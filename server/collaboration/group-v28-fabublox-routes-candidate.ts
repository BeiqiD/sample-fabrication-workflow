import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { DatabaseSync } from "node:sqlite";
import { acceptedImportState, FabubloxImportAcceptanceUnavailableError, FabubloxImportRequestConflictError } from "../../worker/imports/fabublox-acceptance-core";
import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";
import { localAuthenticationIdentityAuthority, type LocalAuthEnvironment } from "../auth/local-auth-http";
import { captureInstalledIdentityExecutionOwnerV28Candidate } from "../auth/installed-identity-execution-owner-v28-candidate";
import type { ReviewedInstallationAdmission } from "../migrations";
import { assertNodeRuntimeConfiguration, type LoadedNodeRuntimeConfiguration } from "../node-runtime-config";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import type { SqliteCapability } from "../sqlite";
import { createLocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate";
import { createLocalFabubloxUploadExecutionV28Candidate } from "../files/local-upload-execution";
import { createLocalFabubloxPermissionV28Candidate } from "../imports/local-fabublox-permission-v28-candidate";
import { publishLocalFabubloxTemplateV28Candidate } from "../imports/local-fabublox-template-publication-v28-candidate";
import { createLocalFabubloxRequestStateV28Candidate } from "../imports/local-fabublox-request-state-v28-candidate";
import { createFabubloxWireRouteAdmission } from "../imports/fabublox-wire-route-admission";
import { createLocalActiveFileRunStartPreviewPermissionV28Candidate } from "./local-run-start-preview-active-file-permission-v28-candidate";
import { readGroupV28Json } from "./group-v28-request-body-custody";
import { createLocalActiveFileEmptySampleCreatePermissionV28Candidate } from "./local-active-file-empty-sample-create-permission-v28-candidate";
import { createLocalActiveFileTemplateReadPermissionV28Candidate } from "./local-active-file-template-read-permission-v28-candidate";

type Execution=ReturnType<typeof createLocalFabubloxUploadExecutionV28Candidate>;
interface Owner {
  readonly pending:Set<Promise<Response>>;readonly executions:Set<Execution>;readonly cleanupFailures:Set<unknown>;
  openingAttempted:boolean;opening?:ReturnType<typeof createLocalVolumeProfileOpeningV28Candidate>;
  permissionAttempted:boolean;permission?:ReturnType<typeof createLocalFabubloxPermissionV28Candidate>;
  stateAttempted:boolean;state?:ReturnType<typeof createLocalFabubloxRequestStateV28Candidate>;
  runStartAttempted:boolean;runStart?:ReturnType<typeof createLocalActiveFileRunStartPreviewPermissionV28Candidate>;
  sampleCreateAttempted:boolean;sampleCreate?:ReturnType<typeof createLocalActiveFileEmptySampleCreatePermissionV28Candidate>;
  templateReadAttempted:boolean;templateRead?:ReturnType<typeof createLocalActiveFileTemplateReadPermissionV28Candidate>;
  phase:"constructing"|"open"|"stopping"|"closed"|"quarantined";closing?:Promise<void>;
}
const owners=new Set<Owner>();
const unavailable=()=>new HTTPException(503,{message:"Current FabuBlox collaboration is unavailable"});
function cleanupUnproven(error:unknown,seen=new Set<unknown>()):boolean {
  if(error instanceof StorageProfileCleanupError)return true;
  if(!error || typeof error!=="object" || seen.has(error))return false;
  seen.add(error);
  if(error instanceof AggregateError && error.errors.some(child=>cleanupUnproven(child,seen)))return true;
  return "cause" in error && cleanupUnproven(error.cause,seen);
}
export class GroupV28FabubloxDrainError extends AggregateError {
  declare readonly retainedOwners:readonly unknown[];
  constructor(errors:readonly unknown[],retained:readonly unknown[]){
    super(errors,"Original V28 FabuBlox ownership remains unresolved");this.name="GroupV28FabubloxDrainError";
    Object.defineProperty(this,"retainedOwners",{value:Object.freeze([...retained])});
  }
}
/** Explicit real-config child only. Same original ingress Request/session and
 * current family permission issue its closed upload/finalizer capability. The
 * status route is scalar; preview/start references never grant File body bytes. */
export function createGroupV28FabubloxRoutesCandidate(options:{
  configuration:LoadedNodeRuntimeConfiguration;database:SqliteCapability;nativeDatabase:DatabaseSync;
  writerLease:LinuxWriterLease;authentication:object;admission:ReviewedInstallationAdmission;
  stopApplicationAdmission():void;
}){
  const {configuration,database,nativeDatabase,writerLease,authentication,admission}=options;
  const config=assertNodeRuntimeConfiguration(configuration),auth=localAuthenticationIdentityAuthority(authentication);
  assertLinuxWriterLeaseBinding(writerLease,database,nativeDatabase);
  const installed=captureInstalledIdentityExecutionOwnerV28Candidate(auth.identity,database,nativeDatabase,admission);
  const main=nativeDatabase.prepare("PRAGMA database_list").all().filter(row=>row.name==="main");
  if(!config.enableLocalFile || config.enableLocalJobs || !config.localVolumes.length || main.length!==1
    || main[0]?.file!==config.databasePath || installed.installation.installationId!==config.expectedInstallationId
    || owners.size>=2)throw unavailable();
  const owner:Owner={pending:new Set(),executions:new Set(),cleanupFailures:new Set(),openingAttempted:false,
    permissionAttempted:false,stateAttempted:false,runStartAttempted:false,sampleCreateAttempted:false,templateReadAttempted:false,phase:"constructing"};owners.add(owner);
  const quarantine=(error:unknown)=>{owner.phase="quarantined";owner.cleanupFailures.add(error);options.stopApplicationAdmission();};
  let wireAdmission:ReturnType<typeof createFabubloxWireRouteAdmission>;
  try{
    owner.openingAttempted=true;
    owner.opening=createLocalVolumeProfileOpeningV28Candidate({database,nativeDatabase,writerLease,admission,authentication,
      filesystemRootOwnerUid:config.filesystemRootOwnerUid,descriptors:config.localVolumes,authorizeAdministrator:()=>false});
    owner.permissionAttempted=true;
    owner.permission=createLocalFabubloxPermissionV28Candidate({opening:owner.opening,authentication,admission});
    owner.stateAttempted=true;
    owner.state=createLocalFabubloxRequestStateV28Candidate({database,nativeDatabase,writerLease,authentication,admission});
    owner.runStartAttempted=true;
    owner.runStart=createLocalActiveFileRunStartPreviewPermissionV28Candidate({database,nativeDatabase,writerLease,authentication,admission,opening:owner.opening});
    owner.sampleCreateAttempted=true;
    owner.sampleCreate=createLocalActiveFileEmptySampleCreatePermissionV28Candidate({database,nativeDatabase,writerLease,authentication,admission,opening:owner.opening});
    owner.templateReadAttempted=true;
    owner.templateRead=createLocalActiveFileTemplateReadPermissionV28Candidate({database,nativeDatabase,writerLease,authentication,admission,opening:owner.opening});
    wireAdmission=createFabubloxWireRouteAdmission(configuration,owner.opening);
    owner.phase="open";
  }catch(error){quarantine(error);throw new GroupV28FabubloxDrainError([error],[owner,installed,config]);}
  const assertCurrent=()=>{
    if(assertNodeRuntimeConfiguration(configuration)!==config || localAuthenticationIdentityAuthority(authentication)!==auth)throw unavailable();
    installed.assertCurrent();assertLinuxWriterLeaseBinding(writerLease,database,nativeDatabase);
  };
  const app=new Hono<LocalAuthEnvironment>();
  const routes=Object.freeze([
    {method:"POST",path:"/api/samples"},{method:"POST",path:"/api/imports/fabublox"},{method:"GET",path:"/api/imports/fabublox/requests/:requestId"},
    {method:"POST",path:"/api/samples/:sampleId/runs/preview"},{method:"POST",path:"/api/samples/:sampleId/runs"},
    {method:"GET",path:"/api/template-families/options"},{method:"GET",path:"/api/template-families"},
    {method:"GET",path:"/api/template-families/:id/versions"},{method:"GET",path:"/api/metrology-templates"},
    {method:"GET",path:"/api/templates"},{method:"GET",path:"/api/templates/:id"},
  ].map(route=>Object.freeze(route)));
  const retain=(original:Promise<Response>)=>{
    owner.pending.add(original);original.then(()=>owner.pending.delete(original),error=>{
      if(cleanupUnproven(error))quarantine(error);else owner.pending.delete(original);
    });return original;
  };
  function dispatch(request:Request,work:()=>Promise<Response>):Promise<Response>{
    if(owner.phase!=="open")throw unavailable();
    return retain(Promise.resolve().then(async()=>{
      assertCurrent();if(new URL(request.url).origin!==config.publicOrigin)throw new HTTPException(403,{message:"Request admission is required."});
      try{return await work();}catch(error){
        // Keep typed original cleanup at the enclosing execution/host barrier.
        if(cleanupUnproven(error))throw error;
        if(error instanceof FabubloxImportRequestConflictError)throw new HTTPException(409,{message:error.message,cause:error});
        if(error instanceof FabubloxImportAcceptanceUnavailableError)throw new HTTPException(503,{message:error.message,cause:error});
        throw error;
      }
    }));
  }
  const headers=Object.freeze({"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"});
  app.post("/api/samples",c=>dispatch(c.req.raw,async()=>{
    const request=c.req.raw,token=await owner.sampleCreate!.capture(request);
    const value=await readGroupV28Json(request,65_536);
    return Response.json(await owner.sampleCreate!.create(request,token,value),{status:201,headers});
  }));
  app.post("/api/imports/fabublox",c=>{
    const request=c.req.raw;
    return dispatch(request,async()=>{
      const token=await owner.permission!.capture(request),actor=owner.permission!.actor(request,token);
      const execution=createLocalFabubloxUploadExecutionV28Candidate({opening:owner.opening!,request,actor,admission,authentication,permission:token});
      // Retain the original source/physical owner before its first acquisition,
      // body/parser/provider await. No Response or promise substitutes its ACK.
      owner.executions.add(execution);
      // Only this owner's actual original settlement releases host custody.
      // A rejected run/Response without that ACK retains the execution.
      execution.settled.then(()=>owner.executions.delete(execution),error=>{
        if(cleanupUnproven(error))quarantine(error);else owner.executions.delete(execution);
      });
      const original=execution.run(async held=>{
        await held.readFabubloxImportPayload!();
        const accepted=await owner.permission!.accept(request,token,held);
        if(!accepted.owned){
          const state=acceptedImportState(accepted.row);
          if(state.status==="ready")return Response.json(state.result,{status:200,headers});
          return Response.json({error:state.status==="pending"?"This import request is still pending.":"This import request failed. Start a new import to try again.",request:state},{status:409,headers});
        }
        const result=await publishLocalFabubloxTemplateV28Candidate(held,request,accepted.accepted);
        return Response.json(result,{status:201,headers});
      });
      return original;
    });
  });
  app.get("/api/imports/fabublox/requests/:requestId",c=>dispatch(c.req.raw,async()=>{
    const result=await owner.state!.read(c.req.raw);return Response.json(result.body,{status:result.status,headers});
  }));
  for(const operation of ["preview","start"] as const){
    const path=operation==="preview"?"/api/samples/:sampleId/runs/preview":"/api/samples/:sampleId/runs";
    app.post(path,c=>dispatch(c.req.raw,async()=>{
      const request=c.req.raw,token=await owner.runStart!.capture(request,{operation,sampleId:c.req.param("sampleId")});
      const result=await owner.runStart!.perform(request,token,()=>readGroupV28Json(request,65_536));
      return Response.json(result,{status:operation==="start"?201:200,headers});
    }));
  }
  // These six handlers preserve the original queries and complete neutral DTOs.
  // Authentication remains local to each captured GET, inside whole dispatch;
  // it adds no global middleware or File-body grant to any Fabu operation.
  const actor=async(request:Request)=>(await auth.authenticateRequest(request)).actor;
  app.get("/api/template-families/options",c=>dispatch(c.req.raw,async()=>{
    const r=c.req.raw;return Response.json(await owner.templateRead!.service(r).options(await actor(r)),{headers});
  }));
  app.get("/api/template-families",c=>dispatch(c.req.raw,async()=>{
    const r=c.req.raw;return Response.json(await owner.templateRead!.service(r).families({query:c.req.query("q"),page:c.req.query("page"),pageSize:c.req.query("pageSize")},await actor(r)),{headers});
  }));
  app.get("/api/template-families/:id/versions",c=>dispatch(c.req.raw,async()=>{
    const r=c.req.raw;return Response.json(await owner.templateRead!.service(r).versions(c.req.param("id"),c.req.query("q")?.trim()??"",await actor(r)),{headers});
  }));
  app.get("/api/metrology-templates",c=>dispatch(c.req.raw,async()=>{
    const r=c.req.raw;return Response.json(await owner.templateRead!.service(r).metrology({query:c.req.query("q"),page:c.req.query("page"),pageSize:c.req.query("pageSize")},await actor(r)),{headers});
  }));
  app.get("/api/templates",c=>dispatch(c.req.raw,async()=>{
    const r=c.req.raw;return Response.json(await owner.templateRead!.service(r).list(c.req.query("view")==="picker",await actor(r)),{headers});
  }));
  app.get("/api/templates/:id",c=>dispatch(c.req.raw,async()=>{
    const r=c.req.raw;return Response.json(await owner.templateRead!.service(r).detail(c.req.param("id"),await actor(r)),{headers});
  }));
  return Object.freeze({app,routes,wireAdmission,
    stopAdmission(){if(owner.phase==="open")owner.phase="stopping";},
    drainAfterTransport():Promise<void>{
      if(owner.closing)return owner.closing;if(owner.phase==="open")owner.phase="stopping";
      owner.closing=Promise.resolve().then(async()=>{
        const errors:unknown[]=[];
        await Promise.allSettled([...owner.pending]);
        for(const execution of owner.executions){try{await execution.dispose();}catch(error){errors.push(error);}}
        if(owner.openingAttempted && !owner.opening || owner.permissionAttempted && !owner.permission
          || owner.stateAttempted && !owner.state || owner.runStartAttempted && !owner.runStart
          || owner.sampleCreateAttempted && !owner.sampleCreate || owner.templateReadAttempted && !owner.templateRead)errors.push(unavailable());
        try{await owner.permission?.close();}catch(error){errors.push(error);}
        try{await owner.state?.close();}catch(error){errors.push(error);}
        try{await owner.sampleCreate?.close();}catch(error){errors.push(error);}
        try{await owner.templateRead?.close();}catch(error){errors.push(error);}
        owner.runStart?.discard();errors.push(...owner.cleanupFailures);
        if(errors.length || owner.phase==="quarantined"){
          owner.phase="quarantined";throw new GroupV28FabubloxDrainError(errors,[owner,installed,config]);
        }
        try{await owner.opening?.close();}catch(error){errors.push(error);}
        if(errors.length){quarantine(errors[0]);throw new GroupV28FabubloxDrainError(errors,[owner,installed,config]);}
        assertCurrent();owner.phase="closed";owners.delete(owner);
      });void owner.closing.catch(()=>undefined);return owner.closing;
    },
  });
}
