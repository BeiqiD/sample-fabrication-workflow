# Phase 5F initial local integration goal

Status: bounded code/default-CI exits passed; whole Phase 5F remains in progress, 2026-10-09
(Europe/Berlin). Branch: `codex/fp2-fp3-development`.
Pushed code: `3c1baf5fdb21994c0510754eb20919db8189a91a`.
Tree: `eda8a59c55817a0c1adab5ba759f956a82e826f3`.
Record: [Phase 5F initial bounded acceptance](PHASE_5F_INITIAL_ACCEPTANCE.md).

The owner requested continued development and merging roadmap Draft PR #250 at
an appropriate checkpoint. FP2–FP5, bounded C4, 5D and 5E remain the baseline.
This goal covers initial 5F slices, not complete cross-product or release acceptance.

## Scope and dated baseline

Local development, isolated fixtures/browser checks, verification, ordinary
development pushes and reviewed PR #250 merge are authorized. Production
deployment, remote migration, real provider activation and actual development-data
changes remain outside scope. Keep `main` unchanged and preserve required checks;
confirm the deployment boundary before writing the integration branch.

- `2060c74` passed bounded local 5E qualification, but remote Verify `37918377223`
  failed V21 recovery at default 5,000ms; earlier local source checks used 15,000ms.
- `4479295` reuses independent real V20/V21 fixtures without losing assertions or
  migration replay. Focused default suite: 11 passed, restore 3,091ms versus
  observed 4,667ms before. Remote Verify `37976554667` hit its 20-minute job budget
  without a specific failed-test annotation; Map passed. The sequential budget
  is now 40 minutes; individual deadlines remain unchanged.
- `20176fc`'s default source-only context succeeded, but mounted Verify
  `37979239529` exposed lost helpful preflight guidance. The assistant deliberately
  stopped the redundant local gate's owned native processes before repair;
  source-stable exit 1 is incomplete, not a native failure or complete pass.
- `0512763` restored validated helpful guidance (47 focused passed). `b7c6246`
  added current-intent receipt ownership (56 focused passed, overlapping the 47).
  Its [Verify `37983032975`](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/37983032975)
  completed SUCCESS at 20:12:24 UTC after 21m14s, with all 15 published contexts
  successful. This qualifies its complete 12-leaf gate, not later `3c1baf5`;
  no exact remote file/test counts are asserted.
  All dated failures, corrections and evidence identities remain in the record.

## Bounded slices and exits

1. Complete default Verify qualification passed for `3c1baf5`: canonical 12-leaf
   gate and all 15 published contexts succeeded, without reduced coverage.
2. First-read status errors: safe package/recovery guidance, validated helpful
   preflight reasons, authorization and original request reconciliation retained.
   Receipt/error handling must still own the current saved intent.
3. Processing preview ownership: source/session/selection changes invalidate
   obsolete results, errors and completion, preserving mutation/revision guards.
4. Processing modal focus: Escape, Tab, pending-close protection and dialog handoff.
5. Dense layout: measure 3/4/8 Samples at 720/721px in both themes and repair the
   demonstrated missing selector while preserving desktop widths and grid behavior.
6. Jobs-view control ACK: invalidate background reads begun before/during an
   accepted control in both pages; late ACKs preserve current access denial.
   Backend/API, maintenance and accepted-control protocols remain unchanged.
7. Reconcile roadmap documents and merge PR #250 when current checks/review and
   the confirmed non-deployment boundary permit an observed merge.

## Current checkpoint and next step

All bounded source repairs are pushed in `3c1baf5`. Jobs-control tests first failed
all 12 cases; the initial fix passed 86 focused tests. Added denial/late-ACK checks
exposed one more failure (13 pass/1 fail), then all 88 focused tests passed,
including 14 new cases. Final full mounted passed 93 files/877 tests on two CPUs
(137.10s, start 20:04:49 UTC). The local TypeScript/Worker/client rebuild exited 0;
its raw log retains a nonfatal Wrangler logging ENOENT. No deployment ran.

Exact-head Map `37984549655` passed at 20:05:26 UTC; [Verify `37984549600`](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/37984549600)
completed SUCCESS at 20:30:28 UTC after 25m39s, with all 15 contexts successful.
This qualifies the complete default gate; no remote test counts or new complete
local canonical pass are claimed. Keep this coding batch frozen.

Twelve post-repair grid cases and eight isolated preview/focus cases passed.
The latter are four unconfirmable start reads (200) and four historical absent-plan
rejections (404); successful real plan preview/confirmation is not qualified.
Positive confirmation is mocked mounted evidence. Preserve original harness failures.

The dated `b7c6246` runtime review reconstructs matching browser source windows;
it is a hash review, not a rerun or retrospective browser qualification of later
package/jobs changes. The final jobs-view Git/source-byte delta is closed: only
two pages and the new control test changed; Processing/styles match browser code.
This is not a dependency rehash or browser rerun. This review did not obtain an
independent before baseline for the original 5E isolated fixture. Actual development-data
read-only proof at 20:07:36 UTC matches schema, typed cells and physical rowids,
quick-check `ok`, zero FK errors. The isolated server stopped with TERM/exit 143.

PR #250's historical `1fe8dd6` docs head had four green runs/14 contexts at 19:47.
Head `4b7353ad8c792d790d379df0e38cbfba04730fb5` now has all four own runs and 14
contexts passed, Draft/CLEAN/MERGEABLE. These are separate from implementation
qualification, and any later docs head needs its own checks. The Cloudflare
deployment boundary remains unconfirmed and an observed merge is pending.

The next queued slice is [Metrology Save and add](PHASE_5F_METROLOGY_GOAL.md): full
pending ownership across create → entry-add → `onSaved`/refresh and session/unmount
fences. Its source is not implemented or qualified at this checkpoint.
Remaining 5F cross-product review,
measured performance, enabled-scope 6A6/6B, real devices/IME/other engines,
authenticated deployment, real providers, operational recovery and release
acceptance remain open. Historical archive readers, migrations, authorization,
provider selection and accepted-operation protocols are preserved.

## Continuation on 2026-10-10 (UTC)

The checkpoint above is historical. PR #250 was merged at `541eedb`; the current
autonomous development scope includes reviewed integration merges into
`v2/backend-foundation`. The bounded [Metrology pending/session goal](PHASE_5F_METROLOGY_GOAL.md)
is locally complete, with subsequent picker/standalone and projection fixes
recorded in their acceptance documents. Current program status is tracked by
[the autonomous goal](ROADMAP_AUTONOMOUS_DEVELOPMENT_GOAL.md) and
[the Phase 6 acceptance ledger](PHASE_6_INTEGRATION_ACCEPTANCE_LEDGER.md); current
combined-tree and deployment qualification must not be inferred from this older
checkpoint.
