import { load, type CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import sanitizeHtml from "sanitize-html";
import { convertAttributeView } from "./av.js";
import type { SiyuanAvRender } from "./siyuan-client.js";
import type { SnapshotBlock, SnapshotAsset } from "./types.js";

/**
 * Options shared across parse + sanitize so AV blocks can be hydrated from
 * the kernel's /api/av/renderAttributeView payload — the doc HTML returned
 * by /api/filetree/getDoc only contains a placeholder for these.
 *
 * Keyed by the AV's editor block id (data-node-id), not the AV id, since the
 * same AV can be mirrored under multiple block ids in a single doc.
 */
export interface AvBlockMap {
    /** node-id (block id) → kernel render payload */
    byNodeId: Map<string, SiyuanAvRender>;
}

/**
 * Parse a Siyuan-rendered doc HTML into typed Snapshot blocks.
 *
 * V1.1 scope (supported block types):
 *   NodeHeading, NodeParagraph, NodeList, NodeListItem, NodeCodeBlock,
 *   NodeBlockquote, NodeThematicBreak, NodeImage (typed),
 *   NodeTable, NodeMathBlock, NodeSuperBlock,
 *   NodeAttributeView (requires `avBlocks` map pre-fetched from the kernel)
 *
 * Inline marks are NOT extracted (always `marks: []`). The sanitized HTML
 * output carries the inline formatting; the structured JSON gets it later.
 */
export function parseSiyuanHtml(
    html: string,
    avBlocks?: AvBlockMap,
): {
    blocks: SnapshotBlock[];
    unsupportedTypes: Set<string>;
} {
    const $ = load(html);
    const unsupportedTypes = new Set<string>();
    // Siyuan's getDoc HTML may wrap content in protyle containers
    // (.protyle-wysiwyg, .protyle-content, …) before reaching block divs.
    // Find every typed block whose nearest typed ancestor is none = real top-level.
    const topLevel = $('[data-type^="Node"]')
        .toArray()
        .filter((el) => $(el).parents('[data-type^="Node"]').length === 0);
    const blocks = parseChildBlocks(topLevel, $, unsupportedTypes, avBlocks);
    return { blocks, unsupportedTypes };
}

function parseChildBlocks(
    elements: Element[],
    $: CheerioAPI,
    unsupported: Set<string>,
    avBlocks?: AvBlockMap,
): SnapshotBlock[] {
    const out: SnapshotBlock[] = [];
    for (const el of elements) {
        const block = parseBlock(el, $, unsupported, avBlocks);
        if (block) {
            out.push(block);
        }
    }
    return out;
}

function parseBlock(
    el: Element,
    $: CheerioAPI,
    unsupported: Set<string>,
    avBlocks?: AvBlockMap,
): SnapshotBlock | null {
    const $el = $(el);
    const type = $el.attr("data-type");
    const id = $el.attr("data-node-id") ?? "";
    if (!type) {
        return null;
    }
    switch (type) {
        case "NodeHeading": {
            const subtype = $el.attr("data-subtype") ?? "h1";
            const level = Math.max(1, Math.min(6, Number.parseInt(subtype.replace("h", ""), 10) || 1));
            return {
                id,
                type: "NodeHeading",
                level,
                text: extractBlockText($el),
                marks: [],
            };
        }
        case "NodeParagraph": {
            // Image-only paragraphs (one inline img span, no other meaningful
            // text) graduate to NodeImage blocks so the reader has typed asset
            // refs. Mixed text + image paragraphs stay as NodeParagraph; their
            // images survive in the sanitized HTML but not in the typed JSON
            // (documented limitation in README).
            const imageBlock = tryParseImageOnlyParagraph(id, $el, $);
            if (imageBlock) return imageBlock;
            return {
                id,
                type: "NodeParagraph",
                text: extractBlockText($el),
                marks: [],
            };
        }
        case "NodeList": {
            const subtype = $el.attr("data-subtype");
            const ordered = subtype === "o";
            return {
                id,
                type: "NodeList",
                ordered,
                children: parseChildBlocks($el.children().get(), $, unsupported, avBlocks),
            };
        }
        case "NodeListItem": {
            return {
                id,
                type: "NodeListItem",
                children: parseChildBlocks($el.children().get(), $, unsupported, avBlocks),
            };
        }
        case "NodeCodeBlock": {
            // Siyuan code blocks contain:
            //   .protyle-action[__language]  ← language label (editable, "python" etc.)
            //   .hljs.language-xxx           ← the actual code body (editable)
            //   .protyle-attr                ← editor metadata
            // We must skip the language label and the attr div to grab the code.
            const clone = $el.clone();
            clone.find(".protyle-action, .protyle-attr").remove();
            const langClass = $el.find('[class*="language-"]').attr("class") ?? "";
            const language =
                langClass.match(/language-(\S+)/)?.[1] ??
                $el.find(".protyle-action__language").text().trim();
            const text = clone.find("[contenteditable]").first().text();
            return { id, type: "NodeCodeBlock", language, text };
        }
        case "NodeBlockquote": {
            return {
                id,
                type: "NodeBlockquote",
                children: parseChildBlocks($el.children().get(), $, unsupported, avBlocks),
            };
        }
        case "NodeThematicBreak": {
            return { id, type: "NodeThematicBreak" };
        }
        case "NodeAttributeView": {
            const av = avBlocks?.byNodeId.get(id);
            if (!av) {
                // Kernel data wasn't pre-fetched (or fetch failed) — record so
                // the extractor logs it, but don't crash the snapshot.
                unsupported.add("NodeAttributeView");
                return null;
            }
            return convertAttributeView(id, av).block;
        }
        case "NodeTable": {
            return parseTableBlock(id, $el, $);
        }
        case "NodeMathBlock": {
            // The kernel stores LaTeX in `data-content`; the rendered DOM
            // is built client-side from that source, so the raw HTML body
            // is empty. We just lift the source out.
            const latex = $el.attr("data-content") ?? "";
            return { id, type: "NodeMathBlock", text: latex };
        }
        case "NodeSuperBlock": {
            // `data-sb-layout` is "row" or "col". Anything else falls back
            // to "row" so the reader still gets a deterministic layout.
            const rawLayout = $el.attr("data-sb-layout");
            const layout: "row" | "col" = rawLayout === "col" ? "col" : "row";
            return {
                id,
                type: "NodeSuperBlock",
                layout,
                children: parseChildBlocks($el.children().get(), $, unsupported, avBlocks),
            };
        }
        case "NodeImage":
        default: {
            unsupported.add(type);
            return null;
        }
    }
}

/**
 * Parse a NodeTable Siyuan block.
 *
 * Layout produced by the kernel:
 *   <div data-type="NodeTable">
 *     <div contenteditable="false">
 *       <table>
 *         <colgroup>…</colgroup>
 *         <thead><tr><th>…</th></tr></thead>
 *         <tbody><tr><td>…</td></tr><tr>…</tr></tbody>
 *       </table>
 *       <div class="protyle-action__table">…</div>
 *     </div>
 *     <div class="protyle-attr">…</div>
 *   </div>
 *
 * `header_row` is 1 when a <thead> is present (every Siyuan markdown table
 * has one), 0 otherwise. Inline marks within cells are NOT extracted yet —
 * cell `text` is the plain-text concat, `marks: []` (same convention as
 * paragraph/heading in this version).
 */
/**
 * Detect an image-only NodeParagraph and emit a typed NodeImage block instead.
 * Returns null if the paragraph has any meaningful text alongside its image,
 * has zero images, or has more than one image — all those cases stay as
 * NodeParagraph and only carry the image through the sanitized HTML.
 */
function tryParseImageOnlyParagraph(
    id: string,
    $el: ReturnType<CheerioAPI>,
    $: CheerioAPI,
): SnapshotBlock | null {
    const editable = $el.children("[contenteditable]").first();
    if (editable.length === 0) return null;
    const imageSpans = editable.find('> span[data-type="img"]');
    if (imageSpans.length !== 1) return null;

    // Strip the image span and any zero-width/whitespace text. If anything
    // meaningful is left over, this paragraph is a mixed-content paragraph.
    const clone = editable.clone();
    clone.find('span[data-type="img"]').remove();
    if (cleanText(clone.text()).length > 0) return null;

    const $imgEl = $(imageSpans.get(0)!);
    const $img = $imgEl.find("img").first();
    const src = $img.attr("src") ?? $img.attr("data-src") ?? "";
    const alt = $img.attr("alt") ?? "";
    // Caption priority: explicit title (markdown `![alt](src "title")`),
    // then any rendered .protyle-action__title span, then "".
    const title = $img.attr("title") ?? "";
    const renderedCaption = cleanText($imgEl.find(".protyle-action__title").text());
    const caption = title || renderedCaption || "";
    return { id, type: "NodeImage", asset_path: src, alt, caption };
}

function parseTableBlock(
    id: string,
    $el: ReturnType<CheerioAPI>,
    $: CheerioAPI,
): SnapshotBlock {
    const $table = $el.find("table").first();
    const headerCells = $table
        .find("thead > tr")
        .first()
        .find("th")
        .toArray()
        .map((th) => ({ text: cleanText($(th).text()), marks: [] as never[] }));
    const bodyRows = $table
        .find("tbody > tr")
        .toArray()
        .map((tr) =>
            $(tr)
                .find("td")
                .toArray()
                .map((td) => ({ text: cleanText($(td).text()), marks: [] as never[] })),
        );

    const rows = headerCells.length > 0 ? [headerCells, ...bodyRows] : bodyRows;
    const header_row = headerCells.length > 0 ? 1 : 0;
    return { id, type: "NodeTable", header_row, rows };
}

/**
 * Extract the visible text from a block, stripping Siyuan's editor metadata
 * (`.protyle-attr` divs). Operates on a clone so the original tree is untouched.
 */
function extractBlockText($el: ReturnType<CheerioAPI>): string {
    const clone = $el.clone();
    clone.find(".protyle-attr").remove();
    return cleanText(clone.text());
}

// Strip Unicode invisible chars Siyuan sprinkles for editing/cursor purposes.
// U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+2060 word joiner, U+FEFF BOM.
const INVISIBLE_CHARS = /[​‌‍⁠﻿]/g;

function cleanText(text: string): string {
    return text.replace(INVISIBLE_CHARS, "").replace(/\s+/g, " ").trim();
}

/**
 * Scan the Siyuan HTML for NodeAttributeView placeholders and return the
 * identifiers needed to fetch each one's data from the kernel. Returns one
 * entry per editor block id (multiple mirrors of the same avId stay as
 * distinct blocks).
 */
export function extractAvPlaceholders(html: string): Array<{
    nodeId: string;
    avId: string;
    viewId: string;
}> {
    const $ = load(html);
    const out: Array<{ nodeId: string; avId: string; viewId: string }> = [];
    $('[data-type="NodeAttributeView"]').each((_, el) => {
        const $el = $(el);
        const nodeId = $el.attr("data-node-id") ?? "";
        const avId = $el.attr("data-av-id") ?? "";
        const viewId = $el.attr("custom-sy-av-view") ?? "";
        if (nodeId && avId) {
            out.push({ nodeId, avId, viewId });
        }
    });
    return out;
}

/**
 * Walk the Siyuan HTML and collect asset paths (e.g. "assets/foo.png").
 */
export function extractAssetPaths(html: string): string[] {
    const $ = load(html);
    const paths = new Set<string>();
    $("[src], [data-src]").each((_, el) => {
        const $el = $(el);
        for (const attr of ["src", "data-src"]) {
            const val = $el.attr(attr);
            if (val && val.startsWith("assets/")) {
                paths.add(val);
            }
        }
    });
    return [...paths];
}

/**
 * Extract plain text for search indexing and excerpts. Strips invisible chars
 * and Siyuan editor metadata. Walks every block (including nested) and reads
 * only its direct contenteditable child, so blocks don't run together.
 */
export function extractSearchText(html: string): string {
    const $ = load(html);
    $(".protyle-attr").remove();
    const parts: string[] = [];
    $('[data-type^="Node"]').each((_, el) => {
        const editable = $(el).children("[contenteditable]").first();
        if (editable.length === 0) {
            return;
        }
        const t = cleanText(editable.text());
        if (t) {
            parts.push(t);
        }
    });
    return parts.join("\n");
}

export function makeExcerpt(searchText: string, maxChars = 200): string {
    if (searchText.length <= maxChars) {
        return searchText;
    }
    const cut = searchText.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + "…";
}

const ALLOWED_TAGS = [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "br", "hr",
    "strong", "em", "code", "s", "u", "sub", "sup",
    "ul", "ol", "li",
    "blockquote",
    "pre",
    "a",
    "img",
    "figure", "figcaption",
    "span", "div",
    "table", "thead", "tbody", "tr", "th", "td", "caption",
];

/**
 * Sanitize Siyuan's rendered HTML and rewrite asset URLs to the public
 * stored_path. AV placeholders are hydrated from `avBlocks` into a real
 * <table> before sanitization (the kernel only ships a stub for them).
 * Anything outside the allowlist is stripped. `.protyle-attr` divs (editor
 * metadata) are dropped wholesale.
 */
export function renderSanitizedHtml(
    siyuanHtml: string,
    assets: Map<string, SnapshotAsset>,
    avBlocks?: AvBlockMap,
): string {
    let hydrated = avBlocks ? hydrateAvPlaceholders(siyuanHtml, avBlocks) : siyuanHtml;
    hydrated = hydrateMathBlocks(hydrated);
    return sanitizeHtml(hydrated, {
        allowedTags: ALLOWED_TAGS,
        allowedAttributes: {
            a: ["href", "title"],
            img: ["src", "alt", "title"],
            span: ["class"],
            div: ["class"],
            code: ["class"],
            pre: ["class", "data-latex"],
            th: ["scope", "data-av-col-type"],
            table: ["class"],
            "*": ["data-type", "data-node-id", "data-subtype", "data-sb-layout"],
        },
        allowedSchemes: ["http", "https", "mailto"],
        exclusiveFilter: (frame) => frame.attribs?.class?.includes("protyle-attr") ?? false,
        transformTags: {
            img: (_tagName, attribs) => {
                const src = attribs.src ?? "";
                if (src.startsWith("assets/")) {
                    const asset = assets.get(src);
                    if (asset) {
                        return { tagName: "img", attribs: { ...attribs, src: `/${asset.stored_path}` } };
                    }
                }
                return { tagName: "img", attribs };
            },
            a: (_tagName, attribs) => {
                // Drop block ref links pointing into the workspace
                if (attribs.href?.startsWith("siyuan://")) {
                    return { tagName: "span", attribs: {}, text: attribs.title ?? "" };
                }
                return { tagName: "a", attribs };
            },
        },
        disallowedTagsMode: "discard",
        nonTextTags: ["style", "script", "textarea", "noscript", "template"],
    });
}

/**
 * Replace each NodeMathBlock's empty inner div with a <pre class="math-block"
 * data-latex="…">$$ … $$</pre>. The reader is expected to wire a client-side
 * LaTeX renderer (KaTeX / MathJax) — we ship the source, not a SVG, so the
 * snapshot stays portable and small.
 */
function hydrateMathBlocks(html: string): string {
    const $ = load(html);
    const blocks = $('[data-type="NodeMathBlock"]');
    if (blocks.length === 0) return html;
    blocks.each((_, el) => {
        const $el = $(el);
        const latex = $el.attr("data-content") ?? "";
        const escapedAttr = latex
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;");
        const escapedText = latex
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        $el.empty().append(
            `<pre class="math-block" data-latex="${escapedAttr}">$$ ${escapedText} $$</pre>`,
        );
    });
    const body = $("body");
    return body.length > 0 ? body.html() ?? "" : $.html();
}

/**
 * Replace each NodeAttributeView placeholder div's content with a real
 * <table> synthesized from the kernel render payload. Returns the rewritten
 * HTML string. AVs we don't have data for are emptied out (the wrapping div
 * survives with no rendered content rather than leaking Siyuan's stub
 * markup).
 */
function hydrateAvPlaceholders(html: string, avBlocks: AvBlockMap): string {
    const $ = load(html);
    $('[data-type="NodeAttributeView"]').each((_, el) => {
        const $el = $(el);
        const nodeId = $el.attr("data-node-id") ?? "";
        const av = avBlocks.byNodeId.get(nodeId);
        if (!av) {
            $el.empty();
            return;
        }
        const { html: tableHtml } = convertAttributeView(nodeId, av);
        $el.empty().append(tableHtml);
    });
    // Cheerio adds <html><head><body> wrappers when given a fragment.
    // Take just the body's innerHTML so we return the same shape as input.
    const body = $("body");
    return body.length > 0 ? body.html() ?? "" : $.html();
}
