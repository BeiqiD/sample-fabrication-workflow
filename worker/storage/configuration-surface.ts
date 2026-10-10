import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MAX_STORAGE_CONFIGURATION_INPUT_BYTES, checkedSaveStorageCandidateInput,
  type SaveStorageCandidateInput, type StorageCandidate, type StorageConfigurationStatus } from "../../shared/contracts/storage-configuration";
import { createSystemAdministratorMiddleware, type AuthorizationSelector } from "../runtime/authorization";

export interface StorageConfigurationOperations<Bindings extends object> {
  authorizeAdministrator: AuthorizationSelector<Bindings>;
  credentialEditingAvailable(bindings: Bindings): Promise<boolean>;
  read(bindings: Bindings, actor: string): Promise<StorageConfigurationStatus>;
  save(bindings: Bindings, input: SaveStorageCandidateInput, actor: string): Promise<StorageCandidate>;
  routeError(error: unknown): { status: 400 | 409 | 503; message: string } | null;
}
type ActorBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
export function createStorageConfigurationCacheControl<Bindings extends object>(): MiddlewareHandler<ActorBindings<Bindings>> {
  return async (c, next) => {
    c.header("Cache-Control", "private, no-store"); c.header("Pragma", "no-cache"); await next();
  };
}
/** Shared HTTP surface only. Runtime services retain independent current
 * authorization, SQL/credential handling and accepted-write reconciliation. */
export function createStorageConfigurationSurface<Bindings extends object>(operations: StorageConfigurationOperations<Bindings>) {
  const routes = new Hono<ActorBindings<Bindings>>();
  const requireAdministrator = createSystemAdministratorMiddleware(operations.authorizeAdministrator);
  routes.get("/storage/configuration/capability", async c => {
    const canManage = await operations.authorizeAdministrator(c.req.raw, c.env, c.get("userEmail")) === true;
    return c.json({ canManage, credentialEditingAvailable: canManage && await operations.credentialEditingAvailable(c.env) });
  });
  routes.get("/storage/configuration", requireAdministrator, async (c: Context<ActorBindings<Bindings>>) => {
    try { return c.json(await operations.read(c.env, c.get("userEmail"))); }
    catch (error) {
      const known = operations.routeError(error);
      return known ? c.json({ error: known.message }, known.status)
        : c.json({ error: "Storage configuration is temporarily unavailable." }, 503);
    }
  });
  routes.put("/storage/configuration/candidates", requireAdministrator,
    bodyLimit({ maxSize: MAX_STORAGE_CONFIGURATION_INPUT_BYTES, onError: c => c.json({ error: "Storage configuration is too large." }, 413) }),
    async (c: Context<ActorBindings<Bindings>>) => {
      if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) return c.json({ error: "Invalid storage configuration." }, 400);
      let input;
      try { input = checkedSaveStorageCandidateInput(await c.req.json()); }
      catch { return c.json({ error: "Invalid storage configuration." }, 400); }
      try { return c.json(await operations.save(c.env, input, c.get("userEmail"))); }
      catch (error) {
        const known = operations.routeError(error);
        return known ? c.json({ error: known.message }, known.status)
          : c.json({ error: "Storage configuration is temporarily unavailable." }, 503);
      }
    });
  return routes;
}
