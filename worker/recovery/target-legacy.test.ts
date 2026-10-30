import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { convertedLegacyAllSlotsFixture } from "./legacy-all-slots-test-support";
import { nativeAcceptanceFixture } from "../uploads/native-acceptance-test-support";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import { createRecoveryTargetEngine, type RecoveryTargetInput } from "./target-import";
import { recoverySourceProfileId, reviewedRecoveryBinding } from "./target-files";
import { captureSystemBackupSnapshot } from "./backup-snapshot";
import { finishSystemBackupManifest, planSystemBackupSources, type SystemBackupFile } from "../../shared/contracts/system-backup";
import { stableJson, sha256Hex } from "../../shared/domain/content-addressing";
import { openShadowProfile } from "../files/shadow-profile";
import { RESEARCH_PACKAGE_CATALOG, type ResearchRecordKind } from "../../shared/contracts/research-package-catalog";
import { researchRecordsDocument, type ResearchDomainRecord, type ResearchPackageV1 } from "../../shared/contracts/research-package";
import { readImportDestinationSnapshot, prepareImportDomainPlan, prepareImportDomainPublication } from "../packages/import-domain";
import type { JobSqlDatabase } from "../files/jobs/sql-repository";

const handles:DatabaseSync[]=[],directories:string[]=[];
afterEach(async()=>{handles.splice(0).forEach(db=>db.close());vi.restoreAllMocks();vi.unstubAllGlobals();await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function drain(engine:ReturnType<typeof createRecoveryTargetEngine>,input:RecoveryTargetInput){
  for(let index=0;index<180;index++){input.ownerToken=crypto.randomUUID();input.generation++;
    const step=await engine.step(input);if(step.done)return step.report!;}
  throw new Error('Legacy recovery exceeded its bounded stage count');
}
async function qualifyRecoveredStatePackageReuse(sql:DatabaseSync){
  const media=sql.prepare(`SELECT sa.state_hash,sa.asset_id,sa.position,sa.file_id,a.r2_key,a.original_name,a.mime_type,a.created_at,
    f.purpose,f.verified_sha256 sha256,f.verified_byte_size byte_size,f.active_location_id location_id,
    p.id profile_id,p.configuration_revision profile_revision,p.namespace_identity
    FROM state_representation_assets sa JOIN assets a ON a.id=sa.asset_id
    JOIN file_usable_publications f ON f.file_id=sa.file_id JOIN file_location_publications l ON l.location_id=f.active_location_id
    JOIN storage_profiles p ON p.id=l.storage_profile_id WHERE sa.asset_id='legacy-state-asset'`).get()!;
  expect(media.r2_key).toBe('legacy/state'); expect(media.file_id).toEqual(expect.any(String));
  const state=sql.prepare('SELECT * FROM state_representations WHERE hash=?').get(media.state_hash)!;
  const {hash:_stateHash,...stateCells}=state;
  const createdAt=String(state.created_at), hash=String(media.state_hash), logical='recovered-state-file', foreignAlias='asset:foreign-state-alias';
  const record=(kind:ResearchRecordKind,sourceId:string,override:Record<string,unknown>):ResearchDomainRecord=>{
    const catalog=RESEARCH_PACKAGE_CATALOG[kind],data=Object.fromEntries(Object.entries(catalog.fields).map(([field,rule])=>[field,
      rule.nullable?null:rule.type==='integer'?1:rule.type==='number'?0:rule.type==='json'?{}:field.endsWith('_at')?createdAt:'literal']));
    Object.assign(data,override);
    const value=catalog.revision.scheme==='contentHash'?sourceId:catalog.revision.scheme==='timestamp'?String(data[catalog.revision.field!]):createdAt;
    return{kind,sourceId,sourceRevision:{scheme:catalog.revision.scheme,value},data};
  };
  const records=[record('sample','foreign-state-copy-owner',{code:'RECOVERED-STATE-COPY',title:'Recovered State package copy',status:'stored',pinned:0,inherited_state_hash:hash}),
    record('state',hash,{...stateCells,content_json:JSON.parse(String(state.content_json))}),
    record('fileAlias',foreignAlias,{alias_kind:'asset',packageFileId:logical,original_name:media.original_name,mime_type:media.mime_type,
      byte_size:media.byte_size,sha256:media.sha256,created_at:media.created_at}),
    record('stateAsset',JSON.stringify([hash,foreignAlias]),{state_hash:hash,asset_id:foreignAlias,position:media.position,packageFileId:logical})];
  const pkg:ResearchPackageV1={schema:'research-package/1',kind:'data_package',packageId:'recovered-state-package',sourceInstallationId:'independent-package-source',
    createdAt,roots:[{kind:'sample',id:'foreign-state-copy-owner'}],records,files:[{packageFileId:logical,path:`files/${logical}`,sha256:String(media.sha256),
      byteSize:Number(media.byte_size),purpose:'embedded_content',mediaType:String(media.mime_type)}],dependencies:[],completeness:'complete',
    counts:{records:records.length,files:1,bytes:Number(media.byte_size)},recordsSha256:await sha256Hex(stableJson(researchRecordsDocument(records))),
    report:{htmlPath:'report/index.html',markdownPath:'report/report.md'}};
  const host=new SqliteD1Database(sql),database:JobSqlDatabase={prepare:query=>host.prepare(query),batch:statements=>host.batch(statements as never),primary(){return this;}};
  const target={packageFileId:logical,destinationFileId:'new-copy-candidate',assetId:'new-copy-alias',profileId:String(media.profile_id),
    profileRevision:Number(media.profile_revision),namespaceIdentity:String(media.namespace_identity),purpose:'embedded_content' as const,
    scope:'system' as const,sha256:String(media.sha256),byteSize:Number(media.byte_size)};
  const plan=async()=>{let identity=0;return prepareImportDomainPlan(pkg,{files:[target],destination:await readImportDestinationSnapshot(database,pkg),
    acceptedAt:createdAt,randomId:()=>`recovered-state-copy-${++identity}`});};
  const reused=await plan();
  expect(reused.fileReuses).toEqual([{packageFileId:logical,fileId:media.file_id,locationId:media.location_id,assetId:media.asset_id}]);
  expect(reused.rows.some(row=>row.kind==='state'||row.kind==='stateAsset')).toBe(false);
  const before=stableJson(sql.prepare('SELECT * FROM state_representations WHERE hash=?').get(hash)),bindingBefore=stableJson(sql.prepare('SELECT * FROM state_representation_assets WHERE state_hash=?').all(hash));
  await database.batch(prepareImportDomainPublication(database,reused));
  expect(sql.prepare('SELECT inherited_state_hash FROM samples WHERE id=?').get(reused.roots[0].id)).toEqual({inherited_state_hash:hash});
  expect(stableJson(sql.prepare('SELECT * FROM state_representations WHERE hash=?').get(hash))).toBe(before);
  expect(stableJson(sql.prepare('SELECT * FROM state_representation_assets WHERE state_hash=?').all(hash))).toBe(bindingBefore);
  // Fault injection stays inside rolled-back transactions. Exact origin and
  // State association are required; a usable File and equal bytes alone fail.
  for(const mutation of [
    ()=>{sql.exec('DROP TRIGGER recovery_file_binding_evidence_delete_guard');sql.prepare("DELETE FROM recovery_file_binding_evidence WHERE consumer_kind='state_representation_asset' AND consumer_id=? AND consumer_sub_id=?").run(hash,media.asset_id);},
    ()=>{sql.exec('DROP TRIGGER recovery_file_alias_evidence_update_guard');sql.prepare("UPDATE recovery_file_alias_evidence SET original_json=json_set(original_json,'$.r2_key','unqualified/origin') WHERE table_name='assets' AND alias_id=?").run(media.asset_id);},
    ()=>{sql.prepare("INSERT INTO file_location_integrity_quarantine(location_id,reason,expected_byte_size,expected_sha256,operation_id,detected_at,last_checked_at) VALUES(?,'missing',?,?,?, ?,?)").run(media.location_id,media.byte_size,media.sha256,'qualification-quarantine',createdAt,createdAt);},
  ]){
    sql.exec('BEGIN');try{mutation();await expect(plan()).rejects.toThrow('definition_media_destination_conflict');}finally{sql.exec('ROLLBACK');}
  }
  expect((await plan()).fileReuses).toEqual(reused.fileReuses);
}
it("converts an actual V8 all13-slot legacy archive to verified S3 Files, retains original byte locators/history, and rebacks up into another fresh R2 target",async()=>{
  const directory=await mkdtemp(join(tmpdir(),'fp5-all13-'));directories.push(directory);
  const converted=await convertedLegacyAllSlotsFixture(directory),capability=await nativeAcceptanceFixture(false,{throughMigration:'0022_fp5_recovery_evidence.sql'});handles.push(capability.sql);
  const sql=referenceTestDatabase();handles.push(sql);sql.exec('PRAGMA foreign_keys=ON');
  const sourceBefore=await readFile(join(directory,'legacy-all-slots.zip'));
  const env={...capability.env,RECOVERY_DB:new SqliteD1Database(sql) as unknown as D1Database,RECOVERY_TARGET_ID:'legacy-first'};
  const input:RecoveryTargetInput={jobId:crypto.randomUUID(),incarnation:crypto.randomUUID().replaceAll('-',''),ownerToken:crypto.randomUUID(),generation:0,
    expectedTargetId:'legacy-first',records:converted.records,manifest:converted.manifest,mode:'historical',current:async()=>true,
    mapping:[...new Set(converted.manifest.files.map(recoverySourceProfileId))].map(sourceProfileId=>({sourceProfileId,destinationProfileId:capability.admission.nativeProfileId,configurationRevision:1})),
    openPayload:async file=>new Response(converted.capsulePayloads.get(file.path!)!.slice().buffer).body!};
  const engine=createRecoveryTargetEngine(env);expect(await engine.preview(input)).toMatchObject({available:true});
  const report=await drain(engine,input);expect(report.verified).toBe(true);expect(report.protectedSettings).toMatchObject({included:false,nativeBindingsEnabled:false});
  const slots=new Set<string>();
  for(const source of converted.manifest.files)for(const binding of source.bindings){
    const spec=reviewedRecoveryBinding(binding),keys=Object.keys(spec.keys),row=sql.prepare(`SELECT "${spec.column}" file_id FROM "${spec.table}" WHERE ${keys.map(key=>`"${key}"=?`).join(' AND ')}`).get(...keys.map(key=>spec.keys[key]));
    expect(row?.file_id).toEqual(expect.any(String));slots.add(`${binding.consumerKind}:${binding.fileSlot}`);
  }
  expect(slots.size).toBe(13);
  await qualifyRecoveredStatePackageReuse(sql);
  for(const original of converted.records.content.tables.assets){
    const restored=sql.prepare('SELECT * FROM assets WHERE id=?').get(original.id)!;
    for(const [column,value]of Object.entries(original))if(column!=='file_id')expect(restored[column],`${original.id}:${column}`).toEqual(value);
  }
  expect(sql.prepare('PRAGMA table_info(samples)').all().some(column=>column.name==='process_revision')).toBe(false);
  expect(sql.prepare("SELECT count(*) n FROM recovery_file_binding_evidence WHERE purpose='derived_preview'").get()).toMatchObject({n:expect.any(Number)});
  expect(sql.prepare("SELECT count(*) n FROM recovery_file_evidence WHERE purpose='derived_preview' AND producer_trust<>'untrusted_import'").get()).toEqual({n:0});
  expect(sql.prepare('SELECT enabled,incarnation FROM file_authority_runtime_guard').get()).toEqual({enabled:0,incarnation:null});
  expect(sql.prepare('SELECT count(*) n FROM system_storage_native_bindings').get()).toEqual({n:0});
  expect(await readFile(join(directory,'legacy-all-slots.zip'))).toEqual(sourceBefore);
  const records=await captureSystemBackupSnapshot(env.RECOVERY_DB,{backupId:crypto.randomUUID(),acquireHolds:false}),payloads=new Map<string,Uint8Array>(),files:SystemBackupFile[]=[];
  for(const source of planSystemBackupSources(records.content)){
    const storage=await openShadowProfile(capability.env,{profileId:source.source.storageProfileId!,configurationRevision:1},'read');
    const observed=await storage.reader.read(source.source.objectKey);if(observed.outcome!=='available')throw new Error('Recovered payload unavailable');
    const bytes=new Uint8Array(await new Response(observed.body).arrayBuffer());payloads.set(source.id,bytes);
    files.push({...source,path:`files/${source.id}`,outcome:'packaged',byteSize:bytes.length,sha256:await sha256Hex(bytes.buffer)});
  }
  const manifest=await finishSystemBackupManifest(records,files);expect(records.content.relocatedSources.length).toBeGreaterThan(0);
  const second=referenceTestDatabase();handles.push(second);second.exec('PRAGMA foreign_keys=ON');
  const next:RecoveryTargetInput={...input,jobId:crypto.randomUUID(),incarnation:crypto.randomUUID().replaceAll('-',''),generation:0,expectedTargetId:'legacy-second',records,manifest,
    mapping:[...new Set(manifest.files.map(recoverySourceProfileId))].map(sourceProfileId=>({sourceProfileId,destinationProfileId:'r2-profile',configurationRevision:1})),openPayload:async file=>new Response(payloads.get(file.id)!.slice().buffer).body!};
  const firstCanonical=stableJson(sql.prepare('SELECT id,code,title,description FROM samples ORDER BY id').all());
  expect((await drain(createRecoveryTargetEngine({...capability.env,RECOVERY_DB:new SqliteD1Database(second) as unknown as D1Database,RECOVERY_TARGET_ID:'legacy-second'}),next)).verified).toBe(true);
  expect(stableJson(second.prepare('SELECT id,code,title,description FROM samples ORDER BY id').all())).toBe(firstCanonical);
  expect(second.prepare('PRAGMA foreign_key_check').all()).toEqual([]);expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
},120_000);
