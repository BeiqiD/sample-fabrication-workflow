import { Hono, type MiddlewareHandler } from "hono";
import { isProjectCreationSubject, projectCreationSubject } from "../../shared/project-creation-subject";
import { workerProjectCreationSubjectScope } from "../projects/creation-subject";
import type { Env } from "../types";

type ApiEnvironment = { Bindings: Env; Variables: { userEmail: string } };
const EXPECTED_SUBJECT_HEADER = "x-sfw-expected-subject";
const IDENTITY_RESULT_HEADER = "x-sfw-identity-result";

/** An expected subject binds retained browser intent to the authenticated actor
 * and installation. It is not a credential or a grant. Older clients without
 * the header keep their existing server-side authorization and admission. */
export const applicationIdentityAdmission: MiddlewareHandler<ApiEnvironment> = async (c, next) => {
  if (c.req.path === "/api/health") return next();
  const expected = c.req.header(EXPECTED_SUBJECT_HEADER);
  if (expected !== undefined && (!isProjectCreationSubject(expected)
    || expected !== await projectCreationSubject(c.get("userEmail"), workerProjectCreationSubjectScope(c.req.raw, c.env)))) {
    c.header("Cache-Control", "private, no-store");
    c.header(IDENTITY_RESULT_HEADER, "mismatch");
    return c.json({ error: "Sign-in identity changed. Refresh before continuing saved work." }, 409);
  }
  await next();
};

/** Available after authentication and before maintenance, without any SQL or
 * provider access, so recovery can identify its browser owner while fenced. */
export const applicationIdentityRoutes = new Hono<ApiEnvironment>();
applicationIdentityRoutes.get("/identity", async c => {
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  return c.json({ schema: "application-identity/1",
    subject: await projectCreationSubject(c.get("userEmail"), workerProjectCreationSubjectScope(c.req.raw, c.env)) });
});
