import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const grid = readFileSync(new URL("./components/MultiSampleRunGrid.tsx", import.meta.url), "utf8");
const dialog = readFileSync(new URL("./components/StateMismatchDialog.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("state mismatch verification", () => {
  it("keeps verified as a direct action but routes mismatch through the in-app dialog", () => {
    expect(grid).not.toContain("window.prompt(");
    expect(grid).toContain('onVerifyMatched={() => void verifyState(column, step, "matched")}');
    expect(grid).toContain('setShowMismatchDialog(true)');
    expect(grid).toContain('<StateMismatchDialog');
    expect(grid).toContain('onVerifyMismatch={(note) => verifyState(column, step, "mismatched", note)}');
  });

  it("submits the note with the exact current sample, run, and step identity", () => {
    expect(grid).toContain("await api.verifyState(column.sample.id, column.run.id, step.id");
    expect(grid).toContain("result, note, expectedUpdatedAt: step.updatedAt");
    expect(grid).toContain('completeStep: ["pending", "in_progress"].includes(step.status)');
  });

  it("keeps verification API failures in the mismatch dialog", () => {
    expect(dialog).toContain("await onConfirm(note)");
    expect(dialog).toContain("setError((submitError as Error).message)");
    expect(dialog).toContain("const blocked = busy || submitting");
    expect(dialog).toContain("useModalDialog({ dialogRef, initialFocusRef: noteRef, onClose: onCancel, blocked })");
  });

  it("does not change the dense State action geometry", () => {
    expect(styles).toMatch(/\.state-action-panel button\s*\{[^}]*min-height:\s*29px[^}]*font-size:\s*10px/s);
    expect(grid).toContain('className="state-action-panel"');
  });
});
