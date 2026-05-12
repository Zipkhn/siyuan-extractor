import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";

interface SiyuanResponse<T> {
    code: number;
    msg: string;
    data: T;
}

export interface SiyuanDocInfo {
    id: string;
    rootID: string;
    name: string;
    refCount: number;
    subFileCount: number;
    ial: Record<string, string>;
}

export interface SiyuanGetDoc {
    box: string;
    path: string;
    rootID: string;
    blockCount: number;
    content: string; // HTML representation of the doc
    isBacklinkExpand: boolean;
    isSyncing: boolean;
    type: string;
    parent2ID: string;
    parentID: string;
    eof: boolean;
    scroll: string;
    mode: number;
}

/**
 * Bounded Siyuan API client. ONLY exposes the endpoints needed to extract a
 * published document. Never wraps /api/query/sql or anything that takes
 * arbitrary user input → server-side execution.
 */
export class SiyuanClient {
    private readonly baseUrl: string;
    private readonly token: string;
    private readonly log: Logger;

    constructor(config: AppConfig, log: Logger) {
        this.baseUrl = config.siyuanUrl;
        this.token = config.siyuanToken;
        this.log = log.child({ component: "siyuan-client" });
    }

    private async call<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
        const url = `${this.baseUrl}${endpoint}`;
        const started = Date.now();
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Token ${this.token}`,
            },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(
                `Siyuan ${endpoint} HTTP ${response.status}: ${text.slice(0, 200)}`,
            );
        }
        const json = (await response.json()) as SiyuanResponse<T>;
        this.log.debug({ endpoint, code: json.code, ms: Date.now() - started }, "siyuan call");
        if (json.code !== 0) {
            throw new Error(`Siyuan ${endpoint} returned code ${json.code}: ${json.msg}`);
        }
        return json.data;
    }

    /**
     * Read IAL attributes of a block. Used to verify a doc is actually marked
     * as published before extracting (defense in depth: don't trust the
     * webhook payload alone).
     */
    getBlockAttrs(id: string): Promise<Record<string, string>> {
        return this.call<Record<string, string>>("/api/attr/getBlockAttrs", { id });
    }

    /**
     * Get doc metadata (root id, name, IAL, refs count).
     */
    getDocInfo(id: string): Promise<SiyuanDocInfo> {
        return this.call<SiyuanDocInfo>("/api/block/getDocInfo", { id });
    }

    /**
     * Get a doc's rendered content (HTML representation), plus box and path.
     * mode=0 + a large size returns the whole doc (size = max block count per chunk).
     * Modes 1-7 are scroll/positional modes that return partial chunks.
     */
    getDoc(id: string): Promise<SiyuanGetDoc> {
        return this.call<SiyuanGetDoc>("/api/filetree/getDoc", {
            id,
            mode: 0,
            size: 102400,
        });
    }

    /**
     * Fetch a file from the workspace (used for assets in `assets/`).
     * Returns the raw bytes.
     */
    async getFileBytes(workspacePath: string): Promise<{ bytes: Uint8Array; mime: string }> {
        const url = `${this.baseUrl}/api/file/getFile`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Token ${this.token}`,
            },
            body: JSON.stringify({ path: workspacePath }),
        });
        if (!response.ok) {
            throw new Error(`Siyuan getFile ${workspacePath} HTTP ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        const mime = response.headers.get("content-type") ?? "application/octet-stream";
        return { bytes: new Uint8Array(buffer), mime };
    }
}
