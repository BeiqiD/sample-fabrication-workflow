import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const templatesPage = readFileSync(new URL("./pages/TemplatesPage.tsx", import.meta.url), "utf8");
const draftGuard = readFileSync(new URL("./lib/process-plan-comment-draft-guard.ts", import.meta.url), "utf8");

describe("template list removal confirmations", () => {
  it("uses one in-app confirmation flow for process and metrology templates", () => {
    expect(templatesPage).not.toContain("window.confirm");
    expect(templatesPage).toContain('type PendingTemplateRemoval =');
    expect(templatesPage).toContain('{ kind: "process"; template: ProcessTemplateVersionSummary }');
    expect(templatesPage).toContain('{ kind: "metrology"; template: MetrologyTemplateSummary }');
    expect(templatesPage).toContain("<ConfirmDeleteDialog");
  });

  it("keeps deletion errors inside the confirmation dialog", () => {
    expect(templatesPage).toContain("removalError");
    expect(templatesPage).toContain("error={removalError}");
    expect(templatesPage).toContain("setPendingRemoval(null)");
  });

  it("preserves the existing inline destructive action treatment", () => {
    expect(templatesPage.match(/className="text-button danger-text"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(templatesPage).toContain('removingId === template.id ? "Deleting…" : "Delete"');
  });

  it("keeps native confirm only for the synchronous unsaved-draft guard", () => {
    expect(draftGuard).toContain("window.confirm(DISCARD_MESSAGE)");
  });
});
