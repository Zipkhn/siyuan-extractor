import { createHash } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { Logger } from "./logger.js";
import type { SiyuanClient } from "./siyuan-client.js";
import type { SnapshotAsset } from "./types.js";

export interface AssetExtractionContext {
    project: string;
    snapshotsDir: string;
    client: SiyuanClient;
    log: Logger;
}

/**
 * Process a list of asset paths referenced inside a document (e.g.
 * "assets/diagram-abc.png"). For each: fetch bytes via Siyuan API,
 * hash sha256, store content-addressed in
 * `<snapshotsDir>/<project>/assets/<basename>.<hash12>.<ext>`.
 * If a file with the same hash already exists, skip writing (idempotent).
 */
export async function extractAssets(
    paths: string[],
    ctx: AssetExtractionContext,
): Promise<Map<string, SnapshotAsset>> {
    const result = new Map<string, SnapshotAsset>();
    const seen = new Set<string>();
    for (const original of paths) {
        if (seen.has(original)) {
            continue;
        }
        seen.add(original);
        try {
            const asset = await fetchAsset(original, ctx);
            result.set(original, asset);
        } catch (e) {
            ctx.log.warn({ asset: original, err: errMsg(e) }, "asset extraction failed; skipping");
        }
    }
    return result;
}

async function fetchAsset(
    originalPath: string,
    ctx: AssetExtractionContext,
): Promise<SnapshotAsset> {
    const workspacePath = originalPath.startsWith("/") ? originalPath : `/data/${originalPath}`;
    const { bytes, mime } = await ctx.client.getFileBytes(workspacePath);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const ext = extname(originalPath);
    const base = basenameWithoutExt(originalPath);
    const stored = `${ctx.project}/assets/${base}.${hash.slice(0, 12)}${ext}`;
    const absolute = join(ctx.snapshotsDir, stored);
    if (!(await pathExists(absolute))) {
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, bytes);
        ctx.log.debug({ stored, sha256: hash, size: bytes.byteLength }, "asset written");
    } else {
        ctx.log.debug({ stored }, "asset already on disk; reused");
    }
    return {
        original_path: originalPath,
        stored_path: stored,
        sha256: hash,
        mime,
        size_bytes: bytes.byteLength,
    };
}

function basenameWithoutExt(p: string): string {
    const parts = p.split("/");
    const last = parts[parts.length - 1];
    const dot = last.lastIndexOf(".");
    return dot === -1 ? last : last.slice(0, dot);
}

async function pathExists(p: string): Promise<boolean> {
    try {
        await access(p);
        return true;
    } catch {
        return false;
    }
}

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
