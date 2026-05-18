import { describe, expect, it } from "vitest";
import { convertAttributeView, type AvBundle } from "../av.js";
import type { AvBlockMap } from "../renderer.js";
import type { SiyuanAvRender } from "../siyuan-client.js";
import { loadFixture, parseAndRender } from "./harness.js";

const DOC_HTML = loadFixture("doc-with-av.html");
const AV_JSON = JSON.parse(loadFixture("av-render.json")) as SiyuanAvRender;
// Real block IDs captured from the dev stack on 2026-05-17.
const NODE_ID = "20260517092721-lwxy0t5";

/** Wrap a single SiyuanAvRender into an AvBundle (1-view shape) for tests. */
function bundleFrom(render: SiyuanAvRender): AvBundle {
    return {
        avId: render.id,
        avName: render.name,
        defaultViewId: render.viewID,
        renders: [render],
    };
}

function avMap(): AvBlockMap {
    return { byNodeId: new Map([[NODE_ID, bundleFrom(AV_JSON)]]) };
}

describe("convertAttributeView — typed JSON shape (real fixture)", () => {
    it("preserves AV name and exposes the default view via views[]", () => {
        const { block } = convertAttributeView(NODE_ID, bundleFrom(AV_JSON));
        expect(block.type).toBe("NodeAttributeView");
        if (block.type !== "NodeAttributeView") return;
        expect(block.id).toBe(NODE_ID);
        expect(block.av_name).toBe("DB démo");
        expect(block.default_view_id).toBe(AV_JSON.viewID);
        expect(block.views).toHaveLength(1);
        const v = block.views[0];
        expect(v.type).toBe("table");
        expect(v.name).toBe("Table");
        expect(v.columns.map((c) => c.name)).toEqual([
            "Primary Key",
            "name",
            "Number",
            "Date",
        ]);
        expect(v.columns.map((c) => c.type)).toEqual([
            "block",
            "text",
            "number",
            "date",
        ]);
    });

    it("formats every cell type to a display string in column order", () => {
        const { block } = convertAttributeView(NODE_ID, bundleFrom(AV_JSON));
        if (block.type !== "NodeAttributeView") throw new Error("wrong type");
        const v = block.views[0];
        expect(v.rows).toHaveLength(1);
        const row = v.rows[0];
        expect(row.id).toBe("20260517092934-yfc9mwv");
        // [block, text, number, date]
        expect(row.cells[0]).toBe("1");
        expect(row.cells[1]).toBe("KOKO");
        expect(row.cells[2]).toBe("34");
        expect(row.cells[3]).toMatch(/^2026-05-1[67]$/);
    });
});

describe("convertAttributeView — synthesized HTML fallback", () => {
    it("emits a <table class=\"av-block\"> with caption, thead, tbody (default view)", () => {
        const { html } = convertAttributeView(NODE_ID, bundleFrom(AV_JSON));
        expect(html).toContain('<table class="av-block">');
        expect(html).toContain("<caption>DB démo</caption>");
        expect(html).toContain('<th scope="col" data-av-col-type="block">Primary Key</th>');
        expect(html).toContain('<th scope="col" data-av-col-type="text">name</th>');
        expect(html).toContain("<tbody>");
        expect(html).toContain("<td>KOKO</td>");
        expect(html).toContain("<td>34</td>");
    });

    it("escapes user content to prevent HTML injection", () => {
        const malicious: SiyuanAvRender = JSON.parse(JSON.stringify(AV_JSON));
        malicious.view.rows![0].cells[1].value.text!.content = '<script>x</script>';
        const { html } = convertAttributeView(NODE_ID, bundleFrom(malicious));
        expect(html).not.toContain("<script>x</script>");
        expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    });
});

describe("parseAndRender — full pipeline with real Siyuan placeholder HTML", () => {
    it("emits a typed NodeAttributeView block + wrapped <av-placeholder>", () => {
        const { blocks, html, unsupportedTypes } = parseAndRender(
            DOC_HTML,
            new Map(),
            avMap(),
        );
        expect(unsupportedTypes.has("NodeAttributeView")).toBe(false);
        const avBlock = blocks.find((b) => b.type === "NodeAttributeView");
        expect(avBlock).toBeDefined();
        if (avBlock?.type !== "NodeAttributeView") throw new Error("wrong type");
        expect(avBlock.views).toHaveLength(1);
        expect(avBlock.views[0].rows[0].cells).toContain("KOKO");

        // The sanitized HTML now wraps AV blocks in <av-placeholder> with the
        // synthesized <table> as fallback inside.
        expect(html).toContain("<av-placeholder");
        expect(html).toContain(`data-node-id="${NODE_ID}"`);
        expect(html).toContain('<table class="av-block">');
        expect(html).toContain("KOKO");
        // Verify the doc structure also kept the other blocks (heading + code block).
        expect(html).toContain("test titre h1");
    });

    it("falls back gracefully when AV data wasn't pre-fetched", () => {
        const { blocks, html, unsupportedTypes } = parseAndRender(DOC_HTML, new Map());
        expect(unsupportedTypes.has("NodeAttributeView")).toBe(true);
        expect(blocks.find((b) => b.type === "NodeAttributeView")).toBeUndefined();
        // Non-AV blocks still render normally.
        expect(html).toContain("test titre h1");
    });

    it("treats unknown column types as 'unknown' without crashing", () => {
        const synthetic: SiyuanAvRender = JSON.parse(JSON.stringify(AV_JSON));
        synthetic.view.columns![1].type = "fancyNewType" as never;
        synthetic.view.rows![0].cells[1].valueType = "fancyNewType" as never;
        synthetic.view.rows![0].cells[1].value.type = "fancyNewType" as never;
        const { block } = convertAttributeView(NODE_ID, bundleFrom(synthetic));
        if (block.type !== "NodeAttributeView") throw new Error("wrong type");
        const v = block.views[0];
        expect(v.columns[1].type).toBe("unknown");
        expect(typeof v.rows[0].cells[1]).toBe("string");
    });
});
