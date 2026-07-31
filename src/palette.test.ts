import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const palette = readFileSync(new URL("./palette.css", import.meta.url), "utf8");
const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const favicon = readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const interfaceTokens = [
  "canvas",
  "paper",
  "surface",
  "surface-muted",
  "surface-warm",
  "input",
  "ink",
  "muted",
  "line",
  "line-strong",
  "accent",
  "accent-contrast",
  "accent-soft",
  "status-contrast",
  "shadow",
  "overlay",
];

const semanticTokens = [
  "success",
  "success-soft",
  "warning",
  "warning-text",
  "warning-soft",
  "danger",
  "danger-soft",
  "info",
  "info-soft",
  "neutral",
  "neutral-soft",
];

describe("interface palette", () => {
  it("loads after the component stylesheet so every token use receives one palette", () => {
    expect(main.indexOf('import "./styles.css"')).toBeGreaterThan(-1);
    expect(main.indexOf('import "./palette.css"')).toBeGreaterThan(main.indexOf('import "./styles.css"'));
  });

  it("defines every interface token for both light and dark themes", () => {
    for (const token of interfaceTokens) {
      expect(Array.from(palette.matchAll(new RegExp(`--${token}\\s*:`, "g")))).toHaveLength(2);
    }

    expect(palette).toContain("--accent: #4f5d95;");
    expect(palette).toContain("--accent-soft: #e3e4f1;");
    expect(palette).toContain("--accent: #aab7e8;");
    expect(palette).toContain("--accent-soft: #29314a;");
  });

  it("does not redefine colors that communicate workflow meaning", () => {
    for (const token of semanticTokens) {
      expect(palette).not.toMatch(new RegExp(`--${token}\\s*:`));
    }
  });

  it("keeps status icon contrast independent from the interface accent", () => {
    expect(palette).toMatch(/\.done-mark,\s*\.state-symbol\s*\{[^}]*color:\s*var\(--status-contrast\)/s);
  });

  it("updates non-component surfaces that previously carried the old palette", () => {
    expect(favicon).toContain('fill="#202522"');
    expect(favicon).not.toContain("#1d2521");
    expect(indexHtml).toContain('name="theme-color" content="#f7f8f6"');
    expect(app).toMatch(/getPropertyValue\("--canvas"\)/);
  });
});
