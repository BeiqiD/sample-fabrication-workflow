import { Hono, type Context } from "hono";
import type { SampleMetadataService } from "./metadata-service";

type ActorBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
/** Select after parsing, from this request's current bindings. Authentication
 * and installation admission belong to the trusted runtime composer/service. */
export function createSampleMetadataHandlers<Bindings extends object>(selectService: (bindings: Bindings) => SampleMetadataService) {
  return {
    async create(c: Context<ActorBindings<Bindings>>) {
      const value = await c.req.json<unknown>().catch(() => null);
      return c.json(await selectService(c.env).create(value, c.get("userEmail")), 201);
    },
    async update(c: Context<ActorBindings<Bindings>, "/samples/:id">) {
      const value = await c.req.json<unknown>().catch(() => null);
      return c.json(await selectService(c.env).update(c.req.param("id"), value, c.get("userEmail")));
    },
    async remove(c: Context<ActorBindings<Bindings>, "/samples/:id">) {
      const value = await c.req.json<unknown>().catch(() => null);
      return c.json(await selectService(c.env).remove(c.req.param("id"), value, c.get("userEmail")));
    },
    async restore(c: Context<ActorBindings<Bindings>, "/samples/:id/restore">) {
      const value = await c.req.json<unknown>().catch(() => null);
      return c.json(await selectService(c.env).restore(c.req.param("id"), value, c.get("userEmail")));
    },
  };
}
/** A bounded four-route surface, not a complete Samples/Node application. */
export function createSampleMetadataSurface<Bindings extends object>(selectService: (bindings: Bindings) => SampleMetadataService) {
  const routes = new Hono<ActorBindings<Bindings>>(), handlers = createSampleMetadataHandlers(selectService);
  routes.post("/samples", handlers.create);
  routes.patch("/samples/:id", handlers.update);
  routes.delete("/samples/:id", handlers.remove);
  routes.post("/samples/:id/restore", handlers.restore);
  return routes;
}
