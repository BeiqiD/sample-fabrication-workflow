# Sample Management System

A low-friction, event-based sample log for fabrication work. The app is a single open-source Cloudflare Worker project: React and Vite provide the interface, Hono provides the API, D1 stores structured records, and private R2 stores workbooks and compressed images.

## MVP flow

1. Find or create a sample.
2. Add comments and phone photos to its timeline.
3. Change location, lifecycle status, or pinned state with an automatic audit entry.
4. Create child samples directly from a parent for split/dicing workflows.
5. Import a FabuBlox Excel workbook in the browser and review its sheets and embedded media.
6. Store each confirmed import as an immutable process, module, or recipe version.
7. Export one sample or a full-system ZIP containing D1 data and private R2 assets.

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

## Deploy

Production requires a Cloudflare Access application plus `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Follow [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md), then run:

```bash
npm run db:migrate:remote
npm run deploy
```

The `wrangler.jsonc` bindings intentionally omit production IDs so Wrangler can provision D1 and R2 resources during the first deployment. Review the generated binding identifiers before deploying migrations.

## Data ownership

Exports contain JSON tables, Markdown summaries where applicable, and assets using relative paths. No export depends on a temporary signed URL.
