import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { supportedExportRequest } from "../shared/contracts/export-protocol";
import { snapshotFullExportV8 } from "./export-v8-snapshot";
import { snapshotFullExportV9 } from "./export-v9-snapshot";
import { snapshotFullExportV10 } from "./export-v10-snapshot";
import { getBlob } from "./blob-lifecycle/storage";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };

// Snapshot and byte delivery stay at their original registration positions in
// the root Worker, with authentication and error handling owned by that root.
export const snapshotRoutes = new Hono<AppBindings>();
export const blobRoutes = new Hono<AppBindings>();

snapshotRoutes.get("/exports/all", async (c) => {
  if (!supportedExportRequest(new URL(c.req.url))) {
    throw new HTTPException(409, { message: "This archive writer is out of date. Refresh the page and download the full ZIP again." });
  }
  try {
    if (c.req.query("archiveSchema") === "10") return c.json(await snapshotFullExportV10(c.env.DB));
    if (c.req.query("archiveSchema") === "9") return c.json(await snapshotFullExportV9(c.env.DB));
    return c.json(await snapshotFullExportV8(c.env.DB));
  }
  catch (error) {
    if (error instanceof Error && /requires archive schema (9|10)/.test(error.message)) {
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
