import type { ExportSchemaObject, ExportTables, FileShadowSourceRowids } from "./export";
import { validateFileRuntimeRows, FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-runtime";
import { fileShadowSchemaFingerprint, validateFileShadowRows } from "./export-file-shadow";
import { validateFileShadowWithdrawalRows } from "./export-file-shadow-withdrawals";
import { validateFileShadowAdjudicationRows } from "./export-file-shadow-adjudications";

/** Independent V19 checkpoint; historical schema fingerprints remain frozen. */
export const FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256 = "a267c2c6e4fa4be261a581f737e9f04b491a7d40180d495f6d4dbb9cea2c49d5";
export const STORAGE_ROLE_DEFAULTS_EXPORT_COLUMNS = {
  storage_role_defaults: ["role", "storage_profile_id", "storage_profile_revision", "policy_revision", "created_at"],
} as const;
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid R2 role defaults ${reason}`);
}
export function validateStorageRoleDefaults(tables: ExportTables) {
  const defaults = tables.storage_role_defaults;
  ensure(Array.isArray(defaults) && [0, 2].includes(defaults.length), "complete role inventory");
  if (!defaults.length) return;
  ensure(new Set(defaults.map(row => row.role)).size === 2 && defaults.every(row => ["internal", "originals"].includes(String(row.role)))
    && new Set(defaults.map(row => row.storage_profile_id)).size === 1
    && new Set(defaults.map(row => row.created_at)).size === 1, "paired role identity");
  for (const row of defaults) {
    const profile = tables.storage_profiles.find(profile => profile.id === row.storage_profile_id);
    ensure(row.storage_profile_revision === 1 && row.policy_revision === 2
      && typeof row.created_at === "string" && Number.isFinite(Date.parse(row.created_at)) && new Date(row.created_at).toISOString() === row.created_at
      && profile?.adapter_type === "r2" && profile.configuration_source === "bootstrap"
      && profile.configuration_revision === row.storage_profile_revision && profile.credential_reference === null
      && profile.state === "historical" && Date.parse(String(profile.created_at)) <= Date.parse(row.created_at), "frozen profile decision");
  }
}
export async function validateFileRolePolicyExport(tables: ExportTables, schemaObjects: ExportSchemaObject[], sourceRowids?: FileShadowSourceRowids) {
  ensure(await fileShadowSchemaFingerprint(schemaObjects) === FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256, "schema fingerprint");
  validateStorageRoleDefaults(tables);
  const acceptedPublicationLocations = validateFileRuntimeRows(tables);
  await validateFileShadowRows(tables, schemaObjects, sourceRowids, { acceptedPublicationLocations });
  await validateFileShadowWithdrawalRows(tables, schemaObjects);
  await validateFileShadowAdjudicationRows(tables, schemaObjects, { allowActive: true,
    schemaSha256: FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256,
    historicalSchemaSha256s: [FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256] });
}
