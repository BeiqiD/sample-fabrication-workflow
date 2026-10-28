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
    for (const [page, openDialog, busy, label] of [
      [templatePage, "setConfirmingRemoval(true)", "saving", /removalIsArchive\s*\?\s*"Archive"\s*:\s*"Delete"/],
      [metrologyPage, "setConfirmingTemplateDeletion(true)", "deleting", /deleting\s*\?\s*"Deleting…"\s*:\s*"Delete"/],
    ] as const) {
      const trigger = [...page.matchAll(/<button\b[\s\S]*?<\/button>/g)]
        .map(([button]) => button).find(button => button.includes(openDialog));
      expect(trigger).toBeDefined();
      const classes = trigger!.match(/className="([^"]+)"/)?.[1].split(/\s+/);
      expect(classes).toEqual(expect.arrayContaining(["button", "danger"]));
      expect(trigger).toContain(`disabled={${busy}}`);
      expect(trigger).toMatch(label);
    }
    const metrologyClasses = [...metrologyPage.matchAll(/className="([^"]+)"/g)].map(([, classes]) => classes.split(/\s+/));
    expect(metrologyClasses.some(classes => classes.includes("text-button") && classes.includes("danger-text"))).toBe(true);
  });
});
