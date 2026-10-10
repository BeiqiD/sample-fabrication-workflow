# S2 baseline and forward migrations

For the reviewed `0017` → `0018`–`0022` development handoff and paired
V21–V24 content/recovery generations, use the
[V3 forward integration runbook](../docs/V3_DEVELOPMENT_INTEGRATION_RUNBOOK.md).
Source and fresh recovery target identities remain separate. Installing source
does not activate providers, restored execution or a new scheduler cadence.

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
or changing storage bindings.

`0007_fp1_file_authority_transition.sql` is the additive authority expand
boundary. It adds nullable typed File foreign keys for all 13 locator-bearing
slots across the 11 consumer categories, immutable full-read publication and
derivation evidence, File/location holds, location quarantine and fenced GC
claims, frozen consumer decisions, per-file acceptance candidates, and complete
typed projection/retention/availability views. It does not rewrite the four
FP1a tables or the legacy `blob_retention_edges` family. The singleton authority
row is deliberately fixed at `legacy`; apart from the migration-owned control
seed and `read_only` runtime companions maintained for storage profiles, every
typed binding and runtime write to new authority/sidecar state is rejected until
a later reviewed forward migration installs overlap-capable Worker behavior.
There is no backfill,
inferred verification, binding change, byte I/O, or reset in `0007`.

All new authority/evidence tables are `WITHOUT ROWID`. The four older FP1a
registry tables retain historical rowids, so `0007` records each occupied value
in the internal, rebuildable `file_registry_rowid_claims` table and rejects any
replacement that tries to reuse it; valid new negative rowids remain supported.
Existing consumer tables retain their historical rowids, so typed/decided
occurrences also guard hidden rowid conflicts, `INSERT OR REPLACE`,
`UPDATE OR REPLACE`, deletion and locator mutation. The exact legacy-to-new lifecycle bridge is
`legacy_file_mappings.location_id`; equal object keys in separate storage profiles
must never alias. Ready bindings require usable publication, and derivative
bindings additionally require matching verified generator/version evidence.
File retirement and location GC remain active-mode-only; overlap candidates,
holds, retention, quarantine and monotonic claim timestamps fence cleanup.

The future overlap writer must finish a same-candidate File publication and
candidate-ready transition in one D1 batch with atomic rollback. It must also add
an event occurrence tombstone/release protocol and mixed-Worker ordering before
backfilling event asset/thumbnail File slots. Terminal migration decisions preserve
otherwise-valid historical TEXT evidence exactly, including values outside the
new operation-field bounds.

The frozen 0007 full export/recovery generation uses schema 14 and preserves this legacy authority
state; historical archive validators remain specific to their original suffixes.
The route probes the expected bounded generation markers before snapshotting and V14 freezes
a deterministic fingerprint of transition-relevant tables, views, indexes and
triggers. Its same-batch snapshot also validates the local registry-rowid claim
set; isolated recovery rebuilds that non-portable derived table from restored
registry rowids. Future archive generations require a new completion marker and
reviewed fingerprint.

Package deployment is migration-first. After `0007` but before the V14 Worker is
live, old business reads/writes remain compatible but an old V13 `/exports/all`
request returns 500. Once V14 is deployed, a stale V13 page receives 409 and must
refresh. Requiring zero
export interruption implies a separately reviewed two-stage bridge Worker before
the migration; this slice does not provide one.

If the Worker deployment fails after `0007` has committed, do not roll the
migration back or serve a relabelled V13 archive. Retry the exact reviewed V14
Worker deployment, then verify a successful V14 export and a 409 response to a
stale V13 request. Until that succeeds, legacy business paths remain compatible
but the complete-export outage can outlast the normal migration-first window.

Keep CASE endings separated from punctuation (`END )` and inline `END ;`) and
retain standalone terminal trigger `END;`. Qualification executes Wrangler-split
statements individually and checks that all schema objects exist before the
migration tracking INSERT. Whole-file SQLite execution alone did not detect the
original `0004` deployment failure; remote migration remains a deployment gate.

## Shadow runtime suffix

`0008_fp1_shadow_runtime.sql` adds the all-13-slot occurrence capture and
conversion protocol described in [FP1 shadow runtime](../docs/FP1_SHADOW_RUNTIME.md).
Migration stays in legacy mode with a disabled local runtime. Explicit commands
admit overlap and an exact destination profile; active authority remains blocked.
Old Worker mutations capture successor generations in the same transaction, and
legacy-visible holds fence uncertain source use against old GC.
This is SQL capture compatibility, not a guarantee of old Worker response
classification: D1 trigger writes inflate `meta.changes`.

The `0008` to V15 deployment remains migration-first. It may proceed without an
operator-imposed business-write pause only with the verified active
[trigger-compatible bridge](../docs/FP1_TRIGGER_COMPATIBLE_ROLLOUT.md): record the
exact reviewed bridge commit and Worker version, verify that version is actually
serving all application traffic on `0007`, and drain older Worker writers and
their in-flight work before applying `0008`. A merge or successful build alone is
not deployment evidence. Keep authority in `legacy` mode and the local execution
gate disabled, and prevent an older queued build or rollback from reintroducing
an incompatible Worker. The bridge can then continue legacy business writes
through the schema-to-Worker interval. Verify first creation, replay,
deletion/restoration, V15 export and stale-version rejection after deploying the
reviewed V15 Worker.

Without that verified bridge prerequisite, use the coordinated maintenance
window: pause business writes before `0008`, deploy the matching Worker with
exact top-level affected-row checks, and complete those verification checks
before resuming writes. Keep writes paused if that Worker deployment fails.
These instructions do not establish that a bridge deployment has occurred.

The `0008` complete export/recovery checkpoint is schema 15, profile `fp1-shadow-conversion`.
It preserves canonical shadow history and portable source rowid evidence, while
recovery resets the non-portable execution gate and incarnation history. No
restore or migration runs provider I/O. A post-0008 database requires the V15
Worker for complete export. During the bridge's schema-to-Worker interval,
complete-export snapshots that observe `0008` return HTTP 409; a snapshot
completed before migration remains valid. Complete export resumes after V15 is
deployed and its export and stale-version rejection checks pass. If migration
succeeds but V15 deployment fails, finish deploying that reviewed Worker with
conversion disabled; the write-pause requirement depends on the verified bridge
prerequisite above. Keep V7–V14 validators frozen, and complete a failed
migration-first rollout forward instead of downgrading or relabelling an archive.
A V14 archive is not a complete backup of a post-0008 database.

`0009_fp1_shadow_withdrawals.sql` adds immutable withdrawal receipts and requires
the matching V16 Worker for complete export. `0010_fp1_shadow_adjudications.sql`
adds operator-evidence histories, revocations, withdrawals and immutable
operation bindings, with matched V17 export/recovery. It preserves existing
business paths, runtime pause state and storage bindings; it approves no
reference and performs no provider I/O. V15/V16 archives remain frozen and
recoverable. Forward recovery creates empty later ledgers and cannot invent
decisions that were not present in the source archive.

Deploy each migration with its matching Worker through the normal forward path.
Complete export is unavailable between the new migration and its Worker;
stale archive negotiation must reject instead of omitting the new history.
No database reset or binding replacement is needed. The V17 operator boundary
remains disabled until explicitly configured as documented in
[Deployment](../docs/DEPLOYMENT.md). Positive adjudication requires real evidence,
and File authority activation remains separate.
