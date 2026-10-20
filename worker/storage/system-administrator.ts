import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { accessEmailCapability, createSystemAdministratorMiddleware } from "../runtime/authorization";

type AdministratorEnvironment = Pick<Env, "AUTH_MODE" | "SYSTEM_ADMIN_EMAILS">;

/** The caller supplies the email from verified Access claims, after ordinary
 * application authentication. Administrator policy is deployment-owned and
 * separate from application access and File evidence operator permissions. */
export function canAdministerSystemSettings(env: AdministratorEnvironment, verifiedEmail: string): boolean {
  return accessEmailCapability(env.AUTH_MODE, verifiedEmail, env.SYSTEM_ADMIN_EMAILS);
}

export function assertSystemAdministrator(env: AdministratorEnvironment, verifiedEmail: string): void {
  if (!canAdministerSystemSettings(env, verifiedEmail)) {
    throw new HTTPException(403, { message: "System administrator access is required." });
  }
}

/** Future privileged Settings routes mount this after verified authentication.
 * No route or capability response is installed by this foundation alone. */
export const requireSystemAdministrator = createSystemAdministratorMiddleware<Env>(
  (_request, env, actor) => canAdministerSystemSettings(env, actor),
);
