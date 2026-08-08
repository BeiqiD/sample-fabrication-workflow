import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  isReferenceTarget,
  MAX_REFERENCE_RESOLUTION_TARGETS,
  type ResolveReferencesInput,
  type ResolveReferencesResponse,
} from "../shared/reference-types";
import { resolveReferences } from "./references/resolver";
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
  const response: ResolveReferencesResponse = {
    results: await resolveReferences(c.env.DB, targets),
  };
  return c.json(response);
});
