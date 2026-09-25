# FP1 shadow-conversion preflight checkpoint

Implementation base: merged PR #220, integration head `4248deb5`, 2026-09-25.
[FP1k](./FP1_FILE_AUTHORITY_TRANSITION.md) has installed migration `0007` and
complete archive schema 14 in immutable `legacy` mode. This checkpoint adds an
executable, read-only inspection of the current database and qualification of
the boundaries that the complete shadow writer/resolver must implement.

The four concrete protocol gaps below prevent safely enabling `overlap` merely
by relaxing the installed guards. This checkpoint makes live source evidence
inspectable and defines the missing protocols before provider writes begin.
The complete shadow-conversion requirements remain in force: this checkpoint
does not complete the shadow writer, conversion ledger, FP1, or authority
activation.

## Executable inspection boundary

The local inspection command is:

```sh
npm run inspect:file-consumers -- --database <SQLite file> --output <new JSON>
```

It reads one page from an existing database through a read-only SQLite connection
and publishes a new diagnostic JSON file exclusively and atomically. It never
replaces an existing report. `--limit` selects at most 20 slots;
`--after <CURSOR_JSON>` resumes after the prior report's structured cursor.
The command does not automatically traverse the database.

Input is a **closed SQLite backup snapshot in rollback-journal mode**, with the
complete installed FP1k generation required by the reader. A database whose
header still identifies WAL mode is rejected even if already checkpointed and
no sidecar is present; existing `-wal`, `-shm` or `-journal` files are also rejected.
This avoids opening a live WAL database, creating shared-memory state during a
nominally read-only open, or inspecting data without its required journal.
Use a separately prepared consistent backup snapshot; do not delete journals to
make a live database pass. Output realpath checks protect the database and its
sidecar paths. The CLI is an inspector, not a backup or recovery utility.

An archive JSON file or FP1g planning report is not a database. Inspection does
not apply migrations, register observations,
write decisions, acquire holds, resume accepted operations, access a provider,
change defaults, or move the authority singleton. An inspection of a local
database does not establish the current state of remote D1.

The common service in
[`worker/files/live-consumer-baseline.ts`](../worker/files/live-consumer-baseline.ts)
uses the primary database capability for live D1 reads. A page is read by one SQL
statement, with a maximum of 20 consumer slots, 512 KiB of page evidence and 100
rows per dependency collection. Callers can request smaller evidence limits.
`MAX_LIVE_CONSUMER_SOURCE_ROWS` additionally limits the combined row count of the
11 business source tables to **20,000**, including rows that produce no file
slot. `MAX_LIVE_CONSUMER_SOURCE_KEY_BYTES` limits the combined UTF-8 size of
source cursor/locator fields and event `metadata_json` to **8 MiB** before
materializing the bounded slot index. Source and related metadata are constructed
only for the selected page;
the source-row ceiling still applies even when `--limit` requests one record.
This is a qualification boundary for the initial reader, not a claim of
unbounded-database support. A larger inventory fails closed and requires a
separately qualified indexed catch-up design.

The same primary SQL statement also reads the schema and checks File-registry
rowid claims. Schema qualification has separate fixed internal limits of 1,000
schema objects and 2 MiB of schema JSON, and requires the exact reviewed V14
transition-schema fingerprint. Missing/mixed schema, invalid rowid claims or
an authority singleton other than revision-1 `legacy` fail closed. These schema
limits are independent of the 512 KiB page-evidence limit; the raw schema catalog
does not become report content.

That statement gives one coherent page. Continuation pages can observe different
database states: their concatenation is not an installation-wide snapshot,
conversion cutoff, or permission to execute a conversion. Bounds fail visibly;
truncated dependency evidence cannot silently become a complete baseline.

The inspection preserves typed slot identity, the recorded legacy locator,
relevant source/dependency evidence and a fingerprint for later comparison.
The version-1 `file-consumer-live-baseline` report records `executable: false`,
`bytesVerified: false`, the observed authority state, `schemaSha256`, per-record
and page `baselineSha256` values, and a structured `nextCursor`. Per-record states
distinguish `pending_no_locator`,
`unavailable`, `ambiguous` and `ready_to_verify`; none means byte verification or
conversion has succeeded. Deleted or superseded history can still be eligible
for planning byte verification; that is not permission to convert it or evidence
that the occurrence is currently active. Source/parent lifecycle, related
occurrences,
registries, admitted receipt/profile evidence and same-locator peers participate
in the fingerprint. Exact historical strings, including embedded NUL where the
old schema allowed it, are preserved within the explicit overall bounds. Its
classification and namespace findings remain metadata observations. A source
row hash is not a byte hash, a namespace observation is not provider access, and
the substrate's `expected_purpose` is not proof of historical intent. Missing,
conflicting, pathological, deleted, failed, cancelled, expired, superseded and
pending evidence must remain visible or fail an explicit bound; it must not be
silently discarded to make the report appear complete.

The report is operational metadata and should be handled with its source
database. It is not a public status response. Arbitrary content, credentials,
provider error text and secret-bearing configuration must not be exposed as
diagnostics. Fingerprint inputs and exposed evidence are separate concerns.

[FP1g](./FP1_FILE_CONSUMER_MIGRATION_PLAN.md) remains a frozen V10–V13 offline
archive planner. This command does not relabel V14 data as V13, broaden that
archive contract, or treat a saved plan as execution authority. The older
projection's strict text validation also cannot be used to silently omit
historical identifiers that `0007` explicitly preserves for unresolved decisions.

## Complete 13-slot writer and lifecycle inventory

The implementation obligation is all 13 slots on 11 business tables. A slot
catalog does not imply that every database contains an occurrence of every
kind. Both physical bindings of an ambiguous R2/managed occurrence and unbound
accepted content require diagnostics rather than guessed selection.

| Business table and typed slot | Writers and replay/recovery entry points | Lifecycle and conversion obligation |
| --- | --- | --- |
| `state_representation_assets.file_id` | `worker/process-definition/routes.ts`, `worker/imports/fabublox-routes.ts`, `worker/sample-split-state.ts`, `worker/fabublox-import-recovery.ts` | Preserve the structured state/asset composite key. Diagram intent may establish embedded content; recovery can insert/delete mappings and must preserve occurrence history. |
| `run_step_assets.file_id` | `worker/execution/routes.ts`, `worker/fabublox-import-recovery.ts` | Execution/state-observation images, supersession, deletion and restoration remain represented; asset replacement cannot leave an old typed binding attached to a new locator. |
| `metrology_template_references.file_id` | `worker/uploads/metrology-reference-acceptance.ts`, `worker/process-definition/routes.ts`, `worker/fabublox-import-recovery.ts` | Use admitted operation purpose when available; historical reference intent is not inferred from MIME. Restore/replacement and soft-delete history remain covered. |
| `run_step_comments.file_id` | `worker/evidence/legacy-routes.ts`, `worker/uploads/comment-acceptance.ts`, `worker/comment-submission-routes.ts`, `worker/samples/routes.ts`, `worker/fabublox-import-recovery.ts` | Preserve legacy image occurrences and canonical submission ownership. Clear/restore/recovery paths must follow the occurrence protocol. A canonical comment without a legacy asset is not an invented file occurrence. |
| `state_verifications.evidence_file_id` | `worker/execution/routes.ts`, `worker/samples/routes.ts`, `worker/fabublox-import-recovery.ts` | Verification evidence is embedded content when supported by operation semantics. Existing evidence removal and recovery rebinds need durable release/replacement history. |
| `comment_submission_items.file_id` | `worker/uploads/comment-acceptance.ts`, `worker/comment-submission-routes.ts`, `worker/evidence/retry-maintenance.ts`, `worker/fabublox-import-recovery.ts` | Attachment, illustration and reciprocal preview-pair purposes remain distinct. Pending, cancelled, expired and deleted items and retry ownership stay visible; a preview pair alone is not trusted derivation. |
| `project_content_attachments.file_id` | `worker/projects/service.ts`, `worker/projects/attachment-copy.ts`, `worker/fabublox-import-recovery.ts` | Upload/copy history, Project/content retention and recovery replacement remain covered. Frozen accepted intent may resolve purpose; a copy or matching hash alone cannot manufacture it. |
| `attachment_derivatives.derived_file_id` | `worker/attachment-derivatives.ts` | Preserve source identity, generator kind/version, parameters, trust and retention. Typed publication requires the verified derivation from the usable source File. |
| `events.asset_file_id` | `worker/samples/routes.ts`, `worker/execution/routes.ts`, `worker/evidence/legacy-routes.ts`, `worker/comment-submission-routes.ts`, `worker/fabublox-import-recovery.ts` | Event primary occurrence needs generation/tombstone semantics for locator clearing, restoration and replacement; event row survival does not by itself retain released bytes forever. |
| `events.thumbnail_file_id` | The same event writers; `metadata_json.thumbnailKey` is the legacy slot | Separate occurrence from the primary, even for an equal key. Bind only with verified source/derivation evidence; release ordering must not orphan or falsely trust either slot. |
| `imports.workbook_file_id` | `worker/imports/fabublox-acceptance.ts`, `worker/imports/fabublox-routes.ts`, `worker/fabublox-import-recovery.ts` | Provenance follows frozen import profile/input, staged publication, failed import recovery and original-result replay. Workbook bytes are verified independently. |
| `imports.manifest_file_id` | The same import acceptance, execution and independent recovery paths | A separate provenance occurrence and independently verified object; workbook success does not certify manifest publication. |
| `template_versions.source_file_id` | `worker/imports/fabublox-routes.ts`, `worker/process-definition/routes.ts`, `worker/fabublox-import-recovery.ts` | Direct source-key provenance, pending-import visibility, recovery replacement and retained template history remain covered. |

This table is the business inventory, not an exhaustive SQL call-site list.
Shared R2/managed registration, accepted upload/import ledgers, deduplication,
quarantine, permanent deletion, GC, media reads, export and independent recovery
are cross-cutting participants. The runtime PR must test their behavior with the
same occurrence and operation identities.

## Four protocol gaps demonstrated by the installed code

### 1. Fill-once references conflict with normal occurrence mutation

In [`0007`](../migrations/0007_fp1_file_authority_transition.sql),
`events_file_locator_guard`, typed update/delete guards and
`file_consumer_decisions_owner_guard` freeze the locator and occurrence identity
once a typed binding or terminal decision exists. Event deletion/restoration in
[`samples/routes.ts`](../worker/samples/routes.ts),
[`execution/routes.ts`](../worker/execution/routes.ts) and
[`evidence/legacy-routes.ts`](../worker/evidence/legacy-routes.ts) still changes
`asset_key` and `metadata_json.thumbnailKey`. Sample evidence cleanup also clears
`state_verifications.evidence_asset_id`.
[`fabublox-import-recovery.ts`](../worker/fabublox-import-recovery.ts) replaces
locators and inserts/deletes relational mappings independently of an upload
request. Backfilling while retaining these writes would make normal operations
fail; dropping the fences would let decision evidence drift from the live row.

The next runtime protocol must distinguish the current business slot from an
append-only occurrence generation. Replacement or removal closes the prior
generation with a tombstone/release record and captures the successor, if any.
The old typed File, locator, decision and operation remain auditable. Clearing a
visible event key must release only the intended generation, and restoring it
must reconcile or create the exact successor rather than reactivate stale work.
Primary and thumbnail changes require one guarded batch and explicit dependency
ordering. The same mechanism must cover other mutable slots in the inventory,
including recovery and terminal unresolved occurrences.

Mixed-version ordering is part of that protocol: either a database-enforced
bridge records old-Worker mutations with equivalent semantics, or incompatible
old writers are fenced and retired before binding the affected rows. A trigger
that merely rejects an ordinary deletion is not an accepted compatibility bridge.
The runtime PR must choose and demonstrate the mechanism on actual old-Worker
fixtures before changing guards.

### 2. New holds are invisible to the authoritative deletion path

`file_location_retention_edges` in `0007` includes new File/location holds and
acceptance candidates; the legacy
[`blob-lifecycle/gc.ts`](../worker/blob-lifecycle/gc.ts) and
[`blob-lifecycle/reachability.ts`](../worker/blob-lifecycle/reachability.ts)
use `blob_retention_edges` and the legacy GC ledger. The installed
`file_holds_safety_guard` and `file_location_holds_safety_guard` check the new
location GC ledger, not an already claimed deletion of the legacy source.
A new hold row alone therefore neither protects that source from an old Worker
nor proves that deletion has not begun.

The overlap migration must bridge exact admitted legacy locator/location/profile
identity into authoritative retention. Source selection, mapping and hold
acquisition must atomically reject both legacy and new deleting/deleted states.
Legacy GC claim/reclaim must atomically reject those holds, including under an
old Worker. File-level holds on unpublished Files cannot substitute for explicit
source location/locator protection. A same-key location in another profile cannot
inherit the hold or lifecycle state accidentally.

Register every destination and attempt before PUT. Keep source and uncertain
destination holds through failed verification, missing responses, cancellation
and stale-owner takeover until that exact attempt is safely reconciled. Lease
expiry does not prove remote I/O stopped. Overlap must not turn missing bytes into
deletion permission or release the recorded operational cleanup/Cron controls.

### 3. Accepted candidates and historical conversion need different ownership

`file_acceptance_candidates_receipt_guard` in `0007` accepts only pending
FP1f–FP1j receipts. `file_acceptance_candidates_update_guard` requires full-read
publication of the candidate placement even when a different same-contract File
wins deduplication. Existing accepted-operation services can return a ready
historical result or reuse a legacy winner without writing a new candidate.
These are legitimate legacy outcomes, but cannot simply be relabelled as a ready
File candidate. In addition, immutable FP1a `files` observations can have absent
purpose/hash metadata that the publication guards require exactly.

The next runtime implementation must separate:

- **New pending acceptance:** freeze purpose/scope/profile revision, input and
  candidate identity before I/O. Preserve the current candidate guard by writing
  and independently verifying the candidate even if a later same-contract winner
  is selected. Any alternative that avoids that write requires an explicitly
  reviewed candidate state-machine change with equivalent ownership evidence.
- **Historical accepted-result replay and conversion:** preserve the original
  receipt/result. Resolve its live occurrences through a separate conversion
  operation/attempt ledger; do not reset a ready receipt to pending or fabricate
  an acceptance sidecar that the receipt never owned. Independent recovery uses
  the same conversion checks, including failed/pending history.

A conversion freezes source occurrence/dependency fingerprints, purpose, scope,
destination profile/revision and attempt identity. It rechecks them before
publishing. Transient unavailability, changed baselines and lost leases are
retryable attempt outcomes; they must not be written automatically as immutable
`admitted_unresolved` decisions, which prohibit later binding. Final admitted
unresolved outcomes require an explicit recorded admission and retained legacy
ownership.

Source metadata is not byte verification. Immutable observations remain intact;
when their contract cannot be promoted, create a new File and tracked placement.
For cross-purpose sharing, make independently addressable physical copies and
hash full source and destination bytes before publication. Reuse requires exact
purpose, scope, profile revision, size, hash and usable lifecycle state.
Derivative trust additionally needs the exact generator/version/parameters and
source/output verification; client pairing or equal hashes do not supply it.
Publishing the candidate's own File and completing that candidate as `ready`
must occur in one D1 batch. Typed business bindings and the accepted operation's
visible result must also retain their guarded publication/visibility boundary;
staged import candidates do not bypass the owning import's finalization gate.
There must be no unrecoverable candidate-publication gap between requests.

### 4. Populated overlap is outside the V14 recovery contract

[`export-v14-snapshot.ts`](../worker/export-v14-snapshot.ts) and the
[`export-file-authority`](../shared/contracts/export-file-authority.ts) contract
qualify the exact installed legacy checkpoint: no typed bindings or populated
publication/hold/decision/candidate state. Overlap is a different physical and
archive generation. A migration-only mode flip or a relaxed V14 validator would
either break complete export or misrepresent the recovery promise.

The runtime PR must introduce the successor archive schema (V15), its own final
physical-generation marker and reviewed schema fingerprint, plus populated
source validation and isolated recovery. Capture occurrence generations,
tombstones, attempts, holds, candidate/receipt relationships, publications,
derivation, quarantine and both retention authorities in one consistent database
snapshot. Validate exact ownership and publication relationships rather than
trusting a rehashed manifest.

Recovery preserves this evidence and the recorded authority mode without
performing provider I/O. Restored leases, holds and unfinished operations are
history requiring explicit reconciliation; recovery must not automatically
resume PUT, copying, deletion, migration, or authority activation. V7–V14 readers
remain frozen and upgrades apply reviewed migrations without synthesizing
verified bytes. The deployment sequence must account for old archive Writers and
stale pages as well as old business Writers.

## Next complete runtime PR and acceptance gates

The next **runtime** PR remains the complete shadow writer/resolver and conversion
ledger. This preparation checkpoint does not authorize a subset of consumers to
become authoritative. It must deliver together:

1. The reviewed `legacy` → `overlap` migration and occurrence protocol; all
   thirteen slot writers, accepted-result replay and independent recovery;
   durable source/destination protection visible to legacy GC.
2. Bounded primary revalidation, purpose/profile-bound candidate registration,
   real complete-byte verification and independent cross-purpose copying;
   retryable attempt history, explicit final decisions and atomic publication.
3. A change/catch-up mechanism covering both new and old-Worker writes. Capture
   a durable mutation cutoff; prove the inspected generation is still current
   at the guarded database decision. Repeated pages or a wall-clock timestamp
   alone cannot establish catch-up. Document old-worker retirement and reject
   stale executors, late PUTs and conflicting retries.
4. V15 export/recovery and both SQLite and workerd/D1 qualification on populated
   data. Include normal event delete/restore and thumbnail release; source
   recovery replacement; hold-versus-GC in both race orders; same-key/different-
   profile isolation; candidate cancellation/dedup/lost response; missing or
   corrupt bytes; multi-purpose copies; and restore without provider replay.

Only after that complete shadow graph is caught up and qualified may a separate
atomic activation switch reads, writes, purpose-aware deduplication, retention,
quarantine, deletion and recovery authority together. Activation must fence old
Workers and verify its cutoff in the same authoritative decision. Retirement of
legacy columns/projections follows a later accepted observation and recovery
window. R2 role defaults, basic Settings, FP2 configuration and FP3 jobs retain
their existing sequence.

The PR records the exact executed preflight and qualification results. Local
fixtures are not live uploads, a downloaded complete backup, live SWITCHdrive
qualification or evidence that any operational hold has been released.

## Executed qualification — 2026-09-25

The preflight checkpoint was checked against merged PR #220 (`4248deb5`):

- Core reader and closed-snapshot CLI: **16/16** tests on real host SQLite.
  Coverage includes source/registry hash disagreement, typed pagination with
  composite and historical NUL identities, malformed metadata privacy,
  pending/missing consumers, schema drift, explicit bounds, unchanged input
  bytes, WAL/sidecar refusal and exclusive report publication.
- Native workerd/D1: **5/5** tests using migrations 0001–0007, all 13 slots,
  single-statement primary reads, pagination, dependency/output bounds,
  unchanged tables/schema, source digest changes and rejection of generation
  0006. The isolated legacy-GC fixture also confirms that File/location mapping
  alone does not retain a source after its event locator is legally replaced.
- The complete local `npm run verify:ci` gate passed all 11 stages: **254**
  verification-script tests, **1,717** source tests, **493** mounted tests,
  rich-text and Map bundles, export-contract typechecks, migrations, both
  reference Worker probes, production build and Project Worker artifact probe.
  Worker typecheck and `git diff --check` also passed. Independent CLI/core
  review has no remaining blocking findings within the diagnostic scope.
  This is local evidence; remote CI has not run for this unpublished branch.

These checks do not qualify a runtime conversion. The bounded source scan is
not the later indexed catch-up design; historical metrology purpose remains
conservatively unresolved. Live FP1k acceptance and its unfinished upload/cleanup
checks are recorded separately in the
[FP1k acceptance appendix](./FP1_FILE_AUTHORITY_TRANSITION.md).
