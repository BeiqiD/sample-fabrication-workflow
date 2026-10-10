import type { ExportSchemaObject, FullExportManifestV24 } from "./export";
import { FULL_EXPORT_ARCHIVE_WRITER } from "./export";
import { createExportArtifact, EXPORT_SOURCE_SCHEMA_PATH, EXPORT_RETIRED_FIELDS_PATH } from "./export-protocol";
import { classifyExportCompatibilitySchema, exportCompatibilityColumns, projectCompatibilitySnapshot, restoreCompatibilityRows } from "./export-compatibility";
import { FILE_SHADOW_EXPORTED_VIEWS, FILE_SHADOW_EXPORT_VIEW_COLUMNS, FILE_SHADOW_REBUILDABLE_TABLE_NAMES, FILE_SHADOW_SOURCE_ROWIDS_PATH, validateFileShadowSourceRowids, fileShadowSchemaFingerprint } from "./export-file-shadow";
import { FILE_AUTHORITY_RUNTIME_LOCAL_TABLE_NAMES } from "./export-file-runtime";
import { FILE_JOBS_LOCAL_TABLE_NAMES } from "./export-file-jobs-schema";
import { RESEARCH_PACKAGE_LOCAL_TABLE_NAMES } from "./export-research-package-schema";
import { validateFileJobHistory } from "./export-file-jobs";
import { RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256, validateResearchPackageHistory } from "./export-research-packages";
import { FILE_MIGRATION_SCHEMA_FINGERPRINT_SHA256 } from "./export-file-migrations";
import { researchImportedPreviewEvidence, researchNativeR2AssetEvidence } from "./export-research-preview-provenance";
import { buildSystemRecoveryBlobExportPlan, validateSystemRecoveryEvidenceHistory, SYSTEM_RECOVERY_EVIDENCE_SCHEMA_FINGERPRINT_SHA256 } from "./export-system-recovery-evidence";
import { validateSystemRecoveryNativeRuntimeExportV26 } from "./export-file-system-recovery-runtime-v26";
import { validateLocalProfileMetadataV26 } from "./export-local-profiles-v26";
import { V26_BUSINESS_SCHEMA_FINGERPRINT_SHA256 } from "./portable-runtime-v26-recovery-catalog";
import { sqliteTableColumns } from "../domain/sqlite-table-columns";
import { stableJson } from "../domain/content-addressing";

export const FULL_EXPORT_ARCHIVE_SCHEMA_V26 = 26 as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V26 = "portable-runtime-local-volume" as const;
export interface FullExportBusinessManifestV26 extends Omit<FullExportManifestV24, "schemaVersion" | "archiveProfile"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V26; archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V26;
}
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error(`V26 full export rejected: ${reason}`); }
function object(value: unknown): value is Record<string, any> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
const sameKeys = (value: object, keys: readonly string[]) => Reflect.ownKeys(value).length === keys.length && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());

/** A genuine new profile over observed V26 DDL and unchanged business cells.
 * Local metadata is checked in its own namespace; unsupported local byte and
 * role/provider references fail closed. No V24 manifest is fabricated here. */
export async function validateFullExportBusinessV26(value: unknown): Promise<FullExportBusinessManifestV26> {
  ensure(object(value) && sameKeys(value, ["schemaVersion", "archiveProfile", "archiveWriter", "exportedAt", "tables", "blobs", "excludedOutputs", "relocatedSources", "backupHoldOwner", "artifacts"])
    && value.schemaVersion === 26 && value.archiveProfile === FULL_EXPORT_ARCHIVE_PROFILE_V26 && value.archiveWriter === FULL_EXPORT_ARCHIVE_WRITER, "version/envelope");
  ensure(typeof value.exportedAt === "string" && Number.isFinite(Date.parse(value.exportedAt)) && object(value.tables) && Array.isArray(value.blobs)
    && object(value.artifacts) && sameKeys(value.artifacts, ["sourceSchema", "retiredFields", "sourceRowids"]), "snapshot envelope");
  for (const [name, path] of [["sourceSchema", EXPORT_SOURCE_SCHEMA_PATH], ["retiredFields", EXPORT_RETIRED_FIELDS_PATH], ["sourceRowids", FILE_SHADOW_SOURCE_ROWIDS_PATH]]) {
    const artifact = value.artifacts[name];
    ensure(object(artifact) && sameKeys(artifact, ["path", "byteSize", "sha256", "value"]) && artifact.path === path
      && Number.isSafeInteger(artifact.byteSize) && artifact.byteSize >= 0 && typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/.test(artifact.sha256) && object(artifact.value), "provenance artifact");
    const expected = await createExportArtifact(path, artifact.value);
    ensure(expected.byteSize === artifact.byteSize && expected.sha256 === artifact.sha256, "artifact hash/size");
  }
  const schema = value.artifacts.sourceSchema.value;
  ensure(sameKeys(schema, ["version", "kind", "objects", "compatibilityColumns", "snapshotClock"])
    && schema.version === 1 && schema.kind === "observed-sqlite-schema" && Array.isArray(schema.objects) && object(schema.compatibilityColumns)
    && sameKeys(schema.compatibilityColumns, ["samples", "run_step_comments"])
    && Array.isArray(schema.compatibilityColumns.samples) && Array.isArray(schema.compatibilityColumns.run_step_comments)
    && typeof schema.snapshotClock === "string" && Number.isFinite(Date.parse(schema.snapshotClock)) && new Date(schema.snapshotClock).toISOString() === schema.snapshotClock
    && Date.parse(schema.snapshotClock) <= Date.parse(value.exportedAt), "observed schema/clock");
  const names = new Set<string>();
  for (const entry of schema.objects) {
    ensure(object(entry) && sameKeys(entry, ["type", "name", "tableName", "sql"]) && ["table", "view", "index", "trigger"].includes(entry.type)
      && typeof entry.name === "string" && entry.name.length > 0 && typeof entry.tableName === "string" && entry.tableName.length > 0
      && (typeof entry.sql === "string" || entry.type === "index" && entry.sql === null)
      && (!["table", "view"].includes(entry.type) || entry.name === entry.tableName) && !names.has(`${entry.type}:${entry.name}`), "schema object");
    names.add(`${entry.type}:${entry.name}`);
  }
  ensure(await fileShadowSchemaFingerprint(schema.objects) === V26_BUSINESS_SCHEMA_FINGERPRINT_SHA256, "V26 business schema");
  for (const name of ["samples", "run_step_comments"] as const) {
    const entry = schema.objects.find((entry: ExportSchemaObject) => entry.type === "table" && entry.name === name);
    ensure(entry && typeof entry.sql === "string" && stableJson(sqliteTableColumns(entry.sql, name)) === stableJson(schema.compatibilityColumns[name]), "compatibility schema columns");
  }
  const rebuildable = new Set<string>([...FILE_SHADOW_REBUILDABLE_TABLE_NAMES, ...FILE_AUTHORITY_RUNTIME_LOCAL_TABLE_NAMES, ...FILE_JOBS_LOCAL_TABLE_NAMES, ...RESEARCH_PACKAGE_LOCAL_TABLE_NAMES]);
  const inventory = schema.objects.filter((entry: ExportSchemaObject) => entry.type === "table" && !entry.name.startsWith("sqlite_") && !rebuildable.has(entry.name)).map((entry: ExportSchemaObject) => entry.name);
  for (const name of rebuildable) ensure(names.has(`table:${name}`) && !Object.hasOwn(value.tables, name), "rebuildable table inventory");
  ensure(names.has("view:blob_retention_edges"), "retention view"); inventory.push("blob_retention_edges");
  for (const name of FILE_SHADOW_EXPORTED_VIEWS) { ensure(names.has(`view:${name}`), "exported view inventory"); inventory.push(name); }
  ensure(stableJson(inventory.sort()) === stableJson(Object.keys(value.tables).sort()), "content table inventory");
  const logical = exportCompatibilityColumns("S2"), retentionColumns = ["store_kind", "provider", "object_key", "blob_record_id", "source_type", "source_id", "occurrence_type", "occurrence_id", "retention_reason", "retain_until"];
  for (const [name, rows] of Object.entries(value.tables)) {
    ensure(/^[a-z][a-z0-9_]*$/.test(name) && Array.isArray(rows), "table inventory");
    const entry = schema.objects.find((entry: ExportSchemaObject) => entry.type === "table" && entry.name === name);
    const columns = name === "samples" ? logical.samples : name === "run_step_comments" ? [...logical.run_step_comments, "file_id"]
      : name === "blob_retention_edges" ? retentionColumns : Object.hasOwn(FILE_SHADOW_EXPORT_VIEW_COLUMNS, name)
        ? FILE_SHADOW_EXPORT_VIEW_COLUMNS[name as keyof typeof FILE_SHADOW_EXPORT_VIEW_COLUMNS] : sqliteTableColumns(entry.sql, name);
    for (const row of rows) ensure(object(row) && [Object.prototype, null].includes(Object.getPrototypeOf(row)) && Reflect.ownKeys(row).length === Object.keys(row).length
      && Object.values(row).every(cell => cell === null || typeof cell === "string" || typeof cell === "number" && Number.isFinite(cell) && (!Number.isInteger(cell) || Number.isSafeInteger(cell)))
      && sameKeys(row, columns), "content row/cells");
  }
  const manifest = value as FullExportBusinessManifestV26;
  const compatibility = classifyExportCompatibilitySchema(manifest.artifacts.sourceSchema.value.compatibilityColumns, "file-authority-v14");
  ensure(compatibility === "S2", "complete physical registry");
  const physical = restoreCompatibilityRows(manifest.tables, manifest.artifacts.retiredFields.value, compatibility, "file-authority-v14");
  const replay = projectCompatibilitySnapshot(physical, manifest.artifacts.sourceSchema.value, "file-authority-v14");
  ensure(stableJson(replay.tables) === stableJson(manifest.tables) && stableJson(replay.retiredFields) === stableJson(manifest.artifacts.retiredFields.value), "logical/physical agreement");
  await validateFileShadowSourceRowids(manifest.tables, manifest.artifacts.sourceRowids.value);
  const localProfileIds = await validateLocalProfileMetadataV26(manifest.tables);
  const plan = buildSystemRecoveryBlobExportPlan(manifest.tables, schema.snapshotClock, manifest.backupHoldOwner);
  const normalized = (values: unknown[]) => values.map(value => { ensure(object(value) && Array.isArray(value.sourceOccurrences), "blob inventory"); return stableJson({ ...value, sourceOccurrences: value.sourceOccurrences.map(stableJson).sort() }); }).sort();
  ensure(stableJson(normalized(manifest.blobs)) === stableJson(normalized(plan.blobs)) && stableJson(manifest.excludedOutputs) === stableJson(plan.excludedOutputs)
    && stableJson(manifest.relocatedSources) === stableJson(plan.relocatedSources), "qualified byte plan");
  ensure(manifest.backupHoldOwner === null || typeof manifest.backupHoldOwner === "string" && manifest.backupHoldOwner.length >= 1 && manifest.backupHoldOwner.length <= 128 && !manifest.backupHoldOwner.includes("\0"), "hold owner");
  const packages = validateResearchPackageHistory(manifest.tables), migrations = validateFileJobHistory(manifest.tables), recovery = validateSystemRecoveryEvidenceHistory(manifest.tables);
  const imported = researchImportedPreviewEvidence(manifest.tables), aliases = researchNativeR2AssetEvidence(manifest.tables);
  await validateSystemRecoveryNativeRuntimeExportV26(manifest.tables, schema.objects, manifest.artifacts.sourceRowids.value, {
    schemaSha256: V26_BUSINESS_SCHEMA_FINGERPRINT_SHA256, publishedLocations: new Set([...migrations.publishedLocations, ...packages.publishedLocations, ...recovery.publishedLocations]),
    historicalResultLocation: (fileId, source, destination) => migrations.historicalResultLocation(fileId, source, destination) || recovery.historicalResultLocation(fileId, source, destination),
    importedPreviewEvidence: (table, row, column) => imported(table, row, column) || recovery.importedPreviewEvidence(table, row, column),
    packageR2AssetEvidence: asset => aliases(asset) || recovery.packageR2AssetEvidence(asset), recoveredAliasEvidence: recovery.recoveredAliasEvidence,
    historicalSchemaSha256s: [FILE_MIGRATION_SCHEMA_FINGERPRINT_SHA256, RESEARCH_PACKAGE_SCHEMA_FINGERPRINT_SHA256, SYSTEM_RECOVERY_EVIDENCE_SCHEMA_FINGERPRINT_SHA256],
  }, schema.snapshotClock, localProfileIds);
  return manifest;
}
