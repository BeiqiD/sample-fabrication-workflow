# Data model

| Entity | Purpose |
|---|---|
| `samples` | A physical wafer, chip, piece, or other tracked item. Self-reference represents parent/child splitting. |
| `events` | Append-oriented timeline records: creation, comments, images, location/status changes, and run-step activity. |
| `template_versions` | Immutable snapshots imported from FabuBlox as a process, module, or recipe. |
| `runs` | Assignment of one template version to one sample. |
| `run_steps` | Ordered, mutable execution state for the steps copied into a run. |
| `imports` | Pending/ready/failed state for one confirmed FabuBlox workbook import. |
| `assets` | R2 object metadata and readiness state for imported and ordinary uploads. |
| `template_steps` | Structured immutable step records normalized from one template version. |
| `template_step_assets` | Relationship between an imported step and its layer-stack diagrams. |

R2 object keys are stored in D1. The bucket stays private and the Worker returns assets only through application routes. Exporters must replace those keys with relative paths inside the resulting ZIP.

Location, lifecycle status, and pinned changes are recorded by database triggers. This makes the current value and its append-only timeline entry part of the same statement. The update API also requires the caller's last-seen `updated_at` value and rejects stale writes.

Ordinary uploads are registered after the R2 write succeeds; a failed registration removes the object. The full export covers every database table and the union of registered assets plus imported source workbook and manifest keys.

Validated Cloudflare Access email addresses are stored on events and other mutable/imported records. Older rows created before the attribution migration remain valid with a null actor.

`last_mutation_id` values are internal concurrency tokens. They allow dependent event inserts to prove that the preceding conditional update succeeded within the same transactional batch.
