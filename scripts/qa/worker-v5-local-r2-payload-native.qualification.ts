import { afterAll, afterEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build, stop } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { PORTABLE_RUNTIME_RECOVERY_MIGRATIONS } from "../../shared/contracts/portable-runtime-v26-recovery-catalog";

const ORIGINAL_PRODUCER_HEAD = "9c7c916d9647ffac8efc163c2b7213b40617cb41";
const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const titles = [
  "publishes original genuine LOCAL Node V5 bytes to native R2 while preserving exact inert D1 V28 File history",
  "retains the original committed native R2 PUT rejection and unknown V5 attempt without replay or deletion",
] as const;
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error("worker_v5_native_" + reason);
}
function object(value: unknown): Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value), "object"); return value as Record<string, unknown>;
}

// The full source documents stay private in the isolate. Only fixed proof facts
// leave it. DB and RECOVERY_DB are the actual Miniflare native D1 bindings.
const workerCode = String.raw`
  import {Hono} from 'hono';
  import {createWorkerV5LocalR2PayloadCandidate} from './v5-local-r2-payload-candidate';
  import {admitV5SystemBackupArchiveCandidate} from '../../shared/contracts/system-backup-v5-archive-admission-candidate';
  import {sourceFromBlob} from '../../shared/domain/research-archive';
  import {stableJson,sha256Hex} from '../../shared/domain/content-addressing';
  import {recoveryTableSnapshotSql} from '../../shared/contracts/system-recovery-image';
  import {PORTABLE_RUNTIME_RECOVERY_TABLES as sourceSpecs} from '../../shared/contracts/portable-runtime-v26-recovery-catalog';
  import {V5_RECOVERY_CATALOG_CANDIDATE as catalog} from './v5-catalog-candidate';
  import {inspectV28CloudflareSchemaCandidate} from './v28-cloudflare-schema-candidate';
  import {inspectRecoveryMigrationLedger} from './target-migrations';
  import {ensureR2BootstrapProfile} from '../files/r2-bootstrap-profile';
  import {shadowRoutes} from '../files/shadow-routes';
  const actor='isolated-v5-constructor-owner@example.invalid';
  const controls=new Hono();
  controls.use('*',async(c,next)=>{c.set('userEmail',actor);await next();});
  controls.route('/',shadowRoutes);
  let profile;
  function require(value,reason){if(!value)throw new Error('worker_v5_native_'+reason);}
  async function table(db,spec){
    const rows=await db.prepare(recoveryTableSnapshotSql(spec)).all();
    require(rows.success,'typed_read');
    return {columns:[...spec.columns],rows:rows.results.map(row=>({rowid:row.rowid,cells:JSON.parse(row.cells)}))};
  }
  async function sourceHash(db){
    const values={};
    for(let offset=0;offset<sourceSpecs.length;offset+=64){
      const group=sourceSpecs.slice(offset,offset+64);
      const results=await db.batch(group.map(spec=>db.prepare(recoveryTableSnapshotSql(spec))));
      for(let index=0;index<group.length;index++){
        require(results[index].success,'source_read');
        values[group[index].name]=results[index].results.map(row=>({rowid:row.rowid,cells:JSON.parse(row.cells)})).map(stableJson).sort();
      }
    }
    return sha256Hex(stableJson(values));
  }
  async function command(env,path,value){
    const response=await controls.fetch(new Request('https://constructor-control.invalid'+path,
      {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}),env);
    require(response.status===200,'original_profile_command');
    return response.json();
  }
  const rowKey=(spec,row)=>spec.withoutRowid?stableJson((spec.primaryKeyColumns??spec.columns).map(name=>row.cells[spec.columns.indexOf(name)])):row.rowid;
  const cellValue=cell=>cell.type==='null'?null:cell.value;
  async function independentProof(target,records,admission,archive){
    const objects=await target.prepare('SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name').all();
    require(objects.success,'target_schema_read');const inspected=await inspectV28CloudflareSchemaCandidate(objects.results);
    require(stableJson(inspected.applicationObjects.filter(object=>object.type==='table').map(object=>object.name).sort())
      ===stableJson(catalog.tables.map(spec=>spec.name).sort()),'table_catalog_coverage');
    await inspectRecoveryMigrationLedger(target,true,catalog.migrations);
    const payload=archive.manifest.files[0],mapping=admission.mappings[0],fileId=payload.fileIds[0];
    const proof=await target.prepare('SELECT * FROM recovery_file_evidence WHERE source_file_id=? AND destination_file_id=? AND object_key=?')
      .bind(fileId,fileId,mapping.objectKey).first();require(proof,'new_native_recovery_evidence');
    require(proof.backup_id===records.backupId&&proof.source_image_sha256===admission.sourceImageSha256
      &&proof.location_id!==payload.source.locationId&&proof.profile_id===mapping.destinationProfileId&&proof.profile_revision===1
      &&proof.namespace_identity===mapping.destinationNamespaceIdentity&&proof.purpose===payload.purposes[0]
      &&proof.byte_size===payload.byteSize&&proof.sha256===payload.sha256&&proof.verification_operation_id==='fp5:'+proof.id
      &&proof.producer_trust==='opaque_recovery','exact_new_evidence');
    const locator=JSON.parse(proof.source_locator_json);
    require(locator.provider==='local'&&locator.storeKind==='file'&&locator.byteAuthority==='file_location'
      &&locator.locatorId===payload.source.locatorId&&locator.storageProfileId===payload.source.storageProfileId
      &&locator.storageProfileRevision===1&&locator.locationId===payload.source.locationId&&locator.objectKey===payload.source.objectKey,'original_local_locator');
    const aliases=records.content.tables.assets.filter(row=>row.file_id===fileId),bindings=payload.bindings;
    const expectedAppends={storage_profiles:1,storage_profile_runtime:1,file_locations:1,file_location_publications:1,
      recovery_file_evidence:1,recovery_file_alias_evidence:aliases.length,recovery_file_binding_evidence:bindings.length,file_registry_rowid_claims:2,file_shadow_dependency_versions:2};
    let oldRowsExact=true,oldRowidsExact=true,appendsClosed=true,accountRows=0,disabledAccounts=0;
    for(const spec of catalog.tables.filter(spec=>!spec.local)){
      const expected=records.image.tables[spec.name],actual=await table(target,spec);
      const rows=new Map(actual.rows.map(row=>[rowKey(spec,row),row]));
      for(const before of expected.rows){
        const after=rows.get(rowKey(spec,before));require(after,'original_typed_row');rows.delete(rowKey(spec,before));
        oldRowidsExact&&=before.rowid===after.rowid;
        for(let index=0;index<spec.columns.length;index++){
          const name=spec.columns[index],left=before.cells[index],right=after.cells[index];
          if(stableJson(left)===stableJson(right))continue;
          let allowed=false;
          if(spec.name==='local_accounts'&&name==='enabled')allowed=right.type==='integer'&&right.value==='0';
          if(spec.name==='file_publications'&&name==='active_location_id')allowed=cellValue(before.cells[spec.columns.indexOf('file_id')])===fileId
            &&right.type==='text'&&right.value===proof.location_id;
          oldRowsExact&&=Boolean(allowed);
        }
      }
      appendsClosed&&=rows.size===(expectedAppends[spec.name]??0);
      if(spec.name==='local_accounts'){
        accountRows=actual.rows.length;const enabled=actual.columns.indexOf('enabled');
        disabledAccounts=actual.rows.filter(row=>row.cells[enabled].type==='integer'&&row.cells[enabled].value==='0').length;
      }
    }
    const location=await target.prepare('SELECT * FROM file_locations WHERE id=?').bind(proof.location_id).first();
    const publication=await target.prepare('SELECT * FROM file_location_publications WHERE location_id=?').bind(proof.location_id).first();
    const head=await target.prepare('SELECT * FROM file_publications WHERE file_id=?').bind(fileId).first();
    require(location&&publication&&head&&location.file_id===fileId&&location.storage_profile_id===mapping.destinationProfileId
      &&location.object_key===mapping.objectKey&&location.state==='unresolved'&&publication.file_id===fileId
      &&publication.storage_profile_id===mapping.destinationProfileId&&publication.object_key===mapping.objectKey
      &&publication.verified_byte_size===payload.byteSize&&publication.verified_sha256===payload.sha256
      &&publication.verification_method==='full_read_sha256'&&publication.verification_operation_id===proof.verification_operation_id
      &&publication.verified_at===proof.verified_at&&publication.published_at===proof.published_at
      &&head.active_location_id===proof.location_id&&head.state==='ready'&&head.verified_byte_size===payload.byteSize
      &&head.verified_sha256===payload.sha256,'canonical_active_mapping');
    for(const alias of aliases){
      const row=await target.prepare("SELECT original_json,destination_file_id FROM recovery_file_alias_evidence WHERE evidence_id=? AND table_name='assets' AND alias_id=?")
        .bind(proof.id,alias.id).first();require(row&&row.destination_file_id===fileId&&stableJson(JSON.parse(row.original_json))===stableJson(alias),'exact_alias_history');
    }
    for(const binding of bindings){
      const row=await target.prepare('SELECT * FROM recovery_file_binding_evidence WHERE evidence_id=? AND consumer_kind=? AND consumer_id=? AND consumer_sub_id=? AND file_slot=?')
        .bind(proof.id,binding.consumerKind,binding.consumerId,binding.consumerSubId,binding.fileSlot).first();
      require(row&&row.source_file_id===fileId&&row.purpose===payload.purposes[0]&&row.preview_origin_json==='{"kind":"none"}','exact_binding_history');
    }
    const singletons=new Set(['file_authority_runtime_guard','file_shadow_runtime_guard','file_job_runtime_guard',
      'system_recovery_runtime','system_recovery_maintenance','collaboration_control']);
    let emptyLocal=true,inertDefaults=true;
    for(const spec of catalog.tables.filter(spec=>spec.local)){
      const actual=await table(target,spec);
      if(spec.name==='system_recovery_target_files'){
        require(actual.rows.length===1,'persisted_attempt_count');
        const attempt=await target.prepare('SELECT * FROM system_recovery_target_files').first();
        require(attempt.state==='published'&&attempt.file_id===fileId&&attempt.location_id===proof.location_id
          &&attempt.object_key===mapping.objectKey&&attempt.byte_size===payload.byteSize&&attempt.sha256===payload.sha256,'persisted_published_attempt');continue;
      }
      if(!singletons.has(spec.name)){emptyLocal&&=actual.rows.length===0;continue;}
      const get=name=>cellValue(actual.rows[0]?.cells[actual.columns.indexOf(name)]??{type:'null'});
      inertDefaults&&=actual.rows.length===1&&get('singleton')==='1';
      if(spec.name==='collaboration_control')inertDefaults&&=get('enforcement')==='disabled'&&get('schema_version')==='2'&&get('revision')==='1';
      else if(spec.name==='system_recovery_maintenance')inertDefaults&&=get('state')==='fenced'&&get('token')===null;
      else inertDefaults&&=get('enabled')==='0';
    }
    const targetProfile=await target.prepare('SELECT p.*,r.state runtime_state,r.activated_at FROM storage_profiles p JOIN storage_profile_runtime r ON r.storage_profile_id=p.id WHERE p.id=?')
      .bind(mapping.destinationProfileId).first();
    require(targetProfile.adapter_type==='r2'&&targetProfile.namespace_identity===mapping.destinationNamespaceIdentity
      &&targetProfile.runtime_state==='read_only'&&targetProfile.activated_at===null,'destination_read_only_default');
    for(const family of ['storage_profiles','storage_profile_runtime']){
      const history=await target.prepare('SELECT revision,present,snapshot_json FROM file_shadow_dependency_versions WHERE dependency_kind=? AND dependency_key=?')
        .bind(family,JSON.stringify([mapping.destinationProfileId])).all();
      require(history.success&&history.results.length===1&&history.results[0].revision===1&&history.results[0].present===1,'new_dependency_revision');
      const expected=family==='storage_profiles'?await target.prepare('SELECT id,adapter_type,namespace_identity,configuration_source,configuration_revision,state,created_at FROM storage_profiles WHERE id=?').bind(mapping.destinationProfileId).first()
        :await target.prepare('SELECT storage_profile_id,state,registered_at,activated_at,retired_at FROM storage_profile_runtime WHERE storage_profile_id=?').bind(mapping.destinationProfileId).first();
      require(stableJson(JSON.parse(history.results[0].snapshot_json))===stableJson(expected),'new_exact_dependency_snapshot');
    }
    const fk=await target.prepare('PRAGMA foreign_key_check').all();
    const checkedTables=['sqlite_schema',...objects.results.filter(object=>object.type==='table'&&object.name!=='_cf_KV'&&object.name!=='_cf_METADATA').map(object=>object.name)].sort();
    for(const name of checkedTables){const quick=await target.prepare('PRAGMA quick_check("'+name.replaceAll('"','""')+'")').all();
      require(quick.success&&quick.results.length===1&&Object.values(quick.results[0])[0]==='ok','native_table_consistency');}
    return {oldRowsExact,oldRowidsExact,appendsClosed,accountRows,disabledAccounts,emptyLocal,inertDefaults,foreignKeys:fk.success&&fk.results.length===0,
      tableIntegrity:true,checkedTables,globalNativeIntegrity:false,canonicalFileId:fileId,destinationLocationId:proof.location_id};
  }
  export default{async fetch(request,bindings){
    let phase='setup';
    try{
      if(new URL(request.url).pathname==='/setup'){
        profile=await ensureR2BootstrapProfile(bindings.DB,bindings,new Date().toISOString());
        let status=await bindings.DB.prepare('SELECT epoch FROM file_shadow_control WHERE singleton=1').first();
        const runtime=await bindings.DB.prepare('SELECT incarnation FROM file_shadow_runtime_guard WHERE singleton=1').first();
        const enabled=await command(bindings,'/files/shadow/enable',{requestId:crypto.randomUUID(),expectedEpoch:status.epoch,expectedIncarnation:runtime.incarnation});
        status=await bindings.DB.prepare('SELECT epoch FROM file_shadow_control WHERE singleton=1').first();
        await command(bindings,'/files/shadow/profiles/enable',{profile:{profileId:profile.id,configurationRevision:1},
          runtimeIncarnation:enabled.incarnation,expectedEpoch:status.epoch});
        return Response.json({setup:true});
      }
      require(profile,'setup_required');
      const count=Number(request.headers.get('x-original-file-count'));
      require(count===1,'selection');
      const fault=request.headers.get('x-original-ack-fault')==='1';
      phase='archive';
      const originalBlob=await request.blob(),originalArchive=sourceFromBlob(originalBlob);
      const archive=await admitV5SystemBackupArchiveCandidate(originalArchive,
        {expectedSha256:request.headers.get('x-original-archive-sha256')});
      require(archive.format==='v5'&&archive.manifest.completeness==='complete'&&archive.manifest.files.length===count,'original_archive_inventory');
      require(archive.records.sourceMigrationLedger.kind==='node-reviewed-migrations/1'
        &&archive.records.origin.capturePolicy==='quiesced-writers-and-bytes/1','original_node_source');
      require(count===0||archive.manifest.files[0].source.provider==='local','original_local_payload');
      const sourceBefore=await sourceHash(bindings.DB),calls={put:0,delete:0};
      // Observe actual native R2 calls; every method forwards to that binding.
      // D1 is passed directly, without a host or isolate SQL adapter.
      const nativeBucket=bindings.ASSETS,observedBucket=new Proxy(nativeBucket,{get(target,key){
        const value=Reflect.get(target,key);
        if(typeof value!=='function')return value;
        return async(...args)=>{if(key==='put'||key==='delete')calls[key]++;
          if(key==='put')require(args[2]?.onlyIf?.etagDoesNotMatch==='*','conditional_no_overwrite');
          const result=await value.apply(target,args);
          if(key==='put'&&fault)throw new Error('original_native_acknowledgement_rejected_after_committed_put');return result;};
      }});
      const env={...bindings,ASSETS:observedBucket};
      const mappings=[...new Set(archive.manifest.files.map(file=>file.source.storageProfileId))].map(sourceProfileId=>{
        require(typeof sourceProfileId==='string'&&sourceProfileId.length>0,'original_source_profile');
        return {sourceProfileId,destinationProfileId:profile.id,configurationRevision:1};
      });
      phase='admission';
      const owner=createWorkerV5LocalR2PayloadCandidate(env);
      let missingMappingRejected=count===0;
      if(count===1){
        try{await owner.admit({archive:originalArchive,expectedArchiveSha256:archive.sha256,expectedTargetId:bindings.RECOVERY_TARGET_ID,mapping:[]});}
        catch(error){missingMappingRejected=error instanceof Error&&error.message==='v5_local_r2_payload_explicit_mapping_missing';}
        require(missingMappingRejected,'missing_mapping_admitted');
      }
      const admission=await owner.admit({archive:originalArchive,expectedArchiveSha256:archive.sha256,
        expectedTargetId:bindings.RECOVERY_TARGET_ID,mapping:mappings});
      require(admission.payloadPublication===false&&admission.executionEnabled===false,'admission_flags');
      const mappingExact=admission.mappings.every(mapping=>{
        const original=archive.manifest.files.find(file=>file.id===mapping.sourceId);
        return original&&stableJson(original.source)===stableJson(mapping.source)
          &&original.source.storageProfileId===mapping.sourceProfileId&&mapping.destinationProfileId===profile.id
          &&mapping.configurationRevision===1&&mapping.destinationNamespaceIdentity===profile.namespaceIdentity
          &&mapping.destinationBindingName==='ASSETS'&&mapping.bytesPublished===false
          &&mapping.objectKey.startsWith('fp5-recovery/'+admission.destinationIncarnation+'/');
      });
      phase='construction';
      const original=owner.construct(admission,async()=>true);
      require(owner.construct(admission,async()=>false)===original,'first_promise_identity');
      if(fault){
        let rejected;try{await original;}catch(error){rejected=error;}
        require(rejected,'original_rejected_ack');
        let repeated;try{await owner.construct(admission,async()=>true);}catch(error){repeated=error;}
        require(repeated===rejected,'retained_first_rejection');
        const attempt=await bindings.RECOVERY_DB.prepare('SELECT * FROM system_recovery_target_files').first();
        require(attempt?.state==='unknown'&&attempt.object_key===admission.mappings[0].objectKey,'persisted_unknown_attempt');
        const object=await nativeBucket.get(attempt.object_key);require(object,'committed_original_object');
        const bytes=await object.arrayBuffer(),sha256=await sha256Hex(bytes);
        require(bytes.byteLength===archive.manifest.files[0].byteSize&&sha256===archive.manifest.files[0].sha256,'original_committed_full_bytes');
        const runtime=await bindings.RECOVERY_DB.prepare('SELECT installation_id,enabled FROM system_recovery_runtime WHERE singleton=1').first();
        const sourceIdentity=await bindings.DB.prepare('SELECT installation_id FROM system_recovery_runtime WHERE singleton=1').first();
        const publications=await bindings.RECOVERY_DB.prepare('SELECT count(*) n FROM recovery_file_evidence').first();
        return Response.json({fault:true,originalRejected:true,firstRejectionRetained:true,attemptUnknown:true,noPublication:publications.n===0,
          originalError:rejected instanceof Error?{name:rejected.name,message:rejected.message,stack:rejected.stack}:null,
          sourceInstallationId:sourceIdentity.installation_id,targetInstallationId:runtime.installation_id,executionEnabled:runtime.enabled===1,
          sourceUnchanged:sourceBefore===await sourceHash(bindings.DB),calls,originalStoredSha256:sha256,originalStoredBytes:bytes.byteLength});
      }
      const receipt=await original;
      phase='independent_proof';
      const proof=await independentProof(bindings.RECOVERY_DB,archive.records,admission,archive);
      const stored=await nativeBucket.get(admission.mappings[0].objectKey);require(stored,'published_original_r2_object');
      const actualBytes=await stored.arrayBuffer(),actualSha256=await sha256Hex(actualBytes);
      require(actualBytes.byteLength===archive.manifest.files[0].byteSize&&actualSha256===archive.manifest.files[0].sha256,'independent_native_r2_full_bytes');
      const sourceAfter=await sourceHash(bindings.DB);
      const targetIdentity=await bindings.RECOVERY_DB.prepare('SELECT installation_id FROM system_recovery_runtime WHERE singleton=1').first();
      const sourceIdentity=await bindings.DB.prepare('SELECT installation_id FROM system_recovery_runtime WHERE singleton=1').first();
      return Response.json({format:archive.format,sourceFileCount:count,archiveSha256:archive.sha256,receipt,proof,
        mappingCount:admission.mappings.length,mappingExact,missingMappingRejected,calls,actualSha256,actualByteSize:actualBytes.byteLength,sourceUnchanged:sourceBefore===sourceAfter,
        sourceInstallationId:sourceIdentity.installation_id,targetInstallationId:targetIdentity.installation_id,
        freshIdentity:targetIdentity.installation_id!==sourceIdentity.installation_id
          &&targetIdentity.installation_id!==archive.records.sourceMigrationLedger.installationId.replaceAll('-','')});
    }catch(error){
      const message=error instanceof Error?error.message:'other';
      const reason=/^(?:v5_fresh_target_|v5_recovery_catalog_candidate_|worker_v5_native_)[a-z0-9_:.-]+$/i.test(message)?message:'original_native_error';
      // Retain the original native error only in the private response artifact;
      // the host assertion prints fixed phase/reason facts, never source rows.
      return Response.json({error:'worker-v5-native-qualification-failed',phase,reason,
        originalError:error instanceof Error?{name:error.name,message:error.message,stack:error.stack}:null},{status:500});
    }
  }};
`;

interface Owner { native?: Miniflare; work: Promise<unknown>[]; closing?: Promise<void> }
const owners = new Set<Owner>();
function original<T>(owner: Owner, operation: () => Promise<T>): Promise<T> {
  let result: Promise<T>; try { result = operation(); } catch (error) { result = Promise.reject(error); }
  owner.work.push(result); void result.catch(() => undefined); return result;
}
function close(owner: Owner): Promise<void> {
  return owner.closing ??= (async () => {
    const failures: unknown[] = [];
    // Rejected operation identities belong to the caller; join them before
    // native disposal without replacing its already preserved first failure.
    await Promise.allSettled(owner.work);
    if (owner.native) try { await owner.native.dispose(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Original native V5 close failed");
    owners.delete(owner);
  })();
}
afterEach(() => { expect(owners.size, "Original native V5 owner remains retained").toBe(0); });
afterAll(async () => {
  const results = await Promise.allSettled([...owners].map(close));
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
  if (errors.length) throw new AggregateError(errors, "Original native V5 teardown remains unproven");
});

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
  expect(receipt.head).toBe(ORIGINAL_PRODUCER_HEAD); expect(receipt.status).toBe("PASS");
  expect(receipt.ownedClosureProven).toBe(true); expect(receipt.originalChildWaited).toBe(true);
  expect(results.actualTotal).toBe(1); expect(results.actualPassed).toBe(1); expect(results.actualFailed).toBe(0);
  expect(results.actualPending).toBe(0); expect(results.exactOriginalSelection).toBe(true);
  return { archive, expectedSha256, receiptPath, receiptHash: hash(receiptBytes), bytes };
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
async function run(fault: boolean) {
  const kind = "NONEMPTY" as const, input = await retainedInput(kind), parent = process.env.WORKER_V5_NATIVE_FIXTURE_PARENT;
  ensure(parent && isAbsolute(parent) && resolve(parent) === parent && await realpath(parent) === parent, "private_parent");
  const root = await mkdtemp(join(parent, ".native-v5-target-")); await chmod(root, 0o700);
  const owner: Owner = { work: [] }; owners.add(owner);
  let failed = false, failure: unknown, persistedD1: string | undefined;
  let closedIdentities: { source: string; target: string } | undefined;
  try {
    let bundle: Awaited<ReturnType<typeof build>> | undefined, buildFailed = false, buildFailure: unknown;
    try { bundle = await original(owner, () => build({ stdin: { resolveDir: join(SOURCE_ROOT, "worker/recovery"),
      loader: "ts", contents: workerCode }, bundle: true, platform: "browser", format: "esm", target: "es2022", write: false, logLevel: "silent" })); }
    catch (error) { buildFailed = true; buildFailure = error; }
    try { await stop(); } catch (cleanup) { throw buildFailed ? new AggregateError([buildFailure, cleanup], "Original build and stop failed") : cleanup; }
    if (buildFailed) throw buildFailure;
    ensure(bundle?.outputFiles?.length === 1, "bundle"); expect(bundle.warnings).toEqual([]);
    const bucketName = "v5-target-" + randomUUID().replaceAll("-", "");
    const namespace = JSON.stringify({ kind: "local-r2", installationId: randomUUID(), bucketName });
    owner.native = new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: "2026-07-20",
      d1Databases: { DB: randomUUID(), RECOVERY_DB: randomUUID() }, d1Persist: join(root, "d1"),
      r2Buckets: { ASSETS: bucketName }, r2Persist: join(root, "r2"), log: new Log(LogLevel.ERROR),
      bindings: { R2_BOOTSTRAP_NAMESPACE: namespace, RECOVERY_TARGET_ID: "isolated-v5-native-target", AUTH_MODE: "access" } });
    persistedD1 = owner.native.unsafeGetPersistPaths().get("d1");
    ensure(persistedD1, "original_persisted_d1_path");
    await original(owner, () => owner.native!.ready);
    const source = await original(owner, () => owner.native!.getD1Database("DB"));
    for (const migration of PORTABLE_RUNTIME_RECOVERY_MIGRATIONS) {
      const sql = await readFile(join(SOURCE_ROOT, "migrations", migration.name), "utf8");
      expect(hash(sql)).toBe(migration.sha256);
      const results = await original(owner, () => source.batch(splitSql(sql).map(statement => source.prepare(statement))));
      expect(results.every(result => result.success)).toBe(true);
    }
    const setup = await original(owner, () => owner.native!.dispatchFetch("https://native-v5.invalid/setup", { method: "POST" }));
    expect(setup.status).toBe(200); expect(await original(owner, () => setup.json())).toEqual({ setup: true });
    const response = await original(owner, () => owner.native!.dispatchFetch("https://native-v5.invalid/construct",
      { method: "POST", body: Uint8Array.from(input.bytes).buffer, headers: { "content-type": "application/zip", "x-original-archive-sha256": input.expectedSha256,
        "x-original-file-count": "1", "x-original-ack-fault": fault ? "1" : "0" } }));
    const responseBytes = await original(owner, () => response.arrayBuffer());
    await original(owner, () => writeFile(join(root, "original-native-response.json"), new Uint8Array(responseBytes), { flag: "wx", mode: 0o600 }));
    const answer = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes)));
    expect(response.status, JSON.stringify({ phase: answer.phase, reason: answer.reason })).toBe(200);
    ensure(typeof answer.sourceInstallationId === "string" && /^[a-f0-9]{32}$/.test(answer.sourceInstallationId)
      && typeof answer.targetInstallationId === "string" && /^[a-f0-9]{32}$/.test(answer.targetInstallationId)
      && answer.sourceInstallationId !== answer.targetInstallationId, "closed_native_identities");
    closedIdentities = { source: answer.sourceInstallationId, target: answer.targetInstallationId };
    expect(answer.sourceUnchanged).toBe(true); expect(answer.calls).toEqual({ put: 1, delete: 0 });
    if (fault) {
      expect(answer.fault).toBe(true); expect(answer.originalRejected).toBe(true); expect(answer.firstRejectionRetained).toBe(true);
      expect(answer.attemptUnknown).toBe(true); expect(answer.noPublication).toBe(true); expect(answer.executionEnabled).toBe(false);
      expect(answer.originalStoredBytes).toBe(68); ensure(typeof answer.originalStoredSha256 === "string", "original_unknown_bytes_hash");
    } else {
      expect(answer.format).toBe("v5"); expect(answer.sourceFileCount).toBe(1); expect(answer.archiveSha256).toBe(input.expectedSha256);
      expect(answer.freshIdentity).toBe(true); expect(answer.mappingExact).toBe(true); expect(answer.missingMappingRejected).toBe(true);
      expect(answer.mappingCount).toBe(1); expect(answer.actualByteSize).toBe(68);
      expect(answer.receipt).toMatchObject({ checkpointId: "portable-runtime/v28", publishedFiles: 1, bytesPublished: 68,
        archiveSha256: input.expectedSha256, accountsDisabled: true, collaborationEnabled: false, localBindingsRestored: false,
        executionEnabled: false, maintenanceState: "fenced", payloadPublication: true, persistedAttempts: true,
        jobAdmission: false, recoveryReady: false, fullV28EnvelopeValidated: true, immutableShadowHistoryPreserved: true, rawMigrationExecution: false, targetLedger: "reviewed-code-catalog", deploymentChanged: false });
      const proof = object(answer.proof);
      for (const key of ["oldRowsExact", "oldRowidsExact", "appendsClosed", "emptyLocal", "inertDefaults", "foreignKeys", "tableIntegrity"]) expect(proof[key], key).toBe(true);
      expect(proof.globalNativeIntegrity).toBe(false); expect(proof.accountRows).toBeGreaterThan(0); expect(proof.disabledAccounts).toBe(proof.accountRows);
    }
    const bucket = await original(owner, () => owner.native!.getR2Bucket("ASSETS"));
    const objects = await original(owner, () => bucket.list());
    expect(objects.truncated).toBe(false); expect(objects.objects).toHaveLength(1);
    // The original Node producer/ZIP are distinct historical scopes. Verify
    // neither is changed by the new native constructor or its mapped R2 plan.
    expect(hash(await readFile(input.archive))).toBe(input.expectedSha256);
    expect(hash(await readFile(input.receiptPath))).toBe(input.receiptHash);
  } catch (error) { failed = true; failure = error; }
  try { await close(owner); } catch (cleanup) { throw failed ? new AggregateError([failure, cleanup], "Original operation and close failed") : cleanup; }
  if (failed) throw failure;
  ensure(persistedD1 && closedIdentities && !owners.has(owner), "original_native_close_before_whole_check");
  await verifyClosedNativeD1(persistedD1, closedIdentities, join(root, "closed-native-file-consistency.json"));
}
it(titles[0], () => run(false), 120_000);
it(titles[1], () => run(true), 120_000);
