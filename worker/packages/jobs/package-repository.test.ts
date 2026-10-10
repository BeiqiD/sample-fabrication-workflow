import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeAcceptanceFixture } from "../../uploads/native-acceptance-test-support";
import { setFileJobExecution } from "../../files/jobs/worker-runtime";
import { writeVerifiedBytes } from "../../files/byte-writer";
import { runFileGarbageCollection } from "../../files/authority-gc";
import { BLOB_REGISTRATION_GRACE_MS } from "../../blob-lifecycle/reachability";
import { dispatchPackageJobs,workerPackageCapabilities } from "./worker-runtime";
import { SqlPackageRepository } from "./sql-repository";
import { PACKAGE_STEP_MS,runPackageJobStep, writePackageUpload } from "./kernel";
import { packageRoutes } from "../routes";
import type { Env } from "../../types";
import type { PackageCapabilities, PackageTargets } from "./types";
import { RESEARCH_PACKAGE_CATALOG } from "../../../shared/contracts/research-package-catalog";
import { researchRecordsDocument,type ResearchDomainRecord } from "../../../shared/contracts/research-package";
import { sha256Hex,stableJson } from "../../../shared/domain/content-addressing";
import { renderResearchPackageReport } from "../../../shared/domain/research-report";
import { createStoreArchiveStream,type ArchiveEntry } from "../../../shared/domain/research-archive";
import type { JobSqlDatabase } from "../../files/jobs/sql-repository";

const bytes=new TextEncoder().encode("registered package ingress 验证");
const sha=createHash("sha256").update(bytes).digest("hex");
const actor="local-development";
let fixture:Awaited<ReturnType<typeof nativeAcceptanceFixture>>;
let repository:SqlPackageRepository,capabilities:PackageCapabilities,targets:PackageTargets,installation:string;
beforeAll(async()=>{
  fixture=await nativeAcceptanceFixture(true,{throughMigration:"0020_fp4_research_packages.sql"});
  fixture.env.AUTH_MODE="disabled";
  await setFileJobExecution(fixture.env,true);
  capabilities=(await workerPackageCapabilities(fixture.env))!;
  repository=capabilities.repository as SqlPackageRepository;
  const profile=fixture.sql.prepare("SELECT id,namespace_identity FROM storage_profiles WHERE id=?").get(fixture.admission.nativeProfileId)!;
  const revision=Number(fixture.sql.prepare("SELECT MAX(policy_revision) revision FROM storage_role_policy_revisions").get()!.revision);
  targets=Object.fromEntries(["research_source","provenance","embedded_content","derived_preview","job_output"].map(purpose=>[purpose,
    {profileId:String(profile.id),configurationRevision:1,namespaceIdentity:String(profile.namespace_identity),policyRevision:revision}])) as PackageTargets;
  installation=String(fixture.sql.prepare("SELECT installation_id FROM research_package_source_identity").get()!.installation_id);
},30_000);
beforeEach(()=>{fixture.s3Fetch.mockClear();fixture.r2Put.mockClear();fixture.r2Get.mockClear();});
afterAll(()=>{fixture?.sql.close();vi.restoreAllMocks();vi.unstubAllGlobals();});

async function acceptUpload(archiveBytes=bytes){
  const id=crypto.randomUUID(),input={requestId:crypto.randomUUID(),byteSize:archiveBytes.byteLength,sha256:createHash("sha256").update(archiveBytes).digest("hex")};
  const acceptance={id,requestId:input.requestId,actor,kind:"upload" as const,input,packageId:crypto.randomUUID(),sourceInstallationId:installation,targets,
    files:[{packageFileId:"@archive",entryKind:"artifact" as const,purpose:"job_output" as const,byteSize:input.byteSize,sha256:input.sha256,
      path:"archive.zip",mediaType:"application/zip",fileId:crypto.randomUUID()}]};
  const receipt=await repository.accept(acceptance,()=>true);
  return {id,input,acceptance,receipt};
}
async function claim(id:string){const result=await repository.claimOne(id,actor,capabilities.incarnation,crypto.randomUUID(),true);expect(result).not.toBeNull();return result!;}
const body=()=>new Response(bytes.slice()).body!;
const count=(table:string,where:string,id:string)=>Number(fixture.sql.prepare(`SELECT count(*) n FROM ${table} WHERE ${where}=?`).get(id)!.n);

describe("actual FP4 receipt, publication and cleanup guards",()=>{
  it("accepts and reconciles exact requests without provider I/O or changing frozen identity",async()=>{
    const accepted=await acceptUpload();
    expect(fixture.s3Fetch).not.toHaveBeenCalled();expect(fixture.r2Put).not.toHaveBeenCalled();
    expect(await repository.accept({...accepted.acceptance,id:crypto.randomUUID()},()=>true)).toEqual(accepted.receipt);
    await expect(repository.request(accepted.input.requestId,actor,{...accepted.input,byteSize:bytes.byteLength+1})).rejects.toThrow("differs");
    expect(await repository.request(accepted.input.requestId,"another-authorized@example.test")).toBeNull();
    expect(count("research_package_jobs","id",accepted.id)).toBe(1);
    expect(()=>fixture.sql.prepare("UPDATE research_package_files SET target_profile_id='r2-profile' WHERE job_id=?").run(accepted.id)).toThrow("immutable");
    expect(()=>fixture.sql.prepare("UPDATE research_package_requests SET reused=1 WHERE job_id=?").run(accepted.id)).toThrow("immutable");
    await repository.control(accepted.id,actor,"cancel");await repository.maintain(capabilities.incarnation);
  },30_000);

  it("only publishes a registered, streamed and completely verified raw archive",async()=>{
    const accepted=await acceptUpload(),owned=await claim(accepted.id);
    await writePackageUpload(capabilities,owned,body());
    const file=(await repository.files(accepted.id))[0],attempt=(await repository.attempt(file))!;
    expect(attempt.state).toBe("published");expect(attempt.io_settled_at).not.toBeNull();
    expect(fixture.sql.prepare("SELECT verification_operation_id,verified_sha256 FROM file_location_publications WHERE location_id=?").get(attempt.location_id))
      .toMatchObject({verification_operation_id:attempt.id,verified_sha256:sha});
    expect((await repository.job(accepted.id))?.phase).toBe("validate");
    expect(fixture.s3Fetch.mock.calls.map(([request])=>(request as Request).method)).toEqual(["PUT","GET"]);
    expect(fixture.r2Put).not.toHaveBeenCalled();
    await repository.control(accepted.id,actor,"pause");
  },30_000);

  it("rejects synthesized evidence and a revoked owner's write before any object I/O",async()=>{
    const accepted=await acceptUpload(),owned=await claim(accepted.id),file=(await repository.files(accepted.id))[0];
    const attempt=await repository.stage(owned,file);
    expect(()=>fixture.sql.prepare("UPDATE research_package_attempts SET state='verified',io_settled_at=?,verified_at=?,verified_byte_size=?,verified_sha256=?,verified_owner_token=?,verified_generation=?,verified_runtime_incarnation=? WHERE id=?")
      .run(new Date().toISOString(),new Date().toISOString(),bytes.byteLength,sha,owned.owner_token,owned.generation,owned.runtime_incarnation,attempt.id)).toThrow();
    await repository.control(accepted.id,actor,"pause");
    await expect(repository.startWrite(owned,attempt)).rejects.toThrow("did not commit");
    expect((await repository.attempt(file))?.state).toBe("staged");
    expect(fixture.s3Fetch).not.toHaveBeenCalled();
    await repository.control(accepted.id,actor,"cancel");await repository.maintain(capabilities.incarnation);
  },30_000);

  it("rechecks old verified bytes under a fresh lease and settles publication without repeating PUT",async()=>{
    const accepted=await acceptUpload(),owned=await claim(accepted.id),file=(await repository.files(accepted.id))[0],attempt=await repository.stage(owned,(await repository.files(accepted.id))[0]);
    const storage=await capabilities.openStorage({profileId:file.target_profile_id!,configurationRevision:1},"write",()=>repository.owns(owned),new AbortController().signal);
    await repository.startWrite(owned,attempt);
    await writeVerifiedBytes({...storage,writer:{accepts:storage.writer!.accepts,async write(input){await storage.writer!.write(input);await repository.settled(attempt);}}},
      {key:attempt.object_key,body:body(),byteSize:bytes.byteLength,sha256:sha,contentType:"application/zip",filename:"archive.zip"});
    await repository.verify(owned,file,attempt);
    await repository.control(accepted.id,actor,"pause");await repository.control(accepted.id,actor,"resume");
    expect(fixture.sql.prepare("SELECT count(*) n FROM research_package_live_verified_attempts WHERE job_id=?").get(accepted.id)!.n).toBe(0);
    fixture.s3Fetch.mockClear();
    expect(await runPackageJobStep(capabilities)).toEqual({jobId:accepted.id,outcome:"file_verified"});
    expect(fixture.s3Fetch.mock.calls.map(([request])=>(request as Request).method)).toEqual(["GET"]);
    expect((await repository.attempt(file))?.state).toBe("published");
    await repository.control(accepted.id,actor,"pause");
  },30_000);

  it("retains an uncertain in-flight PUT until its original positive settlement, then allows safe cleanup and GC",async()=>{
    const accepted=await acceptUpload(),owned=await claim(accepted.id);
    let entered!:()=>void,finish!:()=>void;
    const incoming=new Promise<void>(resolve=>{entered=resolve;}),pending=new Promise<void>(resolve=>{finish=resolve;});
    const implementation=fixture.s3Fetch.getMockImplementation()!;
    fixture.s3Fetch.mockImplementationOnce(async(...args)=>{const response=await implementation(...args);entered();await pending;return response;});
    const writing=writePackageUpload(capabilities,owned,body()).then(()=>null,error=>error);
    await incoming;
    const file=(await repository.files(accepted.id))[0],attempt=(await repository.attempt(file))!;
    await repository.control(accepted.id,actor,"cancel");await repository.maintain(capabilities.incarnation);
    expect((await repository.attempt(file))?.io_settled_at).toBeNull();
    expect(fixture.sql.prepare("SELECT released_at FROM file_location_holds WHERE operation_id=?").get(attempt.id)!.released_at).toBeNull();
    expect(fixture.sql.prepare("SELECT released_at FROM file_holds WHERE operation_id=?").get(`fp4-output:${accepted.id}`)!.released_at).toBeNull();
    finish();expect(await writing).toBeInstanceOf(Error);
    expect((await repository.attempt(file))?.io_settled_at).not.toBeNull();
    await repository.control(accepted.id,actor,"cleanup");await repository.maintain(capabilities.incarnation);
    expect(fixture.sql.prepare("SELECT released_at FROM file_location_holds WHERE operation_id=?").get(attempt.id)!.released_at).not.toBeNull();
    const future=new Date(Date.now()+BLOB_REGISTRATION_GRACE_MS+1000);
    await runFileGarbageCollection(fixture.env,future);
    expect(fixture.sql.prepare("SELECT state FROM file_location_gc_ledger WHERE location_id=?").get(attempt.location_id)).toMatchObject({state:"orphaned"});
    expect(fixture.s3Fetch.mock.calls.filter(([request])=>(request as Request).method==="DELETE")).toHaveLength(0);
  },30_000);

  it("retires unconsumed temporary output through canonical guards and invalidates fresh preview admission",async()=>{
    const accepted=await acceptUpload(),owned=await claim(accepted.id);await writePackageUpload(capabilities,owned,body());
    const validated=await claim(accepted.id);await repository.checkpoint(validated,"preview",{archive:{manifest:{},entries:[],byteSize:bytes.byteLength,sha256:sha}});
    const file=(await repository.files(accepted.id))[0];
    await repository.control(accepted.id,actor,"cleanup");await repository.maintain(capabilities.incarnation);
    expect((await repository.job(accepted.id))?.state).toBe("cancelled");
    expect(fixture.sql.prepare("SELECT state,active_location_id FROM file_publications WHERE file_id=?").get(file.result_file_id!)).toMatchObject({state:"retired",active_location_id:null});
    expect(fixture.sql.prepare("SELECT released_at FROM file_holds WHERE operation_id=?").get(`fp4-output:${accepted.id}`)!.released_at).not.toBeNull();
    expect(fixture.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  },30_000);

  it("retries a never-written raw upload under its exact accepted identity and a fresh registered key",async()=>{
    const accepted=await acceptUpload(),first=await claim(accepted.id);
    const unavailable={...capabilities,openStorage:vi.fn(async()=>{throw new Error("fixture capability unavailable before PUT");})};
    await expect(writePackageUpload(unavailable,first,body())).rejects.toThrow();
    const file=(await repository.files(accepted.id))[0],old=(await repository.attempt(file))!;
    expect(old).toMatchObject({state:"failed",write_started_at:null,io_settled_at:null});
    expect(fixture.s3Fetch).not.toHaveBeenCalled();
    await repository.control(accepted.id,actor,"retry");const second=await claim(accepted.id);
    await writePackageUpload(capabilities,second,body());
    const published=(await repository.attempt(file))!;
    expect(published.state).toBe("published");expect(published.id).not.toBe(old.id);expect(published.object_key).not.toBe(old.object_key);
    expect(JSON.parse((await repository.job(accepted.id))!.input_json)).toEqual(accepted.input);
    expect((await repository.files(accepted.id))[0]).toMatchObject({result_file_id:file.candidate_file_id,sha256:sha,byte_size:bytes.byteLength});
    expect(fixture.sql.prepare("SELECT state FROM research_package_attempts WHERE id=?").get(old.id)).toMatchObject({state:"cancelled"});
    expect(fixture.sql.prepare("SELECT released_at FROM file_location_holds WHERE operation_id=?").get(old.id)!.released_at).toBeNull();
    expect(fixture.s3Fetch.mock.calls.map(([request])=>(request as Request).method)).toEqual(["PUT","GET"]);
    await repository.control(accepted.id,actor,"pause");
  },30_000);

  it("refuses a new raw PUT while the earlier write has no positive settlement",async()=>{
    const accepted=await acceptUpload(),first=await claim(accepted.id),file=(await repository.files(accepted.id))[0],old=await repository.stage(first,(await repository.files(accepted.id))[0]);
    await repository.startWrite(first,old);await repository.pause(first,"fixture_uncertain_write",old);
    await repository.control(accepted.id,actor,"retry");const second=await claim(accepted.id);
    await expect(writePackageUpload(capabilities,second,body())).rejects.toThrow("write_settlement_required");
    expect(await repository.job(accepted.id)).toMatchObject({state:"paused",reason:"write_settlement_required"});
    expect((await repository.attempt(file))!.id).toBe(old.id);
    expect(count("research_package_attempts","job_id",accepted.id)).toBe(1);
    expect(fixture.sql.prepare("SELECT released_at FROM file_location_holds WHERE operation_id=?").get(old.id)!.released_at).toBeNull();
    expect(fixture.s3Fetch).not.toHaveBeenCalled();expect(fixture.r2Put).not.toHaveBeenCalled();
    await repository.control(accepted.id,actor,"cancel");
  },30_000);

  it("bounds an unabortable upload and source cancellation without releasing its unknown write",async()=>{
    const accepted=await acceptUpload(),owned=await claim(accepted.id);
    let entered!:()=>void,finish!:()=>void;
    const incoming=new Promise<void>(resolve=>{entered=resolve;}),pending=new Promise<void>(resolve=>{finish=resolve;});
    const cancel=vi.fn(()=>new Promise<void>(()=>undefined));
    const source=new ReadableStream<Uint8Array>({pull:()=>new Promise<void>(()=>undefined),cancel});
    const bounded={...capabilities,async openStorage(...args:Parameters<PackageCapabilities["openStorage"]>){
      const storage=await capabilities.openStorage(...args);
      return{...storage,writer:{accepts:"stream" as const,async write(){entered();await pending;}}};
    }};
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
    try{
      const writing=writePackageUpload(bounded,owned,source).then(()=>null,error=>error);
      await incoming;await vi.advanceTimersByTimeAsync(PACKAGE_STEP_MS);
      expect(await writing).toBeInstanceOf(Error);
      expect(await repository.job(accepted.id)).toMatchObject({state:"paused",reason:"execution_budget_exhausted"});
      const file=(await repository.files(accepted.id))[0],attempt=(await repository.attempt(file))!;
      expect(attempt).toMatchObject({state:"unknown",io_settled_at:null});
      expect(cancel).toHaveBeenCalledOnce();
      await repository.control(accepted.id,actor,"cancel");await repository.maintain(capabilities.incarnation);
      expect(fixture.sql.prepare("SELECT released_at FROM file_location_holds WHERE operation_id=?").get(attempt.id)!.released_at).toBeNull();
      expect(fixture.sql.prepare("SELECT released_at FROM file_holds WHERE operation_id=?").get(`fp4-output:${accepted.id}`)!.released_at).toBeNull();
      expect(fixture.s3Fetch).not.toHaveBeenCalled();expect(fixture.r2Put).not.toHaveBeenCalled();
      for(let i=0;i<12&&(await repository.job(accepted.id))!.state==="cancel_requested";i++)expect(await repository.maintain(capabilities.incarnation)).toBe(true);
      expect((await repository.job(accepted.id))!.state).toBe("cancelled");
      finish();
      for(let i=0;i<20&&!((await repository.attempt(file))!.io_settled_at);i++)await Promise.resolve();
      expect((await repository.attempt(file))!.io_settled_at).not.toBeNull();
      expect((await repository.files(accepted.id))[0].state).not.toBe("published");
      await repository.control(accepted.id,actor,"cleanup");await repository.maintain(capabilities.incarnation);
    }finally{vi.useRealTimers();finish();}
  },30_000);

  it("shows source counts but refuses both export kinds when request authority admission is unavailable",async()=>{
    const app=new Hono<{Bindings:Env;Variables:{userEmail:string}}>();
    app.use("*",async(c,next)=>{c.set("userEmail",actor);await next();});app.route("/api",packageRoutes);
    // Preview now performs an actual read batch. Use a separate installation
    // rather than wrapping the adapter's BEGIN in a test-only outer savepoint.
    const globals={fetch:globalThis.fetch,Request:globalThis.Request,FixedLengthStream:globalThis.FixedLengthStream};
    let isolated:Awaited<ReturnType<typeof nativeAcceptanceFixture>>|undefined;
    try{
      isolated=await nativeAcceptanceFixture(true,{throughMigration:"0020_fp4_research_packages.sql"});
      isolated.env.AUTH_MODE="disabled";await setFileJobExecution(isolated.env,true);
      isolated.sql.prepare("UPDATE file_authority_runtime_guard SET enabled=0 WHERE singleton=1").run();
      isolated.s3Fetch.mockClear();isolated.r2Put.mockClear();
      const input={kind:"data_package",roots:[{kind:"sample",id:"sample-native"}]};
      const preview=await app.request("/api/packages/plans",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)},isolated.env);
      expect(preview.status).toBe(200);expect(await preview.json()).toMatchObject({counts:{records:1,files:0},targets:[],capabilities:{
        dataPackage:{available:false,reasons:["file_authority_unavailable"]},report:{available:false,reasons:["file_authority_unavailable"]}}});
      for(const kind of ["data_package","report"]){const accepted=await app.request("/api/packages/jobs",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({...input,kind,requestId:crypto.randomUUID()})},isolated.env);expect(accepted.status).toBe(503);}
      expect(isolated.s3Fetch).not.toHaveBeenCalled();expect(isolated.r2Put).not.toHaveBeenCalled();
    }finally{
      for(const [name,value]of Object.entries(globals))vi.stubGlobal(name,value);
      isolated?.sql.close();
    }
  },30_000);

  it("lets queued verification progress when an eligible cleanup grant is blocked by unknown I/O",async()=>{
    const blocked=await acceptUpload(),oldOwner=await claim(blocked.id),oldFile=(await repository.files(blocked.id))[0],old=await repository.stage(oldOwner,(await repository.files(blocked.id))[0]);
    await repository.startWrite(oldOwner,old);await repository.pause(oldOwner,"fixture_unknown_write",old);
    await repository.control(blocked.id,actor,"cancel");
    for(let i=0;i<16&&(await repository.job(blocked.id))!.state==="cancel_requested";i++)await repository.maintain(capabilities.incarnation);
    expect((await repository.job(blocked.id))!.state).toBe("cancelled");
    const ready=await acceptUpload(),owner=await claim(ready.id),file=(await repository.files(ready.id))[0],attempt=await repository.stage(owner,(await repository.files(ready.id))[0]);
    const storage=await capabilities.openStorage({profileId:file.target_profile_id!,configurationRevision:1},"write",()=>repository.owns(owner),new AbortController().signal);
    await repository.startWrite(owner,attempt);
    await writeVerifiedBytes({...storage,writer:{accepts:storage.writer!.accepts,async write(input){await storage.writer!.write(input);await repository.settled(attempt);}}},
      {key:attempt.object_key,body:body(),byteSize:bytes.byteLength,sha256:sha,contentType:"application/zip",filename:"archive.zip"});
    await repository.verify(owner,file,attempt);await repository.control(ready.id,actor,"pause");await repository.control(ready.id,actor,"resume");
    fixture.sql.prepare("UPDATE system_research_package_cleanup_grants SET requested_at=? WHERE job_id=?")
      .run(new Date(Date.now()-121_000).toISOString(),blocked.id);
    fixture.s3Fetch.mockClear();
    expect(await dispatchPackageJobs(fixture.env)).toEqual({jobId:ready.id,outcome:"file_verified"});
    expect((await repository.attempt(file))!.state).toBe("published");
    expect((await repository.attempt(oldFile))!).toMatchObject({id:old.id,state:"unknown",io_settled_at:null});
    expect(fixture.sql.prepare("SELECT released_at FROM file_location_holds WHERE operation_id=?").get(old.id)!.released_at).toBeNull();
    expect(fixture.sql.prepare("SELECT released_at FROM file_holds WHERE operation_id=?").get(`fp4-output:${blocked.id}`)!.released_at).toBeNull();
    expect(fixture.s3Fetch.mock.calls.map(([request])=>(request as Request).method)).toEqual(["GET"]);
    expect(fixture.r2Put).not.toHaveBeenCalled();
    await repository.control(ready.id,actor,"pause");
  },30_000);

  it("fences a stale cleanup selection when its owner resumes and reclaims the job before the batch",async()=>{
    const accepted=await acceptUpload(),oldOwner=await claim(accepted.id),file=(await repository.files(accepted.id))[0],attempt=await repository.stage(oldOwner,(await repository.files(accepted.id))[0]);
    await repository.control(accepted.id,actor,"cancel");
    const primary=repository.database.primary();let interleaved=false,newOwner:Awaited<ReturnType<typeof claim>>|null=null;
    const racing:JobSqlDatabase={prepare:sql=>primary.prepare(sql),primary:()=>racing,async batch(statements){
      if(!interleaved){interleaved=true;await repository.control(accepted.id,actor,"resume");newOwner=await claim(accepted.id);}
      return primary.batch(statements);
    }};
    const stale=new SqlPackageRepository(racing);
    expect(await stale.maintain(capabilities.incarnation)).toBe(false);
    expect(interleaved).toBe(true);expect(newOwner).not.toBeNull();
    expect(await repository.job(accepted.id)).toMatchObject({state:"running",owner_token:newOwner!.owner_token,generation:newOwner!.generation});
    expect((await repository.attempt(file))!).toMatchObject({id:attempt.id,state:"staged",write_started_at:null});
    expect(fixture.sql.prepare("SELECT released_at FROM file_location_holds WHERE operation_id=?").get(attempt.id)!.released_at).toBeNull();
    expect(fixture.sql.prepare("SELECT released_at FROM file_holds WHERE operation_id=?").get(`fp4-output:${accepted.id}`)!.released_at).toBeNull();
    expect(fixture.s3Fetch).not.toHaveBeenCalled();
    await repository.control(accepted.id,actor,"cancel");
    for(let i=0;i<16&&(await repository.job(accepted.id))!.state==="cancel_requested";i++)await repository.maintain(capabilities.incarnation);
    expect((await repository.job(accepted.id))!.state).toBe("cancelled");
  },30_000);

  it("reuses a cancelled normal copy receipt while another-copy allocates independent frozen identities",async()=>{
    const at=new Date().toISOString(),definition=RESEARCH_PACKAGE_CATALOG.sample;
    const data=Object.fromEntries(Object.entries(definition.fields).map(([field,rule])=>[field,rule.nullable?null:
      rule.type==="integer"||rule.type==="number"?1:rule.type==="json"?{}:rule.values?.[0]??(field.endsWith("_at")?at:"value")]));
    Object.assign(data,{code:"CANCEL-COPY",title:"Cancellation source",status:"stored",pinned:0});
    const record:ResearchDomainRecord={kind:"sample",sourceId:"cancel-source",sourceRevision:{scheme:"timestamp",value:at},data};
    const document=researchRecordsDocument([record]),manifest={schema:"research-package/1" as const,kind:"data_package" as const,
      packageId:crypto.randomUUID(),sourceInstallationId:"copy-test-origin",createdAt:at,roots:[{kind:"sample" as const,id:record.sourceId}],
      recordsSha256:await sha256Hex(stableJson(document)),files:[],dependencies:[],completeness:"complete" as const,counts:{records:1,files:0,bytes:0},
      report:{htmlPath:"report/index.html" as const,markdownPath:"report/report.md" as const}};
    const report=renderResearchPackageReport({...manifest,records:[record]});
    const metadata=new Map<string,string>([["manifest.json",stableJson(manifest)],["records.json",stableJson(document)],
      ["report/index.html",report.html],["report/report.md",report.markdown]]);
    const entries:ArchiveEntry[]=await Promise.all([...metadata].map(async([path,text])=>({path,byteSize:new TextEncoder().encode(text).byteLength,
      sha256:await sha256Hex(text),kind:path.startsWith("report/")?"report" as const:"metadata" as const})));
    const zip=new Uint8Array(await new Response(createStoreArchiveStream(entries,async entry=>new Response(metadata.get(entry.path)!).body!)).arrayBuffer());
    const upload=await acceptUpload(zip);await writePackageUpload(capabilities,await claim(upload.id),new Response(zip).body!);
    expect(await runPackageJobStep(capabilities)).toEqual({jobId:upload.id,outcome:"preview"});
    const app=new Hono<{Bindings:Env;Variables:{userEmail:string}}>();app.use("*",async(c,next)=>{c.set("userEmail",actor);await next();});app.route("/api",packageRoutes);
    const post=async(input:unknown)=>{const response=await app.request("/api/packages/imports",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)},fixture.env);
      expect(response.status).toBe(202);return await response.json() as {requestId:string;reused:boolean;job:{id:string;state:string}};};
    const originalInput={requestId:crypto.randomUUID(),uploadJobId:upload.id,anotherCopy:false,expectedRolePolicyRevision:targets.job_output.policyRevision};
    const original=await post(originalInput),frozen=(await repository.job(original.job.id))!.domain_plan_json!;
    await repository.control(original.job.id,actor,"cancel");
    for(let i=0;i<16&&(await repository.job(original.job.id))!.state==="cancel_requested";i++)await repository.maintain(capabilities.incarnation);
    expect((await repository.job(original.job.id))!.state).toBe("cancelled");fixture.s3Fetch.mockClear();
    const preview=await app.request(`/api/packages/jobs/${upload.id}/preview`,{},fixture.env);
    expect(preview.status).toBe(200);expect(await preview.json()).toMatchObject({existingImportJobId:original.job.id});
    const repeated=await post({...originalInput,requestId:crypto.randomUUID(),expectedRolePolicyRevision:null});
    expect(repeated).toMatchObject({reused:true,job:{id:original.job.id,state:"cancelled"}});
    expect((await repository.job(original.job.id))!.domain_plan_json).toBe(frozen);
    expect(await repository.request(repeated.requestId,actor)).toMatchObject({reused:true,job:{id:original.job.id,state:"cancelled"}});
    const another=await post({...originalInput,requestId:crypto.randomUUID(),anotherCopy:true});
    expect(another.reused).toBe(false);expect(another.job.id).not.toBe(original.job.id);
    expect(JSON.parse((await repository.job(another.job.id))!.domain_plan_json!).roots).not.toEqual(JSON.parse(frozen).roots);
    expect(fixture.s3Fetch).not.toHaveBeenCalled();
    await repository.control(another.job.id,actor,"cancel");
    for(let i=0;i<16&&(await repository.job(another.job.id))!.state==="cancel_requested";i++)await repository.maintain(capabilities.incarnation);
    await repository.control(upload.id,actor,"cleanup");await repository.maintain(capabilities.incarnation);
  },30_000);

  it("does not confuse a reverse-ID candidate with an older same-millisecond package attempt",async()=>{
    const accepted=await acceptUpload(),at=new Date(),ids:string[]=[];
    const exact=new SqlPackageRepository(repository.database,()=>at,()=>ids.shift()??crypto.randomUUID());
    const first=(await exact.claimOne(accepted.id,actor,capabilities.incarnation,"first-package-owner",true))!,file=(await exact.files(accepted.id))[0];
    ids.push("z-package-attempt","z-package-location",crypto.randomUUID(),crypto.randomUUID());
    const old=await exact.stage(first,file);
    await exact.control(accepted.id,actor,"pause");await exact.control(accepted.id,actor,"resume");
    const second=(await exact.claimOne(accepted.id,actor,capabilities.incarnation,"second-package-owner",true))!;
    ids.push("a-package-attempt","a-package-location",crypto.randomUUID(),crypto.randomUUID());
    const current=await exact.stage(second,file);
    expect(current.id).toBe("a-package-attempt");expect(old.id).toBe("z-package-attempt");
    expect((await exact.attempt(file))!.id).toBe(current.id);
    expect(fixture.sql.prepare("SELECT DISTINCT created_at FROM research_package_attempts WHERE job_id=?").all(accepted.id)).toHaveLength(1);
    expect(current.generation).toBeGreaterThan(old.generation);
    expect(fixture.s3Fetch).not.toHaveBeenCalled();
    await exact.control(accepted.id,actor,"cancel");await exact.maintain(capabilities.incarnation);
  },30_000);

  it("keeps recovered package work paused across global reconfiguration until its owner explicitly resumes",async()=>{
    const accepted=await acceptUpload();
    await repository.control(accepted.id,actor,"resume");
    const frozen=(await repository.job(accepted.id))!.target_policy_json;
    await setFileJobExecution(fixture.env,false);
    expect(await repository.job(accepted.id)).toMatchObject({state:"paused",reason:"executor_reconfigured",owner_token:null,lease_expires_at:null});
    await setFileJobExecution(fixture.env,true);
    const current=(await workerPackageCapabilities(fixture.env))!;
    expect(current.incarnation).not.toBe(capabilities.incarnation);
    expect(await repository.claim(current.incarnation,crypto.randomUUID(),current.authorizeActor)).toBeNull();
    expect((await repository.job(accepted.id))!.target_policy_json).toBe(frozen);
    await repository.control(accepted.id,actor,"resume");
    const resumed=await repository.claim(current.incarnation,crypto.randomUUID(),current.authorizeActor);
    expect(resumed).toMatchObject({id:accepted.id,state:"running",runtime_incarnation:current.incarnation});
    expect(resumed!.target_policy_json).toBe(frozen);
    expect(await repository.attempt((await repository.files(accepted.id))[0])).toBeNull();
    expect(fixture.s3Fetch).not.toHaveBeenCalled();expect(fixture.r2Put).not.toHaveBeenCalled();
  },30_000);
});
