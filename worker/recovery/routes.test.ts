import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteD1Database, referenceTestDatabase } from "../reference-test-support";
import { systemRecoveryRoutes } from "./routes";
import { recoveryRepository, freezeRecoveryArtifactNamespace } from "./service";
import * as targetModule from "./target-import";
import { captureSystemBackupSnapshot, sourceBackupCheckpoint } from "./backup-snapshot";
import { finishSystemBackupManifest } from "../../shared/contracts/system-backup";
import type { SystemRecoveryReport } from "./report";
import type { Env } from "../types";

const actor="administrator@example.test",databases:DatabaseSync[]=[];
afterEach(()=>{databases.splice(0).forEach(database=>database.close());vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
function fixture(fullSource=false){
  const sql=fullSource?referenceTestDatabase():new DatabaseSync(":memory:");databases.push(sql);sql.exec("PRAGMA foreign_keys=ON");if(!fullSource)sql.exec(readFileSync(new URL("../../migrations/0021_fp5_system_recovery.sql",import.meta.url),"utf8"));
  const objects=new Map<string,ArrayBuffer>(),put=vi.fn(async(key:string,body:BodyInit)=>{objects.set(key,await new Response(body).arrayBuffer());}),get=vi.fn(async(key:string)=>{const value=objects.get(key);return value?{body:new Response(value.slice(0)).body!,size:value.byteLength}:null;}),remove=vi.fn(async(key:string)=>{objects.delete(key);});
  const env={DB:new SqliteD1Database(sql) as unknown as D1Database,AUTH_MODE:"access",SYSTEM_ADMIN_EMAILS:actor,ACCESS_TEAM_DOMAIN:"fixture.cloudflareaccess.com",ACCESS_AUD:"fixture",
    R2_BOOTSTRAP_NAMESPACE:JSON.stringify({kind:"local-r2",installationId:"4e5c6dd7-325b-4eae-8499-518eaa0fcb40",bucketName:"test-assets"}),ASSETS:{put,get,delete:remove} as unknown as R2Bucket} as Env;
  const app=new Hono<{Bindings:Env;Variables:{userEmail:string}}>();app.use("*",async(c,next)=>{c.set("userEmail",c.req.header("X-Fixture-Actor")??actor);await next();});app.route("/api",systemRecoveryRoutes);
  vi.stubGlobal("FixedLengthStream",class extends TransformStream<Uint8Array,Uint8Array>{constructor(_length:number){super();}});
  return{sql,objects,put,get,remove,env,app,repository:recoveryRepository(env)};
}
const json=(value:unknown)=>({method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(value)});
const handoffCheckpoint="a".repeat(64);
async function readyRecoveryFixture(mode:"historical"|"planned"="historical",acknowledgeLaterChanges=true,fullSource=false){
  const f=fixture(fullSource),uploadId=crypto.randomUUID(),jobId=crypto.randomUUID(),backupId=crypto.randomUUID();
  await f.repository.accept({id:uploadId,requestId:"source-upload",actor,kind:"upload",input:{requestId:"source-upload",byteSize:22,sha256:"b".repeat(64)},checkpoint:await freezeRecoveryArtifactNamespace(f.env)},()=>true);
  f.sql.prepare("UPDATE system_recovery_jobs SET state='preview',phase='done',artifact_key=?,expires_at=? WHERE id=?").run(`fp5-system/${uploadId}/${crypto.randomUUID()}`,new Date(Date.now()+3600_000).toISOString(),uploadId);
  const acceptedInput={requestId:"accepted-recovery",uploadJobId:uploadId,expectedTargetId:"isolated-target",mapping:[],acknowledgePartial:false,mode,acknowledgeLaterChanges};
  await f.repository.accept({id:jobId,requestId:acceptedInput.requestId,actor,kind:"recovery",input:acceptedInput,sourceUploadJobId:uploadId,targetId:acceptedInput.expectedTargetId},()=>true);
  f.sql.prepare("UPDATE system_recovery_jobs SET state='completed',phase='ready',target_incarnation=?,result_json=? WHERE id=?").run("d".repeat(32),JSON.stringify({targetId:acceptedInput.expectedTargetId,ready:true,cutover:false,checkpoint:handoffCheckpoint}),jobId);
  await f.env.DB.batch([...f.repository.metadataStatements(uploadId,"records",{backupId}),...f.repository.metadataStatements(uploadId,"manifest",{sourceCheckpoint:"b".repeat(64)})]);
  f.sql.prepare("UPDATE system_recovery_maintenance SET state='fenced',generation=1,token='source-window' WHERE singleton=1").run();
  return{...f,uploadId,jobId,backupId,handoffInput:{requestId:"handoff",expectedTargetId:acceptedInput.expectedTargetId,expectedCheckpoint:handoffCheckpoint}};
}
describe("FP5 real privileged website routes",()=>{
  it("returns a closed safe capability to ordinary actors and denies every privileged action",async()=>{
    const f=fixture(),headers={"X-Fixture-Actor":"ordinary@example.test"};
    const response=await f.app.request("/api/system-recovery/capabilities",{headers},f.env);expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({canManage:false,supported:false,enabled:false,target:{configured:false,id:null}});
    for(const path of ["/jobs","/backup-preview","/jobs/missing/download","/jobs/missing/report"]){expect((await f.app.request(`/api/system-recovery${path}`,{headers},f.env)).status).toBe(403);}
    const rejected=await f.app.request("/api/system-recovery/uploads",{...json({requestId:"forbidden",byteSize:30,sha256:"a".repeat(64)}),headers:{...headers,"Content-Type":"application/json"}},f.env);
    expect(rejected.status).toBe(403);expect(f.sql.prepare("SELECT count(*) n FROM system_recovery_jobs").get()!.n).toBe(0);expect(f.put).not.toHaveBeenCalled();
  });
  it("reconciles upload acceptance and exact identity, streams ingress once, and remains awaiting format validation",async()=>{
    const f=fixture();await f.repository.configure(true);const bytes=new TextEncoder().encode("Pending admitted complete raw bytes, not executable recovery SQL."),input={requestId:"raw-intent",byteSize:bytes.byteLength,sha256:createHash("sha256").update(bytes).digest("hex")};
    const accepted=await f.app.request("/api/system-recovery/uploads",json(input),f.env);expect(accepted.status).toBe(202);const receipt=await accepted.json() as {job:{id:string}};
    const retry=await f.app.request("/api/system-recovery/uploads",json(input),f.env);expect(retry.status).toBe(202);expect((await retry.json() as {job:{id:string}}).job.id).toBe(receipt.job.id);
    expect((await f.app.request("/api/system-recovery/uploads",json({...input,byteSize:input.byteSize+1}),f.env)).status).toBe(409);
    const intent=await f.app.request(`/api/system-recovery/jobs/${receipt.job.id}/upload-intent`,undefined,f.env);expect(await intent.json()).toEqual(input);
    const uploaded=await f.app.request(`/api/system-recovery/jobs/${receipt.job.id}/upload`,{method:"PUT",body:bytes},f.env);expect(uploaded.status).toBe(200);
    expect(await uploaded.json()).toMatchObject({state:"queued",phase:"validate",output:{available:false,sha256:input.sha256}});expect(f.put).toHaveBeenCalledTimes(1);
    expect((await f.app.request(`/api/system-recovery/jobs/${receipt.job.id}/preview`,undefined,f.env)).status).toBe(409);
    expect((await f.app.request(`/api/system-recovery/jobs/${receipt.job.id}/download`,undefined,f.env)).status).toBe(404);
    const recovered=await f.app.request("/api/system-recovery/requests/raw-intent",undefined,f.env);expect((await recovered.json() as {job:{id:string}}).job.id).toBe(receipt.job.id);
    f.env.SYSTEM_ADMIN_EMAILS="replacement@example.test";expect((await f.app.request(`/api/system-recovery/jobs/${receipt.job.id}`,undefined,f.env)).status).toBe(403);
  });
  it("rejects invalid mapping, unknown JSON fields and forged ready checkpoints before target or provider writes",async()=>{
    const f=fixture();
    expect((await f.app.request("/api/system-recovery/jobs",json({requestId:"extra",kind:"backup",mode:"historical",administrator:true}),f.env)).status).toBe(400);
    expect((await f.app.request("/api/system-recovery/recoveries",json({requestId:"restore",uploadJobId:"missing",expectedTargetId:"source",mapping:[],mode:"historical",acknowledgeLaterChanges:false,acknowledgePartial:true}),f.env)).status).toBe(400);
    expect((await f.app.request("/api/system-recovery/jobs/missing/cutover",json({requestId:"forged",expectedTargetId:"source",expectedCheckpoint:"a".repeat(64)}),f.env)).status).toBe(404);
    expect(f.put).not.toHaveBeenCalled();expect(f.remove).not.toHaveBeenCalled();expect(f.sql.prepare("SELECT count(*) n FROM system_recovery_target_claim").get()!.n).toBe(0);
  });
  it("freezes the private artifact binding and rejects reinterpreting an old accepted key in another R2 namespace",async()=>{
    const f=fixture();await f.repository.configure(true);const bytes=new TextEncoder().encode("Frozen namespace upload identity."),input={requestId:"private-binding",byteSize:bytes.byteLength,sha256:createHash("sha256").update(bytes).digest("hex")};
    const response=await f.app.request("/api/system-recovery/uploads",json(input),f.env),receipt=await response.json() as {job:{id:string}};
    const checkpoint=JSON.parse((await f.repository.job(receipt.job.id))!.checkpoint_json!);expect(checkpoint.artifactNamespace).toMatchObject({bindingName:"ASSETS",namespaceIdentity:f.env.R2_BOOTSTRAP_NAMESPACE});
    expect(()=>f.sql.prepare("UPDATE system_recovery_jobs SET checkpoint_json='{}' WHERE id=?").run(receipt.job.id)).toThrow("immutable");
    f.env.R2_BOOTSTRAP_NAMESPACE=JSON.stringify({kind:"local-r2",installationId:"4e5c6dd7-325b-4eae-8499-518eaa0fcb40",bucketName:"other-assets"});
    const rejected=await f.app.request(`/api/system-recovery/jobs/${receipt.job.id}/upload`,{method:"PUT",body:bytes},f.env);expect(rejected.status).toBe(409);
    expect(f.put).not.toHaveBeenCalled();expect(f.get).not.toHaveBeenCalled();expect(await f.repository.attempts(receipt.job.id)).toHaveLength(0);
  });
  it("bounds stalled handoff verification and never accepts a late read result or request receipt",async()=>{
    const f=await readyRecoveryFixture();vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
    let late:((value:SystemRecoveryReport)=>void)|undefined,signal:AbortSignal|undefined;
    const verify=vi.fn((input:targetModule.RecoveryTargetInput)=>{signal=input.signal;return new Promise<SystemRecoveryReport>(resolve=>{late=resolve;});});
    vi.spyOn(targetModule,"createRecoveryTargetEngine").mockReturnValue({verify,preview:vi.fn(),step:vi.fn()});
    const before=f.sql.prepare("SELECT * FROM system_recovery_requests ORDER BY request_id").all(),result=(await f.repository.job(f.jobId))!.result_json;
    const pending=f.app.request(`/api/system-recovery/jobs/${f.jobId}/cutover`,json(f.handoffInput),f.env);
    for(let count=0;count<100&&!late;count++)await new Promise<void>(resolve=>setImmediate(resolve));
    expect(verify).toHaveBeenCalledTimes(1);expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);expect((await pending).status).toBe(409);expect(signal?.aborted).toBe(true);
    expect(f.sql.prepare("SELECT * FROM system_recovery_requests ORDER BY request_id").all()).toEqual(before);expect((await f.repository.job(f.jobId))!.result_json).toBe(result);
    late!({targetCheckpoint:handoffCheckpoint} as SystemRecoveryReport);await new Promise<void>(resolve=>setImmediate(resolve));
    expect(f.sql.prepare("SELECT * FROM system_recovery_requests ORDER BY request_id").all()).toEqual(before);expect((await f.repository.job(f.jobId))!.result_json).toBe(result);
    expect(f.put).not.toHaveBeenCalled();expect(f.remove).not.toHaveBeenCalled();
  });
  it("rechecks historical loss acknowledgement before accepting a handoff from an older ready job",async()=>{
    const f=await readyRecoveryFixture("historical",false),engine=vi.spyOn(targetModule,"createRecoveryTargetEngine");
    expect((await f.app.request(`/api/system-recovery/jobs/${f.jobId}/cutover`,json(f.handoffInput),f.env)).status).toBe(409);
    expect(engine).not.toHaveBeenCalled();expect(await f.repository.request(f.handoffInput.requestId,actor)).toBeNull();expect(JSON.parse((await f.repository.job(f.jobId))!.result_json!).cutover).toBe(false);
  });
  it("recaptures the actual planned source image and refuses drift before target verification or handoff acceptance",async()=>{
    const f=await readyRecoveryFixture("planned",false,true),engine=vi.spyOn(targetModule,"createRecoveryTargetEngine");
    // A source change before the final fence makes the previously recorded
    // checkpoint stale; no snapshot/hash mocks can conceal that mutation.
    f.sql.prepare("UPDATE system_recovery_maintenance SET state='open',checkpoint_sha256=NULL,backup_job_id=NULL WHERE singleton=1").run();
    const records=await captureSystemBackupSnapshot(f.env.DB,{backupId:f.backupId,acquireHolds:false}),manifest=await finishSystemBackupManifest(records,[]),checkpoint=await sourceBackupCheckpoint(records);
    await f.env.DB.batch([...f.repository.metadataStatements(f.uploadId,"records",records),...f.repository.metadataStatements(f.uploadId,"manifest",manifest)]);
    f.sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('later-sample','LATER','Changed after recorded source image',?,?)").run(new Date().toISOString(),new Date().toISOString());
    f.sql.prepare("UPDATE system_recovery_maintenance SET state='fenced',checkpoint_sha256=?,backup_job_id=? WHERE singleton=1").run(checkpoint,f.backupId);
    expect((await f.app.request(`/api/system-recovery/jobs/${f.jobId}/cutover`,json(f.handoffInput),f.env)).status).toBe(409);
    expect(engine).not.toHaveBeenCalled();expect(await f.repository.request(f.handoffInput.requestId,actor)).toBeNull();expect(JSON.parse((await f.repository.job(f.jobId))!.result_json!).cutover).toBe(false);
  });
  it("protects other backup holds in a sealed source window at cleanup CAS and again before hold release",async()=>{
    for(const sealBeforeAdmission of [true,false]){
      const f=fixture(true);await f.repository.configure(true);const runtime=(await f.repository.runtime())!,id=crypto.randomUUID();
      await f.repository.accept({id,requestId:"old-backup",actor,kind:"backup",input:{requestId:"old-backup",kind:"backup",mode:"historical"},checkpoint:await freezeRecoveryArtifactNamespace(f.env)},()=>true);
      const claim=(await f.repository.claim(id,actor,runtime.incarnation,"backup-owner"))!,attempt=await f.repository.startAttempt(claim,{byteSize:22,sha256:"b".repeat(64)});
      await f.repository.settleAttempt(attempt,"settled");await f.repository.verifyAttempt(claim,attempt);await f.repository.finish(claim,{state:"completed",phase:"done",artifact_key:attempt.object_key,expires_at:new Date(Date.now()+3600_000).toISOString()});
      f.sql.prepare("INSERT INTO system_recovery_legacy_holds(job_id,store_kind,provider,object_key) VALUES(?,'r2','r2','retained-source')").run(id);
      const seal=()=>f.sql.prepare("UPDATE system_recovery_maintenance SET state='fenced',generation=1,token='sealed',checkpoint_sha256=?,backup_job_id='different-final-backup' WHERE singleton=1").run("c".repeat(64));
      if(sealBeforeAdmission)seal();else f.remove.mockImplementationOnce(async()=>{seal();});
      const prior=(await f.repository.job(id))!;
      expect((await f.app.request(`/api/system-recovery/jobs/${id}/control`,json({action:"cleanup"}),f.env)).status).toBe(409);
      expect(f.sql.prepare("SELECT released_at FROM system_recovery_legacy_holds WHERE job_id=?").get(id)!.released_at).toBeNull();
      if(sealBeforeAdmission){expect(f.remove).not.toHaveBeenCalled();expect((await f.repository.job(id))!.generation).toBe(prior.generation);expect((await f.repository.attempts(id))[0].state).toBe("verified");}
      else expect(f.remove).toHaveBeenCalledTimes(1);
    }
  });
});
