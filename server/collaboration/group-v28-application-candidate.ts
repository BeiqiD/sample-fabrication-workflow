import { Hono } from "hono";
import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";
import { HTTPException } from "hono/http-exception";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { createInstalledLocalIdentity, type IdentityPolicy } from "../auth/identity";
import { createLocalAuthentication, type LocalAuthEnvironment } from "../auth/local-auth-http";
import { LocalRequestSubjectError } from "../auth/local-request-subject";
import { createLoopbackLocalAuthTransport } from "../auth/local-auth-transport";
import type { PasswordHasher } from "../auth/passwords";
import { createNodeHttpServer, stopNodeHttpServerAndDrain, type NodeHttpOptions } from "../http";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { asReadinessDatabase, assertSqliteConnectionOwner, type SqliteCapability } from "../sqlite";
import { checkDatabaseReadiness } from "../../worker/platform/readiness.ts";
import { PROJECT_CREATION_SUBJECT_RESULT_HEADER } from "../../shared/project-creation-subject";
import { createGroupV28RoutesCandidate } from "./group-v28-routes-candidate";
import { createGroupV28RequestBodyCustody } from "./group-v28-request-body-custody";
import { groupV28Capabilities, type GroupV28Capabilities } from "./group-v28-capabilities";
import { assertNodeRuntimeConfiguration, type LoadedNodeRuntimeConfiguration } from "../node-runtime-config";
import { createGroupV28CanonicalCommentRoutesCandidate } from "./group-v28-canonical-comment-routes-candidate";
import { createGroupV28FabubloxRoutesCandidate } from "./group-v28-fabublox-routes-candidate";

export interface GroupV28ApplicationCandidate {
  readonly server: Server;
  readonly routes: readonly Readonly<{ method: string; path: string }>[];
  readonly capabilities: Readonly<GroupV28Capabilities>;
  close(): Promise<void>;
}
interface Owner {
  readonly database: SqliteCapability;
  readonly native: DatabaseSync;
  readonly lease: LinuxWriterLease;
  readonly pending: Set<Promise<Response>>;
  readonly bodies: Set<ReturnType<typeof createGroupV28RequestBodyCustody>>;
  construction?: Promise<void>;
  serverAttempted: boolean;
  server?: Server;
  routes?: ReturnType<typeof createGroupV28RoutesCandidate>;
  commentAttempted: boolean; commentChild?: ReturnType<typeof createGroupV28CanonicalCommentRoutesCandidate>;
  fabubloxAttempted:boolean;fabubloxChild?:ReturnType<typeof createGroupV28FabubloxRoutesCandidate>;
  transportDrain?: Promise<void>;
  physicalDrain?: Promise<void>;
  closing?: Promise<void>;
  active: boolean;
  failed: boolean;
  failure?: unknown;
}
const claimed = new WeakSet<LinuxWriterLease>();
const owners = new Set<Owner>();
const unavailable = () => Response.json({ error: "This operation is unavailable in the Group V28 application candidate." },
  { status: 503, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
const failure = () => new Error("Original Group V28 application ownership is unavailable");
function cleanupUnproven(error:unknown,seen=new Set<unknown>()):boolean {
  if(error instanceof StorageProfileCleanupError) return true;
  if(!error || typeof error!=="object" || seen.has(error)) return false;
  seen.add(error);
  if(error instanceof AggregateError && error.errors.some(cause=>cleanupUnproven(cause,seen))) return true;
  return "cause" in error && cleanupUnproven(error.cause,seen);
}

/** Single native/core/authentication/physical parent. Requires an actual V28
 * installation already upgraded while stopped. This entry never installs,
 * enrolls, enables Group or exposes provisioning/credential operators. There
 * is no ordinary V26 handler, Jobs, SPA or image-byte fallback. Canonical
 * acceptance and exact attachment byte routes are an explicit actual-config/
 * original Request-purpose child, with no administrator-derived File grant. */
export function createGroupV28ApplicationCandidate(options: {
  database: SqliteCapability; nativeDatabase: DatabaseSync; writerLease: LinuxWriterLease;
  admission: ReviewedInstallationAdmission; hasher: PasswordHasher; identityPolicy: IdentityPolicy;
  sampleMetadataReads?: true;
  canonicalSampleAttachments?: true;
  canonicalCommentConfiguration?: LoadedNodeRuntimeConfiguration;
  fabubloxConfiguration?:LoadedNodeRuntimeConfiguration;
  publicOrigin: string; httpLimits?: Pick<NodeHttpOptions, "maxBodyBytes" | "maxHeaderBytes" | "maxHeaderCount" | "timeoutMs">;
}): Promise<GroupV28ApplicationCandidate> {
  if (options.sampleMetadataReads !== undefined && options.sampleMetadataReads !== true) throw failure();
  if (options.canonicalSampleAttachments!==undefined && options.canonicalSampleAttachments!==true
    || options.canonicalSampleAttachments===true && (options.sampleMetadataReads!==true || options.canonicalCommentConfiguration===undefined)) throw failure();
  if (options.canonicalCommentConfiguration !== undefined) {
    const configuration=assertNodeRuntimeConfiguration(options.canonicalCommentConfiguration);
    if(!configuration.enableLocalFile || configuration.enableLocalJobs || configuration.publicOrigin!==options.publicOrigin) throw failure();
  }
  if(options.fabubloxConfiguration!==undefined){
    const configuration=assertNodeRuntimeConfiguration(options.fabubloxConfiguration);
    if(!configuration.enableLocalFile || configuration.enableLocalJobs || configuration.publicOrigin!==options.publicOrigin)throw failure();
  }
  const captured = Object.freeze({ ...options, identityPolicy: Object.freeze({ ...options.identityPolicy }),
    httpLimits: Object.freeze({ ...options.httpLimits }) });
  assertLinuxWriterLeaseBinding(captured.writerLease, captured.database, captured.nativeDatabase);
  assertSqliteConnectionOwner(captured.database, captured.nativeDatabase);
  if (assertInstallationAdmission(captured.nativeDatabase, captured.admission).checkpointId !== "portable-runtime/v28"
    || claimed.has(captured.writerLease) || owners.size >= 2) throw failure();
  claimed.add(captured.writerLease);
  const owner: Owner = { database: captured.database, native: captured.nativeDatabase, lease: captured.writerLease,
    pending: new Set(), bodies: new Set(), serverAttempted: false, commentAttempted: false, fabubloxAttempted:false, active: true, failed: false };
  owners.add(owner);
  let application: Hono<LocalAuthEnvironment> | undefined;
  let admittedRoutes: readonly Readonly<{ method: string; path: string }>[] = [];
  const capabilities = () => groupV28Capabilities(admittedRoutes, captured.sampleMetadataReads === true,
    captured.canonicalCommentConfiguration !== undefined, captured.canonicalSampleAttachments === true);
  const remember = (error: unknown) => { if (!owner.failed) { owner.failed = true; owner.failure = error; } };
  function close(): Promise<void> {
    if (owner.closing) return owner.closing;
    owner.active = false;
    owner.commentChild?.stopAdmission();
    owner.fabubloxChild?.stopAdmission();
    // Cache the first close before starting either original parent drain.
    // The two retained outcomes are not substitutes for native/lease ACKs.
    owner.closing = Promise.resolve().then(async () => {
      try {
        if (owner.server) {
          owner.transportDrain = stopNodeHttpServerAndDrain(owner.server);
          void owner.transportDrain.catch(() => undefined);
        }
        owner.physicalDrain = owner.lease.stopAdmissionAndDrain();
        void owner.physicalDrain.catch(() => undefined);
        // The retained ORIGINAL construction does not include its external
        // failure/close catch, so awaiting it here cannot self-await.
        if (owner.construction) await owner.construction.catch(() => undefined);
        if (owner.serverAttempted && !owner.server) throw failure();
        if (owner.commentAttempted && !owner.commentChild) throw failure();
        if(owner.fabubloxAttempted && !owner.fabubloxChild)throw failure();
        if (owner.server && !owner.transportDrain) {
          owner.transportDrain = stopNodeHttpServerAndDrain(owner.server);
          void owner.transportDrain.catch(() => undefined);
        }
        if (owner.transportDrain) await owner.transportDrain;
        await Promise.allSettled([...owner.pending]);
        // A rejected child first-close blocks its native/physical parent.
        for (const body of owner.bodies) await body.close();
        // HTTP owns response pumps first; the exact child then settles all original
        // body/provider/source ACKs before the sole native/physical parent.
        if (owner.commentChild) await owner.commentChild.drainAfterTransport();
        if(owner.fabubloxChild)await owner.fabubloxChild.drainAfterTransport();
        await owner.physicalDrain;
        // Original issued continuations drain before their private issuers stop.
        owner.routes?.discard();
        owner.database.close();
        if (owner.native.isOpen) throw failure();
        await owner.lease.release();
        application = undefined;
        owners.delete(owner);
      } catch (error) { remember(error); throw error; }
    });
    void owner.closing.catch(() => undefined);
    return owner.closing;
  }
  const originalConstruction = Promise.resolve().then(() => owner.lease.withWriter(async () => {
    const transport = createLoopbackLocalAuthTransport({ publicOrigin: captured.publicOrigin });
    const identity = await createInstalledLocalIdentity({ database: owner.database, nativeDatabase: owner.native,
      admission: captured.admission, hasher: captured.hasher, policy: captured.identityPolicy });
    assertLinuxWriterLeaseBinding(owner.lease, owner.database, owner.native);
    assertSqliteConnectionOwner(owner.database, owner.native);
    assertInstallationAdmission(owner.native, captured.admission);
    const authentication = createLocalAuthentication({ identity, transport, now: Date.now });
    if(captured.canonicalCommentConfiguration!==undefined && captured.canonicalSampleAttachments===true){
      owner.commentAttempted=true;
      owner.commentChild=createGroupV28CanonicalCommentRoutesCandidate({configuration:captured.canonicalCommentConfiguration,
        database:owner.database,nativeDatabase:owner.native,admission:captured.admission,writerLease:owner.lease,authentication,
        stopApplicationAdmission(){owner.active=false;}});
    }
    const sampleAttachmentReadPort=captured.canonicalSampleAttachments===true
      ? owner.commentChild?.sampleAttachmentProjection() : undefined;
    if(captured.canonicalSampleAttachments===true && !sampleAttachmentReadPort) throw failure();
    owner.routes = createGroupV28RoutesCandidate({ database: owner.database, nativeDatabase: owner.native,
      admission: captured.admission, writerLease: owner.lease, authentication, sampleMetadataReads: captured.sampleMetadataReads,
      ...(sampleAttachmentReadPort?{sampleCanonicalAttachmentReadPort:sampleAttachmentReadPort}:{}) });
    if(captured.canonicalCommentConfiguration!==undefined && captured.canonicalSampleAttachments!==true){
      owner.commentAttempted=true;
      owner.commentChild=createGroupV28CanonicalCommentRoutesCandidate({configuration:captured.canonicalCommentConfiguration,
        database:owner.database,nativeDatabase:owner.native,admission:captured.admission,writerLease:owner.lease,authentication,
        stopApplicationAdmission(){owner.active=false;}});
    }
    if(captured.fabubloxConfiguration!==undefined){
      owner.fabubloxAttempted=true;
      owner.fabubloxChild=createGroupV28FabubloxRoutesCandidate({configuration:captured.fabubloxConfiguration,
        database:owner.database,nativeDatabase:owner.native,writerLease:owner.lease,authentication,admission:captured.admission,
        stopApplicationAdmission(){owner.active=false;}});
    }
    const app = new Hono<LocalAuthEnvironment>();
    app.use("*", async (c, next) => { c.header("Cache-Control", "private, no-store"); c.header("X-Content-Type-Options", "nosniff"); await next(); });
    app.onError((error, c) => {
      // An embedded Sample probe owns the same private File child. Its failed
      // original cleanup must close admission and remain a parent/native barrier.
      if(captured.canonicalSampleAttachments===true && owner.commentChild && cleanupUnproven(error)){
        owner.active=false;owner.commentChild.stopAdmission();remember(error);return unavailable();
      }
      if(owner.fabubloxChild && cleanupUnproven(error)){
        owner.active=false;owner.fabubloxChild.stopAdmission();remember(error);return unavailable();
      }
      if (error instanceof LocalRequestSubjectError)
        return c.json({ error: "Current local authentication is required." }, error.code === "authentication_required" ? 401 : 503);
      if (error instanceof HTTPException) {
        if (c.req.method === "POST" && new URL(c.req.raw.url).pathname === "/api/projects" && error.status === 409
          && error.message === "Sign-in identity changed. Refresh Projects before retrying.")
          c.header(PROJECT_CREATION_SUBJECT_RESULT_HEADER, "mismatch");
        return c.json({ error: error.message }, error.status);
      }
      remember(error); return unavailable();
    });
    app.route("/api/auth", authentication.routes);
    // Match the default Node distinction: health is public process/surface
    // information; readiness uses the genuine current local session, never an
    // administrator/member/resource grant. Neither claims general File or Jobs.
    app.get("/api/health", c => c.json({ ok: true, capabilities: capabilities() }));
    const assertOperationalScope = () => {
      if (!owner.active || !owner.server?.listening || !application || !owner.routes) throw new HTTPException(503,
        { message: "The selected V28 service is unavailable." });
      assertLinuxWriterLeaseBinding(owner.lease, owner.database, owner.native);
      assertSqliteConnectionOwner(owner.database, owner.native);
      if (assertInstallationAdmission(owner.native, captured.admission).checkpointId !== "portable-runtime/v28")
        throw new HTTPException(503, { message: "The selected V28 service is unavailable." });
      const state = owner.native.prepare(`SELECT c.schema_version,c.enforcement,m.state,
        (SELECT count(*) FROM system_recovery_write_leases WHERE released_at IS NULL) writers,
        (SELECT mode FROM file_authority_control WHERE singleton=1) file_mode,
        (SELECT enabled FROM file_authority_runtime_guard WHERE singleton=1) file_enabled,
        (SELECT enabled FROM file_shadow_runtime_guard WHERE singleton=1) shadow_enabled,
        (SELECT enabled FROM file_job_runtime_guard WHERE singleton=1) jobs_enabled,
        (SELECT enabled FROM system_recovery_runtime WHERE singleton=1) recovery_enabled,
        EXISTS(SELECT 1 FROM local_identity_installation i
          JOIN local_accounts a ON a.principal_id=i.bootstrap_principal_id
          JOIN local_admin_grants g ON g.principal_id=a.principal_id
          WHERE i.singleton=1 AND a.enabled=1) initialized
        FROM collaboration_control c JOIN system_recovery_maintenance m ON m.singleton=1 WHERE c.singleton=1`).get();
      // Restored content may retain an active File control row while its
      // destination execution guards are disabled. Metadata readiness never
      // treats that historical mode as a selected or granted File capability.
      const fileScopeUnavailable = owner.commentChild || owner.fabubloxChild
        ? state?.file_mode !== "active" : state?.file_enabled !== 0 || state?.shadow_enabled !== 0;
      if (state?.schema_version !== 2 || state.enforcement !== "enabled" || state.state !== "open"
        || state.writers !== 0 || fileScopeUnavailable || state.jobs_enabled !== 0
        || state.recovery_enabled !== 0 || state.initialized !== 1) throw new HTTPException(503,
        { message: "The selected V28 service is unavailable." });
      if (captured.canonicalCommentConfiguration) assertNodeRuntimeConfiguration(captured.canonicalCommentConfiguration);
      if (captured.fabubloxConfiguration) assertNodeRuntimeConfiguration(captured.fabubloxConfiguration);
      assertLinuxWriterLeaseBinding(owner.lease, owner.database, owner.native);
    };
    app.get("/api/ready", authentication.middleware, async c => {
      assertOperationalScope();
      // Reuse the original real SELECT 1 readiness primitive and the actual
      // owned core. No fabricated bindings, callback database or provider probe.
      await checkDatabaseReadiness(asReadinessDatabase(owner.database));
      assertOperationalScope();
      return c.json({ ok: true, scope: "supported-v28-service", fullReady: false, capabilities: capabilities() });
    });
    // The explicit active File child owns these two original RunStart paths;
    // the unchanged legacy/media-free router retains all other operations.
    if(owner.fabubloxChild)app.route("/",owner.fabubloxChild.app);
    app.route("/", owner.routes.app);
    if(owner.commentChild) app.route("/",owner.commentChild.app);
    app.all("*", () => unavailable());
    application = app;
    admittedRoutes = Object.freeze([
      { method: "POST", path: "/api/auth/login" }, { method: "GET", path: "/api/auth/session" },
      { method: "POST", path: "/api/auth/logout" }, { method: "POST", path: "/api/auth/rotate" },
      { method: "GET", path: "/api/health" }, { method: "GET", path: "/api/ready" },
      ...owner.routes.routes,
      ...(owner.commentChild?.routes ?? []),
      ...(owner.fabubloxChild?.routes ?? []),
    ].map(route => Object.freeze({ ...route })));
    const routes = admittedRoutes.map(route => ({ method: route.method,
      pattern: new RegExp(`^${route.path.replace(/:[A-Za-z]+/g, "[^/]+")}$`) }));
    owner.serverAttempted = true;
    owner.server = createNodeHttpServer(async request => {
      if (!owner.active || !routes.some(route => route.method === request.method && route.pattern.test(new URL(request.url).pathname))) return unavailable();
      const original = owner.lease.withWriter(async () => {
        if (!application || !owner.active) return unavailable();
        const body = createGroupV28RequestBodyCustody(request); owner.bodies.add(body);
        const response = await application.fetch(request, {});
        try { await body.close(); owner.bodies.delete(body); }
        catch (error) { owner.active = false; remember(error); throw error; }
        return response;
      });
      owner.pending.add(original);
      try { return await original; }
      catch (error) { remember(error); return unavailable(); }
      finally { owner.pending.delete(original); }
    }, { ...captured.httpLimits, publicOrigin: captured.publicOrigin,
      ...(owner.fabubloxChild?{fabubloxWireAdmission:owner.fabubloxChild.wireAdmission}:{}),
      requestAdmission(request, incoming, actualServer) {
        try { transport.admit(request, incoming, actualServer); }
        catch { return Response.json({ error: "Request admission is required." },
          { status: 403, headers: { "Cache-Control": "private, no-store" } }); }
      } });
  }));
  owner.construction = originalConstruction;
  // This external catch is deliberately outside originalConstruction.
  return originalConstruction.then(() => Object.freeze({ server: owner.server!, routes: admittedRoutes,
    capabilities: capabilities(), close }), async error => {
    remember(error);
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Group construction and original parent cleanup failed"); }
    throw error;
  });
}
