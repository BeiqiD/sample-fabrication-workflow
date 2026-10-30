import { assertNodeRuntimeConfigurationForProfile } from "../node-runtime-config.ts";
import { assertLocalVolumeProfileOpeningV28Binding } from "../storage/local-volume-profile-opening.ts";
import { assertNodeV28SourceBarrierBinding, type createNodeV28SourceBarrier } from "../recovery/node-v28-source-barrier.ts";
import type { LocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate.ts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { DatabaseSync } from "node:sqlite";
import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";
import { localAuthenticationIdentityAuthority, type LocalAuthEnvironment } from "../auth/local-auth-http";
import type { ReviewedInstallationAdmission } from "../migrations";
import { assertNodeRuntimeConfiguration, type LoadedNodeRuntimeConfiguration } from "../node-runtime-config";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import type { SqliteCapability } from "../sqlite";
import { captureInstalledIdentityExecutionOwnerV28Candidate } from "../auth/installed-identity-execution-owner-v28-candidate";
import { createLocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate";
import { createLocalCommentAcceptanceV28Candidate } from "../files/local-comment-acceptance-v28-candidate";
import { createLocalCommentReadV28Candidate, createLocalCommentSampleAttachmentReadPortV28Candidate,
  type LocalCommentSampleAttachmentReadPortV28Candidate } from "../files/local-comment-read-v28-candidate";

interface Owner {
  readonly configuration: LoadedNodeRuntimeConfiguration;
  readonly database: SqliteCapability; readonly native: DatabaseSync; readonly lease: LinuxWriterLease;
  readonly authentication: object; readonly admission: ReviewedInstallationAdmission;
  readonly pending: Set<Promise<Response>>; readonly cleanupFailures: Set<unknown>;
  openingAttempted: boolean; opening?: ReturnType<typeof createLocalVolumeProfileOpeningV28Candidate>;
  acceptanceAttempted: boolean; acceptance?: ReturnType<typeof createLocalCommentAcceptanceV28Candidate>;
  readAttempted: boolean; read?: ReturnType<typeof createLocalCommentReadV28Candidate>;
  sampleAttachmentPort?: LocalCommentSampleAttachmentReadPortV28Candidate;
  phase: "constructing" | "open" | "stopping" | "closed" | "quarantined";
  closing?: Promise<void>;
}
const owners = new Set<Owner>();
function cleanupUnproven(error: unknown, seen = new Set<unknown>()): boolean {
  if (error instanceof StorageProfileCleanupError) return true;
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  if (error instanceof AggregateError && error.errors.some(cause => cleanupUnproven(cause, seen))) return true;
  // The corrected private owner preserves a typed cleanup failure through
  // either an AggregateError or an ordinary safe HTTP error's original cause.
  return "cause" in error && cleanupUnproven(error.cause, seen);
}
export class GroupV28CanonicalCommentDrainError extends AggregateError {
  declare readonly retainedOwners: readonly unknown[];
  constructor(errors: readonly unknown[], retained: readonly unknown[]) {
    super(errors,"Original V28 canonical Comment ownership remains unresolved");
    this.name="GroupV28CanonicalCommentDrainError";
    Object.defineProperty(this,"retainedOwners",{value:Object.freeze([...retained])});
  }
}
const unavailable=()=>new HTTPException(503,{message:"Current canonical Comment acceptance is unavailable"});
/** Six original canonical acceptance operations and the two original attachment
 * byte transports, using the actual V28 opening and original Request/all-target
 * purpose issuer. This never registers/activates a profile, grants a root, exposes
 * credentials/provider ports or supplies a V26 receipt. No canonical-image byte
 * route or Sample media availability is inferred from attachment permission. */
type WorkflowBorrow = Readonly<{ opening: LocalVolumeProfileOpeningV28Candidate;
  sourceBarrier: ReturnType<typeof createNodeV28SourceBarrier> }>;
type ChildOptions = {
  configuration:LoadedNodeRuntimeConfiguration; database:SqliteCapability; nativeDatabase:DatabaseSync;
  writerLease:LinuxWriterLease; authentication:object; admission:ReviewedInstallationAdmission;
  stopApplicationAdmission():void;
};
export function createGroupV28CanonicalCommentRoutesCandidate(options: ChildOptions) { return createOriginalRoutes(options); }
/** Explicit combined profile only. No new opening, copied parent, or Jobs=false bypass. */
export function createGroupV28CanonicalCommentRoutesBorrowedWorkflow(options: ChildOptions & WorkflowBorrow) {
  const config = assertNodeRuntimeConfigurationForProfile(options.configuration, "v28-workflow");
  if (!config.enableLocalFile || !config.enableLocalJobs || !config.enableLocalRecovery) throw unavailable();
  assertNodeV28SourceBarrierBinding(options.sourceBarrier, options.database, options.nativeDatabase, options.writerLease, options.authentication);
  assertLocalVolumeProfileOpeningV28Binding(options.opening, options.database, options.nativeDatabase, options.writerLease, options.authentication);
  return createOriginalRoutes(options, Object.freeze({ opening: options.opening, sourceBarrier: options.sourceBarrier }));
}
function createOriginalRoutes(options: ChildOptions, borrowed?: WorkflowBorrow) {
  const {configuration,database,nativeDatabase,writerLease,authentication,admission}=options;
  const config=assertNodeRuntimeConfiguration(configuration);
  assertLinuxWriterLeaseBinding(writerLease,database,nativeDatabase);
  const auth=localAuthenticationIdentityAuthority(authentication);
  const installed=captureInstalledIdentityExecutionOwnerV28Candidate(auth.identity,database,nativeDatabase,admission);
  const main=nativeDatabase.prepare("PRAGMA database_list").all().filter(row=>row.name==="main");
  if(!config.enableLocalFile || (borrowed ? !config.enableLocalJobs : config.enableLocalJobs) || !config.localVolumes.length || main.length!==1
    || main[0]?.file!==config.databasePath || installed.installation.installationId!==config.expectedInstallationId
    || owners.size>=2) throw unavailable();
  const owner:Owner={configuration,database,native:nativeDatabase,lease:writerLease,authentication,admission,
    pending:new Set(),cleanupFailures:new Set(),openingAttempted:false,acceptanceAttempted:false,readAttempted:false,phase:"constructing"};
  owners.add(owner);
  const quarantine=(error:unknown)=>{
    owner.phase="quarantined";owner.cleanupFailures.add(error);options.stopApplicationAdmission();
  };
  try {
    owner.openingAttempted = !borrowed;
    owner.opening = borrowed ? borrowed.opening : createLocalVolumeProfileOpeningV28Candidate({database,nativeDatabase,writerLease,admission,authentication,
      filesystemRootOwnerUid:config.filesystemRootOwnerUid,descriptors:config.localVolumes,
      // No ordinary Group method on this surface can use administrator profile
      // registration. Independently authorized setup must already be complete.
      authorizeAdministrator:()=>false});
    owner.acceptanceAttempted=true;
    owner.acceptance=createLocalCommentAcceptanceV28Candidate({opening:owner.opening,authentication,admission});
    owner.readAttempted=true;
    owner.read=createLocalCommentReadV28Candidate({opening:owner.opening,authentication,admission});
    owner.phase="open";
  } catch(error) {
    quarantine(error);
    // A constructor that has not returned its child owner has no original
    // disposer ACK. Retain the original parent rather than guessing cleanup.
    throw new GroupV28CanonicalCommentDrainError([error],[owner,installed,config]);
  }
  const assertCurrent=()=>{
    if(assertNodeRuntimeConfiguration(configuration)!==config || localAuthenticationIdentityAuthority(authentication)!==auth)
      throw unavailable();
    installed.assertCurrent();assertLinuxWriterLeaseBinding(writerLease,database,nativeDatabase);
    if (borrowed) {
      assertNodeRuntimeConfigurationForProfile(configuration, "v28-workflow");
      assertNodeV28SourceBarrierBinding(borrowed.sourceBarrier, database, nativeDatabase, writerLease, authentication);
      assertLocalVolumeProfileOpeningV28Binding(borrowed.opening, database, nativeDatabase, writerLease, authentication);
    }
  };
  const app=new Hono<LocalAuthEnvironment>();
  const acceptanceRoutes=Object.freeze([
    {method:"POST",path:"/api/comment-submissions"},
    {method:"GET",path:"/api/comment-submissions/:submissionId/acceptance"},
    {method:"PUT",path:"/api/comment-submissions/:submissionId/items/:itemId/content"},
    {method:"DELETE",path:"/api/comment-submissions/:submissionId/items/:itemId"},
    {method:"POST",path:"/api/comment-submissions/:submissionId/finalize"},
    {method:"POST",path:"/api/comment-submissions/:submissionId/cancel"},
  ].map(route=>Object.freeze(route)));
  const byteRoutes=Object.freeze([
    {method:"GET",path:"/api/attachments/:itemId/download"},
    {method:"GET",path:"/api/exports/attachments/:itemId"},
  ].map(route=>Object.freeze(route)));
  const admittedRoutes=Object.freeze([...acceptanceRoutes,...byteRoutes]);
  const retain=(original:Promise<Response>)=>{
    owner.pending.add(original);
    original.then(()=>owner.pending.delete(original),error=>{
      if(cleanupUnproven(error)) quarantine(error);
      else owner.pending.delete(original);
    });
    return original;
  };
  for(const route of acceptanceRoutes) app.on(route.method,route.path,c=>{
    if(owner.phase!=="open") throw unavailable();
    const request=c.req.raw;
    // Retain this whole original operation before its capture/body/native await.
    const original=Promise.resolve().then(async()=>{
      assertCurrent();
      if(new URL(request.url).origin!==config.publicOrigin) throw new HTTPException(403,{message:"Request admission is required."});
      const token=await owner.acceptance!.capture(request);
      const result=await owner.acceptance!.perform(request,token);
      assertCurrent();
      return Response.json(result.value,{status:result.status,headers:{"Cache-Control":result.cacheControl,"X-Content-Type-Options":"nosniff"}});
    });
    // A capture failure may retain the original body even before an execution
    // returns. Keep its exact recursive cleanup cause at this parent too.
    return retain(original);
  });
  for(const route of byteRoutes) app.on(route.method,route.path,c=>{
    if(owner.phase!=="open") throw unavailable();
    const request=c.req.raw;
    const original=Promise.resolve().then(async()=>{
      assertCurrent();
      if(new URL(request.url).origin!==config.publicOrigin) throw new HTTPException(403,{message:"Request admission is required."});
      const token=await owner.read!.capture(request);
      const description=await owner.read!.describe(request,token);
      // describe() is typed item metadata, never an availability assertion. Only
      // the original read's actual outcome permits exposing its owned stream.
      const held=await owner.read!.read(request,token),result=held.result;
      assertCurrent();
      if(result.outcome!=="available"){
        await held.dispose();
        if(result.outcome==="missing") throw new HTTPException(404,{message:"Attachment object not found"});
        throw new HTTPException(503,{message:"Attachment storage is unavailable"});
      }
      const fallback=description.filename.replace(/[^a-zA-Z0-9._-]/g,"_")||"attachment";
      const contentType=route.path==="/api/exports/attachments/:itemId"
        ? result.contentType || description.mimeType || "application/octet-stream"
        : String(result.contentType || description.mimeType);
      // Whole active attachment-header expressions follow the original Worker
      // download/export contract. The private read owner, rather than a wrapper
      // Response/body clone, retains the first read/cancel/hold/source ACKs.
      return new Response(result.body,{headers:{
        "content-type":contentType,
        "content-disposition":`attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(description.filename)}`,
        "cache-control":"private, no-store","x-content-type-options":"nosniff",
        ...(result.etag ? {etag:result.etag} : {}),
      }});
    });
    return retain(original);
  });
  return Object.freeze({app,routes:admittedRoutes,
    sampleAttachmentProjection():LocalCommentSampleAttachmentReadPortV28Candidate {
      if(owner.phase!=="open" || !owner.read || !owner.opening) throw unavailable();
      assertCurrent();
      return owner.sampleAttachmentPort ??= createLocalCommentSampleAttachmentReadPortV28Candidate(owner.read,owner.opening);
    },
    stopAdmission(){if(owner.phase==="open")owner.phase="stopping";},
    /** Only after the original HTTP transport has settled all body pumps. */
    drainAfterTransport():Promise<void>{
      if(owner.closing)return owner.closing;
      if(owner.phase==="open")owner.phase="stopping";
      owner.closing=Promise.resolve().then(async()=>{
        const errors:unknown[]=[];
        await Promise.allSettled([...owner.pending]);
        if(owner.openingAttempted && !owner.opening || owner.acceptanceAttempted && !owner.acceptance
          || owner.readAttempted && !owner.read) errors.push(unavailable());
        try{await owner.acceptance?.close();}catch(error){errors.push(error);}
        try{await owner.read?.close();}catch(error){errors.push(error);}
        errors.push(...owner.cleanupFailures);
        if(errors.length || owner.phase==="quarantined"){
          owner.phase="quarantined";throw new GroupV28CanonicalCommentDrainError(errors,[owner,installed,config]);
        }
        try{if (!borrowed) await owner.opening?.close();}catch(error){errors.push(error);}
        if(errors.length){quarantine(errors[0]);throw new GroupV28CanonicalCommentDrainError(errors,[owner,installed,config]);}
        assertCurrent();owner.phase="closed";owners.delete(owner);
      });
      void owner.closing.catch(()=>undefined);return owner.closing;
    },
  });
}
