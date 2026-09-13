# Disposable test environment: rebuild the existing D1 for S2

Decision, 2026-09-13: the owner states that the application is a test environment
and explicitly authorizes discarding its database content. The selected route
rebuilds the currently bound D1 database and preserves the existing Worker,
database UUID, D1 binding, R2 bucket, SWITCHdrive root, credentials and file
bindings. No new database or file-storage resource is required.

## Scope and file behavior

Clear the old application tables and migration ledger only while application
access, deployments and background writers are paused. Initialize the reviewed
S2 baseline in the emptied schema and deploy the corresponding final C/S2 code.
Keep existing R2 and SWITCHdrive files. They lose their old business metadata
and cannot be recovered through the new application's records merely because
the physical bytes remain. New uploads continue using the same configurations.
Any later cleanup of old files is a separate operation after acceptance.

PR #202 already contains the C application, exact S2 baseline and current/history
qualification. This disposable reset does not separately activate #199/#200 or
run the retained-data S0 → S1 → S2 suffixes. Those paths and their tests remain
relevant to installations whose existing data must survive.

## Prepare before downtime

1. Record the current Worker/version, D1 UUID/name, R2 binding, SWITCHdrive root,
   runtime settings, Access settings, Cron, and Builds source/commands. Confirm
   the target is the current integration installation, not another Worker that
   happens to use the same repository. Keep private configuration out of Git.
2. Freeze and review the final PR head and run the complete ordinary verification
   gate. Review and locally rehearse the explicit reset SQL in
   [manual operations](../scripts/operations/README.md). Match the remote
   schema and ledger to its admitted object inventory before using that script.
3. Preserve all existing resource Build Variables. The generator retains `keep_vars: true`
   and emits no remote runtime-variable overrides. Do not add
   `DEPLOY_SWITCHDRIVE_ROOT`, alter `SWITCHDRIVE_ROOT`, or rebind DB/ASSETS.

## Pause all writers

1. Pause automatic Builds and prevent manual/hook/retried builds from reaching
   migration or deployment. Drain or cancel previously queued/running builds.
   Record the original settings for restoration. An exclude-all watch path alone
   is insufficient: Cloudflare documents exceptions for empty and large pushes.
   A temporary fail-closed build/deploy command also prevents new jobs from
   reaching the database while the cutover is paused. Restore the ordinary
   commands only for the reviewed final-source deployment.
2. Disable the current application ingress, including workers.dev and preview
   URLs and any other actual route. Keep the Worker, Access policy and storage
   bindings in place. Verify that new requests cannot reach the application.
3. Disable Cron/background maintenance and confirm earlier work is finished.
   `cleanupCommentUploads` reaches import cleanup and blob GC, which can delete
   physical files after claiming database records. It must not overlap the reset.
4. Close existing application tabs and finish/cancel active uploads. Confirm no
   ongoing writes or file deletions remain. Blocking new access is not proof
   that an older request ended; HTTP requests can remain alive while clients
   stay connected. Inspect pending operations and request/maintenance evidence.
   Do not use an arbitrary 30-second sleep as a substitute for this check.

Cloudflare references: [build watch paths](https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/),
[Worker limits](https://developers.cloudflare.com/workers/platform/limits/), and
[Cron propagation](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

## Rebuild and deploy with the same bindings

1. Recheck the target D1 UUID, paused controls and exact known schema. Execute
   only the reviewed application-trigger/view/table drops and `d1_migrations`
   removal. Preserve Cloudflare/SQLite internal objects such as `_cf_KV` and
   `sqlite_*`; do not modify `sqlite_schema` directly or delete storage objects.
2. Verify the application schema and old migration ledger are absent. A database
   with the same UUID is now an empty application target; the new-empty S2
   baseline can initialize it. The baseline must never be applied on top of the
   non-empty old schema. Do not falsify migration-ledger entries.
3. With access and maintenance still paused, merge the reviewed, passing #202
   head and run the existing `build:deploy` and `deploy:remote` commands on that
   final source. The complete verification gate remains enabled, followed by
   the ordinary baseline migration and deployment. It creates the new migration
   ledger normally. Use the same D1/R2 Build Variables and unchanged runtime
   file-storage settings. Temporarily set only `DEPLOY_WORKERS_DEV=false` so
   the deployment itself does not reopen workers.dev before database checks;
   restore its original value when reopening access. The configured daily Cron
   can be restored by deployment; ensure it cannot fire during the operation
   and remove it again after deploy if acceptance is still pending. Never run
   the former S0 application against S2.
4. Confirm the deployed code, version and unchanged bindings; verify the ledger
   contains only `0001_v3_baseline.sql`, the expected S2 structure/seed rows,
   `PRAGMA quick_check` and `PRAGMA foreign_key_check`. Confirm the expected new
   version serves all traffic. Keep ingress paused during database checks and
   account for deployment configuration restoring the configured Cron.
5. Restore Access-protected application access and perform the acceptance below.
   Resume the original automatic-build commands/watch paths and Cron only when
   the accepted final source and schema match. Record actual results before
   completing Phase 6A6; remaining C4 and Phase 5D–5F follow that checkpoint.

## Acceptance

- Authenticated readiness succeeds and unauthorized API requests remain rejected.
- Create a Sample, template/Run and Project; save, reload and verify the records.
- Add Comment text and an image; check Reference source navigation.
- Upload and download new files using the retained R2/SWITCHdrive configuration,
  comparing downloaded bytes with the original. Confirm old files were not
  cleared as a side effect of the database operation.
- Export a complete ZIP and restore it in the existing isolated/local recovery
  harness; compare data and packaged file bytes. An isolated restore test does
  not require a new Cloudflare database or bucket for the application.

## Failure handling

Before the reset starts, the untouched old schema can resume with its old code
and original controls. After tables or ledger have been cleared, keep maintenance
in place until S2 initialization and deployment succeed. Inspect partial state
and retry only the reviewed reset/initialization path. A code-only rollback to
S0 cannot reconstruct discarded rows or make S0 compatible with S2. Do not
reopen the old application over a partial/new schema. Files and all storage
bindings remain in place throughout; no automatic cleanup is part of recovery.

## Execution record

See the [activation checkpoint](./CLOUDFLARE_S2_ACTIVATION_CHECKPOINT.md) for live
inspection and control changes. The earlier new-resource/root-switch proposal
was superseded before any remote database or storage binding changed. The
owner's current instruction is authorization for the disposable database reset;
remaining checks concern stopping writers and executing the reviewed procedure.
