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
    db.prepare(`
      UPDATE imports
      SET status = 'failed', error_message = ?, completed_at = ?,
          lease_expires_at = NULL, recovery_operation_id = ?
      WHERE id = ? AND status = 'pending' AND operation_id = ?
        AND finalization_id IS NULL
    `).bind(
      message,
      timestamp,
      recoveryOperationId,
      input.importId,
      input.operationId,
    ),
    db.prepare(`
      UPDATE assets
      SET status = 'failed', sha256 = NULL
      WHERE import_id = ? AND status IN ('pending', 'ready')
        AND EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = ? AND i.status = 'failed'
            AND i.recovery_operation_id = ?
        )
    `).bind(input.importId, input.importId, recoveryOperationId),
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
  return {
    importsFailed: Number(results[0].meta.changes ?? 0),
    assetsReleased: Number(results[1].meta.changes ?? 0),
    objectsQueued: Number(results[2].meta.changes ?? 0),
  };
}

export async function reapStaleFabubloxImports(env: Env, now = new Date()) {
  const timestamp = now.toISOString();
  const legacyCutoff = new Date(now.getTime() - FABUBLOX_IMPORT_LEASE_MS).toISOString();
  const rows = await primaryD1(env.DB).prepare(`
    SELECT id, operation_id
    FROM imports
    WHERE status = 'pending' AND operation_id IS NOT NULL
      AND (
        lease_expires_at <= ?
        OR (lease_expires_at IS NULL AND created_at <= ?)
      )
    ORDER BY COALESCE(lease_expires_at, created_at), id
    LIMIT ?
  `).bind(timestamp, legacyCutoff, STALE_IMPORT_BATCH_SIZE).all<{
    id: string;
    operation_id: string;
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
        error: new Error("FabuBlox import lease expired before finalization"),
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
