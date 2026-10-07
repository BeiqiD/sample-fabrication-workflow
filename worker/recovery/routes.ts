import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { assertSystemAdministrator } from "../storage/system-administrator";
import { checkedSystemRecoveryBackupInput, checkedSystemRecoveryUploadInput, checkedSystemRecoveryImportInput, checkedSystemRecoveryCutoverInput,
  checkedSystemRecoveryJobControl, checkedSystemRecoveryJobStatus, checkedSystemRecoveryCapabilities, checkedSystemRecoveryPreview,
  type SystemRecoveryBackupPreview, type SystemRecoveryReceipt, type SystemRecoveryPublicReport } from "../../shared/contracts/system-recovery";
import { recoveryRepository,recoveryActorAllowed,systemRecoveryCapabilities,systemRecoveryJobStatus,systemRecoveryPreview,workerSystemRecoveryCapabilities,freezeRecoveryArtifactNamespace,assertRecoveryArtifactNamespace } from "./service";
import { writeSystemRecoveryUpload, runBoundedSystemRecoveryReadAction } from "./jobs";
import type { RecoveryJob } from "./repository";
import { readSourceMaintenance, verifySourceCheckpoint } from "./maintenance";
import { recaptureSystemBackupSnapshot, sourceBackupCheckpoint } from "./backup-snapshot";
import type { SystemBackupRecordsV1, SystemBackupManifestV1 } from "../../shared/contracts/system-backup";
import { createRecoveryTargetEngine, recoveryTargetRestoreBudget } from "./target-import";
import { stableJson } from "../../shared/domain/content-addressing";
import type { SystemRecoveryReport } from "./report";

type ApiEnv={Bindings:Env;Variables:{userEmail:string}};
export const systemRecoveryRoutes=new Hono<ApiEnv>();
const fail=(message:string,status:400|403|404|409|413|503=409)=>new HTTPException(status,{message});
systemRecoveryRoutes.onError((error,c)=>error instanceof HTTPException?c.json({error:error.message},error.status)
  :c.json({error:"System recovery conflicts with its accepted state or an unavailable capability. Inspect the request receipt and refresh its preview."},409));
systemRecoveryRoutes.use("/system-recovery/*",async(c,next)=>{c.header("Cache-Control","private, no-store");
  if(!(c.req.method==="GET"&&c.req.path.endsWith("/system-recovery/capabilities"))){assertSystemAdministrator(c.env,c.get("userEmail"));if(!recoveryActorAllowed(c.env,c.get("userEmail")))throw fail("System administrator access is required.",403);}
  await next();});
async function json(request:Request){const reader=request.body?.getReader();if(!reader)throw fail("Recovery input is required",400);const chunks:Uint8Array[]=[];let length=0;
  try{while(true){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;if(length>65536){void reader.cancel().catch(()=>undefined);throw fail("Recovery request is too large",413);}chunks.push(next.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as unknown;}catch{throw fail("Invalid recovery JSON",400);}}
async function input<T>(request:Request,check:(value:unknown)=>T){try{return check(await json(request));}catch(error){if(error instanceof HTTPException)throw error;throw fail("Invalid recovery input",400);}}
async function owned(env:Env,id:string,actor:string){const job=await recoveryRepository(env).job(id);if(!job||job.actor!==actor)throw fail("Recovery job does not exist",404);return job;}
async function receipt(env:Env,requestId:string,accepted:{job:RecoveryJob;reused:boolean}):Promise<SystemRecoveryReceipt>{return{requestId,job:checkedSystemRecoveryJobStatus(await systemRecoveryJobStatus(env,accepted.job)),reused:accepted.reused};}
async function requireSchema(env:Env){if(!await recoveryRepository(env).installed())throw fail("System recovery schema is unavailable",503);}
const cleanupHoldReleaseAllowed=`NOT EXISTS(SELECT 1 FROM system_recovery_maintenance WHERE singleton=1 AND state='fenced' AND checkpoint_sha256 IS NOT NULL AND backup_job_id IS NOT ?)`;
function cleanupHoldReleaseGuard(repository:ReturnType<typeof recoveryRepository>,jobId:string){return repository.db().prepare(`SELECT CASE WHEN ${cleanupHoldReleaseAllowed} THEN 1 ELSE json('Source final checkpoint protects other backup holds') END`).bind(jobId);}

systemRecoveryRoutes.get("/system-recovery/capabilities",async c=>c.json(checkedSystemRecoveryCapabilities(await systemRecoveryCapabilities(c.env,c.get("userEmail")))));
systemRecoveryRoutes.post("/system-recovery/executor",async c=>{const value=await json(c.req.raw);if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).join()!=="enabled"||typeof(value as {enabled?:unknown}).enabled!=="boolean")throw fail("Invalid recovery executor configuration",400);
  await requireSchema(c.env);await recoveryRepository(c.env).configure((value as {enabled:boolean}).enabled);return c.json(checkedSystemRecoveryCapabilities(await systemRecoveryCapabilities(c.env,c.get("userEmail"))));});
systemRecoveryRoutes.get("/system-recovery/backup-preview",async c=>{const capability=await systemRecoveryCapabilities(c.env,c.get("userEmail"));
  const value:SystemRecoveryBackupPreview={schema:"system-backup-preview/1",available:capability.supported&&capability.enabled&&capability.reason===null,reasons:capability.reason?[capability.reason]:[],
    bounds:{archiveBytes:104857600,payloadBytes:100663296,metadataBytes:4194304,files:100,maxStepMs:60000},includesProtectedSettings:true,credentialsRequireKeyring:true,maintenance:capability.maintenance};return c.json(value);});
systemRecoveryRoutes.get("/system-recovery/jobs",async c=>{await requireSchema(c.env);const jobs=await recoveryRepository(c.env).list(c.get("userEmail"));return c.json({jobs:await Promise.all(jobs.map(job=>systemRecoveryJobStatus(c.env,job)))});});
systemRecoveryRoutes.post("/system-recovery/jobs",async c=>{const acceptedInput=await input(c.req.raw,checkedSystemRecoveryBackupInput),actor=c.get("userEmail"),repository=recoveryRepository(c.env);await requireSchema(c.env);
  const prior=await repository.request(acceptedInput.requestId,actor,acceptedInput);if(prior)return c.json(await receipt(c.env,acceptedInput.requestId,{job:prior,reused:true}),202);
  if(acceptedInput.mode==="planned"){const status=await readSourceMaintenance(c.env);if(status.state!=="fenced"||status.activeWriters)throw fail("A planned final backup requires drained source maintenance",409);}
  const checkpoint=await freezeRecoveryArtifactNamespace(c.env);
  const accepted=await repository.accept({id:crypto.randomUUID(),requestId:acceptedInput.requestId,actor,kind:"backup",input:acceptedInput,checkpoint},()=>recoveryActorAllowed(c.env,actor));
  return c.json(await receipt(c.env,acceptedInput.requestId,accepted),202);});
systemRecoveryRoutes.post("/system-recovery/uploads",async c=>{const acceptedInput=await input(c.req.raw,checkedSystemRecoveryUploadInput),actor=c.get("userEmail");await requireSchema(c.env);
  const repository=recoveryRepository(c.env),prior=await repository.request(acceptedInput.requestId,actor,acceptedInput);if(prior)return c.json(await receipt(c.env,acceptedInput.requestId,{job:prior,reused:true}),202);
  const checkpoint=await freezeRecoveryArtifactNamespace(c.env);
  const accepted=await repository.accept({id:crypto.randomUUID(),requestId:acceptedInput.requestId,actor,kind:"upload",input:acceptedInput,checkpoint},()=>recoveryActorAllowed(c.env,actor));
  return c.json(await receipt(c.env,acceptedInput.requestId,accepted),202);});
systemRecoveryRoutes.get("/system-recovery/requests/:requestId",async c=>{const actor=c.get("userEmail"),found=await recoveryRepository(c.env).request(c.req.param("requestId"),actor);if(!found)throw fail("Recovery request is not accepted",404);
  return c.json(await receipt(c.env,c.req.param("requestId"),{job:found,reused:true}));});
systemRecoveryRoutes.get("/system-recovery/jobs/:jobId",async c=>c.json(checkedSystemRecoveryJobStatus(await systemRecoveryJobStatus(c.env,await owned(c.env,c.req.param("jobId"),c.get("userEmail"))))));
systemRecoveryRoutes.get("/system-recovery/jobs/:jobId/upload-intent",async c=>{const job=await owned(c.env,c.req.param("jobId"),c.get("userEmail"));if(job.kind!=="upload")throw fail("Recovery job has no upload intent",404);return c.json(checkedSystemRecoveryUploadInput(JSON.parse(job.input_json)));});
systemRecoveryRoutes.put("/system-recovery/jobs/:jobId/upload",async c=>{const actor=c.get("userEmail"),job=await owned(c.env,c.req.param("jobId"),actor);if(job.kind!=="upload")throw fail("This is not a recovery upload",400);
  if(job.phase!=="write")return c.json(checkedSystemRecoveryJobStatus(await systemRecoveryJobStatus(c.env,job)));
  await assertRecoveryArtifactNamespace(c.env,job);
  const acceptedInput=checkedSystemRecoveryUploadInput(JSON.parse(job.input_json)),length=c.req.header("content-length");if(length!==undefined&&(!/^[1-9][0-9]*$/.test(length)||Number(length)!==acceptedInput.byteSize))throw fail("Upload size differs from accepted identity",400);
  if(!c.req.raw.body)throw fail("Recovery upload body is required",400);const capabilities=await workerSystemRecoveryCapabilities(c.env);if(!capabilities)throw fail("Recovery executor is disabled or unavailable",503);
  const claim=await capabilities.repository.claim(job.id,actor,capabilities.incarnation,crypto.randomUUID(),true);if(!claim)throw fail("Another attempt owns this recovery upload",409);
  await writeSystemRecoveryUpload(capabilities,claim,c.req.raw.body);return c.json(checkedSystemRecoveryJobStatus(await systemRecoveryJobStatus(c.env,(await capabilities.repository.job(job.id))!)));});
systemRecoveryRoutes.get("/system-recovery/jobs/:jobId/preview",async c=>{const job=await owned(c.env,c.req.param("jobId"),c.get("userEmail"));
  if(!(job.kind==="upload"&&job.state==="preview"||job.kind==="backup"&&job.state==="completed"||job.kind==="recovery"))throw fail("Recovery archive validation has not completed",409);
  return c.json(checkedSystemRecoveryPreview(await systemRecoveryPreview(c.env,job)));});
systemRecoveryRoutes.post("/system-recovery/recoveries",async c=>{const acceptedInput=await input(c.req.raw,checkedSystemRecoveryImportInput),actor=c.get("userEmail"),repository=recoveryRepository(c.env);await requireSchema(c.env);
  const prior=await repository.request(acceptedInput.requestId,actor,acceptedInput);if(prior)return c.json(await receipt(c.env,acceptedInput.requestId,{job:prior,reused:true}),202);
  const upload=await owned(c.env,acceptedInput.uploadJobId,actor);if(upload.kind!=="upload"||upload.state!=="preview")throw fail("Recovery upload has not been validated",409);
  await assertRecoveryArtifactNamespace(c.env,upload);
  const records=await repository.metadata(upload.id,"records") as SystemBackupRecordsV1|null,manifest=await repository.metadata(upload.id,"manifest") as SystemBackupManifestV1|null;
  if(!records||!manifest||manifest.completeness!=="complete")throw fail("A partial backup cannot prepare complete recovery",409);
  if(!recoveryTargetRestoreBudget(records).available)throw fail("Recovery image exceeds the website atomic restore budget; use an independently reviewed offline recovery path",409);
  if(acceptedInput.mode==="planned"){const source=await repository.job(records.backupId),maintenance=await readSourceMaintenance(c.env);
    if(source?.kind!=="backup"||source.state!=="completed"||source.source_checkpoint!==manifest.sourceCheckpoint||maintenance.state!=="fenced"||maintenance.backupJobId!==records.backupId||maintenance.checkpoint!==manifest.sourceCheckpoint)throw fail("Planned recovery requires the current final source checkpoint",409);}
  const id=crypto.randomUUID(),preview=await createRecoveryTargetEngine(c.env).preview({jobId:id,incarnation:id.replaceAll("-",""),expectedTargetId:acceptedInput.expectedTargetId,records,manifest,mapping:acceptedInput.mapping,mode:acceptedInput.mode});
  if(!preview.available)throw fail("Recovery target or storage mapping is unavailable",409);
  const accepted=await repository.accept({id,requestId:acceptedInput.requestId,actor,kind:"recovery",input:acceptedInput,sourceUploadJobId:upload.id,targetId:acceptedInput.expectedTargetId,
    sourceCheckpoint:manifest.sourceCheckpoint,totalFiles:manifest.files.length,bytesTotal:manifest.counts.bytes},()=>recoveryActorAllowed(c.env,actor));return c.json(await receipt(c.env,acceptedInput.requestId,accepted),202);});
systemRecoveryRoutes.post("/system-recovery/jobs/:jobId/control",async c=>{const action=await input(c.req.raw,checkedSystemRecoveryJobControl),actor=c.get("userEmail"),repository=recoveryRepository(c.env),job=await owned(c.env,c.req.param("jobId"),actor);
  if(action==="cleanup"){
    if(job.kind!=="recovery")await assertRecoveryArtifactNamespace(c.env,job);
    if(["queued","running","awaiting_upload"].includes(job.state))throw fail("Stop the recovery job before cleanup",409);
    if(await repository.db().prepare("SELECT 1 FROM system_recovery_jobs WHERE source_upload_job_id=? AND state IN('queued','running','paused')").bind(job.id).first())throw fail("An accepted recovery still holds this archive",409);
    const attempts=await repository.attempts(job.id);if(attempts.some(row=>["started","unknown","settled"].includes(row.state)))throw fail("Unknown recovery writes must remain held",409);
    const cleaned=await repository.db().prepare(`UPDATE system_recovery_jobs SET state=?,generation=generation+1,expires_at=?,updated_at=?
      WHERE id=? AND actor=? AND generation=? AND state NOT IN('queued','running','awaiting_upload')
      AND NOT EXISTS(SELECT 1 FROM system_recovery_jobs dependent WHERE dependent.source_upload_job_id=system_recovery_jobs.id AND dependent.state IN('queued','running','paused'))
      AND NOT EXISTS(SELECT 1 FROM system_recovery_attempts attempt WHERE attempt.job_id=system_recovery_jobs.id AND attempt.state IN('started','unknown','settled'))
      AND ${cleanupHoldReleaseAllowed} RETURNING id`)
      .bind(job.state==="completed"?"completed":"cancelled",new Date().toISOString(),new Date().toISOString(),job.id,actor,job.generation,job.id).first();
    if(!cleaned)throw fail("Recovery cleanup eligibility changed",409);
    for(const attempt of attempts.filter(row=>["verified","failed"].includes(row.state))){if(!recoveryActorAllowed(c.env,actor))throw fail("System administrator access is required.",403);
      await assertRecoveryArtifactNamespace(c.env,job);await cleanupHoldReleaseGuard(repository,job.id).first();if(!recoveryActorAllowed(c.env,actor))throw fail("System administrator access is required.",403);
      await c.env.ASSETS.delete(attempt.object_key);await repository.db().prepare("UPDATE system_recovery_attempts SET state='cleaned',cleaned_at=? WHERE id=? AND state IN('verified','failed')").bind(new Date().toISOString(),attempt.id).run();}
    if(!recoveryActorAllowed(c.env,actor))throw fail("System administrator access is required.",403);
    await repository.db().batch([cleanupHoldReleaseGuard(repository,job.id),repository.db().prepare("UPDATE system_recovery_legacy_holds SET released_at=? WHERE job_id=? AND released_at IS NULL").bind(new Date().toISOString(),job.id),
      repository.db().prepare("UPDATE file_location_holds SET released_at=? WHERE operation_id=? AND released_at IS NULL").bind(new Date().toISOString(),`fp5-backup:${job.id}`)]);
  }else await repository.control(job,action);
  return c.json(checkedSystemRecoveryJobStatus(await systemRecoveryJobStatus(c.env,(await repository.job(job.id))!)));});
systemRecoveryRoutes.get("/system-recovery/jobs/:jobId/download",async c=>{const job=await owned(c.env,c.req.param("jobId"),c.get("userEmail")),status=await systemRecoveryJobStatus(c.env,job);
  if(!status.output?.available||!job.artifact_key)throw fail("Recovery archive output is expired or unavailable",404);await assertRecoveryArtifactNamespace(c.env,job);const object=await c.env.ASSETS.get(job.artifact_key);if(!object)throw fail("Recovery archive output is unavailable",404);
  return new Response(object.body,{headers:{"Content-Type":"application/zip","Content-Disposition":`attachment; filename="system-backup-${job.id}.zip"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});});
systemRecoveryRoutes.get("/system-recovery/jobs/:jobId/report",async c=>{const job=await owned(c.env,c.req.param("jobId"),c.get("userEmail"));
  if(job.kind!=="recovery"||job.state!=="completed"||job.phase!=="ready")throw fail("Verified recovery report is unavailable",404);
  const report=await recoveryRepository(c.env).metadata(job.id,"report") as SystemRecoveryReport|null;if(!report)throw fail("Verified recovery report is unavailable",404);
  const changed=new Map<string,{table:string;column:string;reason:string;count:number}>();
  for(const difference of report.differences){const key=stableJson([difference.table,difference.column,difference.reason]),group=changed.get(key);
    if(group)group.count++;else changed.set(key,{table:difference.table,column:difference.column,reason:difference.reason,count:1});}
  const snapshot=report.recoveryPoint.replace(" ","T"),recoveryPoint=new Date(/Z$|[+-]\d\d:\d\d$/.test(snapshot)?snapshot:`${snapshot}Z`).toISOString();
  const publicReport:SystemRecoveryPublicReport={schema:"system-recovery-public-report/1",jobId:job.id,targetId:report.targetId,recoveryPoint,mode:report.mode,
    historicalLaterChangesLost:report.historicalLaterChangesLost,sourceImageSha256:report.sourceImageSha256,targetCheckpoint:report.targetCheckpoint,counts:report.counts,
    protectedSettings:{included:report.protectedSettings.included,policy:"quarantined",rootKeysIncluded:false,automaticExecution:false,freshConfigurationRequired:true},
    execution:{shadow:false,authority:false,fileJobs:false,recoveryJobs:false,cleanup:false,oldJobReplay:false},changes:[...changed.values()].sort((a,b)=>stableJson(a).localeCompare(stableJson(b))),
    handoff:{automaticBindingChange:false,operatorRequired:true,sourceRetainedReadOnly:true,rollback:"safe_before_target_writes_only",steps:[
      "Keep source writes fenced and all old background executors stopped.","Compare the operator-owned target identity and verified checkpoint.",
      "Review quarantined settings and supply destination root encryption keys independently.","The operator reviews and changes the deployment database binding.",
      "Verify authenticated reads before explicitly admitting new operational writes.","Retain the old source read-only; rollback ends after new operational writes begin on the destination."]}};
  return new Response(stableJson(publicReport),{headers:{"Content-Type":"application/json","Content-Disposition":`attachment; filename="system-recovery-report-${job.id}.json"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});});
systemRecoveryRoutes.post("/system-recovery/jobs/:jobId/cutover",async c=>{const acceptedInput=await input(c.req.raw,checkedSystemRecoveryCutoverInput),actor=c.get("userEmail"),repository=recoveryRepository(c.env),job=await owned(c.env,c.req.param("jobId"),actor);
  const prior=await repository.request(acceptedInput.requestId,actor,acceptedInput);if(prior)return c.json(await receipt(c.env,acceptedInput.requestId,{job:prior,reused:true}));
  if(job.kind!=="recovery"||job.state!=="completed"||job.phase!=="ready"||!job.target_incarnation||job.target_id!==acceptedInput.expectedTargetId||JSON.parse(job.result_json??"null")?.checkpoint!==acceptedInput.expectedCheckpoint)throw fail("Recovery target is not ready at this checkpoint",409);
  const frozenInput=checkedSystemRecoveryImportInput(JSON.parse(job.input_json)),records=await repository.metadata(job.source_upload_job_id!,"records") as SystemBackupRecordsV1,manifest=await repository.metadata(job.source_upload_job_id!,"manifest") as SystemBackupManifestV1;
  const maintenance=await readSourceMaintenance(c.env);if(maintenance.state!=="fenced"||maintenance.activeWriters)throw fail("Prepared handoff requires drained source maintenance",409);
  if(frozenInput.mode==="historical"&&!frozenInput.acknowledgeLaterChanges)throw fail("Historical recovery requires explicit later-change acknowledgement",409);
  const accepted=await runBoundedSystemRecoveryReadAction(async()=>{if(!recoveryActorAllowed(c.env,actor))return false;const status=await readSourceMaintenance(c.env),live=await repository.job(job.id);
    return status.state==="fenced"&&status.activeWriters===0&&status.generation===maintenance.generation&&status.token===maintenance.token&&live?.state==="completed"&&live.phase==="ready"
      &&live.generation===job.generation&&live.target_incarnation===job.target_incarnation&&live.target_id===acceptedInput.expectedTargetId&&JSON.parse(live.result_json??"null")?.checkpoint===acceptedInput.expectedCheckpoint&&recoveryActorAllowed(c.env,actor);
  },async(current,signal,deadlineAt)=>{
    if(!await current())throw fail("Recovery verification checkpoint changed",409);
    if(frozenInput.mode==="planned"){const fresh=await recaptureSystemBackupSnapshot(c.env,records.backupId);if(!await current())throw fail("Recovery verification checkpoint changed",409);
      const sha=await sourceBackupCheckpoint(fresh);await verifySourceCheckpoint(c.env,records.backupId,sha);
      if(sha!==manifest.sourceCheckpoint||!await current())throw fail("Final source checkpoint changed",409);}
    const report=await createRecoveryTargetEngine(c.env).verify({jobId:job.id,incarnation:job.target_incarnation!,ownerToken:acceptedInput.requestId,generation:job.generation+1,
      runtimeIncarnation:(await repository.runtime())!.incarnation,leaseExpiresAt:deadlineAt,signal,expectedTargetId:acceptedInput.expectedTargetId,records,manifest,mapping:frozenInput.mapping,mode:frozenInput.mode,current,
      openPayload:async()=>{throw new Error("Ready handoff does not issue payload writes");}});
    if(report.targetCheckpoint!==acceptedInput.expectedCheckpoint||!await current())throw fail("Recovery verification checkpoint changed",409);
    return repository.recordCutover(job,acceptedInput,{generation:maintenance.generation,token:maintenance.token,deadlineAt},()=>!signal.aborted&&Date.now()<Date.parse(deadlineAt)&&recoveryActorAllowed(c.env,actor));
  });return c.json(await receipt(c.env,acceptedInput.requestId,accepted));});
