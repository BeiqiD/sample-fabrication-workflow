import { Hono, type MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { readStorageSettings } from "./settings-read-model";

type Bindings = { Bindings: Env; Variables: { userEmail: string } };
export const storageSettingsRoutes = new Hono<Bindings>();
/** Mounted before global authentication so error responses are private too. */
export const storageSettingsCacheControl: MiddlewareHandler<Bindings> = async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  c.header("Pragma", "no-cache");
  await next();
};
storageSettingsRoutes.get("/settings/storage", async c => {
  try { return c.json(await readStorageSettings(c.env.DB, c.env)); }
  catch { return c.json({ error: "Storage settings are temporarily unavailable." }, 503); }
});
