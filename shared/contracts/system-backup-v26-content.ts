// V26-owned cell/source agreement; old V1 helpers and format admission remain frozen.
import type { ExportRow } from "./export";
import type { FullExportManifestV26 } from "./export-portable-runtime-v26";
import type { SystemBackupSource, SystemBackupFile, SystemBackupOutcome } from "./system-backup";
import { SYSTEM_BACKUP_MAX_FILES, SYSTEM_BACKUP_MAX_PAYLOAD_BYTES, SYSTEM_BACKUP_OUTCOMES } from "./system-backup";
import type { FullExportBlobEntryV21 } from "./export";
import type { FilePurpose } from "./files";
import type { SystemRecoveryImageV1 } from "./system-recovery-image";
import { classifyExportCompatibilitySchema, projectCompatibilitySnapshot, restoreCompatibilityRows } from "./export-compatibility";
import { isFileShadowRowidColumn } from "./file-shadow-rowid";
import { stableJson, sha256Hex } from "../domain/content-addressing";
const PURPOSES = ["research_source", "embedded_content", "derived_preview", "provenance", "job_output"] as const;
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error(`V26 system backup rejected: ${reason}`); }
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value), "object");
  const row = value as Record<string, unknown>;
  if (keys) ensure(stableJson(Object.keys(row).sort()) === stableJson([...keys].sort()), "fields");
  return row;
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

export function planSystemBackupSourcesV26(content: FullExportManifestV26): SystemBackupSource[] {
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

export function validateSystemBackupFileInventoryV26(content: FullExportManifestV26, values: readonly SystemBackupFile[]): { files: SystemBackupFile[]; bytes: number } {
  const sources = planSystemBackupSourcesV26(content);
  ensure(values.length === sources.length, "file_inventory");
  const files = sources.map((source, index) => checkedFile(source, values[index]));
  const bytes = files.reduce((total, file) => total + (file.byteSize ?? 0), 0);
  ensure(bytes <= SYSTEM_BACKUP_MAX_PAYLOAD_BYTES, "payload_budget");
  return { files, bytes };
}

export async function validateSystemBackupContentImageV26(content: FullExportManifestV26, image: Pick<SystemRecoveryImageV1, "tables">) {
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
