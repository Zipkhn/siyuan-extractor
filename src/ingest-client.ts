import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";

const TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 4_000, 16_000];

export class IngestError extends Error {
    constructor(
        public readonly code: string,
        public readonly status: number,
        public readonly requestId: string | null,
        message: string,
        public readonly details?: unknown,
    ) {
        super(message);
        this.name = "IngestError";
    }
}

export interface IngestDocAsset {
    original_path: string;
    sha256: string;
    mime: string;
    size_bytes: number;
}

export interface IngestDocPayload {
    schema: "siyuan-snapshot/v1";
    doc: {
        id: string;
        project: string;
        slug: string;
        title: string;
        excerpt: string;
        version: number;
        published_at: string;
        updated_at: string;
    };
    content: { blocks: unknown[] };
    content_hash: string;
    assets: IngestDocAsset[];
    outbound_refs: Array<{
        target_doc_id: string;
        target_block_id: string | null;
        anchor_text: string;
    }>;
    search_text: string;
    html: string | null;
}

export type PostDocResult =
    | { status: "ingested" | "unchanged"; requestId: string }
    | { status: "missing_asset"; missing: string[]; requestId: string };

export type PostAssetResult = { status: "ingested" | "exists"; requestId: string };

export type PostUnpublishResult = { status: "removed" | "already_absent"; requestId: string };

export class IngestClient {
    private readonly readerUrl: string;
    private readonly secret: string;
    private readonly log: Logger;

    constructor(config: AppConfig, log: Logger) {
        this.readerUrl = config.readerUrl;
        this.secret = config.ingestSecret;
        this.log = log.child({ component: "ingest-client" });
    }

    /**
     * HEAD /api/ingest/asset/:sha256 — intentionally minimal probe.
     * 200 = present, 404 = absent. Anything else surfaces as IngestError.
     */
    async headAsset(project: string, sha256: string): Promise<boolean> {
        const url = `${this.readerUrl}/api/ingest/asset/${sha256}?project=${encodeURIComponent(project)}`;
        const res = await this.fetchWithRetry(url, { method: "HEAD" });
        if (res.status === 200) return true;
        if (res.status === 404) return false;
        const reqId = res.headers.get("x-request-id");
        throw new IngestError(
            "head_asset_failed",
            res.status,
            reqId,
            `Unexpected status ${res.status} from HEAD /api/ingest/asset`,
        );
    }

    async postAsset(
        project: string,
        sha256: string,
        mime: string,
        bytes: Buffer,
    ): Promise<PostAssetResult> {
        const url =
            `${this.readerUrl}/api/ingest/asset` +
            `?project=${encodeURIComponent(project)}` +
            `&sha256=${sha256}` +
            `&mime=${encodeURIComponent(mime)}`;
        const res = await this.fetchWithRetry(url, {
            method: "POST",
            body: bytes,
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(bytes.byteLength),
            },
        });
        const body = await readJson(res);
        const reqId = pickRequestId(body, res);
        if (res.status === 200 && (body.status === "ingested" || body.status === "exists")) {
            return { status: body.status, requestId: reqId };
        }
        throw new IngestError(
            String(body.error ?? "post_asset_failed"),
            res.status,
            reqId,
            `Unexpected status ${res.status} on POST /api/ingest/asset`,
            body,
        );
    }

    async postDoc(payload: IngestDocPayload): Promise<PostDocResult> {
        const url = `${this.readerUrl}/api/ingest/doc`;
        const res = await this.fetchWithRetry(url, {
            method: "POST",
            body: JSON.stringify(payload),
            headers: { "Content-Type": "application/json" },
        });
        const body = await readJson(res);
        const reqId = pickRequestId(body, res);
        if (res.status === 200 && (body.status === "ingested" || body.status === "unchanged")) {
            return { status: body.status, requestId: reqId };
        }
        if (res.status === 409 && body.error === "missing_asset" && Array.isArray(body.missing)) {
            return {
                status: "missing_asset",
                missing: body.missing as string[],
                requestId: reqId,
            };
        }
        throw new IngestError(
            String(body.error ?? "post_doc_failed"),
            res.status,
            reqId,
            `Unexpected status ${res.status} on POST /api/ingest/doc`,
            body,
        );
    }

    async postUnpublish(project: string, docId: string): Promise<PostUnpublishResult> {
        const url = `${this.readerUrl}/api/ingest/unpublish`;
        const res = await this.fetchWithRetry(url, {
            method: "POST",
            body: JSON.stringify({ project, docId }),
            headers: { "Content-Type": "application/json" },
        });
        const body = await readJson(res);
        const reqId = pickRequestId(body, res);
        if (res.status === 200 && (body.status === "removed" || body.status === "already_absent")) {
            return { status: body.status, requestId: reqId };
        }
        throw new IngestError(
            String(body.error ?? "post_unpublish_failed"),
            res.status,
            reqId,
            `Unexpected status ${res.status} on POST /api/ingest/unpublish`,
            body,
        );
    }

    /**
     * fetch + retry policy from docs/v1/ingest.md §8:
     *  - 30 s timeout per attempt
     *  - 5xx/429 or network failure → exponential backoff with ±10% jitter
     *    (1 s → 4 s → 16 s), 3 retries max
     *  - 2xx/4xx returned as-is (caller maps the status to a typed result)
     */
    private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${this.secret}`);
        const merged: RequestInit = { ...init, headers };

        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
            try {
                const res = await fetch(url, { ...merged, signal: ctrl.signal });
                clearTimeout(timer);
                if (res.status >= 500 || res.status === 429) {
                    if (attempt >= RETRY_DELAYS_MS.length) {
                        return res;
                    }
                    await this.waitWithJitter(RETRY_DELAYS_MS[attempt], attempt, res.status);
                    continue;
                }
                return res;
            } catch (err) {
                clearTimeout(timer);
                if (attempt >= RETRY_DELAYS_MS.length) {
                    throw err;
                }
                await this.waitWithJitter(RETRY_DELAYS_MS[attempt], attempt, "network");
            }
        }
        throw new Error("unreachable: retry loop exited without returning");
    }

    private async waitWithJitter(
        baseMs: number,
        attempt: number,
        reason: number | "network",
    ): Promise<void> {
        // ±10% jitter avoids retry storms if multiple producers ever pile up.
        const jitter = baseMs * 0.1 * (Math.random() * 2 - 1);
        const delay = Math.max(0, Math.round(baseMs + jitter));
        this.log.warn({ attempt: attempt + 1, delayMs: delay, reason }, "ingest retry");
        await new Promise((r) => setTimeout(r, delay));
    }
}

interface ResponseBody {
    status?: string;
    error?: string;
    requestId?: string;
    missing?: unknown;
    [key: string]: unknown;
}

async function readJson(res: Response): Promise<ResponseBody> {
    try {
        return (await res.json()) as ResponseBody;
    } catch {
        return {};
    }
}

function pickRequestId(body: ResponseBody, res: Response): string {
    if (typeof body.requestId === "string" && body.requestId) return body.requestId;
    return res.headers.get("x-request-id") ?? "";
}
