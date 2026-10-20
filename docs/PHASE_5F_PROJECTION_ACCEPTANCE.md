# Phase 5F shared Project projection checkpoint

Date: 2026-10-10. Status: this bounded implementation passes focused local
qualification; complete combined-tree, remote CI and browser qualification remain
the integration owner's next checks. This does not close all Phase 5F or the
performance programme.

## Observed work and delivered change

The accepted PR #250 roadmap requests measured Map/Reading derivation cleanup.
Before this change, `ProjectPage` independently projected the same snapshot for
Map and Reading. `projectReadingNodes(snapshot)` called `projectMapNodes(snapshot)`
again. Both page memos depended on working geometry, so moving a card repeated
the content/source formatting and canonical indexes twice even when source
content had not changed.

The page now memoizes canonical descriptors on the snapshot, overlays working
geometry once, and orders a copied descriptor array for Reading. The new pure
`orderProjectReadingNodes` preserves the existing creation-sequence comparator
and `itemId.localeCompare` tie break. Map order and its array remain unchanged;
Reading shares the exact descriptors and working-geometry objects. The existing
public `projectReadingNodes(snapshot)` API remains available to other callers.

The implementation changes only the page's pure derivation and the small model
ordering helper. It preserves save/ACK handling, optimistic revisions, operation
identity, undo/redo, projection-switch guards, lazy surfaces and renderers. Dirty
geometry still blocks switching projections until settled.

## Diagnostic measurement

The pre-change diagnostic ran on Node **v24.19.0**, in this cloud Linux workspace,
using the actual model and existing mixed-record fixture modules. It used
synthetic 12-, 250- and 500-node snapshots containing references, Markdown and
attachments. Reversed and tied creation sequences exercise Reading order; every
placement receives a working-geometry overlay. Seven warmed samples each ran
3,000 iterations after 500 warm-up iterations. Values below are median time per
complete pure derivation, with no browser, HTTP, SQLite or provider operation.

| Nodes | Previous dual projection | Shared, including canonical rebuild | Shared, canonical already memoized |
| --- | ---: | ---: | ---: |
| 12 | 0.01802 ms | 0.00861 ms | 0.00113 ms |
| 250 | 0.47559 ms | 0.26339 ms | 0.04418 ms |
| 500 | 0.76457 ms | 0.36260 ms | 0.09926 ms |

The diagnostic compared the actual old dual-projection formula with the proposed
single canonical projection/overlay/copied sort. It asserted complete deep
equality, unchanged Map order, shared descriptor objects and exact overlay
geometry references before recording timings. It establishes avoidable pure
work and a bounded equivalent implementation, not browser frame rate, deployment
latency, React commit counts or a new fixed performance budget. No timing assertion
was added to permanent tests.

Pre-change audited blobs, from source HEAD
`4b2c660267b794d09798f961efe8d11ba6e1df86`:

- `src/pages/ProjectPage.tsx`: `42aafa8449ce516709147cbb47fdd870654457a2`
- `src/lib/project-map-model.ts`: `4a9a6f6f3d4de30cf7ab408697e7a24393f609d9`

Scratch measurement receipts:

- `/tmp/phase5f-projection-probe.mjs`, SHA256 `1fbaf18938f2d6f7b200f17edecb5994bb28985de6dfd696506adc2083e12f6d`
- `/tmp/phase5f-projection-probe.json`, SHA256 `cd3be8cd5c3e884601a539cddeffd9c6457b935698af07d79e1dc1d50d49a8ba`

Scratch files may disappear after environment replacement; the measured values,
conditions and qualification outcomes are recorded here.

## Focused qualification

The new actual-`ProjectPage` mounted tests use the real model and typed Project
API stubs; Map/Reading surfaces are replaced only to inspect the page's node
props. Unexpected `fetch` calls reject. A Markdown source getter counts actual
canonical content reads rather than relying on a timing assertion.

Before the implementation, the corrected two-test reproduction failed with:

- initial source getter count **6**, versus **3** for one canonical projection;
- complete Reading values matched, but Reading did not share the Map descriptors.

After implementation, both mounted tests pass. They prove one canonical
projection on initial read, no additional source formatting for geometry-only
move/undo or a settled view switch, identical full values across projections,
exact working-geometry identity, one acknowledged placement save, unchanged Map
order and the retained guard against switching with dirty geometry. Undo retains
the existing Unsaved state until explicit Save settles the now-empty delta;
the test follows that contract. Earlier harness attempts incorrectly tried
switching with dirty geometry or assumed Undo immediately displays Saved; those
assertions were corrected without changing product behavior and are not defect
evidence.

Model tests also cover complete mixed-record descriptors with a tied sequence,
reversed Map order, frozen input arrays, nonmutation, shared object identities,
working geometry and an empty array. The public snapshot API keeps equivalent
values and the same order.

| Command | Result |
| --- | --- |
| `npm run test:reference-mounted -- src/phase5f-project-projection.mount.test.tsx` before fix | FAIL; 1 file / 2 tests; the two observed duplicate/sharing failures above |
| Same focused mounted command after fix | PASS; 1 file / 2 tests; 1.96 s |
| `npx vitest run src/lib/project-map-model.test.ts src/project-reading-contract.test.ts src/project-map-kernel.test.ts` | PASS; 3 files / 21 tests; 296 ms |
| `git diff --check` | PASS |

Scratch logs and SHA256:

- `/tmp/phase5f-projection-before-corrected.log`: `7d1ec52644af7034c7679cab20cd317a48b2ecf218f6d1e67efb83f52b3fce52`
- `/tmp/phase5f-projection-after-corrected.log`: `08e503f94c9aa050b336ad7d13c8ae4871eee1b830c24100070d9213431c18e4`
- `/tmp/phase5f-projection-pure.log`: `b23e38dae64347d874a032763eb997e6279f15eb594fc05b391ff9c66ba39f62`

Full mounted/build checks, exact combined-tree remote CI and real Map/Reading
browser measurements are not claimed by this focused receipt. The existing
Map save, Reading, drag continuity, responsive projection and representative
250/500-node performance cases remain required regressions.

## Remaining measured lane

Multi-card save still serially awaits one placement PATCH per dirty/pending
placement. The existing `worker/backend-reliability-scale.test.ts` is the focused
real-Worker/isolated-SQLite remeasurement leaf: it records requests, SQL counts,
read bytes, save-to-final-response and ACK-to-Saved time while holding the final
ACK and proving exact revisions. The historical 436/872 ms measurements do not
qualify synchronized code or network/deployed latency. A new bounded batch API
requires independently reviewed revision, partial/atomic failure, lost-ACK,
retry identity and Saved-state contracts; this projection change does not add it.

Processing refresh still reads the primary and every additional visible Sample
through the existing zero-target callback. An eight-sample isolated write therefore
can still read all eight Samples. Narrowing requires an explicit affected-sample
set and separate single/shared-operation measurements: grouped confirmations and
shared comment submissions can affect several Samples. Keep current source/read
generation guards and attachment error propagation. Do not pass a Sample ID into
the existing boolean `load(propagateError)` parameter.

Remaining D1/native fixture cost, provider/archive memory and conditional search/
alignment changes have no new measured evidence in this checkpoint. Preserve
the delivered CI cost correction, native bounded streaming, immutable versioned
archive catalogs, receipts/holds and test isolation until their own measurements
justify another finite change.
