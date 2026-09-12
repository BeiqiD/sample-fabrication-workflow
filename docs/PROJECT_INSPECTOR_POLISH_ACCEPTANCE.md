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
