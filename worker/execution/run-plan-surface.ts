import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { RunPlanService } from "./run-plan-service";
type RunPlanEnvironment<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
export function createRunPlanHandlers<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => RunPlanService) {
  const requests = new WeakMap<Context<RunPlanEnvironment<Bindings>>, Request>();
  const captureIngressRequest: MiddlewareHandler<RunPlanEnvironment<Bindings>> = async (c, next) => {
    requests.set(c, c.req.raw);
    try { await next(); } finally { requests.delete(c); }
  };
  const original = (c: Context<RunPlanEnvironment<Bindings>>) => {
    const request = requests.get(c); if (!request) throw new Error("Run plan request admission is unavailable"); return request;
  };
  return { captureIngressRequest,
    async start(c: Context<RunPlanEnvironment<Bindings>, "/samples/:id/runs">) {
      const input = await c.req.json<unknown>();
      return c.json(await selectService(original(c), c.env).start(c.req.param("id"), input, c.get("userEmail")), 201);
    },
    async apply(c: Context<RunPlanEnvironment<Bindings>, "/samples/:sampleId/runs/:runId/plan-update">) {
      const input = await c.req.json<unknown>(), { sampleId, runId } = c.req.param();
      return c.json(await selectService(original(c), c.env).apply(sampleId, runId, input, c.get("userEmail")));
    },
  };
}
export function createRunPlanSurface<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => RunPlanService) {
  const routes = new Hono<RunPlanEnvironment<Bindings>>(), handlers = createRunPlanHandlers(selectService);
  routes.post("/samples/:id/runs", handlers.captureIngressRequest, handlers.start);
  routes.post("/samples/:sampleId/runs/:runId/plan-update", handlers.captureIngressRequest, handlers.apply);
  return routes;
}
