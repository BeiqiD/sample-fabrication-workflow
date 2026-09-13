# FP1a: file identity and legacy observation foundation

Status: first implementation slice after reviewed and merged PR #207.
Development base: `2021e71` on `v2/backend-foundation`, 2026-09-13.
This is not completion of FP1 or evidence of a deployed upgrade.

## Delivered boundary

The additive [0002 migration](../migrations/0002_fp1_file_registry.sql) introduces
`storage_profiles`, `files`, `file_locations`, and `legacy_file_mappings` without
changing any existing domain row, reference, trigger or retention view. The exact
S2 baseline and 37 historical SQL files remain unchanged. Fresh installations
apply baseline plus suffix; an existing S2 installation applies only the suffix.

These tables capture immutable **first observations** of legacy locators. They
are not current health, a verified byte inventory, an upload acceptance ledger,
or a new retention root. Existing R2/managed metadata and lifecycle services
remain authoritative. Later legacy writes and deletion do not silently rewrite
an observation. An inaccessible or already collected source can still have a
historical mapping; that mapping does not establish recoverable bytes.

The database deliberately permits only unresolved Files and Locations, historical
profiles, and null verified hashes and active pointers. Expected SHA-256/size
remain claims from the previous metadata. Purpose comes from known consumers;
ambiguous or unclassified uses keep a null purpose for explicit later resolution.
One physical legacy key used for incompatible purposes is not copied or falsely
published as several independent Files.

Profile identities require an explicitly supplied physical namespace. The R2
`ASSETS` binding name alone cannot identify a bucket, and `switchdrive` alone
cannot identify an account/root. The suffix inserts no invented deployment
profile and requires no credential re-entry. Stored credential references are
fixed environment labels, never credentials. There is no new administrator,
configuration mutation, ingestion, or inventory HTTP endpoint in this slice.

Unique addresses use profile ID plus key. Immutable identity guards cover update,
delete and SQLite replacement writes, including when recursive triggers are off.
Exact repeated inserts are no-ops; conflicting identity is rejected atomically.
Typed business relationships continue to use their existing real foreign keys.

## Inventory service

[The inventory service](../worker/files/legacy-inventory.ts) receives only explicit
SQL capabilities with an atomic-batch contract. `readLegacyInventoryPage` captures
each page in one statement; `planLegacyInventory` produces deterministic identities
and a classification report; `registerLegacyInventory` records that exact frozen
page atomically. A lost acknowledgement can retry the same page, timestamp and
profiles. Changed evidence or namespace conflicts instead of updating first capture.

Pages contain at most 20 locators, with at most 100 rows per evidence category and
64 KiB of encoded observation evidence per locator. Overflow requires explicit
resolution and never silently classifies truncated evidence. Keyset pages are
individual observations, not an installation-wide snapshot or GC hold. The first
bridge supplies at most one exact profile for each existing singleton provider;
the underlying profile/location identities already distinguish same-type instances.

Enumeration includes registry rows, direct-key retention, GC and quarantine.
Classification also includes persisted historical Comment, execution and metrology
uses, so expiry or soft deletion cannot hide a conflicting purpose. Evidence is
field-allowlisted and excludes provider errors and credentials. No storage I/O is
performed. The [actual-service parity test](../scripts/fp1-file-inventory.test.mjs)
qualifies the read/register/retry/rollback path on host SQLite and local D1.

## Archive and recovery boundary

Current full export negotiates schema **9**, archive writer **1**, profile
`fp1-legacy-overlap`. It captures the four new tables and existing canonical tables,
retention projection and schema in the same D1 batch. Dormant mappings must agree
with their File, Location and Profile, without pretending to add retained bytes.
The existing byte enumeration and per-blob integrity outcomes remain in force.

This is an explicit archive version change. The old v8 route rejects the new
schema rather than omit registry state. A stale export tab must reload to obtain
the v9 writer. Qualified v7/v8 offline readers remain available, including the
reviewed restore-then-forward-upgrade path to the current migration chain. The
restore report records applied forward migrations; absent historical registry
rows are not fabricated. Archive-supplied SQL is never executed.

The browser still builds the archive in memory under the existing limits. This
slice does not deliver native Sample/Project import, a streaming archive engine,
online restore, durable migration jobs, or new provider transfer capabilities.

## Validation and activation

The [schema qualification](../scripts/fp1-file-registry.test.mjs) exercises a
populated S2 upgrade and fresh installation on host SQLite and actual local D1,
including schema/data/ledger rollback after an injected failure. It compares
existing rows and retention before/after, tests immutable identity and rejects
ready/verified/active publication. The migration planner proposes the suffix for
an existing S2 lineage with `executionAuthorized: false`.

The PR's verification results record the actual tested head. Local tests do not
establish SWITCHdrive access, non-empty live R2 acceptance or deployed readiness.
The [S2 checkpoint](./CLOUDFLARE_S2_ACTIVATION_CHECKPOINT.md) continues to own the
remaining live acceptance and operational control state. Apply no reset, binding
change, credential rotation, migration of live bytes or release of held controls
as a consequence of this metadata implementation.

Local verification on 2026-09-13 passed all 11 `verify:ci` leaves, including
1,157 source tests, 467 mounted tests, real Worker/D1 checks and production builds.
After that run began, the final inventory suite was extended to 13 passing cases
and the additional actual-service D1 parity test passed separately; both are in
the repository's ordinary CI discovery/gate. Independent schema, service and
archive review found no remaining blocker for this bounded slice.

Deployment requires the matching suffix and Worker/browser archive protocol.
Returning to an old binary alone would lose the new export coverage once registry
observations exist; use the reviewed backup/restore and deployment procedure.
This PR does not activate its schema remotely.

## Next FP1 slice

The [FP1b byte-reader slice](./FP1_BYTE_READER_BOUNDARY.md) introduces a narrow
read/stat transport boundary and converges legacy download routes while keeping
these tables dormant. [FP1c verified writes](./FP1_VERIFIED_BYTE_WRITES.md) adds
bounded source/destination verification to legacy ingestion and current reuse.
Neither slice completes the authority conversion below.

Introduce verified provider-neutral ingestion/resolution and convert the complete
consumer, deduplication, quarantine and retention inventory together. Only that
review may relax the unresolved-state restrictions, add guarded active-location
ownership and make File locations authoritative. It must also establish accepted
operation identity, retry/default races and complete byte recovery for new Files.
Profile credential/default mutability remains separately versioned work.

After consumer conversion, qualify the explicit R2 policy for new originals,
role-specific readiness and authenticated read-only Settings. Existing originals
retain their recorded provider. FP1 closes only after all supported file paths
and the required frontend/file round trips satisfy the
[implementation plan](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md).
