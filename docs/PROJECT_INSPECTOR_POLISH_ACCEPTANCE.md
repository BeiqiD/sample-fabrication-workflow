# Project panel continuity and hierarchy

Baseline: PR #181, integration commit
`1830927b33e2c6b82e6104cc50511cdba04290f7`.

## Observed defects

On the synthetic Canvas QA Project, the unsaved Markdown alert reused a yellow
save banner inside a modal. It had no heading, crowded actions, and mentioned
rejected changes even for an ordinary unsaved draft. Inspector Details closed
when switching cards. Peer disclosures used inconsistent sizes: Details and
Arrange were 10px while More actions inherited 16px; References scope buttons
were 10.5px.

## Behavior

- The leave dialog has a neutral surface, heading, explanatory text and a
  separate action row. Stay comes first and receives initial focus, discard
  actions have restrained danger text, and the primary action is right aligned.
  Narrow layouts stack actions. Escape stays, and the description is associated
  with the alert. All 25 guarded recovery/leave actions retain their conditions,
  callbacks and disabled states. Markdown messages distinguish unsaved,
  rejected, conflicting and uncertain saves.
- Inspector choices belong to the current Project session: panel intent, Pin,
  Details/edge Technical details, Expand note, More actions and Arrange on Map.
  Selection changes, editing and temporary panel replacement preserve these
  choices. Explicit Close stays closed until reopened; an initial single click
  still only selects. Reading never automatically summons a hidden Inspector
  modal. Project choices are isolated during route reuse. A full page reload
  starts a new session; no draft or server preference is persisted.
- Inspector and References share 12px metadata/actions, 13px body/section
  headings, 14px panel/reference titles and 16px Inspector content titles.
  Markdown retains its document hierarchy. Metadata wraps, source hierarchy
  uses readable label/value columns, and reference footer links/actions wrap
  with room for Details. Existing touch target rules remain in place.

## Verification

Five session-state regressions cover card/edge changes, editing, explicit close,
empty selection, Pin, Reading/References and Project route reuse. The dialog
regression covers description, initial focus, keyboard focus wrapping, Escape
and restored focus. Existing save/discard, uncertain operation and resize
coverage exercises the unchanged navigation guards.

Local gate results, independent review, exact integration build and deployed
browser acceptance are recorded on the associated PR. Browser checks use only
the named synthetic QA Project and discard temporary drafts.

## Browser follow-up after PR #182

The deployed dialog passed light/dark visual checks, initial focus and
Stay/Escape draft preservation. Panel sizes were 320px for References and 340px
for Inspector, with no horizontal overflow. Peer disclosure headings measured
13px, metadata labels 12px and values 13px. Expanded choices survived card
switches, explicit close/reopen and Reading replacement; explicit Close did not
reopen on single selection.

Two interaction issues were found and corrected in the follow-up:

- XYFlow's window-level Space-to-pan listener cancelled native summary
  activation in both panels. Their boundaries now stop only Space keydown
  propagation, retaining the native default, keyup and other shortcuts. Two
  real Page/Flow regressions failed before this correction; they also check
  that Canvas Space still pans and panel activation makes no Project write.
- Reading's floating Inspector covered the Add menu. At the Reference entry's
  center, browser hit testing reached Inspector instead of the menu button.
  Reading uses panel layer 8 and toolbar layer 9, below the global header 10
  and modal backdrop 46. The content workspace remains isolated underneath.
