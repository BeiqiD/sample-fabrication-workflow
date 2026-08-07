import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const templatePage = readFileSync(new URL("./pages/TemplatePage.tsx", import.meta.url), "utf8");
const metrologyPage = readFileSync(new URL("./pages/MetrologyTemplatePage.tsx", import.meta.url), "utf8");
const draftGuard = readFileSync(new URL("./lib/process-plan-comment-draft-guard.ts", import.meta.url), "utf8");

describe("template destructive confirmations", () => {
  it("uses the in-app confirmation primitive on template detail pages", () => {
    expect(templatePage).not.toContain("window.confirm");
    expect(metrologyPage).not.toContain("window.confirm");
    expect(templatePage).toContain("<ConfirmDeleteDialog");
    expect(metrologyPage.match(/<ConfirmDeleteDialog/g)?.length).toBe(2);
  });

  it("keeps removal failures inside their confirmation context", () => {
    expect(templatePage).toContain("removeError");
    expect(templatePage).toContain("error={removeError}");
    expect(metrologyPage).toContain("referenceDeleteError");
    expect(metrologyPage).toContain("templateDeleteError");
  });

  it("preserves the synchronous unsaved-draft guard exception", () => {
    expect(draftGuard).toContain("window.confirm(DISCARD_MESSAGE)");
  });

  it("does not change established destructive button variants", () => {
    expect(templatePage).toContain('className="button danger"');
    expect(metrologyPage).toContain('className="button danger"');
    expect(metrologyPage).toContain('className="text-button danger-text"');
  });
});
