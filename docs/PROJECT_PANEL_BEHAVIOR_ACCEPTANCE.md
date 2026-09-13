# Project panel behavior and Markdown activation

Reviewed: 2026-09-13. Original implementation baseline: PR #183, integration commit
`0b05cf156f80b298e85609c0d46dcfdb8054070b`.

## Current acceptance status

[PR #184](https://github.com/BeiqiD/sample-fabrication-workflow/pull/184) merged
these behaviors as `38b6f021034f524c96fe0d26405b07d2bc0f9be9` and completed
the deployed desktop acceptance below. PR #185 subsequently aligned panel
widths and Sample-note metadata without changing these interaction rules.
The [current C4 integration record](./PROJECT_C4_ACCEPTANCE.md#current-integration-check--2026-09-13)
owns the latest build identity, layout measurements and remaining acceptance
boundaries. Phase 5C4 remains in progress; Phase 5D has not started.

## Shared panel rules

References and Inspector use the same Project-session model for user-opened
state, Pin and temporary presentation. Opening a panel with no selection keeps
it usable. Switching cards updates its content without closing it. After a real
selection is cleared, unpinned panels temporarily hide and pinned panels remain.
An explicit Close stays closed on later selection; reopening preserves Pin and
Inspector disclosure choices. Preferences belong to each Project session.
References' applied search and unfinished search input are also isolated by
Project; search input is UI state, not a content-editing draft.

Wide Map can show both panels. Narrow Map and Reading show the most recently
opened eligible panel; Pin does not override this mutual exclusion. Replacing
one panel preserves its open intent. Closing the active Reading panel does not
automatically summon the other; returning to wide Map restores eligible open
panels. Pending reference placement and Inspector editing retain their original
operation guards and keep the required panel available.

## Markdown double-click

Single click still selects. Double-clicking the non-interactive area of a
Markdown card starts its existing surface editor and opens Inspector alongside
it. The operation opens Inspector only after editing starts successfully and
cancels stale Inspector focus requests, so the textarea owns the caret.
The two panels share a focus request sequence. A regression first reproduced
an older References request stealing focus after the editor mounted; a newer
editing action now invalidates that old request as well.

The explicit Details command remains read-only. Reference, attachment and edge
double-click behavior is unchanged. Links, buttons, resize grips, existing
editors and pending nodes do not start a second edit or create a new note.
Blank-canvas double-click retains its existing new-Markdown behavior.

## Verification

Actual ProjectPage/ReactFlow cases cover single click, combined double-click,
delayed focus, resize availability, editing inside the existing card and
Save/Cancel with no extra card or creation request. Surface cases cover rich
text/math/header hit targets, Details, other kinds, disabled commands and
editing/saving/uncertain states. Shared-panel cases exercise both panels under
the same selection, Pin, Close, responsive and Project-isolation scenarios.

PR #184 passed 992 source and 465 mounted tests, the remaining local build and
Worker gates, and independent review. Its exact head passed all four Verify
checks and 14 statuses; both postmerge Verify jobs and all 14 statuses passed.

## Deployed desktop acceptance — PR #184

Automatic [Workers check 103638097480](https://github.com/BeiqiD/sample-fabrication-workflow/runs/103638097480)
succeeded, version `602de5d6-da09-4e21-beb2-9deba38989b3`. The browser reloaded
the matching CI entry `index-CrnWCafs.js`. This is PR #184's historical asset,
not the current PR #185 entry recorded in C4.

- Wide Map verified both panels opening with empty selection, matching
  Pin/Unpin controls, selection changes without closing, pinned retention and
  unpinned hiding after selection clearing, explicit Close preventing
  single-click reopening, and Pin surviving reopening.
- Single Markdown click selected without editing; Details opened Inspector
  without editing. Double-click with References already open mounted one
  existing-card editor and Inspector, retained both panels and kept the textarea
  focused after lazy loading. A temporary Chinese draft stayed intact and the
  enabled resize grip passed hit testing; Cancel restored Saved and four cards.
- Native Space toggled Details, whose expanded state survived card changes and
  Close/reopen. Reference double-click opened Inspector without an editor.
- Reading showed the last opened panel while retaining both Map pins. A pointer
  click on Add → Reference replaced Inspector with References; closing it left
  both hidden. Returning to Map restored the eligible pinned Inspector while
  explicitly closed References remained closed.
- Blank-Canvas double-click opened one focused new local Markdown editor;
  Cancel restored the original four cards. The final state was light Map,
  Saved, with no editor, draft or saved content/geometry change.

All checks used the named synthetic QA Project. Narrow responsive behavior is
covered by mounted tests; it is not a physical-device result. Direct Chinese
text insertion does not qualify native OS IME behavior.
