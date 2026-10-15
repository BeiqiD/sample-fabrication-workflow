import type { Env } from "../types";
import type { ByteReader } from "../files/byte-reader";
import { workerV5PlannedBackupCleanupGuards } from "./v5-planned-source-window";
import { primaryD1 } from "../d1-primary";
import { canAdministerSystemSettings } from "../storage/system-administrator";
import { allowedEmail } from "../auth";
import { closeWorkerRecoveryExecutionOwner, ownWorkerRecoveryBodyClose,
  workerRecoveryOriginalInvocationSucceeded } from "../files/jobs/execution-lifetime";
import type { RecoveryClaim, RecoveryJob } from "./repository";
import { assertWorkerV5OriginalSourceStream, ownWorkerV5SourceStream, type WorkerV5OriginalSourceStream } from "./v5-held-r2-archive-candidate";
import type { SystemBackupRecordsV5 } from "../../shared/contracts/system-backup-v5";
import { sha256Hex, stableJson } from "../../shared/domain/content-addressing";

const PREFIX="v5-original-source-close/1:",MAXIMUM=512,GROUP=40,CLEANUP_GROUP=40;
type Kind="snapshot"|"body"|"put"|"recovery-step";
interface Intent {
  schema:"worker-v5-original-source-close/1";jobId:string;actor:string;acceptedAt:string;sourceInstallationId:string;
  generation:number;ownerToken:string;runtimeIncarnation:string;leaseExpiresAt:string;phase:string;
  ordinal:number;kind:Kind;resourceSha256:string;registeredAt:string;state:"unproven"|"acknowledged";
  acknowledgedAt:string|null;originalWorkFulfilled:boolean;originalAllCloseAcknowledged:boolean;
}
interface Entry { name:string;initial:string;intent:Intent;jobKind:"backup"|"recovery";nativeAcknowledged:boolean;firstClose?:Promise<void>;close?:()=>Promise<void> }
interface Owner { env:Env;database:D1Database;bucket:R2Bucket;installationId:string;entries:Entry[];ordinal:number;closing?:Promise<void> }
export interface WorkerV5SourceCloseIntent { readonly kind:"worker-v5-original-source-intent/1" }
const owners=new WeakMap<object,Owner>(),issued=new WeakMap<WorkerV5SourceCloseIntent,{owner:Owner;original:object;entry:Entry;claim:RecoveryClaim;signal:AbortSignal;deadlineAt:string}>();
function ensure(value:unknown,reason:string):asserts value {if(!value)throw new Error("worker_v5_source_close_"+reason);}
const iso=(value:string)=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
function local(owner:Owner,claim:RecoveryClaim,signal:AbortSignal,deadlineAt:string){
  return owner.env.DB===owner.database&&owner.env.ASSETS===owner.bucket&&!signal.aborted&&iso(deadlineAt)&&Date.now()<Date.parse(deadlineAt)
    &&canAdministerSystemSettings(owner.env,claim.actor)&&Boolean(owner.env.ACCESS_TEAM_DOMAIN&&owner.env.ACCESS_AUD)&&allowedEmail(claim.actor,owner.env.ALLOWED_EMAILS);
}
function claimFence(owner:Owner,claim:RecoveryClaim,deadlineAt:string){
  return primaryD1(owner.database).prepare(`SELECT CASE WHEN EXISTS(
    SELECT 1 FROM system_recovery_jobs j JOIN system_recovery_runtime r ON r.singleton=1 AND r.enabled=1 AND r.incarnation=j.runtime_incarnation
    WHERE j.id=? AND j.actor=? AND j.accepted_at=? AND j.kind=? AND j.state='running' AND j.phase=?
      AND j.generation=? AND j.owner_token=? AND j.runtime_incarnation=? AND j.lease_expires_at=? AND r.installation_id=?
      AND julianday(j.lease_expires_at)>julianday('now') AND julianday(?)>julianday('now')
      AND ((j.kind='backup' AND (json_extract(j.input_json,'$.mode')<>'planned' OR EXISTS(
        SELECT 1 FROM system_recovery_metadata_chunks reservation JOIN system_recovery_maintenance m ON m.singleton=1
        WHERE reservation.job_id=j.id AND reservation.name='v5-planned-backup-window/1' AND reservation.ordinal=0 AND json_valid(reservation.chunk)
          AND json_extract(reservation.chunk,'$.schema')='worker-v5-planned-backup-window/1'
          AND json_extract(reservation.chunk,'$.backupId')=j.id AND json_extract(reservation.chunk,'$.sourceInstallationId')=r.installation_id
          AND m.state='fenced' AND m.generation=json_extract(reservation.chunk,'$.maintenanceGeneration')
          AND m.token=json_extract(reservation.chunk,'$.maintenanceToken')
          AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)))) OR (j.kind='recovery' AND json_valid(j.input_json) AND json_extract(j.input_json,'$.mode')='planned' AND j.checkpoint_json=?
        AND EXISTS(SELECT 1 FROM system_recovery_metadata_chunks reservation WHERE reservation.job_id=j.id
          AND reservation.name='v5-planned-source-window/1' AND reservation.ordinal=0 AND reservation.chunk=j.checkpoint_json))))
    THEN 1 ELSE json('Original V5 source intent lease or deadline changed') END`)
    .bind(claim.id,claim.actor,claim.accepted_at,claim.kind,claim.phase,claim.generation,claim.owner_token,claim.runtime_incarnation,claim.lease_expires_at,owner.installationId,deadlineAt,claim.checkpoint_json);
}
/** Lifetime registration only. begin() separately joins the actual durable
 * original job/actor/claim. Neither a copied token nor a callback grants SQL. */
export function registerWorkerV5SourceCloseOwner(original:object,env:Env,installationId:string){
  ensure(!owners.has(original)&&/^[a-f0-9]{32}$/.test(installationId),"original_registration");
  owners.set(original,{env,database:env.DB,bucket:env.ASSETS,installationId,entries:[],ordinal:0});
}
/** The durable UNPROVEN intent precedes every original snapshot/body/PUT owner.
 * A lost registration response cannot be replaced by an optimistic close ACK. */
export async function beginWorkerV5SourceCloseIntent(original:object,claim:RecoveryClaim,kind:Kind,resource:string,
  current:()=>Promise<boolean>,signal:AbortSignal,deadlineAt:string):Promise<WorkerV5SourceCloseIntent>{
  ensure(claim.kind==="backup"||claim.kind==="recovery","original_job_kind");
  const owner=owners.get(original);ensure(owner&&!owner.closing&&claim.state==="running"&&(claim.kind==="backup"&&kind!=="recovery-step"
    ||claim.kind==="recovery"&&(kind==="body"||kind==="recovery-step")&&JSON.parse(claim.input_json)?.mode==="planned"),"original_owner");
  const ordinal=owner.ordinal++;ensure(ordinal<MAXIMUM&&local(owner,claim,signal,deadlineAt)&&await current()&&local(owner,claim,signal,deadlineAt),"current_original_claim");
  const resourceSha256=await sha256Hex(resource),registeredAt=new Date().toISOString();
  const intent:Intent={schema:"worker-v5-original-source-close/1",jobId:claim.id,actor:claim.actor,acceptedAt:claim.accepted_at,
    sourceInstallationId:owner.installationId,generation:claim.generation,ownerToken:claim.owner_token,runtimeIncarnation:claim.runtime_incarnation,
    leaseExpiresAt:claim.lease_expires_at,phase:claim.phase,ordinal,kind,resourceSha256,registeredAt,state:"unproven",acknowledgedAt:null,
    originalWorkFulfilled:false,originalAllCloseAcknowledged:false};
  const name=PREFIX+claim.generation+":"+claim.owner_token+":"+ordinal,initial=stableJson(intent),db=primaryD1(owner.database);
  ensure(new TextEncoder().encode(initial).byteLength<=8192&&await current()&&local(owner,claim,signal,deadlineAt),"registration_budget_or_claim");
  // No upsert/delete: old UNKNOWN ownership can never be overwritten by retry.
  await db.batch([claimFence(owner,claim,deadlineAt),
    db.prepare("INSERT INTO system_recovery_metadata_chunks(job_id,name,ordinal,chunk) VALUES(?,?,0,?)").bind(claim.id,name,initial),
    db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_metadata_chunks WHERE job_id=? AND name=? AND ordinal=0 AND chunk=?) THEN 1 ELSE json('Original V5 source intent unavailable') END")
      .bind(claim.id,name,initial)]);
  // The same original whole invocation is already retained before this await.
  // A registration ACK only permits its subsequent original ownership attempt.
  const entry:Entry={name,initial,intent,jobKind:claim.kind,nativeAcknowledged:false};owner.entries.push(entry);
  const token:WorkerV5SourceCloseIntent=Object.freeze({kind:"worker-v5-original-source-intent/1"});issued.set(token,{owner,original,entry,claim,signal,deadlineAt});return token;
}
/** Additional restrictive synchronous fence after actual original current
 * awaits. The issued intent supplies its immutable clock and original bindings. */
export function assertWorkerV5OriginalSourceIntentIssue(token:WorkerV5SourceCloseIntent){
  const original=issued.get(token);ensure(original&&local(original.owner,original.claim,original.signal,original.deadlineAt),"original_intent_issue");
}
export function acknowledgeWorkerV5OriginalNativeSource(token:WorkerV5SourceCloseIntent){
  const value=issued.get(token);ensure(value&&value.entry.intent.kind!=="body","original_native_ack");value.entry.nativeAcknowledged=true;
}
/** The disposer comes only from the real factory-issued logical stream. Its
 * first original promise is cached once and reused by the existing all-close. */
export function ownWorkerV5OriginalSourceBody(token:WorkerV5SourceCloseIntent,stream:WorkerV5OriginalSourceStream){
  assertWorkerV5OriginalSourceStream(stream);const dispose=stream.close;
  const value=issued.get(token);ensure(value&&value.entry.intent.kind==="body"&&!value.entry.close,"original_body_owner");
  const entry=value.entry;
  const originalClose=()=>{
    if(entry.firstClose)return entry.firstClose;
    try{entry.firstClose=dispose();}catch(error){entry.firstClose=Promise.reject(error);}
    void entry.firstClose.catch(()=>undefined);return entry.firstClose;
  };
  entry.close=originalClose;ownWorkerRecoveryBodyClose(value.original,originalClose);
}
/** Same original cached all-close, then durable positive settlement. This is
 * not new byte ownership, job publication, or permission to release a hold. */
export function closeWorkerV5OriginalSourceOwner(original:object):Promise<void>{
  const owner=owners.get(original);if(!owner)return closeWorkerRecoveryExecutionOwner(original);
  if(owner.closing)return owner.closing;
  owner.closing=(async()=>{
    await closeWorkerRecoveryExecutionOwner(original);
    if(!owner.entries.length||!await workerRecoveryOriginalInvocationSucceeded(original))return;
    for(const entry of owner.entries){
      if(entry.intent.kind==="body"){if(!entry.firstClose)return;await entry.firstClose;}
      else if(!entry.nativeAcknowledged)return;
    }
    ensure(owner.env.DB===owner.database&&owner.env.ASSETS===owner.bucket,"original_settlement_binding");
    const db=primaryD1(owner.database),acknowledgedAt=new Date().toISOString();
    for(let offset=0;offset<owner.entries.length;offset+=GROUP){
      const group=owner.entries.slice(offset,offset+GROUP),closed=group.map(entry=>stableJson({...entry.intent,state:"acknowledged",acknowledgedAt,
        originalWorkFulfilled:true,originalAllCloseAcknowledged:true}));
      const statements=[db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_runtime WHERE singleton=1 AND installation_id=?) THEN 1 ELSE json('Original source installation changed') END").bind(owner.installationId),
        ...group.map((entry,index)=>db.prepare(`UPDATE system_recovery_metadata_chunks SET chunk=? WHERE job_id=? AND name=? AND ordinal=0 AND chunk=?
          AND EXISTS(SELECT 1 FROM system_recovery_jobs j WHERE j.id=system_recovery_metadata_chunks.job_id AND j.kind=? AND j.actor=? AND j.accepted_at=? AND j.generation>=?)`)
          .bind(closed[index]!,entry.intent.jobId,entry.name,entry.initial,entry.jobKind,entry.intent.actor,entry.intent.acceptedAt,entry.intent.generation)),
        ...group.map((entry,index)=>db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_metadata_chunks WHERE job_id=? AND name=? AND ordinal=0 AND chunk=?) THEN 1 ELSE json('Original V5 all-close settlement unavailable') END")
          .bind(entry.intent.jobId,entry.name,closed[index]!))];
      ensure(statements.length<=128&&owner.env.DB===owner.database&&owner.env.ASSETS===owner.bucket,"original_settlement_budget_or_binding");
      await db.batch(statements);
    }
  })();void owner.closing.catch(()=>undefined);return owner.closing;
}

interface PlannedTargetOriginal { original:object;env:Env;claim:RecoveryClaim;current:()=>Promise<boolean>;signal:AbortSignal;deadlineAt:string }
const plannedTargets=new WeakMap<object,PlannedTargetOriginal>();
/** Lifetime binding to the same private original capability and concrete
 * target input. begin() still requires the actual durable claim/window SQL. */
export function bindWorkerV5PlannedOriginalTargetInput(original:object,env:Env,input:object,claim:RecoveryClaim,
  current:()=>Promise<boolean>,signal:AbortSignal,deadlineAt:string){
  const owner=owners.get(original);ensure(owner&&owner.env===env&&owner.database===env.DB&&owner.bucket===env.ASSETS
    &&!owner.closing&&!plannedTargets.has(input)&&claim.kind==="recovery"&&JSON.parse(claim.input_json)?.mode==="planned","original_planned_target_binding");
  plannedTargets.set(input,{original,env,claim,current,signal,deadlineAt});
}
/** Synchronous final native issue fence over the privately bound original
 * actor/bindings/signal and immutable kernel deadline, after awaited current. */
export function assertWorkerV5PlannedOriginalTargetIssue(env:Env,input:object|undefined){
  if(input===undefined)return;
  const binding=plannedTargets.get(input),owner=binding&&owners.get(binding.original);
  ensure(binding&&binding.env===env&&owner&&local(owner,binding.claim,binding.signal,binding.deadlineAt),"original_planned_native_issue");
}
/** Wrap only actual planned target readback bodies, keeping the native reader,
 * result and existing provider guards. No raw reader ACK substitutes for this
 * factory-issued logical body and the same cached original first close. */
export function workerV5PlannedOriginalTargetReader(env:Env,input:object|undefined,reader:ByteReader):ByteReader{
  if(input===undefined)return reader;
  const binding=plannedTargets.get(input);ensure(binding&&binding.env===env,"unissued_planned_target_reader");
  const bound=binding;
  const currentLocal=()=>{const owner=owners.get(bound.original);ensure(owner&&local(owner,bound.claim,bound.signal,bound.deadlineAt),"original_planned_target_current");};
  return {stat(key){return reader.stat(key);},async read(key){
    currentLocal();const intent=await beginWorkerV5SourceCloseIntent(bound.original,bound.claim,"body",stableJson({targetReadKey:key}),
      bound.current,bound.signal,bound.deadlineAt);
    if(!await bound.current())throw new Error("administrator_revoked");currentLocal();
    const result=await reader.read(key);if(result.outcome!=="available")return result;
    const stream=ownWorkerV5SourceStream(result.body,async()=>{currentLocal();if(!await bound.current())throw new Error("administrator_revoked");currentLocal();});
    ownWorkerV5OriginalSourceBody(intent,stream);return {...result,body:stream.body};
  }};
}

const KEYS=["schema","jobId","actor","acceptedAt","sourceInstallationId","generation","ownerToken","runtimeIncarnation","leaseExpiresAt","phase",
  "ordinal","kind","resourceSha256","registeredAt","state","acknowledgedAt","originalWorkFulfilled","originalAllCloseAcknowledged"];
function closedIntent(chunk:string,job:RecoveryJob,installationId:string,name:string,recovery=false){
  ensure(new TextEncoder().encode(chunk).byteLength<=8192,"closed_record_budget");const value:unknown=JSON.parse(chunk);
  ensure(value&&typeof value==="object"&&!Array.isArray(value),"closed_record");const row=value as Record<string,unknown>;
  ensure(Object.keys(row).sort().join(",")===KEYS.slice().sort().join(",")&&row.schema==="worker-v5-original-source-close/1"
    &&row.jobId===job.id&&row.actor===job.actor&&row.acceptedAt===job.accepted_at&&row.sourceInstallationId===installationId
    &&typeof row.generation==="number"&&Number.isSafeInteger(row.generation)&&row.generation>0&&row.generation<=job.generation
    &&typeof row.ownerToken==="string"&&/^[A-Za-z0-9-]{1,128}$/.test(row.ownerToken)&&typeof row.runtimeIncarnation==="string"&&/^[a-f0-9]{32}$/.test(row.runtimeIncarnation)
    &&typeof row.leaseExpiresAt==="string"&&iso(row.leaseExpiresAt)&&typeof row.phase==="string"&&(recovery?["claim","schema","rows","files","reinstall","verify","ready"]:["snapshot","inventory","measure","write"]).includes(row.phase)
    &&typeof row.ordinal==="number"&&Number.isSafeInteger(row.ordinal)&&row.ordinal>=0&&row.ordinal<MAXIMUM
    &&(recovery?["body","recovery-step"]:["snapshot","body","put"]).includes(String(row.kind))&&typeof row.resourceSha256==="string"&&/^[a-f0-9]{64}$/.test(row.resourceSha256)
    &&typeof row.registeredAt==="string"&&iso(row.registeredAt)&&row.state==="acknowledged"&&typeof row.acknowledgedAt==="string"&&iso(row.acknowledgedAt)
    &&Date.parse(row.acknowledgedAt)>=Date.parse(row.registeredAt)&&row.originalWorkFulfilled===true&&row.originalAllCloseAcknowledged===true
    &&name===PREFIX+row.generation+":"+row.ownerToken+":"+row.ordinal,"unproven_original_source_close");
  return row;
}
interface Hold { id:string;location_id:string;hold_kind:string;operation_id:string;reason:string;acquired_at:string;expires_at:null;released_at:null }
export interface WorkerV5SourceCloseCleanupAdmission { readonly kind:"worker-v5-durable-source-close-cleanup/1" }
interface ClosedRecord { readonly name:string;readonly ordinal:number;readonly chunk:string }
const cleanupAdmissions=new WeakMap<WorkerV5SourceCloseCleanupAdmission,{env:Env;database:D1Database;job:RecoveryJob;installationId:string;records:readonly ClosedRecord[];holds:Hold[];plannedGuards:readonly D1PreparedStatement[]}>();
/** A restart uses only closed versioned durable records, never old WeakMaps. */
export async function admitWorkerV5SourceCloseCleanup(env:Env,job:RecoveryJob,records:SystemBackupRecordsV5):Promise<WorkerV5SourceCloseCleanupAdmission>{
  const database=env.DB,db=primaryD1(database),runtime=await db.prepare("SELECT installation_id FROM system_recovery_runtime WHERE singleton=1").first<{installation_id:string}>();
  ensure(job.kind==="backup"&&runtime&&/^[a-f0-9]{32}$/.test(runtime.installation_id)&&records.backupId===job.id&&records.createdAt===job.accepted_at
    &&records.origin.format==="native"&&records.origin.schemaVersion===28&&records.origin.capturePolicy==="atomic-primary-with-byte-holds/1","cleanup_installation_or_original_snapshot");
  const rows=await db.prepare("SELECT name,ordinal,chunk FROM system_recovery_metadata_chunks WHERE job_id=? AND substr(name,1,?)=? ORDER BY name,ordinal LIMIT ?")
    .bind(job.id,PREFIX.length,PREFIX,MAXIMUM+1).all<{name:string;ordinal:number;chunk:string}>();
  ensure(rows.success&&rows.results.length>0&&rows.results.length<=MAXIMUM,"missing_original_source_close");
  let snapshots=0;const originalSnapshotResource=await sha256Hex(stableJson({backupId:job.id,installationId:runtime.installation_id}));
  for(const row of rows.results){ensure(row.ordinal===0,"closed_record_chunk");const proof=closedIntent(row.chunk,job,runtime.installation_id,row.name);
    if(proof.kind==="snapshot"){ensure(proof.phase==="snapshot"&&proof.resourceSha256===originalSnapshotResource,"original_snapshot_resource");snapshots++;}}
  ensure(snapshots===1,"original_snapshot_close");
  const table=records.image.tables.file_location_holds;ensure(table,"original_snapshot_holds");const holds:Hold[]=[];
  for(const row of table.rows){
    const text=(column:string)=>{const cell=row.cells[table.columns.indexOf(column)];ensure(cell?.type==="text","original_hold_cell");return cell.value;};
    const operation=row.cells[table.columns.indexOf("operation_id")];if(operation?.type!=="text"||operation.value!=="fp5-backup:"+job.id)continue;
    ensure(row.cells[table.columns.indexOf("expires_at")]?.type==="null"&&row.cells[table.columns.indexOf("released_at")]?.type==="null","original_unreleased_hold");
    const hold={id:text("id"),location_id:text("location_id"),hold_kind:text("hold_kind"),operation_id:operation.value,reason:text("reason"),acquired_at:text("acquired_at"),expires_at:null,released_at:null};
    ensure(/^fp5_[a-f0-9]{32}$/.test(hold.id)&&hold.hold_kind==="export"&&hold.reason==="Frozen system backup source"&&hold.acquired_at===job.accepted_at,"original_hold_identity");holds.push(hold);
  }
  ensure(holds.length<=MAXIMUM&&new Set(holds.map(row=>row.id)).size===holds.length&&new Set(holds.map(row=>row.location_id)).size===holds.length
    &&new TextEncoder().encode(stableJson(holds)).byteLength<=60000&&env.DB===database,"original_hold_budget_or_binding");
  const token:WorkerV5SourceCloseCleanupAdmission=Object.freeze({kind:"worker-v5-durable-source-close-cleanup/1"});
  // Freeze the exact validated native rows, including the complete original
  // JSON bytes. Repeating a subset of flags would allow same-count record
  // changes between admission and actual artifact/hold release.
  const closedRecords=Object.freeze(rows.results.map(row=>Object.freeze({name:row.name,ordinal:row.ordinal,chunk:row.chunk})));
  const plannedGuards=await workerV5PlannedBackupCleanupGuards(env,job.id);
  ensure(env.DB===database,"original_cleanup_source_binding");
  cleanupAdmissions.set(token,{env,database,job,installationId:runtime.installation_id,records:closedRecords,holds,plannedGuards});
  await db.batch(workerV5SourceCloseCleanupGuards(env,job,token));return token;
}
/** Repeat in the SAME source eligibility/hold-release transaction. A future
 * original intent, malformed/unknown close, or changed hold denies release. */
export function workerV5SourceCloseCleanupGuards(env:Env,job:RecoveryJob,token:WorkerV5SourceCloseCleanupAdmission):D1PreparedStatement[]{
  const value=cleanupAdmissions.get(token);ensure(value&&value.env===env&&value.database===env.DB&&value.job===job,"original_cleanup_admission");
  const db=primaryD1(value.database),statements=[db.prepare(`SELECT CASE WHEN
    EXISTS(SELECT 1 FROM system_recovery_jobs j JOIN system_recovery_runtime r ON r.singleton=1
      WHERE j.id=? AND j.actor=? AND j.accepted_at=? AND j.kind='backup' AND r.installation_id=?)
    AND (SELECT count(*) FROM system_recovery_metadata_chunks WHERE job_id=? AND substr(name,1,?)=?)=?
    AND NOT EXISTS(SELECT 1 FROM system_recovery_metadata_chunks c JOIN system_recovery_jobs j ON j.id=c.job_id
      WHERE c.job_id=? AND substr(c.name,1,?)=? AND (c.ordinal<>0 OR NOT json_valid(c.chunk)
        OR json_extract(c.chunk,'$.schema') IS NOT 'worker-v5-original-source-close/1' OR json_extract(c.chunk,'$.state') IS NOT 'acknowledged'
        OR json_extract(c.chunk,'$.jobId') IS NOT j.id OR json_extract(c.chunk,'$.actor') IS NOT j.actor
        OR json_extract(c.chunk,'$.acceptedAt') IS NOT j.accepted_at OR json_extract(c.chunk,'$.sourceInstallationId') IS NOT ?
        OR json_extract(c.chunk,'$.originalWorkFulfilled') IS NOT 1 OR json_extract(c.chunk,'$.originalAllCloseAcknowledged') IS NOT 1))
    AND (SELECT count(*) FROM file_location_holds WHERE operation_id=?)=json_array_length(?)
    AND NOT EXISTS(SELECT 1 FROM file_location_holds h WHERE h.operation_id=? AND NOT EXISTS(SELECT 1 FROM json_each(?) expected
      WHERE h.id=json_extract(expected.value,'$.id') AND h.location_id=json_extract(expected.value,'$.location_id')
        AND h.hold_kind=json_extract(expected.value,'$.hold_kind') AND h.operation_id=json_extract(expected.value,'$.operation_id')
        AND h.reason=json_extract(expected.value,'$.reason') AND h.acquired_at=json_extract(expected.value,'$.acquired_at')
        AND h.expires_at IS NULL AND h.released_at IS NULL))
    THEN 1 ELSE json('Original V5 durable source close or exact hold inventory changed') END`)
    .bind(job.id,job.actor,job.accepted_at,value.installationId,job.id,PREFIX.length,PREFIX,value.records.length,
      job.id,PREFIX.length,PREFIX,value.installationId,"fp5-backup:"+job.id,stableJson(value.holds),"fp5-backup:"+job.id,stableJson(value.holds))];
  statements.push(...exactClosedRecordGuards(value.database,job.id,value.records),...value.plannedGuards);
  ensure(statements.length+3<=128,"original_cleanup_guard_budget");return statements;
}
function exactClosedRecordGuards(database:D1Database,jobId:string,records:readonly ClosedRecord[]):D1PreparedStatement[]{
  const db=primaryD1(database),statements:D1PreparedStatement[]=[];
  // Each page binds at most81 parameters and checks at most40 exact records.
  // No JSON serialization of the frozen chunks or one oversized parameter is
  // needed. All pages must run in the SAME original native transaction as the
  // guarded cleanup mutation, or as one read-only transaction before DELETE.
  for(let offset=0;offset<records.length;offset+=CLEANUP_GROUP){
    const group=records.slice(offset,offset+CLEANUP_GROUP),bindings:unknown[]=[];
    const expected=group.map(record=>{ensure(record.ordinal===0,"original_closed_ordinal");bindings.push(record.name,record.chunk);
      return "(?,0,?)";}).join(",");
    statements.push(db.prepare(`WITH expected(name,ordinal,chunk) AS (VALUES ${expected})
      SELECT CASE WHEN NOT EXISTS(
      SELECT 1 FROM expected LEFT JOIN system_recovery_metadata_chunks actual
        ON actual.job_id=? AND actual.name=expected.name AND actual.ordinal=expected.ordinal
      WHERE actual.chunk IS NOT expected.chunk)
      THEN 1 ELSE json('Original V5 exact source close record inventory changed') END`).bind(...bindings,jobId));
  }
  ensure(statements.length<=13,"original_closed_record_page_budget");return statements;
}
const RETIREMENT_NAME="v5-planned-original-retirement/1";
interface OriginalPlannedRelease { requestId:string;actor:string;expectedGeneration:number }
interface OriginalRetirement {
  schema:"worker-v5-planned-original-retirement/1";jobId:string;jobKind:"backup"|"recovery";actor:string;acceptedAt:string;
  sourceInstallationId:string;checkpointSha256:string;windowGeneration:number;windowToken:string;finalGeneration:number;
  proofCount:number;proofSha256:string;releaseRequestId:string;releaseActor:string;
}
const RETIREMENT_KEYS=["schema","jobId","jobKind","actor","acceptedAt","sourceInstallationId","checkpointSha256","windowGeneration",
  "windowToken","finalGeneration","proofCount","proofSha256","releaseRequestId","releaseActor"];
function originalWindowTuple(job:RecoveryJob){
  ensure(typeof job.checkpoint_json==="string","planned_original_window_checkpoint");
  const checkpoint:unknown=JSON.parse(job.checkpoint_json);ensure(checkpoint&&typeof checkpoint==="object"&&!Array.isArray(checkpoint),"planned_original_window_shape");
  const outer=checkpoint as Record<string,unknown>,value=job.kind==="backup"?outer.plannedSourceWindow:outer;
  ensure(value&&typeof value==="object"&&!Array.isArray(value),"planned_original_window_shape");const window=value as Record<string,unknown>;
  ensure(window.schema===(job.kind==="backup"?"worker-v5-planned-backup-window/1":"worker-v5-planned-source-window/1")
    &&typeof window.sourceInstallationId==="string"&&/^[a-f0-9]{32}$/.test(window.sourceInstallationId)
    &&typeof window.maintenanceGeneration==="number"&&Number.isSafeInteger(window.maintenanceGeneration)&&window.maintenanceGeneration>0
    &&typeof window.maintenanceToken==="string"&&/^[A-Za-z0-9-]{1,128}$/.test(window.maintenanceToken),"planned_original_window_tuple");
  return {sourceInstallationId:window.sourceInstallationId,generation:window.maintenanceGeneration,token:window.maintenanceToken};
}
function releaseReceiptValid(text:string,generation:number){
  const value:unknown=JSON.parse(text);ensure(value&&typeof value==="object"&&!Array.isArray(value),"planned_release_receipt_shape");const row=value as Record<string,unknown>;
  ensure(Object.keys(row).sort().join(",")==="activeWriters,backupJobId,checkpoint,generation,state,token"
    &&row.state==="open"&&row.generation===generation+1&&row.token===null&&row.checkpoint===null&&row.backupJobId===null
    &&row.activeWriters===0,"planned_release_receipt_shape");
}
const RELEASE_RECEIPT_SQL=`json_valid(receipt.result_json)
  AND (SELECT count(*) FROM json_each(receipt.result_json))=6
  AND json_extract(receipt.result_json,'$.state')='open'
  AND json_extract(receipt.result_json,'$.generation')=receipt.expected_generation+1
  AND json_type(receipt.result_json,'$.token')='null' AND json_type(receipt.result_json,'$.checkpoint')='null'
  AND json_type(receipt.result_json,'$.backupJobId')='null' AND json_extract(receipt.result_json,'$.activeWriters')=0`;
async function originalRetirement(database:D1Database,job:RecoveryJob,installationId:string,records:readonly ClosedRecord[]){
  ensure(typeof job.checkpoint_json==="string","planned_retirement_checkpoint");
  const db=primaryD1(database),rows=await db.prepare("SELECT ordinal,chunk FROM system_recovery_metadata_chunks WHERE job_id=? AND name=? ORDER BY ordinal LIMIT 2")
    .bind(job.id,RETIREMENT_NAME).all<{ordinal:number;chunk:string}>();
  ensure(rows.success&&rows.results.length<=1,"planned_retirement_inventory");if(!rows.results.length)return;
  const native=rows.results[0]!;ensure(native.ordinal===0&&new TextEncoder().encode(native.chunk).byteLength<=8192,"planned_retirement_record_budget");
  const value:unknown=JSON.parse(native.chunk);ensure(value&&typeof value==="object"&&!Array.isArray(value),"planned_retirement_shape");const row=value as Record<string,unknown>;
  const window=originalWindowTuple(job),checkpointSha256=await sha256Hex(job.checkpoint_json),proofSha256=await sha256Hex(stableJson(records));
  ensure(Object.keys(row).sort().join(",")===RETIREMENT_KEYS.slice().sort().join(",")&&row.schema==="worker-v5-planned-original-retirement/1"
    &&row.jobId===job.id&&row.jobKind===job.kind&&row.actor===job.actor&&row.acceptedAt===job.accepted_at&&row.sourceInstallationId===installationId
    &&window.sourceInstallationId===installationId&&row.checkpointSha256===checkpointSha256&&row.windowGeneration===window.generation&&row.windowToken===window.token
    &&typeof row.finalGeneration==="number"&&Number.isSafeInteger(row.finalGeneration)&&row.finalGeneration>0&&row.finalGeneration<=job.generation
    &&row.proofCount===records.length&&row.proofSha256===proofSha256
    &&typeof row.releaseRequestId==="string"&&/^[A-Za-z0-9-]{1,128}$/.test(row.releaseRequestId)
    &&typeof row.releaseActor==="string"&&row.releaseActor.length>0&&row.releaseActor.length<=320,"planned_retirement_shape");
  const receipt=await db.prepare(`SELECT result_json FROM system_recovery_maintenance_requests WHERE request_id=? AND actor=? AND action='release' AND expected_generation=?`)
    .bind(row.releaseRequestId,row.releaseActor,window.generation).first<{result_json:string}>();
  ensure(receipt,"planned_retirement_original_release");releaseReceiptValid(receipt.result_json,window.generation);
  const guards=[db.prepare(`SELECT CASE WHEN
    (SELECT count(*) FROM system_recovery_metadata_chunks WHERE job_id=? AND name=?)=1
    AND EXISTS(SELECT 1 FROM system_recovery_metadata_chunks WHERE job_id=? AND name=? AND ordinal=0 AND chunk=?)
    AND EXISTS(SELECT 1 FROM system_recovery_maintenance_requests receipt WHERE receipt.request_id=? AND receipt.actor=?
      AND receipt.action='release' AND receipt.expected_generation=? AND receipt.result_json=? AND ${RELEASE_RECEIPT_SQL})
    THEN 1 ELSE json('Original planned retirement or release receipt changed') END`)
    .bind(job.id,RETIREMENT_NAME,job.id,RETIREMENT_NAME,native.chunk,row.releaseRequestId,row.releaseActor,window.generation,receipt.result_json)];
  return {finalGeneration:row.finalGeneration,guards};
}
/** A first release requires the actual final job generation. Later completed
 * cleanup generations are accepted only with SAME atomically qualified release
 * receipt and unchanged complete original proof bytes, never surviving max(). */
async function plannedOriginalCloseReleasePlan(env:Env,job:RecoveryJob,installationId:string,backup:boolean,
  release?:OriginalPlannedRelease,requireRetirement=false,cleanupAdvance=false):Promise<{before:D1PreparedStatement[];after:D1PreparedStatement[]}>{
  ensure(job.kind===(backup?"backup":"recovery")&&job.state==="completed"&&job.phase===(backup?"done":"ready")
    &&typeof job.checkpoint_json==="string"&&job.owner_token===null&&job.runtime_incarnation===null&&job.lease_expires_at===null,"planned_original_job_not_ready");
  const database=env.DB,db=primaryD1(database),rows=await db.prepare("SELECT name,ordinal,chunk FROM system_recovery_metadata_chunks WHERE job_id=? AND substr(name,1,?)=? ORDER BY name,ordinal LIMIT ?")
    .bind(job.id,PREFIX.length,PREFIX,MAXIMUM+1).all<ClosedRecord>();
  ensure(rows.success&&rows.results.length>0&&rows.results.length<=MAXIMUM,"planned_missing_original_all_close");
  const records=Object.freeze(rows.results.map(row=>Object.freeze({name:row.name,ordinal:row.ordinal,chunk:row.chunk})));
  const retired=await originalRetirement(database,job,installationId,records);ensure(!requireRetirement||retired,"planned_cleanup_requires_original_retirement");
  const finalGeneration=retired?.finalGeneration??job.generation;
  let finalOriginalStep=false,snapshots=0,finalOriginalPut=false;
  const proofs=records.map(row=>{ensure(row.ordinal===0,"planned_original_close_ordinal");return closedIntent(row.chunk,job,installationId,row.name,!backup);});
  for(const proof of proofs){
    ensure(typeof proof.generation==="number"&&proof.generation<=finalGeneration,"planned_original_generation_after_retirement");
    if(backup&&proof.kind==="snapshot"){
      ensure(proof.phase==="snapshot"&&proof.resourceSha256===await sha256Hex(stableJson({backupId:job.id,installationId})),"planned_original_snapshot_resource");snapshots++;
    }
    if(backup&&proof.kind==="put"&&proof.generation===finalGeneration){
      ensure(proof.phase==="write"&&job.artifact_key&&typeof job.archive_byte_size==="number"
        &&proof.resourceSha256===await sha256Hex(stableJson({key:job.artifact_key,byteSize:job.archive_byte_size})),"planned_final_original_put_resource");finalOriginalPut=true;
    }
    if(!backup&&proof.kind==="recovery-step"){
      const expected=await sha256Hex(stableJson({jobId:job.id,phase:proof.phase,sourceWindow:job.checkpoint_json}));
      ensure(proof.resourceSha256===expected,"planned_original_step_resource");if(proof.generation===finalGeneration)finalOriginalStep=true;
    }
  }
  ensure((backup?snapshots===1&&finalOriginalPut:finalOriginalStep)&&env.DB===database,"planned_final_original_all_close");
  const before=[db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_jobs j JOIN system_recovery_runtime r ON r.singleton=1
    WHERE j.id=? AND j.kind=? AND j.actor=? AND j.accepted_at=? AND j.generation IN(?,?) AND j.state='completed' AND j.phase=?
      AND j.owner_token IS NULL AND j.runtime_incarnation IS NULL AND j.lease_expires_at IS NULL AND j.checkpoint_json=?
      AND r.installation_id=?
      AND NOT EXISTS(SELECT 1 FROM system_recovery_attempts a WHERE a.job_id=j.id AND a.state IN('started','unknown','settled'))
      AND (j.kind<>'backup' OR EXISTS(SELECT 1 FROM system_recovery_attempts a WHERE a.job_id=j.id AND a.generation=?
        AND a.object_key=j.artifact_key AND a.expected_byte_size=j.archive_byte_size AND a.expected_sha256=j.archive_sha256
        AND a.state IN('verified','cleaned'))))
      AND (SELECT count(*) FROM system_recovery_metadata_chunks WHERE job_id=? AND substr(name,1,?)=?)=?
    THEN 1 ELSE json('Original planned source all-close lineage or inventory changed') END`)
    .bind(job.id,job.kind,job.actor,job.accepted_at,job.generation,cleanupAdvance?job.generation+1:job.generation,job.phase,job.checkpoint_json,installationId,finalGeneration,job.id,PREFIX.length,PREFIX,records.length),
    ...exactClosedRecordGuards(database,job.id,records),...(retired?.guards??[])],after:D1PreparedStatement[]=[];
  if(release&&!retired){
    const window=originalWindowTuple(job);ensure(window.sourceInstallationId===installationId&&window.generation===release.expectedGeneration
      &&/^[A-Za-z0-9-]{1,128}$/.test(release.requestId)&&release.actor.length>0&&release.actor.length<=320,"planned_original_retirement_window");
    const retirement:OriginalRetirement={schema:"worker-v5-planned-original-retirement/1",jobId:job.id,jobKind:backup?"backup":"recovery",actor:job.actor,acceptedAt:job.accepted_at,
      sourceInstallationId:installationId,checkpointSha256:await sha256Hex(job.checkpoint_json),windowGeneration:window.generation,windowToken:window.token,
      finalGeneration:job.generation,proofCount:records.length,proofSha256:await sha256Hex(stableJson(records)),releaseRequestId:release.requestId,releaseActor:release.actor};
    const text=stableJson(retirement);ensure(new TextEncoder().encode(text).byteLength<=8192,"planned_retirement_budget");
    before.push(db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_maintenance m JOIN system_recovery_runtime r ON r.singleton=1
      WHERE m.singleton=1 AND m.state='fenced' AND m.generation=? AND m.token=? AND r.installation_id=?
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL))
      AND NOT EXISTS(SELECT 1 FROM system_recovery_metadata_chunks WHERE job_id=? AND name=?)
      THEN 1 ELSE json('Original planned retirement source window changed') END`).bind(window.generation,window.token,installationId,job.id,RETIREMENT_NAME),
      db.prepare("INSERT INTO system_recovery_metadata_chunks(job_id,name,ordinal,chunk) VALUES(?,?,0,?)").bind(job.id,RETIREMENT_NAME,text));
    after.push(db.prepare(`SELECT CASE WHEN
      (SELECT count(*) FROM system_recovery_metadata_chunks WHERE job_id=? AND name=?)=1
      AND EXISTS(SELECT 1 FROM system_recovery_metadata_chunks WHERE job_id=? AND name=? AND ordinal=0 AND chunk=?)
      AND EXISTS(SELECT 1 FROM system_recovery_maintenance_requests receipt WHERE receipt.request_id=? AND receipt.actor=?
        AND receipt.action='release' AND receipt.expected_generation=? AND ${RELEASE_RECEIPT_SQL})
      AND EXISTS(SELECT 1 FROM system_recovery_maintenance WHERE singleton=1 AND state='open' AND generation=? AND token IS NULL
        AND checkpoint_sha256 IS NULL AND backup_job_id IS NULL)
      THEN 1 ELSE json('Original planned retirement release did not commit') END`)
      .bind(job.id,RETIREMENT_NAME,job.id,RETIREMENT_NAME,text,release.requestId,release.actor,window.generation,window.generation+1));
  }
  ensure(env.DB===database&&before.length+after.length+3<=128,"planned_original_release_plan_budget");return {before,after};
}
export async function workerV5PlannedOriginalCloseReleaseGuards(env:Env,job:RecoveryJob,installationId:string):Promise<D1PreparedStatement[]>{
  return (await plannedOriginalCloseReleasePlan(env,job,installationId,false)).before;
}
export async function workerV5PlannedBackupOriginalCloseReleaseGuards(env:Env,job:RecoveryJob,installationId:string):Promise<D1PreparedStatement[]>{
  return (await plannedOriginalCloseReleasePlan(env,job,installationId,true)).before;
}
export function workerV5PlannedOwnerReleaseStatements(env:Env,job:RecoveryJob,installationId:string,release:OriginalPlannedRelease){
  return plannedOriginalCloseReleasePlan(env,job,installationId,job.kind==="backup",release);
}
export async function workerV5PlannedOwnerRetiredCleanupGuards(env:Env,job:RecoveryJob,installationId:string):Promise<D1PreparedStatement[]>{
  return (await plannedOriginalCloseReleasePlan(env,job,installationId,job.kind==="backup",undefined,true,true)).before;
}
