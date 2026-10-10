import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteD1Database } from "../reference-test-support";
import { SystemRecoveryRepository } from "./repository";
import { runSystemRecoveryJobStep, writeSystemRecoveryUpload, type SystemRecoveryCapabilitiesAdapter } from "./jobs";

const databases:DatabaseSync[]=[];
afterEach(()=>{for(const database of databases.splice(0))database.close();vi.useRealTimers();});
const bytes=new TextEncoder().encode("Verified system backup staging bytes, never a research File.");
const sha=createHash("sha256").update(bytes).digest("hex");
function setup(){
  const sql=new DatabaseSync(":memory:");databases.push(sql);sql.exec("PRAGMA foreign_keys=ON");
  sql.exec(readFileSync(new URL("../../migrations/0021_fp5_system_recovery.sql",import.meta.url),"utf8"));
  const repository=new SystemRecoveryRepository(new SqliteD1Database(sql) as unknown as D1Database),objects=new Map<string,Uint8Array>();
  const hash=()=>{const digest=createHash("sha256");return{async write(chunk:Uint8Array){digest.update(chunk);},async finish(){return digest.digest("hex");},async abort(){}};};
  let allowed=true;
  const capabilities:SystemRecoveryCapabilitiesAdapter={repository,incarnation:"",authorizeActor:()=>allowed,now:()=>new Date(),randomId:()=>crypto.randomUUID(),hash,
    async step(){return{patch:{state:"preview",phase:"done"},outcome:"preview"};},async exportBody(){return new Response(bytes.slice()).body!;},
    put:vi.fn(async(key,body)=>{objects.set(key,new Uint8Array(await new Response(body).arrayBuffer()));}),read:vi.fn(async key=>objects.has(key)?new Response(objects.get(key)!.slice()).body:null)};
  return{sql,repository,objects,capabilities,revoke(){allowed=false;}};
}
async function enable(fixture:ReturnType<typeof setup>){await fixture.repository.configure(true);fixture.capabilities.incarnation=(await fixture.repository.runtime())!.incarnation;}
async function upload(fixture:ReturnType<typeof setup>){const id=crypto.randomUUID(),input={requestId:crypto.randomUUID(),byteSize:bytes.byteLength,sha256:sha};
  await fixture.repository.accept({id,requestId:input.requestId,actor:"administrator@example.test",kind:"upload",input},()=>true);
  return{id,input,claim:async()=>{const claim=await fixture.repository.claim(id,"administrator@example.test",fixture.capabilities.incarnation,crypto.randomUUID(),true);expect(claim).not.toBeNull();return claim!;}};
}

describe("FP5 actual durable staging and execution fences",()=>{
  it("starts disabled and rejects actor substitution, changed request identity and edited accepted fields",async()=>{
    const f=setup(),accepted=await upload(f);expect((await f.repository.runtime())!.enabled).toBe(0);
    expect(await f.repository.claim(accepted.id,"administrator@example.test",(await f.repository.runtime())!.incarnation,"owner",true)).toBeNull();
    expect(await f.repository.request(accepted.input.requestId,"another@example.test")).toBeNull();
    await expect(f.repository.request(accepted.input.requestId,"administrator@example.test",{...accepted.input,byteSize:100})).rejects.toThrow();
    expect(()=>f.sql.prepare("UPDATE system_recovery_jobs SET input_json='{}' WHERE id=?").run(accepted.id)).toThrow("immutable");
    expect(()=>f.sql.prepare("UPDATE system_recovery_requests SET input_sha256=?").run("a".repeat(64))).toThrow("immutable");
    expect(f.capabilities.put).not.toHaveBeenCalled();
  });
  it("streams, verifies the complete stored body, and advances only to independent validation",async()=>{
    const f=setup();await enable(f);const accepted=await upload(f),claim=await accepted.claim();
    await writeSystemRecoveryUpload(f.capabilities,claim,new Response(bytes.slice()).body!);
    const job=(await f.repository.job(accepted.id))!,attempt=(await f.repository.attempts(accepted.id))[0];
    expect(job).toMatchObject({state:"queued",phase:"validate",archive_sha256:sha,archive_byte_size:bytes.byteLength,artifact_key:attempt.object_key});
    expect(attempt).toMatchObject({state:"verified",expected_sha256:sha});expect(attempt.settled_at).not.toBeNull();expect(attempt.verified_at).not.toBeNull();
    expect(f.capabilities.put).toHaveBeenCalledTimes(1);expect(f.capabilities.read).toHaveBeenCalledTimes(1);
    expect(await runSystemRecoveryJobStep(f.capabilities)).toMatchObject({jobId:accepted.id,outcome:"preview"});
    expect((await f.repository.job(accepted.id))!.state).toBe("preview");
  });
  it("revokes a claimed actor before any PUT and pauses the accepted request",async()=>{
    const f=setup();await enable(f);const accepted=await upload(f),claim=await accepted.claim();f.revoke();
    await expect(writeSystemRecoveryUpload(f.capabilities,claim,new Response(bytes.slice()).body!)).rejects.toThrow();
    expect((await f.repository.job(accepted.id))!.state).toBe("paused");expect(f.capabilities.put).not.toHaveBeenCalled();
  });
  it("never replays an unknown raw PUT; its original late ACK can reconcile under a fresh owner",async()=>{
    const f=setup();await enable(f);const accepted=await upload(f),old=await accepted.claim();
    const attempt=await f.repository.startAttempt(old,{byteSize:bytes.byteLength,sha256:sha});
    await f.repository.pause(old,"execution_budget_exhausted",attempt);
    await f.repository.control((await f.repository.job(accepted.id))!,"resume");const blocked=await accepted.claim();
    await expect(writeSystemRecoveryUpload(f.capabilities,blocked,new Response(bytes.slice()).body!)).rejects.toThrow("write_outcome_unknown");
    expect(f.capabilities.put).not.toHaveBeenCalled();expect((await f.repository.attempts(accepted.id))[0].state).toBe("unknown");
    f.objects.set(attempt.object_key,bytes.slice());await f.repository.settleAttempt(attempt,"settled");await f.repository.control((await f.repository.job(accepted.id))!,"resume");
    const fresh=await accepted.claim();await writeSystemRecoveryUpload(f.capabilities,fresh,new Response(bytes.slice()).body!);
    expect(fresh.generation).toBeGreaterThan(old.generation);expect(f.capabilities.put).not.toHaveBeenCalled();expect(f.capabilities.read).toHaveBeenCalledTimes(2);
    expect((await f.repository.attempts(accepted.id))[0].state).toBe("verified");
    await expect(f.repository.finish(old,{state:"completed"})).rejects.toThrow();
  });
  it("rejects incomplete incoming bytes and caps positively settled retries at five fresh keys",async()=>{
    const f=setup();await enable(f);const accepted=await upload(f),claim=await accepted.claim();
    await expect(writeSystemRecoveryUpload(f.capabilities,claim,new Response(bytes.slice(0,-1)).body!)).rejects.toThrow();
    expect((await f.repository.job(accepted.id))!.state).toBe("paused");expect((await f.repository.attempts(accepted.id))[0].state).toBe("failed");
    for(let index=1;index<5;index++){await f.repository.control((await f.repository.job(accepted.id))!,"resume");const owned=await accepted.claim();
      const attempt=await f.repository.startAttempt(owned,{byteSize:bytes.byteLength,sha256:sha});await f.repository.settleAttempt(attempt,"failed");await f.repository.pause(owned,"source_unavailable");}
    await f.repository.control((await f.repository.job(accepted.id))!,"resume");await expect(f.repository.startAttempt(await accepted.claim(),{byteSize:bytes.byteLength,sha256:sha})).rejects.toThrow();
    const attempts=await f.repository.attempts(accepted.id);expect(attempts).toHaveLength(5);expect(new Set(attempts.map(row=>row.object_key)).size).toBe(5);
  });
  it("executor reconfiguration invalidates owner generations and requires explicit resume",async()=>{
    const f=setup();await enable(f);const accepted=await upload(f),claim=await accepted.claim();await f.repository.configure(false);
    expect(await f.repository.current(claim)).toBe(false);expect((await f.repository.job(accepted.id))!).toMatchObject({state:"paused",reason:"executor_reconfigured"});
    await f.repository.configure(true);expect((await f.repository.job(accepted.id))!.state).toBe("paused");
    await expect(f.repository.finish(claim,{state:"completed"})).rejects.toThrow();
  });
  it("never publishes corrupt stored bytes and retries a positively settled bad candidate using a fresh key",async()=>{
    const f=setup();await enable(f);const accepted=await upload(f),first=await accepted.claim();
    f.capabilities.read=vi.fn(async()=>new Response(bytes.map((byte,index)=>index===0?byte^1:byte)).body!);
    await expect(writeSystemRecoveryUpload(f.capabilities,first,new Response(bytes.slice()).body!)).rejects.toThrow();
    const bad=(await f.repository.attempts(accepted.id))[0];expect(bad.state).toBe("failed");expect((await f.repository.job(accepted.id))!.artifact_key).toBeNull();
    f.capabilities.read=vi.fn(async key=>new Response(f.objects.get(key)!.slice()).body!);await f.repository.control((await f.repository.job(accepted.id))!,"resume");
    await writeSystemRecoveryUpload(f.capabilities,await accepted.claim(),new Response(bytes.slice()).body!);
    const all=await f.repository.attempts(accepted.id);expect(all).toHaveLength(2);expect(all[0].state).toBe("verified");expect(all[0].object_key).not.toBe(bad.object_key);expect(f.capabilities.put).toHaveBeenCalledTimes(2);
  });
  it("recovers a process-lost atomic R2 ACK only through a positive full-body read of the same immutable key",async()=>{
    const f=setup();await enable(f);const accepted=await upload(f),old=await accepted.claim(),attempt=await f.repository.startAttempt(old,{byteSize:bytes.byteLength,sha256:sha});
    f.objects.set(attempt.object_key,bytes.slice());await f.repository.pause(old,"stage_interrupted",attempt);
    await f.repository.configure(false);await enable(f);await f.repository.control((await f.repository.job(accepted.id))!,"resume");const fresh=await accepted.claim();
    await writeSystemRecoveryUpload(f.capabilities,fresh,new Response(bytes.slice()).body!);
    const recovered=(await f.repository.attempts(accepted.id))[0];expect(recovered.object_key).toBe(attempt.object_key);expect(recovered.runtime_incarnation).toBe(old.runtime_incarnation);
    expect(recovered.state).toBe("verified");expect(recovered.settled_at).not.toBeNull();expect(f.capabilities.put).not.toHaveBeenCalled();expect(f.capabilities.read).toHaveBeenCalledTimes(1);
  });
  it("keeps a negative or corrupt unknown read held and never creates a replacement candidate",async()=>{
    const f=setup();await enable(f);const accepted=await upload(f),old=await accepted.claim(),attempt=await f.repository.startAttempt(old,{byteSize:bytes.byteLength,sha256:sha});
    f.objects.set(attempt.object_key,bytes.slice(0,-1));await f.repository.pause(old,"stage_interrupted",attempt);await f.repository.control((await f.repository.job(accepted.id))!,"resume");
    await expect(writeSystemRecoveryUpload(f.capabilities,await accepted.claim(),new Response(bytes.slice()).body!)).rejects.toThrow();
    expect((await f.repository.attempts(accepted.id))[0]).toMatchObject({state:"unknown",settled_at:null,object_key:attempt.object_key});
    expect(await f.repository.attempts(accepted.id)).toHaveLength(1);expect(f.capabilities.put).not.toHaveBeenCalled();
  });
});
