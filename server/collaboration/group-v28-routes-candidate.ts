import type { LocalCommentSampleAttachmentReadPortV28Candidate } from "../files/local-comment-read-v28-candidate";
import { createLocalSampleProjectedDetailReadV28Candidate } from "./local-sample-projected-detail-read-v28-candidate";
import { createLocalMetrologyTemplateCreationV28Candidate } from "./local-metrology-template-creation-v28-candidate";
import { createLocalTemplateLifecycleV28Candidate } from "./local-template-lifecycle-v28-candidate";
import { createLocalTemplateStepDeleteV28Candidate } from "./local-template-step-delete-v28-candidate";
import { createGroupV28SplitReferenceRoutesCandidate } from "./group-v28-split-reference-routes-candidate";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { PROJECT_CREATION_SUBJECT_HEADER } from "../../shared/project-creation-subject";
import { classifyProjectFailure, type SettlementProof } from "../../worker/projects/failure";
import type { LocalAuthEnvironment } from "../auth/local-auth-http";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalSamplePermissionV28Candidate } from "./local-sample-permission-candidate";
import { createLocalProjectPermissionV28Candidate } from "./local-project-permission-v28-candidate";
import { createLocalProjectDirectoryV28Candidate } from "./local-project-directory-v28-candidate";
import { createLocalProjectFilteredReadV28Candidate } from "./local-project-filtered-read-v28-candidate";
import { createLocalProjectMarkdownPermissionV28Candidate } from "./local-project-markdown-permission-v28-candidate";
import { createLocalProjectMarkdownPlacementV28Candidate } from "./local-project-markdown-placement-v28-candidate";
import { createLocalProjectMarkdownItemLifecycleV28Candidate } from "./local-project-markdown-item-lifecycle-v28-candidate";
import { createLocalProjectMarkdownEdgeV28Candidate } from "./local-project-markdown-edge-v28-candidate";
import { createLocalProjectRootLifecycleV28Candidate } from "./local-project-root-lifecycle-v28-candidate";
import { createLocalMembershipManagementV28Candidate, type MembershipState, type MembershipStateChange } from "./local-membership-management-v28-candidate";
import { createLocalRootManagementV28Candidate, type RootManagementChange } from "./local-root-management-v28-candidate";
import { readGroupV28Json } from "./group-v28-request-body-custody";
import { createLocalReferenceReadV28Candidate } from "./local-reference-read-v28-candidate";
import { createLocalTemplateReadPermissionV28Candidate } from "./local-template-read-permission-v28-candidate";
import { createLocalMetrologyMetadataPermissionV28Candidate } from "./local-metrology-metadata-permission-v28-candidate";
import { createLocalRunTrashPermissionV28Candidate } from "./local-run-trash-permission-v28-candidate";
import { createLocalSampleRecordPermissionV28Candidate } from "./local-sample-record-permission-v28-candidate";
import { createLocalSampleRecordRemovePermissionV28Candidate } from "./local-sample-record-remove-permission-v28-candidate";
import { createLocalRunStepCommentPermissionV28Candidate } from "./local-run-step-comment-permission-v28-candidate";
import { createLocalCommentLifecyclePermissionV28Candidate } from "./local-comment-lifecycle-permission-v28-candidate";
import { createLocalTemplatePermissionV28Candidate } from "./local-template-permission-v28-candidate";
import { createLocalRunFinishPermissionV28Candidate } from "./local-run-finish-permission-v28-candidate";
import { createLocalExecutionStepPatchV28Candidate } from "./local-execution-step-patch-v28-candidate";
import { createLocalStepConfirmationPermissionV28Candidate } from "./local-step-confirmation-permission-v28-candidate";
import { createLocalRunStartPreviewPermissionV28Candidate } from "./local-run-start-preview-permission-v28-candidate";
import { createLocalRunPlanUpdatePermissionV28Candidate } from "./local-run-plan-update-permission-v28-candidate";

type Options = Parameters<typeof createLocalProjectPermissionV28Candidate>[0] & Readonly<{ sampleMetadataReads?: true
  sampleCanonicalAttachmentReadPort?: LocalCommentSampleAttachmentReadPortV28Candidate; }>;
type Ctx = Context<LocalAuthEnvironment>;
const bad = () => new HTTPException(400, { message: "Invalid collaboration request." });
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const revision = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v < Number.MAX_SAFE_INTEGER;
const state = (v: unknown): v is MembershipState => v === "active" || v === "suspended" || v === "left";
function memberChange(v: unknown): MembershipStateChange {
  if (!record(v) || !revision(v.expectedRevision) || !state(v.expectedState) || !state(v.state)
    || Object.keys(v).some(k => !["expectedRevision", "expectedState", "state"].includes(k))) throw bad();
  return { expectedRevision: v.expectedRevision, expectedState: v.expectedState, state: v.state };
}
function policyChange(v: unknown, operation: "visibility" | "grant"): RootManagementChange {
  if (!record(v) || !revision(v.expectedResourceRevision) || v.operation !== operation) throw bad();
  if (operation === "visibility") {
    if (v.visibility !== "workspace" && v.visibility !== "restricted"
      || Object.keys(v).some(k => !["operation", "expectedResourceRevision", "visibility"].includes(k))) throw bad();
    return { operation, expectedResourceRevision: v.expectedResourceRevision, visibility: v.visibility };
  }
  if (v.expectedGrantRevision !== null && !revision(v.expectedGrantRevision)
    || typeof v.enabled !== "boolean" || (v.capability !== "read" && v.capability !== "operate" && v.capability !== "edit" && v.capability !== "manage")
    || Object.keys(v).some(k => !["operation", "expectedResourceRevision", "expectedGrantRevision", "enabled", "capability"].includes(k))) throw bad();
  return { operation, expectedResourceRevision: v.expectedResourceRevision, expectedGrantRevision: v.expectedGrantRevision,
    capability: v.capability, enabled: v.enabled };
}
async function projectFailure(c: Ctx, error: unknown, proof?: SettlementProof) {
  const failure = await classifyProjectFailure(error, proof);
  if (!failure) throw error;
  if (failure.authoritativeRejection) c.header("x-project-mutation-disposition", "authoritative-rejection");
  return c.json({ error: failure.message }, failure.code === "not_found" ? 404 : 409);
}

/** Typed wrappers only. Every token comes from this original ingress Request;
 * parsing never clones/replaces it. The owners retain the mature algorithms and
 * fresh same-BEGIN decisions. Only the explicit stopped V28 application mounts
 * these routes; the default Worker and V26 Node applications retain their owners. */
export function createGroupV28RoutesCandidate(options: Options) {
  const sample = createLocalSamplePermissionV28Candidate(options), project = createLocalProjectPermissionV28Candidate(options);
  const directory = createLocalProjectDirectoryV28Candidate(options), reading = createLocalProjectFilteredReadV28Candidate(options);
  const markdown = createLocalProjectMarkdownPermissionV28Candidate(options), placement = createLocalProjectMarkdownPlacementV28Candidate(options);
  const item = createLocalProjectMarkdownItemLifecycleV28Candidate(options), edge = createLocalProjectMarkdownEdgeV28Candidate(options);
  const rootLifecycle = createLocalProjectRootLifecycleV28Candidate(options), membership = createLocalMembershipManagementV28Candidate(options);
  const management = createLocalRootManagementV28Candidate(options);
  const references = createLocalReferenceReadV28Candidate(options), templateReads = createLocalTemplateReadPermissionV28Candidate(options);
  const metrology = createLocalMetrologyMetadataPermissionV28Candidate(options), runTrash = createLocalRunTrashPermissionV28Candidate(options);
  const metrologyCreation = createLocalMetrologyTemplateCreationV28Candidate(options);
  const templateLifecycle = createLocalTemplateLifecycleV28Candidate(options);
  const stepDelete = createLocalTemplateStepDeleteV28Candidate(options);
  const records = createLocalSampleRecordPermissionV28Candidate(options), recordRemoval = createLocalSampleRecordRemovePermissionV28Candidate(options);
  const comments = createLocalRunStepCommentPermissionV28Candidate(options), commentLifecycle = createLocalCommentLifecyclePermissionV28Candidate(options);
  const recipes = createLocalTemplatePermissionV28Candidate(options), runFinish = createLocalRunFinishPermissionV28Candidate(options);
  const confirmation = createLocalStepConfirmationPermissionV28Candidate(options), runStart = createLocalRunStartPreviewPermissionV28Candidate(options);
  const runPlan = createLocalRunPlanUpdatePermissionV28Candidate(options);
  const executionPatch = createLocalExecutionStepPatchV28Candidate(options);
  const sampleReading = options.sampleMetadataReads === true ? createLocalSampleProjectedDetailReadV28Candidate(options) : undefined;
  const splitReference = createGroupV28SplitReferenceRoutesCandidate(options);
  const app = new Hono<LocalAuthEnvironment>();
  app.route("/", splitReference.app);
  const body = (request: Request, bytes = 65_536) => readGroupV28Json(request, bytes);
  const actor = async (request: Request) => (await localAuthenticationIdentityAuthority(options.authentication).authenticateRequest(request)).actor;
  const templateQuery = (c: Ctx) => ({ query: c.req.query("q"), page: c.req.query("page"), pageSize: c.req.query("pageSize") });
  app.get("/api/sample-directory-options", async c => {
    const r = c.req.raw, token = await sample.capture(r, { operation: "directory_options" });
    const result = await sample.directoryOptions(r, token); c.header("Server-Timing", result.serverTiming); return c.json(result.payload);
  });
  app.get("/api/samples", async c => {
    if (sampleReading && c.req.query("view") === "processing") {
      const request=c.req.raw,token=await sampleReading.capture(request,{operation:"processing"});
      const result=await sampleReading.perform(request,token) as {payload:unknown;serverTiming:string};
      c.header("Server-Timing",result.serverTiming);return c.json(result.payload);
    }
    const r = c.req.raw, token = await sample.capture(r, { operation: "directory" });
    const result = await sample.directory(r, token); c.header("Server-Timing", result.serverTiming); return c.json(result.payload);
  });
  app.post("/api/samples", async c => {
    const r = c.req.raw, token = await sample.capture(r, { operation: "create" }); return c.json(await sample.create(r, token, await body(r)), 201);
  });
  app.patch("/api/samples/:id", async c => {
    const r = c.req.raw, id = c.req.param("id"), token = await sample.capture(r, { operation: "update", id });
    return c.json(await sample.update(r, token, id, await body(r)));
  });
  app.delete("/api/samples/:id", async c => {
    const r = c.req.raw, id = c.req.param("id"), token = await sample.capture(r, { operation: "remove", id });
    return c.json(await sample.remove(r, token, id, await body(r)));
  });
  app.post("/api/samples/:id/restore", async c => {
    const r = c.req.raw, id = c.req.param("id"), token = await sample.capture(r, { operation: "restore", id });
    return c.json(await sample.restore(r, token, id, await body(r)));
  });
  app.get("/api/projects", async c => {
    const r = c.req.raw, token = await directory.capture(r), result = await directory.directory(r, token);
    c.header(PROJECT_CREATION_SUBJECT_HEADER, result.creationSubject); return c.json(result.value);
  });
  app.get("/api/projects/:projectId", async c => {
    const r = c.req.raw, token = await reading.capture(r);
    try { return c.json(await reading.snapshot(r, token)); } catch (error) { return projectFailure(c, error); }
  });
  app.post("/api/projects", async c => {
    const r = c.req.raw, token = await project.capture(r, { operation: "create" });
    try { const result = await project.create(r, token, await body(r, 8192)); return c.json(result, result.replayed ? 200 : 201); }
    catch (error) { return projectFailure(c, error); }
  });
  app.patch("/api/projects/:projectId", async c => {
    const r = c.req.raw, token = await project.capture(r, { operation: "rename", id: c.req.param("projectId") });
    try { return c.json(await project.rename(r, token, await body(r, 8192))); } catch (error) { return projectFailure(c, error); }
  });
  app.post("/api/projects/:projectId/items/markdown", async c => {
    const r = c.req.raw, token = await markdown.capture(r, { operation: "create-markdown", projectId: c.req.param("projectId") }), input = await body(r, 2_500_000);
    try { const result = await markdown.createMarkdown(r, token, input); return c.json(result, result.replayed ? 200 : 201); }
    catch (error) { return projectFailure(c, error, () => markdown.creationSettlement(r, token, input)); }
  });
  app.patch("/api/projects/:projectId/contents/:contentId/markdown", async c => {
    const r = c.req.raw, token = await markdown.capture(r, { operation: "update-markdown", projectId: c.req.param("projectId"), contentId: c.req.param("contentId") });
    try { return c.json(await markdown.updateMarkdown(r, token, await body(r, 2_500_000))); } catch (error) { return projectFailure(c, error); }
  });
  app.patch("/api/projects/:projectId/placements/:placementId", async c => {
    const r = c.req.raw, token = await placement.capture(r, { operation: "update-placement", projectId: c.req.param("projectId"), placementId: c.req.param("placementId") }), input = await body(r, 2_500_000);
    try { return c.json(await placement.updatePlacement(r, token, input)); }
    catch (error) { return projectFailure(c, error, () => placement.placementSettlement(r, token, input)); }
  });
  app.delete("/api/projects/:projectId/items/:itemId", async c => {
    const r = c.req.raw, token = await item.capture(r, { operation: "remove-item", projectId: c.req.param("projectId"), itemId: c.req.param("itemId") });
    try { return c.json(await item.removeItem(r, token, await body(r))); } catch (error) { return projectFailure(c, error); }
  });
  app.post("/api/projects/:projectId/items/:itemId/restore", async c => {
    const r = c.req.raw, token = await item.capture(r, { operation: "restore-item", projectId: c.req.param("projectId"), itemId: c.req.param("itemId") });
    try { return c.json(await item.restoreItem(r, token, await body(r))); } catch (error) { return projectFailure(c, error); }
  });
  app.post("/api/projects/:projectId/edges", async c => {
    const r = c.req.raw, token = await edge.capture(r, { operation: "create-edge", projectId: c.req.param("projectId") }), input = await body(r, 16_384);
    try { const result = await edge.create(r, token, input); return c.json(result, result.replayed ? 200 : 201); }
    catch (error) { return projectFailure(c, error, () => edge.creationSettlement(r, token, input)); }
  });
  app.patch("/api/projects/:projectId/edges/:edgeId", async c => {
    const r = c.req.raw, token = await edge.capture(r, { operation: "update-edge", projectId: c.req.param("projectId"), edgeId: c.req.param("edgeId") });
    try { return c.json(await edge.update(r, token, await body(r, 16_384))); } catch (error) { return projectFailure(c, error); }
  });
  app.delete("/api/projects/:projectId/edges/:edgeId", async c => {
    const r = c.req.raw, token = await edge.capture(r, { operation: "remove-edge", projectId: c.req.param("projectId"), edgeId: c.req.param("edgeId") });
    try { return c.json(await edge.remove(r, token, await body(r, 16_384))); } catch (error) { return projectFailure(c, error); }
  });
  app.post("/api/projects/:projectId/edges/:edgeId/restore", async c => {
    const r = c.req.raw, token = await edge.capture(r, { operation: "restore-edge", projectId: c.req.param("projectId"), edgeId: c.req.param("edgeId") });
    try { return c.json(await edge.restore(r, token, await body(r, 16_384))); } catch (error) { return projectFailure(c, error); }
  });
  app.delete("/api/projects/:projectId", async c => {
    const r = c.req.raw, token = await rootLifecycle.capture(r, { operation: "remove-project", projectId: c.req.param("projectId") });
    try { return c.json(await rootLifecycle.remove(r, token, await body(r, 4096))); } catch (error) { return projectFailure(c, error); }
  });
  app.post("/api/projects/:projectId/restore", async c => {
    const r = c.req.raw, token = await rootLifecycle.capture(r, { operation: "restore-project", projectId: c.req.param("projectId") });
    try { return c.json(await rootLifecycle.restore(r, token, await body(r, 4096))); } catch (error) { return projectFailure(c, error); }
  });
  app.get("/api/collaboration/members", async c => {
    const r = c.req.raw, token = await membership.capture(r, { operation: "roster" }); return c.json(await membership.roster(r, token));
  });
  app.put("/api/collaboration/members/:memberId/state", async c => {
    const r = c.req.raw, token = await membership.capture(r, { operation: "state", memberId: c.req.param("memberId") });
    return c.json(await membership.changeState(r, token, memberChange(await body(r))));
  });
  app.put("/api/collaboration/resources/:kind/:rootId/visibility", async c => {
    const r = c.req.raw, kind = c.req.param("kind"); if (kind !== "sample" && kind !== "project" && kind !== "template") throw bad();
    const token = await management.capture(r, { operation: "visibility", root: { kind, id: c.req.param("rootId") } });
    return c.json(await management.change(r, token, policyChange(await body(r), "visibility")));
  });
  app.put("/api/collaboration/resources/:kind/:rootId/grants/:memberId", async c => {
    const r = c.req.raw, kind = c.req.param("kind"); if (kind !== "sample" && kind !== "project" && kind !== "template") throw bad();
    const token = await management.capture(r, { operation: "grant", root: { kind, id: c.req.param("rootId") }, memberId: c.req.param("memberId") });
    return c.json(await management.change(r, token, policyChange(await body(r), "grant")));
  });
  for (const path of ["/api/references/resolve", "/api/references/children", "/api/references/search"] as const) {
    app.post(path, async c => {
      const r = c.req.raw, token = await references.capture(r);
      // The owner retains the original Request.json promise inside perform;
      // the physical HTTP owner retains the original request stream drain.
      return Response.json(await references.perform(r, token));
    });
  }
  app.get("/api/template-families/options", async c => {
    const r = c.req.raw; return c.json(await templateReads.service(r).options(await actor(r)));
  });
  app.get("/api/template-families", async c => {
    const r = c.req.raw; return c.json(await templateReads.service(r).families(templateQuery(c), await actor(r)));
  });
  app.get("/api/template-families/:id/versions", async c => {
    const r = c.req.raw; return c.json(await templateReads.service(r).versions(c.req.param("id"), c.req.query("q")?.trim() ?? "", await actor(r)));
  });
  app.post("/api/metrology-templates", async c => {
    const request = c.req.raw, token = await metrologyCreation.capture(request);
    return c.json(await metrologyCreation.create(request, token, () => body(request)), 201);
  });
  app.get("/api/metrology-templates", async c => {
    const r = c.req.raw; return c.json(await templateReads.service(r).metrology(templateQuery(c), await actor(r)));
  });
  app.get("/api/templates", async c => {
    const r = c.req.raw; return c.json(await templateReads.service(r).list(c.req.query("view") === "picker", await actor(r)));
  });
  app.get("/api/templates/:id", async c => {
    const r = c.req.raw; return c.json(await templateReads.service(r).detail(c.req.param("id"), await actor(r)));
  });
  app.post("/api/samples/:sampleId/metrology-runs", async c => {
    const r = c.req.raw, token = await metrology.capture(r, { operation: "startRun", sampleId: c.req.param("sampleId") });
    return c.json(await metrology.perform(r, token, () => body(r)), 201);
  });
  app.post("/api/samples/:sampleId/runs/:runId/metrology", async c => {
    const r = c.req.raw, token = await metrology.capture(r, { operation: "addEntry", sampleId: c.req.param("sampleId"), runId: c.req.param("runId") });
    return c.json(await metrology.perform(r, token, () => body(r)), 201);
  });
  app.delete("/api/samples/:sampleId/runs/:runId", async c => {
    const r = c.req.raw, token = await runTrash.capture(r, { operation: "remove", sampleId: c.req.param("sampleId"), runId: c.req.param("runId") });
    return c.json(await runTrash.mutate(r, token, () => body(r)));
  });
  app.post("/api/samples/:sampleId/runs/:runId/restore", async c => {
    const r = c.req.raw, token = await runTrash.capture(r, { operation: "restore", sampleId: c.req.param("sampleId"), runId: c.req.param("runId") });
    return c.json(await runTrash.mutate(r, token, () => body(r)));
  });
  app.post("/api/samples/:sampleId/records", async c => {
    const r = c.req.raw, token = await records.capture(r, c.req.param("sampleId"));
    return c.json(await records.perform(r, token, () => body(r)), 201);
  });
  app.delete("/api/samples/:sampleId/records/:eventId", async c => {
    const r = c.req.raw, token = await recordRemoval.capture(r, c.req.param("sampleId"), c.req.param("eventId"));
    return c.json(await recordRemoval.perform(r, token));
  });
  app.post("/api/run-step-comments", async c => {
    const r = c.req.raw, token = await comments.capture(r);
    return c.json(await comments.perform(r, token, () => body(r)), 201);
  });
  app.delete("/api/run-step-comments/:commentId", async c => {
    const r = c.req.raw, token = await commentLifecycle.capture(r, { operation: "remove", commentId: c.req.param("commentId") });
    return c.json(await commentLifecycle.perform(r, token));
  });
  app.post("/api/run-step-comments/:commentId/restore", async c => {
    const r = c.req.raw, token = await commentLifecycle.capture(r, { operation: "restore", commentId: c.req.param("commentId") });
    return c.json(await commentLifecycle.perform(r, token));
  });
  app.patch("/api/templates/:id", async c => {
    const request=c.req.raw,token=await templateLifecycle.capture(request,{operation:"rename",templateId:c.req.param("id")});
    return c.json(await templateLifecycle.perform(request,token,()=>body(request)));
  });
  app.delete("/api/templates/:id", async c => {
    const request=c.req.raw,token=await templateLifecycle.capture(request,{operation:"remove",templateId:c.req.param("id")});
    return c.json(await templateLifecycle.perform(request,token));
  });
  app.post("/api/templates/:id/restore", async c => {
    const request=c.req.raw,token=await templateLifecycle.capture(request,{operation:"restore",templateId:c.req.param("id")});
    return c.json(await templateLifecycle.perform(request,token));
  });
  app.post("/api/templates/:templateId/clone", async c => {
    const r = c.req.raw, token = await recipes.capture(r, { operation: "clone", templateId: c.req.param("templateId") });
    return c.json(await recipes.clone(r, token), 201);
  });
  app.post("/api/templates/:templateId/steps", async c => {
    const r = c.req.raw, token = await recipes.capture(r, { operation: "createStep", templateId: c.req.param("templateId") });
    return c.json(await recipes.createStep(r, token, () => body(r)), 201);
  });
  app.patch("/api/templates/:templateId/steps/:stepId", async c => {
    const r = c.req.raw, token = await recipes.capture(r, { operation: "updateStep", templateId: c.req.param("templateId"), stepId: c.req.param("stepId") });
    return c.json(await recipes.updateStep(r, token, () => body(r)));
  });
  app.delete("/api/templates/:templateId/steps/:stepId", async c => {
    const request = c.req.raw, token = await stepDelete.capture(request, { templateId: c.req.param("templateId"), stepId: c.req.param("stepId") });
    return c.json(await stepDelete.perform(request, token));
  });
  app.post("/api/samples/:sampleId/runs/:runId/finish", async c => {
    const r = c.req.raw, token = await runFinish.capture(r, { sampleId: c.req.param("sampleId"), runId: c.req.param("runId") });
    return c.json(await runFinish.finish(r, token, () => body(r)));
  });
  app.patch("/api/samples/:sampleId/runs/:runId/steps/:stepId",async c=>{
    const request=c.req.raw,token=await executionPatch.capture(request,{sampleId:c.req.param("sampleId"),runId:c.req.param("runId"),stepId:c.req.param("stepId")});
    return c.json(await executionPatch.patch(request,token,()=>body(request)));
  });
  app.post("/api/run-steps/confirm", async c => {
    const r = c.req.raw, token = await confirmation.capture(r);
    return c.json(await confirmation.confirm(r, token, () => body(r)));
  });
  app.post("/api/samples/:sampleId/runs/preview", async c => {
    const r = c.req.raw, token = await runStart.capture(r, { operation: "preview", sampleId: c.req.param("sampleId") });
    return c.json(await runStart.perform(r, token, () => body(r)));
  });
  app.post("/api/samples/:sampleId/runs", async c => {
    const r = c.req.raw, token = await runStart.capture(r, { operation: "start", sampleId: c.req.param("sampleId") });
    return c.json(await runStart.perform(r, token, () => body(r)), 201);
  });
  app.post("/api/samples/:sampleId/runs/:runId/plan-update/preview", async c => {
    const r = c.req.raw, token = await runPlan.capture(r, { operation: "preview", sampleId: c.req.param("sampleId"), runId: c.req.param("runId") });
    return c.json(await runPlan.perform(r, token, () => body(r)));
  });
  app.post("/api/samples/:sampleId/runs/:runId/plan-update", async c => {
    const r = c.req.raw, token = await runPlan.capture(r, { operation: "apply", sampleId: c.req.param("sampleId"), runId: c.req.param("runId") });
    return c.json(await runPlan.perform(r, token, () => body(r)));
  });
  if (sampleReading) app.get("/api/samples/:id",async c=>{
    const request=c.req.raw,token=await sampleReading.capture(request,{operation:"detail",sampleId:c.req.param("id")});
    return c.json(await sampleReading.perform(request,token));
  });
  const routes = Object.freeze(app.routes.map(r => Object.freeze({ method: r.method, path: r.path })));
  return Object.freeze({ app, routes, discard() {
    project.discard(); directory.discard(); reading.discard(); markdown.discard(); placement.discard(); item.discard();
    edge.discard(); rootLifecycle.discard(); membership.discard(); management.discard();
    references.discard(); templateReads.discard(); metrology.discard(); metrologyCreation.discard(); templateLifecycle.discard(); runTrash.discard(); records.discard(); recordRemoval.discard();
    executionPatch.discard();
    comments.discard(); commentLifecycle.discard(); recipes.discard(); stepDelete.discard(); runFinish.discard(); confirmation.discard(); runStart.discard(); runPlan.discard();
    splitReference.discard();
    sampleReading?.discard();
    // The Sample issuer has no discard API. It never escapes this application;
    // transport admission stops before drain and its bound core closes last.
  } });
}
