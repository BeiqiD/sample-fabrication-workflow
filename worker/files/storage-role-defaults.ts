import { primaryD1 } from "../d1-primary";
import type { Env } from "../types";
import { assertR2BootstrapProfile, ensureR2BootstrapProfile, type R2BootstrapProfile } from "./r2-bootstrap-profile";

export interface StorageRoleDefault {
  role: "internal" | "originals";
  storageProfileId: string;
  storageProfileRevision: 1;
  policyRevision: 2;
  createdAt: string;
}
export interface StorageRoleDefaults { internal: StorageRoleDefault; originals: StorageRoleDefault }
export class StorageRoleDefaultsUnavailableError extends Error {
  constructor() { super("The selected storage role is unavailable."); this.name = "StorageRoleDefaultsUnavailableError"; }
}

/** Pure metadata read. Empty means the first active binary acceptance has not
 * initialized the policy; an incomplete policy is never silently repaired. */
export async function readStorageRoleDefaults(database: D1Database): Promise<StorageRoleDefaults | null> {
  try {
    const result = await primaryD1(database).prepare("SELECT role,storage_profile_id,storage_profile_revision,policy_revision,created_at FROM storage_role_defaults ORDER BY role")
      .all<{ role: string; storage_profile_id: string; storage_profile_revision: number; policy_revision: number; created_at: string }>();
    if (!result.success) throw new StorageRoleDefaultsUnavailableError();
    if (!result.results.length) return null;
    if (result.results.length !== 2) throw new StorageRoleDefaultsUnavailableError();
    const rows = result.results.map((row): StorageRoleDefault => {
      if (!["internal", "originals"].includes(row.role) || typeof row.storage_profile_id !== "string" || !row.storage_profile_id
        || row.storage_profile_id.length > 256 || row.storage_profile_id.includes("\0") || row.storage_profile_revision !== 1
        || row.policy_revision !== 2 || !Number.isFinite(Date.parse(row.created_at)) || new Date(row.created_at).toISOString() !== row.created_at)
        throw new StorageRoleDefaultsUnavailableError();
      return { role: row.role as StorageRoleDefault["role"], storageProfileId: row.storage_profile_id,
        storageProfileRevision: 1, policyRevision: 2, createdAt: row.created_at };
    });
    if (rows[0].role !== "internal" || rows[1].role !== "originals" || rows[0].storageProfileId !== rows[1].storageProfileId || rows[0].createdAt !== rows[1].createdAt)
      throw new StorageRoleDefaultsUnavailableError();
    return { internal: rows[0], originals: rows[1] };
  } catch { throw new StorageRoleDefaultsUnavailableError(); }
}

/** The caller adds these statements to its acceptance batch. No default is
 * written here, and a restart/redeploy never rewrites a persisted choice. */
export async function prepareR2StorageRoleDefaults(database: D1Database, env: Pick<Env, "R2_BOOTSTRAP_NAMESPACE">,
  now: string): Promise<{ profile: R2BootstrapProfile; statements: D1PreparedStatement[] }> {
  const db = primaryD1(database);
  try {
    const stored = await readStorageRoleDefaults(db);
    const profile = stored ? await assertR2BootstrapProfile(db, env, stored.originals.storageProfileId, stored.originals.storageProfileRevision)
      : await ensureR2BootstrapProfile(db, env, now);
    const admitted = await db.prepare(`SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g
      ON g.singleton=a.singleton AND g.enabled=1 JOIN storage_profile_runtime r ON r.storage_profile_id=? AND r.state='read_write'
      WHERE a.singleton=1 AND a.mode='active'`).bind(profile.id).first();
    if (!admitted) throw new StorageRoleDefaultsUnavailableError();
    const statements = ["internal", "originals"].map(role => db.prepare(`INSERT INTO storage_role_defaults
      (role,storage_profile_id,storage_profile_revision,policy_revision,created_at)
      SELECT ?,?,1,2,? WHERE NOT EXISTS(SELECT 1 FROM storage_role_defaults WHERE role=?)`)
      .bind(role, profile.id, now, role));
    statements.push(db.prepare(`SELECT CASE WHEN (SELECT count(*) FROM storage_role_defaults)=2
      AND NOT EXISTS(SELECT 1 FROM storage_role_defaults WHERE storage_profile_id<>? OR storage_profile_revision<>1 OR policy_revision<>2)
      AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1
        JOIN storage_profile_runtime r ON r.storage_profile_id=? AND r.state='read_write' WHERE a.singleton=1 AND a.mode='active')
      THEN 1 ELSE json('R2 role default acceptance did not commit') END`).bind(profile.id, profile.id));
    return { profile, statements };
  } catch { throw new StorageRoleDefaultsUnavailableError(); }
}
