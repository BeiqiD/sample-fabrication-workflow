import type { ExportRow, ExportSchemaObject, ExportTables, FileShadowSourceRowids } from "./export";
import { validateNativeRuntimeProfiles, FILE_NATIVE_RUNTIME_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-native-runtime";
import { FILE_NATIVE_ADMISSION_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-native-admission";
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

function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error(`Full export rejected: invalid recovered File runtime ${reason}`); }
export interface SystemRecoveryRuntimeEvidence {
  schemaSha256: string; publishedLocations: ReadonlySet<string>;
  historicalResultLocation(fileId: unknown, source: unknown, destination: unknown): boolean;
  importedPreviewEvidence(table: string, row: ExportRow, column: string): boolean;
  packageR2AssetEvidence(asset: ExportRow): boolean;
  recoveredAliasEvidence(table: string, row: ExportRow): boolean;
  historicalSchemaSha256s: readonly string[];
}
/** Version 24 alone can recognize a legacy alias whose exact old address and
 * metadata remain recorded while a qualified recovery fills its File binding.
 * All V21–V23 asset validators retain their frozen strict legacy-null rule. */
function validateRecoveredAssetAliases(tables: ExportTables, nativeIds: ReadonlySet<string>, evidence: SystemRecoveryRuntimeEvidence) {
  const files = new Map(tables.files.map(row => [row.id, row]));
  for (const asset of tables.assets) {
    const columns = ["file_id", "storage_profile_id", "storage_profile_revision", "object_key"];
    if (asset.r2_key !== null) {
      ensure(columns.every(column => asset[column] === null) || evidence.recoveredAliasEvidence("assets", asset), "historical alias recovery proof");
      continue;
    }
    const file = files.get(asset.file_id);
    ensure(file && (nativeIds.has(String(asset.storage_profile_id)) || evidence.packageR2AssetEvidence(asset))
      && asset.storage_profile_revision === 1 && typeof asset.object_key === "string" && asset.object_key.length > 0 && !asset.object_key.includes("\0"), "neutral native asset identity");
    const location = tables.file_locations.find(row => row.file_id === asset.file_id && row.storage_profile_id === asset.storage_profile_id && row.object_key === asset.object_key);
    const publication = tables.file_location_publications.find(row => row.location_id === location?.id);
    ensure(location && asset.sha256 === file.expected_sha256 && asset.byte_size === file.expected_byte_size
      && (asset.status !== "ready" || publication && publication.verified_sha256 === asset.sha256 && publication.verified_byte_size === asset.byte_size), "native asset verified location");
  }
}
/** Additive V24 composition. Existing native validators, original admission and
 * activation histories remain unchanged; only qualified recovery alias proof
 * contributes additional publication and imported-unverified preview evidence. */
export async function validateSystemRecoveryNativeRuntimeExport(tables: ExportTables, schema: ExportSchemaObject[], rowids: FileShadowSourceRowids,
  evidence: SystemRecoveryRuntimeEvidence, snapshotClock: string) {
  ensure(await fileShadowSchemaFingerprint(schema) === evidence.schemaSha256, "schema fingerprint");
  validateFileNativeReferences(tables, schema);
  const nativeProfileIds = await validateNativeRuntimeProfiles(tables);
  validateNativeRolePolicies(tables);
  await validateImportAcceptanceV21(tables); await validateFileUploadAcceptanceV21(tables);
  await validateMetrologyReferenceAcceptanceV21(tables); await validateCommentAcceptanceV21(tables);
  const acceptedPublicationLocations = new Set(validateFileNativeRuntimeRows(tables, {
    ...evidence, recoveredAttachmentPreviewEvidence: evidence.importedPreviewEvidence,
  }));
  for (const location of evidence.publishedLocations) acceptedPublicationLocations.add(location);
  await validateFileNativeShadowRows(tables, schema, rowids, { acceptedPublicationLocations, nativeProfileIds });
  validateRecoveredAssetAliases(tables, nativeProfileIds, evidence);
  validateFileNativeRetention(tables, snapshotClock);
  await validateFileShadowWithdrawalRows(tables, schema);
  await validateFileShadowAdjudicationRows(tables, schema, { allowActive: true, schemaSha256: evidence.schemaSha256,
    historicalSchemaSha256s: [FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256, FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256,
      FILE_NATIVE_ADMISSION_SCHEMA_FINGERPRINT_SHA256, FILE_NATIVE_RUNTIME_SCHEMA_FINGERPRINT_SHA256, ...evidence.historicalSchemaSha256s] });
}
