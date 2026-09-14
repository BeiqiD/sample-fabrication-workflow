import { FULL_EXPORT_ARCHIVE_SCHEMA, FULL_EXPORT_ARCHIVE_PROFILE, FULL_EXPORT_ARCHIVE_WRITER, type ExportTables, type FullExportManifestV12, type ObservedExportSchema } from "../shared/contracts/export";
import { projectCompatibilitySnapshot } from "../shared/contracts/export-compatibility";
import { createExportArtifact, validateFullExportV12, EXPORT_RETIRED_FIELDS_PATH, EXPORT_SOURCE_SCHEMA_PATH } from "../shared/contracts/export-protocol";
import { FULL_EXPORT_TABLE_QUERIES } from "./export-catalog";
import { buildBlobExportPlan } from "./export-data";

// The negotiated route and browser writer share this complete snapshot contract.
export async function snapshotFullExportV12(database: D1Database): Promise<FullExportManifestV12> {
  const names = Object.keys(FULL_EXPORT_TABLE_QUERIES);
  const queries = Object.entries(FULL_EXPORT_TABLE_QUERIES).map(([name, sql]) => name === "samples"
    ? "SELECT * FROM samples ORDER BY created_at, id"
    : name === "run_step_comments" ? "SELECT * FROM run_step_comments ORDER BY run_step_id, created_at, id" : sql);
  const results = await database.batch([
    ...queries.map((sql) => database.prepare(sql)),
    database.prepare("SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema ORDER BY type, name"),
    database.prepare("SELECT name FROM pragma_table_xinfo('samples') ORDER BY cid"),
    database.prepare("SELECT name FROM pragma_table_xinfo('run_step_comments') ORDER BY cid"),
  ]);
  if (results.length !== names.length + 3 || results.some((result) => !result.success || !Array.isArray(result.results))) {
    throw new Error("Complete export snapshot was incomplete");
  }
  const physicalTables = Object.fromEntries(names.map((name, index) => [name, results[index].results])) as ExportTables;
  const schema: ObservedExportSchema = {
    version: 1, kind: "observed-sqlite-schema",
    objects: results[names.length].results as unknown as ObservedExportSchema["objects"],
    compatibilityColumns: {
      samples: results[names.length + 1].results.map((row) => String((row as { name: string }).name)),
      run_step_comments: results[names.length + 2].results.map((row) => String((row as { name: string }).name)),
    },
  };
  const projected = projectCompatibilitySnapshot(physicalTables, schema);
  const [sourceSchema, retiredFields] = await Promise.all([
    createExportArtifact(EXPORT_SOURCE_SCHEMA_PATH, schema),
    createExportArtifact(EXPORT_RETIRED_FIELDS_PATH, projected.retiredFields),
  ]);
  return validateFullExportV12({
    archiveProfile: FULL_EXPORT_ARCHIVE_PROFILE,
    schemaVersion: FULL_EXPORT_ARCHIVE_SCHEMA,
    archiveWriter: FULL_EXPORT_ARCHIVE_WRITER,
    exportedAt: new Date().toISOString(),
    tables: projected.tables,
    blobs: buildBlobExportPlan(physicalTables),
    artifacts: { sourceSchema, retiredFields },
  });
}
