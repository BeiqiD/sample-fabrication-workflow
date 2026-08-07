import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const layout = readFileSync(new URL("./sample-page-layout.css", import.meta.url), "utf8");
const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("./pages/SamplePage.tsx", import.meta.url), "utf8");

describe("sample page layout refinements", () => {
  it("uses the natural read-only Sample details content as the edit baseline without runtime measurement", () => {
    expect(page).toContain('className="sample-details-mode-stack"');
    expect(page).toContain('className={`sample-details-view${editingDetails ? " is-hidden" : ""}`}');
    expect(page).toContain('aria-hidden={editingDetails}');
    expect(page).toContain('className="detail-form sample-identity-form sample-details-edit-form"');
    expect(layout).toMatch(/\.sample-details-mode-stack\s*\{[^}]*position:\s*relative/s);
    expect(layout).toMatch(/\.sample-details-edit-form\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*height:\s*100%/s);
    expect(main).not.toContain("installSampleDetailsEditSizing");
    expect(main).not.toContain("sample-details-edit-sizing");
  });

  it("lets Description absorb the fixed edit layer while preserving access at narrow heights", () => {
    expect(page).toContain('className="sample-details-description-field"');
    expect(layout).toMatch(/\.sample-details-edit-form\s*\{[^}]*grid-template-rows:[^;}]*minmax\(48px,\s*1fr\)[^}]*overflow:\s*auto/s);
    expect(layout).toMatch(/\.sample-details-description-field\s*\{[^}]*grid-template-rows:\s*auto minmax\(48px,\s*1fr\)/s);
    expect(layout).toMatch(/\.sample-details-description-field textarea\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0[^}]*resize:\s*none/s);
  });

  it("keeps the complete read-only details and Delete area as the stable geometry source", () => {
    const viewStart = page.indexOf('className={`sample-details-view');
    const formStart = page.indexOf('className="detail-form sample-identity-form sample-details-edit-form"', viewStart);
    expect(viewStart).toBeGreaterThanOrEqual(0);
    expect(formStart).toBeGreaterThan(viewStart);
    const view = page.slice(viewStart, formStart);
    expect(view).toContain("<dt>Parent</dt>");
    expect(view).toContain("<dt>Children</dt>");
    expect(view).toContain("<dt>Created</dt>");
    expect(view).toContain('className="sample-danger-zone"');
    expect(page).toContain('disabled={updatingDetails} onClick={() => setEditingDetails((value) => !value)}');
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
