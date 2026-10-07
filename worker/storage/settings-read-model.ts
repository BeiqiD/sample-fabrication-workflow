import { checkedStorageSettingsStatus, MAX_STORAGE_SETTINGS_BYTES, MAX_STORAGE_SETTINGS_PROFILES,
  type StorageBindingMatch, type StorageConfigurationState, type StorageSettingsStatus } from "../../shared/contracts/storage-settings";
import { primaryD1 } from "../d1-primary";
import { managedBootstrapNamespace } from "../files/managed-bootstrap-profile";
import { assertR2BootstrapProfile, r2BootstrapNamespace } from "../files/r2-bootstrap-profile";
import type { Env } from "../types";
import { checkedCurrentStorageSettings, checkedCurrentStorageSettingsProfile, type CurrentStorageSettings, type CurrentStorageSettingsProfile,
  type StorageRoleSelection } from "../../shared/contracts/current-storage-settings";
import { hasNativeStoragePolicy, selectedStorageProfile } from "./storage-role-policy";
import { openShadowProfile } from "../files/shadow-profile";

type DeploymentConfiguration = Pick<Env, "R2_BOOTSTRAP_NAMESPACE" | "MANAGED_STORAGE_PROVIDER" | "SWITCHDRIVE_WEBDAV_URL"
  | "SWITCHDRIVE_USERNAME" | "SWITCHDRIVE_APP_PASSWORD" | "SWITCHDRIVE_ROOT">;
interface BindingConfiguration { state: StorageConfigurationState; namespace: string | null }
const missing = (value: unknown) => value === undefined || value === null || typeof value === "string" && !value.trim();
function r2Configuration(env: DeploymentConfiguration): BindingConfiguration {
  if (missing(env.R2_BOOTSTRAP_NAMESPACE)) return { state: "missing", namespace: null };
  try { return { state: "configured", namespace: r2BootstrapNamespace(env) }; }
  catch { return { state: "invalid", namespace: null }; }
}
function managedConfiguration(env: DeploymentConfiguration): BindingConfiguration & { provider: "switchdrive" | "none" | "unsupported" } {
  if (missing(env.MANAGED_STORAGE_PROVIDER)) return { provider: "none", state: "missing", namespace: null };
  if (typeof env.MANAGED_STORAGE_PROVIDER !== "string" || env.MANAGED_STORAGE_PROVIDER.trim().toLowerCase() !== "switchdrive")
    return { provider: "unsupported", state: "invalid", namespace: null };
  if ([env.SWITCHDRIVE_WEBDAV_URL, env.SWITCHDRIVE_USERNAME, env.SWITCHDRIVE_APP_PASSWORD].some(missing))
    return { provider: "switchdrive", state: "missing", namespace: null };
  try { return { provider: "switchdrive", state: "configured", namespace: managedBootstrapNamespace(env) }; }
  catch { return { provider: "switchdrive", state: "invalid", namespace: null }; }
}
function bindingMatch(configuration: BindingConfiguration, matches: number): StorageBindingMatch {
  return configuration.state === "missing" ? "not_configured" : configuration.state === "invalid" ? "invalid_configuration"
    : matches === 1 ? "matched" : "mismatch";
}
export class StorageSettingsUnavailableError extends Error {
  constructor() { super("Storage settings are temporarily unavailable."); this.name = "StorageSettingsUnavailableError"; }
}

/** One primary snapshot. Namespace and credential-reference equality is reduced
 * inside SQL, so even the result rows contain only safe profile metadata. The
 * deployment parsers are pure; this reader never ensures profiles or probes a
 * provider. A match describes configuration identity, not connection health;
 * S3 registration describes only its immutable row and read-only runtime policy. */
export async function readStorageSettings(database: D1Database, env: DeploymentConfiguration): Promise<StorageSettingsStatus> {
  const r2 = r2Configuration(env), managed = managedConfiguration(env);
  try {
    const result = await primaryD1(database).prepare(`WITH profile_page AS (
      SELECT id,adapter_type,configuration_revision,configuration_source,credential_reference,namespace_identity,state
      FROM storage_profiles ORDER BY id LIMIT ${MAX_STORAGE_SETTINGS_PROFILES + 1}
    ), safe_profiles AS (
      SELECT p.id,p.adapter_type,p.configuration_revision,r.state runtime_access,
        CASE WHEN p.adapter_type='r2' THEN p.namespace_identity IS ?1 AND p.configuration_source='bootstrap'
          AND p.credential_reference IS NULL AND p.configuration_revision=1 AND p.state='historical'
        WHEN p.adapter_type='switchdrive' THEN p.namespace_identity IS ?2 AND p.configuration_source='environment'
          AND p.credential_reference IS 'environment:SWITCHDRIVE' AND p.configuration_revision=1 AND p.state='historical'
        WHEN p.adapter_type='s3' THEN p.configuration_source='system' AND p.credential_reference IS NULL
          AND p.configuration_revision=1 AND p.state='historical' AND r.state='read_only'
        ELSE 0 END binding_matches
      FROM profile_page p LEFT JOIN storage_profile_runtime r ON r.storage_profile_id=p.id
    ), role_defaults AS (
      SELECT d.role,d.storage_profile_id,d.storage_profile_revision,d.policy_revision,d.created_at,p.adapter_type
      FROM storage_role_defaults d LEFT JOIN storage_profiles p ON p.id=d.storage_profile_id
    ) SELECT authority.mode authority_mode,authority.revision authority_revision,runtime.enabled shadow_enabled,
      (SELECT count(*) FROM role_defaults) role_default_count,
      (SELECT json_group_array(json_object('role',role,'profileId',storage_profile_id,'profileRevision',storage_profile_revision,
        'policyRevision',policy_revision,'createdAt',created_at,'adapterType',adapter_type)) FROM role_defaults) role_defaults_json,
      (SELECT count(*) FROM safe_profiles) profile_count,
      (SELECT json_group_array(json_object('id',id,'adapterType',adapter_type,'configurationRevision',configuration_revision,
        'runtimeAccess',runtime_access,'bindingMatches',binding_matches)) FROM (SELECT * FROM safe_profiles ORDER BY id)) profiles_json
      FROM file_authority_control authority JOIN file_shadow_runtime_guard runtime ON runtime.singleton=authority.singleton
      WHERE authority.singleton=1`).bind(r2.namespace, managed.namespace).all<{
        authority_mode: string; authority_revision: number; shadow_enabled: number; profile_count: number; profiles_json: string;
        role_default_count: number; role_defaults_json: string;
      }>();
    if (!result.success || result.results.length !== 1) throw new StorageSettingsUnavailableError();
    const row = result.results[0];
    if (row.authority_revision !== 1 || ![0, 1].includes(row.shadow_enabled) || !Number.isSafeInteger(row.profile_count)
      || row.profile_count < 0 || row.profile_count > MAX_STORAGE_SETTINGS_PROFILES + 1 || typeof row.profiles_json !== "string"
      || new TextEncoder().encode(row.profiles_json).length > MAX_STORAGE_SETTINGS_BYTES) throw new StorageSettingsUnavailableError();
    if (![0, 2].includes(row.role_default_count) || typeof row.role_defaults_json !== "string"
      || row.role_defaults_json.length > 4096) throw new StorageSettingsUnavailableError();
    const defaults: unknown = JSON.parse(row.role_defaults_json);
    if (!Array.isArray(defaults) || defaults.length !== row.role_default_count
      || row.authority_mode !== "active" && defaults.length > 0) throw new StorageSettingsUnavailableError();
    for (const entry of defaults) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new StorageSettingsUnavailableError();
      const role = entry as Record<string, unknown>;
      if (Object.keys(role).length !== 6 || !["internal", "originals"].includes(String(role.role))
        || typeof role.profileId !== "string" || !role.profileId || role.profileId.length > 256 || role.profileId.includes("\0")
        || role.profileRevision !== 1 || role.policyRevision !== 2 || role.adapterType !== "r2"
        || typeof role.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(role.createdAt)
        || !Number.isFinite(Date.parse(role.createdAt)) || new Date(role.createdAt).toISOString() !== role.createdAt) throw new StorageSettingsUnavailableError();
    }
    if (defaults.length === 2 && (new Set(defaults.map(role => role.role)).size !== 2
      || defaults[0].profileId !== defaults[1].profileId)) throw new StorageSettingsUnavailableError();
    const rawProfiles: unknown = JSON.parse(row.profiles_json);
    if (!Array.isArray(rawProfiles) || rawProfiles.length !== row.profile_count) throw new StorageSettingsUnavailableError();
    const profiles = rawProfiles.map((profile: unknown) => {
      if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new StorageSettingsUnavailableError();
      const item = profile as Record<string, unknown>;
      if (Object.keys(item).length !== 5 || ![0, 1].includes(item.bindingMatches as number)
        || !["r2", "switchdrive", "s3"].includes(String(item.adapterType))
        || item.adapterType === "s3" && item.bindingMatches !== 1) throw new StorageSettingsUnavailableError();
      return { id: item.id, adapterType: item.adapterType, configurationRevision: item.configurationRevision, runtimeAccess: item.runtimeAccess,
        bindingMatch: item.adapterType === "s3" ? "registered" : bindingMatch(item.adapterType === "r2" ? r2 : managed, item.bindingMatches as number) };
    });
    const report = { version: 2, kind: "storage-settings-status", readOnly: true, configurationSource: "deployment", health: "not_checked",
      authority: { mode: row.authority_mode, shadowConversions: row.shadow_enabled ? "enabled" : "paused" },
      roleDefaults: { state: row.authority_mode !== "active" ? "legacy" : defaults.length ? "configured" : "pending_bootstrap" },
      bindings: { r2: { configuration: r2.state }, managed: { provider: managed.provider, configuration: managed.state } },
      uploadDestinations: { ordinaryUploads: "r2", commentOriginals: row.authority_mode === "active" ? "r2" : managed.provider === "none" ? "unconfigured" : managed.provider } };
    // Validate the sentinel row too, so truncation cannot conceal malformed
    // metadata among the rows used to establish this bounded snapshot.
    if (profiles.length > MAX_STORAGE_SETTINGS_PROFILES) checkedStorageSettingsStatus({ ...report,
      profiles: { items: profiles.slice(MAX_STORAGE_SETTINGS_PROFILES), hasMore: false, limit: MAX_STORAGE_SETTINGS_PROFILES } });
    return checkedStorageSettingsStatus({ ...report,
      profiles: { items: profiles.slice(0, MAX_STORAGE_SETTINGS_PROFILES), hasMore: profiles.length > MAX_STORAGE_SETTINGS_PROFILES, limit: MAX_STORAGE_SETTINGS_PROFILES } });
  } catch { throw new StorageSettingsUnavailableError(); }
}

/** Explicit current generation. The safe snapshot preserves selected IDs even
 * when their local capability is unavailable. Opening a capability is read-only
 * and performs no provider request; a changed binding is reported unavailable. */
export async function readCurrentStorageSettings(database: D1Database, env: Partial<Env>): Promise<CurrentStorageSettings> {
  try {
    const db = primaryD1(database);
    if (!await hasNativeStoragePolicy(db)) return readStorageSettings(db, env);
    const r2 = r2Configuration(env), managed = managedConfiguration(env);
    const result = await db.prepare(`WITH safe_profiles AS (
      SELECT p.id,p.adapter_type,p.configuration_revision,r.state runtime_access,b.binding_revision,
        CASE WHEN p.adapter_type='r2' THEN p.namespace_identity IS ?1 AND p.configuration_source='bootstrap'
          AND p.credential_reference IS NULL AND p.configuration_revision=1 AND p.state='historical'
        WHEN p.adapter_type='switchdrive' THEN p.namespace_identity IS ?2 AND p.configuration_source='environment'
          AND p.credential_reference IS 'environment:SWITCHDRIVE' AND p.configuration_revision=1 AND p.state='historical'
        WHEN p.adapter_type='s3' THEN p.configuration_source='system' AND p.credential_reference IS NULL
          AND p.configuration_revision=1 AND p.state='historical'
        ELSE 0 END binding_matches
      FROM storage_profiles p LEFT JOIN storage_profile_runtime r ON r.storage_profile_id=p.id
      LEFT JOIN system_storage_native_bindings b ON b.storage_profile_id=p.id
      ORDER BY p.id LIMIT ${MAX_STORAGE_SETTINGS_PROFILES + 1}
    ), roles AS (
      SELECT d.role,d.storage_profile_id,d.storage_profile_revision,d.policy_revision,d.created_at,p.adapter_type,
        b.binding_revision FROM storage_role_defaults d JOIN storage_profiles p ON p.id=d.storage_profile_id
      LEFT JOIN system_storage_native_bindings b ON b.storage_profile_id=p.id
    ) SELECT a.mode,a.revision,g.enabled file_enabled,s.enabled shadow_enabled,
      (SELECT json_group_array(json_object('id',id,'adapterType',adapter_type,'configurationRevision',configuration_revision,
        'runtimeAccess',runtime_access,'bindingMatches',binding_matches,'bindingRevision',binding_revision)) FROM safe_profiles) profiles_json,
      (SELECT count(*) FROM storage_role_defaults) role_count,
      (SELECT json_group_array(json_object('role',role,'profileId',storage_profile_id,'profileRevision',storage_profile_revision,
        'policyRevision',policy_revision,'createdAt',created_at,'adapterType',adapter_type,'bindingRevision',binding_revision)) FROM roles) roles_json
      FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton
      JOIN file_shadow_runtime_guard s ON s.singleton=a.singleton WHERE a.singleton=1`).bind(r2.namespace, managed.namespace).all<{
        mode: string; revision: number; file_enabled: number; shadow_enabled: number; profiles_json: string; role_count: number; roles_json: string;
      }>();
    if (!result.success || result.results.length !== 1) throw new Error();
    const row = result.results[0];
    if (row.revision !== 1 || ![0, 1].includes(row.file_enabled) || ![0, 1].includes(row.shadow_enabled)
      || typeof row.profiles_json !== "string" || new TextEncoder().encode(row.profiles_json).length > MAX_STORAGE_SETTINGS_BYTES
      || typeof row.roles_json !== "string" || row.roles_json.length > 4096 || ![0, 2].includes(row.role_count)) throw new Error();
    const raw: unknown = JSON.parse(row.profiles_json), roles: unknown = JSON.parse(row.roles_json);
    if (!Array.isArray(raw) || raw.length > MAX_STORAGE_SETTINGS_PROFILES + 1 || !Array.isArray(roles) || roles.length !== row.role_count) throw new Error();
    const available = async (id: string, adapterType: string, bindingRevision: number | null) => {
      try {
        if (adapterType === "switchdrive") {
          const opened = await openShadowProfile({ ...env, DB: db } as Env, { profileId: id, configurationRevision: 1 }, "write");
          return opened.storage.adapterType === "switchdrive" && !!opened.writer && !!opened.deleter;
        }
        const opened = await selectedStorageProfile(db, env, id);
        return adapterType === "s3" ? opened.adapterType === "s3" && opened.bindingRevision === bindingRevision : adapterType === "r2";
      } catch { return false; }
    };
    const profiles: CurrentStorageSettingsProfile[] = await Promise.all(raw.map(async item => {
      if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 6
        || ![0, 1].includes(item.bindingMatches) || item.adapterType === "s3" && item.bindingMatches !== 1) throw new Error();
      let binding = item.adapterType === "s3" ? item.runtimeAccess === "read_only" ? "registered" : "mismatch"
        : bindingMatch(item.adapterType === "r2" ? r2 : managed, item.bindingMatches);
      if (item.adapterType === "r2") {
        try { await assertR2BootstrapProfile(db, env, item.id, item.configurationRevision); binding = "matched"; }
        catch { binding = bindingMatch(r2, 0); }
      }
      // Current R2 opening can resolve a separately bound registered instance;
      // the bootstrap namespace is not a prerequisite for every R2 profile.
      const ready = item.runtimeAccess === "read_write" && (item.adapterType === "r2" || item.adapterType === "s3" || binding === "matched")
        && await available(item.id, item.adapterType, item.bindingRevision);
      return { id: item.id, adapterType: item.adapterType, configurationRevision: item.configurationRevision, runtimeAccess: item.runtimeAccess,
        bindingMatch: ready ? "matched" : binding, bindingRevision: item.bindingRevision,
        availability: item.runtimeAccess === "retired" ? "retired" : item.adapterType === "s3" && item.runtimeAccess === "read_only" ? "registered" : ready ? "available" : "unavailable" };
    }));
    let internal: StorageRoleSelection | null = null, originals: StorageRoleSelection | null = null, policyRevision: number | null = null;
    for (const role of roles) {
      if (!role || typeof role !== "object" || Array.isArray(role) || Object.keys(role).length !== 7 || !["internal", "originals"].includes(role.role)
        || role.profileRevision !== 1 || !Number.isSafeInteger(role.policyRevision) || role.policyRevision < 2
        || !["r2", "s3"].includes(role.adapterType) || typeof role.profileId !== "string" || !role.profileId || role.profileId.length > 256
        || typeof role.createdAt !== "string" || !Number.isFinite(Date.parse(role.createdAt)) || new Date(role.createdAt).toISOString() !== role.createdAt
        || policyRevision !== null && policyRevision !== role.policyRevision) throw new Error();
      policyRevision = role.policyRevision;
      const selection: StorageRoleSelection = { profileId: role.profileId, adapterType: role.adapterType,
        availability: await available(role.profileId, role.adapterType, role.bindingRevision) ? "available" : "unavailable" };
      if (role.role === "internal") { if (internal) throw new Error(); internal = selection; }
      else { if (originals) throw new Error(); originals = selection; }
    }
    if (roles.length === 2 && (roles[0].createdAt !== roles[1].createdAt
      || policyRevision === 2 && (internal?.profileId !== originals?.profileId || internal?.adapterType !== "r2" || originals?.adapterType !== "r2"))) throw new Error();
    const report = { version: 3, kind: "storage-settings-status", readOnly: true, health: "not_checked",
      authority: { mode: row.mode, shadowConversions: row.shadow_enabled ? "enabled" : "paused", fileAccess: row.file_enabled ? "enabled" : "paused" },
      roleDefaults: { state: row.mode !== "active" ? "legacy" : roles.length ? "configured" : "pending_bootstrap", policyRevision, internal, originals },
      bindings: { r2: { configuration: r2.state }, managed: { provider: managed.provider, configuration: managed.state } } };
    if (profiles.length > MAX_STORAGE_SETTINGS_PROFILES) checkedCurrentStorageSettingsProfile(profiles[MAX_STORAGE_SETTINGS_PROFILES]);
    return checkedCurrentStorageSettings({ ...report, profiles: { items: profiles.slice(0, MAX_STORAGE_SETTINGS_PROFILES),
      hasMore: profiles.length > MAX_STORAGE_SETTINGS_PROFILES, limit: MAX_STORAGE_SETTINGS_PROFILES } });
  } catch { throw new StorageSettingsUnavailableError(); }
}
