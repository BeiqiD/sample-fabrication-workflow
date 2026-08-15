import { primaryD1 } from "../d1-primary";
import type { Env } from "../types";
import type { ReusableManagedObject, ReusableR2Asset } from "./reuse";

export async function reconcileCommittedR2Asset(
  db: D1Database,
  input: { id: string; objectKey: string; sha256: string },
): Promise<ReusableR2Asset | null> {
  return primaryD1(db).prepare(`
    SELECT a.id, a.r2_key, a.original_name, a.mime_type,
           a.byte_size, a.sha256
    FROM assets a
    WHERE a.id = ? AND a.r2_key = ? AND a.sha256 = ?
      AND a.status = 'ready' AND a.import_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = a.r2_key
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = a.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
  `).bind(input.id, input.objectKey, input.sha256).first<ReusableR2Asset>();
}

export type R2RegistrationReconciliation =
  | {
      outcome: "resolved";
      asset: ReusableR2Asset;
      deduplicated: boolean;
    }
  | {
      outcome: "confirmed-uncommitted";
      error?: unknown;
    }
  | {
      outcome: "authority-unavailable";
      error: unknown;
    };

/**
 * Resolve an uncertain ready-R2 INSERT without guessing from the content hash.
 *
 * The exact stable identity is authoritative. A primary-D1 failure is distinct
 * from a confirmed absence: callers must preserve the uploaded locator and
 * return a retryable error while authority is unavailable. Only after primary
 * D1 confirms that the exact attempt did not commit may cleanup or winner
 * reconciliation make the candidate redundant.
 */
export async function reconcileR2RegistrationFailure(
  env: Env,
  input: {
    id: string;
    objectKey: string;
    sha256: string;
    findWinner: () => Promise<ReusableR2Asset | null>;
  },
): Promise<R2RegistrationReconciliation> {
  let committed: ReusableR2Asset | null;
  try {
    committed = await reconcileCommittedR2Asset(env.DB, input);
  } catch (error) {
    return { outcome: "authority-unavailable", error };
  }
  if (committed) {
    return {
      outcome: "resolved",
      asset: committed,
      deduplicated: false,
    };
  }

  let winner: ReusableR2Asset | null;
  try {
    winner = await input.findWinner();
  } catch (error) {
    return { outcome: "confirmed-uncommitted", error };
  }
  if (!winner) return { outcome: "confirmed-uncommitted" };

  const sameAttempt = winner.id === input.id
    && winner.r2_key === input.objectKey;
  if (!sameAttempt) {
    await env.ASSETS.delete(input.objectKey);
  }
  return {
    outcome: "resolved",
    asset: winner,
    deduplicated: !sameAttempt,
  };
}

export async function reconcileCommittedManagedObject(
  db: D1Database,
  input: {
    id: string;
    provider: string;
    objectKey: string;
    sha256: string;
    byteSize: number;
  },
): Promise<ReusableManagedObject | null> {
  return primaryD1(db).prepare(`
    SELECT mso.id, mso.provider, mso.object_key, mso.original_name,
           mso.mime_type, mso.byte_size, mso.sha256
    FROM managed_storage_objects mso
    WHERE mso.id = ? AND mso.provider = ? AND mso.object_key = ?
      AND mso.sha256 = ? AND mso.byte_size = ? AND mso.status = 'ready'
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'managed'
          AND biq.provider = mso.provider
          AND biq.object_key = mso.object_key
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'managed'
          AND bg.provider = mso.provider
          AND bg.object_key = mso.object_key
          AND bg.state IN ('deleting', 'deleted')
      )
  `).bind(
    input.id,
    input.provider,
    input.objectKey,
    input.sha256,
    input.byteSize,
  ).first<ReusableManagedObject>();
}
