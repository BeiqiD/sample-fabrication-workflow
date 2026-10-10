import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { decodeReferenceRouteId } from "../shared/reference-destinations";
import { isReferenceTarget } from "../shared/reference-types";
import { safeMediaResponseHeaders } from "./media-response";
import { getBlob } from "./blob-lifecycle/storage";
import { readFileAuthorityMode, readPublishedFile } from "./files/authority-reader";
import { primaryD1 } from "./d1-primary";
import { hasRecoveryAssetAliasEvidence, qualifiedRecoveryLegacyAssetAliasSql } from "./files/native-asset-alias";
import type { FilePurpose } from "../shared/contracts/files";
import { referenceReadHandlers } from "./references/read-worker";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };

type MediaSource = {
  r2_key: string;
  original_name: string;
  mime_type: string;
  file_id?: string | null;
  purpose?: FilePurpose;
};

export const routes = new Hono<AppBindings>();

/** Native aliases have their own route namespace. The historical /assets/*
 * route continues to interpret every opaque string as its original R2 key.
 * The alias records original placement evidence; reads always use the File's
 * current usable location, including a later migration to another provider. */
routes.get("/file-assets/:assetId", async (c) => {
  const assetId = c.req.param("assetId");
  if (!assetId || assetId.length > 256 || assetId.includes("\0")) throw new HTTPException(400, { message: "A valid File asset identifier is required" });
  const active = await readFileAuthorityMode(c.env.DB).catch(() => {
    throw new HTTPException(503, { message: "File storage is unavailable" });
  }) === "active";
  if (!active) throw new HTTPException(404, { message: "File asset not found" });
  const source = await primaryD1(c.env.DB).prepare(`SELECT a.original_name,a.mime_type,f.file_id,f.purpose
    FROM assets a JOIN file_usable_publications f ON f.file_id=a.file_id
    JOIN storage_profiles recorded_profile ON recorded_profile.id=a.storage_profile_id
      AND recorded_profile.configuration_revision=a.storage_profile_revision AND recorded_profile.adapter_type='s3'
    WHERE a.id=? AND a.r2_key IS NULL AND a.status='ready' AND f.access_scope='system'
      AND f.verified_sha256=a.sha256 AND f.verified_byte_size=a.byte_size
      AND (a.import_id IS NULL OR EXISTS(SELECT 1 FROM imports i WHERE i.id=a.import_id AND i.status='ready'))
      AND EXISTS(SELECT 1 FROM file_location_publications recorded WHERE recorded.file_id=a.file_id
        AND recorded.storage_profile_id=a.storage_profile_id AND recorded.object_key=a.object_key
        AND recorded.verified_sha256=a.sha256 AND recorded.verified_byte_size=a.byte_size)`)
    .bind(assetId).first<{ original_name: string; mime_type: string; file_id: string; purpose: FilePurpose }>();
  if (!source) throw new HTTPException(404, { message: "File asset not found" });
  const object = await readPublishedFile(c.env, { fileId: source.file_id, purpose: source.purpose });
  if (object.outcome === "missing") throw new HTTPException(404, { message: "File asset not found" });
  if (object.outcome !== "available") throw new HTTPException(503, { message: "File storage is unavailable" });
  const headers = new Headers(object.httpMetadata);
  safeMediaResponseHeaders({ headers, mimeType: source.mime_type, filename: source.original_name || "asset",
    cacheControl: "private, no-store", etag: object.etag });
  return new Response(object.body, { headers });
});

// Ordinary assets and reference media use the same fail-closed response policy.
routes.get("/assets/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const active = await readFileAuthorityMode(c.env.DB).catch(() => {
    throw new HTTPException(503, { message: "File storage is unavailable" });
  }) === "active";
  // Existing media URLs retain their authorized asset identity. In active mode,
  // resolve that identity through a bound consumer or completed upload receipt;
  // the old key is never read.
  let source = active ? await primaryD1(c.env.DB).prepare(`
    WITH bindings(file_id,object_key,expected_purpose) AS (
      SELECT file_id,legacy_r2_object_key,expected_purpose FROM file_consumer_projection
      UNION ALL
      SELECT candidate.result_file_id,json_extract(receipt.accepted_result_json,'$.key'),receipt.purpose
      FROM file_acceptance_candidates candidate
      JOIN r2_upload_requests receipt ON receipt.id=candidate.acceptance_id
      WHERE candidate.acceptance_kind='r2_upload' AND candidate.state='ready' AND receipt.status='ready'
    )
    SELECT a.r2_key, a.original_name, a.mime_type, f.file_id, f.purpose
    FROM assets a
    JOIN bindings consumer ON consumer.object_key=a.r2_key
    JOIN file_usable_publications f ON f.file_id=consumer.file_id
    WHERE a.r2_key=? AND a.status='ready' AND f.access_scope='system'
      AND f.verified_byte_size=a.byte_size AND f.verified_sha256=a.sha256
      AND (consumer.expected_purpose IS NULL OR consumer.expected_purpose=f.purpose)
      AND (a.import_id IS NULL OR EXISTS (
        SELECT 1 FROM imports i WHERE i.id=a.import_id AND i.status='ready'))
    ORDER BY f.file_id LIMIT 1
  `).bind(key).first<MediaSource>() : await c.env.DB.prepare(`
    SELECT a.r2_key, a.original_name, a.mime_type
    FROM assets a
    WHERE a.r2_key = ?
      AND a.status = 'ready'
      AND (
        a.import_id IS NULL
        OR EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = a.import_id AND i.status = 'ready'
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2'
          AND bg.provider = 'r2'
          AND bg.object_key = a.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2'
          AND biq.provider = 'r2'
          AND biq.object_key = a.r2_key
      )
    LIMIT 1
  `).bind(key).first<MediaSource>();
  // Original candidate/consumer admission remains the first path. Only an
  // exact portable recovery receipt can expose an otherwise unbound historical
  // alias or authenticate bytes whose original metadata hash was NULL.
  if (!source && active && await hasRecoveryAssetAliasEvidence(primaryD1(c.env.DB))) {
    source = await primaryD1(c.env.DB).prepare(`SELECT a.r2_key,a.original_name,a.mime_type,f.file_id,f.purpose
      FROM assets a JOIN file_usable_publications f ON f.file_id=a.file_id
      WHERE a.r2_key=? AND a.status='ready' AND f.access_scope='system'
        AND(a.import_id IS NULL OR EXISTS(SELECT 1 FROM imports i WHERE i.id=a.import_id AND i.status='ready'))
        AND ${qualifiedRecoveryLegacyAssetAliasSql("a", "f")}
      ORDER BY f.file_id LIMIT 1`).bind(key).first<MediaSource>();
  }
  if (!source) throw new HTTPException(404, { message: "Asset not found" });

  const object = active ? await readPublishedFile(c.env, {
    fileId: source.file_id ?? null, purpose: source.purpose!,
  }) : await getBlob(c.env, {
    storeKind: "r2", provider: "r2", objectKey: source.r2_key, blobRecordId: null,
  });
  if (object.outcome === "missing") throw new HTTPException(404, { message: "Asset not found" });
  if (object.outcome !== "available") {
    throw new HTTPException(503, { message: active ? "File storage is unavailable" : "R2 is unavailable" });
  }

  const headers = new Headers(object.httpMetadata);
  safeMediaResponseHeaders({
    headers,
    mimeType: source.mime_type,
    filename: source.original_name || "asset",
    cacheControl: "private, max-age=3600",
    etag: object.etag,
  });
  return new Response(object.body, { headers });
});

routes.post("/references/resolve", referenceReadHandlers.captureIngressRequest, referenceReadHandlers.resolve);
routes.post("/references/children", referenceReadHandlers.captureIngressRequest, referenceReadHandlers.children);
routes.post("/references/search", referenceReadHandlers.captureIngressRequest, referenceReadHandlers.search);

routes.get("/references/media/execution_image/:encodedId", async (c) => {
  const id = decodeReferenceRouteId(c.req.param("encodedId"));
  const stepId = c.req.query("step") ?? "";
  if (id === null || !id || id.trim() !== id) {
    throw new HTTPException(400, { message: "A valid execution-image reference ID is required" });
  }
  if (!isReferenceTarget({ type: "run_step", id: stepId }) || stepId.trim() !== stepId) {
    throw new HTTPException(400, { message: "A valid Run Step context is required" });
  }

  const active = await readFileAuthorityMode(c.env.DB).catch(() => {
    throw new HTTPException(503, { message: "File storage is unavailable" });
  }) === "active";
  const source = await primaryD1(c.env.DB).prepare(`
    SELECT a.r2_key, a.original_name, a.mime_type, effective_occurrence.file_id
    FROM run_step_assets origin
    LEFT JOIN run_step_assets successor
      ON successor.id = origin.superseded_by_occurrence_id
    JOIN run_step_assets effective_occurrence
      ON effective_occurrence.id = COALESCE(successor.id, origin.id)
    JOIN assets a
      ON a.id = effective_occurrence.asset_id AND a.status = 'ready'
    JOIN run_steps rs
      ON rs.id = effective_occurrence.run_step_id AND rs.deleted_at IS NULL
    JOIN runs r ON r.id = rs.run_id AND r.deleted_at IS NULL
    JOIN samples s ON s.id = r.sample_id AND s.deleted_at IS NULL
    WHERE origin.id = ?
      AND rs.id = ?
      AND origin.role = 'execution'
      AND effective_occurrence.role = 'execution'
      AND effective_occurrence.deleted_at IS NULL
      AND effective_occurrence.superseded_by_occurrence_id IS NULL
      AND (
        a.import_id IS NULL
        OR EXISTS (
          SELECT 1 FROM imports i
          WHERE i.id = a.import_id AND i.status = 'ready'
        )
      )
      AND (?=1 OR NOT EXISTS (
        SELECT 1
        FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2'
          AND bg.provider = 'r2'
          AND bg.object_key = a.r2_key
          AND bg.state IN ('deleting', 'deleted')
      ))
      AND (?=1 OR NOT EXISTS (
        SELECT 1
        FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2'
          AND biq.provider = 'r2'
          AND biq.object_key = a.r2_key
      ))
  `).bind(id, stepId, active ? 1 : 0, active ? 1 : 0).first<MediaSource>();
  if (!source) {
    throw new HTTPException(404, { message: "Execution image not found in this Step context" });
  }

  const object = active ? await readPublishedFile(c.env, {
    fileId: source.file_id ?? null, purpose: "embedded_content",
  }) : await getBlob(c.env, {
    storeKind: "r2", provider: "r2", objectKey: source.r2_key, blobRecordId: null,
  });
  if (object.outcome === "missing") throw new HTTPException(404, { message: "Execution image bytes are unavailable" });
  if (object.outcome !== "available") {
    throw new HTTPException(503, { message: active ? "File storage is unavailable" : "R2 is unavailable" });
  }

  const headers = new Headers(object.httpMetadata);
  safeMediaResponseHeaders({
    headers,
    mimeType: source.mime_type,
    filename: source.original_name || "execution-image",
    cacheControl: "private, no-store",
    etag: object.etag,
  });
  return new Response(object.body, { headers });
});
