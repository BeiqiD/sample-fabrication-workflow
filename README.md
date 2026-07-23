# Sample Fabrication Workflow

A lightweight, sample-centered workflow and event log for small-scale research fabrication. It is intentionally not a general LIMS or enterprise MES: the app follows a specific management model for research groups in which the planned process and the work actually performed may diverge.

## Management model and scope

- A Process template describes **what should be done**. It is a reusable, versioned plan rather than a rigid work order.
- Starting a process run on a physical sample locks that template version and creates an independent, sample-bound execution plan. Later template versions, archives, or deletions cannot rewrite content already used by the run.
- The process run records **what was actually done**. Operators can change actual parameters, add comments and diagrams, record deviations, skip work, or insert ad-hoc steps while keeping the planned step visible for comparison.
- Each run stores an immutable initial substrate structure. A first run uses the template definition; an additional run requires confirmation against the sample's current derived structure.
- Meaningful actions append to the sample's event history. Completed execution and verified sample states therefore remain traceable even as future work changes.
- A process-template version is editable only before its first run. An unused version can be deleted; a referenced version can only be archived so historical sample records remain intact.

These are deliberate assumptions, not a universal laboratory-management model. They favor an honest, durable history of each physical sample over forcing execution to match the current process template. Groups with different rules for deviations, version ownership, approvals, or historical corrections should review and adapt the model before adopting the app.

The app is a single open-source Cloudflare Worker project: React and Vite provide the interface, Hono provides the API, D1 stores structured records, and private R2 stores workbooks and compressed images.

## MVP flow

1. Use `Processing` to find active work, or `Samples` to browse the permanent archive and create a sample.
2. Add comments and phone photos to a sample's timeline.
3. Change location, physical lifecycle status, title, or pinned state with one audit entry per changed field. Starting or reopening a process run automatically makes the sample active; completing it returns the sample to stored unless it was explicitly marked consumed or lost.
4. Split a parent into multiple automatically numbered child samples in one atomic operation; review each child before confirming.
5. Import a FabuBlox Excel workbook in the browser and review its sheets and embedded media.
6. Import a distinct process template or attach the workbook to an existing process-template family as its next immutable version.
7. Start a process run, preserving its confirmed initial substrate and planned steps while recording actual parameters, comments, deviations, added steps, and execution diagrams.
8. Reconcile a newer process-template version with the unfinished part of an active run without rewriting completed history.
9. Verify the observed sample state after any completed step; each verification links to the previous one and records the covered execution interval.
10. Finish a run and start a new independent run on the same physical sample after confirming whether its initial substrate comes from the sample's current structure or the new template.

Sample-level notes, photos, details, split history, run summaries, and the complete Timeline live on the Sample page. Step execution stays in Processing so planned work and actual work remain distinct.

See [MVP_SPEC.md](./MVP_SPEC.md) for scope, [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for system invariants, [docs/DATA_MODEL.md](./docs/DATA_MODEL.md) for the data model, [docs/FABUBLOX_IMPORT.md](./docs/FABUBLOX_IMPORT.md) for the workbook contract, and [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) for the production checklist.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Cloudflare's Vite plugin runs the API inside the Workers runtime and uses local D1/R2 simulations by default.

Workbook and image inputs support both drag-and-drop and ordinary file selection. Images are compressed in the browser before upload.
The Worker hashes every received workbook, image, normalized process step, expected state, and template manifest with SHA-256. Repeated content therefore reuses definitions and state representations instead of copying full content into every run.

## Deploy

Follow [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md), then run:

```bash
npm run db:migrate:remote
npm run deploy
```

The committed `DB` and `ASSETS` bindings identify the existing alpha-v2 production resources. Do not change those bindings or the Worker name during an ordinary deployment; a fork or fresh installation must replace them with resources owned by its Cloudflare account.

## Data ownership

Exports contain JSON tables, Markdown summaries where applicable, and assets using relative paths. No export depends on a temporary signed URL.
