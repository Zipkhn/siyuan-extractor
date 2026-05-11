import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { SiyuanClient } from "./siyuan-client.js";
import { extractAssets } from "./assets.js";
import {
    extractAssetPaths,
    extractSearchText,
    makeExcerpt,
    parseSiyuanHtml,
    renderSanitizedHtml,
} from "./renderer.js";
import {
    computeContentHash,
    deleteSnapshot,
    removeIndexEntry,
    upsertIndexEntry,
    writeSnapshot,
} from "./snapshot.js";
import { isValidSlug, slugify } from "./slug.js";
import {
    SNAPSHOT_SCHEMA,
    type Snapshot,
    type SnapshotAsset,
    type WebhookPayload,
} from "./types.js";

const ATTR_PUBLISHED = "custom-published";
const ATTR_PROJECT = "custom-project";
const ATTR_PUBLISH_SLUG = "custom-publish-slug";
const ATTR_PUBLISH_VERSION = "custom-publish-version";
const ATTR_PUBLISH_UPDATED_AT = "custom-publish-updated-at";

export class Extractor {
    private readonly config: AppConfig;
    private readonly client: SiyuanClient;
    private readonly log: Logger;

    constructor(config: AppConfig, log: Logger) {
        this.config = config;
        this.client = new SiyuanClient(config, log);
        this.log = log.child({ component: "extractor" });
    }

    async handlePublish(payload: WebhookPayload): Promise<{ snapshotChanged: boolean }> {
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
            project,
            snapshotsDir: this.config.snapshotsDir,
            client: this.client,
            log,
        });
        const assets: SnapshotAsset[] = [...assetMap.values()];

        const { blocks, unsupportedTypes } = parseSiyuanHtml(html);
        if (unsupportedTypes.size > 0) {
            log.warn(
                { types: [...unsupportedTypes] },
                "some block types are not supported in V1.0 and were skipped from JSON blocks",
            );
        }

        const searchText = extractSearchText(html);
        const excerpt = makeExcerpt(searchText, 200);

        const content = { blocks };
        const contentHash = computeContentHash(content);

        const snapshot: Snapshot = {
            schema: SNAPSHOT_SCHEMA,
            doc: {
                id: payload.docId,
                project,
                slug,
                title: titleRaw,
                published_at: payload.publishedAt,
                updated_at: updatedAt,
                version,
                excerpt,
            },
            content,
            content_hash: contentHash,
            assets,
            outbound_refs: [], // V1.1
            search_text: searchText,
        };

        const sanitizedHtml = this.config.emitHtml ? renderSanitizedHtml(html, assetMap) : null;

        const writeResult = await writeSnapshot({
            snapshotsDir: this.config.snapshotsDir,
            project,
            docId: payload.docId,
            snapshot,
            sanitizedHtml,
            log,
        });

        await upsertIndexEntry({
            snapshotsDir: this.config.snapshotsDir,
            project,
            entry: {
                id: payload.docId,
                slug,
                title: titleRaw,
                excerpt,
                published_at: payload.publishedAt,
                updated_at: updatedAt,
            },
            log,
        });

        return { snapshotChanged: writeResult.snapshotChanged };
    }

    async handleUnpublish(payload: WebhookPayload): Promise<{ removed: boolean }> {
        const log = this.log.child({ docId: payload.docId, project: payload.project });
        log.info("unpublish webhook received");
        const result = await deleteSnapshot(
            this.config.snapshotsDir,
            payload.project,
            payload.docId,
            log,
        );
        await removeIndexEntry(this.config.snapshotsDir, payload.project, payload.docId, log);
        return result;
    }
}
