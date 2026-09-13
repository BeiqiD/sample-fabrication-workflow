# S2 activation checkpoint — 2026-09-13

Selected route: rebuild the existing disposable test D1 while retaining the
Worker, database identity, R2, SWITCHdrive and all file bindings/configuration.
The owner's current instruction supersedes the earlier new-resource proposal.

## Verified target and preparation

- Integration source is `v2/backend-foundation` at
  `b8fc0bb4f5ec25fe54879d5bf251c17131c809e7`; Cloudflare successfully deployed
  that exact commit at 10:06 UTC. The separate main-branch Worker is not the
  current execution target; no production-data claim is made for either app.
- D1 and R2 bindings match existing Build Variables. SWITCHdrive is configured;
  its runtime root is a plain-text variable and its password remains a secret.
  Access is enabled. Private configuration values are omitted from Git.
- R2 public r2.dev access is disabled and no custom domain is attached.
- Read-only D1 queries found 34 application tables plus `d1_migrations`, 198
  triggers, 15 views and 37 original ledger entries. The 248 table/trigger/view
  names exactly match the explicit reset SQL, with no missing or extra names.
  Pending imports and unfinished comment submissions both counted zero.
- The prior preparation head `fdabae49fc9ef678217ba135c94f18e83e1728c7` passed
  all four GitHub checks and 14 status contexts. Its optional root-switch feature
  is now removed because the owner requires existing file configuration to stay.

## Maintenance controls applied

Earlier low-level Builds requests returned authentication errors, and subsequent
trigger PATCH attempts returned `12002: Invalid request body`. The supported
Worker Builds configuration endpoint succeeded. This supersedes the earlier
record that no configuration write was possible.

At 11:51 UTC, read-back confirmed:

- the Worker workers.dev endpoint and preview URLs are disabled;
- the Cron schedule list is empty;
- Builds watch paths exclude `*`, and both build/deploy commands are temporarily
  fail-closed maintenance commands; no queued/running build exists;
- no integration deploy hook or custom Worker domain exists;
- all DB/R2 bindings, Build Variable resource values, Access policy, SWITCHdrive
  root and credentials are unchanged.

The hostname-only Build Variable `DEPLOY_WORKERS_DEV` is temporarily `false`,
preventing the gated S2 deployment from reopening ingress before database
checks. Restore its original `true` value together with workers.dev access.
The configured daily Cron can be restored by the ordinary deployment; it must
not execute before acceptance and can be removed again while tests run.

The original settings to restore are `npm run build:deploy`,
`npm run deploy:remote`, watch paths include `*` / exclude none, workers.dev
on / previews off, and Cron `17 3 * * *`. Do not restore old-code deployment
against a rebuilt S2 schema. Watch paths alone are not a complete pause because
Cloudflare documents empty/large-push exceptions.

The owner confirmed that application tabs are closed and no upload is running.
The prior daily Cron time is well before the documented maximum invocation
window; newly scheduled work is disabled and pending database operations are
zero. Recheck these controls immediately before reset. Existing physical files
are retained; application cleanup discovers objects from database registrations,
not by scanning and deleting all unreferenced bucket/root contents.

## Reset and acceptance status

The explicit reset SQL passed the actual same-database local Wrangler rehearsal:
37 historical migrations and 53 fixture rows were cleared; normal S2 migration
then produced one baseline ledger entry, 34 tables and 20 exact seed rows,
matching an independent fresh control. Empty/partial-reset retries passed;
platform system definitions, foreign keys and integrity checks were preserved.
All 66 remote foreign-key edges also match the tested child-first drop order.

The final application after removing the root override passed all 11 ordinary
`verify:ci` leaves: 90 script cases, 1,107 source cases, 467 mounted cases,
actual migration/Worker checks, contracts and production builds. This local
result does not substitute for the new head's GitHub CI or remote acceptance. No remote application table or migration
ledger has been cleared at this checkpoint. No D1, R2 or SWITCHdrive resource
has been created, removed, rebound or cleared. Runtime file-storage settings
remain unchanged.

The live reset must follow [the ordered procedure](./BACKEND_DISPOSABLE_S2_CUTOVER.md)
and [manual SQL instructions](../scripts/operations/README.md): delete known
application objects and the old ledger, preserve platform internals, initialize
the ordinary S2 baseline, deploy the matching passing source and verify the
unchanged bindings, new ledger, schema/integrity and application behavior.

After access resumes, acceptance covers create/save/reload, Comment images,
R2/SWITCHdrive upload/download, Reference navigation, full ZIP export and isolated
restore. Record actual deployment and these results before marking Phase 6A6
complete. No old-file cleanup is part of this operation.
