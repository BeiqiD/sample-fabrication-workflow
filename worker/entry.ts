import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { FullExportManifest } from "../shared/types";
import { authenticateRequest } from "./auth";
import core from "./index";
import { routes as referenceRoutes } from "./reference-routes";
import { sameOriginOrNonBrowser } from "./request-guards";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };

const referenceApp = new Hono<AppBindings>().basePath("/api");

referenceApp.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  console.error(error);
  return c.json({ error: "Unexpected server error" }, 500);
});

referenceApp.use("*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !sameOriginOrNonBrowser(c.req.raw)) {
    return c.json({ error: "Cross-origin writes are not allowed" }, 403);
  }
  try {
    const identity = await authenticateRequest(c.req.raw, c.env);
    c.set("userEmail", identity.email);
    await next();
  } catch (error) {
    console.warn("Authentication rejected", error);
    return c.json({ error: "Authentication required" }, 403);
  }
});

referenceApp.route("/", referenceRoutes);

async function withReferenceTargetExport(response: Response, env: Env) {
  if (!response.ok) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const manifest = await response.json() as FullExportManifest;
  const referenceTargets = await env.DB.prepare(
    `SELECT * FROM reference_targets
     ORDER BY target_type, target_id`,
  ).all<Record<string, unknown>>();
  manifest.tables.reference_targets = referenceTargets.results;

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=UTF-8");
  return new Response(JSON.stringify(manifest), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env, executionContext: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/references/")) {
      return referenceApp.fetch(request, env, executionContext);
    }

    const response = await core.fetch(request, env, executionContext);
    if (request.method === "GET" && url.pathname === "/api/exports/all") {
      return withReferenceTargetExport(response, env);
    }
    return response;
  },
  scheduled(event: ScheduledController, env: Env, executionContext: ExecutionContext) {
    return core.scheduled(event, env, executionContext);
  },
} satisfies ExportedHandler<Env>;
