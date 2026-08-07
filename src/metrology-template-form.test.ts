import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const form = readFileSync(new URL("./components/MetrologyTemplateForm.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("./pages/MetrologyTemplatePage.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("./metrology-template-form.css", import.meta.url), "utf8");

describe("metrology template form typography", () => {
  it("loads the shared typography for both standalone and embedded template forms", () => {
    expect(form).toContain('import "../metrology-template-form.css"');
    expect(form).toContain('"metrology-template-form embedded"');
    expect(form).toContain('"card metrology-template-form"');
  });

  it("keeps field labels comfortable and controls readable", () => {
    expect(layout).toMatch(/\.metrology-template-form > label,[\s\S]*\.metrology-reference-card > label\s*\{[^}]*font-size:\s*12px[^}]*font-weight:\s*650[^}]*line-height:\s*1\.35/s);
    expect(layout).toMatch(/\.metrology-template-form input,[\s\S]*\.metrology-reference-card textarea\s*\{[^}]*font-size:\s*14px[^}]*line-height:\s*1\.45/s);
    expect(page).toContain('className="card metrology-reference-card"');
  });

  it("does not redefine layout rhythm or button geometry", () => {
    expect(layout).not.toMatch(/gap\s*:|padding\s*:|margin\s*:/);
    expect(layout).not.toMatch(/\.button|button\s*\{/);
  });
});
