import { describe, expect, it } from "vitest";
import { loadFixture, parseAndRender } from "./harness.js";

const DOC_HTML = loadFixture("doc-with-av.html");

describe("NodeTable (real Siyuan markdown table)", () => {
    it("emits a typed NodeTable block with header + body rows", () => {
        const { blocks } = parseAndRender(DOC_HTML);
        const table = blocks.find((b) => b.type === "NodeTable");
        expect(table).toBeDefined();
        if (table?.type !== "NodeTable") throw new Error("wrong type");
        expect(table.header_row).toBe(1);
        // header + 2 body rows
        expect(table.rows).toHaveLength(3);
        expect(table.rows[0].map((c) => c.text)).toEqual(["Col A", "Col B", "Col C"]);
        expect(table.rows[1].map((c) => c.text)).toEqual(["1", "2", "3"]);
        // "<baz>" is HTML-encoded in the source but our parser sees it decoded.
        expect(table.rows[2].map((c) => c.text)).toEqual(["foo", "bar", "<baz>"]);
    });

    it("HTML output preserves <table> structure", () => {
        const { html } = parseAndRender(DOC_HTML);
        expect(html).toContain("<table");
        expect(html).toContain("<thead>");
        expect(html).toContain("<th>Col A</th>");
        expect(html).toContain("<td>foo</td>");
        // The "<baz>" cell content must stay HTML-escaped.
        expect(html).toContain("&lt;baz&gt;");
        expect(html).not.toContain("<baz>");
    });

    it("table with no thead still parses as header_row=0", () => {
        const html = `
            <div data-node-id="x" data-type="NodeTable">
              <div contenteditable="false">
                <table>
                  <tbody>
                    <tr><td>a</td><td>b</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
        `;
        const { blocks } = parseAndRender(html);
        const table = blocks.find((b) => b.type === "NodeTable");
        if (table?.type !== "NodeTable") throw new Error("wrong type");
        expect(table.header_row).toBe(0);
        expect(table.rows).toHaveLength(1);
    });
});
