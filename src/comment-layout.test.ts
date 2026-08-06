import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const layout = readFileSync(new URL("./comment-layout.css", import.meta.url), "utf8");
const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");

describe("common execution comment images", () => {
  it("loads the common-comment overrides after the shared palette", () => {
    expect(main.indexOf('import "./comment-layout.css"')).toBeGreaterThan(main.indexOf('import "./palette.css"'));
  });

  it("stacks image thumbnails below the full-width comment copy in the plan column", () => {
    expect(layout).toMatch(/\.common-comments \.common-comment \.comment-card-content\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    expect(layout).toMatch(/\.common-comments \.common-comment \.comment-thumbnail-gallery \.grid-diagrams\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*72px\)/s);
    expect(layout).toMatch(/\.common-comments \.common-comment \.comment-thumbnail-gallery \.grid-diagram-item > button:first-child\s*\{[^}]*height:\s*58px/s);
    expect(layout).not.toContain(".process-plan-comment-dialog .comment-card-content");
  });

  it("describes the drop target as accepting both images and attachments", () => {
    expect(layout).toContain('content: "Drop images or attachments"');
  });
});
