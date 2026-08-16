import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { decodeReferenceRouteId } from "../shared/reference-destinations";
import type { SearchReferencesResponse } from "../shared/reference-search";
import {
  isReferenceTarget,
  MAX_REFERENCE_RESOLUTION_TARGETS,
  type ResolveReferencesInput,
  type ResolveReferencesResponse,
} from "../shared/reference-types";
import { safeMediaResponseHeaders } from "./media-response";
import {
  ReferenceResolutionInputError,
  resolveReferences,
} from "./references/resolver";
import {
  ReferenceSearchInputError,
  searchReferences,
} from "./references/search";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };

type MediaSource = {
  r2_key: string;
  original_name: string;
  mime_type: string;
};

export const routes = new Hono<AppBindings>();

// Ordinary assets and reference media use the same fail-closed response policy.
routes.get("/assets/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const source = await c.env.DB.prepare(`
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
  if (!source) throw new HTTPException(404, { message: "Asset not found" });

  const object = await c.env.ASSETS.get(source.r2_key);
  if (!object) throw new HTTPException(404, { message: "Asset not found" });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  safeMediaResponseHeaders({
    headers,
    mimeType: source.mime_type,
    filename: source.original_name || "asset",
    cacheControl: "private, max-age=3600",
    etag: object.httpEtag,
  });
  return new Response(object.body, { headers });
});

routes.post("/references/resolve", async (c) => {
  let input: unknown;
  try {
    input = await c.req.json<unknown>();
  } catch {
    throw new HTTPException(400, { message: "A valid JSON request body is required" });
  }
  if (!input || typeof input !== "object" || !Array.isArray((input as Partial<ResolveReferencesInput>).targets)) {
    throw new HTTPException(400, { message: "Reference targets are required" });
  }

  const targets = (input as Partial<ResolveReferencesInput>).targets!;
  if (targets.length < 1 || targets.length > MAX_REFERENCE_RESOLUTION_TARGETS) {
    throw new HTTPException(400, {
      message: `Between 1 and ${MAX_REFERENCE_RESOLUTION_TARGETS} reference targets are required`,
    });
  }
  if (!targets.every((target) => isReferenceTarget(target) && target.id.trim() === target.id)) {
    throw new HTTPException(400, { message: "Every reference target needs a known type and valid stable ID" });
  }

  try {
    const response: ResolveReferencesResponse = {
      results: await resolveReferences(c.env.DB, targets),
    };
    return c.json(response);
  } catch (error) {
    if (error instanceof ReferenceResolutionInputError) {
      throw new HTTPException(400, { message: error.message });
    }
    throw error;
  }
});

routes.post("/references/search", async (c) => {
  let input: unknown;
  try {
    input = await c.req.json<unknown>();
  } catch {
    throw new HTTPException(400, { message: "A valid JSON request body is required" });
  }

  try {
    const response: SearchReferencesResponse = await searchReferences(c.env.DB, input);
    return c.json(response);
  } catch (error) {
    if (error instanceof ReferenceSearchInputError) {
      throw new HTTPException(400, { message: error.message });
    }
    throw error;
  }
});

routes.get("/references/media/execution_image/:encodedId", async (c) => {
  const id = decodeReferenceRouteId(c.req.param("encodedId"));
  const stepId = c.req.query("step") ?? "";
  if (id === null || !id || id.trim() !== id) {
    throw new HTTPException(400, { message: "A valid execution-image reference ID is required" });
  }
  if (!isReferenceTarget({ type: "run_step", id: stepId }) || stepId.trim() !== stepId) {
    throw new HTTPException(400, { message: "A valid Run Step context is required" });
  }

  const source = await c.env.DB.prepare(`
    SELECT a.r2_key, a.original_name, a.mime_type
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
  `).bind(id, stepId).first<MediaSource>();
  if (!source) {
    throw new HTTPException(404, { message: "Execution image not found in this Step context" });
  }

  const object = await c.env.ASSETS.get(source.r2_key);
  if (!object) throw new HTTPException(404, { message: "Execution image bytes are unavailable" });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  safeMediaResponseHeaders({
    headers,
    mimeType: source.mime_type,
    filename: source.original_name || "execution-image",
    cacheControl: "private, no-store",
    etag: object.httpEtag,
  });
  return new Response(object.body, { headers });
});
