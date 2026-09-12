import { describe, expect, it } from "vitest";
import { referenceCommentExcerpt, referenceCommentTitle } from "./reference-comment-preview";
import { renderRichText } from "../src/lib/rich-text";

describe("bounded Comment reference previews", () => {
  it("preserves the exact paragraph structure of short inline and display math", () => {
    const source = String.raw`Diffusion check: $L=\sqrt{2Dt}$.

$$
D=D_0 e^{-E_a/(k_B T)}
$$`;
    expect(referenceCommentExcerpt(source)).toBe(source);
    expect(referenceCommentExcerpt(source.replaceAll("\n", "\r\n"))).toBe(source);
  });

  it("uses a complete paragraph prefix and omits an oversized first paragraph", () => {
    const first = "Complete context paragraph.";
    expect(referenceCommentExcerpt(`${first}\n\n${"long ".repeat(70)}`)).toBe(first);
    expect(referenceCommentExcerpt("long ".repeat(70))).toBeNull();
    expect(referenceCommentExcerpt(null)).toBeNull();
    expect(referenceCommentExcerpt("   ")).toBeNull();
  });

  it.each([
    ["$$", "$$"], ["\\[", "\\]"], ["\\(", "\\)"], ["$", "$"],
  ])("does not stop inside %s math even when it crosses empty lines", (opening, closing) => {
    const formula = `${opening}\nx=1\n\n${"a + ".repeat(80)}z\n${closing}`;
    expect(referenceCommentExcerpt(`Context.\n\n${formula}`)).toBe("Context.");
    expect(referenceCommentExcerpt(formula)).toBeNull();
  });

  it("retains a complete cross-paragraph display formula that fits before the next paragraph", () => {
    const first = "Context.\n\n$$\na=1\n\nb=2\n$$";
    expect(referenceCommentExcerpt(`${first}\n\n${"next ".repeat(70)}`)).toBe(first);
  });

  it.each(["```tex", "````tex", "~~~tex"])("does not manufacture a closed preview from a split %s fence", (opening) => {
    const closing = opening.replace(/tex$/, "");
    expect(referenceCommentExcerpt(`Context.\n\n${opening}\nx=1\n\n${"a ".repeat(160)}\n${closing}`))
      .toBe("Context.");
  });

  it("omits a prefix ending inside a double-backtick code span", () => {
    expect(referenceCommentExcerpt(`Context.\n\nUse \`\`the first line\n\n${"a ".repeat(160)}\`\``))
      .toBe("Context.");
  });

  it.each([
    "Use `$$` for display math.",
    "Use ``a ` $$ literal`` for display math.",
    "Use `\\` and `$$` for display math.",
  ])("does not count delimiters in closed inline code: %s", (first) => {
    const source = `${first}\n\n$$\nx=1\n\n${"a + ".repeat(70)}z\n$$`;
    const preview = referenceCommentExcerpt(source);
    expect(renderRichText(source, "comment")).toContain("<math");
    expect(preview).toBe(first);
    expect(renderRichText(preview!, "comment")).not.toContain("x=1");
  });

  it("pairs exact backtick runs instead of counting nested runs as separate spans", () => {
    const first = "Use `a `` b` as literal text.";
    expect(referenceCommentExcerpt(`${first}\n\n${"later ".repeat(70)}`)).toBe(first);
  });

  it("does not pair a code opener across a real display-math block interruption", () => {
    const source = `Context.\n\nUse \`literal\n$$\nx=1 \`\n\n${"a + ".repeat(70)}z\n$$`;
    expect(referenceCommentExcerpt(source)).toBe("Context.");
    expect(renderRichText(source, "comment")).toContain("<math");
  });

  it("does not interpret backticks inside a TeX expression as Markdown code", () => {
    const first = "Context.\n\n\\[\n\\text{` is literal}\n\\]";
    expect(referenceCommentExcerpt(`${first}\n\n${"later ".repeat(70)}`)).toBe(first);
    expect(renderRichText(first, "comment")).toContain("<math");
  });

  it.each(["~~~", "```"])("does not cut a %s fence nested inside a list", (fence) => {
    const first = "Context.\n\n1. Example:";
    const source = `${first}\n\n    ${fence}tex\n    x=1\n\n    ${"a + ".repeat(70)}z\n    ${fence}`;
    expect(referenceCommentExcerpt(source)).toBe(first);
    expect(renderRichText(source, "comment")).toContain('<pre><code class="language-tex">');
  });

  it.each(["- ", "> ", "> - ", "  > 1. ", "\t"])(
    "conservatively omits an ambiguous nested fence with prefix %j", (prefix) => {
      const source = `Context.\n\n${prefix}~~~tex\nx=1\n\n${"later ".repeat(70)}\n~~~`;
      expect(referenceCommentExcerpt(source)).toBe("Context.");
    },
  );

  it.each([
    "[A](https://example.com/$$)",
    '[A](https://example.com "$$")',
    "[A](https://example.com/(part)/$$)",
    "<https://example.com/$$>",
    "[A]: https://example.com/$$",
    "[A](\nhttps://example.com/$$\n)",
    '[A](https://example.com\n"$$")',
    "[A]:\n  https://example.com/$$",
  ])("does not allow non-rendered link delimiters to close real math: %s", (link) => {
    const source = `Context.\n\n${link}\n\n$$\nx=1\n\n${"a + ".repeat(70)}z\n$$`;
    expect(referenceCommentExcerpt(source)).toBe("Context.");
    expect(renderRichText(source, "comment")).toContain("<math");
  });

  it("retains ordinary links followed by complete math in a bounded paragraph", () => {
    const first = "[Paper](https://example.com/a_(b)) gives $L=2$.";
    expect(referenceCommentExcerpt(`${first}\n\n${"later ".repeat(70)}`)).toBe(first);
  });

  it.each([
    "<div>$$</div>",
    "<div>\n$$\n</div>",
    "<!-- $$ -->",
    "Use $$ for display math.",
    "    $$",
  ])("does not count other literal display delimiters as mathematical blocks: %s", (literal) => {
    const source = `Context.\n\n${literal}\n\n$$\nx=1\n\n${"a + ".repeat(70)}z\n$$`;
    expect(referenceCommentExcerpt(source)).toBe("Context.");
    expect(renderRichText(source, "comment")).toContain("<math");
  });

  it.each(["~", "`"])("requires a %s fence closer at least as long as its opener", (marker) => {
    const start = `${marker.repeat(4)}tex\na=1\n${marker.repeat(3)}`;
    expect(referenceCommentExcerpt(`${start}\n\n${"long ".repeat(70)}\n${marker.repeat(4)}`)).toBeNull();
    expect(referenceCommentExcerpt(`Context.\n\n${start}\n\n${"long ".repeat(70)}\n${marker.repeat(4)}`))
      .toBe("Context.");
    const closed = `${marker.repeat(4)}tex\na=1\n${marker.repeat(5)}`;
    expect(referenceCommentExcerpt(`${closed}\n\n${"later ".repeat(70)}`)).toBe(closed);
  });

  it("does not mistake escaped dollar signs for open math at a paragraph boundary", () => {
    const first = String.raw`Cost is \$50.`;
    expect(referenceCommentExcerpt(`${first}\n\n${"later ".repeat(70)}`)).toBe(first);
  });

  it("keeps complete malformed short source for the existing safe renderer fallback", () => {
    expect(referenceCommentExcerpt("Unclosed $x")).toBe("Unclosed $x");
  });

  it("takes a textual first-line title without copying formula or fence source into the heading", () => {
    expect(referenceCommentTitle("# Diffusion check\n\n$$x$$")).toBe("Diffusion check");
    expect(referenceCommentTitle(String.raw`Diffusion length $L=\sqrt{2Dt}$`)).toBe("Diffusion length");
    expect(referenceCommentTitle(String.raw`$L=\sqrt{2Dt}$`)).toBe("Comment");
    expect(referenceCommentTitle("$$\nx=1\n$$", "Step Comment")).toBe("Step Comment");
    expect(referenceCommentTitle("```tex\nx=1\n``` ")).toBe("Comment");
    expect(referenceCommentTitle("🧪".repeat(50) + " experiment")).not.toMatch(/[\ud800-\udfff]…$/u);
  });
});
