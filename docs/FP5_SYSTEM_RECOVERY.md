# FP5 system backup and recovery

Status: implementation and local development qualification complete,
2026-10-06 (UTC). Working branch: `codex/fp2-fp3-development`; integration
base: `474a038`. The [development goal](./FP5_DEVELOPMENT_GOAL.md) and
[portability plan](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md) define the exit.

FP5 adds privileged whole-system backup and identity-preserving recovery, with
explicit completeness and an assisted handoff to a provisioned fresh target.
FP4 research-package import keeps its separate copy semantics and fresh IDs.
Development authority covers local implementation, isolated fixtures and local
reversible migrations. Production deployment, remote migration, actual provider
activation, production file movement and repository push remain outside this goal.

## Contracts, schema and admission

`system-backup/1` and `system-backup-records/1` are closed contracts separate from
research packages, content-export versions and migration numbers. Their records
cross-bind the current ordinary content snapshot, an exact typed recovery image,
protected configuration classification, source origin and source migration
observations. The manifest binds records, source checkpoint, file inventory,
purposes and consumers, completeness, relocation evidence and generated reports.

Migration `0021_fp5_system_recovery.sql` adds installation-local jobs, receipts,
ownership, maintenance, retained-artifact metadata and target recovery controls.
Migration `0022_fp5_recovery_evidence.sql` adds portable physical-file, alias and
consumer-binding evidence. Ordinary content V24 adds the reviewed
`fp5-system-recovery-evidence` profile; frozen V7–V23 readers remain separate.
The original 20 SQL migrations must remain byte-identical to the preserved FP4
baseline. Installation-local recovery tables do not become portable old-job
authority. The target schema and its migration ledger come from the reviewed
repository catalog; uploaded SQL is evidence and is never executed.

The typed image retains SQLite cell classes (`null`, `integer`, `real`, `text`,
`blob`), exact physical rowids, signed decimal int64, canonical real text,
uppercase BLOB hex and NUL-bearing text. This does not broaden ordinary business
integer contracts: the current content snapshot still requires application-valid
JavaScript safe integers. Explicit decimal shadow fields and typed-only protected
int64 fields retain their exact representations.

| Bound | Admission limit |
| --- | --- |
| Complete ZIP | 100 MiB |
| Aggregate physical payload | 96 MiB; at most 100 physical source entries |
| Aggregate metadata and reports | 4 MiB |
| `records.json` | 3 MiB |
| Typed row count / JSON bytes per typed row | 16,384 / 64 KiB |
| Source capture preflight | Conservative 4 MiB budget before reading row bodies |
| Website target row publication | One atomic D1 batch; at most 128 statements including guards and bookkeeping |
| Website row groups and generated SQL | Groups at most 83 KiB; SQL below 83 KiB |
| Frozen destination metadata | 1 MiB |
| Planned destination copies | At most 100 logical copies and 96 MiB aggregate bytes |
| Streaming hash/read chunks | 64 KiB |
| Executor stage / ownership lease | 60 seconds / 65 seconds |
| Fresh raw-artifact attempts / availability | At most five / 24 hours, extended by accepted unfinished recovery retention |

The shared STORE ZIP engine checks UTF-8 names, normalized paths, duplicates,
case collisions, local and central header agreement, descriptors, EOF, CRC and
full-byte SHA-256. It rejects traversal, symlinks, encryption, unsupported
compression and ZIP64. Four metadata entries are fixed: `manifest.json`,
`records.json`, `report/index.html`, `report/report.md`. Reports are regenerated
and compared during admission; uploaded report HTML is never executed. Website
restore budget failure is surfaced before target or provider work. A complete
backup can remain useful even when that website restore budget is insufficient;
the independent local restore has the same archive/image admission bounds.

## Capture, bytes and retention

A fresh-primary D1 batch captures the ordinary content snapshot, all reviewed
nonlocal canonical tables, protected cells, source schema evidence, native clock
and actual source migration observations. Retention holds are acquired in that
same batch before inventory reads. Unknown schema objects, including unreviewed
objects attached to platform tables, reject capture; qualified engine platform
tables are not treated as application data.

`sourceMigrationLedger` records the actual observed `d1_migrations` rows when
available, including exact decimal receipt IDs, names and application times.
Matching repository hashes are reviewed-code evidence, not proof of the bytes
historically executed by D1. An absent ledger is declared unavailable. Recovery
creates a separate code-owned target ledger from the reviewed migration list; it
does not execute or substitute the archive's observed ledger.

Native export holds use the exact backup owner. Legacy holds freeze the exact
store/provider/object-key tuple. Legacy and native GC paths honor these holds and
reject already irreversible deletion races. Missing, unavailable, changed,
oversized or unreadable source bytes produce visible partial inventory outcomes.
Only complete capsules can enter full website or standalone system recovery.
The final archive stream rechecks each promised payload, then the stored output
receives an independent complete-byte readback. A successful PUT response or a
provider HEAD response alone does not prove completion.

Backup artifacts live in installation-private `ASSETS` keys under
`fp5-system/<job>/<attempt>` rather than becoming canonical business Files. Their
transport is bound to the exact declared R2 namespace. Rotation cannot silently
reinterpret an old key. Paused jobs, available outputs and accepted unfinished
recoveries retain their sources; settled eligible cleanup releases only its own
holds. Portable relocation evidence can make an old physical root optional only
when its exact alias/consumer closure leads to a verified available terminal
payload. Unknown/manual consumers and unfinished imports remain conservative.

## Website recovery and destination verification

The system page is `/settings/data/system`; its privileged API is
`/api/system-recovery`. It exposes capabilities, backup preview and creation,
explicit executor enable/disable, upload intent and raw upload, separate upload
validation, recovery preview, staged recovery, progress, pause/resume/retry/cancel,
cleanup, archive/report downloads, maintenance and assisted cutover receipts.
Execution is disabled by default. Ordinary capability responses contain no private
jobs, source evidence or protected values.

Management requires verified Access authentication, `AUTH_MODE=access`, the
application email admission and the separate `SYSTEM_ADMIN_EMAILS` allowlist.
Disabled authentication never grants system administration. Actor-bound request
IDs bind the exact input digest and return durable receipts. The browser stores
pending request identities for reload reconciliation, validates closed responses,
and polls status without executing work. A resumed upload requires reselecting
the original file and matching its full-byte hash and size. Privilege loss clears
private client state.

An operator must provision an isolated `RECOVERY_DB` and declare its
`RECOVERY_TARGET_ID`. Freshness permits an empty database or only the exact
reviewed schema, seed state and platform definitions. Any present migration ledger
must be empty or the exact complete reviewed ledger; publication installs the
separate code-owned target ledger.
Installation markers and a persistent random target challenge detect source
aliasing independently of JavaScript binding object identity. Unknown platform
DDL and attached platform objects reject admission. Target claims bind the job,
incarnation, target ID, image/schema digests, owner token, generation and lease;
every target mutation rechecks this ownership and source/target binding identity.

Canonical business and File IDs, history, rowids and source provenance survive
restore. New Files are limited to reviewed conversions of genuine NULL legacy
bindings across all 13 consumer slots. Cyclic row graphs publish atomically with
foreign keys enabled and deferred. Schema, indexes, triggers, rowids, foreign-key
checks and all typed rows are verified against the reviewed image. Every allowed
difference is classified as an explicit binding/remapping, authority quarantine
or derived reconstruction; unknown differences fail verification. Retired or
unknown purposes remain opaque, and imported previews do not acquire fabricated
trusted-cache status.

Mappings name already admitted writable R2/S3 profiles with frozen namespace,
revision and transport identity. Archive data does not select arbitrary provider
credentials or endpoints. Needed destination registration/runtime/admission and
profile-owned history are frozen and preserved as a reviewed metadata closure.
Source history remains exact. Local encrypted credential/native-binding state
does not become target execution authority. Provider binding or envelope changes
invalidate the frozen transport before the next request.

Writes use registered fresh `fp5-recovery/<incarnation>/<digest>` keys, including
same-bucket recovery. They never overwrite or delete source bytes. Each key is
registered before PUT, and publication requires complete independent GET/hash
proof. An unknown PUT acknowledgement is not replayed. Retry can reconcile it
only through a positive full-byte read at that same immutable key; an unavailable
or negative observation leaves it unsettled. Final verification rereads every
destination payload and reconstructs source remap/alias/binding evidence.

## Protected configuration and the handoff boundary

Privileged native capsules include encrypted storage configuration revisions,
descriptors, credential payloads, key IDs, checks, audits and reenvelope history.
Environment root keyrings, Access configuration, admin lists, native bindings,
local runtime incarnations and cleanup grants remain installation-local and are
excluded. Imported protected history is quarantined. Canonical historical
runtime/admission values remain accurate; execution is disabled through local
guards and absent grants/bindings, not by rewriting that history. Operators must
separately supply/review root keys, external credentials and fresh provider
admission. Legacy content capsules declare protected configuration unavailable.

Maintenance is `open → draining → fenced`. HTTP mutators obtain a request-local
persisted lease on their first database execution or object-storage call; input
validation and authorization still run before storage work. Existing scheduled
writers obtain a persisted lease for their whole callback. Both are admitted
only while open. Safe reads, including exact SELECT-only shadow POST helpers,
remain available. Candidate-check status reads suppress their incidental
reconciliation UPDATE atomically while draining or fenced.
An installed fence is enforced even after deployment activates the restored DB
without retaining a secondary target binding. Expired leases are diagnostic,
not proof that an unknown writer ended. Outstanding writes must be positively
settled or cancelled. Explicit release of an existing fence does not require
secondary target configuration.

Running candidate checks, running cleanup and candidate PUTs with an unknown
outcome also prevent finalization. In the existing FP2 check protocol, even an
acknowledged deletion followed by a negative read cannot turn a retired unknown
PUT into positive settlement. Such retained history conservatively blocks a
planned handoff; FP5 does not invent a settlement endpoint or age it away.
If a check times out after draining begins, reconciliation remains suspended;
the operator must release maintenance, reconcile and settle it, then re-enter.

A planned final backup requires a drained fenced source. Its semantic checkpoint
includes canonical/protected state and actual migration observations, excluding
local controls, read holds and only that exact backup's own export holds. Other
backup capture and canonical hold release are guarded against changing the sealed
checkpoint. Cutover recaptures the source, verifies the unchanged window and final
backup, and fully reverifies the target within a bounded 60-second action. Local
deadline/abort checks and atomic receipt predicates prevent late read completion
from recording a successful handoff. Maintenance token/generation, source leases,
job ownership and checkpoint remain receipt guards.

Historical recovery displays its point and requires acknowledgement of later
source-change loss. Staging can occur while the source remains open; handoff
still requires a drained fenced source. `cutover: true` means a reviewed handoff
receipt is prepared. It does not provision resources, change deployment bindings,
switch traffic or release writes. The operator reviews target identity, bindings,
keys, providers and checkpoint, activates the deployment, verifies authenticated
reads, then explicitly enables writes and any newly reviewed jobs. The source
remains available for reads. Rollback after new target operational writes requires
reconciliation; maintenance release alone never routes traffic.

The downloadable recovery report gives counts, checkpoint/hash evidence,
table/column/reason difference groups, disabled capability state and operator
steps. It contains no raw before/after protected cells or credential values.
Full typed audit differences remain private engine metadata.

## Historical conversion and independent offline restore

The existing ordinary content export and isolated legacy restore remain available.
The converter uses their frozen V7–V23 admission and an additive current V24 path,
then applies only a hash-pinned code-owned forward migration chain. Original ZIP
bytes, original observed schema and retired-field artifacts are retained offline.
V7 declares absent original schema evidence; later versions preserve their actual
evidence. Canonical IDs survive conversion. Only originally recorded physical
consumer rowids can be historical rowid evidence; unrecorded rows receive the
reviewed local restore's rowids. Legacy protected settings remain excluded, and
all recovered operational authority is inert. The old content reader's own
archive limits remain distinct from the smaller FP5 output caps.

```sh
node scripts/convert-system-backup.mjs \
  --archive /path/content-backup.zip \
  --destination /path/new-conversion-directory

node scripts/restore-system-backup.mjs \
  --archive /path/system-backup.zip \
  --destination /path/new-offline-recovery-directory
```

Both commands require an exclusively new output directory. The standalone system
restore uses local Node SQLite and the shared streaming archive validator, without
a website or provider. It creates private output permissions and retains the
original capsule, admitted manifest/records/reports, local payload files, a source
byte inventory, reviewed target migration evidence and a recovery report. One
local SQLite transaction installs only code-owned DDL, inserts exact typed cells
and rowids, then checks foreign keys, integrity, schema and image equality. It
does not inherit the website's 128-statement D1 batch constraint; all shared
capsule, typed-row and metadata admission limits still apply.

The offline database starts fenced with execution guards disabled. It keeps
original physical source addresses as inert metadata;
local payload mappings are separate. It performs no provider remapping, provider
activation or deployment handoff. Original source migration observations stay in
records; reviewed target migration evidence is a separate artifact. The resulting
private SQLite/database-and-files directory requires operator deployment design
and review before serving traffic.

An optional local target binding can be generated without provisioning or
deploying a resource:

```sh
node scripts/generate-wrangler-config.mjs --local \
  --local-recovery-target fp5-local-target
```

Ordinary `config:local` omits this secondary target unless explicitly requested.
Production configuration accepts a complete optional recovery DB name/ID/target
group and rejects source aliases; actual resources and activation are operator
operations. Local `AUTH_MODE=disabled` remains insufficient for system management.

## Final local development qualification

All twelve exact canonical CI leaves passed. Documented mixed-fingerprint staged qualification: verification-scripts passed at AA aa945573019d5175677f975e3015cbc677d1db66e6600804482bb0b41f25b772; only three independently reviewed test fixture files changed afterward. The other eleven leaves passed freshly at the final fingerprint below. The pre-completion manifest proves all 1,235 other repository paths were unchanged during qualification; these documentation updates follow qualification. Independent dependency review confirms those fixtures are outside the retained script leaf. Original per-leaf fingerprints, records and logs are preserved; earlier failed runs and the passing pre-interoperability checkpoint remain separate.
Final full-tree source fingerprint (source and ten other freshly run leaves):
`d82270c2ef2f9e1395734811abe6500460184cc50ba51822c2c67b311fb25e1f`.
Heavy native runners were serialized. Results, stage fingerprints and durations
are recorded in `/tmp/fp5-canonical-results.json`; no status was published externally.
Source: 364 files / 3291 tests.
Mounted UI: 81 files / 698 tests.
Verification scripts: 351 cases and dependency ownership
for 104 shared production files.

| Required leaf | Final result / evidence |
| --- | --- |
| `npm run test:verification-scripts` | PASS — 613.74 s; `/tmp/fp5-canonical-verification-scripts.log` |
| `npm run test:source` | PASS — 1660.98 s; `/tmp/fp5-canonical-source.log` |
| `npm run test:reference-mounted` | PASS — 105.69 s; `/tmp/fp5-canonical-mounted.log` |
| `npm run test:rich-text-bundle` | PASS — 1.12 s; `/tmp/fp5-canonical-rich-text.log` |
| `npm run typecheck:export-contract` | PASS — 1.31 s; `/tmp/fp5-canonical-export-contract.log` |
| `npm run typecheck:file-jobs-node` | PASS — 1.06 s; `/tmp/fp5-canonical-file-jobs-node.log` |
| `npm run verify:d1-migrations` | PASS — 20.21 s; `/tmp/fp5-canonical-migrations.log` |
| `npm run verify:reference-worker` | PASS — 40.69 s; `/tmp/fp5-canonical-reference-worker.log` |
| `npm run verify:reference-search-worker` | PASS — 36.10 s; `/tmp/fp5-canonical-reference-search-worker.log` |
| `npm run build` | PASS — 7.26 s; `/tmp/fp5-canonical-build.log` |
| `npm run test:project-map-bundle` | PASS — 0.92 s; `/tmp/fp5-canonical-map-bundle.log` |
| `npm run verify:project-worker-artifact` | PASS — 39.92 s; `/tmp/fp5-canonical-project-worker.log` |

| FP5 acceptance area | Final result / evidence |
| --- | --- |
| Closed archive/image/V24 contracts; malformed archives; partial and budget outcomes | PASS — full source gate; shared contracts/image/archive tests and snapshot/partial/CRC/budget cases |
| Nonempty native D1 + R2/S3 isolated fixture round trips; all purposes and 13 slots | PASS — native R2→S3→rebackup→fresh R2; host actual V8 conversion covers all 13 consumer slots; actual local Wrangler list/apply no-op |
| Unknown PUT/readback, retention/GC, target freshness/alias/ownership, transport changes | PASS — target-engine faults and core runtime; 53 focused retention/GC cases plus 5 actual native GC cases |
| Protected-cell quarantine, exact rowids/int64, derived projections and safe report | PASS — exact typed image, native signed rowids/REAL/BLOB/NUL and quarantined configuration; sanitized report/client checks |
| Maintenance/scheduled-writer races, sealed checkpoint capture/cleanup, bounded cutover | PASS — final source gate covers maintenance admission, candidate-read fencing, unknown-writer drain and core/routes deadline/checkpoint faults |
| Auth/capabilities, mounted upload/recovery/reload/receipt reconciliation | PASS — client 17 cases, mounted system page 18 cases; full mounted gate |
| Legacy V7/V8/V15/V23/V24 conversion, standalone exact restore and refusal cases | PASS — converter 7 and independent offline restore 2 cases; full historical source gate |
| Repeated recovery and rebackup, with transport/operator boundary recorded | PASS — native and converted legacy second-target restores; qualified recovered legacy media reads and canonical State reuse; pre-handoff source transport only |
| Original 20 SQL hashes, V7–V23 behavior and actual local DB data/ledger preservation | PASS — exact old 103 tables / 31 rows with cell types and rowids; original 20 receipts and SQL hashes preserved; canonical historical gate |
| Independent read-only review and issue closure | PASS — independent initial review and final frozen-source review; concrete issues corrected and qualified |

Approved immutable artifact identities:

| Artifact | SHA-256 |
| --- | --- |
| `0021_fp5_system_recovery.sql` | `834df694d90705962b6a8d81e97b0c1cf9b4514ff270f954e29d2080b596a3e1` |
| `0022_fp5_recovery_evidence.sql` | `b637e7e901168e11276b76040cd0a1c45693884a35ad35b5279527e54609ee48` |
| Current V24 content schema | `81fe9ecaeb50ef90be66455c946bedd7c6a0d5ed41508b223805967da022df16` |
| Code-owned recovery catalog | `7783c42f0259f6b9b857a0e2860d4c754638faaa8e13500a4cd9ab953555f3d8` |

The actual development DB is on `0022`, with the exact 119-table application
inventory, no foreign-key violations and `quick_check=ok`. Its original 103
application tables retain every cell, SQLite type and physical rowid across all
31 baseline rows. The original 20 full migration receipts and raw SQL hashes are
unchanged. Historical main DB bytes are unchanged. File mode remains `legacy`,
all execution guards are disabled and the development maintenance state is open.
The newly restored offline/native targets separately start fenced.
Proof: `/tmp/fp5-development-baseline/local-data-qualification.json`; actual local
migration log: `/tmp/fp5-root-local-migration-qualification.log`.

Earlier focused runs exposed actual native D1 compound/expression compilation
limits, SQL comment presentation differences, repeated view compiler memory use,
current-V24 live-shadow admission, request validation/maintenance admission,
GET candidate-check reconciliation, repeated R2-bootstrap/native-migration/Project-copy migration setup,
sealed-checkpoint/deadline defects and
recovered legacy alias/State interoperability defects. Recovery media reads and
canonical State reuse authenticate exact immutable recovery evidence while
delivery follows the current usable File. Recovered legacy aliases with no stored SHA, including ready aliases
without current consumers, require that exact evidence before native delivery.
The final code corrects these without raising archive/action bounds or modifying historical migrations
or frozen V7–V23 archive readers. Existing timing-sensitive lifecycle, storage-export, shadow, R2-bootstrap, native-migration and Project-copy
tests retain their original 5-second deadlines; isolated pristine real-migration templates
and connection-local compiled SQL reuse remove repeated setup cost. The initial
focused failures are retained in `/tmp/fp5-*` logs; the documented staged CI plan
above is the passing qualification result. The last AA source run passed 3,288 cases
and recorded three 5-second fixture-setup timeouts, retained separately in
`/tmp/fp5-secondary-fixture-timeout-checkpoint/`; the revised fixtures passed all
12 unchanged cases before the final full source run.

The local repeated-recovery fixture uses freshly admitted source-installation
transport to rebackup the restored database before operator handoff. It does not
establish that an activated restored deployment has independently admitted its
own provider bindings. Real R2/S3 services, deployed Access/runtime bindings,
operator root-key/provider review, target deployment activation, traffic handoff
and post-activation backup/write acceptance remain explicit external/manual
qualification. No local fixture result should be described as production
deployment or complete real-provider handoff acceptance.
