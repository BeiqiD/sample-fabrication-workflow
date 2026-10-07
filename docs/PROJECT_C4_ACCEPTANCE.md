# Project C4 integration acceptance

Status: formal C4 acceptance remains in progress. The bounded local development
goal completed on 2026-10-07 after FP5 qualification, with two demonstrated
responsive repairs and the current isolated-browser evidence below. Shortcut,
editor and panel work through PR #185 retains its recorded deployed desktop
acceptance. Physical-device, OS input and deployed-runtime boundaries remain
explicit. Phase 5D has not started.

Reviewed: 2026-10-07 for the new local checkpoint. The 2026-09-13 and earlier
records below are historical deployed evidence, not newly executed tests.

## Local integration checkpoint — 2026-10-07

The [bounded C4 development goal](./C4_LOCAL_DEVELOPMENT_GOAL.md) resumed after
FP5 qualification on `codex/fp2-fp3-development`, from local baseline commit
`426b969e682780bbb9b6dcec7e57cecee6eb81e9`. This checkpoint is local development
qualification; the historical deployed records below retain their original
versions and scope. Phase 5D has not started.

### Demonstrated repairs

Only `src/project.css` changed in production code. No Project state, command,
identity, lifecycle, persistence, API, migration, provider or authentication
implementation changed.

- When a pending editor/save kept the desktop projection while the viewport
  narrowed from 1440px to 390px, Save occupied x=446–515 and Help x=518–554,
  outside the viewport. The retained desktop header now uses a second action row
  below 860px, wraps action/status groups and anchors Add inside the viewport.
  Existing icon controls retain their accessible names and titles. The unsafe
  projection remains locked until its existing state machine permits switching.
- At 360 × 600 in ordinary mobile Reading, Help's center was covered by Project
  actions in all three Project fixtures and both themes. Mobile action groups
  now wrap below 561px instead of shrinking into overlapping controls. Status
  text can wrap, and the Add menu stays reachable.

The initial 64-case matrix recorded 58 passes and six mobile failures. The final
matrix passed all 64 after the second repair. Independent comparison of all 24
workspace cases at widths of at least 860px found identical header geometry
before and after the repairs. CSS SHA-256:
`cfda4fdb54fb8a1207435a39739d610022d721c4b60001e0e3380cbcc44afc96`.

### Local application and browser evidence

Chromium 151.0.7922.173 drove the actual Vite/Worker/D1 application on loopback.
The scratch application used its own `/tmp/c4-local-Q2tJrl/state` directory,
applied the 22 actual migrations, and held three disposable Projects: ordinary
Markdown/reference/image content, a 200-character title, and an empty workspace.
Project content and geometry restoration used normal Project APIs; the source
reference fixture was populated only in the isolated database. The browser used the existing
`AUTH_MODE=disabled` local development configuration; it does not establish
Cloudflare Access or system administrator authentication/authorization.

| Check | Observed local result |
| --- | --- |
| Workspace/directory, responsive layout and Help | 64/64 passed: Map/Reading, ordinary/long-title/empty Projects, light/dark, 1440/1024/390/360 widths and adjacent 480/481, 560/561, 859/860, 1180/1181 boundaries at short height. Header bounds, native center hit testing, horizontal overflow, Help initial focus/Tab containment/body scrolling/Escape trigger restoration and directory draft cancellation passed. |
| Active Markdown editor | 18/18 passed: Map Inspector and desktop Reading narrowed to 320/360/390/859 in both themes, plus ordinary 390px mobile Reading. Draft text and the required projection lock survived; Save, Cancel, menus, Help and full unsaved status stayed reachable. Cancel retained backend text. No API writes occurred in this matrix. |
| Committed response loss | Passed: a real placement write committed before browser delivery was replaced with 503. Narrow-screen Retry save resent the exact original input/operation identity; native replay returned the same revision. Saved geometry survived reload. |
| Response during active gesture | Passed: the real reference-write acknowledgement arrived while another card was in a native mouse drag. The gesture and transform remained unchanged; mouse-up produced one new note placement write, persisted through reload. |
| Real revision conflict | Passed: an independent local API client changed the placement revision before the UI write. Native 409 retained the local move until explicit narrow-screen authoritative reload; the server position then appeared. Both clients used the same local development identity. |
| Canvas focus | Help Escape returned focus to Help; a native blank-Canvas click focused the Canvas. Control+A selected all four cards and Escape cleared selection. |

These are measured headless browser viewport and mouse checks, not physical
touch/native mobile/OS keyboard acceptance. Reference and legacy R2 image cards
were representative content, not a full attachment lifecycle qualification.
Existing transient ReactFlow size warnings were visible during initial Map/view
transitions; the successful matrices had no page exceptions. No large-project
real-browser frame-rate improvement is claimed.

### Verification and evidence preservation

All five affected checks passed at the same start/end source fingerprint
`e7eaddd9e9677d0c2a7a1bbe688a4cec5e3215705dfa53ea35695b3784af36a4`:

| Command | Result |
| --- | --- |
| `npm exec -- vitest run src/project-owned-content-contract.test.ts src/project-map-kernel.test.ts src/lib/project-map-performance.test.ts --maxWorkers=2` | 3 files / 24 tests passed. |
| `npm run test:reference-mounted -- --maxWorkers=2` | All 81 files / 698 tests passed. |
| `npm run build` | TypeScript and production build passed. |
| `npm run test:project-map-bundle` | Lazy ReactFlow ownership passed: 6 initial and 18 Map chunks. |
| `npm run verify:project-worker-artifact` | Production assets/API/SPA and actual Worker/D1 Project smoke passed, including expected missing-JWT Access rejection, 201 distinct references, media, replay, conflict and lifecycle. This is not successful live Access authentication. |

The complete FP5 twelve-leaf gate remains preserved at its qualified baseline;
it was not rerun or relabelled as a fresh complete C4 gate. The C4 scope required
the affected source contracts, complete mounted suite, build and Project gates.
Independent review found no blocking issue in the scoped CSS changes or coverage.

The actual development database exactly matches the pre-C4 snapshot: complete
schema, all 119 application tables / 33 rows, typed cells and physical rowids,
all 22 migration receipts and unchanged raw migration SQL. SQLite quick check
passed; foreign-key violations were zero. File mode remains legacy and execution
guards disabled. Browser fixtures used separate state; the local server was
stopped after qualification. Fixture geometry was restored through ordinary API
CAS, retaining real operation receipts and advanced revisions.

Machine-readable reports, screenshots, harnesses, all five check logs, original
failures, baseline manifest and data proof are preserved in
`/tmp/c4-final-qualification-checkpoint/`. The pre-C4 full archive, FP5 evidence
and database snapshot remain in `/tmp/c4-development-baseline/`.

The first final-CSS fault rerun recorded one pass, then `route.fetch` raised
`socket hang up` inside an uncaught async route callback. Node exited before the
second result and cleanup; that incomplete run is not counted as passed. The
upstream socket-drop cause is unproven. A separate harness now catches and drains
callbacks, records request identity before forwarding, uses `Connection: close`
and `maxRetries: 0`, and asserts identical replay body bytes. Existing assertions,
10-second UI waits and 15-second bounded waits remain; the native fetch bound is
15 seconds, stricter than the original default. The abandoned fixture was first
restored through normal API CAS. The subsequent final run passed all three cases
and both geometry restorations, with zero unconfirmed attempts. No application
save logic or mutation behavior changed to accommodate the harness.

### Current remaining acceptance boundaries

The local goal closes the named checks above. Formal C4 acceptance remains in
progress for the following boundaries:

- Physical macOS Command and Windows/macOS IME, physical touch and multi-finger
  interruption, soft keyboard/visual viewport, safe areas and native mobile
  browser engines.
- Final deployed version and authenticated Cloudflare Access/application and
  independent administrator authorization; real provider/runtime, deployment,
  recovery and release acceptance remain separate.
- Fresh real-backend large-Project performance and the full native normal/reduced
  zoom connection-port, resize-grip and source-link matrix. Mounted large
  fixtures and historical desktop results retain their recorded coverage.
- The complete cross-mode command-under-Help sweep beyond the specific focus,
  selection and editor checks recorded here.

Phase 5D attachment/media presentation remains the next implementation slice;
its plan must preserve the stable File/lifecycle/preview-trust semantics and
carry these formal acceptance gaps forward. Phase 5E, Phase 5F and Phase 6B
follow their existing roadmap order.

<a id="current-integration-check--2026-09-13"></a>

## Historical deployed integration check — 2026-09-13

- Integration branch: `v2/backend-foundation`, at [PR #185](https://github.com/BeiqiD/sample-fabrication-workflow/pull/185)
  merge [`c4bf698e3753a0474e7d75d400af6685ff874a6a`](https://github.com/BeiqiD/sample-fabrication-workflow/commit/c4bf698e3753a0474e7d75d400af6685ff874a6a),
  tree `5c5f2c7a932db8e380305205684bd4ddcbf832e4`, matching the locally tested tree.
- Both postmerge Verify jobs and all 14 status contexts passed. The full suites
  contain 992 source tests and 467 mounted tests.
- [Automatic Workers Build](https://github.com/BeiqiD/sample-fabrication-workflow/runs/103645367972)
  `8a88f5c2-ff0a-4c8e-acae-68fb4c90615b` succeeded at
  `2026-09-13 00:26:01 UTC`, version `29cb6d4e-4c20-4c8d-9efa-385dd4495e1e`.
  An ordinary browser reload served `index-BPgDwsci.js`, matching the exact
  completed merge build. Earlier asset names below identify historical checks.
- Acceptance used the existing synthetic QA Project and Sample listed below,
  on `https://sample-workflow-v3.clannadas.workers.dev` at `1363 × 936`.
  No manual deployment or remote migration was performed.

### Accepted desktop follow-ups

These results were recorded on each merged PR's deployed build. They establish
the named behavior within that session, rather than a rerun of every prior
workflow on the PR #185 build.

| Change | Deployed result and evidence |
| --- | --- |
| Existing shortcuts and ownership — #175–#178 | Help, Control+S/Escape draft preservation, Control+A/Delete background isolation and native panel/Reading copying passed the historical desktop checks below. These shortcuts are implemented; they are not a new development step. See [shortcut acceptance](./PROJECT_SHORTCUT_INSPECTOR_ACCEPTANCE.md). |
| Active-editor resize and height — [#180](https://github.com/BeiqiD/sample-fabrication-workflow/pull/180) | Native inline drag enlarged the note from `904 × 711` to `1200 × 1000`; Write grew from `580px` to `869px` and Preview also measured `869px`, without a max-height cap, with a `6px` CSS action gap. Inspector editing also resized. Cancel preserved size and discarded text; Undo restored geometry. A new `180 × 110` draft retained reachable actions through form scrolling. Final reload restored the original four cards and Saved. |
| Composition synchronization — [#181](https://github.com/BeiqiD/sample-fabrication-workflow/pull/181) | Simulated composition regressions passed. Directly inserted Chinese text survived Preview, expanded Write and collapse in the deployed browser; Cancel discarded it. This is not physical Windows/macOS IME acceptance. See [Markdown input acceptance](./PROJECT_MARKDOWN_INPUT_ACCEPTANCE.md). |
| Dialog and Inspector hierarchy — [#182](https://github.com/BeiqiD/sample-fabrication-workflow/pull/182) | Light/night dialog layout, aligned `38px` actions, Stay/Escape draft preservation, measured text hierarchy and disclosure retention passed. Browser findings concerning Space and Reading menus were then fixed by #183; the original unequal panel widths were later replaced by #185. |
| Panel Space and Reading menus — [#183](https://github.com/BeiqiD/sample-fabrication-workflow/pull/183) | Native Space opened Inspector Details and References More. Reading Add → Reference passed pointer hit testing and opened References while replacing Inspector. See [panel hierarchy acceptance](./PROJECT_INSPECTOR_POLISH_ACCEPTANCE.md). |
| Shared panel state and Markdown activation — [#184](https://github.com/BeiqiD/sample-fabrication-workflow/pull/184) | Both panels passed open-with-no-selection, Pin/Unpin, selection changes/clearing and explicit Close/reopen checks. Markdown double-click opened one existing-card editor and Inspector while keeping the textarea focused; Details remained read-only. Reading panel replacement and blank-Canvas new-note cancellation passed. No temporary content or geometry was saved. See [panel behavior acceptance](./PROJECT_PANEL_BEHAVIOR_ACCEPTANCE.md). |

### PR #185 desktop layout and source-note acceptance

| Check | Direct observation on the current integration build |
| --- | --- |
| Map panels | References and Inspector both measured `340px`, with `14px` padding and `12px` radius. Neither overflowed horizontally. Light and night screenshots were inspected. |
| Reading panels | References and Inspector each measured `380px`, with the same padding and radius. |
| Open source | Clicking the selected reference card's Open source link focused the correct synthetic Sample note. Referenced sat beside Sample note, did not intersect the timestamp, and the former floating pseudo-element was absent. Note content had no horizontal overflow in either theme. |
| Delete note | The button had `14px` clearance from the right edge and passed visible hit testing. Clicking opened the correct note summary; Cancel preserved the note and returned focus to Delete note. |
| Final state | Light Map mode, Saved, no draft or confirmation dialog. The existing synthetic note remained present; no Project content or remote Sample data was changed. |

The two new mounted SamplePage cases cover older-note expansion, source-focus
switching/cleanup, timestamp preservation and cancelling the intended deletion.
The first remote run exposed a lazy RichText test race; resolving the connected
article inside `waitFor` retained all behavior assertions and made the complete
467-test mounted suite pass. Narrow/mobile screenshots were not taken.

## Historical integration check — 2026-09-12

This is the PR #175–#179 record. Its entry assets, measurements and the
then-pending editor work identify that earlier build, not the current deployment.

- Deployed code baseline: `v2/backend-foundation` merge commit
  [`791f00073ee69f4ce2c59a377705fe3faee61423`](https://github.com/BeiqiD/sample-fabrication-workflow/commit/791f00073ee69f4ce2c59a377705fe3faee61423),
  tree `a4279e14d400f6178d4e5e8b93d9d239858de3bc`.
- Both jobs checked out that commit and passed:
  [Verify](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/34710705610/job/103598858710)
  and [Project Map performance](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/34710705597/job/103598858669).
  Both production builds emitted `index-CAh5QSPs.js`,
  `ProjectPage-CEKAkFht.js`, and `ProjectMapSurface-BxPAFhhU.js`.
- The integration commit's
  [Workers Builds: sample-workflow-v3 check](https://github.com/BeiqiD/sample-fabrication-workflow/runs/103601517189)
  completed successfully. An ordinary browser reload then served
  `index-CAh5QSPs.js`, matching the CI entry asset, and exposed one Keyboard
  shortcuts button. An earlier inspection had served `index-BkL0387N.js` and
  shown the old `310 × 42px` Edit Markdown button. That mismatch is resolved;
  the earlier observation did not establish its cause or the older deployed commit.
- [PR #179](https://github.com/BeiqiD/sample-fabrication-workflow/pull/179) merged
  the preceding acceptance record as `93d540ac302764a9d0c675911d79069bb9a121e3`,
  tree `fff2d196ee1c230be6fd8b9a638b990f1c6c107c`. This documentation-only merge
  preserves the tested code baseline.
- The following checks used the authenticated synthetic QA Project at
  `1363 × 936` on `https://sample-workflow-v3.clannadas.workers.dev`, serving
  `index-CAh5QSPs.js`. They do not exercise the new editor-resizing work below.
- No manual deployment, migration, or remote configuration change was performed.

### Desktop browser results

| Check | Direct observation |
| --- | --- |
| Markdown and reference entry | Markdown single-click selected it; double-click opened Inspector. Reference double-click also opened Inspector. Clicking a reference from an unchanged Markdown editor exited editing and left Saved. |
| Compact Inspector actions | Markdown's permanent `Edit` measured `64 × 34px` inside the `340px` Inspector. Edge direction read Source → target; Enter opened and closed More actions, exposing Delete edge when open. |
| Edge editing | Single-click selected the edge without opening Inspector; double-click opened Inspector. An unchanged edge editor yielded to a card click. With a temporary label, the same click retained the draft and prompted Save or Cancel; Cancel preserved the original label. |
| Native text and panel ownership | A selected word in the reference Inspector copied with Control+C and matched the actual clipboard. Delete with an Inspector button focused did not remove a card. In Reading, selecting and copying `Synthetic` matched the clipboard; Delete left all four articles intact. The first Details activation opened Inspector. |
| Help and keyboard ownership | Help displayed Workspace and Map canvas instructions. With a temporary Markdown draft, Control+S left help open and the marker unsaved; Escape closed only help, returned focus to its trigger, and retained the draft. Plain Cancel discarded it. Control+A and Delete under help preserved the background single-card selection and all four cards. |
| Overlapping editor controls | The comment reference at layer `3` was moved over both inline Save and Cancel centers. While editing, the note used display layer `5`; both centers lay within the reference bounds but `elementFromPoint` hit their own controls. Actual Cancel and Save clicks (without a text change) exited editing and returned the note to layer `1`. Undo restored the reference's exact original DOM style. |
| Display-mode resizing | An interior point at 70% of the visible corner triangle hit the resize control. Pointer resizing changed the reference from `445 × 239` to `505 × 284`; Undo restored its exact original geometry. |
| Reference controls | All four connection-port centers hit their own handles and their parent allowed visible overflow. On hover, Open source was horizontally centered at the card bottom, separate from the resize corner. This checks presentation and hit targets, not creating a new connection. |

During the first overlap-positioning attempt, the UI reported Placement revision
conflict and stopped saving. Reloading the authoritative Project recovered the
workspace, and a fresh drag saved successfully. The observation and read-only
code review did not establish the cause; it is not attributed to another writer
or recorded as a confirmed unresolved defect. This was not controlled conflict
injection and does not qualify all reconciliation paths.

The QA Project was returned to four cards and Saved with the tested geometry
changes undone. No temporary text or edge label was persisted. A final reload
confirmed four cards, Saved, no temporary marker, and the comment reference's
restored `445 × 239` size and original position/layer.

### Historical editor requirement — predeployment implementation record

The following implementation and local-validation record preceded PR #180's
deployment. Its pending browser checks were completed by the PR #180 results
above; it is retained to distinguish the original reproduction from acceptance.

The user requested that the current card retain its bottom-right resize control
while editing. For large Markdown cards, the textarea and Preview should expand
with the card instead of remaining capped at `360px` and leaving a large unused
gap. The implementation now permits resizing only the active Markdown card in
Canvas or Inspector editing. Existing cards save size through normal placement
history: Cancel discards the content draft, while Undo after editing restores the
size. New notes keep their size locally until creation. Save, Cancel, and Expand
wait for an active resize to finish; interrupted gestures release that lock.

The compact textarea and Preview no longer have the `360px` height cap. They fill
the available card height, with actions below and form scrolling for very small
cards. At this stage, deployed measurements were still pending; PR #180 later
completed desktop acceptance of the resizing and editor-space changes.

Regression coverage exercises actual ReactFlow resize controls in Canvas and
Inspector editing, draft preservation, placement saves and Undo/Redo, new-note
creation/cancellation, a placement response arriving during a later gesture,
uncertain outcomes, and cancelled/unmounted gestures. The full regression run
also exposed an edge-toolbar test that compared positions before and after
initial fit; that test now waits for fit before recording its baseline and keeps
its original selection and position assertions.

Independent review also caught a fractional-size boundary: browser node
measurements round saved dimensions, so resize commands must retain descriptor
geometry as their original state. Three regressions reproduced the failure with
integer DOM measurements for an existing editor, an ordinary card, and a new
draft descriptor; the resize result still uses the native gesture dimensions.

Local source tests passed in 183 files / 992 tests; mounted interaction tests
passed in 57 files / 430 tests. Bundled development and production formulas also
passed. Independent review confirmed the fractional-size correction and found
no remaining blocker in the reviewed resize and editor-layout changes.
The complete `npm run verify:ci` gate passed, including TypeScript/export
contracts, local migrations, Reference and search Worker smoke checks,
production build, lazy Map bundle ownership, and production Project Worker plus
assets. The local build emitted `index-BwVQjoze.js`, `ProjectPage-49wfw6sZ.js`,
and `ProjectMapSurface-CVR8I2pQ.js`; these names were the local comparison
baseline at that stage, not deployment evidence. PR #180 subsequently deployed
`index-BuJsDT8b.js`, matching its completed merge build.

The deployed reproduction used a `1200 × 1000` Markdown card. Its textarea had
computed height and max-height of `360px`, leaving about `197.2` screen pixels
before Save at the fitted Canvas zoom; editing exposed no Resize card button.

## Remaining acceptance

The desktop results cover the actions named above, including the completed
PR #180–#185 follow-ups. macOS Command shortcuts,
other Canvas commands under help, and returning keyboard ownership to the Canvas
still need their applicable browser checks. Reuse the existing CI and historical
evidence within its recorded scope.

Check ordinary and long-title content at `1440 × 900`, `1024 × 600`,
`390 × 600`, and `360 × 600`, including light/night themes, header alignment,
independently scrolling help content, and focus restoration. Use adjacent widths
`480/481`, `560/561`, `859/860`, and `1180/1181` for the changed Help layout,
mobile header, panel modality, and desktop panel/control sizing respectively.
Recheck the connection ports, editor resize grip, and bottom-centered source
action at normal and reduced Canvas zoom. Reuse the existing named QA fixtures.
Native Control+plus/equals did not change the browser viewport in this session;
no narrow-screen result is claimed from that attempt.

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
required a browser session loading the fixed build. The later PR #175–#178
desktop check above completed the overlapping Save/Cancel pointer validation.

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

1. The then-pending fixed-editor overlap pointer check was completed by the
   later PR #175–#178 desktop result above. It no longer blocks that regression's
   acceptance; the broader C4 limits below still apply.
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

When frontend refinement resumes, Phase 5D attachment/media work follows the
remaining C4 acceptance. Neither phase is declared complete by the backend-first
schedule change; the final Phase 5F frontend baseline remains required before
release hardening.
