import { primaryD1 } from "../d1-primary";
import { managedStorage } from "../managed-storage";
import type { Env } from "../types";
import type { ByteReader } from "./byte-reader";
import type { ByteWriter } from "./byte-writer";
import type { ByteDeleter } from "./byte-deleter";
import { assertManagedBootstrapProfile } from "./managed-bootstrap-profile";
import { assertR2BootstrapProfile } from "./r2-bootstrap-profile";
import { cloudflareSha256 } from "./storage-adapters/cloudflare-sha256";
import { managedByteReader } from "./storage-adapters/managed-reader";
import { managedByteWriter } from "./storage-adapters/managed-writer";
import { managedByteDeleter } from "./storage-adapters/managed-deleter";
import { r2ByteReader } from "./storage-adapters/r2-reader";
import { r2ShadowByteWriter } from "./storage-adapters/r2-shadow-writer";
import { r2ByteDeleter } from "./storage-adapters/r2-deleter";

export interface FrozenShadowProfile {
  profileId: string;
  configurationRevision: number;
}

export interface ShadowProfileLifecycle {
  /** Recheck the caller's exact deletion claim immediately before transport.
   * False or an exception prevents I/O. This does not revoke an in-flight DELETE. */
  beforeDelete?: (key: string) => Promise<boolean>;
}

type BoundStorage = FrozenShadowProfile & { adapterType: "r2" | "switchdrive"; namespaceIdentity: string };
const MANAGED_BINDINGS = ["MANAGED_STORAGE_PROVIDER", "SWITCHDRIVE_WEBDAV_URL", "SWITCHDRIVE_USERNAME",
  "SWITCHDRIVE_APP_PASSWORD", "SWITCHDRIVE_ROOT"] as const;

function profileByteDeleter(env: Env, captured: Env, storage: BoundStorage, transport: ByteDeleter,
  beforeDelete: ShadowProfileLifecycle["beforeDelete"]): ByteDeleter {
  const sameBinding = () => env.DB === captured.DB && (storage.adapterType === "r2"
    ? env.ASSETS === captured.ASSETS && env.R2_BOOTSTRAP_NAMESPACE === captured.R2_BOOTSTRAP_NAMESPACE
    : MANAGED_BINDINGS.every(key => env[key] === captured[key]));
  return {
    async delete(key) {
      try {
        // Opening a profile is not a lasting write authorization. Use a new
        // primary session for each delete, including stale-lease reconciliation.
        const writable = await primaryD1(captured.DB).prepare(`SELECT 1 AS writable FROM storage_profiles p
          JOIN storage_profile_runtime runtime ON runtime.storage_profile_id=p.id
          WHERE p.id=? AND p.adapter_type=? AND p.namespace_identity=? AND p.configuration_revision=?
            AND p.configuration_source=? AND p.credential_reference IS ? AND p.state='historical'
            AND runtime.state='read_write' AND runtime.registered_at=p.created_at
            AND runtime.activated_at IS NOT NULL AND runtime.retired_at IS NULL`)
          .bind(storage.profileId, storage.adapterType, storage.namespaceIdentity, storage.configurationRevision,
            storage.adapterType === "r2" ? "bootstrap" : "environment",
            storage.adapterType === "r2" ? null : "environment:SWITCHDRIVE").first();
        if (!writable || !sameBinding()) return { outcome: "unavailable" };
        if (beforeDelete && !await beforeDelete(key)) return { outcome: "unavailable" };
        if (!sameBinding()) return { outcome: "unavailable" };
        return await transport.delete(key);
      } catch { return { outcome: "unavailable" }; }
    },
  };
}

export class ShadowProfileUnavailableError extends Error {
  constructor() { super("The recorded File storage profile is unavailable"); this.name = "ShadowProfileUnavailableError"; }
}

/** Resolve only an exact, already registered physical namespace. This function
 * never creates a profile, changes its access state, chooses a role default, or
 * uses a request-supplied URL/credential. The caller still owns the database
 * lease, generation check and lifecycle fence surrounding provider I/O. */
export async function openShadowProfile(
  env: Env,
  frozen: FrozenShadowProfile,
  access: "read" | "write",
  lifecycle: ShadowProfileLifecycle = {},
): Promise<{
  storage: BoundStorage;
  reader: ByteReader;
  writer?: ByteWriter;
  deleter?: ByteDeleter;
  createHash: typeof cloudflareSha256;
}> {
  try {
    if (!frozen || typeof frozen.profileId !== "string" || !frozen.profileId
      || frozen.profileId.length > 256 || frozen.profileId.includes("\0")
      || frozen.configurationRevision !== 1 || !["read", "write"].includes(access)) throw new Error();
    const target = { profileId: frozen.profileId, configurationRevision: frozen.configurationRevision };
    const captured = { ...env }, beforeDelete = lifecycle.beforeDelete;
    const db = primaryD1(captured.DB);
    const row = await db.prepare(`SELECT p.adapter_type, p.configuration_revision, r.state
      FROM storage_profiles p JOIN storage_profile_runtime r ON r.storage_profile_id=p.id
      WHERE p.id=?`).bind(target.profileId).first<{
        adapter_type: string; configuration_revision: number; state: string;
      }>();
    if (!row || row.configuration_revision !== target.configurationRevision
      || !["read_only", "read_write"].includes(row.state)
      || access === "write" && row.state !== "read_write") throw new Error();
    if (row.adapter_type === "r2") {
      const profile = await assertR2BootstrapProfile(db, captured, target.profileId, target.configurationRevision);
      const storage: BoundStorage = Object.freeze({ ...target, adapterType: "r2", namespaceIdentity: profile.namespaceIdentity });
      return { storage,
        reader: r2ByteReader(captured.ASSETS),
        ...(access === "write" ? { writer: r2ShadowByteWriter(captured.ASSETS),
          deleter: profileByteDeleter(env, captured, storage, r2ByteDeleter(captured.ASSETS), beforeDelete) } : {}),
        createHash: cloudflareSha256 };
    }
    if (row.adapter_type === "switchdrive") {
      const profile = await assertManagedBootstrapProfile(db, captured, target.profileId, target.configurationRevision);
      const provider = managedStorage(captured);
      if (!provider || provider.provider !== "switchdrive") throw new Error();
      const storage: BoundStorage = Object.freeze({ ...target, adapterType: "switchdrive", namespaceIdentity: profile.namespaceIdentity });
      return { storage,
        reader: managedByteReader(provider),
        ...(access === "write" ? { writer: managedByteWriter(provider),
          deleter: profileByteDeleter(env, captured, storage, managedByteDeleter(provider), beforeDelete) } : {}),
        createHash: cloudflareSha256 };
    }
    throw new Error();
  } catch { throw new ShadowProfileUnavailableError(); }
}
