# Inspector hierarchy and keyboard ownership

Date: 2026-09-12. Base: merged PR #174 at
`4da00e06f9a5d18a1bfb022a5b4375e692fba7ed`.

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

## Verification

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

## Browser evidence and remaining acceptance

The authenticated deployed PR #174 page was inspected at 1363 by 936. The
synthetic QA Project reproduced oversized full-width Markdown and edge Edit
buttons, the competing edge Delete action, and the raw `forward` direction.
Markdown and edge were opened through Inspector, entered editing and cancelled;
edge Escape returned to inspection. The Project remained Saved, and no content
or geometry write was needed for this inspection.

The new changes are not deployed by this PR. Their visual acceptance remains
open: check header alignment at narrow and wide desktop sizes, light/night
contrast, 44px touch targets, help scrolling on short screens, native keyboard
activation and text selection, and help over an active draft. Mounted coverage
does not establish physical-device acceptance or complete Phase 5C4.
