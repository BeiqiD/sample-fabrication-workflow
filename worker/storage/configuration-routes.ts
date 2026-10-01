import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MAX_STORAGE_CONFIGURATION_INPUT_BYTES, checkedSaveStorageCandidateInput } from "../../shared/contracts/storage-configuration";
import type { Env } from "../types";
import { canAdministerSystemSettings, requireSystemAdministrator } from "./system-administrator";
import { readStorageConfiguration, saveStorageCandidate, storageCredentialEditingAvailable, StorageConfigurationError } from "./configuration-registry";

type Bindings = { Bindings: Env; Variables: { userEmail: string } };
export const storageConfigurationRoutes = new Hono<Bindings>();
/** Installed before authentication, including its error responses. */
export const storageConfigurationCacheControl: MiddlewareHandler<Bindings> = async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  c.header("Pragma", "no-cache");
  await next();
};

storageConfigurationRoutes.get("/storage/configuration/capability", async c => {
  const canManage = canAdministerSystemSettings(c.env, c.get("userEmail"));
  return c.json({ canManage, credentialEditingAvailable: canManage && await storageCredentialEditingAvailable(c.env) });
});

storageConfigurationRoutes.get("/storage/configuration", requireSystemAdministrator, async c => {
  try { return c.json(await readStorageConfiguration(c.env, c.get("userEmail"))); }
  catch (error) {
    if (error instanceof StorageConfigurationError) return c.json({ error: error.message }, error.status);
    return c.json({ error: "Storage configuration is temporarily unavailable." }, 503);
  }
});

storageConfigurationRoutes.put("/storage/configuration/candidates", requireSystemAdministrator,
  bodyLimit({ maxSize: MAX_STORAGE_CONFIGURATION_INPUT_BYTES, onError: c => c.json({ error: "Storage configuration is too large." }, 413) }),
  async c => {
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) return c.json({ error: "Invalid storage configuration." }, 400);
    let input;
    try { input = checkedSaveStorageCandidateInput(await c.req.json()); }
    catch {
      return c.json({ error: "Invalid storage configuration." }, 400);
    }
    try { return c.json(await saveStorageCandidate(c.env, input, c.get("userEmail"))); }
    catch (error) {
      if (error instanceof StorageConfigurationError) return c.json({ error: error.message }, error.status);
      return c.json({ error: "Storage configuration is temporarily unavailable." }, 503);
    }
  });
