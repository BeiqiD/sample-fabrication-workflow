import { Hono, type ErrorHandler, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { authenticateRequest } from "../auth";
import { sameOriginOrNonBrowser } from "../request-guards";
import { ASSET_OWNING_IMPORT_NOT_READY_SQL_ERROR, TEMPLATE_VERSION_NOT_PUBLISHED_SQL_ERROR } from "../template-publication";
import { managedStorageStatus } from "../managed-storage";
import type { Env } from "../types";

type ApiEnv = { Bindings: Env; Variables: { userEmail: string } };

export const routes = new Hono<ApiEnv>();

function blobLocatorConflict(error: unknown): "unavailable" | "quarantined" | null {
  const message = String(error);
  if (message.includes("blob locator is quarantined")) return "quarantined";
  if (message.includes("blob locator is unavailable")) return "unavailable";
  return null;
}

function publicationBoundaryConflict(error: unknown): "template" | "asset" | null {
  const message = String(error);
  if (message.includes(TEMPLATE_VERSION_NOT_PUBLISHED_SQL_ERROR)) return "template";
  if (message.includes(ASSET_OWNING_IMPORT_NOT_READY_SQL_ERROR)) return "asset";
  return null;
}

export const handleError: ErrorHandler<ApiEnv> = (error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  const locatorConflict = blobLocatorConflict(error);
  if (locatorConflict === "quarantined") {
    return c.json({
      error: "The selected file failed an integrity check. Upload a verified replacement.",
    }, 409);
  }
  if (locatorConflict === "unavailable") {
    return c.json({ error: "The selected file is being cleaned up. Retry with a new upload." }, 409);
  }
  const publicationConflict = publicationBoundaryConflict(error);
  if (publicationConflict === "template") {
    return c.json({ error: "The selected template import has not been published yet." }, 409);
  }
  if (publicationConflict === "asset") {
    return c.json({ error: "The selected imported file has not been published yet." }, 409);
  }
  console.error(error);
  return c.json({ error: "Unexpected server error" }, 500);
};

export const authenticateApiRequest: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (c.req.path === "/api/health") return next();
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
};

routes.get("/health", (c) => c.json({ ok: true }));

routes.get("/ready", async (c) => {
  const checks: Promise<unknown>[] = [
    c.env.DB.prepare("SELECT 1 AS ok").first(),
    c.env.ASSETS.list({ limit: 1 }),
  ];
  if (c.env.MANAGED_STORAGE_PROVIDER) {
    const storageStatus = await managedStorageStatus(c.env);
    if (!storageStatus.available) throw new HTTPException(503, { message: storageStatus.message });
  }
  await Promise.all(checks);
  return c.json({ ok: true });
});
