import { Hono, type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { isProjectApiId } from "../../shared/project-api";
import { classifyProjectFailure } from "./failure";
import type { ProjectReadService } from "./read-service";

type ActorBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
async function projectReadCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const failure = await classifyProjectFailure(error);
    if (failure) throw new HTTPException(failure.code === "not_found" ? 404 : 409, { message: failure.message });
    throw error;
  }
}
export function createProjectReadHandlers<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => ProjectReadService) {
  const requests = new WeakMap<Context<ActorBindings<Bindings>>, Request>();
  const ingressRequest = (c: Context<ActorBindings<Bindings>>) => {
    const request = requests.get(c); if (!request) throw new Error("Project request admission is unavailable"); return request;
  };
  const captureIngressRequest: MiddlewareHandler<ActorBindings<Bindings>> = async (c, next) => {
    requests.set(c, c.req.raw); try { await next(); } finally { requests.delete(c); }
  };
  return {
    captureIngressRequest,
    async list(c: Context<ActorBindings<Bindings>>) {
      return c.json(await projectReadCall(() => selectService(ingressRequest(c), c.env).list(c.req.query("includeDeleted") === "1", c.get("userEmail"))));
    },
    async snapshot(c: Context<ActorBindings<Bindings>, "/projects/:projectId">) {
      const projectId = c.req.param("projectId");
      if (!isProjectApiId(projectId)) throw new HTTPException(400, { message: "A valid Project ID is required" });
      return c.json(await projectReadCall(() => selectService(ingressRequest(c), c.env).snapshot(projectId, c.req.query("includeDeleted") === "1", c.get("userEmail"))));
    },
  };
}
/** Only the two existing GET owners. Bytes, copies and mutations stay separate. */
export function createProjectReadSurface<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => ProjectReadService) {
  const routes = new Hono<ActorBindings<Bindings>>(), handlers = createProjectReadHandlers(selectService);
  routes.get("/projects", handlers.captureIngressRequest, handlers.list);
  routes.get("/projects/:projectId", handlers.captureIngressRequest, handlers.snapshot);
  return routes;
}
