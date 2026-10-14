import { beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { verifyNodeDistribution } from "../../scripts/lib/node-distribution-v28-manifest.mjs";
import { checkedResearchJobStatus, checkedResearchRequestReceipt } from "../../shared/contracts/research-package-api";
import { validateResearchPackage } from "../../shared/contracts/research-package";
import { sourceFromBlob, validateStoreArchive } from "../../shared/domain/research-archive";
import { CANONICAL_FILE_PASSWORD, assertCanonicalFileOwnersReleased, canonicalFilePrivateOrigin,
  retainedCanonicalFileCase, withCanonicalFileDatabase } from "../collaboration/current-v28-canonical-comment-file.qualification-support";
import { executeCollaborationV28OperatorCandidate } from "../operations/collaboration-v28-operator-candidate";
import { executeV28OrdinaryAccountOperatorCandidate } from "../operations/ordinary-account-v28-candidate";
import { executeDomainRootV28OperatorCandidate } from "../operations/collaboration-domain-roots-v28-candidate";
import { prepareCurrentV28WorkflowSharedFileSource } from "../recovery/current-v28-online-recovery.qualification-support";
import { NODE_V28_JOB_CADENCE_MS } from "../jobs/node-v28-job-scheduler";
import { launchWorkflowCli, closeWorkflowCli, loginWorkflowCli, workflowCliJson, workflowCliBytes,
  type WorkflowCliOwner, type WorkflowCliSession } from "./node-v28-workflow-cli.qualification-support";

// Separate finite stage: one actual compiled main, three original families,
// real elapsed slots. No alternate host, clock/timer replacement, manual
// dispatch, synthetic port, shorter product cadence or direct queue SQL.
// Two actual automatic Package actions complete this one-File export.
// Four original120s slots plus60s bound setup/current negative/first close.
const MAX_SLOTS=4,CASE_MS=MAX_SLOTS*NODE_V28_JOB_CADENCE_MS+60_000;
let distribution:string,receiptPath:string,manifestSha256:string;
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function ensure(value:unknown):asserts value {if(!value)throw new Error("Genuine compiled V28 workflow qualification is unavailable");}
function object(value:unknown):Record<string,unknown>{ensure(value&&typeof value==="object"&&!Array.isArray(value));return value as Record<string,unknown>;}
beforeAll(async()=>{
  distribution=process.env.NODE_OFFLINE_V28_DISTRIBUTION??"";receiptPath=process.env.CURRENT_V28_PACKAGE_REVOKED_POST_REPLAY_RECEIPT??"";
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
    "server/recovery/node-system-recovery-v28-application.ts","server/packages/job-child-v28-candidate.ts","server/packages/request-http-v28-candidate.ts",
    "server/packages/local-permission-v28-candidate.ts","server/auth/installed-identity-execution-owner-v28-candidate.ts",
    "server/auth/local-request-subject.ts","server/collaboration/local-root-management-v28-candidate.ts"]){
    const current=await readFile(new URL("../../"+relative,import.meta.url));
    const entry=inputs.map(object).find(item=>item.path===relative);ensure(entry);
    expect(entry.bytes).toBe(current.byteLength);expect(entry.sha256).toBe(hash(current));
  }
},20_000);
// Fixed route names only: never log selectors, origins, IDs, request bodies,
// response data, credentials or an arbitrary error message. These diagnostics
// observe each same original request/ACK; no deadline or retry is introduced.
function routeName(path:string):string {
  const fixed=["/api/health","/api/auth/login","/api/auth/session","/api/files/migrations","/api/files/migrations/executor",
    "/api/packages/jobs","/api/system-recovery/capabilities","/api/system-recovery/executor","/api/system-recovery/uploads"];
  if(fixed.includes(path))return path;
  const selected:[RegExp,string][]=[[/^\/api\/collaboration\/resources\/sample\/[^/]+\/grants\/[^/]+$/,"/api/collaboration/resources/sample/:rootId/grants/:memberId"],
    [/^\/api\/packages\/requests\/[^/]+$/,"/api/packages/requests/:requestId"],[/^\/api\/samples\/[^/]+$/,"/api/samples/:sampleId"],
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

describe("actual completed Node V28 Package POST replay after genuine Group root revocation",()=>{
  it("completes and positively replays one original export, transfers actual manager rights and denies the same POST while its original actor remains authenticated administrator",()=>retainedCanonicalFileCase(async()=>{
    expect(NODE_V28_JOB_CADENCE_MS).toBe(120000);
    const source=await diagnostic("genuine shared one-File Sample preparation",()=>prepareCurrentV28WorkflowSharedFileSource()),baseline=source.baseline;
    const origin=await withCanonicalFileDatabase(baseline.path,owner=>canonicalFilePrivateOrigin(owner));assertCanonicalFileOwnersReleased();
    const base={databasePath:baseline.path,filesystemRootOwnerUid:baseline.rootOwnerUid};
    // All actors are provisioned/mapped by real stopped operators. This named
    // ordinary successor receives no administrator or default root authority.
    const successor=await executeV28OrdinaryAccountOperatorCandidate({...base,kind:"provision-account",username:"replay.successor"},CANONICAL_FILE_PASSWORD);
    expect(successor.systemAdministrator).toBe(false);
    const requester=await executeCollaborationV28OperatorCandidate({...base,kind:"enroll-local-member",principalId:baseline.principalId,
      displayName:"Actual completed Package requester",workspaceRole:"membershipAdministrator",canCreateSamples:true,expectedControlRevision:1});
    const successorMember=await executeCollaborationV28OperatorCandidate({...base,kind:"enroll-local-member",principalId:successor.principalId,
      displayName:"Explicit ordinary root-manager successor",workspaceRole:"member",canCreateSamples:false,expectedControlRevision:1});
    const requesterMemberId=requester.memberId,successorMemberId=successorMember.memberId;
    ensure(typeof requesterMemberId==="string"&&requesterMemberId.length>0
      &&typeof successorMemberId==="string"&&successorMemberId.length>0&&requesterMemberId!==successorMemberId);
    const creation=await executeDomainRootV28OperatorCandidate({...base,kind:"set-creation-flags",principalId:baseline.principalId,
      expectedMemberRevision:1,expectedControlRevision:1,canCreateSamples:true,canCreateProjects:false,canCreateTemplates:false});
    const allocated=await executeDomainRootV28OperatorCandidate({...base,kind:"allocate-existing-root",rootKind:"sample",rootId:source.workflowSampleId,
      visibility:"restricted",principalId:baseline.principalId,expectedMemberRevision:creation.memberRevision,expectedControlRevision:1});
    expect(allocated.root).toEqual({kind:"sample",id:source.workflowSampleId,resourceRevision:1,grantRevision:1});
    await executeCollaborationV28OperatorCandidate({...base,kind:"set-enforcement",enforcement:"enabled",expectedControlRevision:1});assertCanonicalFileOwnersReleased();
    const configuration=join(baseline.root,"completed-post-replay-runtime.json");
    await writeFile(configuration,JSON.stringify({format:"node-loopback-development-v1",dataDirectory:baseline.dataDirectory,
      expectedInstallationId:baseline.installationId,publicOrigin:origin,clientDirectory:baseline.clientDirectory,localVolumes:baseline.descriptors,
      enableLocalFile:true,enableLocalJobs:true,enableLocalRecovery:true,recoveryArtifacts:source.recoveryArtifacts}),{flag:"wx",mode:0o600});
    let current:WorkflowCliOwner|undefined,workFailed=false,workFailure:unknown;
    const input={requestId:randomUUID(),kind:"data_package",roots:[{kind:"sample",id:source.workflowSampleId}]};
    const events:Array<{event:string;elapsedMs?:number}>=[];
    try{
      current=launchWorkflowCli(distribution,configuration,baseline.rootOwnerUid);const owner=current;
      await diagnostic("actual replay main original readiness",()=>owner.ready);ensure(owner.child?.pid&&owner.child.pid!==process.pid);
      const session=await diagnostic("actual requester HTTP POST /api/auth/login",()=>loginWorkflowCli(owner,origin,"operator",CANONICAL_FILE_PASSWORD));
      expect(session.actor).toBe(baseline.operatorActor);expect(session.systemAdministrator).toBe(true);expect(session.fileEvidenceOperator).toBe(false);
      const disabled=await json(owner,origin,"/api/files/migrations/executor","GET",undefined,session);expect(disabled.status).toBe(200);expect(disabled.value).toMatchObject({enabled:false});
      expect((await json(owner,origin,"/api/files/migrations/executor","POST",{enabled:true},session)).status).toBe(200);
      const accepted=await json(owner,origin,"/api/packages/jobs","POST",input,session);expect(accepted.status).toBe(202);
      const original=checkedResearchRequestReceipt(accepted.value),jobId=original.job.id;expect(original.requestId).toBe(input.requestId);
      expect(original.job).toMatchObject({state:"queued",phase:"snapshot",kind:"data_package"});
      ensure(performance.now()-owner.launchedAt<NODE_V28_JOB_CADENCE_MS);
      const deadline=owner.launchedAt+MAX_SLOTS*NODE_V28_JOB_CADENCE_MS;
      let firstAction=false,completed=false;
      while(performance.now()<deadline){
        ensure(!owner.ended);const answer=await json(owner,origin,"/api/packages/jobs/"+jobId,"GET",undefined,session);expect(answer.status).toBe(200);
        const state=checkedResearchJobStatus(answer.value),elapsed=performance.now()-owner.launchedAt;
        expect(state.state).not.toBe("paused");
        if(!firstAction&&(state.phase!=="snapshot"||state.state!=="queued")){
          firstAction=true;expect(elapsed).toBeGreaterThanOrEqual(NODE_V28_JOB_CADENCE_MS);events.push({event:"original_package_first_automatic_action",elapsedMs:Math.trunc(elapsed)});
        }
        if(state.state==="completed"){
          completed=true;expect(firstAction).toBe(true);expect(elapsed).toBeGreaterThanOrEqual(2*NODE_V28_JOB_CADENCE_MS);
          events.push({event:"original_package_completed_automatically",elapsedMs:Math.trunc(elapsed)});break;
        }
        await delay(Math.min(2000,Math.max(1,deadline-performance.now())));
      }
      expect(completed).toBe(true);
      const receipt=await json(owner,origin,"/api/packages/requests/"+input.requestId,"GET",undefined,session);expect(receipt.status).toBe(200);
      const completedReceipt=checkedResearchRequestReceipt(receipt.value);expect(completedReceipt.job).toMatchObject({id:jobId,state:"completed",phase:"done"});
      const output=completedReceipt.job.output;ensure(output&&output.available);
      // Same original POST/request ID has a positive completed-receipt replay
      // control before any current right is revoked. No second job is accepted.
      const replay=await json(owner,origin,"/api/packages/jobs","POST",input,session);expect(replay.status).toBe(202);
      expect(checkedResearchRequestReceipt(replay.value)).toEqual(completedReceipt);
      const downloaded=await bytes(owner,origin,"/api/packages/jobs/"+jobId+"/download","GET",undefined,session);expect(downloaded.status).toBe(200);
      expect(downloaded.bytes.byteLength).toBe(output.byteSize);expect(hash(downloaded.bytes)).toBe(output.sha256);
      const archive=await validateStoreArchive(sourceFromBlob(new Blob([downloaded.bytes.slice().buffer as ArrayBuffer])),{expectedSha256:output.sha256});
      const validated=await validateResearchPackage(JSON.parse(new TextDecoder().decode(archive.metadata.get("manifest.json")!)),JSON.parse(new TextDecoder().decode(archive.metadata.get("records.json")!)));
      expect(validated.files).toHaveLength(1);expect(validated.files[0]).toMatchObject({byteSize:source.payloadBytes,sha256:source.payloadSha256,purpose:"embedded_content"});
      const entry=archive.entries.find(value=>value.path===validated.files[0]!.path);ensure(entry);expect(downloaded.bytes.slice(entry.dataOffset,entry.dataOffset+entry.byteSize)).toEqual(source.bytes);
      // Original projected Sample admission also confirms the current root and
      // genuinely drained source writer window before management begins.
      const read=await json(owner,origin,"/api/samples/"+source.workflowSampleId,"GET",undefined,session);expect(read.status).toBe(200);
      const grants="/api/collaboration/resources/sample/"+source.workflowSampleId+"/grants/";
      const successorGrant=await json(owner,origin,grants+successorMemberId,"PUT",{operation:"grant",expectedResourceRevision:1,
        expectedGrantRevision:null,capability:"manage",enabled:true},session);expect(successorGrant.status).toBe(200);
      expect(successorGrant.value).toMatchObject({resourceRevision:2,memberId:successorMemberId,grantRevision:1});
      const successorSession=await diagnostic("ordinary successor HTTP POST /api/auth/login",()=>loginWorkflowCli(owner,origin,"replay.successor",CANONICAL_FILE_PASSWORD));
      expect(successorSession.principalId).toBe(successor.principalId);expect(successorSession.systemAdministrator).toBe(false);expect(successorSession.fileEvidenceOperator).toBe(false);
      // Last-manager protection is respected. The independently authenticated
      // actual successor disables the requester's grant and keeps its own
      // current manager authority through the original post-commit ACK.
      const revoked=await json(owner,origin,grants+requesterMemberId,"PUT",{operation:"grant",expectedResourceRevision:2,
        expectedGrantRevision:1,capability:"manage",enabled:false},successorSession);expect(revoked.status).toBe(200);
      expect(revoked.value).toMatchObject({resourceRevision:3,memberId:requesterMemberId,grantRevision:2});
      const stillSignedIn=await json(owner,origin,"/api/auth/session","GET",undefined,session);expect(stillSignedIn.status).toBe(200);
      expect(stillSignedIn.value).toMatchObject({principal:{id:baseline.principalId,actor:baseline.operatorActor,capabilities:{systemAdministrator:true,fileEvidenceOperator:false}}});
      const denied=await json(owner,origin,"/api/packages/jobs","POST",input,session);expect(denied.status).toBe(403);
      expect(denied.value).toEqual({error:"Current Group Package root permission is required."});
      const deniedReceipt=await json(owner,origin,"/api/packages/requests/"+input.requestId,"GET",undefined,session);expect(deniedReceipt.status).toBe(403);
      expect(deniedReceipt.value).toEqual({error:"Current Group Package root permission is required."});
      events.push({event:"same_completed_post_and_receipt_denied_after_real_root_revocation",elapsedMs:Math.trunc(performance.now()-owner.launchedAt)});
      const originalClose=closeWorkflowCli(owner);expect(closeWorkflowCli(owner)).toBe(originalClose);
      const closed=await diagnostic("actual replay main original close",()=>originalClose);current=undefined;
      await writeFile(join(baseline.root,"completed-replay-main.stdout.log"),closed.stdout,{flag:"wx",mode:0o600});
      await writeFile(join(baseline.root,"completed-replay-main.stderr.log"),closed.stderr,{flag:"wx",mode:0o600});
      // Read-only census only after original app/child/stdio first-close ACK.
      const census=await withCanonicalFileDatabase(baseline.path,async(_owner,lease,native)=>lease.withWriter(async()=>{
        expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n).toBe(0);
        expect(native.prepare("SELECT count(*) n FROM research_package_jobs").get()?.n).toBe(1);
        expect(native.prepare("SELECT count(*) n FROM research_package_requests WHERE actor=? AND request_id=? AND job_id=?").get(baseline.operatorActor,input.requestId,jobId)?.n).toBe(1);
        expect(native.prepare("SELECT state,phase,request_id,actor FROM research_package_jobs WHERE id=?").get(jobId))
          .toEqual({state:"completed",phase:"done",request_id:input.requestId,actor:baseline.operatorActor});
        expect(native.prepare("SELECT count(*) n FROM research_package_attempts WHERE state IN('write_started','unknown')").get()?.n).toBe(0);
        expect(native.prepare("SELECT visibility,revision FROM collaboration_resources WHERE root_kind='sample' AND root_id=?").get(source.workflowSampleId)).toEqual({visibility:"restricted",revision:3});
        expect(native.prepare("SELECT capability,enabled,revision FROM collaboration_grants WHERE root_kind='sample' AND root_id=? AND member_id=?").get(source.workflowSampleId,requesterMemberId))
          .toEqual({capability:"manage",enabled:0,revision:2});
        expect(native.prepare("SELECT capability,enabled,revision FROM collaboration_grants WHERE root_kind='sample' AND root_id=? AND member_id=?").get(source.workflowSampleId,successorMemberId))
          .toEqual({capability:"manage",enabled:1,revision:1});
        expect(native.prepare("SELECT enabled FROM local_accounts WHERE principal_id=?").get(baseline.principalId)?.enabled).toBe(1);
        expect(native.prepare("SELECT count(*) n FROM local_admin_grants WHERE principal_id=?").get(baseline.principalId)?.n).toBe(1);
        expect(native.prepare("SELECT count(*) n FROM local_admin_grants WHERE principal_id=?").get(successor.principalId)?.n).toBe(0);
        expect(native.prepare("SELECT count(*) n FROM file_holds WHERE operation_id=? AND released_at IS NULL").get("fp4-output:"+jobId)?.n).toBe(1);
        const sources=native.prepare("SELECT kind,owner,created_at,released_at FROM system_recovery_write_leases WHERE kind='scheduled' ORDER BY created_at,id").all();expect(sources).toHaveLength(2);
        for(const row of sources){expect(row.owner).toMatch(/^node-file-job:/);expect(typeof row.released_at).toBe("string");}
        expect(Date.parse(String(sources[1]!.created_at))-Date.parse(String(sources[0]!.created_at))).toBeGreaterThanOrEqual(NODE_V28_JOB_CADENCE_MS);
        return {scheduledSources:sources,requestRows:native.prepare("SELECT request_id,job_id,reused FROM research_package_requests WHERE actor=?").all(baseline.operatorActor),
          attempts:native.prepare("SELECT state,io_settled_at FROM research_package_attempts WHERE job_id=?").all(jobId),
          rootGrants:native.prepare("SELECT member_id,capability,enabled,revision FROM collaboration_grants WHERE root_kind='sample' AND root_id=? ORDER BY member_id").all(source.workflowSampleId)};
      }));assertCanonicalFileOwnersReleased();
      await writeFile(receiptPath,JSON.stringify({schema:"genuine-v28-completed-post-replay-current-root-denial/1",distributionManifestSha256:manifestSha256,
        cadenceMs:NODE_V28_JOB_CADENCE_MS,maximumSlots:MAX_SLOTS,installationId:baseline.installationId,jobId,requestId:input.requestId,
        payloadBytes:source.payloadBytes,payloadSha256:source.payloadSha256,positiveCompletedReplay:true,revokedPostStatus:denied.status,
        revokedReceiptStatus:deniedReceipt.status,actualRequesterStillAuthenticatedAdministrator:true,successorIsOrdinaryActualRootManager:true,
        originalFirstCloseAcknowledged:true,originalClose:{code:closed.code,signal:closed.signal},events,census,
        noManualDispatch:true,noFakeClock:true,noPermissionSqlSeed:true,noCallbackRights:true},null,2)+"\n",{flag:"wx",mode:0o600});
    }catch(error){workFailed=true;workFailure=error;throw error;}
    finally{if(current){const remaining=current;try{await diagnostic("original cached replay failure close",()=>closeWorkflowCli(remaining));}
      catch(cleanup){if(workFailed)throw new AggregateError([workFailure,cleanup],"Original replay qualification work and cached first close failed");throw cleanup;}}}
  }),CASE_MS);
});
