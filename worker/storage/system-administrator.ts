import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";

type AdministratorEnvironment = Pick<Env, "AUTH_MODE" | "SYSTEM_ADMIN_EMAILS">;
type Bindings = { Bindings: Env; Variables: { userEmail: string } };
const EMAIL = /^[a-z0-9.!#$%&'+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i;

/** The caller supplies the email from verified Access claims, after ordinary
 * application authentication. Administrator policy is deployment-owned and
 * separate from application access and File evidence operator permissions. */
export function canAdministerSystemSettings(env: AdministratorEnvironment, verifiedEmail: string): boolean {
  if (env.AUTH_MODE !== "access" || typeof verifiedEmail !== "string" || verifiedEmail.length > 254 || !EMAIL.test(verifiedEmail)) return false;
  const configured = env.SYSTEM_ADMIN_EMAILS;
  if (typeof configured !== "string" || !configured.trim() || configured.length > 8192) return false;
  const entries = configured.split(",").map(entry => entry.trim().toLowerCase());
  if (entries.length > 50 || entries.some(entry => entry.length > 254 || !EMAIL.test(entry))) return false;
  return entries.includes(verifiedEmail.toLowerCase());
}

export function assertSystemAdministrator(env: AdministratorEnvironment, verifiedEmail: string): void {
  if (!canAdministerSystemSettings(env, verifiedEmail)) {
    throw new HTTPException(403, { message: "System administrator access is required." });
  }
}

/** Future privileged Settings routes mount this after verified authentication.
 * No route or capability response is installed by this foundation alone. */
export const requireSystemAdministrator: MiddlewareHandler<Bindings> = async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  assertSystemAdministrator(c.env, c.get("userEmail"));
  await next();
};
