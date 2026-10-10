# Phase 6 integration and enabled-scope acceptance ledger

Status: 6A6/6B in progress, 2026-10-10 (UTC).
This is a finite acceptance inventory for the combined development integration.
It does not declare Phase 6 complete or authorize a production release.

## Evidence identity and status rules

- Historical qualified source/document head: `4b2c660267b794d09798f961efe8d11ba6e1df86`;
  [Verify 37987949742](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/37987949742)
  succeeded. This evidence belongs to that head, not subsequent changes.
- Read-only audit checkpoint: `86369739160057f45ec8476b7778fdba9c79799d`.
  Source/doc integration, later fixes and the final combined tree need their own
  full required gates and review before an implementation PR is merged.
- `REVIEWED_SOURCE` means implementation and existing test assertions were read;
  it is not a new test pass. `OPEN_GATE` needs exact-tree verification.
  `OPEN_REMOTE` needs deployment/provider/operational evidence.
  `OPEN_IMPLEMENTATION` identifies code work rather than an external dependency.
- Preserve failed, interrupted, historical and current runs separately. A build,
  successful docs merge or mock provider test does not establish serving traffic,
  actual D1 migrations, enabled execution or live provider acceptance.

## 6A6 combined-tree stabilization

| Acceptance item | Current evidence and finite exit | Status |
| --- | --- | --- |
| Reviewed combined code/docs tree | PR #250 is merged; FP2–FP5 implementation and subsequent bounded 5F fixes still require their actual combined-tree review, full required CI and observed implementation merge. Record exact head/tree and receipts. | OPEN_GATE |
| Frozen predecessor and paired migrations | 0001–0017 are unchanged from the integration baseline. Review 0018/V21, 0019/V22, 0020/V23 and 0021–0022/V24 together; preserve historical hashes/readers and qualified fresh/populated migration coverage. | REVIEWED_SOURCE / OPEN_GATE |
| Generated recovery schema | Read-only fresh in-memory audit matched all 119 tables and 1,115 schema objects; no missing/stale tables, column differences, migration hash differences or FK violations. Relevant schema/export bytes were unchanged between `4b2c660` and audit checkpoint `8636973`. | Fresh-schema check passed; full combined-tree gate open |
| Current export admission | Generation markers/columns distinguish V21–V24; stale writers return 409, incomplete generations fail closed, and snapshot validators require the exact schema fingerprint and table inventory. Existing tests below cover actual routes and forged histories. | REVIEWED_SOURCE / OPEN_GATE |
| Nonempty recovery and preserved history | Existing native and legacy tests preserve bytes, canonical cells, signed rowids, source identity and accepted provenance through current-version export/restore and repeated recovery. Review source preservation and every restored execution guard at the final tree. | REVIEWED_SOURCE / OPEN_GATE |
| Stale-tab deployment recovery | The pre-existing obsolete lazy chunk gap now has a bounded explicit recovery implementation and five passing actual-App mounted cases; [route recovery evidence](PHASE_6_ROUTE_RECOVERY_ACCEPTANCE.md) preserves three pre-fix failures and the host-observation correction. Combined-tree gates, built-chunk browser recovery and actual serving-version handover are still required. | Locally implemented/focused pass; OPEN_GATE / OPEN_REMOTE |
| Integrated browser/input/data workflows | Retain bounded C4/5D/5E/5F receipts; finish applicable current-tree cross-page save/retry/focus, representative responsive/themes/mixed records, physical-device and OS-input checks. Mocked confirmation and viewport emulation do not establish real-device/IME acceptance. | OPEN_GATE / OPEN_REMOTE |

Fresh-schema audit SHA-256:
`7783c42f0259f6b9b857a0e2860d4c754638faaa8e13500a4cd9ab953555f3d8`.
The audit applied the reviewed fresh chain in memory, excluding the retired
0011 data-cleanup operation as the generator does. It did not execute remote
migrations, a new populated restore suite or the full canonical gate.

## Source guards and existing regression coverage

These are reviewed test paths, not newly executed results for the current head.

| Guard / preservation requirement | Existing assertion evidence |
| --- | --- |
| Migration DDL, hashes, columns and local/protected classification | `scripts/lib/system-recovery-schema.test.ts`; `worker/export-schema-coverage.test.ts`; `scripts/lib/export-restore-migrations.test.ts` |
| Whole-file and Wrangler-split successor equivalence; FK checks | `worker/export-v21-protocol.test.ts`; `worker/export-v22-protocol.test.ts`; `worker/export-v23-protocol.test.ts` |
| Exact generation, stale writer rejection and forged publication/history refusal before byte retrieval | V21–V23 protocol suites; `shared/contracts/export-system-recovery-evidence.test.ts`; `worker/export-archive-integrity.test.ts` |
| One primary-batch schema/rows/rowids/retention-clock snapshot; exact backup-owner holds | `worker/recovery/backup-snapshot.test.ts`; `shared/contracts/system-backup.test.ts` |
| Nonempty S3 archive after role-default changes; original rowids/locations; no restored credentials/execution | `worker/export-v21-protocol.test.ts` |
| Verified and uncertain migration history, retained physical copies, disabled restored executor and empty cleanup grants | `worker/export-v22-protocol.test.ts` |
| Nonempty native bytes, queued research history, preserved source installation identity and inert forward V24 restore | `worker/export-v23-protocol.test.ts` |
| Fresh target only, signed rows/BLOBs/cycles, partial/forged-schema/ledger refusal, lost-ACK readback and second-target recovery | `worker/recovery/target-import.test.ts`; `target-import-workerd.test.ts`; `target-legacy.test.ts`; `shared/contracts/system-recovery-image.test.ts` |
| Current Access/application/admin admission during migration execution; independent accepted cleanup policy | `worker/files/jobs/worker-runtime-authorization.test.ts`; `native-migration.test.ts`; `worker/recovery/recovered-asset-read.test.ts` |

## 6B proposed enabled scope and server-side admission

Implemented capability and approved live enablement are separate entries.
Disabling an executor prevents its independent object-I/O steps; it need not
prevent authorized users from saving queued metadata, plans or accepted requests.
Some explicit upload/read/control actions have separate capability checks.
Do not describe an installed disabled executor as a blanket prohibition of every
API action, or expose an unqualified operation merely because its UI is hidden.

| Capability | Actual implementation/admission boundary | Remaining enabled-scope exit |
| --- | --- | --- |
| FP2 administrator storage configuration and S3 File bytes | Verified Access application admission precedes separate administrator policy. Native S3 checks, admission and activation require the exact current candidate/envelope/namespace; byte execution requires the matching installation-local native binding, keyring and admitted File authority/runtime. Portable content does not install those credentials or bindings. | Authenticated deployed policy checks; actual exact-instance provider checks, activation/read/write/delete evidence and deployed resource limits before native-byte enablement. |
| FP3 File migration jobs | `file_job_runtime_guard` defaults disabled; File authority must be active/enabled. Independent steps recheck current Access metadata, application/admin policy, owner/generation/incarnation and request/publication fences; each step is bounded to 60s. Separately accepted cleanup retains its own local grant and runtime checks. | Qualified deployment bindings/provider directions, interrupt/unknown-ACK settlement, held reads/grace/cleanup and actual independent scheduling/runtime budgets. |
| FP4 research packages | Uses the explicitly enabled File-job runtime, current actor checks, frozen logical identities/destinations, bounded steps and verified publication; restored job history and cleanup authority remain inert. Queued metadata can exist without an executing runner. | Actual deployed package export/import/copy and full-byte verification with enabled destinations, scheduler and resource limits; retain import/copy semantics and original research history. |
| FP5 system backup/recovery | Privileged Access/application/admin checks, separate default-disabled recovery runtime and exact artifact namespace. Full restore additionally requires a provisioned fresh `RECOVERY_DB`/target identity. Partial capsules cannot perform full recovery; restored credentials, bindings, jobs and execution capabilities remain inert pending explicit local admission. | Actual provisioned separate target, nonempty backup/restore/rebackup, source preservation/checkpoints, root-key/provider review, operational handoff and authenticated target readiness. |

## Remote and operational acceptance still open

| Required evidence | Present checkpoint / exit |
| --- | --- |
| Legitimate authenticated development session | Anonymous requests to the development Workers URL currently redirect with HTTP 302 to Cloudflare Access. No legitimate test identity/session was available; this does not qualify application health, readiness, data or authorization behavior. |
| Actual development schema and serving code | Record current serving Worker/version and observed D1 receipts/schema for 0018–0022, then authenticated readiness, V24 export and stale-writer rejection. A successful Workers Build is insufficient. No remote migration is claimed by this ledger. |
| Independent runner cadence | Repository cron is `17 3 * * *` (daily), not a qualified two-minute runner. API `cadenceSeconds: 120` and a 60s step bound do not prove an installed cadence, heartbeat or deployed resource budget. |
| Real providers and enabled operations | Local SQLite/native workerd and isolated provider witnesses establish runtime mechanics. Record actual R2/S3/managed-service identity, interruption/settlement and applicable resource limits for each proposed live operation before enabling it. |
| Real devices and deployment handoff | Finish applicable physical-device, OS-input/IME and stale-document handoff scenarios against the reviewed serving version. Record failures and recovery outcomes rather than substituting emulation or manual refresh. |

If these external inputs are unavailable, continue implementation and local
qualification and keep the affected live capability deferred at its actual
server-side admission boundary. 6B closes only for the explicitly selected,
verified enabled scope, with every deferred scope and restriction recorded.

## Later roadmap scope

Full Node/Docker application distribution with SQLite/local volumes, deployment
upgrades and nonempty Cloudflare-to-self-hosted recovery parity is not implemented
by the neutral Node File-job kernel. Small-group membership and complete resource
authorization also remain later implementation work. Track them in the
[long-term roadmap](LONG_TERM_ROADMAP.md) and the finite [RT1–RT6 implementation plan](PORTABLE_RUNTIME_IMPLEMENTATION_PLAN.md); they are not missing credentials or
the same acceptance gate as this bounded 6A6/6B integration.
