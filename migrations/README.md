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

This branch is preparation only. It must not merge into the S0 automatic
deployment branch or run remote migration/deployment commands. Remote activation
still requires the approved staged executor, old-request retirement evidence,
recovery qualification, and browser acceptance described in
`docs/COMPATIBILITY_STAGE_PREFLIGHT.md`.
