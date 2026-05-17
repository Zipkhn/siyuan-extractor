import { describe, expect, it } from "vitest";
import { loadFixture, parseAndRender } from "./harness.js";

const DOC_HTML = loadFixture("doc-with-av.html");

describe("NodeSuperBlock", () => {
    it("emits typed block with layout and recursively parses children (real fixture)", () => {
        const { blocks } = parseAndRender(DOC_HTML);
        const sb = blocks.find((b) => b.type === "NodeSuperBlock");
        expect(sb).toBeDefined();
        if (sb?.type !== "NodeSuperBlock") throw new Error("wrong type");
        expect(sb.layout).toBe("row");
        // Two paragraph children, one with "Gauche", one with "Droite".
        expect(sb.children).toHaveLength(2);
        const texts = sb.children.map((c) => (c.type === "NodeParagraph" ? c.text : ""));
        expect(texts).toEqual(["Gauche", "Droite"]);
    });

    it("col layout is preserved", () => {
        const html = `
            <div data-node-id="sb1" data-type="NodeSuperBlock" data-sb-layout="col" class="sb">
              <div data-node-id="p1" data-type="NodeParagraph">
                <div contenteditable="true">a</div>
              </div>
              <div data-node-id="p2" data-type="NodeParagraph">
                <div contenteditable="true">b</div>
              </div>
            </div>
        `;
        const { blocks } = parseAndRender(html);
        const sb = blocks.find((b) => b.type === "NodeSuperBlock");
        if (sb?.type !== "NodeSuperBlock") throw new Error("wrong type");
        expect(sb.layout).toBe("col");
    });

    it("missing/unknown layout falls back to row", () => {
        const html = `
            <div data-node-id="sb2" data-type="NodeSuperBlock" class="sb">
              <div data-node-id="p1" data-type="NodeParagraph">
                <div contenteditable="true">x</div>
              </div>
            </div>
        `;
        const { blocks } = parseAndRender(html);
        const sb = blocks.find((b) => b.type === "NodeSuperBlock");
        if (sb?.type !== "NodeSuperBlock") throw new Error("wrong type");
        expect(sb.layout).toBe("row");
    });

    it("HTML preserves the layout marker via data-sb-layout attribute", () => {
        const { html } = parseAndRender(DOC_HTML);
        expect(html).toMatch(/data-type="NodeSuperBlock"[^>]*data-sb-layout="row"|data-sb-layout="row"[^>]*data-type="NodeSuperBlock"/);
    });
});
