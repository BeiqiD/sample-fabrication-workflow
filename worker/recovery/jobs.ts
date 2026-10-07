import type { RecoveryAttempt, RecoveryClaim, RecoveryJob, SystemRecoveryRepository } from "./repository";
import { SystemRecoveryConflict } from "./repository";
import { SYSTEM_RECOVERY_MAX_STEP_MS } from "../../shared/contracts/system-recovery";
import { ByteVerificationError, verifyByteStream, verifyingStream, type Sha256Factory } from "../files/byte-verification";

export interface RecoveryStepResult {
  patch: Partial<RecoveryJob>; statements?: readonly D1PreparedStatement[]; outcome: string;
}
export interface SystemRecoveryCapabilitiesAdapter {
  repository: SystemRecoveryRepository; incarnation: string; authorizeActor(actor: string): boolean;
  now(): Date; randomId(): string; hash: Sha256Factory;
  step(claim: RecoveryClaim, current: () => Promise<boolean>, signal: AbortSignal): Promise<RecoveryStepResult>;
  exportBody(claim: RecoveryClaim, current: () => Promise<boolean>, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  put(key: string, body: ReadableStream<Uint8Array>, byteSize: number): Promise<void>;
  read(key: string): Promise<ReadableStream<Uint8Array> | null>;
}
function safeReason(error: unknown) {
  if(error instanceof SystemRecoveryConflict)return error.reason;
  const known = new Set(["execution_budget_exhausted","administrator_revoked","archive_budget","source_checkpoint_changed","source_maintenance_required","legacy_requires_conversion",
    "partial_backup","target_unavailable","target_not_fresh","target_alias","write_outcome_unknown","attempt_limit","archive_invalid","source_unavailable","artifact_namespace_changed","artifact_namespace_unavailable"]);
  return error instanceof Error&&known.has(error.message)?error.message:"recovery_validation_or_storage_failed";
}
/** Read-only operator actions have the same hard budget as scheduled stages.
 * A late provider response cannot regain authority after the timeout wins. */
export async function runBoundedSystemRecoveryReadAction<T>(
  authorized:()=>Promise<boolean>,
  operation:(current:()=>Promise<boolean>,signal:AbortSignal,deadlineAt:string)=>Promise<T>,
  now:()=>Date=()=>new Date(),
){
  const abort=new AbortController(),deadline=now().getTime()+SYSTEM_RECOVERY_MAX_STEP_MS;let expired=false,timer:ReturnType<typeof setTimeout>|undefined;
  const local=()=>!expired&&!abort.signal.aborted&&now().getTime()<deadline;
  const current=async()=>local()&&await authorized()&&local();
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;abort.abort();reject(new Error("execution_budget_exhausted"));},SYSTEM_RECOVERY_MAX_STEP_MS);});
  try{return await Promise.race([operation(current,abort.signal,new Date(deadline).toISOString()),timeout]);}
  finally{if(timer!==undefined)clearTimeout(timer);expired=true;abort.abort();}
}
/** The stage clock stops local execution; it cannot certify an outstanding
 * provider PUT stopped. Every issued key remains in the durable attempt ledger. */
async function timed<T>(capabilities:SystemRecoveryCapabilitiesAdapter,claim:RecoveryClaim,
  operation:(current:()=>Promise<boolean>,signal:AbortSignal)=>Promise<T>,attempt:()=>RecoveryAttempt|null){
  const abort=new AbortController(),deadline=capabilities.now().getTime()+SYSTEM_RECOVERY_MAX_STEP_MS;let expired=false,timer:ReturnType<typeof setTimeout>|undefined;
  const current=async()=>!expired&&!abort.signal.aborted&&capabilities.now().getTime()<deadline&&capabilities.authorizeActor(claim.actor)&&await capabilities.repository.current(claim);
  const work=operation(current,abort.signal),timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;abort.abort();reject(new Error("execution_budget_exhausted"));},SYSTEM_RECOVERY_MAX_STEP_MS);});
  try{return await Promise.race([work,timeout]);}
  catch(error){abort.abort();await capabilities.repository.pause(claim,safeReason(error),attempt());throw error;}
  finally{if(timer)clearTimeout(timer);abort.abort();}
}
async function writeArtifact(capabilities:SystemRecoveryCapabilitiesAdapter,claim:RecoveryClaim,body:()=>Promise<ReadableStream<Uint8Array>>,
  expected:{byteSize:number;sha256:string},current:()=>Promise<boolean>,saveAttempt:(value:RecoveryAttempt)=>void){
  const repository=capabilities.repository,prior=(await repository.attempts(claim.id))[0];let attempt:RecoveryAttempt;
  if(prior&&["started","unknown","settled","verified"].includes(prior.state))attempt=prior;
  else {
    if(!await current())throw new Error("administrator_revoked");
    // The durable registration precedes opening/issuing any provider write.
    attempt=await repository.startAttempt(claim,expected);saveAttempt(attempt);
    let incoming:ReadableStream<Uint8Array>;
    try{incoming=await body();}catch(error){await repository.settleAttempt(attempt,"failed");throw error;}
    if(!await current()){await incoming.cancel().catch(()=>undefined);await repository.settleAttempt(attempt,"failed");throw new Error("administrator_revoked");}
    const verified=verifyingStream(incoming,expected,capabilities.hash,"source");
    try{await capabilities.put(attempt.object_key,verified.body,expected.byteSize);await repository.settleAttempt(attempt,"settled");
      attempt={...attempt,state:"settled",settled_at:capabilities.now().toISOString()};saveAttempt(attempt);verified.result();}
    catch(error){if(attempt.state==="settled"&&await current())await repository.failSettledAttempt(claim,attempt);else await repository.settleAttempt(attempt,"failed");throw error;}
    finally{await verified.dispose();}
  }
  saveAttempt(attempt);
  if(!await current())throw new Error("administrator_revoked");
  const unresolved=["started","unknown"].includes(attempt.state);
  if(attempt.expected_byte_size!==expected.byteSize||attempt.expected_sha256!==expected.sha256)throw new Error("archive_invalid");
  const stored=await capabilities.read(attempt.object_key);if(!stored)throw new Error(unresolved?"write_outcome_unknown":"source_unavailable");
  try{await verifyByteStream(stored,expected,capabilities.hash,"destination");}
  catch(error){if(!unresolved&&error instanceof ByteVerificationError&&["size_mismatch","hash_mismatch"].includes(error.reason)&&await current())await repository.failSettledAttempt(claim,attempt);throw error;}
  if(!await current())throw new Error("administrator_revoked");
  if(unresolved)await repository.settleAtomicReconciliation(claim,attempt);
  await repository.verifyAttempt(claim,attempt);
  return attempt;
}
export async function runSystemRecoveryJobStep(capabilities:SystemRecoveryCapabilitiesAdapter){
  const repository=capabilities.repository;await repository.recoverExpiredClaims();
  const next=await repository.next();if(!next)return{jobId:null,outcome:"idle"};
  if(!capabilities.authorizeActor(next.actor)){await repository.control(next,"pause");return{jobId:next.id,outcome:"administrator_revoked"};}
  const claim=await repository.claim(next.id,next.actor,capabilities.incarnation,capabilities.randomId());if(!claim)return{jobId:null,outcome:"idle"};
  let attempt:RecoveryAttempt|null=null;
  try{return await timed(capabilities,claim,async(current,signal)=>{
    if(!await current())throw new Error("administrator_revoked");
    if(claim.kind==="backup"&&claim.phase==="write"){
      if(!claim.archive_sha256||!claim.archive_byte_size)throw new Error("archive_invalid");
      const expected={byteSize:claim.archive_byte_size,sha256:claim.archive_sha256};
      const written=await writeArtifact(capabilities,claim,()=>capabilities.exportBody(claim,current,signal),expected,current,value=>{attempt=value;});
      await repository.finish(claim,{state:"completed",phase:"done",reason:null,artifact_key:written.object_key,expires_at:new Date(capabilities.now().getTime()+24*60*60_000).toISOString(),bytes_done:claim.bytes_total,completed_files:claim.total_files});
      return{jobId:claim.id,outcome:"completed"};
    }
    const result=await capabilities.step(claim,current,signal);if(!await current())throw new Error("administrator_revoked");
    await repository.finish(claim,result.patch,result.statements);return{jobId:claim.id,outcome:result.outcome};
  },()=>attempt);}catch{return{jobId:claim.id,outcome:"paused"};}
}
function abortableBody(body:ReadableStream<Uint8Array>,signal:AbortSignal){
  const reader=body.getReader();let ended=false,output:ReadableStreamDefaultController<Uint8Array>;
  const release=()=>{try{reader.releaseLock();}catch{/* Outstanding raw read settles separately. */}};
  const abort=()=>{if(ended)return;ended=true;output.error(signal.reason??new Error("execution_budget_exhausted"));void reader.cancel().catch(()=>undefined);release();};
  return new ReadableStream<Uint8Array>({start(c){output=c;signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();},
    async pull(c){try{const next=await reader.read();if(ended)return;if(next.done){ended=true;signal.removeEventListener("abort",abort);release();c.close();}else c.enqueue(next.value);}catch(error){if(!ended){ended=true;signal.removeEventListener("abort",abort);release();c.error(error);}}},
    cancel(reason){if(!ended){ended=true;signal.removeEventListener("abort",abort);void reader.cancel(reason).catch(()=>undefined);release();}}},{highWaterMark:0});
}
/** Ingress acknowledges only verified staging bytes. Domain admission occurs
 * later in the independently dispatched validate stage. */
export async function writeSystemRecoveryUpload(capabilities:SystemRecoveryCapabilitiesAdapter,claim:RecoveryClaim,body:ReadableStream<Uint8Array>){
  const input=JSON.parse(claim.input_json) as {byteSize:number;sha256:string};let attempt:RecoveryAttempt|null=null;
  return timed(capabilities,claim,async(current,signal)=>{
    const forwarded=abortableBody(body,signal);
    try{const written=await writeArtifact(capabilities,claim,async()=>forwarded,input,current,value=>{attempt=value;});
      if(!await current())throw new Error("administrator_revoked");
      await capabilities.repository.finish(claim,{state:"queued",phase:"validate",reason:null,artifact_key:written.object_key,archive_byte_size:input.byteSize,archive_sha256:input.sha256,
        expires_at:new Date(capabilities.now().getTime()+24*60*60_000).toISOString()});
    }finally{void forwarded.cancel().catch(()=>undefined);}
  },()=>attempt);
}
