# Phase 5F initial local integration goal

Status: active local development, 2026-10-09 (Europe/Berlin).
Working branch: `codex/fp2-fp3-development`.

The owner requested continued development and merging roadmap Draft PR #250 at
an appropriate checkpoint. Previously completed FP2–FP5, bounded C4, 5D and 5E
remain the baseline. This goal records the initial bounded 5F slices; finishing
them does not by itself close the entire cross-product or release acceptance.

## Authorized scope and preserved boundaries

Local source changes, isolated fixtures/browser work, verification, ordinary
development-branch pushes and the reviewed PR #250 merge are authorized.
Production deployment, remote database migration, real provider activation and
actual development-data changes are outside this goal. Keep `main` unchanged.
Do not bypass branch protections or required checks to merge. Confirm the merge
transport and deployment boundary before writing the integration branch.

## Current starting evidence

- The synchronized implementation at `2060c74` passed bounded local 5E checks,
  but remote Verify run `37918377223` failed the V21 recovery test at the default
  5,000ms deadline. Its earlier local source qualification used 15,000ms.
- Test-only commit `4479295` prepares real populated V20/V21 migration baselines
  once and copies independent SQLite fixtures. All original recovery assertions
  and migration replay remain. The focused default-timeout suite passed 11 cases;
  the previously failing case measured 3,091ms versus 4,667ms before the change.
  These are local observations, not a production restore benchmark.
- Remote Verify run `37976554667` was cancelled at the workflow's 20-minute job
  limit, with no specific test failure annotation. This does not qualify the
  complete gate. Map performance run `37976554666` passed. The sequential complete
  gate now has a 40-minute job budget; individual test deadlines remain unchanged.
- PR #250 at `8134fe6` correctly acknowledges completed development and separate
  remote/integration/provider acceptance. Its remaining old status prose needs
  cleanup. Standard GitHub API access currently fails at proxy CONNECT with 403;
  successful development-branch Git push does not prove PR merge availability.

## Initial slices and exits

1. Resolve default-CI qualification without dropping migration, corruption,
   recovery or security coverage. Run the appropriate complete gate and obtain
   the actual remote result for the final submitted implementation head.
2. 5F-1a: distinguish first-read network/500 failure from an uncertain write in
   research packages and system recovery. Preserve authorization, original
   request identities and reconciliation. Verify safe GET-only retry.
3. 5F-2a: bind Processing plan/start previews to their source and transition
   session. Late success, error and completion must not affect a different
   selection/session. Existing results must become unusable when their owner
   changes. Preserve mutation and plan-revision preconditions.
4. Integrate the existing modal focus contract for the Processing template picker;
   verify Escape, Tab, pending-close protection and dialog focus handoff.
5. Measure the documented narrow Process discrepancy for 3, 4 and 8 samples at
   720/721px in both themes. Apply a minimal selector repair only if demonstrated,
   preserving the existing desktop widths and grid behavior.
6. Reconcile the roadmap documents, run appropriate link/status checks and merge
   PR #250 when its actual checks, review and non-deployment boundary permit it.

Retain dated raw failures and successes rather than replacing them with a
blanket green claim. Real devices/IME, authenticated deployment, real providers,
operational recovery admission and release acceptance remain separate exits.

## Follow-up

Continue the remaining 5F cross-product review and measured performance lane,
then the actual enabled-scope 6A6/6B review. This goal neither retires historical
archive readers nor changes migrations, authorization, provider selection or
accepted-operation protocols.

## Development checkpoint — 2026-10-09

The initial source repairs are implemented. Settings/data mounted checks passed
21 tests; Processing preview, existing Process/Timeline and modal checks passed
57 tests; six positive/blocked mocked-confirmation cases passed. Local build
passed. These results preserve ordinary start/update/reopen payloads and refresh.

The narrow grid discrepancy was measured before repairing its missing selector.
All 12 post-repair layout cases passed. Eight actual local preview/focus cases
passed: four unconfirmable start-preview responses (200) and four historical
plan-preview rejections (404). The historical fixture has no plan revision;
this browser result does not qualify a successful plan preview or real mutation.
The isolated server is stopped and actual development-data schema/typed rows/
physical rowids remain identical to the retained pre-5E baseline.

Complete default gate, final submitted-head remote checks, the remaining 5F
review and PR #250 merge are still open. Preserve the original failed harness
runs and their diagnosed corrections in the acceptance record.
