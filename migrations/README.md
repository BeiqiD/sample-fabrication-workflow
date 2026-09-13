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

The [activation checkpoint](../docs/CLOUDFLARE_S2_ACTIVATION_CHECKPOINT.md)
records completion of the selected same-D1 S2 reset and deployment. The
[in-place rebuild](../docs/BACKEND_DISPOSABLE_S2_CUTOVER.md) and
[manual reset procedure](../scripts/operations/README.md) are retained operational
evidence, not instructions to repeat that reset for subsequent features. Their
recorded file bindings and unfinished acceptance/cleanup remain separate matters.
Never automatically run the manual reset as part of migrations or deployment.

Retained-data upgrades from a historical S0/S1 installation still require their
admitted historical suffix and [compatibility preflight](../docs/COMPATIBILITY_STAGE_PREFLIGHT.md).
That is different from extending an installation already at S2.

Future FP changes use reviewed forward migrations after the immutable S2 baseline.
The current directory is still baseline-only: adding the first suffix must update
[schema-source qualification](../scripts/current-schema-source.test.mjs), migration
planning and recovery/version coverage in the same implementation slice. Preserve
the baseline and historical byte hashes; do not drop those checks merely to admit
new SQL. Qualify both fresh baseline-plus-suffix installation and populated S2
upgrade. No suffix or remote change is introduced by this documentation update.
See the [repository compatibility audit](../docs/FILE_DATA_PORTABILITY_REPOSITORY_COMPATIBILITY.md).
