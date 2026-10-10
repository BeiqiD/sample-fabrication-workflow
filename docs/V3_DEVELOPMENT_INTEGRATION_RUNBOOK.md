# V3 development integration and forward rollout

Status: development handoff procedure under review, 2026-10-10. This document
records source behavior and required evidence; it does not report a remote
migration, provider activation or completed release.

The owner authorizes autonomous development, reviewed PR merges and testing on
`v2/backend-foundation`, including its existing development Workers build/deploy
path. Production `main` and actual production file movement remain outside the
development task. The earlier fresh-production defaults in [Deployment](DEPLOYMENT.md)
are not a requirement to disable this explicitly authorized development branch.
Keep the development Worker and its resources separate from production.

## Capture the actual handoff

PR #250 merged the roadmap into development integration at
`541eedb1405678097675aac5eb1284bf3c8ef950`. That was a documentation-only merge;
FP2–FP5 and the synchronized frontend implementation were still on
`codex/fp2-fp3-development@4b2c660267b794d09798f961efe8d11ba6e1df86` at this
runbook's initial inventory. Its runtime code equals the earlier qualified
`3c1baf5` checkpoint. Later heads need their own review and checks.

For each implementation PR, record:

- exact base/head and accepted code/docs tree, required checks and review outcome;
- actual serving Worker version and built commit, not only a successful build;
- development account/Worker, source `DB`, `ASSETS` and frozen R2 namespace;
- observed migration ledger and schema generation, preserving historical evidence;
- effective authentication/admin policy, executor status and enabled capability scope;
- optional recovery target identity, isolated provider fixtures and outstanding live gates.

Store operational identity/credentials and research snapshots privately. Commit
only redacted receipts, scope, checks and runbook findings. Never print tokens,
Access assertions, private redirect URLs or encrypted credential payloads.

## Discover configuration without changing resources

These repository reads establish source identity and the gate inventory:

```sh
git status --short
git rev-parse HEAD
git rev-parse origin/v2/backend-foundation
git merge-base HEAD origin/v2/backend-foundation
git diff --stat origin/v2/backend-foundation HEAD
node scripts/run-verification.mjs --mode ci --list
node scripts/run-verification.mjs --mode deploy --list
```

Read the selected development Worker's actual Builds settings or available
read-only configuration API. Record its branch, root directory, build command,
deploy command and binding identities. **The configured automatic command is
unknown until inspected**. Do not infer it from a GitHub Cloudflare check, copy
the fresh-production example, or assume a plain `wrangler deploy` applied D1
migrations.

The repository's `package.json` defines this controlled remote path:

1. `deploy:remote` runs `verify:v3-deployment`.
2. `internal:db:migrate:remote` regenerates deploy configuration, verifies built
   and migration bootstrap agreement, then applies reviewed migrations to `DB`.
3. `wrangler deploy` publishes the verified Worker and static assets only after
   migration succeeds.

The generator requires complete installation-owned `DEPLOY_*` inputs and a safely
resolved Cloudflare account. It does not create resources. The bootstrap check
binds the built Worker to the source database and exact ASSETS namespace; an
optional recovery target must also agree with the built configuration. Missing,
ambiguous, mismatched or invalid inputs stop the path before remote migration.
See [generator](../scripts/generate-wrangler-config.mjs),
[bootstrap guard](../scripts/lib/cloudflare-bootstrap.mjs) and
[deployment command](../package.json).

The initial source review found that a valid generated `RECOVERY_DB` configuration
was rejected by the old one-database bootstrap guard. Its pre-fix isolated
reproduction failed (0 passed / 1 failed). The repaired guard binds both named
database identities and the optional target ID, rejects source aliases, incomplete
or extra bindings and drift, and preserves account/ASSETS agreement. The focused
`node --test scripts/cloudflare-bootstrap.test.mjs` run passed **11/11** on
2026-10-10. These local fixture checks do not establish an installed remote target
or qualify the later combined-tree complete gate.

If an authorized D1 Read credential and the exact development IDs are available,
the existing observer can capture schema and migration receipts:

```sh
node scripts/observe-remote-d1-migrations.mjs \
  --account-id <development-account-id> \
  --database-id <development-database-id> \
  --output /tmp/new-private-development-observation.json
```

This tool uses only its fixed SELECT/PRAGMA observation sequence through the D1
query API, rejects write metadata and redirects, and takes `CLOUDFLARE_API_TOKEN`
from the invoking environment. It neither loads credential files nor creates the
ledger, runs migrations or authorizes activation. Its HTTP POST transports SQL
reads. A missing credential or network allowlist is a discovery limitation, not
permission to substitute unverified IDs or bypass the managed proxy. Migration
receipt names/times do not establish the original SQL file bytes.

An anonymous site 302 to Cloudflare Access proves connectivity only. Authenticated
API acceptance needs a legitimate Access identity whose validated JWT has the
required email claim and passes the application allowlist. A service token without
that claim is insufficient. Do not weaken Access or fabricate assertions to test.
System administration additionally requires `AUTH_MODE=access` and the separate
`SYSTEM_ADMIN_EMAILS` policy; disabled local authentication grants no administrator.
See [authentication](../worker/auth.ts) and
[system-administrator check](../worker/storage/system-administrator.ts).

## Review the paired schema generations

The historical V20/0017 deployment is a dated checkpoint. Confirm the current
target before proposing this suffix; never assume a remote target is still at it.

| Forward migration | Matching ordinary content generation | Admission boundary |
| --- | --- | --- |
| `0018_fp2_native_file_runtime.sql` | V21 native File runtime | Native byte access, verified publication/lifecycle and independent role defaults; optional provider bindings still need exact qualification |
| `0019_fp3_file_jobs.sql` | V22 persisted migration jobs | Installation-local executor admission defaults disabled; recovered job history cannot grant execution or cleanup |
| `0020_fp4_research_packages.sql` | V23 research packages | Sample and Project fresh-copy import identities differ from source identities; no scheduler is enabled by the migration |
| `0021_fp5_system_recovery.sql` | V23 content remains frozen | Installation-local recovery jobs/artifacts/target control are excluded from ordinary portable content; system executor defaults disabled |
| `0022_fp5_recovery_evidence.sql` | V24 portable recovery evidence | Exact file/alias/consumer evidence; immutable historical rows and rowids survive reviewed table reconstruction |

Migration number, archive version, package format and runtime enablement are
different contracts. `research-package/1` and `system-backup/1` are not relabeled
ordinary content archives. Preserve frozen V7–V23 readers and the current V24
catalog, fingerprints, protected-data classification and receipt/hold invariants.
Uploaded SQL is evidence; recovery executes only the reviewed code-owned catalog.

Before merging the schema/runtime handoff, qualify both empty baseline-plus-suffix
installation and populated upgrades through every relevant boundary. Preserve the
exact S2 baseline and historical migration bytes; do not reset or recut them.
Compare old typed cells, NUL/BLOB/int64 values, physical rowids, accepted destinations,
aliases, jobs, source/candidate/read holds, references and deleted state. Require
SQLite quick-check, foreign-key checks, native D1/Wrangler statement splitting and
version-specific nonempty recovery. Whole-file SQLite success alone is insufficient.

The shared [verification plan](../scripts/verification-plan.mjs) currently has
12 canonical leaves, including source/native/mounted, contract checks, migrations,
Worker smokes and one build. CI uses local bindings; deploy mode uses the deploy
build and final isolated artifact smoke. Passing one profile does not establish
an actual remote/provider pass. Retain the default Vitest deadline and individual
case limits; a larger job budget is not evidence of a performance repair.

## Merge and forward deployment

1. Resolve latest accepted roadmap and implementation documentation together.
   Preserve dated evidence and update the current status matrix. Review the
   actual combined implementation, paired migration/recovery generations and
   configured automatic build/deploy path.
2. Qualify the exact PR head with the full default Verify gate and required Map
   gate. Merge through a reviewed PR against development integration; do not
   bypass failed or unexecuted required checks.
3. Confirm the automatic build uses the verified migration-first path and the
   development identities captured above. If it does not, complete a reviewed
   development handoff before applying the missing suffix. Do not guess or run
   an additional remote deployment concurrently with a queued automatic build.
4. Capture actual applied names/final ledger, built commit, serving version and
   authenticated development readiness. `/api/ready` checks database reachability
   only; it does not prove schema completeness, provider readiness, scheduler
   limits or recovery target qualification.
5. Validate the exact current ordinary export generation and stale-client
   behavior, then scoped disposable research workflows and affected APIs. Take
   before/after snapshots when a test writes disposable development data, and
   retain accepted-operation evidence until reconciliation completes.

This procedure uses ordinary forward migrations against an already admitted S2
installation. It never repeats the historical disposable baseline reset, replaces
source bindings, activates S3, moves existing bytes or grants restored execution.
Those are distinct explicitly reviewed operational actions.

If verification/bootstrap fails, no remote migration should have started. If a
migration or deployment fails, inspect the real schema/ledger and build state
before continuing. Keep the exact reviewed commit and finish the failed rollout
forward; do not downgrade schema, deploy an older incompatible Worker, reset data,
manually forge ledger entries or relabel an archive as current. Complete export
can be unavailable in the schema-to-Worker interval; this runbook promises no
zero-downtime bridge. If an individual migration is incomplete, its ledger absence
alone does not authorize blind replay; qualify the repair from observed state.

The current export route probes complete markers/columns, refuses inconsistent
generations and returns 409 when a supported request's archive schema differs
from the installed generation. The current frontend requests V24; an old V20
request after a complete V24 upgrade must not receive a falsely complete V20
backup. Older serving Worker failure codes are version-specific; retain their
actual evidence rather than assuming every old writer returns 409.
See [export negotiation](../worker/export-routes.ts),
[V21 tests](../worker/export-v21-protocol.test.ts) and
[V24 restore planning](../scripts/lib/export-restore-migrations.test.ts).

## Keep enablement separate from installed source

| Capability | Evidence needed before claiming operational enablement |
| --- | --- |
| FP2 provider/default activation | Actual tested candidate revision, credential envelope and exact account/bucket/root/binding; independent complete-byte write/readback and visible outage behavior |
| FP3 migration/cleanup | Actual runtime CPU/memory/elapsed budget, qualified interruption/unknown PUT handling, installed bounded dispatcher and explicit current-incarnation grants; changing defaults never moves old files |
| FP4 native packages | Enabled executor/storage scope, complete nonempty dependency graph, matching website copy import and readable reports; original-vs-copy identity remains explicit |
| FP5 backup/recovery | Complete current backup, isolated provisioned fresh target, destination byte verification, protected key/config policy, restored execution disabled and assisted binding/traffic handoff |

The checked-in Cron remains daily, not the proposed two-minute runner cadence.
Installing source does not qualify or enable that cadence. A missing provider
retains visible holds/cleanup obligations; it never authorizes fallback or deletion.
Unqualified installed capabilities must remain effectively unavailable at server
admission, with their deferred status recorded in the release scope.

The optional `DEPLOY_RECOVERY_D1_DATABASE_NAME`, `DEPLOY_RECOVERY_D1_DATABASE_ID`
and `DEPLOY_RECOVERY_TARGET_ID` inputs must be supplied as one complete group for
a separately provisioned target. A generated `RECOVERY_DB` binding does not prove
freshness. Do not apply the source `DB` migration command to the fresh recovery
database: the recovery engine verifies ownership/freshness, installs its reviewed
target catalog and writes the reviewed ledger only after verification. Preserve
source/target identity distinctions even when bytes share a qualified bucket.
See [FP5 target procedure](FP5_SYSTEM_RECOVERY.md#website-recovery-and-destination-verification)
and [code-owned target ledger](../worker/recovery/target-migrations.ts).

## Remaining roadmap gates

After integration, complete bounded 5F cross-page semantics/action ownership,
read/retry/focus/uncertain-write review and realistic mixed-product browser/theme/
responsive acceptance. Preserve completed C4/5D/5E and repair observed gaps.
Measure named Project/Processing/archive/test workloads before optimizing.

Then qualify the combined-tree 6A6 exit and enabled-scope 6B matrix: fresh/populated
upgrades, current nonempty archive/package/recovery round trips, provider failures
and interruption, old-tab lazy-chunk recovery, accessibility/security, performance,
physical OS/device input and operational handoff. Local fixtures, browser mocks and
historical provider passes retain their scope. Missing Access/provider/target/device
evidence remains open while independent implementation continues.

Prepare production release artifacts separately; publication to `main` requires
production scope authorization. Later milestones implement the complete Node/
Docker/SQLite/local-volume app and actual cross-deployment recovery, then shared
workspace membership and domain-root permissions across routes/media/search/
references/packages/jobs. Existing Node File-runner tests do not complete hosting.
Optional search/derivative/LLM/live-collaboration ideas remain separate measured
decisions. The [Product roadmap](PRODUCT_ROADMAP.md#near-term-order-and-first-integrated-release)
owns the milestone order and current acceptance ledger.
