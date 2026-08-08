import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { decodeReferenceRouteId } from "../shared/reference-destinations";
import {
  isReferenceTarget,
  MAX_REFERENCE_RESOLUTION_TARGETS,
  type ResolveReferencesInput,
  type ResolveReferencesResponse,
} from "../shared/reference-types";
import {
  ReferenceResolutionInputError,
  resolveReferences,
} from "./references/resolver";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };

export const routes = new Hono<AppBindings>();

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

routes.get("/references/media/execution_image/:encodedId", async (c) => {
  const id = decodeReferenceRouteId(c.req.param("encodedId"));
  if (id === null || !id || id.trim() !== id) {
    throw new HTTPException(400, { message: "A valid execution-image reference ID is required" });
  }

  const source = await c.env.DB.prepare(`
    SELECT a.r2_key, a.original_name, a.mime_type
    FROM run_step_assets rsa
    JOIN assets a ON a.id = rsa.asset_id AND a.status = 'ready'
    JOIN run_steps rs ON rs.id = rsa.run_step_id AND rs.deleted_at IS NULL
    JOIN runs r ON r.id = rs.run_id AND r.deleted_at IS NULL
    JOIN samples s ON s.id = r.sample_id AND s.deleted_at IS NULL
    WHERE rsa.id = ?
      AND rsa.role = 'execution'
      AND rsa.deleted_at IS NULL
  `).bind(id).first<{
    r2_key: string;
    original_name: string;
    mime_type: string;
  }>();
  if (!source) throw new HTTPException(404, { message: "Execution image not found" });

  const object = await c.env.ASSETS.get(source.r2_key);
  if (!object) throw new HTTPException(404, { message: "Execution image bytes are unavailable" });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", source.mime_type || headers.get("content-type") || "application/octet-stream");
  headers.set(
    "content-disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(source.original_name || "execution-image")}`,
  );
  headers.set("cache-control", "private, no-store");
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
});
