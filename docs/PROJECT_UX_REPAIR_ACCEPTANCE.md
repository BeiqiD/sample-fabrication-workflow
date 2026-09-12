# Project interaction repair acceptance

Date: 2026-09-11. Follow-up to the user's review of entry, editing, references,
connections, removal, mouse gestures and information density. This extends Draft
PR #168 beyond its original rendering scope. No merge or production deployment.

The historical Map body-selection rule below is superseded by the 2026-09-12
[card gesture acceptance](./PROJECT_CARD_GESTURE_ACCEPTANCE.md): Map previews
drag from their non-interactive body and double-click opens editing or Details.
Reading and Inspector retain text selection.

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

## Independent review and cross-size follow-up

Three independent read-only reviews covered editing/navigation, deletion/recovery,
and endpoint reconnection/migration/history. The follow-up fixed two classes of
unknown-result settlement defects and one mobile layout defect:

- An uncertain create must retain its exact request after a reversible 409.
  Reference cancellation may only treat a replay rejection as settled when the
  Worker supplies its authoritative-rejection proof. A currently absent item is
  insufficient: the original request may still commit later.
- An uncertain Trash mutation stays locked after a later generic 4xx. A 409 only
  permits reconciliation when the current task's item/content/edge revision has
  strictly advanced. Temporary source or endpoint unavailability is reversible.
  An original deletion token still requires acknowledgement so Undo is retained;
  partially completed restoration preserves the cascade recovery ledger.
- At phone widths, identity and commands use separate header rows. Multiword save
  status wraps within its own space. Previously the title collapsed to zero width,
  the Add button covered the return link, and editing status overflowed its badge.

Browser checks used the real application in a temporary same-origin iframe with
controlled CSS viewport dimensions, driven through ordinary browser UI. This
exercises real layout/media-query behavior, not native device emulation. The
temporary harness was removed before the production build.

| CSS viewport | Observed acceptance |
| --- | --- |
| 360 × 900 and 360 × 600, dark/light | Add → Markdown → formula Preview → expanded editor → Save; all short-screen editor actions in bounds. Header identity and commands remain reachable, including multiline editing status. |
| 390 × 600, light | Attachment edit → Save metadata and leave → reopen persisted value; reference search; card More → Trash → restore. |
| 859 → 860 × 900, light | Draft text survives crossing the mobile/desktop boundary; Reading remains mounted until cancellation, then desktop Map appears. |
| 860 and 1024 × 900, light | Map controls fit; References and Inspector switch as one unpinned panel. |
| 1180 → 1181 × 900, light | At 1180 opening References closes unpinned Inspector; at 1181 both can remain open. |
| 1440 × 600, light | Both floating panels stay within the short viewport and scroll internally; Canvas retains its full area. |
| 360 × 600, light, complex math fixture | Fractions, matrix, integral, table, tasks and malformed-TeX fallback render. A 509 px equation scrolls within a 281 px region; browser wheel moved it to scrollLeft 228. Document scrollWidth equals clientWidth (345 px excluding scrollbar), and card scrollWidth equals clientWidth (315 px). |

The reconnection review found no additional defect in atomic endpoint updates,
migration identity/provenance guards or Undo/Redo. Targeted independent suites and
new regressions were followed by the integrated checks below.

The first follow-up CI exposed a timing race in the clipboard-denial test: it
clicked Inspector after Map mounted but before the canonical focus link had
selected its item. A bounded repeated run reproduced the same failure locally.
The test now waits for the requested selected/focused item and Inspector content
before exercising clipboard denial, matching the successful-copy fixture's
preconditions. The clipboard error assertions remain unchanged.

## Automated and integration evidence

- Follow-up `npm test`: **175 source suites / 870 tests**, **39 mounted suites / 213 tests**,
  all passing; development and production bundled-math gates also passed.
- `tsc -b` and clean TypeScript/Vite production build passed. The Map bundle gate
  confirmed React Flow remains owned by the desktop-only lazy Map chunk.
- The full suite includes the permanent Map performance fixtures and meaningful
  regressions for mobile/Reading entry, panels, editor errors, navigation locks,
  exact retry, copy/paste, endpoint reconnection, partial bulk restore and deletion
  provenance. Examples include 503 → 403 → successful exact replay without exposing
  an unsafe Cancel/new-write path, and restore/navigation unlock after reconciliation.
- The added follow-up regressions cover reversible 409 after an uncertain create
  or restore, authoritative revision fences, original-deletion acknowledgement,
  delayed commit during cancellation and retained connection recovery. A real
  Worker/SQLite test proves an endpoint-unavailable restore can later succeed
  with exactly the same edge revision and operation ID.
- Integration baseline at `3833f406`: `verify:d1-migrations` passed through
  migration 0036. The local QA database was
  backed up before applying it. `verify:project-worker` passed against real local
  bindings, including asset deduplication, retries, rollback and lifecycle flows.
- `git diff --check` passed.

## Remaining acceptance boundaries

- Desktop Chrome and the controlled iframe dimensions above cover this interaction
  revision. Native mobile Safari/Chrome, touch gestures and the on-screen keyboard
  were not tested; iframe resizing is not evidence for those device behaviors.
- C3 remains open for contextual Reading details and fully modal mobile panels
  with focus containment/dismissal/return. Existing Reading Add, shared editing and
  compact actions are already implemented and should be reused by that slice.
- Earlier export-download landing, full valid-workbook import, and configured
  managed-storage Comment upload limits remain as recorded in that report.
- Global Undo covers layout/edge history and deletion priority; it is not universal
  history for content edits or creation. Unfinished deletion recovery is held in
  the current tab/session and uses authoritative reads before releasing locks.
- Deployment of endpoint reconnection requires migration
  `0036_project_edge_reconnection.sql` before serving the new Worker. Only the
  local QA database was migrated in this pass. PR remains Draft.

## Extended pre-merge review — 2026-09-12

The user authorized merging #168 and #169 after this additional review. This pass
extends the earlier happy-path and responsive checks to delayed writes, route
reuse, commands beneath modals, and malformed input at larger sizes.

- A real SQLite service/controller regression reproduces a reconnect whose first
  response is lost, whose retry encounters a temporary duplicate relationship,
  and whose original request can still commit later. A generic 409 now retains
  the exact request and its lock. Only an authoritative rejection or advancement
  of a revision actually compared by that request permits conflict recovery.
  Missing rows, unchanged revisions and failed reads do not prove settlement.
- Project switches and authoritative reloads reject commands using an old
  snapshot. Read generations, Project identity checks and placement-save session
  invalidation prevent stale work from being installed into the next session.
  Existing dirty geometry can still finish saving before a conflict reload starts.
- Canvas shortcuts no longer reach behind a modal, and the Project deletion
  confirmation blocks the workspace Save shortcut. Expanded Markdown retains its
  own Ctrl/Cmd+S behavior.
- The shared math review additionally checked hostile TeX/MathML, URL and HTML
  attribute input, recursive macros, and the locked Temml lexer transform. No new
  injection regression was found. A pre-existing repeated-unclosed-delimiter
  rendering slowdown was reproduced and addressed during this pass. Duplicate
  scans are reduced, and each document has a cumulative math-scan budget. When
  pathological input exhausts it, the existing escaped-source fallback preserves
  the complete text instead of continuing expensive parsing.

These findings have permanent regression coverage. The earlier browser evidence
above remains dated to its original run; this extension uses automated component,
service, and build checks and does not claim a new native-device/browser run.
