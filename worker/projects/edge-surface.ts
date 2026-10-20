import { type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { isProjectApiId } from "../../shared/project-api";
import { classifyProjectFailure, type SettlementProof } from "./failure";
import type { ProjectEdgeService } from "./edge-service";
type ActorBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
/** Retain the exact authenticated Request before bodyLimit clones it. */
export function createProjectEdgeHandlers<Bindings extends object>(
  selectService: (request: Request, bindings: Bindings, actor: string) => ProjectEdgeService,
) {
  const requests = new WeakMap<Context<ActorBindings<Bindings>>, Request>();
  const captureIngressRequest: MiddlewareHandler<ActorBindings<Bindings>> = async (c, next) => {
    requests.set(c, c.req.raw); try { await next(); } finally { requests.delete(c); }
  };
  const id = (c: Context<ActorBindings<Bindings>>, name: string, label: string) => {
    const value = c.req.param(name); if (!isProjectApiId(value)) throw new HTTPException(400, { message: `A valid ${label} ID is required` }); return value;
  };
  const execute = async (c: Context<ActorBindings<Bindings>>, operation: "create" | "update" | "remove" | "restore") => {
    const projectId = id(c, "projectId", "Project"), edgeId = operation === "create" ? null : id(c, "edgeId", "Project edge");
    let value: unknown; try { value = await c.req.json<unknown>(); }
    catch { throw new HTTPException(400, { message: "A valid JSON request body is required" }); }
    const request = requests.get(c); if (!request) throw new Error("Project edge Request admission is unavailable");
    const actor = c.get("userEmail"), service = selectService(request, c.env, actor);
    try {
      if (operation === "create") { const result = await service.create(projectId, value, actor); return c.json(result, result.replayed ? 200 : 201); }
      return c.json(await service[operation](projectId, edgeId!, value, actor));
    } catch (error) {
      const proof: SettlementProof | undefined = operation === "create" ? () => service.creationSettlement(projectId, value, actor) : undefined;
      const failure = await classifyProjectFailure(error, proof); if (!failure) throw error;
      if (failure.authoritativeRejection) c.header("x-project-mutation-disposition", "authoritative-rejection");
      return c.json({ error: failure.message }, failure.code === "not_found" ? 404 : 409);
    }
  };
  return { captureIngressRequest, create: (c: Context<ActorBindings<Bindings>>) => execute(c, "create"),
    update: (c: Context<ActorBindings<Bindings>>) => execute(c, "update"), remove: (c: Context<ActorBindings<Bindings>>) => execute(c, "remove"),
    restore: (c: Context<ActorBindings<Bindings>>) => execute(c, "restore") };
}
