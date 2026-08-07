import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const grid = readFileSync(new URL("./components/MultiSampleRunGrid.tsx", import.meta.url), "utf8");
const hook = readFileSync(new URL("./lib/use-modal-dialog.ts", import.meta.url), "utf8");

function functionBlock(name: string, nextName: string) {
  const start = grid.indexOf(`function ${name}`);
  const end = grid.indexOf(`function ${nextName}`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return grid.slice(start, end);
}

describe("grid modal behavior", () => {
  it("moves ordinary grid overlays onto the shared modal behavior", () => {
    const recipe = functionBlock("RecipeDetailsSheet", "CommentCard");
    const comments = functionBlock("ProcessPlanCommentDialog", "ActualDifferences");
    const drawer = functionBlock("StepDrawer", "MetrologyPickerDrawer");
    const picker = functionBlock("MetrologyPickerDrawer", "MultiSampleRunGrid");

    for (const source of [recipe, comments, drawer, picker]) {
      expect(source).toContain("useModalDialog({");
      expect(source).toContain("dialogRef");
    }

    expect(recipe).not.toContain("document.body.style.overflow");
    expect(recipe).not.toContain('addEventListener("keydown"');
    expect(comments).not.toContain("document.body.style.overflow");
    expect(comments).not.toContain('addEventListener("keydown"');
  });

  it("blocks drawer dismissal while save/add work is in flight", () => {
    const drawer = functionBlock("StepDrawer", "MetrologyPickerDrawer");
    const picker = functionBlock("MetrologyPickerDrawer", "MultiSampleRunGrid");

    expect(drawer).toContain("blocked: saving");
    expect(drawer).toContain("event.target === event.currentTarget && !saving");
    expect(drawer).toContain('className="drawer-close" aria-label="Close" disabled={saving}');
    expect(drawer).toContain('className="button" disabled={saving} onClick={onClose}');

    expect(picker).toContain("blocked: Boolean(savingId)");
    expect(picker).toContain("ref={searchRef}");
    expect(picker).toContain('className="drawer-close" aria-label="Close" disabled={Boolean(savingId)}');
  });

  it("keeps the image lightbox keyboard model specialized", () => {
    const gallery = functionBlock("DiagramGallery", "RecipeDetailsSheet");
    expect(gallery).toContain('event.key === "ArrowLeft"');
    expect(gallery).toContain('event.key === "ArrowRight"');
    expect(gallery).toContain("setImageZoom");
    expect(gallery).toContain('window.addEventListener("keydown", onKeyDown)');
    expect(gallery).toContain('aria-modal="true"');
  });

  it("makes the shared modal stack nested-overlay aware", () => {
    expect(hook).toContain("const modalStack: HTMLElement[] = []");
    expect(hook).toContain("bodyOverflowBeforeFirstModal");
    expect(hook).toContain("hasLaterUnregisteredModal");
    expect(hook).toContain("document.querySelectorAll<HTMLElement>('[aria-modal=\"true\"]')");
    expect(hook).toContain("modalStack[modalStack.length - 1] === dialog");
    expect(hook).toContain("!hasLaterUnregisteredModal(dialog)");
  });
});
