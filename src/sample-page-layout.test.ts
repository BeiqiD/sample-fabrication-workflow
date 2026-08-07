import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const layout = readFileSync(new URL("./sample-page-layout.css", import.meta.url), "utf8");
const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const sizing = readFileSync(new URL("./lib/sample-details-edit-sizing.ts", import.meta.url), "utf8");

describe("sample page layout refinements", () => {
  it("uses the natural read-only Sample details height as the edit baseline", () => {
    expect(layout).not.toMatch(/\.sample-details-card\s*\{[^}]*min-height:/s);
    expect(sizing).toContain("getBoundingClientRect().height");
    expect(sizing).toContain("sampleDetailsViewHeight");
    expect(sizing).toContain("card.clientHeight - card.scrollHeight");
    expect(main).toContain("installSampleDetailsEditSizing();");
  });

  it("lets Description absorb the remaining edit height without changing field rhythm", () => {
    expect(layout).toMatch(/data-sample-details-edit-height-locked[^}]*overflow:\s*hidden/s);
    expect(layout).toMatch(/data-sample-details-edit-height-locked[\s\S]*textarea\[name="description"\][^}]*min-height:\s*0[^}]*resize:\s*none/s);
    expect(sizing).toContain("MIN_DESCRIPTION_HEIGHT = 48");
  });

  it("uses the same field hierarchy in read-only and edit typography", () => {
    expect(layout).toMatch(/\.sample-details-card dl dt,[\s\S]*\.sample-details-card \.detail-form label\s*\{[^}]*font-size:\s*12px[^}]*letter-spacing:\s*0[^}]*text-transform:\s*none/s);
    expect(layout).toMatch(/\.sample-details-card dl dd,[\s\S]*\.sample-details-card \.detail-form input,[\s\S]*font-size:\s*14px/s);
    expect(layout).toMatch(/\.sample-details-card \.sample-location-value\s*\{[^}]*font-size:\s*14px[^}]*font-weight:\s*400/s);
  });

  it("stacks note images below text as an adaptive mobile grid", () => {
    expect(layout).toMatch(/@media \(max-width:\s*720px\)[\s\S]*\.sample-note-content\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    expect(layout).toMatch(/\.sample-note-images > \.grid-diagrams\s*\{[^}]*display:\s*grid[^}]*repeat\(auto-fill,\s*minmax\(84px,\s*1fr\)\)/s);
    expect(layout).toMatch(/\.sample-note-images \.grid-diagrams\.photo-thumbnails \.grid-diagram-item > button:first-child\s*\{[^}]*width:\s*100%[^}]*aspect-ratio:\s*4 \/ 3/s);
  });
});
