import { type Context, type MiddlewareHandler } from "hono";
import type { MetrologyDefinitionService } from "./metrology-definition-service";

type ActorBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
/** Original JSON parser/domain validation; exact authenticated ingress is
 * captured before the Node body's bounded clone substitutes its raw Request. */
export function createMetrologyDefinitionHandlers<Bindings extends object>(
  selectService: (request: Request, bindings: Bindings, actor: string) => MetrologyDefinitionService,
) {
  const requests = new WeakMap<Context<ActorBindings<Bindings>>, Request>();
  const captureIngressRequest: MiddlewareHandler<ActorBindings<Bindings>> = async (c, next) => {
    requests.set(c, c.req.raw); try { await next(); } finally { requests.delete(c); }
  };
  const select = (c: Context<ActorBindings<Bindings>>) => {
    const request = requests.get(c); if (!request) throw new Error("Metrology definition Request admission is unavailable");
    const actor = c.get("userEmail"); return { actor, service: selectService(request, c.env, actor) };
  };
  const routeId = (c: Context<ActorBindings<Bindings>>): string => {
    const value = c.req.param("id"); if (typeof value !== "string") throw new Error("Metrology definition route identity is unavailable"); return value;
  };
  return {
    captureIngressRequest,
    async create(c: Context<ActorBindings<Bindings>>) {
      const { actor, service } = select(c); return c.json(await service.create(() => c.req.json<unknown>(), actor), 201);
    },
    async update(c: Context<ActorBindings<Bindings>>) {
      const { actor, service } = select(c); return c.json(await service.update(routeId(c), () => c.req.json<unknown>(), actor));
    },
    async notes(c: Context<ActorBindings<Bindings>>) {
      const { actor, service } = select(c); return c.json(await service.notes(routeId(c), () => c.req.json<unknown>(), actor));
    },
  };
}
