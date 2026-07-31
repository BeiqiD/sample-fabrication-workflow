import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  PAGE_LOAD_AUTOFOCUS_MEDIA_QUERY,
  shouldAutoFocusPageField,
} from "./page-load-autofocus";

const samplesPage = readFileSync(new URL("../pages/SamplesPage.tsx", import.meta.url), "utf8");
const metrologyTemplatePage = readFileSync(new URL("../pages/MetrologyTemplatePage.tsx", import.meta.url), "utf8");
const metrologyTemplateForm = readFileSync(new URL("../components/MetrologyTemplateForm.tsx", import.meta.url), "utf8");

describe("page-load autofocus", () => {
  it("is enabled for a fine primary pointer", () => {
    const matchMedia = vi.fn(() => ({ matches: true }));

    expect(shouldAutoFocusPageField(matchMedia)).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith(PAGE_LOAD_AUTOFOCUS_MEDIA_QUERY);
  });

  it("does not autofocus for touch-style primary input", () => {
    const matchMedia = vi.fn(() => ({ matches: false }));

    expect(shouldAutoFocusPageField(matchMedia)).toBe(false);
  });

  it("is safe when browser media queries are unavailable", () => {
    expect(shouldAutoFocusPageField()).toBe(false);
  });

  it("guards standalone page fields while preserving user-opened form autofocus", () => {
    expect(samplesPage).toMatch(/autoFocus=\{shouldAutoFocusPageField\(\)\}/);
    expect(metrologyTemplatePage).toMatch(/autoFocusTitle=\{shouldAutoFocusPageField\(\)\}/);
    expect(metrologyTemplateForm).toMatch(/autoFocusTitle = true/);
    expect(metrologyTemplateForm).toMatch(/autoFocus=\{autoFocusTitle\}/);
  });
});
