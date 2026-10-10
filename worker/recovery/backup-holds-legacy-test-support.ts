/** Frozen pre-fix seven-source UNION, retained only as an independent SQLite
 * equivalence oracle. Native D1 compiler qualification uses the real reader. */
export function installLegacySystemBackupHolds(db: D1Database, backupId: string, now: string): D1PreparedStatement[] {
  return [db.prepare(`INSERT INTO system_recovery_legacy_holds(job_id,store_kind,provider,object_key)
    SELECT ?,store_kind,provider,object_key FROM (
      SELECT store_kind,provider,object_key FROM blob_retention_edges
      UNION SELECT 'r2','r2',r2_key FROM assets WHERE r2_key IS NOT NULL
      UNION SELECT 'managed',provider,object_key FROM managed_storage_objects
      UNION SELECT 'r2','r2',workbook_asset_key FROM imports WHERE workbook_asset_key IS NOT NULL
      UNION SELECT 'r2','r2',manifest_asset_key FROM imports WHERE manifest_asset_key IS NOT NULL
      UNION SELECT 'r2','r2',source_asset_key FROM template_versions WHERE source_asset_key IS NOT NULL
      UNION SELECT 'r2','r2',asset_key FROM events WHERE asset_key IS NOT NULL
    ) sources WHERE NOT EXISTS(SELECT 1 FROM system_recovery_legacy_holds h WHERE h.job_id=?
      AND h.store_kind=sources.store_kind AND h.provider=sources.provider AND h.object_key=sources.object_key)
      AND NOT EXISTS(SELECT 1 FROM blob_gc_ledger gc WHERE gc.store_kind=sources.store_kind AND gc.provider=sources.provider
        AND gc.object_key=sources.object_key AND gc.state IN('deleting','deleted'))
      AND NOT EXISTS(SELECT 1 FROM file_shadow_legacy_deletion_claims gc WHERE gc.store_kind=sources.store_kind
        AND gc.provider=sources.provider AND gc.object_key=sources.object_key)
      AND NOT EXISTS(SELECT 1 FROM legacy_file_mappings m JOIN file_location_gc_ledger gc ON gc.location_id=m.location_id
        WHERE gc.state IN('deleting','deleted') AND m.store_kind=sources.store_kind
          AND m.provider=sources.provider AND m.object_key=sources.object_key)`)
    .bind(backupId, backupId),
  db.prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at)
    SELECT 'fp5_'||lower(hex(randomblob(16))),l.location_id,'export',?,'Frozen system backup source',?
    FROM file_location_publications l JOIN file_location_availability a ON a.location_id=l.location_id
    WHERE a.availability='available' AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
      AND NOT EXISTS(SELECT 1 FROM file_location_gc_ledger gc WHERE gc.location_id=l.location_id AND gc.state IN('deleting','deleted'))
      AND NOT EXISTS(SELECT 1 FROM file_location_holds h WHERE h.location_id=l.location_id AND h.operation_id=?)`)
    .bind(`fp5-backup:${backupId}`, now, `fp5-backup:${backupId}`)];
}
