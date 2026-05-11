import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "./logger.js";
import type { ProjectIndex, ProjectIndexEntry, Snapshot } from "./types.js";

export interface WriteResult {
    /** Whether the snapshot JSON was actually rewritten (false if content_hash matched). */
    snapshotChanged: boolean;
    /** Path of the snapshot JSON written, relative to snapshotsDir. */
    jsonPath: string;
    /** Path of the HTML rendering written, relative to snapshotsDir (only when emitHtml=true). */
    htmlPath: string | null;
}

export interface WriteOptions {
    snapshotsDir: string;
    project: string;
    docId: string;
    snapshot: Snapshot;
    sanitizedHtml: string | null;
    log: Logger;
}

/**
 * Write a snapshot JSON (+ optional sibling HTML) atomically.
 * Idempotent on content_hash: if the existing JSON has the same content_hash
 * AND the same `doc.version`, no write happens.
 */
export async function writeSnapshot(opts: WriteOptions): Promise<WriteResult> {
    const dir = join(opts.snapshotsDir, opts.project, "docs");
    await mkdir(dir, { recursive: true });
    const jsonRel = `${opts.project}/docs/${opts.docId}.json`;
    const htmlRel = opts.sanitizedHtml === null ? null : `${opts.project}/docs/${opts.docId}.html`;
    const jsonAbs = join(opts.snapshotsDir, jsonRel);
    const htmlAbs = htmlRel === null ? null : join(opts.snapshotsDir, htmlRel);

    const existing = await readExistingSnapshot(jsonAbs);
    const unchanged =
        existing !== null &&
        existing.content_hash === opts.snapshot.content_hash &&
        existing.doc.version === opts.snapshot.doc.version;
    if (unchanged) {
        opts.log.info(
            { docId: opts.docId, project: opts.project, version: opts.snapshot.doc.version },
            "snapshot unchanged; skipping write",
        );
        return { snapshotChanged: false, jsonPath: jsonRel, htmlPath: htmlRel };
    }

    await atomicWrite(jsonAbs, JSON.stringify(opts.snapshot, null, 2));
    if (htmlAbs !== null && opts.sanitizedHtml !== null) {
        await atomicWrite(htmlAbs, opts.sanitizedHtml);
    }
    opts.log.info(
        {
            docId: opts.docId,
            project: opts.project,
            version: opts.snapshot.doc.version,
            content_hash: opts.snapshot.content_hash.slice(0, 12),
        },
        "snapshot written",
    );
    return { snapshotChanged: true, jsonPath: jsonRel, htmlPath: htmlRel };
}

export async function deleteSnapshot(
    snapshotsDir: string,
    project: string,
    docId: string,
    log: Logger,
): Promise<{ removed: boolean }> {
    const jsonAbs = join(snapshotsDir, project, "docs", `${docId}.json`);
    const htmlAbs = join(snapshotsDir, project, "docs", `${docId}.html`);
    let removed = false;
    for (const p of [jsonAbs, htmlAbs]) {
        try {
            await rm(p);
            removed = true;
        } catch {
            // ignore missing
        }
    }
    log.info({ docId, project, removed }, "snapshot delete");
    return { removed };
}

export interface UpsertIndexEntryOptions {
    snapshotsDir: string;
    project: string;
    projectName?: string;
    entry: ProjectIndexEntry;
    log: Logger;
}

export async function upsertIndexEntry(opts: UpsertIndexEntryOptions): Promise<void> {
    const path = join(opts.snapshotsDir, opts.project, "index.json");
    await mkdir(dirname(path), { recursive: true });
    const existing = await readJson<ProjectIndex>(path);
    const index: ProjectIndex = existing ?? {
        project: opts.project,
        name: opts.projectName ?? opts.project,
        updated_at: new Date().toISOString(),
        docs: [],
    };
    if (opts.projectName) {
        index.name = opts.projectName;
    }
    const docs = index.docs.filter((d) => d.id !== opts.entry.id);
    docs.push(opts.entry);
    docs.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    index.docs = docs;
    index.updated_at = new Date().toISOString();
    await atomicWrite(path, JSON.stringify(index, null, 2));
    opts.log.debug({ project: opts.project, count: docs.length }, "project index updated");
}

export async function removeIndexEntry(
    snapshotsDir: string,
    project: string,
    docId: string,
    log: Logger,
): Promise<void> {
    const path = join(snapshotsDir, project, "index.json");
    const existing = await readJson<ProjectIndex>(path);
    if (!existing) {
        return;
    }
    const before = existing.docs.length;
    existing.docs = existing.docs.filter((d) => d.id !== docId);
    if (existing.docs.length === before) {
        return;
    }
    existing.updated_at = new Date().toISOString();
    await atomicWrite(path, JSON.stringify(existing, null, 2));
    log.debug({ project, removed: docId }, "project index entry removed");
}

/**
 * Compute the canonical content hash of the snapshot's content.blocks.
 * Stable: keys sorted, no whitespace.
 */
export function computeContentHash(snapshotContent: unknown): string {
    return createHash("sha256").update(canonicalJson(snapshotContent)).digest("hex");
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return "[" + value.map(canonicalJson).join(",") + "]";
    }
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return (
        "{" +
        keys
            .map((k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k]))
            .join(",") +
        "}"
    );
}

async function readExistingSnapshot(absPath: string): Promise<Snapshot | null> {
    return readJson<Snapshot>(absPath);
}

async function readJson<T>(absPath: string): Promise<T | null> {
    try {
        const buf = await readFile(absPath, "utf8");
        return JSON.parse(buf) as T;
    } catch {
        return null;
    }
}

async function atomicWrite(absPath: string, content: string): Promise<void> {
    await mkdir(dirname(absPath), { recursive: true });
    const tmp = `${absPath}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, content);
    await rename(tmp, absPath);
}
