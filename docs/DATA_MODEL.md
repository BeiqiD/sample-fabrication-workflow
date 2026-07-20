# Data model

| Entity | Purpose |
|---|---|
| `samples` | A physical wafer, chip, piece, or other tracked item. Self-reference represents parent/child splitting. |
| `events` | Append-oriented timeline records: creation, comments, images, location/status changes, and run-step activity. |
| `template_versions` | Imported or cloned process/module/recipe versions. Editable until first assignment, then locked; deletion is a soft archive. |
| `runs` | Sample-bound assignment with its own template name/type/version snapshot. It remains readable after the source template is archived. |
| `run_steps` | Ordered execution steps with immutable planned fields and independently editable actual fields. Ad hoc steps have no planned baseline. |
| `run_step_assets` | Planned diagrams copied at assignment and execution diagrams uploaded during fabrication. |
| `imports` | Pending/ready/failed state for one confirmed FabuBlox workbook import. |
| `assets` | R2 object metadata and readiness state for imported and ordinary uploads. |
| `template_steps` | Structured template step records. Editable only while the parent version has never been assigned. |
| `template_step_assets` | Relationship between an imported step and its layer-stack diagrams. |

R2 object keys are stored in D1. The bucket stays private and the Worker returns assets only through application routes. Exporters must replace those keys with relative paths inside the resulting ZIP.

Location, lifecycle status, and pinned changes are recorded by database triggers. This makes the current value and its append-only timeline entry part of the same statement. The update API also requires the caller's last-seen `updated_at` value and rejects stale writes.

Ordinary uploads are registered after the R2 write succeeds; a failed registration removes the object. The full export covers every database table and the union of registered assets plus imported source workbook and manifest keys.

New `assets` rows carry a SHA-256 protected by a partial unique index. Imports resolve the workbook, normalized manifest, and every embedded image against that index before writing R2; duplicates within one upload are also collapsed. Rows created before this migration retain a null hash until a future maintenance backfill, so deduplication is guaranteed for newly received content.

Validated Cloudflare Access email addresses are stored on events and other mutable/imported records. Older rows created before the attribution migration remain valid with a null actor.

`last_mutation_id` values are internal concurrency tokens. They allow dependent event inserts to prove that the preceding conditional update succeeded within the same transactional batch.

Assignment is a snapshot boundary. It locks the source version, copies every step field and planned diagram into the run, and records the displayed template metadata on the run itself. Later run edits update only actual fields. Differences from the planned baseline, added ad hoc steps, execution diagrams, and the supplied deviation reason remain attached to that sample and are also represented in the sample timeline.

Promotion is a separate, explicit operation. It copies the run's current actual step fields and all still-available planned/execution diagrams into the next editable template version. Execution notes and deviation explanations remain audit data on the sample run rather than silently becoming standard instructions.
