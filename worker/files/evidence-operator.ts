import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";

type Bindings = { Bindings: Env; Variables: { userEmail: string } };
const EMAIL = /^[a-z0-9.!#$%&'+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i;

/** The actor must already come from validated Access claims. This allowlist is
 * deployment-owned, never inferred from ordinary application access, a request
 * header, an evidence statement, or the first person visiting the application. */
export function canAdjudicateFileEvidence(env: Pick<Env, "AUTH_MODE" | "FILE_EVIDENCE_OPERATOR_EMAILS">, actor: string): boolean {
  if (env.AUTH_MODE !== "access" || typeof actor !== "string" || actor.length > 254 || !EMAIL.test(actor)) return false;
  const configured = env.FILE_EVIDENCE_OPERATOR_EMAILS;
  if (typeof configured !== "string" || !configured.trim() || configured.length > 8192) return false;
  const entries = configured.split(",").map((entry) => entry.trim().toLowerCase());
  // A malformed list is not partially accepted. In particular no wildcard,
  // empty entry, or local-development identity can grant operator privileges.
  if (entries.length > 50 || entries.some((entry) => entry.length > 254 || !EMAIL.test(entry))) return false;
  return entries.includes(actor.toLowerCase());
}

export const requireFileEvidenceOperator: MiddlewareHandler<Bindings> = async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (!canAdjudicateFileEvidence(c.env, c.get("userEmail"))) {
    throw new HTTPException(403, { message: "File evidence operator access is required." });
  }
  await next();
};

export const fileEvidenceAccessRoutes = new Hono<Bindings>();
fileEvidenceAccessRoutes.get("/files/shadow/evidence/capabilities", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ canAdjudicate: canAdjudicateFileEvidence(c.env, c.get("userEmail")) });
});
