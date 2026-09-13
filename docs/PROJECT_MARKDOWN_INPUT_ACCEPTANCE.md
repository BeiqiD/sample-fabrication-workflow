# Markdown composition input

Reviewed: 2026-09-13. Original implementation baseline: PR #180, integration commit
`6d85db2cecb5fd2b65df1abf40630c631daadcce`.

## Current acceptance status

[PR #181](https://github.com/BeiqiD/sample-fabrication-workflow/pull/181) merged
the composition correction as `1830927b33e2c6b82e6104cc50511cdba04290f7`.
Both postmerge Verify jobs and all 14 statuses passed. Its automatic Workers
deployment succeeded, and the browser served the matching CI entry
`index-DRmC-BVm.js`.

On the named synthetic QA Project, directly inserted Chinese text survived
Preview, expanded Write and collapse. Cancel restored Saved and removed the
temporary draft without persisting content. This deployed smoke and the
simulated composition regressions below do not establish physical Windows/macOS
IME acceptance; native candidate entry remains a device acceptance item.

The fix remains included through PR #185. See the
[current C4 integration record](./PROJECT_C4_ACCEPTANCE.md#current-integration-check--2026-09-13)
for its exact deployment identity and broader acceptance limits. The older
entry asset above identifies PR #181's check, not the current deployed asset.

## Defect and correction

The Canvas textarea previously took its controlled value directly from the
parent draft. A change passes through Surface's node projection effect and
ReactFlow's store effect before returning to the textarea. React's event-end
controlled-field restoration could therefore write the previous value, then the
new value. Although the final text looked correct in ordinary tests, those DOM
writes destroyed the native composition range and moved the caret, allowing
successive Pinyin fragments to accumulate.

The shared Markdown editor now owns a synchronous text value for each editing
session. Canvas, Inspector, Reading, Preview and the expanded editor use that
same draft. Every actual change still immediately updates the parent draft for
dirty-state, save and navigation protection. Composition completion reads the
complete textarea value; it does not append event data, and duplicate final
input events do not publish a second identical change.

Within an active session, upstream text is an echo, while status and geometry
remain parent-controlled. Discard/reload closes the session. A different item
or new-item state starts a fresh session. Future programmatic
draft replacement must explicitly reset the session instead of overwriting an
active composition through a delayed value prop.

## Regression evidence

- Two actual ProjectPage/ReactFlow cases failed before the correction: an input
  of `s` caused script writes of the old and new strings and moved the caret from
  offset 4 to 7. Both now pass with no script value writes, preserved caret,
  candidate completion, preview/expansion and one correct Markdown save.
- Component cases cover delayed intermediate echoes, repeated candidate values,
  composition completion before/after final input, native composition
  cancellation, pending resize/status changes and a new card identity.
- The focused two-file suite passes 20 tests. These tests simulate native input
  and composition events and observe DOM value writes. They do not constitute
  a physical Windows/macOS IME acceptance result.

PR #181's full verification passed 992 source and 435 mounted tests, plus
TypeScript/build, lazy Map ownership, local migrations, Reference/search Worker,
production Project Worker/assets and bundled formula checks. Independent review
found no remaining blocker. These are historical implementation results; this
documentation update does not rerun or broaden the physical IME claim.
