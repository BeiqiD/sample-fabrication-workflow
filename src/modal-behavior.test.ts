import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const hook = readFileSync(new URL("./lib/use-modal-dialog.ts", import.meta.url), "utf8");
const confirm = readFileSync(new URL("./components/ConfirmDeleteDialog.tsx", import.meta.url), "utf8");
const split = readFileSync(new URL("./components/SplitSampleDialog.tsx", import.meta.url), "utf8");
const start = readFileSync(new URL("./components/StartProcessRunDialog.tsx", import.meta.url), "utf8");
const metrology = readFileSync(new URL("./components/StandaloneMetrologyDialog.tsx", import.meta.url), "utf8");

describe("shared modal behavior", () => {
  it("owns background locking, Escape handling, focus containment, and focus restoration", () => {
    expect(hook).toContain('document.body.style.overflow = "hidden"');
    expect(hook).toContain('event.key !== "Escape"');
    expect(hook).toContain('document.addEventListener("focusin", keepFocusInside, true)');
    expect(hook).toContain("previouslyFocused?.isConnected");
    expect(hook).toContain("blockedRef.current");
  });

  it("is used by the standard confirmation and major standalone modal flows", () => {
    for (const source of [confirm, split, start, metrology]) {
      expect(source).toContain("useModalDialog({");
      expect(source).toContain("dialogRef");
    }
  });

  it("removes duplicated keydown modal handlers from the migrated components", () => {
    expect(confirm).not.toContain('addEventListener("keydown"');
    expect(split).not.toContain('addEventListener("keydown"');
    expect(start).not.toContain('addEventListener("keydown"');
    expect(metrology).not.toContain('addEventListener("keydown"');
  });

  it("keeps existing modal classes and button variants intact", () => {
    expect(confirm).toContain('className="confirm-dialog"');
    expect(split).toContain('className="split-dialog"');
    expect(start).toContain('className="run-start-dialog"');
    expect(metrology).toContain('standalone-metrology-dialog');
    expect(confirm).toContain('className="button danger"');
    expect(start).toContain('className="button primary"');
  });
});
