# Development goal: Phase 5E source-record and directory coherence

Status: bounded local development complete on 2026-10-08 (Europe/Zurich).
Owner direction: continue the existing roadmap with minimal intervention.
Working branch: `codex/fp2-fp3-development`.
Qualified Phase 5D baseline: `f59031b18a911dc440fc96ed4292fe6508cb5629`.

## Scope and authority

Complete the existing [Phase 5E slice](./FRONTEND_REFINEMENT_IMPLEMENTATION_PLAN.md#phase-5e--source-record-and-directory-coherence)
across Samples, Templates, Processing, Comments, Timeline and Settings/Export.
Audit directory/record hierarchy, meaningful loading/empty/error/retry states,
operational warnings, keyboard accessibility and responsive behavior using
representative content. Repair demonstrated problems while retaining the
intentional Comfortable, Compact and Dense roles.

Continue implementation, self-checking and independent review until this bounded
local goal is complete. Local commits, isolated fixtures, local test migrations
and browser tooling are authorized. Production deployment, repository push,
remote migration, real provider activation, production data movement and external
messaging remain outside scope. Phase 5F and Phase 6B are subsequent slices.

## Protected contracts

- Preserve Process sample-count widths, status colors and action ladder.
- Preserve Sample/Template read/edit field order and natural layout geometry.
- Keep Comment body rendering separate from attachment controls, and retain
  the completed Phase 5D metadata, preview, focus and child-removal behavior.
- Preserve FP2–FP5 File authority, storage routing, acceptance identities,
  recovery fences, revisions, administration and migration protocols.
- A failed read is not an authoritative empty result or a proved permission
  denial. Read retries must not replay a mutation or automatically submit a form.
- Keep drafts after failed saves and prevent accidental cancellation while a
  save/create is in flight. Retain existing domain-specific deletion and recovery
  wording; introduce no new storage/authentication/schema/backend protocol.
- Use local, measured style fixes rather than a broad stylesheet rewrite.
- Preserve all formal C4/device/deployed/provider/release acceptance boundaries.

## Completion checklist

- [x] Preserve the qualified source and consistent actual development DB baseline.
- [x] Audit record, directory, Processing/Timeline and Settings/Export surfaces.
- [x] Implement truthful read states, safe retries and response ownership.
- [x] Repair demonstrated accessibility, busy-form and metadata hierarchy gaps.
- [x] Measure and repair concrete responsive defects using representative data.
- [x] Preserve View/Edit geometry, Dense Process and Phase 5D behavior.
- [x] Pass meaningful page/interaction tests and final local canonical Verify.
- [x] Record before/after isolated real-browser and theme/viewport evidence.
- [x] Complete independent review and exact actual development-data preservation.
- [x] Update acceptance, roadmap and implementation plan; create a local commit.

## Baseline and exit

`/tmp/phase5e-development-baseline/` contains the tracked source hash manifest,
the starting source archive and a read-only consistent development DB snapshot.
The actual DB has 119 application tables / 33 rows and 22 migration receipts;
File mode remains legacy and execution guards remain disabled. Browser/test
fixtures must use separate persistent state. Phase 5D qualification remains at
`/tmp/phase5d-final-qualification-checkpoint/`.

Exit: mature source-record and directory pages expose reliable, accessible
states and clear action hierarchy while preserving their field layout, density,
ownership and workflows. Untested physical devices, IME, native mobile engines,
soft keyboards, successful Access/admin identities, provider connectivity and
deployed/release/recovery behavior remain explicitly pending. Continue next with
Phase 5F integration review, then Phase 6B under the existing roadmap.

## Completed qualification

The [Phase 5E acceptance](./PHASE_5E_ACCEPTANCE.md) records 400/400 core browser
cases and 16/16 supplemental heading cases at actual browser fingerprint
`7a84da3af014817020a67043b5f4dac10af64d5fee0dd6af46e73473cf632c78`. All 12/12 canonical local leaf qualification (finite resource budget, retained prefix) leaf outcomes qualify current
source `0aa3af63af675b47deef8a34ec446c9954fc36cc7f5c4a672e275e27c398d96f` through two retained input-closed leaves at `164d44ed8dc3221a24574bde29fc283c4d96681abe5052464d2dcd246bee2508`
and ten fresh leaves at final source. All 629 production file hashes match actual browser source. Final eligible
differences are `worker/storage/candidate-check-service.test.ts` (deterministic control of four existing 40ms
fixtures), `src/phase5e-records.mount.test.tsx` (one optional-chain question mark), and `src/phase5e-process-timeline.mount.test.tsx`
(initial-read readiness before the one original opening click in three existing
picker cases). Existing assertions, fixtures and application deadlines are
preserved. Earlier four temporary budget annotations were reverted at historical
freeze7. The actual source leaf passed all 3336 tests at `164d44ed8dc3221a24574bde29fc283c4d96681abe5052464d2dcd246bee2508` under
`npm run test:source -- --maxWorkers=2 --testTimeout=15000`; default 5,000ms CI timing remains unqualified.
Browser reports retain their actual fingerprint. Qualification preserves two
passing source/native leaves at `164d44ed8dc3221a24574bde29fc283c4d96681abe5052464d2dcd246bee2508` with independently proved
unchanged input closure, then runs the remaining ten leaves fresh at
`0aa3af63af675b47deef8a34ec446c9954fc36cc7f5c4a672e275e27c398d96f`. Exact per-leaf source identities are retained for this two-plus-ten
qualification. Four failed full source attempts, the
interrupted/build-failed clock-stage chain and wrapper 65393's mounted failure
remain historical failures. The actual new resumed wrapper exit 0 is retained
separately in `/tmp/phase5e-final-source-resource-qualification-v7.json`.
A fresh read-only actual development-data comparison preserved all 119 application
tables / 33 rows / 22 migration receipts. Independent source/evidence review passed.
Local evidence and commit receipts are at `/tmp/phase5e-final-qualification-checkpoint/`.
Next: Phase 5F integration review, which has not started, then Phase 6B; neither
subsequent slice is completed by this goal.
