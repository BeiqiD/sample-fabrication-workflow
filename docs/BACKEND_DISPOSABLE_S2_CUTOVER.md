# Disposable test environment: direct S2 cutover

Decision, 2026-09-13: the owner confirmed that the current integration database
contains no production data and authorized replacing its test content. The
selected route starts with empty resources; it does not retain or restore those
test rows. This decision applies to this integration installation, not to other
installations or the `main` production workflow.

## Selected route and scope

Create a new empty D1 database and private R2 bucket, then deploy the reviewed
final C/S2 application with both new bindings in the same Worker version. Keep
the old resources in place during acceptance. This obtains a clean test system
without dropping tables underneath an older Worker.

The C application and fresh baseline are already prepared in PR #202. It does
not require separately activating PR #200's B bridge, PR #199's standalone C
preparation, or the S0-to-S1-to-S2 suffixes. Those remain applicable to an
existing database whose data must survive the upgrade. Their compatibility
preflight and historical tests stay intact; no retirement evidence is fabricated
or waived for that different route.

Cloudflare records code, static assets and bindings together in a
[Worker version](https://developers.cloudflare.com/workers/versions-and-deployments/).
With distinct storage bindings, requests using an older version continue to
address the older resources. This removes old-request retirement as a condition
for initializing the new database. It does not prove that older requests ended,
and does not justify deleting their resources during the cutover.

## Existing implementation

`scripts/generate-wrangler-config.mjs` already generates the D1 `DB` and R2
`ASSETS` bindings from explicit Build Variables. The final candidate's ordinary
`npm run deploy:remote` runs the complete deployment verification, applies
`migrations/0001_v3_baseline.sql` to the selected database, and deploys the built
Worker and client only after migration succeeds. No new reset API, automatic
resource discovery or in-place destructive migration is needed.

The candidate's previous complete local gate and remote CI are recorded in
PR #202 at head `48834069023a8751d7c9cc6752af01662329f2ac`, tree
`b3efb157b81b596e92221346ad8d1a6dec0cbec5`. They cover the fresh baseline and
actual Worker/restore behavior. This document changes the selected activation
route; it does not constitute a remote deployment result.

## Ordered execution

1. In the authorized Cloudflare account, record the current integration Worker,
   deployed version, D1 ID, R2 bucket, build source/commands and managed-storage
   configuration. Verify this is the disposable integration target. Do not copy
   private settings or credentials into Git.
2. Pause automatic build triggers using the provider's supported controls.
   Cancel or finish already queued/running old-source builds and prevent manual
   or hook-triggered builds from racing the cutover. This concerns build jobs,
   not the lifetime of old HTTP requests. Keep the current Worker serving its
   current resources.
3. Create a new empty D1 database and private R2 bucket. Record their actual
   names and the new database UUID; require them to differ from the old targets.
   Check that the database has no application tables or historical migration
   ledger and the bucket has no objects. No original schema/ledger classification
   or export recovery is needed to preserve data that is being discarded.
4. Set the following **Build Variables** to the new resource values:

   | Variable | Required value |
   | --- | --- |
   | `DEPLOY_D1_DATABASE_NAME` | New database name |
   | `DEPLOY_D1_DATABASE_ID` | New database UUID |
   | `DEPLOY_R2_BUCKET_NAME` | New private bucket name |

   Preserve the reviewed Worker name and hostname settings. Confirm that the
   build's configured credential can access the new resources. Build variables
   are [build-time inputs](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/),
   not an immediate replacement of the running version's bindings. Do not edit
   the running Worker's `DB` binding separately before deploying C/S2 code.
5. If managed storage is configured, isolate it too: the final new version must
   use a new SWITCHdrive root or have that optional provider disabled. A new R2
   bucket alone does not isolate managed originals. Preserve Access/authentication
   settings and pair any managed-storage change with the final code deployment;
   do not first deploy old code with the new root. If this pairing cannot be
   prepared, use a separate test Worker for first acceptance. No provider change
   is required when managed storage is already unconfigured.
6. With old-source builds stopped and the new target settings confirmed, review
   the final PR head and its required CI, then merge PR #202. Keep automatic
   triggering paused until the build source and resource settings are paired.
   Run one build from that merged S2 source using the existing `build:deploy`
   and `deploy:remote` commands, with all existing verification gates enabled.
   The baseline must only be applied to the new database. Never retry an old
   source build using these new variables.
7. Confirm the deployed version contains the expected S2 code and new bindings,
   serves all new traffic, and the new D1 ledger records only the baseline.
   Verify schema/integrity and `/api/ready`, then exercise Sample creation,
   template/Run, Comment text and image, Project save/reload, Reference source
   navigation, and full export/isolated restore in the browser.
8. Resume automatic builds only for the final S2 source and new resources after
   acceptance. Record the actual version, target IDs and browser/export results,
   then complete the integrated 6A6 review. Do not mark backend exit complete
   merely because the fresh database was created.

## Failure handling

If verification or initialization fails, the old Worker can continue serving
its old resources. Inspect the new target before retrying; never redirect the
failed baseline to the old database. A retry against a successfully initialized
new database uses its existing baseline ledger instead of starting over.

If the deployed candidate fails acceptance, stop additional builds and return
the matched old application/resource version using the provider's supported
deployment controls. Restore the old build variables and source together before
resuming automation. Test records created only after the switch are disposable;
they are not silently merged back into the old database. Retain both resource
sets for diagnosis. Resource deletion is a later cleanup action, not part of
this first cutover attempt.

## Current execution checkpoint

The local Cloudflare CLI was actually checked with `wrangler whoami` and returned
`You are not authenticated`. No callable authenticated Cloudflare connection is
available in this session. No database or bucket has been created, cleared or
rebound, no Build Variables have been changed, and no remote S2 migration has
run. The next external step is authenticated target inspection and preparation
of the explicit new resources and serialized build. The remaining obstacle is
access and execution, not a requirement to preserve the disposable S0 data.
