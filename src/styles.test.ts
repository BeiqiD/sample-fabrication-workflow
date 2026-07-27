import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("processing action menus", () => {
  it("uses the shared option height for Add and State menus", () => {
    expect(styles).toMatch(
      /\.state-action-panel button\s*\{[^}]*min-height:\s*29px;/,
    );
    expect(styles).not.toMatch(
      /\.add-action-panel button\s*\{[^}]*min-height:/,
    );
  });
});

describe("sample filter panel", () => {
  it("uses the existing responsive directory widths without adding a separate mobile surface", () => {
    expect(styles).toMatch(/\.sample-filter-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    expect(styles).toMatch(/@media \(max-width:\s*1160px\)[\s\S]*?\.sample-filter-grid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.sample-filter-grid\s*\{[^}]*grid-template-columns:\s*1fr/);
  });
});

describe("process template picker", () => {
  it("keeps family and version choices side by side until the mobile breakpoint", () => {
    expect(styles).toMatch(/\.process-template-picker\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.process-template-picker\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("reuses one selected-row treatment across the picker", () => {
    expect(styles).toMatch(/\.template-picker-list\s*>\s*button\.selected\s*\{[^}]*border-color:\s*var\(--accent\)/);
  });
});
