import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./modal-form-controls.css", import.meta.url), "utf8");
const confirm = readFileSync(new URL("./components/ConfirmDeleteDialog.tsx", import.meta.url), "utf8");
const mismatch = readFileSync(new URL("./components/StateMismatchDialog.tsx", import.meta.url), "utf8");

describe("modal editable-value typography", () => {
  it("keeps modal labels compact while editable values use body typography", () => {
    expect(css).toMatch(/\.confirm-dialog-confirmation > input,[\s\S]*\.confirm-dialog-confirmation > textarea\s*\{[^}]*font-size:\s*var\(--font-body\)[^}]*line-height:\s*1\.45/s);
  });

  it("is scoped to the confirmation and mismatch form controls", () => {
    expect(confirm).toContain('import "../modal-form-controls.css"');
    expect(mismatch).toContain('import "../modal-form-controls.css"');
    expect(confirm).toContain('className="confirm-dialog-confirmation"');
    expect(mismatch).toContain('className="confirm-dialog-confirmation"');
  });

  it("does not alter modal geometry or button roles", () => {
    expect(css).not.toMatch(/height|width|padding|margin|gap|\.button/);
    expect(confirm).toContain('className="button danger"');
    expect(mismatch).toContain('className="button primary"');
  });
});
