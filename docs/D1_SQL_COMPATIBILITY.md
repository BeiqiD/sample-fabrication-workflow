# D1 SQL compatibility contract

Status: operational constraint for the v3 backend

Last reviewed: 2026-08-08 after the first isolated v3 activation attempt

The repository uses SQLite syntax through Cloudflare D1, but production D1 is
not equivalent to an unconstrained host SQLite build. Migrations and runtime SQL
must satisfy the limits enforced by Cloudflare's workerd SQLite runtime.

## Why this contract exists

The first remote activation of the blob-lifecycle slice failed while applying
`0016_blob_lifecycle_control.sql` with:

```text
too many terms in compound SELECT
```

Host `node:sqlite` migration tests had passed. The difference was platform
configuration: workerd sets `SQLITE_LIMIT_COMPOUND_SELECT` to `5`, while ordinary
SQLite builds commonly permit many more compound terms.

This is a runtime/platform limit, not a Free-versus-Paid D1 quota. Upgrading the
Cloudflare plan does not raise it.

The failed activation was recoverable because Wrangler completed migration
`0015_managed_orphan_dedupe_repair.sql`, rolled back the failing `0016`, did not
apply `0017`, and the `&&`-chained deploy command did not deploy the new Worker.

## Compound-select rule

No individual D1 SQL statement or view definition may contain more than five
terms in one compound `SELECT` chain:

```text
SELECT ...
UNION ALL SELECT ...
UNION ALL SELECT ...
UNION ALL SELECT ...
UNION ALL SELECT ...
```

is the maximum supported shape for one compound level.

When one logical read surface needs more source classes, preserve one public
contract through a hierarchy of smaller views rather than duplicating
reachability in TypeScript.

The blob lifecycle therefore exposes:

```text
blob_retention_edges_r2_occurrences   <= 5 terms
blob_retention_edges_comment_items    <= 5 terms
blob_retention_edges_direct_keys      <= 5 terms
                |
                v
blob_retention_edges                  3 terms
```

Application code continues to query only `blob_retention_edges`. The leaf views
are an implementation detail required by D1.

Future Project attachment or reference work must keep every leaf within the
workerd limit. If a leaf would exceed five terms, split it again and keep the
public view stable.

## Migration verification

Host SQLite tests remain useful for schema and data regressions, but they are
not sufficient evidence that a migration is D1-compatible.

`npm run verify:d1-migrations` must apply the complete migration chain against a
fresh Wrangler local D1 database. This execution goes through the Cloudflare
local runtime and therefore exercises D1/workerd SQL limits.

`npm run verify:blob-lifecycle` includes both:

1. the focused SQLite lifecycle/regression suites; and
2. the Wrangler/workerd migration application.

The normal remote migration and deployment commands already depend on the blob
lifecycle gate, so a future migration that violates D1 SQL limits must fail in
CI before any remote D1 operation starts.

## Recovery rule for the 2026-08-08 failed activation

The isolated remote v3 database has this migration state:

```text
0015_managed_orphan_dedupe_repair.sql  applied
0016_blob_lifecycle_control.sql        not applied / rolled back
0017_blob_lifecycle_review_fixes.sql   not applied
```

Do not edit or replay `0015_managed_orphan_dedupe_repair.sql`.

Because `0016` and `0017` were not applied, the recovery branch may correct
those two migration files in place. Adding a later `0018` would not help because
Wrangler must successfully apply the still-pending `0016` first.

After the recovery PR is merged, use the normal gated activation path. The next
remote migration run should list only the still-pending `0016` and `0017` files.
No direct Wrangler command should bypass the repository gate.
