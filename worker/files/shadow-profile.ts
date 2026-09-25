import { primaryD1 } from "../d1-primary";
import { managedStorage } from "../managed-storage";
import type { Env } from "../types";
import type { ByteReader } from "./byte-reader";
import type { ByteWriter } from "./byte-writer";
import { assertManagedBootstrapProfile } from "./managed-bootstrap-profile";
import { assertR2BootstrapProfile } from "./r2-bootstrap-profile";
import { cloudflareSha256 } from "./storage-adapters/cloudflare-sha256";
import { managedByteReader } from "./storage-adapters/managed-reader";
import { managedByteWriter } from "./storage-adapters/managed-writer";
import { r2ByteReader } from "./storage-adapters/r2-reader";
import { r2ShadowByteWriter } from "./storage-adapters/r2-shadow-writer";

export interface FrozenShadowProfile {
  profileId: string;
  configurationRevision: number;
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
): Promise<{
  storage: FrozenShadowProfile & { adapterType: "r2" | "switchdrive"; namespaceIdentity: string };
  reader: ByteReader;
  writer?: ByteWriter;
  createHash: typeof cloudflareSha256;
}> {
  try {
    if (!frozen || typeof frozen.profileId !== "string" || !frozen.profileId
      || frozen.profileId.length > 256 || frozen.profileId.includes("\0")
      || frozen.configurationRevision !== 1 || !["read", "write"].includes(access)) throw new Error();
    const db = primaryD1(env.DB);
    const row = await db.prepare(`SELECT p.adapter_type, p.configuration_revision, r.state
      FROM storage_profiles p JOIN storage_profile_runtime r ON r.storage_profile_id=p.id
      WHERE p.id=?`).bind(frozen.profileId).first<{
        adapter_type: string; configuration_revision: number; state: string;
      }>();
    if (!row || row.configuration_revision !== frozen.configurationRevision
      || !["read_only", "read_write"].includes(row.state)
      || access === "write" && row.state !== "read_write") throw new Error();
    if (row.adapter_type === "r2") {
      const profile = await assertR2BootstrapProfile(db, env, frozen.profileId, frozen.configurationRevision);
      return { storage: { ...frozen, adapterType: "r2", namespaceIdentity: profile.namespaceIdentity },
        reader: r2ByteReader(env.ASSETS),
        ...(access === "write" ? { writer: r2ShadowByteWriter(env.ASSETS) } : {}),
        createHash: cloudflareSha256 };
    }
    if (row.adapter_type === "switchdrive") {
      const profile = await assertManagedBootstrapProfile(db, env, frozen.profileId, frozen.configurationRevision);
      const provider = managedStorage(env);
      if (!provider || provider.provider !== "switchdrive") throw new Error();
      return { storage: { ...frozen, adapterType: "switchdrive", namespaceIdentity: profile.namespaceIdentity },
        reader: managedByteReader(provider),
        ...(access === "write" ? { writer: managedByteWriter(provider) } : {}),
        createHash: cloudflareSha256 };
    }
    throw new Error();
  } catch { throw new ShadowProfileUnavailableError(); }
}
