import { describe, expect, it } from "vitest";
import {
  renderRichText,
  escapeRichTextHtml,
  richTextSafeHref,
  richTextSafeImageSrc,
  richTextStartsWithHeading,
} from "./rich-text";

describe("shared rich-text renderer", () => {
  it("renders document GFM, TeX, and remote images", () => {
    const html = renderRichText(`# Heading

- [x] measured
- [ ] reviewed

The state is $\\lvert \\psi \\rangle$.

![AFM](https://example.com/afm.png)`, "document");

    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("rich-text-math-inline");
    expect(html).toContain("<math");
    expect(html).toContain('src="https://example.com/afm.png"');
    expect(html).toContain('referrerpolicy="no-referrer"');
  });

  it("keeps comments compact, preserves single line breaks, and avoids page headings", () => {
    const html = renderRichText(`# Observation
First line
Second line`, "comment");

    expect(html).toContain('class="rich-text-comment-heading"');
    expect(html).toContain('data-heading-level="1"');
    expect(html).not.toContain("<h1");
    expect(html).toMatch(/First line<br>\s*Second line/);
  });

  it("demotes Markdown images to links in comments so attachments remain separate", () => {
    const html = renderRichText(`![AFM surface](https://example.com/afm.png)`, "comment");

    expect(html).not.toContain("<img");
    expect(html).toContain('class="rich-text-image-link"');
    expect(html).toContain('href="https://example.com/afm.png"');
    expect(html).toContain("Image: AFM surface");
  });

  it("renders raw HTML literally and rejects unsafe destinations in both modes", () => {
    const source = `<script>alert("x")</script>

[unsafe](javascript:alert(1)) ![bad](data:text/html,boom)`;
    for (const mode of ["document", "comment"] as const) {
      const html = renderRichText(source, mode);
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("data:text/html");
      expect(html).toContain("&lt;script&gt;");
    }
  });

  it("retains the URL and leading-heading safety contract", () => {
    expect(richTextSafeHref("mailto:researcher@example.com")).toBe("mailto:researcher@example.com");
    expect(richTextSafeHref("//example.com/path")).toBeNull();
    expect(richTextSafeHref("/\\evil.example/research")).toBeNull();
    expect(richTextSafeImageSrc("mailto:researcher@example.com")).toBeNull();
    expect(richTextStartsWithHeading("Title\n=====")).toBe(true);
    expect(richTextStartsWithHeading("    # shell comment")).toBe(false);
  });

  it.each(["document", "comment"] as const)("renders explicit TeX whitespace and escaped dollars in %s", (mode) => {
    for (const source of ["\\( x^2 \\)", "\\(\nx^2\n\\)"]) {
      const html = renderRichText(source, mode);
      expect(html).toContain("<msup>");
      expect(html).not.toContain("<br>");
    }
    for (const source of ["$\\text{cost \\$5}$", "$\\text{cost \\$}$"]) {
      const html = renderRichText(source, mode);
      expect(html).toContain("<mtext>cost");
      expect(html).not.toContain("rich-text-math-error");
      expect(html).not.toContain("temml-error");
    }
  });

  it.each(["document", "comment"] as const)("keeps unmatched display markers in their original paragraph in %s", (mode) => {
    expect(renderRichText("Before $$missing", mode)).toBe("<p>Before $$missing</p>\n");
    expect(renderRichText("Before $$x$$ after", mode)).toBe("<p>Before $$x$$ after</p>\n");
    expect(renderRichText("Before \\[missing", mode)).toBe("<p>Before [missing</p>\n");
    const html = renderRichText("Paragraph\n  $$x^2$$\nAfter", mode);
    expect(html).toContain("<p>Paragraph</p>");
    expect(html).toContain("rich-text-math-block");
    expect(html).toContain("<p>After</p>");
  });

  it.each(["document", "comment"] as const)("preserves literal code and currency in %s", (mode) => {
    expect(renderRichText("Cost is \\$5", mode)).toBe("<p>Cost is $5</p>\n");
    for (const source of ["\`$x^2$\`", "\`$$x^2$$\`", "\`\`\`\n$$x^2$$\n\`\`\`", "~~~tex\n\\[x^2\\]\n~~~", "    $$x^2$$"]) {
      const html = renderRichText(source, mode);
      expect(html).toContain("<code");
      expect(html).not.toContain("<math");
    }
    for (const source of ["$ x^2 $", "$x\n+y$", "$x\\\n+y$", "\\\\(x^2\\\\)", "\\$x^2\\$"]) {
      expect(renderRichText(source, mode)).not.toContain("<math");
    }
  });

  it.each(["document", "comment"] as const)("renders complete fractions, scripts and matrices in %s", (mode) => {
    const fraction = renderRichText("$$\n\\frac{1}{1+x_0^2}\n$$", mode);
    expect(fraction).toContain("<mfrac>");
    expect(fraction).toContain("<msubsup>");
    for (const source of ["\\[\n\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\n\\]", "$$\n\\begin{aligned}a&=b+c\\\\d&=e+f\\end{aligned}\n$$"]) {
      const html = renderRichText(source, mode);
      expect(html).toContain("<mtable");
      expect(html).toContain("rich-text-math-block");
      expect(html).not.toContain("rich-text-math-error");
    }
  });

  it.each(["document", "comment"] as const)("keeps malformed TeX readable without embedding parser errors in %s", (mode) => {
    const html = renderRichText("$\\frac{1}{$", mode);
    expect(html).toContain('class="rich-text-math-error"');
    expect(html).toContain("\\frac{1}{");
    expect(html).not.toContain("ParseError");
    expect(html).not.toContain("temml-error");
  });

  it.each(["document", "comment"] as const)("keeps large unmatched display markers readable in %s", (mode) => {
    const source = `Before\n${"\\[\n".repeat(16_000)}`;
    const html = renderRichText(source, mode);
    expect(html).not.toContain("rich-text-fallback");
    expect(html).not.toContain("<math");
    expect(html.match(/\[/g)).toHaveLength(16_000);
  });

  it.each(["document", "comment"] as const)("bounds repeated unsuccessful delimiter scans with escaped source fallback in %s", (mode) => {
    // Check the deterministic fallback instead of imposing a machine-dependent
    // deadline. These cases used to rescan each remaining suffix synchronously.
    for (const marker of ["\\(\n", "\\(missing\\\\)\n", "$$ x ", "\\[\n# Heading\n"]) {
      const source = `Before <script>alert(1)</script>\n${marker.repeat(4_000)}`;
      expect(renderRichText(source, mode))
        .toBe(`<pre class="rich-text-fallback"><code>${escapeRichTextHtml(source)}</code></pre>`);
    }
    // An exhausted lexer must not affect another comment/document render.
    expect(renderRichText("$x^2$", mode)).toContain("<msup>");
  });

  it.each(["document", "comment"] as const)("preserves later complete math across Markdown and newline boundaries in %s", (mode) => {
    for (const source of [
      "$unclosed\n$x^2$",
      "> \\(missing\n\nParagraph \\( y^2 \\)",
      "- \\[missing\n\nParagraph\n\\[z^2\\]",
    ]) {
      const html = renderRichText(source, mode);
      expect(html).toContain("<msup>");
      expect(html).not.toContain("rich-text-fallback");
    }
  });

  it.each(["document", "comment"] as const)("retains long documents containing many legitimate formulas in %s", (mode) => {
    const section = `${"Ordinary text ".repeat(16)}$\\frac{1}{1+x_0^2}$.\n\n\\[x^2+y^2=z^2\\]\n\n`;
    const source = section.repeat(600);
    expect(source.length).toBeGreaterThan(150_000);
    const html = renderRichText(source, mode);
    expect(html).not.toContain("rich-text-fallback");
    expect(html).not.toContain("rich-text-math-error");
    expect(html.match(/<mfrac>/g)).toHaveLength(600);
    expect(html.match(/rich-text-math-block/g)).toHaveLength(600);
  });

});
