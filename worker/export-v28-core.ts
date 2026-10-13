// SOURCE-ONLY V28 writer. Own new envelope over unchanged reviewed business snapshot SQL.
// V26 business composition. Snapshot table SQL remains the qualified existing business inventory.
import { NATIVE_RETENTION_VIEW_NAMES, NATIVE_RETENTION_SNAPSHOT_QUERY, checkedNativeRetentionSnapshot } from "./export-native-retention-snapshot.ts";
import { FULL_EXPORT_ARCHIVE_WRITER, type ExportTables, type FileShadowSourceRowids, type ObservedNativeExportSchema } from "../shared/contracts/export.ts";
import { FULL_EXPORT_ARCHIVE_PROFILE_V28, FULL_EXPORT_ARCHIVE_SCHEMA_V28, validateFullExportBusinessV28, type FullExportBusinessManifestV28 } from "../shared/contracts/export-business-v28.ts";
import { portableBusinessSchemaV28 } from "../shared/contracts/export-portable-runtime-v28.ts";
import { projectCompatibilitySnapshot } from "../shared/contracts/export-compatibility.ts";
import { createExportArtifact, EXPORT_RETIRED_FIELDS_PATH, EXPORT_SOURCE_SCHEMA_PATH } from "../shared/contracts/export-protocol.ts";
import { FILE_REGISTRY_ROWID_CLAIMS_INTEGRITY_SQL } from "../shared/contracts/export-file-authority.ts";
import { FILE_SHADOW_HEAD_INTEGRITY_SQL, FILE_SHADOW_SOURCE_ROWIDS_PATH, FILE_SHADOW_SOURCE_TABLE_NAMES } from "../shared/contracts/export-file-shadow.ts";
import { FULL_EXPORT_V24_TABLE_QUERIES } from "./export-catalog.ts";
import { sha256Hex, stableJson } from "../shared/domain/content-addressing.ts";
import { validateLocalFileRuntimeV28, type ProtectedLocalHistoryV28 } from "../shared/contracts/export-local-file-runtime-v28.ts";
import { planFileBlobExportV28 } from "../shared/contracts/export-local-file-bytes-v28.ts";


export interface NativeExportSnapshotResult { success: boolean; results: unknown[] }
/** Only the consumed code-owned batch read; no D1 or environment shape. */
export interface NativeExportSnapshotReader {
  readBatch(sql: readonly string[]): Promise<NativeExportSnapshotResult[]>;
}
export const NATIVE_V28_SNAPSHOT_TABLE_NAMES = Object.keys(FULL_EXPORT_V24_TABLE_QUERIES);
export function nativeV28SnapshotSql(): string[] {
  const queries = Object.entries(FULL_EXPORT_V24_TABLE_QUERIES).map(([name, sql]) => {
    const query = name === "samples" ? "SELECT * FROM samples ORDER BY created_at, id"
      : name === "run_step_comments" ? "SELECT * FROM run_step_comments ORDER BY run_step_id, created_at, id" : sql;
    if (NATIVE_RETENTION_VIEW_NAMES.has(name)) return "SELECT 1 WHERE 0";
    return FILE_SHADOW_SOURCE_TABLE_NAMES.includes(name) ? query.replace(/^SELECT\s+/, "SELECT CAST(rowid AS TEXT) AS __archive_source_rowid, ") : query;
  });
  return [
    ...queries,
    "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema ORDER BY type, name",
    "SELECT name FROM pragma_table_xinfo('samples') ORDER BY cid",
    "SELECT name FROM pragma_table_xinfo('run_step_comments') ORDER BY cid",
    FILE_REGISTRY_ROWID_CLAIMS_INTEGRITY_SQL, FILE_SHADOW_HEAD_INTEGRITY_SQL, NATIVE_RETENTION_SNAPSHOT_QUERY,
  ];
}
export async function buildFullExportV28FromSnapshot(results: readonly NativeExportSnapshotResult[], options: {
  backupHoldOwner?: string | null;
  protectedLocalHistory?: ProtectedLocalHistoryV28;
  projectSchema?: (objects: ObservedNativeExportSchema["objects"]) => ObservedNativeExportSchema["objects"] | Promise<ObservedNativeExportSchema["objects"]>;
} = {}): Promise<FullExportBusinessManifestV28> {
  const names = NATIVE_V28_SNAPSHOT_TABLE_NAMES;
  if (results.length !== names.length + 6 || results.some((result) => !result.success || !Array.isArray(result.results))) throw new Error("Complete shadow export snapshot was incomplete");
  const claims = results[names.length + 3].results as Array<{ invalid_count: number }>;
  if (claims.length !== 1 || claims[0].invalid_count !== 0) throw new Error("Complete shadow export found invalid File registry rowid claims");
  const heads = results[names.length + 4].results as Array<{ invalid_count: number }>;
  if (heads.length !== 1 || heads[0].invalid_count !== 0) throw new Error("Complete shadow export found inconsistent current source heads");
  const retention = checkedNativeRetentionSnapshot(results[names.length + 5].results);
  const rowidValues: Record<string, string[]> = {};
  const physicalTables = Object.fromEntries(names.map((name, index) => [name, results[index].results.map((value) => {
    if (!FILE_SHADOW_SOURCE_TABLE_NAMES.includes(name)) return value;
    const { __archive_source_rowid: rowid, ...row } = value as Record<string, unknown>;
    (rowidValues[name] ??= []).push(String(rowid)); return row;
  })])) as ExportTables;
  Object.assign(physicalTables, retention.tables);
  const schema: ObservedNativeExportSchema = {
    snapshotClock: retention.snapshotClock,
    version: 1, kind: "observed-sqlite-schema",
    objects: await (options.projectSchema ?? portableBusinessSchemaV28)(results[names.length].results as ObservedNativeExportSchema["objects"]),
    compatibilityColumns: {
      samples: results[names.length + 1].results.map((row) => String((row as { name: string }).name)),
      run_step_comments: results[names.length + 2].results.map((row) => String((row as { name: string }).name)),
    },
  };
  const projected = projectCompatibilitySnapshot(physicalTables, schema, "file-authority-v14");
  const sourceRowidValue: FileShadowSourceRowids = { version: 1, kind: "file-shadow-source-rowids", tables: {} };
  for (const name of FILE_SHADOW_SOURCE_TABLE_NAMES) sourceRowidValue.tables[name] = await Promise.all(projected.tables[name].map(async (row, index) => ({
    rowid: rowidValues[name][index], rowSha256: await sha256Hex(stableJson(row)),
  })));
  const [sourceSchema, retiredFields, sourceRowids] = await Promise.all([
    createExportArtifact(EXPORT_SOURCE_SCHEMA_PATH, schema), createExportArtifact(EXPORT_RETIRED_FIELDS_PATH, projected.retiredFields),
    createExportArtifact(FILE_SHADOW_SOURCE_ROWIDS_PATH, sourceRowidValue),
  ]);
  const protectedLocalHistory = options.protectedLocalHistory ?? { local_storage_profile_registrations: [], local_storage_profile_activations: [] };
  const evidence = await validateLocalFileRuntimeV28({ businessTables: projected.tables, sourceSchema: schema.objects,
    sourceRowids: sourceRowidValue, snapshotClock: retention.snapshotClock, protectedLocalHistory });
  const plan = planFileBlobExportV28(evidence, options.backupHoldOwner ?? null);
  return validateFullExportBusinessV28({ schemaVersion: FULL_EXPORT_ARCHIVE_SCHEMA_V28,
    archiveProfile: FULL_EXPORT_ARCHIVE_PROFILE_V28, archiveWriter: FULL_EXPORT_ARCHIVE_WRITER,
    exportedAt: new Date(Math.max(Date.now(), Date.parse(retention.snapshotClock))).toISOString(), tables: projected.tables,
    blobs: plan.blobs, excludedOutputs: plan.excludedOutputs, relocatedSources: plan.relocatedSources,
    backupHoldOwner: options.backupHoldOwner ?? null,
    artifacts: { sourceSchema, retiredFields, sourceRowids } }, protectedLocalHistory);
}
