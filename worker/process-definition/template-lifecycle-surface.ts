import { type Context, type MiddlewareHandler } from "hono";
import type { TemplateLifecycleService } from "./template-lifecycle-service";
type ActorBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
/** Capture this exact authenticated original Request before the bounded body
 * clone; use the original JSON parser only after published-template lookup. */
export function createTemplateLifecycleHandlers<Bindings extends object>(
  selectService: (request: Request, bindings: Bindings, actor: string) => TemplateLifecycleService,
) {
  const requests = new WeakMap<Context<ActorBindings<Bindings>>, Request>();
  const captureIngressRequest: MiddlewareHandler<ActorBindings<Bindings>> = async (c, next) => {
    requests.set(c, c.req.raw); try { await next(); } finally { requests.delete(c); }
  };
  const select = (c: Context<ActorBindings<Bindings>>) => {
    const request = requests.get(c); if (!request) throw new Error("Template lifecycle Request admission is unavailable");
    const id = c.req.param("id"); if (typeof id !== "string") throw new Error("Template lifecycle route identity is unavailable");
    const actor = c.get("userEmail"); return { id, actor, service: selectService(request, c.env, actor) };
  };
  return {
    captureIngressRequest,
    async rename(c: Context<ActorBindings<Bindings>>) { const { id, actor, service } = select(c); return c.json(await service.rename(id, () => c.req.json<unknown>(), actor)); },
    async remove(c: Context<ActorBindings<Bindings>>) { const { id, actor, service } = select(c); return c.json(await service.remove(id, actor)); },
    async restore(c: Context<ActorBindings<Bindings>>) { const { id, actor, service } = select(c); return c.json(await service.restore(id, actor)); },
  };
}
