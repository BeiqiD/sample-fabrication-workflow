import { expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { prepareGenuineCurrentV26R2Pair, pairJson, type GenuineR2Pair } from "../../server/recovery/current-v26-r2-node-pair.qualification-support";
import { activateR2PackagePeer } from "../../server/packages/public-r2-node-pair.qualification-support";
import { checkedSystemRecoveryCapabilities, checkedSystemRecoveryJobStatus, checkedSystemRecoveryPreview,
  checkedSystemRecoveryReceipt, type SystemRecoveryJobStatus } from "../../shared/contracts/system-recovery";
import { PORTABLE_RUNTIME_RECOVERY_TABLES as V28_TABLES } from "../../shared/contracts/portable-runtime-v28-recovery-catalog";
import { recoveryTableSnapshotSql as typedSnapshotSql, type RecoveryTableSpec, type SystemRecoveryRow } from "../../shared/contracts/system-recovery-image";
import { validateV28SystemBackupArchiveCandidate } from "../../shared/contracts/system-backup-v5-archive-admission";
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource } from "../lib/system-backup-node-io";
import { verifyNodeDistribution } from "../lib/node-distribution-v28-manifest.mjs";
import { runCurrentCli } from "../../server/operations/current-v28-backup-cli.qualification-support";
import { stableJson } from "../../shared/domain/content-addressing";
import { assertWorkerV5OriginalProducerInput } from "./worker-v5-original-producer-input";

const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PINNED_PRODUCER_HEAD = "62ac1d54dcfd2bff6381f2bbfbe4276df1bf3ddc";
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const titles = [
  "restores the original zero-File V5 archive through genuine Access public FP5 upload, jobs and inert report",
  "restores the original nonempty V5 through genuine Access public FP5 and recaptures held native R2 through a real backup job into fresh current Node",
] as const;
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error("worker_v5_public_" + reason); }
function object(value: unknown): Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value), "object"); return value as Record<string, unknown>;
}
type Port = Pick<GenuineR2Pair, "request" | "schedule" | "readRows">;
async function json(port: Port, path: string, method = "GET", input?: unknown, status = 200) {
  const answer = await port.request(path, method, input === undefined ? undefined : JSON.stringify(input),
    input === undefined ? {} : { "content-type": "application/json" });
  let label = method + " " + path;
  if (answer.response.status !== status) {
    const value = pairJson(answer.value);
    label += ": HTTP " + answer.response.status + "; public error="
      + JSON.stringify(typeof value.error === "string" ? value.error.slice(0,2048) : null);
  }
  expect(answer.response.status, label).toBe(status); return pairJson(answer.value);
}
async function complete(port: Port, initial: SystemRecoveryJobStatus, terminal: "preview" | "completed") {
  let job = initial, originalScheduledCalls = 0;
  for (; originalScheduledCalls < 100 && job.state !== terminal; originalScheduledCalls++) {
    await port.schedule(); job = checkedSystemRecoveryJobStatus(await json(port, "/api/system-recovery/jobs/" + job.id));
    expect(["queued", terminal], "Original public job state; reason=" + job.reason).toContain(job.state);
  }
  expect(job.state).toBe(terminal); return { job, originalScheduledCalls };
}
async function typed(port: Port, spec: RecoveryTableSpec) {
  const rows = await port.readRows(typedSnapshotSql(spec));
  return rows.map(row => { ensure((row.rowid===null||typeof row.rowid==="string")&&typeof row.cells==="string","typed_row");
    return { rowid:row.rowid,cells:JSON.parse(row.cells) } as SystemRecoveryRow; });
}
const key = (spec: RecoveryTableSpec, row: SystemRecoveryRow) => spec.withoutRowid
  ? stableJson((spec.primaryKeyColumns??spec.columns).map(name=>row.cells[spec.columns.indexOf(name)])) : row.rowid;
async function inert(port: Port, files: number) {
  for(const name of ["file_authority_runtime_guard","file_shadow_runtime_guard","file_job_runtime_guard","system_recovery_runtime"])
    expect(await port.readRows('SELECT enabled FROM "'+name+'" WHERE singleton=1'),name).toEqual([{enabled:0}]);
  expect(await port.readRows("SELECT state FROM system_recovery_maintenance WHERE singleton=1")).toEqual([{state:"fenced"}]);
  expect(await port.readRows("SELECT enforcement,schema_version,revision FROM collaboration_control WHERE singleton=1"))
    .toEqual([{enforcement:"disabled",schema_version:2,revision:1}]);
  for(const name of ["local_identity_installation","local_admin_grants","local_sessions","local_login_throttle",
    "local_storage_profile_bindings","local_storage_profile_checks","local_storage_profile_admissions",
    "collaboration_members","collaboration_identities","collaboration_resources","collaboration_grants",
    "system_storage_native_bindings","system_recovery_jobs"])
    expect(await port.readRows('SELECT count(*) n FROM "'+name+'"'),name).toEqual([{n:0}]);
  expect(await port.readRows("SELECT count(*) n FROM local_accounts WHERE enabled<>0")).toEqual([{n:0}]);
  expect(await port.readRows("SELECT count(*) n FROM system_recovery_target_files WHERE state='published'")).toEqual([{n:files}]);
}

async function run(kind: "ZERO" | "NONEMPTY") {
  const input = await retainedInput(kind), expectedFiles = kind === "ZERO" ? 0 : 1;
  const admitted = await validateV28SystemBackupArchiveCandidate(await nodeRecoveryArchiveSource(input.archive),
    {...NODE_RECOVERY_ARCHIVE_OPTIONS,expectedSha256:input.expectedSha256});
  expect(admitted.format).toBe("v5");expect(admitted.manifest.completeness).toBe("complete");expect(admitted.manifest.files).toHaveLength(expectedFiles);
  const parent = process.env.WORKER_V5_NATIVE_FIXTURE_PARENT;
  ensure(parent&&isAbsolute(parent)&&resolve(parent)===parent&&await realpath(parent)===parent,"private_parent");
  const pair=await prepareGenuineCurrentV26R2Pair(parent,{fileEvidenceOperator:true,recoveryTargetId:"public-v5-"+randomUUID()});
  const target=pair.recoveryTarget;ensure(target,"target_binding");
  let failed=false,failure:unknown,sourceIdentity="",targetIdentity="";
  let proof: Record<string,unknown> = {};
  try {
    expect((await pair.request("/api/system-recovery/jobs","GET",undefined,{},"reader")).response.status).toBe(403);
    expect((await pair.request("/api/system-recovery/jobs","GET",undefined,{},"none")).response.status).toBe(403);
    expect(await target.readRows("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN('_cf_KV','_cf_METADATA')")).toEqual([]);
    let profileId: string | undefined;
    if(expectedFiles) profileId=(await activateR2PackagePeer(pair)).profileId;
    const capabilities=checkedSystemRecoveryCapabilities(await json(pair,"/api/system-recovery/executor","POST",{enabled:true}));
    expect(capabilities).toMatchObject({supported:true,canManage:true,enabled:true,cadenceSeconds:120,maxStepMs:60000,target:{configured:true,id:target.id,mode:"fresh"}});
    const acceptedInput={requestId:randomUUID(),byteSize:input.bytes.byteLength,sha256:input.expectedSha256};
    const accepted=checkedSystemRecoveryReceipt(await json(pair,"/api/system-recovery/uploads","POST",acceptedInput,202));
    const replay=checkedSystemRecoveryReceipt(await json(pair,"/api/system-recovery/uploads","POST",acceptedInput,202));
    expect(replay.reused).toBe(true);expect(replay.job.id).toBe(accepted.job.id);
    const uploaded=await pair.request("/api/system-recovery/jobs/"+accepted.job.id+"/upload","PUT",Uint8Array.from(input.bytes).buffer,
      {"content-type":"application/zip","content-length":String(input.bytes.byteLength)});
    expect(uploaded.response.status).toBe(200);
    const validation=await complete(pair,checkedSystemRecoveryJobStatus(pairJson(uploaded.value)),"preview");
    const preview=checkedSystemRecoveryPreview(await json(pair,"/api/system-recovery/jobs/"+accepted.job.id+"/preview"));
    expect(preview).toMatchObject({archive:{schema:"system-backup/5",sha256:input.expectedSha256,complete:true,legacy:false},
      counts:{files:expectedFiles,availableFiles:expectedFiles,unavailableFiles:0},canRecover:true,canCutover:false,target:{id:target.id,available:true}});
    const mappings=expectedFiles?[{sourceProfileId:admitted.manifest.files[0]!.source.storageProfileId,destinationProfileId:profileId,configurationRevision:1}]:[];
    const recoveryInput={requestId:randomUUID(),uploadJobId:accepted.job.id,expectedTargetId:target.id,mapping:mappings,
      mode:"historical",acknowledgeLaterChanges:true,acknowledgePartial:false};
    const recovery=checkedSystemRecoveryReceipt(await json(pair,"/api/system-recovery/recoveries","POST",recoveryInput,202));
    const recoveryReplay=checkedSystemRecoveryReceipt(await json(pair,"/api/system-recovery/recoveries","POST",recoveryInput,202));
    expect(recoveryReplay.reused).toBe(true);expect(recoveryReplay.job.id).toBe(recovery.job.id);
    const restored=await complete(pair,recovery.job,"completed");expect(restored.job.phase).toBe("ready");
    expect(restored.job.progress).toMatchObject({completedFiles:expectedFiles,totalFiles:expectedFiles,bytesDone:admitted.manifest.counts.bytes});
    ensure(restored.job.result?.checkpoint,"ready_checkpoint");expect(restored.job.result).toMatchObject({targetId:target.id,ready:true,cutover:false});
    const report=await json(pair,"/api/system-recovery/jobs/"+recovery.job.id+"/report");
    expect(report).toMatchObject({schema:"system-recovery-public-report/1",jobId:recovery.job.id,targetId:target.id,mode:"historical",
      historicalLaterChangesLost:true,sourceImageSha256:hash(stableJson(admitted.records.image)),targetCheckpoint:restored.job.result.checkpoint,
      counts:{files:expectedFiles,bytes:admitted.manifest.counts.bytes},
      protectedSettings:{policy:"quarantined",rootKeysIncluded:false,automaticExecution:false,freshConfigurationRequired:true},
      execution:{shadow:false,authority:false,fileJobs:false,recoveryJobs:false,cleanup:false,oldJobReplay:false},
      handoff:{automaticBindingChange:false,operatorRequired:true,sourceRetainedReadOnly:true}});
    await json(pair,"/api/system-recovery/jobs/"+recovery.job.id+"/cutover","POST",{requestId:randomUUID(),expectedTargetId:target.id,expectedCheckpoint:restored.job.result.checkpoint},409);
    await inert(target,expectedFiles);
    const evidence=await target.readRows("SELECT * FROM recovery_file_evidence");expect(evidence).toHaveLength(expectedFiles);
    const appends: Record<string,number> = expectedFiles?{storage_profiles:1,storage_profile_runtime:1,file_locations:1,file_location_publications:1,
      recovery_file_evidence:1,recovery_file_alias_evidence:admitted.records.content.tables.assets.filter(row=>row.file_id===admitted.manifest.files[0]!.fileIds[0]).length,
      recovery_file_binding_evidence:admitted.manifest.files[0]!.bindings.length,file_registry_rowid_claims:2,file_shadow_dependency_versions:2}:{};
    for(const spec of V28_TABLES.filter(spec=>!spec.local)){
      const before=admitted.records.image.tables[spec.name]!,after=await typed(target,spec),remaining=new Map(after.map(row=>[key(spec,row),row]));
      for(const original of before.rows){
        const observed=remaining.get(key(spec,original));ensure(observed,"original_row:"+spec.name);remaining.delete(key(spec,original));
        expect(observed.rowid===original.rowid,"Exact original rowid "+spec.name).toBe(true);
        for(let index=0;index<spec.columns.length;index++){
          const left=original.cells[index],right=observed.cells[index];if(stableJson(left)===stableJson(right))continue;
          const allowed=spec.name==="local_accounts"&&spec.columns[index]==="enabled"&&right.type==="integer"&&right.value==="0"
            ||expectedFiles===1&&spec.name==="file_publications"&&spec.columns[index]==="active_location_id"
              &&right.type==="text"&&right.value===evidence[0]?.location_id;
          expect(Boolean(allowed),"Classified typed cell "+spec.name+"."+spec.columns[index]).toBe(true);
        }
      }
      expect(remaining.size,"Closed appended row census "+spec.name).toBe(appends[spec.name]??0);
    }
    sourceIdentity=String((await pair.readRows("SELECT installation_id FROM system_recovery_runtime WHERE singleton=1"))[0]?.installation_id);
    targetIdentity=String((await target.readRows("SELECT installation_id FROM system_recovery_runtime WHERE singleton=1"))[0]?.installation_id);
    expect(targetIdentity).toMatch(/^[a-f0-9]{32}$/);expect(targetIdentity).not.toBe(sourceIdentity);
    let captureProof: Record<string,unknown> | null=null;
    if(expectedFiles){
      const member=admitted.manifest.files[0]!,entry=admitted.entries.find(row=>row.path===member.path);ensure(entry&&evidence[0],"payload_evidence");
      const originalBytes=await (await nodeRecoveryArchiveSource(input.archive)).read(entry.dataOffset,entry.byteSize);
      const item=evidence[0];expect(item).toMatchObject({backup_id:admitted.records.backupId,source_file_id:member.fileIds[0],destination_file_id:member.fileIds[0],
        profile_id:profileId,profile_revision:1,purpose:member.purposes[0],byte_size:member.byteSize,sha256:member.sha256,producer_trust:"opaque_recovery"});
      ensure(typeof item.object_key==="string","native_key");const native=await pair.readObject(item.object_key);
      expect(native.byteSize).toBe(originalBytes.byteLength);expect(hash(new Uint8Array(native.bytes))).toBe(member.sha256);
      expect(hash(new Uint8Array(native.bytes))).toBe(hash(originalBytes));
      expect(await target.readRows("SELECT state,activated_at,retired_at FROM storage_profile_runtime WHERE storage_profile_id=?",[profileId!]))
        .toEqual([{state:"read_only",activated_at:null,retired_at:null}]);
      const targetCapabilities=checkedSystemRecoveryCapabilities(await json(target,"/api/system-recovery/executor","POST",{enabled:true}));
      expect(targetCapabilities).toMatchObject({supported:true,canManage:true,enabled:true,cadenceSeconds:120,maxStepMs:60000,maintenance:{state:"fenced"}});
      // Capture the complete actual available-location inventory BEFORE the
      // public snapshot. Protected LOCAL history and canonical R2 are distinct
      // original retention owners, even though only canonical R2 supplies bytes.
      const originalLocationTable=admitted.records.image.tables.file_locations;ensure(originalLocationTable,"original_location_image");
      expect(originalLocationTable.rows).toHaveLength(1);
      const originalLocation=originalLocationTable.rows[0]!;
      function originalLocationText(column:string){const index=originalLocationTable.columns.indexOf(column),cell=originalLocation.cells[index];
        ensure(index>=0&&cell?.type==="text","original_location_cell");return cell.value;}
      const beforeSourceRows=await target.readRows(`SELECT l.id AS location_id,l.file_id,l.storage_profile_id,l.object_key,
        p.adapter_type,p.configuration_revision,lp.verified_byte_size,lp.verified_sha256
        FROM file_location_publications lp JOIN file_location_availability a ON a.location_id=lp.location_id
        JOIN file_locations l ON l.id=lp.location_id JOIN storage_profiles p ON p.id=l.storage_profile_id
        WHERE a.availability='available' ORDER BY l.id`);
      expect(beforeSourceRows).toHaveLength(2);
      const protectedLocal=beforeSourceRows.filter(row=>row.adapter_type==="local"),canonicalR2=beforeSourceRows.filter(row=>row.adapter_type==="r2");
      expect(protectedLocal).toHaveLength(1);expect(canonicalR2).toHaveLength(1);
      expect(protectedLocal[0]).toMatchObject({location_id:originalLocationText("id"),file_id:originalLocationText("file_id"),
        storage_profile_id:originalLocationText("storage_profile_id"),object_key:originalLocationText("object_key"),
        verified_byte_size:member.byteSize,verified_sha256:member.sha256});
      expect(canonicalR2[0]).toMatchObject({location_id:item.location_id,file_id:item.destination_file_id,
        storage_profile_id:profileId,object_key:item.object_key,configuration_revision:1,
        verified_byte_size:member.byteSize,verified_sha256:member.sha256});
      const backup=checkedSystemRecoveryReceipt(await json(target,"/api/system-recovery/jobs","POST",{requestId:randomUUID(),kind:"backup",mode:"historical"},202));
      const captured=await complete(target,backup.job,"completed");ensure(captured.job.output?.available,"actual_backup_output");
      expect(captured.job.progress).toMatchObject({totalFiles:1,completedFiles:1,bytesDone:member.byteSize});
      const downloaded=await target.request("/api/system-recovery/jobs/"+backup.job.id+"/download");expect(downloaded.response.status).toBe(200);
      ensure(downloaded.value instanceof ArrayBuffer,"actual_backup_bytes");const capturedHash=hash(new Uint8Array(downloaded.value));
      expect(capturedHash).toBe(captured.job.output.sha256);expect(downloaded.value.byteLength).toBe(captured.job.output.byteSize);
      const archive=join(pair.root,"original-public-held-r2-v5.zip");await writeFile(archive,new Uint8Array(downloaded.value),{flag:"wx",mode:0o600});
      const recaptured=await validateV28SystemBackupArchiveCandidate(await nodeRecoveryArchiveSource(archive),{...NODE_RECOVERY_ARCHIVE_OPTIONS,expectedSha256:capturedHash});
      expect(recaptured.format).toBe("v5");expect(recaptured.records.origin).toEqual({format:"native",schemaVersion:28,capturePolicy:"atomic-primary-with-byte-holds/1"});
      expect(recaptured.manifest.completeness).toBe("complete");expect(recaptured.manifest.files).toHaveLength(1);
      expect(recaptured.manifest.files[0]).toMatchObject({source:{storeKind:"r2",provider:"r2",byteAuthority:"file_location",storageProfileId:profileId},fileIds:member.fileIds,
        outcome:"packaged",byteSize:member.byteSize,sha256:member.sha256});
      const holdSql=`SELECT h.id,h.location_id,h.hold_kind,h.operation_id,h.reason,h.acquired_at,h.expires_at,h.released_at,
        l.file_id,l.storage_profile_id,l.object_key,p.adapter_type,p.configuration_revision,lp.verified_byte_size,lp.verified_sha256
        FROM file_location_holds h JOIN file_locations l ON l.id=h.location_id JOIN storage_profiles p ON p.id=l.storage_profile_id
        JOIN file_location_publications lp ON lp.location_id=l.id WHERE h.operation_id=? ORDER BY h.location_id`;
      const originalHolds=await target.readRows(holdSql,["fp5-backup:"+backup.job.id]);expect(originalHolds).toHaveLength(2);
      expect(new Set(originalHolds.map(row=>row.id)).size).toBe(2);
      for(let index=0;index<originalHolds.length;index++){
        expect(originalHolds[index]).toMatchObject({...beforeSourceRows[index],hold_kind:"export",operation_id:"fp5-backup:"+backup.job.id,
          reason:"Frozen system backup source",acquired_at:backup.job.acceptedAt,expires_at:null,released_at:null});
        expect(originalHolds[index]?.id).toMatch(/^fp5_[a-f0-9]{32}$/);
      }
      await json(target,"/api/system-recovery/jobs/"+backup.job.id+"/control","POST",{action:"cleanup"},409);
      // Exact original IDs/locations/owner/complete tuples stay retained. No
      // deletion, replacement, released row or extra hold can satisfy this.
      expect(await target.readRows(holdSql,["fp5-backup:"+backup.job.id])).toEqual(originalHolds);
      const distribution=await coherentDistribution(),destination=join(pair.root,"fresh-public-held-node-inert");
      const result=await runCurrentCli(distribution.path,"restore-v28-cli.cjs",["restore","--archive",archive,"--destination",destination,"--sha256",capturedHash,
        "--filesystem-root-owner-uid",String((await lstat("/")).uid)]);
      expect(result.code).toBe(0);expect(result.signal).toBeNull();expect(result.stderr).toBe("");const restoredNode=object(JSON.parse(result.stdout));
      expect(restoredNode).toMatchObject({kind:"offline-v28-inert-restore/1",destinationCheckpoint:"portable-runtime/v28",sourceArchiveSha256:capturedHash,executionEnabled:false,payloads:1});
      const nativeNode=new DatabaseSync(join(destination,"database.sqlite"),{readOnly:true});
      try {
        for(const spec of V28_TABLES.filter(spec=>!spec.local)){
          const actual=nativeNode.prepare(typedSnapshotSql(spec)).all().map(value=>{ensure(typeof value.cells==="string","node_row");return stableJson({rowid:value.rowid,cells:JSON.parse(value.cells)});}).sort();
          expect(stableJson(actual)===stableJson(recaptured.records.image.tables[spec.name]!.rows.map(stableJson).sort()),"Exact current Node typed rows/rowids "+spec.name).toBe(true);
        }
        for(const name of ["file_authority_runtime_guard","file_shadow_runtime_guard","file_job_runtime_guard","system_recovery_runtime"])
          expect(nativeNode.prepare('SELECT enabled FROM "'+name+'" WHERE singleton=1').get()?.enabled).toBe(0);
        expect(nativeNode.prepare("SELECT state FROM system_recovery_maintenance WHERE singleton=1").get()?.state).toBe("fenced");
        expect(nativeNode.prepare("PRAGMA integrity_check").all()).toEqual([{integrity_check:"ok"}]);expect(nativeNode.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      }finally{nativeNode.close();}
      const delivered=await readFile(join(destination,recaptured.manifest.files[0]!.path!));expect(hash(delivered)).toBe(member.sha256);
      expect(hash(await readFile(join(destination,"original-archive.zip")))).toBe(capturedHash);await verifyDistributionSourcePins(distribution.path);
      captureProof={realAcceptedBackupJob:true,originalScheduledCalls:captured.originalScheduledCalls,archiveFormat:"v5",payloads:1,payloadBytes:delivered.byteLength,
        exactTypedRowsAndRowids:true,positiveOriginalSourceFirstCloseRequired:true,holdsRetainedUntilDurableCleanupProof:true,originalAvailableLocationInventory:2,
        originalProtectedLocalHolds:1,originalCanonicalR2Holds:1,exactOriginalHoldIdsAndTuplesRetained:true,compiledCurrentNodeRestore:true,
        coherentDistributionManifestSha256:distribution.manifestSha256};
    }
    await pair.verifyNativeDatabaseConsistency();await target.verifyNativeDatabaseConsistency();
    proof={schema:"genuine-access-public-v5-historical-native/1",inputScope:process.env.WORKER_V5_CURRENT_PRODUCER_HEAD===undefined?"pinned-original62ac-producer":"same-current-original-producer",
      inputProducerHead:process.env.WORKER_V5_CURRENT_PRODUCER_HEAD??PINNED_PRODUCER_HEAD,sourceArchiveSha256:input.expectedSha256,files:expectedFiles,
      authenticatedActualProductionHandler:true,actualDurablePublicUploadAndRecovery:true,originalValidationScheduledCalls:validation.originalScheduledCalls,
      originalRecoveryScheduledCalls:restored.originalScheduledCalls,elapsedCadenceQualified:false,cadenceSeconds:120,maxStepMs:60000,
      exactOriginalTypedCellsAndRowids:true,closedAppendCensus:true,accountsDisabled:true,groupDefaultDisabled:true,executionDefaultsDisabled:true,automaticCutover:false,captureProof};
    expect(hash(await readFile(input.archive))).toBe(input.expectedSha256);expect(hash(await readFile(input.receiptPath))).toBe(input.receiptHash);await input.recheckProducer();
  }catch(error){failed=true;failure=error;}
  try{const original=pair.close();expect(pair.close()).toBe(original);await original;}catch(cleanup){throw failed?new AggregateError([failure,cleanup],"Original public V5 work and first close failed"):cleanup;}
  if(failed)throw failure;
  const sourceClosed=pair.closedDatabaseConsistency(),targetClosed=target.closedDatabaseConsistency();
  expect(sourceClosed.databaseSha256Before).toBe(sourceClosed.databaseSha256After);expect(targetClosed.databaseSha256Before).toBe(targetClosed.databaseSha256After);
  await verifyClosedNativeD1(join(pair.root,"d1"),{source:sourceIdentity,target:targetIdentity},join(pair.root,"closed-native-file-consistency.json"));
  await writeFile(join(pair.root,"original-public-v5-historical-receipt.json"),JSON.stringify({...proof,originalPairFirstCloseAcknowledged:true,
    originalNativeDisposed:true,sourceFullIntegrity:"ok",targetFullIntegrity:"ok"})+"\n",{flag:"wx",mode:0o600});
}
it(titles[0],()=>run("ZERO"),120_000);
it(titles[1],()=>run("NONEMPTY"),120_000);

async function retainedInput(kind: "ZERO" | "NONEMPTY") {
  const prefix = "WORKER_V5_" + kind;
  const archive = process.env[prefix + "_ARCHIVE"], expectedSha256 = process.env[prefix + "_SHA256"];
  const receiptPath = process.env[prefix + "_PRODUCER_RECEIPT"];
  ensure(archive && receiptPath && expectedSha256 && /^[a-f0-9]{64}$/.test(expectedSha256), "original_input_missing");
  for (const path of [archive, receiptPath]) ensure(isAbsolute(path) && resolve(path) === path && await realpath(path) === path, "original_input_path");
  const stat = await lstat(archive); ensure(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
    && stat.size > 0 && stat.size <= 8 * 1024 * 1024, "original_archive_file");
  const bytes = await readFile(archive), receiptBytes = await readFile(receiptPath);
  expect(hash(bytes)).toBe(expectedSha256);
  const receipt = object(JSON.parse(receiptBytes.toString("utf8"))), results = object(receipt.actualResults);
  const recheckProducer = await assertWorkerV5OriginalProducerInput(SOURCE_ROOT, prefix, kind, receipt, archive, expectedSha256, PINNED_PRODUCER_HEAD);
  expect(receipt.status).toBe("PASS");
  expect(receipt.ownedClosureProven).toBe(true); expect(receipt.originalChildWaited).toBe(true);
  expect(results.actualTotal).toBe(1); expect(results.actualPassed).toBe(1); expect(results.actualFailed).toBe(0);
  expect(results.actualPending).toBe(0); expect(results.exactOriginalSelection).toBe(true);
  return { archive, expectedSha256, receiptPath, receiptHash: hash(receiptBytes), bytes, recheckProducer };
}
/** Read-only whole checks of the exact original files, after owned Miniflare
 * disposal. These are neither a reconstructed expected catalog nor a host D1
 * adapter. Include platform tables and global page ownership/unused-page checks
 * unavailable from workerd's bounded table quick_check operations. */
async function verifyClosedNativeD1(directory: string, identities: { source: string; target: string }, receiptPath: string) {
  ensure(isAbsolute(directory) && resolve(directory) === directory && await realpath(directory) === directory, "closed_native_path");
  const entries = await readdir(directory, { recursive: true });
  const files = entries.filter(name => name.endsWith(".sqlite") && !name.endsWith("metadata.sqlite")).sort();
  expect(files, "Exactly the two original native D1 files must remain").toHaveLength(2);
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
      expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { native.close(); }
  }
  expect(observed.sort()).toEqual([identities.source, identities.target].sort());
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
    originalNativeDisposed: true, installations: observed, wholeQuickCheck: true, foreignKeys: true,
    durableMainAndWalUnchanged: true, physicalPathsAndInodesUnchanged: true, files: observations }, null, 2) + "\n",
  { flag: "wx", mode: 0o600 });
}
let dependencyCustody: string | undefined;
async function coherentDependencyRoot(): Promise<string> {
  const logical = join(SOURCE_ROOT, "node_modules"), logicalStat = await lstat(logical);
  const actual = await realpath(logical), actualStat = await lstat(actual);
  ensure((logicalStat.isDirectory() || logicalStat.isSymbolicLink()) && actualStat.isDirectory()
    && !actualStat.isSymbolicLink() && await realpath(actual) === actual, "coherent_dependency_root");
  const identity = stableJson({ logical, actual, logicalDev: logicalStat.dev, logicalIno: logicalStat.ino,
    actualDev: actualStat.dev, actualIno: actualStat.ino, owner: actualStat.uid, mode: actualStat.mode });
  dependencyCustody ??= identity;
  ensure(identity === dependencyCustody, "coherent_dependency_root_changed"); return actual;
}
async function verifyDistributionSourcePins(directory: string) {
  const manifestBytes = await readFile(join(directory, "manifest.json"));
  // The original verifier already admits the closed canonical manifest/input
  // format and every binary. Independently bind those admitted inputs to THIS
  // complete current source generation, rather than a historical distribution.
  const manifest = object(JSON.parse(manifestBytes.toString("utf8"))), sourceBytes = await readFile(join(directory, "source-inputs.json"));
  expect(hash(sourceBytes)).toBe(manifest.sourceInputsSha256);
  expect(hash(await readFile(join(SOURCE_ROOT, "package-lock.json")))).toBe(manifest.packageLockSha256);
  const source = object(JSON.parse(sourceBytes.toString("utf8"))); ensure(Array.isArray(source.inputs), "coherent_source_inventory");
  const inputs = source.inputs.map(object), dependencyRoot = await coherentDependencyRoot();
  for (const input of inputs) {
    ensure(typeof input.path === "string" && typeof input.bytes === "number" && typeof input.sha256 === "string", "coherent_source_input");
    const path = join(SOURCE_ROOT, input.path), stat = await lstat(path);
    // The exact admitted SDK may be a single shared node_modules alias in
    // local qualification. Current tracked application inputs remain fresh,
    // single-link canonical files; dependencies must resolve under that one
    // captured canonical SDK root and retain every declared byte/hash check.
    const expected = input.path.startsWith("node_modules/")
      ? join(dependencyRoot, input.path.slice("node_modules/".length)) : path;
    ensure(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && await realpath(path) === expected, "coherent_source_file");
    expect(stat.size).toBe(input.bytes); expect(hash(await readFile(path)), "Coherent original Node source input: " + input.path).toBe(input.sha256);
  }
  await coherentDependencyRoot();
  for (const required of ["shared/contracts/export-system-recovery-evidence-v28.ts", "shared/contracts/export-local-file-runtime-v28.ts",
    "shared/contracts/system-backup-v5.ts", "server/recovery/restore-v28-candidate.ts"]) expect(inputs.some(input => input.path === required), required).toBe(true);
}
async function coherentDistribution() {
  const path = process.env.WORKER_V5_COHERENT_NODE_DISTRIBUTION;
  ensure(path && isAbsolute(path) && resolve(path) === path && await realpath(path) === path, "coherent_node_distribution");
  const manifest = await verifyNodeDistribution(path, { enforceRuntimeVersion: true });
  expect(manifest.version).toBe(3); expect(manifest.offlineRecoveryCheckpoint.id).toBe("portable-runtime/v28");
  expect(manifest.offlineRecoveryCheckpoint.archiveFormat).toBe("v5");
  await verifyDistributionSourcePins(path); return { path, manifestSha256: manifest.manifestSha256 };
}
