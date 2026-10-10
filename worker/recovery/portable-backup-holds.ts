/** Reviewed V1/current source holds. D1 expands an outer UNION over the
 * code-owned retention view beyond its compound SELECT limit. Materialized
 * streams and selector joins preserve all source rows before the same
 * DISTINCT/fences, without changing any stored schema or archive format. */
export function installPortableSystemBackupHolds(db: D1Database, backupId: string, now: string): D1PreparedStatement[] {
  const branches = [
    ["retention", "SELECT store_kind,provider,object_key FROM blob_retention_edges"],
    ["assets", "SELECT 'r2' AS store_kind,'r2' AS provider,r2_key AS object_key FROM assets WHERE r2_key IS NOT NULL"],
    ["managed", "SELECT 'managed' AS store_kind,provider,object_key FROM managed_storage_objects"],
    ["workbooks", "SELECT 'r2' AS store_kind,'r2' AS provider,workbook_asset_key AS object_key FROM imports WHERE workbook_asset_key IS NOT NULL"],
    ["manifests", "SELECT 'r2' AS store_kind,'r2' AS provider,manifest_asset_key AS object_key FROM imports WHERE manifest_asset_key IS NOT NULL"],
    ["templates", "SELECT 'r2' AS store_kind,'r2' AS provider,source_asset_key AS object_key FROM template_versions WHERE source_asset_key IS NOT NULL"],
    ["events", "SELECT 'r2' AS store_kind,'r2' AS provider,asset_key AS object_key FROM events WHERE asset_key IS NOT NULL"],
  ] as const;
  const selected = (column: string) => `coalesce(${branches.map(([name]) => `source_${name}.${column}`).join(",")})`;
  return [db.prepare(`WITH
    ${branches.map(([name, sql]) => `source_${name} AS MATERIALIZED (SELECT '${name}' AS source_kind,s.* FROM (${sql}) s)`).join(",\n    ")},
    selectors(source_kind) AS MATERIALIZED (VALUES ${branches.map(([name]) => `('${name}')`).join(",")}),
    selected AS MATERIALIZED (
      SELECT ${selected("store_kind")} AS store_kind,${selected("provider")} AS provider,${selected("object_key")} AS object_key
      FROM selectors ${branches.map(([name]) => `LEFT JOIN source_${name} ON selectors.source_kind=source_${name}.source_kind`).join("\n      ")}
      WHERE ${selected("source_kind")} IS NOT NULL),
    sources AS MATERIALIZED (SELECT DISTINCT store_kind,provider,object_key FROM selected)
    INSERT INTO system_recovery_legacy_holds(job_id,store_kind,provider,object_key)
    SELECT ?,store_kind,provider,object_key FROM sources
    WHERE NOT EXISTS(SELECT 1 FROM system_recovery_legacy_holds h WHERE h.job_id=?
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
