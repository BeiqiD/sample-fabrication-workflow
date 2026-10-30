# Trigger-compatible rollout before FP1 shadow capture

Migration `0008` adds synchronous capture triggers. A Worker that interprets D1
`meta.changes` as an exact business-row count can misclassify a successful write
after that migration. Deploy this compatibility bridge on the existing `0007`
database before deploying the shadow runtime.

The bridge uses top-level `RETURNING` rows or an adjacent `SELECT changes()` for
exact mutation counts. It keeps the existing database, storage bindings and
legacy byte paths. It adds no migration and does not enable File conversion.
Its V14 exporter rejects any `file_shadow_*` schema object observed in the same
atomic snapshot as the exported rows. A snapshot completed before migration
remains valid; a snapshot observing the new schema requires the V15 Worker.

## Deployment order

1. Merge and deploy the bridge while the database remains at `0007`. Confirm the
   Cloudflare Workers Builds check succeeded for that integration commit and
   record its Worker version. Confirm normal business and V14 export behavior.
2. Only after this bridge is serving all application traffic, with older Worker
   writers and their in-flight work drained, deploy the reviewed shadow runtime.
   Its normal deployment command applies `0008` and then deploys the V15 Worker.
   Do not allow an older queued build or rollback to reintroduce an incompatible
   Worker during this interval.
3. Verify first creation and replay, deletion/restoration, V15 export and stale
   archive-version rejection on the completed deployment. Conversion remains
   disabled until separately enabled by an explicit operator action.

During the schema-to-Worker interval the bridge can continue legacy business
writes; complete export returns a refresh-required conflict until V15 is live.
If migration succeeds but V15 deployment fails, finish deploying that reviewed
Worker. Do not downgrade the schema or treat a V14 archive as a complete backup
of a database that already contains shadow history. A failed migration requires
inspection of its reported migration/schema state before retrying.

Without a verified active bridge, the original maintenance procedure still
applies: pause business writes before `0008` and keep them paused until the
matching Worker is deployed. Merely merging the bridge does not establish that
it is serving traffic.
