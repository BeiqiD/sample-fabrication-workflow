import { Hono, type Context } from "hono";
import type { StepConfirmationService } from "./confirmation-service";

type ActorBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
/** Capture only this method's original trusted ingress Request before JSON
 * parsing or an optional bodyLimit replacement. Clones are never admitted. */
export function createStepConfirmationHandlers<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => StepConfirmationService) {
  const requests = new WeakMap<Context<ActorBindings<Bindings>>, Request>();
  return {
    async captureIngressRequest(c: Context<ActorBindings<Bindings>>, next: () => Promise<void>) {
      requests.set(c, c.req.raw);
      try { await next(); } finally { requests.delete(c); }
    },
    async confirm(c: Context<ActorBindings<Bindings>>) {
      // Preserve the mature route's JSON parser/error semantics.
      const value = await c.req.json<unknown>();
      const original = requests.get(c);
      if (!original) throw new Error("Step confirmation ingress request unavailable");
      return c.json(await selectService(original, c.env).confirm(value, c.get("userEmail")));
    },
  };
}
/** This single POST surface is preparatory, not a complete Node Execution app. */
export function createStepConfirmationSurface<Bindings extends object>(selectService: (request: Request, bindings: Bindings) => StepConfirmationService) {
  const routes = new Hono<ActorBindings<Bindings>>(), handlers = createStepConfirmationHandlers(selectService);
  routes.post("/run-steps/confirm", handlers.captureIngressRequest, handlers.confirm);
  return routes;
}
