import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const palette = readFileSync(new URL("./palette.css", import.meta.url), "utf8");
const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const multiSampleRunGrid = readFileSync(new URL("./components/MultiSampleRunGrid.tsx", import.meta.url), "utf8");
const processingPage = readFileSync(new URL("./pages/ProcessingPage.tsx", import.meta.url), "utf8");
const samplesPage = readFileSync(new URL("./pages/SamplesPage.tsx", import.meta.url), "utf8");
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
  "control-strong",
  "control-strong-contrast",
  "accent",
  "accent-fill",
  "accent-contrast",
  "accent-soft",
  "status-contrast",
  "media-panel",
  "media-toolbar",
  "floating-shadow-soft",
  "floating-shadow",
  "floating-shadow-strong",
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

const lockedSemanticValues = [
  "--success: #177252;",
  "--success-soft: #e3f3eb;",
  "--warning: #aa6b14;",
  "--warning-text: #80500e;",
  "--warning-soft: #fff3d9;",
  "--danger: #a33a33;",
  "--danger-soft: #fbe7e5;",
  "--info: #246f9a;",
  "--info-soft: #e8f3fa;",
  "--neutral: #68736d;",
  "--neutral-soft: #edf0ee;",
  "--success: #5fc59a;",
  "--success-soft: #1b382c;",
  "--warning: #e0a44b;",
  "--warning-text: #f2c36f;",
  "--warning-soft: #3a2c16;",
  "--danger: #e17a72;",
  "--danger-soft: #3b2221;",
  "--info: #69b5df;",
  "--info-soft: #1d3340;",
  "--neutral: #a4afa8;",
  "--neutral-soft: #252d28;",
];

function relativeLuminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= .04045
    ? channel / 12.92
    : ((channel + .055) / 1.055) ** 2.4);
  return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
}

function contrastRatio(first: string, second: string) {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + .05) / (darker + .05);
}

describe("interface palette", () => {
  it("loads after the component stylesheet so every token use receives one palette", () => {
    expect(main.indexOf('import "./styles.css"')).toBeGreaterThan(-1);
    expect(main.indexOf('import "./palette.css"')).toBeGreaterThan(main.indexOf('import "./styles.css"'));
  });

  it("defines every interface token for both light and dark themes", () => {
    for (const token of interfaceTokens) {
      expect(Array.from(palette.matchAll(new RegExp(`--${token}\\s*:`, "g")))).toHaveLength(2);
    }

    expect(palette).toContain("--accent: #526e89;");
    expect(Array.from(palette.matchAll(/--accent-fill: #849eb8;/g))).toHaveLength(2);
    expect(palette).toContain("--accent-contrast: #1b1f21;");
    expect(palette).toContain("--accent-soft: #e8eef3;");
    expect(palette).toContain("--canvas: #f4f5f4;");
    expect(palette).toContain("--paper: #fafbfa;");
    expect(palette).toContain("--surface-warm: #f7f8f7;");
    expect(palette).toContain("--control-strong: #3e4541;");
    expect(palette).toContain("--control-strong-contrast: #f7f8f6;");
    expect(palette).toContain("--accent: #849eb8;");
    expect(palette).toContain("--accent-soft: #26333f;");
    expect(palette).toContain("--control-strong: #bfc6c2;");
    expect(palette).toContain("--control-strong-contrast: #1b1f21;");
    expect(palette).toContain("--status-contrast: #f7f8f6;");
    expect(palette).toContain("--status-contrast: #0c1611;");
  });

  it("keeps interface text and accent contrast above the WCAG AA text threshold", () => {
    const pairs = [
      ["#303633", "#f4f5f4"],
      ["#303633", "#fafbfa"],
      ["#68716c", "#f4f5f4"],
      ["#526e89", "#fafbfa"],
      ["#526e89", "#e8eef3"],
      ["#f7f8f6", "#526e89"],
      ["#1b1f21", "#849eb8"],
      ["#3e4541", "#f7f8f6"],
      ["#c9cfcc", "#141719"],
      ["#969f9a", "#141719"],
      ["#849eb8", "#141719"],
      ["#849eb8", "#26333f"],
      ["#bfc6c2", "#1b1f21"],
    ];
    for (const [foreground, background] of pairs) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("does not redefine colors that communicate workflow meaning", () => {
    for (const token of semanticTokens) {
      expect(palette).not.toMatch(new RegExp(`--${token}\\s*:`));
    }
    for (const declaration of lockedSemanticValues) {
      expect(styles).toContain(declaration);
    }
  });

  it("keeps status icon contrast independent from the interface accent", () => {
    expect(palette).toMatch(/\.done-mark,\s*\.state-symbol\s*\{[^}]*color:\s*var\(--status-contrast\)/s);
  });

  it("maps only actions with a clear visible result to semantic colors", () => {
    expect(palette).toMatch(/\.cell-actions button\.done-action,\s*\.recipe-actions > \.button\.primary\.recipe-icon-action\s*\{[^}]*var\(--success\)/s);
    expect(palette).toMatch(/\.state-action-panel:not\(\.add-action-panel\) button:first-child\s*\{[^}]*var\(--success\)/s);
    expect(palette).toMatch(/\.state-action-panel:not\(\.add-action-panel\) button:last-child\s*\{[^}]*var\(--danger\)/s);
    expect(multiSampleRunGrid).toMatch(/className="done-action"[\s\S]*?: "Done"/);
    expect(multiSampleRunGrid.match(/button primary compact-button recipe-icon-action/g)).toHaveLength(1);
    expect(multiSampleRunGrid).toMatch(/className="button primary compact-button recipe-icon-action"[\s\S]*?Done ·/);
    expect(multiSampleRunGrid).toMatch(/className="state-action-panel add-action-panel"[\s\S]*?Fabrication[\s\S]*?Metrology/);
    expect(multiSampleRunGrid).toMatch(/className="state-action-panel"[\s\S]*?State verified[\s\S]*?State mismatch/);
  });

  it("keeps ambiguous controls grayscale until they are interacted with", () => {
    expect(styles).toMatch(/\.button\.primary\s*\{[^}]*border-color:\s*var\(--control-strong\)[^}]*background:\s*var\(--control-strong\)[^}]*color:\s*var\(--control-strong-contrast\)/s);
    expect(styles).toMatch(/\.button:hover:not\(:disabled\)\s*\{[^}]*border-color:\s*var\(--accent\)[^}]*background:\s*var\(--accent-soft\)/s);
    expect(styles).toMatch(/\.button\.primary:hover:not\(:disabled\),\s*\.button\.primary\[aria-expanded="true"\]:not\(:disabled\)\s*\{[^}]*color:\s*var\(--control-strong-contrast\)[^}]*background:\s*var\(--accent\)/s);
    expect(styles).toMatch(/\.text-button\s*\{[^}]*color:\s*var\(--ink\)/s);
    expect(styles).toMatch(/\.text-button:hover:not\(:disabled\)\s*\{[^}]*color:\s*var\(--accent\)/s);
    expect(styles).toMatch(/\.eyebrow\s*\{[^}]*color:\s*var\(--muted\)/s);
    expect(styles).toMatch(/\.sample-code\s*\{[^}]*color:\s*var\(--ink\)/s);
    expect(palette).not.toMatch(/(?:^|\n)\.button\.primary\s*\{/);
  });

  it("uses the interaction accent for persistent states and gives dropdown triggers hover feedback", () => {
    expect(styles).toMatch(/\.segmented-control button\.selected\s*\{[^}]*color:\s*var\(--accent\)[^}]*background:\s*var\(--accent-soft\)/s);
    expect(styles).toMatch(/\.template-picker-list > button\.selected\s*\{[^}]*border-color:\s*var\(--accent\)[^}]*background:\s*var\(--accent-soft\)/s);
    expect(styles).toMatch(/\.button:not\(\.primary, \.danger\)\[aria-expanded="true"\]:not\(:disabled\)\s*\{[^}]*var\(--accent\)/s);
    expect(styles).toMatch(/\.cell-actions button\[aria-expanded="true"\]:not\(:disabled\)\s*\{[^}]*var\(--accent\)/s);
    expect(styles).toMatch(/\.comment-tool-button\[aria-expanded="true"\]\s*\{[^}]*var\(--accent\)/s);
  });

  it("keeps product status mappings and Process-grid state surfaces intact", () => {
    expect(styles).toMatch(/\.run-status-active\s*\{[^}]*var\(--success\)/s);
    expect(styles).toMatch(/\.run-status-complete\s*\{[^}]*var\(--info\)/s);
    expect(styles).toMatch(/\.run-status-ready\s*\{[^}]*var\(--neutral\)/s);
    expect(styles).toMatch(/\.sample-pinned\s*\{[^}]*var\(--neutral\)/s);
    expect(styles).toMatch(/\.template-state\.draft\s*\{[^}]*var\(--neutral\)/s);
    expect(styles).toMatch(/\.sample-step-cell\.step-status-in_progress\s*\{[^}]*var\(--info\)/s);
    expect(styles).toMatch(/\.sample-step-cell\.step-status-done\s*\{[^}]*var\(--success\)/s);
    expect(styles).toMatch(/\.sample-step-cell\.step-status-skipped\s*\{[^}]*var\(--warning\)/s);
    expect(styles).toMatch(/\.sample-step-cell\.step-status-blocked\s*\{[^}]*var\(--danger\)/s);
  });

  it("uses the same emphasized New sample action on every page-level entry", () => {
    expect(samplesPage).toContain('className="button primary" to="/samples/new">New sample</Link>');
    expect(processingPage).toContain('className="button primary" to="/samples/new">New sample</Link>');
  });

  it("updates non-component and hard-coded surfaces that carried the old palette", () => {
    expect(favicon).toContain('fill="#3e4541"');
    expect(favicon).not.toContain("#1d2521");
    expect(indexHtml).toContain('name="theme-color" content="#f4f5f4"');
    expect(app).toMatch(/getPropertyValue\("--canvas"\)/);
    expect(palette).toMatch(/\.photo-lightbox \.image-lightbox-panel\s*\{[^}]*var\(--media-panel\)/s);
    expect(palette).toMatch(/\.image-lightbox-toolbar\s*\{[^}]*var\(--media-toolbar\)/s);
    expect(palette).toMatch(/\.attachment-menu\s*\{[^}]*var\(--floating-shadow-soft\)/s);
    expect(palette).toMatch(/\.step-drawer\s*\{[^}]*var\(--floating-shadow-soft\)/s);
    expect(palette).toMatch(/\.process-plan-comment-dialog\s*\{[^}]*var\(--floating-shadow\)/s);
    expect(palette).toMatch(/\.run-action-menu-panel\s*\{[^}]*var\(--floating-shadow\)/s);
    expect(palette).toMatch(/\.confirm-dialog,\s*\.run-start-dialog,\s*\.split-dialog\s*\{[^}]*var\(--floating-shadow\)/s);
    expect(palette).toMatch(/\.recipe-details-sheet\s*\{[^}]*var\(--floating-shadow-strong\)/s);
  });
});
