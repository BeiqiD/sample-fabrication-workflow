# Project C4 integration acceptance

Status: in progress. PRs #175–#178 are merged, the final integration commit's
CI passed, and the deployed page now exposes the new shortcut and Inspector UI.
Browser/device acceptance remains incomplete; Phase 5D has not started.

Reviewed: 2026-09-12.

## Current integration check — 2026-09-12

- Branch: `v2/backend-foundation`; final merge commit
  [`791f00073ee69f4ce2c59a377705fe3faee61423`](https://github.com/BeiqiD/sample-fabrication-workflow/commit/791f00073ee69f4ce2c59a377705fe3faee61423),
  tree `a4279e14d400f6178d4e5e8b93d9d239858de3bc`.
- Both jobs checked out that commit and passed:
  [Verify](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/34710705610/job/103598858710)
  and [Project Map performance](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/34710705597/job/103598858669).
  Both production builds emitted `index-CAh5QSPs.js`,
  `ProjectPage-CEKAkFht.js`, and `ProjectMapSurface-BxPAFhhU.js`.
- Earlier observation: an authenticated browser reloaded the synthetic QA Project at
  `1363 × 936` on `https://sample-workflow-v3.clannadas.workers.dev`.
  It still served `index-BkL0387N.js`; the Keyboard shortcuts button count was
  zero. Double-clicking `QA · Diffusion hypothesis` opened the read-only
  Inspector, where the old `Edit Markdown` button measured `310 × 42px` inside
  a `340px` Inspector. The merged UI instead places pencil-and-Edit in the type
  row. That earlier session could not establish acceptance of those merged UI changes.
- That earlier check used inspection and reload only. It changed no application data and
  performed no deployment, configuration change, or migration. The observations
  do not identify the exact older deployed commit or explain the deployment gap.
  Inspector was closed afterward; Saved remained visible and Undo, Redo, and
  Save remained disabled throughout. No editor was entered.
- Follow-up: the integration commit's
  [Workers Builds: sample-workflow-v3 check](https://github.com/BeiqiD/sample-fabrication-workflow/runs/103601517189)
  completed successfully. An ordinary browser reload then served
  `index-CAh5QSPs.js`, matching the CI entry asset, and exposed one Keyboard
  shortcuts button. The previously observed served-build mismatch is resolved.
- At the same `1363 × 936` desktop viewport, opening Keyboard shortcuts displayed
  Workspace and Map canvas instructions. Escape closed help and returned focus
  to its trigger. Double-clicking the Markdown card opened Inspector; the visible
  action text was `Edit`, measuring `64 × 34px` inside the unchanged `340px`
  Inspector. These are direct observations of the new deployed controls.
- A temporary QA marker was appended in the Inspector's native Markdown
  textarea, producing Unsaved Markdown. With help open, Control+S left help
  open, retained the temporary marker in the draft and Unsaved Markdown state,
  and did not put the marker on the card. Escape closed only help, returned focus to Keyboard
  shortcuts, and preserved the draft. Plain-text Cancel then restored Saved and
  removed the marker. After closing Inspector and reloading, the matching entry,
  four cards, Saved state, and absence of the marker were confirmed. No content
  change was persisted. This exercised desktop Control+S, not macOS Command+S.
- No manual deployment, migration, or remote configuration change was performed.

### Resume acceptance

The entry-asset match and new controls allow integrated browser acceptance to
continue. Reuse the existing CI and historical workflow evidence within its
recorded scope; the remaining browser checks are:

| Priority | Integrated browser check | Required observation |
| --- | --- | --- |
| P0 | Overlapping Markdown editor and higher-layer reference | Cancel and Save centers hit their own controls and real clicks work; leaving the editor restores the original display layer without a placement write. |
| P0 | Markdown, reference, and edge interaction | Single-click selection, double-click Inspector, and explicit Edit remain consistent; an unchanged editor yields to the next Canvas operation, while a dirty draft remains protected. |
| P0 | Keyboard help over an active draft | Desktop Control+S isolation, Escape focus/draft retention, and subsequent Cancel passed above. macOS Command+S and other Canvas commands under help remain unverified in the browser. |
| P0 | Keyboard ownership in Inspector and Reading | Native text selection/copy remain available; Delete and other Canvas commands do not mutate the background. Canvas commands resume when focus returns to the Canvas. |
| P0 | Compact Inspector actions | The permanent Edit action is discoverable beside the type, content remains visually primary, direction is readable, and edge deletion is reachable through the initially closed More actions. |

Check ordinary and long-title content at `1440 × 900`, `1024 × 600`,
`390 × 600`, and `360 × 600`, including light/night themes, header alignment,
independently scrolling help content, and focus restoration. Use adjacent widths
`480/481`, `560/561`, `859/860`, and `1180/1181` for the changed Help layout,
mobile header, panel modality, and desktop panel/control sizing respectively.
Recheck the connection ports, resize grip, and bottom-centered source action at
normal and reduced Canvas zoom. Reuse the existing named QA fixtures.

Responsive browser or controlled CSS-viewport evidence must remain separate from
physical touch, multi-finger cancellation, soft-keyboard/visual-viewport,
safe-area, and native mobile browser acceptance. A successful ordinary save does
not exercise response loss, uncertain/reconciling outcomes, or a save response
arriving during another gesture; those require controlled fault/timing injection.
Existing mounted large-Project fixtures also do not establish a new real-backend
large-Project browser or frame-rate result. Export/import, attachment lifecycle,
and deployment/recovery qualification retain their separate acceptance scope.

## Historical baseline and environment — PR #170, 2026-09-12

The following workflow, defect, and local-validation record predates the current
integration check. It does not establish acceptance of PRs #175–#178.

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

## Historical remaining acceptance boundaries

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
