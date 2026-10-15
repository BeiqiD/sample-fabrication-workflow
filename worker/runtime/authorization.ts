import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

export type PrivilegedCapability = "systemAdministrator" | "fileEvidenceOperator";
/** Trusted authentication supplies current persisted grants. Actor spelling
 * retains provenance and never creates a capability. */
export interface AuthenticatedPrincipal {
  readonly id: string;
  readonly actor: string;
  readonly capabilities: Readonly<Record<PrivilegedCapability, boolean>>;
}
export type AuthorizationSelector<Bindings extends object> = (
  request: Request, bindings: Bindings, actor: string,
) => boolean | Promise<boolean>;
type ActorBindings<Bindings extends object> = { Bindings: Bindings; Variables: { userEmail: string } };

export function principalHasCapability(principal: AuthenticatedPrincipal | undefined,
  actor: string, capability: PrivilegedCapability): boolean {
  return Boolean(principal && typeof principal.id === "string" && principal.id.length > 0
    && typeof principal.actor === "string" && principal.actor.length > 0
    && principal.actor === actor && principal.capabilities?.[capability] === true);
}
const EMAIL = /^[a-z0-9.!#$%&'+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i;
/** Existing Access allowlist policy; local principals do not enter it. */
export function accessEmailCapability(mode: string, verifiedActor: string, configured: unknown): boolean {
  if (mode !== "access" || typeof verifiedActor !== "string" || verifiedActor.length > 254 || !EMAIL.test(verifiedActor)) return false;
  if (typeof configured !== "string" || !configured.trim() || configured.length > 8192) return false;
  const entries = configured.split(",").map(value => value.trim().toLowerCase());
  if (entries.length > 50 || entries.some(entry => entry.length > 254 || !EMAIL.test(entry))) return false;
  return entries.includes(verifiedActor.toLowerCase());
}
export function createSystemAdministratorMiddleware<Bindings extends object>(
  authorize: AuthorizationSelector<Bindings>,
): MiddlewareHandler<ActorBindings<Bindings>> {
  return async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    if (await authorize(c.req.raw, c.env, c.get("userEmail")) !== true) {
      throw new HTTPException(403, { message: "System administrator access is required." });
    }
    await next();
  };
}
export function createFileEvidenceOperatorMiddleware<Bindings extends object>(
  authorize: AuthorizationSelector<Bindings>,
): MiddlewareHandler<ActorBindings<Bindings>> {
  return async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (await authorize(c.req.raw, c.env, c.get("userEmail")) !== true) {
      throw new HTTPException(403, { message: "File evidence operator access is required." });
    }
    await next();
  };
}
export function createFileEvidenceAccessRoutes<Bindings extends object>(authorize: AuthorizationSelector<Bindings>) {
  const routes = new Hono<ActorBindings<Bindings>>();
  routes.get("/files/shadow/evidence/capabilities", async c => {
    c.header("Cache-Control", "no-store");
    return c.json({ canAdjudicate: await authorize(c.req.raw, c.env, c.get("userEmail")) === true });
  });
  return routes;
}
