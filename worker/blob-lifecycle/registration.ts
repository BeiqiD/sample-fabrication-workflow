import { primaryD1 } from "../d1-primary";
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
