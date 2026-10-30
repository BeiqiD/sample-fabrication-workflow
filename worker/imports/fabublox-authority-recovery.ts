/** Active imports publish their aliases, File results and typed consumers in
 * one finalization batch. Before that commit, only accepted candidates and
 * private template metadata exist. Recovery therefore needs no provider read,
 * hash deduplication, alias transfer or physical deletion. */
export async function recoverAuthorityImport(
  db: D1Database,
  input: { importId: string; operationId: string; recoveryOperationId: string; message: string; timestamp: string },
) {
  const { importId, operationId, recoveryOperationId, message, timestamp } = input;
  const ownedImport = `SELECT template_version_id FROM imports
    WHERE id=? AND operation_id=? AND status='failed' AND recovery_operation_id=?
      AND finalization_id IS NULL AND client_request_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')`;
  const owned = () => [importId, operationId, recoveryOperationId];
  const results = await db.batch([
    db.prepare(`UPDATE imports SET status='failed',error_message=COALESCE(error_message,?),
        completed_at=COALESCE(completed_at,?),lease_expires_at=NULL,recovery_operation_id=?,
        workbook_asset_key=NULL,manifest_asset_key=NULL
      WHERE id=? AND operation_id=? AND finalization_id IS NULL AND client_request_id IS NOT NULL
        AND status IN ('pending','failed')
        AND (recovery_operation_id IS NULL OR recovery_operation_id=?)
        AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
      RETURNING 1 AS affected`)
      .bind(message, timestamp, recoveryOperationId, importId, operationId, recoveryOperationId),
    // Adjacent to the claim so changes() belongs to that UPDATE. An old
    // unfinished overlap writer cannot be mistaken for a private active import;
    // it must finish recovery before activation. A winning finalization makes
    // this whole batch a no-op and keeps its original File results untouched.
    db.prepare(`SELECT CASE WHEN changes()=1 AND (
        EXISTS(SELECT 1 FROM assets WHERE import_id=?)
        OR EXISTS(SELECT 1 FROM imports WHERE id=? AND
          (workbook_file_id IS NOT NULL OR manifest_file_id IS NOT NULL OR accepted_result_json IS NOT NULL))
        OR EXISTS(SELECT 1 FROM template_versions WHERE id IN (${ownedImport}) AND source_file_id IS NOT NULL)
        OR EXISTS(SELECT 1 FROM file_acceptance_candidates c WHERE c.acceptance_kind='import_file'
          AND c.acceptance_id=? AND (c.state='ready' OR EXISTS(
            SELECT 1 FROM file_publications p WHERE p.file_id=c.candidate_file_id)))
      ) THEN json('Import recovery requires unpublished accepted File candidates') ELSE 1 END`)
      .bind(importId, importId, ...owned(), importId),
    db.prepare(`UPDATE reference_targets SET tombstoned_at=COALESCE(tombstoned_at,?),last_validated_at=?
      WHERE target_type='recipe_revision' AND target_id IN (${ownedImport})`)
      .bind(timestamp, timestamp, ...owned()),
    db.prepare(`DELETE FROM template_steps WHERE template_version_id IN (${ownedImport}) RETURNING 1 AS affected`)
      .bind(...owned()),
    db.prepare(`UPDATE template_versions SET source_asset_key=NULL,initial_state_hash=NULL,
        archived_at=COALESCE(archived_at,?),archived_by=COALESCE(archived_by,'system:fabublox-import-recovery'),
        deleted_at=COALESCE(deleted_at,?),deleted_by=COALESCE(deleted_by,'system:fabublox-import-recovery')
      WHERE id IN (${ownedImport}) RETURNING 1 AS affected`)
      .bind(timestamp, timestamp, ...owned()),
  ]);
  // Keep candidate identity and bytes until the existing registration/orphan
  // grace has elapsed. File GC releases them from this terminal original
  // receipt, then deletes using their exact recorded location/profile.
  return {
    importsFailed: results[0].results.length,
    relationshipsRemoved: 0,
    templateStepsRemoved: results[3].results.length,
    templatesQuarantined: results[4].results.length,
    assetsReleased: 0,
    objectsQueued: 0,
  };
}
