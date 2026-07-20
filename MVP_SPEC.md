# MVP specification

## Goal

Make recording fabrication history less painful than maintaining an Obsidian database: open the site, find a sample, add a record, and continue working.

## Included

- Search and recent samples at `/` (no dashboard).
- Create a sample at `/samples/new`.
- Sample detail at `/samples/:sampleId`, including parent/children, facts, and an event timeline.
- Comments and directly captured images; browser-side compression is intentionally aggressive.
- FabuBlox workbook parsing at `/imports/fabublox` before upload.
- Extraction of worksheet values and OOXML embedded media.
- Immutable process/module/recipe template versions at `/templates`.
- Export one sample as a ZIP containing Markdown, JSON, and all timeline images with relative paths.
- D1 for records and private R2 for workbook/image assets.
- Local development and one-Worker deployment.

## Next vertical slices

1. Map FabuBlox drawing anchors to cells and steps instead of only preserving all embedded media.
2. Assign a template version to a sample, creating a run and ordered run-step records.
3. Add run-step statuses: `pending`, `in_progress`, `done`, `skipped`, and `blocked`.
4. Record step comments and images in both the run and sample timeline.
5. Export all versioned tables and R2 assets.
6. Add Cloudflare Access deployment notes and authorization checks.

## Explicit exclusions for the first slice

- General analytics/dashboard views.
- Editing an imported template version in place.
- SEM or other large raw instrument data.
- A traditional always-on server.
