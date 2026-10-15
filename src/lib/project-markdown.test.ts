import { describe, expect, it } from "vitest";
import {
  projectMarkdownSafeHref,
  projectMarkdownSafeImageSrc,
  projectMarkdownStartsWithHeading,
  renderProjectMarkdown,
} from "./project-markdown";

describe("Project Markdown compatibility boundary", () => {
  it("uses the shared document renderer for GFM and TeX", () => {
    const html = renderProjectMarkdown(`# Heading

| a | b |
| - | - |
| 1 | 2 |

$$
H \\lvert \\psi \\rangle = E \\lvert \\psi \\rangle
$$`);
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<table>");
    expect(html).toContain("rich-text-math-block");
    expect(html).toContain("<math");
  });

  it("retains the Project URL and leading-heading aliases", () => {
    expect(projectMarkdownSafeHref("/projects/a")).toBe("/projects/a");
    expect(projectMarkdownSafeHref("javascript:alert(1)")).toBeNull();
    expect(projectMarkdownSafeImageSrc("https://example.com/image.png"))
      .toBe("https://example.com/image.png");
    expect(projectMarkdownStartsWithHeading("Canonical title\n==============="))
      .toBe(true);
    expect(projectMarkdownStartsWithHeading("    # shell comment")).toBe(false);
  });
});
