import { type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { isProjectApiId } from "../../shared/project-api";
import { classifyProjectFailure } from "./failure";
import type { ProjectLifecycleService } from "./lifecycle-service";
type ActorBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
/** Exact original authenticated Request is captured before bodyLimit clones it. */
export function createProjectLifecycleHandlers<Bindings extends object>(
  selectService: (request: Request, bindings: Bindings, actor: string) => ProjectLifecycleService,
) {
  const requests = new WeakMap<Context<ActorBindings<Bindings>>, Request>();
  const captureIngressRequest: MiddlewareHandler<ActorBindings<Bindings>> = async (c, next) => {
    requests.set(c, c.req.raw); try { await next(); } finally { requests.delete(c); }
  };
  const execute = async (c: Context<ActorBindings<Bindings>>, restore: boolean) => {
    const projectId = c.req.param("projectId");
    if (!isProjectApiId(projectId)) throw new HTTPException(400, { message: "A valid Project ID is required" });
    let value: unknown; try { value = await c.req.json<unknown>(); }
    catch { throw new HTTPException(400, { message: "A valid JSON request body is required" }); }
    const request = requests.get(c); if (!request) throw new Error("Project lifecycle Request admission is unavailable");
    const actor = c.get("userEmail"), service = selectService(request, c.env, actor);
    try { return c.json(await (restore ? service.restore(projectId, value, actor) : service.remove(projectId, value, actor))); }
    catch (error) {
      const failure = await classifyProjectFailure(error); if (!failure) throw error;
      if (failure.authoritativeRejection) c.header("x-project-mutation-disposition", "authoritative-rejection");
      return c.json({ error: failure.message }, failure.code === "not_found" ? 404 : 409);
    }
  };
  return { captureIngressRequest, remove: (c: Context<ActorBindings<Bindings>>) => execute(c, false), restore: (c: Context<ActorBindings<Bindings>>) => execute(c, true) };
}
