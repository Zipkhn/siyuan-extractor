import { load, type CheerioAPI, type Element } from "cheerio";
import sanitizeHtml from "sanitize-html";
import type { SnapshotBlock, SnapshotAsset } from "./types.js";

/**
 * Parse a Siyuan-rendered doc HTML into typed Snapshot blocks.
 *
 * V1.0 scope (supported block types):
 *   NodeHeading, NodeParagraph, NodeList, NodeListItem, NodeCodeBlock,
 *   NodeBlockquote, NodeImage, NodeThematicBreak
 *
 * Unsupported V1.0 (logged + skipped):
 *   NodeTable, NodeMathBlock, NodeAttributeView, NodeSuperBlock
 *
 * Inline marks are NOT extracted in V1.0 (always `marks: []`). The sanitized
 * HTML output carries the inline formatting; the structured JSON gets it in V1.1.
 */
export function parseSiyuanHtml(html: string): {
    blocks: SnapshotBlock[];
    unsupportedTypes: Set<string>;
} {
    const $ = load(html, { decodeEntities: true });
    const unsupportedTypes = new Set<string>();
    // Siyuan's getDoc HTML may wrap content in protyle containers
    // (.protyle-wysiwyg, .protyle-content, …) before reaching block divs.
    // Find every typed block whose nearest typed ancestor is none = real top-level.
    const topLevel = $('[data-type^="Node"]')
        .toArray()
        .filter((el) => $(el).parents('[data-type^="Node"]').length === 0);
    const blocks = parseChildBlocks(topLevel, $, unsupportedTypes);
    return { blocks, unsupportedTypes };
}

function parseChildBlocks(
    elements: Element[],
    $: CheerioAPI,
    unsupported: Set<string>,
): SnapshotBlock[] {
    const out: SnapshotBlock[] = [];
    for (const el of elements) {
        const block = parseBlock(el, $, unsupported);
        if (block) {
            out.push(block);
        }
    }
    return out;
}

function parseBlock(el: Element, $: CheerioAPI, unsupported: Set<string>): SnapshotBlock | null {
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
                children: parseChildBlocks($el.children().get(), $, unsupported),
            };
        }
        case "NodeListItem": {
            return {
                id,
                type: "NodeListItem",
                children: parseChildBlocks($el.children().get(), $, unsupported),
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
                children: parseChildBlocks($el.children().get(), $, unsupported),
            };
        }
        case "NodeThematicBreak": {
            return { id, type: "NodeThematicBreak" };
        }
        // V1.0 NOT supported — record and skip.
        case "NodeTable":
        case "NodeMathBlock":
        case "NodeAttributeView":
        case "NodeSuperBlock":
        case "NodeImage":
        default: {
            unsupported.add(type);
            return null;
        }
    }
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
    "table", "thead", "tbody", "tr", "th", "td",
];

/**
 * Sanitize Siyuan's rendered HTML and rewrite asset URLs to the public
 * stored_path. Anything outside the allowlist is stripped. `.protyle-attr`
 * divs (editor metadata) are dropped wholesale.
 */
export function renderSanitizedHtml(
    siyuanHtml: string,
    assets: Map<string, SnapshotAsset>,
): string {
    return sanitizeHtml(siyuanHtml, {
        allowedTags: ALLOWED_TAGS,
        allowedAttributes: {
            a: ["href", "title"],
            img: ["src", "alt", "title"],
            span: ["class"],
            div: ["class"],
            code: ["class"],
            pre: ["class"],
            th: ["scope"],
            "*": ["data-type", "data-node-id", "data-subtype"],
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
