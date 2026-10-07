import { stableJson, sha256Hex } from "../../shared/domain/content-addressing";
import type { SystemBackupRecordsV1 } from "../../shared/contracts/system-backup";
import type { SystemRecoveryCell, SystemRecoveryRow, SystemRecoveryTable, RecoveryTableSpec } from "../../shared/contracts/system-recovery-image";
import { FILE_REGISTRY_ROWID_CLAIMS_INTEGRITY_SQL, canonicalFileAuthoritySchemaSql } from "../../shared/contracts/export-file-authority";
import { FILE_SHADOW_HEAD_INTEGRITY_SQL } from "../../shared/contracts/export-file-shadow";
import { RECOVERY_SCHEMA_SHA256, RECOVERY_SCHEMA_STATEMENTS, RECOVERY_TABLES } from "./trusted-schema";
import { readRecoveryTable, assertRecoveredCapabilitiesInert, recoveryIdentifier } from "./protected-settings";
import { recoveryFileCellChanges, type RecoveryDestinationProfile, type RecoveryPlannedFile } from "./target-files";
import type { RecoveryCellDifference } from "./report";
import { recoveryFileEvidenceRows } from "./target-files";
import { SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS, validateSystemRecoveryEvidenceHistory } from "../../shared/contracts/export-system-recovery-evidence";
import type { ExportTables } from "../../shared/contracts/export";
import { inspectRecoveryPlatformSchema } from "./target-migrations";

export interface RecoveryVerification { differences: RecoveryCellDifference[]; checkpoint: { schemaSha256: string; tables: Record<string, string>; files: string; sourceImageSha256: string } }
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
const text = (value: string): SystemRecoveryCell => ({ type: "text", value });
const cellValue = (cell: SystemRecoveryCell | undefined) => cell?.type === "null" || !cell ? null : cell.value;
function rowKey(spec: RecoveryTableSpec, row: SystemRecoveryRow) {
  if (!spec.withoutRowid) return `rowid:${row.rowid}`;
  return stableJson((spec.primaryKeyColumns ?? spec.columns).map(column => row.cells[spec.columns.indexOf(column)]));
}
function keyed(table: SystemRecoveryTable, row: SystemRecoveryRow, keys: Record<string, string>) {
  return Object.entries(keys).every(([column, value]) => cellValue(row.cells[table.columns.indexOf(column)]) === value);
}
function validClock(cell: SystemRecoveryCell) { return cell.type === "text" && Number.isFinite(Date.parse(cell.value)); }
async function appendedRowAllowed(database: D1Database, table: SystemRecoveryTable, name: string, row: SystemRecoveryRow,
  files: readonly RecoveryPlannedFile[], profiles: readonly RecoveryDestinationProfile[]) {
  const value = (column: string) => cellValue(row.cells[table.columns.indexOf(column)]);
  if (name === "files") {
    const file = files.find(file => file.createFile && file.fileId === value("id"));
    return Boolean(file && value("purpose") === file.purpose && value("access_scope") === "system"
      && value("expected_byte_size") === String(file.byteSize) && value("expected_sha256") === file.sha256
      && value("verified_sha256") === null && value("state") === "unresolved" && value("active_location_id") === null
      && validClock(row.cells[table.columns.indexOf("created_at")]));
  }
  if (name === "file_locations") {
    const file = files.find(file => file.locationId === value("id"));
    return Boolean(file && value("file_id") === file.fileId && value("storage_profile_id") === file.destinationProfileId
      && value("object_key") === file.objectKey && value("state") === "unresolved" && validClock(row.cells[table.columns.indexOf("created_at")]));
  }
  if (name === "file_location_publications") {
    const file = files.find(file => file.locationId === value("location_id"));
    return Boolean(file && value("file_id") === file.fileId && value("storage_profile_id") === file.destinationProfileId
      && value("object_key") === file.objectKey && value("verified_byte_size") === String(file.byteSize) && value("verified_sha256") === file.sha256
      && value("verification_method") === "full_read_sha256" && value("verification_operation_id") === `fp5:${file.id}`
      && validClock(row.cells[table.columns.indexOf("verified_at")]) && validClock(row.cells[table.columns.indexOf("published_at")]));
  }
  if (name === "file_publications") {
    const file = files.find(file => !file.nativePublicationExists && file.publishAsActive && file.fileId === value("file_id"));
    return Boolean(file && value("purpose") === file.purpose && value("access_scope") === "system" && value("verified_byte_size") === String(file.byteSize)
      && value("verified_sha256") === file.sha256 && value("active_location_id") === file.locationId && value("state") === "ready"
      && value("retired_at") === null && validClock(row.cells[table.columns.indexOf("published_at")]));
  }
  if (name === "storage_profiles") {
    const profile = profiles.find(profile => profile.id === value("id"));
    return Boolean(profile && value("adapter_type") === profile.adapterType && value("namespace_identity") === profile.namespaceIdentity
      && value("configuration_source") === (profile.adapterType === "r2" ? "bootstrap" : "system") && value("credential_reference") === null
      && value("configuration_revision") === "1" && value("state") === "historical" && value("created_at") === profile.createdAt);
  }
  if (name === "storage_profile_runtime") {
    const profile = profiles.find(profile => profile.id === value("storage_profile_id"));
    if (!profile) return false;
    const stored = await database.prepare("SELECT created_at FROM storage_profiles WHERE id=?").bind(profile.id).first<{ created_at: string }>();
    return value("state") === (profile.runtime?.state ?? "read_only") && value("registered_at") === stored?.created_at
      && value("activated_at") === (profile.runtime?.activated_at ?? null) && value("retired_at") === (profile.runtime?.retired_at ?? null);
  }
  if (name === "file_registry_rowid_claims") {
    const registry = value("registry_name"), rowid = value("claimed_rowid");
    if (!registry || !rowid || !["storage_profiles", "files", "file_locations", "legacy_file_mappings"].includes(registry)) return false;
    const row = await database.prepare(`SELECT 1 AS present FROM ${recoveryIdentifier(registry)} WHERE rowid=CAST(? AS INTEGER)`).bind(rowid).first();
    return Boolean(row);
  }
  if(name==='file_shadow_enablements'){
    if(!files.length||value('singleton')!=='1'||value('enabled_by')!==`fp5-recovery:${files[0].incarnation}`)return false;
    const authority=await database.prepare('SELECT a.activated_at,c.epoch FROM file_authority_control a JOIN file_shadow_control c ON c.singleton=a.singleton WHERE a.singleton=1 AND a.mode=\'active\'').first<{activated_at:string;epoch:number}>();
    return Boolean(authority&&value('enabled_at')===authority.activated_at&&value('expected_epoch')===String(authority.epoch));
  }
  if (["storage_profile_admissions", "storage_profile_activations", "file_shadow_dependency_versions", "file_shadow_profile_enablements"].includes(name)) {
    return profiles.some(profile => profile.metadataRows?.some(metadata => metadata.table === name && table.columns.every(column => {
      const recorded = metadata.row[column], cell = row.cells[table.columns.indexOf(column)];
      return recorded === null ? cell.type === "null" : typeof recorded === "number"
        ? (cell.type === "integer" || cell.type === "real") && cell.value === String(recorded) : cell.type === "text" && cell.value === recorded;
    })));
  }
  if (Object.hasOwn(SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS, name)) {
    const evidenceId = value(name === "recovery_file_evidence" ? "id" : "evidence_id");
    const file = files.find(file => file.id === evidenceId); if (!file) return false;
    const proof = await database.prepare("SELECT verified_at FROM system_recovery_target_files WHERE logical_id=? AND state='published'")
      .bind(file.id).first<{ verified_at: string }>();
    if (!proof) return false;
    return recoveryFileEvidenceRows(file, proof.verified_at)[name].some(expected => table.columns.every(column => {
      const recorded = expected[column], cell = row.cells[table.columns.indexOf(column)];
      return recorded === null ? cell.type === "null" : typeof recorded === "number"
        ? cell.type === "integer" && cell.value === String(recorded) : cell.type === "text" && cell.value === recorded;
    }));
  }
  return false;
}
export async function verifyRecoveryTarget(database: D1Database, records: SystemBackupRecordsV1,
  files: readonly RecoveryPlannedFile[], profiles: readonly RecoveryDestinationProfile[], jobId: string, imageSha256: string): Promise<RecoveryVerification> {
  await assertRecoveredCapabilitiesInert(database);
  await inspectRecoveryPlatformSchema(database);
  const schema = await database.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND tbl_name NOT IN('_cf_KV','_cf_METADATA','d1_migrations') ORDER BY type,name")
    .all<{ type: string; name: string; tableName: string; sql: string }>();
  const schemaTokens = (entries: readonly { type: string; name: string; tableName: string; sql: string }[]) =>
    entries.map(entry => ({ ...entry, sql: canonicalFileAuthoritySchemaSql(entry.sql) }));
  ensure(schema.success && stableJson(schemaTokens(schema.results)) === stableJson(schemaTokens(RECOVERY_SCHEMA_STATEMENTS)), "restored_schema_differs");
  ensure((await database.prepare("PRAGMA foreign_key_check").all()).results.length === 0, "restored_foreign_keys_invalid");
  const originalText = (await database.prepare("SELECT chunk,image_sha256 FROM system_recovery_target_provenance WHERE job_id=? ORDER BY ordinal")
    .bind(jobId).all<{ chunk: string; image_sha256: string }>()).results;
  ensure(originalText.length && originalText.every(chunk => chunk.image_sha256 === imageSha256)
    && originalText.map(chunk => chunk.chunk).join("") === stableJson(records.image), "original_recovery_provenance_changed");
  const proofFiles = (await database.prepare("SELECT * FROM system_recovery_target_files WHERE job_id=? ORDER BY logical_id")
    .bind(jobId).all<Record<string, unknown>>()).results;
  ensure(proofFiles.length === files.length && proofFiles.every(row => {
    const file = files.find(file => file.id === row.logical_id);
    return file && row.state === "published" && row.file_id === file.fileId && row.location_id === file.locationId
      && row.source_blob_id === file.sourceId && row.profile_id === file.destinationProfileId && row.namespace === file.destinationNamespaceIdentity
      && row.object_key === file.objectKey && row.purpose === file.purpose && row.byte_size === file.byteSize && row.sha256 === file.sha256
      && row.incarnation === file.incarnation && typeof row.verified_at === "string" && Number.isFinite(Date.parse(row.verified_at));
  }), "recovery_payload_proofs_incomplete");
  const changes = recoveryFileCellChanges(files), differences: RecoveryCellDifference[] = [], tableHashes: Record<string, string> = {};
  const evidenceTables: ExportTables = {};
  const headSources = (await database.prepare(`SELECT h.occurrence_id,h.consumer_kind,h.consumer_id,h.consumer_sub_id,h.file_slot,s.source_json
    FROM file_shadow_heads h JOIN file_shadow_sources s ON s.consumer_kind=h.consumer_kind AND s.consumer_id=h.consumer_id
      AND s.consumer_sub_id=h.consumer_sub_id AND s.file_slot=h.file_slot WHERE h.present=1`).all<Record<string, unknown>>()).results;
  for (const spec of RECOVERY_TABLES.filter(table => !table.local)) {
    const expected = records.image.tables[spec.name], observed = await readRecoveryTable(database, spec.name);
    if (Object.hasOwn(SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS, spec.name) || ["files","storage_profiles","file_locations","file_location_publications"].includes(spec.name)) {
      evidenceTables[spec.name] = observed.rows.map(row => Object.fromEntries(spec.columns.map((column,index) => {
        const cell=row.cells[index]; return [column,cell.type==='null'?null:cell.type==='integer'||cell.type==='real'?Number(cell.value):cell.value];
      })));
    }
    const actualRows = new Map(observed.rows.map(row => [rowKey(spec, row), row]));
    for (const original of expected.rows) {
      const key = rowKey(spec, original), actual = actualRows.get(key); ensure(actual, `original_row_missing:${spec.name}`); actualRows.delete(key);
      for (let index = 0; index < spec.columns.length; index++) {
        const column = spec.columns[index], before = original.cells[index], after = actual.cells[index];
        if (stableJson(before) === stableJson(after)) continue;
        let allowed = false, reason: RecoveryCellDifference["reason"] = "destination_mapping";
        const planned = changes.filter(change => change.table === spec.name && change.column === column && keyed(expected, original, change.keys));
        if (planned.length) { allowed = planned.every(change => stableJson(after) === stableJson(change.value === null ? { type: "null" } : text(change.value))); reason = column === "active_location_id" ? "destination_mapping" : "file_binding"; }
        if (spec.name === "file_authority_control") {
          const originalMode=cellValue(original.cells[expected.columns.indexOf('mode')]);
          if(files.length&&originalMode!=='active')allowed ||= column === "mode" && stableJson(after) === stableJson(text("active"))
            || column === "updated_at" && validClock(after) || column === "activated_at" && before.type === "null" && validClock(after);
          reason = "authority_conversion";
        }
        if (column === "source_json" && ["file_shadow_heads", "file_shadow_occurrences"].includes(spec.name)) {
          const values = (name: string) => cellValue(original.cells[expected.columns.indexOf(name)]);
          const source = spec.name === "file_shadow_occurrences" ? headSources.find(source => source.occurrence_id === values("id"))
            : headSources.find(source => source.consumer_kind === values("consumer_kind") && source.consumer_id === values("consumer_id")
              && source.consumer_sub_id === values("consumer_sub_id") && source.file_slot === values("file_slot"));
          allowed ||= Boolean(source && after.type === "text" && source.source_json === after.value); reason = "derived_reconstruction";
        }
        ensure(allowed, `unclassified_recovery_cell_change:${spec.name}:${column}`);
        differences.push({ table: spec.name, row: key, column, before, after, reason });
      }
    }
    for (const [key, row] of actualRows) {
      ensure(await appendedRowAllowed(database, observed, spec.name, row, files, profiles), `unclassified_recovery_row:${spec.name}`);
      // Appended immutable rows are summarized in the signed table proof; the
      // cell-difference report identifies their exact typed values as well.
      for (let index = 0; index < spec.columns.length; index++) differences.push({ table: spec.name, row: key, column: spec.columns[index], before: null, after: row.cells[index], reason: "destination_mapping" });
    }
    const check = await database.prepare(`PRAGMA quick_check(${recoveryIdentifier(spec.name)})`).all<Record<string, unknown>>();
    ensure(check.success && check.results.length === 1 && Object.values(check.results[0])[0] === "ok", `restored_table_consistency:${spec.name}`);
    tableHashes[spec.name] = await sha256Hex(stableJson(observed.rows.map(stableJson).sort()));
  }
  validateSystemRecoveryEvidenceHistory(evidenceTables);
  ensure((await database.prepare(FILE_REGISTRY_ROWID_CLAIMS_INTEGRITY_SQL).first<{ invalid_count: number }>())?.invalid_count === 0, "restored_registry_rowids_invalid");
  ensure((await database.prepare(FILE_SHADOW_HEAD_INTEGRITY_SQL).first<{ invalid_count: number }>())?.invalid_count === 0, "restored_shadow_heads_invalid");
  const projectChecks = [
    "SELECT 1 FROM project_items i JOIN project_contents c ON c.id=i.project_content_id WHERE i.project_id<>c.project_id LIMIT 1",
    "SELECT 1 FROM project_edges e JOIN project_items a ON a.id=e.source_item_id JOIN project_items b ON b.id=e.target_item_id WHERE a.project_id<>e.project_id OR b.project_id<>e.project_id LIMIT 1",
  ];
  for (const sql of projectChecks) ensure(!await database.prepare(sql).first(), "restored_project_relationships_invalid");
  return { differences, checkpoint: { schemaSha256: RECOVERY_SCHEMA_SHA256, tables: tableHashes,
    files: await sha256Hex(stableJson(proofFiles)), sourceImageSha256: imageSha256 } };
}
