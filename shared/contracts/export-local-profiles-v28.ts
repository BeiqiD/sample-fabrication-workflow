import type { ExportRow, ExportTables } from "./export";
import { checkedStoredLocalVolumeNamespace } from "./local-volume-profile";
import { FILE_SHADOW_DEPENDENCY_SPECS } from "./file-shadow-schema";
import { sha256Hex, stableJson } from "../domain/content-addressing";
import { nativeV5CommentItemRow, type NativeV5CommentProvenance } from "./export-native-v5-comment-provenance";

export const LOCAL_PROFILE_HISTORY_TABLE_NAMES = ["local_storage_profile_registrations", "local_storage_profile_activations"] as const;
export const LOCAL_PROFILE_INSTALLATION_TABLE_NAMES = ["local_storage_profile_checks", "local_storage_profile_admissions", "local_storage_profile_bindings"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 254 && !value.includes("\0");
const clock = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error(`V28 local profile history rejected: ${reason}`); }
function snapshot(value: unknown): ExportRow {
  try { const row: unknown = JSON.parse(String(value)); ensure(row && typeof row === "object" && !Array.isArray(row), "runtime snapshot"); return row as ExportRow; }
  catch { throw new Error("V28 local profile history rejected: runtime snapshot"); }
}

/** Research carries physical identity and historical runtime metadata only.
 * Protected registration/activation audits and every installation binding are
 * excluded. Recorded read_write is never interpreted as usable authority. */
export async function validateLocalProfileMetadataV28(tables: ExportTables, nativeComment?: NativeV5CommentProvenance): Promise<ReadonlySet<string>> {
  for (const name of [...LOCAL_PROFILE_HISTORY_TABLE_NAMES, ...LOCAL_PROFILE_INSTALLATION_TABLE_NAMES]) ensure(!Object.hasOwn(tables, name), "protected/local rows in research");
  const profiles = tables.storage_profiles.filter(row => row.adapter_type === "local"), ids = new Set(profiles.map(row => String(row.id)));
  ensure(ids.size === profiles.length, "metadata profile identity");
  const namespaces = new Set<string>();
  for (const profile of profiles) {
    const canonical = JSON.stringify(checkedStoredLocalVolumeNamespace(profile.namespace_identity)), digest = await sha256Hex(canonical);
    ensure(profile.id === `storage-profile:local:${digest}` && !namespaces.has(canonical) && profile.configuration_source === "installation"
      && profile.credential_reference === null && profile.configuration_revision === 1 && profile.state === "historical" && clock(profile.created_at), "metadata canonical namespace");
    const history = tables.file_shadow_dependency_versions.filter(row => row.dependency_kind === "storage_profiles" && row.dependency_key === stableJson([profile.id]));
    ensure(history.length === 1 && history[0].revision === 1 && history[0].present === 1
      && stableJson(snapshot(history[0].snapshot_json)) === stableJson(Object.fromEntries(FILE_SHADOW_DEPENDENCY_SPECS.storage_profiles.snapshotColumns.map(column => [column, profile[column]]))), "metadata immutable profile history");
    const versions = tables.file_shadow_dependency_versions.filter(row => row.dependency_kind === "storage_profile_runtime" && row.dependency_key === stableJson([profile.id])).sort((a, b) => Number(a.revision) - Number(b.revision));
    const initial = { storage_profile_id: profile.id, state: "read_only", registered_at: profile.created_at, activated_at: null, retired_at: null };
    ensure(versions.length > 0 && stableJson(snapshot(versions[0].snapshot_json)) === stableJson(initial), "metadata read-only origin");
    let previous = initial as ExportRow;
    for (const [index, version] of versions.entries()) {
      const row = snapshot(version.snapshot_json);
      ensure(version.revision === index + 1 && version.present === 1 && stableJson(Object.keys(row).sort()) === stableJson(Object.keys(initial).sort())
        && row.storage_profile_id === profile.id && row.registered_at === profile.created_at
        && ["read_only", "read_write", "retired"].includes(String(row.state)), "metadata runtime history");
      if (index > 0) {
        ensure(row.state !== "read_only" && (row.state === "read_write" ? clock(row.activated_at) && row.activated_at >= String(profile.created_at) && row.retired_at === null
          : row.activated_at === previous.activated_at && clock(row.retired_at) && row.retired_at >= String(profile.created_at)), "metadata runtime transition");
        if (previous.activated_at !== null && row.activated_at !== null) ensure(String(row.activated_at) >= String(previous.activated_at), "metadata activation clock");
        if (previous.retired_at !== null) ensure(String(row.activated_at ?? row.retired_at) >= String(previous.retired_at), "metadata retirement clock");
        ensure(stableJson(row) !== stableJson(previous), "duplicate runtime version");
      }
      previous = row;
    }
    const runtime = tables.storage_profile_runtime.filter(row => row.storage_profile_id === profile.id);
    ensure(runtime.length === 1 && stableJson(runtime[0]) === stableJson(previous), "metadata current runtime");
    namespaces.add(canonical);
  }
  assertLocalPayloadScopeV28(tables, ids, nativeComment);
  return ids;
}

function assertLocalPayloadScopeV28(tables: ExportTables, ids: ReadonlySet<string>, nativeComment?: NativeV5CommentProvenance) {
  // This first explicit local-byte profile supports ordinary accepted uploads;
  // import/metrology/shadow/job/recovery-publication references remain closed.
  // Native V5 alone may qualify exact completed local Comment receipt rows.
  const payloadTables = new Set(["file_locations", "file_location_publications", "file_location_availability", "file_acceptance_candidates",
    "r2_upload_requests", "assets", "storage_role_defaults", "storage_role_policy_revisions"]);
  for (const [name, rows] of Object.entries(tables)) {
    if (["storage_profiles", "storage_profile_runtime", ...LOCAL_PROFILE_HISTORY_TABLE_NAMES].includes(name)) continue;
    for (const row of rows) for (const [column, value] of Object.entries(row)) if (column === "storage_profile_id" || column.endsWith("_profile_id")) {
      ensure(!ids.has(String(value)) || column === "storage_profile_id" && (payloadTables.has(name)
        || name === "comment_item_acceptances" && nativeV5CommentItemRow(nativeComment, row)), `unsupported local provider payload:${name}.${column}`);
    }
  }
}

/** Portable decisions are provenance, never destination installation authority.
 * The dedicated V28 runtime verifier qualifies the closed ordinary local File
 * payload set. Nothing here admits destination paths, bindings or execution. */
export async function validateLocalProfileHistoryV28(tables: ExportTables, nativeComment?: NativeV5CommentProvenance): Promise<ReadonlySet<string>> {
  for (const name of LOCAL_PROFILE_INSTALLATION_TABLE_NAMES) ensure(!Object.hasOwn(tables, name), "installation authority in content");
  const profiles = tables.storage_profiles.filter(row => row.adapter_type === "local");
  const ids = new Set(profiles.map(row => String(row.id)));
  ensure(ids.size === profiles.length && tables.local_storage_profile_registrations.length === profiles.length, "registration inventory");
  const operations = new Set<string>(), admissions = new Map<string, string>(), registered = new Set<string>(), namespaces = new Set<string>();
  for (const registration of tables.local_storage_profile_registrations) {
    const id = String(registration.storage_profile_id), profile = profiles.find(row => row.id === id);
    ensure(profile && !registered.has(id) && typeof registration.operation_id === "string" && UUID.test(registration.operation_id)
      && !operations.has(registration.operation_id) && text(registration.actor) && clock(registration.created_at), "registration identity");
    const namespace = checkedStoredLocalVolumeNamespace(profile.namespace_identity), canonical = JSON.stringify(namespace);
    const digest = await sha256Hex(canonical);
    ensure(registration.namespace_sha256 === digest && profile.id === `storage-profile:local:${digest}`
      && !namespaces.has(canonical) && profile.configuration_source === "installation" && profile.credential_reference === null
      && profile.configuration_revision === 1 && profile.state === "historical" && profile.created_at === registration.created_at, "canonical immutable namespace");
    const history = tables.file_shadow_dependency_versions.filter(row => row.dependency_kind === "storage_profiles" && row.dependency_key === stableJson([id]));
    ensure(history.length === 1 && history[0].revision === 1 && history[0].present === 1
      && stableJson(snapshot(history[0].snapshot_json)) === stableJson(Object.fromEntries(FILE_SHADOW_DEPENDENCY_SPECS.storage_profiles.snapshotColumns.map(column => [column, profile[column]]))), "profile dependency history");
    const runtime = tables.storage_profile_runtime.filter(row => row.storage_profile_id === id);
    ensure(runtime.length === 1 && runtime[0].registered_at === registration.created_at, "runtime inventory");
    const versions = tables.file_shadow_dependency_versions.filter(row => row.dependency_kind === "storage_profile_runtime" && row.dependency_key === stableJson([id])).sort((a, b) => Number(a.revision) - Number(b.revision));
    const original = { storage_profile_id: id, state: "read_only", registered_at: registration.created_at, activated_at: null, retired_at: null };
    const expected = [stableJson(original)];
    const actions = tables.local_storage_profile_activations.filter(row => row.storage_profile_id === id)
      .sort((a, b) => Number(a.binding_revision) - Number(b.binding_revision) || String(a.created_at).localeCompare(String(b.created_at)) || (a.action === b.action ? String(a.operation_id).localeCompare(String(b.operation_id)) : a.action === "activate" ? -1 : 1));
    let highestBinding = 0, previous: ExportRow | undefined, activatedAt: string | null = null;
    for (const action of actions) {
      ensure(typeof action.operation_id === "string" && UUID.test(action.operation_id) && !operations.has(action.operation_id)
        && action.configuration_revision === 1 && action.namespace_sha256 === digest && ["activate", "retire"].includes(String(action.action))
        && revision(action.binding_revision) && text(action.actor) && clock(action.created_at)
        && action.created_at >= registration.created_at && (!previous || action.created_at >= String(previous.created_at)), "action identity/clock");
      ensure(action.admission_operation_id === null || typeof action.admission_operation_id === "string" && UUID.test(action.admission_operation_id), "admission provenance");
      if (action.action === "activate") {
        ensure(action.binding_revision > highestBinding && typeof action.admission_operation_id === "string" && !admissions.has(action.admission_operation_id), "new activation provenance");
        activatedAt = action.created_at;
      } else {
        // A read-only binding may be retired before its first writable action;
        // its excluded admission is provenance only, not invented authority.
        ensure(action.binding_revision >= highestBinding && (action.binding_revision === 0 ? action.admission_operation_id === null : typeof action.admission_operation_id === "string"), "retirement provenance");
        if (previous && action.binding_revision === highestBinding) ensure(action.admission_operation_id === previous.admission_operation_id, "retained retirement provenance");
      }
      if (typeof action.admission_operation_id === "string") {
        const binding = stableJson([id, action.binding_revision]);
        ensure(!admissions.has(action.admission_operation_id) || admissions.get(action.admission_operation_id) === binding, "immutable admission binding provenance");
        admissions.set(action.admission_operation_id, binding);
      }
      highestBinding = action.binding_revision;
      const state = stableJson({ storage_profile_id: id, state: action.action === "activate" ? "read_write" : "retired",
        registered_at: registration.created_at, activated_at: activatedAt, retired_at: action.action === "retire" ? action.created_at : null });
      if (expected.at(-1) !== state) expected.push(state);
      operations.add(action.operation_id); previous = action;
    }
    ensure(versions.length === expected.length && versions.every((row, index) => row.present === 1 && row.revision === index + 1 && stableJson(snapshot(row.snapshot_json)) === expected[index]), "complete runtime dependency history");
    ensure(stableJson(runtime[0]) === expected.at(-1), "current historical runtime");
    operations.add(registration.operation_id); registered.add(id); namespaces.add(canonical);
  }
  ensure(tables.local_storage_profile_activations.every(row => ids.has(String(row.storage_profile_id))), "action owner");
  assertLocalPayloadScopeV28(tables, ids, nativeComment);
  ensure(tables.file_shadow_profile_enablements.every(row => !ids.has(String(row.storage_profile_id))), "legacy local enablement forbidden");
  return ids;
}
