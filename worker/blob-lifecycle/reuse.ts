import type { Env } from "../types";
import { refreshOrphanGrace } from "./reachability";
import { statBlob } from "./storage";
import type { BlobLocator } from "./types";

export interface ReusableR2Asset {
  id: string;
  r2_key: string;
  original_name: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
}

export interface ReusableManagedObject {
  id: string;
  provider: string;
  object_key: string;
  original_name: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
}

export class BlobReuseProviderUnavailableError extends Error {
  constructor(provider: string, detail: string) {
    super(`The ${provider} object could not be verified before deduplication: ${detail}`);
    this.name = "BlobReuseProviderUnavailableError";
  }
}

async function quarantineLocator(
  db: D1Database,
  locator: BlobLocator,
  expectedByteSize: number,
  reason: "missing" | "size_mismatch",
  observedByteSize: number | null,
) {
  const timestamp = new Date().toISOString();
  await db.prepare(`
    INSERT INTO blob_integrity_quarantine (
      store_kind, provider, object_key, blob_record_id, reason,
      expected_byte_size, observed_byte_size, operation_id,
      detected_at, last_checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(store_kind, provider, object_key) DO UPDATE SET
      last_checked_at = excluded.last_checked_at
  `).bind(
    locator.storeKind,
    locator.provider,
    locator.objectKey,
    locator.blobRecordId,
    reason,
    expectedByteSize,
    observedByteSize,
    crypto.randomUUID(),
    timestamp,
    timestamp,
  ).run();
}

async function locatorIsReusable(
  env: Env,
  locator: BlobLocator,
  expectedByteSize: number,
) {
  const stat = await statBlob(env, locator);
  if (stat.outcome === "provider_unavailable") {
    throw new BlobReuseProviderUnavailableError(locator.provider, stat.message);
  }
  if (stat.outcome === "missing") {
    await quarantineLocator(env.DB, locator, expectedByteSize, "missing", null);
    return false;
  }
  if (stat.byteSize !== null && stat.byteSize !== expectedByteSize) {
    await quarantineLocator(env.DB, locator, expectedByteSize, "size_mismatch", stat.byteSize);
    return false;
  }
  return refreshOrphanGrace(env.DB, locator, crypto.randomUUID(), new Date());
}

export async function findReusableR2Asset(
  env: Env,
  sha256: string,
): Promise<ReusableR2Asset | null> {
  const rows = await env.DB.prepare(`
    SELECT a.id, a.r2_key, a.original_name, a.mime_type,
           a.byte_size, a.sha256
    FROM assets a
    LEFT JOIN imports i ON i.id = a.import_id
    WHERE a.sha256 = ? AND a.status = 'ready'
      AND (a.import_id IS NULL OR i.status = 'ready')
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = a.r2_key
      )
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 8
  `).bind(sha256).all<ReusableR2Asset>();

  for (const row of rows.results) {
    const locator: BlobLocator = {
      storeKind: "r2",
      provider: "r2",
      objectKey: row.r2_key,
      blobRecordId: row.id,
    };
    if (await locatorIsReusable(env, locator, Number(row.byte_size))) return row;
  }

  const pendingImport = await env.DB.prepare(`
    SELECT 1 AS pending
    FROM assets a
    JOIN imports i ON i.id = a.import_id AND i.status = 'pending'
    WHERE a.sha256 = ? AND a.status IN ('pending', 'ready')
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = a.r2_key
      )
    LIMIT 1
  `).bind(sha256).first<{ pending: number }>();
  if (pendingImport) {
    throw new BlobReuseProviderUnavailableError(
      "R2",
      "matching bytes are still owned by a pending FabuBlox import; retry after the import finishes",
    );
  }
  return null;
}

export async function findReusableManagedObject(
  env: Env,
  provider: string,
  sha256: string,
  byteSize: number,
): Promise<ReusableManagedObject | null> {
  const rows = await env.DB.prepare(`
    SELECT mso.id, mso.provider, mso.object_key, mso.original_name,
           mso.mime_type, mso.byte_size, mso.sha256
    FROM managed_storage_objects mso
    WHERE mso.provider = ? AND mso.sha256 = ? AND mso.byte_size = ?
      AND mso.status IN ('ready', 'orphaned')
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'managed' AND bg.provider = mso.provider
          AND bg.object_key = mso.object_key AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'managed' AND biq.provider = mso.provider
          AND biq.object_key = mso.object_key
      )
    ORDER BY mso.created_at DESC, mso.id DESC
    LIMIT 8
  `).bind(provider, sha256, byteSize).all<ReusableManagedObject>();

  for (const row of rows.results) {
    const locator: BlobLocator = {
      storeKind: "managed",
      provider: row.provider,
      objectKey: row.object_key,
      blobRecordId: row.id,
    };
    if (await locatorIsReusable(env, locator, Number(row.byte_size))) return row;
  }
  return null;
}
