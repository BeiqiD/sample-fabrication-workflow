# Negotiated complete-export protocol

The current browser requests
`/api/exports/all?archiveSchema=8&archiveWriter=1`. Exactly one supported value for
each parameter is required. Unversioned requests, duplicates, extra parameters
or unsupported versions receive 409 with a refresh message before any snapshot
or ZIP generation. An already-open v7 client consequently fails before its old
writer can discard required provenance. A new client receiving a previous
Worker's v7 response rejects it before fetching blobs.

This release changes the archive protocol and isolated recovery tooling. It does
not change the active migrations, normal text-writing columns, provider bindings
or database resources. Remote B/C/D transitions retain the strict retirement
barrier; a v8 deployment is not proof that those transitions are safe.

## Snapshot and ZIP contents

`worker/export-v8-snapshot.ts` captures the complete existing table/view inventory,
all physical schema objects and the two compatibility-table column lists in the
same D1 batch. The response timestamp follows that batch; it is not an exact
database clock. Schema observations do not come from the Worker version or a
separate schema-cache read.

The v8 logical Sample row omits `process_revision`. The logical occurrence row
replaces `body` with `legacy_body`: a legacy occurrence retains its actual text,
and a canonical occurrence has `legacy_body = null` with its operational text
still in `comment_submissions.body`.

The ZIP includes two required artifacts:

- `provenance/source-schema.json`: actual schema objects and compatibility
  columns observed with the source rows;
- `provenance/retired-fields.json`: actual Sample counters and occurrence bodies,
  keyed by unique stable IDs, with source-row counts and explicit availability
  and completeness flags for each family.

Before column contraction, the retired artifact preserves every actual numeric
counter and body, including nonzero/negative counters and empty placeholders.
After contraction, unavailable families are explicitly incomplete and empty;
their values are never manufactured. Existing v7 archives retain their original
stored fields and remain valid offline recovery inputs.

The browser validates the negotiated versions, artifact hashes and sizes, source
shape and logical/retired-field consistency before downloading blobs. It also
checks the complete table inventory against observed schema objects, every
row’s columns against the safely parsed source CREATE statement (or the fixed
logical/view contract), and the complete blob plan against those table rows.
The source SQL is parsed for column names only; it is never executed. The ZIP
manifest declares each table's row count, byte size and SHA-256, both artifact
descriptors, and every blob's exact locator, occurrence metadata and final
outcome. Ordinal blob paths preserve opaque provider identities. The writer
checks the completed file inventory before generating the download.

## Recovery behavior

The [isolated recovery utility](./EXPORT_RESTORE_REHEARSAL.md) requires an explicit
S0, S1 or S2 target for v8. Independently supplied local migrations construct the
target; archive schema SQL is retained as evidence and never executed.

S0/S1 restoration requires complete original retired fields. S0 additionally
requires each legacy row's recorded `body` to equal its logical `legacy_body`;
otherwise preserving both stored values and readable legacy text is impossible
and the utility rejects. S2 restoration uses logical rows and retains the retired
artifact outside operational tables. A v8 source after contraction cannot supply
missing historical counters or bodies for an older target.

V7 recovery projects its exact known row contract, preserves actual retired
values, and explicitly records that a physical source-schema observation was not
available in v7. Every successful recovery retains the input ZIP byte-for-byte,
the relevant provenance artifacts and the hashes of the actual local target
migrations. Existing destination, archive-path, CRC, blob, row, foreign-key,
integrity, trigger and Project-relation checks remain in force.

These hashes detect inconsistency; they do not authenticate arbitrary archives,
prove the original Worker build, authorize remote writes or replace the live
schema-transition gates. Browser deployment acceptance is recorded separately
after inspecting a ZIP downloaded from the actual deployed version.

## Local acceptance evidence

The protocol tests exercise the real Worker and SQLite rows, both version
rejection directions, one-batch schema expansion, complete table/column/blob
inventory, exact artifact hashes, and isolated S0 recovery. The existing
`verify:project-worker` smoke also executes the negotiated export through actual
Miniflare/D1, including `sqlite_schema` and both table-valued PRAGMA queries.
The same assertions run in the production-artifact verification leaf.

An independently downloaded old browser v7 ZIP was restored directly with this
utility, without conversion through the new writer: SHA-256
`0fbd0bf71919f164bf201761fbc20678ec014816d77951675360cebd88cdad26`.
The result preserved 34 tables, 94 rows and one blob, installed 198 triggers,
and passed row, foreign-key and integrity checks with zero warnings.
This is offline archive compatibility evidence, not live v8 browser acceptance.
