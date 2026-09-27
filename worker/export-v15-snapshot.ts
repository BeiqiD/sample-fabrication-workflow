import { FULL_EXPORT_ARCHIVE_PROFILE_V15, FULL_EXPORT_ARCHIVE_SCHEMA_V15, FULL_EXPORT_ARCHIVE_WRITER, type ExportTables, type FileShadowSourceRowids, type FullExportManifestV15, type ObservedExportSchema } from "../shared/contracts/export";
import { projectCompatibilitySnapshot } from "../shared/contracts/export-compatibility";
import { createExportArtifact, EXPORT_RETIRED_FIELDS_PATH, EXPORT_SOURCE_SCHEMA_PATH, validateFullExportV15 } from "../shared/contracts/export-protocol";
import { FILE_REGISTRY_ROWID_CLAIMS_INTEGRITY_SQL } from "../shared/contracts/export-file-authority";
import { buildFileShadowBlobExportPlan, FILE_SHADOW_HEAD_INTEGRITY_SQL, FILE_SHADOW_SOURCE_ROWIDS_PATH, FILE_SHADOW_SOURCE_TABLE_NAMES } from "../shared/contracts/export-file-shadow";
import { FULL_EXPORT_V15_TABLE_QUERIES } from "./export-catalog";
import { sha256Hex, stableJson } from "../shared/domain/content-addressing";

/** One primary snapshot contains canonical histories, both retention graphs,
 * the recorded mode and their physical schema. Runtime execution authority is
 * installation-local and is never made portable by an archive. */
export async function snapshotFullExportV15(database: D1Database): Promise<FullExportManifestV15> {
  const db = typeof database.withSession === "function" ? database.withSession("first-primary") : database;
  const names = Object.keys(FULL_EXPORT_V15_TABLE_QUERIES);
  const queries = Object.entries(FULL_EXPORT_V15_TABLE_QUERIES).map(([name, sql]) => {
    const query = name === "samples" ? "SELECT * FROM samples ORDER BY created_at, id"
      : name === "run_step_comments" ? "SELECT * FROM run_step_comments ORDER BY run_step_id, created_at, id" : sql;
    return FILE_SHADOW_SOURCE_TABLE_NAMES.includes(name) ? query.replace(/^SELECT\s+/, "SELECT CAST(rowid AS TEXT) AS __archive_source_rowid, ") : query;
  });
  const results = await db.batch([
    ...queries.map((sql) => db.prepare(sql)),
    db.prepare("SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema ORDER BY type, name"),
    db.prepare("SELECT name FROM pragma_table_xinfo('samples') ORDER BY cid"),
    db.prepare("SELECT name FROM pragma_table_xinfo('run_step_comments') ORDER BY cid"),
    db.prepare(FILE_REGISTRY_ROWID_CLAIMS_INTEGRITY_SQL),
    db.prepare(FILE_SHADOW_HEAD_INTEGRITY_SQL),
  ]);
  if (results.length !== names.length + 5 || results.some((result) => !result.success || !Array.isArray(result.results))) throw new Error("Complete shadow export snapshot was incomplete");
  const claims = results[names.length + 3].results as Array<{ invalid_count: number }>;
  if (claims.length !== 1 || claims[0].invalid_count !== 0) throw new Error("Complete shadow export found invalid File registry rowid claims");
  const heads = results[names.length + 4].results as Array<{ invalid_count: number }>;
  if (heads.length !== 1 || heads[0].invalid_count !== 0) throw new Error("Complete shadow export found inconsistent current source heads");
  const rowidValues: Record<string, string[]> = {};
  const physicalTables = Object.fromEntries(names.map((name, index) => [name, results[index].results.map((value) => {
    if (!FILE_SHADOW_SOURCE_TABLE_NAMES.includes(name)) return value;
    const { __archive_source_rowid: rowid, ...row } = value as Record<string, unknown>;
    (rowidValues[name] ??= []).push(String(rowid)); return row;
  })])) as ExportTables;
  const schema: ObservedExportSchema = {
    version: 1, kind: "observed-sqlite-schema",
    objects: results[names.length].results as unknown as ObservedExportSchema["objects"],
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
  return validateFullExportV15({ schemaVersion: FULL_EXPORT_ARCHIVE_SCHEMA_V15,
    archiveProfile: FULL_EXPORT_ARCHIVE_PROFILE_V15, archiveWriter: FULL_EXPORT_ARCHIVE_WRITER,
    exportedAt: new Date().toISOString(), tables: projected.tables,
    blobs: buildFileShadowBlobExportPlan(physicalTables), artifacts: { sourceSchema, retiredFields, sourceRowids } });
}
