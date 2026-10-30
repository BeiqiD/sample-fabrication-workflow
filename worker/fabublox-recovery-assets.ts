import {
  BlobReuseProviderUnavailableError,
  findReusableR2Asset,
  type ReusableR2Asset,
} from "./blob-lifecycle/reuse";
import { inspectLegacyRecoveryBytes } from "./files/legacy-byte-inspection";
import { validateByteExpectation } from "./files/byte-verification";
import { cloudflareSha256 } from "./files/storage-adapters/cloudflare-sha256";
import { r2ByteReader } from "./files/storage-adapters/r2-reader";
import type { Env } from "./types";

export interface RecoveryAssetRow {
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
  canonicalAssetId: string | null;
  canonicalObjectKey: string | null;
  canonicalSha256: string | null;
  canonicalByteSize: number | null;
  snapshot: Readonly<RecoveryAssetRow>;
}

export class FabubloxRecoveryProviderUnavailableError extends Error {
  constructor() {
    super("FabuBlox recovery file bytes could not be verified. Retry later.");
    this.name = "FabubloxRecoveryProviderUnavailableError";
  }
}

function unavailable(
  row: RecoveryAssetRow,
  reason: "missing" | "size_mismatch" | null,
  observedByteSize: number | null,
  canonical: ReusableR2Asset | null = null,
  expectedByteSize = Number(row.byte_size),
): FabubloxRecoveryAssetInspection {
  return {
    id: row.id,
    objectKey: row.r2_key,
    available: false,
    sha256: null,
    byteSize: Number(row.byte_size),
    quarantineReason: reason,
    expectedByteSize,
    observedByteSize,
    canonicalAssetId: canonical?.id ?? null,
    canonicalObjectKey: canonical?.r2_key ?? null,
    canonicalSha256: canonical?.sha256 ?? null,
    canonicalByteSize: canonical ? Number(canonical.byte_size) : null,
    snapshot: Object.freeze({ ...row }),
  };
}

async function canonicalWinner(
  env: Env,
  sha256: string,
  byteSize: number,
): Promise<ReusableR2Asset | null> {
  try {
    validateByteExpectation({ byteSize, sha256 }, "destination");
    const winner = await findReusableR2Asset(env, sha256);
    if (!winner) return null;
    if (Number(winner.byte_size) !== byteSize) {
      throw new FabubloxRecoveryProviderUnavailableError();
    }
    // The reuse lookup preserves its existing ownership/orphan-grace fences,
    // but its stat result is not integrity evidence for a canonical successor.
    const checked = await inspectLegacyRecoveryBytes(r2ByteReader(env.ASSETS), winner.r2_key,
      { byteSize, sha256 }, cloudflareSha256);
    if (checked.outcome !== "available") throw new FabubloxRecoveryProviderUnavailableError();
    return winner;
  } catch (error) {
    if (error instanceof BlobReuseProviderUnavailableError
      && error.message.includes("matching bytes are still owned by a pending FabuBlox import")) {
      // A pending import is a private successor, not a public canonical winner.
      // The recovery ownership graph will handle that case after the claim.
      return null;
    }
    throw new FabubloxRecoveryProviderUnavailableError();
  }
}

function availableInspection(
  row: RecoveryAssetRow,
  sha256: string,
  byteSize: number,
  canonical: ReusableR2Asset | null,
): FabubloxRecoveryAssetInspection {
  return {
    id: row.id,
    objectKey: row.r2_key,
    available: true,
    sha256,
    byteSize,
    quarantineReason: null,
    expectedByteSize: Number(row.byte_size),
    observedByteSize: byteSize,
    canonicalAssetId: canonical?.id ?? null,
    canonicalObjectKey: canonical?.r2_key ?? null,
    canonicalSha256: canonical?.sha256 ?? null,
    canonicalByteSize: canonical ? Number(canonical.byte_size) : null,
    snapshot: Object.freeze({ ...row }),
  };
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
    const expectedByteSize = Number(row.byte_size);
    const trustedCanonical = row.sha256 === null
      ? null
      : await canonicalWinner(
          env,
          row.sha256,
          expectedByteSize,
        );

    if (row.quarantine_reason) {
      inspections.push(unavailable(
        row,
        row.quarantine_reason,
        row.quarantine_observed_byte_size === null
          ? null
          : Number(row.quarantine_observed_byte_size),
        trustedCanonical,
        Number(row.quarantine_expected_byte_size ?? row.byte_size),
      ));
      continue;
    }
    if (row.gc_state === "deleting" || row.gc_state === "deleted") {
      inspections.push(unavailable(row, null, null, trustedCanonical));
      continue;
    }

    let checked;
    try {
      checked = await inspectLegacyRecoveryBytes(r2ByteReader(env.ASSETS), row.r2_key,
        { byteSize: expectedByteSize, sha256: row.sha256 }, cloudflareSha256);
    } catch {
      // In particular, do not turn a hash mismatch into a missing/size diagnosis
      // or discard the stored hash. Inspection precedes the durable cleanup claim.
      throw new FabubloxRecoveryProviderUnavailableError();
    }
    if (checked.outcome === "missing") {
      inspections.push(unavailable(row, "missing", null, trustedCanonical));
      continue;
    }
    if (checked.outcome === "size_mismatch") {
      inspections.push(unavailable(
        row,
        "size_mismatch",
        checked.observedByteSize,
        trustedCanonical,
      ));
      continue;
    }
    inspections.push(availableInspection(
      row,
      checked.sha256,
      expectedByteSize,
      row.sha256 === null
        ? await canonicalWinner(env, checked.sha256, expectedByteSize)
        : trustedCanonical,
    ));
  }
  return inspections;
}
