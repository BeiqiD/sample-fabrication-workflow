# Data model

| Entity | Purpose |
|---|---|
| `samples` | A physical wafer, chip, piece, or other tracked item. Self-reference represents parent/child splitting; a child can retain the parent's structure hash at the split boundary. |
| `events` | Append-oriented timeline records: creation, comments, images, location/status changes, and run-step activity. |
| `recipe_families` | Legacy internal table name for the stable identity shared by successive process-template versions. |
| `step_definitions` | SHA-256-addressed instructions; order and version are deliberately excluded from the hash. |
| `state_representations` | SHA-256-addressed expected sample states, currently represented by ordered diagram assets. |
| `template_versions` | Imported or cloned versions with an ordered manifest of logical step, definition, and expected-state hashes. |
| `runs` | Ordered process runs for one physical sample, including the immutable initial substrate hash, predecessor, and anchor step. |
| `run_plan_revisions` | Immutable records of which process-template version governed the unfinished plan at each revision. |
| `run_steps` | The actual execution chain. Template-derived rows reference definitions; corrections are nullable overrides and ad-hoc rows are explicit actual steps. |
| `run_step_plan_links` | Links process-template plan entries to stable actual run-step identities across plan revisions. |
| `run_step_assets` | Execution and observed-state images uploaded during fabrication. |
| `state_verifications` | Sparse observed-state anchors connected to the previous verification. |
| `state_verification_steps` | Immutable snapshot of the actual steps covered by a verification interval. |
| `imports` | Pending/ready/failed state for one confirmed FabuBlox workbook import. |
| `assets` | R2 object metadata and readiness state for imported and ordinary uploads. |
| `template_steps` | Ordered logical references from a process-template version to hashed definitions and expected states. |

R2 object keys are stored in D1. The bucket stays private and the Worker returns assets only through application routes. Exporters must replace those keys with relative paths inside the resulting ZIP.

Location, lifecycle status, and pinned changes are recorded by database triggers. Process-run triggers also keep the normal lifecycle synchronized: starting or reopening a run makes its sample `active`, and completing the run returns an `active` sample to `stored` without overriding an explicit `consumed` or `lost` state. This makes the current value and its append-only timeline entry part of the same statement. The update API also requires the caller's last-seen `updated_at` value and rejects stale writes.

Ordinary uploads are registered after the R2 write succeeds; a failed registration removes the object. The full export covers every database table and the union of registered assets plus imported source workbook and manifest keys.

New `assets` rows carry a SHA-256 protected by a partial unique index. Imports resolve the workbook, normalized manifest, and every embedded image against that index before writing R2; duplicates within one upload are also collapsed. Rows created before this migration retain a null hash until a future maintenance backfill, so deduplication is guaranteed for newly received content.

Validated Cloudflare Access email addresses are stored on events and other mutable/imported records. Older rows created before the attribution migration remain valid with a null actor.

`last_mutation_id` values are internal concurrency tokens. They allow dependent event inserts to prove that the preceding conditional update succeeded within the same transactional batch.

`samples.process_revision` is retained only for compatibility with the deployed alpha schema. Current concurrency control uses `updated_at` and `last_mutation_id`; application writes no longer increment the legacy column. Removing it should be a future explicit migration rather than an edit to the already-deployed initial migration.

`recipe_change_proposals` is a legacy internal name for evidence opened by mismatched state verification. It is included in full export and prevents referenced template history from being deleted, but it does not yet have a review interface.

A process-template version states what should happen and what state should result. A process run records what did happen. `run_step_plan_links` connect those views without treating an execution correction as a template edit.

Plan updates align the normalized sequence of step names while preserving relative order. Step numbers are display metadata; parameter, note, custom-field, and diagram changes do not determine identity. Compatible future entries retain their run-step IDs, new entries are appended after the execution head, and displaced unfinished entries remain auditable as superseded. Changes or removals affecting completed steps are recorded as historical differences without rewriting execution; a newly inserted step before the execution boundary still requires manual review.

Deleting an unused template version removes its version and ordered step rows. Import provenance and content-addressed assets are retained because they may be shared; a version already used by a process run is archived instead of deleted so run and plan history remain resolvable.

Verification is not inferred from `done`. A user may verify after any step once every current step in the interval is done or skipped. The verification stores its predecessor and an explicit ordered coverage snapshot; a mismatch also opens process-change evidence without mutating execution history.
