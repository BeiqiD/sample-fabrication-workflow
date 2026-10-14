import { beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { verifyNodeDistribution } from "../../scripts/lib/node-distribution-v28-manifest.mjs";
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource } from "../../scripts/lib/system-backup-node-io";
import { checkedFileJobStatus } from "../../shared/contracts/file-jobs";
import { checkedResearchJobStatus, checkedResearchRequestReceipt } from "../../shared/contracts/research-package-api";
import { validateResearchPackage } from "../../shared/contracts/research-package";
import { checkedSystemRecoveryCapabilities, checkedSystemRecoveryReceipt, checkedSystemRecoveryJobStatus,
  checkedSystemRecoveryPreview } from "../../shared/contracts/system-recovery";
import { validateV28SystemBackupArchiveCandidate } from "../../shared/contracts/system-backup-v5-archive-admission";
import { sourceFromBlob, validateStoreArchive } from "../../shared/domain/research-archive";
import { CANONICAL_FILE_PASSWORD, assertCanonicalFileOwnersReleased, canonicalFilePrivateOrigin,
  retainedCanonicalFileCase, withCanonicalFileDatabase } from "../collaboration/current-v28-canonical-comment-file.qualification-support";
import { executeCollaborationV28OperatorCandidate } from "../operations/collaboration-v28-operator-candidate";
import { executeDomainRootV28OperatorCandidate } from "../operations/collaboration-domain-roots-v28-candidate";
import { runCurrentCli } from "../operations/current-v28-backup-cli.qualification-support";
import { prepareCurrentV28WorkflowSharedFileSource } from "../recovery/current-v28-online-recovery.qualification-support";
import { NODE_V28_JOB_CADENCE_MS } from "../jobs/node-v28-job-scheduler";
import { launchWorkflowCli, closeWorkflowCli, loginWorkflowCli, workflowCliJson, workflowCliBytes,
  type WorkflowCliOwner, type WorkflowCliSession } from "./node-v28-workflow-cli.qualification-support";

// Separate finite stage: one actual compiled main, three original families,
// real elapsed slots. No alternate host, clock/timer replacement, manual
// dispatch, synthetic port, shorter product cadence or direct queue SQL.
// Four required real slots: one File slot before nonzero close, then
// Package→Recovery→Package after restart. Two extra slots and60s bound original
// setup/stop/verification; product120s cadence and60s kernels stay untouched.
const MAX_SLOTS=6,CASE_MS=MAX_SLOTS*NODE_V28_JOB_CADENCE_MS+60_000;
let distribution:string,receiptPath:string,manifestSha256:string;
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function ensure(value:unknown):asserts value {if(!value)throw new Error("Genuine compiled V28 workflow qualification is unavailable");}
function object(value:unknown):Record<string,unknown>{ensure(value&&typeof value==="object"&&!Array.isArray(value));return value as Record<string,unknown>;}
beforeAll(async()=>{
  distribution=process.env.NODE_OFFLINE_V28_DISTRIBUTION??"";receiptPath=process.env.CURRENT_V28_WORKFLOW_CURSOR_RESTART_RECEIPT??"";
  ensure(isAbsolute(distribution)&&resolve(distribution)===distribution&&await realpath(distribution)===distribution
    &&isAbsolute(receiptPath)&&resolve(receiptPath)===receiptPath);
  const manifest=await verifyNodeDistribution(distribution,{enforceRuntimeVersion:true});manifestSha256=manifest.manifestSha256;
  expect(manifest.version).toBe(3);expect(manifest.offlineRecoveryCheckpoint.id).toBe("portable-runtime/v28");
  expect(manifest.offlineRecoveryCheckpoint.archiveFormat).toBe("v5");
  // Distribution verification alone cannot carry another source's runtime
  // claim. Independently compare this exact current source graph's leaf hashes.
  const inputs=object(JSON.parse(await readFile(join(distribution,"source-inputs.json"),"utf8"))).inputs;ensure(Array.isArray(inputs));
  for(const relative of ["server/main.ts","server/node-runtime-profile.ts","server/http.ts",
    "server/workflow/node-v28-workflow-runtime.ts","server/workflow/node-v28-workflow-application.ts","server/workflow/node-v28-file-job-child.ts",
    "server/jobs/node-v28-job-scheduler.ts","server/jobs/node-v28-job-cursor.ts","server/recovery/node-v28-source-barrier.ts",
    "server/recovery/node-system-recovery-v28-application.ts","server/packages/job-child-v28-candidate.ts","server/packages/request-http-v28-candidate.ts"]){
    const current=await readFile(new URL("../../"+relative,import.meta.url));
    const entry=inputs.map(object).find(item=>item.path===relative);ensure(entry);
    expect(entry.bytes).toBe(current.byteLength);expect(entry.sha256).toBe(hash(current));
  }
},20_000);
// Fixed route names only: never log selectors, origins, IDs, request bodies,
// response data, credentials or an arbitrary error message. These diagnostics
// observe each same original request/ACK; no deadline or retry is introduced.
function routeName(path:string):string {
  const fixed=["/api/health","/api/auth/login","/api/files/migrations","/api/files/migrations/executor",
    "/api/packages/jobs","/api/system-recovery/capabilities","/api/system-recovery/executor","/api/system-recovery/uploads"];
  if(fixed.includes(path))return path;
  const selected:[RegExp,string][]=[[/^\/api\/samples\/[^/]+$/,"/api/samples/:sampleId"],
    [/^\/api\/files\/migrations\/[^/]+$/,"/api/files/migrations/:jobId"],
    [/^\/api\/packages\/jobs\/[^/]+\/download$/,"/api/packages/jobs/:jobId/download"],
    [/^\/api\/packages\/jobs\/[^/]+$/,"/api/packages/jobs/:jobId"],
    [/^\/api\/system-recovery\/jobs\/[^/]+\/upload$/,"/api/system-recovery/jobs/:jobId/upload"],
    [/^\/api\/system-recovery\/jobs\/[^/]+\/preview$/,"/api/system-recovery/jobs/:jobId/preview"],
    [/^\/api\/system-recovery\/jobs\/[^/]+$/,"/api/system-recovery/jobs/:jobId"]];
  return selected.find(([pattern])=>pattern.test(path))?.[1]??"unrecognized-current-case-route";
}
async function diagnostic<T>(step:string,original:()=>Promise<T>):Promise<T> {
  const started=performance.now();
  console.info("Workflow phase diagnostic:",JSON.stringify({step,event:"begin"}));
  try {
    const result=await original();
    const status=result&&typeof result==="object"&&"status" in result&&typeof result.status==="number"?result.status:undefined;
    console.info("Workflow phase diagnostic:",JSON.stringify({step,event:"ack",durationMs:Math.trunc(performance.now()-started),...(status===undefined?{}:{status})}));
    return result;
  }catch(error){
    const known=["TimeoutError","AbortError","AssertionError","AggregateError"];
    const failureKind=error instanceof Error&&known.includes(error.name)?error.name:"original-operation-error";
    console.info("Workflow phase diagnostic:",JSON.stringify({step,event:"failure",durationMs:Math.trunc(performance.now()-started),failureKind}));
    throw error; // Preserve the exact first original rejection and its custody.
  }
}
async function json(owner:WorkflowCliOwner,origin:string,path:string,method="GET",input?:unknown,session?:WorkflowCliSession){
  return diagnostic("HTTP "+method+" "+routeName(path),()=>workflowCliJson(owner,origin,path,method,input,session));
}
async function bytes(owner:WorkflowCliOwner,origin:string,path:string,method:string,input?:Uint8Array,session?:WorkflowCliSession){
  return diagnostic("HTTP "+method+" "+routeName(path),()=>workflowCliBytes(owner,origin,path,method,input,session));
}
async function snapshot(owner:WorkflowCliOwner,origin:string,ids:{file:string;package:string;recovery:string},session:WorkflowCliSession){
  const file=await json(owner,origin,"/api/files/migrations/"+ids.file,"GET",undefined,session);expect(file.status).toBe(200);
  const pkg=await json(owner,origin,"/api/packages/jobs/"+ids.package,"GET",undefined,session);expect(pkg.status).toBe(200);
  const recovery=await json(owner,origin,"/api/system-recovery/jobs/"+ids.recovery,"GET",undefined,session);expect(recovery.status).toBe(200);
  return {file:checkedFileJobStatus(file.value),package:checkedResearchJobStatus(pkg.value),recovery:checkedSystemRecoveryJobStatus(recovery.value)};
}

describe("actual compiled V28 workflow durable nonzero cursor restart",()=>{
  it("persists one original consumed File slot, closes before the next family and resumes Package then Recovery under actual elapsed120s slots",()=>retainedCanonicalFileCase(async()=>{
    expect(NODE_V28_JOB_CADENCE_MS).toBe(120000);
    const source=await diagnostic("genuine original shared-File source preparation",()=>prepareCurrentV28WorkflowSharedFileSource()),baseline=source.baseline;
    const origin=await withCanonicalFileDatabase(baseline.path,owner=>canonicalFilePrivateOrigin(owner));
    assertCanonicalFileOwnersReleased();
    // Existing stopped capture CLI produces a genuine complete one-File V5
    // before workflow startup. This does not invoke an application scheduler.
    const captureConfig=join(baseline.root,"workflow-capture.json"),archivePath=join(baseline.root,"workflow-original-one-file-v5.zip");
    await writeFile(captureConfig,JSON.stringify({schema:"stopped-local-v28-capture/1",databasePath:baseline.path,descriptors:baseline.descriptors}),{flag:"wx",mode:0o600});
    const capture=await diagnostic("compiled stopped strict-V5 capture",()=>runCurrentCli(distribution,"installation-cli.cjs",["capture-local-backup","--runtime-profile","v28",
      "--configuration",captureConfig,"--archive",archivePath,"--installation",baseline.installationId,"--filesystem-root-owner-uid",String(baseline.rootOwnerUid)]));
    expect(capture.code).toBe(0);expect(capture.signal).toBeNull();expect(capture.stderr).toBe("");
    const captureReceipt=object(JSON.parse(capture.stdout));ensure(typeof captureReceipt.archiveSha256==="string");
    expect(captureReceipt).toMatchObject({kind:"stopped-local-v28-v5-capture/1",completeness:"complete",packagedFiles:1,unavailableFiles:0,sourceMutation:false});
    const originalArchive=await readFile(archivePath);expect(hash(originalArchive)).toBe(captureReceipt.archiveSha256);
    const admittedV5=await validateV28SystemBackupArchiveCandidate(await nodeRecoveryArchiveSource(archivePath),
      {...NODE_RECOVERY_ARCHIVE_OPTIONS,expectedSha256:captureReceipt.archiveSha256});
    expect(admittedV5.manifest.counts).toMatchObject({sources:1,packagedFiles:1,unavailableFiles:0,bytes:source.payloadBytes});
    expect(admittedV5.manifest.files[0]).toMatchObject({byteSize:source.payloadBytes,sha256:source.payloadSha256,fileIds:[source.sourceFileId]});
    // Genuine offline membership/creation/enforcement commands, before the
    // parent takes its sole lease. No SQL rows or flags stand in for grants.
    const base={databasePath:baseline.path,filesystemRootOwnerUid:baseline.rootOwnerUid};
    const member=await executeCollaborationV28OperatorCandidate({...base,kind:"enroll-local-member",principalId:baseline.principalId,
      displayName:"Genuine three-queue member",workspaceRole:"membershipAdministrator",canCreateSamples:true,expectedControlRevision:1});ensure(member.memberId);
    const creation=await executeDomainRootV28OperatorCandidate({...base,kind:"set-creation-flags",principalId:baseline.principalId,
      expectedMemberRevision:1,expectedControlRevision:1,canCreateSamples:true,canCreateProjects:false,canCreateTemplates:false});
    const allocated=await executeDomainRootV28OperatorCandidate({...base,kind:"allocate-existing-root",rootKind:"sample",rootId:source.workflowSampleId,
      visibility:"restricted",principalId:baseline.principalId,expectedMemberRevision:creation.memberRevision,expectedControlRevision:1});
    expect(allocated.root).toEqual({kind:"sample",id:source.workflowSampleId,resourceRevision:1,grantRevision:1});
    await executeCollaborationV28OperatorCandidate({...base,kind:"set-enforcement",enforcement:"enabled",expectedControlRevision:1});
    assertCanonicalFileOwnersReleased();
    const configPath=join(baseline.root,"workflow-runtime.json");
    await writeFile(configPath,JSON.stringify({format:"node-loopback-development-v1",dataDirectory:baseline.dataDirectory,
      expectedInstallationId:baseline.installationId,publicOrigin:origin,clientDirectory:baseline.clientDirectory,localVolumes:baseline.descriptors,
      enableLocalFile:true,enableLocalJobs:true,enableLocalRecovery:true,recoveryArtifacts:source.recoveryArtifacts}),{flag:"wx",mode:0o600});
    let current:WorkflowCliOwner|undefined;
    const events:Array<{event:string;elapsedMs?:number;pid?:number;code?:number|null;signal?:NodeJS.Signals|null}>=[];
    const ids={file:"",package:"",recovery:""};
    let workFailed=false,workFailure:unknown;
    try{
      current=launchWorkflowCli(distribution,configPath,baseline.rootOwnerUid);
      const first=current;await diagnostic("first compiled main original readiness",()=>first.ready);ensure(first.child?.pid&&first.child.pid!==process.pid);
      const session=await diagnostic("first main HTTP POST /api/auth/login",()=>loginWorkflowCli(first,origin,"operator",CANONICAL_FILE_PASSWORD));
      expect(session.actor).toBe(baseline.operatorActor);expect(session.systemAdministrator).toBe(true);expect(session.fileEvidenceOperator).toBe(false);
      const health=await json(first,origin,"/api/health");expect(health.status).toBe(200);
      expect(object(health.value).capabilities).toMatchObject({kind:"node-v28-workflow-mounted/1",profile:"v28-workflow",fullReady:false,
        jobCadenceMs:120000,jobFamilies:["file","package","recovery"],persistedExecutorActivationRequired:true,startupProvisioning:false,generalFileLifecycle:false,imageBytes:false,spa:false});
      const initialFile=await json(first,origin,"/api/files/migrations/executor","GET",undefined,session);expect(initialFile.status).toBe(200);
      expect(initialFile.value).toMatchObject({enabled:false,cadenceSeconds:120});
      const initialRecovery=await json(first,origin,"/api/system-recovery/capabilities","GET",undefined,session);expect(initialRecovery.status).toBe(200);
      expect(checkedSystemRecoveryCapabilities(initialRecovery.value).enabled).toBe(false);
      // Same ordinary File was associated through the original real V26
      // Sample record HTTP before upgrade. This genuine existing root was
      // allocated above by the stopped V28 operator, never by a fixture row.
      const sampleId=source.workflowSampleId;
      const selected=await json(first,origin,"/api/samples/"+sampleId,"GET",undefined,session);expect(selected.status).toBe(200);
      expect(object(selected.value)).toMatchObject({id:sampleId});
      expect((await json(first,origin,"/api/files/migrations/executor","POST",{enabled:true},session)).status).toBe(200);
      const file=await json(first,origin,"/api/files/migrations","POST",{requestId:randomUUID(),fileIds:[source.sourceFileId],
        target:{profileId:baseline.originalsProfileId,configurationRevision:1}},session);expect(file.status).toBe(202);ids.file=checkedFileJobStatus(file.value).id;
      const pkg=await json(first,origin,"/api/packages/jobs","POST",{requestId:randomUUID(),kind:"data_package",roots:[{kind:"sample",id:sampleId}]},session);
      expect(pkg.status).toBe(202);ids.package=checkedResearchRequestReceipt(pkg.value).job.id;
      expect((await json(first,origin,"/api/system-recovery/executor","POST",{enabled:true},session)).status).toBe(200);
      const upload=await json(first,origin,"/api/system-recovery/uploads","POST",{requestId:randomUUID(),byteSize:originalArchive.byteLength,sha256:hash(originalArchive)},session);
      expect(upload.status).toBe(202);ids.recovery=checkedSystemRecoveryReceipt(upload.value).job.id;
      const uploaded=await bytes(first,origin,"/api/system-recovery/jobs/"+ids.recovery+"/upload","PUT",originalArchive,session);expect(uploaded.status).toBe(200);
      expect(checkedSystemRecoveryJobStatus(JSON.parse(new TextDecoder().decode(uploaded.bytes)))).toMatchObject({kind:"upload",state:"queued",phase:"validate"});
      const queued=await snapshot(first,origin,ids,session);
      expect(queued.file).toMatchObject({state:"queued",moved:0,remaining:1});expect(queued.package).toMatchObject({state:"queued",phase:"snapshot"});
      expect(queued.recovery).toMatchObject({state:"queued",phase:"validate"});
      ensure(performance.now()-first.launchedAt<NODE_V28_JOB_CADENCE_MS);
      const firstClose=closeWorkflowCli(first);expect(closeWorkflowCli(first)).toBe(firstClose);const closed=await diagnostic("first compiled main original close",()=>firstClose);current=undefined;
      events.push({event:"first_original_close",pid:first.child.pid,code:closed.code,signal:closed.signal});
      await writeFile(join(baseline.root,"cursor-first-zero.stdout.log"),closed.stdout,{flag:"wx",mode:0o600});
      await writeFile(join(baseline.root,"cursor-first-zero.stderr.log"),closed.stderr,{flag:"wx",mode:0o600});
      const persisted=await withCanonicalFileDatabase(baseline.path,async(_owner,lease,native)=>lease.withWriter(async()=>{
        expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n).toBe(0);
        expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE kind='scheduled'").get()?.n).toBe(0);
        expect(native.prepare("SELECT state FROM file_migration_jobs WHERE id=?").get(ids.file)?.state).toBe("queued");
        expect(native.prepare("SELECT state,phase FROM research_package_jobs WHERE id=?").get(ids.package)).toEqual({state:"queued",phase:"snapshot"});
        expect(native.prepare("SELECT state,phase FROM system_recovery_jobs WHERE id=?").get(ids.recovery)).toEqual({state:"queued",phase:"validate"});
        const location=native.prepare("SELECT active_location_id FROM file_publications WHERE file_id=?").get(source.sourceFileId)?.active_location_id;ensure(typeof location==="string");
        expect(native.prepare("SELECT asset_file_id FROM events WHERE sample_id=? AND asset_file_id IS NOT NULL").all(sampleId))
          .toEqual([{asset_file_id:source.sourceFileId}]);
        expect(native.prepare("SELECT source_file_id,purpose FROM research_package_files WHERE job_id=? AND entry_kind='source'").all(ids.package))
          .toEqual([{source_file_id:source.sourceFileId,purpose:"embedded_content"}]);
        return {location};
      }));assertCanonicalFileOwnersReleased();
      const initialCursor=object(JSON.parse(await readFile(join(baseline.dataDirectory,".node-v28-workflow-job-cursor.json"),"utf8")));
      expect(initialCursor).toMatchObject({schema:"node-v28-workflow-job-cursor/1",nextFamily:"file",consumedSlots:0,reservation:null});
      current=launchWorkflowCli(distribution,configPath,baseline.rootOwnerUid);
      const second=current;await diagnostic("second compiled main original readiness",()=>second.ready);ensure(second.child?.pid&&second.child.pid!==first.child.pid&&second.child.pid!==process.pid);
      const secondSession=await diagnostic("second main HTTP POST /api/auth/login",()=>loginWorkflowCli(second,origin,"operator",CANONICAL_FILE_PASSWORD));
      const firstSlotDeadline=second.launchedAt+2*NODE_V28_JOB_CADENCE_MS;
      let firstFile=false;
      while(performance.now()<firstSlotDeadline){
        ensure(!second.ended);
        const state=await snapshot(second,origin,ids,secondSession),elapsed=performance.now()-second.launchedAt;
        expect(state.file.state).not.toBe("paused");
        // No next-family action may precede the nonzero stop. The real File
        // publication alone does not prove its source/provider/cursor ACK.
        expect(state.package).toMatchObject({state:"queued",phase:"snapshot"});
        expect(state.recovery).toMatchObject({state:"queued",phase:"validate"});
        if(state.file.moved===1){
          expect(state.file).toMatchObject({state:"completed",moved:1,remaining:0,failed:0});
          expect(elapsed).toBeGreaterThanOrEqual(NODE_V28_JOB_CADENCE_MS);
          expect(elapsed).toBeLessThan(2*NODE_V28_JOB_CADENCE_MS);firstFile=true;
          events.push({event:"automatic_file_slot_before_nonzero_restart",elapsedMs:Math.trunc(elapsed)});break;
        }
        await delay(Math.min(2000,Math.max(1,firstSlotDeadline-performance.now())));
      }
      expect(firstFile).toBe(true);
      const consumedClose=closeWorkflowCli(second);expect(closeWorkflowCli(second)).toBe(consumedClose);
      const consumedStopped=await diagnostic("nonzero File-slot main original close",()=>consumedClose);current=undefined;
      const consumedCloseElapsed=performance.now()-second.launchedAt;
      expect(consumedCloseElapsed).toBeLessThan(2*NODE_V28_JOB_CADENCE_MS);
      events.push({event:"nonzero_original_close_before_next_family",elapsedMs:Math.trunc(consumedCloseElapsed),
        pid:second.child.pid,code:consumedStopped.code,signal:consumedStopped.signal});
      await writeFile(join(baseline.root,"cursor-after-file.stdout.log"),consumedStopped.stdout,{flag:"wx",mode:0o600});
      await writeFile(join(baseline.root,"cursor-after-file.stderr.log"),consumedStopped.stderr,{flag:"wx",mode:0o600});
      // The only observer Native/core/lease is acquired AFTER original child
      // close+stdio EOF ACK. Its SQL is read-only and never seeds queue/cursor.
      const consumedCensus=await withCanonicalFileDatabase(baseline.path,async(_owner,lease,native)=>lease.withWriter(async()=>{
        expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n).toBe(0);
        expect(native.prepare("SELECT state FROM file_migration_jobs WHERE id=?").get(ids.file)?.state).toBe("completed");
        expect(native.prepare("SELECT state,phase FROM research_package_jobs WHERE id=?").get(ids.package)).toEqual({state:"queued",phase:"snapshot"});
        expect(native.prepare("SELECT state,phase FROM system_recovery_jobs WHERE id=?").get(ids.recovery)).toEqual({state:"queued",phase:"validate"});
        expect(native.prepare("SELECT count(*) n FROM research_package_attempts WHERE job_id=?").get(ids.package)?.n).toBe(0);
        const sources=native.prepare("SELECT id,owner,kind,created_at,released_at FROM system_recovery_write_leases WHERE kind='scheduled' ORDER BY created_at,id").all();
        expect(sources).toHaveLength(1);expect(sources[0]!.owner).toMatch(/^node-file-job:/);expect(typeof sources[0]!.released_at).toBe("string");
        const attempts=native.prepare("SELECT id,state,io_settled_at FROM file_migration_attempts WHERE job_id=? ORDER BY created_at,id").all(ids.file);
        expect(attempts).toHaveLength(1);expect(attempts[0]!.state).toBe("published");
        ensure(typeof attempts[0]!.id==="string"&&typeof attempts[0]!.io_settled_at==="string");
        const location=native.prepare("SELECT active_location_id FROM file_publications WHERE file_id=?").get(source.sourceFileId)?.active_location_id;
        ensure(typeof location==="string");expect(location).not.toBe(persisted.location);
        return {sources,attempts,location};
      }));assertCanonicalFileOwnersReleased();
      const nonzeroCursor=object(JSON.parse(await readFile(join(baseline.dataDirectory,".node-v28-workflow-job-cursor.json"),"utf8")));
      expect(nonzeroCursor).toMatchObject({schema:"node-v28-workflow-job-cursor/1",nextFamily:"package",consumedSlots:1,sequence:2,reservation:null});
      expect(nonzeroCursor.installation).toEqual(initialCursor.installation);
      current=launchWorkflowCli(distribution,configPath,baseline.rootOwnerUid);
      const third=current;await diagnostic("third compiled main nonzero cursor readiness",()=>third.ready);
      ensure(third.child?.pid&&third.child.pid!==second.child.pid&&third.child.pid!==first.child.pid&&third.child.pid!==process.pid);
      const thirdSession=await diagnostic("third main HTTP POST /api/auth/login",()=>loginWorkflowCli(third,origin,"operator",CANONICAL_FILE_PASSWORD));
      const resumed=snapshot(third,origin,ids,thirdSession);
      const initialResumed=await resumed;
      expect(initialResumed.file).toMatchObject({state:"completed",moved:1,remaining:0,failed:0});
      expect(initialResumed.package).toMatchObject({state:"queued",phase:"snapshot"});
      expect(initialResumed.recovery).toMatchObject({state:"queued",phase:"validate"});
      const deadline=third.launchedAt+(MAX_SLOTS-1)*NODE_V28_JOB_CADENCE_MS;
      let firstPackage=false,firstRecovery=false;
      while(performance.now()<deadline){
        ensure(!third.ended);const state=await snapshot(third,origin,ids,thirdSession),elapsed=performance.now()-third.launchedAt;
        expect(state.file).toMatchObject({state:"completed",moved:1,remaining:0,failed:0});
        expect(state.package.state).not.toBe("paused");expect(state.recovery.state).not.toBe("paused");
        if(!firstPackage&&(state.package.phase!=="snapshot"||state.package.state!=="queued")){
          firstPackage=true;expect(elapsed).toBeGreaterThanOrEqual(NODE_V28_JOB_CADENCE_MS);
          expect(state.recovery).toMatchObject({state:"queued",phase:"validate"});
          events.push({event:"nonzero_resume_package_first_automatic_slot",elapsedMs:Math.trunc(elapsed)});
        }
        if(!firstRecovery&&state.recovery.state==="preview"){
          firstRecovery=true;expect(firstPackage).toBe(true);expect(elapsed).toBeGreaterThanOrEqual(2*NODE_V28_JOB_CADENCE_MS);
          events.push({event:"nonzero_resume_recovery_second_automatic_slot",elapsedMs:Math.trunc(elapsed)});
        }
        if(state.package.state==="completed"){
          expect(firstPackage&&firstRecovery).toBe(true);expect(elapsed).toBeGreaterThanOrEqual(3*NODE_V28_JOB_CADENCE_MS);
          events.push({event:"nonzero_resume_package_final_automatic_slot",elapsedMs:Math.trunc(elapsed)});break;
        }
        await delay(Math.min(2000,Math.max(1,deadline-performance.now())));
      }
      const final=await snapshot(third,origin,ids,thirdSession);expect(firstFile&&firstPackage&&firstRecovery).toBe(true);
      expect(final.file).toMatchObject({state:"completed",moved:1,remaining:0,failed:0});expect(final.package.state).toBe("completed");
      expect(final.recovery).toMatchObject({kind:"upload",state:"preview",phase:"done"});
      const preview=await json(third,origin,"/api/system-recovery/jobs/"+ids.recovery+"/preview","GET",undefined,thirdSession);expect(preview.status).toBe(200);
      expect(checkedSystemRecoveryPreview(preview.value)).toMatchObject({archive:{schema:"system-backup/5",sha256:hash(originalArchive),complete:true},
        counts:{files:1,availableFiles:1,unavailableFiles:0,bytes:source.payloadBytes},canRecover:false,canCutover:false});
      const output=final.package.output;ensure(output&&output.available);
      const delivered=await bytes(third,origin,"/api/packages/jobs/"+ids.package+"/download","GET",undefined,thirdSession);expect(delivered.status).toBe(200);
      expect(delivered.bytes.byteLength).toBe(output.byteSize);expect(hash(delivered.bytes)).toBe(output.sha256);
      const archive=await validateStoreArchive(sourceFromBlob(new Blob([delivered.bytes.slice().buffer as ArrayBuffer])),{expectedSha256:output.sha256});
      const validated=await validateResearchPackage(JSON.parse(new TextDecoder().decode(archive.metadata.get("manifest.json")!)),JSON.parse(new TextDecoder().decode(archive.metadata.get("records.json")!)));
      expect(validated.files).toHaveLength(1);expect(validated.files[0]).toMatchObject({byteSize:source.payloadBytes,sha256:source.payloadSha256,purpose:"embedded_content"});
      const entry=archive.entries.find(value=>value.path===validated.files[0]!.path);ensure(entry);
      expect(delivered.bytes.slice(entry.dataOffset,entry.dataOffset+entry.byteSize)).toEqual(source.bytes);
      const finalClose=closeWorkflowCli(third);expect(closeWorkflowCli(third)).toBe(finalClose);const stopped=await diagnostic("third compiled main original close",()=>finalClose);current=undefined;
      events.push({event:"third_original_close",pid:third.child.pid,code:stopped.code,signal:stopped.signal});
      await writeFile(join(baseline.root,"cursor-final-third.stdout.log"),stopped.stdout,{flag:"wx",mode:0o600});
      await writeFile(join(baseline.root,"cursor-final-third.stderr.log"),stopped.stderr,{flag:"wx",mode:0o600});
      const census=await withCanonicalFileDatabase(baseline.path,async(_owner,lease,native)=>lease.withWriter(async()=>{
        expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n).toBe(0);
        for(const table of ["file_migration_attempts","research_package_attempts"])expect(native.prepare(`SELECT count(*) n FROM ${table} WHERE state IN('write_started','unknown')`).get()?.n).toBe(0);
        expect(native.prepare("SELECT count(*) n FROM system_recovery_attempts WHERE state IN('started','unknown')").get()?.n).toBe(0);
        const location=native.prepare("SELECT active_location_id FROM file_publications WHERE file_id=?").get(source.sourceFileId)?.active_location_id;
        ensure(typeof location==="string");expect(location).not.toBe(persisted.location);
        expect(native.prepare("SELECT storage_profile_id,verified_byte_size,verified_sha256 FROM file_location_publications WHERE location_id=?").get(location))
          .toEqual({storage_profile_id:baseline.originalsProfileId,verified_byte_size:source.payloadBytes,verified_sha256:source.payloadSha256});
        expect(native.prepare("SELECT count(*) n FROM file_holds WHERE operation_id=? AND released_at IS NULL").get("fp4-output:"+ids.package)?.n).toBe(1);
        const sources=native.prepare("SELECT owner,kind,created_at,released_at FROM system_recovery_write_leases WHERE kind='scheduled' ORDER BY created_at,id").all();
        expect(sources).toHaveLength(3); // File1 + Package2; Recovery has no scheduled SOURCE lease.
        for(const [index,row] of sources.entries()){
          expect(row.owner).toMatch(/^node-file-job:/);expect(typeof row.released_at).toBe("string");
          if(index)expect(Date.parse(String(row.created_at))-Date.parse(String(sources[index-1]!.created_at))).toBeGreaterThanOrEqual(NODE_V28_JOB_CADENCE_MS);
        }
        const finalFileAttempts=native.prepare("SELECT id,state,io_settled_at FROM file_migration_attempts WHERE job_id=? ORDER BY created_at,id").all(ids.file);
        // Same original completed attempt and publication: no File action is
        // replayed when the genuinely nonzero cursor is reopened.
        expect(finalFileAttempts).toEqual(consumedCensus.attempts);expect(location).toBe(consumedCensus.location);
        return {scheduledSources:sources,fileItems:native.prepare("SELECT file_id,state,source_location_id,destination_location_id FROM file_migration_items WHERE job_id=?").all(ids.file),
          fileAttempts:native.prepare("SELECT state,io_settled_at FROM file_migration_attempts WHERE job_id=?").all(ids.file),
          packageAttempts:native.prepare("SELECT state FROM research_package_attempts WHERE job_id=?").all(ids.package),
          recoveryAttempts:native.prepare("SELECT state FROM system_recovery_attempts WHERE job_id=?").all(ids.recovery),
          holds:native.prepare("SELECT hold_kind,operation_id,released_at FROM file_location_holds ORDER BY id").all()};
      }));assertCanonicalFileOwnersReleased();
      const cursor=object(JSON.parse(await readFile(join(baseline.dataDirectory,".node-v28-workflow-job-cursor.json"),"utf8")));
      expect(cursor.reservation).toBeNull();ensure(typeof cursor.consumedSlots==="number");expect(cursor.consumedSlots).toBe(4);
      expect(cursor.nextFamily).toBe("recovery");expect(cursor.sequence).toBe(8);
      expect(cursor.installation).toEqual(nonzeroCursor.installation);
      await writeFile(receiptPath,JSON.stringify({schema:"genuine-compiled-v28-workflow-nonzero-cursor-restart/1",distributionManifestSha256:manifestSha256,
        cadenceMs:NODE_V28_JOB_CADENCE_MS,maximumSlots:MAX_SLOTS,installationId:baseline.installationId,fileId:source.sourceFileId,
        payloadBytes:source.payloadBytes,payloadSha256:source.payloadSha256,jobIds:ids,events,initialCursor,nonzeroCursor,consumedCensus,finalCursor:cursor,census,
        originalFirstClosesAcknowledged:true,nonzeroCursorResumed:true,noCompletedFileReplay:true,writerReacquiredOnlyAfterOriginalClose:true,noManualDispatch:true,noFakeClock:true,noCadenceOverride:true,
        maintenanceHeldBodyQualified:false,onlineTargetRestoreQualified:false,unknownWriteFaultsQualified:false},null,2)+"\n",{flag:"wx",mode:0o600});
    }catch(error){workFailed=true;workFailure=error;throw error;}
    finally{
      if(current){
        const remaining=current;
        try{await diagnostic("failure cleanup original cached main close",()=>closeWorkflowCli(remaining));}
        catch(cleanup){
          // Join only the helper's original cached first close. Preserve the
          // first work failure as well; no new close attempt or fallback.
          if(workFailed)throw new AggregateError([workFailure,cleanup],"Original workflow qualification work and cached first close failed");
          throw cleanup;
        }
      }
    }
  }),CASE_MS);
});
