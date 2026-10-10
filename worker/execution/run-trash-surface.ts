import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { RunTrashService } from "./run-trash-service";

type RunTrashBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
/** Capture only these owned methods, before any bodyLimit replaces req.raw.
 * No shared principal or Request clone is admitted. Services select the live
 * bindings using this exact original transport-owned Request after parsing. */
export function createRunTrashHandlers<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => RunTrashService) {
  const requests = new WeakMap<Context<RunTrashBindings<Bindings>>, Request>();
  const captureIngressRequest: MiddlewareHandler<RunTrashBindings<Bindings>> = async (c, next) => {
    requests.set(c, c.req.raw);
    try { await next(); } finally { requests.delete(c); }
  };
  function ingressRequest(c: Context<RunTrashBindings<Bindings>>) {
    const request = requests.get(c);
    if (!request) throw new Error("Run trash request admission is unavailable");
    return request;
  }
  return {
    captureIngressRequest,
    async remove(c: Context<RunTrashBindings<Bindings>, "/samples/:sampleId/runs/:runId">) {
      const { sampleId, runId } = c.req.param();
      const input = await c.req.json<unknown>().catch(() => null);
      return c.json(await selectService(ingressRequest(c), c.env).remove(sampleId, runId, input, c.get("userEmail")));
    },
    async restore(c: Context<RunTrashBindings<Bindings>, "/samples/:sampleId/runs/:runId/restore">) {
      const { sampleId, runId } = c.req.param();
      const input = await c.req.json<unknown>().catch(() => null);
      return c.json(await selectService(ingressRequest(c), c.env).restore(sampleId, runId, input, c.get("userEmail")));
    },
  };
}
/** Two Run trash methods only; no complete Execution/runtime claim. */
export function createRunTrashSurface<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => RunTrashService) {
  const routes = new Hono<RunTrashBindings<Bindings>>(), handlers = createRunTrashHandlers(selectService);
  routes.delete("/samples/:sampleId/runs/:runId", handlers.captureIngressRequest, handlers.remove);
  routes.post("/samples/:sampleId/runs/:runId/restore", handlers.captureIngressRequest, handlers.restore);
  return routes;
}
