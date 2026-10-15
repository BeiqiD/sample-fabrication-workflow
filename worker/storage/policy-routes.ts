import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../types";
import { activateNativeStorageProfile, readNativeStorageActivation, StoragePolicyError } from "./native-profile-activation";
import { readStorageRolePolicy, setStorageRoleDefaults } from "./storage-role-policy";
import { requireSystemAdministrator } from "./system-administrator";

export const storagePolicyRoutes = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
const limit = bodyLimit({ maxSize: 4096, onError: c => c.json({ error: "Storage policy input is too large." }, 413) });
const jsonContentType = (raw: string | undefined) => /^application\/json(?:\s*;|$)/i.test(raw ?? "");
storagePolicyRoutes.get("/storage/configuration/activations/:operationId", requireSystemAdministrator, async c => {
  try { return c.json(await readNativeStorageActivation(c.env, c.req.param("operationId"), c.get("userEmail"))); }
  catch (error) { if (error instanceof StoragePolicyError) return c.json({ error: error.message }, error.status); return c.json({ error: "Storage policy is temporarily unavailable." }, 503); }
});
storagePolicyRoutes.get("/settings/storage/defaults/:operationId", requireSystemAdministrator, async c => {
  try { return c.json(await readStorageRolePolicy(c.env, c.req.param("operationId"), c.get("userEmail"))); }
  catch (error) { if (error instanceof StoragePolicyError) return c.json({ error: error.message }, error.status); return c.json({ error: "Storage policy is temporarily unavailable." }, 503); }
});
storagePolicyRoutes.post("/storage/configuration/activations", requireSystemAdministrator, limit, async c => {
  if (!jsonContentType(c.req.header("content-type"))) return c.json({ error: "Invalid storage activation." }, 400);
  let input: unknown;
  try { input = await c.req.json(); } catch { return c.json({ error: "Invalid storage activation." }, 400); }
  try { return c.json(await activateNativeStorageProfile(c.env, input, c.get("userEmail"))); }
  catch (error) { if (error instanceof StoragePolicyError) return c.json({ error: error.message }, error.status); return c.json({ error: "Storage policy is temporarily unavailable." }, 503); }
});
storagePolicyRoutes.put("/settings/storage/defaults", requireSystemAdministrator, limit, async c => {
  if (!jsonContentType(c.req.header("content-type"))) return c.json({ error: "Invalid storage role policy." }, 400);
  let input: unknown;
  try { input = await c.req.json(); } catch { return c.json({ error: "Invalid storage role policy." }, 400); }
  try { return c.json(await setStorageRoleDefaults(c.env, input, c.get("userEmail"))); }
  catch (error) { if (error instanceof StoragePolicyError) return c.json({ error: error.message }, error.status); return c.json({ error: "Storage policy is temporarily unavailable." }, 503); }
});
