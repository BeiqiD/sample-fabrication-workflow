import type { ExportRow, ExportSchemaObject, ExportTables, FileShadowSourceRowids } from "./export";
import { stableJson } from "../domain/content-addressing";
import { fileShadowSchemaFingerprint, validateFileShadowSourceRowids } from "./export-file-shadow";
import { V26_BUSINESS_SCHEMA_FINGERPRINT_SHA256 } from "./portable-runtime-v26-recovery-catalog";
import { validateLocalProfileMetadataV28, validateLocalProfileHistoryV28 } from "./export-local-profiles-v28";
import { validateNativeRuntimeProfiles, FILE_NATIVE_RUNTIME_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-native-runtime";
import { validateFileNativeRuntimeRowsV28 } from "./export-file-native-candidates-v28";
import { validateNativeRolePoliciesV28 } from "./export-file-native-role-policy-v28";
import { validateFileUploadAcceptanceV28 } from "./export-file-upload-acceptance-v28";
import { validateFileNativeReferences } from "./export-file-native-references";
import { validateFileNativeShadowRowsV26 } from "./export-file-native-shadow-v26";
import { validateFileNativeRetention } from "./export-file-native-retention";
import { validateImportAcceptanceV21 } from "./export-import-acceptance-v21";
import { validateMetrologyReferenceAcceptanceV21 } from "./export-metrology-reference-acceptance-v21";
import { validateCommentAcceptanceV21 } from "./export-comment-acceptance-v21";
import { nativeV5CommentSourceHistory, validateNativeV5CompletedCommentProvenance,
  nativeV5CommentLocationRow } from "./export-native-v5-comment-provenance";
import { validateFileShadowWithdrawalRows } from "./export-file-shadow-withdrawals";
import { validateFileShadowAdjudicationRows } from "./export-file-shadow-adjudications";
import { validateFileJobHistory } from "./export-file-jobs";
import { validateResearchPackageHistory, RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256 } from "./export-research-packages";
import { SYSTEM_RECOVERY_EVIDENCE_SCHEMA_FINGERPRINT_SHA256 } from "./export-system-recovery-evidence";
import { validateSystemRecoveryEvidenceHistoryV28 } from "./export-system-recovery-evidence-v28";
import { researchImportedPreviewEvidence, researchNativeR2AssetEvidence } from "./export-research-preview-provenance";
import { FILE_MIGRATION_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-migrations";
import { FILE_NATIVE_ADMISSION_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-native-admission";
import { FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-runtime";
import { FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-role-policy";
import type { SystemRecoveryRuntimeEvidence } from "./export-file-system-recovery-runtime-v26";

/** Decoded from the SAME validated V5 typed image/source batch. Checks,
 * admissions, paths and bindings are intentionally not part of this input. */
export interface ProtectedLocalHistoryV28 {
  local_storage_profile_registrations: ExportRow[];
  local_storage_profile_activations: ExportRow[];
}
export interface LocalFileRuntimeEvidenceV28 {
  readonly kind: "local-file-runtime-evidence/v28";
  readonly localProfileCount: number;
  readonly localLocationCount: number;
}
export interface LocalFileRuntimeInputV28 {
  businessTables: ExportTables;
  sourceSchema: readonly ExportSchemaObject[];
  sourceRowids: FileShadowSourceRowids;
  snapshotClock: string;
  protectedLocalHistory: ProtectedLocalHistoryV28;
}
interface Snapshot {
  readonly tables: ExportTables;
  readonly localProfileIds: readonly string[];
  readonly snapshotClock: string;
}
const snapshots = new WeakMap<LocalFileRuntimeEvidenceV28, Snapshot>();
const HISTORY_COLUMNS = {
  local_storage_profile_registrations: ["storage_profile_id", "operation_id", "namespace_sha256", "actor", "created_at"],
  local_storage_profile_activations: ["operation_id", "storage_profile_id", "configuration_revision", "action",
    "admission_operation_id", "binding_revision", "namespace_sha256", "actor", "created_at"],
} as const;
const MAX_ROWS = 16_384, MAX_JSON_BYTES = 4 * 1024 * 1024;
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`V28 local File source rejected: ${reason}`);
}

/** Capture only bounded JSON data, not getters, mutable caller rows or an
 * archive callback. This semantic proof is inert and grants no provider I/O. */
function captureJson(value: unknown): unknown {
  let nodes = 0, characters = 0;
  const copy = (item: unknown, depth: number): unknown => {
    ensure(depth <= 16 && ++nodes <= 200_000, "JSON bounds");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") {
      ensure(Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item)), "JSON number");
      return item;
    }
    if (typeof item === "string") { characters += item.length; ensure(characters <= MAX_JSON_BYTES, "JSON text budget"); return item; }
    ensure(item && typeof item === "object" && [Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(item)), "JSON object");
    if (Array.isArray(item)) {
      ensure(item.length <= MAX_ROWS && Reflect.ownKeys(item).length === item.length + 1, "JSON array");
      const values = Array.from({ length: item.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        ensure(descriptor && "value" in descriptor, "JSON array cell"); return copy(descriptor.value, depth + 1);
      });
      return Object.freeze(values);
    }
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(item)) {
      ensure(typeof key === "string", "JSON key");
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      ensure(descriptor && descriptor.enumerable && "value" in descriptor, "JSON field");
      output[key] = copy(descriptor.value, depth + 1);
    }
    return Object.freeze(output);
  };
  const result = copy(value, 0);
  ensure(new TextEncoder().encode(stableJson(result)).byteLength <= MAX_JSON_BYTES, "JSON byte budget");
  return result;
}

/** Internal read of an issued immutable semantic snapshot. A deserialized or
 * copied result cannot substitute for complete validation. This is still
 * source metadata, never installation/session/role/provider authority. */
export function localFileRuntimeSnapshotV28(evidence: LocalFileRuntimeEvidenceV28): Snapshot {
  const value = snapshots.get(evidence); ensure(value, "unissued source evidence"); return value;
}

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

/** V28's application envelope and V5 image must already have their independent
 * code-owned schema/checkpoint/typed-row checks. The observed BUSINESS DDL is
 * unchanged from the frozen V26 business slice; we prove that exact hash here
 * rather than retagging a V26 content proof. All new local semantics live in
 * dedicated successor modules. No historical reader or fingerprint is edited.
 *
 * This first slice admits only ordinary accepted local-upload provenance.
 * Native V5 additionally admits only exact completed unpaired local Comment
 * attachment provenance from the same validated typed source image.
 * Local recovery relocation is admitted only by the separate V28 exact native
 * source-address/readback/history proof. Other local import/Comment-purpose/metrology/
 * shadow/job publication payloads remain unsupported. Source records do not authorize destination execution. */
export async function validateLocalFileRuntimeV28(input: LocalFileRuntimeInputV28): Promise<LocalFileRuntimeEvidenceV28> {
  const nativeCommentSource = nativeV5CommentSourceHistory(input);
  const captured = captureJson(input) as LocalFileRuntimeInputV28;
  ensure(captured && stableJson(Object.keys(captured).sort()) === stableJson([
    "businessTables", "sourceSchema", "sourceRowids", "snapshotClock", "protectedLocalHistory"].sort()), "input inventory");
  const tables = captured.businessTables, schema = [...captured.sourceSchema], clock = captured.snapshotClock;
  ensure(typeof clock === "string" && Number.isFinite(Date.parse(clock)) && new Date(clock).toISOString() === clock, "snapshot clock");
  ensure(await fileShadowSchemaFingerprint(schema) === V26_BUSINESS_SCHEMA_FINGERPRINT_SHA256, "observed business schema");
  let totalRows = 0;
  for (const rows of Object.values(tables)) {
    ensure(Array.isArray(rows), "table rows"); totalRows += rows.length;
    for (const row of rows) ensure(row && !Array.isArray(row) && Object.values(row).every(cell =>
      cell === null || typeof cell === "string" || typeof cell === "number"), "typed source cells");
  }
  ensure(totalRows <= MAX_ROWS, "row budget");
  const history = captured.protectedLocalHistory;
  ensure(history && stableJson(Object.keys(history).sort()) === stableJson(Object.keys(HISTORY_COLUMNS).sort()), "protected history inventory");
  for (const [name, columns] of Object.entries(HISTORY_COLUMNS)) {
    const rows = history[name as keyof ProtectedLocalHistoryV28];
    ensure(Array.isArray(rows), "protected history rows");
    totalRows += rows.length;
    for (const row of rows) ensure(stableJson(Object.keys(row).sort()) === stableJson([...columns].sort()), "protected history columns");
  }
  ensure(totalRows <= MAX_ROWS, "combined source/history row budget");
  const nativeComment = await validateNativeV5CompletedCommentProvenance(nativeCommentSource, tables, history, clock, captured.sourceRowids);
  const localProfileIds = await validateLocalProfileMetadataV28(tables, nativeComment);
  await validateLocalProfileHistoryV28({ ...tables, ...history }, nativeComment);
  for (const location of tables.file_locations.filter(row => localProfileIds.has(String(row.storage_profile_id)))) {
    ensure(!tables.legacy_file_mappings.some(row => row.location_id === location.id), "local address has no legacy mapping");
    ensure(tables.file_acceptance_candidates.some(row => row.storage_profile_id === location.storage_profile_id
      && row.acceptance_kind === "r2_upload" && (row.candidate_location_id === location.id || row.result_location_id === location.id))
      || nativeV5CommentLocationRow(nativeComment, location),
    "qualified local location provenance");
  }
  await validateFileShadowSourceRowids(tables, captured.sourceRowids);
  validateFileNativeReferences(tables, schema);
  const nativeIds = new Set([...await validateNativeRuntimeProfiles(tables), ...localProfileIds]);
  validateNativeRolePoliciesV28(tables, localProfileIds, history.local_storage_profile_activations);
  await validateImportAcceptanceV21(tables); await validateFileUploadAcceptanceV28(tables, localProfileIds);
  await validateMetrologyReferenceAcceptanceV21(tables);
  if (!nativeComment) await validateCommentAcceptanceV21(tables);
  const packages = validateResearchPackageHistory(tables), migrations = validateFileJobHistory(tables), recovery = validateSystemRecoveryEvidenceHistoryV28(tables);
  const imported = researchImportedPreviewEvidence(tables), aliases = researchNativeR2AssetEvidence(tables);
  const evidence = {
    historicalResultLocation: (fileId: unknown, source: unknown, destination: unknown) => migrations.historicalResultLocation(fileId, source, destination)
      || recovery.historicalResultLocation(fileId, source, destination),
    importedPreviewEvidence: (table: string, row: ExportRow, column: string) => imported(table, row, column) || recovery.importedPreviewEvidence(table, row, column),
  };
  const published = new Set(validateFileNativeRuntimeRowsV28(tables, {
    ...evidence, recoveredAttachmentPreviewEvidence: evidence.importedPreviewEvidence,
  }, localProfileIds, nativeComment));
  for (const id of [...packages.publishedLocations, ...migrations.publishedLocations, ...recovery.publishedLocations]) published.add(id);
  await validateFileNativeShadowRowsV26(tables, schema, captured.sourceRowids, { acceptedPublicationLocations: published,
    nativeProfileIds: nativeIds, localProfileIds });
  validateRecoveredAssetAliases(tables, nativeIds, { ...evidence,
    schemaSha256: V26_BUSINESS_SCHEMA_FINGERPRINT_SHA256, publishedLocations: published,
    packageR2AssetEvidence: asset => aliases(asset) || recovery.packageR2AssetEvidence(asset),
    recoveredAliasEvidence: recovery.recoveredAliasEvidence, historicalSchemaSha256s: [] });
  validateFileNativeRetention(tables, clock);
  await validateFileShadowWithdrawalRows(tables, schema);
  await validateFileShadowAdjudicationRows(tables, schema, { allowActive: true, schemaSha256: V26_BUSINESS_SCHEMA_FINGERPRINT_SHA256,
    historicalSchemaSha256s: [FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256, FILE_R2_ROLE_DEFAULTS_SCHEMA_FINGERPRINT_SHA256,
      FILE_NATIVE_ADMISSION_SCHEMA_FINGERPRINT_SHA256, FILE_NATIVE_RUNTIME_SCHEMA_FINGERPRINT_SHA256,
      FILE_MIGRATION_SCHEMA_FINGERPRINT_SHA256, RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256, SYSTEM_RECOVERY_EVIDENCE_SCHEMA_FINGERPRINT_SHA256] });
  const proof = Object.freeze({ kind: "local-file-runtime-evidence/v28" as const, localProfileCount: localProfileIds.size,
    localLocationCount: tables.file_locations.filter(row => localProfileIds.has(String(row.storage_profile_id))).length });
  snapshots.set(proof, Object.freeze({ tables, localProfileIds: Object.freeze([...localProfileIds]), snapshotClock: clock }));
  return proof;
}
