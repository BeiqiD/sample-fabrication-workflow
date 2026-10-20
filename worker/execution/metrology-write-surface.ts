import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { MetrologyWriteService } from "./metrology-write-service";

type MetrologyBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
/** Exact method-scoped ingress ownership before bodyLimit/JSON. Captures no
 * shared principal, trusts no Request clone and admits no arbitrary headers. */
export function createMetrologyWriteHandlers<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => MetrologyWriteService) {
  const requests = new WeakMap<Context<MetrologyBindings<Bindings>>, Request>();
  const captureIngressRequest: MiddlewareHandler<MetrologyBindings<Bindings>> = async (c, next) => {
    requests.set(c, c.req.raw);
    try { await next(); } finally { requests.delete(c); }
  };
  function originalRequest(c: Context<MetrologyBindings<Bindings>>) {
    const request = requests.get(c);
    if (!request) throw new Error("Metrology request admission is unavailable");
    return request;
  }
  return {
    captureIngressRequest,
    async addEntry(c: Context<MetrologyBindings<Bindings>, "/samples/:sampleId/runs/:runId/metrology">) {
      const { sampleId, runId } = c.req.param(), input = await c.req.json<unknown>();
      return c.json(await selectService(originalRequest(c), c.env).addEntry(sampleId, runId, input, c.get("userEmail")), 201);
    },
    async startRun(c: Context<MetrologyBindings<Bindings>, "/samples/:sampleId/metrology-runs">) {
      const sampleId = c.req.param("sampleId"), input = await c.req.json<unknown>();
      return c.json(await selectService(originalRequest(c), c.env).startRun(sampleId, input, c.get("userEmail")), 201);
    },
  };
}
/** Only the two existing metadata methods, not complete Execution/media. */
export function createMetrologyWriteSurface<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => MetrologyWriteService) {
  const routes = new Hono<MetrologyBindings<Bindings>>(), handlers = createMetrologyWriteHandlers(selectService);
  routes.post("/samples/:sampleId/runs/:runId/metrology", handlers.captureIngressRequest, handlers.addEntry);
  routes.post("/samples/:sampleId/metrology-runs", handlers.captureIngressRequest, handlers.startRun);
  return routes;
}
