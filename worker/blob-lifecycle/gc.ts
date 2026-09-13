import type { Env } from "../types";
import {
  BLOB_ORPHAN_GRACE_MS,
  BLOB_REGISTRATION_GRACE_MS,
  claimBlobDeletion,
  markOrphanCandidate,
  reclaimBlobDeletion,
} from "./reachability";
import { removeBlob } from "./storage";
import type { BlobLocator } from "./types";

const GC_BATCH_SIZE = 100;
const DELETION_CLAIM_LEASE_MS = 15 * 60 * 1_000;

async function listUnreachableLocators(env: Env, now: Date) {
  const registrationCutoff = new Date(now.getTime() - BLOB_REGISTRATION_GRACE_MS).toISOString();
  const [r2, managed] = await Promise.all([
    env.DB.prepare(
      `SELECT 'r2' AS store_kind, 'r2' AS provider, a.r2_key AS object_key,
              a.id AS blob_record_id
       FROM assets a
       WHERE (
         a.status = 'ready'
         OR (a.status IN ('pending', 'failed') AND a.import_id IS NULL)
       ) AND a.created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM blob_retention_edges bre
           WHERE bre.store_kind = 'r2' AND bre.provider = 'r2' AND bre.object_key = a.r2_key
         )
         AND NOT EXISTS (
           SELECT 1 FROM blob_gc_ledger bg
           WHERE bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
             AND bg.state IN ('deleting', 'deleted')
         )
       ORDER BY a.created_at, a.id
       LIMIT ?`,
    ).bind(registrationCutoff, GC_BATCH_SIZE).all<{
      store_kind: "r2"; provider: string; object_key: string; blob_record_id: string;
    }>(),
    env.DB.prepare(
      `SELECT 'managed' AS store_kind, mso.provider, mso.object_key,
              mso.id AS blob_record_id
       FROM managed_storage_objects mso
       WHERE mso.status IN ('ready', 'orphaned', 'failed') AND mso.created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM blob_retention_edges bre
           WHERE bre.store_kind = 'managed' AND bre.provider = mso.provider
             AND bre.object_key = mso.object_key
         )
         AND NOT EXISTS (
           SELECT 1 FROM blob_gc_ledger bg
           WHERE bg.store_kind = 'managed' AND bg.provider = mso.provider
             AND bg.object_key = mso.object_key AND bg.state IN ('deleting', 'deleted')
         )
       ORDER BY mso.created_at, mso.id
       LIMIT ?`,
    ).bind(registrationCutoff, GC_BATCH_SIZE).all<{
      store_kind: "managed"; provider: string; object_key: string; blob_record_id: string;
    }>(),
  ]);
  return [...r2.results, ...managed.results].map((row): BlobLocator => ({
    storeKind: row.store_kind,
    provider: row.provider,
    objectKey: row.object_key,
    blobRecordId: row.blob_record_id,
  }));
}

async function markUnreachableLocators(env: Env, now: Date) {
  const candidates = await listUnreachableLocators(env, now);
  let marked = 0;
  for (const locator of candidates) {
    if (await markOrphanCandidate(env.DB, locator, crypto.randomUUID(), now)) marked += 1;
  }
  return marked;
}

async function listDeletionWork(env: Env, now: Date) {
  const orphanCutoff = new Date(now.getTime() - BLOB_ORPHAN_GRACE_MS).toISOString();
  const staleClaimCutoff = new Date(now.getTime() - DELETION_CLAIM_LEASE_MS).toISOString();
  const result = await env.DB.prepare(
    `SELECT store_kind, provider, object_key, blob_record_id, state, operation_id
     FROM blob_gc_ledger
     WHERE (state = 'orphaned' AND orphaned_at <= ?)
        OR (state = 'deleting' AND deletion_started_at <= ? AND operation_id IS NOT NULL)
     ORDER BY CASE state WHEN 'deleting' THEN 0 ELSE 1 END,
              orphaned_at, store_kind, provider, object_key
     LIMIT ?`,
  ).bind(orphanCutoff, staleClaimCutoff, GC_BATCH_SIZE).all<{
    store_kind: "r2" | "managed";
    provider: string;
    object_key: string;
    blob_record_id: string | null;
    state: "orphaned" | "deleting";
    operation_id: string | null;
  }>();
  return result.results.map((row) => ({
    locator: {
      storeKind: row.store_kind,
      provider: row.provider,
      objectKey: row.object_key,
      blobRecordId: row.blob_record_id,
    } satisfies BlobLocator,
    state: row.state,
    operationId: row.operation_id,
    staleClaimCutoff,
  }));
}

async function finalizeDeletion(
  env: Env,
  locator: BlobLocator,
  operationId: string,
  now: Date,
) {
  const timestamp = now.toISOString();
  const ledgerUpdate = env.DB.prepare(
    `UPDATE blob_gc_ledger
     SET state = 'deleted', deleted_at = ?, last_error = NULL, updated_at = ?
     WHERE store_kind = ? AND provider = ? AND object_key = ?
       AND state = 'deleting' AND operation_id = ?`,
  ).bind(
    timestamp,
    timestamp,
    locator.storeKind,
    locator.provider,
    locator.objectKey,
    operationId,
  );
  if (locator.storeKind === "r2") {
    const result = await ledgerUpdate.run();
    return Boolean(result.meta.changes);
  }
  const results = await env.DB.batch([
    ledgerUpdate,
    env.DB.prepare(
      `UPDATE managed_storage_objects
       SET status = 'deleted'
       WHERE provider = ? AND object_key = ?
         AND EXISTS (
           SELECT 1 FROM blob_gc_ledger bg
           WHERE bg.store_kind = 'managed' AND bg.provider = managed_storage_objects.provider
             AND bg.object_key = managed_storage_objects.object_key
             AND bg.state = 'deleted' AND bg.operation_id = ?
         )`,
    ).bind(locator.provider, locator.objectKey, operationId),
  ]);
  return Boolean(results[0].meta.changes);
}

async function recordDeletionFailure(
  env: Env,
  locator: BlobLocator,
  operationId: string,
  now: Date,
  error: unknown,
) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
  const timestamp = now.toISOString();
  await env.DB.prepare(
    `UPDATE blob_gc_ledger
     SET state = 'orphaned', deletion_started_at = NULL, last_error = ?, updated_at = ?
     WHERE store_kind = ? AND provider = ? AND object_key = ?
       AND state = 'deleting' AND operation_id = ?`,
  ).bind(
    message,
    timestamp,
    locator.storeKind,
    locator.provider,
    locator.objectKey,
    operationId,
  ).run();
}

async function deleteClaimedLocators(env: Env, now: Date) {
  const candidates = await listDeletionWork(env, now);
  let imageDeleted = 0;
  let managedDeleted = 0;
  let failures = 0;
  for (const candidate of candidates) {
    const { locator } = candidate;
    const operationId = candidate.state === "deleting"
      ? candidate.operationId!
      : crypto.randomUUID();
    const claimed = candidate.state === "deleting"
      ? await reclaimBlobDeletion(env.DB, locator, operationId, now, candidate.staleClaimCutoff)
      : await claimBlobDeletion(env.DB, locator, operationId, now);
    if (!claimed) continue;
    try {
      await removeBlob(env, locator);
      if (!await finalizeDeletion(env, locator, operationId, now)) {
        throw new Error("GC deletion claim changed before finalization");
      }
      if (locator.storeKind === "r2") imageDeleted += 1;
      else managedDeleted += 1;
    } catch (error) {
      failures += 1;
      await recordDeletionFailure(env, locator, operationId, now, error);
    }
  }
  return { imageDeleted, managedDeleted, failures };
}

export async function runBlobGarbageCollection(env: Env, now = new Date()) {
  const orphanCandidatesMarked = await markUnreachableLocators(env, now);
  const deleted = await deleteClaimedLocators(env, now);
  return { orphanCandidatesMarked, ...deleted };
}
