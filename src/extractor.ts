import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { SiyuanClient } from "./siyuan-client.js";
import { extractAssets, type AssetWithBytes } from "./assets.js";
import {
    extractAssetPaths,
    extractAvPlaceholders,
    extractSearchText,
    makeExcerpt,
    parseSiyuanHtml,
    renderSanitizedHtml,
    type AvBlockMap,
} from "./renderer.js";
import type { SiyuanAvRender } from "./siyuan-client.js";
import { computeContentHash } from "./content-hash.js";
import {
    IngestClient,
    type IngestDocPayload,
    type PostDocResult,
} from "./ingest-client.js";
import { isValidSlug, slugify } from "./slug.js";
import { SNAPSHOT_SCHEMA, type SnapshotAsset, type WebhookPayload } from "./types.js";

const ATTR_PUBLISHED = "custom-published";
const ATTR_PROJECT = "custom-project";
const ATTR_PUBLISH_SLUG = "custom-publish-slug";
const ATTR_PUBLISH_VERSION = "custom-publish-version";
const ATTR_PUBLISH_UPDATED_AT = "custom-publish-updated-at";

export class Extractor {
    private readonly config: AppConfig;
    private readonly client: SiyuanClient;
    private readonly ingest: IngestClient;
    private readonly log: Logger;

    constructor(config: AppConfig, log: Logger, ingestClient?: IngestClient) {
        this.config = config;
        this.client = new SiyuanClient(config, log);
        this.ingest = ingestClient ?? new IngestClient(config, log);
        this.log = log.child({ component: "extractor" });
    }

    async handlePublish(payload: WebhookPayload): Promise<{ status: PostDocResult["status"] }> {
        const log = this.log.child({ docId: payload.docId, project: payload.project });
        log.info({ version: payload.version }, "publish webhook received");

        // Defense in depth: verify the doc IS marked as published in Siyuan.
        // Don't trust the webhook payload alone.
        const attrs = await this.client.getBlockAttrs(payload.docId);
        if (attrs[ATTR_PUBLISHED] !== "true") {
            throw new Error(
                `Doc ${payload.docId} is not marked as published in Siyuan (custom-published=${attrs[ATTR_PUBLISHED] ?? "missing"})`,
            );
        }
        const project = attrs[ATTR_PROJECT];
        if (!project || !isValidSlug(project)) {
            throw new Error(`Doc ${payload.docId} has invalid project slug: ${project ?? "missing"}`);
        }
        if (project !== payload.project) {
            log.warn(
                { siyuanProject: project, webhookProject: payload.project },
                "project slug mismatch; trusting Siyuan IAL",
            );
        }

        const docInfo = await this.client.getDocInfo(payload.docId);
        const docContent = await this.client.getDoc(payload.docId);

        const titleRaw = docInfo.name || `untitled-${payload.docId}`;
        const slug = attrs[ATTR_PUBLISH_SLUG] && isValidSlug(attrs[ATTR_PUBLISH_SLUG])
            ? attrs[ATTR_PUBLISH_SLUG]
            : slugify(titleRaw) || payload.docId;

        const version = Number.parseInt(attrs[ATTR_PUBLISH_VERSION] ?? String(payload.version), 10) || payload.version;
        const updatedAt = attrs[ATTR_PUBLISH_UPDATED_AT] ?? payload.publishedAt;

        const html = docContent.content ?? "";
        const assetPaths = extractAssetPaths(html);
        const assetMap = await extractAssets(assetPaths, {
            client: this.client,
            log,
        });

        const avBlocks = await this.fetchAvBlocks(html, log);

        const { blocks, unsupportedTypes } = parseSiyuanHtml(html, avBlocks);
        if (unsupportedTypes.size > 0) {
            log.warn(
                { types: [...unsupportedTypes] },
                "some block types are not yet supported and were skipped from JSON blocks",
            );
        }

        const searchText = extractSearchText(html);
        const excerpt = makeExcerpt(searchText, 200);
        const content = { blocks };
        const contentHash = computeContentHash(content);

        const sanitizedHtml = this.config.emitHtml
            ? renderSanitizedHtml(html, project, assetMap, avBlocks)
            : null;

        const payloadDoc: IngestDocPayload = {
            schema: SNAPSHOT_SCHEMA,
            doc: {
                id: payload.docId,
                project,
                slug,
                title: titleRaw,
                excerpt,
                version,
                published_at: payload.publishedAt,
                updated_at: updatedAt,
            },
            content,
            content_hash: contentHash,
            assets: [...assetMap.values()].map(stripBytes),
            outbound_refs: [], // V1.1
            search_text: searchText,
            html: sanitizedHtml,
        };

        // 1) Pre-flight: HEAD each asset to know which ones need uploading.
        const toUpload: AssetWithBytes[] = [];
        for (const asset of assetMap.values()) {
            const present = await this.ingest.headAsset(project, asset.sha256);
            if (!present) toUpload.push(asset);
        }
        // 2) Upload missing assets.
        for (const asset of toUpload) {
            await this.ingest.postAsset(project, asset.sha256, asset.mime, asset.bytes);
        }
        // 3) POST doc. On 409 missing_asset (rare race — reader pruned an
        // asset between our HEAD and POST, or the asset upload silently
        // failed), upload the listed sha256s and retry once.
        let result = await this.ingest.postDoc(payloadDoc);
        if (result.status === "missing_asset") {
            const missing = result.missing;
            log.warn({ missing }, "doc rejected 409 missing_asset; uploading and retrying once");
            const recover = [...assetMap.values()].filter((a) => missing.includes(a.sha256));
            for (const asset of recover) {
                await this.ingest.postAsset(project, asset.sha256, asset.mime, asset.bytes);
            }
            result = await this.ingest.postDoc(payloadDoc);
            if (result.status === "missing_asset") {
                throw new Error(
                    `doc ${payload.docId} still missing assets after retry: ${result.missing.join(", ")}`,
                );
            }
        }
        log.info({ status: result.status, requestId: result.requestId }, "doc ingested");
        return { status: result.status };
    }

    /**
     * Pre-fetch every AttributeView referenced in the doc HTML. The kernel's
     * getDoc response only includes a placeholder div for each AV; the real
     * column/row data has to come from /api/av/renderAttributeView. Failures
     * on individual AVs are logged but don't block the snapshot — they fall
     * through as "unsupported" so the doc still publishes.
     */
    private async fetchAvBlocks(html: string, log: Logger): Promise<AvBlockMap> {
        const placeholders = extractAvPlaceholders(html);
        const byNodeId = new Map<string, SiyuanAvRender>();
        for (const { nodeId, avId, viewId } of placeholders) {
            try {
                const data = await this.client.renderAttributeView(avId, nodeId, viewId);
                byNodeId.set(nodeId, data);
            } catch (err) {
                log.warn(
                    { nodeId, avId, viewId, err: (err as Error).message },
                    "failed to render attribute view; block will be skipped",
                );
            }
        }
        return { byNodeId };
    }

    async handleUnpublish(
        payload: WebhookPayload,
    ): Promise<{ status: "removed" | "already_absent" }> {
        const log = this.log.child({ docId: payload.docId, project: payload.project });
        log.info("unpublish webhook received");
        const result = await this.ingest.postUnpublish(payload.project, payload.docId);
        log.info({ status: result.status, requestId: result.requestId }, "doc unpublished");
        return { status: result.status };
    }
}

function stripBytes(a: AssetWithBytes): SnapshotAsset {
    const { bytes: _bytes, ...meta } = a;
    return meta;
}
