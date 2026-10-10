import type { ExportRow, FullExportBlobEntryV21, FullExportManifestV24 } from "./export";
import { validateFullExportV24, EXPORT_RETIRED_FIELDS_PATH, EXPORT_SOURCE_SCHEMA_PATH } from "./export-protocol";
import { FILE_SHADOW_SOURCE_ROWIDS_PATH } from "./export-file-shadow";
import { RECOVERY_MIGRATIONS } from "./system-recovery-catalog";
import type { FilePurpose } from "./files";
import { stableJson, sha256Hex } from "../domain/content-addressing";
import { validateSystemRecoveryImage, type RecoveryTableSpec, type SystemRecoveryImageV1 } from "./system-recovery-image";
import { classifyExportCompatibilitySchema, projectCompatibilitySnapshot, restoreCompatibilityRows } from "./export-compatibility";
import { isFileShadowRowidColumn } from "./file-shadow-rowid";

export const SYSTEM_BACKUP_SCHEMA = "system-backup/1" as const;
export const SYSTEM_BACKUP_RECORDS_SCHEMA = "system-backup-records/1" as const;
export const SYSTEM_BACKUP_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const SYSTEM_BACKUP_MAX_PAYLOAD_BYTES = 96 * 1024 * 1024;
export const SYSTEM_BACKUP_MAX_METADATA_BYTES = 4 * 1024 * 1024;
export const SYSTEM_BACKUP_MAX_RECORDS_BYTES = 3 * 1024 * 1024;
export const SYSTEM_BACKUP_MAX_FILES = 100;
export const SYSTEM_BACKUP_OUTCOMES = ["packaged", "missing", "provider_unavailable", "metadata_unavailable", "download_failed", "size_mismatch", "hash_mismatch"] as const;
export type SystemBackupOutcome = typeof SYSTEM_BACKUP_OUTCOMES[number];
const PURPOSES = ["research_source", "embedded_content", "derived_preview", "provenance", "job_output"] as const;

export interface SystemBackupBinding {
  consumerKind: string; consumerId: string; consumerSubId: string; fileSlot: string;
  fileId: string | null; purpose: FilePurpose | null;
}
/** Physical source identity is frozen independently of the archive member and
 * independently of each logical File occurrence sharing those source bytes. */
export interface SystemBackupSource {
  id: string; source: FullExportBlobEntryV21; fileIds: string[]; purposes: FilePurpose[]; bindings: SystemBackupBinding[];
}
export interface SystemBackupFile extends SystemBackupSource {
  path: string | null; outcome: SystemBackupOutcome; byteSize: number | null; sha256: string | null;
}
export interface ProtectedConfigurationPolicy {
  policy: "encrypted-configuration-quarantine/1"; tableNames: string[]; keyIds: string[];
  status: "included_encrypted" | "excluded_legacy_content";
  rootKeysIncluded: false; automaticExecution: false;
}
export interface SystemBackupOrigin {
  format: "native" | "legacy-converted"; schemaVersion: number; archiveSha256: string | null;
  legacyArtifacts: Record<string, unknown> | null; migrationEvidence: Array<{ name: string; sha256: string }>;
}
/** Observed platform migration receipts remain inert provenance. They are
 * distinct from the reviewed code-owned chain used to initialize a target. */
export interface SystemBackupMigrationLedger {
  status: "unavailable" | "observed";
  entries: Array<{ id: string; name: string; appliedAt: string | null; rawSha256: string | null }>;
}
export interface SystemBackupRecordsV1 {
  schema: typeof SYSTEM_BACKUP_RECORDS_SCHEMA; backupId: string; createdAt: string;
  content: FullExportManifestV24; image: SystemRecoveryImageV1; protectedConfiguration: ProtectedConfigurationPolicy; origin: SystemBackupOrigin;
  sourceMigrationLedger: SystemBackupMigrationLedger;
}
export interface SystemBackupManifestV1 {
  schema: typeof SYSTEM_BACKUP_SCHEMA; kind: "system_backup"; backupId: string; sourceInstallationId: string;
  createdAt: string; sourceSnapshotClock: string; sourceCheckpoint: string; contentSchemaVersion: 24; recordsSha256: string;
  completeness: "complete" | "partial"; files: SystemBackupFile[];
  counts: { tables: number; rows: number; sources: number; packagedFiles: number; unavailableFiles: number; bytes: number };
  protectedConfiguration: ProtectedConfigurationPolicy;
  relocatedSources: FullExportManifestV24["relocatedSources"];
  report: { htmlPath: "report/index.html"; markdownPath: "report/report.md" };
}
export class SystemBackupValidationError extends Error {
  constructor(readonly code: string) { super(`Invalid system backup: ${code}`); this.name = "SystemBackupValidationError"; }
}
function ensure(value: unknown, code: string): asserts value { if (!value) throw new SystemBackupValidationError(code); }
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value), "object");
  const row = value as Record<string, unknown>;
  if (keys) ensure(stableJson(Object.keys(row).sort()) === stableJson([...keys].sort()), "fields");
  return row;
}
function text(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0")
    && new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) === value;
}
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const size = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function purpose(value: unknown): FilePurpose | null { return PURPOSES.includes(value as FilePurpose) ? value as FilePurpose : null; }
function sortedUnique<T extends string>(values: Iterable<T>): T[] { return [...new Set(values)].sort(); }
function sourceMatches(row: ExportRow, source: FullExportBlobEntryV21, ids: Set<string>) {
  return row.file_id !== null && ids.has(String(row.file_id))
    || source.storeKind === "r2" && row.legacy_r2_object_key === source.objectKey
    || source.storeKind === "managed" && row.legacy_managed_provider === source.provider && row.legacy_managed_object_key === source.objectKey;
}

export function planSystemBackupSources(content: FullExportManifestV24): SystemBackupSource[] {
  ensure(content.blobs.length <= SYSTEM_BACKUP_MAX_FILES, "file_budget");
  const tables = content.tables, files = new Map((tables.files ?? []).map(row => [String(row.id), row]));
  return content.blobs.map((source, index) => {
    const ids = new Set<string>();
    if (source.locationId !== null) for (const row of tables.file_locations ?? []) if (row.id === source.locationId) ids.add(String(row.file_id));
    for (const row of tables.legacy_file_mappings ?? []) if (row.store_kind === source.storeKind && row.provider === source.provider && row.object_key === source.objectKey) ids.add(String(row.file_id));
    if (source.storeKind === "r2") for (const row of tables.assets ?? []) if (row.r2_key === source.objectKey && typeof row.file_id === "string") ids.add(row.file_id);
    if (source.storeKind === "managed") for (const row of tables.managed_storage_objects ?? []) if (row.provider === source.provider && row.object_key === source.objectKey && typeof row.file_id === "string") ids.add(row.file_id);
    const bindings = (tables.file_consumer_projection ?? []).filter(row => sourceMatches(row, source, ids)).map(row => ({
      consumerKind: String(row.consumer_kind), consumerId: String(row.consumer_id), consumerSubId: String(row.consumer_sub_id), fileSlot: String(row.file_slot),
      fileId: typeof row.file_id === "string" ? row.file_id : null, purpose: purpose(row.expected_purpose),
    })).sort((a, b) => stableJson(a) < stableJson(b) ? -1 : stableJson(a) > stableJson(b) ? 1 : 0);
    const purposes = sortedUnique([...ids].flatMap(id => { const value = purpose(files.get(id)?.purpose); return value ? [value] : []; })
      .concat(bindings.flatMap(binding => binding.purpose ? [binding.purpose] : [])));
    return { id: `b_${String(index).padStart(4, "0")}`, source, fileIds: sortedUnique(ids), purposes, bindings };
  });
}

/** The archive contains encrypted envelope history only. Key material and
 * execution privileges are supplied independently by the destination. */
export function systemBackupProtectedConfiguration(image: SystemRecoveryImageV1, status: ProtectedConfigurationPolicy["status"] = "included_encrypted"): ProtectedConfigurationPolicy {
  const tableNames = Object.keys(image.tables).filter(name => name.startsWith("system_storage_")).sort();
  const keys = new Set<string>();
  for (const name of tableNames) {
    const table = image.tables[name];
    for (const column of ["key_id", "previous_key_id"]) {
      const index = table.columns.indexOf(column); if (index < 0) continue;
      for (const row of table.rows) if (row.cells[index].type === "text") keys.add(row.cells[index].value);
    }
  }
  if (status === "excluded_legacy_content") ensure(tableNames.every(name => image.tables[name].rows.length === 0), "legacy_configuration_not_empty");
  return { policy: "encrypted-configuration-quarantine/1", status, tableNames, keyIds: [...keys].sort(), rootKeysIncluded: false, automaticExecution: false };
}

function checkedFile(source: SystemBackupSource, value: unknown): SystemBackupFile {
  const row = object(value, ["id", "source", "fileIds", "purposes", "bindings", "path", "outcome", "byteSize", "sha256"]);
  ensure(stableJson({ id: row.id, source: row.source, fileIds: row.fileIds, purposes: row.purposes, bindings: row.bindings }) === stableJson(source), "source_inventory");
  ensure(SYSTEM_BACKUP_OUTCOMES.includes(row.outcome as SystemBackupOutcome), "file_outcome");
  if (row.outcome === "packaged") {
    ensure(row.path === `files/${source.id}` && size(row.byteSize) && row.byteSize <= SYSTEM_BACKUP_MAX_PAYLOAD_BYTES && hash(row.sha256), "packaged_file");
    ensure(source.source.initialOutcome === null, "unavailable_source_packaged");
    ensure(source.source.expectedByteSize === null || source.source.expectedByteSize === row.byteSize, "promised_size");
    ensure(source.source.expectedSha256 === null || source.source.expectedSha256.toLowerCase() === row.sha256, "promised_hash");
  } else ensure(row.path === null && row.byteSize === null && row.sha256 === null, "unavailable_payload");
  return row as unknown as SystemBackupFile;
}

export async function finishSystemBackupManifest(records: SystemBackupRecordsV1, values: readonly SystemBackupFile[]): Promise<SystemBackupManifestV1> {
  ensure(text(records.backupId, 128) && text(records.createdAt, 200) && Number.isFinite(Date.parse(records.createdAt)), "identity");
  const sources = planSystemBackupSources(records.content);
  ensure(values.length === sources.length, "file_inventory");
  const files = sources.map((source, index) => checkedFile(source, values[index]));
  const bytes = files.reduce((total, file) => total + (file.byteSize ?? 0), 0);
  ensure(bytes <= SYSTEM_BACKUP_MAX_PAYLOAD_BYTES, "payload_budget");
  const recordsText = stableJson(records); ensure(new TextEncoder().encode(recordsText).byteLength <= SYSTEM_BACKUP_MAX_RECORDS_BYTES, "records_budget");
  const identity = records.content.tables.research_package_source_identity[0];
  ensure(identity && text(identity.installation_id), "installation_identity");
  const packagedFiles = files.filter(file => file.outcome === "packaged").length;
  return { schema: SYSTEM_BACKUP_SCHEMA, kind: "system_backup", backupId: records.backupId, sourceInstallationId: identity.installation_id,
    createdAt: records.createdAt, sourceSnapshotClock: records.image.sourceSnapshotClock, sourceCheckpoint: await sourceBackupCheckpoint(records), contentSchemaVersion: 24,
    recordsSha256: await sha256Hex(recordsText), completeness: packagedFiles === files.length ? "complete" : "partial", files,
    counts: { tables: Object.keys(records.image.tables).length, rows: Object.values(records.image.tables).reduce((total, table) => total + table.rows.length, 0),
      sources: files.length, packagedFiles, unavailableFiles: files.length - packagedFiles, bytes },
    protectedConfiguration: records.protectedConfiguration, relocatedSources: records.content.relocatedSources,
    report: { htmlPath: "report/index.html", markdownPath: "report/report.md" } };
}

export interface SystemBackupAdmission { schemaSha256: string; tables: readonly RecoveryTableSpec[] }
export function validateSystemBackupMigrationLedger(value: unknown): SystemBackupMigrationLedger {
  const ledger = object(value, ["status", "entries"]);
  ensure(["unavailable", "observed"].includes(String(ledger.status)) && Array.isArray(ledger.entries)
    && ledger.entries.length <= 256 && new TextEncoder().encode(stableJson(ledger)).byteLength <= 64 * 1024, "source_migration_ledger_budget");
  ensure(ledger.status !== "unavailable" || ledger.entries.length === 0, "source_migration_ledger_unavailable");
  const ids = new Set<string>(), names = new Set<string>();
  for (const value of ledger.entries) {
    const row = object(value, ["id", "name", "appliedAt", "rawSha256"]);
    ensure(typeof row.id === "string" && /^(?:0|-?[1-9]\d*)$/.test(row.id) && row.id.length <= 20
      && BigInt(row.id) >= -9223372036854775808n && BigInt(row.id) <= 9223372036854775807n
      && !ids.has(row.id) && text(row.name, 256) && !names.has(row.name)
      && (row.appliedAt === null || text(row.appliedAt, 200) && Number.isFinite(Date.parse(row.appliedAt))), "source_migration_ledger_entry");
    const reviewed = RECOVERY_MIGRATIONS.find(migration => migration.name === row.name);
    ensure(row.rawSha256 === (reviewed?.sha256 ?? null), "source_migration_ledger_hash");
    ids.add(row.id); names.add(row.name);
  }
  return ledger as unknown as SystemBackupMigrationLedger;
}
/** The typed recovery image and historical content proof must describe the
 * SAME frozen records. An independently valid second image is not sufficient. */
export async function validateSystemBackupContentImage(content: FullExportManifestV24, image: SystemRecoveryImageV1) {
  const compatibility = classifyExportCompatibilitySchema(content.artifacts.sourceSchema.value.compatibilityColumns, "file-authority-v14");
  const physical = restoreCompatibilityRows(content.tables, content.artifacts.retiredFields.value, compatibility, "file-authority-v14");
  for (const [name, table] of Object.entries(image.tables)) {
    if (!Object.hasOwn(physical, name)) continue;
    const rows = table.rows.map(row => Object.fromEntries(table.columns.map((column, index) => {
      const cell = row.cells[index];
      if (cell.type === "integer" && !isFileShadowRowidColumn(name, column)) ensure(Number.isSafeInteger(Number(cell.value)), `content_integer:${name}.${column}`);
      const value = cell.type === "null" ? null : cell.type === "integer" && isFileShadowRowidColumn(name, column) ? cell.value
        : cell.type === "integer" || cell.type === "real" ? Number(cell.value) : cell.type === "text" ? cell.value : { $sqliteBlob: cell.value };
      return [column, value];
    })));
    ensure(stableJson(rows.map(stableJson).sort()) === stableJson(physical[name].map(stableJson).sort()), `content_image:${name}`);
    const rowids = content.artifacts.sourceRowids.value.tables[name];
    if (rowids) {
      const expected = new Map(rowids.map(row => [row.rowid, row.rowSha256]));
      ensure(table.rows.length === expected.size, `content_rowids:${name}`);
      ensure(table.rows.every(row => row.rowid !== null && expected.has(row.rowid)), `content_rowids:${name}`);
      const logical = projectCompatibilitySnapshot({ ...physical, [name]: rows as ExportRow[] }, content.artifacts.sourceSchema.value, "file-authority-v14").tables[name];
      for (let index = 0; index < table.rows.length; index++) ensure(await sha256Hex(stableJson(logical[index])) === expected.get(table.rows[index].rowid!), `content_rowid_binding:${name}`);
    }
  }
}

/** Clock, API read leases and this backup's export holds do not mutate source
 * research. Every other typed canonical/configuration cell remains covered. */
export async function sourceBackupCheckpoint(records: SystemBackupRecordsV1): Promise<string> {
  const operation = `fp5-backup:${records.backupId}`;
  const tables = Object.fromEntries(Object.entries(records.image.tables).map(([name, table]) => {
    const kindIndex = table.columns.indexOf("hold_kind"), operationIndex = table.columns.indexOf("operation_id");
    const rows = table.rows.filter(row => {
      if (name !== "file_holds" && name !== "file_location_holds") return true;
      const kind = row.cells[kindIndex], owner = row.cells[operationIndex];
      return !(kind?.type === "text" && (kind.value === "read" || kind.value === "export" && owner?.type === "text"
        && owner.value === operation));
    }).sort((a, b) => stableJson(a) < stableJson(b) ? -1 : stableJson(a) > stableJson(b) ? 1 : 0);
    return [name, { ...table, rows }];
  }));
  return sha256Hex(stableJson({ kind: "system-backup-source-checkpoint/1", schemaSha256: records.image.schemaSha256, tables,
    protectedConfiguration: records.protectedConfiguration, sourceMigrationLedger: records.sourceMigrationLedger }));
}
async function checkedLegacyOrigin(origin: Record<string, unknown>, content: FullExportManifestV24) {
  const evidence = object(origin.legacyArtifacts, ["sourceSchemaEvidence", "artifacts"]);
  ensure(evidence.sourceSchemaEvidence === (origin.schemaVersion === 7 ? "unavailable-in-v7" : "observed-in-source-snapshot"), "legacy_schema_evidence");
  const artifacts = object(evidence.artifacts), expected = origin.schemaVersion === 7 ? [EXPORT_RETIRED_FIELDS_PATH]
    : Number(origin.schemaVersion) >= 15 ? [EXPORT_RETIRED_FIELDS_PATH, EXPORT_SOURCE_SCHEMA_PATH, FILE_SHADOW_SOURCE_ROWIDS_PATH] : [EXPORT_RETIRED_FIELDS_PATH, EXPORT_SOURCE_SCHEMA_PATH];
  ensure(stableJson(Object.keys(artifacts).sort()) === stableJson(expected.sort()), "legacy_artifact_inventory");
  for (const path of expected) {
    const artifact = object(artifacts[path], path === EXPORT_RETIRED_FIELDS_PATH ? ["path", "byteSize", "sha256", "retainedOffline", "value", "originalText"] : ["path", "byteSize", "sha256", "retainedOffline"]);
    ensure(artifact.path === path && size(artifact.byteSize) && artifact.byteSize <= 128 * 1024 * 1024 && hash(artifact.sha256) && artifact.retainedOffline === true, "legacy_artifact_descriptor");
    if (path === EXPORT_RETIRED_FIELDS_PATH) {
      // Preserve recorded S0/S1 fields even though the current S2 image no
      // longer has those columns. The original bytes remain in offline sidecar.
      restoreCompatibilityRows(content.tables, artifact.value as FullExportManifestV24["artifacts"]["retiredFields"]["value"], "S2", "file-authority-v14");
      ensure(typeof artifact.originalText === "string" && new TextEncoder().encode(artifact.originalText).byteLength <= SYSTEM_BACKUP_MAX_RECORDS_BYTES
        && new TextEncoder().encode(artifact.originalText).byteLength === artifact.byteSize
        && await sha256Hex(artifact.originalText) === artifact.sha256, "legacy_retired_artifact_hash");
      let originalValue: unknown;
      try { originalValue = JSON.parse(artifact.originalText); } catch { ensure(false, "legacy_retired_artifact_json"); }
      ensure(stableJson(originalValue) === stableJson(artifact.value), "legacy_retired_artifact_value");
    }
  }
  const seen = new Set<string>();
  for (const raw of origin.migrationEvidence as unknown[]) {
    const item = object(raw, ["name", "sha256"]);
    ensure(!seen.has(String(item.name)) && RECOVERY_MIGRATIONS.some(migration => migration.name === item.name && migration.sha256 === item.sha256), "legacy_migration_evidence");
    seen.add(String(item.name));
  }
}
export async function validateSystemBackupDocuments(manifestValue: unknown, recordsValue: unknown, admission: SystemBackupAdmission) {
  const record = object(recordsValue, ["schema", "backupId", "createdAt", "content", "image", "protectedConfiguration", "origin", "sourceMigrationLedger"]);
  ensure(record.schema === SYSTEM_BACKUP_RECORDS_SCHEMA, "records_schema");
  const sourceMigrationLedger = validateSystemBackupMigrationLedger(record.sourceMigrationLedger);
  const content = await validateFullExportV24(record.content);
  const image = validateSystemRecoveryImage(record.image, { schemaSha256: admission.schemaSha256, tables: admission.tables, maxMetadataBytes: SYSTEM_BACKUP_MAX_RECORDS_BYTES });
  ensure(image.sourceSnapshotClock === content.artifacts.sourceSchema.value.snapshotClock, "snapshot_clock");
  await validateSystemBackupContentImage(content, image);
  const origin = object(record.origin, ["format", "schemaVersion", "archiveSha256", "legacyArtifacts", "migrationEvidence"]);
  ensure(Array.isArray(origin.migrationEvidence), "origin_migrations");
  for (const item of origin.migrationEvidence) { const row = object(item, ["name", "sha256"]); ensure(text(row.name, 200) && hash(row.sha256), "origin_migrations"); }
  const configuration = object(record.protectedConfiguration);
  if (origin.format === "native") ensure(origin.schemaVersion === 24 && origin.archiveSha256 === null && origin.legacyArtifacts === null && origin.migrationEvidence.length === 0 && configuration.status === "included_encrypted"
    && content.backupHoldOwner === record.backupId, "native_origin");
  else {
    ensure(origin.format === "legacy-converted" && Number.isInteger(origin.schemaVersion) && Number(origin.schemaVersion) >= 7 && Number(origin.schemaVersion) <= 24
      && hash(origin.archiveSha256) && origin.legacyArtifacts !== null && typeof origin.legacyArtifacts === "object" && configuration.status === "excluded_legacy_content"
      && content.backupHoldOwner === null, "legacy_origin");
    await checkedLegacyOrigin(origin, content);
    ensure(sourceMigrationLedger.status === "unavailable", "legacy_source_migration_ledger");
  }
  const policy = systemBackupProtectedConfiguration(image, configuration.status as ProtectedConfigurationPolicy["status"]);
  ensure(stableJson(record.protectedConfiguration) === stableJson(policy), "protected_configuration");
  const records = { ...record, content, image, sourceMigrationLedger } as unknown as SystemBackupRecordsV1;
  const manifest = object(manifestValue, ["schema", "kind", "backupId", "sourceInstallationId", "createdAt", "sourceSnapshotClock", "sourceCheckpoint", "contentSchemaVersion", "recordsSha256", "completeness", "files", "counts", "protectedConfiguration", "relocatedSources", "report"]);
  ensure(manifest.schema === SYSTEM_BACKUP_SCHEMA && manifest.kind === "system_backup" && Array.isArray(manifest.files), "manifest_schema");
  const expected = await finishSystemBackupManifest(records, manifest.files as SystemBackupFile[]);
  ensure(stableJson(manifest) === stableJson(expected), "manifest_inventory");
  return { manifest: expected, records };
}
