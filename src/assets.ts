import { createHash } from "node:crypto";
import type { Logger } from "./logger.js";
import type { SiyuanClient } from "./siyuan-client.js";
import type { SnapshotAsset } from "./types.js";

export interface AssetWithBytes extends SnapshotAsset {
    bytes: Buffer;
}

export interface AssetExtractionContext {
    client: SiyuanClient;
    log: Logger;
}

/**
 * Fetch every asset referenced in a doc, compute its sha256, and return
 * the metadata + bytes in-memory. No filesystem writes — the orchestrator
 * is responsible for uploading bytes to the reader via the HTTP ingest API.
 * Idempotent on `originalPath`: duplicates are skipped.
 */
export async function extractAssets(
    paths: string[],
    ctx: AssetExtractionContext,
): Promise<Map<string, AssetWithBytes>> {
    const result = new Map<string, AssetWithBytes>();
    const seen = new Set<string>();
    for (const original of paths) {
        if (seen.has(original)) continue;
        seen.add(original);
        try {
            const asset = await fetchAsset(original, ctx);
            result.set(original, asset);
        } catch (e) {
            ctx.log.warn(
                { asset: original, err: errMsg(e) },
                "asset extraction failed; skipping",
            );
        }
    }
    return result;
}

async function fetchAsset(
    originalPath: string,
    ctx: AssetExtractionContext,
): Promise<AssetWithBytes> {
    const workspacePath = originalPath.startsWith("/") ? originalPath : `/data/${originalPath}`;
    const { bytes, mime } = await ctx.client.getFileBytes(workspacePath);
    const buf = Buffer.from(bytes);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    return {
        original_path: originalPath,
        sha256,
        mime,
        size_bytes: buf.byteLength,
        bytes: buf,
    };
}

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
