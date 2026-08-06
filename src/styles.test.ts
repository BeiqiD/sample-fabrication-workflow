import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const samplePage = readFileSync(new URL("./pages/SamplePage.tsx", import.meta.url), "utf8");
const templatePage = readFileSync(new URL("./pages/TemplatePage.tsx", import.meta.url), "utf8");
const templatesPage = readFileSync(new URL("./pages/TemplatesPage.tsx", import.meta.url), "utf8");
const commentComposer = readFileSync(new URL("./components/CommentComposer.tsx", import.meta.url), "utf8");
const multiSampleRunGrid = readFileSync(new URL("./components/MultiSampleRunGrid.tsx", import.meta.url), "utf8");

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

  it("keeps unrelated sample actions visually stable during an individual save", () => {
    expect(multiSampleRunGrid).toMatch(/pendingRunStepActionTargets\(pendingAction, step\.id\)/);
    expect(multiSampleRunGrid).toMatch(/data-background-locked=\{lockedByAnotherStep/);
    expect(styles).toMatch(/\.cell-actions button\[data-background-locked="true"\]:disabled\s*\{[^}]*opacity:\s*1/);
  });

  it("offers checked-sample common actions on metrology rows", () => {
    expect(multiSampleRunGrid).toMatch(/supportsCommonActions\s*=\s*row\.kind\s*===\s*"template"\s*\|\|\s*row\.kind\s*===\s*"metrology"/);
    expect(multiSampleRunGrid).toMatch(/context=\{commonCommentContext\}/);
    expect(multiSampleRunGrid).toContain("Metrology comment");
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

  it("uses a three-note touch preview without nested scrolling below the wide tier", () => {
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-notes-slot\s*\{[^}]*position:\s*static[^}]*order:\s*2/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-notes-card\s*\{[^}]*position:\s*static[^}]*overflow:\s*visible/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-notes-list\s*\{[^}]*flex:\s*0 1 auto[^}]*max-height:\s*none[^}]*overflow:\s*visible/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-notes-list\.is-collapsed > \.sample-note-preview-overflow\s*\{[^}]*display:\s*none/);
    expect(styles).toMatch(/\.sample-notes-toggle\s*\{[^}]*display:\s*none/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.sample-notes-toggle\s*\{[^}]*min-height:\s*44px[^}]*display:\s*inline-flex/);
    expect(samplePage).toMatch(/const SAMPLE_NOTES_PREVIEW_COUNT = 3/);
    expect(samplePage).toMatch(/notes\.map\(\(note, index\)[\s\S]*?!showAllNotes && index === SAMPLE_NOTES_PREVIEW_COUNT[\s\S]*?className="sample-notes-toggle"[\s\S]*?<article className=\{`sample-note[^`]*sample-note-preview-overflow/);
    expect(samplePage).toMatch(/<\/Fragment>\)\}\s*\{showAllNotes && notes\.length > SAMPLE_NOTES_PREVIEW_COUNT[\s\S]*?className="sample-notes-toggle"/);
    expect(samplePage).toMatch(/Show recent \$\{SAMPLE_NOTES_PREVIEW_COUNT\}/);
    expect(samplePage).toMatch(/Show all \$\{notes\.length\} notes/);
    expect(samplePage).toMatch(/pendingNotesViewportTopRef\.current = notesListRef\.current\?\.getBoundingClientRect\(\)\.top \?\? null[\s\S]*?setShowAllNotes\(true\)/);
    expect(samplePage).toMatch(/const viewportShift = nextTop - previousTop[\s\S]*?window\.scrollBy\(0, viewportShift\)/);
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

describe("Process grid comment composer", () => {
  it("expands from the rendered text width and keeps its complete toolbar together", () => {
    expect(commentComposer).toMatch(/adaptiveToolbarLayout\?:\s*boolean/);
    expect(commentComposer).toMatch(/textareaUsesMultipleVisualLines/);
    expect(commentComposer).toMatch(/new ResizeObserver\(expandWhenTextWraps\)/);
    expect(commentComposer).toMatch(/hasDraftItems \|\| preparing \|\| showLinkForm/);
    expect(commentComposer).toMatch(/className="comment-composer-tools"/);
    expect(styles).toMatch(/\.grid-comment-composer\.adaptive-toolbar-layout \.comment-composer-row\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(styles).toMatch(/\.grid-comment-composer\.adaptive-toolbar-layout\.is-expanded textarea\s*\{[^}]*width:\s*100%[^}]*flex:\s*0 0 100%/);
    expect(styles).toMatch(/\.grid-comment-composer\.adaptive-toolbar-layout\.is-expanded \.comment-composer-tools\s*\{[^}]*margin-left:\s*auto/);
    expect(styles).not.toMatch(/\.recipe-cell \.grid-comment-composer textarea\s*\{[^}]*flex-basis:\s*100%/);
  });

  it("enables adaptive layout only for the two inline Process grid composers", () => {
    expect(multiSampleRunGrid.match(/adaptiveToolbarLayout/g)).toHaveLength(2);
    expect(commentComposer).toMatch(/setToolbarExpanded\(false\)[\s\S]*?requestAnimationFrame\(resizeTextarea\)/);
    expect(commentComposer).toMatch(/!body\.trim\(\) && !hasDraftItems && !preparing && !showLinkForm && !showAttachmentMenu/);
  });
});

describe("Jump to current", () => {
  it("keeps one portal-mounted, icon-only action outside the horizontal scroller", () => {
    expect(multiSampleRunGrid).toMatch(/title="Jump to current"[\s\S]*?aria-label="Jump to current"/);
    expect(multiSampleRunGrid).toMatch(/createPortal\([\s\S]*?className=\{`jump-to-current-anchor/);
    expect(multiSampleRunGrid).toMatch(/className="run-grid-scroll"[\s\S]*?\{jumpButton\}/);
    expect(multiSampleRunGrid).toMatch(/rowAnchors\.current\.set\(row\.key, node\)/);
    expect(multiSampleRunGrid).toMatch(/stepCellAnchors\.current\.set\(cellKey, node\)/);
  });

  it("fixes a compact coral-red 28px action to the viewport and preserves mobile safe area", () => {
    expect(styles).toMatch(/\.jump-to-current-anchor\s*\{[^}]*position:\s*fixed[^}]*right:\s*20px[^}]*bottom:\s*20px[^}]*z-index:\s*20[^}]*width:\s*28px[^}]*height:\s*28px/);
    expect(styles).toMatch(/--jump-current:\s*#c86f69/);
    expect(styles).toMatch(/:root\[data-theme="dark"\][\s\S]*?--jump-current:\s*#e08b84/);
    expect(styles).toMatch(/\.jump-to-current-anchor button\s*\{[^}]*width:\s*28px[^}]*height:\s*28px[^}]*border:\s*1px solid currentColor[^}]*color:\s*var\(--jump-current\)[^}]*background:\s*color-mix\(in srgb, var\(--surface\) 90%, transparent\)[^}]*box-shadow:\s*0 2px 8px var\(--shadow\)[^}]*backdrop-filter:\s*blur\(6px\)/);
    expect(styles).toMatch(/\.jump-to-current-anchor button:focus-visible\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--surface\) 92%, var\(--jump-current\) 8%\)[^}]*outline:\s*2px solid currentColor/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.jump-to-current-anchor\s*\{[^}]*right:\s*16px[^}]*bottom:\s*calc\(16px \+ env\(safe-area-inset-bottom\)\)/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.jump-to-current-anchor/);
  });

  it("does not let sticky touch hover or pointer focus keep the action visible", () => {
    expect(multiSampleRunGrid).toMatch(/matchMedia\("\(hover: hover\) and \(pointer: fine\)"\)/);
    expect(multiSampleRunGrid).toMatch(/button\?\.matches\(":focus-visible"\)/);
    expect(multiSampleRunGrid).toMatch(/event\.detail > 0\) event\.currentTarget\.blur\(\)/);
    expect(multiSampleRunGrid).not.toMatch(/jumpButtonAnchor\.current\?\.contains\(document\.activeElement\)/);
    expect(styles).toMatch(/@media \(hover:\s*hover\) and \(pointer:\s*fine\)\s*\{[\s\S]*?\.jump-to-current-anchor button:hover\s*\{[^}]*var\(--jump-current\) 8%/);
  });

  it("provides a temporary non-semantic cell highlight", () => {
    expect(styles).toMatch(/\.sample-step-cell\.jump-current-highlight::after\s*\{[^}]*var\(--accent\)[^}]*animation:\s*jump-current-highlight 1s/);
    expect(multiSampleRunGrid).toMatch(/JUMP_HIGHLIGHT_DURATION = 1000/);
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

  it("uses an explicit second information row and one aligned action group for templates", () => {
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.template-version-link\s*\{[^}]*grid-template-columns:\s*minmax\(160px,\s*1\.4fr\)\s*minmax\(110px,\s*\.8fr\)\s*minmax\(70px,\s*\.5fr\)/);
    expect(styles).toMatch(/@media \(max-width:\s*1200px\)[\s\S]*?\.template-version-identity\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.template-version-fact\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
    expect(styles).toMatch(/\.template-row-actions\s*\{[^}]*align-items:\s*baseline[^}]*gap:\s*16px/);
    expect(templatesPage.match(/className="text-button template-row-edit"/g)).toHaveLength(2);
    expect(templatesPage).not.toMatch(/template-row-open/);
    expect(styles).toMatch(/\.template-step-actions\s*\{[^}]*flex:\s*0\s+0\s+auto[^}]*align-items:\s*baseline[^}]*flex-wrap:\s*nowrap/);
    expect(styles).toMatch(/\.template-step-body \.card-title-row > div:first-child\s*\{[^}]*min-width:\s*0/);
    expect(templatePage).toMatch(/className="template-step-actions"[^]*?editing \? "Cancel" : "Edit"[^]*?Delete step<\/button><\/div>/);
  });
});
