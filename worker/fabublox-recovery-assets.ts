import { sha256Hex } from "../shared/content-addressing";
import { getBlob, statBlob } from "./blob-lifecycle/storage";
import type { BlobLocator } from "./blob-lifecycle/types";
import type { Env } from "./types";

interface RecoveryAssetRow {
  id: string;
  r2_key: string;
  byte_size: number;
  sha256: string | null;
  status: "pending" | "ready" | "failed";
  quarantine_reason: "missing" | "size_mismatch" | null;
  quarantine_expected_byte_size: number | null;
  quarantine_observed_byte_size: number | null;
  gc_state: "orphaned" | "deleting" | "deleted" | null;
}

export interface FabubloxRecoveryAssetInspection {
  id: string;
  objectKey: string;
  available: boolean;
  sha256: string | null;
  byteSize: number;
  quarantineReason: "missing" | "size_mismatch" | null;
  expectedByteSize: number;
  observedByteSize: number | null;
}

export class FabubloxRecoveryProviderUnavailableError extends Error {
  constructor(objectKey: string, detail: string) {
    super(`Could not verify FabuBlox recovery asset ${objectKey}: ${detail}`);
    this.name = "FabubloxRecoveryProviderUnavailableError";
  }
}

function locator(row: RecoveryAssetRow): BlobLocator {
  return {
    storeKind: "r2",
    provider: "r2",
    objectKey: row.r2_key,
    blobRecordId: row.id,
  };
}

function unavailable(
  row: RecoveryAssetRow,
  reason: "missing" | "size_mismatch" | null,
  observedByteSize: number | null,
): FabubloxRecoveryAssetInspection {
  return {
    id: row.id,
    objectKey: row.r2_key,
    available: false,
    sha256: null,
    byteSize: Number(row.byte_size),
    quarantineReason: reason,
    expectedByteSize: Number(row.byte_size),
    observedByteSize,
  };
}

async function rejectConflictingRecoveredHash(
  db: D1Database,
  assetId: string,
  sha256: string,
) {
  const conflict = await db.prepare(`
    SELECT a.id
    FROM assets a
    WHERE a.id <> ? AND a.sha256 = ? AND a.status IN ('pending', 'ready')
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
  `).bind(assetId, sha256).first<{ id: string }>();
  if (conflict) {
    throw new Error(
      `Recovered bytes conflict with live canonical asset ${conflict.id}; recovery requires explicit relationship reconciliation`,
    );
  }
}

export async function inspectFabubloxRecoveryAssets(
  env: Env,
  db: D1Database,
  importId: string,
): Promise<FabubloxRecoveryAssetInspection[]> {
  const rows = await db.prepare(`
    SELECT a.id, a.r2_key, a.byte_size, a.sha256, a.status,
           biq.reason AS quarantine_reason,
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
    ORDER BY a.created_at, a.id
  `).bind(importId).all<RecoveryAssetRow>();

  const inspections: FabubloxRecoveryAssetInspection[] = [];
  for (const row of rows.results) {
    if (row.quarantine_reason) {
      inspections.push({
        id: row.id,
        objectKey: row.r2_key,
        available: false,
        sha256: null,
        byteSize: Number(row.byte_size),
        quarantineReason: row.quarantine_reason,
        expectedByteSize: Number(
          row.quarantine_expected_byte_size ?? row.byte_size,
        ),
        observedByteSize: row.quarantine_observed_byte_size === null
          ? null
          : Number(row.quarantine_observed_byte_size),
      });
      continue;
    }
    if (row.gc_state === "deleting" || row.gc_state === "deleted") {
      inspections.push(unavailable(row, null, null));
      continue;
    }

    if (row.sha256 === null) {
      const read = await getBlob(env, locator(row));
      if (read.outcome === "provider_unavailable") {
        throw new FabubloxRecoveryProviderUnavailableError(row.r2_key, read.message);
      }
      if (read.outcome === "missing") {
        inspections.push(unavailable(row, "missing", null));
        continue;
      }
      const bytes = await new Response(read.body).arrayBuffer();
      const sha256 = await sha256Hex(bytes);
      await rejectConflictingRecoveredHash(db, row.id, sha256);
      inspections.push({
        id: row.id,
        objectKey: row.r2_key,
        available: true,
        sha256,
        byteSize: bytes.byteLength,
        quarantineReason: null,
        expectedByteSize: Number(row.byte_size),
        observedByteSize: bytes.byteLength,
      });
      continue;
    }

    const stat = await statBlob(env, locator(row));
    if (stat.outcome === "provider_unavailable") {
      throw new FabubloxRecoveryProviderUnavailableError(row.r2_key, stat.message);
    }
    if (stat.outcome === "missing") {
      inspections.push(unavailable(row, "missing", null));
      continue;
    }
    if (stat.byteSize === null) {
      throw new FabubloxRecoveryProviderUnavailableError(
        row.r2_key,
        "R2 did not return a stable byte size",
      );
    }
    if (stat.byteSize !== Number(row.byte_size)) {
      inspections.push(unavailable(row, "size_mismatch", stat.byteSize));
      continue;
    }
    inspections.push({
      id: row.id,
      objectKey: row.r2_key,
      available: true,
      sha256: row.sha256,
      byteSize: Number(row.byte_size),
      quarantineReason: null,
      expectedByteSize: Number(row.byte_size),
      observedByteSize: stat.byteSize,
    });
  }
  return inspections;
}
