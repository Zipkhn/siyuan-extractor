import { describe, expect, it } from "vitest";
import { parseAndRender } from "./harness.js";

describe("smoke — already-supported V1.0 blocks", () => {
    it("parses a heading + paragraph snapshot", () => {
        const html = `
            <div data-type="NodeHeading" data-node-id="20260517090000-aaaaaaa" data-subtype="h2">
                <div contenteditable="true">Section title</div>
                <div class="protyle-attr"></div>
            </div>
            <div data-type="NodeParagraph" data-node-id="20260517090000-bbbbbbb">
                <div contenteditable="true">Hello world.</div>
                <div class="protyle-attr"></div>
            </div>
        `;
        const { blocks, unsupportedTypes } = parseAndRender(html);
        expect(unsupportedTypes.size).toBe(0);
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toMatchObject({ type: "NodeHeading", level: 2, text: "Section title" });
        expect(blocks[1]).toMatchObject({ type: "NodeParagraph", text: "Hello world." });
    });
});
