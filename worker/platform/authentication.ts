import type { MiddlewareHandler } from "hono";
import { sameOriginOrNonBrowser } from "../request-guards";

/** Trusted runtime authentication is supplied explicitly. This helper neither
 * validates Access itself nor implements local-account/admin authorization. */
export function createAuthenticationMiddleware<Bindings extends object>(
  authenticate: (request: Request, bindings: Bindings) => Promise<{ email: string }>,
): MiddlewareHandler<{ Bindings: Bindings; Variables: { userEmail: string } }> {
  return async (c, next) => {
    if (c.req.path === "/api/health") return next();
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !sameOriginOrNonBrowser(c.req.raw)) {
      return c.json({ error: "Cross-origin writes are not allowed" }, 403);
    }
    try {
      const identity = await authenticate(c.req.raw, c.env);
      c.set("userEmail", identity.email);
      await next();
    } catch (error) {
      console.warn("Authentication rejected", error);
      return c.json({ error: "Authentication required" }, 403);
    }
  };
}
