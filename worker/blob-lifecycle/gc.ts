import type { Env } from "../types";
import { ByteDeletionError } from "../files/byte-deleter";
import type { BlobLifecycleDatabase } from "./gc-database";
import {
  type BlobDeletionClaim,
  BLOB_ORPHAN_GRACE_MS,
  BLOB_REGISTRATION_GRACE_MS,
  claimBlobDeletion,
  markOrphanCandidate,
  reclaimBlobDeletion,
} from "./reachability";
import { removeBlob, statBlob, type BlobStatResult } from "./storage";
import type { BlobLocator } from "./types";

export interface BlobGarbageCollectionDependencies {
  db: BlobLifecycleDatabase;
  storage: {
    remove(locator: BlobLocator): Promise<void>;
    stat(locator: BlobLocator): Promise<BlobStatResult>;
  };
  newOperationId(): string;
}

type DeletionFailureCode =
  | "deletion_unavailable"
  | "deletion_denied"
  | "deletion_invalid_locator"
  | "deletion_confirmation_unavailable"
  | "deletion_claim_changed";

function deletionFailureCode(error: unknown): DeletionFailureCode {
  if (error instanceof ByteDeletionError) {
    if (error.reason === "denied") return "deletion_denied";
    if (error.reason === "invalid_locator") return "deletion_invalid_locator";
  }
  return "deletion_unavailable";
}

const GC_BATCH_SIZE = 100;
const DELETION_CLAIM_LEASE_MS = 15 * 60 * 1_000;

async function listUnreachableLocators(db: BlobLifecycleDatabase, now: Date) {
  const registrationCutoff = new Date(now.getTime() - BLOB_REGISTRATION_GRACE_MS).toISOString();
  const [r2, managed] = await Promise.all([
    db.prepare(
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
    db.prepare(
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

async function markUnreachableLocators(dependencies: BlobGarbageCollectionDependencies, now: Date) {
  const candidates = await listUnreachableLocators(dependencies.db, now);
  let marked = 0;
  for (const locator of candidates) {
    if (await markOrphanCandidate(dependencies.db, locator, dependencies.newOperationId(), now)) marked += 1;
  }
  return marked;
}

async function listDeletionWork(db: BlobLifecycleDatabase, now: Date) {
  const orphanCutoff = new Date(now.getTime() - BLOB_ORPHAN_GRACE_MS).toISOString();
  const staleClaimCutoff = new Date(now.getTime() - DELETION_CLAIM_LEASE_MS).toISOString();
  const result = await db.prepare(
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
  db: BlobLifecycleDatabase,
  locator: BlobLocator,
  claim: BlobDeletionClaim,
  now: Date,
) {
  const timestamp = now.toISOString();
  const ledgerUpdate = db.prepare(
    `UPDATE blob_gc_ledger
     SET state = 'deleted', deleted_at = ?, last_error = NULL, updated_at = ?
     WHERE store_kind = ? AND provider = ? AND object_key = ?
       AND state = 'deleting' AND operation_id = ?
       AND attempt_count = ? AND deletion_started_at = ?`,
  ).bind(
    timestamp,
    timestamp,
    locator.storeKind,
    locator.provider,
    locator.objectKey,
    claim.operationId,
    claim.attemptCount,
    claim.deletionStartedAt,
  );
  if (locator.storeKind === "r2") {
    const result = await ledgerUpdate.run();
    return Boolean(result.meta.changes);
  }
  const results = await db.batch([
    ledgerUpdate,
    db.prepare(
      `UPDATE managed_storage_objects
       SET status = 'deleted'
       WHERE provider = ? AND object_key = ?
         AND EXISTS (
           SELECT 1 FROM blob_gc_ledger bg
           WHERE bg.store_kind = 'managed' AND bg.provider = managed_storage_objects.provider
             AND bg.object_key = managed_storage_objects.object_key
             AND bg.state = 'deleted' AND bg.operation_id = ?
             AND bg.attempt_count = ? AND bg.deletion_started_at = ?
         )`,
    ).bind(locator.provider, locator.objectKey, claim.operationId, claim.attemptCount, claim.deletionStartedAt),
  ]);
  return Boolean(results[0].meta.changes);
}

async function recordDeletionFailure(
  db: BlobLifecycleDatabase,
  locator: BlobLocator,
  claim: BlobDeletionClaim,
  now: Date,
  code: DeletionFailureCode,
) {
  const timestamp = now.toISOString();
  await db.prepare(
    `UPDATE blob_gc_ledger
     SET last_error = ?, updated_at = ?
     WHERE store_kind = ? AND provider = ? AND object_key = ?
       AND state = 'deleting' AND operation_id = ?
       AND attempt_count = ? AND deletion_started_at = ?`,
  ).bind(
    code,
    timestamp,
    locator.storeKind,
    locator.provider,
    locator.objectKey,
    claim.operationId,
    claim.attemptCount,
    claim.deletionStartedAt,
  ).run();
}

async function deleteClaimedLocators(dependencies: BlobGarbageCollectionDependencies, now: Date) {
  const { db, storage } = dependencies;
  const candidates = await listDeletionWork(db, now);
  let imageDeleted = 0;
  let managedDeleted = 0;
  let failures = 0;
  for (const candidate of candidates) {
    const { locator } = candidate;
    const operationId = candidate.state === "deleting"
      ? candidate.operationId!
      : dependencies.newOperationId();
    const claim = candidate.state === "deleting"
      ? await reclaimBlobDeletion(db, locator, operationId, now, candidate.staleClaimCutoff)
      : await claimBlobDeletion(db, locator, operationId, now);
    if (!claim) continue;
    let failureCode: DeletionFailureCode | null = null;
    try {
      // A previous lease can have left an outcome-unknown remote DELETE. Observe
      // this exact bound locator before any retry; denial/outage is not absence.
      let alreadyMissing = false;
      if (candidate.state === "deleting") {
        const observed = await storage.stat(locator);
        if (observed.outcome === "provider_unavailable") {
          failureCode = "deletion_confirmation_unavailable";
        } else {
          alreadyMissing = observed.outcome === "missing";
        }
      }
      if (!failureCode) {
        if (!alreadyMissing) await storage.remove(locator);
        if (await finalizeDeletion(db, locator, claim, now)) {
          if (locator.storeKind === "r2") imageDeleted += 1;
          else managedDeleted += 1;
        } else {
          failureCode = "deletion_claim_changed";
        }
      }
    } catch (error) {
      failureCode = deletionFailureCode(error);
    }
    if (failureCode) {
      failures += 1;
      // Never make an uncertain deletion attachable again. Both this failure
      // update and successful finalization are fenced by the exact returned lease.
      await recordDeletionFailure(db, locator, claim, now, failureCode);
    }
  }
  return { imageDeleted, managedDeleted, failures };
}

export async function collectBlobGarbage(dependencies: BlobGarbageCollectionDependencies, now: Date) {
  const orphanCandidatesMarked = await markUnreachableLocators(dependencies, now);
  const deleted = await deleteClaimedLocators(dependencies, now);
  return { orphanCandidatesMarked, ...deleted };
}

export async function runBlobGarbageCollection(env: Env, now = new Date()) {
  return collectBlobGarbage({
    db: env.DB,
    storage: {
      remove: (locator) => removeBlob(env, locator),
      stat: (locator) => statBlob(env, locator),
    },
    newOperationId: () => crypto.randomUUID(),
  }, now);
}
