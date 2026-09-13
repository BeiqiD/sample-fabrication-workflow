# Project panel continuity and hierarchy

Reviewed: 2026-09-13. Original implementation baseline: PR #181, integration commit
`1830927b33e2c6b82e6104cc50511cdba04290f7`.

## Current acceptance status

[PR #182](https://github.com/BeiqiD/sample-fabrication-workflow/pull/182) deployed
the dialog, disclosure retention and typography changes. Its browser acceptance
found two additional interaction defects, both fixed and accepted after
[PR #183](https://github.com/BeiqiD/sample-fabrication-workflow/pull/183) deployed.
PR #184 subsequently applied the shared session/pinning rules to both panels.
PR #185 unified their widths and corrected referenced Sample-note layout.

The measurements and findings below are historical observations on PR #182.
Current Map panels both measure `340px` at the tested desktop viewport, and
Reading panels each measure `380px`. Current build identity, CI and the scoped
desktop results are in the
[C4 integration record](./PROJECT_C4_ACCEPTANCE.md#current-integration-check--2026-09-13).
Responsive and physical-device acceptance remains open.

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

## Historical browser follow-up after PR #182

The deployed dialog passed light/dark visual checks, initial focus and
Stay/Escape draft preservation. Panel sizes were 320px for References and 340px
for Inspector, with no horizontal overflow; those unequal widths were later
superseded by PR #185. Peer disclosure headings measured
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

## Follow-up acceptance — PR #183

PR #183 merged as `0b05cf156f80b298e85609c0d46dcfdb8054070b` after all four
Verify checks and 14 statuses passed; both postmerge Verify jobs and all 14
statuses also passed. Automatic Workers Build
`bb505823-3584-418e-b5a4-1ed2d7b30215` succeeded, version
`3e3e6c54-e97e-4708-9bca-17ee825ac6c0`. The deployed browser served its exact
CI entry `index-G3Xso3bC.js`.

On the named synthetic QA Project, native Space opened Inspector Details and
References More. Reading Add → Reference passed hit testing at the button
center; an actual pointer click opened References and replaced Inspector.
These checks needed no content writes or temporary drafts. They close the two
observed PR #182 interaction findings, within the recorded desktop scope.
