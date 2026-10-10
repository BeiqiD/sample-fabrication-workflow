import type { BlobLifecycleDatabase } from "./gc-database";

/** Historical installations have no FP5 metadata. A configured recovery
 * installation must never interpret its missing retention table as permission
 * to delete. Read the primary schema instead of caching across migrations. */
export async function recoveryHoldsInstalled(db: BlobLifecycleDatabase, required = false): Promise<boolean | null> {
  const installed = Boolean(await db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='system_recovery_legacy_holds'",
  ).first());
  return required && !installed ? null : installed;
}

/** Arguments are internal SQL expressions, never request data. Tuple matching
 * intentionally keeps provider and store kind distinct for identical keys. */
export function recoveryTupleUnheldSql(installed: boolean, storeKind: string, provider: string, objectKey: string) {
  return installed ? `NOT EXISTS (SELECT 1 FROM system_recovery_legacy_holds recovery_hold
    WHERE recovery_hold.store_kind=${storeKind} AND recovery_hold.provider=${provider}
      AND recovery_hold.object_key=${objectKey} AND recovery_hold.released_at IS NULL)` : "1";
}
