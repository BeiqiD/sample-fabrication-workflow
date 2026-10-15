import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";
import { checkDatabaseReadiness } from "../../worker/platform/readiness";
import { PROJECT_CREATION_SUBJECT_RESULT_HEADER } from "../../shared/project-creation-subject";
import { createInstalledLocalIdentity, type IdentityPolicy } from "../auth/identity";
import { createLocalAuthentication, type LocalAuthEnvironment } from "../auth/local-auth-http";
import { createLoopbackLocalAuthTransport } from "../auth/local-auth-transport";
import { LocalRequestSubjectError } from "../auth/local-request-subject";
import type { PasswordHasher } from "../auth/passwords";
import { createGroupV28RoutesCandidate } from "../collaboration/group-v28-routes-candidate";
import { createGroupV28RequestBodyCustody } from "../collaboration/group-v28-request-body-custody";
import { createGroupV28CanonicalCommentRoutesBorrowedWorkflow } from "../collaboration/group-v28-canonical-comment-routes-candidate";
import { createGroupV28FabubloxRoutesBorrowedWorkflow } from "../collaboration/group-v28-fabublox-routes-candidate";
import { createInstalledJobPrincipalAuthorityV28 } from "../files/jobs/principal-authority";
import { createNodeFileJobHttpRoutes, NodeFileJobHttpCleanupError } from "../files/jobs/request-http";
import { createNodeHttpServer, ownedNodeHttpRequestLifetime, stopNodeHttpServerAndDrain, type NodeHttpOptions } from "../http";
import { openNodeV28JobCursor } from "../jobs/node-v28-job-cursor";
import { createNodeV28JobScheduler, assertNodeV28JobSchedulerBinding, NODE_V28_JOB_CADENCE_MS } from "../jobs/node-v28-job-scheduler";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertNodeRuntimeConfigurationForProfile, type LoadedNodeRuntimeConfiguration } from "../node-runtime-config";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createNodePackageHttpRoutesV28Candidate } from "../packages/request-http-v28-candidate";
import { createNodeV28PackageJobChild, assertNodeV28PackageJobChildBinding } from "../packages/job-child-v28-candidate";
import { createNodeSystemRecoveryV28BorrowedChild, assertNodeSystemRecoveryV28BorrowedChildBinding } from "../recovery/node-system-recovery-v28-application";
import { createNodeV28SourceBarrier, assertNodeV28SourceBarrierBinding } from "../recovery/node-v28-source-barrier";
import { createLocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate";
import { assertLocalVolumeProfileOpeningV28Binding } from "../storage/local-volume-profile-opening";
import { asReadinessDatabase, assertSqliteConnectionOwner, type SqliteCapability } from "../sqlite";
import { createNodeV28FileJobChild, assertNodeV28FileJobChildBinding } from "./node-v28-file-job-child";

type Route = Readonly<{method:string;path:string}>;
type Authentication = ReturnType<typeof createLocalAuthentication>;
type Barrier = ReturnType<typeof createNodeV28SourceBarrier>;
type Opening = ReturnType<typeof createLocalVolumeProfileOpeningV28Candidate>;
type Authority = Awaited<ReturnType<typeof createInstalledJobPrincipalAuthorityV28>>;
type Recovery = Awaited<ReturnType<typeof createNodeSystemRecoveryV28BorrowedChild>>;
type FileHttp = ReturnType<typeof createNodeFileJobHttpRoutes<{readonly database:SqliteCapability}>>;
type PackageHttp = ReturnType<typeof createNodePackageHttpRoutesV28Candidate<{readonly database:SqliteCapability}>>;
export interface NodeV28WorkflowApplication {
  readonly server: Server;
  readonly routes: readonly Route[];
  readonly capabilities: Readonly<{
    kind:"node-v28-workflow-mounted/1";profile:"v28-workflow";fullReady:false;
    admittedRoutes:readonly Route[];jobCadenceMs:120000;jobFamilies:readonly ["file","package","recovery"];
    persistedExecutorActivationRequired:true;startupProvisioning:false;
    generalFileLifecycle:false;imageBytes:false;spa:false;
    recovery:Recovery["surfaceCapabilities"];
  }>;
  dispatchJobsOnce(): ReturnType<ReturnType<typeof createNodeV28JobScheduler>["dispatchOnce"]>;
  close(): Promise<void>;
}
interface Owner {
  readonly database:SqliteCapability;readonly native:DatabaseSync;readonly lease:LinuxWriterLease;
  readonly pending:Set<Promise<Response>>;readonly bodies:Set<ReturnType<typeof createGroupV28RequestBodyCustody>>;
  readonly attempted:Set<string>;readonly constructed:Set<string>;
  construction?:Promise<void>;server?:Server;authentication?:Authentication;opening?:Opening;barrier?:Barrier;authority?:Authority;
  group?:ReturnType<typeof createGroupV28RoutesCandidate>;
  comment?:ReturnType<typeof createGroupV28CanonicalCommentRoutesBorrowedWorkflow>;
  fabublox?:ReturnType<typeof createGroupV28FabubloxRoutesBorrowedWorkflow>;
  fileHttp?:FileHttp;packageHttp?:PackageHttp;file?:ReturnType<typeof createNodeV28FileJobChild>;
  package?:ReturnType<typeof createNodeV28PackageJobChild>;recovery?:Recovery;
  cursor?:Awaited<ReturnType<typeof openNodeV28JobCursor>>;scheduler?:ReturnType<typeof createNodeV28JobScheduler>;
  closing?:Promise<void>;transportDrain?:Promise<void>;physicalDrain?:Promise<void>;active:boolean;failed:boolean;failure?:unknown;
}
const claimed = new WeakSet<LinuxWriterLease>(), retained = new Set<Owner>();
const failure = () => new Error("Original Node V28 workflow ownership is unavailable");
const unavailable = () => Response.json({error:"The selected V28 operation is unavailable."},{status:503,
  headers:{"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
function cleanupUnproven(error:unknown,seen=new Set<unknown>()):boolean {
  if (error instanceof StorageProfileCleanupError || error instanceof NodeFileJobHttpCleanupError) return true;
  if (!error || typeof error!=="object" || seen.has(error)) return false;
  seen.add(error);
  if (error instanceof AggregateError && error.errors.some(value=>cleanupUnproven(value,seen))) return true;
  return "cause" in error && cleanupUnproven(error.cause,seen);
}
/** Sole actual transport/auth/Native/core/physical parent for explicit
 * v28-workflow. All children borrow one privately issued opening. Startup
 * consumes an existing installation; it never provisions or activates it. */
export function createNodeV28WorkflowApplication(options:{
  configuration:LoadedNodeRuntimeConfiguration;database:SqliteCapability;nativeDatabase:DatabaseSync;writerLease:LinuxWriterLease;
  admission:ReviewedInstallationAdmission;hasher:PasswordHasher;identityPolicy:IdentityPolicy;publicOrigin:string;
  httpLimits?:Pick<NodeHttpOptions,"maxBodyBytes"|"maxHeaderBytes"|"maxHeaderCount"|"timeoutMs">;
}):Promise<NodeV28WorkflowApplication> {
  const captured=Object.freeze({...options,identityPolicy:Object.freeze({...options.identityPolicy}),httpLimits:Object.freeze({...options.httpLimits})});
  const config=assertNodeRuntimeConfigurationForProfile(captured.configuration,"v28-workflow");
  assertLinuxWriterLeaseBinding(captured.writerLease,captured.database,captured.nativeDatabase);
  assertSqliteConnectionOwner(captured.database,captured.nativeDatabase);
  if (config.publicOrigin!==captured.publicOrigin || !config.enableLocalFile || !config.enableLocalJobs || !config.enableLocalRecovery
    || assertInstallationAdmission(captured.nativeDatabase,captured.admission).checkpointId!=="portable-runtime/v28"
    || claimed.has(captured.writerLease) || retained.size>=2) throw failure();
  const owner:Owner={database:captured.database,native:captured.nativeDatabase,lease:captured.writerLease,
    pending:new Set(),bodies:new Set(),attempted:new Set(),constructed:new Set(),active:true,failed:false};
  claimed.add(owner.lease);retained.add(owner);
  let app:Hono<LocalAuthEnvironment>|undefined,admittedRoutes:readonly Route[]=[];
  function remember(error:unknown):void {if(!owner.failed){owner.failed=true;owner.failure=error;}}
  function stopAdmission():void {
    owner.active=false;owner.scheduler?.stopAdmission();owner.file?.stopAdmission();owner.package?.stopAdmission();
    owner.fileHttp?.stopAdmission();owner.packageHttp?.stopAdmission();owner.comment?.stopAdmission();owner.fabublox?.stopAdmission();owner.recovery?.stopAdmission();
  }
  function quarantine(error:unknown):void {remember(error);stopAdmission();}
  function current():void {
    if(assertNodeRuntimeConfigurationForProfile(captured.configuration,"v28-workflow")!==config)throw failure();
    assertLinuxWriterLeaseBinding(owner.lease,owner.database,owner.native);assertSqliteConnectionOwner(owner.database,owner.native);
    const installation=assertInstallationAdmission(owner.native,captured.admission);
    if(installation.checkpointId!=="portable-runtime/v28"||installation.installationId!==config.expectedInstallationId)throw failure();
    if(!owner.authentication||!owner.opening||!owner.barrier)throw failure();
    assertLocalVolumeProfileOpeningV28Binding(owner.opening,owner.database,owner.native,owner.lease,owner.authentication);
    assertNodeV28SourceBarrierBinding(owner.barrier,owner.database,owner.native,owner.lease,owner.authentication);
  }
  function close():Promise<void> {
    if(owner.closing)return owner.closing;
    stopAdmission();
    // Store the one original close before any potentially reentrant disposer.
    owner.closing=Promise.resolve().then(async()=>{
      try {
        if(owner.server){owner.transportDrain=stopNodeHttpServerAndDrain(owner.server);void owner.transportDrain.catch(()=>undefined);}
        if(owner.construction)await owner.construction.catch(()=>undefined);
        stopAdmission();
        for(const name of owner.attempted)if(!owner.constructed.has(name))throw owner.failed?owner.failure:failure();
        if(owner.server&&!owner.transportDrain){owner.transportDrain=stopNodeHttpServerAndDrain(owner.server);void owner.transportDrain.catch(()=>undefined);}
        if(owner.transportDrain)await owner.transportDrain;
        const pending=await Promise.allSettled([...owner.pending]);
        for(const result of pending)if(result.status==="rejected")throw result.reason;
        for(const body of owner.bodies)await body.close();
        // Actual transport/body ACK precedes original scheduled/provider/source
        // ACK. A rejecting first ACK blocks every later physical parent close.
        if(owner.scheduler)await owner.scheduler.drain();
        else {if(owner.file)await owner.file.drain();if(owner.package)await owner.package.drain();if(owner.recovery)await owner.recovery.drain();}
        if(owner.fileHttp)await owner.fileHttp.drain();if(owner.packageHttp)await owner.packageHttp.drain();
        if(owner.comment)await owner.comment.drainAfterTransport();if(owner.fabublox)await owner.fabublox.drainAfterTransport();
        if(owner.barrier)await owner.barrier.close();
        if(owner.failed)throw owner.failure;
        if(owner.cursor)await owner.cursor.close();
        owner.group?.discard();
        if(owner.opening)await owner.opening.close();
        owner.authority?.close();
        owner.physicalDrain=owner.lease.stopAdmissionAndDrain();void owner.physicalDrain.catch(()=>undefined);await owner.physicalDrain;
        owner.database.close();if(owner.native.isOpen)throw failure();await owner.lease.release();
        app=undefined;retained.delete(owner);
      }catch(error){quarantine(error);throw error;}
    });
    void owner.closing.catch(()=>undefined);return owner.closing;
  }
  const construction=Promise.resolve().then(()=>owner.lease.withWriter(async()=>{
    const transport=createLoopbackLocalAuthTransport({publicOrigin:captured.publicOrigin});
    const identity=await createInstalledLocalIdentity({database:owner.database,nativeDatabase:owner.native,admission:captured.admission,
      hasher:captured.hasher,policy:captured.identityPolicy});
    owner.authentication=createLocalAuthentication({identity,transport,now:Date.now});
    const authentication=owner.authentication;
    owner.attempted.add("opening");
    owner.opening=createLocalVolumeProfileOpeningV28Candidate({database:owner.database,nativeDatabase:owner.native,writerLease:owner.lease,
      admission:captured.admission,authentication,filesystemRootOwnerUid:config.filesystemRootOwnerUid,descriptors:config.localVolumes,authorizeAdministrator:()=>false});
    owner.constructed.add("opening");const opening=owner.opening;
    owner.attempted.add("barrier");owner.barrier=createNodeV28SourceBarrier({database:owner.database,nativeDatabase:owner.native,
      writerLease:owner.lease,admission:captured.admission,authentication,quarantine});owner.constructed.add("barrier");const sourceBarrier=owner.barrier;
    owner.attempted.add("authority");owner.authority=await createInstalledJobPrincipalAuthorityV28({database:owner.database,nativeDatabase:owner.native,
      writerLease:owner.lease,admission:captured.admission,authentication});owner.constructed.add("authority");const authority=owner.authority;
    owner.attempted.add("comment");owner.comment=createGroupV28CanonicalCommentRoutesBorrowedWorkflow({configuration:captured.configuration,
      database:owner.database,nativeDatabase:owner.native,writerLease:owner.lease,admission:captured.admission,authentication,
      opening,sourceBarrier,stopApplicationAdmission:stopAdmission});owner.constructed.add("comment");
    owner.attempted.add("group");owner.group=createGroupV28RoutesCandidate({database:owner.database,nativeDatabase:owner.native,
      writerLease:owner.lease,admission:captured.admission,authentication,sampleMetadataReads:true,sampleCanonicalAttachmentReadPort:owner.comment.sampleAttachmentProjection()});owner.constructed.add("group");
    owner.attempted.add("fabublox");owner.fabublox=createGroupV28FabubloxRoutesBorrowedWorkflow({configuration:captured.configuration,
      database:owner.database,nativeDatabase:owner.native,writerLease:owner.lease,admission:captured.admission,authentication,
      opening,sourceBarrier,stopApplicationAdmission:stopAdmission});owner.constructed.add("fabublox");
    owner.attempted.add("fileHttp");owner.fileHttp=createNodeFileJobHttpRoutes<{readonly database:SqliteCapability}>({authority,authentication,
      admission:captured.admission,writerLease:owner.lease});owner.constructed.add("fileHttp");
    owner.attempted.add("packageHttp");owner.packageHttp=createNodePackageHttpRoutesV28Candidate<{readonly database:SqliteCapability}>({configuration:captured.configuration,
      opening,authentication,admission:captured.admission,stopApplicationAdmission:stopAdmission});owner.constructed.add("packageHttp");
    owner.attempted.add("file");owner.file=createNodeV28FileJobChild({configuration:captured.configuration,opening,authentication,authority,sourceBarrier});owner.constructed.add("file");
    owner.attempted.add("package");owner.package=createNodeV28PackageJobChild({configuration:captured.configuration,opening,authentication,
      admission:captured.admission,authority,sourceBarrier});owner.constructed.add("package");
    owner.attempted.add("recovery");owner.recovery=await createNodeSystemRecoveryV28BorrowedChild({configuration:captured.configuration,
      database:owner.database,nativeDatabase:owner.native,writerLease:owner.lease,admission:captured.admission,publicOrigin:captured.publicOrigin,
      authentication,opening,sourceBarrier,quarantine});owner.constructed.add("recovery");
    assertNodeV28FileJobChildBinding(owner.file,opening,authentication,authority,sourceBarrier,captured.configuration);
    assertNodeV28PackageJobChildBinding(owner.package,opening,authentication,authority,sourceBarrier,captured.configuration);
    assertNodeSystemRecoveryV28BorrowedChildBinding(owner.recovery,owner.database,owner.native,owner.lease,authentication,sourceBarrier,opening);
    owner.attempted.add("cursor");owner.cursor=await openNodeV28JobCursor({configuration:captured.configuration,database:owner.database,
      nativeDatabase:owner.native,writerLease:owner.lease,admission:captured.admission,authentication,quarantine});owner.constructed.add("cursor");
    owner.attempted.add("scheduler");owner.scheduler=createNodeV28JobScheduler({database:owner.database,nativeDatabase:owner.native,
      writerLease:owner.lease,admission:captured.admission,authentication,file:owner.file,package:owner.package,recovery:owner.recovery.schedulerPort,
      cursorOwner:owner.cursor,quarantine});owner.constructed.add("scheduler");
    assertNodeV28JobSchedulerBinding(owner.scheduler,owner.database,owner.native,owner.lease,authentication);
    const application=new Hono<LocalAuthEnvironment>();
    application.use("*",async(c,next)=>{c.header("Cache-Control","private, no-store");c.header("X-Content-Type-Options","nosniff");await next();});
    application.onError((error,c)=>{
      if(cleanupUnproven(error)){quarantine(error);return unavailable();}
      if(error instanceof LocalRequestSubjectError)return c.json({error:"Current local authentication is required."},error.code==="authentication_required"?401:503);
      if(error instanceof HTTPException){
        if(c.req.method==="POST"&&new URL(c.req.raw.url).pathname==="/api/projects"&&error.status===409
          &&error.message==="Sign-in identity changed. Refresh Projects before retrying.")c.header(PROJECT_CREATION_SUBJECT_RESULT_HEADER,"mismatch");
        return c.json({error:error.message},error.status);
      }
      return unavailable();
    });
    application.route("/api/auth",authentication.routes);
    application.get("/api/health",c=>c.json({ok:true,capabilities:capabilities()}));
    application.get("/api/ready",authentication.middleware,async c=>{
      current();if(!owner.active||!owner.server?.listening||!owner.scheduler||!owner.recovery)throw new HTTPException(503,{message:"The selected V28 service is unavailable."});
      const state=owner.native.prepare(`SELECT c.schema_version,c.enforcement,m.state FROM collaboration_control c
        JOIN system_recovery_maintenance m ON m.singleton=c.singleton WHERE c.singleton=1`).get();
      if(state?.schema_version!==2||state.enforcement!=="enabled"||state.state!=="open")throw new HTTPException(503,{message:"The selected V28 service is unavailable."});
      await checkDatabaseReadiness(asReadinessDatabase(owner.database));current();
      return c.json({ok:true,scope:"mounted-v28-workflow",fullReady:false,capabilities:capabilities()});
    });
    application.route("/",owner.fabublox.app);application.route("/",owner.group.app);application.route("/",owner.comment.app);
    const jobs=new Hono<LocalAuthEnvironment>();jobs.use("*",authentication.middleware);
    jobs.route("/",owner.fileHttp.routes);jobs.route("/",owner.packageHttp.routes);application.route("/api",jobs);
    application.all("*",()=>unavailable());app=application;
    const fileRoutes=[{method:"GET",path:"/files/migrations"},{method:"GET",path:"/files/migrations/files"},
      {method:"GET",path:"/files/migrations/executor"},{method:"POST",path:"/files/migrations/executor"},
      {method:"POST",path:"/files/migrations/plans"},{method:"POST",path:"/files/migrations"},
      {method:"GET",path:"/files/migrations/requests/:requestId"},
      {method:"GET",path:"/files/migrations/:jobId"},{method:"GET",path:"/files/migrations/:jobId/items"},
      {method:"POST",path:"/files/migrations/:jobId/cleanup"},{method:"POST",path:"/files/migrations/:jobId/:action"}];
    admittedRoutes=Object.freeze([{method:"POST",path:"/api/auth/login"},{method:"GET",path:"/api/auth/session"},
      {method:"POST",path:"/api/auth/logout"},{method:"POST",path:"/api/auth/rotate"},
      {method:"GET",path:"/api/health"},{method:"GET",path:"/api/ready"},...owner.group.routes,...owner.comment.routes,...owner.fabublox.routes,
      ...fileRoutes.map(route=>({...route,path:"/api"+route.path})),...owner.packageHttp.admittedRoutes.map(route=>({...route,path:"/api"+route.path})),
      ...owner.recovery.routes].map(route=>Object.freeze({...route})));
    const routes=admittedRoutes.map(route=>({method:route.method,pattern:new RegExp(`^${route.path.replace(/:[A-Za-z]+/g,"[^/]+")}$`)}));
    owner.attempted.add("server");owner.server=createNodeHttpServer(async request=>{
      const pathname=new URL(request.url).pathname;
      if(!owner.active||!routes.some(route=>route.method===request.method&&route.pattern.test(pathname)))return unavailable();
      // Recovery/maintenance and authentication are excluded from SOURCE: a
      // maintenance route must never await its own original transport/lease.
      if(owner.recovery!.handles(request))return owner.recovery!.handle(request);
      const excluded=pathname.startsWith("/api/auth/")||pathname==="/api/health"||pathname==="/api/ready";
      const operation=async()=>{
        if(!owner.active||!app)return unavailable();current();
        if(!excluded){
          const lifetime=ownedNodeHttpRequestLifetime(request,owner.server!);
          const retained=sourceBarrier.retainInvocation(lifetime);
          void lifetime.settled.then(()=>retained.close(),()=>retained.close()).catch(quarantine);
        }
        const body=createGroupV28RequestBodyCustody(request);owner.bodies.add(body);
        try{return await app.fetch(request,{database:owner.database});}
        finally{try{await body.close();owner.bodies.delete(body);}catch(error){quarantine(error);throw error;}}
      };
      const original=excluded?owner.lease.withWriter(operation):sourceBarrier.runSource(operation);owner.pending.add(original);
      try{return await original;}catch(error){if(cleanupUnproven(error))quarantine(error);return unavailable();}
      finally{owner.pending.delete(original);}
    },{...captured.httpLimits,publicOrigin:captured.publicOrigin,fabubloxWireAdmission:owner.fabublox.wireAdmission,
      requestAdmission(request,incoming,server){try{transport.admit(request,incoming,server);}catch{return Response.json({error:"Request admission is required."},{status:403,headers:{"Cache-Control":"private, no-store"}});}}});
    owner.constructed.add("server");owner.scheduler.startOnListening(owner.server);
  }));
  owner.construction=construction;
  function capabilities():NodeV28WorkflowApplication["capabilities"] {
    if(!owner.recovery)throw failure();
    return Object.freeze({kind:"node-v28-workflow-mounted/1" as const,profile:"v28-workflow" as const,fullReady:false as const,
      admittedRoutes,jobCadenceMs:NODE_V28_JOB_CADENCE_MS,jobFamilies:Object.freeze(["file","package","recovery"] as const),
      persistedExecutorActivationRequired:true as const,startupProvisioning:false as const,generalFileLifecycle:false as const,
      imageBytes:false as const,spa:false as const,recovery:owner.recovery.surfaceCapabilities});
  }
  return construction.then(()=>Object.freeze({server:owner.server!,routes:admittedRoutes,capabilities:capabilities(),
    dispatchJobsOnce(){if(!owner.active||!owner.scheduler)throw failure();current();return owner.scheduler.dispatchOnce();},close}),async error=>{
    remember(error);try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],"V28 workflow construction and original parent close failed");}throw error;
  });
}
