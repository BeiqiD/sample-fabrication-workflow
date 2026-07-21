# MVP specification

## Goal

Make recording fabrication history less painful than maintaining an Obsidian database: open the site, find a sample, add a record, and continue working.

## Included

- Processing workspace at `/` and `/processing`, with active work shown by default and latest-run status filters available.
- High-density permanent sample archive at `/samples`.
- Create a sample at `/samples/new`.
- Sample detail at `/samples/:sampleId`, including parent/children, facts, and an event timeline.
- Comments and directly captured images; browser-side compression is intentionally aggressive.
- FabuBlox workbook parsing from Templates before upload; `/imports/fabublox` remains a compatibility redirect.
- Extraction of worksheet values and OOXML embedded media.
- Relationship- and anchor-aware mapping of FabuBlox layer-stack drawings to normalized steps.
- Immutable process/module/recipe template versions at `/templates`.
- Assigning a template version creates a run checklist; step status, notes, and images append to the sample timeline.
- Export one sample as a ZIP containing Markdown, JSON, and all timeline images with relative paths.
- D1 for records and private R2 for workbook/image assets.
- Local development and one-Worker deployment.
- Sample-level records and detail changes from the Sample page.
- Full-system, consistent-snapshot ZIP export.
- Cloudflare Access JWT validation and actor attribution.

## Architecture-complete deployment boundary

The local architecture includes export, audited mutations, atomic bench/step recording, transactional FabuBlox persistence, fail-closed Access validation, and deployment/recovery instructions. Creating the Cloudflare resources and Access policy is intentionally deferred until owner-approved account connection.

## Explicit exclusions for the first slice

- General analytics/dashboard views.
- Editing an imported template version in place.
- SEM or other large raw instrument data.
- A traditional always-on server.
