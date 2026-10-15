import { Hono, type MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { readCurrentStorageSettings, readStorageSettings } from "./settings-read-model";

type Bindings = { Bindings: Env; Variables: { userEmail: string } };
export const storageSettingsRoutes = new Hono<Bindings>();
/** Mounted before global authentication so error responses are private too. */
export const storageSettingsCacheControl: MiddlewareHandler<Bindings> = async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  c.header("Pragma", "no-cache");
  await next();
};
storageSettingsRoutes.get("/settings/storage", async c => {
  try {
    const version = c.req.query("version");
    if (version !== undefined && version !== "2" && version !== "3") return c.json({ error: "Invalid storage settings version." }, 400);
    return c.json(await (version === "3" ? readCurrentStorageSettings(c.env.DB, c.env) : readStorageSettings(c.env.DB, c.env)));
  }
  catch { return c.json({ error: "Storage settings are temporarily unavailable." }, 503); }
});
