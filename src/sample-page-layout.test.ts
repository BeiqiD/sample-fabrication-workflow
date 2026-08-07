import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const layout = readFileSync(new URL("./sample-page-layout.css", import.meta.url), "utf8");
const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");

describe("sample page layout refinements", () => {
  it("keeps the sample Description editor tall enough to avoid a card-height jump", () => {
    expect(layout).toMatch(/\.sample-details-card textarea\[name="description"\]\s*\{[^}]*min-height:\s*128px/s);
    expect(main).toContain('import "./sample-page-layout.css"');
  });

  it("stacks note images below text as an adaptive mobile grid", () => {
    expect(layout).toMatch(/@media \(max-width:\s*720px\)[\s\S]*\.sample-note-content\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    expect(layout).toMatch(/\.sample-note-images > \.grid-diagrams\s*\{[^}]*display:\s*grid[^}]*repeat\(auto-fill,\s*minmax\(84px,\s*1fr\)\)/s);
    expect(layout).toMatch(/\.sample-note-images \.grid-diagrams\.photo-thumbnails \.grid-diagram-item > button:first-child\s*\{[^}]*width:\s*100%[^}]*aspect-ratio:\s*4 \/ 3/s);
  });
});
