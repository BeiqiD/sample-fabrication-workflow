import { describe, expect, it } from "vitest";
import {
  renderRichText,
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
});
