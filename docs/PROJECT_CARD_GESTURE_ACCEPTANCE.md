# Project card gestures and live workflow acceptance

Date: 2026-09-12. Follow-up to the authenticated Cloudflare inspection and the
user's request for intuitive selection, dragging, editing and realistic records.

## Interaction contract

| Gesture | Result |
| --- | --- |
| Single click | Select the card and show its nearby actions. |
| Press and move | Drag from any non-interactive area, including Markdown text, mathematical content, blank space, reference excerpts and attachment images. No preliminary selection click is needed. |
| Double-click Markdown | Open the existing editor from its body, formula, heading or header. |
| Double-click a reference or attachment | Open Details, subject to the existing panel lock. |
| Link, editor, resize border or connection handle | Keep its own operation; do not start card movement or double-click editing. |
| Scroll a long note | Scroll its contents. Arrow/Page/Home/End keys retain scrolling when its reading region has focus. |
| Copy/Delete with Map preview focus | Operate on selected cards through the existing guarded commands. |
| Select/copy text in Reading or Inspector | Keep native text operations; do not mutate the Map. |

An acknowledgement for one card no longer replaces the transient position of
another card during its active drag. The same projection rule preserves active
resize dimensions while accepting fresh content and selection. Deleted,
replaced, pending, locked or edited nodes do not retain stale pointer geometry.

## Reference mathematics

The live fixture exposed a separate issue: Comment references compressed and
truncated Markdown twice, producing raw or incomplete LaTeX in their summaries.
Comment summaries now carry an explicit Markdown format, retain complete bounded
paragraphs and use the shared safe comment renderer. Other reference summaries
remain plain text. The Map does not truncate the Markdown summary a second time.
Content that cannot fit safely is read through Open source. These previews stay
inside the existing card dimensions and renderer lazy-loading boundaries.

## Browser verification against the existing Cloudflare deployment

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

This browser pass used the existing deployed frontend. It validates the actual
backend workflow and supplies reproduction evidence, not proof that the new
gestures have been deployed. Post-deployment verification must repeat body drag,
double-click editing/Details and drag-during-save on the new served assets.

## Regression evidence

Real ReactFlow mounted tests cover body/image/reference dragging, double-click
ownership, native links and editor input, keyboard ownership, resize, mouse and
touch connections, and a delayed real-Page save acknowledgement during a second
drag. Removing the `nodrag` event exception makes all three resize/connection
regressions fail; restoring it makes them pass. Projection unit tests cover
multi-drag, resize and replacement/lock boundaries.

Full-suite and build results are recorded in the pull request. The existing
deployment gate and activation requirements still apply.
