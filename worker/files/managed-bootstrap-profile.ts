import { primaryD1 } from "../d1-primary";
import { switchdriveConfiguration } from "../switchdrive-storage";
import type { Env } from "../types";

const PROFILE_ID = "storage-profile:switchdrive:environment";

type ManagedBootstrapEnvironment = Pick<Env, "MANAGED_STORAGE_PROVIDER" | "SWITCHDRIVE_WEBDAV_URL"
  | "SWITCHDRIVE_USERNAME" | "SWITCHDRIVE_APP_PASSWORD" | "SWITCHDRIVE_ROOT">;

export class ManagedBootstrapUnavailableError extends Error {
  constructor() { super("Managed storage profile is unavailable"); this.name = "ManagedBootstrapUnavailableError"; }
}

export interface ManagedBootstrapProfile {
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

/** The account WebDAV endpoint and effective root determine physical object
 * identity. Authentication values only authorize access to that namespace and
 * are never captured. Use the adapter's configuration validation and its exact
 * root segmentation, so repeated/outer slashes cannot introduce aliases. */
export function managedBootstrapNamespace(env: ManagedBootstrapEnvironment): string {
  try {
    if (env.MANAGED_STORAGE_PROVIDER?.trim().toLowerCase() !== "switchdrive") throw new Error();
    const configuration = switchdriveConfiguration(env);
    if (!configuration) throw new Error();
    const namespace = JSON.stringify({ kind: "switchdrive", webdavUrl: configuration.webdavUrl,
      root: configuration.root.split("/").filter(Boolean).join("/") });
    if (namespace.length > 2048) throw new Error();
    return namespace;
  } catch { throw new ManagedBootstrapUnavailableError(); }
}

function checkedProfile(row: ProfileRow | null | undefined, namespace: string): ManagedBootstrapProfile {
  if (!row || typeof row.id !== "string" || !row.id || row.id.length > 256 || row.id.includes("\0")
    || row.adapter_type !== "switchdrive" || row.configuration_source !== "environment"
    || row.credential_reference !== "environment:SWITCHDRIVE" || row.configuration_revision !== 1
    || row.state !== "historical" || row.namespace_identity !== namespace) throw new ManagedBootstrapUnavailableError();
  return { id: row.id, configurationRevision: 1, namespaceIdentity: namespace };
}

/** Capture an immutable historical profile, without changing File authority or
 * storage defaults. Conditional insertion serializes competing namespaces;
 * primary readback alone reconciles lost acknowledgements and competing IDs. */
export async function ensureManagedBootstrapProfile(db: D1Database, env: ManagedBootstrapEnvironment, now: string): Promise<ManagedBootstrapProfile> {
  const namespace = managedBootstrapNamespace(env);
  try {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now)
      || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw new Error();
    const primary = primaryD1(db);
    const existing = await primary.prepare("SELECT * FROM storage_profiles WHERE adapter_type = 'switchdrive'").all<ProfileRow>();
    if (!existing.success) throw new Error();
    if (existing.results.length > 0) return checkedProfile(existing.results.find((row) => row.namespace_identity === namespace), namespace);
    try {
      await primary.prepare(`INSERT INTO storage_profiles
        (id, adapter_type, namespace_identity, configuration_source, credential_reference, configuration_revision, state, created_at)
        SELECT ?, 'switchdrive', ?, 'environment', 'environment:SWITCHDRIVE', 1, 'historical', ?
        WHERE NOT EXISTS (SELECT 1 FROM storage_profiles WHERE adapter_type = 'switchdrive')`)
        .bind(PROFILE_ID, namespace, now).run();
    } catch { /* Only authoritative readback can reconcile an unknown response. */ }
    return checkedProfile(await primary.prepare("SELECT * FROM storage_profiles WHERE adapter_type = 'switchdrive' AND namespace_identity = ?")
      .bind(namespace).first<ProfileRow>(), namespace);
  } catch { throw new ManagedBootstrapUnavailableError(); }
}

export async function assertManagedBootstrapProfile(db: D1Database, env: ManagedBootstrapEnvironment, profileId: string, revision: number): Promise<ManagedBootstrapProfile> {
  const namespace = managedBootstrapNamespace(env);
  try {
    if (revision !== 1 || typeof profileId !== "string" || !profileId || profileId.length > 256 || profileId.includes("\0")) throw new Error();
    return checkedProfile(await primaryD1(db).prepare("SELECT * FROM storage_profiles WHERE id = ?").bind(profileId).first<ProfileRow>(), namespace);
  } catch { throw new ManagedBootstrapUnavailableError(); }
}
