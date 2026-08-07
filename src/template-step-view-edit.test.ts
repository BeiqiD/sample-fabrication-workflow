import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("./pages/TemplatePage.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("./template-page-layout.css", import.meta.url), "utf8");

describe("template step view/edit parity", () => {
  it("replaces step identity and detail content instead of appending a duplicate edit form", () => {
    expect(page).toContain('className="template-step-heading-editor"');
    expect(page).toContain('className="template-step-fields template-step-fields-edit"');
    expect(page).toContain('className="template-step-fields template-step-fields-view"');
    expect(page).not.toContain('{editing && <div className="step-form">');
  });

  it("keeps the existing diagram gallery and action family outside the edited field copy", () => {
    expect(page).toContain('<DiagramGallery keys={step.imageKeys} label={step.name} className="template-diagram-gallery" />');
    expect(page).toContain('className="template-step-actions"');
    expect(page).toContain('Delete step');
    expect(page).toContain('className="button primary"');
  });

  it("uses comfortable field typography without redefining button geometry", () => {
    expect(layout).toMatch(/\.template-step-field > span\s*\{[^}]*font-size:\s*12px/s);
    expect(layout).toMatch(/\.template-step-field > p\s*\{[^}]*font-size:\s*14px[^}]*line-height:\s*1\.55/s);
    expect(layout).toMatch(/\.template-step-field textarea[\s\S]*font-size:\s*14px/s);
    expect(layout).not.toMatch(/\.button\s*\{/);
    expect(layout).not.toMatch(/\.template-step-actions\s*\{/);
  });
});
