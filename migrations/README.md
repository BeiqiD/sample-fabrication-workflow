# Final S2 candidate — not activated

This candidate directory contains only `0001_v3_baseline.sql`, the exact reviewed
bytes of `scripts/fixtures/backend-schema/s2-baseline.sql`. Its original
"inactive candidate" comments preserve the source and review provenance. Local
application checks in this branch select this baseline to create **new, empty**
databases. No existing database may receive this file.

The 37 historical migration files are preserved unchanged in
`migrations-history/s0/`. History and archive recovery tests name that directory
explicitly. The existing-ledger planner, retained S0 → S1 → S2 rehearsal, and
exact historical file hashes remain mandatory checks.

This branch remains preparation until the target and build inputs are paired.
For the authorized disposable integration, follow the
[direct S2 cutover](../docs/BACKEND_DISPOSABLE_S2_CUTOVER.md): serialize Builds,
create new empty D1 and isolated file resources, and deploy the final C/S2
application with those bindings in one version using the ordinary complete gate.
Keep old resources intact and perform the final browser/recovery acceptance.
Never merge while automatic builds still point to the original S0 database.

Data-preserving upgrades of an existing database still require the staged
selection, old-request retirement evidence and recovery qualification in the
[compatibility preflight](../docs/COMPATIBILITY_STAGE_PREFLIGHT.md). They receive
only their admitted historical suffix, never this new-empty baseline.
