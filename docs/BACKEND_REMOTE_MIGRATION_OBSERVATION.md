# Remote D1 migration observation

Status: fixed read-only transport and CLI implemented; fixture transport checks
and actual local D1 parity passed. No live Cloudflare request was made to qualify
this slice, and no remote schema, migration ledger, deployment or binding changed.
This is a prerequisite for reviewing a real target, not Phase 6A5 completion.

## Explicit target and credential

An operator with an intended account, database and a D1 Read API token can run:

```sh
npm run db:observe:remote -- \
  --account-id <account-id> \
  --database-id <database-uuid> \
  --output <new-private-json-file>
```

The credential comes only from `CLOUDFLARE_API_TOKEN` in the invoking environment.
Do not put it in CLI arguments or commit it. This command does not discover an
account, select a configured database, inspect Wrangler/OAuth credentials, load
`.env` files, or accept a SQL, URL, config or credential argument. Its validated
target is sent only to the fixed official HTTPS D1 `/query` endpoint, without
redirects or automatic retries. Cloudflare's
[query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
accepts D1 Read permission.

The output parent directory must already exist. The command reserves a new file
exclusively before making a request; an existing file or final-component symlink
is rejected. It writes with mode `0600` on POSIX, flushes the completed JSON, and
removes its own reserved file if observation fails. On systems where POSIX modes
do not enforce privacy, the operator must use a directory with a private ACL.
Schema SQL and ledger names can be sensitive; only a short completion message
appears on stdout. Provider bodies, credentials, URLs and raw exception messages
are never printed as errors.

## One statement for returned evidence

The transport reuses the
[binding observer](BACKEND_MIGRATION_OBSERVATION.md), including its validation
and protected-platform-table rules. A fixed preliminary `SELECT EXISTS` decides
whether `d1_migrations` may be referenced. That result is not returned as schema
or ledger evidence.

When the ledger exists, the private transport combines the observer's exact
schema and ordered-ledger queries into one compound SELECT, returning two JSON
columns. With no ledger, it sends only the fixed schema SELECT. The transport
decodes the single response back into the binding observer's expected result
shape. No observed name or caller input becomes executable SQL. Appearance or
disappearance of the ledger between probe and observation rejects.

This construction deliberately avoids an assumption about REST multi-query
batches: the [REST reference](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
supports batches but does not state an isolation guarantee, whereas the
[binding batch contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
explicitly describes transactions. The consistency argument here is a single
SQLite SELECT's implicit read transaction, as documented by
[SQLite](https://www.sqlite.org/lang_transaction.html). It does not claim that a
REST multi-query batch is equivalent to `D1Database.batch()`, that observation
locks out later changes, or that its contents are still current at migration time.

The installed Wrangler SDK exposes remote development proxies, which establish
remote preview sessions and use broader configuration/credential behavior. Its
bundled generic Cloudflare REST client is not a public module export. Neither
adds a documented REST snapshot guarantee, so this bounded transport uses native
fetch without starting a proxy or preview deployment.

## Rejection and artifact contract

The entire observation, including both requests and body consumption, has a
30-second deadline. Each response body is capped at 8 MiB, including streamed
responses with no length header. Non-200 responses, redirects, wrong content
types, invalid UTF-8/JSON, failed envelope or statement success, nonempty errors,
unexpected pagination, missing/extra statement results, write metadata and
malformed nested schema/ledger results all reject. The observer's existing
cardinality, complete-metadata, ledger-order and duplicate-name checks still run.

A completed artifact contains explicit account/database identifiers, overall and
per-request timestamps, the raw observation, normalized schema and observation
SHA-256 fingerprints, and an artifact SHA-256. The latter covers the JSON-serialized
payload before `artifactHash` is appended, including target and timestamps.
Fingerprints bind recorded evidence; they are not signatures or a provider proof.
`executionAuthorized` remains `false`. No planner catalog is inferred, no
migration proposal is applied, and the deployment command never calls this CLI.

## Qualification and remaining gates

Run the transport tests with:

```sh
node --test scripts/remote-d1-migration-observation.test.mjs
```

They also run in the existing `test:verification-scripts` leaf. Fixture coverage
includes absent/present/changing ledgers, data preservation, exact target and
single-statement construction, failure envelopes, redaction, limits, slow
requests/bodies, invalid arguments, private output and cleanup. The actual local
D1 cases construct the complete 37-file S0 schema from `migrations-history/s0/`
and the default S2 baseline from `migrations/` in separate fresh databases. Both
compare this single SELECT with the original binding batch observation and
preserve their distinct exact ledger filenames. The original S0 qualification
recorded 1,983 `rows_read` and 374,116 bytes of D1 result JSON; the separate S2
case recorded 1,950 and 371,310 respectively. Those are local fixture
diagnostics, not remote capacity or latency guarantees.

Before a target migration is proposed, still obtain and review a real remote
observation, qualify any unfamiliar protected platform definitions, and match it
to reviewed lineage/catalog sources. Migration execution additionally needs the
separate recovery, deployment serialization, current-state recheck and serving
version retirement gates in the
[baseline design](BACKEND_MIGRATION_BASELINE_DESIGN.md). This CLI does not satisfy
or bypass those gates.
