# Development goal: Phase 5D attachment and media surfaces

Status: bounded local development complete on 2026-10-08 (Europe/Zurich).
Owner direction received on 2026-10-08.
Working branch: `codex/fp2-fp3-development`.
Qualified C4/FP2–FP5 baseline: `129bde6542d2dc58d87db37dbf6aebb1bc40873d`.

## Scope and authority

Complete the existing [Phase 5D slice](./FRONTEND_REFINEMENT_IMPLEMENTATION_PLAN.md#phase-5d--attachment-and-media-surfaces)
after the bounded local C4 goal. Improve attachment metadata, generic-file and
image presentation, existing upload states, child/owner action wording and
keyboard/focus/mobile media transitions across Project, Comment and Run.
Shared presentation follows Comfortable, Compact and Dense roles; domain adapters
continue to own authorized URLs, identity, mutation and retention.

Continue implementation, self-checking and independent review with minimal owner
intervention. Local commits, isolated fixtures, local migrations and browser
tooling are authorized. Production deployment, remote migration, real provider
activation, production data movement, repository push and external messaging
remain outside scope. Phase 5E, Phase 5F and Phase 6B remain subsequent work.

## Protected contracts

- Preserve File authority, native/legacy routing, upload acceptance identities,
  retries, cancellation fencing, revisions, source hierarchy and Project gestures.
- A Comment child action preserves its Comment body/other items; a Run child
  action preserves its Run/step/status/history. A Project attachment uses its
  existing Project-item lifecycle. Shared cards do not own deletion or storage.
- Project item/Project and canonical Comment Trash retention is 30 days.
  Explicit ready Comment/Run child removal contributes a guaranteed 24-hour
  edge; later recovery is best-effort until GC claims bytes. Do not promise an
  in-app restore control where none exists or apply canonical policy to a
  different legacy deletion endpoint.
- Client-generated Comment/TIFF previews remain untrusted occurrence assets;
  a displayed preview is not the original or a verified derivative. Unsupported
  and failed previews retain truthful generic-file/access information.
- No new upload protocol, server derivative/PDF renderer, scientific source
  parser, schema migration or provider change. Existing ready child endpoints
  may receive an explicit UI adapter while durable pending-upload APIs stay intact.
- Preserve specialized lightbox zoom/pan/navigation, Process-grid density,
  Project Map bundle ownership and existing rich-text lazy boundaries.

## Completion checklist

- [x] Preserve qualified code and a consistent actual development DB baseline.
- [x] Audit Project, Comment/Run and shared contracts for demonstrated gaps.
- [x] Implement shared file metadata/status presentation with safe explicit URLs.
- [x] Complete Project unsupported/failed/unavailable previews and metadata.
- [x] Complete Comment/Run media states, child actions and accurate lifecycle copy.
- [x] Verify upload progress/retry/cancel announcements and keyboard isolation.
- [x] Verify modal focus, dismissal, image navigation and failure/retry transitions.
- [x] Record representative before/after local browser, viewport and theme evidence.
- [x] Pass full local Verify and affected permanent Project/bundle/Worker gates.
- [x] Complete independent review and exact actual development-data preservation.
- [x] Update acceptance, roadmap and implementation plan; create a local checkpoint.

## Baseline and exit

`/tmp/phase5d-development-baseline/` contains the baseline source archive, file
hash manifest and a read-only consistent backup of the actual development DB.
The actual DB remains at `0022`, legacy File mode with execution disabled;
test/browser fixtures must use separate persistent state. The qualified FP5 and
C4 evidence remains preserved at its recorded baselines.

Exit: the named attachment actions, metadata and states are understandable across
domains without changing ownership, lifecycle or preview trust, with meaningful
automated and isolated real-browser evidence. Formal physical OS input/touch,
soft keyboards/native mobile browsers, successful Access/admin identities,
real-provider/deployed runtime, release and recovery acceptance remain deferred.
These local checks do not erase the [formal C4 gaps](./PROJECT_C4_ACCEPTANCE.md#current-remaining-acceptance-boundaries).

## Completed local exit — 2026-10-08

Shared presentation and Project/Comment/Run adapters are complete. Final
Chromium qualification passed 56 primary, 84 adjacent-breakpoint, 11 lifecycle/
gallery and four Inspector save/cancel cases, with two original child restores
and four normal metadata CAS restorations. All twelve canonical local
Verify leaves passed at source fingerprint
`e458c152920508102afbc651bd79042663e8bdd34d00c6140b4f73ebdfe669c1`;
complete source/mounted suites, build and Map bundle include the permanent
Project performance checks. Independent review found no remaining blocker.

The browser evidence retains its actual source fingerprint
`926bc42dae091094c4d0619f69b893d15ef2f44b82269a263b01d174f18318eb`.
The only later eligible change is one documented finite 15-second budget for an
existing native staging/finalization/retry/GC test; all production paths and
assertions remain unchanged. The first full attempt's Inspector failure and the
second attempt's observed source failure/SIGINT exit 130 remain failed/incomplete.
An unchanged standalone run reproduced the default 5,000ms timeout (17 passed,
one failed); after the scoped budget change, all 18 affected cases passed.
Neither failed attempt is counted as completed qualification.

The actual development DB remains exactly unchanged: 119 application tables,
33 rows, 22 migration receipts, typed cells/rowids and raw migration SQL.
Original failures, final logs/screenshots, review, source manifest and data proof
are preserved in `/tmp/phase5d-final-qualification-checkpoint/`, with the local
commit receipt recorded there. Isolated browser servers were stopped. No
production deployment, remote mutation, provider activation or push occurred.

See [Phase 5D acceptance](./PHASE_5D_ACCEPTANCE.md) for exact commands, results,
fixture limits and remaining formal acceptance. Next is Phase 5E source-record
and directory coherence, then Phase 5F and Phase 6B under the existing roadmap.
Those implementation slices have not started at this exit.
