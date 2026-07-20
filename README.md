# Sample Management System

A low-friction, event-based sample log for fabrication work. The app is a single open-source Cloudflare Worker project: React and Vite provide the interface, Hono provides the API, D1 stores structured records, and private R2 stores workbooks and compressed images.

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

Production requires a Cloudflare Access application plus `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Follow [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md), then run:

```bash
npm run db:migrate:remote
npm run deploy
```

The `wrangler.jsonc` bindings intentionally omit production IDs so Wrangler can provision D1 and R2 resources during the first deployment. Review the generated binding identifiers before deploying migrations.

## Data ownership

Exports contain JSON tables, Markdown summaries where applicable, and assets using relative paths. No export depends on a temporary signed URL.
