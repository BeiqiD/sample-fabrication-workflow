# Contracted writer preparation (stage C)

This is an **inactive implementation for the qualified S1 and S2 schemas**.
It is not compatible with the currently deployed S0 schema and must not be
merged into an automatically deploying branch while that branch still serves S0.
The active migration directory and deployment configuration are unchanged.

The serving-version retirement, recovery, rollback and migration prerequisites in
[the compatibility design](BACKEND_COMPATIBILITY_CLEANUP_DESIGN.md) still apply.
The E export/restore protocol and B4 returned-occurrence acknowledgement fix are
prerequisites; passing local tests does not apply B's S1 expansion or authorize
the later remote contraction.

## Runtime behavior

Legacy occurrence creation stores its text in `run_step_comments.legacy_body`.
Sample detail, reference resolution/search and occurrence lifecycle summaries
read that column for legacy occurrences. Canonical occurrences continue to read
`comment_submissions.body`, including an empty body; finalization no longer copies
that text into the occurrence row. The public `body` field and ordinary request
and response shapes stay unchanged.

The C changes preserve generated occurrence and operation IDs, actor metadata,
guard predicates, batch statement order and event writes. Canonical finalization
removes only the obsolete occurrence column, its matching SELECT placeholder and
binding. Legacy insertion preserves B4's `RETURNING id` and exact returned-ID
settlement; an uncertain acknowledgement is not reclassified as an authoritative
conflict.

On S1, omitted compatibility `body` values receive the schema's empty default.
On S2, that column and `samples.process_revision` do not exist. The same C Worker
code executes the qualified normal API flows on both schemas. The E export
implementation separately owns generic snapshot projection and retired-field
provenance; the C changes do not add another export format.

## Explicit qualification

With the reviewed, inactive schema fixture files present at
`scripts/fixtures/backend-schema/s1-compatibility-bridge.sql` and
`scripts/fixtures/backend-schema/s2-final-schema.sql` (reviewed in
[PR #198](https://github.com/BeiqiD/sample-fabrication-workflow/pull/198)), run:

```sh
node --test scripts/backend-contracted-writer.test.mjs
npx tsc -p tsconfig.worker.json
```

The script builds the actual `worker/index.ts` and calls its real HTTP handlers.
It runs the same cases on host SQLite and workerd D1, each with S1 and S2, using
the unchanged active chain followed by the inactive stage SQL only in disposable
databases. The host harness implements returned rows and trigger-inclusive
change counts; workerd supplies actual D1 and R2 behavior.

The matrix covers:

- Exact retained reads, canonical singular search, legacy search and reference
  resolution without reviving a retired duplicate.
- Legacy and canonical creation for common and individual scopes, both text and
  image-only content; canonical image bytes pass through the actual upload API.
- Occurrence, submission and image deletion/restoration, preserving identity,
  text ownership, group membership and event summaries.
- Canonical finalization retry with an exact all-table comparison. The host
  cases also inject a committed batch whose acknowledgement is lost, require a
  500 response and prove the retry adds no duplicate events or occurrences.
- Stale common targets and a target trashed between submission creation and
  finalization, with exact all-table checks against partial writes.
- Foreign-key and SQLite integrity checks after the full API sequence.

This explicit qualification is not the ordinary S0 `verify:ci` gate. Existing
default fixtures and smoke scripts still assume active S0 migrations. The
separate `backend-compatibility-schema.test.mjs` also qualifies the pre-C A/B4
writer on S1; its historical duplicate-body assertion is not a C acceptance
test and must remain tied to that earlier stage. The final
integration must qualify its selected active schema, full test/restore matrix,
deployment retirement evidence and browser acceptance together before activation.
