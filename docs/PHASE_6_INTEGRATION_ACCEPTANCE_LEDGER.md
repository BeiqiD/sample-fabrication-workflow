# Phase 6 integration and enabled-scope acceptance ledger

Historical checkpoint: 6A6/6B in progress, 2026-10-10 (UTC).
This is a finite acceptance inventory for the combined development integration.
It does not declare Phase 6 complete or authorize a production release.

**Current development status — 2026-10-13 (UTC).**

**Earlier merged development checkpoint:** [PR #282](https://github.com/BeiqiD/sample-fabrication-workflow/pull/282) merged at `e6a4dbe8098d3557510831531bd2fc534fe9e26b`. Its own-head four Verify/Map runs and all 15 contexts, then the e6 post-merge two runs and all 15 contexts, succeeded; its actual Workers Build also succeeded. Those results retain their exact source scope.

**Build optimization now in the development baseline:** [PR #283](https://github.com/BeiqiD/sample-fabrication-workflow/pull/283) merged at `879145ec1e74c853d079ba49503bcad199a3b768`, with its own-head and post-merge CI and actual [Workers Build 114914679495](https://github.com/BeiqiD/sample-fabrication-workflow/runs/114914679495) successful. Default `npm run build` uses `npm run config:local && vite build`; TypeScript checking remains the separate `npm run typecheck` prerequisite in `verify`. The fast build result does not replace serving, schema or provider acceptance.

**Merged FabuBlox development checkpoint:** [PR #284](https://github.com/BeiqiD/sample-fabrication-workflow/pull/284) is merged at `784aeb5c14cb2e2c776a27f6f9a5ef9a6ba4dfcd`, whose tree equals qualified candidate `762616906a0cc569567cc4d73242163642310c70`. Its actual post-merge [Verify 38320273223](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38320273223), [Map 38320273213](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38320273213), all 15 contexts and Cloudflare build succeeded. The candidate's four genuine Process/body tests, full server typecheck, fresh build and four fixed local Chromium shell/accessibility cases retain their original local scopes; earlier failures and browser receipts remain recorded separately.

**Merged Node producer:** [PR #285](https://github.com/BeiqiD/sample-fabrication-workflow/pull/285) merged at `8d832ba7af5f1554d61f34fe726ffd8b9de46336`, with the exact tree of `cbe0fd3`. Both own Verify runs, both Map runs and all 15 contexts passed. Its actual post-merge [Verify 38323940091](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38323940091), [Map 38323940004](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38323940004), all 15 contexts and Cloudflare build succeeded. The full Node V3 package, eight distribution tests, embedded verifier and four bundled CLI help checks passed at cbe0; its package has 123 files and 858 source inputs. Those results retain their exact scopes; Docker/image/17-case and whole restored-target acceptance remain open.

**Merged explicit V28 profile checkpoint:** [PR #286](https://github.com/BeiqiD/sample-fabrication-workflow/pull/286) merged at `356`, preserving the exact qualified `4ef7a9d` tree `1e454`. Its four own Verify/Map workflows and all 15 contexts succeeded. Full server type checking, three parser cases, a fresh Node client/distribution build, embedded verification, four compiled CLI help checks and four genuine programmatic runtime-startup cases passed in the dedicated [run 38323352244](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38323352244). This package has 123 files and 928 source inputs. Its actual post-merge [Verify 38326376427](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38326376427), [Map 38326376350](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38326376350) and all 15 contexts succeeded. The original workflow logs and stage PASS reports were read; the separate artifact download returned 403 and its detailed receipt files were not read back. Compiled-server startup, restored-target startup and cross-runtime recovery are not established by those four programmatic startup cases; the default entry remains V26.

**Merged roadmap status checkpoint:** [PR #287](https://github.com/BeiqiD/sample-fabrication-workflow/pull/287) merged at `493` after its own four Verify/Map workflows and all 15 contexts succeeded. Its post-merge checks remain pending; the documentation merge does not complete the separate runtime, browser or release scopes.

**Merged restored Node operators — bounded dedicated pass:** [PR #289](https://github.com/BeiqiD/sample-fabrication-workflow/pull/289) at `ebc1` passed its dedicated [run 38327393720](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38327393720): actual full server type checking, three parser cases, a fresh 123-file/930-source-input Node package, embedded verification and four bundled CLI help checks. Genuine complete zero-File V5 capture and one actual bundled restore-CLI case passed across distinct source/destination installations; two reset-secret administrator/Group operator cases and the credential-revision `+2` check passed. Parent `f34` [run 38326839944](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38326839944) retains its own earlier zero-File capture/restore/operator scope. The candidate's four own Verify/Map workflows and all 15 contexts succeeded, and PR #289 merged at `86a8972588f60326aad850c63f1e0ebb08813578` with the exact `ebc1` tree. The merge's new post-CI remains pending. Maintenance remains fenced; nonempty FileBackup, restored business activation, serving and public capture remain UNRUN. These bounded results do not establish whole Node recovery.

**Large Project browser work — original native200 pass, combined-head scope pending:** [Draft PR #288](https://github.com/BeiqiD/sample-fabrication-workflow/pull/288) source `32` passed dedicated [run 38328093696](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38328093696): two physical SQLite checks before startup, 477 real API seed requests, one genuine native200 browser case, original normal stop and four physical SQLite checks afterwards. `completeFiniteMatrix` remains `false`. Its first attempt's Python SQLite parser failure before API startup still retains API/browser UNRUN. New source `028c0ff7bf8ef4d1ab1b127b8e3a0899cd63e245` exactly combines the `32` browser source with `ebc1`; its dedicated [run 38329403623](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38329403623) separately passed the same original native200 and before/after physical checks. Its whole CI remains pending. The `32` result is not retagged onto this combined source. Historical 250/400 browser cases retain their original sources and scopes; whole5F acceptance remains open.

**RT6 — original bounded failure retained:** The original `8d` Docker attempt built its image and passed two cases before its constructor-path failure. Corrected `ce880` dedicated [run 38327278329](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38327278329) built one image, passed its first eight actual cases, then failed case 9, `genuine-native-upload-replay-and-bytes`, on `POST /api/assets` with observed HTTP 503; the remaining eight cases were UNRUN. Actual CLI/container closure was confirmed, while the original `originalBodiesClosureUnproven` marker remains preserved. The 503 root cause is undetermined. The fixed-enum diagnostic `b3e7463` ran the same 17-case matrix in [run 38329481740](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38329481740), retaining 8PASS/1FAIL/8UNRUN and identifying the original response as `node_503_file_unavailable`. This generic File error still requires a specific server-side cause; it does not establish a full pass. The original 17-case matrix and budgets remain unchanged, and RT6 is not complete.

**Maintenance control — source and narrow checks pending completion:** New six-leaf maintenance source `087` has actual Root full server type checking and three parser cases passed. Its three genuine maintenance cases remain UNRUN. Maintenance remains fenced; no serving activation or whole maintenance-lane pass is claimed.

#252 and #254 subsequently passed their final-head gates and merged. Initial Project GET Retry and three-owner refresh are completed scoped repairs from merged #254; their earlier red/candidate results below remain historical. The four named local shell/accessibility cases passed for the #284 qualified candidate before its merge; that original receipt retains its scope. Whole5F final disposition, applicable physical IME/touch/other-engine evidence, actual old-document/new-serving-version handover, and selected fresh/populated and enabled-provider/operational 6A6/6B exits remain open. Retain the existing server admission restrictions and versioned failures/counts.

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
- Historical open-PR checkpoint for [PR #252](https://github.com/BeiqiD/sample-fabrication-workflow/pull/252):
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

## 6A6 combined-tree stabilization — historical 2026-10-10 checkpoint

| Acceptance item | Historical evidence and finite exit | Historical status |
| --- | --- | --- |
| Reviewed combined code/docs tree | #250 planning and #251 implementation are merged. Reviewed `af8f374` passed full local/default remote checks; observed integration `aa497d9` has its identical tree and post-merge checks passed. Historically open #252 had bounded local evidence; its final-head complete gates were pending at this checkpoint. Preserve exact receipts for later changes. | QUALIFIED_TREE / observed development merge |
| Frozen predecessor and paired migrations | 0001–0017 are unchanged from the integration baseline. Paired 0018/V21, 0019/V22, 0020/V23 and 0021–0022/V24 review and complete local/remote gates passed; retain frozen hashes/readers and fresh/populated coverage. Actual remote D1 migration receipts remain unknown. | QUALIFIED_TREE / OPEN_REMOTE |
| Generated recovery schema | Historical fresh audit matched 119 tables and 1,115 schema objects without differences or FK violations. Relevant bytes were unchanged at audit checkpoint `8636973`; later complete `af8f374` migration/schema/export gates passed independently. | QUALIFIED_TREE |
| Current export admission | Generation markers/columns distinguish V21–V24; stale writers return 409, incomplete generations fail closed, and validators require exact fingerprints/inventory. Canonical suites below passed at `af8f374`; authenticated actual serving-route checks remain open. | QUALIFIED_TREE / OPEN_REMOTE |
| Nonempty recovery and preserved history | Native/legacy canonical tests passed with bytes, canonical cells, signed rowids, source identity and accepted provenance preserved through export/restore and repeated recovery. This local/native evidence does not qualify an actual deployed provider or provisioned target handoff. | QUALIFIED_TREE / OPEN_REMOTE |
| Stale-tab deployment recovery | Explicit recovery passed actual-App mounted and full gates; [route recovery evidence](PHASE_6_ROUTE_RECOVERY_ACCEPTANCE.md) preserves pre-fix failures. [Built-Worker browser evidence](PHASE_5F_INTEGRATED_BROWSER_ACCEPTANCE.md) passed two one-shot 404/503 chunk failures, explicit keyboard reload and full URL retention. An actual old-document/new-serving-version handover is still required. | QUALIFIED_TREE / local browser passed / OPEN_REMOTE |
| Historical integrated browser/input/data workflows | Historical 20-case matrix and two Metrology pending cases retain their versioned scope. Current `ee171339` adopted matrix passed 20 cases plus six cost cases and 12 additional Project scenario IDs; dirty/held/lost-ACK exact retries preserve original Projects, and controlled-stop/physical proof passed. Owner refresh and search label are implemented in open #252; fresh `c06cb71` passed 20 matrix cases and both named Metrology cases, plus awaited-stop/physical checks. | Bounded current browser passed / final-head gates pending / OPEN_REMOTE |
| Historical product-repair candidates (completed via merged #254) | Initial Project GET Retry characterization had 5 red / 1 pass; its candidate has 6 green mounted cases. Known three-owner group refresh has a private 29-test/type candidate for 8 → 3 reads. At this checkpoint, both belonged in separate reviewable PRs, with current-artifact qualification before integration. | HISTORICAL_CANDIDATES / merged #254 |

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
