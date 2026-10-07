import type { ExportRow, ExportTables } from "./export";
import { stableJson } from "../domain/content-addressing";
import { FILE_NATIVE_RUNTIME_TABLE_COLUMNS } from "./file-native-runtime";

function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid native role policy ${reason}`);
}
const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");

export function validateNativeRolePolicies(tables: ExportTables) {
  const profiles = new Map(tables.storage_profiles.map(row => [row.id, row]));
  const policies = new Map<number, ExportRow[]>();
  for (const row of tables.storage_role_policy_revisions) {
    ensure(stableJson(Object.keys(row).sort()) === stableJson([...FILE_NATIVE_RUNTIME_TABLE_COLUMNS.storage_role_policy_revisions].sort()), "history columns");
    ensure(typeof row.policy_revision === "number" && Number.isSafeInteger(row.policy_revision) && row.policy_revision >= 2
      && ["internal", "originals"].includes(String(row.role)) && text(row.operation_id) && text(row.actor) && time(row.created_at), "history identity");
    const profile = profiles.get(row.storage_profile_id);
    ensure(profile && profile.configuration_revision === row.storage_profile_revision
      && ["r2", "s3"].includes(String(profile.adapter_type)), "historical target");
    if (profile.adapter_type === "s3") {
      const history = tables.storage_profile_activations.filter(entry => entry.storage_profile_id === profile.id
        && Date.parse(String(entry.created_at)) <= Date.parse(row.created_at as string))
        .sort((a, b) => Number(a.binding_revision) - Number(b.binding_revision)
          || (a.action === b.action ? 0 : a.action === "activate" ? -1 : 1));
      ensure(history.at(-1)?.action === "activate", "selection follows native activation");
    }
    const rows = policies.get(row.policy_revision) ?? [];
    rows.push(row); policies.set(row.policy_revision, rows);
  }
  const revisions = [...policies.keys()].sort((a, b) => a - b);
  const operations = new Set<unknown>();
  for (const [index, revision] of revisions.entries()) {
    ensure(index === 0 ? revision === 2 || revision >= 3 : revision > revisions[index - 1], "history sequence");
    const rows = policies.get(revision)!;
    ensure(rows.length === 2 && new Set(rows.map(row => row.role)).size === 2
      && ["operation_id", "actor", "created_at"].every(column => new Set(rows.map(row => row[column])).size === 1), "atomic paired policy");
    ensure(!operations.has(rows[0].operation_id), "unique accepted operation"); operations.add(rows[0].operation_id);
    if (index > 0) ensure(Date.parse(String(rows[0].created_at)) >= Date.parse(String(policies.get(revisions[index - 1])![0].created_at)), "policy history clock");
    if (revision === 2) ensure(rows.every(row => profiles.get(row.storage_profile_id)?.adapter_type === "r2")
      && new Set(rows.map(row => row.storage_profile_id)).size === 1, "frozen bootstrap policy");
  }
  const defaults = tables.storage_role_defaults;
  ensure(defaults.length === 0 || defaults.length === 2, "current paired inventory");
  if (defaults.length) {
    const revision = Number(defaults[0].policy_revision), policy = policies.get(revision);
    ensure(revision === revisions.at(-1) && policy && new Set(defaults.map(row => row.role)).size === 2
      && defaults.every(row => row.policy_revision === revision && policy.some(selected => selected.role === row.role
        && selected.storage_profile_id === row.storage_profile_id && selected.storage_profile_revision === row.storage_profile_revision
        && selected.created_at === row.created_at)), "current policy projection");
  } else ensure(policies.size === 0, "current policy absent after history");
}

/** A saved selection is checked against immutable history, never today's
 * defaults or a newly edited installation candidate. */
export function validateRecordedRoleTarget(tables: ExportTables, policyRevision: unknown, purpose: unknown,
  profileId: unknown, configurationRevision: unknown, acceptedAt?: unknown): ExportRow {
  ensure(typeof policyRevision === "number" && Number.isSafeInteger(policyRevision) && policyRevision >= 2, "recorded selection revision");
  const role = purpose === "research_source" || purpose === "provenance" ? "originals" : "internal";
  const selected = tables.storage_role_policy_revisions.filter(row => row.policy_revision === policyRevision && row.role === role);
  ensure(selected.length === 1 && selected[0].storage_profile_id === profileId
    && selected[0].storage_profile_revision === configurationRevision
    && (acceptedAt === undefined || time(acceptedAt) && Date.parse(selected[0].created_at as string) <= Date.parse(acceptedAt)), "recorded selection target");
  const profile = tables.storage_profiles.find(row => row.id === profileId);
  ensure(profile && profile.configuration_revision === configurationRevision, "recorded selection profile");
  return profile;
}
