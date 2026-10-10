import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { TemplateDirectoryInput, TemplateReadResponse, TemplateReadService } from "./read-service";

type ActorBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
function directoryInput<Bindings extends object>(c: Context<ActorBindings<Bindings>>): TemplateDirectoryInput {
  return { query: c.req.query("q"), page: c.req.query("page"), pageSize: c.req.query("pageSize") };
}
function respond<Bindings extends object, T extends object>(c: Context<ActorBindings<Bindings>>, result: TemplateReadResponse<T>) {
  const response = c.json(result.payload);
  if (result.serverTiming !== undefined) response.headers.set("Server-Timing", result.serverTiming);
  return response;
}
export function createTemplateReadHandlers<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => TemplateReadService) {
  const requests = new WeakMap<Context<ActorBindings<Bindings>>, Request>();
  const ingressRequest = (c: Context<ActorBindings<Bindings>>) => {
    const request = requests.get(c); if (!request) throw new Error("Template request admission is unavailable"); return request;
  };
  // Registered first on each of the six owned GETs, never an ALL/API-wide hook.
  // Future body guards must remain after this trusted exact Request capture.
  const captureIngressRequest: MiddlewareHandler<ActorBindings<Bindings>> = async (c, next) => {
    requests.set(c, c.req.raw); try { await next(); } finally { requests.delete(c); }
  };
  const service = (c: Context<ActorBindings<Bindings>>) => selectService(ingressRequest(c), c.env);
  return {
    captureIngressRequest,
    async options(c: Context<ActorBindings<Bindings>>) { return respond(c, await service(c).options(c.get("userEmail"))); },
    async families(c: Context<ActorBindings<Bindings>>) { return respond(c, await service(c).families(directoryInput(c), c.get("userEmail"))); },
    async versions(c: Context<ActorBindings<Bindings>, "/template-families/:id/versions">) {
      return respond(c, await service(c).versions(c.req.param("id"), c.req.query("q")?.trim() ?? "", c.get("userEmail")));
    },
    async metrology(c: Context<ActorBindings<Bindings>>) { return respond(c, await service(c).metrology(directoryInput(c), c.get("userEmail"))); },
    async list(c: Context<ActorBindings<Bindings>>) { return respond(c, await service(c).list(c.req.query("view") === "picker", c.get("userEmail"))); },
    async detail(c: Context<ActorBindings<Bindings>, "/templates/:id">) { return respond(c, await service(c).detail(c.req.param("id"), c.get("userEmail"))); },
  };
}
/** Mature metadata-only reads. Upload status, mutations and bytes stay owned
 * by their existing routes, including their current publication/auth policies. */
export function createTemplateReadSurface<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => TemplateReadService) {
  const routes = new Hono<ActorBindings<Bindings>>(), handlers = createTemplateReadHandlers(selectService);
  routes.get("/template-families/options", handlers.captureIngressRequest, handlers.options);
  routes.get("/template-families", handlers.captureIngressRequest, handlers.families);
  routes.get("/template-families/:id/versions", handlers.captureIngressRequest, handlers.versions);
  routes.get("/metrology-templates", handlers.captureIngressRequest, handlers.metrology);
  routes.get("/templates", handlers.captureIngressRequest, handlers.list);
  routes.get("/templates/:id", handlers.captureIngressRequest, handlers.detail);
  return routes;
}
