# Project panel behavior and Markdown activation

Baseline: PR #183, integration commit
`0b05cf156f80b298e85609c0d46dcfdb8054070b`.

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

Exact local/CI results, independent review and deployed browser acceptance are
recorded on the associated PR. Browser checks use only the named synthetic QA
Project, discard temporary drafts and leave the workspace Saved.
