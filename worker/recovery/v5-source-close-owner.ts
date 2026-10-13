import type { Env } from "../types";
import { primaryD1 } from "../d1-primary";
import { canAdministerSystemSettings } from "../storage/system-administrator";
import { allowedEmail } from "../auth";
import { closeWorkerRecoveryExecutionOwner, ownWorkerRecoveryBodyClose,
  workerRecoveryOriginalInvocationSucceeded } from "../files/jobs/execution-lifetime";
import type { RecoveryClaim, RecoveryJob } from "./repository";
import { assertWorkerV5OriginalSourceStream, type WorkerV5OriginalSourceStream } from "./v5-held-r2-archive-candidate";
import type { SystemBackupRecordsV5 } from "../../shared/contracts/system-backup-v5";
import { sha256Hex, stableJson } from "../../shared/domain/content-addressing";

const PREFIX="v5-original-source-close/1:",MAXIMUM=512,GROUP=40,CLEANUP_GROUP=40;
type Kind="snapshot"|"body"|"put";
interface Intent {
  schema:"worker-v5-original-source-close/1";jobId:string;actor:string;acceptedAt:string;sourceInstallationId:string;
  generation:number;ownerToken:string;runtimeIncarnation:string;leaseExpiresAt:string;phase:string;
  ordinal:number;kind:Kind;resourceSha256:string;registeredAt:string;state:"unproven"|"acknowledged";
  acknowledgedAt:string|null;originalWorkFulfilled:boolean;originalAllCloseAcknowledged:boolean;
}
interface Entry { name:string;initial:string;intent:Intent;nativeAcknowledged:boolean;firstClose?:Promise<void>;close?:()=>Promise<void> }
interface Owner { env:Env;database:D1Database;bucket:R2Bucket;installationId:string;entries:Entry[];ordinal:number;closing?:Promise<void> }
export interface WorkerV5SourceCloseIntent { readonly kind:"worker-v5-original-source-intent/1" }
const owners=new WeakMap<object,Owner>(),issued=new WeakMap<WorkerV5SourceCloseIntent,{owner:Owner;original:object;entry:Entry}>();
function ensure(value:unknown,reason:string):asserts value {if(!value)throw new Error("worker_v5_source_close_"+reason);}
const iso=(value:string)=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
function local(owner:Owner,claim:RecoveryClaim,signal:AbortSignal,deadlineAt:string){
  return owner.env.DB===owner.database&&owner.env.ASSETS===owner.bucket&&!signal.aborted&&iso(deadlineAt)&&Date.now()<Date.parse(deadlineAt)
    &&canAdministerSystemSettings(owner.env,claim.actor)&&Boolean(owner.env.ACCESS_TEAM_DOMAIN&&owner.env.ACCESS_AUD)&&allowedEmail(claim.actor,owner.env.ALLOWED_EMAILS);
}
function claimFence(owner:Owner,claim:RecoveryClaim,deadlineAt:string){
  return primaryD1(owner.database).prepare(`SELECT CASE WHEN EXISTS(
    SELECT 1 FROM system_recovery_jobs j JOIN system_recovery_runtime r ON r.singleton=1 AND r.enabled=1 AND r.incarnation=j.runtime_incarnation
    WHERE j.id=? AND j.actor=? AND j.accepted_at=? AND j.kind='backup' AND j.state='running' AND j.phase=?
      AND j.generation=? AND j.owner_token=? AND j.runtime_incarnation=? AND j.lease_expires_at=? AND r.installation_id=?
      AND julianday(j.lease_expires_at)>julianday('now') AND julianday(?)>julianday('now'))
    THEN 1 ELSE json('Original V5 source intent lease or deadline changed') END`)
    .bind(claim.id,claim.actor,claim.accepted_at,claim.phase,claim.generation,claim.owner_token,claim.runtime_incarnation,claim.lease_expires_at,owner.installationId,deadlineAt);
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
  const owner=owners.get(original);ensure(owner&&!owner.closing&&claim.kind==="backup"&&claim.state==="running","original_owner");
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
  const entry:Entry={name,initial,intent,nativeAcknowledged:false};owner.entries.push(entry);
  const token:WorkerV5SourceCloseIntent=Object.freeze({kind:"worker-v5-original-source-intent/1"});issued.set(token,{owner,original,entry});return token;
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
          AND EXISTS(SELECT 1 FROM system_recovery_jobs j WHERE j.id=system_recovery_metadata_chunks.job_id AND j.kind='backup' AND j.actor=? AND j.accepted_at=? AND j.generation>=?)`)
          .bind(closed[index]!,entry.intent.jobId,entry.name,entry.initial,entry.intent.actor,entry.intent.acceptedAt,entry.intent.generation)),
        ...group.map((entry,index)=>db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_metadata_chunks WHERE job_id=? AND name=? AND ordinal=0 AND chunk=?) THEN 1 ELSE json('Original V5 all-close settlement unavailable') END")
          .bind(entry.intent.jobId,entry.name,closed[index]!))];
      ensure(statements.length<=128&&owner.env.DB===owner.database&&owner.env.ASSETS===owner.bucket,"original_settlement_budget_or_binding");
      await db.batch(statements);
    }
  })();void owner.closing.catch(()=>undefined);return owner.closing;
}

const KEYS=["schema","jobId","actor","acceptedAt","sourceInstallationId","generation","ownerToken","runtimeIncarnation","leaseExpiresAt","phase",
  "ordinal","kind","resourceSha256","registeredAt","state","acknowledgedAt","originalWorkFulfilled","originalAllCloseAcknowledged"];
function closedIntent(chunk:string,job:RecoveryJob,installationId:string,name:string){
  ensure(new TextEncoder().encode(chunk).byteLength<=8192,"closed_record_budget");const value:unknown=JSON.parse(chunk);
  ensure(value&&typeof value==="object"&&!Array.isArray(value),"closed_record");const row=value as Record<string,unknown>;
  ensure(Object.keys(row).sort().join(",")===KEYS.slice().sort().join(",")&&row.schema==="worker-v5-original-source-close/1"
    &&row.jobId===job.id&&row.actor===job.actor&&row.acceptedAt===job.accepted_at&&row.sourceInstallationId===installationId
    &&typeof row.generation==="number"&&Number.isSafeInteger(row.generation)&&row.generation>0&&row.generation<=job.generation
    &&typeof row.ownerToken==="string"&&/^[A-Za-z0-9-]{1,128}$/.test(row.ownerToken)&&typeof row.runtimeIncarnation==="string"&&/^[a-f0-9]{32}$/.test(row.runtimeIncarnation)
    &&typeof row.leaseExpiresAt==="string"&&iso(row.leaseExpiresAt)&&typeof row.phase==="string"&&["snapshot","inventory","measure","write"].includes(row.phase)
    &&typeof row.ordinal==="number"&&Number.isSafeInteger(row.ordinal)&&row.ordinal>=0&&row.ordinal<MAXIMUM
    &&["snapshot","body","put"].includes(String(row.kind))&&typeof row.resourceSha256==="string"&&/^[a-f0-9]{64}$/.test(row.resourceSha256)
    &&typeof row.registeredAt==="string"&&iso(row.registeredAt)&&row.state==="acknowledged"&&typeof row.acknowledgedAt==="string"&&iso(row.acknowledgedAt)
    &&Date.parse(row.acknowledgedAt)>=Date.parse(row.registeredAt)&&row.originalWorkFulfilled===true&&row.originalAllCloseAcknowledged===true
    &&name===PREFIX+row.generation+":"+row.ownerToken+":"+row.ordinal,"unproven_original_source_close");
  return row;
}
interface Hold { id:string;location_id:string;hold_kind:string;operation_id:string;reason:string;acquired_at:string;expires_at:null;released_at:null }
export interface WorkerV5SourceCloseCleanupAdmission { readonly kind:"worker-v5-durable-source-close-cleanup/1" }
interface ClosedRecord { readonly name:string;readonly ordinal:number;readonly chunk:string }
const cleanupAdmissions=new WeakMap<WorkerV5SourceCloseCleanupAdmission,{env:Env;database:D1Database;job:RecoveryJob;installationId:string;records:readonly ClosedRecord[];holds:Hold[]}>();
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
  cleanupAdmissions.set(token,{env,database,job,installationId:runtime.installation_id,records:closedRecords,holds});
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
  // Each page binds at most81 parameters and checks at most40 exact records.
  // No JSON serialization of the frozen chunks or one oversized parameter is
  // needed. All pages must run in the SAME original native transaction as the
  // guarded cleanup mutation, or as one read-only transaction before DELETE.
  for(let offset=0;offset<value.records.length;offset+=CLEANUP_GROUP){
    const group=value.records.slice(offset,offset+CLEANUP_GROUP),bindings:unknown[]=[];
    const expected=group.map(record=>{ensure(record.ordinal===0,"original_closed_ordinal");bindings.push(record.name,record.chunk);
      return "SELECT ? AS name,0 AS ordinal,? AS chunk";}).join(" UNION ALL ");
    statements.push(db.prepare(`SELECT CASE WHEN NOT EXISTS(
      SELECT 1 FROM (${expected}) expected LEFT JOIN system_recovery_metadata_chunks actual
        ON actual.job_id=? AND actual.name=expected.name AND actual.ordinal=expected.ordinal
      WHERE actual.chunk IS NOT expected.chunk)
      THEN 1 ELSE json('Original V5 exact source close record inventory changed') END`).bind(...bindings,job.id));
  }
  ensure(statements.length<=14,"original_cleanup_guard_budget");return statements;
}
