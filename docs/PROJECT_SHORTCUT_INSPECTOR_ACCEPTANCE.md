# Inspector hierarchy and keyboard ownership

Reviewed: 2026-09-13. Original implementation base: merged PR #174 at
`4da00e06f9a5d18a1bfb022a5b4375e692fba7ed`.

## Current acceptance status

PR #175 and follow-up fixes #176–#178 are merged and their recorded desktop
shortcut/help checks passed. The shortcuts are already implemented and do not
need another implementation pass. PR #180 subsequently completed deployed
desktop acceptance of active-editor resizing and large-card editor height;
#183 verified native Space activation within panels and pointer access to
Reading menus. PR #184 unified panel state and made Markdown double-click
open the card editor and Inspector together; explicit Details remains read-only.

Current integration is PR #185 merge
`c4bf698e3753a0474e7d75d400af6685ff874a6a`. Exact CI/deployment identity,
the completed follow-ups and remaining C4 boundaries are recorded in
[Project C4 integration acceptance](./PROJECT_C4_ACCEPTANCE.md#current-integration-check--2026-09-13).
The historical results below belong to their named build, not a new execution
of the shortcut suite on this documentation update. Phase 5C4 remains in
progress and Phase 5D has not started.

## Historical desktop acceptance — PR #175–#178

These checks used integration commit
`791f00073ee69f4ce2c59a377705fe3faee61423`. Verify and Project Map performance
passed on that exact commit.

In the earlier check on 2026-09-12, an authenticated browser reloaded the synthetic QA Project at
`1363 × 936`. The inspected deployment served `index-BkL0387N.js`, rather than
the two CI builds' `index-CAh5QSPs.js`, and the new Keyboard shortcuts control was
absent. Read-only Inspector inspection still showed the old `310 × 42px`
`Edit Markdown` button inside a `340px` panel. Saved remained visible; no editor
was entered or application data changed. These observations do not identify the
exact older deployed commit or establish a cause for the mismatch.

The subsequent Workers Builds check on the integration commit passed. After an
ordinary reload, the browser served `index-CAh5QSPs.js`, matching the CI entry,
and displayed one Keyboard shortcuts button. The earlier mismatch is resolved.
Opening help displayed Workspace and Map canvas instructions; Escape closed it
and returned focus to the trigger. Double-clicking Markdown opened Inspector,
where the visible action was now `Edit`, measuring `64 × 34px` inside the same
`340px` panel at `1363 × 936`.

An Inspector Markdown draft was then given a temporary QA marker. With help
open, Control+S left help open, retained the temporary marker in the draft and
Unsaved Markdown status, and did not put the marker on the card. Escape closed only help,
returned focus to Keyboard shortcuts, and retained the draft. Plain-text Cancel
discarded the marker and restored Saved. A final reload confirmed four cards,
Saved, the matching entry asset, and no marker; no application content change
was persisted. macOS Command+S was not exercised.

The subsequent desktop continuation verified Markdown/reference/edge Inspector
entry, clean-editor handoff, dirty-edge draft protection, keyboard activation of
More actions, native Inspector and Reading copying, and background isolation for
Delete and help's Control+A. Overlapping inline Save/Cancel and display-mode
resizing also passed pointer checks. The compact result table and observed
placement-conflict recovery are recorded in the
[C4 desktop browser results](./PROJECT_C4_ACCEPTANCE.md#desktop-browser-results).

At the time of these checks, resizing the current card while editing and
letting large-card textarea/Preview areas use the available height were new
requirements. Both were implemented and later accepted on PR #180's deployed
build. Existing-card size uses placement history, while new-note size stays
local until creation. Full interaction and device acceptance remains open.
No manual deployment, migration, or remote configuration change was performed.

## Product changes

- Inspector prioritizes content and relationships. A permanent pencil-and-Edit
  action sits in the type row, with the existing explicit accessible name.
  Source actions are compact; edge direction uses readable text. Edge deletion
  joins other infrequent actions under More actions.
- Cancel is plain text in Markdown, attachment and edge editors. Escape remains
  supported without adding its name to every button.
- A keyboard icon beside Save opens a modal reference for the existing basic
  commands. It introduces no single-letter tool shortcuts. Text editing keeps
  native operations; the help dialog preserves the underlying draft and blocks
  background Save and Canvas commands.
- Only unambiguous chords are consumed. Modified Escape, IME composition,
  modifier-arrow navigation and Shift+Delete cannot trigger Canvas actions.
  Command+Y remains a browser shortcut; Control+Y remains a redo alternative.
- Non-Canvas panel and menu focus no longer changes the background selection,
  history or card clipboard. Save continues to target the active editor.

## Historical implementation verification — PR #175

- Full suite: 951 source tests and 394 mounted tests passed. Development and
  production bundled-formula checks passed.
- TypeScript, production build and desktop-only React Flow bundle ownership
  passed. A final edge-surface run covers the remaining inline Cancel text update.
- Permanent regressions cover actual React Flow node and multi-selection
  keyboard handling, modifier/IME exclusion, inline edge Save, panel ownership,
  help focus trapping/restoration and background isolation, and preserving and
  saving an Inspector draft after dismissing help.
- Existing edge delete/restore/history tests now open More actions explicitly.
  The native details element is checked through its open state; JSDOM's role
  query alone does not model its closed-content visibility.
- Independent review found no remaining behavior or data blocker. Its two
  presentation findings were addressed: inline edge Cancel text and the 44px
  Inspector header-action target in mobile panels and on coarse pointers.

## Historical browser evidence — PR #174

The authenticated deployed PR #174 page was inspected at 1363 by 936. The
synthetic QA Project reproduced oversized full-width Markdown and edge Edit
buttons, the competing edge Delete action, and the raw `forward` direction.
Markdown and edge were opened through Inspector, entered editing and cancelled;
edge Escape returned to inspection. The Project remained Saved, and no content
or geometry write was needed for this inspection.

## Remaining browser acceptance

Editing-state resize and large-card editor layout passed PR #180's desktop
deployment checks. The desktop draft/Control+S/Escape/Cancel,
Control+A/Delete isolation, native copying, and More actions checks passed
above; macOS Command shortcuts and the remaining Canvas commands under help
are still unverified in the browser.

Check header alignment and light/night contrast at narrow and wide sizes, help
scrolling at short heights, and the adjacent `480/481`, `560/561`, `859/860`, and
`1180/1181` widths listed in the C4 checklist. Inspector actions have a 44px
minimum height in mobile panels or on coarse pointers; shortcut icon buttons
grow from 36px to 44px only under the coarse-pointer rule. A narrowed desktop
viewport alone does not exercise that input mode.

Mounted and CSS-viewport coverage do not establish physical touch, soft-keyboard,
safe-area, or native mobile browser acceptance, or complete Phase 5C4. The C4
record owns the wider interaction and fault-injection boundaries.
