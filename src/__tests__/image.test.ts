import { describe, expect, it } from "vitest";
import { loadFixture, parseAndRender } from "./harness.js";

const DOC_HTML = loadFixture("doc-with-av.html");

describe("NodeImage (image-only paragraph promoted to typed block)", () => {
    it("emits NodeImage block with asset_path, alt and caption from the real fixture", () => {
        const { blocks } = parseAndRender(DOC_HTML);
        const img = blocks.find((b) => b.type === "NodeImage");
        expect(img).toBeDefined();
        if (img?.type !== "NodeImage") throw new Error("wrong type");
        expect(img.asset_path).toBe("assets/test-fixture.png");
        expect(img.alt).toBe("Mon image");
        // The markdown `![alt](src "title")` form puts "title" as caption.
        expect(img.caption).toBe("Légende ici");
    });

    it("mixed text + image paragraph stays a paragraph (image preserved in HTML)", () => {
        const html = `
            <div data-type="NodeParagraph" data-node-id="p1">
              <div contenteditable="true">
                Hello
                <span contenteditable="false" data-type="img" class="img">
                  <img src="assets/foo.png" alt="" />
                </span>
                world
              </div>
            </div>
        `;
        const { blocks, html: out } = parseAndRender(html);
        const p = blocks.find((b) => b.type === "NodeParagraph");
        expect(p).toBeDefined();
        if (p?.type !== "NodeParagraph") throw new Error("wrong type");
        expect(p.text).toContain("Hello");
        expect(p.text).toContain("world");
        // No NodeImage block emitted for mixed paragraph.
        expect(blocks.find((b) => b.type === "NodeImage")).toBeUndefined();
        // The img tag should still survive in sanitized HTML.
        expect(out).toContain("<img");
    });

    it("paragraph with two images stays a paragraph (multi-image not yet typed)", () => {
        const html = `
            <div data-type="NodeParagraph" data-node-id="p2">
              <div contenteditable="true">
                <span contenteditable="false" data-type="img" class="img"><img src="assets/a.png" alt="A" /></span>
                <span contenteditable="false" data-type="img" class="img"><img src="assets/b.png" alt="B" /></span>
              </div>
            </div>
        `;
        const { blocks } = parseAndRender(html);
        expect(blocks.find((b) => b.type === "NodeImage")).toBeUndefined();
        expect(blocks.find((b) => b.type === "NodeParagraph")).toBeDefined();
    });
});
