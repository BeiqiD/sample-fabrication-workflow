# FP1k: additive File authority transition substrate

Implementation base: `7e63a366663c47c830120abc77af1d174abaf5aa`
(merged PR #219), 2026-09-14. FP1a–FP1j are merged at that exact
`v2/backend-foundation` head. This implementation PR records its own verification
and deployment evidence; this document does not claim that a later authority
activation has happened.

The completed predecessor chain is exact:

| Slice | Merged result |
| --- | --- |
| FP1a dormant registry / schema 9 | PR #208, `959cd64` |
| FP1b bound byte reader | PR #209, `1f47a81` |
| FP1c verified byte writes | PR #210, `35664cb` |
| FP1d fenced deletion/GC | PR #211, `492b552` |
| FP1e recovery byte verification | PR #212, `9f1ac38` |
| FP1f durable import / schema 10 | PR #213, `0e7d3f6` |
| FP1g read-only conversion plan | PR #214, `9225237` |
| FP1h ordinary/Project acceptance / schema 11 | PR #215, `922749f`; D1 split fix #216, `f3061ae`; restore-timeout fix #217, `c4b2ff6` |
| FP1i metrology publication / schema 12 | PR #218, `13c5f8f` |
| FP1j Comment publication / schema 13 | PR #219, `7e63a36` |

Migration `0007_fp1_file_authority_transition.sql` and complete archive schema
**14**, writer **1**, profile `fp1-file-authority-transition`, add the database and
recovery substrate for a staged File-authority conversion. The installed authority
mode is `legacy`. Guards in this slice make that value immutable, so the existing
locator consumers, retention views, deduplication rules, quarantine and GC ledger
remain authoritative at runtime.

This is an expand-only compatibility step. It does not publish a File or
FileLocation for an existing object, copy or inspect provider bytes, route a read
or write through File authority, change either storage-role default, add Settings,
change credentials, contact R2 or SWITCHdrive, or release any operational hold.
Applying the migration and restoring a schema-14 archive are database operations,
not authorization to perform provider I/O or activate the new model.

## Why the transition is staged

Old and new Workers can overlap during deployment, and existing installations can
contain ambiguous or incomplete historical locator evidence. A safe transition
therefore cannot replace every locator and lifecycle rule in one migration. The
required order is:

1. **Expand in legacy mode.** Install additive authority metadata, typed consumer
   slots and conversion/audit state. Keep old columns, old writes and the existing
   retention/lifecycle projections intact. This PR stops here.
2. **Shadow and catch up.** A later separately reviewed migration/Worker pair
   must replace the legacy-only transition guards and move the singleton from
   `legacy` to `overlap`; that is not part of `0007`. The overlap Worker must
   dual-write the legacy occurrence and its typed File reference for every
   supported writer. A bounded resolver
   must re-read the live database, compare its admitted baseline, freeze purpose,
   scope and destination profile, acquire durable holds, verify full source and
   destination bytes, and record each outcome in a conversion ledger. It must be
   replay-safe and must not infer success from a planning report or metadata hash.
3. **Validate the whole authority graph.** Before activation, every supported
   consumer and direct-key slot must be resolved or carry an explicit admitted
   unresolved outcome. File purpose, scope, profile, active verified location,
   retention, quarantine, deletion fencing, recovery and deduplication invariants
   must agree. Shadow writes and old-worker writes must be reconciled through the
   same captured cutoff. Before the overlap implementation is approved, its
   activation contract must also choose and test one explicit policy for those
   admitted-unresolved rows: either a named legacy-read compatibility path remains
   authoritative after activation, or activation requires their count to be zero.
   `0007` deliberately makes neither choice.
4. **Activate atomically.** Only a subsequent separately reviewed
   migration/operation may move the singleton from `overlap` to `active`. It must
   fence old Workers, prove the catch-up cutoff is current in the same database
   decision, and make File-aware reads/writes/lifecycle rules authoritative
   together. There is no per-route partial cutover and no silent provider fallback.
5. **Retire compatibility later.** Legacy locator columns and projections remain
   until an accepted post-activation observation window, rollback/recovery proof
   and explicit retirement migration. Activation alone does not delete legacy
   metadata or provider bytes.

An old Worker is therefore safe on the business data paths created here: it keeps
reading and writing the columns and views it already knows, while the new
tables/columns have no runtime authority. This does not make an old archive
writer compatible with the new physical generation. Immediately after `0007`
lands, an already-loaded V13 page or old Worker requests schema 13 from a schema-14
database; the old V13 Worker returns 500 from `/exports/all` rather than
mislabelling that snapshot. Conversely, a File-aware Worker must fail closed unless the mode and
schema it expects are present; it must not treat the mere existence of `0007` as
activation.

### Deployment ordering and export availability

The repository's normal package deployment is migration-first. With that order,
there can be a short interval after `0007` and before the schema-14 Worker is live
where ordinary application reads and legacy writes remain compatible but complete
export returns 500. Once the new V14 Worker is serving, stale V13 pages receive a
409 archive-version conflict and must refresh before retrying V14. An
incomplete or mixed physical migration returns an internal error before any
snapshot is read.

If Worker deployment fails after `0007` succeeds, treat the result as a
forward-only deployment incident. Do not roll back `0007`, relabel schema-14 data
as V13, or attempt an old-format complete export. Keep the still-compatible
business paths available, retry deployment of the exact reviewed V14 Worker, then
verify that a V14 export succeeds and a stale V13 request receives 409. A failure
to deploy the new Worker can make the export outage longer than the normal short
window; recovery is completion of the V14 deployment, not schema downgrade.

If uninterrupted export is a release requirement, do not claim it from this
single package rollout. Use a separately reviewed two-stage bridge: first deploy
a Worker that understands both pre-`0007` and post-`0007` generations without
changing the browser's requested archive, then apply the migration and deploy the
V14 front end/Worker. That bridge is not implemented by this slice. In either
order, no schema mismatch may be downgraded to a best-effort or partially labelled
archive.

## Consumer and lifecycle boundary

The additive schema covers the complete inventory identified by
[FP1d](./FP1_FENCED_BYTE_DELETION.md#next-authority-transition-complete-inventory)
and projected by [FP1g](./FP1_FILE_CONSUMER_MIGRATION_PLAN.md):

- relational file occurrences for structures, executions, metrology, Comments,
  verification evidence, Projects and derivatives;
- direct-key occurrences for timeline events, thumbnails, import workbook and
  manifest provenance, and template-version sources;
- the accepted import, ordinary/Project upload, metrology and Comment operation
  histories introduced by FP1f–FP1j;
- storage profiles, logical files and locations, legacy mappings, retention
  reachability, quarantine, GC/deletion fencing and independent recovery.

Migration `0007` installs the following exact expand-only surfaces:

| Surface | Legacy-mode meaning |
| --- | --- |
| `file_authority_control` | Migration-owned singleton: `mode='legacy'`, revision 1. Insert, update and delete guards prevent runtime transition in this slice; later modes are named `overlap` and `active`. |
| `storage_profile_runtime` | One read-only companion for each historical storage profile. The seed trigger keeps new dormant profile observations paired; updates and deletes are forbidden. |
| `file_registry_rowid_claims` | Internal, rebuildable claims for the four older FP1a registry tables' local hidden rowids. They preserve immutable identity under SQLite replacement writes without rejecting valid historical or newly allocated negative rowids. |
| Typed consumer columns | Nullable File FKs on the 11 real consumer tables, including separate event image/thumbnail and import workbook/manifest slots. Every existing row remains null. |
| `file_location_publications`, `file_publications` | Future full-read verification and active-location publication evidence. Both are empty and non-authoritative in legacy mode. |
| `file_holds`, `file_location_holds` | Future operation-scoped File and location protection. Empty here; they do not yet extend legacy retention. |
| `file_location_gc_ledger`, `file_location_integrity_quarantine` | Future location-scoped cleanup and integrity evidence. Empty here; the existing locator ledgers still govern runtime cleanup. |
| `file_derivations` | Future source-File/output-File derivation and trust evidence. Empty here; hash equality does not create a trusted derivation. |
| `file_consumer_migration_decisions` | Future typed `resolved` or `admitted_unresolved` decision ledger. The schema does not make or backfill decisions. |
| `file_acceptance_candidates` | Future purpose/scope/profile-bound sidecars for FP1f–FP1j receipts without changing those frozen receipt schemas. No receipt is backfilled here. |
| `file_usable_publications` | Internal fail-closed join of a ready File and its exact active, available location. Typed bindings and reuse must use this view rather than existence of a File/publication row alone. |
| File consumer/retention/location views | Read-only projections over the nullable slots and future state. In legacy mode they do not replace `blob_retention_edges`. The legacy bridge joins through `legacy_file_mappings.location_id`, preserving exact storage-profile/location identity rather than aliasing equal object keys across profiles. |

`0007` does not rebuild or reinterpret the FP1a `files` and `file_locations`
tables. Their original observation rows remain immutable and `unresolved`; future
full-byte readiness and active-location state live in the two publication
sidecars. This keeps the physical meaning seen by an old Worker stable while a
later overlap Worker builds separately guarded authority evidence.

The exact nullable consumer slots are:

| Business table | File slot columns |
| --- | --- |
| `state_representation_assets` | `file_id` |
| `run_step_assets` | `file_id` |
| `metrology_template_references` | `file_id` |
| `run_step_comments` | `file_id` |
| `state_verifications` | `evidence_file_id` |
| `comment_submission_items` | `file_id` |
| `project_content_attachments` | `file_id` |
| `attachment_derivatives` | `derived_file_id` |
| `events` | `asset_file_id`, `thumbnail_file_id` |
| `imports` | `workbook_file_id`, `manifest_file_id` |
| `template_versions` | `source_file_id` |

`file_consumer_projection` unions separate relational, content and direct-key
projections, preserving the untouched locator beside the nullable File slot.
Its `expected_purpose` is diagnostic input for the later resolver; it does not
resolve historical ambiguity or authorize publication. File retention and active
location views are likewise inert while all typed slots/publications are empty.

Typed business foreign keys remain the authority target. A generic owner string
does not replace the real occurrence identity. During legacy mode, any new File
reference slot is shadow metadata only and must not make a byte reachable, reusable
or deletable. Null means not yet resolved; it does not certify that no file exists.
The later resolver must preserve deleted, failed, cancelled, expired, superseded
and pending history rather than projecting only currently visible rows.

The next PR after this substrate is the **shadow writer/resolver and conversion
ledger**, not final cutover. It must cover every current writer and consumer class,
including accepted-operation replay and independent import recovery, before an
activation PR can be proposed.

### Latent-state safety rules

The new authority and evidence tables are `WITHOUT ROWID`, so SQLite's hidden
`rowid` conflict target cannot bypass their immutable identity guards. The four
older FP1a registry tables retain rowids; `0007` snapshots every occupied value
into `file_registry_rowid_claims`, then claims each final rowid after future
inserts. Reusing an occupied hidden identity aborts the complete replacement
statement and restores its implicit delete, while ordinary and explicit new
negative rowids remain valid. The 11 legacy consumer tables separately fence
`INSERT OR REPLACE`, `UPDATE OR REPLACE`, delete, hidden-rowid conflict and
locator-only mutation once a typed File binding or terminal migration decision
exists. A later overlap writer must not weaken those fences to make backfill
easier.

A terminal consumer decision copies the exact pre-existing occurrence identity
and locator evidence. Its legacy TEXT evidence is intentionally not narrowed to a
new length/character subset: otherwise a long identifier, embedded NUL, or a
managed-provider value already valid under S2 could never receive an explicit
`admitted_unresolved` outcome. New operation IDs, reasons, hashes and lifecycle
timestamps keep their strict bounds; all new authority timestamps are parseable,
bounded and NUL-free. `storage_profile_runtime.registered_at` is the sole
historical exception because it exactly mirrors the older unbounded
`storage_profiles.created_at` contract.

Publication is usable only when a ready File owns the same full-read-verified
active location, the File publication is not earlier than the location
publication, the profile is not retired, and neither legacy nor new quarantine/GC
state blocks the exact location. Legacy mapping is location-bound, so equal
provider keys in two storage profiles cannot merge their lifecycle state. File
retirement and location GC are active-mode-only operations; overlap cannot retire
a File or enqueue a mapped, active, retained, held, candidate, quarantined,
deleting or deleted location. Hold release, GC retry/completion and quarantine
evidence have monotonic and internally consistent timelines.

An `attachment_derivatives.derived_file_id` binding additionally requires a
verified derivation from the attachment's usable source File. The proof must match
the legacy derivative kind and generator version exactly; hash equality or a
different generator/version is not substitutable evidence.

Acceptance candidates bind one immutable durable receipt item to an exact
purpose, scope, profile, File, location, key, size and hash. Readiness requires
full-read publication of the candidate placement and either that exact File or a
usable deduplication winner with the same contract. Cancellation is terminal and
is rejected after candidate File publication; neither cancelled nor losing
candidate bytes become usable File authority. Candidate history cannot be
deleted, and an in-flight candidate is a retention edge; only a terminal unused
location can later qualify for active-mode GC. The future writer must publish the
same-candidate File and transition
the candidate to `ready` in one D1 batch: if either statement fails, the batch
must roll back. Separate requests would leave an unrecoverable published candidate
if availability changes between them.

Events need one more overlap-specific rule before typed backfill. Because an event
can encode both asset and thumbnail occurrences in mutable row/JSON metadata, the
next migration must define an occurrence tombstone/release protocol and mixed-old-
Worker ordering first. Backfilling the two typed slots without that protocol would
turn the current locator/delete fences into permanent, ambiguous retention.

## Purpose separation and verified copying

File identity is not a content hash. Reuse is allowed only when purpose, scope,
exact destination profile revision, verified SHA-256, byte size, active usable
location and lifecycle state all satisfy the File storage contract. The current
global-SHA legacy behavior remains unchanged while authority mode is `legacy`; it
must be replaced with the complete lifecycle cutover, not selectively weakened by
this migration.

A single historical locator may have consumers with different purposes. Those
purposes cannot be made independent by pointing multiple logical Files at the same
physical location. The conversion must retain one admitted source, create a
separate destination placement for each independent purpose where required, hash
the complete source and destination bytes, and publish only the verified copy.
Filename, MIME type, a legacy expected hash, provider `stat`, an acceptance receipt
or the FP1g proposal is insufficient. If bytes or namespace evidence cannot be
verified, the occurrence remains explicitly unresolved and legacy-owned.

Provider absence is an integrity outcome, not deletion permission. Failed or
uncertain copies keep their holds and source reachability; cancellation cannot
turn a late completion into an active location. Cleanup remains fenced by the
existing lifecycle ledger until the later authority transition qualifies the
corresponding File/location behavior.

## Schema-14 export and recovery

The complete export advances to schema **14**, writer **1**, profile
`fp1-file-authority-transition`. It preserves the new additive tables, typed
reference slots and installed authority mode in the same D1 snapshot as all prior
canonical rows and lifecycle projections. Schema 14 describes an installation in
`legacy` mode; an export is evidence, not an executable conversion plan.

The V14 validator freezes that exact expand checkpoint: every typed consumer File
FK is null; publication, hold, location-GC, integrity-quarantine, derivation,
migration-decision and acceptance-candidate tables are empty; the control singleton
is revision 1 in `legacy` mode; and each storage profile has one matching
`read_only` runtime companion. The new projections are exported, but the blob
catalog still describes legacy physical locators because no File location has been
published. A database in later `overlap` or `active` mode requires a successor
archive schema rather than weakening V14 validation.

Hidden rowids are local physical identities, so their claim rows are not portable
archive records. The source snapshot verifies in the same D1 batch that claims
and all four registries have exact bidirectional coverage. Isolated recovery
loads the portable registry rows, rebuilds claims from the restored local rowids
while guards are temporarily removed, verifies the rebuilt set, and only then
reinstalls the reviewed triggers.

Before snapshotting, the route runs one bounded generation-marker probe covering
the selected migration markers and typed columns from schemas 8 through 14. A
complete but different known generation returns an archive-version conflict;
partial or mixed marker sets fail before snapshotting. V14 also fingerprints the transition-
relevant `sqlite_schema` catalog after deterministic SQL normalization, including
tables, views, indexes and triggers owned by those surfaces. The source validator
and isolated restore recompute the same fingerprint, so a forged view-owned
trigger, implicit-index-shaped row or extra object field cannot be hidden by
rehashing the manifest. The V14 completion trigger is a marker for this exact
physical generation only. Every later archive schema must introduce its own
generation marker and reviewed fingerprint rather than treating that trigger as a
generic “14 or newer” signal.

Recovery validates the transition-relevant schema-14 catalog slice and canonical
rows, recreates the reviewed
forward suffix through `0007`, and must restore the authority mode as `legacy`.
It does not execute a resolver, resume provider work, synthesize File identities,
upgrade expected hashes to verified hashes, contact a storage provider, or switch
authority. Empty additive state in an archive upgraded from an older version is a
valid historical result, not proof that conversion completed.

Schema-7 through schema-13 readers remain frozen to their original contracts.
The isolated trusted recovery utility validates an older archive first, then
applies reviewed forward migrations; missing authority rows stay empty/defaulted
under legacy mode. No old archive silently acquires new File meanings. Schema 14
does not claim website import, live-database restore, cross-provider recovery or
native package compatibility.

The FP1g offline migration planner remains frozen to complete schema-10 through
schema-13 snapshots and rejects V14. V14 is a post-expansion recovery snapshot,
not a substitute baseline or permission to populate the new ledgers.

## Acceptance boundary

This slice is qualified only when fresh and populated S2 databases apply every
split migration statement, old-style writes still work unchanged, every new guard
and foreign key behaves on SQLite and workerd/D1, schema-14 export/recovery round
trips the additive state, and schema-7–13 recovery remains frozen and compatible.
Deployment must preserve the same D1 and storage bindings and must not infer an
authority/default/Settings transition from successful migration.

The following remain explicitly open after this PR:

- shadow writers for every supported upload/publication/recovery path;
- the bounded live resolver, conversion ledger, durable holds and catch-up fence;
- purpose-aware File/location publication, reuse and verified cross-purpose copy;
- File-authoritative read, retention, quarantine, GC and deletion behavior;
- atomic activation and later compatibility retirement;
- Cloudflare R2 defaults for both roles and basic authenticated storage Settings;
- FP2 external configuration, administrator/secret boundaries and S3.

No database reset, storage rebinding, credential change, SWITCHdrive qualification,
Cron/Build-control release or destructive legacy cleanup follows from this design.

## Acceptance observation — 2026-09-25

PR #220 is merged at integration commit
`4248deb5fe8784a6eec444e30b0d3cc862d92430`. All 14 commit status contexts and
both Verify / Project Map performance workflows reported success. The Cloudflare
Workers build `03dcc2f1-ddf0-44cd-9484-feb755d71671` completed successfully with
Worker version `873ba5a0-1e0e-4468-abaf-17fd39109e6f`.

The following local checks passed against this merged substrate:

| Check | Result | Boundary |
| --- | --- | --- |
| `npm run test:file-authority-transition` | 3/3 | Actual SQLite and workerd/D1 migrations and legacy guards |
| `npm run test:export-restore` | 24/24 | Local export, isolated recovery and schema coverage |
| V14 protocol and schema-fingerprint tests | 12/12 | Local V14 generation and recovery-contract qualification |

At `https://sample-workflow-v3.clannadas.workers.dev`, Processing, Projects and
Export pages loaded. No application console error was observed during those
reads. This did not inspect the remote database schema directly or verify any
provider bytes.

A disposable Project named **FP1k acceptance 2026-09-25 disposable** was created
and its UI showed **Saved**. Its identity is
`project-247a522c-6d37-4c06-9251-a2324dc1a11d` and its
[Project page](https://sample-workflow-v3.clannadas.workers.dev/projects/project-247a522c-6d37-4c06-9251-a2324dc1a11d)
remains the cleanup reference. The browser connection stalled while selecting an
attachment and again on a later read attempt. No subsequent DOM result or
screenshot was obtained. Attachment publication, non-empty download/export,
live isolated recovery, Project cleanup and any possible attachment residue are
**unconfirmed**. Treat the test Project as still present until a later observed
recoverable Trash action succeeds; no deletion or storage cleanup is claimed.

These observations close neither full interactive acceptance nor non-empty file
round-trip acceptance. The local checks remain useful evidence for the additive
legacy-mode substrate, and the read-only consumer preflight does not activate
shadow conversion or release operational cleanup controls.
