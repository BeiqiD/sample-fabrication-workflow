import type { Env } from "./types";

export const FABUBLOX_IMPORT_LEASE_MS = 24 * 60 * 60 * 1_000;
const STALE_IMPORT_BATCH_SIZE = 25;

export interface FabubloxImportState {
  status: "pending" | "ready" | "failed";
  operation_id: string | null;
  finalization_id: string | null;
  recovery_operation_id: string | null;
  template_version_id: string | null;
}

export function fabubloxImportLeaseExpiresAt(now = new Date()) {
  return new Date(now.getTime() + FABUBLOX_IMPORT_LEASE_MS).toISOString();
}

// A recovery read must reach the primary database. The fallback keeps the
// local SQLite/D1 test adapters small while production uses D1 Sessions.
export function primaryD1(db: D1Database): D1Database {
  const candidate = db as D1Database & {
    withSession?: (constraint?: "first-primary") => unknown;
  };
  if (typeof candidate.withSession !== "function") return db;
  return candidate.withSession("first-primary") as unknown as D1Database;
}

export async function readFabubloxImportState(
  db: D1Database,
  importId: string,
): Promise<FabubloxImportState | null> {
  return primaryD1(db).prepare(`
    SELECT status, operation_id, finalization_id,
           recovery_operation_id, template_version_id
    FROM imports
    WHERE id = ?
  `).bind(importId).first<FabubloxImportState>();
}

export async function queueFabubloxImportCleanup(
  env: Env,
  input: {
    importId: string;
    operationId: string;
    error: unknown;
    now?: Date;
    recoveryOperationId?: string;
  },
) {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const recoveryOperationId = input.recoveryOperationId ?? crypto.randomUUID();
  const message = (input.error instanceof Error
    ? input.error.message
    : String(input.error)).slice(0, 1_000);
  const db = primaryD1(env.DB);
  const results = await db.batch([
    // Claim the exact unfinished operation. This also resumes legacy failed
    // rows that predate durable recovery identity. Every later statement is
    // gated by the persisted recovery ID, so a competing finalization cannot
    // be torn down after it wins. Only import-owned direct provenance is
    // released here; durable occurrences owned by other sources remain intact.
    db.prepare(`
      UPDATE imports
      SET status = 'failed',
          error_message = COALESCE(error_message, ?),
          completed_at = COALESCE(completed_at, ?),
          lease_expires_at = NULL,
          recovery_operation_id = ?,
          workbook_asset_key = NULL,
          manifest_asset_key = NULL
      WHERE id = ? AND operation_id = ? AND finalization_id IS NULL
        AND status IN ('pending', 'failed')
        AND (recovery_operation_id IS NULL OR recovery_operation_id = ?)
    `).bind(
      message,
      timestamp,
      recoveryOperationId,
      input.importId,
      input.operationId,
      recoveryOperationId,
    ),
    // A pending revision should never have been registered, but tombstone a
    // pre-existing row defensively before removing its partial source record.
    db.prepare(`
      UPDATE reference_targets
      SET tombstoned_at = COALESCE(tombstoned_at, ?), last_validated_at = ?
      WHERE target_type = 'recipe_revision'
        AND target_id = (
          SELECT template_version_id FROM imports
          WHERE id = ? AND status = 'failed'
            AND recovery_operation_id = ?
        )
    `).bind(timestamp, timestamp, input.importId, recoveryOperationId),
    // A state-image occurrence belongs to the state, not to the import that
    // originally registered the asset row. Remove it only when the state is
    // exclusive to this partial template. Other templates, independent Run
    // step/initial-state history, Sample inherited state, and explicit
    // verification history retain the relationship regardless of asset origin.
    db.prepare(`
      DELETE FROM state_representation_assets
      WHERE state_hash IN (
        SELECT tv.initial_state_hash
        FROM imports i
        JOIN template_versions tv ON tv.id = i.template_version_id
        WHERE i.id = ? AND i.status = 'failed'
          AND i.recovery_operation_id = ?
          AND tv.initial_state_hash IS NOT NULL
        UNION
        SELECT ts.expected_state_hash
        FROM imports i
        JOIN template_steps ts ON ts.template_version_id = i.template_version_id
        WHERE i.id = ? AND i.status = 'failed'
          AND i.recovery_operation_id = ?
          AND ts.expected_state_hash IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM template_versions other
        WHERE other.id <> (
          SELECT template_version_id FROM imports
          WHERE id = ? AND status = 'failed'
            AND recovery_operation_id = ?
        )
          AND other.initial_state_hash = state_representation_assets.state_hash
      )
      AND NOT EXISTS (
        SELECT 1
        FROM template_steps other
        WHERE other.template_version_id <> (
          SELECT template_version_id FROM imports
          WHERE id = ? AND status = 'failed'
            AND recovery_operation_id = ?
        )
          AND other.expected_state_hash = state_representation_assets.state_hash
      )
      AND NOT EXISTS (
        SELECT 1
        FROM run_steps rs
        LEFT JOIN template_steps linked_step ON linked_step.id = rs.template_step_id
        WHERE rs.expected_state_hash = state_representation_assets.state_hash
          AND (
            rs.template_step_id IS NULL
            OR linked_step.template_version_id IS NULL
            OR linked_step.template_version_id <> (
              SELECT template_version_id FROM imports
              WHERE id = ? AND status = 'failed'
                AND recovery_operation_id = ?
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM runs r
        WHERE r.initial_state_hash = state_representation_assets.state_hash
      )
      AND NOT EXISTS (
        SELECT 1
        FROM samples s
        WHERE s.inherited_state_hash = state_representation_assets.state_hash
      )
      AND NOT EXISTS (
        SELECT 1
        FROM state_verifications sv
        WHERE sv.expected_state_hash = state_representation_assets.state_hash
      )
    `).bind(
      input.importId,
      recoveryOperationId,
      input.importId,
      recoveryOperationId,
      input.importId,
      recoveryOperationId,
      input.importId,
      recoveryOperationId,
      input.importId,
      recoveryOperationId,
    ),
    // Through-0024 databases could point Run records at staged template steps.
    // Remove the join rows and nullable FK before deleting the partial steps.
    db.prepare(`
      DELETE FROM run_step_plan_links
      WHERE template_step_id IN (
        SELECT ts.id
        FROM template_steps ts
        JOIN imports i ON i.template_version_id = ts.template_version_id
        WHERE i.id = ? AND i.status = 'failed'
          AND i.recovery_operation_id = ?
      )
    `).bind(input.importId, recoveryOperationId),
    db.prepare(`
      UPDATE run_steps
      SET template_step_id = NULL
      WHERE template_step_id IN (
        SELECT ts.id
        FROM template_steps ts
        JOIN imports i ON i.template_version_id = ts.template_version_id
        WHERE i.id = ? AND i.status = 'failed'
          AND i.recovery_operation_id = ?
      )
    `).bind(input.importId, recoveryOperationId),
    // Template revisions are stable identities and cannot be physically
    // deleted. Remove their cascade-owned step rows, then quarantine the
    // revision in place and release only its direct source locator. Event and
    // other occurrence keys are independent durable edges and are not altered.
    db.prepare(`
      DELETE FROM template_steps
      WHERE template_version_id = (
        SELECT template_version_id FROM imports
        WHERE id = ? AND status = 'failed'
          AND recovery_operation_id = ?
      )
    `).bind(input.importId, recoveryOperationId),
    db.prepare(`
      UPDATE template_versions
      SET source_asset_key = NULL,
          initial_state_hash = NULL,
          archived_at = COALESCE(archived_at, ?),
          archived_by = COALESCE(archived_by, 'system:fabublox-import-recovery'),
          deleted_at = COALESCE(deleted_at, ?),
          deleted_by = COALESCE(deleted_by, 'system:fabublox-import-recovery')
      WHERE id = (
        SELECT template_version_id FROM imports
        WHERE id = ? AND status = 'failed'
          AND recovery_operation_id = ?
      )
    `).bind(timestamp, timestamp, input.importId, recoveryOperationId),
    // The asset row may have originated in this import and later become the
    // canonical winner for another source. Once import-owned provenance and
    // exclusive state edges are gone, the shared retention view is the sole
    // authority: any still-reachable asset is re-homed as standalone before
    // the failed import can release it. Keep its readiness and content hash.
    db.prepare(`
      UPDATE assets
      SET import_id = NULL
      WHERE import_id = ? AND status IN ('pending', 'ready')
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM blob_retention_edges bre
          WHERE bre.store_kind = 'r2' AND bre.provider = 'r2'
            AND bre.object_key = assets.r2_key
        )
    `).bind(input.importId, input.importId, recoveryOperationId),
    // Only assets that are unreachable under the shared authoritative surface
    // may release their hash and transition to failed.
    db.prepare(`
      UPDATE assets
      SET status = 'failed', sha256 = NULL
      WHERE import_id = ? AND status IN ('pending', 'ready')
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_retention_edges bre
          WHERE bre.store_kind = 'r2' AND bre.provider = 'r2'
            AND bre.object_key = assets.r2_key
        )
    `).bind(input.importId, input.importId, recoveryOperationId),
    // Queue only unreachable failed provider objects. Deletion rechecks the
    // same retention view before claiming, preserving the invariant that one
    // source becoming terminal cannot release another source's durable edge.
    db.prepare(`
      INSERT INTO blob_gc_ledger (
        store_kind, provider, object_key, blob_record_id, state, operation_id,
        orphaned_at, deletion_started_at, deleted_at,
        attempt_count, last_error, updated_at
      )
      SELECT 'r2', 'r2', a.r2_key, a.id, 'orphaned', ?,
             a.created_at, NULL, NULL, 0, NULL, ?
      FROM assets a
      WHERE a.import_id = ? AND a.status = 'failed'
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_retention_edges bre
          WHERE bre.store_kind = 'r2' AND bre.provider = 'r2'
            AND bre.object_key = a.r2_key
        )
      ON CONFLICT(store_kind, provider, object_key) DO UPDATE SET
        blob_record_id = excluded.blob_record_id,
        operation_id = excluded.operation_id,
        orphaned_at = COALESCE(blob_gc_ledger.orphaned_at, excluded.orphaned_at),
        deletion_started_at = NULL,
        deleted_at = NULL,
        last_error = NULL,
        updated_at = excluded.updated_at
      WHERE blob_gc_ledger.state = 'orphaned'
    `).bind(
      recoveryOperationId,
      timestamp,
      input.importId,
      input.importId,
      recoveryOperationId,
    ),
  ]);
  const relationshipResultIndexes = [2, 3, 4];
  return {
    importsFailed: Number(results[0].meta.changes ?? 0),
    relationshipsRemoved: relationshipResultIndexes.reduce(
      (total, index) => total + Number(results[index].meta.changes ?? 0),
      0,
    ),
    templateStepsRemoved: Number(results[5].meta.changes ?? 0),
    templatesQuarantined: Number(results[6].meta.changes ?? 0),
    assetsReleased: Number(results[8].meta.changes ?? 0),
    objectsQueued: Number(results[9].meta.changes ?? 0),
  };
}

export async function reapStaleFabubloxImports(env: Env, now = new Date()) {
  const timestamp = now.toISOString();
  const legacyCutoff = new Date(now.getTime() - FABUBLOX_IMPORT_LEASE_MS).toISOString();
  const rows = await primaryD1(env.DB).prepare(`
    SELECT candidate.id, candidate.operation_id, candidate.status
    FROM imports candidate
    WHERE candidate.operation_id IS NOT NULL
      AND candidate.finalization_id IS NULL
      AND (
        (
          candidate.status = 'pending'
          AND (
            candidate.lease_expires_at <= ?
            OR (candidate.lease_expires_at IS NULL AND candidate.created_at <= ?)
          )
        )
        OR (
          candidate.status = 'failed'
          AND candidate.recovery_operation_id IS NULL
          AND (
            candidate.template_version_id IS NOT NULL
            OR candidate.workbook_asset_key IS NOT NULL
            OR candidate.manifest_asset_key IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM assets a WHERE a.import_id = candidate.id
            )
          )
        )
      )
    ORDER BY CASE candidate.status WHEN 'failed' THEN 0 ELSE 1 END,
             COALESCE(candidate.lease_expires_at, candidate.completed_at, candidate.created_at),
             candidate.id
    LIMIT ?
  `).bind(timestamp, legacyCutoff, STALE_IMPORT_BATCH_SIZE).all<{
    id: string;
    operation_id: string;
    status: "pending" | "failed";
  }>();

  let staleImportsFailed = 0;
  let staleImportAssetsReleased = 0;
  let staleImportObjectsQueued = 0;
  let staleImportRecoveryFailures = 0;
  for (const row of rows.results) {
    try {
      const result = await queueFabubloxImportCleanup(env, {
        importId: row.id,
        operationId: row.operation_id,
        error: new Error(row.status === "pending"
          ? "FabuBlox import lease expired before finalization"
          : "Resuming cleanup for a legacy failed FabuBlox import"),
        now,
      });
      staleImportsFailed += result.importsFailed;
      staleImportAssetsReleased += result.assetsReleased;
      staleImportObjectsQueued += result.objectsQueued;
    } catch (error) {
      staleImportRecoveryFailures += 1;
      console.error("Could not recover stale FabuBlox import", row.id, error);
    }
  }
  return {
    staleImportsFailed,
    staleImportAssetsReleased,
    staleImportObjectsQueued,
    staleImportRecoveryFailures,
  };
}
