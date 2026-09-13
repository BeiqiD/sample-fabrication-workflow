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

## Executed reset and deployment

PR #202 head `54f9ade5ff05a5a8cb2682ddbeb3a06aaa2025bb` passed all four
GitHub check runs and 14 status contexts, plus independent review. It merged as
`e37dbe119a063147887b681799198f0805024e11` while maintenance was active.

The live reset rechecked disabled ingress/Cron, no active Builds, the original
D1 binding, and the complete unchanged 248-object inventory before execution.
All 248 DROP statements succeeded. Read-back found only `_cf_KV` and
`sqlite_sequence`; `quick_check` was `ok` and foreign-key checks were empty.
No database identity, binding, R2 object or SWITCHdrive file was changed by SQL.

Cloudflare build `e46ab534-09d5-4781-838b-4763ef0b15ed` ran from that exact merge
commit with the ordinary `build:deploy` / `deploy:remote` commands and all 11
deployment-verification leaves enabled. It completed successfully at
2026-09-13 12:15:49 UTC. The normal remote migration initialized S2 and recorded
only `0001_v3_baseline.sql`.

Deployed Worker version: `cebe4ecd-d167-4420-b31d-841e1582c9a2`, with 100% of
traffic assigned to it. Post-deploy D1 checks confirmed:

- 34 application tables and 20 baseline rows; the four populated seed tables
  each contain five rows, while other application tables are empty.
- Exactly one migration ledger entry, named `0001_v3_baseline.sql`.
- `quick_check=ok` and no `foreign_key_check` violations.
- Unchanged original D1 and R2 bindings, SWITCHdrive provider/root/username/URL,
  password-secret binding, Access audience/team settings and `AUTH_MODE=access`.

`DEPLOY_WORKERS_DEV` and workers.dev access have been restored to their original
`true` values; preview URLs remain disabled. An unauthenticated `/api/ready`
request returns HTTP 302 to Cloudflare Access, confirming the login boundary.
No authenticated readiness result is claimed from that redirect.

## Remaining acceptance and temporary controls

Application access is restored. Automatic/manual Builds remain held by temporary
fail-closed commands and exclude-all watch paths, and Cron is empty while final
browser acceptance is pending. No build or file cleanup should be resumed from
an old source. After acceptance, restore the exact original commands/watch paths
and Cron listed above; resource bindings and file configuration stay unchanged.

## Live page and API tests

Safari completed Access login and reached `/processing`. Its supported read-only
`text` and `source` properties allowed authenticated inspection without enabling
page scripts. Processing, Samples, Projects, Templates and Export rendered the
expected empty-system views, with no application-page error shown. Samples and
Projects have zero records. There are no imported process or metrology templates.

A real issue was reproduced:

- Authenticated `/api/ready` returns the managed-storage authentication error.
- `/api/storage/status` reports provider `switchdrive`, `available:false`, and
  “SWITCHdrive rejected the configured username or App Passcode. File attachments
  are disabled.”
- The adapter emits this error for upstream HTTP 401 or 403. Its source is
  unchanged between the previous S0 integration and the deployed S2 commit;
  runtime username/URL/root values and the password-secret binding are retained.
  These observations do not prove when the credential problem began, whether
  the passcode expired, or which credential is incorrect.

The owner must supply a working SWITCHdrive username/App Passcode through the
Worker's secure Variables and Secrets settings. Do not publish credentials in
Git or chat, change file roots, disable the provider to disguise the error, or
claim the original-file upload/download check passed.

## Live export and isolated restore

The authenticated live `/api/exports/all?archiveSchema=8&archiveWriter=1` response
contained a valid v8 envelope with 35 logical table/projection entries, 20 rows
and zero registered blobs. The application's actual `buildFullExportArchiveV8`
writer was bundled and executed locally on that response, then the existing
`verify:export-restore` CLI restored its ZIP into a new local directory.

Safari's document source interface initially decoded the UTF-8 JSON as
Windows-1252, changing two em dashes in schema SQL into mojibake. Reversing that
transport decoding made the original server-declared artifact sizes and SHA-256
values match exactly; no hash, expected value, application data or validation
rule was changed. The initial extraction failure is not reported as a product
export defect.

The verified ZIP is 32,357 bytes with SHA-256
`8cec6133b6aa10b4d2d51f1e1add15501af952947e7c42ef15fa55bf67cd735a`.
Isolated recovery reports 34 physical tables, 20 rows, zero blobs and no warnings;
row/schema equality, foreign keys, database integrity, Project relations and
retention checks passed. This exercises the live snapshot, actual client writer
and real local restore. It does not claim that the browser's download button
was clicked or that a non-empty file payload round-trip was tested.

## Remaining blockers

Safari page interaction is unavailable until “Allow JavaScript from Apple
Events” is enabled. Native accessibility actions were denied; the separate
computer-use executor cannot start with the current symlinked writable root.
Interactive create/save/reload, new file uploads/downloads and exact Reference
navigation remain unexecuted against this deployment. The owner has been asked
to enable page automation and update SWITCHdrive credentials, or take over the
remaining manual interaction checks.

Phase 6A5 activation is complete; Phase 6A6 exit remains open. Application access
is available, with temporary Builds and Cron holds retained until acceptance.
Old physical files remain in the same storage; no cleanup of those unreferenced
test files ran.
