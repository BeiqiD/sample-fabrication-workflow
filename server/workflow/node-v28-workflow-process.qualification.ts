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
import { prepareCurrentV28OnlineRecoverySource } from "../recovery/current-v28-online-recovery.qualification-support";
import { NODE_V28_JOB_CADENCE_MS } from "../jobs/node-v28-job-scheduler";
import { launchWorkflowCli, closeWorkflowCli, loginWorkflowCli, workflowCliJson, workflowCliBytes,
  type WorkflowCliOwner, type WorkflowCliSession } from "./node-v28-workflow-cli.qualification-support";

// Separate finite stage: one actual compiled main, three original families,
// real elapsed slots. No alternate host, clock/timer replacement, manual
// dispatch, synthetic port, shorter product cadence or direct queue SQL.
const MAX_SLOTS=10,CASE_MS=MAX_SLOTS*NODE_V28_JOB_CADENCE_MS+60_000;
let distribution:string,receiptPath:string,manifestSha256:string;
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function ensure(value:unknown):asserts value {if(!value)throw new Error("Genuine compiled V28 workflow qualification is unavailable");}
function object(value:unknown):Record<string,unknown>{ensure(value&&typeof value==="object"&&!Array.isArray(value));return value as Record<string,unknown>;}
beforeAll(async()=>{
  distribution=process.env.NODE_OFFLINE_V28_DISTRIBUTION??"";receiptPath=process.env.CURRENT_V28_WORKFLOW_PROCESS_RECEIPT??"";
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
async function json(owner:WorkflowCliOwner,origin:string,path:string,method="GET",input?:unknown,session?:WorkflowCliSession){
  const answer=await workflowCliJson(owner,origin,path,method,input,session);return answer;
}
async function snapshot(owner:WorkflowCliOwner,origin:string,ids:{file:string;package:string;recovery:string},session:WorkflowCliSession){
  const file=await json(owner,origin,"/api/files/migrations/"+ids.file,"GET",undefined,session);expect(file.status).toBe(200);
  const pkg=await json(owner,origin,"/api/packages/jobs/"+ids.package,"GET",undefined,session);expect(pkg.status).toBe(200);
  const recovery=await json(owner,origin,"/api/system-recovery/jobs/"+ids.recovery,"GET",undefined,session);expect(recovery.status).toBe(200);
  return {file:checkedFileJobStatus(file.value),package:checkedResearchJobStatus(pkg.value),recovery:checkedSystemRecoveryJobStatus(recovery.value)};
}

describe("actual compiled V28 workflow main, three queues and original120s cadence",()=>{
  it("retains accepted File, Package and strict Recovery-upload queues across first graceful close, then executes original elapsed slots under one parent",()=>retainedCanonicalFileCase(async()=>{
    expect(NODE_V28_JOB_CADENCE_MS).toBe(120000);
    const source=await prepareCurrentV28OnlineRecoverySource(),baseline=source.baseline;
    const origin=await withCanonicalFileDatabase(baseline.path,owner=>canonicalFilePrivateOrigin(owner));
    assertCanonicalFileOwnersReleased();
    // Existing stopped capture CLI produces a genuine complete one-File V5
    // before workflow startup. This does not invoke an application scheduler.
    const captureConfig=join(baseline.root,"workflow-capture.json"),archivePath=join(baseline.root,"workflow-original-one-file-v5.zip");
    await writeFile(captureConfig,JSON.stringify({schema:"stopped-local-v28-capture/1",databasePath:baseline.path,descriptors:baseline.descriptors}),{flag:"wx",mode:0o600});
    const capture=await runCurrentCli(distribution,"installation-cli.cjs",["capture-local-backup","--runtime-profile","v28",
      "--configuration",captureConfig,"--archive",archivePath,"--installation",baseline.installationId,"--filesystem-root-owner-uid",String(baseline.rootOwnerUid)]);
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
    await executeDomainRootV28OperatorCandidate({...base,kind:"set-creation-flags",principalId:baseline.principalId,
      expectedMemberRevision:1,expectedControlRevision:1,canCreateSamples:true,canCreateProjects:false,canCreateTemplates:false});
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
      current=launchWorkflowCli(distribution,configPath,baseline.rootOwnerUid);await current.ready;
      const first=current;ensure(first.child?.pid&&first.child.pid!==process.pid);
      const session=await loginWorkflowCli(first,origin,"operator",CANONICAL_FILE_PASSWORD);
      expect(session.actor).toBe(baseline.operatorActor);expect(session.systemAdministrator).toBe(true);expect(session.fileEvidenceOperator).toBe(false);
      const health=await json(first,origin,"/api/health");expect(health.status).toBe(200);
      expect(object(health.value).capabilities).toMatchObject({kind:"node-v28-workflow-mounted/1",profile:"v28-workflow",fullReady:false,
        jobCadenceMs:120000,jobFamilies:["file","package","recovery"],persistedExecutorActivationRequired:true,startupProvisioning:false,generalFileLifecycle:false,imageBytes:false,spa:false});
      const initialFile=await json(first,origin,"/api/files/migrations/executor","GET",undefined,session);expect(initialFile.status).toBe(200);
      expect(initialFile.value).toMatchObject({enabled:false,cadenceSeconds:120});
      const initialRecovery=await json(first,origin,"/api/system-recovery/capabilities","GET",undefined,session);expect(initialRecovery.status).toBe(200);
      expect(checkedSystemRecoveryCapabilities(initialRecovery.value).enabled).toBe(false);
      const created=await json(first,origin,"/api/samples","POST",{code:"WORKFLOW-"+randomUUID(),title:"Genuine three-queue source"},session);expect(created.status).toBe(201);
      const sampleId=object(created.value).id;ensure(typeof sampleId==="string");
      const selected=await json(first,origin,"/api/samples/"+sampleId,"GET",undefined,session);expect(selected.status).toBe(200);const sample=object(selected.value);
      const observation=await json(first,origin,"/api/samples/"+sampleId+"/records","POST",{status:sample.status,location:sample.location??"",pinned:Boolean(sample.pinned),
        expectedUpdatedAt:sample.updatedAt,body:"One actual accepted File shared by the three-queue observation",assetId:source.sourceAssetId},session);expect(observation.status).toBe(201);
      expect((await json(first,origin,"/api/files/migrations/executor","POST",{enabled:true},session)).status).toBe(200);
      const file=await json(first,origin,"/api/files/migrations","POST",{requestId:randomUUID(),fileIds:[source.sourceFileId],
        target:{profileId:baseline.originalsProfileId,configurationRevision:1}},session);expect(file.status).toBe(202);ids.file=checkedFileJobStatus(file.value).id;
      const pkg=await json(first,origin,"/api/packages/jobs","POST",{requestId:randomUUID(),kind:"data_package",roots:[{kind:"sample",id:sampleId}]},session);
      expect(pkg.status).toBe(202);ids.package=checkedResearchRequestReceipt(pkg.value).job.id;
      expect((await json(first,origin,"/api/system-recovery/executor","POST",{enabled:true},session)).status).toBe(200);
      const upload=await json(first,origin,"/api/system-recovery/uploads","POST",{requestId:randomUUID(),byteSize:originalArchive.byteLength,sha256:hash(originalArchive)},session);
      expect(upload.status).toBe(202);ids.recovery=checkedSystemRecoveryReceipt(upload.value).job.id;
      const uploaded=await workflowCliBytes(first,origin,"/api/system-recovery/jobs/"+ids.recovery+"/upload","PUT",originalArchive,session);expect(uploaded.status).toBe(200);
      expect(checkedSystemRecoveryJobStatus(JSON.parse(new TextDecoder().decode(uploaded.bytes)))).toMatchObject({kind:"upload",state:"queued",phase:"validate"});
      const queued=await snapshot(first,origin,ids,session);
      expect(queued.file).toMatchObject({state:"queued",moved:0,remaining:1});expect(queued.package).toMatchObject({state:"queued",phase:"snapshot"});
      expect(queued.recovery).toMatchObject({state:"queued",phase:"validate"});
      ensure(performance.now()-first.launchedAt<NODE_V28_JOB_CADENCE_MS);
      const firstClose=closeWorkflowCli(first);expect(closeWorkflowCli(first)).toBe(firstClose);const closed=await firstClose;current=undefined;
      events.push({event:"first_original_close",pid:first.child.pid,code:closed.code,signal:closed.signal});
      await writeFile(join(baseline.root,"workflow-first.stdout.log"),closed.stdout,{flag:"wx",mode:0o600});
      await writeFile(join(baseline.root,"workflow-first.stderr.log"),closed.stderr,{flag:"wx",mode:0o600});
      const persisted=await withCanonicalFileDatabase(baseline.path,async(_owner,lease,native)=>lease.withWriter(async()=>{
        expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n).toBe(0);
        expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE kind='scheduled'").get()?.n).toBe(0);
        expect(native.prepare("SELECT state FROM file_migration_jobs WHERE id=?").get(ids.file)?.state).toBe("queued");
        expect(native.prepare("SELECT state,phase FROM research_package_jobs WHERE id=?").get(ids.package)).toEqual({state:"queued",phase:"snapshot"});
        expect(native.prepare("SELECT state,phase FROM system_recovery_jobs WHERE id=?").get(ids.recovery)).toEqual({state:"queued",phase:"validate"});
        const location=native.prepare("SELECT active_location_id FROM file_publications WHERE file_id=?").get(source.sourceFileId)?.active_location_id;ensure(typeof location==="string");
        return {location};
      }));assertCanonicalFileOwnersReleased();
      const initialCursor=object(JSON.parse(await readFile(join(baseline.dataDirectory,".node-v28-workflow-job-cursor.json"),"utf8")));
      expect(initialCursor).toMatchObject({schema:"node-v28-workflow-job-cursor/1",nextFamily:"file",consumedSlots:0,reservation:null});
      current=launchWorkflowCli(distribution,configPath,baseline.rootOwnerUid);await current.ready;
      const second=current;ensure(second.child?.pid&&second.child.pid!==first.child.pid&&second.child.pid!==process.pid);
      const secondSession=await loginWorkflowCli(second,origin,"operator",CANONICAL_FILE_PASSWORD);
      const deadline=second.launchedAt+MAX_SLOTS*NODE_V28_JOB_CADENCE_MS;
      let firstFile=false,firstPackage=false,firstRecovery=false;
      while(performance.now()<deadline){
        ensure(!second.ended);const state=await snapshot(second,origin,ids,secondSession),elapsed=performance.now()-second.launchedAt;
        expect(state.file.state).not.toBe("paused");expect(state.package.state).not.toBe("paused");expect(state.recovery.state).not.toBe("paused");
        if(!firstFile&&state.file.moved===1){firstFile=true;expect(elapsed).toBeGreaterThanOrEqual(NODE_V28_JOB_CADENCE_MS);
          events.push({event:"automatic_file_verified_cutover",elapsedMs:Math.trunc(elapsed)});}
        if(!firstPackage&&(state.package.phase!=="snapshot"||state.package.state!=="queued")){firstPackage=true;
          expect(firstFile).toBe(true);expect(elapsed).toBeGreaterThanOrEqual(2*NODE_V28_JOB_CADENCE_MS);events.push({event:"automatic_package_first_action",elapsedMs:Math.trunc(elapsed)});}
        if(!firstRecovery&&state.recovery.state==="preview"){firstRecovery=true;expect(firstPackage).toBe(true);
          expect(elapsed).toBeGreaterThanOrEqual(3*NODE_V28_JOB_CADENCE_MS);events.push({event:"automatic_recovery_strict_preview",elapsedMs:Math.trunc(elapsed)});}
        if(state.file.state==="completed"&&state.package.state==="completed"&&state.recovery.state==="preview")break;
        await delay(Math.min(2000,Math.max(1,deadline-performance.now())));
      }
      const final=await snapshot(second,origin,ids,secondSession);expect(firstFile&&firstPackage&&firstRecovery).toBe(true);
      expect(final.file).toMatchObject({state:"completed",moved:1,remaining:0,failed:0});expect(final.package.state).toBe("completed");
      expect(final.recovery).toMatchObject({kind:"upload",state:"preview",phase:"done"});
      const preview=await json(second,origin,"/api/system-recovery/jobs/"+ids.recovery+"/preview","GET",undefined,secondSession);expect(preview.status).toBe(200);
      expect(checkedSystemRecoveryPreview(preview.value)).toMatchObject({archive:{schema:"system-backup/5",sha256:hash(originalArchive),complete:true},
        counts:{files:1,availableFiles:1,unavailableFiles:0,bytes:source.payloadBytes},canRecover:false,canCutover:false});
      const output=final.package.output;ensure(output&&output.available);
      const delivered=await workflowCliBytes(second,origin,"/api/packages/jobs/"+ids.package+"/download","GET",undefined,secondSession);expect(delivered.status).toBe(200);
      expect(delivered.bytes.byteLength).toBe(output.byteSize);expect(hash(delivered.bytes)).toBe(output.sha256);
      const archive=await validateStoreArchive(sourceFromBlob(new Blob([delivered.bytes.slice().buffer as ArrayBuffer])),{expectedSha256:output.sha256});
      const validated=await validateResearchPackage(JSON.parse(new TextDecoder().decode(archive.metadata.get("manifest.json")!)),JSON.parse(new TextDecoder().decode(archive.metadata.get("records.json")!)));
      expect(validated.files).toHaveLength(1);expect(validated.files[0]).toMatchObject({byteSize:source.payloadBytes,sha256:source.payloadSha256,purpose:"embedded_content"});
      const entry=archive.entries.find(value=>value.path===validated.files[0]!.path);ensure(entry);
      expect(delivered.bytes.slice(entry.dataOffset,entry.dataOffset+entry.byteSize)).toEqual(source.bytes);
      const finalClose=closeWorkflowCli(second);expect(closeWorkflowCli(second)).toBe(finalClose);const stopped=await finalClose;current=undefined;
      events.push({event:"second_original_close",pid:second.child.pid,code:stopped.code,signal:stopped.signal});
      await writeFile(join(baseline.root,"workflow-second.stdout.log"),stopped.stdout,{flag:"wx",mode:0o600});
      await writeFile(join(baseline.root,"workflow-second.stderr.log"),stopped.stderr,{flag:"wx",mode:0o600});
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
        expect(sources.length).toBeGreaterThanOrEqual(3);expect(sources.length).toBeLessThanOrEqual(MAX_SLOTS);
        for(const row of sources){expect(row.owner).toMatch(/^node-file-job:/);expect(typeof row.released_at).toBe("string");}
        return {scheduledSources:sources,fileItems:native.prepare("SELECT file_id,state,source_location_id,destination_location_id FROM file_migration_items WHERE job_id=?").all(ids.file),
          fileAttempts:native.prepare("SELECT state,io_settled_at FROM file_migration_attempts WHERE job_id=?").all(ids.file),
          packageAttempts:native.prepare("SELECT state FROM research_package_attempts WHERE job_id=?").all(ids.package),
          recoveryAttempts:native.prepare("SELECT state FROM system_recovery_attempts WHERE job_id=?").all(ids.recovery),
          holds:native.prepare("SELECT hold_kind,operation_id,released_at FROM file_location_holds ORDER BY id").all()};
      }));assertCanonicalFileOwnersReleased();
      const cursor=object(JSON.parse(await readFile(join(baseline.dataDirectory,".node-v28-workflow-job-cursor.json"),"utf8")));
      expect(cursor.reservation).toBeNull();ensure(typeof cursor.consumedSlots==="number");expect(cursor.consumedSlots).toBeGreaterThanOrEqual(4);
      expect(cursor.consumedSlots).toBeLessThanOrEqual(MAX_SLOTS);expect(cursor.sequence).toBeGreaterThan(0);
      await writeFile(receiptPath,JSON.stringify({schema:"genuine-compiled-v28-workflow-three-queue-original-cadence/1",distributionManifestSha256:manifestSha256,
        cadenceMs:NODE_V28_JOB_CADENCE_MS,maximumSlots:MAX_SLOTS,installationId:baseline.installationId,fileId:source.sourceFileId,
        payloadBytes:source.payloadBytes,payloadSha256:source.payloadSha256,jobIds:ids,events,initialCursor,finalCursor:cursor,census,
        originalFirstClosesAcknowledged:true,writerReacquiredOnlyAfterOriginalClose:true,noManualDispatch:true,noFakeClock:true,noCadenceOverride:true,
        maintenanceHeldBodyQualified:false,onlineTargetRestoreQualified:false,unknownWriteFaultsQualified:false},null,2)+"\n",{flag:"wx",mode:0o600});
    }catch(error){workFailed=true;workFailure=error;throw error;}
    finally{
      if(current){
        try{await closeWorkflowCli(current);}
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
