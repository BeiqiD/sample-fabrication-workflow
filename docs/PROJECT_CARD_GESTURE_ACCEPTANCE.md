# Project card gestures and live workflow acceptance

Updated: 2026-09-13. Current integration baseline: PR #185, merge
`c4bf698e3753a0474e7d75d400af6685ff874a6a`. The contract below includes PR #180's
active-editor resize and PR #184's combined Markdown activation. Historical
2026-09-12 browser evidence is retained under its original scope.

See the [current C4 integration record](./PROJECT_C4_ACCEPTANCE.md#current-integration-check--2026-09-13)
for deployed desktop acceptance and remaining wide-screen, physical-device and
large-Project checks. C4 remains in progress; Phase 5D has not started.

## Interaction contract

| Gesture | Result |
| --- | --- |
| Single click on a committed card or edge | Select it and show nearby actions. An already-open Inspector follows the selection; this gesture does not open it. |
| Press and move | Drag from any non-interactive area, including Markdown text, mathematical content, blank space, reference excerpts and attachment images. No preliminary selection click is needed. |
| Double-click a committed Markdown card | Start its existing surface editor and open Inspector alongside it, subject to the edit/panel guards. The textarea retains focus; no extra card is created. Details remains read-only. |
| Double-click a committed reference, attachment or edge | Open its Inspector, subject to the existing panel lock. Editing remains an explicit Edit action where available. |
| Primary click or drag in Canvas while an existing editor is unchanged | Exit the clean editor and perform that same click or drag. This requires the editable draft to exactly match its existing persisted content; editor inputs and controls keep their own interaction. |
| Click an edge | Place its action toolbar near the actual click, clamped inside the visible Canvas and clear of endpoint controls. Keyboard/programmatic selection uses the endpoint-based fallback. |
| Any committed card's bottom-right corner | Drag the always-visible triangular border corner to resize directly, without selecting first. The 18-unit corner scales with the card, follows its 12-unit outer radius and stays clear of content/source links. Only that card resizes; selection is preserved. The active Markdown card remains resizable during ordinary Canvas or Inspector editing; unresolved saves and other geometry locks retain their guards. |
| Arrow keys with the resize grip focused | Adjust width/height by 5 canvas units, or 20 with Shift. Preserve position and layer, respect existing dimension limits, and retain Save/Undo/Redo. |
| Link, editor, resize grip or connection handle | Keep its own operation; do not start card movement or double-click inspection. |
| Scroll a long note | Scroll its contents. Arrow/Page/Home/End keys retain scrolling when its reading region has focus. |
| Copy/Delete with Map preview focus | Operate on selected cards through the existing guarded commands. |
| Select/copy text in Reading or Inspector | Keep native text operations; do not mutate the Map. |

An acknowledgement for one card no longer replaces the transient position of
another card during its active drag. The same projection rule preserves active
resize dimensions while accepting fresh content and selection. Deleted,
replaced, pending or otherwise locked nodes do not retain stale pointer geometry.

PR #180 permits resizing the active Markdown editor without losing its text.
Existing-card size changes use placement autosave/history; Cancel discards the
text draft while Undo after editing restores size. New-note dimensions stay
local until creation. Save, Cancel and Expand wait for an active resize, and
gesture cancellation or unmount releases the resize lock.

Clean-editor handoff applies only to an existing Markdown, attachment metadata or
edge editor in the ordinary `editing` state. New or changed drafts, rejected saves,
saving, uncertain and conflict states cannot use this handoff; they retain their
editing session and operation guards, including the allowed Markdown resize above.
Pending operations, reloads, navigation decisions and modal controls cannot be
cleared by clicking the Canvas. Handoff performs no content write and keeps focus
with the new Canvas action instead of returning it to the former Edit trigger.
The existing shortcut implementation is recorded in
[shortcut acceptance](./PROJECT_SHORTCUT_INSPECTOR_ACCEPTANCE.md).

## Reference mathematics

The live fixture exposed a separate issue: Comment references compressed and
truncated Markdown twice, producing raw or incomplete LaTeX in their summaries.
Comment summaries now carry an explicit Markdown format, retain complete bounded
paragraphs and use the shared safe comment renderer. Other reference summaries
remain plain text. The Map does not truncate the Markdown summary a second time.
Content that cannot fit safely is read through Open source. These previews stay
inside the existing card dimensions and renderer lazy-loading boundaries.

## Historical browser verification — 2026-09-12, before the gesture repairs

Created an isolated `QA · Canvas interaction · 2026-09-12` Project and a
`QA-CANVAS-20260912` Sample, both explicitly marked as synthetic fixtures.
The pre-existing Doping Project was not changed by this workflow.

- Created a Project note containing inline and display formulas, a table, a list
  and a source link. Verified Write/Preview and Reading rendering.
- Created and edited Sample metadata, then added a mathematical observation.
  Its formulas rendered in both Notes & observations and the timeline.
- Searched the Sample code, found both Sample and Comment, and placed both
  references in the Project without modifying their source records.
- Connected the Project note to the Sample reference, edited its label and
  direction, and saved the relationship.
- Edited the note in Reading and verified the new text after a browser refresh.
- Moved the note to Trash and used Undo. After completion and refresh, all three
  cards and the labelled directed edge were restored.
- No application errors were reported by the browser's filtered error log.

This browser pass used the then-deployed frontend. It validated the actual
backend workflow and supplied reproduction evidence; it did not establish
deployment of the subsequent gesture repairs. Their later deployed checks and
remaining acceptance are recorded in [C4 acceptance](./PROJECT_C4_ACCEPTANCE.md).
These observations apply only to the deployment tested at that time.

## Regression evidence

The Inspector follow-up keeps Markdown, attachment metadata and edge editing in
the panel when started there. Save/Cancel stay beside the bounded input area;
Cancel/Escape preserve the panel and selection and return to the Edit action.
Tests cover unchanged exit without a write, successful saves, guarded uncertain
outcomes, mobile sheet Escape ordering and blocked panel switches. Direction
controls expose four keyboard-operable icon radio buttons instead of a select.
Connection ports are siblings of the clipped article, and source actions are
bottom-centered; native connection and card gesture regressions remain applicable.

Historical inspection of the deployed #173 assets confirmed article
overflow/clip-path cut the outer half of each connection port. Follow-up assets
were still awaiting deployment in that inspection. Later desktop checks are
recorded in C4; bounded 2K/4K layout and physical-device acceptance remain open.
The available browser viewport was 1363×936, so mounted coverage is not claimed
as a physical large-screen or mobile visual test.

Real ReactFlow mounted tests cover body/image/reference dragging, double-click
ownership, native links and editor input, keyboard ownership, resize, mouse and
touch connections, and a delayed real-Page save acknowledgement during a second
drag. Removing the `nodrag` event exception makes all three resize/connection
regressions fail; restoring it makes them pass. Projection unit tests cover
multi-drag, resize and replacement/lock boundaries.

Full-suite and build results are recorded in the pull request. The existing
deployment gate and activation requirements still apply.

## Historical resize grip follow-up — PRs #172–#174

The authenticated Cloudflare page reproduced the resizing difficulty: selected
cards exposed four 9px corner targets, partly clipped by the card, alongside
thin edge targets. PR #172 replaced these with a selected-card floating grip.
The user's follow-up clarified that the corner must always be present as part
of the border. PR #173 introduced a 36-unit triangle; the subsequent size refinement
halves both dimensions to 18 units and follows the card's existing 12-unit outer
radius. It remains visible within every committed card's bottom-right corner,
without a floating square or preliminary selection.
It scales with the card and uses a rounded triangular hit area, reserved bottom padding,
and a bottom-centered source link to keep its operation clear of content and scrolling.

Mounted regressions exercise native mouse and multi-step touch resizing from
the button itself, unselected/primary/secondary cards, editing/lock cancellation, arrow
and Shift-arrow adjustments, dimension limits, modifier/activation key ownership,
and real-Page Save/Undo/Redo persistence. Stable resize callbacks prevent live
dimension updates from restarting the native touch listener mid-gesture. Direct
resize, click and double-click preserve the existing selection. Touch cancellation
and a second finger discard transient dimensions without a geometry write.

The Projects directory displays Created from `createdAt` and Updated from
`updatedAt`, in equal-width, left-aligned date columns. Small screens show a
label with each date. Revision remains an internal concurrency parameter.

At this follow-up's original review, browser evidence covered reproduction on
the preceding deployment. Subsequent desktop grip and active-editor resize
checks are recorded in C4 and [PR #180](https://github.com/BeiqiD/sample-fabrication-workflow/pull/180).
Mounted touch coverage does not establish physical mobile acceptance or change
the existing Reading-only mobile scope.

## Additional merge review

Independent probes found and repaired four further boundaries:

- Literal math delimiters inside code examples, link destinations, HTML and
  nested Markdown constructs must not close a later real formula in a truncated
  summary. Exact same-line code spans are skipped; ambiguous long-source
  prefixes are omitted conservatively. The complete source remains available
  through Open source, and complete short comments are unchanged.
- A lock or interrupted pointer gesture must release its saved drag/resize
  start state. Aborted geometry returns to the current projection; late stop
  callbacks cannot create a write. Subsequent keyboard movement and normal
  pointer gestures still commit, while unrelated acknowledgements preserve an
  active drag. Real Page coverage includes opening and cancelling an editor
  during a drag, then moving by keyboard and saving.
  Cleanup runs in the next event task so native stop listeners finish first;
  generation and unmount guards prevent an older cleanup from ending a new drag.
- A 240-character summary can still contain dozens of Markdown paragraphs.
  Inspector and expanded search-result summaries therefore have a 240px scroll
  limit, visible keyboard focus and native reading-shortcut ownership for both
  plain and Markdown content. Reading and source-detail documents retain their
  ordinary document layout.
- Mobile Details must accept the first activation as soon as Reading appears.
  CI exposed an intermittent failure that a first-frame activation probe then
  reproduced deterministically: two passive effects based on the preceding
  empty selection closed the newly requested panel. Both consistency checks
  now run in the layout phase, before user interaction, retaining their existing
  close conditions. The regression activates the real Details button from the
  real Reading surface's first passive effect and verifies the live Inspector.
