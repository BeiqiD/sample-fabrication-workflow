import type { Env } from "../types";
import { primaryD1 } from "../d1-primary";
import { stableJson, sha256Hex } from "../../shared/domain/content-addressing";
import type { SystemBackupRecordsV5, SystemBackupManifestV5 } from "../../shared/contracts/system-backup-v5";
import type { RecoveryClaim, RecoveryJob } from "./repository";
import { SystemRecoveryRepository } from "./repository";
import { canAdministerSystemSettings } from "../storage/system-administrator";
import { allowedEmail } from "../auth";
import { workerV5PlannedOriginalCloseReleaseGuards, workerV5PlannedBackupOriginalCloseReleaseGuards, workerV5PlannedOwnerReleaseStatements, workerV5PlannedOwnerRetiredCleanupGuards } from "./v5-source-close-owner";

const NAME="v5-planned-source-window/1",SCHEMA="worker-v5-planned-source-window/1",BACKUP_NAME="v5-planned-backup-window/1",MAX_JOBS=32;
interface PlannedBackupWindow { readonly schema:"worker-v5-planned-backup-window/1";readonly sourceInstallationId:string;
  readonly maintenanceGeneration:number;readonly maintenanceToken:string;readonly backupId:string }
const backupCaptures=new WeakMap<PlannedBackupWindow,{env:Env;database:D1Database;actor:string}>();
function backupDecode(text:string):PlannedBackupWindow {
  ensure(new TextEncoder().encode(text).byteLength<=8192,"backup_window_budget");const parsed:unknown=JSON.parse(text);
  ensure(parsed&&typeof parsed==="object"&&!Array.isArray(parsed),"backup_window_shape");const row=parsed as Record<string,unknown>;
  ensure(Object.keys(row).sort().join(",")==="backupId,maintenanceGeneration,maintenanceToken,schema,sourceInstallationId"
    &&row.schema==="worker-v5-planned-backup-window/1"&&typeof row.sourceInstallationId==="string"&&/^[a-f0-9]{32}$/.test(row.sourceInstallationId)
    &&typeof row.maintenanceGeneration==="number"&&Number.isSafeInteger(row.maintenanceGeneration)&&row.maintenanceGeneration>0
    &&typeof row.maintenanceToken==="string"&&/^[A-Za-z0-9-]{1,128}$/.test(row.maintenanceToken)
    &&typeof row.backupId==="string"&&/^[A-Za-z0-9-]{1,128}$/.test(row.backupId),"backup_window_shape");
  return Object.freeze({schema:"worker-v5-planned-backup-window/1",sourceInstallationId:row.sourceInstallationId,
    maintenanceGeneration:row.maintenanceGeneration,maintenanceToken:row.maintenanceToken,backupId:row.backupId});
}
export async function captureWorkerV5PlannedBackupWindow(env:Env,actor:string,backupId:string):Promise<PlannedBackupWindow>{
  const database=env.DB,row=await primaryD1(database).prepare(`SELECT m.generation,m.token,r.installation_id
    FROM system_recovery_maintenance m JOIN system_recovery_runtime r ON r.singleton=1
    WHERE m.singleton=1 AND m.state='fenced' AND m.backup_job_id IS NULL AND m.checkpoint_sha256 IS NULL
      AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)`)
    .first<{generation:number;token:string;installation_id:string}>();
  ensure(row&&env.DB===database,"backup_original_window");
  const window=backupDecode(stableJson({schema:"worker-v5-planned-backup-window/1",sourceInstallationId:row.installation_id,
    maintenanceGeneration:row.generation,maintenanceToken:row.token,backupId}));
  backupCaptures.set(window,{env,database,actor});return window;
}
export function workerV5PlannedBackupAcceptanceStatements(env:Env,window:PlannedBackupWindow):D1PreparedStatement[]{
  const owner=backupCaptures.get(window);ensure(owner&&owner.env===env&&owner.database===env.DB,"unissued_backup_window");
  const db=primaryD1(owner.database),text=stableJson(window);
  return [db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_maintenance m JOIN system_recovery_runtime r ON r.singleton=1
    JOIN system_recovery_jobs j ON j.id=? AND j.kind='backup' AND j.state='queued' AND j.generation=0 AND j.actor=?
    WHERE m.singleton=1 AND m.state='fenced' AND m.generation=? AND m.token=? AND r.installation_id=?
      AND m.backup_job_id IS NULL AND m.checkpoint_sha256 IS NULL AND json_valid(j.input_json) AND json_extract(j.input_json,'$.mode')='planned'
      AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL))
    THEN 1 ELSE json('Original planned backup admission window changed') END`)
    .bind(window.backupId,owner.actor,window.maintenanceGeneration,window.maintenanceToken,window.sourceInstallationId),
    db.prepare("INSERT INTO system_recovery_metadata_chunks(job_id,name,ordinal,chunk) VALUES(?,?,0,?)").bind(window.backupId,BACKUP_NAME,text)];
}
/** The actual new planned backup cannot write its final checkpoint into a
 * later released/reentered window after native capture awaits. */
export async function recordWorkerV5PlannedSourceCheckpoint(env:Env,claim:RecoveryClaim,checkpoint:string,signal:AbortSignal,deadlineAt:string){
  const database=env.DB,db=primaryD1(database),row=await db.prepare("SELECT chunk FROM system_recovery_metadata_chunks WHERE job_id=? AND name=? AND ordinal=0")
    .bind(claim.id,BACKUP_NAME).first<{chunk:string}>();
  ensure(row&&/^[a-f0-9]{64}$/.test(checkpoint),"missing_backup_checkpoint_owner");const window=backupDecode(row.chunk),text=stableJson(window);
  ensure(row.chunk===text&&window.backupId===claim.id,"backup_checkpoint_owner");
  ensure(env.DB===database&&!signal.aborted&&Number.isFinite(Date.parse(deadlineAt))&&Date.now()<Date.parse(deadlineAt)
    &&canAdministerSystemSettings(env,claim.actor)&&Boolean(env.ACCESS_TEAM_DOMAIN&&env.ACCESS_AUD)&&allowedEmail(claim.actor,env.ALLOWED_EMAILS),"backup_checkpoint_current");
  await db.batch([db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_jobs j JOIN system_recovery_runtime r ON r.singleton=1 AND r.enabled=1 AND r.incarnation=j.runtime_incarnation
    JOIN system_recovery_metadata_chunks c ON c.job_id=j.id AND c.name=? AND c.ordinal=0 AND c.chunk=?
    WHERE j.id=? AND j.kind='backup' AND j.actor=? AND j.state='running' AND j.phase='snapshot' AND j.generation=? AND j.owner_token=?
      AND j.runtime_incarnation=? AND j.lease_expires_at=? AND julianday(j.lease_expires_at)>julianday('now') AND julianday(?)>julianday('now')
      AND r.installation_id=?) THEN 1 ELSE json('Original planned backup checkpoint claim changed') END`)
    .bind(BACKUP_NAME,text,claim.id,claim.actor,claim.generation,claim.owner_token,claim.runtime_incarnation,claim.lease_expires_at,deadlineAt,window.sourceInstallationId),
    db.prepare(`UPDATE system_recovery_maintenance SET backup_job_id=?,checkpoint_sha256=?,updated_at=?
      WHERE singleton=1 AND state='fenced' AND generation=? AND token=? AND (backup_job_id IS NULL OR backup_job_id=?)
        AND (checkpoint_sha256 IS NULL OR checkpoint_sha256=?) AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)`)
      .bind(claim.id,checkpoint,new Date().toISOString(),window.maintenanceGeneration,window.maintenanceToken,claim.id,checkpoint),
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_maintenance WHERE singleton=1 AND state='fenced' AND generation=? AND token=?
      AND backup_job_id=? AND checkpoint_sha256=?) AND julianday(?)>julianday('now') THEN 1 ELSE json('Original planned backup checkpoint publication changed') END`)
      .bind(window.maintenanceGeneration,window.maintenanceToken,claim.id,checkpoint,deadlineAt)]);
}
export interface WorkerV5PlannedSourceWindow {
  readonly schema:"worker-v5-planned-source-window/1";
  /** Actual original runtime owner, independently generated for this D1. */
  readonly sourceInstallationId:string;
  /** Preserved research provenance identity of the native archive documents. */
  readonly archiveSourceInstallationId:string;
  readonly maintenanceGeneration:number;
  readonly maintenanceToken:string;
  readonly checkpoint:string;
  readonly backupId:string;
  readonly backupGeneration:number;
  readonly backupActor:string;
  readonly backupAcceptedAt:string;
  readonly archiveSha256:string;
  readonly archiveByteSize:number;
  readonly uploadId:string;
  readonly uploadAcceptedAt:string;
}
const KEYS=["schema","sourceInstallationId","archiveSourceInstallationId","maintenanceGeneration","maintenanceToken","checkpoint","backupId","backupGeneration",
  "backupActor","backupAcceptedAt","archiveSha256","archiveByteSize","uploadId","uploadAcceptedAt"];
const claimedWindows=new WeakMap<RecoveryClaim,{env:Env;database:D1Database;window:WorkerV5PlannedSourceWindow}>();
const admitted=new WeakMap<WorkerV5PlannedSourceWindow,{env:Env;database:D1Database;actor:string;upload:RecoveryJob;backupCloseGuards:readonly D1PreparedStatement[]}>();
function ensure(value:unknown,reason:string):asserts value {if(!value)throw new Error("worker_v5_planned_source_"+reason);}
const iso=(value:string)=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
/** Closed installation-local input. Imported archive fields alone issue none
 * of the maintenance/job authority checked by the original source SQL. */
function decode(text:string):WorkerV5PlannedSourceWindow {
  ensure(new TextEncoder().encode(text).byteLength<=8192,"window_budget");const parsed:unknown=JSON.parse(text);
  ensure(parsed&&typeof parsed==="object"&&!Array.isArray(parsed),"window_shape");const row=parsed as Record<string,unknown>;
  ensure(Object.keys(row).sort().join(",")===KEYS.slice().sort().join(",")&&row.schema===SCHEMA
    &&typeof row.sourceInstallationId==="string"&&/^[a-f0-9]{32}$/.test(row.sourceInstallationId)
    &&typeof row.archiveSourceInstallationId==="string"&&row.archiveSourceInstallationId.length>0&&row.archiveSourceInstallationId.length<=128&&!row.archiveSourceInstallationId.includes("\0")
    &&typeof row.maintenanceGeneration==="number"&&Number.isSafeInteger(row.maintenanceGeneration)&&row.maintenanceGeneration>0
    &&typeof row.maintenanceToken==="string"&&/^[A-Za-z0-9-]{1,128}$/.test(row.maintenanceToken)
    &&typeof row.checkpoint==="string"&&/^[a-f0-9]{64}$/.test(row.checkpoint)
    &&typeof row.backupId==="string"&&/^[A-Za-z0-9-]{1,128}$/.test(row.backupId)
    &&typeof row.backupGeneration==="number"&&Number.isSafeInteger(row.backupGeneration)&&row.backupGeneration>0
    &&typeof row.backupActor==="string"&&row.backupActor.length>0&&row.backupActor.length<=320
    &&typeof row.backupAcceptedAt==="string"&&iso(row.backupAcceptedAt)
    &&typeof row.archiveSha256==="string"&&/^[a-f0-9]{64}$/.test(row.archiveSha256)
    &&typeof row.archiveByteSize==="number"&&Number.isSafeInteger(row.archiveByteSize)&&row.archiveByteSize>0&&row.archiveByteSize<=104857600
    &&typeof row.uploadId==="string"&&/^[A-Za-z0-9-]{1,128}$/.test(row.uploadId)
    &&typeof row.uploadAcceptedAt==="string"&&iso(row.uploadAcceptedAt),"window_shape");
  // Decode only the exact reviewed fields; SQL below must still re-admit it.
  return Object.freeze({schema:SCHEMA,sourceInstallationId:row.sourceInstallationId,archiveSourceInstallationId:row.archiveSourceInstallationId,maintenanceGeneration:row.maintenanceGeneration,
    maintenanceToken:row.maintenanceToken,checkpoint:row.checkpoint,backupId:row.backupId,backupGeneration:row.backupGeneration,
    backupActor:row.backupActor,backupAcceptedAt:row.backupAcceptedAt,archiveSha256:row.archiveSha256,archiveByteSize:row.archiveByteSize,
    uploadId:row.uploadId,uploadAcceptedAt:row.uploadAcceptedAt});
}
function windowGuard(env:Env,window:WorkerV5PlannedSourceWindow):D1PreparedStatement {
  const backupReservation=stableJson({schema:"worker-v5-planned-backup-window/1",sourceInstallationId:window.sourceInstallationId,
    maintenanceGeneration:window.maintenanceGeneration,maintenanceToken:window.maintenanceToken,backupId:window.backupId});
  return primaryD1(env.DB).prepare(`SELECT CASE WHEN EXISTS(
    SELECT 1 FROM system_recovery_maintenance m JOIN system_recovery_runtime r ON r.singleton=1
      JOIN system_recovery_jobs b ON b.id=m.backup_job_id JOIN system_recovery_jobs u ON u.id=?
      JOIN research_package_source_identity provenance ON provenance.singleton=1 AND provenance.installation_id=?
      JOIN system_recovery_metadata_chunks original ON original.job_id=b.id AND original.name='v5-planned-backup-window/1' AND original.ordinal=0 AND original.chunk=?
    WHERE m.singleton=1 AND m.state='fenced' AND m.generation=? AND m.token=? AND m.checkpoint_sha256=? AND m.backup_job_id=?
      AND r.installation_id=? AND b.kind='backup' AND b.state='completed' AND b.generation=? AND b.actor=? AND b.accepted_at=?
      AND b.source_checkpoint=? AND b.archive_sha256=? AND b.archive_byte_size=? AND b.artifact_key IS NOT NULL
      AND u.kind='upload' AND u.state='preview' AND u.actor=b.actor AND u.accepted_at=?
      AND u.archive_sha256=b.archive_sha256 AND u.archive_byte_size=b.archive_byte_size AND u.artifact_key IS NOT NULL
      AND json_valid(b.input_json) AND json_extract(b.input_json,'$.mode')='planned'
      AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL))
    THEN 1 ELSE json('Original V5 planned source maintenance window changed') END`)
    .bind(window.uploadId,window.archiveSourceInstallationId,backupReservation,window.maintenanceGeneration,window.maintenanceToken,window.checkpoint,window.backupId,
      window.sourceInstallationId,window.backupGeneration,window.backupActor,window.backupAcceptedAt,window.checkpoint,
      window.archiveSha256,window.archiveByteSize,window.uploadAcceptedAt);
}
/** Real public acceptance capture; same installation native rows and original
 * backup/upload archive hash and documents must match before freezing. */
export async function captureWorkerV5PlannedSourceWindow(env:Env,actor:string,upload:RecoveryJob,
  records:SystemBackupRecordsV5,manifest:SystemBackupManifestV5):Promise<WorkerV5PlannedSourceWindow>{
  const database=env.DB,repository=new SystemRecoveryRepository(database),db=repository.db();
  ensure(upload.actor===actor&&upload.kind==="upload"&&upload.state==="preview"&&records.backupId===manifest.backupId
    &&records.createdAt===manifest.createdAt&&records.origin.format==="native"&&records.origin.schemaVersion===28
    &&records.origin.capturePolicy==="atomic-primary-with-byte-holds/1","original_native_backup");
  const rows=await db.batch<Record<string,unknown>>([db.prepare("SELECT generation,token,checkpoint_sha256,backup_job_id FROM system_recovery_maintenance WHERE singleton=1 AND state='fenced'"),
    db.prepare("SELECT installation_id FROM system_recovery_runtime WHERE singleton=1"),
    db.prepare("SELECT * FROM system_recovery_jobs WHERE id=? AND kind='backup' AND state='completed'").bind(records.backupId),
    db.prepare("SELECT installation_id FROM research_package_source_identity WHERE singleton=1")]);
  ensure(rows.length===4&&rows.every(row=>row.success&&row.results.length===1),"original_window_rows");
  const m=rows[0]!.results[0]!,r=rows[1]!.results[0]!,b=rows[2]!.results[0]!;
  const window=decode(stableJson({schema:SCHEMA,sourceInstallationId:r.installation_id,archiveSourceInstallationId:rows[3]!.results[0]!.installation_id,maintenanceGeneration:m.generation,maintenanceToken:m.token,
    checkpoint:m.checkpoint_sha256,backupId:b.id,backupGeneration:b.generation,backupActor:b.actor,backupAcceptedAt:b.accepted_at,
    archiveSha256:b.archive_sha256,archiveByteSize:b.archive_byte_size,uploadId:upload.id,uploadAcceptedAt:upload.accepted_at}));
  ensure(window.archiveSourceInstallationId===manifest.sourceInstallationId&&window.archiveSourceInstallationId===records.content.tables.research_package_source_identity[0]?.installation_id&&window.backupActor===actor&&window.backupId===records.backupId
    &&window.backupAcceptedAt===records.createdAt&&window.checkpoint===manifest.sourceCheckpoint
    &&window.archiveSha256===upload.archive_sha256&&window.archiveByteSize===upload.archive_byte_size,"original_window_documents");
  const originalRecords=await repository.metadata(window.backupId,"records"),originalManifest=await repository.metadata(window.backupId,"manifest");
  ensure(stableJson(originalRecords)===stableJson(records)&&stableJson(originalManifest)===stableJson(manifest)&&env.DB===database,"original_backup_documents");
  const originalBackup=await repository.job(window.backupId);ensure(originalBackup,"original_backup_job");
  const backupCloseGuards=await workerV5PlannedBackupOriginalCloseReleaseGuards(env,originalBackup,window.sourceInstallationId);
  await db.batch([windowGuard(env,window),...backupCloseGuards]);
  ensure(env.DB===database,"original_source_binding");
  admitted.set(window,{env,database,actor,upload,backupCloseGuards});return window;
}
/** Preview is read-only but a planned invocation still consumes the exact
 * original capture, never a caller-provided source maintenance descriptor. */
export async function assertWorkerV5PlannedPreviewWindow(env:Env,window:WorkerV5PlannedSourceWindow,
  records:SystemBackupRecordsV5,manifest:SystemBackupManifestV5){
  const original=admitted.get(window);ensure(original&&original.env===env&&original.database===env.DB
    &&window.backupId===records.backupId&&window.backupAcceptedAt===records.createdAt
    &&window.archiveSourceInstallationId===manifest.sourceInstallationId&&window.archiveSourceInstallationId===records.content.tables.research_package_source_identity[0]?.installation_id&&window.checkpoint===manifest.sourceCheckpoint,"unissued_preview_window");
  await windowGuard(env,window).first();ensure(env.DB===original.database&&canAdministerSystemSettings(env,original.actor)
    &&Boolean(env.ACCESS_TEAM_DOMAIN&&env.ACCESS_AUD)&&allowedEmail(original.actor,env.ALLOWED_EMAILS),"original_preview_binding_or_actor");
}
/** Append to ORIGINAL repository.accept's native batch after original job
 * INSERT. The exact reservation and checkpoint commit with its request ID. */
export function workerV5PlannedSourceAcceptanceStatements(env:Env,jobId:string,window:WorkerV5PlannedSourceWindow):D1PreparedStatement[]{
  const original=admitted.get(window);ensure(original&&original.env===env&&original.database===env.DB,"unissued_window");
  const db=primaryD1(original.database),text=stableJson(window);
  return [windowGuard(env,window),...original.backupCloseGuards,db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_jobs
    WHERE id=? AND kind='recovery' AND actor=? AND source_upload_job_id=? AND checkpoint_json=?
      AND state='queued' AND generation=0 AND json_valid(input_json) AND json_extract(input_json,'$.mode')='planned')
    THEN 1 ELSE json('Original planned recovery acceptance changed') END`).bind(jobId,original.actor,original.upload.id,text),
    db.prepare("INSERT INTO system_recovery_metadata_chunks(job_id,name,ordinal,chunk) VALUES(?,?,0,?)").bind(jobId,NAME,text)];
}
/** This reads the original durable Recovery job rather than caller-supplied
 * maintenance DTOs. Same window bytes must survive every claimed stage. */
export async function assertWorkerV5PlannedSourceWindowCurrent(env:Env,claim:RecoveryClaim,
  records:SystemBackupRecordsV5,manifest:SystemBackupManifestV5):Promise<WorkerV5PlannedSourceWindow>{
  ensure(claim.kind==="recovery"&&typeof claim.checkpoint_json==="string","missing_original_window");
  const database=env.DB,window=decode(claim.checkpoint_json),text=stableJson(window),db=primaryD1(database);
  ensure(claim.checkpoint_json===text&&window.backupActor===claim.actor&&window.uploadId===claim.source_upload_job_id
    &&window.backupId===records.backupId&&window.backupAcceptedAt===records.createdAt
    &&window.archiveSourceInstallationId===manifest.sourceInstallationId&&window.archiveSourceInstallationId===records.content.tables.research_package_source_identity[0]?.installation_id&&window.checkpoint===manifest.sourceCheckpoint,"original_window_lineage");
  await db.batch([windowGuard(env,window),db.prepare(`SELECT CASE WHEN EXISTS(
    SELECT 1 FROM system_recovery_jobs j JOIN system_recovery_runtime r ON r.singleton=1 AND r.enabled=1 AND r.incarnation=j.runtime_incarnation
    JOIN system_recovery_metadata_chunks c ON c.job_id=j.id AND c.name=? AND c.ordinal=0 AND c.chunk=j.checkpoint_json
    WHERE j.id=? AND j.kind='recovery' AND j.actor=? AND j.accepted_at=? AND j.state='running' AND j.owner_token=? AND j.generation=?
      AND j.runtime_incarnation=? AND j.lease_expires_at=? AND julianday(j.lease_expires_at)>julianday('now')
      AND j.checkpoint_json=? AND j.source_upload_job_id=?
      AND (SELECT count(*) FROM system_recovery_metadata_chunks original WHERE original.job_id=j.id AND original.name='v5-planned-source-window/1')=1
      AND json_valid(j.input_json) AND json_extract(j.input_json,'$.mode')='planned')
    THEN 1 ELSE json('Original planned recovery claim or reservation changed') END`)
    .bind(NAME,claim.id,claim.actor,claim.accepted_at,claim.owner_token,claim.generation,claim.runtime_incarnation,claim.lease_expires_at,text,window.uploadId)]);
  ensure(env.DB===database,"original_source_binding");
  const previous=claimedWindows.get(claim);ensure(!previous||previous.env===env&&previous.database===database
    &&stableJson(previous.window)===text,"original_claim_window_binding");
  claimedWindows.set(claim,{env,database,window});return window;
}
/** The Source commit repeats the actual privately captured original window,
 * claim and immutable kernel clock in SAME repository.finish native batch.
 * Target ACK or repository-only current() cannot replace this source guard. */
export function workerV5PlannedSourceFinishGuards(env:Env,claim:RecoveryClaim,signal:AbortSignal,deadlineAt:string):D1PreparedStatement[]{
  const original=claimedWindows.get(claim);ensure(original&&original.env===env&&original.database===env.DB
    &&!signal.aborted&&iso(deadlineAt)&&Date.now()<Date.parse(deadlineAt)
    &&canAdministerSystemSettings(env,claim.actor)&&Boolean(env.ACCESS_TEAM_DOMAIN&&env.ACCESS_AUD)
    &&allowedEmail(claim.actor,env.ALLOWED_EMAILS),"original_finish_binding_or_deadline");
  const db=primaryD1(original.database),window=original.window,text=stableJson(window);
  return [windowGuard(env,window),db.prepare(`SELECT CASE WHEN EXISTS(
    SELECT 1 FROM system_recovery_jobs j JOIN system_recovery_runtime r ON r.singleton=1 AND r.enabled=1 AND r.incarnation=j.runtime_incarnation
    JOIN system_recovery_metadata_chunks reservation ON reservation.job_id=j.id AND reservation.name=? AND reservation.ordinal=0 AND reservation.chunk=j.checkpoint_json
    WHERE j.id=? AND j.kind='recovery' AND j.actor=? AND j.accepted_at=? AND j.phase=? AND j.state='running'
      AND j.generation=? AND j.owner_token=? AND j.runtime_incarnation=? AND j.lease_expires_at=?
      AND julianday(j.lease_expires_at)>julianday('now') AND julianday(?)>julianday('now')
      AND j.checkpoint_json=? AND j.source_upload_job_id=? AND j.target_id IS ? AND j.target_incarnation IS ?
      AND (SELECT count(*) FROM system_recovery_metadata_chunks c WHERE c.job_id=j.id AND c.name='v5-planned-source-window/1')=1
      AND json_valid(j.input_json) AND json_extract(j.input_json,'$.mode')='planned')
    THEN 1 ELSE json('Original planned Source finish window or claim changed') END`)
    .bind(NAME,claim.id,claim.actor,claim.accepted_at,claim.phase,claim.generation,claim.owner_token,claim.runtime_incarnation,
      claim.lease_expires_at,deadlineAt,text,window.uploadId,claim.target_id,claim.target_incarnation)];
}
/** Source and target are separate native D1s. Release therefore keeps the
 * original source window fixed until every accepted planned operation is
 * terminal with durable original ALL-close ACKs. Expiry is never a grant. */
async function originalV28Source(env:Env):Promise<boolean>{
  const database=env.DB,db=primaryD1(database);
  const present=await db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='collaboration_control'").first();
  ensure(env.DB===database,"source_classification_binding");if(!present)return false;
  ensure(await db.prepare("SELECT 1 FROM collaboration_control WHERE singleton=1 AND schema_version=2").first()
    &&env.DB===database,"current_native_v28_source");return true;
}
const V28_SOURCE_GUARD_SQL="SELECT CASE WHEN EXISTS(SELECT 1 FROM collaboration_control WHERE singleton=1 AND schema_version=2) THEN 1 ELSE json('Original native V28 source changed') END";
interface OriginalRelease { requestId:string;actor:string;expectedGeneration:number }
interface OriginalReleaseStatements { before:D1PreparedStatement[];after:D1PreparedStatement[] }
// Actual accepted job/input/checkpoint select obligations. A reservation is a
// required matching record, never the authority which selects its own owner.
const RECOVERY_SELECTION=`j.kind='recovery' AND (NOT json_valid(j.input_json) OR json_extract(j.input_json,'$.mode')='planned'
  OR (json_valid(j.checkpoint_json) AND json_extract(j.checkpoint_json,'$.schema')='worker-v5-planned-source-window/1')
  OR EXISTS(SELECT 1 FROM system_recovery_metadata_chunks c WHERE c.job_id=j.id AND c.name IN('v5-planned-source-window/1','v5-planned-original-retirement/1')))`;
const BACKUP_SELECTION=`j.kind='backup' AND (NOT json_valid(j.input_json) OR json_extract(j.input_json,'$.mode')='planned'
  OR (json_valid(j.checkpoint_json) AND json_extract(j.checkpoint_json,'$.plannedSourceWindow.schema')='worker-v5-planned-backup-window/1')
  OR EXISTS(SELECT 1 FROM system_recovery_metadata_chunks c WHERE c.job_id=j.id AND c.name IN('v5-planned-backup-window/1','v5-planned-original-retirement/1')))`;
async function originalPlannedCustodyStatements(env:Env,release?:OriginalRelease,cleanupJobId?:string):Promise<OriginalReleaseStatements>{
  const database=env.DB;if(!await originalV28Source(env))return {before:[],after:[]};
  const db=primaryD1(database),selection=RECOVERY_SELECTION+(cleanupJobId===undefined?"":" AND j.id<>?"),bindings=cleanupJobId===undefined?[]:[cleanupJobId];
  const rows=await db.prepare(`SELECT j.* FROM system_recovery_jobs j WHERE ${selection} ORDER BY j.id LIMIT ?`)
    .bind(...bindings,MAX_JOBS+1).all<RecoveryJob>();
  ensure(rows.success&&rows.results.length<=MAX_JOBS,"release_original_job_budget");
  const before:D1PreparedStatement[]=[db.prepare(V28_SOURCE_GUARD_SQL),db.prepare(`SELECT CASE WHEN
    (SELECT count(*) FROM system_recovery_jobs j WHERE ${selection})=?
    THEN 1 ELSE json('Original planned recovery obligation inventory changed') END`).bind(...bindings,rows.results.length)],after:D1PreparedStatement[]=[];
  for(const job of rows.results){
    ensure(job.state==="completed"&&job.phase==="ready"&&job.owner_token===null&&job.runtime_incarnation===null&&job.lease_expires_at===null
      &&typeof job.checkpoint_json==="string"&&JSON.parse(job.input_json).mode==="planned","original_planned_owner_unsettled");
    const window=decode(job.checkpoint_json),text=stableJson(window),inputSha256=await sha256Hex(stableJson(JSON.parse(job.input_json)));
    ensure(text===job.checkpoint_json&&window.backupActor===job.actor&&window.uploadId===job.source_upload_job_id,"release_original_window");
    before.push(db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_jobs j
      JOIN system_recovery_metadata_chunks c ON c.job_id=j.id AND c.name=? AND c.ordinal=0 AND c.chunk=j.checkpoint_json
      JOIN system_recovery_requests request ON request.job_id=j.id AND request.actor=j.actor AND request.request_id=j.request_id AND request.input_sha256=?
      WHERE j.id=? AND j.kind='recovery' AND j.actor=? AND j.accepted_at=? AND j.generation=? AND j.state='completed' AND j.phase='ready'
        AND j.owner_token IS NULL AND j.runtime_incarnation IS NULL AND j.lease_expires_at IS NULL AND j.checkpoint_json=? AND j.input_json=?
        AND j.source_upload_job_id=? AND j.target_id IS ? AND j.target_incarnation IS ?
        AND (SELECT count(*) FROM system_recovery_metadata_chunks reservation WHERE reservation.job_id=j.id AND reservation.name='v5-planned-source-window/1')=1
        AND NOT EXISTS(SELECT 1 FROM system_recovery_attempts a WHERE a.job_id=j.id AND a.state IN('started','unknown','settled')))
      THEN 1 ELSE json('Original planned recovery reservation or full-close custody changed') END`)
      .bind(NAME,inputSha256,job.id,job.actor,job.accepted_at,job.generation,text,job.input_json,job.source_upload_job_id,job.target_id,job.target_incarnation));
    if(release){const plan=await workerV5PlannedOwnerReleaseStatements(env,job,window.sourceInstallationId,release);before.push(...plan.before);after.push(...plan.after);}
    else before.push(...await workerV5PlannedOriginalCloseReleaseGuards(env,job,window.sourceInstallationId));
    ensure(before.length+after.length+3<=128,"release_original_statement_budget");
  }
  ensure(env.DB===database,"release_original_source_binding");return {before,after};
}
export async function workerV5PlannedSourceReleaseStatements(env:Env,release:OriginalRelease):Promise<OriginalReleaseStatements>{
  const database=env.DB;if(!await originalV28Source(env))return {before:[],after:[]};
  const db=primaryD1(database),rows=await db.prepare(`SELECT j.* FROM system_recovery_jobs j WHERE ${BACKUP_SELECTION} ORDER BY j.id LIMIT ?`)
    .bind(MAX_JOBS+1).all<RecoveryJob>();
  ensure(rows.success&&rows.results.length<=MAX_JOBS,"backup_release_inventory_budget");
  const before=[db.prepare(V28_SOURCE_GUARD_SQL),db.prepare(`SELECT CASE WHEN (SELECT count(*) FROM system_recovery_jobs j WHERE ${BACKUP_SELECTION})=?
    THEN 1 ELSE json('Original planned backup obligation inventory changed') END`).bind(rows.results.length)],after:D1PreparedStatement[]=[];
  for(const job of rows.results){
    ensure(job.checkpoint_json&&JSON.parse(job.input_json).mode==="planned","original_backup_window_checkpoint");const checkpoint:unknown=JSON.parse(job.checkpoint_json);
    ensure(checkpoint&&typeof checkpoint==="object"&&!Array.isArray(checkpoint),"original_backup_window_checkpoint");
    const window=backupDecode(stableJson((checkpoint as Record<string,unknown>).plannedSourceWindow)),text=stableJson(window),inputSha256=await sha256Hex(stableJson(JSON.parse(job.input_json)));
    ensure(window.backupId===job.id,"original_backup_window_lineage");
    before.push(db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_jobs j
      JOIN system_recovery_requests request ON request.job_id=j.id AND request.actor=j.actor AND request.request_id=j.request_id AND request.input_sha256=?
      WHERE j.id=? AND j.checkpoint_json=? AND j.input_json=?
        AND (SELECT count(*) FROM system_recovery_metadata_chunks WHERE job_id=j.id AND name=?)=1
        AND EXISTS(SELECT 1 FROM system_recovery_metadata_chunks WHERE job_id=j.id AND name=? AND ordinal=0 AND chunk=?))
      THEN 1 ELSE json('Original planned backup reservation changed') END`).bind(inputSha256,job.id,job.checkpoint_json,job.input_json,BACKUP_NAME,BACKUP_NAME,text));
    const plan=await workerV5PlannedOwnerReleaseStatements(env,job,window.sourceInstallationId,release);before.push(...plan.before);after.push(...plan.after);
    ensure(before.length+after.length+3<=128,"original_backup_release_guard_budget");
  }
  const recovery=await originalPlannedCustodyStatements(env,release);before.push(...recovery.before);after.push(...recovery.after);
  ensure(env.DB===database&&before.length+after.length+3<=128,"original_full_release_guard_budget");return {before,after};
}
/** Planned completed cleanup can advance a job generation only after the
 * exact original fully closed owner retired with the actual release receipt.
 * All other planned Recovery obligations remain globally visible as well. */
async function originalPlannedCleanupGuards(env:Env,job:RecoveryJob):Promise<D1PreparedStatement[]>{
  const database=env.DB;if(!await originalV28Source(env))return [];
  const input:unknown=JSON.parse(job.input_json);ensure(input&&typeof input==="object"&&!Array.isArray(input),"cleanup_original_input");
  if((input as Record<string,unknown>).mode!=="planned"){
    const checkpoint:unknown=JSON.parse(job.checkpoint_json??"null");
    const protocol=checkpoint&&typeof checkpoint==="object"&&!Array.isArray(checkpoint)
      &&((checkpoint as Record<string,unknown>).schema===SCHEMA||(checkpoint as Record<string,unknown>).plannedSourceWindow!==undefined);
    const reservation=await primaryD1(database).prepare("SELECT 1 FROM system_recovery_metadata_chunks WHERE job_id=? AND name IN(?,?,?) LIMIT 1")
      .bind(job.id,NAME,BACKUP_NAME,"v5-planned-original-retirement/1").first();
    ensure(!protocol&&!reservation&&env.DB===database,"cleanup_original_mode_changed");return [];
  }
  const checkpoint:unknown=JSON.parse(job.checkpoint_json??"null");ensure(checkpoint&&typeof checkpoint==="object"&&!Array.isArray(checkpoint),"cleanup_original_window");
  const outer=checkpoint as Record<string,unknown>,window=job.kind==="backup"?backupDecode(stableJson(outer.plannedSourceWindow)):decode(job.checkpoint_json??"null");
  const guards=await workerV5PlannedOwnerRetiredCleanupGuards(env,job,window.sourceInstallationId);
  const text=stableJson(window),name=job.kind==="backup"?BACKUP_NAME:NAME,inputSha256=await sha256Hex(stableJson(input)),db=primaryD1(database);
  guards.push(db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_jobs j
    JOIN system_recovery_requests request ON request.job_id=j.id AND request.actor=j.actor AND request.request_id=j.request_id AND request.input_sha256=?
    WHERE j.id=? AND j.input_json=? AND j.checkpoint_json=?
      AND (SELECT count(*) FROM system_recovery_metadata_chunks WHERE job_id=j.id AND name=?)=1
      AND EXISTS(SELECT 1 FROM system_recovery_metadata_chunks WHERE job_id=j.id AND name=? AND ordinal=0 AND chunk=?))
    THEN 1 ELSE json('Original planned cleanup reservation changed') END`).bind(inputSha256,job.id,job.input_json,job.checkpoint_json,name,name,text));
  ensure(env.DB===database&&guards.length+3<=128,"original_retired_cleanup_budget");return guards;
}
export async function workerV5PlannedBackupCleanupGuards(env:Env,backupId:string):Promise<D1PreparedStatement[]>{
  const job=await new SystemRecoveryRepository(env.DB).job(backupId);ensure(job&&job.kind==="backup","cleanup_original_backup");
  const guards=await originalPlannedCleanupGuards(env,job),recovery=await originalPlannedCustodyStatements(env);
  guards.push(...recovery.before);ensure(guards.length+3<=128,"original_backup_cleanup_custody_budget");return guards;
}
export async function workerV5PlannedRecoveryCleanupGuards(env:Env,job:RecoveryJob):Promise<D1PreparedStatement[]>{
  if(job.kind!=="recovery")return [];
  const guards=await originalPlannedCleanupGuards(env,job);if(!guards.length)return [];
  const other=await originalPlannedCustodyStatements(env,undefined,job.id);guards.push(...other.before);
  ensure(guards.length+3<=128,"original_recovery_cleanup_custody_budget");return guards;
}
