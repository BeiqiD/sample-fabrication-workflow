import type { Env } from "../types";
import type { ProjectCreationSubjectScope } from "../../shared/project-creation-subject";

/** Deployment-owned realm metadata; no provider opening/bootstrap or SQL. The
 * optional configured namespace changes conservatively fence retained intent. */
export function workerProjectCreationSubjectScope(request: Request, env: Env): ProjectCreationSubjectScope {
  return {
    authenticationFamily: env.AUTH_MODE === "disabled" ? "worker-development" : "cloudflare-access",
    installationContext: JSON.stringify([new URL(request.url).origin, env.ACCESS_TEAM_DOMAIN ?? null,
      env.ACCESS_AUD ?? null, env.R2_BOOTSTRAP_NAMESPACE ?? null]),
  };
}
