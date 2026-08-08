import type { BlobLocator, RetentionEdgeRow } from "./types";

export const COMMENT_RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
export const BLOB_REGISTRATION_GRACE_MS = 24 * 60 * 60 * 1_000;
export const BLOB_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

export function retryUntil(now: Date) {
  return new Date(now.getTime() + COMMENT_RETRY_WINDOW_MS).toISOString();
}

export async function listRetentionEdges(db: D1Database, locator: BlobLocator) {
  const result = await db.prepare(
    `SELECT store_kind, provider, object_key, blob_record_id,
            source_type, source_id, occurrence_type, occurrence_id,
            retention_reason, retain_until
     FROM blob_retention_edges
     WHERE store_kind = ? AND provider = ? AND object_key = ?
     ORDER BY source_type, source_id, occurrence_type, occurrence_id`,
  ).bind(locator.storeKind, locator.provider, locator.objectKey).all<RetentionEdgeRow>();
  return result.results;
}

export async function isBlobReachable(db: D1Database, locator: BlobLocator) {
  const row = await db.prepare(
    `SELECT 1 AS reachable FROM blob_retention_edges
     WHERE store_kind = ? AND provider = ? AND object_key = ? LIMIT 1`,
  ).bind(locator.storeKind, locator.provider, locator.objectKey).first<{ reachable: number }>();
  return Boolean(row);
}

function orphanInsertSql(storeKind: BlobLocator["storeKind"]) {
  const source = storeKind === "r2"
    ? `assets b`
    : `managed_storage_objects b`;
  const provider = storeKind === "r2" ? `'r2'` : `b.provider`;
  const key = storeKind === "r2" ? `b.r2_key` : `b.object_key`;
  const status = storeKind === "r2" ? `b.status = 'ready'` : `b.status IN ('ready', 'orphaned')`;
  return `INSERT INTO blob_gc_ledger (
      store_kind, provider, object_key, blob_record_id, state, operation_id,
      orphaned_at, deletion_started_at, deleted_at, attempt_count, last_error, updated_at
    )
    SELECT ?, ${provider}, ${key}, b.id, 'orphaned', ?, ?, NULL, NULL, 0, NULL, ?
    FROM ${source}
    WHERE ${key} = ? AND ${status} AND b.created_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM blob_retention_edges bre
        WHERE bre.store_kind = ? AND bre.provider = ${provider}
          AND bre.object_key = ${key}
      )
    ON CONFLICT(store_kind, provider, object_key) DO UPDATE SET
      blob_record_id = excluded.blob_record_id,
      operation_id = excluded.operation_id,
      orphaned_at = COALESCE(blob_gc_ledger.orphaned_at, excluded.orphaned_at),
      deletion_started_at = NULL,
      deleted_at = NULL,
      last_error = NULL,
      updated_at = excluded.updated_at
    WHERE blob_gc_ledger.state = 'orphaned'`;
}

export async function markOrphanCandidate(
  db: D1Database,
  locator: BlobLocator,
  operationId: string,
  now: Date,
) {
  const timestamp = now.toISOString();
  const registrationCutoff = new Date(now.getTime() - BLOB_REGISTRATION_GRACE_MS).toISOString();
  const insert = db.prepare(orphanInsertSql(locator.storeKind)).bind(
    locator.storeKind,
    operationId,
    timestamp,
    timestamp,
    locator.objectKey,
    registrationCutoff,
    locator.storeKind,
  );
  if (locator.storeKind === "r2") {
    const result = await insert.run();
    return Boolean(result.meta.changes);
  }
  const results = await db.batch([
    insert,
    db.prepare(
      `UPDATE managed_storage_objects
       SET status = 'orphaned', orphaned_at = COALESCE(orphaned_at, ?)
       WHERE provider = ? AND object_key = ? AND status = 'ready'
         AND EXISTS (
           SELECT 1 FROM blob_gc_ledger bg
           WHERE bg.store_kind = 'managed' AND bg.provider = managed_storage_objects.provider
             AND bg.object_key = managed_storage_objects.object_key AND bg.state = 'orphaned'
         )
         AND NOT EXISTS (
           SELECT 1 FROM blob_retention_edges bre
           WHERE bre.store_kind = 'managed' AND bre.provider = managed_storage_objects.provider
             AND bre.object_key = managed_storage_objects.object_key
         )`,
    ).bind(timestamp, locator.provider, locator.objectKey),
  ]);
  return Boolean(results[0].meta.changes);
}

export async function refreshOrphanGrace(
  db: D1Database,
  locator: BlobLocator,
  operationId: string,
  now: Date,
) {
  const ledger = await db.prepare(
    `SELECT state FROM blob_gc_ledger
     WHERE store_kind = ? AND provider = ? AND object_key = ?`,
  ).bind(locator.storeKind, locator.provider, locator.objectKey)
    .first<{ state: "orphaned" | "deleting" | "deleted" }>();
  if (!ledger) return true;
  if (ledger.state !== "orphaned") return false;
  const timestamp = now.toISOString();
  const result = await db.prepare(
    `UPDATE blob_gc_ledger
     SET operation_id = ?, orphaned_at = ?, last_error = NULL, updated_at = ?
     WHERE store_kind = ? AND provider = ? AND object_key = ? AND state = 'orphaned'
       AND NOT EXISTS (
         SELECT 1 FROM blob_retention_edges bre
         WHERE bre.store_kind = ? AND bre.provider = ? AND bre.object_key = ?
       )`,
  ).bind(
    operationId,
    timestamp,
    timestamp,
    locator.storeKind,
    locator.provider,
    locator.objectKey,
    locator.storeKind,
    locator.provider,
    locator.objectKey,
  ).run();
  return Boolean(result.meta.changes);
}

export async function claimBlobDeletion(
  db: D1Database,
  locator: BlobLocator,
  operationId: string,
  now: Date,
) {
  const timestamp = now.toISOString();
  const orphanCutoff = new Date(now.getTime() - BLOB_ORPHAN_GRACE_MS).toISOString();
  const result = await db.prepare(
    `UPDATE blob_gc_ledger
     SET state = 'deleting', operation_id = ?, deletion_started_at = ?,
         attempt_count = attempt_count + 1, last_error = NULL, updated_at = ?
     WHERE store_kind = ? AND provider = ? AND object_key = ?
       AND state = 'orphaned' AND orphaned_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM blob_retention_edges bre
         WHERE bre.store_kind = ? AND bre.provider = ? AND bre.object_key = ?
       )`,
  ).bind(
    operationId,
    timestamp,
    timestamp,
    locator.storeKind,
    locator.provider,
    locator.objectKey,
    orphanCutoff,
    locator.storeKind,
    locator.provider,
    locator.objectKey,
  ).run();
  return Boolean(result.meta.changes);
}

export async function reclaimBlobDeletion(
  db: D1Database,
  locator: BlobLocator,
  operationId: string,
  now: Date,
  staleBefore: string,
) {
  const timestamp = now.toISOString();
  const result = await db.prepare(
    `UPDATE blob_gc_ledger
     SET deletion_started_at = ?, attempt_count = attempt_count + 1, updated_at = ?
     WHERE store_kind = ? AND provider = ? AND object_key = ?
       AND state = 'deleting' AND operation_id = ? AND deletion_started_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM blob_retention_edges bre
         WHERE bre.store_kind = ? AND bre.provider = ? AND bre.object_key = ?
       )`,
  ).bind(
    timestamp,
    timestamp,
    locator.storeKind,
    locator.provider,
    locator.objectKey,
    operationId,
    staleBefore,
    locator.storeKind,
    locator.provider,
    locator.objectKey,
  ).run();
  return Boolean(result.meta.changes);
}

export async function listSubmissionBlobLocators(db: D1Database, submissionId: string) {
  const result = await db.prepare(
    `SELECT DISTINCT 'r2' AS store_kind, 'r2' AS provider, a.r2_key AS object_key,
            a.id AS blob_record_id
     FROM comment_submission_items csi
     JOIN assets a ON a.id = csi.asset_id
     WHERE csi.submission_id = ?
     UNION
     SELECT DISTINCT 'managed' AS store_kind, mso.provider, mso.object_key,
            mso.id AS blob_record_id
     FROM comment_submission_items csi
     JOIN managed_storage_objects mso ON mso.id = csi.storage_object_id
     WHERE csi.submission_id = ?`,
  ).bind(submissionId, submissionId).all<{
    store_kind: "r2" | "managed";
    provider: string;
    object_key: string;
    blob_record_id: string;
  }>();
  return result.results.map((row): BlobLocator => ({
    storeKind: row.store_kind,
    provider: row.provider,
    objectKey: row.object_key,
    blobRecordId: row.blob_record_id,
  }));
}

export async function listItemBlobLocators(db: D1Database, submissionId: string, itemId: string) {
  const result = await db.prepare(
    `SELECT 'r2' AS store_kind, 'r2' AS provider, a.r2_key AS object_key,
            a.id AS blob_record_id
     FROM comment_submission_items csi
     JOIN assets a ON a.id = csi.asset_id
     WHERE csi.submission_id = ? AND csi.id = ?
     UNION
     SELECT 'managed' AS store_kind, mso.provider, mso.object_key,
            mso.id AS blob_record_id
     FROM comment_submission_items csi
     JOIN managed_storage_objects mso ON mso.id = csi.storage_object_id
     WHERE csi.submission_id = ? AND csi.id = ?`,
  ).bind(submissionId, itemId, submissionId, itemId).all<{
    store_kind: "r2" | "managed";
    provider: string;
    object_key: string;
    blob_record_id: string;
  }>();
  return result.results.map((row): BlobLocator => ({
    storeKind: row.store_kind,
    provider: row.provider,
    objectKey: row.object_key,
    blobRecordId: row.blob_record_id,
  }));
}
