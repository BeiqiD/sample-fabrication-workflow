import { Hono, type Context } from "hono";
import type { SampleMetadataService } from "./metadata-service";

import { createSampleRequestContext, type SampleActorBindings } from "./request-context";
/** Select after parsing using the captured ingress Request and this request's
 * current bindings. Mount capture before any middleware replacing c.req.raw;
 * authentication/installation admission belong to the trusted composer/service. */
export function createSampleMetadataHandlers<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => SampleMetadataService) {
  const { captureIngressRequest, ingressRequest } = createSampleRequestContext<Bindings>();
  return {
    captureIngressRequest,
    async create(c: Context<SampleActorBindings<Bindings>>) {
      const value = await c.req.json<unknown>().catch(() => null);
      return c.json(await selectService(ingressRequest(c), c.env).create(value, c.get("userEmail")), 201);
    },
    async update(c: Context<SampleActorBindings<Bindings>, "/samples/:id">) {
      const value = await c.req.json<unknown>().catch(() => null);
      return c.json(await selectService(ingressRequest(c), c.env).update(c.req.param("id"), value, c.get("userEmail")));
    },
    async remove(c: Context<SampleActorBindings<Bindings>, "/samples/:id">) {
      const value = await c.req.json<unknown>().catch(() => null);
      return c.json(await selectService(ingressRequest(c), c.env).remove(c.req.param("id"), value, c.get("userEmail")));
    },
    async restore(c: Context<SampleActorBindings<Bindings>, "/samples/:id/restore">) {
      const value = await c.req.json<unknown>().catch(() => null);
      return c.json(await selectService(ingressRequest(c), c.env).restore(c.req.param("id"), value, c.get("userEmail")));
    },
  };
}
/** A bounded four-route surface, not a complete Samples/Node application. */
export function createSampleMetadataSurface<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => SampleMetadataService) {
  const routes = new Hono<SampleActorBindings<Bindings>>(), handlers = createSampleMetadataHandlers(selectService);
  routes.post("/samples", handlers.captureIngressRequest, handlers.create);
  routes.patch("/samples/:id", handlers.captureIngressRequest, handlers.update);
  routes.delete("/samples/:id", handlers.captureIngressRequest, handlers.remove);
  routes.post("/samples/:id/restore", handlers.captureIngressRequest, handlers.restore);
  return routes;
}
