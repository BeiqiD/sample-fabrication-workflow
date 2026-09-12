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
| Any committed card's bottom-right corner | Drag the always-visible triangular border corner to resize directly, without selecting first. The 36-unit corner scales with the card and stays clear of content/source links. Only that card resizes; selection is preserved. Editing and geometry locks disable this operation. |
| Arrow keys with the resize grip focused | Adjust width/height by 5 canvas units, or 20 with Shift. Preserve position and layer, respect existing dimension limits, and retain Save/Undo/Redo. |
| Link, editor, resize grip or connection handle | Keep its own operation; do not start card movement or double-click editing. |
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

## Dedicated resize grip follow-up

The authenticated Cloudflare page reproduced the resizing difficulty: selected
cards exposed four 9px corner targets, partly clipped by the card, alongside
thin edge targets. PR #172 replaced these with a selected-card floating grip.
The user's follow-up clarified that the corner must always be present as part
of the border. The revised control is a 36-unit triangle within every committed
card's bottom-right corner, without a floating square or preliminary selection.
It scales with the card and uses a triangular hit area, reserved bottom padding,
and an offset source link to keep its operation clear of content and scrolling.

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

Browser evidence for this follow-up currently covers reproduction on the
existing deployment. The new grip still requires post-deployment browser
verification, including zoomed-out hit targets and nearby links/connection
handles. Mounted touch coverage does not establish physical mobile acceptance
or change the existing Reading-only mobile scope.

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
