# FP4 native research packages

Status: implementation and local development qualification complete,
2026-10-06 (UTC). The [development goal](./FP4_DEVELOPMENT_GOAL.md) is complete,
and the local development schema is aligned. Formal provider, deployed-runtime
and concentrated manual acceptance remain deferred by the owner.

## Product boundary

Sample and Project pages link to Settings Data. Native data packages pair a
versioned domain snapshot with its required files and an offline HTML/Markdown
reading projection. The matching website importer validates an uploaded package,
shows dependencies, naming and destination roles, then creates a new copy.
Independent report exports are readable outputs; they are not copy-import inputs.
The existing FabuBlox workflow and full backup remain separate workflows.

The native envelopes are `research-package/1` and `research-report/1`, with
`research-records/1` domain records, independent
of D1 migration versions. ZIP members are `manifest.json`, `records.json`,
`report/index.html`, `report/report.md`, and declared `files/` entries. Domain
records use a closed catalog rather than SQL dumps. Required inputs contain no
provider addresses, credentials, expiring URLs or destination account grants.

## Limits and execution

The V1 policy bounds an archive at 100 MiB, packaged File payloads at 96 MiB,
aggregate metadata and reports at 4 MiB, 100 logical File entries, 1,200 domain
records, and 20 roots. Export and import share a 64 KiB per-record admission
limit. A persisted manifest with its ZIP index and the frozen mapped publication
plan each have a separate 1 MiB ceiling. Export preflight checks supported copy
planning before writing a native package. Metadata duplication and ZIP overhead must also fit the complete archive
limit; independently passing the component ceilings does not guarantee that.
The initial source preview is advisory and has no retention holds. Accepted
export capture freezes the actual records and locations; its complete archive
and copy-plan preflight is authoritative and runs before any output write.

The deterministic STORE profile uses bounded 64 KiB chunks, fixed headers and
signed data descriptors. Admission rejects traversal, duplicate or case-colliding
paths, encryption, symlinks, ZIP64, unsupported compression, invalid UTF-8 and
header/central-directory disagreement. CRC and SHA checks cover complete bytes,
including the last payload byte. Browser hashing and Worker object I/O stream
the archive instead of allocating a complete 100 MiB buffer.

Native execution uses the existing installation-local File job guard. A task
continues independently of its browser page. A step performs bounded work within
60 seconds and writes at most one File; no deployed schedule is changed. Provider
targets and accepted policy revisions are immutable. Unknown writes retain their
registered physical candidate and holds until a safe decision is possible.

Publication validates payload bytes before committing the complete business graph
in one bounded transaction. Earlier verified File/location metadata stays held;
it does not expose a partial Sample or Project. The canonical publication plan
has at most 112 statements with room for the runtime and publication fences in a
128-statement transaction. Foreign keys still apply at commit.

## Identity, dependencies and permissions

Business entities, occurrences and operation groups receive fresh destination
identities. Immutable definitions retain their existing content-hash schemes and
are reused only after content and associated media qualify. Recorded actors are
origin provenance. They do not create destination accounts or permissions.

Normal repeated imports resolve their persisted copy decision. Explicitly
requesting another copy allocates a separate identity. The import preview's role
policy version must still match during fresh acceptance. Retrying an accepted
request continues with its original frozen mapping even if defaults changed.
Cancelled copies also retain that decision; creating a new copy requires the
explicit another-copy action. Accepted receipts remain readable after their
upload expires or is cleaned up, without reopening the payload.

Project references include the required source context. A directly referenced
Comment includes its target runs and owning Sample metadata; incidental Common
Comments retain selected targets and explicitly exclude outside contexts.
Definitions do not expand to unrelated consumers. Missing or deleted references
retain explicit unresolved provenance rather than becoming false live sources.
Pending or failed source imports are not native copy inputs. Project history,
placements, sequence watermarks and attachment subtypes are checked before fresh
IDs or provider writes. Historical preview and derivation claims survive copy
and re-export as provenance; they never become trusted destination caches.

Ordinary authorized research actors can export and copy-import. Enabling the
installation executor remains an administrator operation. Native packages need
qualified active File authority and available role destinations; the local
development database retains legacy authority and disabled execution.

## Full backup and offline recovery

Additive migration `0020` introduces package staging, requests, identity maps and
publication evidence. Full archive V23 preserves that history and its source
installation identity. Disposable package output bytes have an explicit
`excludedOutputs` inventory, which prevents recursive backup growth. Independently
referenced outputs and uploaded archives needed by unfinished imports stay in the
byte plan.

Migration `0020` SHA-256 is
`0dc7a2248a06a434cf92ca7f647bab4c50ad7f6419c792d10ec13b05b94c44b4`.
The native current-schema fingerprint is
`f889414ca16d103fa92756ecd7bc5067bd634f723a5ad28b3ee89619781d5f35`.
All original migration bytes and historical V7–V22 fingerprints remain frozen.

Matched offline recovery preserves audited cells, rebuilds installation execution
disabled and retains no cleanup grants or credential bindings. Historical V7–V22
validators, planners and fingerprints remain separate. Website privileged system
recovery is FP5 work.

## Local qualification

The implementation has passed complete-byte and hostile-archive checks,
client/protocol and mounted UI checks, durable backend and publication checks,
and nonempty cross-provider round trips. Qualification uses the exact twelve
leaf checks from `verificationPlan('ci')` in serial stages. The verification
scripts passed 349/349, followed by the unchanged shared boundary over 95 source
files. All ten leaves after source passed, including 80 mounted test files with
680 cases, types, migrations, runtime smoke checks, build and production-artifact
verification. The repaired complete source leaf passed all 347 test files and
3,144 cases in 1,405.78 seconds. Its exact command was:

```sh
XDG_CONFIG_HOME=/workspace/.config WRANGLER_SEND_METRICS=false \
VERIFY_PUBLISH_STATUSES=0 VITEST_MAX_WORKERS=2 npm run test:source
```

The two Vitest workers bound concurrent native fixtures on this four-CPU
development environment. Selected tests, admission limits, runtime budgets and
test timeouts are unchanged. GitHub status publication stays disabled.
Evidence is `/tmp/fp4-source-final.log`, `/tmp/fp4-source-verification-results.json`,
`/tmp/fp4-remaining-ci.log` and `/tmp/fp4-remaining-verification-results.json`.
The earlier monolithic `npm run verify:ci` failed and is retained separately in
`/tmp/fp4-final-ci.log`; it is not reported as a successful monolithic run.
Focused logs named below are local development evidence, not committed artifacts.
The final staged aggregate is `/tmp/fp4-staged-verification-results.json` and
`/tmp/fp4-staged-verification-summary.md`:

| Canonical check | Command | Outcome | Duration (ms) |
|---|---|---|---:|
| verification-scripts | `npm run test:verification-scripts` | PASS | 503974 |
| source | `npm run test:source` | PASS | 1406693 |
| mounted | `npm run test:reference-mounted` | PASS | 97566 |
| rich-text | `npm run test:rich-text-bundle` | PASS | 601 |
| export-contract | `npm run typecheck:export-contract` | PASS | 1360 |
| file-jobs-node | `npm run typecheck:file-jobs-node` | PASS | 446 |
| migrations | `npm run verify:d1-migrations` | PASS | 17952 |
| reference-worker | `npm run verify:reference-worker` | PASS | 30389 |
| reference-search-worker | `npm run verify:reference-search-worker` | PASS | 26674 |
| build | `npm run build` | PASS | 6695 |
| map-bundle | `npm run test:project-map-bundle` | PASS | 651 |
| project-worker | `npm run verify:project-worker-artifact` | PASS | 31121 |

R2→S3, S3→R2 and S3→a different S3 profile passed the shared nonempty Sample
and Project fixture. It contains 97 records, 15 logical Files, all 13 File
bindings, all nine reference kinds and 11 Project placements. Checks cover
complete payload bytes, exact alias metadata, frozen role destinations, normal
retry reuse, fresh another-copy identities, report parity and untrusted preview
provenance across two copy generations. Corrupt input and late SQL failure
preserve graph atomicity; verified payloads survive a retry without another PUT,
and dependent imports prevent premature upload cleanup.

The real workerd+D1+R2→S3 flow passed in 39.66 seconds within its unchanged
60-second test timeout. Both databases applied all 20 migrations through native
D1, and the native schema fingerprint matched. File authority and S3 candidate
admission follow their actual guarded paths. Its isolated S3 transport checks
native signed requests and hashes received PUT bytes independently. A competing
activation loses its CAS without provider I/O or altering the winner's binding
and retained history. Evidence: `/tmp/fp4-roundtrip-native-balanced.log`,
`/tmp/fp4-roundtrip-critical-domain-v23.log` and
`/tmp/fp4-roundtrip-host-remaining.log`.

Both completed histories also qualified as V23 snapshots. The production backup
blob route generated an actual nonempty V23 ZIP, and the matching S2 offline
restore preserved every canonical table's cells and identifiers, passed foreign
keys and left execution disabled. Negative checks reject a missing provenance
record, a paused publication owner, an invented R2 asset key and forged output
exclusions. Historical V22 recovery remains qualified separately.

Native source capture uses six statements for its snapshot and retention.
Readonly preview computes exact per-kind counts and safe context summaries in
one fresh-primary D1 batch. Native qualification checks both ordinary and rejected
sources, atomic rollback and the actual 1 MiB D1 cell boundary. SQL remains within
D1 expression, compound-query and statement-size limits; no safety guard or
runtime limit was increased to make these checks pass.

Native workerd/R2 streaming qualification exercised a 96 MiB payload in a
100,664,033-byte ZIP. Full admission read exactly two complete ZIP streams; the
largest hash chunk was 65,536 bytes. Evidence:
`/tmp/fp4-archive-native-max-budget.json`. Host process memory observations are
not measurements of workerd heap use or deployed-provider performance.

Self-review additionally resolved equal-timestamp attempt ordering, unknown-write
retry safety, stale-owner maintenance races, cleanup starvation, cancelled-copy
receipt reuse, permission revision races, offsetless SQLite retention timestamps,
Unicode input admission, Project restore invariants and oversized advisory-count
display. Reconfiguring the executor pauses older accepted jobs for explicit
owner resume; recovery never restarts them automatically.
The complete gate also exposed stale current-chain recovery assertions and a
domain-to-contract type dependency in report rendering. Current-target tests now
include `0020`/V23 while historical source fixtures stay frozen; report rendering
consumes its own structural domain projection. The existing dependency boundary
remains enforced without an exception. The repaired boundary and all 16 focused
format/report checks passed. A current-version route assertion now expects V23,
and a nested package fixture restores the enclosing fixture's fetch and stream
globals; both repaired files passed all 18 focused cases.

The native R2 regression also exposed the installed workerd SQLite compiler
opcode ceiling: whole-schema `PRAGMA quick_check` exceeds the last supported
allocation after `0020` and reports `SQLITE_NOMEM`. The test now checks every
installed table and its indexes through native `quick_check(table)`, with exact
table/catalog coverage, unchanged cell/type/int64-rowid and ledger comparisons,
and native foreign-key checks. After workerd closes, a read-only whole check on
the exact persisted native fixture covers global page ownership and unused-page
checks omitted by table checks. The complete 8 MiB native R2 migration, read-hold,
unresolved historical occurrence and GC flow passed in 21.12 seconds with the
original 120-second timeout. No production schema, guard or runtime limit changed.
Evidence: `/tmp/fp4-r2-native-integrity-final.log` and
`/tmp/fp4-sqlite-integrity-opcodes.json`.

An isolated copy of the actual 19-migration development database has applied
`0020`, retained all 96 pre-existing non-ledger tables with their rowids and
cells, retained the 19-entry ledger prefix, and passed foreign-key and quick
checks. It has 20 migrations, keeps File mode `legacy`, and leaves both execution
guards disabled with no package jobs or cleanup grants. The original historical
main database still has its original SHA-256. The live development database has
subsequently applied only `0020` through `npm run db:migrate:local`. All 95
pre-existing application tables retain their exact cells, SQLite types and rowids,
and the first 19 ledger entries are unchanged. Wrangler's internal `_cf_METADATA`
commit counter advanced from 32 to 35; it is not application history. The live
database has 20 migrations, no package history or cleanup grants, and one source
identity. Foreign-key and quick checks pass, File authority stays `legacy`, and
both File authority and job execution guards stay disabled. All 19 original
migration hashes and the historical main database hash remain unchanged. Evidence:
`/tmp/fp4-live-development-migration.log` and
`/tmp/fp4-live-development-db-qualification.json`.

Production deployment, actual provider activation, real production byte movement,
and concentrated manual acceptance are deferred by the owner. Local fixtures
must not be reported as real-provider or deployed-runtime acceptance.
