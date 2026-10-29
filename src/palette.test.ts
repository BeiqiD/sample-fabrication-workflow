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

const statusInkTokens = [
  "status-success-ink",
  "status-warning-ink",
  "status-danger-ink",
  "status-info-ink",
  "status-neutral-ink",
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

function themeTokens(css: string, theme: "light" | "dark") {
  const selector = theme === "light" ? /:root\s*\{([^}]*)\}/ : /:root\[data-theme="dark"\]\s*\{([^}]*)\}/;
  const declarations = css.match(selector)?.[1];
  if (!declarations) throw new Error(`Missing ${theme} theme declarations`);
  return Object.fromEntries([...declarations.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)]
    .map(([, name, value]) => [name, value.trim()]));
}

function expectTokenContrast(tokens: Record<string, string>, foreground: string, background: string, minimum = 4.5) {
  for (const name of [foreground, background]) {
    expect(tokens[name], `Color token --${name} must resolve to a color`).toMatch(/^#[\da-f]{6}$/i);
  }
  expect(contrastRatio(tokens[foreground], tokens[background]), `--${foreground} on --${background}`)
    .toBeGreaterThanOrEqual(minimum);
}

describe("interface palette", () => {
  it("loads after the component stylesheet so every token use receives one palette", () => {
    expect(main.indexOf('import "./styles.css"')).toBeGreaterThan(-1);
    expect(main.indexOf('import "./palette.css"')).toBeGreaterThan(main.indexOf('import "./styles.css"'));
  });

  it("owns every interface token once per theme without duplicate definitions in component styles", () => {
    for (const token of interfaceTokens) {
      expect(Array.from(palette.matchAll(new RegExp(`--${token}\\s*:`, "g")))).toHaveLength(2);
      expect(styles).not.toMatch(new RegExp(`--${token}\\s*:`));
    }

    expect(themeTokens(palette, "light")).toMatchObject({
      canvas: "#f5f6f7", paper: "#ffffff", ink: "#20262d",
      muted: "#56616d", line: "#d8dde3", accent: "#3f668e",
    });
    expect(themeTokens(palette, "dark")).toMatchObject({
      canvas: "#15181c", paper: "#1d2228", ink: "#e2e6eb",
      muted: "#a5afba", line: "#36404b", accent: "#96b7d8",
    });
  });

  it("checks the actual theme tokens for readable text, controls, and focus rings", () => {
    const pairs = [
      ["ink", "canvas"], ["ink", "paper"], ["ink", "surface"],
      ["muted", "canvas"], ["muted", "paper"],
      ["muted", "input"],
      ["accent", "paper"], ["accent", "accent-soft"],
      ["control-strong-contrast", "control-strong"],
      ["control-strong-contrast", "accent"], ["accent-contrast", "accent-fill"],
    ];
    for (const theme of ["light", "dark"] as const) {
      const tokens = themeTokens(palette, theme);
      for (const [foreground, background] of pairs) expectTokenContrast(tokens, foreground, background);
      for (const background of ["canvas", "paper", "surface"]) {
        expectTokenContrast(tokens, "accent", background, 3);
      }
    }
  });

  it("keeps Processing filter counts readable in the actual count surface", () => {
    const countRule = styles.match(/\.segmented-control button span\s*\{([^}]*)\}/)?.[1];
    const foreground = countRule?.match(/(?:^|;)\s*color:\s*var\(--([\w-]+)\)/)?.[1];
    const background = countRule?.match(/(?:^|;)\s*background:\s*var\(--([\w-]+)\)/)?.[1];
    expect(foreground).toBeDefined();
    expect(background).toBeDefined();
    for (const theme of ["light", "dark"] as const) {
      expectTokenContrast(themeTokens(palette, theme), foreground!, background!);
    }
  });

  it("uses accessible low-saturation ink for passive lifecycle status labels", () => {
    for (const token of statusInkTokens) {
      expect(Array.from(styles.matchAll(new RegExp(`--${token}\\s*:`, "g")))).toHaveLength(2);
    }

    for (const theme of ["light", "dark"] as const) {
      const tokens = themeTokens(styles, theme);
      for (const state of ["success", "warning", "danger", "info", "neutral"]) {
        expectTokenContrast(tokens, `status-${state}-ink`, `${state}-soft`);
      }
    }

    expect(styles).toMatch(/\.status\s*\{[^}]*border:\s*0[^}]*var\(--status-neutral-ink\)/s);
    expect(styles).toMatch(/\.run-status\s*\{[^}]*border:\s*0[^}]*var\(--status-neutral-ink\)/s);
    expect(styles).toMatch(/\.status-active\s*\{[^}]*var\(--status-success-ink\)[^}]*var\(--success-soft\)/s);
    expect(styles).toMatch(/\.run-status-active\s*\{[^}]*var\(--status-success-ink\)[^}]*var\(--success-soft\)/s);
    expect(styles).toMatch(/\.run-status-complete\s*\{[^}]*var\(--status-info-ink\)[^}]*var\(--info-soft\)/s);
    expect(styles).toMatch(/\.run-status-cancelled\s*\{[^}]*var\(--status-danger-ink\)[^}]*var\(--danger-soft\)/s);
    expect(styles).toMatch(/\.status-stored,\s*\.status-consumed\s*\{[^}]*var\(--status-neutral-ink\)[^}]*var\(--neutral-soft\)/s);
    expect(styles).toMatch(/\.status-lost,\s*\.status-blocked\s*\{[^}]*var\(--status-danger-ink\)[^}]*var\(--danger-soft\)/s);
    expect(styles).toContain(".sample-directory-state > span:not(.status)");
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
    for (const theme of ["light", "dark"] as const) {
      const tokens = { ...themeTokens(styles, theme), ...themeTokens(palette, theme) };
      expectTokenContrast(tokens, "status-contrast", "success");
      expectTokenContrast(tokens, "danger", "danger-soft");
      expectTokenContrast(tokens, "status-contrast", "danger");
    }
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

  it("preserves visible keyboard focus and deliberate destructive button states", () => {
    expect(styles).toMatch(/\.button:focus-visible,[^{]*\.theme-toggle:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)[^}]*outline-offset:\s*2px/s);
    expect(styles).toMatch(/\.button\.danger\s*\{[^}]*border-color:\s*var\(--danger\)[^}]*color:\s*var\(--danger\)[^}]*background:\s*var\(--danger-soft\)/s);
    expect(styles).toMatch(/\.button\.danger:hover:not\(:disabled\)\s*\{[^}]*color:\s*var\(--status-contrast\)[^}]*background:\s*var\(--danger\)/s);
    expect(styles).toMatch(/\.button:disabled\s*\{[^}]*cursor:\s*not-allowed/s);
  });

  it("uses the interaction accent for persistent states and gives dropdown triggers hover feedback", () => {
    expect(styles).toMatch(/\.segmented-control button\.selected\s*\{[^}]*color:\s*var\(--accent\)[^}]*background:\s*var\(--accent-soft\)/s);
    expect(styles).toMatch(/\.template-picker-list > button\.selected\s*\{[^}]*border-color:\s*var\(--accent\)[^}]*background:\s*var\(--accent-soft\)/s);
    expect(styles).toMatch(/\.button:not\(\.primary, \.danger\)\[aria-expanded="true"\]:not\(:disabled\)\s*\{[^}]*var\(--accent\)/s);
    expect(styles).toMatch(/\.cell-actions button\[aria-expanded="true"\]:not\(:disabled\)\s*\{[^}]*var\(--accent\)/s);
    expect(styles).toMatch(/\.comment-tool-button\[aria-expanded="true"\]\s*\{[^}]*var\(--accent\)/s);
  });

  it("keeps product status mappings and Process-grid state surfaces intact", () => {
    expect(styles).toMatch(/\.run-status-active\s*\{[^}]*var\(--success-soft\)/s);
    expect(styles).toMatch(/\.run-status-complete\s*\{[^}]*var\(--info-soft\)/s);
    expect(styles).toMatch(/\.run-status-ready\s*\{[^}]*var\(--neutral-soft\)/s);
    expect(styles).toMatch(/\.sample-pinned\s*\{[^}]*var\(--neutral\)/s);
    expect(styles).toMatch(/\.template-state\.draft\s*\{[^}]*var\(--neutral\)/s);
    expect(styles).toMatch(/\.sample-step-cell\.step-status-in_progress\s*\{[^}]*var\(--info\)/s);
    expect(styles).toMatch(/\.sample-step-cell\.step-status-done\s*\{[^}]*var\(--success\)/s);
    expect(styles).toMatch(/\.sample-step-cell\.step-status-skipped\s*\{[^}]*var\(--warning\)/s);
    expect(styles).toMatch(/\.sample-step-cell\.step-status-blocked\s*\{[^}]*var\(--danger\)/s);
  });

  it("uses the same emphasized New sample action on every page-level entry", () => {
    for (const page of [samplesPage, processingPage]) {
      const actions = [...page.matchAll(/<Link\b[^>]*\bto="\/samples\/new"[^>]*>[\s\S]*?<\/Link>/g)];
      expect(actions).toHaveLength(1);
      const action = actions[0][0];
      const classes = action.match(/className="([^"]+)"/)?.[1].split(/\s+/);
      expect(classes).toEqual(expect.arrayContaining(["button", "primary"]));
      expect(classes).not.toContain("danger");
      expect(action).toContain('aria-label="New sample"');
    }
  });

  it("updates non-component and hard-coded surfaces that carried the old palette", () => {
    const lightTokens = themeTokens(palette, "light");
    expect(favicon).toContain(`fill="${lightTokens["control-strong"]}"`);
    expect(favicon).not.toContain("#1d2521");
    expect(indexHtml).toContain(`name="theme-color" content="${lightTokens.canvas}"`);
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
