import { configurationSqlInteger } from "../runtime/configuration-sql";
import type { FileAuthoritySqlDatabase } from "../runtime/file-authority-sql";

export interface StorageRoleDefault {
  role: "internal" | "originals";
  storageProfileId: string;
  storageProfileRevision: 1;
  policyRevision: number;
  createdAt: string;
}
export interface StorageRoleDefaults { internal: StorageRoleDefault; originals: StorageRoleDefault }
export class StorageRoleDefaultsUnavailableError extends Error {
  constructor() { super("The selected storage role is unavailable."); this.name = "StorageRoleDefaultsUnavailableError"; }
}

/** Pure metadata read. Empty means the first active binary acceptance has not
 * initialized the policy; an incomplete policy is never silently repaired. */
export async function readSqlStorageRoleDefaults(database: FileAuthoritySqlDatabase): Promise<StorageRoleDefaults | null> {
  try {
    const result = await database.primary().prepare("SELECT role,storage_profile_id,storage_profile_revision,policy_revision,created_at FROM storage_role_defaults ORDER BY role")
      .all();
    if (!result.success) throw new StorageRoleDefaultsUnavailableError();
    if (!result.results.length) return null;
    if (result.results.length !== 2) throw new StorageRoleDefaultsUnavailableError();
    const rows = result.results.map((row): StorageRoleDefault => {
      const role = row.role, createdAt = row.created_at;
      const profileRevision = configurationSqlInteger(row.storage_profile_revision, "storageRole.profileRevision", 1);
      const policyRevision = configurationSqlInteger(row.policy_revision, "storageRole.policyRevision", 2);
      if ((role !== "internal" && role !== "originals") || typeof row.storage_profile_id !== "string" || !row.storage_profile_id
        || row.storage_profile_id.length > 256 || row.storage_profile_id.includes("\0") || profileRevision !== 1
        || typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt)
        throw new StorageRoleDefaultsUnavailableError();
      return { role, storageProfileId: row.storage_profile_id,
        storageProfileRevision: 1, policyRevision, createdAt };
    });
    if (rows[0].role !== "internal" || rows[1].role !== "originals" || rows[0].policyRevision !== rows[1].policyRevision
      || rows[0].policyRevision === 2 && rows[0].storageProfileId !== rows[1].storageProfileId || rows[0].createdAt !== rows[1].createdAt)
      throw new StorageRoleDefaultsUnavailableError();
    return { internal: rows[0], originals: rows[1] };
  } catch { throw new StorageRoleDefaultsUnavailableError(); }
}

