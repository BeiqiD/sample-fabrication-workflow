# Final S2 baseline

This directory contains only `0001_v3_baseline.sql`, the exact reviewed bytes of
`scripts/fixtures/backend-schema/s2-baseline.sql`. Its provenance comments remain
unchanged. The baseline requires an empty application schema and migration
ledger. This may be a newly created database or the existing disposable test
database after the explicitly authorized and verified reset; it must never be
applied over a non-empty historical schema.

The 37 historical SQL files remain unchanged in `migrations-history/s0/`.
Retained-data upgrade planning, staged rehearsal and hash checks still use that
history. Ordinary CI and deployment verification gates remain enabled.

For the current test installation, follow the
[in-place S2 rebuild](../docs/BACKEND_DISPOSABLE_S2_CUTOVER.md): pause application
access, deployments and background writers; finish old requests; use the
[reviewed manual reset](../scripts/operations/README.md); apply this baseline and
deploy C/S2 while retaining the Worker, D1 UUID, R2 and SWITCHdrive bindings.
Old file cleanup is a separate task. Never automatically run the manual reset
as part of normal migrations or deployment.

Data-preserving upgrades require the admitted historical suffix and the
[compatibility preflight](../docs/COMPATIBILITY_STAGE_PREFLIGHT.md), not a reset.
