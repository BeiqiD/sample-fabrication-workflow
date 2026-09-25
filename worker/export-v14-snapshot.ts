import { FULL_EXPORT_ARCHIVE_PROFILE_V14, FULL_EXPORT_ARCHIVE_SCHEMA_V14, FULL_EXPORT_ARCHIVE_WRITER, type ExportTables, type FullExportManifestV14, type ObservedExportSchema } from "../shared/contracts/export";
import { projectCompatibilitySnapshot } from "../shared/contracts/export-compatibility";
import { createExportArtifact, EXPORT_RETIRED_FIELDS_PATH, EXPORT_SOURCE_SCHEMA_PATH, validateFullExportV14 } from "../shared/contracts/export-protocol";
import { FILE_REGISTRY_ROWID_CLAIMS_INTEGRITY_SQL } from "../shared/contracts/export-file-authority";
import { FULL_EXPORT_V14_TABLE_QUERIES } from "./export-catalog";
import { buildBlobExportPlan } from "./export-data";

// V14 deliberately keeps the legacy locator planner while the transition is
// in legacy mode. File locations cannot become byte authority until a later,
// separately negotiated publication gate.
export async function snapshotFullExportV14(database: D1Database): Promise<FullExportManifestV14> {
  const names = Object.keys(FULL_EXPORT_V14_TABLE_QUERIES);
  const queries = Object.entries(FULL_EXPORT_V14_TABLE_QUERIES).map(([name, sql]) => name === "samples"
    ? "SELECT * FROM samples ORDER BY created_at, id"
    : name === "run_step_comments" ? "SELECT * FROM run_step_comments ORDER BY run_step_id, created_at, id" : sql);
  const results = await database.batch([
    ...queries.map((sql) => database.prepare(sql)),
    database.prepare("SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema ORDER BY type, name"),
    database.prepare("SELECT name FROM pragma_table_xinfo('samples') ORDER BY cid"),
    database.prepare("SELECT name FROM pragma_table_xinfo('run_step_comments') ORDER BY cid"),
    database.prepare(FILE_REGISTRY_ROWID_CLAIMS_INTEGRITY_SQL),
  ]);
  if (results.length !== names.length + 4 || results.some((result) => !result.success || !Array.isArray(result.results))) {
    throw new Error("Complete export snapshot was incomplete");
  }
  const claimIntegrity = results[names.length + 3].results as Array<{ invalid_count: number }>;
  if (claimIntegrity.length !== 1 || claimIntegrity[0].invalid_count !== 0) {
    throw new Error("Complete export snapshot found invalid File registry rowid claims");
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
  const projected = projectCompatibilitySnapshot(physicalTables, schema, "file-authority-v14");
  const [sourceSchema, retiredFields] = await Promise.all([
    createExportArtifact(EXPORT_SOURCE_SCHEMA_PATH, schema),
    createExportArtifact(EXPORT_RETIRED_FIELDS_PATH, projected.retiredFields),
  ]);
  return validateFullExportV14({
    archiveProfile: FULL_EXPORT_ARCHIVE_PROFILE_V14,
    schemaVersion: FULL_EXPORT_ARCHIVE_SCHEMA_V14,
    archiveWriter: FULL_EXPORT_ARCHIVE_WRITER,
    exportedAt: new Date().toISOString(),
    tables: projected.tables,
    blobs: buildBlobExportPlan(physicalTables),
    artifacts: { sourceSchema, retiredFields },
  });
}
