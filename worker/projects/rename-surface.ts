import { type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { isProjectApiId } from "../../shared/project-api";
import { classifyProjectFailure } from "./failure";
import type { ProjectRenameService } from "./rename-service";

type ActorBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
/** Only the already mature PATCH protocol. Its ingress Request is captured
 * before the body's bounded clone; no creation witness grants authority. */
export function createProjectRenameHandlers<Bindings extends object>(
  selectService: (request: Request, bindings: Bindings) => ProjectRenameService,
) {
  const requests = new WeakMap<Context<ActorBindings<Bindings>>, Request>();
  const captureIngressRequest: MiddlewareHandler<ActorBindings<Bindings>> = async (c, next) => {
    requests.set(c, c.req.raw); try { await next(); } finally { requests.delete(c); }
  };
  return {
    captureIngressRequest,
    async rename(c: Context<ActorBindings<Bindings>>) {
      const projectId = c.req.param("projectId");
      if (!isProjectApiId(projectId)) throw new HTTPException(400, { message: "A valid Project ID is required" });
      let value: unknown;
      try { value = await c.req.json<unknown>(); }
      catch { throw new HTTPException(400, { message: "A valid JSON request body is required" }); }
      const request = requests.get(c); if (!request) throw new Error("Project request admission is unavailable");
      try { return c.json(await selectService(request, c.env).rename(projectId, value, c.get("userEmail"))); }
      catch (error) {
        const failure = await classifyProjectFailure(error);
        if (failure) throw new HTTPException(failure.code === "not_found" ? 404 : 409, { message: failure.message });
        throw error;
      }
    },
  };
}
