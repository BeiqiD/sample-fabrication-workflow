import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect } from "vitest";
import { checkedResearchJobStatus, checkedResearchPackagePreview, checkedResearchRequestReceipt } from "../../shared/contracts/research-package-api";
import { RESEARCH_PACKAGE_CATALOG, type ResearchRecordKind } from "../../shared/contracts/research-package-catalog";
import { REFERENCE_IMPORT_KINDS, type ImportIdentityKind } from "../../worker/packages/import-domain-identity";
import type { FrozenImportDomainPlan } from "../../worker/packages/import-domain-types";
import { researchRecordsDocument, validateResearchPackage, type ResearchPackageV1 } from "../../shared/contracts/research-package";
import { stableJson } from "../../shared/domain/content-addressing";
import { createStoreArchiveStream, measureStoreArchive, sourceFromBlob, validateStoreArchive, type ArchiveEntry } from "../../shared/domain/research-archive";
import { buildImportDomainFixture } from "../../worker/packages/import-domain-test-support";
import { actor, count, fixture, it, retainOriginalOperation } from "../files/jobs/local-runtime.qualification-support";

type Fixture=Awaited<ReturnType<typeof fixture>>;
const prefix="/api/packages";
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function released(f:Fixture){expect(count(f.native,"system_recovery_write_leases","released_at IS NULL")).toBe(0);expect(f.native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);}
async function archive(){
  const value=await buildImportDomainFixture(),{records,...manifest}=value.package,encode=new TextEncoder();
  const contents=new Map<string,Uint8Array>([["manifest.json",encode.encode(stableJson(manifest))],
    ["records.json",encode.encode(stableJson(researchRecordsDocument(records)))],
    ["report/index.html",encode.encode("<!doctype html><p>Inert qualification report</p>")],
    ["report/report.md",encode.encode("# Qualification report")],
    ...value.package.files.map(file=>[file.path,value.payloads.get(file.packageFileId)!] as const)]);
  const entries:ArchiveEntry[]=[...contents].map(([path,bytes])=>({path,kind:path.startsWith("files/")?"payload":path.startsWith("report/")?"report":"metadata",byteSize:bytes.byteLength,sha256:hash(bytes)}));
  const open=async(entry:ArchiveEntry)=>new Response(contents.get(entry.path)!.slice().buffer as ArrayBuffer).body!;
  const measured=await measureStoreArchive(entries,open);
  const bytes=new Uint8Array(await new Response(createStoreArchiveStream(entries,open)).arrayBuffer());
  expect(bytes.byteLength).toBe(measured.byteSize);expect(hash(bytes)).toBe(measured.sha256);
  return{value,bytes,measured};
}
async function drain(f:Fixture,jobId:string,expected:string){
  for(let i=0;i<36;i++){
    const before=checkedResearchJobStatus((await f.request("GET",`${prefix}/jobs/${jobId}`)).value);
    if(before.state===expected)return before;
    // A real independently invoked original emitter; GET/status above never
    // claims work. This proves dispatcher independence, not elapsed120s cadence.
    const step=await f.dispatchJobsOnce();expect(step.outcome).not.toBe("paused");
  }
  throw new Error("Bounded original Package dispatcher did not reach its checkpoint");
}

/** Reuse the original graph/assertGraph publication oracle against this actual
 * native owner. Frozen rows establish exact publication; independent source
 * records, identity receipts and literals establish source semantics. No plan
 * or transformer is invoked here and no business row is seeded by the oracle. */
function typedGraph(f:Fixture,jobId:string,original:ResearchPackageV1){
  const row=f.native.prepare("SELECT domain_plan_json FROM research_package_jobs WHERE id=?").get(jobId)!;
  const frozen=JSON.parse(String(row.domain_plan_json)) as FrozenImportDomainPlan;
  const identities=f.native.prepare("SELECT entity_kind,source_id,destination_id FROM research_package_identity_maps WHERE job_id=? ORDER BY entity_kind,source_id").all(jobId);
  const mapped=(kind:ImportIdentityKind,id:string)=>{
    const identity=identities.find(value=>value.entity_kind===kind&&value.source_id===id);
    expect(identity,`${kind}:${id}`).toBeDefined();return String(identity!.destination_id);
  };
  const acceptedIdentities=identities.map(identity=>({kind:identity.entity_kind,sourceId:identity.source_id,destinationId:identity.destination_id}));
  expect(acceptedIdentities).toHaveLength(frozen.identities.length);
  expect(acceptedIdentities).toEqual(expect.arrayContaining(frozen.identities));
  for(const published of frozen.rows){
    const fields=RESEARCH_PACKAGE_CATALOG[published.kind].id;
    const actual=f.native.prepare(`SELECT * FROM ${published.table} WHERE ${fields.map(field=>`${field}=?`).join(" AND ")}`)
      .get(...fields.map(field=>published.data[field] as string|number|null));
    expect(actual,`${published.kind}:${published.sourceId}`).toMatchObject(published.data);
    if(fields.length===1&&fields[0]==='id')expect(published.id).not.toBe(published.sourceId);
  }
  const retained=f.native.prepare("SELECT record_json FROM research_package_records WHERE job_id=? ORDER BY ordinal").all(jobId);
  expect(retained.map(value=>JSON.parse(String(value.record_json)))).toEqual(original.records);
  expect(retained).toHaveLength(original.counts.records);
  const nativeRows=new Map<string,Record<string,unknown>>();
  for(const source of original.records){
    if(source.kind==='fileDerivation'||source.kind==='attachmentDerivative')continue;
    const definition=RESEARCH_PACKAGE_CATALOG[source.kind];
    const parts=definition.id.map(field=>{
      if(field==='id'||field==='hash')return mapped(source.kind,source.sourceId);
      const relation=definition.relations?.find(value=>value.field===field);
      return relation?mapped(relation.kind,String(source.data[field])):source.data[field] as string|number|null;
    });
    const actual=f.native.prepare(`SELECT * FROM ${definition.table} WHERE ${definition.id.map(field=>`${field}=?`).join(' AND ')}`).get(...parts)!;
    expect(actual,`${source.kind}:${source.sourceId}`).toBeDefined();nativeRows.set(`${source.kind}:${source.sourceId}`,actual);
    if(definition.id.length===1&&definition.id[0]==='id')expect(actual.id).not.toBe(source.sourceId);
    // Compare ordinary source fields directly to actual canonical cells, rather
    // than to the formatter's own expected rows. Only declared typed identities,
    // accepted naming and public JSON projection fields need separate checks.
    const typed=new Set([...(definition.relations??[]).map(value=>value.field),
      'last_mutation_id','deletion_operation_id','asset_deletion_operation_id','supersession_operation_id','creation_operation_id',
      'run_group_id','operation_group_id','metadata','relationships','target','contexts','excluded_targets']);
    for(const [field,value] of Object.entries(source.data)){
      if(typed.has(field)||field==='packageFileId'||field.endsWith('PackageFileId')||!Object.hasOwn(actual,field))continue;
      const naming=frozen.naming.find(value=>value.kind===source.kind&&value.sourceId===source.sourceId&&value.field===field);
      if(naming){expect(naming.original).toBe(value);expect(actual[field]).toBe(naming.destination);continue;}
      const observed=definition.fields[field].type==='json'&&actual[field]!==null?JSON.parse(String(actual[field])):actual[field];
      expect(observed,`${source.kind}:${source.sourceId}.${field}`).toEqual(value);
    }
    for(const relation of definition.relations??[]){
      const value=source.data[relation.field];
      expect(actual[relation.field],`${source.kind}:${source.sourceId}.${relation.field}`)
        .toBe(value===null?null:mapped(relation.kind,String(value)));
    }
  }
  const copied=(kind:ResearchRecordKind,sourceId:string)=>nativeRows.get(`${kind}:${sourceId}`)!;
  const sources=(kind:ResearchRecordKind)=>original.records.filter(value=>value.kind===kind);
  expect(sources('comment')).toHaveLength(1);expect(sources('commentTarget')).toHaveLength(2);
  expect(copied('comment','foreign-common-comment').body).toBe('One canonical Common Comment body');
  for(const source of sources('commentOccurrence')){
    const actual=copied(source.kind,source.sourceId);
    expect(actual.operation_group_id).toBe(source.data.operation_group_id===null?null:mapped('comment',String(source.data.operation_group_id)));
    expect(actual.legacy_body).toBe(source.data.legacy_body);
  }
  const references=sources('reference');expect(references).toHaveLength(9);
  for(const source of references){
    const actual=copied(source.kind,source.sourceId),target=source.data.target as {kind:ResearchRecordKind;sourceId:string};
    expect(actual.target_type).toBe(Object.entries(REFERENCE_IMPORT_KINDS).find(([,kind])=>kind===target.kind)![0]);
    expect(actual.target_id).toBe(mapped(target.kind,target.sourceId));
    const contexts=source.data.contexts as Array<{segments:Array<{target:{kind:ResearchRecordKind;sourceId:string};label:string;deletedAt:null|string;archivedAt:null|string}>}>;
    expect(JSON.parse(String(actual.last_known_contexts_json))).toEqual(contexts.map(context=>({segments:context.segments.map(segment=>({
      type:Object.entries(REFERENCE_IMPORT_KINDS).find(([,kind])=>kind===segment.target.kind)![0],id:mapped(segment.target.kind,segment.target.sourceId),
      label:segment.label,deletedAt:segment.deletedAt,archivedAt:segment.archivedAt,
    }))})));
  }
  const placements=sources('projectPlacement');expect(placements).toHaveLength(11);
  for(const source of placements)expect(copied(source.kind,source.sourceId)).toMatchObject({
    project_item_id:mapped('projectItem',String(source.data.project_item_id)),x:source.data.x,y:source.data.y,width:source.data.width,height:source.data.height,
    z_index:source.data.z_index,revision:source.data.revision,
  });
  expect(copied('projectContent','foreign-content-attachment')).toMatchObject({deleted_at:original.createdAt,attachment_caption:'Deleted attachment history'});
  expect(copied('projectItem','foreign-owned-item-attachment').deleted_at).toBe(original.createdAt);
  expect(copied('projectEdge','foreign-edge-reverse')).toMatchObject({deleted_at:original.createdAt,label:'Preserved cyclic graph edge'});
  expect(copied('sample','foreign-sample').title).toBe('foreign-run-one remains literal title');
  expect(copied('runStep','foreign-step-one').notes).toBe('foreign-step-two is literal history text');
  const definition=sources('stepDefinition')[0],state=sources('state')[0];
  expect(mapped('stepDefinition',definition.sourceId)).toBe(definition.sourceId);expect(mapped('state',state.sourceId)).toBe(state.sourceId);
  expect(copied('stepDefinition',definition.sourceId)).toMatchObject({hash:definition.sourceId,
    parameters_text:'foreign-run-one is ordinary parameter text',comments_text:'Original researcher note'});
  expect(JSON.parse(String(copied('stepDefinition',definition.sourceId).canonical_json))).toEqual(definition.data.canonical_json);
  expect(copied('state',state.sourceId).hash).toBe(state.sourceId);
  expect(JSON.parse(String(copied('state',state.sourceId).content_json))).toEqual(state.data.content_json);
  const ordered=sources('stateAsset').sort((left,right)=>Number(left.data.position)-Number(right.data.position)).map(source=>copied(source.kind,source.sourceId));
  expect(ordered.map(value=>value.position)).toEqual([0,1]);expect(ordered[0].asset_id).not.toBe(ordered[1].asset_id);expect(ordered[0].file_id).not.toBe(ordered[1].file_id);
  const metadata=JSON.parse(String(copied('event','foreign-event').metadata_json));
  expect(copied('event','foreign-event').body).toBe('foreign-run-one remains ordinary event text');
  expect(metadata.rawCells).toEqual({stepId:'foreign-step-one'});expect(metadata.caption).toBe('Original <b>caption</b>');
  expect(metadata.runId).toBe(mapped('run','foreign-run-one'));expect(metadata.stepIds).toEqual([mapped('runStep','foreign-step-one'),mapped('runStep','foreign-step-two')]);
  expect(copied('projectContent','foreign-content-markdown').markdown_source).toBe('# Original Markdown\n\nforeign-run-one remains user text.');
  const fileMap=f.native.prepare("SELECT logical_file_id,result_file_id FROM research_package_files WHERE job_id=? AND entry_kind='payload'").all(jobId);
  const slots:Array<[ResearchRecordKind,string,string]>=[['stateAsset','packageFileId','file_id'],['executionImage','packageFileId','file_id'],
    ['metrologyReference','packageFileId','file_id'],['commentOccurrence','packageFileId','file_id'],['stateVerification','evidencePackageFileId','evidence_file_id'],
    ['commentItem','packageFileId','file_id'],['projectAttachment','packageFileId','file_id'],['recipeRevision','sourcePackageFileId','source_file_id'],
    ['sourceImport','workbookPackageFileId','workbook_file_id'],['sourceImport','manifestPackageFileId','manifest_file_id'],
    ['event','packageFileId','asset_file_id'],['event','thumbnailPackageFileId','thumbnail_file_id'],['attachmentDerivative','derivedPackageFileId','']];
  for(const [kind,field,column] of slots){
    const records=sources(kind).filter(value=>typeof value.data[field]==='string');expect(records.length,`${kind}.${field}`).toBeGreaterThan(0);
    for(const source of records){
      const file=fileMap.find(value=>value.logical_file_id===source.data[field]);expect(file).toBeDefined();
      if(column)expect(copied(kind,source.sourceId)[column],`${kind}.${field}`).toBe(file!.result_file_id);
      else{
        expect(source.data.trust_state).toBe('imported_unverified');
        expect(f.native.prepare('SELECT file_id FROM file_usable_publications WHERE file_id=?').get(file!.result_file_id)).toBeDefined();
      }
    }
  }
  const sourceImport=copied('sourceImport','foreign-source-import');
  for(const field of ['operation_id','lease_expires_at','finalization_id','recovery_operation_id','client_request_id','request_sha256','request_input_json','request_scope',
    'storage_profile_id','storage_profile_revision','storage_policy_revision','accepted_result_json','file_targets_protocol','role_policy_revision'])expect(sourceImport[field],field).toBeNull();
  for(const kind of ['fileDerivation','attachmentDerivative'] as const)expect(sources(kind)[0].data.trust_state).toBe('imported_unverified');
  expect(count(f.native,'file_derivations')).toBe(0);expect(count(f.native,'attachment_derivatives')).toBe(0);
  expect(f.native.prepare('PRAGMA foreign_key_check').all()).toEqual([]);expect(f.native.prepare('PRAGMA defer_foreign_keys').get()).toEqual({defer_foreign_keys:0});
}
function serializedSlots(pkg:ResearchPackageV1){
  const slots:Array<[ResearchRecordKind,string]>=[['stateAsset','packageFileId'],['executionImage','packageFileId'],['metrologyReference','packageFileId'],
    ['commentOccurrence','packageFileId'],['stateVerification','evidencePackageFileId'],['commentItem','packageFileId'],['projectAttachment','packageFileId'],
    ['recipeRevision','sourcePackageFileId'],['sourceImport','workbookPackageFileId'],['sourceImport','manifestPackageFileId'],
    ['event','packageFileId'],['event','thumbnailPackageFileId'],['attachmentDerivative','derivedPackageFileId']];
  for(const [kind,field] of slots){const values=pkg.records.filter(record=>record.kind===kind&&typeof record.data[field]==='string');
    expect(values.length,`${kind}.${field}`).toBeGreaterThan(0);for(const value of values)expect(pkg.files.some(file=>file.packageFileId===value.data[field])).toBe(true);}
  for(const kind of ['fileDerivation','attachmentDerivative'] as const)expect(pkg.records.find(record=>record.kind===kind)!.data.trust_state).toBe('imported_unverified');
}

describe("explicit current Node Package Request admission",()=>{
  let f:Fixture;
  beforeEach(()=>retainOriginalOperation(async()=>{f=await fixture({administrator:true});}));
  it("keeps Package HTTP unavailable when localJobs opt-in is omitted",async()=>{
    expect(f.prototype.unsupportedRouteOwners).toContain("package");
    expect((await f.request("GET",prefix+"/jobs")).status).toBe(503);
    expect(count(f.native,"research_package_jobs")).toBe(0);released(f);
  });
});
describe("ordinary Node Package metadata and original Request fences",()=>{
  let f:Fixture,data:Awaited<ReturnType<typeof archive>>;
  beforeEach(()=>retainOriginalOperation(async()=>{f=await fixture({administrator:false,enableLocalJobs:true});data=await archive();}));
  it("requires original CSRF and admits ordinary actor history without startup execution",async()=>{
    const input={requestId:randomUUID(),byteSize:data.bytes.byteLength,sha256:data.measured.sha256};
    expect((await f.request("POST",prefix+"/uploads",input,{"x-sfw-csrf":"invalid"})).status).toBe(403);
    expect(count(f.native,"research_package_jobs")).toBe(0);
    const accepted=await f.request("POST",prefix+"/uploads",input);expect(accepted.status).toBe(202);
    const receipt=checkedResearchRequestReceipt(accepted.value),replay=checkedResearchRequestReceipt((await f.request("POST",prefix+"/uploads",input)).value);
    expect(replay).toEqual(receipt);expect(receipt.job.state).toBe("awaiting_upload");
    expect((await f.request("GET",prefix+"/jobs")).status).toBe(200);
    expect((await f.request("PUT",`${prefix}/jobs/${receipt.job.id}/upload`,data.bytes,{"content-type":"application/zip"})).status).toBe(503);
    expect(await f.dispatchJobsOnce()).toEqual({jobId:null,outcome:"disabled"});
    expect(count(f.native,"research_package_attempts")).toBe(0);expect(count(f.native,"local_admin_grants")).toBe(0);released(f);
  });
});
describe("genuine nonempty Node Package HTTP and independent executor",()=>{
  let f:Fixture,data:Awaited<ReturnType<typeof archive>>,uploadId:string,input:{requestId:string;uploadJobId:string;anotherCopy:boolean;expectedRolePolicyRevision:number};
  beforeEach(()=>retainOriginalOperation(async()=>{
    f=await fixture({administrator:true,enableLocalJobs:true});data=await archive();
    expect((await f.request("POST","/api/files/migrations/executor",{enabled:true})).status).toBe(200);
    // Revoke only the fixture's already-genuine administrator grant after its
    // explicit enable operation. No business relation/File/profile is seeded.
    f.native.prepare("DELETE FROM local_admin_grants").run();
    const accepted=await f.request("POST",prefix+"/uploads",{requestId:randomUUID(),byteSize:data.bytes.byteLength,sha256:data.measured.sha256});
    expect(accepted.status).toBe(202);uploadId=checkedResearchRequestReceipt(accepted.value).job.id;
    const sent=await f.request("PUT",`${prefix}/jobs/${uploadId}/upload`,data.bytes,{"content-type":"application/zip","content-length":String(data.bytes.byteLength)});
    expect(sent.status).toBe(200);await drain(f,uploadId,"preview");
    const preview=checkedResearchPackagePreview((await f.request("GET",`${prefix}/jobs/${uploadId}/preview`)).value);
    expect(preview.counts.files).toBe(15);expect(preview.rolePolicyRevision).not.toBeNull();
    input={requestId:randomUUID(),uploadJobId:uploadId,anotherCopy:false,expectedRolePolicyRevision:preview.rolePolicyRevision!};released(f);
  }));
  it("copies all15 verified Files through HTTP, publishes one typed graph and downloads its captured native ZIP",async()=>{
    const accepted=await f.request("POST",prefix+"/imports",input);expect(accepted.status).toBe(202);
    const receipt=checkedResearchRequestReceipt(accepted.value),job=await drain(f,receipt.job.id,"completed");
    expect(job.progress).toMatchObject({completedFiles:15,totalFiles:15});expect(job.result?.roots.length).toBe(2);
    expect(count(f.native,"local_admin_grants")).toBe(0);
    typedGraph(f,job.id,data.value.package);
    const files=f.native.prepare(`SELECT p.logical_file_id,p.result_file_id,p.purpose,p.sha256,p.byte_size,a.original_name,a.mime_type
      FROM research_package_files p LEFT JOIN assets a ON a.id=p.candidate_asset_id
      WHERE p.job_id=? AND p.entry_kind='payload' ORDER BY p.logical_file_id`).all(job.id);
    expect(files).toHaveLength(15);
    expect(new Set(files.map(file=>file.result_file_id)).size).toBe(15);
    for(const source of data.value.package.files){
      const copy=files.find(file=>file.logical_file_id===source.packageFileId)!;
      expect(copy).toMatchObject({purpose:source.purpose,sha256:source.sha256,byte_size:source.byteSize});
      const alias=data.value.package.records.find(record=>record.kind==='fileAlias'&&record.data.packageFileId===source.packageFileId);
      if(alias)expect(copy).toMatchObject({original_name:alias.data.original_name,mime_type:alias.data.mime_type});
      expect(copy.result_file_id).not.toBe(source.packageFileId);
    }
    const replay=checkedResearchRequestReceipt((await f.request("POST",prefix+"/imports",input)).value);expect(replay.job.id).toBe(job.id);
    const roots=job.result!.roots;
    const exportAnswer=await f.request("POST",prefix+"/jobs",{requestId:randomUUID(),kind:"data_package",roots});expect(exportAnswer.status).toBe(202);
    const exported=await drain(f,checkedResearchRequestReceipt(exportAnswer.value).job.id,"completed");
    expect(exported.output?.available).toBe(true);
    const download=await f.request("GET",`${prefix}/jobs/${exported.id}/download`);
    expect(download.status).toBe(200);expect(download.value).toBeInstanceOf(Uint8Array);
    const body=download.value as Uint8Array;
    expect(body.byteLength).toBe(exported.output!.byteSize);expect(hash(body)).toBe(exported.output!.sha256);
    const validated=await validateStoreArchive(sourceFromBlob(new Blob([body.slice().buffer as ArrayBuffer])),{expectedSha256:exported.output!.sha256});
    expect(validated.entries.filter(entry=>entry.path.startsWith('files/'))).toHaveLength(15);
    const exportedPackage=await validateResearchPackage(JSON.parse(new TextDecoder().decode(validated.metadata.get('manifest.json')!)),
      JSON.parse(new TextDecoder().decode(validated.metadata.get('records.json')!)));
    serializedSlots(exportedPackage);
    const captured=f.native.prepare("SELECT logical_file_id,archive_path,source_file_id FROM research_package_files WHERE job_id=? AND entry_kind='source' ORDER BY archive_path").all(exported.id);
    expect(captured).toHaveLength(15);expect(exportedPackage.files).toHaveLength(15);
    expect(validated.entries.map(entry=>entry.path).sort()).toEqual(['manifest.json','records.json','report/index.html','report/report.md',...exportedPackage.files.map(file=>file.path)].sort());
    for(const capture of captured){
      const imported=files.find(file=>file.result_file_id===capture.source_file_id)!;
      expect(imported).toBeDefined();
      const declaration=exportedPackage.files.find(file=>file.packageFileId===capture.logical_file_id)!;
      const entry=validated.entries.find(entry=>entry.path===capture.archive_path)!;
      expect(declaration).toMatchObject({path:capture.archive_path,purpose:imported.purpose,sha256:imported.sha256,byteSize:imported.byte_size});
      expect(entry).toMatchObject({path:declaration.path,sha256:declaration.sha256,byteSize:declaration.byteSize});
      // Exact original downloaded STORE bytes, independent Node SHA, and the
      // original pre-import fixture payload; whole-archive SHA is insufficient.
      const payload=body.slice(entry.dataOffset,entry.dataOffset+entry.byteSize);
      expect(payload).toEqual(data.value.payloads.get(String(imported.logical_file_id)));
      expect(payload.byteLength).toBe(declaration.byteSize);expect(hash(payload)).toBe(declaration.sha256);
    }

    expect(count(f.native,"research_package_jobs","kind='import' AND state='completed'")).toBe(1);
    expect(count(f.native,"system_recovery_write_leases","kind='scheduled'")).toBeGreaterThan(15);
    expect(f.native.prepare("SELECT actor FROM research_package_jobs WHERE id=?").get(job.id)).toEqual({actor});released(f);
  });
});
