// SOURCE-ONLY V28/image5/records5 family. Every historical reader keeps its exact pins.
import { COLLABORATION_TABLE_NAMES_V28 } from "./collaboration-schema-v28";
export function collaborationRecoveryPolicyV28() {
  return { schema: "installation-local-collaboration/2", tableNames: [...COLLABORATION_TABLE_NAMES_V28],
    sourceRows: "omitted", destinationControl: { singleton: 1, schemaVersion: 2, enforcement: "disabled", revision: 1 },
    destinationAuthorityTables: "empty", importedAuthority: false } as const;
}
export type CollaborationRecoveryPolicyV28 = ReturnType<typeof collaborationRecoveryPolicyV28>;
import { validateFullExportV28, type FullExportManifestV28 } from "./export-portable-runtime-v28";
import { validateSystemBackupContentImageV28, validateSystemBackupFileInventoryV28, type SystemBackupFileV28 } from "./system-backup-v28-content";
import { LOCAL_PROFILE_HISTORY_TABLE_NAMES } from "./export-local-profiles-v26";
import type { ProtectedLocalHistoryV28 } from "./export-local-file-runtime-v28";
import { bindNativeV5CommentSourceHistory } from "./export-native-v5-comment-provenance";
import type { ExportRow } from "./export";
import type { ProtectedIdentityPolicy } from "./system-backup-v2";
import { protectedIdentityPolicy } from "./system-backup-v2";
export { protectedIdentityPolicy } from "./system-backup-v2";
import { SYSTEM_BACKUP_MAX_RECORDS_BYTES, systemBackupProtectedConfiguration, type ProtectedConfigurationPolicy, type SystemBackupManifestV1 } from "./system-backup";
import { validateSystemRecoveryImage, type SystemRecoveryImageV1 } from "./system-recovery-image";
import { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, PORTABLE_RUNTIME_RECOVERY_MIGRATIONS,
  PORTABLE_RUNTIME_RECOVERY_TABLES, PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256 } from "./portable-runtime-v28-recovery-catalog";
import { sha256Hex, stableJson } from "../domain/content-addressing";

export const SYSTEM_BACKUP_SCHEMA_V5 = "system-backup/5" as const;
export const SYSTEM_BACKUP_RECORDS_SCHEMA_V5 = "system-backup-records/5" as const;
export interface SystemRecoveryImageV5 extends Omit<SystemRecoveryImageV1, "version"> {
  version: 5; checkpointId: typeof PORTABLE_RUNTIME_CHECKPOINT_ID;
}
export interface NodeMigrationProvenance {
  kind: "node-reviewed-migrations/1"; installationId: string; catalogId: "sample-fabrication-workflow/sqlite-v1";
  checkpointId: typeof PORTABLE_RUNTIME_CHECKPOINT_ID; schemaSha256: string; createdAt: string;
  entries: Array<{ ordinal: number; name: string; rawSha256: string; checkpointId: string; schemaSha256: string; status: "applied"; appliedAt: string }>;
}
/** Actual Cloudflare receipts are observational source provenance. They do not
 * assert the Node installer ran, and never become a destination's ledger. */
export interface CloudflareMigrationProvenance {
  kind: "cloudflare-observed-migrations/1"; status: "observed" | "unavailable";
  entries: Array<{ id: string; name: string; appliedAt: string | null; rawSha256: string | null }>;
}
export type CurrentMigrationProvenance = NodeMigrationProvenance | CloudflareMigrationProvenance;
export interface SystemBackupRecordsV5 {
  schema: typeof SYSTEM_BACKUP_RECORDS_SCHEMA_V5; backupId: string; createdAt: string;
  content: FullExportManifestV28; image: SystemRecoveryImageV5;
  protectedConfiguration: ProtectedConfigurationPolicy; protectedIdentity: ProtectedIdentityPolicy;
  collaborationPolicy: CollaborationRecoveryPolicyV28;
  sourceMigrationLedger: CurrentMigrationProvenance;
  origin: { format: "native"; schemaVersion: 28; capturePolicy: "quiesced-writers-and-bytes/1" | "atomic-primary-with-byte-holds/1" };
}
export interface NodeSystemBackupRecordsV5 extends SystemBackupRecordsV5 {
  sourceMigrationLedger: NodeMigrationProvenance;
  origin: { format: "native"; schemaVersion: 28; capturePolicy: "quiesced-writers-and-bytes/1" };
}
export interface SystemBackupManifestV5 extends Omit<SystemBackupManifestV1, "schema" | "contentSchemaVersion" | "files"> {
  schema: typeof SYSTEM_BACKUP_SCHEMA_V5; contentSchemaVersion: 28; protectedIdentity: ProtectedIdentityPolicy; collaborationPolicy: CollaborationRecoveryPolicyV28;
  files: SystemBackupFileV28[];
}
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Current system backup rejected: ${reason}`);
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value) && Reflect.ownKeys(value).length === keys.length
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort()), "closed fields");
}
const clock = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function validateSystemRecoveryImageV5(value: unknown): SystemRecoveryImageV5 {
  exact(value, ["version", "kind", "schemaSha256", "checkpointId", "sourceSnapshotClock", "tables"]);
  ensure(value.version === 5 && value.checkpointId === PORTABLE_RUNTIME_CHECKPOINT_ID, "image version/checkpoint");
  const { checkpointId: _checkpoint, ...typed } = value;
  // V1's closed typed-cell/storage-class validator is reused with the explicit
  // NEW catalog, after admitting V5. Its historical default remains frozen.
  const checked = validateSystemRecoveryImage({ ...typed, version: 1 }, {
    schemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, tables: PORTABLE_RUNTIME_RECOVERY_TABLES, maxMetadataBytes: SYSTEM_BACKUP_MAX_RECORDS_BYTES,
  });
  const accounts = checked.tables.local_accounts;
  const enabled = accounts.columns.indexOf("enabled"), principal = accounts.columns.indexOf("principal_id"), username = accounts.columns.indexOf("username");
  for (const row of accounts.rows) {
    const state = row.cells[enabled], id = row.cells[principal], name = row.cells[username];
    ensure(state.type === "integer" && ["0", "1"].includes(state.value)
      && id.type === "text" && /^local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id.value)
      && name.type === "text" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name.value), "protected account identity/state");
  }
  return { ...checked, version: 5, checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID };
}
/** Data-only semantic input derived from the SAME already validated closed V5
 * image. No authority/check/binding/path table is copied into research content.
 * Both whole-record validation and actual native capture call this after image
 * admission; callers never supply a callback claiming a source was qualified. */
export function protectedLocalHistoryFromV5Image(image: SystemRecoveryImageV5): ProtectedLocalHistoryV28 {
  const history = Object.fromEntries(LOCAL_PROFILE_HISTORY_TABLE_NAMES.map(name => [name, image.tables[name].rows.map(row =>
    Object.freeze(Object.fromEntries(image.tables[name].columns.map((column, index) => {
      const cell = row.cells[index];
      ensure(cell.type !== "blob" && (cell.type !== "integer" || Number.isSafeInteger(Number(cell.value))), "protected local history scalar");
      return [column, cell.type === "null" ? null : cell.type === "integer" || cell.type === "real" ? Number(cell.value) : cell.value];
    })) as ExportRow))])) as unknown as ProtectedLocalHistoryV28;
  bindNativeV5CommentSourceHistory(history, image);
  return history;
}
export function validateNodeMigrationProvenanceV5(value: unknown): NodeMigrationProvenance {
  exact(value, ["kind", "installationId", "catalogId", "checkpointId", "schemaSha256", "createdAt", "entries"]);
  ensure(value.kind === "node-reviewed-migrations/1" && value.catalogId === "sample-fabrication-workflow/sqlite-v1"
    && value.checkpointId === PORTABLE_RUNTIME_CHECKPOINT_ID && value.schemaSha256 === PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256[PORTABLE_RUNTIME_CHECKPOINT_ID] && clock(value.createdAt)
    && typeof value.installationId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.installationId)
    && Array.isArray(value.entries) && value.entries.length === PORTABLE_RUNTIME_RECOVERY_MIGRATIONS.length, "node migration identity");
  for (const [index, raw] of value.entries.entries()) {
    exact(raw, ["ordinal", "name", "rawSha256", "checkpointId", "schemaSha256", "status", "appliedAt"]);
    const reviewed = PORTABLE_RUNTIME_RECOVERY_MIGRATIONS[index];
    ensure(raw.ordinal === index + 1 && raw.name === reviewed.name && raw.rawSha256 === reviewed.sha256
      && raw.checkpointId === (index === 22 ? "portable-runtime/v25" : index === 23 ? "portable-runtime/v26" : index === 24 ? "portable-runtime/v27" : index === 25 ? PORTABLE_RUNTIME_CHECKPOINT_ID : `migration/${reviewed.name}`)
      && raw.schemaSha256 === PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256[raw.checkpointId as keyof typeof PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256] && raw.status === "applied" && clock(raw.appliedAt), "node migration receipt");
  }
  ensure(value.entries.at(-1)?.schemaSha256 === value.schemaSha256, "node current receipt");
  ensure(new TextEncoder().encode(stableJson(value)).byteLength <= 64 * 1024, "node migration budget");
  return value as unknown as NodeMigrationProvenance;
}
export function validateCloudflareMigrationProvenanceV5(value: unknown): CloudflareMigrationProvenance {
  exact(value, ["kind", "status", "entries"]);
  ensure(value.kind === "cloudflare-observed-migrations/1" && (value.status === "observed" || value.status === "unavailable")
    && Array.isArray(value.entries) && value.entries.length <= 256
    && new TextEncoder().encode(stableJson(value)).byteLength <= 64 * 1024, "cloudflare migration budget");
  ensure(value.status !== "unavailable" || value.entries.length === 0, "cloudflare unavailable receipts");
  const ids = new Set<string>(), names = new Set<string>();
  const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !v.includes("\0")
    && new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(v)) === v;
  for (const row of value.entries) {
    exact(row, ["id", "name", "appliedAt", "rawSha256"]);
    ensure(typeof row.id === "string" && /^(?:0|-?[1-9]\d*)$/.test(row.id) && row.id.length <= 20
      && BigInt(row.id) >= -9223372036854775808n && BigInt(row.id) <= 9223372036854775807n && !ids.has(row.id)
      && text(row.name, 256) && !names.has(row.name)
      && (row.appliedAt === null || text(row.appliedAt, 200) && Number.isFinite(Date.parse(row.appliedAt))), "cloudflare migration receipt");
    ensure(row.rawSha256 === (PORTABLE_RUNTIME_RECOVERY_MIGRATIONS.find(migration => migration.name === row.name)?.sha256 ?? null), "cloudflare raw migration digest");
    ids.add(row.id); names.add(row.name);
  }
  return value as unknown as CloudflareMigrationProvenance;
}
export async function sourceBackupCheckpointV5(records: SystemBackupRecordsV5): Promise<string> {
  const tables = Object.fromEntries(Object.entries(records.image.tables).map(([name, table]) => {
    const kind = table.columns.indexOf("hold_kind");
    const rows = table.rows.filter(row => !["file_holds", "file_location_holds"].includes(name)
      || row.cells[kind]?.type !== "text" || row.cells[kind].value !== "read")
      .sort((a, b) => stableJson(a) < stableJson(b) ? -1 : stableJson(a) > stableJson(b) ? 1 : 0);
    return [name, { ...table, rows }];
  }));
  return sha256Hex(stableJson({ kind: "system-backup-source-checkpoint/5", checkpointId: records.image.checkpointId,
    schemaSha256: records.image.schemaSha256, tables, protectedConfiguration: records.protectedConfiguration,
    protectedIdentity: records.protectedIdentity, collaborationPolicy: records.collaborationPolicy, sourceMigrationLedger: records.sourceMigrationLedger }));
}
export async function finishSystemBackupManifestV5(records: SystemBackupRecordsV5, values: readonly SystemBackupFileV28[]): Promise<SystemBackupManifestV5> {
  ensure(typeof records.backupId === "string" && records.backupId.length > 0 && records.backupId.length <= 128 && !records.backupId.includes("\0")
    && clock(records.createdAt), "identity");
  const { files, bytes } = validateSystemBackupFileInventoryV28(records.content, values);
  const recordsText = stableJson(records);
  ensure(new TextEncoder().encode(recordsText).byteLength <= SYSTEM_BACKUP_MAX_RECORDS_BYTES, "records budget");
  const identity = records.content.tables.research_package_source_identity[0];
  ensure(identity && typeof identity.installation_id === "string" && identity.installation_id.length > 0, "source installation");
  const packagedFiles = files.filter(file => file.outcome === "packaged").length;
  return { schema: SYSTEM_BACKUP_SCHEMA_V5, kind: "system_backup", backupId: records.backupId, sourceInstallationId: identity.installation_id,
    createdAt: records.createdAt, sourceSnapshotClock: records.image.sourceSnapshotClock, sourceCheckpoint: await sourceBackupCheckpointV5(records),
    contentSchemaVersion: 28, recordsSha256: await sha256Hex(recordsText), completeness: packagedFiles === files.length ? "complete" : "partial", files,
    counts: { tables: Object.keys(records.image.tables).length, rows: Object.values(records.image.tables).reduce((sum, table) => sum + table.rows.length, 0),
      sources: files.length, packagedFiles, unavailableFiles: files.length - packagedFiles, bytes }, protectedConfiguration: records.protectedConfiguration,
    protectedIdentity: records.protectedIdentity, collaborationPolicy: records.collaborationPolicy, relocatedSources: records.content.relocatedSources,
    report: { htmlPath: "report/index.html", markdownPath: "report/report.md" } };
}
export async function validateSystemBackupRecordsV5(recordsValue: unknown): Promise<SystemBackupRecordsV5> {
  exact(recordsValue, ["schema", "backupId", "createdAt", "content", "image", "protectedConfiguration", "protectedIdentity", "collaborationPolicy", "sourceMigrationLedger", "origin"]);
  ensure(recordsValue.schema === SYSTEM_BACKUP_RECORDS_SCHEMA_V5, "records version");
  // Admit every image table/typed cell and the actual V28 tuple FIRST. Only this
  // original image's decoded protected history may qualify new local bytes.
  const image = validateSystemRecoveryImageV5(recordsValue.image);
  const histories = protectedLocalHistoryFromV5Image(image);
  const content = await validateFullExportV28(recordsValue.content, histories);
  ensure(image.sourceSnapshotClock === content.artifacts.sourceSchema.value.snapshotClock, "same source clock");
  await validateSystemBackupContentImageV28(content, image);
  exact(recordsValue.origin, ["format", "schemaVersion", "capturePolicy"]);
  ensure(recordsValue.origin.format === "native" && recordsValue.origin.schemaVersion === 28, "native origin");
  const nodeCapture = recordsValue.origin.capturePolicy === "quiesced-writers-and-bytes/1";
  ensure(nodeCapture && content.backupHoldOwner === null || recordsValue.origin.capturePolicy === "atomic-primary-with-byte-holds/1"
    && content.backupHoldOwner === recordsValue.backupId, "native capture policy");
  const protectedConfiguration = systemBackupProtectedConfigurationV5(image);
  ensure(stableJson(recordsValue.protectedConfiguration) === stableJson(protectedConfiguration), "protected storage configuration");
  ensure(stableJson(recordsValue.protectedIdentity) === stableJson(protectedIdentityPolicy()), "protected identity policy");
  ensure(stableJson(recordsValue.collaborationPolicy) === stableJson(collaborationRecoveryPolicyV28()), "installation-local collaboration policy");
  const records = { ...recordsValue, content, image, protectedConfiguration, protectedIdentity: protectedIdentityPolicy(), collaborationPolicy: collaborationRecoveryPolicyV28(),
    sourceMigrationLedger: nodeCapture ? validateNodeMigrationProvenanceV5(recordsValue.sourceMigrationLedger)
      : validateCloudflareMigrationProvenanceV5(recordsValue.sourceMigrationLedger) } as unknown as SystemBackupRecordsV5;
  ensure(typeof records.backupId === "string" && records.backupId.length > 0 && records.backupId.length <= 128 && !records.backupId.includes("\0")
    && clock(records.createdAt) && new TextEncoder().encode(stableJson(records)).byteLength <= SYSTEM_BACKUP_MAX_RECORDS_BYTES, "records identity/budget");
  return records;
}
export async function validateSystemBackupDocumentsV5(manifestValue: unknown, recordsValue: unknown) {
  const records = await validateSystemBackupRecordsV5(recordsValue);
  exact(manifestValue, ["schema", "kind", "backupId", "sourceInstallationId", "createdAt", "sourceSnapshotClock", "sourceCheckpoint", "contentSchemaVersion", "recordsSha256",
    "completeness", "files", "counts", "protectedConfiguration", "protectedIdentity", "collaborationPolicy", "relocatedSources", "report"]);
  ensure(manifestValue.schema === SYSTEM_BACKUP_SCHEMA_V5 && Array.isArray(manifestValue.files), "manifest version");
  const expected = await finishSystemBackupManifestV5(records, manifestValue.files as SystemBackupFileV28[]);
  ensure(stableJson(manifestValue) === stableJson(expected), "manifest inventory");
  return { manifest: expected, records };
}

/** Explicit classified inventory. The frozen V1/V2 prefix helper is not
 * extended to silently include new protected tables. Local histories describe
 * inert decisions; physical paths, checks, admissions and bindings are absent. */
export function systemBackupProtectedConfigurationV5(image: Pick<SystemRecoveryImageV5, "tables">): ProtectedConfigurationPolicy {
  const old = systemBackupProtectedConfiguration(image);
  return { ...old, tableNames: PORTABLE_RUNTIME_RECOVERY_TABLES.filter(table => table.classification === "protected_configuration").map(table => table.name).sort() };
}
