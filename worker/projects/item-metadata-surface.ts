import { type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { isProjectApiId } from "../../shared/project-api";
import { classifyProjectFailure, type SettlementProof } from "./failure";
import type { ProjectItemMetadataService } from "./item-metadata-service";
type ActorBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
export function createProjectItemMetadataHandlers<Bindings extends object>(selectService: (request: Request, bindings: Bindings, actor: string) => ProjectItemMetadataService) {
  const requests = new WeakMap<Context<ActorBindings<Bindings>>, Request>();
  const captureIngressRequest: MiddlewareHandler<ActorBindings<Bindings>> = async (c, next) => { requests.set(c, c.req.raw); try { await next(); } finally { requests.delete(c); } };
  const id = (c: Context<ActorBindings<Bindings>>, name: string, label: string) => { const value = c.req.param(name); if (!isProjectApiId(value)) throw new HTTPException(400, { message: `A valid ${label} ID is required` }); return value; };
  const execute = async (c: Context<ActorBindings<Bindings>>, operation: "createReference" | "updateAttachment" | "removeItem") => {
    const projectId = id(c, "projectId", "Project"), childId = operation === "createReference" ? null : operation === "updateAttachment" ? id(c, "contentId", "Project content") : id(c, "itemId", "Project item");
    let value: unknown; try { value = await c.req.json<unknown>(); } catch { throw new HTTPException(400, { message: "A valid JSON request body is required" }); }
    const request = requests.get(c); if (!request) throw new Error("Project item metadata Request admission is unavailable"); const actor = c.get("userEmail"), service = selectService(request, c.env, actor);
    try { if (operation === "createReference") { const r = await service.createReference(projectId, value, actor); return c.json(r, r.replayed ? 200 : 201); } return c.json(await service[operation](projectId, childId!, value, actor)); }
    catch (error) { const proof: SettlementProof | undefined = operation === "createReference" ? () => service.creationSettlement(projectId, value, actor) : undefined; const failure = await classifyProjectFailure(error, proof); if (!failure) throw error; if (failure.authoritativeRejection) c.header("x-project-mutation-disposition", "authoritative-rejection"); return c.json({ error: failure.message }, failure.code === "not_found" ? 404 : 409); }
  };
  return { captureIngressRequest, createReference: (c: Context<ActorBindings<Bindings>>) => execute(c, "createReference"), updateAttachment: (c: Context<ActorBindings<Bindings>>) => execute(c, "updateAttachment"), removeItem: (c: Context<ActorBindings<Bindings>>) => execute(c, "removeItem") };
}
