# Sample Fabrication Workflow

A lightweight, sample-centered workflow and event log for small-scale research fabrication. It is intentionally not a general LIMS or enterprise MES: the app follows a specific management model for research groups in which the planned process and the work actually performed may diverge.

## Management model and scope

- A Template or Recipe describes **what should be done**. It is a reusable, versioned plan rather than a rigid work order.
- Assigning a version to a physical sample locks that version and creates an independent, sample-bound plan and run. Later template edits, archives, or deletions cannot rewrite content that was already assigned.
- The run records **what was actually done**. Operators can change actual parameters, add comments and diagrams, record deviations, skip work, or insert ad-hoc steps while keeping the expected plan visible for comparison.
- Meaningful actions append to the sample's event history. Completed execution and verified sample states therefore remain traceable even as future work changes.
- A template version is editable only before its first assignment. An unused version can be deleted; a referenced version can only be archived so historical sample records remain intact.

These are deliberate assumptions, not a universal laboratory-management model. They favor an honest, durable history of each physical sample over forcing execution to match the original recipe. Groups with different rules for deviations, version ownership, approvals, or historical corrections should review and adapt the model before adopting the app.

The app is a single open-source Cloudflare Worker project: React and Vite provide the interface, Hono provides the API, D1 stores structured records, and private R2 stores workbooks and compressed images.

## MVP flow

1. Find or create a sample.
2. Add comments and phone photos to its timeline.
3. Change location, lifecycle status, or pinned state with an automatic audit entry.
4. Create child samples directly from a parent for split/dicing workflows.
5. Import a FabuBlox Excel workbook in the browser and review its sheets and embedded media.
6. Import a distinct recipe or attach the workbook to an existing recipe family as its next immutable version.
7. Start a sample run, preserving the expected recipe plan while recording actual parameters, comments, deviations, added steps, and execution diagrams.
8. Reconcile a longer recipe version with the unfinished part of an active run without rewriting completed history.
9. Verify the observed sample state after any completed step; each verification links to the previous one and records the covered execution interval.
10. Finish a run and start a successor run on the same physical sample, connected to its last actual step.

For repeated bench work, `/entry` provides a dedicated mobile-friendly recording screen: select the target sample, keep its code visible, and save a note/photo together with current status, location, and pinned state.

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
The Worker hashes every received workbook, image, normalized recipe step, expected state, and recipe manifest with SHA-256. Repeated recipes therefore reuse definitions and state representations instead of copying their full content into every run.

## Deploy

Production is served at [samples.run](https://samples.run) as a custom domain of the existing `sample-management-system` Worker. The committed configuration disables both the ordinary `workers.dev` endpoint and version preview URLs. Production also requires a Cloudflare Access application covering `samples.run`, plus `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` Worker secrets.

Follow [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md), then run:

```bash
npm run db:migrate:remote
npm run deploy
```

The committed `DB` and `ASSETS` bindings identify the existing alpha-v2 production resources. Do not change those bindings or the Worker name during an ordinary deployment; a fork or fresh installation must replace them with resources owned by its Cloudflare account.

## Data ownership

Exports contain JSON tables, Markdown summaries where applicable, and assets using relative paths. No export depends on a temporary signed URL.
