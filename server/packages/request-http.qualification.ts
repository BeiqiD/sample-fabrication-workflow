import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect } from "vitest";
import { checkedResearchJobStatus, checkedResearchPackagePreview, checkedResearchRequestReceipt } from "../../shared/contracts/research-package-api";
import { researchRecordsDocument } from "../../shared/contracts/research-package";
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
    expect(count(f.native,"research_package_jobs","kind='import' AND state='completed'")).toBe(1);
    expect(count(f.native,"system_recovery_write_leases","kind='scheduled'")).toBeGreaterThan(15);
    expect(f.native.prepare("SELECT actor FROM research_package_jobs WHERE id=?").get(job.id)).toEqual({actor});released(f);
  });
});
