import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { ExecutionPreviewService } from "./preview-service";
type PreviewEnvironment<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
/** Capture only the two owned methods, before any downstream bodyLimit clone. */
export function createExecutionPreviewHandlers<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => ExecutionPreviewService) {
  const requests = new WeakMap<Context<PreviewEnvironment<Bindings>>, Request>();
  const captureIngressRequest: MiddlewareHandler<PreviewEnvironment<Bindings>> = async (c, next) => {
    requests.set(c, c.req.raw);
    try { await next(); } finally { requests.delete(c); }
  };
  function original(c: Context<PreviewEnvironment<Bindings>>) {
    const request = requests.get(c);
    if (!request) throw new Error("Execution preview request admission is unavailable");
    return request;
  }
  return {
    captureIngressRequest,
    async start(c: Context<PreviewEnvironment<Bindings>, "/samples/:id/runs/preview">) {
      const sampleId = c.req.param("id"), input = await c.req.json<unknown>();
      return c.json(await selectService(original(c), c.env).start(sampleId, input, c.get("userEmail")));
    },
    async planUpdate(c: Context<PreviewEnvironment<Bindings>, "/samples/:sampleId/runs/:runId/plan-update/preview">) {
      const { sampleId, runId } = c.req.param(), input = await c.req.json<unknown>();
      return c.json(await selectService(original(c), c.env).planUpdate(sampleId, runId, input, c.get("userEmail")));
    },
  };
}
export function createExecutionPreviewSurface<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => ExecutionPreviewService) {
  const routes = new Hono<PreviewEnvironment<Bindings>>(), handlers = createExecutionPreviewHandlers(selectService);
  routes.post("/samples/:id/runs/preview", handlers.captureIngressRequest, handlers.start);
  routes.post("/samples/:sampleId/runs/:runId/plan-update/preview", handlers.captureIngressRequest, handlers.planUpdate);
  return routes;
}
