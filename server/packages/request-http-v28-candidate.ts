import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import type { FilePurpose } from "../../shared/contracts/files";
import { createPackageRoutes, PACKAGE_HTTP_ROUTES, readPackageRequestJson } from "../../worker/packages/routes-core";
import { readSqlStorageRoleDefaults, roleForFilePurpose, StorageRoleDefaultsUnavailableError } from "../../worker/files/storage-role-defaults-core";
import { closeFileJobExecutions, requiresFileJobExecutionQuarantine } from "../../worker/files/jobs/execution-lifetime";
import { bindPackageFormatCapabilities } from "../../worker/packages/jobs/format-capabilities";
import { SqlPackageRepository } from "../../worker/packages/jobs/sql-repository";
import { writePackageUpload } from "../../worker/packages/jobs/kernel";
import type { PackageCapabilities, PackageTargets } from "../../worker/packages/jobs/types";
import type { OwnedPublishedFileRead } from "../../worker/files/authority-reader-core";
import type { ReviewedInstallationAdmission } from "../migrations";
import { assertNodeRuntimeConfiguration, type LoadedNodeRuntimeConfiguration } from "../node-runtime-config";
import { assertLocalPackageRequestExecutionOwner, createLocalPackageRequestExecutionV28Candidate } from "../files/local-upload-execution";
import { ownedCommentAcceptanceBody } from "../files/owned-comment-acceptance-body";
import { captureLocalVolumeProfileAuthority, type LocalVolumeProfileAuthority } from "../storage/local-volume-profile-opening";
import { ownedLocalVolumeProfileContextV28Candidate, type LocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate";
import { createLocalPackagePermissionV28Candidate, ownedLocalPackagePermissionV28Candidate } from "./local-permission-v28-candidate";
import { nodeSha256 } from "../storage/node-sha256";

type Scope = ReturnType<typeof createLocalPackageRequestExecutionV28Candidate>;
interface RequestOwner { readonly scope:Scope; failure?:unknown }
const purposes:readonly FilePurpose[]=["research_source","provenance","embedded_content","derived_preview","job_output"];
/** Separate fixed-purpose V28 Request adapter for the unchanged shared router. The sole host owns
 * this opening, native connection and original physical writer. Metadata HTTP
 * never executes queued jobs; explicit localJobs opt-in mounts this surface.
 * Actual Group membership/root checks join each original same-BEGIN; no
 * profile activation or executor enablement is issued. */
export function createNodePackageHttpRoutesV28Candidate<Bindings extends object>(options:{
  configuration:LoadedNodeRuntimeConfiguration; opening:LocalVolumeProfileOpeningV28Candidate;
  authentication:object; admission:ReviewedInstallationAdmission;
  stopApplicationAdmission():void;
}) {
  if(Object.keys(options).sort().join(",")!=="admission,authentication,configuration,opening,stopApplicationAdmission")throw new Error("Closed V28 Package HTTP owner is required");
  const {configuration,opening,authentication,admission}=options;
  const config=assertNodeRuntimeConfiguration(configuration),local=ownedLocalVolumeProfileContextV28Candidate(opening);
  if(!config.enableLocalFile||!config.enableLocalJobs||local.installationCheckpointId!=="portable-runtime/v28"
    ||config.expectedInstallationId!==local.installationId
    ||local.nativeDatabase.prepare("PRAGMA database_list").all().find(row=>row.name==="main")?.file!==config.databasePath)
    throw new Error("Explicit current Node Package HTTP opt-in is unavailable");
  const permissions=createLocalPackagePermissionV28Candidate({opening,authentication,admission});
  const owners=new Set<RequestOwner>();
  let phase:"open"|"stopping"|"closed"|"quarantined"="open",draining:Promise<void>|undefined;
  function current(){
    if(phase!=="open"||assertNodeRuntimeConfiguration(configuration)!==config)
      throw new HTTPException(503,{message:"Package request admission is unavailable."});
    local.assertCurrent();
  }
  const routes=createPackageRoutes<Bindings>({async run(request,_bindings,actor,work){
    current();
    if(new URL(request.url).origin!==config.publicOrigin)
      throw new HTTPException(403,{message:"Request admission is required."});
    const token=await permissions.capture(request);
    const permission=ownedLocalPackagePermissionV28Candidate(token,opening,request,actor);
    const scope=createLocalPackageRequestExecutionV28Candidate({opening,request,actor,admission,authentication,permission:token});
    const owned:RequestOwner={scope};owners.add(owned);
    scope.settled.then(()=>owners.delete(owned),error=>{
      owned.failure=error;
      if(requiresFileJobExecutionQuarantine(error)){phase="quarantined";options.stopApplicationAdmission();}
      else owners.delete(owned);
    });
    let delivered=false,resolve!:(value:Response)=>void,reject!:(reason:unknown)=>void;
    const response=new Promise<Response>((yes,no)=>{resolve=yes;reject=no;});
    const original=scope.run(async execution=>{
      assertLocalPackageRequestExecutionOwner(execution,opening,request,actor);
      const authorities:LocalVolumeProfileAuthority[]=[];
      const database=execution.packageDatabase!(authorities),repository=new SqlPackageRepository(database,()=>new Date(),randomUUID);
      const originalAccept=repository.accept.bind(repository);
      repository.accept=async(input,authorize)=>{permission.accept(input,database);return originalAccept(input,authorize);};
      const settled=new SqlPackageRepository(execution.packageSettlementDatabase!(),()=>new Date(),randomUUID);
      const reads:OwnedPublishedFileRead[]=[];
      const ingresses=new Set<ReturnType<typeof ownedCommentAcceptanceBody>>();
      const cleanupFailures:unknown[]=[];
      function ingress(){
        try{const body=ownedCommentAcceptanceBody(request,assertCurrent);ingresses.add(body);return body;}
        catch(error){if(requiresFileJobExecutionQuarantine(error))cleanupFailures.push(error);throw error;}
      }
      async function closeIngress(body:ReturnType<typeof ownedCommentAcceptanceBody>){
        try{await body.dispose();ingresses.delete(body);}
        catch(error){cleanupFailures.push(error);throw error;}
      }
      async function assertCurrent(){assertLocalPackageRequestExecutionOwner(execution,opening,request,actor);await database.batch([]);}
      function capture(target:{profileId:string;configurationRevision:number},access:"read"|"write"){
        const previous=authorities.find(a=>a.profile.profileId===target.profileId&&a.profile.configurationRevision===target.configurationRevision&&a.access===access);
        if(previous)return previous;
        const issued=captureLocalVolumeProfileAuthority(opening,target,access);
        if(authorities.length>=4)throw new Error("Package Request profile check budget exceeded");
        authorities.push(issued);return issued;
      }
      async function inspectRuntime(){
        await assertCurrent();
        const row=await database.prepare(`SELECT j.enabled,j.incarnation,c.mode,f.enabled file_enabled,m.state
          FROM file_job_runtime_guard j JOIN file_authority_control c ON c.singleton=j.singleton
          JOIN file_authority_runtime_guard f ON f.singleton=j.singleton
          JOIN system_recovery_maintenance m ON m.singleton=j.singleton WHERE j.singleton=1`)
          .first<{enabled:number;incarnation:string;mode:string;file_enabled:number;state:string}>();
        if(!row||row.enabled!==1||typeof row.incarnation!=="string"||!row.incarnation)return{outcome:"disabled"};
        if(row.mode!=="active"||row.file_enabled!==1||row.state!=="open")return{outcome:"paused"};
        return{outcome:"available",incarnation:row.incarnation};
      }
      const ports={actor,repository,database,
        actorAllowed:()=>execution.packageActorAllowed!(),
        async selectTargets(required:readonly FilePurpose[]=["job_output"]){
          await assertCurrent();
          const defaults=await readSqlStorageRoleDefaults(execution.historyDatabase());
          if(!defaults)throw new StorageRoleDefaultsUnavailableError();
          const revision=defaults.internal.policyRevision,needed=new Set(required.map(roleForFilePurpose));
          const metadata=(await database.prepare(`SELECT d.role,p.id,p.namespace_identity,p.configuration_revision,p.adapter_type,p.configuration_source
            FROM storage_role_defaults d JOIN storage_profiles p ON p.id=d.storage_profile_id AND p.configuration_revision=d.storage_profile_revision ORDER BY d.role`)
            .all<{role:"internal"|"originals";id:string;namespace_identity:string;configuration_revision:number;adapter_type:string;configuration_source:string}>()).results;
          if(metadata.length!==2||metadata.some(p=>p.adapter_type!=="local"||p.configuration_source!=="installation"||p.configuration_revision!==1))
            throw new StorageRoleDefaultsUnavailableError();
          for(const role of needed){const chosen=metadata.find(p=>p.role===role);if(!chosen)throw new StorageRoleDefaultsUnavailableError();capture({profileId:chosen.id,configurationRevision:1},"write");}
          const targets={} as Record<FilePurpose,PackageTargets[FilePurpose]>;
          for(const purpose of purposes){const chosen=metadata.find(p=>p.role===roleForFilePurpose(purpose));if(!chosen)throw new StorageRoleDefaultsUnavailableError();
            targets[purpose]={profileId:chosen.id,configurationRevision:1,namespaceIdentity:chosen.namespace_identity,policyRevision:revision};}
          const statements=[database.prepare(`SELECT CASE WHEN(SELECT count(*) FROM storage_role_defaults)=2 AND
            (SELECT MAX(policy_revision) FROM storage_role_policy_revisions)=? AND
            (SELECT count(*) FROM storage_role_defaults d JOIN storage_role_policy_revisions h
              ON h.policy_revision=d.policy_revision AND h.role=d.role AND h.storage_profile_id=d.storage_profile_id
                AND h.storage_profile_revision=d.storage_profile_revision AND h.created_at=d.created_at
              JOIN storage_profiles p ON p.id=d.storage_profile_id AND p.configuration_revision=d.storage_profile_revision
              WHERE d.policy_revision=? AND p.adapter_type='local' AND p.configuration_source='installation'
                AND((d.role='internal' AND p.id=? AND p.namespace_identity=?) OR(d.role='originals' AND p.id=? AND p.namespace_identity=?)))=2
            THEN 1 ELSE json('Selected local package role policy changed') END`)
            .bind(revision,revision,targets.job_output.profileId,targets.job_output.namespaceIdentity,targets.research_source.profileId,targets.research_source.namespaceIdentity)];
          await assertCurrent();return{targets,revision,statements};
        },inspectRuntime,
        async canManage(){return Boolean(await database.prepare(`SELECT 1 FROM local_accounts a JOIN local_admin_grants g ON g.principal_id=a.principal_id
          WHERE 'local-account:'||a.principal_id=? AND a.enabled=1`).bind(actor).first());},
        async capabilities():Promise<PackageCapabilities|null>{
          const runtime=await inspectRuntime();if(runtime.outcome!=="available"||!runtime.incarnation)return null;
          return bindPackageFormatCapabilities({repository,incarnation:runtime.incarnation,authorizeActor:value=>value===actor&&execution.packageActorAllowed!(),
            now:()=>new Date(),randomId:randomUUID,
            async openStorage(target,access,beforeRequest,signal){
              capture(target,access);await assertCurrent();
              const opened=await execution.openProfile(target,access,{signal,async beforeRequest(operation){
                await assertCurrent();if(await beforeRequest(operation)!==true)return false;await assertCurrent();return true;
              }});
              if(opened.storage.adapterType!=="local")
                throw new HTTPException(503,{message:"Selected package volume is unavailable."});
              return{...opened,namespaceIdentity:opened.storage.namespaceIdentity,adapterType:"local" as const,
                atomicSinglePut:true,...(opened.dispose?{dispose:opened.dispose.bind(opened)}:{})};
            },
          },nodeSha256);
        },
        async readJson(originalRequest:Request){
          if(originalRequest!==request)throw new Error("Original Package ingress Request changed");
          const body=ingress();
          try{const value=await readPackageRequestJson(request,body.body);permission.selectJson(value);return value;}
          finally{await closeIngress(body);}
        },
        async writeUpload(capabilities:PackageCapabilities,claim:Parameters<typeof writePackageUpload>[1],originalBody:ReadableStream<Uint8Array>){
          if(originalBody!==request.body)throw new Error("Original Package upload body changed");
          const body=ingress();
          const active:PackageCapabilities={...capabilities,repository:{...repository,
            database:repository.database,claim:repository.claim.bind(repository),owns:repository.owns.bind(repository),guard:repository.guard.bind(repository),
            job:repository.job.bind(repository),status:repository.status.bind(repository),files:repository.files.bind(repository),records:repository.records.bind(repository),
            attempt:repository.attempt.bind(repository),stage:repository.stage.bind(repository),startWrite:repository.startWrite.bind(repository),
            settled:settled.settled.bind(settled),pause:settled.pause.bind(settled),verify:repository.verify.bind(repository),checkpoint:repository.checkpoint.bind(repository),
            addOutput:repository.addOutput.bind(repository),publishFile:repository.publishFile.bind(repository),publish:repository.publish.bind(repository),
          }};
          try{await writePackageUpload(active,claim,body.body);}
          finally{
            try{await closeFileJobExecutions(active);}catch(error){cleanupFailures.push(error);throw error;}
            await closeIngress(body);
          }
        },
        async readOutput(fileId:string){const read=await execution.openRead({fileId,purpose:"job_output"});reads.push(read);return read.result;},
      };
      try{
        const result=await work(ports);
        await assertCurrent();
        if(reads.length){delivered=true;resolve(result);}
        // Response streaming remains under the original Request/native/source
        // owner until its original read/provider/hold settlement acknowledges.
        await Promise.all(reads.map(read=>read.settled));
        return result;
      }finally{
        for(const body of ingresses){try{await closeIngress(body);}catch{/* Retain its original first failure below. */}}
        if(cleanupFailures.length)throw new StorageProfileCleanupError(undefined,cleanupFailures[0],{
          owner:Object.freeze({request,scope,execution,ingresses,reads,cleanupFailures}),
          dispose:()=>Promise.reject(cleanupFailures[0]),
        });
      }
    });
    original.then(result=>{if(!delivered){delivered=true;resolve(result);}},error=>{if(!delivered)reject(error);});
    return response;
  }});
  return Object.freeze({routes,admittedRoutes:PACKAGE_HTTP_ROUTES,
    stopAdmission(){if(phase==="open")phase="stopping";},
    closeBeforeTransport(){if(owners.size)throw new Error("Original Package transport must drain");return drain();},
    drain,
  });
  function drain():Promise<void>{
    if(draining)return draining;if(phase==="open")phase="stopping";
    draining=(async()=>{
      const results=await Promise.allSettled([...owners].map(owner=>owner.scope.settled));
      const failures=results.flatMap(result=>result.status==="rejected"&&requiresFileJobExecutionQuarantine(result.reason)?[result.reason]:[]);
      if(failures.length||phase==="quarantined")throw new AggregateError(failures,"Original Package request ownership could not drain");
      await permissions.close();phase="closed";
    })();draining.then(()=>undefined,()=>undefined);return draining;
  }
}
