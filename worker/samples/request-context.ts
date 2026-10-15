import type { Context, MiddlewareHandler } from "hono";

export type SampleActorBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };
/** Mount capture before body-limit/other Request replacement middleware. The
 * exact ingress object owns transport admission; current bindings are selected
 * separately when the service is invoked. Contexts and requests are never shared. */
export function createSampleRequestContext<Bindings extends object>() {
  const requests = new WeakMap<Context<SampleActorBindings<Bindings>>, Request>();
  const captureIngressRequest: MiddlewareHandler<SampleActorBindings<Bindings>> = async (c, next) => {
    requests.set(c, c.req.raw);
    try { await next(); }
    finally { requests.delete(c); }
  };
  return {
    captureIngressRequest,
    ingressRequest(c: Context<SampleActorBindings<Bindings>>) {
      const request = requests.get(c);
      if (!request) throw new Error("Sample request admission is unavailable");
      return request;
    },
  };
}
