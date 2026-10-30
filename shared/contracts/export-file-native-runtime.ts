import type { ExportRow, ExportSchemaObject, ExportTables, FileShadowSourceRowids } from "./export";
import { sha256Hex, stableJson } from "../domain/content-addressing";
import { canonicalNativeS3Namespace, checkedStorageProfileAdmissionReceipt } from "./storage-profile-admission";
import { STORAGE_PROFILE_ADMISSIONS_EXPORT_COLUMNS, FILE_NATIVE_ADMISSION_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-native-admission";
import { FILE_NATIVE_RUNTIME_TABLE_COLUMNS } from "./file-native-runtime";
import { FILE_SHADOW_DEPENDENCY_SPECS } from "./file-shadow-schema";
import { FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-runtime";
import { FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-role-policy";
import { fileShadowSchemaFingerprint } from "./export-file-shadow";
import { validateFileNativeShadowRows } from "./export-file-native-shadow";
import { validateFileNativeRuntimeRows } from "./export-file-native-candidates";
import { validateFileNativeReferences } from "./export-file-native-references";
import { validateNativeRolePolicies } from "./export-file-native-role-policy";
import { validateFileNativeRetention } from "./export-file-native-retention";
import { validateImportAcceptanceV21 } from "./export-import-acceptance-v21";
import { validateFileUploadAcceptanceV21 } from "./export-file-upload-acceptance-v21";
import { validateMetrologyReferenceAcceptanceV21 } from "./export-metrology-reference-acceptance-v21";
import { validateCommentAcceptanceV21 } from "./export-comment-acceptance-v21";
import { validateFileShadowWithdrawalRows } from "./export-file-shadow-withdrawals";
import { validateFileShadowAdjudicationRows } from "./export-file-shadow-adjudications";

/** Independent 0018/V21 content checkpoint. V7–V20 remain frozen. */
export const FILE_NATIVE_RUNTIME_SCHEMA_FINGERPRINT_SHA256 = "98b823f52ebdff24177878f5a66682667855584be1fa57873aee172a3300d967";
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid native File runtime ${reason}`);
}
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");
const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function snapshot(value: unknown) {
  try { return stableJson(JSON.parse(String(value))); } catch { ensure(false, "dependency snapshot JSON"); }
}

/** Registration stays original provenance. Later native activation histories
 * describe recorded decisions, never usable credentials in a recovered install. */
export async function validateNativeRuntimeProfiles(tables: ExportTables): Promise<ReadonlySet<string>> {
  const profiles = new Map(tables.storage_profiles.map(row => [row.id, row]));
  const native = tables.storage_profiles.filter(row => row.adapter_type === "s3");
  const nativeIds = new Set(native.map(row => String(row.id)));
  ensure(nativeIds.size === native.length && tables.storage_profile_admissions.length === native.length, "complete admitted inventory");
  const operations = new Set<unknown>(), admitted = new Set<unknown>(), namespaces = new Set<string>();
  for (const row of tables.storage_profile_admissions) {
    ensure(stableJson(Object.keys(row).sort()) === stableJson([...STORAGE_PROFILE_ADMISSIONS_EXPORT_COLUMNS.storage_profile_admissions].sort()), "admission columns");
    try { checkedStorageProfileAdmissionReceipt({ operationId: row.operation_id, profileId: row.candidate_profile_id,
      revision: row.candidate_revision, envelopeRevision: row.envelope_revision, checkId: row.check_id,
      nativeProfileId: row.native_profile_id, configurationRevision: 1, runtimeAccess: "read_only", createdAt: row.created_at, createdBy: row.actor }); }
    catch { ensure(false, "original admission receipt"); }
    const profile = profiles.get(row.native_profile_id);
    ensure(profile && nativeIds.has(String(profile.id)) && !admitted.has(profile.id) && !operations.has(row.operation_id)
      && hash(row.configuration_sha256) && hash(row.namespace_sha256), "admission identity");
    let namespace: string;
    try { namespace = canonicalNativeS3Namespace(JSON.parse(String(profile.namespace_identity))); } catch { ensure(false, "canonical native namespace"); }
    ensure(namespace === profile.namespace_identity && !namespaces.has(namespace) && await sha256Hex(namespace) === row.namespace_sha256
      && profile.id === `storage-profile:aws-s3:${row.namespace_sha256}` && profile.configuration_revision === 1
      && profile.configuration_source === "system" && profile.credential_reference === null && profile.state === "historical"
      && profile.created_at === row.created_at, "immutable native physical identity");
    const profileHistory = tables.file_shadow_dependency_versions.filter(entry => entry.dependency_kind === "storage_profiles"
      && entry.dependency_key === stableJson([profile.id]));
    ensure(profileHistory.length === 1 && profileHistory[0].revision === 1 && profileHistory[0].present === 1
      && snapshot(profileHistory[0].snapshot_json) === stableJson(Object.fromEntries(FILE_SHADOW_DEPENDENCY_SPECS.storage_profiles.snapshotColumns
        .map(column => [column, profile[column]]))), "immutable admitted profile history");
    const runtime = tables.storage_profile_runtime.filter(entry => entry.storage_profile_id === profile.id);
    ensure(runtime.length === 1 && runtime[0].registered_at === row.created_at, "native runtime inventory");
    const original = tables.file_shadow_dependency_versions.filter(entry => entry.dependency_kind === "storage_profile_runtime"
      && entry.dependency_key === stableJson([profile.id]) && entry.revision === 1);
    let originalSnapshot: ExportRow;
    try { originalSnapshot = JSON.parse(String(original[0]?.snapshot_json)); } catch { ensure(false, "original runtime snapshot"); }
    ensure(original.length === 1 && original[0].present === 1 && originalSnapshot.storage_profile_id === profile.id
      && originalSnapshot.state === "read_only" && originalSnapshot.registered_at === row.created_at
      && originalSnapshot.activated_at === null && originalSnapshot.retired_at === null, "retained read-only registration");
    const history = tables.storage_profile_activations.filter(entry => entry.storage_profile_id === profile.id)
      .sort((a, b) => Number(a.binding_revision) - Number(b.binding_revision) || (a.action === b.action ? 0 : a.action === "activate" ? -1 : 1));
    let binding = 0, previous: ExportRow | undefined;
    const runtimeVersions = tables.file_shadow_dependency_versions.filter(entry => entry.dependency_kind === "storage_profile_runtime"
      && entry.dependency_key === stableJson([profile.id])).sort((a, b) => Number(a.revision) - Number(b.revision));
    const expectedRuntimeVersions = [snapshot(original[0].snapshot_json)];
    let lastActivation: ExportRow | undefined;
    for (const entry of history) {
      ensure(stableJson(Object.keys(entry).sort()) === stableJson([...FILE_NATIVE_RUNTIME_TABLE_COLUMNS.storage_profile_activations].sort())
        && text(entry.operation_id) && !operations.has(entry.operation_id) && entry.configuration_revision === 1
        && ["activate", "retire"].includes(String(entry.action)) && text(entry.candidate_profile_id) && positive(entry.candidate_revision)
        && positive(entry.envelope_revision) && text(entry.check_id) && hash(entry.configuration_sha256)
        && entry.namespace_sha256 === row.namespace_sha256 && positive(entry.binding_revision) && text(entry.actor)
        && time(entry.created_at) && Date.parse(entry.created_at) >= Date.parse(String(row.created_at)), "activation audit identity");
      if (previous) ensure(Date.parse(entry.created_at) >= Date.parse(String(previous.created_at)), "activation history clock");
      if (entry.action === "activate") { ensure(entry.binding_revision === binding + 1, "activation binding sequence"); binding += 1; lastActivation = entry; }
      else ensure(previous?.action === "activate" && entry.binding_revision === binding
        && ["candidate_profile_id", "candidate_revision", "envelope_revision", "check_id", "configuration_sha256", "namespace_sha256"]
          .every(column => entry[column] === previous![column]), "retirement retains exact binding");
      const expectedSnapshot = stableJson({ storage_profile_id: profile.id,
        state: entry.action === "activate" ? "read_write" : "retired", registered_at: row.created_at,
        activated_at: lastActivation!.created_at, retired_at: entry.action === "retire" ? entry.created_at : null });
      // A credential binding can rotate twice within the same millisecond.
      // Dependency triggers record changed runtime cells, while the immutable
      // activation audit still records both distinct binding revisions.
      if (expectedRuntimeVersions.at(-1) !== expectedSnapshot) expectedRuntimeVersions.push(expectedSnapshot);
      operations.add(entry.operation_id); previous = entry;
    }
    ensure(runtimeVersions.length === expectedRuntimeVersions.length && runtimeVersions.every((version, index) =>
      version.present === 1 && snapshot(version.snapshot_json) === expectedRuntimeVersions[index]), "complete audit/runtime history agreement");
    ensure(previous ? runtime[0].state === (previous.action === "activate" ? "read_write" : "retired")
      && runtime[0].activated_at === history.filter(entry => entry.action === "activate").at(-1)?.created_at
      && runtime[0].retired_at === (previous.action === "retire" ? previous.created_at : null)
      : runtime[0].state === "read_only" && runtime[0].activated_at === null && runtime[0].retired_at === null, "current recorded native runtime");
    admitted.add(profile.id); operations.add(row.operation_id); namespaces.add(namespace);
  }
  ensure(tables.storage_profile_activations.every(row => nativeIds.has(String(row.storage_profile_id))), "native activation owner");
  ensure(tables.legacy_file_mappings.every(row => !tables.file_locations.some(location => location.id === row.location_id
    && nativeIds.has(String(location.storage_profile_id)))), "native addresses have no fabricated legacy mappings");
  return nativeIds;
}

function validateNativeAssetAliases(tables: ExportTables, nativeIds: ReadonlySet<string>, packageR2AssetEvidence?: (asset: ExportRow) => boolean) {
  const files = new Map(tables.files.map(row => [row.id, row]));
  for (const asset of tables.assets) {
    const columns = ["file_id", "storage_profile_id", "storage_profile_revision", "object_key"];
    if (asset.r2_key !== null) { ensure(columns.every(column => asset[column] === null), "historical asset remains a legacy locator"); continue; }
    const file = files.get(asset.file_id);
    ensure(file && (nativeIds.has(String(asset.storage_profile_id)) || packageR2AssetEvidence?.(asset))
      && asset.storage_profile_revision === 1 && text(asset.object_key), "neutral native asset identity");
    const location = tables.file_locations.find(row => row.file_id === asset.file_id && row.storage_profile_id === asset.storage_profile_id && row.object_key === asset.object_key);
    const publication = tables.file_location_publications.find(row => row.location_id === location?.id);
    ensure(location && asset.sha256 === file.expected_sha256 && asset.byte_size === file.expected_byte_size
      && (asset.status !== "ready" || publication && publication.verified_sha256 === asset.sha256
        && publication.verified_byte_size === asset.byte_size), "native asset verified location");
  }
}

export async function validateFileNativeRuntimeExport(tables: ExportTables, schemaObjects: ExportSchemaObject[], sourceRowids?: FileShadowSourceRowids,
  successor?: { schemaSha256: string; publishedLocations: ReadonlySet<string>;
    historicalResultLocation: (fileId: unknown, source: unknown, destination: unknown) => boolean;
    importedPreviewEvidence?: (table: string, row: ExportRow, column: string) => boolean;
    packageR2AssetEvidence?: (asset: ExportRow) => boolean;
    historicalSchemaSha256s?: readonly string[] }, snapshotClock = new Date().toISOString()) {
  const schemaSha256 = successor?.schemaSha256 ?? FILE_NATIVE_RUNTIME_SCHEMA_FINGERPRINT_SHA256;
  ensure(await fileShadowSchemaFingerprint(schemaObjects) === schemaSha256, "schema fingerprint");
  validateFileNativeReferences(tables, schemaObjects);
  const nativeProfileIds = await validateNativeRuntimeProfiles(tables);
  validateNativeRolePolicies(tables);
  await validateImportAcceptanceV21(tables);
  await validateFileUploadAcceptanceV21(tables);
  await validateMetrologyReferenceAcceptanceV21(tables);
  await validateCommentAcceptanceV21(tables);
  const acceptedPublicationLocations = new Set(validateFileNativeRuntimeRows(tables, successor));
  for (const location of successor?.publishedLocations ?? []) acceptedPublicationLocations.add(location);
  await validateFileNativeShadowRows(tables, schemaObjects, sourceRowids, { acceptedPublicationLocations, nativeProfileIds });
  validateNativeAssetAliases(tables, nativeProfileIds, successor?.packageR2AssetEvidence);
  validateFileNativeRetention(tables, snapshotClock);
  await validateFileShadowWithdrawalRows(tables, schemaObjects);
  await validateFileShadowAdjudicationRows(tables, schemaObjects, { allowActive: true,
    schemaSha256,
    historicalSchemaSha256s: [FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256, FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256,
      FILE_NATIVE_ADMISSION_SCHEMA_FINGERPRINT_SHA256, ...(successor ? [FILE_NATIVE_RUNTIME_SCHEMA_FINGERPRINT_SHA256] : []),
      ...(successor?.historicalSchemaSha256s ?? [])] });
}
