import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("shared Comment Markdown and TeX contract", () => {
  it("keeps one safe renderer core with separate document and comment policies", () => {
    const renderer = read("src/lib/rich-text.ts");
    expect(renderer).toContain('export type RichTextMode = "document" | "comment"');
    expect(renderer).toContain('breaks: mode === "comment"');
    expect(renderer).toContain('mode === "comment"');
    expect(renderer).toContain('class="rich-text-image-link"');
    expect(renderer).toContain("Temml.renderToString");
    expect(renderer).toContain("maxExpand: 1_000");
    expect(renderer).toContain("maxSize: [20, 200]");
    expect(renderer).toContain("renderer.html = ({ text }) => escapeRichTextHtml(text)");
  });

  it("loads the shared renderer lazily from comment surfaces", () => {
    const body = read("src/components/CommentBody.tsx");
    expect(body).toContain('lazy(() => import("./RichText")');
    expect(body).toContain("<Suspense");
    expect(body).not.toContain('from "../lib/rich-text"');
  });

  it("renders every published Comment body without changing composer or attachment ownership", () => {
    const sample = read("src/pages/SamplePage.tsx");
    const grid = read("src/components/MultiSampleRunGrid.tsx");
    const timeline = read("src/components/SampleTimeline.tsx");
    const composer = read("src/components/CommentComposer.tsx");

    expect(sample).toContain("<CommentBody source={note.body} />");
    expect(grid).toContain("<CommentBody source={comment.body} />");
    expect(timeline).toContain('? <CommentBody source={event.body} />');
    expect(sample).not.toContain("<p>{note.body}</p>");
    expect(grid).not.toContain("<p>{comment.body}</p>");
    expect(composer).toContain("<textarea");
    expect(composer).toContain("prepareCommentImage");
    expect(composer).not.toContain("CommentBody");
    expect(composer).not.toContain("RichText");
  });

  it("keeps Project Reading on the same shared renderer without moving its lazy boundary", () => {
    const projectWrapper = read("src/components/project/ProjectMarkdown.tsx");
    const projectPage = read("src/pages/ProjectPage.tsx");
    expect(projectWrapper).toContain('import { RichText } from "../RichText"');
    expect(projectWrapper).toContain('mode="document"');
    expect(projectPage).toContain('lazy(() => import("../components/project/ProjectReadingSurface")');
  });
});
