import type { SystemRecoveryJobKind, SystemRecoveryJobPhase, SystemRecoveryJobState } from "../../shared/contracts/system-recovery";
import { sha256Hex, stableJson } from "../../shared/domain/content-addressing";
import { primaryD1 } from "../d1-primary";

export interface RecoveryJob {
  id: string; request_id: string; actor: string; kind: SystemRecoveryJobKind; state: SystemRecoveryJobState; phase: SystemRecoveryJobPhase;
  input_json: string; accepted_at: string; updated_at: string; reason: string | null;
  generation: number; owner_token: string | null; runtime_incarnation: string | null; lease_expires_at: string | null;
  source_upload_job_id: string | null; target_id: string | null; target_incarnation: string | null;
  checkpoint_json: string | null; source_checkpoint: string | null; artifact_key: string | null;
  archive_byte_size: number | null; archive_sha256: string | null; expires_at: string | null;
  completed_files: number; total_files: number; bytes_done: number; bytes_total: number; result_json: string | null;
}
export interface RecoveryClaim extends RecoveryJob { owner_token: string; runtime_incarnation: string; lease_expires_at: string }
export interface RecoveryAttempt {
  id: string; job_id: string; generation: number; runtime_incarnation: string; owner_token: string; object_key: string;
  expected_byte_size: number; expected_sha256: string; state: "started" | "settled" | "verified" | "failed" | "unknown" | "cleaned";
  created_at: string; settled_at: string | null; verified_at: string | null; cleaned_at: string | null;
}
export interface RecoveryRuntime { enabled: number; incarnation: string; installation_id: string; last_heartbeat_at: string | null }
export class SystemRecoveryConflict extends Error {
  constructor(readonly reason: string = "accepted_state_conflict") { super("System recovery conflicts with its accepted state."); this.name = "SystemRecoveryConflict"; }
}
const mutable = new Set(["state", "phase", "reason", "checkpoint_json", "source_checkpoint", "artifact_key", "archive_byte_size", "archive_sha256",
  "expires_at", "completed_files", "total_files", "bytes_done", "bytes_total", "result_json", "target_incarnation"]);
export class SystemRecoveryRepository {
  constructor(readonly database: D1Database, readonly now: () => Date = () => new Date()) {}
  db() { return primaryD1(this.database); }
  async installed() { return Boolean(await this.db().prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='system_recovery_jobs'").first()); }
  async runtime() { return this.db().prepare("SELECT enabled,incarnation,installation_id,last_heartbeat_at FROM system_recovery_runtime WHERE singleton=1").first<RecoveryRuntime>(); }
  async job(id: string) { return this.db().prepare("SELECT * FROM system_recovery_jobs WHERE id=?").bind(id).first<RecoveryJob>(); }
  async list(actor: string) { return (await this.db().prepare("SELECT * FROM system_recovery_jobs WHERE actor=? ORDER BY accepted_at DESC,id DESC LIMIT 20").bind(actor).all<RecoveryJob>()).results; }
  async request(requestId: string, actor: string, input?: unknown) {
    const found = await this.db().prepare("SELECT r.input_sha256,j.* FROM system_recovery_requests r JOIN system_recovery_jobs j ON j.id=r.job_id WHERE r.actor=? AND r.request_id=?")
      .bind(actor, requestId).first<RecoveryJob & { input_sha256: string }>();
    if (!found) return null;
    if (input !== undefined && found.input_sha256 !== await sha256Hex(stableJson(input))) throw new SystemRecoveryConflict("request_identity_conflict");
    return found;
  }
  async accept(input: { id: string; requestId: string; actor: string; kind: SystemRecoveryJobKind; input: unknown; sourceUploadJobId?: string; targetId?: string;
    sourceCheckpoint?: string; checkpoint?: unknown; totalFiles?:number; bytesTotal?:number }, authorized: () => boolean) {
    if (!authorized()) throw new SystemRecoveryConflict("administrator_revoked");
    const prior = await this.request(input.requestId, input.actor, input.input); if (prior) return { job: prior, reused: true };
    const db = this.db(), now = this.now().toISOString(), digest = await sha256Hex(stableJson(input.input));
    const kind = input.kind, state = kind === "upload" ? "awaiting_upload" : "queued", phase = kind === "backup" ? "snapshot" : kind === "upload" ? "write" : "claim";
    if (!authorized()) throw new SystemRecoveryConflict("administrator_revoked");
    try { await db.batch([
      ...(input.sourceUploadJobId ? [db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_jobs WHERE id=? AND actor=? AND kind='upload'
        AND state='preview' AND artifact_key IS NOT NULL AND julianday(expires_at)>julianday(?)) THEN 1 ELSE json('Recovery upload expired') END`)
        .bind(input.sourceUploadJobId,input.actor,now)] : []),
      db.prepare(`INSERT INTO system_recovery_jobs(id,request_id,actor,kind,state,phase,input_json,accepted_at,updated_at,source_upload_job_id,target_id,source_checkpoint,checkpoint_json,total_files,bytes_total)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.id,input.requestId,input.actor,kind,state,phase,stableJson(input.input),now,now,
          input.sourceUploadJobId??null,input.targetId??null,input.sourceCheckpoint??null,input.checkpoint===undefined?null:stableJson(input.checkpoint),input.totalFiles??0,input.bytesTotal??0),
      db.prepare("INSERT INTO system_recovery_requests(request_id,actor,job_id,input_sha256,accepted_at) VALUES(?,?,?,?,?)")
        .bind(input.requestId,input.actor,input.id,digest,now),
    ]); } catch { const raced = await this.request(input.requestId,input.actor,input.input); if (raced) return { job: raced, reused: true }; throw new SystemRecoveryConflict(); }
    return { job: (await this.job(input.id))!, reused: false };
  }
  guard(claim: RecoveryClaim, db = this.db()) {
    return db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_jobs j JOIN system_recovery_runtime r ON r.singleton=1 AND r.enabled=1
      AND r.incarnation=j.runtime_incarnation WHERE j.id=? AND j.actor=? AND j.state='running' AND j.generation=? AND j.owner_token=?
      AND j.runtime_incarnation=? AND julianday(j.lease_expires_at)>julianday(?)) THEN 1 ELSE json('System recovery lease lost') END`)
      .bind(claim.id,claim.actor,claim.generation,claim.owner_token,claim.runtime_incarnation,this.now().toISOString());
  }
  async current(claim: RecoveryClaim) {
    return Boolean(await this.db().prepare(`SELECT 1 FROM system_recovery_jobs j JOIN system_recovery_runtime r ON r.singleton=1 AND r.enabled=1
      AND r.incarnation=j.runtime_incarnation WHERE j.id=? AND j.actor=? AND j.state='running' AND j.generation=? AND j.owner_token=?
      AND j.runtime_incarnation=? AND julianday(j.lease_expires_at)>julianday(?)`).bind(claim.id,claim.actor,claim.generation,claim.owner_token,claim.runtime_incarnation,this.now().toISOString()).first());
  }
  async claim(id: string, actor: string, incarnation: string, owner: string, upload = false): Promise<RecoveryClaim | null> {
    const db=this.db(), now=this.now().toISOString(), expires=new Date(this.now().getTime()+65_000).toISOString();
    await db.prepare(`UPDATE system_recovery_jobs SET state='running',generation=generation+1,owner_token=?,runtime_incarnation=?,lease_expires_at=?,updated_at=?
      WHERE id=? AND actor=? AND state=? AND owner_token IS NULL AND EXISTS(SELECT 1 FROM system_recovery_runtime WHERE singleton=1 AND enabled=1 AND incarnation=?)`)
      .bind(owner,incarnation,expires,now,id,actor,upload?"awaiting_upload":"queued",incarnation).run();
    const job=await this.job(id); return job?.state==="running"&&job.owner_token===owner&&job.runtime_incarnation===incarnation?job as RecoveryClaim:null;
  }
  async next() { return this.db().prepare("SELECT * FROM system_recovery_jobs WHERE state='queued' ORDER BY updated_at,id LIMIT 1").first<RecoveryJob>(); }
  async finish(claim:RecoveryClaim, patch:Partial<RecoveryJob>, statements:readonly D1PreparedStatement[] = []) {
    const keys=Object.keys(patch);if(keys.some(key=>!mutable.has(key)))throw new SystemRecoveryConflict("invalid_job_patch");
    const db=this.db(), now=this.now().toISOString();
    await db.batch([this.guard(claim,db),...statements,db.prepare(`UPDATE system_recovery_jobs SET ${keys.map(key=>`${key}=?`).join(",")}${keys.length?",":""}
      owner_token=NULL,runtime_incarnation=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND generation=? AND owner_token=?`)
      .bind(...keys.map(key=>patch[key as keyof RecoveryJob]??null),now,claim.id,claim.generation,claim.owner_token)]);
  }
  async metadata(jobId:string,name:string) {
    const rows=(await this.db().prepare("SELECT ordinal,chunk FROM system_recovery_metadata_chunks WHERE job_id=? AND name=? ORDER BY ordinal")
      .bind(jobId,name).all<{ordinal:number;chunk:string}>()).results;
    if(!rows.length)return null;if(rows.some((row,index)=>row.ordinal!==index))throw new SystemRecoveryConflict("metadata_incomplete");
    return JSON.parse(rows.map(row=>row.chunk).join("")) as unknown;
  }
  metadataStatements(jobId:string,name:string,value:unknown,db=this.db()) {
    const json=stableJson(value),chunks:string[]=[];let start=0,size=0;
    // Split only at Unicode code point boundaries; D1 cells remain <=64KiB.
    for(let index=0;index<json.length;){const point=json.codePointAt(index)!,width=point>0xffff?2:1,bytes=point<0x80?1:point<0x800?2:point<0x10000?3:4;
      if(size+bytes>65536){chunks.push(json.slice(start,index));start=index;size=0;}size+=bytes;index+=width;}chunks.push(json.slice(start));
    if(chunks.length>64)throw new SystemRecoveryConflict("metadata_budget");
    return [db.prepare("DELETE FROM system_recovery_metadata_chunks WHERE job_id=? AND name=?").bind(jobId,name),
      ...chunks.map((chunk,index)=>db.prepare("INSERT INTO system_recovery_metadata_chunks(job_id,name,ordinal,chunk) VALUES(?,?,?,?)").bind(jobId,name,index,chunk))];
  }
  async saveMetadata(claim:RecoveryClaim,name:string,value:unknown){const db=this.db();await db.batch([this.guard(claim,db),...this.metadataStatements(claim.id,name,value,db)]);}
  async files(jobId:string){return(await this.db().prepare("SELECT id,ordinal,outcome,file_json FROM system_recovery_files WHERE job_id=? ORDER BY ordinal")
    .bind(jobId).all<{id:string;ordinal:number;outcome:string;file_json:string}>()).results;}
  async attempts(jobId:string){return(await this.db().prepare("SELECT * FROM system_recovery_attempts WHERE job_id=? ORDER BY generation DESC,created_at DESC,id DESC")
    .bind(jobId).all<RecoveryAttempt>()).results;}
  async startAttempt(claim:RecoveryClaim,expected:{byteSize:number;sha256:string}){
    const prior=await this.attempts(claim.id);
    if(prior.some(row=>["started","unknown"].includes(row.state)))throw new SystemRecoveryConflict("write_outcome_unknown");
    if(prior.length>=5)throw new SystemRecoveryConflict("attempt_limit");
    const id=crypto.randomUUID(),key=`fp5-system/${claim.id}/${id}`,db=this.db(),created=this.now().toISOString();
    await db.batch([this.guard(claim,db),db.prepare(`INSERT INTO system_recovery_attempts(id,job_id,generation,runtime_incarnation,owner_token,object_key,expected_byte_size,expected_sha256,state,created_at)
      VALUES(?,?,?,?,?,?,?,?,'started',?)`).bind(id,claim.id,claim.generation,claim.runtime_incarnation,claim.owner_token,key,expected.byteSize,expected.sha256,created)]);
    return(await this.attempts(claim.id)).find(row=>row.id===id)!;
  }
  /** A settled transport ACK is evidence even if its stage lost ownership. It
   * cannot mutate the job or publish an artifact under that stale owner. */
  async settleAttempt(attempt:RecoveryAttempt,state:"settled"|"failed"|"unknown"){
    await this.db().prepare("UPDATE system_recovery_attempts SET state=?,settled_at=? WHERE id=? AND state IN('started','unknown') AND owner_token=? AND generation=?")
      .bind(state,state==="unknown"?null:this.now().toISOString(),attempt.id,attempt.owner_token,attempt.generation).run();
  }
  async verifyAttempt(claim:RecoveryClaim,attempt:RecoveryAttempt){const db=this.db();await db.batch([this.guard(claim,db),
    db.prepare("UPDATE system_recovery_attempts SET state='verified',verified_at=? WHERE id=? AND state='settled'").bind(this.now().toISOString(),attempt.id),
    db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_attempts WHERE id=? AND state='verified') THEN 1 ELSE json('System recovery PUT not settled') END").bind(attempt.id)]);}
  async failSettledAttempt(claim:RecoveryClaim,attempt:RecoveryAttempt){const db=this.db();await db.batch([this.guard(claim,db),
    db.prepare("UPDATE system_recovery_attempts SET state='failed' WHERE id=? AND state='settled' AND settled_at IS NOT NULL").bind(attempt.id)]);}
  /** R2's atomic object visibility plus an exact complete body read is positive
   * commit evidence. Missing/corrupt/unavailable reads never call this method. */
  async settleAtomicReconciliation(claim:RecoveryClaim,attempt:RecoveryAttempt){const db=this.db();await db.batch([this.guard(claim,db),
    db.prepare("UPDATE system_recovery_attempts SET state='settled',settled_at=? WHERE id=? AND job_id=? AND state IN('started','unknown') AND object_key=? AND expected_byte_size=? AND expected_sha256=?")
      .bind(this.now().toISOString(),attempt.id,claim.id,attempt.object_key,attempt.expected_byte_size,attempt.expected_sha256)]);}
  async pause(claim:RecoveryClaim,reason:string,attempt?:RecoveryAttempt|null){
    const db=this.db(),now=this.now().toISOString();await db.batch([
      ...(attempt?[db.prepare("UPDATE system_recovery_attempts SET state='unknown' WHERE id=? AND state='started'").bind(attempt.id)]:[]),
      db.prepare("UPDATE system_recovery_jobs SET state='paused',reason=?,generation=generation+1,owner_token=NULL,runtime_incarnation=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='running' AND generation=? AND owner_token=?")
        .bind(reason,now,claim.id,claim.generation,claim.owner_token)]);
  }
  async configure(enabled:boolean){const db=this.db(),now=this.now().toISOString();await db.batch([
    db.prepare("UPDATE system_recovery_jobs SET state='paused',reason='executor_reconfigured',generation=generation+1,owner_token=NULL,runtime_incarnation=NULL,lease_expires_at=NULL,updated_at=? WHERE state IN('queued','running')").bind(now),
    db.prepare("UPDATE system_recovery_runtime SET enabled=?,incarnation=lower(hex(randomblob(16))),updated_at=? WHERE singleton=1").bind(enabled?1:0,now)]);}
  async control(job:RecoveryJob,action:"pause"|"resume"|"retry"|"cancel"){
    if(["completed","cancelled","preview"].includes(job.state))return;
    const state=action==="cancel"?"cancelled":action==="pause"?"paused":job.kind==="upload"&&job.phase==="write"?"awaiting_upload":"queued";
    if(["resume","retry"].includes(action)&&job.state!=="paused")throw new SystemRecoveryConflict();
    await this.db().prepare("UPDATE system_recovery_jobs SET state=?,generation=generation+1,owner_token=NULL,runtime_incarnation=NULL,lease_expires_at=NULL,reason=?,updated_at=? WHERE id=? AND actor=? AND generation=?")
      .bind(state,action==="pause"?"paused_by_administrator":null,this.now().toISOString(),job.id,job.actor,job.generation).run();
  }
  async recoverExpiredClaims(){await this.db().prepare("UPDATE system_recovery_jobs SET state='paused',reason='stage_interrupted',generation=generation+1,owner_token=NULL,runtime_incarnation=NULL,lease_expires_at=NULL,updated_at=? WHERE state='running' AND julianday(lease_expires_at)<=julianday(?)")
    .bind(this.now().toISOString(),this.now().toISOString()).run();}
  async recordCutover(job:RecoveryJob,input:{requestId:string;expectedCheckpoint:string},window:{generation:number;token:string|null;deadlineAt:string},authorized:()=>boolean){
    if(!authorized())throw new SystemRecoveryConflict("administrator_revoked");const prior=await this.request(input.requestId,job.actor,input);if(prior)return{job:prior,reused:true};
    const db=this.db(),now=this.now().toISOString(),digest=await sha256Hex(stableJson(input));
    if(!authorized())throw new SystemRecoveryConflict("administrator_revoked");
    await db.batch([db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_maintenance WHERE singleton=1 AND state='fenced' AND generation=? AND token IS ?)
      AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
      AND julianday('now')<julianday(?) THEN 1 ELSE json('Source maintenance changed or handoff deadline elapsed') END`).bind(window.generation,window.token,window.deadlineAt),
      db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_jobs WHERE id=? AND actor=? AND state='completed' AND phase='ready' AND json_extract(result_json,'$.checkpoint')=? AND generation=?) THEN 1 ELSE json('System recovery checkpoint changed') END")
      .bind(job.id,job.actor,input.expectedCheckpoint,job.generation),
      db.prepare("UPDATE system_recovery_jobs SET result_json=json_set(result_json,'$.cutover',json('true')),updated_at=? WHERE id=? AND generation=?").bind(now,job.id,job.generation),
      db.prepare("INSERT INTO system_recovery_requests(request_id,actor,job_id,input_sha256,accepted_at) VALUES(?,?,?,?,?)").bind(input.requestId,job.actor,job.id,digest,now),
      db.prepare("SELECT CASE WHEN julianday('now')<julianday(?) THEN 1 ELSE json('System recovery handoff deadline elapsed') END").bind(window.deadlineAt)]);
    return{job:(await this.job(job.id))!,reused:false};
  }
}
