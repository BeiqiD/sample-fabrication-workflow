import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { normalizeR2UploadRequestId } from "../../shared/contracts/r2-upload";
import { safeMediaResponseHeaders } from "../../worker/media-response";
import { ordinaryAssetUploadMetadata } from "../../worker/uploads/ordinary-asset-request";
import { StorageProfileCleanupError, ShadowProfileUnavailableError } from "../../worker/files/storage-profile-opening";
import { AuthorityCandidateUnavailableError } from "../../worker/files/authority-candidates-core.ts";
import { ByteVerificationError } from "../../worker/files/byte-verification.ts";
import { FileAuthorityUnavailableError } from "../../worker/files/authority-mode.ts";
import type { OwnedPublishedFileRead } from "../../worker/files/authority-reader-core";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { captureInstalledIdentityExecutionOwner } from "../auth/installed-identity-execution-owner";
import { stopNodeHttpServerAndDrain } from "../http";
import type { ReviewedInstallationAdmission } from "../migrations";
import { assertNodeRuntimeConfiguration, type LoadedNodeRuntimeConfiguration } from "../node-runtime-config";
import { assertLinuxWriterLeaseBinding, WriterLeaseError, type LinuxWriterLease } from "../operations/writer-lease";
import type { SqliteCapability } from "../sqlite";
import { createLocalVolumeProfileOpening } from "../storage/local-volume-profile-opening";
import { createLocalAcceptedUpload, localUploadFailureStep, LocalUploadConflictError, LocalUploadUnavailableError } from "./local-accepted-upload";
import { StorageRoleDefaultsUnavailableError } from "../../worker/files/storage-role-defaults-core.ts";
import { LocalByteStorageError } from "../storage/local-byte-storage.ts";
import { createLocalUploadExecution } from "./local-upload-execution";
import { readOwnedUploadBody } from "./owned-upload-body";
import { createLocalFileMetadataComposition } from "./local-file-metadata-composition";
import { createNodePackageHttpRoutes } from "../packages/request-http";
import { createNodeLocalFileJobs } from "./jobs/local-runtime";

type FileEnvironment = { Bindings: { readonly database: SqliteCapability }; Variables: { userEmail: string } };
type ExecutionScope = ReturnType<typeof createLocalUploadExecution>;
interface ScopeOwner {
  readonly scope: ExecutionScope;
  readonly dispose: () => Promise<void>;
  readonly reads: Set<OwnedPublishedFileRead>;
  failure?: unknown;
}
export class NodeLocalFileDrainError extends AggregateError {
  declare readonly retainedOwners: readonly unknown[];
  constructor(errors: readonly unknown[], owners: readonly unknown[]) {
    super(errors, "Original local File ownership could not drain");
    this.name = "NodeLocalFileDrainError";
    Object.defineProperty(this, "retainedOwners", { value: Object.freeze([...owners]) });
  }
}
function cleanupUnproven(error: unknown, seen = new Set<unknown>()): boolean {
  if (error instanceof StorageProfileCleanupError) return true;
  if (!(error instanceof AggregateError) || seen.has(error)) return false;
  seen.add(error); return error.errors.some(value => cleanupUnproven(value, seen));
}
function denied(error: unknown, cacheControl = "private, no-store"): Response {
  const status = error instanceof HTTPException ? error.status : error instanceof LocalUploadConflictError ? 409 : 503;
  const message = error instanceof HTTPException || error instanceof LocalUploadConflictError || error instanceof LocalUploadUnavailableError
    ? error.message : "File storage is unavailable";
  return Response.json({ error: message }, { status, headers: { "Cache-Control": cacheControl } });
}
// Fixed Node failure observability only. No request identity, body, message,
// cause, stack, SQL, path, credential or authorization input is projected.
type UploadFailurePhase = "host_route_admission" | "metadata_admission" | "request_metadata" | "request_owner"
  | "execution_admission" | "body_read" | "upload_accept" | "execution_settlement" | "result_delivery";
function uploadFailureClass(error: unknown): string {
  if (error instanceof HTTPException) return error.status === 503 ? "http_503" : "http_other";
  if (error instanceof StorageProfileCleanupError) return "storage_cleanup";
  if (error instanceof ByteVerificationError) return "byte_verification";
  if (error instanceof AuthorityCandidateUnavailableError) return "authority_candidate";
  if (error instanceof ShadowProfileUnavailableError) return "shadow_profile";
  if (error instanceof FileAuthorityUnavailableError) return "file_authority";
  if (error instanceof LocalUploadUnavailableError) return "upload_outcome_unavailable";
  if (error instanceof StorageRoleDefaultsUnavailableError) return "role_defaults";
  if (error instanceof LocalByteStorageError) return "local_byte_storage";
  if (error instanceof WriterLeaseError) return "writer_lease";
  if (error instanceof TypeError) return "type_error";
  if (error instanceof ReferenceError) return "reference_error";
  if (error instanceof RangeError) return "range_error";
  if (error instanceof AggregateError) return "aggregate_error";
  if (error instanceof Error && Object.getOwnPropertyDescriptor(error, "code")?.value === "ERR_SQLITE_ERROR") {
    const code = Object.getOwnPropertyDescriptor(error, "errcode")?.value;
    if (code === 787) return "native_sqlite_foreign_key";
    if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 0x7fff_ffff) {
      switch (code & 255) {
        case 17: return "native_sqlite_schema";
        case 19: return "native_sqlite_constraint";
        case 5: return "native_sqlite_busy";
        case 6: return "native_sqlite_locked";
      }
    }
    return "native_sqlite_error";
  }
  return "unknown";
}
function observeUpload503(phase: UploadFailurePhase, error: unknown): void {
  // Exactly the existing denied() status selection: no successful/4xx work logs.
  if (error instanceof LocalUploadConflictError || error instanceof HTTPException && error.status !== 503) return;
  try {
    const selectedPhase = phase === "upload_accept" ? localUploadFailureStep(error) ?? phase : phase;
    process.stderr.write(JSON.stringify({ kind: "node-local-file-upload-failure/1", phase: selectedPhase,
      errorClass: uploadFailureClass(error) }) + "\n");
  } catch { /* Diagnostics cannot replace the original response or close outcome. */ }
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

/** Unmounted source candidate. The operational composer must independently
 * qualify paired current3 local File export/recovery before mounting these
 * methods. This consumes the composer's sole real native/core/lease/auth and
 * genuine opaque config; it creates no database, account, profile or default.
 * Registration/activation/admin/Group/Comment/import/Job routes are absent.
 * The fixed metadata composition is source-only and shares this exact opening;
 * its current Request/domain guards and original algorithms remain separate. */
export function createNodeLocalFileHost(options: {
  readonly configuration: LoadedNodeRuntimeConfiguration;
  readonly database: SqliteCapability;
  readonly nativeDatabase: DatabaseSync;
  readonly admission: ReviewedInstallationAdmission;
  readonly writerLease: LinuxWriterLease;
  readonly authentication: object;
  readonly stopApplicationAdmission?: () => void;
}) {
  const { configuration, database, nativeDatabase, admission, writerLease, authentication } = options;
  const config = assertNodeRuntimeConfiguration(configuration);
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  const auth = localAuthenticationIdentityAuthority(authentication);
  const identity = captureInstalledIdentityExecutionOwner(auth.identity, database, nativeDatabase, admission);
  // The real owner must be the configured physical database, not a copy
  // carrying the same imported installation UUID. The captured identity owner
  // already retains this exact main-file tuple for every subsequent dispatch.
  const main = nativeDatabase.prepare("PRAGMA database_list").all().filter(row => row.name === "main");
  if (main.length !== 1 || main[0]?.file !== config.databasePath)
    throw new Error("Configured local File database ownership is unavailable");
  if (identity.installation.installationId !== config.expectedInstallationId || !config.localVolumes.length)
    throw new Error("Local File configuration is unavailable");
  const opening = createLocalVolumeProfileOpening({ database, nativeDatabase, admission, writerLease,
    filesystemRootOwnerUid: config.filesystemRootOwnerUid, descriptors: config.localVolumes,
    // This surface owns ordinary authenticated system-scope bytes only. It
    // cannot use its underlying opening to exercise any admin metadata method.
    authorizeAdministrator: () => false });
  let metadata: ReturnType<typeof createLocalFileMetadataComposition>;
  let jobs: ReturnType<typeof createNodeLocalFileJobs> | undefined;
  let packages: ReturnType<typeof createNodePackageHttpRoutes<FileEnvironment["Bindings"]>> | undefined;
  let phase: "open" | "stopping" | "closed" | "quarantined" = "open";
  try {
    metadata = createLocalFileMetadataComposition({ opening, authentication, admission, publicOrigin: config.publicOrigin });
    if (config.enableLocalJobs) jobs = createNodeLocalFileJobs({ configuration, opening, authentication, admission,
      stopApplicationAdmission() {
        phase = "quarantined"; metadata.stopAdmission(); options.stopApplicationAdmission?.();
      } });
    if (config.enableLocalJobs) packages = createNodePackageHttpRoutes<FileEnvironment["Bindings"]>({ configuration, opening, authentication, admission,
      stopApplicationAdmission() { phase = "quarantined"; metadata.stopAdmission(); jobs?.stopAdmission(); options.stopApplicationAdmission?.(); } });
  }
  catch (error) { throw new NodeLocalFileDrainError([error], [configuration, auth, identity, opening, jobs]); }
  const scopes = new Set<ScopeOwner>();
  let closing: Promise<void> | undefined;
  let dispatched = false;
  function stopJobsAfterFileQuarantine(): void {
    if (jobs) { jobs.stopAdmission(); options.stopApplicationAdmission?.(); }
  }
  const assertCurrent = () => {
    if (assertNodeRuntimeConfiguration(configuration) !== config
      || localAuthenticationIdentityAuthority(authentication) !== auth)
      throw new Error("Original local File configuration is unavailable");
    identity.assertCurrent(); assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  };
  function createExecution(request: Request, actor: string): ScopeOwner {
    if (phase !== "open") throw new HTTPException(503, { message: "File storage is unavailable" });
    assertCurrent();
    if (new URL(request.url).origin !== config.publicOrigin)
      throw new HTTPException(403, { message: "Request admission is required." });
    const scope = createLocalUploadExecution({ opening, request, actor, admission, authentication });
    const record: ScopeOwner = { scope, dispose: scope.dispose.bind(scope), reads: new Set() };
    scopes.add(record);
    scope.settled.then(() => scopes.delete(record), error => {
      record.failure = error;
      // Ordinary business denial follows proved original provider/hold drain.
      // Typed failed cleanup is retained even after Hono sanitizes its reply.
      if (cleanupUnproven(error)) { phase = "quarantined"; stopJobsAfterFileQuarantine(); }
      else scopes.delete(record);
    });
    return record;
  }
  const routes = new Hono<FileEnvironment>();
  const admittedRoutes = Object.freeze([{ method: "POST", path: "/assets" }, { method: "GET", path: "/r2-upload-requests/:requestId" },
    { method: "GET", path: "/file-assets/:assetId" }, ...metadata.admittedRoutes,
    ...(jobs?.admittedRoutes ?? []), ...(packages?.admittedRoutes ?? [])].map(route => Object.freeze(route)));
  // Scope ingress to actual host methods. A wildcard child middleware would
  // accidentally gate the unrelated legacy methods when mounted at /api.
  for (const route of admittedRoutes) routes.on(route.method, route.path, async (_c, next) => {
    if (phase !== "open") {
      const error = new HTTPException(503, { message: "File storage is unavailable" });
      if (route.method === "POST" && route.path === "/assets") observeUpload503("host_route_admission", error);
      return denied(error);
    }
    try { metadata.assertAdmissionOpen(); }
    catch (error) {
      if (route.method === "POST" && route.path === "/assets") observeUpload503("metadata_admission", error);
      return denied(error);
    }
    dispatched = true;
    return next();
  });
  routes.post("/assets", async c => {
    let failurePhase: UploadFailurePhase = "request_metadata";
    try {
      const request = c.req.raw, actor = c.get("userEmail");
      const metadata = ordinaryAssetUploadMetadata(request);
      // Capture genuine auth/original digest before body consumption or await.
      failurePhase = "request_owner";
      const record = createExecution(request, actor);
      failurePhase = "execution_admission";
      const uploaded = await record.scope.run(async execution => {
        failurePhase = "body_read";
        const bytes = await readOwnedUploadBody(request);
        failurePhase = "upload_accept";
        const answer = await createLocalAcceptedUpload(opening, execution).accept({ ...metadata, bytes });
        failurePhase = "execution_settlement";
        return answer;
      });
      failurePhase = "result_delivery";
      if (uploaded.state.status === "ready") return json(uploaded.state.result,
        uploaded.fresh && !uploaded.state.result.deduplicated ? 201 : 200);
      return json(uploaded.state, uploaded.state.status === "pending" ? 202
        : uploaded.state.status === "expired" ? 410 : uploaded.state.status === "failed" ? 409 : 503);
    } catch (error) { observeUpload503(failurePhase, error); return denied(error, "no-store"); }
  });
  routes.get("/r2-upload-requests/:requestId", async c => {
    try {
      const raw = c.req.param("requestId"), requestId = normalizeR2UploadRequestId(raw);
      if (!raw) throw new HTTPException(428, { message: "Reload the application before uploading files." });
      if (!requestId) throw new HTTPException(400, { message: "A valid upload request ID is required." });
      const record = createExecution(c.req.raw, c.get("userEmail"));
      const state = await record.scope.run(execution => createLocalAcceptedUpload(opening, execution).getState(requestId));
      if (!state) throw new HTTPException(404, { message: "Upload request not found." });
      return json(state);
    } catch (error) { return denied(error, "no-store"); }
  });
  routes.get("/file-assets/:assetId", async c => {
    try {
      const assetId = c.req.param("assetId");
      if (!assetId || assetId.length > 256 || assetId.includes("\0"))
        throw new HTTPException(400, { message: "A valid File asset identifier is required" });
      const record = createExecution(c.req.raw, c.get("userEmail"));
      let resolve!: (value: Response) => void, reject!: (error: unknown) => void, delivered = false;
      const response = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
      response.then(() => undefined, () => undefined);
      const original = record.scope.run(async execution => {
        // Preserve the mature alias metadata/import/system/hash/publication
        // predicates, with an explicit local recorded profile. Old CF/S3 SQL
        // remains untouched; the current pointer still selects usable bytes.
        const source = await execution.historyDatabase().primary().prepare(`SELECT a.original_name,a.mime_type,f.file_id,f.purpose
    FROM assets a JOIN file_usable_publications f ON f.file_id=a.file_id
    JOIN storage_profiles recorded_profile ON recorded_profile.id=a.storage_profile_id
      AND recorded_profile.configuration_revision=a.storage_profile_revision AND recorded_profile.adapter_type='local'
    WHERE a.id=? AND a.r2_key IS NULL AND a.status='ready' AND f.access_scope='system'
      AND f.verified_sha256=a.sha256 AND f.verified_byte_size=a.byte_size
      AND (a.import_id IS NULL OR EXISTS(SELECT 1 FROM imports i WHERE i.id=a.import_id AND i.status='ready'))
      AND EXISTS(SELECT 1 FROM file_location_publications recorded WHERE recorded.file_id=a.file_id
        AND recorded.storage_profile_id=a.storage_profile_id AND recorded.object_key=a.object_key
        AND recorded.verified_sha256=a.sha256 AND recorded.verified_byte_size=a.byte_size)`)
          .bind(assetId).first();
        if (!source) throw new HTTPException(404, { message: "File asset not found" });
        if (typeof source.file_id !== "string" || typeof source.original_name !== "string" || typeof source.mime_type !== "string"
          || source.purpose !== "embedded_content" && source.purpose !== "research_source")
          throw new HTTPException(503, { message: "File storage is unavailable" });
        const read = await execution.openRead({ fileId: source.file_id, purpose: source.purpose });
        record.reads.add(read);
        if (read.result.outcome === "missing") throw new HTTPException(404, { message: "File asset not found" });
        if (read.result.outcome !== "available") throw new HTTPException(503, { message: "File storage is unavailable" });
        const headers = safeMediaResponseHeaders({ headers: new Headers(read.result.httpMetadata), mimeType: source.mime_type,
          filename: source.original_name || "asset", cacheControl: "private, no-store", etag: read.result.etag });
        // Deliver the body while the original execution remains physically
        // owned. Returning Response from run would dispose before consumption.
        const deliveredResponse = new Response(read.result.body, { headers });
        delivered = true; resolve(deliveredResponse);
        await read.settled;
      });
      original.then(() => undefined, error => { if (!delivered) reject(error); });
      return await response;
    } catch (error) { return denied(error); }
  });
  routes.route("/", metadata.routes);
  return Object.freeze({ routes,
    admittedRoutes,
    jobRoutes: jobs?.routes,
    packageRoutes: packages?.routes,
    startJobsOnListening(server: Server): void { jobs?.startOnListening(server); },
    dispatchJobsOnce(): Promise<Readonly<{jobId: string | null; outcome: string}>> {
      return jobs ? jobs.dispatchOnce() : Promise.resolve({jobId:null,outcome:"disabled"});
    },
    stopAdmission(): void { if (phase === "open") phase = "stopping"; metadata.stopAdmission(); jobs?.stopAdmission(); packages?.stopAdmission(); },
    /** Cached constructor cleanup before a transport has been published.
     * This proves zero original dispatch; it never substitutes for HTTP drain. */
    closeBeforeTransport(): Promise<void> {
      if (closing) return closing;
      if (phase === "open") phase = "stopping";
      metadata.stopAdmission();
      jobs?.stopAdmission();
      packages?.stopAdmission();
      closing = (async () => {
        try {
          if (dispatched || scopes.size || phase === "quarantined")
            throw new Error("Original File transport ownership is required");
          await packages?.closeBeforeTransport();
          await metadata.closeBeforeTransport();
          await jobs?.drain();
          await opening.close();
          assertCurrent(); phase = "closed";
        } catch (error) {
          phase = "quarantined";
          stopJobsAfterFileQuarantine();
          throw new NodeLocalFileDrainError([error], [configuration, auth, identity, opening, metadata, jobs, scopes]);
        }
      })();
      closing.then(() => undefined, () => undefined);
      return closing;
    },
    /** Root composer calls stopAdmission synchronously with HTTP stop, then
     * awaits this exact original drain before its sole native/lease close.
     * No direct read.dispose races an HTTP pump or invents cancellation. */
    drainAfterTransport(server: Server): Promise<void> {
      if (closing) return closing;
      if (phase === "open") phase = "stopping";
      metadata.stopAdmission();
      jobs?.stopAdmission();
      packages?.stopAdmission();
      closing = (async () => {
        const errors: unknown[] = [];
        try { await stopNodeHttpServerAndDrain(server); } catch (error) { errors.push(error); }
        const current = [...scopes];
        const settled = await Promise.allSettled(current.map(record => record.scope.settled));
        for (const value of settled) if (value.status === "rejected" && cleanupUnproven(value.reason)) errors.push(value.reason);
        // These exact callbacks can only settle the original attempts. HTTP
        // has finished owning delivered bodies before any disposal is invoked.
        const disposal = await Promise.allSettled(current.flatMap(record => [record.dispose(), ...[...record.reads].map(read => read.dispose())]));
        for (const value of disposal) if (value.status === "rejected" && cleanupUnproven(value.reason)) errors.push(value.reason);
        try { await packages?.drain(); } catch (error) { errors.push(error); }
        try { await metadata.drainAfterTransport(server); } catch (error) { errors.push(error); }
        try { await jobs?.drain(); } catch (error) { errors.push(error); }
        // A reported original HTTP/domain/provider failure retains this exact
        // opening and all physical owners. Closing the opening cannot certify
        // settlement of those original promises.
        if (errors.length || phase === "quarantined") {
          phase = "quarantined";
          stopJobsAfterFileQuarantine();
          throw new NodeLocalFileDrainError(errors, [configuration, auth, identity, opening, metadata, jobs, scopes, server]);
        }
        try { await opening.close(); } catch (error) { errors.push(error); }
        if (errors.length) {
          phase = "quarantined";
          stopJobsAfterFileQuarantine();
          throw new NodeLocalFileDrainError(errors, [configuration, auth, identity, opening, metadata, jobs, scopes, server]);
        }
        assertCurrent(); phase = "closed";
      })();
      closing.then(() => undefined, () => undefined); return closing;
    },
  });
}
