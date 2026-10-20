import { assertWorkerV5PlannedSourceWindowCurrent, workerV5PlannedSourceFinishGuards, recordWorkerV5PlannedSourceCheckpoint } from "./v5-planned-source-window";
import { registerWorkerRecoveryExecutionOwner, ownWorkerRecoveryBodyClose } from "../files/jobs/execution-lifetime";
import { beginWorkerV5SourceCloseIntent, assertWorkerV5OriginalSourceIntentIssue, bindWorkerV5PlannedOriginalTargetInput, acknowledgeWorkerV5OriginalNativeSource, ownWorkerV5OriginalSourceBody,
  registerWorkerV5SourceCloseOwner, closeWorkerV5OriginalSourceOwner, type WorkerV5SourceCloseIntent } from "./v5-source-close-owner";
import { ownWorkerV5SourceStream } from "./v5-held-r2-archive-candidate";
import { captureWorkerV5PublicSnapshot } from "./v28-held-backup-snapshot-candidate";
import { sourceBackupCheckpointV5 } from "../../shared/contracts/system-backup-v5";
import { planSystemBackupSourcesV28 } from "../../shared/contracts/system-backup-v28-content";
import { prepareWorkerSystemBackupArchive, validateWorkerSystemBackupArchive } from "./archive-format";
import { openWorkerV5BackupSource } from "./backup-archive";
import type { WorkerRecoveryRecords, WorkerRecoveryManifest, WorkerRecoveryFile, WorkerRecoverySource } from "./versioned-catalog";
import { planSystemBackupSourcesV26 } from "../../shared/contracts/system-backup-v26-content";
import type { Env } from "../types";
import { canAdministerSystemSettings } from "../storage/system-administrator";
import { allowedEmail } from "../auth";
import { SystemRecoveryRepository, SystemRecoveryConflict, type RecoveryClaim, type RecoveryJob } from "./repository";
import type { SystemRecoveryCapabilitiesAdapter } from "./jobs";
import { runSystemRecoveryJobStep } from "./jobs";
import { cloudflareSha256 } from "../files/storage-adapters/cloudflare-sha256";
import { stableJson,sha256Hex } from "../../shared/domain/content-addressing";
import { planSystemBackupSources, type SystemBackupSource, type SystemBackupFile } from "../../shared/contracts/system-backup";
import type { SystemRecoveryCapabilities, SystemRecoveryPreview, SystemRecoveryJobStatus, SystemRecoveryImportInput } from "../../shared/contracts/system-recovery";
import { captureVersionedSystemBackupSnapshot, sourceVersionedBackupCheckpoint } from "./portable-backup-snapshot";
import { selectWorkerRecoveryCatalog as selectReviewedRecoveryCatalog } from "./versioned-catalog";
import { portableBusinessManifestV24 } from "../../shared/contracts/export-portable-runtime";
import { openSystemBackupSource } from "./backup-archive";
import { createSystemBackupArchiveStream, measureSystemBackupArchive } from "../../shared/domain/system-backup-archive";
import { sourceFromStream, openStoreArchiveEntry, type ArchiveSource, type ArchiveIndexEntry } from "../../shared/domain/research-archive";
import { readSourceMaintenance, recordSourceCheckpoint } from "./maintenance";
import { createRecoveryTargetEngine,createWorkerV5RecoveryTargetEngine,inspectRecoveryTargetFreshness,RecoveryTargetError,recoveryTargetRestoreBudget } from "./target-import";
import { recoverySourceProfileId } from "./target-files";
import { r2BootstrapNamespace } from "../files/r2-bootstrap-profile";

export function recoveryRepository(env:Env){return new SystemRecoveryRepository(env.DB);}
export function recoveryActorAllowed(env:Env,actor:string){return canAdministerSystemSettings(env,actor)&&Boolean(env.ACCESS_TEAM_DOMAIN&&env.ACCESS_AUD)&&allowedEmail(actor,env.ALLOWED_EMAILS);}
function targetConfigured(env:Env){return Boolean(env.RECOVERY_DB&&env.RECOVERY_DB!==env.DB&&env.RECOVERY_TARGET_ID);}
export async function freezeRecoveryArtifactNamespace(env:Env){
  const namespaceIdentity=r2BootstrapNamespace(env);if(!env.ASSETS||!["get","put","delete"].every(key=>typeof(env.ASSETS as unknown as Record<string,unknown>)[key]==="function"))throw new Error("artifact_namespace_unavailable");
  return{artifactNamespace:{bindingName:"ASSETS",namespaceIdentity,sha256:await sha256Hex(stableJson({bindingName:"ASSETS",namespaceIdentity}))}};
}
export async function assertRecoveryArtifactNamespace(env:Env,job:RecoveryJob){
  const frozen=job.checkpoint_json?JSON.parse(job.checkpoint_json) as {artifactNamespace?:unknown}:null,current=await freezeRecoveryArtifactNamespace(env);
  if(!frozen?.artifactNamespace||stableJson(frozen.artifactNamespace)!==stableJson(current.artifactNamespace))throw new Error("artifact_namespace_changed");
}
async function assertPrivateKeyNamespace(env:Env,key:string){const matched=/^fp5-system\/([A-Za-z0-9-]+)\/([A-Za-z0-9-]+)$/.exec(key);
  if(!matched)throw new Error("artifact_namespace_changed");const job=await recoveryRepository(env).job(matched[1]);if(!job)throw new Error("artifact_namespace_changed");await assertRecoveryArtifactNamespace(env,job);return job;
}
export async function systemRecoveryCapabilities(env:Env,actor:string):Promise<SystemRecoveryCapabilities>{
  const canManage=recoveryActorAllowed(env,actor),base={supported:false,canManage,enabled:false,stale:true,lastHeartbeatAt:null,cadenceSeconds:120 as const,maxStepMs:60000 as const,reason:canManage?"schema_unavailable":"administrator_required",
    target:{configured:false,id:null,mode:"fresh" as const},maintenance:{state:"open" as const,checkpoint:null},
    policy:{recoveryMapping:"explicit-profile" as const,backupMaintenance:"planned-only" as const,maintenanceWithoutTarget:false,recoveryCleanup:true,sourceResume:false}};
  if(!canManage)return base;const repository=recoveryRepository(env);if(!await repository.installed())return base;
  const runtime=await repository.runtime(),maintenance=await readSourceMaintenance(env);
  let artifactAvailable=true;try{await freezeRecoveryArtifactNamespace(env);}catch{artifactAvailable=false;}
  return{...base,supported:true,enabled:runtime?.enabled===1,stale:!runtime?.last_heartbeat_at||Date.now()-Date.parse(runtime.last_heartbeat_at)>5*60_000,
    lastHeartbeatAt:runtime?.last_heartbeat_at??null,reason:!artifactAvailable?"artifact_namespace_unavailable":runtime?.enabled===1?null:"executor_disabled",
    target:{configured:targetConfigured(env),id:targetConfigured(env)?env.RECOVERY_TARGET_ID!:null,mode:"fresh"},maintenance:{state:maintenance.state,checkpoint:maintenance.checkpoint}};
}
export async function systemRecoveryJobStatus(env:Env,job:RecoveryJob):Promise<SystemRecoveryJobStatus>{
  let namespaceAvailable=false;try{await assertRecoveryArtifactNamespace(env,job);namespaceAvailable=true;}catch{/* A changed private binding never reinterprets the old key. */}
  const available=Boolean(namespaceAvailable&&job.artifact_key&&job.state==="completed"&&job.expires_at&&Date.parse(job.expires_at)>Date.now()
    &&(await recoveryRepository(env).attempts(job.id)).some(attempt=>attempt.state==="verified"&&attempt.object_key===job.artifact_key));
  return{id:job.id,requestId:job.request_id,kind:job.kind,state:job.state,phase:job.phase,acceptedAt:job.accepted_at,updatedAt:job.updated_at,reason:job.reason,
    progress:{completedFiles:job.completed_files,totalFiles:job.total_files,bytesDone:job.bytes_done,bytesTotal:job.bytes_total},
    output:job.archive_byte_size&&job.archive_sha256&&job.expires_at?{available,byteSize:job.archive_byte_size,sha256:job.archive_sha256,expiresAt:job.expires_at}:null,
    result:job.result_json?JSON.parse(job.result_json):null};
}
async function records(repository:SystemRecoveryRepository,jobId:string){const value=await repository.metadata(jobId,"records");if(!value)throw new Error("archive_invalid");const records=value as WorkerRecoveryRecords;selectReviewedRecoveryCatalog(records);return records;}
async function manifest(repository:SystemRecoveryRepository,jobId:string){const value=await repository.metadata(jobId,"manifest");if(!value)throw new Error("archive_invalid");const manifest=value as WorkerRecoveryManifest;if(!["system-backup/1","system-backup/2","system-backup/3","system-backup/5"].includes(manifest.schema))throw new Error("archive_invalid");return manifest;}
async function terminalFiles(repository:SystemRecoveryRepository,jobId:string){return(await repository.files(jobId)).map(row=>JSON.parse(row.file_json) as WorkerRecoveryFile);}
function groupFileStatements(repository:SystemRecoveryRepository,claim:RecoveryClaim,sources:readonly WorkerRecoverySource[]){
  const db=repository.db(),groups:Array<Array<{id:string;ordinal:number;json:string}>>=[];let group:Array<{id:string;ordinal:number;json:string}>=[];
  sources.forEach((source,ordinal)=>{const row={id:source.id,ordinal,json:stableJson(source)};
    if(new TextEncoder().encode(row.json).byteLength>65536)throw new SystemRecoveryConflict("metadata_budget");
    if(new TextEncoder().encode(stableJson([...group,row])).byteLength>83*1024&&group.length){groups.push(group);group=[];}
    group.push(row);if(new TextEncoder().encode(stableJson(group)).byteLength>83*1024)throw new SystemRecoveryConflict("metadata_budget");});if(group.length)groups.push(group);
  return groups.map(rows=>db.prepare(`INSERT INTO system_recovery_files(job_id,id,ordinal,outcome,file_json)
    SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.ordinal'),'pending',json_extract(value,'$.json') FROM json_each(?)`)
    .bind(claim.id,stableJson(rows)));
}
async function measureSource(env:Env,source:WorkerRecoverySource,current:()=>Promise<boolean>,signal:AbortSignal,claim:RecoveryClaim,installationId:string,v5:boolean,owner:SystemRecoveryCapabilitiesAdapter,deadlineAt?:string):Promise<WorkerRecoveryFile>{
  const unavailable=(outcome:SystemBackupFile["outcome"]):WorkerRecoveryFile=>({...source,path:null,outcome,byteSize:null,sha256:null});
  let read;try{read=await openClaimedBackupSource(env,source,claim,installationId,current,signal,v5,owner,deadlineAt);}catch{if(signal.aborted||!await current())throw new Error("administrator_revoked");return unavailable("download_failed");}
  if(read.outcome!=="available")return unavailable(read.outcome);
  const hash=cloudflareSha256(),reader=read.body.getReader();let size=0,complete=false;
  try{while(true){const next=await reader.read();if(next.done){complete=true;break;}size+=next.value.byteLength;
      if(size>96*1024*1024)throw new Error("archive_budget");if(!await current())throw new Error("administrator_revoked");
      for(let offset=0;offset<next.value.byteLength;offset+=65536)await hash.write(next.value.subarray(offset,offset+65536));}
    const sha256=await hash.finish();if(read.expected.byteSize!==null&&read.expected.byteSize!==size)return unavailable("size_mismatch");
    if(read.expected.sha256!==null&&read.expected.sha256.toLowerCase()!==sha256)return unavailable("hash_mismatch");
    return{...source,path:`files/${source.id}`,outcome:"packaged",byteSize:size,sha256};
  }catch(error){if(signal.aborted||!await current())throw error;if(error instanceof Error&&error.message==="archive_budget")throw error;return unavailable("download_failed");}
  finally{if(!complete){if(read.dispose)await reader.cancel();else void reader.cancel().catch(()=>undefined);}reader.releaseLock();await hash.abort();await read.dispose?.();}
}
interface PlannedArchiveOriginalOwnership { owner:SystemRecoveryCapabilitiesAdapter;claim:RecoveryClaim;deadlineAt:string;signal:AbortSignal }
export async function recoveryArchiveSource(env:Env,job:RecoveryJob,current:()=>Promise<boolean>,signal?:AbortSignal,
  original?:PlannedArchiveOriginalOwnership):Promise<ArchiveSource>{
  const originalBinding=env.DB;
  function localOriginal(){if(original&&(env.DB!==originalBinding||original.signal.aborted||!Number.isFinite(Date.parse(original.deadlineAt))||Date.now()>=Date.parse(original.deadlineAt)
    ||!recoveryActorAllowed(env,original.claim.actor)))throw new Error("administrator_revoked");}
  await assertRecoveryArtifactNamespace(env,job);
  const held=Boolean(await recoveryRepository(env).db().prepare("SELECT 1 FROM system_recovery_jobs WHERE source_upload_job_id=? AND state IN('queued','running','paused')").bind(job.id).first());
  if(!job.artifact_key||!job.archive_byte_size||!job.archive_sha256||!job.expires_at||Date.parse(job.expires_at)<=Date.now()&&!held)throw new Error("archive_invalid");
  const attempt=(await recoveryRepository(env).attempts(job.id)).find(row=>row.object_key===job.artifact_key&&row.state==="verified");if(!attempt)throw new Error("archive_invalid");
  async function openArchive(reopenSignal?:AbortSignal,range?:{offset:number;length:number}) {
    if(signal?.aborted||reopenSignal?.aborted||!await current())throw new Error("administrator_revoked");
    await assertRecoveryArtifactNamespace(env,job);
    if(signal?.aborted||reopenSignal?.aborted||!await current()||!recoveryActorAllowed(env,job.actor))throw new Error("administrator_revoked");
    const intent=original?await beginWorkerV5SourceCloseIntent(original.owner,original.claim,"body",
      stableJson({uploadId:job.id,key:job.artifact_key,sha256:job.archive_sha256}),current,original.signal,original.deadlineAt):undefined;
    if(original){if(!await current())throw new Error("administrator_revoked");localOriginal();}
    if(intent)assertWorkerV5OriginalSourceIntentIssue(intent);
    const object=range?await env.ASSETS.get(job.artifact_key!,{range}):await env.ASSETS.get(job.artifact_key!);
    if(!object)throw new Error("source_unavailable");
    // Retain the actual body before any later validation/guard await. Invalid
    // ranged metadata must close this SAME original body, never a replacement.
    let body=object.body;
    if(intent){
      const stream=ownWorkerV5SourceStream(body,async()=>{localOriginal();if(!await current())throw new Error("administrator_revoked");localOriginal();});
      ownWorkerV5OriginalSourceBody(intent,stream);body=stream.body;
    }
    try {
      if(range&&(object.size!==job.archive_byte_size||!object.range||!("offset" in object.range)||!("length" in object.range)
        ||object.range.offset!==range.offset||object.range.length!==range.length))throw new Error("archive_range_invalid");
      if(signal?.aborted||reopenSignal?.aborted||!await current()||!recoveryActorAllowed(env,job.actor))throw new Error("administrator_revoked");
      await assertRecoveryArtifactNamespace(env,job);
      return body;
    } catch(error) {await body.cancel();throw error;}
  }
  return sourceFromStream(job.archive_byte_size,reopenSignal=>openArchive(reopenSignal),
    (offset,length,reopenSignal)=>openArchive(reopenSignal,{offset,length}));
}
async function openFrozenPayload(env:Env,upload:RecoveryJob,file:WorkerRecoveryFile,current:()=>Promise<boolean>,signal:AbortSignal,original?:PlannedArchiveOriginalOwnership){
  const repository=recoveryRepository(env),index=await repository.metadata(upload.id,"index") as ArchiveIndexEntry[]|null;
  const entry=index?.find(row=>row.path===file.path);if(!entry||entry.sha256!==file.sha256||entry.byteSize!==file.byteSize)throw new Error("archive_invalid");
  const source=await recoveryArchiveSource(env,upload,current,signal,original);return openStoreArchiveEntry(source,entry,{signal,createHash:cloudflareSha256});
}
export async function workerSystemRecoveryCapabilities(env:Env):Promise<SystemRecoveryCapabilitiesAdapter|null>{
  const repository=recoveryRepository(env);if(!await repository.installed())return null;const runtime=await repository.runtime();if(!runtime||runtime.enabled!==1)return null;
  try{await freezeRecoveryArtifactNamespace(env);}catch{return null;}
  const originalSourceBinding=env.DB;
  const sourceInstallationId=runtime.installation_id;
  const capabilities:SystemRecoveryCapabilitiesAdapter={repository,incarnation:runtime.incarnation,authorizeActor:actor=>recoveryActorAllowed(env,actor),now:()=>new Date(),randomId:()=>crypto.randomUUID(),hash:cloudflareSha256,
    async put(key,body,byteSize,deadlineAt,signal,issuedClaim){const originalJob=await assertPrivateKeyNamespace(env,key);
      // The SAME current kernel claim owns this issue, including readback of
      // an older UNKNOWN artifact attempt. Do not compare its old attempt token.
      if(deadlineAt!==undefined&&(!issuedClaim||issuedClaim.id!==originalJob.id||issuedClaim.actor!==originalJob.actor||!await repository.current(issuedClaim)))throw new Error("administrator_revoked");
      if(deadlineAt!==undefined&&(!Number.isFinite(Date.parse(deadlineAt))||Date.now()>=Date.parse(deadlineAt)||signal?.aborted||env.DB!==originalSourceBinding))throw new Error("execution_budget_exhausted");
      if(deadlineAt!==undefined&&!recoveryActorAllowed(env,originalJob.actor))throw new Error("administrator_revoked");
      let durablePut:WorkerV5SourceCloseIntent|undefined;
      if(originalJob.kind==="backup"&&deadlineAt!==undefined&&issuedClaim!==undefined&&(await records(repository,originalJob.id)).schema==="system-backup-records/5"){
        if(!issuedClaim||!signal||typeof deadlineAt!=="string")throw new Error("execution_budget_exhausted");
        durablePut=await beginWorkerV5SourceCloseIntent(capabilities,issuedClaim,"put",JSON.parse(originalJob.input_json).mode==="planned"?stableJson({key,byteSize}):key,()=>repository.current(issuedClaim),signal,deadlineAt);
      }
      if(deadlineAt!==undefined&&(!issuedClaim||!await repository.current(issuedClaim)))throw new Error("administrator_revoked");
      if(deadlineAt!==undefined&&(!Number.isFinite(Date.parse(deadlineAt))||Date.now()>=Date.parse(deadlineAt)||signal?.aborted||env.DB!==originalSourceBinding))throw new Error("execution_budget_exhausted");
      if(deadlineAt!==undefined&&!recoveryActorAllowed(env,originalJob.actor))throw new Error("administrator_revoked");
      const {FixedLengthStream}=globalThis as typeof globalThis&{FixedLengthStream:new(length:number)=>{readable:ReadableStream<Uint8Array>;writable:WritableStream<Uint8Array>}};
      const fixed=new FixedLengthStream(byteSize),pipe=body.pipeTo(fixed.writable);void pipe.catch(()=>undefined);
      try{if(deadlineAt!==undefined&&(!Number.isFinite(Date.parse(deadlineAt))||Date.now()>=Date.parse(deadlineAt)||signal?.aborted||env.DB!==originalSourceBinding))throw new Error("execution_budget_exhausted");
      if(deadlineAt!==undefined&&!recoveryActorAllowed(env,originalJob.actor))throw new Error("administrator_revoked");
        await env.ASSETS.put(key,fixed.readable,{httpMetadata:{contentType:"application/zip"}});await pipe;if(durablePut)acknowledgeWorkerV5OriginalNativeSource(durablePut);}catch(error){void fixed.readable.cancel().catch(()=>undefined);throw error;}},
    async read(key,deadlineAt,signal,issuedClaim){const originalJob=await assertPrivateKeyNamespace(env,key);
      if(deadlineAt!==undefined&&(!issuedClaim||issuedClaim.id!==originalJob.id||issuedClaim.actor!==originalJob.actor||!await repository.current(issuedClaim)))throw new Error("administrator_revoked");
      if(deadlineAt!==undefined&&(!Number.isFinite(Date.parse(deadlineAt))||Date.now()>=Date.parse(deadlineAt)||signal?.aborted||env.DB!==originalSourceBinding))throw new Error("execution_budget_exhausted");
      if(deadlineAt!==undefined&&!recoveryActorAllowed(env,originalJob.actor))throw new Error("administrator_revoked");
      let durableRead:WorkerV5SourceCloseIntent|undefined;
      if(originalJob.kind==="backup"&&deadlineAt!==undefined&&issuedClaim!==undefined&&(await records(repository,originalJob.id)).schema==="system-backup-records/5"){
        if(!issuedClaim||!signal||typeof deadlineAt!=="string")throw new Error("execution_budget_exhausted");
        durableRead=await beginWorkerV5SourceCloseIntent(capabilities,issuedClaim,"body",key,()=>repository.current(issuedClaim),signal,deadlineAt);
      }
      if(deadlineAt!==undefined&&(!issuedClaim||!await repository.current(issuedClaim)))throw new Error("administrator_revoked");
      if(deadlineAt!==undefined&&(!Number.isFinite(Date.parse(deadlineAt))||Date.now()>=Date.parse(deadlineAt)||signal?.aborted||env.DB!==originalSourceBinding))throw new Error("execution_budget_exhausted");
      if(deadlineAt!==undefined&&!recoveryActorAllowed(env,originalJob.actor))throw new Error("administrator_revoked");
      const object=await env.ASSETS.get(key);if(!object)return null;if(!durableRead)return object.body;
      const actualClaim=issuedClaim,actualSignal=signal,actualDeadline=deadlineAt;
      if(!actualClaim||!actualSignal||typeof actualDeadline!=="string")throw new Error("execution_budget_exhausted");
      const stream=ownWorkerV5SourceStream(object.body,async()=>{
        if(actualSignal.aborted||Date.now()>=Date.parse(actualDeadline)||env.DB!==originalSourceBinding||!recoveryActorAllowed(env,originalJob.actor)
          ||!await repository.current(actualClaim)||actualSignal.aborted||Date.now()>=Date.parse(actualDeadline)||!recoveryActorAllowed(env,originalJob.actor))throw new Error("administrator_revoked");
      });ownWorkerV5OriginalSourceBody(durableRead,stream);return stream.body;},
    async exportBody(claim,current,signal,deadlineAt){const frozen=await records(repository,claim.id);
      const files=await terminalFiles(repository,claim.id),metadata=await prepareWorkerSystemBackupArchive(frozen,files);
      return createSystemBackupArchiveStream(metadata,async entry=>{const file=files.find(row=>row.path===entry.path);if(!file)throw new Error("archive_invalid");
        const read=await openClaimedBackupSource(env,file,claim,sourceInstallationId,current,signal,frozen.schema==="system-backup-records/5",capabilities,deadlineAt);if(read.outcome!=="available")throw new Error("source_unavailable");return read.body;},{signal,createHash:cloudflareSha256});},
    async step(claim,current,signal,deadlineAt){
      if(claim.kind!=="recovery")await assertRecoveryArtifactNamespace(env,claim);
      if(env.DB!==originalSourceBinding)throw new Error("archive_invalid");
      const db=repository.db();
      if(claim.kind==="backup"&&claim.phase==="snapshot"){
        const input=JSON.parse(claim.input_json) as {mode:"historical"|"planned"};
        if(input.mode==="planned"){const status=await readSourceMaintenance(env);if(status.state!=="fenced"||status.activeWriters)throw new Error("source_maintenance_required");}
        const v5=Boolean(await db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='collaboration_control'").first())
          &&Boolean(await db.prepare("SELECT 1 FROM collaboration_control WHERE singleton=1 AND schema_version=2").first());
        if(v5&&typeof deadlineAt!=="string")throw new Error("execution_budget_exhausted");
        let snapshotIntent:WorkerV5SourceCloseIntent|undefined;
        if(v5){if(typeof deadlineAt!=="string")throw new Error("execution_budget_exhausted");
          snapshotIntent=await beginWorkerV5SourceCloseIntent(capabilities,claim,"snapshot",stableJson({backupId:claim.id,installationId:sourceInstallationId}),current,signal,deadlineAt);}
        const frozen=v5?await captureWorkerV5PublicSnapshot(env,claim,sourceInstallationId,current,signal,deadlineAt)
          :await captureVersionedSystemBackupSnapshot(env.DB,{backupId:claim.id,createdAt:claim.accepted_at});
        if(snapshotIntent)acknowledgeWorkerV5OriginalNativeSource(snapshotIntent);if(!await current())throw new Error("administrator_revoked");
        const checkpoint=frozen.schema==="system-backup-records/5"?await sourceBackupCheckpointV5(frozen):await sourceVersionedBackupCheckpoint(frozen);
        if(input.mode==="planned"){
          if(frozen.schema==="system-backup-records/5"){
            if(typeof deadlineAt!=="string"||!await current())throw new Error("administrator_revoked");
            await recordWorkerV5PlannedSourceCheckpoint(env,claim,checkpoint,signal,deadlineAt);
          }else await recordSourceCheckpoint(env,claim.id,checkpoint);
        }
        const sources=frozen.schema==="system-backup-records/5"?planSystemBackupSourcesV28(frozen.content):frozen.content.schemaVersion===26?planSystemBackupSourcesV26(frozen.content):planSystemBackupSources(frozen.content.schemaVersion===25?portableBusinessManifestV24(frozen.content):frozen.content),statements=[...repository.metadataStatements(claim.id,"records",frozen),...groupFileStatements(repository,claim,sources)];
        if(statements.length+2>128)throw new SystemRecoveryConflict("metadata_budget");
        return{patch:{state:"queued",phase:"inventory",source_checkpoint:checkpoint,total_files:sources.length},statements,outcome:"snapshot"};
      }
      if(claim.kind==="backup"&&claim.phase==="inventory"){
        const all=await repository.files(claim.id),pending=all.find(row=>row.outcome==="pending");
        if(!pending)return{patch:{state:"queued",phase:"measure"},outcome:"inventoried"};
        const frozen=await records(repository,claim.id);
        const source=JSON.parse(pending.file_json) as WorkerRecoverySource,
          file=await measureSource(env,source,current,signal,claim,sourceInstallationId,frozen.schema==="system-backup-records/5",capabilities,deadlineAt);
        const packaged=all.filter(row=>row.outcome==="packaged").reduce((sum,row)=>sum+((JSON.parse(row.file_json) as WorkerRecoveryFile).byteSize??0),0)+(file.byteSize??0);
        if(packaged>96*1024*1024)throw new Error("archive_budget");
        return{patch:{state:"queued",phase:all.filter(row=>row.outcome==="pending").length===1?"measure":"inventory",completed_files:claim.completed_files+1,bytes_total:packaged},
          statements:[db.prepare("UPDATE system_recovery_files SET outcome=?,file_json=? WHERE job_id=? AND id=? AND outcome='pending'").bind(file.outcome,stableJson(file),claim.id,file.id)],outcome:"source_measured"};
      }
      if(claim.kind==="backup"&&claim.phase==="measure"){
        const frozen=await records(repository,claim.id);
      const files=await terminalFiles(repository,claim.id),metadata=await prepareWorkerSystemBackupArchive(frozen,files);
        const measured=await measureSystemBackupArchive(metadata,async entry=>{const file=files.find(row=>row.path===entry.path);if(!file)throw new Error("archive_invalid");const read=await openClaimedBackupSource(env,file,claim,sourceInstallationId,current,signal,frozen.schema==="system-backup-records/5",capabilities,deadlineAt);
          if(read.outcome!=="available")throw new Error("source_unavailable");return read.body;},{signal,createHash:cloudflareSha256});
        return{patch:{state:"queued",phase:"write",archive_byte_size:measured.byteSize,archive_sha256:measured.sha256},
          statements:[...repository.metadataStatements(claim.id,"manifest",metadata.manifest),...repository.metadataStatements(claim.id,"index",measured.entries)],outcome:"measured"};
      }
      if(claim.kind==="upload"&&claim.phase==="validate"){
        const source=await recoveryArchiveSource(env,claim,current,signal);
        try{
          const prefix=await source.read(0,Math.min(512,source.byteSize),signal);
          if(prefix.byteLength>=30&&new DataView(prefix.buffer,prefix.byteOffset,prefix.byteLength).getUint32(0,true)===0x04034b50){
            const length=new DataView(prefix.buffer,prefix.byteOffset,prefix.byteLength).getUint16(26,true);
            if(length<=prefix.byteLength-30){const path=new TextDecoder("utf-8",{fatal:true}).decode(prefix.subarray(30,30+length));
              if(path==="export-manifest.json"||/^tables\/[a-z_]+\.json$/.test(path)||path==="tables/")throw new Error("legacy_requires_conversion");}
          }
          const validated=await validateWorkerSystemBackupArchive(source,{expectedSha256:claim.archive_sha256!,signal,createHash:cloudflareSha256});
          const statements=[...repository.metadataStatements(claim.id,"records",validated.records),...repository.metadataStatements(claim.id,"manifest",validated.manifest),...repository.metadataStatements(claim.id,"index",validated.entries)];
          if(statements.length+2>128)throw new SystemRecoveryConflict("metadata_budget");
          return{patch:{state:"preview",phase:"done",total_files:validated.manifest.files.length,completed_files:validated.manifest.counts.packagedFiles,bytes_total:validated.manifest.counts.bytes,bytes_done:validated.manifest.counts.bytes},statements,outcome:"preview"};
        }finally{await source.dispose?.();}
      }
      if(claim.kind==="recovery"){
        const input=JSON.parse(claim.input_json) as SystemRecoveryImportInput,upload=await repository.job(claim.source_upload_job_id!);
        if(!upload||upload.actor!==claim.actor||upload.state!=="preview")throw new Error("archive_invalid");
        await assertRecoveryArtifactNamespace(env,upload);
        const frozen=await records(repository,upload.id);
        const backup=await manifest(repository,upload.id);if(backup.completeness!=="complete")throw new Error("partial_backup");
        let plannedOriginal:WorkerV5SourceCloseIntent|undefined,originalCurrent=current,originalArchive:PlannedArchiveOriginalOwnership|undefined;
        if(frozen.schema==="system-backup-records/5"&&input.mode==="planned"){
          if(backup.schema!=="system-backup/5"||typeof deadlineAt!=="string")throw new Error("archive_invalid");
          const plannedManifest=backup,plannedRecords=frozen;
          await assertWorkerV5PlannedSourceWindowCurrent(env,claim,plannedRecords,plannedManifest);
          originalCurrent=async()=>{if(!await current())return false;
            try{await assertWorkerV5PlannedSourceWindowCurrent(env,claim,plannedRecords,plannedManifest);}catch{return false;}
            return await current();};
          plannedOriginal=await beginWorkerV5SourceCloseIntent(capabilities,claim,"recovery-step",
            stableJson({jobId:claim.id,phase:claim.phase,sourceWindow:claim.checkpoint_json}),originalCurrent,signal,deadlineAt);
          originalArchive={owner:capabilities,claim,deadlineAt,signal};
        }
        if(!claim.target_incarnation){const incarnation=crypto.randomUUID().replaceAll("-","");
          if(plannedOriginal)acknowledgeWorkerV5OriginalNativeSource(plannedOriginal);
          return{patch:{state:"queued",target_incarnation:incarnation},
            statements:originalArchive?workerV5PlannedSourceFinishGuards(env,claim,signal,originalArchive.deadlineAt):[],outcome:"target_identity_frozen"};}
        const shared={jobId:claim.id,incarnation:claim.target_incarnation,ownerToken:claim.owner_token,generation:claim.generation,
          expectedTargetId:input.expectedTargetId,mapping:input.mapping,mode:input.mode,current:originalCurrent,signal,deadlineAt,runtimeIncarnation:claim.runtime_incarnation,leaseExpiresAt:claim.lease_expires_at,
          openPayload:(file:WorkerRecoveryFile,payloadSignal:AbortSignal)=>openFrozenPayload(env,upload,file,originalCurrent,payloadSignal,originalArchive)};
        let result;
        if(frozen.schema==="system-backup-records/5"){
          if(backup.schema!=="system-backup/5")throw new Error("archive_invalid");
          const originalTargetInput={...shared,records:frozen,manifest:backup};
          if(originalArchive)bindWorkerV5PlannedOriginalTargetInput(capabilities,env,originalTargetInput,claim,originalCurrent,signal,originalArchive.deadlineAt);
          result=await createWorkerV5RecoveryTargetEngine(env).step(originalTargetInput);
        }else{
          if(backup.schema==="system-backup/5")throw new Error("archive_invalid");
          result=await createRecoveryTargetEngine(env).step({...shared,records:frozen,manifest:backup});
        }
        if(plannedOriginal)acknowledgeWorkerV5OriginalNativeSource(plannedOriginal);
        return{patch:{state:result.done?"completed":"queued",phase:result.phase,completed_files:Math.min(result.completedFiles,claim.total_files),bytes_done:Math.min(result.bytesDone,claim.bytes_total),
          ...(result.done&&result.report?{result_json:stableJson({targetId:input.expectedTargetId,ready:true,cutover:false,checkpoint:result.report.targetCheckpoint})}: {})},
          statements:[...(originalArchive?workerV5PlannedSourceFinishGuards(env,claim,signal,originalArchive.deadlineAt):[]),
            ...(result.report?repository.metadataStatements(claim.id,"report",result.report):[])],outcome:result.done?"ready":"recovery_step"};
      }
      throw new Error("archive_invalid");
    }};
  registerWorkerRecoveryExecutionOwner(capabilities);
  registerWorkerV5SourceCloseOwner(capabilities,env,sourceInstallationId);
  return capabilities;
}
export async function dispatchSystemRecoveryJobs(env:Env){const capabilities=await workerSystemRecoveryCapabilities(env);if(!capabilities)return{jobId:null,outcome:"disabled"};
  await capabilities.repository.db().prepare("UPDATE system_recovery_runtime SET last_heartbeat_at=? WHERE singleton=1 AND enabled=1 AND incarnation=?").bind(new Date().toISOString(),capabilities.incarnation).run();
  try{return await runSystemRecoveryJobStep(capabilities);}finally{await closeWorkerV5RecoveryExecutions(capabilities);}
}
export async function systemRecoveryPreview(env:Env,job:RecoveryJob):Promise<SystemRecoveryPreview>{
  const repository=recoveryRepository(env),sourceId=job.kind==="recovery"?job.source_upload_job_id!:job.id,frozen=await records(repository,sourceId),backup=await manifest(repository,sourceId),source=await repository.job(sourceId);
  if(!source?.archive_byte_size||!source.archive_sha256)throw new Error("archive_invalid");
  const profiles=[...new Set(backup.files.map(recoverySourceProfileId))].map(id=>{const file=backup.files.find(row=>recoverySourceProfileId(row)===id)!;
    const p=frozen.content.tables.storage_profiles.find(row=>row.id===id);return{id,adapterType:String(p?.adapter_type??file.source.provider),namespaceIdentity:String(p?.namespace_identity??id)};});
  const maintenance=await readSourceMaintenance(env),input=JSON.parse(job.input_json) as {mode?:"historical"|"planned"},complete=backup.completeness==="complete";
  const configured=targetConfigured(env);let targetAvailable=configured,targetReason:string|null=configured?null:"target_unavailable";
  if(configured&&job.kind!=="recovery")try{await inspectRecoveryTargetFreshness(env,env.RECOVERY_TARGET_ID!,frozen);}catch(error){targetAvailable=false;targetReason=error instanceof RecoveryTargetError?error.code:"target_unavailable";}
  if(job.kind==="recovery"&&job.state!=="completed"){targetAvailable=false;targetReason="target_recovery_pending";}
  if(job.kind==="recovery"&&job.target_id!==env.RECOVERY_TARGET_ID){targetAvailable=false;targetReason="target_configuration_changed";}
  const expired=job.kind==="upload"&&(!job.expires_at||Date.parse(job.expires_at)<=Date.now());
  let archiveAvailable=true;try{await assertRecoveryArtifactNamespace(env,source);}catch{archiveAvailable=false;}
  const restoreBudget=recoveryTargetRestoreBudget(frozen);
  const reason=!complete?"partial_backup":expired?"upload_expired":!archiveAvailable?"artifact_namespace_changed":!restoreBudget.available?restoreBudget.reason:!targetAvailable?targetReason??"target_recovery_pending":null;
  const paused=(frozen.content.tables.file_migration_jobs?.length??0)+(frozen.content.tables.research_package_jobs?.length??0);
  const snapshotClock=backup.sourceSnapshotClock.replace(" ","T"),recoveryPoint=new Date(/Z$|[+-]\d\d:\d\d$/.test(snapshotClock)?snapshotClock:`${snapshotClock}Z`).toISOString();
  return{schema:"system-recovery-preview/1",archive:{schema:backup.schema,byteSize:source.archive_byte_size,sha256:source.archive_sha256,complete,legacy:frozen.origin.format==="legacy-converted",recoveryPoint},
    counts:{tables:backup.counts.tables,rows:backup.counts.rows,files:backup.counts.sources,bytes:backup.counts.bytes,availableFiles:backup.counts.packagedFiles,unavailableFiles:backup.counts.unavailableFiles},
    files:backup.files.map(file=>({id:file.id,purpose:file.purposes.join(",")||"unknown",byteSize:file.byteSize??file.source.expectedByteSize??0,status:file.outcome,reason:file.outcome==="packaged"?null:file.outcome,sourceProfileId:recoverySourceProfileId(file)})),profiles,
    protectedSettings:{included:frozen.protectedConfiguration.status==="included_encrypted",credentialRecovery:frozen.protectedConfiguration.status==="included_encrypted"?"quarantined":"excluded",warnings:[...(frozen.protectedConfiguration.keyIds.length?["separate_root_keys_required"]:[]),...(["system-backup-records/2","system-backup-records/3","system-backup-records/5"].includes(frozen.schema)?["protected_local_accounts_disabled_offline_bootstrap_required"]:[]),...((frozen.schema==="system-backup-records/3"||frozen.schema==="system-backup-records/5")&&frozen.content.tables.storage_profiles.some(profile=>profile.adapter_type==="local")?["local_profiles_require_fresh_destination_binding"]:[])]},
    oldJobs:{paused,automaticReplay:false},target:{id:configured?env.RECOVERY_TARGET_ID!:null,available:targetAvailable,reason:targetReason},
    source:{maintenanceRequired:true,checkpoint:job.source_checkpoint??maintenance.checkpoint,mode:input.mode??"historical"},canRecover:complete&&!expired&&archiveAvailable&&restoreBudget.available&&targetAvailable&&job.kind!=="recovery",canCutover:frozen.schema!=="system-backup-records/5"&&complete&&targetAvailable&&Boolean(job.result_json)&&maintenance.state==="fenced"&&maintenance.activeWriters===0,reasons:reason?[reason]:[]};
}


function originalSource(source:WorkerRecoverySource):source is SystemBackupSource{return source.source.provider!=="local";}
async function openClaimedBackupSource(env:Env,source:WorkerRecoverySource,claim:RecoveryClaim,installationId:string,
  current:()=>Promise<boolean>,signal:AbortSignal,v5:boolean,owner:SystemRecoveryCapabilitiesAdapter,deadlineAt?:string){
  if(v5){if(typeof deadlineAt!=="string")throw new Error("execution_budget_exhausted");
    const intent=await beginWorkerV5SourceCloseIntent(owner,claim,"body",stableJson(source.source),current,signal,deadlineAt);
    return openWorkerV5BackupSource(env,source,claim,installationId,current,signal,dispose=>ownWorkerRecoveryBodyClose(owner,dispose),deadlineAt,intent);}
  if(!originalSource(source))throw new Error("archive_invalid");
  return openSystemBackupSource(env,source,current,signal,claim.id);
}

/** After the original bounded result, join the exact retained V5 work and first
 * body/provider close. This never retries cleanup or releases durable holds. */
export async function closeWorkerV5RecoveryExecutions(capabilities:SystemRecoveryCapabilitiesAdapter){
  // The format can become known only after a late metadata/ZIP operation. Join
  // this exact registered owner even then; no timeout or false marker is a body
  // close ACK. Historical format/actor/lease grants remain the original ones.
  await closeWorkerV5OriginalSourceOwner(capabilities);
}
