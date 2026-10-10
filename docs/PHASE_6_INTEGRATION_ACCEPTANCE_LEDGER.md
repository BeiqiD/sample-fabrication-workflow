# Phase 6 integration and enabled-scope acceptance ledger

Status: 6A6/6B in progress, 2026-10-10 (UTC).
This is a finite acceptance inventory for the combined development integration.
It does not declare Phase 6 complete or authorize a production release.

## Evidence identity and status rules

- Historical fully qualified implementation source:
  `af8f374cfbbade3282f2e686cc9f35d3c40adf4a`. All **12 local default**
  `npm run verify:ci` leaves passed, with no skips: native **355 tests**,
  source **366 files / 3,349 tests**, mounted **98 files / 945 tests**;
  contracts, fresh/populated migrations, Worker, build and bundle leaves passed.
  [Push Verify 38054290373](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38054290373),
  [PR Verify 38054322488](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38054322488),
  [push Map 38054290357](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38054290357)
  and [PR Map 38054322490](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38054322490)
  all succeeded; all **15 final status contexts** passed.
- Observed implementation [PR #251](https://github.com/BeiqiD/sample-fabrication-workflow/pull/251)
  merge: `aa497d9a1a304751ea7533548573a256799ef734`, 2026-10-10 at
  13:30:26 UTC. Its tree `087749d12a3e3ad19473f1f4e63d29e1ecf1c269`
  equals the validated `af8f374` tree. Its post-merge Verify/Map checks and all
  15 contexts subsequently passed, as did Workers Build `114224522096`.
  Three anonymous routes still returned Access 302; serving/schema/provider
  admission remains separate. Later changes need their own checks.
- Open [PR #252](https://github.com/BeiqiD/sample-fabrication-workflow/pull/252):
  applied UI source passed 100 mounted files / 966 tests and build. At
  `ee1713393f5dea1f6bbd7a856c7586a8e517591c`, tree
  `8f37485feb0328094738ada55da46a2a9c38aeaf`, the
  [current local checkpoint](PHASE_5F_CURRENT_BROWSER_ACCEPTANCE.md) passed
  the adopted 20-case matrix, 84-request seed, six cost cases, 12 additional
  Project scenario IDs, awaited controlled stop and four physical SQLite/FK
  checks with exact PNG/original-state byte proof. Fresh exercised source
  `c06cb71ec5933cfb4d1721a5c1ac314b09a96ed8`, tree
  `2466e71894298e90acdc5bd4b183d29fdd88b24f`, then passed 20 matrix cases,
  both named Metrology cases, awaited stop and four SQLite/FK/PNG/original-byte
  checks. Final-head complete remote gates remain pending. These bounded checks do not inherit the historical full gate.
- Historical qualified source/document head: `4b2c660267b794d09798f961efe8d11ba6e1df86`;
  [Verify 37987949742](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/37987949742)
  succeeded. This evidence belongs to that head, not subsequent changes.
- Historical read-only audit checkpoint: `86369739160057f45ec8476b7778fdba9c79799d`.
  Its fresh-schema audit is retained separately from the later complete
  `af8f374` qualification and observed integration merge.
- `REVIEWED_SOURCE` means implementation and existing test assertions were read;
  it is not a new test pass. `OPEN_GATE` needs exact-tree verification.
  `QUALIFIED_TREE` means the reviewed tree passed its complete local/default
  remote gate. `OPEN_REMOTE` needs deployment/provider/operational evidence.
  `OPEN_IMPLEMENTATION` identifies code work rather than an external dependency.
- Preserve failed, interrupted, historical and current runs separately. A build,
  successful docs merge or mock provider test does not establish serving traffic,
  actual D1 migrations, enabled execution or live provider acceptance.

## 6A6 combined-tree stabilization

| Acceptance item | Current evidence and finite exit | Status |
| --- | --- | --- |
| Reviewed combined code/docs tree | #250 planning and #251 implementation are merged. Reviewed `af8f374` passed full local/default remote checks; observed integration `aa497d9` has its identical tree and post-merge checks passed. Open #252 has bounded current local evidence; its final-head complete gates remain pending. Preserve exact receipts for later changes. | QUALIFIED_TREE / observed development merge |
| Frozen predecessor and paired migrations | 0001–0017 are unchanged from the integration baseline. Paired 0018/V21, 0019/V22, 0020/V23 and 0021–0022/V24 review and complete local/remote gates passed; retain frozen hashes/readers and fresh/populated coverage. Actual remote D1 migration receipts remain unknown. | QUALIFIED_TREE / OPEN_REMOTE |
| Generated recovery schema | Historical fresh audit matched 119 tables and 1,115 schema objects without differences or FK violations. Relevant bytes were unchanged at audit checkpoint `8636973`; later complete `af8f374` migration/schema/export gates passed independently. | QUALIFIED_TREE |
| Current export admission | Generation markers/columns distinguish V21–V24; stale writers return 409, incomplete generations fail closed, and validators require exact fingerprints/inventory. Canonical suites below passed at `af8f374`; authenticated actual serving-route checks remain open. | QUALIFIED_TREE / OPEN_REMOTE |
| Nonempty recovery and preserved history | Native/legacy canonical tests passed with bytes, canonical cells, signed rowids, source identity and accepted provenance preserved through export/restore and repeated recovery. This local/native evidence does not qualify an actual deployed provider or provisioned target handoff. | QUALIFIED_TREE / OPEN_REMOTE |
| Stale-tab deployment recovery | Explicit recovery passed actual-App mounted and full gates; [route recovery evidence](PHASE_6_ROUTE_RECOVERY_ACCEPTANCE.md) preserves pre-fix failures. [Built-Worker browser evidence](PHASE_5F_INTEGRATED_BROWSER_ACCEPTANCE.md) passed two one-shot 404/503 chunk failures, explicit keyboard reload and full URL retention. An actual old-document/new-serving-version handover is still required. | QUALIFIED_TREE / local browser passed / OPEN_REMOTE |
| Integrated browser/input/data workflows | Historical 20-case matrix and two Metrology pending cases retain their versioned scope. Current `ee171339` adopted matrix passed 20 cases plus six cost cases and 12 additional Project scenario IDs; dirty/held/lost-ACK exact retries preserve original Projects, and controlled-stop/physical proof passed. Owner refresh and search label are implemented in open #252; fresh `c06cb71` passed 20 matrix cases and both named Metrology cases, plus awaited-stop/physical checks. | Bounded current browser passed / final-head gates pending / OPEN_REMOTE |
| Next finite product repairs | Initial Project GET Retry characterization had 5 red / 1 pass; its candidate has 6 green mounted cases. Known three-owner group refresh has a private 29-test/type candidate for 8 → 3 reads. Both belong in separate reviewable PRs, with current-artifact qualification before integration. | OPEN_IMPLEMENTATION / candidate tests only |

Fresh-schema audit SHA-256:
`7783c42f0259f6b9b857a0e2860d4c754638faaa8e13500a4cd9ab953555f3d8`.
The historical audit applied the reviewed fresh chain in memory, excluding the
retired 0011 data-cleanup operation as the generator does. That audit alone did
not execute remote migrations, a new populated restore suite or the full gate;
the later `af8f374` complete gate has its separate receipt above.

## Source guards and existing regression coverage

These reviewed paths are covered by the complete native/source gate at
`af8f374`; their individual counts are not added to the canonical totals.
None is a real-provider or actual deployed target receipt.

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
| Legitimate authenticated development session | The post-merge curl checks of three development routes returned HTTP 302 to Cloudflare Access. No legitimate test identity/session was available; this does not qualify application health, readiness, data or authorization behavior. |
| Actual development schema and serving code | Workers Build `114224522096` succeeded after the post-merge checkpoint. Record actual serving Worker/version and observed D1 receipts/schema for 0018–0022, then authenticated readiness, V24 export and stale-writer rejection. Even a successful build is insufficient. No manual remote migration is claimed by this ledger. |
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
