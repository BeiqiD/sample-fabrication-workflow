import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
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

export default {
  async fetch(request: Request, env: Env, executionContext: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/references/")) {
      return referenceApp.fetch(request, env, executionContext);
    }
    return core.fetch(request, env, executionContext);
  },
  scheduled(event: ScheduledController, env: Env, executionContext: ExecutionContext) {
    return core.scheduled(event, env, executionContext);
  },
} satisfies ExportedHandler<Env>;
