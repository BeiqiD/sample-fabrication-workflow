import { expect,it } from "vitest";
import { createHash,randomUUID } from "node:crypto";
import { lstat,readFile,readdir,realpath,writeFile } from "node:fs/promises";
import { isAbsolute,join,resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { prepareGenuineCurrentV26R2Pair,pairJson,type GenuineR2Pair,type WorkerV5OriginalIssueObserver,
  type WorkerV5OriginalIssueGate } from "../../server/recovery/current-v26-r2-node-pair.qualification-support";
import { activateR2PackagePeer } from "../../server/packages/public-r2-node-pair.qualification-support";
import { checkedSystemRecoveryCapabilities,checkedSystemRecoveryJobStatus,checkedSystemRecoveryReceipt,
  checkedSystemRecoveryMaintenanceReceipt,checkedSystemRecoveryMaintenanceStatus,type SystemRecoveryJobStatus } from "../../shared/contracts/system-recovery";
import { PORTABLE_RUNTIME_RECOVERY_TABLES as V28_TABLES } from "../../shared/contracts/portable-runtime-v28-recovery-catalog";
import { recoveryTableSnapshotSql,type RecoveryTableSpec,type SystemRecoveryRow } from "../../shared/contracts/system-recovery-image";
import { stableJson } from "../../shared/domain/content-addressing";
import { validateV28SystemBackupArchiveCandidate } from "../../shared/contracts/system-backup-v5-archive-admission";
import { NODE_RECOVERY_ARCHIVE_OPTIONS,nodeRecoveryArchiveSource } from "../lib/system-backup-node-io";
import { retainedInput } from "./worker-v5-original-issue-negative.qualification-support";
const hash=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");
const TITLE="restores a genuine planned V5 R2 source into a third native D1 only while its original source window and complete close owners remain current";
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error("worker_v5_original_negative_" + reason); }
function object(value: unknown): Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value), "object"); return value as Record<string, unknown>;
}
type Port = Pick<GenuineR2Pair, "request" | "schedule" | "readRows">;
interface Trace {
  nativeGet: number; nativeHead: number; nativePut: number; nativeDelete: number; readers: number;
  originalCancelCalls: number; originalCancelAcknowledged: number; originalCancelRejected: number;
  originalReaderClosedAcknowledged: number; originalReaderClosedRejected: number; actorRevoked: boolean;
  gate: null | { kind: WorkerV5OriginalIssueGate; entered: boolean; originalAcknowledged: boolean;
    released: boolean; enteredAt: number | null; returnedAt: number | null };
}
function count(value: unknown): number { ensure(typeof value==="number"&&Number.isSafeInteger(value)&&value>=0,"actual_observation_count");return value; }
function clock(value: unknown): number | null { if(value===null)return null;return count(value); }
async function stats(observer: WorkerV5OriginalIssueObserver): Promise<Trace> {
  const value=object(await observer.control("stats"));ensure(typeof value.actorRevoked==="boolean","actual_policy_observation");
  let gate: Trace["gate"]=null;
  if(value.gate!==null){const item=object(value.gate);
    ensure(item.kind==="namespace-actor"||item.kind==="profile-actor"||item.kind==="held-original-ack","closed_gate_kind");
    ensure(typeof item.entered==="boolean"&&typeof item.originalAcknowledged==="boolean"&&typeof item.released==="boolean","original_gate_observation");
    gate={kind:item.kind,entered:item.entered,originalAcknowledged:item.originalAcknowledged,released:item.released,
      enteredAt:clock(item.enteredAt),returnedAt:clock(item.returnedAt)};
  }
  return {nativeGet:count(value.nativeGet),nativeHead:count(value.nativeHead),nativePut:count(value.nativePut),nativeDelete:count(value.nativeDelete),
    readers:count(value.readers),originalCancelCalls:count(value.originalCancelCalls),originalCancelAcknowledged:count(value.originalCancelAcknowledged),
    originalCancelRejected:count(value.originalCancelRejected),originalReaderClosedAcknowledged:count(value.originalReaderClosedAcknowledged),
    originalReaderClosedRejected:count(value.originalReaderClosedRejected),actorRevoked:value.actorRevoked,gate};
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
const closeSql="SELECT name,ordinal,chunk FROM system_recovery_metadata_chunks WHERE job_id=? AND name GLOB 'v5-original-source-close/1:*' ORDER BY name,ordinal LIMIT 513";
const maintenanceSql="SELECT * FROM system_recovery_maintenance WHERE singleton=1";
const holdsSql="SELECT * FROM file_location_holds ORDER BY id";
const legacySql="SELECT CAST(rowid AS TEXT) AS original_rowid,* FROM system_recovery_legacy_holds ORDER BY job_id,store_kind,provider,object_key";
async function maintenance(port:Port,action:"enter"|"finalize"|"release",generation:number,status=200,requestId=randomUUID()){
  const result=await json(port,"/api/system-recovery/maintenance","POST",{requestId,action,expectedGeneration:generation},status);
  return status===200?checkedSystemRecoveryMaintenanceReceipt(result):null;
}
async function allClosed(port:Port,id:string,actor:string,installation:string,acceptedAt:string){
  const rows=await port.readRows(closeSql,[id]);ensure(rows.length>0&&rows.length<=512,"original_close_inventory");
  const proofs=rows.map(row=>{
    ensure(typeof row.name==="string"&&row.ordinal===0&&typeof row.chunk==="string","original_close_native_row");
    const proof=object(JSON.parse(row.chunk));
    expect(Object.keys(proof).sort()).toEqual(["schema","jobId","actor","acceptedAt","sourceInstallationId","generation","ownerToken",
      "runtimeIncarnation","leaseExpiresAt","phase","ordinal","kind","resourceSha256","registeredAt","state","acknowledgedAt",
      "originalWorkFulfilled","originalAllCloseAcknowledged"].sort());
    expect(proof).toMatchObject({schema:"worker-v5-original-source-close/1",jobId:id,
      actor,acceptedAt,sourceInstallationId:installation,state:"acknowledged",originalWorkFulfilled:true,originalAllCloseAcknowledged:true});
    ensure(typeof proof.generation==="number"&&Number.isSafeInteger(proof.generation)&&proof.generation>0
      &&typeof proof.ownerToken==="string"&&typeof proof.ordinal==="number"&&typeof proof.registeredAt==="string"&&typeof proof.acknowledgedAt==="string","original_close_claim");
    expect(row.name).toBe("v5-original-source-close/1:"+proof.generation+":"+proof.ownerToken+":"+proof.ordinal);
    expect(Date.parse(proof.acknowledgedAt)).toBeGreaterThanOrEqual(Date.parse(proof.registeredAt));return proof;
  });
  return {rows,proofs};
}
async function typedRows(port:Port,spec:RecoveryTableSpec):Promise<SystemRecoveryRow[]>{
  return (await port.readRows(recoveryTableSnapshotSql(spec))).map(row=>{
    ensure((row.rowid===null||typeof row.rowid==="string")&&typeof row.cells==="string","typed_native_row");
    return {rowid:row.rowid,cells:JSON.parse(row.cells)};
  });
}
const typedKey=(spec:RecoveryTableSpec,row:SystemRecoveryRow)=>spec.withoutRowid
  ?stableJson((spec.primaryKeyColumns??spec.columns).map(name=>row.cells[spec.columns.indexOf(name)])):row.rowid;
async function run(){
  const input=await retainedInput("NONEMPTY"),parent=process.env.WORKER_V5_NATIVE_FIXTURE_PARENT;
  ensure(parent&&isAbsolute(parent)&&resolve(parent)===parent&&await realpath(parent)===parent,"private_parent");
  const pair=await prepareGenuineCurrentV26R2Pair(parent,{fileEvidenceOperator:true,recoveryTargetId:"planned-source-"+randomUUID(),
    plannedRecoveryTargetId:"planned-fresh-"+randomUUID(),originalIssueObserver:true});
  const source=pair.recoveryTarget,target=pair.plannedRecoveryTarget,observer=source?.originalIssueObserver;
  ensure(source&&target&&observer,"three_genuine_original_bindings");
  let failed=false,failure:unknown,originalInvocation:Promise<string>|undefined,invocationSettled=false;
  let bootstrapIdentity="",sourceIdentity="",targetIdentity="",proof:Record<string,unknown>={};
  try{
    const prepared=await prepareOriginalTarget(pair,input);bootstrapIdentity=prepared.sourceIdentity;sourceIdentity=prepared.targetIdentity;
    expect(sourceIdentity).toMatch(/^[a-f0-9]{32}$/);expect(sourceIdentity).not.toBe(bootstrapIdentity);
    await pair.verifyNativeDatabaseConsistency();await source.verifyNativeDatabaseConsistency();
    expect(await target.readRows("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN('_cf_KV','_cf_METADATA')")).toEqual([]);
    const profile=prepared.beforeSourceRows.find(row=>row.adapter_type==="r2")?.storage_profile_id;
    ensure(typeof profile==="string","original_canonical_profile");
    const profileBefore=await source.readRows("SELECT * FROM storage_profiles WHERE id=?",[profile]);
    const runtimeBefore=await source.readRows("SELECT * FROM storage_profile_runtime WHERE storage_profile_id=?",[profile]);
    expect(runtimeBefore).toHaveLength(1);expect(runtimeBefore[0]).toMatchObject({state:"read_only",activated_at:null,retired_at:null});
    const initial=checkedSystemRecoveryMaintenanceStatus(await json(source,"/api/system-recovery/maintenance"));
    expect(initial).toMatchObject({state:"fenced",generation:0,checkpoint:null,backupJobId:null,activeWriters:0});
    const opened=await maintenance(source,"release",0);ensure(opened,"initial_original_release");expect(opened.status).toMatchObject({state:"open",generation:1,token:null});
    const entered=await maintenance(source,"enter",1);ensure(entered,"original_enter");expect(entered.status).toMatchObject({state:"draining",generation:2});
    ensure(typeof entered.status.token==="string","original_window_token");
    const fenced=await maintenance(source,"finalize",2);ensure(fenced,"original_finalize");expect(fenced.status).toMatchObject({state:"fenced",generation:2,token:entered.status.token,activeWriters:0});
    const backup=checkedSystemRecoveryReceipt(await json(source,"/api/system-recovery/jobs","POST",{requestId:randomUUID(),kind:"backup",mode:"planned"},202));
    const admittedBackup=await source.readRows("SELECT input_json,checkpoint_json FROM system_recovery_jobs WHERE id=?",[backup.job.id]);
    const backupReservation=await source.readRows("SELECT name,ordinal,chunk FROM system_recovery_metadata_chunks WHERE job_id=? AND name='v5-planned-backup-window/1'",[backup.job.id]);
    expect(backupReservation).toHaveLength(1);ensure(typeof backupReservation[0]?.chunk==="string","real_backup_reservation");
    expect(JSON.parse(backupReservation[0].chunk)).toEqual({schema:"worker-v5-planned-backup-window/1",sourceInstallationId:sourceIdentity,
      maintenanceGeneration:2,maintenanceToken:entered.status.token,backupId:backup.job.id});
    expect(JSON.parse(String(admittedBackup[0]?.input_json)).mode).toBe("planned");
    const queuedWindow=await source.readRows(maintenanceSql);await maintenance(source,"release",2,409);expect(await source.readRows(maintenanceSql)).toEqual(queuedWindow);
    await source.schedule();let current=checkedSystemRecoveryJobStatus(await json(source,"/api/system-recovery/jobs/"+backup.job.id));
    expect(current).toMatchObject({state:"queued",phase:"inventory"});
    await observer.control("arm","held-original-ack");
    originalInvocation=observer.scheduleOutcome();void originalInvocation.then(()=>{invocationSettled=true;},()=>{invocationSettled=true;});
    const held=await waitFor(()=>stats(observer),value=>Boolean(value.gate?.entered&&value.gate.originalAcknowledged),10_000);
    expect(held.nativeGet).toBe(1);expect(held.nativePut).toBe(0);expect(held.readers).toBe(1);expect(held.originalCancelAcknowledged).toBe(0);expect(invocationSettled).toBe(false);
    // SDK3 prerequisite: there must be actual outstanding Native HTTP I/O,
    // not only an isolate-local JavaScript waiter or a synthetic SQL value.
    const delivered=await waitFor(()=>observer.control("stats"),value=>{
      const io=object(object(value).deliveryIo);return io.acceptedRequests===1;
    },10_000);
    expect(object(object(delivered).deliveryIo)).toMatchObject({schema:"original-native-ack-delivery-http-io/1",acceptedRequests:1,acknowledgedResponses:0,released:false});
    const pendingJob=await source.readRows("SELECT state,phase,generation,owner_token FROM system_recovery_jobs WHERE id=?",[backup.job.id]);
    expect(pendingJob[0]).toMatchObject({state:"running",phase:"inventory"});
    const pendingClose=await source.readRows(closeSql,[backup.job.id]);
    expect(pendingClose.map(row=>object(JSON.parse(String(row.chunk)))).some(row=>row.kind==="body"&&row.state==="unproven"&&row.originalAllCloseAcknowledged!==true)).toBe(true);
    const heldWindow=await source.readRows(maintenanceSql),heldHolds=await source.readRows(holdsSql);
    await maintenance(source,"release",2,409);expect(await source.readRows(maintenanceSql)).toEqual(heldWindow);expect(await source.readRows(holdsSql)).toEqual(heldHolds);
    await json(source,"/api/system-recovery/jobs/"+backup.job.id+"/control","POST",{action:"cleanup"},409);
    expect((await stats(observer)).nativePut).toBe(0);expect(invocationSettled).toBe(false);
    await observer.control("release");expect(await originalInvocation).toBe("ok");expect(invocationSettled).toBe(true);
    const deliveredAfter=object(object(await observer.control("stats")).deliveryIo);
    expect(deliveredAfter).toMatchObject({acceptedRequests:1,acknowledgedResponses:1,released:true});
    ensure(typeof deliveredAfter.acceptedAt==="number"&&typeof deliveredAfter.responseFinishedAt==="number","original_http_ack_clock");
    expect(deliveredAfter.responseFinishedAt-deliveredAfter.acceptedAt).toBeLessThan(60_000);
    current=checkedSystemRecoveryJobStatus(await json(source,"/api/system-recovery/jobs/"+backup.job.id));
    expect(current).toMatchObject({state:"queued",phase:"measure"});
    const captured=await complete(source,current,"completed");ensure(captured.job.output?.available,"original_planned_backup_output");
    const downloaded=await source.request("/api/system-recovery/jobs/"+backup.job.id+"/download");expect(downloaded.response.status).toBe(200);
    ensure(downloaded.value instanceof ArrayBuffer,"actual_planned_archive_bytes");const archiveSha=hash(new Uint8Array(downloaded.value));
    expect(archiveSha).toBe(captured.job.output.sha256);expect(downloaded.value.byteLength).toBe(captured.job.output.byteSize);
    const archive=join(pair.root,"original-public-planned-held-v5.zip");await writeFile(archive,new Uint8Array(downloaded.value),{flag:"wx",mode:0o600});
    const admitted=await validateV28SystemBackupArchiveCandidate(await nodeRecoveryArchiveSource(archive),{...NODE_RECOVERY_ARCHIVE_OPTIONS,expectedSha256:archiveSha});
    expect(admitted.format).toBe("v5");expect(admitted.manifest.completeness).toBe("complete");expect(admitted.manifest.files).toHaveLength(1);
    expect(admitted.records.origin).toEqual({format:"native",schemaVersion:28,capturePolicy:"atomic-primary-with-byte-holds/1"});
    const originalHeads=admitted.records.image.tables.file_shadow_heads;ensure(originalHeads,"original_head_inventory");
    const presentColumn=originalHeads.columns.indexOf("present");ensure(presentColumn>=0,"original_present_column");
    expect(originalHeads.rows.every(row=>{const cell=row.cells[presentColumn];return cell?.type==="integer"&&cell.value==="0";})).toBe(true);
    const member=admitted.manifest.files[0]!;expect(member.source).toMatchObject({storeKind:"r2",provider:"r2",byteAuthority:"file_location",storageProfileId:profile});
    const archiveSourceIdentity=admitted.manifest.sourceInstallationId;
    expect(archiveSourceIdentity).toBe(admitted.records.content.tables.research_package_source_identity[0]?.installation_id);
    expect(archiveSourceIdentity).not.toBe(sourceIdentity); // Independent actual runtime and research lineage.
    const checkpointWindow=checkedSystemRecoveryMaintenanceStatus(await json(source,"/api/system-recovery/maintenance"));
    expect(checkpointWindow).toMatchObject({state:"fenced",generation:2,token:entered.status.token,checkpoint:admitted.manifest.sourceCheckpoint,backupJobId:backup.job.id,activeWriters:0});
    const backupClose=await allClosed(source,backup.job.id,pair.actor,sourceIdentity,backup.job.acceptedAt);
    expect(backupClose.rows).toHaveLength(6);expect(backupClose.proofs.map(row=>row.kind).sort()).toEqual(["body","body","body","body","put","snapshot"]);
    const originalHolds=await source.readRows("SELECT * FROM file_location_holds WHERE operation_id=? ORDER BY id",["fp5-backup:"+backup.job.id]);
    expect(originalHolds).toHaveLength(2);expect(originalHolds.every(row=>row.released_at===null)).toBe(true);
    const uploadInput={requestId:randomUUID(),byteSize:downloaded.value.byteLength,sha256:archiveSha};
    const upload=checkedSystemRecoveryReceipt(await json(source,"/api/system-recovery/uploads","POST",uploadInput,202));
    const put=await source.request("/api/system-recovery/jobs/"+upload.job.id+"/upload","PUT",Uint8Array.from(new Uint8Array(downloaded.value)).buffer,
      {"content-type":"application/zip","content-length":String(downloaded.value.byteLength)});expect(put.response.status).toBe(200);
    const validated=await complete(source,checkedSystemRecoveryJobStatus(pairJson(put.value)),"preview");expect(validated.job.phase).toBe("validate");
    const importInput={requestId:randomUUID(),uploadJobId:upload.job.id,expectedTargetId:target.id,
      mapping:[{sourceProfileId:profile,destinationProfileId:profile,configurationRevision:1}],mode:"planned",acknowledgeLaterChanges:false,acknowledgePartial:false};
    const accepted=checkedSystemRecoveryReceipt(await json(source,"/api/system-recovery/recoveries","POST",importInput,202));
    const originalRecovery=await source.readRows("SELECT * FROM system_recovery_jobs WHERE id=?",[accepted.job.id]);
    ensure(typeof originalRecovery[0]?.checkpoint_json==="string","original_planned_recovery_checkpoint");
    const sourceWindow=object(JSON.parse(originalRecovery[0].checkpoint_json));
    expect(sourceWindow).toEqual({schema:"worker-v5-planned-source-window/1",sourceInstallationId:sourceIdentity,archiveSourceInstallationId:archiveSourceIdentity,
      maintenanceGeneration:2,maintenanceToken:entered.status.token,checkpoint:admitted.manifest.sourceCheckpoint,backupId:backup.job.id,
      backupGeneration:(await source.readRows("SELECT generation FROM system_recovery_jobs WHERE id=?",[backup.job.id]))[0]?.generation,
      backupActor:pair.actor,backupAcceptedAt:backup.job.acceptedAt,archiveSha256:archiveSha,archiveByteSize:downloaded.value.byteLength,
      uploadId:upload.job.id,uploadAcceptedAt:upload.job.acceptedAt});
    expect(await source.readRows("SELECT name,ordinal,chunk FROM system_recovery_metadata_chunks WHERE job_id=? AND name='v5-planned-source-window/1'",[accepted.job.id]))
      .toEqual([{name:"v5-planned-source-window/1",ordinal:0,chunk:originalRecovery[0].checkpoint_json}]);
    const acceptedWindow=await source.readRows(maintenanceSql);await maintenance(source,"release",2,409);expect(await source.readRows(maintenanceSql)).toEqual(acceptedWindow);
    await json(source,"/api/system-recovery/jobs/"+backup.job.id+"/control","POST",{action:"cleanup"},409);expect(await source.readRows(holdsSql)).toEqual(heldHolds);
    const replay=checkedSystemRecoveryReceipt(await json(source,"/api/system-recovery/recoveries","POST",importInput,202));expect(replay.job.id).toBe(accepted.job.id);expect(replay.reused).toBe(true);
    const restored=await complete(source,accepted.job,"completed");expect(restored.job).toMatchObject({phase:"ready",result:{targetId:target.id,ready:true,cutover:false}});
    const report=await json(source,"/api/system-recovery/jobs/"+accepted.job.id+"/report");
    expect(report).toMatchObject({mode:"planned",historicalLaterChangesLost:false,targetId:target.id,execution:{shadow:false,authority:false,fileJobs:false,recoveryJobs:false,cleanup:false,oldJobReplay:false},handoff:{automaticBindingChange:false,operatorRequired:true,sourceRetainedReadOnly:true}});
    await json(source,"/api/system-recovery/jobs/"+accepted.job.id+"/cutover","POST",{requestId:randomUUID(),expectedTargetId:target.id,expectedCheckpoint:restored.job.result?.checkpoint},409);
    expect(await source.readRows("SELECT * FROM storage_profiles WHERE id=?",[profile])).toEqual(profileBefore);
    expect(await source.readRows("SELECT * FROM storage_profile_runtime WHERE storage_profile_id=?",[profile])).toEqual(runtimeBefore);
    const newEvidence=await target.readRows("SELECT * FROM recovery_file_evidence WHERE backup_id=?",[backup.job.id]);expect(newEvidence).toHaveLength(1);
    ensure(typeof newEvidence[0]?.object_key==="string"&&typeof newEvidence[0].location_id==="string","actual_third_native_evidence");
    const bytes=await pair.readObject(newEvidence[0].object_key);expect(bytes.byteSize).toBe(member.byteSize);expect(hash(new Uint8Array(bytes.bytes))).toBe(member.sha256);
    const entry=admitted.entries.find(row=>row.path===member.path);ensure(entry,"original_archive_member");
    expect(hash(await (await nodeRecoveryArchiveSource(archive)).read(entry.dataOffset,entry.byteSize))).toBe(hash(new Uint8Array(bytes.bytes)));
    const appends:Record<string,number>={file_locations:1,file_location_publications:1,recovery_file_evidence:1,
      recovery_file_alias_evidence:admitted.records.content.tables.assets.filter(row=>row.file_id===member.fileIds[0]).length,
      recovery_file_binding_evidence:member.bindings.length,file_registry_rowid_claims:1};
    for(const spec of V28_TABLES.filter(spec=>!spec.local)){
      const original=admitted.records.image.tables[spec.name];ensure(original,"original_full_native_table");
      const remaining=new Map((await typedRows(target,spec)).map(row=>[typedKey(spec,row),row]));
      for(const row of original.rows){const observed=remaining.get(typedKey(spec,row));ensure(observed,"original_native_row:"+spec.name);remaining.delete(typedKey(spec,row));
        expect(observed.rowid).toBe(row.rowid);
        for(let index=0;index<spec.columns.length;index++){
          if(stableJson(observed.cells[index])===stableJson(row.cells[index]))continue;
          const cell=observed.cells[index];expect(spec.name==="file_publications"&&spec.columns[index]==="active_location_id"&&cell?.type==="text"&&cell.value===newEvidence[0].location_id,
            "Only canonical verified new publication cell "+spec.name+"."+spec.columns[index]).toBe(true);
        }
      }
      expect(remaining.size,"Exact closed new-row census "+spec.name).toBe(appends[spec.name]??0);
    }
    for(const name of ["file_authority_runtime_guard","file_shadow_runtime_guard","file_job_runtime_guard","system_recovery_runtime"])
      expect(await target.readRows('SELECT enabled FROM "'+name+'" WHERE singleton=1')).toEqual([{enabled:0}]);
    expect(await target.readRows("SELECT enforcement,schema_version,revision FROM collaboration_control WHERE singleton=1")).toEqual([{enforcement:"disabled",schema_version:2,revision:1}]);
    expect(await target.readRows("SELECT state FROM system_recovery_maintenance WHERE singleton=1")).toEqual([{state:"fenced"}]);
    for(const name of ["local_identity_installation","local_admin_grants","local_sessions","local_storage_profile_bindings","collaboration_members","collaboration_identities","collaboration_resources","collaboration_grants","system_recovery_jobs"])
      expect(await target.readRows('SELECT count(*) n FROM "'+name+'"')).toEqual([{n:0}]);
    expect(await target.readRows("SELECT count(*) n FROM local_accounts WHERE enabled<>0")).toEqual([{n:0}]);
    targetIdentity=String((await target.readRows("SELECT installation_id FROM system_recovery_runtime WHERE singleton=1"))[0]?.installation_id);
    expect(targetIdentity).toMatch(/^[a-f0-9]{32}$/);expect(new Set([bootstrapIdentity,sourceIdentity,targetIdentity]).size).toBe(3);
    const actualFinal=await source.readRows("SELECT generation,checkpoint_json,state,phase FROM system_recovery_jobs WHERE id=?",[accepted.job.id]);
    expect(actualFinal[0]).toMatchObject({state:"completed",phase:"ready",checkpoint_json:originalRecovery[0].checkpoint_json});
    const recoveryClose=await allClosed(source,accepted.job.id,pair.actor,sourceIdentity,accepted.job.acceptedAt);
    expect(recoveryClose.proofs.some(row=>row.kind==="recovery-step"&&row.generation===actualFinal[0]?.generation)).toBe(true);
    const backupFinal=await source.readRows("SELECT generation,checkpoint_json,artifact_key,archive_byte_size FROM system_recovery_jobs WHERE id=?",[backup.job.id]);
    const finalPut=backupClose.proofs.filter(row=>row.kind==="put"&&row.phase==="write"&&row.generation===backupFinal[0]?.generation);
    expect(finalPut).toHaveLength(1);expect(finalPut[0]?.resourceSha256).toBe(hash(stableJson({key:backupFinal[0]?.artifact_key,byteSize:backupFinal[0]?.archive_byte_size})));
    const releaseId=randomUUID(),released=await maintenance(source,"release",2,200,releaseId);ensure(released,"original_positive_release");
    expect(released.status).toMatchObject({state:"open",generation:3,token:null,checkpoint:null,backupJobId:null,activeWriters:0});
    for(const [jobId,kind,close,final] of [[backup.job.id,"backup",backupClose,backupFinal],[accepted.job.id,"recovery",recoveryClose,actualFinal]] as const){
      const retirement=await source.readRows("SELECT name,ordinal,chunk FROM system_recovery_metadata_chunks WHERE job_id=? AND name='v5-planned-original-retirement/1'",[jobId]);
      expect(retirement).toHaveLength(1);ensure(retirement[0]?.ordinal===0&&typeof retirement[0].chunk==="string"&&typeof final[0]?.checkpoint_json==="string","original_retirement_row");
      expect(JSON.parse(retirement[0].chunk)).toEqual({schema:"worker-v5-planned-original-retirement/1",jobId,jobKind:kind,actor:pair.actor,
        acceptedAt:kind==="backup"?backup.job.acceptedAt:accepted.job.acceptedAt,sourceInstallationId:sourceIdentity,
        checkpointSha256:hash(final[0].checkpoint_json),windowGeneration:2,windowToken:entered.status.token,finalGeneration:final[0].generation,
        proofCount:close.rows.length,proofSha256:hash(stableJson(close.rows)),releaseRequestId:releaseId,releaseActor:pair.actor});
    }
    const reentered=await maintenance(source,"enter",3);ensure(reentered,"new_actual_window");expect(reentered.status).toMatchObject({state:"draining",generation:4});
    expect(reentered.status.token).not.toBe(entered.status.token);await maintenance(source,"finalize",4);
    const beforeReplayObjects=(await pair.listObjects()).objects.map(row=>row.key).sort(),beforeReplayTarget=await target.readRows("SELECT * FROM system_recovery_target_files ORDER BY job_id,logical_id");
    await json(source,"/api/system-recovery/recoveries","POST",{...importInput,requestId:randomUUID()},409);
    const retiredReplay=checkedSystemRecoveryReceipt(await json(source,"/api/system-recovery/recoveries","POST",importInput,202));expect(retiredReplay.job.id).toBe(accepted.job.id);expect(retiredReplay.reused).toBe(true);
    expect((await pair.listObjects()).objects.map(row=>row.key).sort()).toEqual(beforeReplayObjects);expect(await target.readRows("SELECT * FROM system_recovery_target_files ORDER BY job_id,logical_id")).toEqual(beforeReplayTarget);
    const allHoldsBefore=await source.readRows(holdsSql),allLegacyBefore=await source.readRows(legacySql),originalIds=new Set(originalHolds.map(row=>row.id));
    expect(allHoldsBefore.filter(row=>originalIds.has(row.id))).toEqual(originalHolds);
    await json(source,"/api/system-recovery/jobs/"+backup.job.id+"/control","POST",{action:"cleanup"},200);
    const allHoldsAfter=await source.readRows(holdsSql);expect(allHoldsAfter).toHaveLength(allHoldsBefore.length);
    expect(allHoldsAfter).toEqual(allHoldsBefore.map(row=>{
      if(!originalIds.has(row.id))return row;const released=allHoldsAfter.find(value=>value.id===row.id);
      ensure(released&&typeof released.released_at==="string"&&Number.isFinite(Date.parse(released.released_at)),"positive_exact_original_release");
      expect({...released,released_at:null}).toEqual(row);return {...row,released_at:released.released_at};
    }));
    expect(await source.readRows(legacySql)).toEqual(allLegacyBefore);expect(await source.readRows(closeSql,[backup.job.id])).toEqual(backupClose.rows);
    expect(await source.readRows(closeSql,[accepted.job.id])).toEqual(recoveryClose.rows);
    await pair.verifyNativeDatabaseConsistency();await source.verifyNativeDatabaseConsistency();await target.verifyNativeDatabaseConsistency();
    expect(hash(await readFile(input.archive))).toBe(input.expectedSha256);expect(hash(await readFile(input.receiptPath))).toBe(input.receiptHash);await input.recheckProducer();
    proof={schema:"genuine-access-public-v5-planned-three-original-d1/1",authenticatedProductionPublicHandler:true,nativeD1s:3,
      sameWindowPlannedBackupAndRecovery:true,distinctRuntimeAndArchiveResearchIdentity:true,sourceCanonicalR2RemainedReadOnly:true,
      realOriginalNativeAckAndPendingHttpIo:true,pendingOriginalBodyPreventsWindowRelease:true,queuedOwnersPreventWindowRelease:true,
      positiveOriginalLogicalAllCloseRequired:true,backupOriginalCloseRecords:backupClose.rows.length,recoveryOriginalCloseRecords:recoveryClose.rows.length,
      actualFinalJobGenerationProofs:true,actualOriginalReleaseRetirements:2,reenteredOldArchiveRefused:true,acceptedRequestReplayIssuesNothing:true,
      fullOriginalTypedRowsAndRowids:true,closedNewAppendCensus:true,exactNativeR2Bytes:true,inertTarget:true,automaticCutover:false,
      original2HoldsReleasedOnlyAfterRetirement:true,allOtherLocationAndLegacyRowsUnchanged:true,originalRecoveryScheduledCalls:restored.originalScheduledCalls,
      cadenceSeconds:120,maxStepMs:60000,elapsedCadenceQualified:false,caseMs:240000,outerSeconds:300};
  }catch(error){failed=true;failure=error;}
  // Owner's exact first close releases actual HTTP before joining SDK/outbound
  // and disposes all three original D1s. A rejected work/close stays failed.
  try{const closing=pair.close();expect(pair.close()).toBe(closing);await closing;}
  catch(cleanup){throw failed?new AggregateError([failure,cleanup],"Original planned V5 work and first close failed"):cleanup;}
  if(originalInvocation)await originalInvocation;
  if(failed)throw failure;
  const closed=[pair.closedDatabaseConsistency(),source.closedDatabaseConsistency(),target.closedDatabaseConsistency()];
  for(const row of closed)expect(row.databaseSha256Before).toBe(row.databaseSha256After);
  await verifyThreeClosedNativeD1(join(pair.root,"d1"),[bootstrapIdentity,sourceIdentity,targetIdentity],join(pair.root,"closed-three-native-file-consistency.json"));
  await writeFile(join(pair.root,"original-public-v5-planned-three-d1-receipt.json"),JSON.stringify({...proof,originalPairFirstCloseAcknowledged:true,
    originalNativeDisposed:true,all3WholeIntegrityAndForeignKeys:true})+"\n",{flag:"wx",mode:0o600});
}
it(TITLE,run,240_000);

async function verifyThreeClosedNativeD1(directory: string, identities: readonly string[], receiptPath: string) {
  ensure(isAbsolute(directory) && resolve(directory) === directory && await realpath(directory) === directory, "closed_native_path");
  const entries = await readdir(directory, { recursive: true });
  const files = entries.filter(name => name.endsWith(".sqlite") && !name.endsWith("metadata.sqlite")).sort();
  expect(files, "Exactly the three original native D1 files must remain").toHaveLength(3);
  const before = new Map<string, { sha256: string; dev: number; ino: number; size: number }>();
  for (const name of entries.filter(name => /\.sqlite(?:-wal|-shm)?$/.test(name)).sort()) {
    const path = join(directory, name), stat = await lstat(path);
    ensure(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && await realpath(path) === path, "closed_native_file");
    before.set(name, { sha256: hash(await readFile(path)), dev: stat.dev, ino: stat.ino, size: stat.size });
  }
  const observed: string[] = [];
  for (const name of files) {
    const native = new DatabaseSync(join(directory, name), { readOnly: true });
    try {
      const identity = native.prepare("SELECT installation_id FROM system_recovery_runtime WHERE singleton=1").get();
      ensure(identity && typeof identity.installation_id === "string", "closed_native_identity");
      observed.push(identity.installation_id);
      expect(native.prepare("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
      expect(native.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { native.close(); }
  }
  expect(observed.sort()).toEqual([...identities].sort());
  const after = (await readdir(directory, { recursive: true })).filter(name => /\.sqlite(?:-wal|-shm)?$/.test(name)).sort();
  expect(after).toEqual([...before.keys()].sort());
  const observations: Array<{ name: string; kind: "durable-data" | "ephemeral-reader-coordination";
    beforeSha256: string; afterSha256: string; beforeSize: number; afterSize: number; dev: number; ino: number }> = [];
  for (const [name, expected] of before) {
    const path = join(directory, name), stat = await lstat(path);
    ensure(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && await realpath(path) === path
      && stat.dev === expected.dev && stat.ino === expected.ino, "closed_native_file_identity_changed");
    const afterSha256 = hash(await readFile(path)), ephemeral = name.endsWith(".sqlite-shm");
    if (!ephemeral) {
      expect(stat.size, "Read-only durable native file size changed: " + name).toBe(expected.size);
      expect(afterSha256, "Read-only durable native file changed: " + name).toBe(expected.sha256);
    }
    // WAL-index reader locks/read marks can change during a read-only SQLite
    // connection. They are coordination metadata, not durable database pages.
    // Record both hashes honestly while preserving the exact path/inode.
    observations.push({ name, kind: ephemeral ? "ephemeral-reader-coordination" : "durable-data",
      beforeSha256: expected.sha256, afterSha256, beforeSize: expected.size, afterSize: stat.size, dev: stat.dev, ino: stat.ino });
  }
  await writeFile(receiptPath, JSON.stringify({ schema: "closed-original-native-d1-readonly-consistency/1",
    originalNativeDisposed: true, installations: observed, wholeQuickCheck: true, wholeIntegrity: true, foreignKeys: true,
    durableMainAndWalUnchanged: true, physicalPathsAndInodesUnchanged: true, files: observations }, null, 2) + "\n",
  { flag: "wx", mode: 0o600 });
}
