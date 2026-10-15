import type { ManagedStorageStatus } from "../../shared/types";
import { primaryD1 } from "../d1-primary";
import { readFileAuthorityMode } from "../files/authority-reader";
import { assertR2BootstrapProfile, r2BootstrapNamespace } from "../files/r2-bootstrap-profile";
import { readStorageRoleDefaults } from "../files/storage-role-defaults";
import { managedStorageStatus } from "../managed-storage";
import type { Env } from "../types";

const unavailable = (): ManagedStorageStatus => ({ provider: "r2", available: false, authentication: "service_binding",
  message: "Original file storage is unavailable. Retry to enable file attachments; attachment links remain available." });

/** Status follows new original uploads. Historical locations are opened only
 * when their recorded files are read; their connectivity does not gate uploads.
 * First use may persist role defaults, but a status read never creates them. */
export async function originalFileStorageStatus(env: Env): Promise<ManagedStorageStatus> {
  try {
    if (await readFileAuthorityMode(env.DB) !== "active") return managedStorageStatus(env);
    const db = primaryD1(env.DB), defaults = await readStorageRoleDefaults(db);
    const namespace = r2BootstrapNamespace(env);
    const row = await db.prepare(`SELECT p.id,p.configuration_revision,r.state,g.enabled
      FROM storage_profiles p JOIN storage_profile_runtime r ON r.storage_profile_id=p.id
      JOIN file_authority_runtime_guard g ON g.singleton=1
      WHERE p.adapter_type='r2' AND p.namespace_identity=? AND (? IS NULL OR p.id=?)`)
      .bind(namespace, defaults?.originals.storageProfileId ?? null, defaults?.originals.storageProfileId ?? null)
      .first<{ id: string; configuration_revision: number; state: string; enabled: number }>();
    if (!row || row.state !== "read_write" || row.enabled !== 1) return unavailable();
    await assertR2BootstrapProfile(db, env, row.id, row.configuration_revision);
    await env.ASSETS.list({ limit: 1 });
    return { provider: "r2", available: true, authentication: "service_binding",
      message: "Cloudflare R2 is connected. New original files are stored without modification." };
  } catch { return unavailable(); }
}
