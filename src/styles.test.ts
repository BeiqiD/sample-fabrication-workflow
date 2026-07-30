import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const samplePage = readFileSync(new URL("./pages/SamplePage.tsx", import.meta.url), "utf8");
const commentComposer = readFileSync(new URL("./components/CommentComposer.tsx", import.meta.url), "utf8");

describe("responsive layout tiers", () => {
  it("uses only the documented medium and narrow breakpoints", () => {
    const maxWidthQueries = Array.from(
      styles.matchAll(/@media \(max-width:\s*(\d+)px\)/g),
      (match) => Number(match[1]),
    );
    expect(maxWidthQueries).toEqual([1200, 720]);
  });

  it("keeps page gutters continuous and button labels on one line", () => {
    expect(styles).toMatch(/\.sample-page\s*\{[^}]*width:\s*min\(1740px,\s*90vw\)/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-page\s*\{[^}]*width:\s*min\(1740px,\s*max\(90vw,\s*692px\)\)/);
    expect(styles).toMatch(/\.button\s*\{[^}]*white-space:\s*nowrap/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.page,\s*\.sample-page\s*\{[^}]*100%\s*-\s*28px/);
  });
});

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
  it("uses four, two, and one columns across the three tiers", () => {
    expect(styles).toMatch(/\.sample-filter-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-filter-grid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.sample-filter-grid\s*\{[^}]*grid-template-columns:\s*1fr/);
  });
});

describe("responsive directory rows", () => {
  it("moves Samples process information to a second medium-width row", () => {
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-directory-head,\s*\.sample-directory-row\s*\{[^}]*grid-template-columns:\s*minmax\(190px,\s*1\.15fr\)\s*minmax\(150px,\s*\.8fr\)\s*90px/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-directory-workflow\s*\{[^}]*grid-column:\s*1\s*\/\s*-1[^}]*grid-row:\s*2/);
  });

  it("moves Processing workflow information to a second medium-width row", () => {
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.processing-row\s*\{[^}]*grid-template-columns:\s*120px minmax\(0,\s*1fr\) auto/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.processing-workflow\s*\{[^}]*grid-column:\s*2\s*\/\s*-1[^}]*grid-row:\s*2/);
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

describe("sample header actions", () => {
  it("keeps primary labels in medium, collapses secondary actions there, and collapses every action on mobile", () => {
    expect(styles).toMatch(/\.sample-header-action-buttons\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-header-secondary-action\s*\{[^}]*width:\s*42px/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-header-secondary-action \.responsive-action-label\s*\{[^}]*position:\s*absolute/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.sample-header-action-buttons\s*\{[^}]*flex-wrap:\s*nowrap/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.responsive-icon-button\s*\{[^}]*width:\s*42px/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.responsive-icon-button \.responsive-action-label\s*\{[^}]*position:\s*absolute/);
    expect(samplePage.match(/sample-header-secondary-action/g)).toHaveLength(2);
    expect(samplePage).not.toMatch(/primary responsive-icon-button sample-header-secondary-action/);
  });
});

describe("sample overview notes", () => {
  it("uses the left priority column to set the wide Notes height", () => {
    expect(samplePage).toMatch(/className="sample-notes-slot"[\s\S]*?className="card sample-notes-card"/);
    expect(styles).toMatch(/\.sample-notes-slot\s*\{[^}]*position:\s*relative/);
    expect(styles).toMatch(/\.sample-notes-card\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*overflow:\s*hidden/);
    expect(styles).toMatch(/\.sample-notes-heading\s*\{[^}]*flex:\s*0 0 auto/);
    expect(styles).toMatch(/\.sample-note-composer\s*\{[^}]*flex:\s*0 0 auto/);
    expect(styles).toMatch(/\.sample-notes-list\s*\{[^}]*min-height:\s*0[^}]*flex:\s*1 1 auto[^}]*overflow-y:\s*auto/);
  });

  it("uses a five-note touch preview without nested scrolling below the wide tier", () => {
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-notes-slot\s*\{[^}]*position:\s*static[^}]*order:\s*2/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-notes-card\s*\{[^}]*position:\s*static[^}]*overflow:\s*visible/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-notes-list\s*\{[^}]*flex:\s*0 1 auto[^}]*max-height:\s*none[^}]*overflow:\s*visible/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-notes-list\.is-collapsed > \.sample-note-preview-overflow\s*\{[^}]*display:\s*none/);
    expect(styles).toMatch(/\.sample-notes-toggle\s*\{[^}]*display:\s*none/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-notes-toggle\s*\{[^}]*min-height:\s*44px[^}]*display:\s*inline-flex/);
    expect(samplePage).toMatch(/const SAMPLE_NOTES_PREVIEW_COUNT = 5/);
    expect(samplePage).toMatch(/notes\.map\(\(note, index\)[\s\S]*?index === SAMPLE_NOTES_PREVIEW_COUNT[\s\S]*?className="sample-notes-toggle"[\s\S]*?<article className=\{`sample-note[^`]*sample-note-preview-overflow/);
    expect(samplePage).toMatch(/Show recent \$\{SAMPLE_NOTES_PREVIEW_COUNT\}/);
    expect(samplePage).toMatch(/Show all \$\{notes\.length\} notes/);
    expect(samplePage).toMatch(/aria-controls="sample-notes-list"[\s\S]*?aria-expanded=\{showAllNotes\}/);
    expect(samplePage).not.toMatch(/scrollIntoView/);
  });
});

describe("run workflow actions", () => {
  it("keeps wide and medium controls on one row, with compact medium menu triggers", () => {
    expect(styles).toMatch(/\.run-controls\s*\{[^}]*grid-template-columns:\s*120px minmax\(260px,\s*420px\) 210px minmax\(0,\s*1fr\)/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.run-controls\s*\{[^}]*grid-template-columns:\s*120px minmax\(180px,\s*420px\) minmax\(0,\s*1fr\) auto[^}]*grid-template-areas:\s*"title picker status actions"/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.run-control-menus \.run-action-menu-trigger\s*\{[^}]*width:\s*46px/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.run-control-menus \.run-action-menu-label\s*\{[^}]*position:\s*absolute/);
    expect(styles).toMatch(/\.run-controls-picker select\s*\{[^}]*height:\s*42px/);
    expect(styles).toMatch(/\.run-controls-picker strong\s*\{[^}]*height:\s*42px/);
  });

  it("keeps the mobile picker and both icon menus on one row", () => {
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.run-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?grid-template-areas:[^}]*"picker actions"/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.run-controls-heading\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.run-controls-heading \.run-controls-status\s*\{[^}]*margin-left:\s*auto/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.run-action-menu-trigger\s*\{[^}]*width:\s*46px[^}]*height:\s*40px/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.run-action-menu-label\s*\{[^}]*position:\s*absolute/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.run-control-menus\s*\{[^}]*position:\s*relative/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.run-control-menus \.run-action-menu\s*\{[^}]*position:\s*static/);
  });

  it("presents early finish as a multiline danger action", () => {
    expect(styles).toMatch(/\.run-action-menu-item\s*\{[^}]*grid-template-columns:\s*22px minmax\(0,\s*1fr\)/);
    expect(styles).toMatch(/\.run-action-menu-item\.danger\s*\{[^}]*border-color:[^}]*var\(--danger\)[^}]*color:\s*var\(--danger\)/);
    expect(styles).toMatch(/\.run-action-menu-item-copy\s*\{[^}]*display:\s*grid/);
  });
});

describe("comment composer placeholder", () => {
  it("uses one placeholder in every comment context", () => {
    expect(commentComposer).toMatch(/placeholder="Add a comment…"/);
    expect(commentComposer).not.toMatch(/placeholder\s*\?\?/);
    expect(commentComposer).not.toMatch(/placeholder\?:\s*string/);
    expect(samplePage).not.toMatch(/placeholder="Observation about this sample/);
  });
});

describe("medium content layouts", () => {
  it("uses stable Process grid tracks without enabling phone-only interactions", () => {
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?--recipe-width:\s*230px;\s*--sample-width:\s*300px/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?--recipe-width:\s*88px;\s*--sample-width:\s*270px/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.process-plan-comment-inline\s*\{[^}]*display:\s*none/);
  });

  it("stacks Sample priority and secondary regions and makes run summaries explicit two-row grids", () => {
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-priority-grid\s*\{[^}]*flex-direction:\s*column/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-secondary-grid\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-run-card \.sample-run-summary\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto 18px/);
  });

  it("uses an explicit second information row for template versions", () => {
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.template-version-link\s*\{[^}]*grid-template-columns:\s*minmax\(160px,\s*1\.4fr\)\s*minmax\(110px,\s*\.8fr\)\s*minmax\(70px,\s*\.5fr\) auto/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.template-version-identity\s*\{[^}]*grid-column:\s*1\s*\/\s*-2/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.template-version-fact\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  });
});
