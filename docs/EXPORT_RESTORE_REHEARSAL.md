# Isolated complete-export recovery rehearsal

Phase 6A1 verifies that a trusted complete export can recreate its current-schema
rows, identities and available physical bytes in disposable local resources.
This tool is a verification utility. It does not install a public import route,
upload anything to R2/SWITCHdrive, overwrite an existing database, or qualify a
remote disaster-recovery procedure.

## Running it

Use Node 24 and the repository's installed dependencies:

```sh
npm run verify:export-restore -- --archive /path/to/backup.zip --destination /path/to/new-rehearsal --target-schema S0
```

The destination must not exist, including as an empty directory or symlink.
There is no overwrite, force or remote option. The current repository's SQL
migrations provide the schema; the archive cannot supply executable SQL.
V8 requires an explicit `--target-schema S0|S1|S2`; S0 is the current active
schema. Offline qualification can select an independently reviewed migration
directory with `--migrations-dir`. The selected target must match that directory’s
actual resulting columns. V7 keeps its existing default S0 recovery command.

The utility reserves a private destination, works inside a temporary child and
publishes `restored/` only after validation. Failure removes the newly created
destination. Success produces:

- `restored/database.sqlite`, containing the exact canonical table rows;
- `restored/provider-bytes/`, containing available bytes under generated names;
- `restored/provider-manifest.json`, mapping each exact locator to its local
  bytes, SHA-256 and archived outcome;
- `restored/restore-report.json`, recording archive, migration and schema hashes,
  row counts, installed triggers, warnings and expired retention edges;
- `restored/original-archive.zip`, an exact copy of the input archive;
- `restored/provenance/`, retaining actual retired values and, for v8, the physical
  source-schema observation from the export snapshot.

Provider keys are opaque metadata. They are never used as filesystem paths.
The same utility accepts prior schema-v7 archive filenames by following their
manifest paths. An older archive whose distinct locators share one ZIP path is
rejected; missing overwritten bytes cannot be reconstructed.

## What is verified

The parser checks the schema version, full business-table and exported-view
catalog, exact row columns and declared counts. It rejects duplicate or unsafe
ZIP paths, undeclared entries, malformed warnings, inconsistent blob metadata,
and member size/CRC errors. V8 also verifies each table/artifact SHA-256 and
byte size, writer version, physical-source shape and exact retired-field ID
coverage. An S0/S1 target requires actual recorded counter/body values; S2
archives with absent retired families cannot be restored to those older targets.
A legacy-only row whose recorded compatibility `body` differs from logical
`legacy_body` is rejected for S0. No SQL default supplies missing evidence.
Each packaged blob must match its recorded size and
SHA-256 where available. Blob identity and occurrence metadata are recomputed
with the existing export planner over the archived table/view rows.

The destination starts with the full migration chain. Within a transaction,
only that new database's write triggers and foreign-key enforcement are
temporarily disabled. Migration seed rows are replaced with the exact exported
rows, including any changed or retired built-in definitions. The original
triggers are reinstalled, and SQLite integrity, foreign keys, schema equality,
canonical row equality and selected Project ownership/sequence/placement
relations are checked before the result is published. Future writes again use
the original triggers; fixture tests exercise their identity and deletion guards.

`blob_retention_edges` is rebuilt from canonical rows. Every currently retained
edge must be present in the archive. An additional historical edge is accepted
only after its `retain_until` has passed and its complete metadata can be
reconstructed from the same rows on a separate read-only connection before
expiry. These differences are listed in the report. `exportedAt` is assigned
after the D1 batch and is **not** treated as its precise snapshot clock.

The permanent test fixture covers canonical and legacy Comments, shared
occurrences, Run-plan and verification history, stable References, Project
content and geometry, deleted content and cascading edges, managed attachments,
legacy unhashed bytes, quarantine and GC rows, and unavailable-byte warnings.
It compares the restored Project snapshot and a second complete export with the
source. Failure tests verify that corrupted inputs leave no partial destination,
and that existing and symlink destinations remain untouched. These tests run in
the ordinary source suite used by CI and deployment; `npm run test:export-restore`
is the focused local command.

## Recorded browser-export rehearsal

On 2026-09-13, actual full ZIP downloads from the isolated integration site were
recovered into two separate new local destinations, before and after PR #187's
archive-path repair. Both contained 34 canonical tables with 94 rows, one
retention-view row and one available blob. Both passed schema, row, Project
relation, foreign-key, integrity and byte-hash checks with 198 triggers
reinstalled and no warnings. Comparing the two restored databases found no
table differences; their provider locators and bytes were also identical.

The old-path archive SHA-256 was
`0fbd0bf71919f164bf201761fbc20678ec014816d77951675360cebd88cdad26`;
the ordinal-path archive SHA-256 was
`d307331111f7c3dbdf80c20213605f0ab0829d74e3522e174879a5cecbefd278`.
These are browser-download and local-recovery observations. They do not certify
remote database replacement, provider writes or larger real research datasets.

## Limits and later work

- Trusted v7 and [negotiated v8](./FULL_EXPORT_V8.md) exports are supported with
  an explicitly qualified physical target. V7 has no observed source schema;
  its report states that absence. V8 retains same-snapshot schema and retired
  values, but neither version proves a source build or historic migration bytes.
  The report records original archive and actual target-migration hashes.
- Restoring write triggers does not replay every historical business command or
  authenticate arbitrary third-party archives. This is preservation and
  qualification of known exports, not a general untrusted-data import protocol.
- Missing, unavailable, unready or mismatched bytes remain explicit warnings;
  their database state is preserved, and no replacement bytes are invented.
  A legacy packaged blob without a recorded hash is listed separately, with a
  new local hash for subsequent comparison. Such an archive is not certified as
  a complete, independently verified backup.
- The bounded utility accepts ordinary single-volume ZIP files up to 64 MiB,
  with at most 64 MiB per expanded entry and 256 MiB expanded in total. ZIP64,
  encrypted archives and larger datasets require a separately designed path.
- Remote D1 restoration, provider credentials/uploads, live compatibility
  contractions and activating the later V3 baseline retain their own review and deployment
  gates. The relevant rehearsal must be repeated against that final schema.
