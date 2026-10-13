import { expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { prepareGenuineCurrentV26R2Pair, pairJson, type GenuineR2Pair,
  type WorkerV5OriginalIssueObserver, type WorkerV5OriginalIssueGate } from "../../server/recovery/current-v26-r2-node-pair.qualification-support";
import { activateR2PackagePeer } from "../../server/packages/public-r2-node-pair.qualification-support";
import { checkedSystemRecoveryCapabilities, checkedSystemRecoveryJobStatus, checkedSystemRecoveryReceipt,
  type SystemRecoveryJobStatus } from "../../shared/contracts/system-recovery";
import { validateV28SystemBackupArchiveCandidate } from "../../shared/contracts/system-backup-v5-archive-admission";
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource } from "../lib/system-backup-node-io";
import { retainedInput, verifyClosedNativeD1 } from "./worker-v5-original-issue-negative.qualification-support";

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const titles = [
  "refuses the genuine public V5 artifact PUT after actual administrator revocation during the original native namespace ACK",
  "refuses the genuine held V5 R2 GET after actual administrator revocation during the original native profile ACK",
  "retains the genuine held V5 body across its real 60s deadline and refuses new issue after the original native ACK arrives late",
] as const;
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error("worker_v5_original_negative_" + reason); }
function object(value: unknown): Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value), "object"); return value as Record<string, unknown>;
}
type Port = Pick<GenuineR2Pair, "request" | "schedule" | "readRows">;
type Target = NonNullable<GenuineR2Pair["recoveryTarget"]>;
interface Trace {
  nativeGet: number; nativeHead: number; nativePut: number; nativeDelete: number; readers: number;
  originalCancelCalls: number; originalCancelAcknowledged: number; originalCancelRejected: number;
  originalReaderClosedAcknowledged: number; originalReaderClosedRejected: number; actorRevoked: boolean;
  gate: null | { kind: WorkerV5OriginalIssueGate; entered: boolean; originalAcknowledged: boolean;
    released: boolean; deliveryIoStarted: boolean; deliveryIoAcknowledged: boolean; enteredAt: number | null; returnedAt: number | null };
  deliveryIo: null | { schema: 'original-native-ack-delivery-http-io/1'; acceptedRequests: number; acknowledgedResponses: number;
    released: boolean; acceptedAt: number | null; responseFinishedAt: number | null };
}
function count(value: unknown): number { ensure(typeof value==="number"&&Number.isSafeInteger(value)&&value>=0,"actual_observation_count");return value; }
function clock(value: unknown): number | null { if(value===null)return null;return count(value); }
async function stats(observer: WorkerV5OriginalIssueObserver): Promise<Trace> {
  const value=object(await observer.control("stats"));ensure(typeof value.actorRevoked==="boolean","actual_policy_observation");
  let gate: Trace["gate"]=null;
  if(value.gate!==null){const item=object(value.gate);
    ensure(item.kind==="namespace-actor"||item.kind==="profile-actor"||item.kind==="held-original-ack","closed_gate_kind");
    ensure(typeof item.entered==="boolean"&&typeof item.originalAcknowledged==="boolean"&&typeof item.released==="boolean"
      &&typeof item.deliveryIoStarted==="boolean"&&typeof item.deliveryIoAcknowledged==="boolean","original_gate_observation");
    gate={kind:item.kind,entered:item.entered,originalAcknowledged:item.originalAcknowledged,released:item.released,
      deliveryIoStarted:item.deliveryIoStarted,deliveryIoAcknowledged:item.deliveryIoAcknowledged,
      enteredAt:clock(item.enteredAt),returnedAt:clock(item.returnedAt)};
  }
  let deliveryIo: Trace["deliveryIo"]=null;
  if(value.deliveryIo!==null){const item=object(value.deliveryIo);
    ensure(item.schema==='original-native-ack-delivery-http-io/1'&&typeof item.released==='boolean','actual_delivery_io_observation');
    deliveryIo={schema:item.schema,acceptedRequests:count(item.acceptedRequests),acknowledgedResponses:count(item.acknowledgedResponses),
      released:item.released,acceptedAt:clock(item.acceptedAt),responseFinishedAt:clock(item.responseFinishedAt)};
  }
  return {nativeGet:count(value.nativeGet),nativeHead:count(value.nativeHead),nativePut:count(value.nativePut),nativeDelete:count(value.nativeDelete),
    readers:count(value.readers),originalCancelCalls:count(value.originalCancelCalls),originalCancelAcknowledged:count(value.originalCancelAcknowledged),
    originalCancelRejected:count(value.originalCancelRejected),originalReaderClosedAcknowledged:count(value.originalReaderClosedAcknowledged),
    originalReaderClosedRejected:count(value.originalReaderClosedRejected),actorRevoked:value.actorRevoked,gate,deliveryIo};
}
async function json(port: Pick<Port,"request">, path: string, method = "GET", input?: unknown, status = 200) {
  const answer = await port.request(path, method, input === undefined ? undefined : JSON.stringify(input),
    input === undefined ? {} : { "content-type": "application/json" });
  const value=pairJson(answer.value),publicError=typeof value.error==="string"?value.error.slice(0,2048):null;
  expect(answer.response.status,method+" "+path+"; public error="+JSON.stringify(publicError)).toBe(status);return value;
}
async function complete(port: Port, initial: SystemRecoveryJobStatus, terminal: "preview" | "completed") {
  let job=initial,originalScheduledCalls=0;
  for(;originalScheduledCalls<100&&job.state!==terminal;originalScheduledCalls++){
    await port.schedule();job=checkedSystemRecoveryJobStatus(await json(port,"/api/system-recovery/jobs/"+job.id));
    expect(["queued",terminal],"Original job reason="+job.reason).toContain(job.state);
  }
  expect(job.state).toBe(terminal);return {job,originalScheduledCalls};
}
async function waitFor<T>(read:()=>Promise<T>,ready:(value:T)=>boolean,maximumMs:number):Promise<T>{
  const deadline=Date.now()+maximumMs;
  while(true){const value=await read();if(ready(value))return value;ensure(Date.now()<deadline,"original_handshake_or_state_missing");await delay(100);}
}
const issueCounts=(trace:Trace)=>[trace.nativeGet,trace.nativeHead,trace.nativePut,trace.nativeDelete];
const holdSql=`SELECT h.id,h.location_id,h.hold_kind,h.operation_id,h.reason,h.acquired_at,h.expires_at,h.released_at,
  l.file_id,l.storage_profile_id,l.object_key,p.adapter_type,p.configuration_revision,lp.verified_byte_size,lp.verified_sha256
  FROM file_location_holds h JOIN file_locations l ON l.id=h.location_id JOIN storage_profiles p ON p.id=l.storage_profile_id
  JOIN file_location_publications lp ON lp.location_id=l.id WHERE h.operation_id=? ORDER BY h.location_id`;
const originalHolds=(target:Target,id:string)=>target.readRows(holdSql,["fp5-backup:"+id]);
const nativeJob=(target:Target,id:string)=>target.readRows("SELECT state,phase,reason,generation,owner_token,runtime_incarnation,artifact_key,result_json FROM system_recovery_jobs WHERE id=?",[id]);
async function prepareOriginalTarget(pair:GenuineR2Pair,input:Awaited<ReturnType<typeof retainedInput>>){
  const target=pair.recoveryTarget;ensure(target,"actual_target");
  expect((await pair.request("/api/system-recovery/jobs","GET",undefined,{},"reader")).response.status).toBe(403);
  expect((await pair.request("/api/system-recovery/jobs","GET",undefined,{},"none")).response.status).toBe(403);
  expect(await target.readRows("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN('_cf_KV','_cf_METADATA')")).toEqual([]);
  const archive=await validateV28SystemBackupArchiveCandidate(await nodeRecoveryArchiveSource(input.archive),
    {...NODE_RECOVERY_ARCHIVE_OPTIONS,expectedSha256:input.expectedSha256});
  expect(archive.format).toBe("v5");expect(archive.manifest.completeness).toBe("complete");expect(archive.manifest.files).toHaveLength(1);
  const profile=(await activateR2PackagePeer(pair)).profileId;
  const caps=checkedSystemRecoveryCapabilities(await json(pair,"/api/system-recovery/executor","POST",{enabled:true}));
  expect(caps).toMatchObject({supported:true,canManage:true,enabled:true,cadenceSeconds:120,maxStepMs:60000,target:{configured:true,id:target.id,mode:"fresh"}});
  const upload=checkedSystemRecoveryReceipt(await json(pair,"/api/system-recovery/uploads","POST",
    {requestId:randomUUID(),byteSize:input.bytes.byteLength,sha256:input.expectedSha256},202));
  const put=await pair.request("/api/system-recovery/jobs/"+upload.job.id+"/upload","PUT",Uint8Array.from(input.bytes).buffer,
    {"content-type":"application/zip","content-length":String(input.bytes.byteLength)});
  expect(put.response.status).toBe(200);await complete(pair,checkedSystemRecoveryJobStatus(pairJson(put.value)),"preview");
  const recovery=checkedSystemRecoveryReceipt(await json(pair,"/api/system-recovery/recoveries","POST",{
    requestId:randomUUID(),uploadJobId:upload.job.id,expectedTargetId:target.id,
    mapping:[{sourceProfileId:archive.manifest.files[0]!.source.storageProfileId,destinationProfileId:profile,configurationRevision:1}],
    mode:"historical",acknowledgeLaterChanges:true,acknowledgePartial:false},202));
  const restored=await complete(pair,recovery.job,"completed");expect(restored.job.phase).toBe("ready");
  expect(restored.job.result).toMatchObject({targetId:target.id,ready:true,cutover:false});
  expect(restored.job.progress).toMatchObject({totalFiles:1,completedFiles:1,bytesDone:archive.manifest.files[0]!.byteSize});
  for(const name of ["file_authority_runtime_guard","file_shadow_runtime_guard","file_job_runtime_guard","system_recovery_runtime"])
    expect(await target.readRows('SELECT enabled FROM "'+name+'" WHERE singleton=1'),name).toEqual([{enabled:0}]);
  expect(await target.readRows("SELECT enforcement,schema_version FROM collaboration_control WHERE singleton=1")).toEqual([{enforcement:"disabled",schema_version:2}]);
  expect(await target.readRows("SELECT state FROM system_recovery_maintenance WHERE singleton=1")).toEqual([{state:"fenced"}]);
  expect(await target.readRows("SELECT count(*) n FROM local_accounts WHERE enabled<>0")).toEqual([{n:0}]);
  const evidence=await target.readRows("SELECT * FROM recovery_file_evidence");expect(evidence).toHaveLength(1);
  ensure(typeof evidence[0]?.object_key==="string","actual_native_key");const native=await pair.readObject(evidence[0].object_key);
  expect(hash(new Uint8Array(native.bytes))).toBe(archive.manifest.files[0]!.sha256);expect(native.byteSize).toBe(archive.manifest.files[0]!.byteSize);
  const originalLocationTable=archive.records.image.tables.file_locations;ensure(originalLocationTable,"original_location_image");
  expect(originalLocationTable.rows).toHaveLength(1);const originalLocation=originalLocationTable.rows[0]!;
  function originalLocationText(column:string){const index=originalLocationTable.columns.indexOf(column),cell=originalLocation.cells[index];
    ensure(index>=0&&cell?.type==="text","original_location_cell");return cell.value;}
  const beforeSourceRows=await target.readRows(`SELECT l.id AS location_id,l.file_id,l.storage_profile_id,l.object_key,
    p.adapter_type,p.configuration_revision,lp.verified_byte_size,lp.verified_sha256
    FROM file_location_publications lp JOIN file_location_availability a ON a.location_id=lp.location_id
    JOIN file_locations l ON l.id=lp.location_id JOIN storage_profiles p ON p.id=l.storage_profile_id
    WHERE a.availability='available' ORDER BY l.id`);
  expect(beforeSourceRows).toHaveLength(2);const protectedLocal=beforeSourceRows.filter(row=>row.adapter_type==="local"),canonicalR2=beforeSourceRows.filter(row=>row.adapter_type==="r2");
  expect(protectedLocal).toHaveLength(1);expect(canonicalR2).toHaveLength(1);
  expect(protectedLocal[0]).toMatchObject({location_id:originalLocationText("id"),file_id:originalLocationText("file_id"),
    storage_profile_id:originalLocationText("storage_profile_id"),object_key:originalLocationText("object_key"),
    verified_byte_size:archive.manifest.files[0]!.byteSize,verified_sha256:archive.manifest.files[0]!.sha256});
  expect(canonicalR2[0]).toMatchObject({location_id:evidence[0].location_id,file_id:evidence[0].destination_file_id,
    storage_profile_id:profile,object_key:evidence[0].object_key,configuration_revision:1,
    verified_byte_size:archive.manifest.files[0]!.byteSize,verified_sha256:archive.manifest.files[0]!.sha256});
  const enabled=checkedSystemRecoveryCapabilities(await json(target,"/api/system-recovery/executor","POST",{enabled:true}));
  expect(enabled).toMatchObject({enabled:true,canManage:true,cadenceSeconds:120,maxStepMs:60000,maintenance:{state:"fenced"}});
  return {target,beforeSourceRows,sourceIdentity:String((await pair.readRows("SELECT installation_id FROM system_recovery_runtime WHERE singleton=1"))[0]?.installation_id),
    targetIdentity:String((await target.readRows("SELECT installation_id FROM system_recovery_runtime WHERE singleton=1"))[0]?.installation_id)};
}
async function run(kind:WorkerV5OriginalIssueGate){
  const input=await retainedInput("NONEMPTY"),parent=process.env.WORKER_V5_NATIVE_FIXTURE_PARENT;
  ensure(parent&&isAbsolute(parent)&&resolve(parent)===parent&&await realpath(parent)===parent,"private_parent");
  const pair=await prepareGenuineCurrentV26R2Pair(parent,{fileEvidenceOperator:true,recoveryTargetId:"negative-v5-"+randomUUID(),originalIssueObserver:true});
  const target=pair.recoveryTarget,observer=target?.originalIssueObserver;ensure(target&&observer,"issued_native_observer");
  let failed=false,failure:unknown,sourceIdentity="",targetIdentity="",proof:Record<string,unknown>={};
  try{
    const prepared=await prepareOriginalTarget(pair,input);sourceIdentity=prepared.sourceIdentity;targetIdentity=prepared.targetIdentity;
    expect(targetIdentity).toMatch(/^[a-f0-9]{32}$/);expect(targetIdentity).not.toBe(sourceIdentity);
    const beforeObjects=(await pair.listObjects()).objects.map(value=>value.key).sort();
    const beforePublications=await target.readRows("SELECT * FROM file_publications ORDER BY file_id");
    const beforeTargets=await target.readRows("SELECT * FROM system_recovery_target_files ORDER BY job_id,logical_id");
    let jobId:string,outcome:string|null=null,responseStatus:number|null=null,originalInvocationSettled=false;
    let invocation:Promise<void>,startedAt=Date.now(),heldRows:Record<string,unknown>[]=[];
    if(kind==="namespace-actor"){
      const upload=checkedSystemRecoveryReceipt(await json(target,"/api/system-recovery/uploads","POST",
        {requestId:randomUUID(),byteSize:input.bytes.byteLength,sha256:input.expectedSha256},202));jobId=upload.job.id;
      await observer.control("arm",kind);startedAt=Date.now();
      invocation=observer.request("/api/system-recovery/jobs/"+jobId+"/upload","PUT",Uint8Array.from(input.bytes).buffer,
        {"content-type":"application/zip","content-length":String(input.bytes.byteLength)})
        .then(value=>{responseStatus=value.response.status;originalInvocationSettled=true;});
    }else{
      const backup=checkedSystemRecoveryReceipt(await json(target,"/api/system-recovery/jobs","POST",
        {requestId:randomUUID(),kind:"backup",mode:"historical"},202));jobId=backup.job.id;
      await target.schedule();const snapshotted=checkedSystemRecoveryJobStatus(await json(target,"/api/system-recovery/jobs/"+jobId));
      expect(snapshotted).toMatchObject({state:"queued",phase:"inventory",progress:{totalFiles:1,completedFiles:0}});
      heldRows=await originalHolds(target,jobId);expect(heldRows).toHaveLength(2);expect(new Set(heldRows.map(row=>row.id)).size).toBe(2);
      for(let index=0;index<heldRows.length;index++){
        expect(heldRows[index]).toMatchObject({...prepared.beforeSourceRows[index],hold_kind:"export",operation_id:"fp5-backup:"+jobId,
          reason:"Frozen system backup source",acquired_at:backup.job.acceptedAt,expires_at:null,released_at:null});
        expect(heldRows[index]?.id).toMatch(/^fp5_[a-f0-9]{32}$/);
      }
      await observer.control("arm",kind);startedAt=Date.now();
      invocation=observer.scheduleOutcome().then(value=>{outcome=value;originalInvocationSettled=true;});
    }
    void invocation.catch(()=>undefined); // Retain same original failure in pair owner; never fabricate ACK.
    const entered=await waitFor(()=>stats(observer),value=>Boolean(value.gate?.entered&&value.gate.originalAcknowledged
      &&value.gate.deliveryIoStarted&&value.deliveryIo?.acceptedRequests===1),15_000);
    ensure(entered.gate?.enteredAt!==null&&entered.gate?.enteredAt!==undefined,"actual_entered_clock");
    expect(entered.gate.kind).toBe(kind);expect(entered.gate.released).toBe(false);expect(entered.nativePut).toBe(0);expect(originalInvocationSettled).toBe(false);
    expect(entered.gate.deliveryIoAcknowledged).toBe(false);
    expect(entered.deliveryIo).toMatchObject({acceptedRequests:1,acknowledgedResponses:0,released:false,responseFinishedAt:null});
    ensure(entered.deliveryIo?.acceptedAt!==null&&entered.deliveryIo?.acceptedAt!==undefined,'actual_private_http_arrival');
    expect(entered.deliveryIo.acceptedAt).toBeGreaterThanOrEqual(entered.gate.enteredAt);
    expect(entered.deliveryIo.acceptedAt-startedAt).toBeLessThan(60000);
    const actualRunning=(await nativeJob(target,jobId))[0];expect(actualRunning).toMatchObject({state:"running",artifact_key:null,result_json:null});
    ensure(actualRunning&&typeof actualRunning.generation==="number"&&Number.isSafeInteger(actualRunning.generation),"actual_original_generation");
    if(kind==="held-original-ack"){
      expect(entered.nativeGet).toBe(1);expect(entered.readers).toBe(1);expect(entered.originalCancelCalls).toBe(0);
      // REAL wall time only. Raw D1 ACK was already recorded. Genuine private
      // HTTP I/O now delays delivery of that SAME original value to the
      // application strictly beyond the actual unchanged 60000ms kernel limit.
      await waitFor(()=>stats(observer),value=>Boolean(value.gate?.enteredAt&&Date.now()-value.gate.enteredAt>=61_000),65_000);
      const paused=await waitFor(()=>nativeJob(target,jobId),rows=>rows[0]?.state==="paused",5000);
      expect(paused[0]).toMatchObject({state:"paused",phase:"inventory",reason:"execution_budget_exhausted",owner_token:null,runtime_incarnation:null,artifact_key:null,result_json:null});
      expect(Number(paused[0]?.generation)).toBe(Number(actualRunning.generation)+1);
      expect(originalInvocationSettled).toBe(false);const held=await stats(observer);
      expect(held.gate).toMatchObject({released:false,originalAcknowledged:true,deliveryIoStarted:true,deliveryIoAcknowledged:false,returnedAt:null});
      expect(held.deliveryIo).toMatchObject({acceptedRequests:1,acknowledgedResponses:0,released:false,responseFinishedAt:null});
      expect(held.deliveryIo?.acceptedAt).toBe(entered.deliveryIo.acceptedAt);
      expect(held.originalCancelCalls).toBe(1);expect(held.originalCancelAcknowledged).toBe(1);expect(held.originalCancelRejected).toBe(0);
      expect(held.originalReaderClosedAcknowledged).toBe(1);expect(held.originalReaderClosedRejected).toBe(0);
      expect(issueCounts(held)).toEqual(issueCounts(entered));
    }else{
      if(kind==="profile-actor"){expect(entered.nativeGet).toBe(0);expect(entered.readers).toBe(0);}
      await observer.control("revoke-administrator");
      expect((await target.request("/api/system-recovery/jobs")).response.status).toBe(403);
      expect(await stats(observer)).toMatchObject({actorRevoked:true});expect(originalInvocationSettled).toBe(false);
    }
    await observer.control("release");await invocation;
    const after=await stats(observer);expect(after.gate).toMatchObject({entered:true,originalAcknowledged:true,released:true,deliveryIoStarted:true,deliveryIoAcknowledged:true});
    expect(after.deliveryIo).toMatchObject({acceptedRequests:1,acknowledgedResponses:1,released:true});
    ensure(after.deliveryIo?.responseFinishedAt!==null&&after.deliveryIo?.responseFinishedAt!==undefined,'actual_private_http_ack');
    expect(after.deliveryIo.responseFinishedAt).toBeGreaterThanOrEqual(entered.deliveryIo.acceptedAt);
    expect(issueCounts(after)).toEqual(issueCounts(entered));expect(after.nativePut).toBe(0);expect(after.nativeDelete).toBe(0);
    if(kind==="held-original-ack"){
      ensure(after.gate?.returnedAt!==null&&after.gate?.returnedAt!==undefined,"late_original_return_clock");
      expect(after.gate.returnedAt-entered.gate.enteredAt).toBeGreaterThanOrEqual(61_000);
      expect(after.deliveryIo.responseFinishedAt-entered.gate.enteredAt).toBeGreaterThanOrEqual(61_000);
      // The original abortable stream's cached logical close rejects. Preserve
      // the actual SDK exception/quarantine; raw reader ACK does not certify it.
      expect(outcome).toBe("exception");expect(after.originalCancelCalls).toBe(1);expect(after.originalCancelAcknowledged).toBe(1);
    }else{
      expect(after.actorRevoked).toBe(true);if(kind==="namespace-actor")expect(responseStatus).toBe(409);else expect(outcome).toBe("ok");
      await observer.control("restore-administrator");
    }
    const final=(await nativeJob(target,jobId))[0];expect(final).toMatchObject({state:"paused",reason:kind==="held-original-ack"?"execution_budget_exhausted":"administrator_revoked",
      owner_token:null,runtime_incarnation:null,artifact_key:null,result_json:null});
    expect(Number(final?.generation)).toBe(Number(actualRunning.generation)+1);
    const publicStatus=checkedSystemRecoveryJobStatus(await json(target,"/api/system-recovery/jobs/"+jobId));
    expect(publicStatus).toMatchObject({state:"paused",output:null,result:null});
    expect((await target.request("/api/system-recovery/jobs/"+jobId+"/report")).response.status).toBe(404);
    expect(await target.readRows("SELECT * FROM file_publications ORDER BY file_id")).toEqual(beforePublications);
    expect(await target.readRows("SELECT * FROM system_recovery_target_files ORDER BY job_id,logical_id")).toEqual(beforeTargets);
    expect((await pair.listObjects()).objects.map(value=>value.key).sort()).toEqual(beforeObjects);
    if(kind!=="namespace-actor"){
      await json(target,"/api/system-recovery/jobs/"+jobId+"/control","POST",{action:"cleanup"},409);
      expect(await originalHolds(target,jobId)).toEqual(heldRows);
      expect(await target.readRows("SELECT outcome FROM system_recovery_files WHERE job_id=?",[jobId])).toEqual([{outcome:"pending"}]);
    }
    await pair.verifyNativeDatabaseConsistency();await target.verifyNativeDatabaseConsistency();
    expect(hash(await readFile(input.archive))).toBe(input.expectedSha256);expect(hash(await readFile(input.receiptPath))).toBe(input.receiptHash);await input.recheckProducer();
    proof={schema:"genuine-worker-v5-original-issue-negative/1",kind,actualProductionHandlerAndAccess:true,actualNativeAckReturnedUnchanged:true,
      actualRawNativeAckRecorded:true,actualOriginalAckDeliveryBarrier:'original-native-ack-delivery-http-io/1',
      actualPrivateHttpArrivedBeforeDeadline:entered.deliveryIo.acceptedAt-startedAt<60000,
      actualPrivateHttpResponseAcknowledged:true,
      actualLiveAdministratorPolicyRevoked:kind!=="held-original-ack",actualKernelDeadlineMs:60000,cadenceSeconds:120,elapsedCadenceQualified:false,
      fakeClock:false,permissionCallbackMock:false,newExecutor:false,registeredLogicalFirstClosePositive:false,
      registeredLogicalFirstCloseOutcome:kind==="held-original-ack"?"original-sdk-exception-quarantined":"not-independently-observed",
      originalScheduledOutcome:outcome,originalHttpStatus:responseStatus,originalInvocationSettled:true,elapsedOriginalInvocationMs:Date.now()-startedAt,
      noLaterProviderIssue:true,noExtraPut:true,noPublication:true,holdsRetained:kind!=="namespace-actor",originalAvailableLocationInventory:2,
      exactOriginalProtectedLocalAndCanonicalR2HoldIdsRetained:kind!=="namespace-actor",nativeObservation:after};
  }catch(error){failed=true;failure=error;}
  // The SAME optional observer stop revokes admission/releases its exact held
  // query, then original close joins original work before Miniflare.dispose.
  // Original failures remain aggregated; no database, ZIP or quarantine removal.
  try{const original=pair.close();expect(pair.close()).toBe(original);await original;}catch(cleanup){throw failed?new AggregateError([failure,cleanup],"Original native issue negative and first fixture close failed"):cleanup;}
  if(failed)throw failure;
  const sourceClosed=pair.closedDatabaseConsistency(),targetClosed=target.closedDatabaseConsistency();
  expect(sourceClosed.databaseSha256Before).toBe(sourceClosed.databaseSha256After);expect(targetClosed.databaseSha256Before).toBe(targetClosed.databaseSha256After);
  await verifyClosedNativeD1(join(pair.root,"d1"),{source:sourceIdentity,target:targetIdentity},join(pair.root,"closed-native-file-consistency.json"));
  await writeFile(join(pair.root,"original-v5-issue-negative-receipt.json"),JSON.stringify({...proof,
    originalFixtureFirstCloseAcknowledged:true,originalNativeDisposed:true,sourceFullIntegrity:"ok",targetFullIntegrity:"ok"})+"\n",{flag:"wx",mode:0o600});
}
it(titles[0],()=>run("namespace-actor"),120_000);
it(titles[1],()=>run("profile-actor"),120_000);
it(titles[2],()=>run("held-original-ack"),180_000);
