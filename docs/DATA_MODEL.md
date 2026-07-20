# Data model

| Entity | Purpose |
|---|---|
| `samples` | A physical wafer, chip, piece, or other tracked item. Self-reference represents parent/child splitting. |
| `events` | Append-oriented timeline records: creation, comments, images, location/status changes, and run-step activity. |
| `template_versions` | Immutable snapshots imported from FabuBlox as a process, module, or recipe. |
| `runs` | Assignment of one template version to one sample. |
| `run_steps` | Ordered, mutable execution state for the steps copied into a run. |

R2 object keys are stored in D1. The bucket stays private and the Worker returns assets only through application routes. Exporters must replace those keys with relative paths inside the resulting ZIP.
