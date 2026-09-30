/** Read-only deployment metadata. Configuration parsing and a registered profile
 * match never establish connection health, byte availability, or role defaults. */
export type StorageConfigurationState = "configured" | "missing" | "invalid";
export type StorageBindingMatch = "matched" | "mismatch" | "not_configured" | "invalid_configuration";
export const MAX_STORAGE_SETTINGS_PROFILES = 100;
export const MAX_STORAGE_SETTINGS_BYTES = 192 * 1024;
export interface StorageSettingsProfile {
  id: string;
  adapterType: "r2" | "switchdrive";
  configurationRevision: 1;
  /** Access to this recorded profile; not the application's upload default. */
  runtimeAccess: "read_only" | "read_write" | "retired";
  bindingMatch: StorageBindingMatch;
}
export interface StorageSettingsStatus {
  version: 2;
  kind: "storage-settings-status";
  readOnly: true;
  configurationSource: "deployment";
  health: "not_checked";
  authority: { mode: "legacy" | "overlap" | "active"; shadowConversions: "enabled" | "paused" };
  roleDefaults: { state: "legacy" | "pending_bootstrap" | "configured" };
  bindings: {
    r2: { configuration: StorageConfigurationState };
    managed: { provider: "switchdrive" | "none" | "unsupported"; configuration: StorageConfigurationState };
  };
  /** Pending bootstrap describes the intended R2 destination before first use. */
  uploadDestinations: { ordinaryUploads: "r2"; commentOriginals: "r2" | "switchdrive" | "unconfigured" | "unsupported" };
  profiles: { items: StorageSettingsProfile[]; hasMore: boolean; limit: typeof MAX_STORAGE_SETTINGS_PROFILES };
}
const encoder = new TextEncoder();
function invalid(): never { throw new Error("Invalid storage settings response"); }
function object(value: unknown, expected: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const actual = Object.keys(value).sort(), names = [...expected].sort();
  if (actual.length !== names.length || actual.some((name, index) => name !== names[index])) invalid();
  return value as Record<string, unknown>;
}
function enumeration<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid();
  return value as T;
}
const configuration = (value: unknown) => enumeration(value, ["configured", "missing", "invalid"] as const);
export function checkedStorageSettingsStatus(value: unknown): StorageSettingsStatus {
  const input = object(value, ["version", "kind", "readOnly", "configurationSource", "health", "authority", "roleDefaults", "bindings", "uploadDestinations", "profiles"]);
  if (input.version !== 2 || input.kind !== "storage-settings-status" || input.readOnly !== true
    || input.configurationSource !== "deployment" || input.health !== "not_checked") invalid();
  const authority = object(input.authority, ["mode", "shadowConversions"]), roles = object(input.roleDefaults, ["state"]), bindings = object(input.bindings, ["r2", "managed"]);
  const r2 = object(bindings.r2, ["configuration"]), managed = object(bindings.managed, ["provider", "configuration"]);
  const destinations = object(input.uploadDestinations, ["ordinaryUploads", "commentOriginals"]);
  if (destinations.ordinaryUploads !== "r2") invalid();
  const profiles = object(input.profiles, ["items", "hasMore", "limit"]);
  if (!Array.isArray(profiles.items) || profiles.items.length > MAX_STORAGE_SETTINGS_PROFILES
    || typeof profiles.hasMore !== "boolean" || profiles.limit !== MAX_STORAGE_SETTINGS_PROFILES
    || profiles.hasMore && profiles.items.length !== MAX_STORAGE_SETTINGS_PROFILES) invalid();
  const items = profiles.items.map((entry): StorageSettingsProfile => {
    const profile = object(entry, ["id", "adapterType", "configurationRevision", "runtimeAccess", "bindingMatch"]);
    if (typeof profile.id !== "string" || profile.id.length < 1 || profile.id.length > 256 || profile.id.includes("\0")
      || profile.configurationRevision !== 1) invalid();
    return { id: profile.id, adapterType: enumeration(profile.adapterType, ["r2", "switchdrive"] as const), configurationRevision: 1,
      runtimeAccess: enumeration(profile.runtimeAccess, ["read_only", "read_write", "retired"] as const),
      bindingMatch: enumeration(profile.bindingMatch, ["matched", "mismatch", "not_configured", "invalid_configuration"] as const) };
  });
  if (new Set(items.map(item => item.id)).size !== items.length) invalid();
  const result: StorageSettingsStatus = { version: 2, kind: "storage-settings-status", readOnly: true, configurationSource: "deployment", health: "not_checked",
    authority: { mode: enumeration(authority.mode, ["legacy", "overlap", "active"] as const), shadowConversions: enumeration(authority.shadowConversions, ["enabled", "paused"] as const) },
    roleDefaults: { state: enumeration(roles.state, ["legacy", "pending_bootstrap", "configured"] as const) },
    bindings: { r2: { configuration: configuration(r2.configuration) }, managed: {
      provider: enumeration(managed.provider, ["switchdrive", "none", "unsupported"] as const), configuration: configuration(managed.configuration),
    } }, uploadDestinations: { ordinaryUploads: "r2", commentOriginals: enumeration(destinations.commentOriginals, ["r2", "switchdrive", "unconfigured", "unsupported"] as const) },
    profiles: { items, hasMore: profiles.hasMore, limit: MAX_STORAGE_SETTINGS_PROFILES } };
  if (result.bindings.managed.provider === "none" && result.bindings.managed.configuration !== "missing"
    || result.bindings.managed.provider === "unsupported" && result.bindings.managed.configuration !== "invalid"
    || result.authority.mode === "active" && (result.roleDefaults.state === "legacy" || result.uploadDestinations.commentOriginals !== "r2")
    || result.authority.mode !== "active" && (result.roleDefaults.state !== "legacy"
      || result.uploadDestinations.commentOriginals !== (result.bindings.managed.provider === "none" ? "unconfigured" : result.bindings.managed.provider))) invalid();
  for (const profile of items) {
    const state = profile.adapterType === "r2" ? result.bindings.r2.configuration : result.bindings.managed.configuration;
    if (state === "missing" && profile.bindingMatch !== "not_configured"
      || state === "invalid" && profile.bindingMatch !== "invalid_configuration"
      || state === "configured" && !["matched", "mismatch"].includes(profile.bindingMatch)) invalid();
  }
  if (encoder.encode(JSON.stringify(result)).length > MAX_STORAGE_SETTINGS_BYTES) invalid();
  return result;
}
