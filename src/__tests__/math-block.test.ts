import { describe, expect, it } from "vitest";
import { loadFixture, parseAndRender } from "./harness.js";

const DOC_HTML = loadFixture("doc-with-av.html");

describe("NodeMathBlock", () => {
    it("extracts LaTeX source from data-content (real fixture)", () => {
        const { blocks } = parseAndRender(DOC_HTML);
        const math = blocks.find((b) => b.type === "NodeMathBlock");
        expect(math).toBeDefined();
        if (math?.type !== "NodeMathBlock") throw new Error("wrong type");
        expect(math.text).toBe("E = mc^2\n\\int_0^\\infty x^2 dx");
    });

    it("hydrates the empty inner div into <pre class=\"math-block\">$$...$$</pre>", () => {
        const { html } = parseAndRender(DOC_HTML);
        expect(html).toMatch(/<pre class="math-block" data-latex="[^"]*">\$\$ [^<]*\$\$<\/pre>/);
        expect(html).toContain("E = mc^2");
    });

    it("LaTeX containing HTML-dangerous chars is HTML-escaped in both attr and text", () => {
        const html = `
            <div data-node-id="m1" data-type="NodeMathBlock" data-subtype="math" data-content="a < b &amp; c > d">
              <div spin="1"></div>
            </div>
        `;
        const { blocks, html: out } = parseAndRender(html);
        const math = blocks.find((b) => b.type === "NodeMathBlock");
        if (math?.type !== "NodeMathBlock") throw new Error("wrong type");
        // The parser receives the decoded LaTeX source from cheerio.
        expect(math.text).toBe("a < b & c > d");
        // The rendered HTML must escape it so it can't break the page.
        expect(out).not.toContain("a < b & c > d");
        expect(out).toContain("a &lt; b");
        expect(out).toContain("&gt; d");
    });
});
