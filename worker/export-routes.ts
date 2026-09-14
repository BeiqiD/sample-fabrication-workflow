import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { supportedExportRequest } from "../shared/contracts/export-protocol";
import { FILE_FOUNDATION_EXPORT_COLUMNS } from "../shared/contracts/export-file-foundation";
import { IMPORT_ACCEPTANCE_EXPORT_COLUMNS } from "../shared/contracts/export-import-acceptance";
import { R2_UPLOAD_ACCEPTANCE_EXPORT_COLUMNS } from "../shared/contracts/export-r2-upload-acceptance";
import { METROLOGY_REFERENCE_ACCEPTANCE_EXPORT_COLUMNS } from "../shared/contracts/export-metrology-reference-acceptance";
import { COMMENT_ACCEPTANCE_EXPORT_COLUMNS } from "../shared/contracts/export-comment-acceptance";
import { FILE_AUTHORITY_CONSUMER_COLUMNS, FILE_AUTHORITY_EXPORT_COLUMNS } from "../shared/contracts/export-file-authority";
import { snapshotFullExportV8 } from "./export-v8-snapshot";
import { snapshotFullExportV9 } from "./export-v9-snapshot";
import { snapshotFullExportV13 } from "./export-v13-snapshot";
import { snapshotFullExportV14 } from "./export-v14-snapshot";
import { snapshotFullExportV12 } from "./export-v12-snapshot";
import { snapshotFullExportV11 } from "./export-v11-snapshot";
import { snapshotFullExportV10 } from "./export-v10-snapshot";
import { getBlob } from "./blob-lifecycle/storage";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };

// Snapshot and byte delivery stay at their original registration positions in
// the root Worker, with authentication and error handling owned by that root.
export const snapshotRoutes = new Hono<AppBindings>();
export const blobRoutes = new Hono<AppBindings>();

type SchemaObjectType = "table" | "index" | "trigger" | "view";
type SchemaMarker = readonly [SchemaObjectType, string];

const BASE_EXPORT_MARKERS = [
  ["table", "samples"], ["table", "imports"], ["table", "run_step_comments"],
  ["table", "blob_gc_ledger"], ["view", "blob_retention_edges"],
] as const satisfies readonly SchemaMarker[];
const FILE_FOUNDATION_MARKERS = [
  ["table", "storage_profiles"], ["table", "files"], ["table", "file_locations"],
  ["table", "legacy_file_mappings"], ["index", "file_locations_file_idx"],
  ["trigger", "storage_profiles_immutable"], ["trigger", "files_immutable"],
  ["trigger", "file_locations_immutable"], ["trigger", "legacy_file_mappings_immutable"],
  ["trigger", "legacy_file_mappings_profile_guard"], ["trigger", "storage_profiles_insert_identity_guard"],
  ["trigger", "storage_profiles_delete_guard"], ["trigger", "files_insert_identity_guard"],
  ["trigger", "files_delete_guard"], ["trigger", "file_locations_insert_identity_guard"],
  ["trigger", "file_locations_delete_guard"], ["trigger", "legacy_file_mappings_insert_identity_guard"],
  ["trigger", "legacy_file_mappings_delete_guard"],
] as const satisfies readonly SchemaMarker[];
const IMPORT_ACCEPTANCE_MARKERS = [
  ["index", "imports_accepted_request_idx"], ["trigger", "imports_acceptance_insert_guard"],
  ["trigger", "imports_acceptance_update_guard"], ["trigger", "imports_acceptance_publication_guard"],
  ["trigger", "imports_acceptance_delete_guard"],
] as const satisfies readonly SchemaMarker[];
const R2_ACCEPTANCE_MARKERS = [
  ["table", "r2_upload_requests"], ["trigger", "r2_upload_requests_insert_guard"],
  ["trigger", "r2_upload_requests_update_guard"], ["trigger", "r2_upload_requests_publication_guard"],
  ["trigger", "r2_upload_requests_delete_guard"],
] as const satisfies readonly SchemaMarker[];
const METROLOGY_ACCEPTANCE_MARKERS = [
  ["table", "metrology_reference_upload_requests"],
  ["trigger", "metrology_reference_upload_requests_insert_guard"],
  ["trigger", "metrology_reference_upload_requests_update_guard"],
  ["trigger", "metrology_reference_upload_requests_publication_guard"],
  ["trigger", "metrology_reference_upload_requests_delete_guard"],
] as const satisfies readonly SchemaMarker[];
const COMMENT_ACCEPTANCE_MARKERS = [
  ["table", "comment_submission_acceptances"], ["table", "comment_item_acceptances"],
  ["trigger", "comment_submission_acceptances_insert_guard"],
  ["trigger", "comment_submission_acceptances_update_guard"],
  ["trigger", "comment_submission_acceptances_publication_guard"],
  ["trigger", "comment_submission_acceptances_delete_guard"],
  ["trigger", "comment_item_acceptances_insert_guard"],
  ["trigger", "comment_item_acceptances_update_guard"],
  ["trigger", "comment_item_acceptances_publication_guard"],
  ["trigger", "comment_item_acceptances_delete_guard"],
  ["trigger", "comment_accepted_submission_identity_guard"],
  ["trigger", "comment_accepted_submission_cancel"], ["trigger", "comment_accepted_item_cancel"],
  ["trigger", "comment_accepted_submission_replace_guard"], ["trigger", "comment_accepted_item_replace_guard"],
  ["trigger", "comment_accepted_target_replace_guard"], ["trigger", "comment_accepted_target_update_guard"],
  ["trigger", "comment_accepted_target_delete_guard"], ["trigger", "comment_accepted_item_identity_guard"],
] as const satisfies readonly SchemaMarker[];

function sqlLiteral(value: string) { return `'${value.replaceAll("'", "''")}'`; }
function markerCountSql(markers: readonly SchemaMarker[]) {
  return `(SELECT count(*) FROM sqlite_schema WHERE sql IS NOT NULL AND (${markers
    .map(([type, name]) => `(type = ${sqlLiteral(type)} AND name = ${sqlLiteral(name)})`).join(" OR ")}))`;
}
function columnCountSql(columns: Record<string, readonly string[]>) {
  return Object.entries(columns).map(([table, names]) =>
    `(SELECT count(*) FROM pragma_table_xinfo(${sqlLiteral(table)}) WHERE name IN (${names.map(sqlLiteral).join(", ")}))`,
  ).join(" + ");
}
function totalColumns(columns: Record<string, readonly string[]>) {
  return Object.values(columns).reduce((count, names) => count + names.length, 0);
}

const R2_ACCEPTANCE_COLUMNS = { r2_upload_requests: R2_UPLOAD_ACCEPTANCE_EXPORT_COLUMNS };
const METROLOGY_ACCEPTANCE_COLUMNS = { metrology_reference_upload_requests: METROLOGY_REFERENCE_ACCEPTANCE_EXPORT_COLUMNS };
const FILE_AUTHORITY_TABLE_MARKERS = Object.keys(FILE_AUTHORITY_EXPORT_COLUMNS)
  .map((name) => ["table", name] as const);
// This 0007-only guard is created after all authority tables, typed columns,
// views and primary lifecycle guards. A control/table-only partial execution
// must not be mistaken for the complete V14 generation.
const FILE_AUTHORITY_COMPLETION_MARKERS = [
  ["trigger", "template_versions_file_replace_guard"],
] as const satisfies readonly SchemaMarker[];

const EXPORT_SCHEMA_GENERATION_PROBE = `SELECT
  ${markerCountSql(BASE_EXPORT_MARKERS)} AS base_markers,
  ${markerCountSql(FILE_FOUNDATION_MARKERS)} AS foundation_markers,
  ${columnCountSql(FILE_FOUNDATION_EXPORT_COLUMNS)} AS foundation_columns,
  ${markerCountSql(IMPORT_ACCEPTANCE_MARKERS)} AS import_markers,
  ${columnCountSql({ imports: IMPORT_ACCEPTANCE_EXPORT_COLUMNS })} AS import_columns,
  ${markerCountSql(R2_ACCEPTANCE_MARKERS)} AS r2_markers,
  ${columnCountSql(R2_ACCEPTANCE_COLUMNS)} AS r2_columns,
  ${markerCountSql(METROLOGY_ACCEPTANCE_MARKERS)} AS metrology_markers,
  ${columnCountSql(METROLOGY_ACCEPTANCE_COLUMNS)} AS metrology_columns,
  ${markerCountSql(COMMENT_ACCEPTANCE_MARKERS)} AS comment_markers,
  ${columnCountSql(COMMENT_ACCEPTANCE_EXPORT_COLUMNS)} AS comment_columns,
  ${markerCountSql(FILE_AUTHORITY_TABLE_MARKERS)} AS authority_markers,
  ${columnCountSql(FILE_AUTHORITY_EXPORT_COLUMNS)} AS authority_columns,
  ${columnCountSql(FILE_AUTHORITY_CONSUMER_COLUMNS)} AS authority_consumer_columns,
  ${markerCountSql(FILE_AUTHORITY_COMPLETION_MARKERS)} AS authority_completion_markers`;

type ExportSchemaGenerationProbe = {
  base_markers: number;
  foundation_markers: number; foundation_columns: number;
  import_markers: number; import_columns: number;
  r2_markers: number; r2_columns: number;
  metrology_markers: number; metrology_columns: number;
  comment_markers: number; comment_columns: number;
  authority_markers: number; authority_columns: number; authority_consumer_columns: number;
  authority_completion_markers: number;
};

const COMPLETE_GENERATION_COUNTS = [
  BASE_EXPORT_MARKERS.length,
  FILE_FOUNDATION_MARKERS.length, totalColumns(FILE_FOUNDATION_EXPORT_COLUMNS),
  IMPORT_ACCEPTANCE_MARKERS.length, IMPORT_ACCEPTANCE_EXPORT_COLUMNS.length,
  R2_ACCEPTANCE_MARKERS.length, R2_UPLOAD_ACCEPTANCE_EXPORT_COLUMNS.length,
  METROLOGY_ACCEPTANCE_MARKERS.length, METROLOGY_REFERENCE_ACCEPTANCE_EXPORT_COLUMNS.length,
  COMMENT_ACCEPTANCE_MARKERS.length, totalColumns(COMMENT_ACCEPTANCE_EXPORT_COLUMNS),
  FILE_AUTHORITY_TABLE_MARKERS.length, totalColumns(FILE_AUTHORITY_EXPORT_COLUMNS),
  totalColumns(FILE_AUTHORITY_CONSUMER_COLUMNS), FILE_AUTHORITY_COMPLETION_MARKERS.length,
] as const;
const COMPLETE_FIELDS_BY_GENERATION = [1, 3, 5, 7, 9, 11, COMPLETE_GENERATION_COUNTS.length] as const;

function generationCounts(row: ExportSchemaGenerationProbe) {
  return [row.base_markers, row.foundation_markers, row.foundation_columns, row.import_markers, row.import_columns,
    row.r2_markers, row.r2_columns, row.metrology_markers, row.metrology_columns, row.comment_markers,
    row.comment_columns, row.authority_markers, row.authority_columns, row.authority_consumer_columns,
    row.authority_completion_markers];
}

async function installedExportSchema(database: D1Database) {
  const row = await database.prepare(EXPORT_SCHEMA_GENERATION_PROBE).first<ExportSchemaGenerationProbe>();
  if (!row || generationCounts(row).some((value) => !Number.isSafeInteger(value) || value < 0)) return null;
  const observed = generationCounts(row);
  for (let index = 6; index >= 0; index -= 1) {
    const version = index + 8;
    const expected = COMPLETE_GENERATION_COUNTS.map((value, position) =>
      position < COMPLETE_FIELDS_BY_GENERATION[index] ? value : 0);
    if (observed.every((value, position) => value === expected[position])) return version;
  }
  return null;
}

snapshotRoutes.get("/exports/all", async (c) => {
  if (!supportedExportRequest(new URL(c.req.url))) {
    throw new HTTPException(409, { message: "This archive writer is out of date. Refresh the page and download the full ZIP again." });
  }
  try {
    const requestedSchema = c.req.query("archiveSchema");
    const installedSchema = await installedExportSchema(c.env.DB);
    if (installedSchema === null) throw new Error("Installed export schema generation is incomplete or inconsistent");
    if (Number(requestedSchema) !== installedSchema) {
      throw new HTTPException(409, { message: "This archive writer is out of date. Refresh the page and download the full ZIP again." });
    }
    if (requestedSchema === "14") return c.json(await snapshotFullExportV14(c.env.DB));
    if (c.req.query("archiveSchema") === "13") return c.json(await snapshotFullExportV13(c.env.DB));
    if (c.req.query("archiveSchema") === "12") return c.json(await snapshotFullExportV12(c.env.DB));
    if (c.req.query("archiveSchema") === "11") return c.json(await snapshotFullExportV11(c.env.DB));
    if (c.req.query("archiveSchema") === "10") return c.json(await snapshotFullExportV10(c.env.DB));
    if (c.req.query("archiveSchema") === "9") return c.json(await snapshotFullExportV9(c.env.DB));
    return c.json(await snapshotFullExportV8(c.env.DB));
  }
  catch (error) {
    if (error instanceof Error && /requires archive schema (9|10|11|12|13|14)/.test(error.message)) {
      throw new HTTPException(409, { message: "This archive writer is out of date. Refresh the page and download the full ZIP again." });
    }
    throw error;
  }
});

blobRoutes.get("/exports/r2/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const registered = await c.env.DB.prepare(
    `SELECT 1 AS registered
     WHERE (
       EXISTS (SELECT 1 FROM assets WHERE r2_key = ?)
       OR EXISTS (SELECT 1 FROM imports WHERE workbook_asset_key = ? OR manifest_asset_key = ?)
       OR EXISTS (SELECT 1 FROM template_versions WHERE source_asset_key = ?)
       OR EXISTS (SELECT 1 FROM events WHERE asset_key = ?)
       OR EXISTS (
         SELECT 1 FROM blob_retention_edges
         WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = ?
       )
     )
     AND NOT EXISTS (
       SELECT 1 FROM blob_gc_ledger
       WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = ? AND state = 'deleted'
     )`,
  ).bind(key, key, key, key, key, key, key).first<{ registered: number }>();
  if (!registered) throw new HTTPException(404, { message: "Export blob not found" });
  const object = await getBlob(c.env, {
    storeKind: "r2", provider: "r2", objectKey: key, blobRecordId: null,
  });
  if (object.outcome === "missing") throw new HTTPException(404, { message: "Export blob is missing" });
  if (object.outcome === "provider_unavailable") {
    throw new HTTPException(503, { message: "R2 is unavailable" });
  }
  return new Response(object.body, {
    headers: {
      "content-type": object.contentType,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...(object.etag ? { etag: object.etag } : {}),
    },
  });
});

blobRoutes.get("/exports/managed/:objectId", async (c) => {
  const objectId = c.req.param("objectId");
  const row = await c.env.DB.prepare(
    `SELECT mso.id, mso.provider, mso.object_key, mso.mime_type
     FROM managed_storage_objects mso
     WHERE mso.id = ? AND mso.status IN ('ready', 'orphaned')
       AND NOT EXISTS (
         SELECT 1 FROM blob_gc_ledger bg
         WHERE bg.store_kind = 'managed' AND bg.provider = mso.provider
           AND bg.object_key = mso.object_key AND bg.state = 'deleted'
       )`,
  ).bind(objectId).first<{
    id: string; provider: string; object_key: string; mime_type: string;
  }>();
  if (!row) throw new HTTPException(404, { message: "Export blob not found" });
  const object = await getBlob(c.env, {
    storeKind: "managed",
    provider: row.provider,
    objectKey: row.object_key,
    blobRecordId: row.id,
  });
  if (object.outcome === "missing") throw new HTTPException(404, { message: "Export blob is missing" });
  if (object.outcome === "provider_unavailable") {
    throw new HTTPException(503, { message: "Managed storage is unavailable" });
  }
  return new Response(object.body, {
    headers: {
      "content-type": object.contentType || row.mime_type,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...(object.etag ? { etag: object.etag } : {}),
    },
  });
});
