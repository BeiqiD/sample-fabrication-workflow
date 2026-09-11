# Project interaction repair acceptance

Date: 2026-09-11. Follow-up to the user's review of entry, editing, references,
connections, removal, mouse gestures and information density. This extends Draft
PR #168 beyond its original rendering scope. No merge or production deployment.

## Implemented behavior

| Task | Result |
| --- | --- |
| Select and inspect | Selection shows nearby actions without opening Inspector. Details opens it explicitly; only Pin changes its pinned state. References starts closed. Narrow desktop panel switching respects an explicit pin. |
| Read and edit | Card body double-click selects text; header double-click edits. Map and Reading share a Write/Preview editor with an expanded draft. Save and Ctrl/Cmd+S save the active editor; status reflects its actual state. Navigation offers Save and leave. |
| Correct an error | Invalid attachment URLs remain editable with the caption preserved. Determinate rejections permit correction/new requests; a previously uncertain request remains frozen for exact retry. A conflicting draft can be discarded and reloaded after existing layout writes finish. |
| Add content | Map, Reading and mobile Reading share Add. Button-created notes, references and attachments avoid occupied cards using their actual dimensions and anchors. An off-screen new card is revealed without changing zoom. Explicit drop/right-click coordinates remain exact. |
| Find and cite | Reference rows emphasize title/type/context and Place/Open. Secondary excerpts and Details are disclosed on demand. Related candidates are deduplicated and filtered before the display cap; bounded or failed reads are reported honestly. |
| Connect | Card connection handles remain above resize borders. Nearby edge actions edit label/direction or reconnect an endpoint. Short-edge toolbars avoid endpoint hit areas and stay inside the canvas. Item and edge selection remain exclusive. |
| Copy and arrange | More and right-click share commands. Align and Layer use submenus. Paste here uses the clicked canvas point; keyboard paste keeps its established offset and grouped geometry. |
| Remove and recover | Delete/Backspace and More support selected cards. Undo prioritizes the latest deletion group. Project actions opens Trash, including multi-select restore. Cascade edges restore only for the matching deletion action and available endpoints. |
| Reduce secondary content | Inspector previews have bounded scrolling and optional expansion. Technical metadata and infrequent actions are collapsed. Relationship entries focus the connected card. Canvas status notifications float above the canvas instead of resizing it; paste notices can be dismissed. |

## Browser acceptance on the integrated implementation

Chrome, real local Worker/D1/R2 bindings; dedicated Project
`project-f790244b-656f-4744-9b72-343a6b2e9613`.

- Created and saved a Markdown note with a fraction and two-row matrix; inspected
  rendered math in Map, expanded Preview and Reading. Ctrl+S saved the expanded
  draft. Body double-click left zero editors and did not open Inspector.
- Deleted the note through More, restored it with Ctrl+Z when layout history was
  empty, deleted again, reloaded the page and restored through Project Trash.
- Created another note from Reading and uploaded a real 48-byte text attachment.
  An observed network failure recovered with exact retry and one visible attachment.
  Entered an invalid source URL, verified retained caption and editable fields,
  corrected it, used Save metadata and leave, and reopened the saved caption/URL.
- Searched REF-A and placed the same Run reference twice. The two occurrences had
  distinct non-overlapping positions and Open source targeted the research record.
- Dragged a card header and observed layout persistence. Created a connection by
  dragging its handle; changed label and direction with Ctrl+S; reconnected its
  source and checked Undo/Redo. The same edge ID, label and direction were retained.
- Reproduced and fixed selected-card resize borders intercepting connection
  handles, a short-edge toolbar covering a reconnect handle, and stale card
  selection after edge creation. The final short-edge toolbar was fully visible;
  DOM hit testing reached both reconnect handles. Dragging its target to another
  note changed the endpoint while retaining the edge ID.
- Copied a note and used right-click Paste here. Selected all six cards, pressed
  Delete, selected all six Trash entries and restored them. All six cards and the
  associated labelled/directed edge returned with its original ID.
- Reproduced Reading Add overlap, then added a new note and attachment after the
  fix and checked that both avoided existing cards. Existing positions were not
  rearranged by the fix.
- Inspected light and dark Map/Inspector layouts. Clicking a relationship focused
  its card and updated the open Inspector. Technical Details/More stayed collapsed;
  expanding a preview did not pin the Inspector.

## Automated and integration evidence

- `npm test`: **175 source suites / 869 tests**, **39 mounted suites / 200 tests**,
  all passing; development and production bundled-math gates also passed.
- `tsc -b` and clean TypeScript/Vite production build passed. The Map bundle gate
  confirmed React Flow remains owned by the desktop-only lazy Map chunk.
- The full suite includes the permanent Map performance fixtures and meaningful
  regressions for mobile/Reading entry, panels, editor errors, navigation locks,
  exact retry, copy/paste, endpoint reconnection, partial bulk restore and deletion
  provenance. Examples include 503 → 403 → successful exact replay without exposing
  an unsafe Cancel/new-write path, and restore/navigation unlock after reconciliation.
- `verify:d1-migrations` passed through migration 0036. The local QA database was
  backed up before applying it. `verify:project-worker` passed against real local
  bindings, including asset deduplication, retries, rollback and lifecycle flows.
- `git diff --check` passed.

## Remaining acceptance boundaries

- This repair pass used the available desktop Chrome viewport (1363 × 936), in
  both themes. Mobile/adjacent-breakpoint behavior has mounted coverage; the new
  controls were not rechecked in native mobile browsers or at every visual width.
  The earlier 1440/1024/390/360 checks in `PR168_BROWSER_ACCEPTANCE.md` predate this
  interaction revision and are not evidence for its new controls.
- Earlier export-download landing, full valid-workbook import, and configured
  managed-storage Comment upload limits remain as recorded in that report.
- Global Undo covers layout/edge history and deletion priority; it is not universal
  history for content edits or creation. Unfinished deletion recovery is held in
  the current tab/session and uses authoritative reads before releasing locks.
- Deployment of endpoint reconnection requires migration
  `0036_project_edge_reconnection.sql` before serving the new Worker. Only the
  local QA database was migrated in this pass. PR remains Draft.
