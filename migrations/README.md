# S2 baseline and forward migrations

`0001_v3_baseline.sql` retains the exact reviewed bytes of
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

FP1a adds `0002_fp1_file_registry.sql` after the immutable S2 baseline. It creates
four dormant identity/legacy-observation tables and changes no existing rows or
retention rules. It inserts no deployment profile and verifies no remote bytes.
The same slice updates
[schema-source qualification](../scripts/current-schema-source.test.mjs), migration
planning qualification and v9 recovery/version coverage. Preserve
the baseline and historical byte hashes; do not drop those checks merely to admit
new SQL. Qualify both fresh baseline-plus-suffix installation and populated S2
upgrade. See the [FP1a implementation boundary](../docs/FP1_FILE_REGISTRY_FOUNDATION.md).
No remote migration, reset or deployment is performed by this implementation PR.
See the [repository compatibility audit](../docs/FILE_DATA_PORTABILITY_REPOSITORY_COMPATIBILITY.md).

Later forward migrations add accepted FabuBlox requests (`0003`), ordinary and
Project byte uploads (`0004`), and
[metrology reference publication](../docs/FP1_METROLOGY_REFERENCE_ACCEPTANCE.md)
(`0005`), and [Comment acceptance](../docs/FP1_COMMENT_ACCEPTANCE.md) (`0006`).
These ledgers preserve operation history without activating File tables
or changing storage bindings. Current full export/recovery uses schema 13;
historical archive validators remain specific to their original suffixes.

Keep CASE endings separated from punctuation (`END )` and inline `END ;`) and
retain standalone terminal trigger `END;`. Qualification executes Wrangler-split
statements individually and checks that all schema objects exist before the
migration tracking INSERT. Whole-file SQLite execution alone did not detect the
original `0004` deployment failure; remote migration remains a deployment gate.
