import type { Env } from "../types";
import { accessEmailCapability, createFileEvidenceAccessRoutes, createFileEvidenceOperatorMiddleware } from "../runtime/authorization";


/** The actor must already come from validated Access claims. This allowlist is
 * deployment-owned, never inferred from ordinary application access, a request
 * header, an evidence statement, or the first person visiting the application. */
export function canAdjudicateFileEvidence(env: Pick<Env, "AUTH_MODE" | "FILE_EVIDENCE_OPERATOR_EMAILS">, actor: string): boolean {
  return accessEmailCapability(env.AUTH_MODE, actor, env.FILE_EVIDENCE_OPERATOR_EMAILS);
}

const authorize = (_request: Request, env: Env, actor: string) => canAdjudicateFileEvidence(env, actor);
export const requireFileEvidenceOperator = createFileEvidenceOperatorMiddleware(authorize);
export const fileEvidenceAccessRoutes = createFileEvidenceAccessRoutes(authorize);
