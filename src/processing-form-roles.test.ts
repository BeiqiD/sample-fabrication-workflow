import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const roles = readFileSync(new URL("./processing-form-roles.css", import.meta.url), "utf8");
const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");

describe("processing form typography roles", () => {
  it("uses readable body text in the execution-step drawer controls", () => {
    expect(roles).toMatch(/\.step-drawer \.drawer-form input:not\(\[type="checkbox"\]\),[\s\S]*\.step-drawer \.drawer-form select\s*\{[^}]*font-size:\s*var\(--font-body\)[^}]*line-height:\s*1\.45/s);
  });

  it("matches the editable run picker to its read-only body-value role", () => {
    expect(roles).toMatch(/\.run-controls-picker select\s*\{[^}]*font-size:\s*var\(--font-body\)[^}]*line-height:\s*1\.4/s);
  });

  it("keeps the process-family search readable but compact", () => {
    expect(roles).toMatch(/\.process-family-search input\s*\{[^}]*font-size:\s*var\(--font-body\)[^}]*line-height:\s*1\.45/s);
  });

  it("does not redefine protected geometry or button styles", () => {
    expect(roles).not.toMatch(/\b(?:width|height|min-height|max-height|gap|padding|margin)\s*:/);
    expect(roles).not.toMatch(/\.button|button\s*\{/);
    expect(main).toContain('import "./processing-form-roles.css"');
  });
});
