import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { RunFinishService } from "./run-finish-service";
type RunFinishBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
export function createRunFinishHandlers<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => RunFinishService) {
  const requests = new WeakMap<Context<RunFinishBindings<Bindings>>, Request>();
  const captureIngressRequest: MiddlewareHandler<RunFinishBindings<Bindings>> = async (c, next) => {
    requests.set(c, c.req.raw);
    try { await next(); } finally { requests.delete(c); }
  };
  return {
    captureIngressRequest,
    async finish(c: Context<RunFinishBindings<Bindings>, "/samples/:sampleId/runs/:runId/finish">) {
      const { sampleId, runId } = c.req.param();
      const input = await c.req.json<unknown>();
      const original = requests.get(c);
      if (!original) throw new Error("Run finish request admission is unavailable");
      return c.json(await selectService(original, c.env).finish(sampleId, runId, input, c.get("userEmail")));
    },
  };
}
export function createRunFinishSurface<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => RunFinishService) {
  const routes = new Hono<RunFinishBindings<Bindings>>(), handlers = createRunFinishHandlers(selectService);
  routes.post("/samples/:sampleId/runs/:runId/finish", handlers.captureIngressRequest, handlers.finish);
  return routes;
}
