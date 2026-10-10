import { checkedStorageSettingsStatus, MAX_STORAGE_SETTINGS_BYTES, MAX_STORAGE_SETTINGS_PROFILES,
  type StorageSettingsProfile, type StorageSettingsStatus } from "./storage-settings";

export type StorageProfileAvailability = "available" | "unavailable" | "registered" | "retired";
export interface CurrentStorageSettingsProfile extends StorageSettingsProfile {
  bindingRevision: number | null;
  availability: StorageProfileAvailability;
}
export interface StorageRoleSelection {
  profileId: string;
  adapterType: "r2" | "s3";
  availability: "available" | "unavailable";
}
/** Local capability observations do not check provider connectivity. This
 * successor exposes exact role selections while keeping credential data private. */
export interface CurrentStorageSettingsStatus {
  version: 3;
  kind: "storage-settings-status";
  readOnly: true;
  health: "not_checked";
  authority: StorageSettingsStatus["authority"] & { fileAccess: "enabled" | "paused" };
  roleDefaults: { state: "legacy" | "pending_bootstrap" | "configured"; policyRevision: number | null;
    internal: StorageRoleSelection | null; originals: StorageRoleSelection | null };
  bindings: StorageSettingsStatus["bindings"];
  profiles: { items: CurrentStorageSettingsProfile[]; hasMore: boolean; limit: typeof MAX_STORAGE_SETTINGS_PROFILES };
}
export type CurrentStorageSettings = StorageSettingsStatus | CurrentStorageSettingsStatus;
function invalid(): never { throw new Error("Invalid storage settings response."); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
  return value as Record<string, unknown>;
}
function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid();
  return value as T;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function revision(value: unknown, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid();
  return value as number;
}
function role(value: unknown): StorageRoleSelection | null {
  if (value === null) return null;
  const v = object(value, ["profileId", "adapterType", "availability"]);
  return { profileId: id(v.profileId), adapterType: enumeration(v.adapterType, ["r2", "s3"] as const),
    availability: enumeration(v.availability, ["available", "unavailable"] as const) };
}
export function checkedCurrentStorageSettingsProfile(value: unknown): CurrentStorageSettingsProfile {
  const x = object(value, ["id", "adapterType", "configurationRevision", "runtimeAccess", "bindingMatch", "bindingRevision", "availability"]);
  if (x.configurationRevision !== 1) invalid();
  const item: CurrentStorageSettingsProfile = { id: id(x.id), adapterType: enumeration(x.adapterType, ["r2", "switchdrive", "s3"] as const),
    configurationRevision: 1, runtimeAccess: enumeration(x.runtimeAccess, ["read_only", "read_write", "retired"] as const),
    bindingMatch: enumeration(x.bindingMatch, ["matched", "mismatch", "not_configured", "invalid_configuration", "registered"] as const),
    bindingRevision: x.bindingRevision === null ? null : revision(x.bindingRevision),
    availability: enumeration(x.availability, ["available", "unavailable", "registered", "retired"] as const) };
  if (item.adapterType !== "s3" && (item.bindingRevision !== null || item.bindingMatch === "registered" || item.availability === "registered")
    || item.availability === "available" && (item.runtimeAccess !== "read_write" || item.bindingMatch !== "matched")
    || (item.availability === "retired") !== (item.runtimeAccess === "retired")
    || item.adapterType === "s3" && item.runtimeAccess === "read_only" && (item.availability !== "registered" || item.bindingMatch !== "registered")
    || item.adapterType === "s3" && item.runtimeAccess === "read_write" && (item.bindingMatch === "registered" || item.availability === "available" && item.bindingRevision === null)
    || item.availability === "registered" && item.runtimeAccess !== "read_only") invalid();
  return item;
}
export function checkedCurrentStorageSettings(value: unknown): CurrentStorageSettings {
  if (value && typeof value === "object" && "version" in value && value.version === 2) return checkedStorageSettingsStatus(value);
  const v = object(value, ["version", "kind", "readOnly", "health", "authority", "roleDefaults", "bindings", "profiles"]);
  if (v.version !== 3 || v.kind !== "storage-settings-status" || v.readOnly !== true || v.health !== "not_checked") invalid();
  const a = object(v.authority, ["mode", "shadowConversions", "fileAccess"]), r = object(v.roleDefaults, ["state", "policyRevision", "internal", "originals"]);
  const b = object(v.bindings, ["r2", "managed"]), r2 = object(b.r2, ["configuration"]), managed = object(b.managed, ["provider", "configuration"]);
  const p = object(v.profiles, ["items", "hasMore", "limit"]);
  if (!Array.isArray(p.items) || p.items.length > MAX_STORAGE_SETTINGS_PROFILES || typeof p.hasMore !== "boolean"
    || p.limit !== MAX_STORAGE_SETTINGS_PROFILES || p.hasMore && p.items.length !== MAX_STORAGE_SETTINGS_PROFILES) invalid();
  const items = p.items.map(checkedCurrentStorageSettingsProfile);
  if (new Set(items.map(item => item.id)).size !== items.length) invalid();
  const result: CurrentStorageSettingsStatus = { version: 3, kind: "storage-settings-status", readOnly: true, health: "not_checked",
    authority: { mode: enumeration(a.mode, ["legacy", "overlap", "active"] as const), shadowConversions: enumeration(a.shadowConversions, ["enabled", "paused"] as const),
      fileAccess: enumeration(a.fileAccess, ["enabled", "paused"] as const) },
    roleDefaults: { state: enumeration(r.state, ["legacy", "pending_bootstrap", "configured"] as const),
      policyRevision: r.policyRevision === null ? null : revision(r.policyRevision, 2), internal: role(r.internal), originals: role(r.originals) },
    bindings: { r2: { configuration: enumeration(r2.configuration, ["configured", "missing", "invalid"] as const) },
      managed: { provider: enumeration(managed.provider, ["switchdrive", "none", "unsupported"] as const),
        configuration: enumeration(managed.configuration, ["configured", "missing", "invalid"] as const) } },
    profiles: { items, hasMore: p.hasMore, limit: MAX_STORAGE_SETTINGS_PROFILES } };
  const roles = result.roleDefaults;
  for (const selected of [roles.internal, roles.originals]) {
    if (!selected) continue;
    const profile = items.find(item => item.id === selected.profileId);
    if (!profile && !p.hasMore || profile && (profile.adapterType !== selected.adapterType
      || selected.availability !== (profile.availability === "available" ? "available" : "unavailable"))) invalid();
  }
  if (roles.state === "configured" && (!roles.internal || !roles.originals || roles.policyRevision === null)
    || roles.state !== "configured" && (roles.internal !== null || roles.originals !== null || roles.policyRevision !== null)
    || (result.authority.mode !== "active") !== (roles.state === "legacy")
    || result.bindings.managed.provider === "none" && result.bindings.managed.configuration !== "missing"
    || result.bindings.managed.provider === "unsupported" && result.bindings.managed.configuration !== "invalid"
    || roles.policyRevision === 2 && (roles.internal?.adapterType !== "r2" || roles.originals?.adapterType !== "r2"
      || roles.internal.profileId !== roles.originals.profileId)
    || roles.internal && roles.originals && roles.internal.profileId === roles.originals.profileId
      && (roles.internal.adapterType !== roles.originals.adapterType || roles.internal.availability !== roles.originals.availability)
    || new TextEncoder().encode(JSON.stringify(result)).length > MAX_STORAGE_SETTINGS_BYTES) invalid();
  return result;
}
