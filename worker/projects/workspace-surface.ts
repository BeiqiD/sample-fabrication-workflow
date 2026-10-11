import { type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { isProjectApiId } from "../../shared/project-api";
import { classifyProjectFailure, type SettlementProof } from "./failure";
import type { ProjectWorkspaceService } from "./workspace-service";

type ActorBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
/** Capture the genuine authenticated ingress before bodyLimit substitutes raw.
 * The three mature endpoints keep their existing identity/revision protocol. */
export function createProjectWorkspaceHandlers<Bindings extends object>(
  selectService: (request: Request, bindings: Bindings, actor: string) => ProjectWorkspaceService,
) {
  const requests = new WeakMap<Context<ActorBindings<Bindings>>, Request>();
  const captureIngressRequest: MiddlewareHandler<ActorBindings<Bindings>> = async (c, next) => {
    requests.set(c, c.req.raw); try { await next(); } finally { requests.delete(c); }
  };
  const id = (c: Context<ActorBindings<Bindings>>, name: string, label: string): string => {
    const value = c.req.param(name);
    if (!isProjectApiId(value)) throw new HTTPException(400, { message: `A valid ${label} ID is required` });
    return value;
  };
  const read = async (c: Context<ActorBindings<Bindings>>) => {
    let value: unknown;
    try { value = await c.req.json<unknown>(); }
    catch { throw new HTTPException(400, { message: "A valid JSON request body is required" }); }
    const request = requests.get(c); if (!request) throw new Error("Project request admission is unavailable");
    const actor = c.get("userEmail"); return { value, actor, service: selectService(request, c.env, actor) };
  };
  const errorResponse = async (c: Context<ActorBindings<Bindings>>, error: unknown, proof?: SettlementProof) => {
    const failure = await classifyProjectFailure(error, proof);
    if (!failure) throw error;
    if (failure.authoritativeRejection) c.header("x-project-mutation-disposition", "authoritative-rejection");
    return c.json({ error: failure.message }, failure.code === "not_found" ? 404 : 409);
  };
  return {
    captureIngressRequest,
    async createMarkdown(c: Context<ActorBindings<Bindings>>) {
      const projectId = id(c, "projectId", "Project"), { value, actor, service } = await read(c);
      try { const result = await service.createMarkdown(projectId, value, actor); return c.json(result, result.replayed ? 200 : 201); }
      catch (error) { return errorResponse(c, error, () => service.creationSettlement(projectId, value, actor)); }
    },
    async updateMarkdown(c: Context<ActorBindings<Bindings>>) {
      const projectId = id(c, "projectId", "Project"), contentId = id(c, "contentId", "Project content"), { value, actor, service } = await read(c);
      try { return c.json(await service.updateMarkdown(projectId, contentId, value, actor)); }
      catch (error) { return errorResponse(c, error); }
    },
    async updatePlacement(c: Context<ActorBindings<Bindings>>) {
      const projectId = id(c, "projectId", "Project"), placementId = id(c, "placementId", "Project placement"), { value, actor, service } = await read(c);
      try { return c.json(await service.updatePlacement(projectId, placementId, value, actor)); }
      catch (error) { return errorResponse(c, error, () => service.placementSettlement(projectId, placementId, value, actor)); }
    },
  };
}
