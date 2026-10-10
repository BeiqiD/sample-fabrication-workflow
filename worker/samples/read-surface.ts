import { Hono, type Context } from "hono";
import type { SampleReadService } from "./read-service";
import { createSampleRequestContext, type SampleActorBindings } from "./request-context";

export function createSampleReadHandlers<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => SampleReadService) {
  const { captureIngressRequest, ingressRequest } = createSampleRequestContext<Bindings>();
  return {
    captureIngressRequest,
    async directoryOptions(c: Context<SampleActorBindings<Bindings>>) {
      const result = await selectService(ingressRequest(c), c.env).directoryOptions(c.get("userEmail"));
      const response = c.json(result.payload);
      response.headers.set("Server-Timing", result.serverTiming);
      return response;
    },
    async directory(c: Context<SampleActorBindings<Bindings>>) {
      const result = await selectService(ingressRequest(c), c.env).directory(key => c.req.query(key), c.get("userEmail"));
      const response = c.json(result.payload);
      response.headers.set("Server-Timing", result.serverTiming);
      return response;
    },
    async detail(c: Context<SampleActorBindings<Bindings>, "/samples/:id">) {
      return c.json(await selectService(ingressRequest(c), c.env).detail(c.req.param("id"), key => c.req.query(key), c.get("userEmail")));
    },
  };
}
/** Three existing read routes only. Provider bytes and other Samples actions
 * remain separate route owners until genuine capabilities are supplied. */
export function createSampleReadSurface<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => SampleReadService) {
  const routes = new Hono<SampleActorBindings<Bindings>>(), handlers = createSampleReadHandlers(selectService);
  routes.get("/sample-directory-options", handlers.captureIngressRequest, handlers.directoryOptions);
  routes.get("/samples", handlers.captureIngressRequest, handlers.directory);
  routes.get("/samples/:id", handlers.captureIngressRequest, handlers.detail);
  return routes;
}
