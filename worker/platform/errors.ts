import type { Env, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ASSET_OWNING_IMPORT_NOT_READY_SQL_ERROR, TEMPLATE_VERSION_NOT_PUBLISHED_SQL_ERROR } from "../template-publication";

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

export function createApiErrorHandler<E extends Env>(): ErrorHandler<E> {
  return (error, c) => {
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
}
