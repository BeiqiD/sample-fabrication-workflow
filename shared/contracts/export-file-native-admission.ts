import type { ExportRow, ExportSchemaObject, ExportTables, FileShadowSourceRowids } from "./export";
import { sha256Hex, stableJson } from "../domain/content-addressing";
import { canonicalNativeS3Namespace, checkedStorageProfileAdmissionReceipt } from "./storage-profile-admission";
import { FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256, validateFileRuntimeRows } from "./export-file-runtime";
import { FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256, validateStorageRoleDefaults } from "./export-file-role-policy";
import { fileShadowSchemaFingerprint, validateFileShadowRows } from "./export-file-shadow";
import { validateFileShadowWithdrawalRows } from "./export-file-shadow-withdrawals";
import { validateFileShadowAdjudicationRows } from "./export-file-shadow-adjudications";

/** Independent V20 checkpoint. V8–V19 schemas and row semantics stay frozen. */
export const FILE_NATIVE_ADMISSION_SCHEMA_FINGERPRINT_SHA256 = "c6fd2da614d716dcc50b368b95d82f54084592ed77ef31533871f97457cc3c1c";
export const STORAGE_PROFILE_ADMISSIONS_EXPORT_COLUMNS = {
  storage_profile_admissions: ["operation_id", "native_profile_id", "candidate_profile_id", "candidate_revision", "envelope_revision", "check_id", "configuration_sha256", "namespace_sha256", "actor", "created_at"],
} as const;
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid native profile admission ${reason}`);
}
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Non-secret registration provenance does not claim that the recovered
 * installation has credentials or permission to read or write this namespace. */
export async function validateNativeProfileAdmissions(tables: ExportTables): Promise<ReadonlySet<string>> {
  const admitted = tables.storage_profile_admissions;
  ensure(Array.isArray(admitted), "inventory");
  const profiles = new Map(tables.storage_profiles.map(row => [row.id, row]));
  const nativeProfiles = tables.storage_profiles.filter(row => row.adapter_type === "s3");
  const nativeIds = new Set(nativeProfiles.map(row => String(row.id)));
  ensure(nativeIds.size === nativeProfiles.length && admitted.length === nativeProfiles.length, "complete native profile inventory");
  const operations = new Set<string>(), admittedIds = new Set<string>(), namespaces = new Set<string>();
  for (const row of admitted) {
    ensure(stableJson(Object.keys(row).sort()) === stableJson([...STORAGE_PROFILE_ADMISSIONS_EXPORT_COLUMNS.storage_profile_admissions].sort()), "columns");
    let receipt: ReturnType<typeof checkedStorageProfileAdmissionReceipt> | undefined;
    try { receipt = checkedStorageProfileAdmissionReceipt({ operationId: row.operation_id, profileId: row.candidate_profile_id,
      revision: row.candidate_revision, envelopeRevision: row.envelope_revision, checkId: row.check_id,
      nativeProfileId: row.native_profile_id, configurationRevision: 1, runtimeAccess: "read_only",
      createdAt: row.created_at, createdBy: row.actor }); } catch { /* rejected below */ }
    ensure(receipt && !operations.has(receipt.operationId) && !admittedIds.has(receipt.nativeProfileId)
      && nativeIds.has(receipt.nativeProfileId) && hash(row.configuration_sha256) && hash(row.namespace_sha256), "receipt identity");
    const profile = profiles.get(row.native_profile_id)!;
    let canonical: string | undefined;
    try { canonical = canonicalNativeS3Namespace(JSON.parse(String(profile.namespace_identity))); } catch { /* rejected below */ }
    ensure(canonical !== undefined && canonical === profile.namespace_identity && !namespaces.has(canonical)
      && await sha256Hex(canonical) === row.namespace_sha256
      && profile.id === `storage-profile:aws-s3:${row.namespace_sha256}`
      && profile.configuration_source === "system" && profile.credential_reference === null
      && profile.configuration_revision === 1 && profile.state === "historical"
      && profile.created_at === row.created_at, "canonical namespace and immutable registration");
    const runtime = tables.storage_profile_runtime.filter(entry => entry.storage_profile_id === profile.id);
    ensure(runtime.length === 1 && runtime[0].state === "read_only" && runtime[0].registered_at === row.created_at
      && runtime[0].activated_at === null && runtime[0].retired_at === null, "metadata-only runtime");
    // Admission creates exactly one immutable profile and its read-only runtime.
    // Keep these histories in the full shadow validator: filtering them out
    // would change profile revisions captured by existing occurrence evidence.
    for (const [kind, expected] of [["storage_profiles", profile], ["storage_profile_runtime", runtime[0]]] as const) {
      const history = tables.file_shadow_dependency_versions.filter(entry => entry.dependency_kind === kind
        && entry.dependency_key === JSON.stringify([profile.id]));
      ensure(history.length === 1 && history[0].revision === 1 && history[0].present === 1, "immutable dependency history");
      let snapshot: ExportRow | undefined;
      try { snapshot = JSON.parse(String(history[0].snapshot_json)); } catch { /* rejected below */ }
      ensure(snapshot && (kind === "storage_profiles" ? snapshot.namespace_identity === expected.namespace_identity
        && snapshot.adapter_type === "s3" && snapshot.configuration_revision === 1 : snapshot.state === "read_only"), "metadata-only dependency state");
    }
    operations.add(receipt.operationId); admittedIds.add(receipt.nativeProfileId); namespaces.add(canonical);
  }
  // V20 admits no File location, accepted upload, default, shadow enablement or
  // execution operation using these profiles. This also checks exported views.
  for (const [name, rows] of Object.entries(tables)) {
    if (name === "storage_profile_runtime" || name === "storage_profile_admissions") continue;
    for (const row of rows) for (const column of ["storage_profile_id", "source_profile_id", "destination_profile_id"]) {
      ensure(!nativeIds.has(String(row[column])), `metadata-only profile referenced by ${name}`);
    }
  }
  return nativeIds;
}

export async function validateFileNativeAdmissionExport(tables: ExportTables, schemaObjects: ExportSchemaObject[], sourceRowids?: FileShadowSourceRowids) {
  ensure(await fileShadowSchemaFingerprint(schemaObjects) === FILE_NATIVE_ADMISSION_SCHEMA_FINGERPRINT_SHA256, "schema fingerprint");
  const metadataOnlyProfileIds = await validateNativeProfileAdmissions(tables);
  validateStorageRoleDefaults(tables);
  const acceptedPublicationLocations = validateFileRuntimeRows(tables);
  await validateFileShadowRows(tables, schemaObjects, sourceRowids, { acceptedPublicationLocations, metadataOnlyProfileIds });
  await validateFileShadowWithdrawalRows(tables, schemaObjects);
  await validateFileShadowAdjudicationRows(tables, schemaObjects, { allowActive: true,
    schemaSha256: FILE_NATIVE_ADMISSION_SCHEMA_FINGERPRINT_SHA256,
    historicalSchemaSha256s: [FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256, FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256] });
}
