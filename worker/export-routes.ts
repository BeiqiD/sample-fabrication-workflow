import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { PROJECT_EXPORT_SCHEMA_VERSION } from "../shared/project-types";
import { getBlob } from "./blob-lifecycle/storage";
import { FULL_EXPORT_TABLE_QUERIES } from "./export-catalog";
import { buildBlobExportPlan } from "./export-data";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };
type ExportRow = Record<string, unknown>;

// Snapshot and byte delivery stay at their original registration positions in
// the root Worker, with authentication and error handling owned by that root.
export const snapshotRoutes = new Hono<AppBindings>();
export const blobRoutes = new Hono<AppBindings>();

snapshotRoutes.get("/exports/all", async (c) => {
  const names = Object.keys(FULL_EXPORT_TABLE_QUERIES);
  const results = await c.env.DB.batch(
    Object.values(FULL_EXPORT_TABLE_QUERIES).map((sql) => c.env.DB.prepare(sql)),
  );
  const entries = names.map((name, index) => [name, results[index].results ?? []] as const);
  const tables = Object.fromEntries(entries) as Record<string, ExportRow[]>;
  return c.json({
    schemaVersion: PROJECT_EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    tables,
    blobs: buildBlobExportPlan(tables),
  });
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
