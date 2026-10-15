# Phase 5F Metrology pending/session acceptance

Local checkpoint: 2026-10-10, `codex/fp2-fp3-development`.
Baseline: `4b2c660267b794d09798f961efe8d11ba6e1df86`.
Scope: [the bounded pending/session goal](PHASE_5F_METROLOGY_GOAL.md).
Evidence hashes and commands: [receipts](PHASE_5F_METROLOGY_RECEIPTS.json).

The outer drawer now owns template creation, entry insertion and the existing
refresh callback as one pending operation. Close, Escape, backdrop and competing
actions stay blocked. A synchronous operation lock rejects duplicate dispatch.
Captured sample/run/insertion-point payloads remain unchanged; the mount-session
owner guards follow-up insertion, refresh, close, error and finally effects.
Ordinary refreshed run objects do not invalidate their own successful operation.

## Actual checks

| Check | Result |
| --- | --- |
| Actual-grid pre-fix reproduction | 4 failed: three dismissals during create and insertion after unmount |
| First focused grid/form regressions | 3 files / 66 passed; before two additional stale-refresh cases |
| Full mounted suite | 94 files / 903 passed, including 26 final pending/session cases; 65.47s |
| Shared modal source checks | 1 file / 4 passed |
| Initial build | Failed because eight new test role queries used an unsupported TypeScript option |
| Corrected build | Passed after removing that option; string role names retain exact matching |

The mounted suite exercises the real grid, StepCell, form and modal hook using
deferred API responses. It checks current and abandoned create/add/refresh
outcomes, same-business remounts, exact ordered payloads, retained drafts, direct
Add, read-only/completed actions and keyboard focus. Unexpected network calls
are rejected. This is local component qualification, not browser/provider or
deployed acceptance. Later independent picker-read changes require their own
checks and combined-tree qualification.

## Preserved limits

Already dispatched writes may still be accepted after navigation; there is no
cancellation, rollback, deletion or automatic POST replay. After accepted create
and failed add, the draft remains; accepted-template reuse/recovery is still a
separate concern and a repeated create may meet the existing uniqueness guard.
Processing's ordinary refresh callback still resolves while presenting a GET
failure on the page. The explicitly rejecting refresh test qualifies callback
cleanup and does not change that host behavior.

Session qualification follows the actual Processing keyed-grid boundary. It
does not promise to repair arbitrary replacement of run columns inside an
otherwise unchanged mounted grid. Picker query/read ownership, standalone
Metrology navigation and mixed-product browser/device acceptance remain separate
follow-up slices. No remote migration or real development-data write was made.
