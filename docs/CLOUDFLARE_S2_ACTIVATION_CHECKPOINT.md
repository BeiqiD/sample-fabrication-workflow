# S2 activation checkpoint — 2026-09-13

Status: remote target inspected; activation blocked by Cloudflare write authentication.

## Verified state

- The active integration source is `v2/backend-foundation` at
  `b8fc0bb4f5ec25fe54879d5bf251c17131c809e7`, merged through PR #204.
  Cloudflare Workers Builds completed successfully at 10:06 UTC on 2026-09-13
  for that exact commit, and the deployment API reports one version at 100%.
- The integration Build trigger watches only that branch. Its build command is
  `npm run build:deploy`; its deploy command is `npm run deploy:remote`.
  The inspected build history contained no running/queued job; the integration
  deploy-hook list was empty. Repeat these reads immediately before a cutover.
- D1 and private R2 bindings match the current Build Variables. Managed storage
  is configured as SWITCHdrive, so its originals directory must be isolated too.
  Access remains enabled. Account identifiers, storage paths, identity settings
  and secret values are intentionally omitted from this repository record.
- The separate `main` deployment is unchanged and remains outside this cutover.
- PR #202 at the inspected head `ecbc7ee2985bb2e4870d967348e74c910d66a725`
  had all four check runs and all 14 `pre-pr/*` statuses successful. PRs #199
  and #200 remain alternative inactive preparations; their historical-fixture
  verification failures are not a reason to retry or activate them for this route.

## Attempted configuration and outcome

The authorized Cloudflare connection succeeded for reads but returned API error
`10000: Authentication error` for both the build-trigger PATCH and new-D1 POST.
Retrying the trigger request with explicit account scope also failed. Read-back
confirmed the existing trigger was not paused and the proposed new database did
not exist. Local Wrangler 4.112.0 reported unauthenticated. Browser automation
could not start because the local executor rejects a symlinked writable root.

No D1 or R2 resource was created or removed. No runtime binding, Build Variable,
Access policy, migration ledger or application data was changed. No merge or
S2 deployment was attempted. This is an authentication failure record, not
permission to bypass the existing verification or target-pairing requirements.

## Prepared change

The generated remote configuration accepts optional `DEPLOY_SWITCHDRIVE_ROOT`
and emits only `vars.SWITCHDRIVE_ROOT` alongside the explicit D1/R2 bindings.
Other dashboard variables use the existing `keep_vars: true` behavior; credentials
remain secrets. Omission preserves current behavior, and local configuration
ignores this input. Invalid empty roots, dot segments and backslashes fail
before configuration output. The focused test suite covers these boundaries.

This enables the new managed-originals folder to activate with the final S2
version. It does not verify folder emptiness, create the folder, or change the
currently serving root. That remote acceptance remains required.

## Local validation of the pairing change

The complete `npm run verify:ci` gate passed all 11 leaves on 2026-09-13:
90 verification-script cases, 1,119 source tests across 194 files, 467 mounted
tests across 62 files, rich-text bundle, export contract, actual Wrangler local
baseline migration, Reference and Reference-search Worker smokes, production
build, Map bundle, and production-artifact Project Worker smoke. No gate was
skipped or weakened. The 23 focused configuration/storage tests also passed.

Independent baseline review of the parent candidate reproduced identical final
schema and seed rows between the fresh baseline and the 37-file historical
chain plus S1/S2, with 34 tables, all historical hashes matching, and clean
integrity/foreign-key checks. These local results do not establish remote S2
activation, browser acceptance or authorization for an in-place reset.

## Resume point

1. Restore Cloudflare write authorization for Builds configuration and the
   account's D1, R2 and Worker deployment resources.
2. Recheck the exact PR head/CI, integration head, current version/bindings,
   active builds and deploy hooks. Do not reuse a stale inventory.
3. Follow [direct S2 cutover](./BACKEND_DISPOSABLE_S2_CUTOVER.md): pause and
   serialize builds, create and inspect new empty storage, pair all explicit
   Build Variables, then merge and run one ordinary gated deployment.
4. Keep old resources and matched versions available. Confirm final code,
   bindings, baseline ledger, schema/integrity, authenticated readiness,
   browser workflows and complete ZIP/isolated restore before resuming builds.
5. Record that live acceptance before completing Phase 6A6. Remaining C4 and
   Phase 5D–5F work follows the backend checkpoint; Phase 6B is still later.
