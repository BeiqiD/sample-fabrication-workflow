import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialog = readFileSync(new URL("./components/SplitSampleDialog.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("./split-sample-dialog.css", import.meta.url), "utf8");

describe("split sample setup typography", () => {
  it("loads a dialog-scoped field typography layer", () => {
    expect(dialog).toContain('import "../split-sample-dialog.css"');
    expect(layout).toMatch(/\.split-dialog \.split-setup-grid > label\s*\{[^}]*font-size:\s*12px[^}]*font-weight:\s*650[^}]*line-height:\s*1\.35/s);
    expect(layout).toMatch(/\.split-dialog \.split-setup-grid > label > input,[\s\S]*> select\s*\{[^}]*font-size:\s*14px[^}]*line-height:\s*1\.45/s);
  });

  it("does not alter the established dialog geometry or actions", () => {
    expect(layout).not.toMatch(/gap\s*:|padding\s*:|margin\s*:|width\s*:|grid-template/);
    expect(layout).not.toMatch(/\.button|button\s*\{/);
    expect(dialog).toContain('className="button primary" onClick={preparePieces}>Continue</button>');
    expect(dialog).toContain('className="split-setup-grid"');
  });

  it("keeps setup helper text as a separate lower-emphasis role", () => {
    expect(dialog).toContain("Number of new physical pieces");
    expect(dialog).toContain("The original sample code remains in the archive.");
    expect(dialog).toContain("This becomes the default for every piece and can be edited individually next.");
  });
});
