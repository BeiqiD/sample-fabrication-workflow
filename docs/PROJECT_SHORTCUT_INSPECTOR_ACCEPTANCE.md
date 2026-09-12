# Inspector hierarchy and keyboard ownership

Date: 2026-09-12. Implementation base: merged PR #174 at
`4da00e06f9a5d18a1bfb022a5b4375e692fba7ed`.

## Current acceptance status

PR #175 and follow-up fixes #176–#178 are merged into `v2/backend-foundation` at
`791f00073ee69f4ce2c59a377705fe3faee61423`. Verify and Project Map performance
passed on that exact integration commit. The production assets and CI evidence
are recorded in [Project C4 integration acceptance](./PROJECT_C4_ACCEPTANCE.md#current-integration-check--2026-09-12).

On 2026-09-12, an authenticated browser reloaded the synthetic QA Project at
`1363 × 936`. The inspected deployment served `index-BkL0387N.js`, rather than
the two CI builds' `index-CAh5QSPs.js`, and the new Keyboard shortcuts control was
absent. Read-only Inspector inspection still showed the old `310 × 42px`
`Edit Markdown` button inside a `340px` panel. Saved remained visible; no editor
was entered or application data changed. These observations do not identify the
exact older deployed commit or establish a cause for the mismatch.

Visual acceptance of the new UI remains open. Before resuming, establish the
served commit/assets and confirm the new controls are present. Phase 5C4 remains
in progress and Phase 5D has not started.

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

After the served-build check, prioritize compact Markdown/edge Edit controls and
More actions, native text selection and keyboard ownership, and help over an
active draft. Help must block background Save and Canvas commands, close one
layer at a time, return focus, and preserve the draft.

Check header alignment and light/night contrast at narrow and wide sizes, help
scrolling at short heights, and the adjacent `480/481`, `560/561`, `859/860`, and
`1180/1181` widths listed in the C4 checklist. Inspector actions have a 44px
minimum height in mobile panels or on coarse pointers; shortcut icon buttons
grow from 36px to 44px only under the coarse-pointer rule. A narrowed desktop
viewport alone does not exercise that input mode.

Mounted and CSS-viewport coverage do not establish physical touch, soft-keyboard,
safe-area, or native mobile browser acceptance, or complete Phase 5C4. The C4
record owns the wider interaction and fault-injection boundaries.
