/** Must immediately follow the import claim UPDATE in the same atomic batch.
 * A failed assertion rolls back that claim and every later cleanup statement.
 * changes() belongs to the adjacent guarded UPDATE: a competing finalization
 * remains a no-op rather than failing because its asset inventory changed.
 */
export function fabubloxRecoverySnapshotGuard(
  db: D1Database, importId: string, inspectionPayload: string,
) {
  return db.prepare(`
    WITH inspected AS (
      SELECT entry.value AS evidence FROM json_each(?) entry
    ), current_sources AS (
      SELECT a.*, biq.reason AS quarantine_reason,
             biq.expected_byte_size AS quarantine_expected_byte_size,
             biq.observed_byte_size AS quarantine_observed_byte_size,
             bg.state AS gc_state
      FROM assets a
      LEFT JOIN blob_integrity_quarantine biq
        ON biq.store_kind = 'r2' AND biq.provider = 'r2'
       AND biq.object_key = a.r2_key
      LEFT JOIN blob_gc_ledger bg
        ON bg.store_kind = 'r2' AND bg.provider = 'r2'
       AND bg.object_key = a.r2_key
      WHERE a.import_id = ? AND a.status IN ('pending', 'ready', 'failed')
    )
    SELECT CASE WHEN changes() = 1 AND (
      (SELECT COUNT(*) FROM inspected) <> (SELECT COUNT(*) FROM current_sources)
      OR EXISTS (
        SELECT 1 FROM inspected e
        WHERE NOT EXISTS (
          SELECT 1 FROM current_sources a
          WHERE a.id IS json_extract(e.evidence, '$.snapshot.id')
            AND a.r2_key IS json_extract(e.evidence, '$.snapshot.r2_key')
            AND a.sha256 IS json_extract(e.evidence, '$.snapshot.sha256')
            AND a.byte_size IS json_extract(e.evidence, '$.snapshot.byte_size')
            AND a.status IS json_extract(e.evidence, '$.snapshot.status')
            AND a.quarantine_reason IS json_extract(e.evidence, '$.snapshot.quarantine_reason')
            AND a.quarantine_expected_byte_size IS json_extract(e.evidence, '$.snapshot.quarantine_expected_byte_size')
            AND a.quarantine_observed_byte_size IS json_extract(e.evidence, '$.snapshot.quarantine_observed_byte_size')
            AND a.gc_state IS json_extract(e.evidence, '$.snapshot.gc_state')
            AND (json_extract(e.evidence, '$.available') <> 1
              OR (a.quarantine_reason IS NULL
                AND COALESCE(a.gc_state, '') NOT IN ('deleting', 'deleted')))
        )
      )
      OR EXISTS (
        SELECT 1 FROM inspected e
        WHERE json_extract(e.evidence, '$.canonicalAssetId') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM assets a
            WHERE a.id IS json_extract(e.evidence, '$.canonicalAssetId')
              AND a.r2_key IS json_extract(e.evidence, '$.canonicalObjectKey')
              AND a.sha256 IS json_extract(e.evidence, '$.canonicalSha256')
              AND a.byte_size IS json_extract(e.evidence, '$.canonicalByteSize')
              AND a.status = 'ready'
              AND (a.import_id IS NULL OR EXISTS (
                SELECT 1 FROM imports owner
                WHERE owner.id = a.import_id AND owner.status = 'ready'
              ))
              AND NOT EXISTS (
                SELECT 1 FROM blob_integrity_quarantine biq
                WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
                  AND biq.object_key = a.r2_key
              )
              AND NOT EXISTS (
                SELECT 1 FROM blob_gc_ledger bg
                WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
                  AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
              )
          )
      )
    ) THEN json('FabuBlox recovery snapshot changed') ELSE 1 END AS verified
  `).bind(inspectionPayload, importId);
}
