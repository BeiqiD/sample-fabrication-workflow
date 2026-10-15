import { type Context, type MiddlewareHandler } from "hono";
import type { TemplateStepDeleteService } from "./template-step-delete-service";
type ActorBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
export function createTemplateStepDeleteHandlers<Bindings extends object>(
  selectService: (request: Request, bindings: Bindings, actor: string) => TemplateStepDeleteService,
) {
  const requests = new WeakMap<Context<ActorBindings<Bindings>>, Request>();
  const captureIngressRequest: MiddlewareHandler<ActorBindings<Bindings>> = async (c, next) => {
    requests.set(c, c.req.raw); try { await next(); } finally { requests.delete(c); }
  };
  return { captureIngressRequest, async remove(c: Context<ActorBindings<Bindings>>) {
    const request = requests.get(c); if (!request) throw new Error("Template step Request admission is unavailable");
    const templateId = c.req.param("templateId"), stepId = c.req.param("stepId");
    if (typeof templateId !== "string" || typeof stepId !== "string") throw new Error("Template step route identity is unavailable");
    const actor = c.get("userEmail"); return c.json(await selectService(request, c.env, actor).remove(templateId, stepId, actor));
  } };
}
