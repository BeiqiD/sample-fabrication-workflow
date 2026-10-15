import type { Env } from "../types";
import { canonicalR2ProfileNamespace, r2ProfileNamespace } from "./r2-profile-bindings";

const PROFILE_ID = "storage-profile:r2:bootstrap";

export class R2BootstrapUnavailableError extends Error {
  constructor() { super("R2 storage profile is unavailable"); this.name = "R2BootstrapUnavailableError"; }
}

export interface R2BootstrapProfile {
  id: string;
  configurationRevision: 1;
  namespaceIdentity: string;
}

interface ProfileRow {
  id: string;
  adapter_type: string;
  namespace_identity: string;
  configuration_source: string;
  credential_reference: string | null;
  configuration_revision: number;
  state: string;
}

/** The namespace is deployment metadata, never inferred from the binding name,
 * the D1 UUID, a hostname, or a request. Local identities cannot alias a cloud
 * account. Exact serialization also excludes unknown/credential-bearing fields. */
export function r2BootstrapNamespace(env: Pick<Env, "R2_BOOTSTRAP_NAMESPACE">): string {
  try { return canonicalR2ProfileNamespace(env.R2_BOOTSTRAP_NAMESPACE); }
  catch { throw new R2BootstrapUnavailableError(); }
}

function checkedProfile(row: ProfileRow | null | undefined, namespace: string): R2BootstrapProfile {
  if (!row || typeof row.id !== "string" || !row.id || row.id.length > 256 || row.id.includes("\0")
    || row.adapter_type !== "r2" || row.configuration_source !== "bootstrap"
    || row.credential_reference !== null || row.configuration_revision !== 1
    || row.state !== "historical" || row.namespace_identity !== namespace) throw new R2BootstrapUnavailableError();
  return { id: row.id, configurationRevision: 1, namespaceIdentity: namespace };
}

/** Remains an immutable historical FP1 overlap profile, not a writable File
 * default. The conditional INSERT serializes first use against competing
 * namespaces; readback reconciles both lost acknowledgements and same-profile
 * races without rewriting a captured physical namespace. */
export async function ensureR2BootstrapProfile(db: D1Database, env: Pick<Env, "R2_BOOTSTRAP_NAMESPACE">, now: string): Promise<R2BootstrapProfile> {
  const namespace = r2BootstrapNamespace(env);
  try {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now)
      || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw new Error();
    const existing = await db.prepare("SELECT * FROM storage_profiles WHERE adapter_type = 'r2'").all<ProfileRow>();
    if (!existing.success) throw new Error();
    if (existing.results.length > 0) return checkedProfile(existing.results.find((row) => row.namespace_identity === namespace), namespace);
    try {
      await db.prepare(`INSERT INTO storage_profiles
        (id, adapter_type, namespace_identity, configuration_source, credential_reference, configuration_revision, state, created_at)
        SELECT ?, 'r2', ?, 'bootstrap', NULL, 1, 'historical', ?
        WHERE NOT EXISTS (SELECT 1 FROM storage_profiles WHERE adapter_type = 'r2')`)
        .bind(PROFILE_ID, namespace, now).run();
    } catch { /* Only authoritative readback can reconcile an unknown response. */ }
    const row = await db.prepare("SELECT * FROM storage_profiles WHERE adapter_type = 'r2' AND namespace_identity = ?")
      .bind(namespace).first<ProfileRow>();
    return checkedProfile(row, namespace);
  } catch { throw new R2BootstrapUnavailableError(); }
}

export async function assertR2BootstrapProfile(db: D1Database, env: Pick<Env, "R2_BOOTSTRAP_NAMESPACE" | "R2_PROFILE_BINDINGS">, profileId: string, revision: number): Promise<R2BootstrapProfile> {
  try {
    if (revision !== 1 || typeof profileId !== "string" || !profileId || profileId.length > 256 || profileId.includes("\0")) throw new Error();
    const namespace = r2ProfileNamespace(env, profileId);
    return checkedProfile(await db.prepare("SELECT * FROM storage_profiles WHERE id = ?").bind(profileId).first<ProfileRow>(), namespace);
  } catch { throw new R2BootstrapUnavailableError(); }
}
