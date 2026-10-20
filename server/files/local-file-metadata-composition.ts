import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Server } from "node:http";
import { classifyProjectFailure } from "../../worker/projects/failure";
import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";
import { localAuthenticationIdentityAuthority, type LocalAuthEnvironment } from "../auth/local-auth-http";
import { stopNodeHttpServerAndDrain } from "../http";
import type { ReviewedInstallationAdmission } from "../migrations";
import type { SqliteCapability } from "../sqlite";
import { ownedLocalVolumeProfileContext, type LocalVolumeProfileOpening } from "../storage/local-volume-profile-opening";
import { createLocalFileDefinitionMetadataExecution } from "./local-file-definition-metadata";
import { createLocalFileExecutionMetadataExecution } from "./local-file-execution-metadata";
import { createLocalFileExecutionInsertionMetadataExecution } from "./local-file-execution-insertion-metadata";
import { createLocalFileProjectMetadataExecution } from "./local-file-project-metadata";
import { createLocalFileRestorationMetadataExecution } from "./local-file-restoration-metadata";
import { createLocalFileSampleRecordMetadataExecution } from "./local-file-sample-record-metadata";
import { createLocalFileSampleMetadataExecution } from "./local-file-sample-metadata";

type Environment = LocalAuthEnvironment<{ readonly database: SqliteCapability }>;
interface Execution { readonly settled: Promise<void>; dispose(): Promise<void> }
interface RetainedOperation {
  readonly execution: Execution;
  original?: Promise<Response>;
  failed: boolean;
  failure?: unknown;
  cleanupFailed: boolean;
  cleanupFailure?: unknown;
}

/** These are complete original methods, not new permissions for their owner.
 * The Project attachment PATCH overlaps the legacy Node business surface and
 * must replace that active-File branch, never count as a second new method. */
export const LOCAL_FILE_METADATA_ROUTES = Object.freeze([
  { owner: "sample", method: "POST", path: "/samples" },
  { owner: "sample", method: "PATCH", path: "/samples/:id" },
  { owner: "sample", method: "DELETE", path: "/samples/:id" },
  { owner: "sample", method: "POST", path: "/samples/:id/restore" },
  { owner: "processDefinition", method: "POST", path: "/templates/:id/clone" },
  { owner: "processDefinition", method: "POST", path: "/templates/:id/steps" },
  { owner: "processDefinition", method: "PATCH", path: "/templates/:templateId/steps/:stepId" },
  { owner: "execution", method: "PATCH", path: "/samples/:sampleId/runs/:runId/steps/:stepId" },
  { owner: "execution", method: "DELETE", path: "/samples/:sampleId/runs/:runId/steps/:stepId/assets" },
  { owner: "execution", method: "POST", path: "/samples/:sampleId/runs/:runId/steps/:stepId/assets/restore" },
  { owner: "execution", method: "POST", path: "/samples/:sampleId/runs/:runId/steps" },
  { owner: "executionVerification", method: "POST", path: "/samples/:sampleId/runs/:runId/steps/:stepId/verify-state" },
  { owner: "project", method: "POST", path: "/projects/:projectId/items/attachment" },
  { owner: "project", method: "POST", path: "/projects/:projectId/items/attachment/copy" },
  { owner: "project", method: "PATCH", path: "/projects/:projectId/contents/:contentId/attachment" },
  { owner: "processDefinition", method: "DELETE", path: "/metrology-templates/:id/references/:referenceId" },
  { owner: "processDefinition", method: "POST", path: "/metrology-templates/:id/references/:referenceId/restore" },
  { owner: "project", method: "POST", path: "/projects/:projectId/items/:itemId/restore" },
  { owner: "sample", method: "POST", path: "/samples/:id/split" },
  { owner: "sample", method: "POST", path: "/samples/:id/records" },
  { owner: "sample", method: "DELETE", path: "/samples/:id/records/:eventId" },
  { owner: "sample", method: "DELETE", path: "/samples/:id/events/:eventId/asset" },
].map(route => Object.freeze(route)));

export class LocalFileMetadataDrainError extends AggregateError {
  declare readonly retainedOwners: readonly unknown[];
  constructor(errors: readonly unknown[], owners: readonly unknown[]) {
    super(errors, "Original local File metadata ownership could not drain");
    this.name = "LocalFileMetadataDrainError";
    Object.defineProperty(this, "retainedOwners", { value: Object.freeze([...owners]) });
  }
}
function cleanupUnproven(error: unknown): boolean {
  // All unknown batch/rollback aggregates stay quarantined. An ordinary
  // business denial can only settle after its issuer's exact source-lease ACK.
  return error instanceof StorageProfileCleanupError || error instanceof AggregateError;
}

/** Source-only application composition seam. The sole File host supplies its
 * already issued opening and actual authentication; this creates no Native,
 * opening, profile, default, account, session, grant or byte provider.
 *
 * Each fixed route independently issues its original-Request domain authority
 * before any body consumption. Its complete original algorithm and same-BEGIN
 * checks run inside the composer's existing writerLease.withWriter invocation.
 * This registry cannot turn a Sample/admin/Group grant into another domain.
 * The sole host must stop this owner before physical drain and await this exact
 * original drain before opening.close, Native close and physical release.
 * Existing legacy/research gates and other Node methods are untouched.
 */
export function createLocalFileMetadataComposition(options: {
  readonly opening: LocalVolumeProfileOpening;
  readonly authentication: object;
  readonly admission: ReviewedInstallationAdmission;
  readonly publicOrigin: string;
}) {
  if (Object.keys(options).sort().join(",") !== "admission,authentication,opening,publicOrigin")
    throw new Error("Local File metadata composition is unavailable");
  const { opening, authentication, admission, publicOrigin } = options;
  const owner = ownedLocalVolumeProfileContext(opening);
  const auth = localAuthenticationIdentityAuthority(authentication);
  if (new URL(publicOrigin).origin !== publicOrigin) throw new Error("Canonical local origin is required");
  const retained = new Set<RetainedOperation>();
  let phase: "open" | "stopping" | "closed" | "quarantined" = "open";
  let closing: Promise<void> | undefined;
  let dispatched = false;
  const routes = new Hono<Environment>();
  function context(c: Context<Environment>) {
    dispatched = true;
    if (phase !== "open") throw new HTTPException(503, { message: "File storage is unavailable" });
    owner.assertCurrent();
    if (localAuthenticationIdentityAuthority(authentication) !== auth || new URL(c.req.raw.url).origin !== publicOrigin)
      throw new HTTPException(403, { message: "Original Request admission is required." });
    return { opening, authentication, admission, request: c.req.raw, actor: c.get("userEmail") };
  }
  function original<T, E extends Execution>(c: Context<Environment>, execution: E,
    invoke: (current: E) => Promise<T>, status: (answer: T) => 200 | 201 = () => 200): Promise<Response> {
    // Strong owner registration precedes the first original body/SQL await.
    const record: RetainedOperation = { execution, failed: false, cleanupFailed: false };
    retained.add(record);
    const operation = (async () => {
      try { const answer = await invoke(execution); return c.json(answer, status(answer)); }
      catch (error) { record.failed = true; record.failure = error; throw error; }
      finally {
        try { await execution.dispose(); }
        catch (error) {
          // Exact original business rejection is safe only after the issuer
          // proves its source hold released and the genuine core is live.
          if (!record.failed || error !== record.failure || cleanupUnproven(error)) {
            record.cleanupFailed = true; record.cleanupFailure = error;
          }
        }
        try { owner.database.primary(); } catch (error) {
          if (!record.cleanupFailed) record.cleanupFailure = error;
          record.cleanupFailed = true;
        }
        if (record.cleanupFailed) {
          phase = "quarantined";
          throw new LocalFileMetadataDrainError(record.failed ? [record.failure, record.cleanupFailure] : [record.cleanupFailure],
            [opening, auth, owner, record]);
        }
        else retained.delete(record);
      }
    })();
    operation.then(() => undefined, () => undefined);
    record.original = operation;
    return operation;
  }
  const created = () => 201 as const;
  const replayCreated = (answer: { replayed?: boolean }) => answer.replayed ? 200 as const : 201 as const;
  const id = (c: Context<Environment>, key: string) => c.req.param(key) ?? "";
  // Factories recheck the exact decoded IDs against the captured raw Request;
  // the router supplies no parsed body, token, role, database or grant.
  // Match the mature Sample surface's JSON-to-null validation behavior. Issue
  // the original Request owner and retain its operation before consuming body.
  routes.post("/samples", c => original(c, createLocalFileSampleMetadataExecution(context(c)),
    async e => e.create(await c.req.json<unknown>().catch(() => null)), created));
  routes.patch("/samples/:id", c => original(c, createLocalFileSampleMetadataExecution(context(c)),
    async e => e.update(id(c, "id"), await c.req.json<unknown>().catch(() => null))));
  routes.delete("/samples/:id", c => original(c, createLocalFileSampleMetadataExecution(context(c)),
    async e => e.remove(id(c, "id"), await c.req.json<unknown>().catch(() => null))));
  routes.post("/samples/:id/restore", c => original(c, createLocalFileSampleMetadataExecution(context(c)),
    async e => e.restore(id(c, "id"), await c.req.json<unknown>().catch(() => null))));
  routes.post("/templates/:id/clone", c => original(c, createLocalFileDefinitionMetadataExecution(context(c)), e => e.clone(id(c, "id")), created));
  routes.post("/templates/:id/steps", c => original(c, createLocalFileDefinitionMetadataExecution(context(c)), e => e.createStep(id(c, "id")), created));
  routes.patch("/templates/:templateId/steps/:stepId", c => original(c, createLocalFileDefinitionMetadataExecution(context(c)), e => e.updateStep(id(c, "templateId"), id(c, "stepId"))));
  routes.patch("/samples/:sampleId/runs/:runId/steps/:stepId", c => original(c, createLocalFileExecutionMetadataExecution(context(c)), e => e.updateStep(id(c, "sampleId"), id(c, "runId"), id(c, "stepId"))));
  routes.delete("/samples/:sampleId/runs/:runId/steps/:stepId/assets", c => original(c, createLocalFileExecutionMetadataExecution(context(c)), e => e.removeAsset(id(c, "sampleId"), id(c, "runId"), id(c, "stepId"))));
  routes.post("/samples/:sampleId/runs/:runId/steps/:stepId/assets/restore", c => original(c, createLocalFileExecutionMetadataExecution(context(c)), e => e.restoreAsset(id(c, "sampleId"), id(c, "runId"), id(c, "stepId"))));
  routes.post("/samples/:sampleId/runs/:runId/steps", c => original(c, createLocalFileExecutionInsertionMetadataExecution(context(c)), e => e.createStep(id(c, "sampleId"), id(c, "runId")), created));
  routes.post("/samples/:sampleId/runs/:runId/steps/:stepId/verify-state", c => original(c, createLocalFileExecutionInsertionMetadataExecution(context(c)), e => e.verifyState(id(c, "sampleId"), id(c, "runId"), id(c, "stepId")), created));
  routes.post("/projects/:projectId/items/attachment", c => original(c, createLocalFileProjectMetadataExecution(context(c)), e => e.createAttachment(id(c, "projectId")), replayCreated));
  routes.post("/projects/:projectId/items/attachment/copy", c => original(c, createLocalFileProjectMetadataExecution(context(c)), e => e.copyAttachment(id(c, "projectId")), replayCreated));
  routes.patch("/projects/:projectId/contents/:contentId/attachment", c => original(c, createLocalFileProjectMetadataExecution(context(c)), e => e.updateAttachment(id(c, "projectId"), id(c, "contentId"))));
  routes.delete("/metrology-templates/:id/references/:referenceId", c => original(c, createLocalFileRestorationMetadataExecution(context(c)), e => e.removeReference(id(c, "id"), id(c, "referenceId"))));
  routes.post("/metrology-templates/:id/references/:referenceId/restore", c => original(c, createLocalFileRestorationMetadataExecution(context(c)), e => e.restoreReference(id(c, "id"), id(c, "referenceId"))));
  routes.post("/projects/:projectId/items/:itemId/restore", c => original(c, createLocalFileRestorationMetadataExecution(context(c)), e => e.restoreProjectItem(id(c, "projectId"), id(c, "itemId"))));
  routes.post("/samples/:id/split", c => original(c, createLocalFileSampleRecordMetadataExecution(context(c)), e => e.split(id(c, "id")), created));
  routes.post("/samples/:id/records", c => original(c, createLocalFileSampleRecordMetadataExecution(context(c)), e => e.createRecord(id(c, "id")), created));
  routes.delete("/samples/:id/records/:eventId", c => original(c, createLocalFileSampleRecordMetadataExecution(context(c)), e => e.removeRecord(id(c, "id"), id(c, "eventId"))));
  routes.delete("/samples/:id/events/:eventId/asset", c => original(c, createLocalFileSampleRecordMetadataExecution(context(c)), e => e.removeTimelineAttachment(id(c, "id"), id(c, "eventId"))));
  routes.onError(async (error, c) => {
    c.header("Cache-Control", "private, no-store");
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    const failure = await classifyProjectFailure(error);
    if (failure) return c.json({ error: failure.message }, failure.code === "not_found" ? 404 : 409);
    return c.json({ error: "Local File metadata is unavailable." }, 503);
  });
  return Object.freeze({ routes, admittedRoutes: LOCAL_FILE_METADATA_ROUTES,
    assertAdmissionOpen(): void {
      if (phase !== "open") throw new HTTPException(503, { message: "File storage is unavailable" });
    },
    stopAdmission(): void { if (phase === "open") phase = "stopping"; },
    /** Only the unpublished constructor owner can close without transport.
     * Any dispatched original operation requires the real HTTP drain instead. */
    closeBeforeTransport(): Promise<void> {
      if (closing) return closing;
      if (phase === "open") phase = "stopping";
      closing = (async () => {
        if (dispatched || retained.size || phase === "quarantined") {
          phase = "quarantined";
          throw new LocalFileMetadataDrainError([new Error("Original metadata transport ownership is required")],
            [opening, auth, owner, retained]);
        }
        phase = "closed";
      })();
      closing.then(() => undefined, () => undefined);
      return closing;
    },
    /** Host retains this same first drain. Transport/body originals settle
     * before domain disposal; this never closes opening, Native or lease. */
    drainAfterTransport(server: Server): Promise<void> {
      if (closing) return closing;
      if (phase === "open") phase = "stopping";
      closing = (async () => {
        const errors: unknown[] = [];
        try { await stopNodeHttpServerAndDrain(server); } catch (error) { errors.push(error); }
        const records = [...retained];
        await Promise.allSettled(records.map(record => {
          if (!record.original) {
            const error = new Error("Original metadata operation ownership was not returned");
            record.cleanupFailed = true; record.cleanupFailure = error;
            return Promise.reject(error);
          }
          return record.original;
        }));
        for (const record of records) {
          if (record.cleanupFailed) errors.push(record.cleanupFailure);
          try { await record.execution.dispose(); }
          catch (error) { if (!record.failed || error !== record.failure || cleanupUnproven(error)) errors.push(error); }
        }
        if (errors.length || phase === "quarantined") {
          phase = "quarantined";
          throw new LocalFileMetadataDrainError(errors, [opening, auth, owner, retained, server]);
        }
        phase = "closed";
      })();
      closing.then(() => undefined, () => undefined);
      return closing;
    },
  });
}
