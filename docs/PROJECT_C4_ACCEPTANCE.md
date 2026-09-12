# Project C4 integration acceptance

Status: in progress; the integrated desktop workflow was exercised against the
real backend. This change fixes an editor overlap defect and a test-observer
defect found during acceptance. It does not complete device or release acceptance.

Reviewed: 2026-09-12.

## Baseline and environment

- Integration branch: `v2/backend-foundation`, starting at PR #170 merge commit
  `2f515ef6e348fb5067d187632cd85e2da377980d`.
- The merge tree is `c70b201a3b28ee330ea2da707f182c1f05c0380d`, identical to the
  reviewed PR #170 head tree.
- Authenticated Cloud Browser, desktop viewport `1363 × 936`, against
  `https://sample-workflow-v3.clannadas.workers.dev` with its real backend.
- After reload, the page served `/assets/index-CIVTDk1A.js`, matching the PR #170
  production build. The newly fixed editor layer is not in that deployed asset.
- No manual deployment, remote configuration change or database migration was
  performed. The served asset check is not an inspection of Cloudflare build logs.

## Live fixtures

All writes used explicitly named synthetic QA fixtures, not experimental data.

| Fixture | Identity and final state |
| --- | --- |
| Existing interaction Project | `project-68458fe0-a41d-4f95-b51f-2100969d51b7`, titled `QA · Canvas interaction · 2026-09-12`; four active cards after the create/trash/restore exercise |
| Existing sample source | `d32b75f6-31db-4253-b065-e169df8c76a4`, code `QA-CANVAS-20260912`; its sample and comment references remain available |
| Existing Markdown | `item-6cc189b3-456f-4dbe-a29e-beeab9bde522`; retained original content and appended a C4 verification sentence |
| New disposable Markdown | `item-31ec1cfb-a8c7-4c33-8082-e5e73b2e39fa`, titled `QA · C4 restore control`; restored and confirmed after reload |
| Existing relationship | `edge-0677d9fa-4293-419a-ac81-a4ea424be84a`, note → sample, label `hypothesis → sample`; retained through navigation and reload |
| New empty Project | `project-9a953633-af11-466f-bfe3-44fc7235256a`, titled `QA · C4 empty workspace · 2026-09-12`; retained empty for later acceptance |

No permanent deletion or empty-trash operation was used. The existing `Doping`
Project was not modified.

## Real-backend browser results

| Workflow | Observed result |
| --- | --- |
| Whole-card movement | Dragging directly from a displayed formula moved both the owned Markdown card and the comment reference; automatic save completed |
| Geometry durability | After navigation and reload, Markdown remained at approximately `(326.486, 317.420)`, comment reference at `(127.153, 493.852)`, and their original layers remained `1` and `3` |
| Markdown and reference math | Existing Markdown displayed three MathML formulas; comment reference displayed two; titles omitted raw formula markup |
| Edit and cancel | Double-clicking the Markdown heading opened the editor. A discarded test sentence did not survive cancellation via the expanded editor; the inline cancellation obstruction is the defect below |
| Keyboard after cancellation | ArrowRight moved the Markdown card by five map units and saved successfully after leaving the editor |
| Reference inspection | Double-clicking the reference heading opened Inspector; mathematical preview had `max-height: 240px`, `overflow: auto` and `tabIndex=0` |
| Reading keyboard ownership | Delete while the Inspector preview was focused left all three existing cards intact |
| Reading edit and save | Editing the original note from Reading saved the C4 verification sentence; it survived navigation and reload |
| Relationship navigation | Activating `hypothesis → sample` from Reading details closed Inspector and moved both current-item state and DOM focus to the sample reference; reopening details worked |
| Native links | The Markdown `Open Samples` link navigated to `/samples`; browser Back returned to the Project with its content and relationship intact |
| New content | Add → Note / Markdown created the disposable note with an inline `$r=1$` formula |
| Leave protection | Navigating to Projects with a dirty draft opened `Unsaved Project changes`; Stay on Project preserved the draft, and subsequent explicit Save created it |
| Trash and recovery | Move to trash removed only the disposable note; Undo removal restored it. Saved status and the restored content were confirmed again after reload |
| Theme and layout | Light and night Map/Reading views were inspected. Night Reading displayed all six fixture formulas in the DOM, with no document-level horizontal overflow at the tested desktop size; the preference was returned to light |
| Directory and empty state | Projects directory opened correctly; creating the named empty Project navigated to its Map. Reading showed `This Project is empty` and its Add menu exposed Note / Markdown, Attachment and Reference |

The final application-origin error-log query returned no entries. This is scoped
to the exercised browser session, not a server-log or telemetry audit.

## Defect: overlapping card blocks editor controls

On the deployed baseline, the reference at layer `3` overlapped a Markdown card
at layer `1`. Opening the Markdown editor kept its wrapper at layer `1`, placing
part of Cancel and Save beneath the reference. A screenshot and DOM hit test
confirmed that `elementFromPoint` at the Cancel button's center returned the
reference article. Clicking there left the draft dirty. Expanding the editor
into its dialog made Cancel reachable and allowed recovery.

`ProjectMapSurface` now lifts only the active editor's node `style.zIndex` above
all projected cards, including pending cards. It keeps the descriptor and saved
geometry unchanged. Cancel or completed save rebuilds the original display
order; editing does not create a placement write or an Undo entry.

Four new mounted cases use the actual ReactFlow node wrappers and ProjectPage:

- Cancel and save, including an outstanding save response and expanded/collapsed
  editing, retain the temporary layer only for the editor lifetime.
- The next real movement still PATCHes the original saved layer.
- Existing and new editors remain above pending references and attachments even
  at the maximum legal stored layer, without mutating their input geometry.

All four failed before the fix and passed after it. These tests verify rendered
stacking and persistence behavior; actual pointer hit testing of this new code
still requires a browser session loading the fixed build.

## Defect: post-merge Verify times out in observer simulation

The merge commit's [Verify run](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/34688740747)
failed only in its final full mounted phase: the 250-node/400-edge case exceeded
its existing 20-second timeout. The earlier reference phase in the same job
passed, and the separate
[Project Map performance run](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/34688740749)
passed on the same commit.

The test ResizeObserver previously scheduled one independent callback per node
and did not implement `unobserve` or `disconnect`. The correction batches pending
observations per observer and removes/cancels notifications when observation
ends. It also waits for completed initial overview fitting before zooming and
asserts actual rendered node/edge counts and viewport culling.

The fixtures, 20-second timeouts, 24 zoom clicks, scale thresholds and product
code are unchanged by this test correction. A local diagnostic comparison of
the same 250-node/400-edge interactions reduced observer callbacks from 759 to
5 while delivering 759 versus 752 entries; the seven removed entries belonged
to targets no longer observed. This is evidence of corrected test simulation,
not a claim of improved real-browser frame rate.

## Local validation and review

- `npm test`: 179 source test files / **937 tests**, then the default mounted
  configuration with 51 files / **304 tests**, all passed; bundled development
  and production formula checks passed. No worker-count override was used.
- `npm run build`: TypeScript and production build passed.
- `node scripts/verify-project-map-bundle.mjs`: passed; ReactFlow remains owned by
  the lazy desktop Map bundle.
- `git diff --check`: passed.
- Independent cross-review of the editor fix and the observer correction found
  no blocking issue. Remote checks on the submitted commit remain authoritative;
  their results belong to the PR checks rather than this pre-submission record.

## Remaining acceptance boundaries

1. Load the fixed editor build in a browser and repeat Cancel and Save pointer
   hit tests with an overlapping higher-layer reference. Keep C4 in progress
   until this regression has been verified after deployment.
2. This run covered one desktop viewport. Phone, short-screen and physical touch
   acceptance still requires direct visual/device checks; mounted responsive
   coverage does not establish those results.
3. Large projects are covered by mounted 250-node/400-edge and 500-node/800-edge
   fixtures, not a newly populated real-backend large-project browser exercise.
4. The live consecutive drags completed saves before the next gesture; the run
   did not force a response to arrive mid-gesture. Delayed-response behavior is
   covered by the existing mounted tests, not newly proven by this live run.
5. This was Project integration acceptance, not an export/import, attachment
   lifecycle or release/deployment recovery rehearsal. Historical acceptance
   limits in the earlier records remain applicable.

Phase 5D attachment/media refinement follows C4 acceptance. It is not started
or declared complete by this change.
