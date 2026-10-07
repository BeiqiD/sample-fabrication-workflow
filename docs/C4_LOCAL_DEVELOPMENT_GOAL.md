# Development goal: C4 local integration and demonstrated defect repairs

Status: complete for the bounded local development goal, 2026-10-07 (Europe/Zurich).
Formal device/deployment C4 acceptance remains in progress.
Owner direction received on 2026-10-07 (Europe/Zurich).
Working branch: `codex/fp2-fp3-development`.
Qualified FP2–FP5 baseline: `426b969e682780bbb9b6dcec7e57cecee6eb81e9`.

## Scope and authority

Resume the Project C4 integration work in the
[product roadmap](./PRODUCT_ROADMAP.md) and
[frontend implementation plan](./FRONTEND_REFINEMENT_IMPLEMENTATION_PLAN.md).
Verify the current development version against an isolated local backend and
real browser, then repair demonstrated workflow, focus, responsive or save-state
defects. Preserve the implemented shortcuts, panels, editing and Project identity
contracts. This goal does not start the Phase 5D attachment/media implementation.

Continue implementation, meaningful verification and independent review with
minimal owner intervention. Local commits, isolated fixtures, local migrations,
browser tooling and local test servers are within scope. Production deployment,
remote migration, actual provider activation, production data movement,
repository push and external messaging remain outside scope.

Physical keyboard/IME, touch devices, mobile native browsers, real-provider and
deployed-runtime acceptance remain separate. Local browser simulations must not
be recorded as those checks or as complete formal C4 acceptance.

## Completion checklist

- [x] Preserve the qualified FP5 code/evidence and actual development DB baseline.
- [x] Create an isolated real local application/backend and browser fixture.
- [x] Verify Project directory/workspace, Map/Reading and reload persistence.
- [x] Verify command ownership, Help dismissal and Canvas focus restoration.
- [x] Verify representative content, themes and documented adjacent breakpoints.
- [x] Verify save response loss/reconciliation and active-gesture response timing.
- [x] Repair actual defects while retaining lifecycle, identity and projection invariants.
- [x] Run affected source/mounted, build and relevant Project performance checks.
- [x] Complete independent review and confirm actual local data remains unchanged.
- [x] Record local evidence and explicitly retained external acceptance gaps.

## Preserved baseline and exit

`/tmp/c4-development-baseline/` contains the pre-C4 tracked patch and untracked
archive, a consistent copy of the actual development database, the full path
manifest and all twelve passing FP5 qualification records/logs. The baseline
code fingerprint is
`d82270c2ef2f9e1395734811abe6500460184cc50ba51822c2c67b311fb25e1f`.
The development DB remains on `0022`, in legacy File mode with execution guards
disabled. Browser fixtures must use a different persistent state directory.

The exit is a reviewed local C4 integration checkpoint with measured evidence,
concrete repairs and an honest list of remaining device/deployment checks.
Phase 5D follows C4 under the roadmap; local completion alone does not erase the
formal C4 acceptance boundaries in [C4 acceptance](./PROJECT_C4_ACCEPTANCE.md).

## Completed checkpoint

Two native-browser findings were repaired only in `src/project.css`: the
retained desktop editor/save header clipped controls below 860px, and ordinary
360px mobile Reading overlapped Help with Project actions. Wrapping and menu
anchoring retain the existing projection and mutation state machines. All 24
measured workspace cases at widths of at least 860px kept their original geometry.

The final isolated browser qualification passed 64 layout/directory/Help cases,
18 active-editor cases and three actual Worker/D1 save-fault cases. Canvas focus
restoration and selection were also checked. All five affected checks passed:
24 source tests, the complete 698 mounted tests, build, Map bundle ownership and
production Worker/D1 Project artifact verification. Independent review found no
blocking issue. Source start/end fingerprint for all five checks:
`e7eaddd9e9677d0c2a7a1bbe688a4cec5e3215705dfa53ea35695b3784af36a4`.
The original full FP5 gate remains preserved at its own qualified baseline.

The actual development database exactly matches the pre-C4 snapshot: schema,
119 application tables / 33 rows, typed cells and physical rowids, all 22
migration receipts and raw migration SQL. Quick check passed and foreign-key
violations were zero. The isolated fixture was restored through normal API CAS
operations; truthful operation receipts and advanced revisions remain. The local
browser server was stopped after qualification.

The initial six layout failures and later uncaught test-forwarding connection
failure are retained with the successful evidence. The corrected harness catches
and drains route callbacks, records unknown outcomes, uses no automatic mutation
retry, and verifies exact replay body bytes. It did not relax assertions or waits.
The upstream socket-drop cause remains unproven.

See the [current local C4 record](./PROJECT_C4_ACCEPTANCE.md#local-integration-checkpoint--2026-10-07)
for cases, commands, evidence paths and formal acceptance gaps.
The next implementation slice is **Phase 5D — attachment and media surfaces**;
it has not started. Its eventual goal must carry forward these device/deployed
acceptance limits, then follow the existing 5E → 5F → 6B order. This goal closes
at the reviewed local C4 checkpoint and does not authorize a production rollout.
