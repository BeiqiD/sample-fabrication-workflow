import { describe, expect, it } from "vitest";
import {
  projectMarkdownSafeHref,
  projectMarkdownSafeImageSrc,
  projectMarkdownStartsWithHeading,
  renderProjectMarkdown,
} from "./project-markdown";

describe("Project rich Markdown", () => {
  it("renders GFM structure from the canonical Markdown source", () => {
    const html = renderProjectMarkdown(`# Heading

- [x] measured
- [ ] reviewed

| a | b |
| - | - |
| 1 | 2 |

~~deprecated~~`);
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<table>");
    expect(html).toContain("<del>deprecated</del>");
  });

  it("renders inline and display TeX as MathML", () => {
    const html = renderProjectMarkdown(`The state is $\\lvert \\psi \\rangle$.

$$
H \\lvert \\psi \\rangle = E \\lvert \\psi \\rangle
$$`);
    expect(html).toContain("project-markdown-math-inline");
    expect(html).toContain("project-markdown-math-block");
    expect(html).toContain("<math");
    expect(html).toContain("H");
  });

  it("renders raw HTML literally instead of executing it", () => {
    const html = renderProjectMarkdown(`<script>alert("x")</script>

<img src=x onerror=alert(1)>`);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("removes unsafe link and image destinations while preserving safe relative and HTTPS URLs", () => {
    const html = renderProjectMarkdown(`[unsafe](javascript:alert(1)) ![bad](data:text/html,boom)

[safe](/projects/a) [external](https://example.com/research) ![remote](https://example.com/image.png)`);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).toContain('href="/projects/a"');
    expect(html).toContain('href="https://example.com/research"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('src="https://example.com/image.png"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(projectMarkdownSafeHref("mailto:researcher@example.com")).toBe("mailto:researcher@example.com");
    expect(projectMarkdownSafeHref("//example.com/path")).toBeNull();
    expect(projectMarkdownSafeHref("/\\evil.example/research")).toBeNull();
    expect(projectMarkdownSafeImageSrc("mailto:researcher@example.com")).toBeNull();
  });
  it("recognizes Setext titles without mistaking indented code for a heading", () => {
    expect(projectMarkdownStartsWithHeading("Title\n=====")).toBe(true);
    expect(projectMarkdownStartsWithHeading("Title\n-----")).toBe(true);
    expect(projectMarkdownStartsWithHeading("    # shell comment")).toBe(false);
  });

});
