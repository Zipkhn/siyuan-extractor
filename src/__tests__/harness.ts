import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSiyuanHtml, renderSanitizedHtml, type AvBlockMap } from "../renderer.js";
import type { SnapshotAsset, SnapshotBlock } from "../types.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");

export function loadFixture(name: string): string {
    return readFileSync(join(FIXTURES_DIR, name), "utf-8");
}

export interface ParseAndRenderResult {
    blocks: SnapshotBlock[];
    unsupportedTypes: Set<string>;
    html: string;
}

/**
 * Run both stages (typed JSON + sanitized HTML) against the same input so
 * tests assert the full extractor contract in one call.
 */
export function parseAndRender(
    html: string,
    assets: Map<string, SnapshotAsset> = new Map(),
    avBlocks?: AvBlockMap,
    project = "test",
): ParseAndRenderResult {
    const { blocks, unsupportedTypes } = parseSiyuanHtml(html, avBlocks);
    const sanitized = renderSanitizedHtml(html, project, assets, avBlocks);
    return { blocks, unsupportedTypes, html: sanitized };
}
