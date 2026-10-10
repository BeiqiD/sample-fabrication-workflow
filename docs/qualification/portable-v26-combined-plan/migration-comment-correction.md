# Whole-file and split migration catalog comparison

Both push and PR Verify runs on `4ee8a7b1c7b1e0ced8ce5a771b76e908b9aae5c2` failed at the same current-schema-source assertion: verification scripts reported 356 passed and one failed; source and later gates were skipped, 14 skipped gates in total. The exact original logs and hashes are retained in the companion source receipt.

Wrangler deliberately consumes SQL line/block comments while splitting statements. Whole-file SQLite retains the internal raw0024 provenance comment in `sqlite_schema`. The failure compares that comment against the split path's blank line. Raw0024 is pinned and remains unchanged.

The correction uses the existing imported `normalizeSchemaSql`, matching the same file's established FP3 catalog comparison. The entire sorted catalog still requires equal object types, names, table names and every normalized executable token. Quoted strings/identifiers remain byte-exact; malformed quotes/comments reject. Populated cells, rowids, receipts, ledger ordering, foreign keys and inert runtime checks are unchanged. No object or SQL token is omitted, and no generator, splitter, helper, migration, catalog or application code changes.

All other 60 V26 code/configuration pins, all 24 raw migration pins and five frozen generated pins match the prior source review. The exact prior plan is preserved in checkpoint425 history; the current plan changes the affected test hash and identifies this source delta while retaining its commands, counts and original budgets. Local compiler, tests, build and database operations remain UNRUN pending explicit coordinator GO. V26 remains metadata-only with local File/role/provider guards closed.
