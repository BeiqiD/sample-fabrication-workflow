import { Hono } from "hono";
import { classifyProjectFailure } from "../../worker/projects/failure";
import type { LocalAuthEnvironment } from "../auth/local-auth-http";
import { createLocalSampleSplitPermissionV28Candidate } from "./local-sample-split-permission-v28-candidate";
import { createLocalProjectReferenceInsertionV28Candidate } from "./local-project-reference-insertion-v28-candidate";
import { readGroupV28Json } from "./group-v28-request-body-custody";

/** The explicit composer keeps both whole original operations in its real
 * writer scope, and discards these subordinate issuers after original drain.
 * Splitting relevant media and Reference placement/lifecycle remain separate. */
export function createGroupV28SplitReferenceRoutesCandidate(options: Parameters<typeof createLocalSampleSplitPermissionV28Candidate>[0]) {
  const split = createLocalSampleSplitPermissionV28Candidate(options);
  const reference = createLocalProjectReferenceInsertionV28Candidate(options);
  const app = new Hono<LocalAuthEnvironment>();
  app.post("/api/samples/:sampleId/split", async c => {
    const request = c.req.raw, token = await split.capture(request, c.req.param("sampleId"));
    return c.json(await split.perform(request, token, () => readGroupV28Json(request, 65_536)), 201);
  });
  app.post("/api/projects/:projectId/items/reference", async c => {
    const request = c.req.raw, token = await reference.capture(request, c.req.param("projectId"));
    try {
      const result = await reference.createReference(request, token, () => readGroupV28Json(request, 65_536));
      return c.json(result, result.replayed ? 200 : 201);
    } catch (error) {
      const failure = await classifyProjectFailure(error, () => reference.creationSettlement(request, token));
      if (!failure) throw error;
      // The exact current original readonly revision/identity proof retains
      // authoritative rejection versus uncertain accepted-write semantics.
      if (failure.authoritativeRejection) c.header("x-project-mutation-disposition", "authoritative-rejection");
      return c.json({ error: failure.message }, failure.code === "not_found" ? 404 : 409);
    }
  });
  return Object.freeze({ app, routes: Object.freeze(app.routes.map(route => Object.freeze({ method: route.method, path: route.path }))),
    discard() { split.discard(); reference.discard(); } });
}
