import type { RecoveryClaim } from "./repository";
import { canAdministerSystemSettings } from "../storage/system-administrator";
import { allowedEmail } from "../auth";
// Explicit V28/V5 Cloudflare capture. Historical/default capture stays frozen.
import type { Env } from "../types";
import { primaryD1 } from "../d1-primary";
import { nativeV28SnapshotSql, buildFullExportV28FromSnapshot } from "../export-v28-core";
import { portableBusinessSchemaV28, createFullExportV28 } from "../../shared/contracts/export-portable-runtime-v28";
import type { ExportSchemaObject } from "../../shared/contracts/export";
import { recoveryTableSnapshotSql } from "../../shared/contracts/system-recovery-image";
import { V5_RECOVERY_CATALOG_CANDIDATE as catalog } from "./v5-catalog-candidate";
import { inspectV28CloudflareSchemaCandidate } from "./v28-cloudflare-schema-candidate";
import { installPortableSystemBackupHolds } from "./portable-backup-holds";
import { inspectRecoveryMigrationLedger } from "./target-migrations";
import { SYSTEM_BACKUP_MAX_RECORDS_BYTES } from "../../shared/contracts/system-backup";
import { validateSystemRecoveryImageV5, protectedLocalHistoryFromV5Image, validateSystemBackupRecordsV5,
  validateCloudflareMigrationProvenanceV5, systemBackupProtectedConfigurationV5, protectedIdentityPolicy,
  collaborationRecoveryPolicyV28, type SystemBackupRecordsV5 } from "../../shared/contracts/system-backup-v5";

const tables = catalog.tables.filter(table => !table.local);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function sum(terms: string[]): string {
  if (terms.length === 1) return terms[0]; const index = Math.floor(terms.length / 2);
  return `(${sum(terms.slice(0, index))}+${sum(terms.slice(index))})`;
}
const count = sum(tables.map(table => `(SELECT count(*) FROM ${quote(table.name)})`));
const bytes = sum(tables.map(table => `(SELECT coalesce(sum(${sum([String(512 + table.columns.length * 80),
  ...table.columns.map(column => `coalesce(length(CAST(${quote(column)} AS BLOB)),0)*6`)])}),0) FROM ${quote(table.name)})`));
const budget = `SELECT CASE WHEN ${count}>16384 OR ${bytes}>${SYSTEM_BACKUP_MAX_RECORDS_BYTES}
  THEN json('V28 held snapshot budget exceeded') ELSE 1 END`;
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error("worker_v28_held_capture_" + reason); }
export interface WorkerV28HeldCaptureOptionsCandidate {
  backupId: string; expectedInstallationId: string; createdAt?: string; signal?: AbortSignal;
  deadlineAt?: string;
  /** Actual operator/application authorization and cold-source writer custody.
   * Metadata, an archive, or a copied source marker never supplies this grant. */
  current(): Promise<boolean>;
  /** Runtime observation of an acknowledged original atomic hold installation.
   * Used only by the enclosing owner to retain/release its fresh hold identities. */
  onHoldsInstalled?(ids: readonly string[]): void;
}
const ledgerSql = "SELECT CAST(id AS TEXT) AS id,name,applied_at AS appliedAt FROM d1_migrations ORDER BY d1_migrations.id";
const schemaSql = "SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema ORDER BY type,name";
export const V28_HELD_SOURCE_INERT_SQL_CANDIDATE = `SELECT CASE WHEN
  EXISTS(SELECT 1 FROM system_recovery_runtime WHERE singleton=1 AND enabled=0 AND installation_id=?)
  AND EXISTS(SELECT 1 FROM system_recovery_maintenance WHERE singleton=1 AND state='fenced')
  AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
  AND EXISTS(SELECT 1 FROM file_authority_runtime_guard WHERE singleton=1 AND enabled=0)
  AND EXISTS(SELECT 1 FROM file_shadow_runtime_guard WHERE singleton=1 AND enabled=0)
  AND EXISTS(SELECT 1 FROM file_job_runtime_guard WHERE singleton=1 AND enabled=0)
  AND EXISTS(SELECT 1 FROM collaboration_control WHERE singleton=1 AND schema_version=2 AND enforcement='disabled' AND revision=1)
  AND NOT EXISTS(SELECT 1 FROM local_accounts WHERE enabled<>0)
  AND NOT EXISTS(SELECT 1 FROM local_identity_installation) AND NOT EXISTS(SELECT 1 FROM local_admin_grants)
  AND NOT EXISTS(SELECT 1 FROM local_sessions) AND NOT EXISTS(SELECT 1 FROM local_storage_profile_bindings)
  AND NOT EXISTS(SELECT 1 FROM local_storage_profile_checks) AND NOT EXISTS(SELECT 1 FROM local_storage_profile_admissions)
  AND NOT EXISTS(SELECT 1 FROM collaboration_members) AND NOT EXISTS(SELECT 1 FROM collaboration_identities)
  AND NOT EXISTS(SELECT 1 FROM collaboration_resources) AND NOT EXISTS(SELECT 1 FROM collaboration_grants)
  THEN 1 ELSE json('V28 held source is not the admitted inert installation') END`;

/** One real primary batch installs the actual reviewed export holds and freezes
 * content, typed protected history, entire observed schema and actual D1 ledger.
 * This is an explicit cold/inert source port, not public capture or activation.
 * The outer owner MUST retain all holds through original provider/archive close. */
export async function captureHeldWorkerV28SystemBackupCandidate(env: Env, options: WorkerV28HeldCaptureOptionsCandidate): Promise<SystemBackupRecordsV5> {
  return captureOriginalWorkerV28Snapshot(env,options);
}
/** Actual original public FP5 claim. This issuer reads the genuine installation
 * and joins the durable job/token/generation/runtime lease to every cold fence.
 * No uploaded metadata, callback-only actor, one-shot token or enabled account
 * can stand in for that original issued public job. */
export async function captureWorkerV5PublicSnapshot(env: Env,claim: RecoveryClaim,expectedInstallationId:string,current:()=>Promise<boolean>,signal:AbortSignal,deadlineAt?:string):Promise<SystemBackupRecordsV5>{
  ensure(typeof deadlineAt==="string"&&Number.isFinite(Date.parse(deadlineAt))&&Date.now()<Date.parse(deadlineAt),"original_public_hard_deadline");
  ensure(claim.kind==="backup"&&claim.phase==="snapshot"&&claim.state==="running","original_public_backup_claim");
  ensure(/^[a-f0-9]{32}$/.test(expectedInstallationId),"original_public_installation");
  return captureOriginalWorkerV28Snapshot(env,{backupId:claim.id,createdAt:claim.accepted_at,expectedInstallationId,current,signal,deadlineAt},claim);
}
export function workerV5PublicBackupClaimFence(env:Env,claim:RecoveryClaim,expectedId:string,deadlineAt?:string){
  ensure(claim.kind==="backup"&&claim.state==="running"&&canAdministerSystemSettings(env,claim.actor)
    &&Boolean(env.ACCESS_TEAM_DOMAIN&&env.ACCESS_AUD)&&allowedEmail(claim.actor,env.ALLOWED_EMAILS),"original_public_administrator");
  const original=V28_HELD_SOURCE_INERT_SQL_CANDIDATE.replace(
    "EXISTS(SELECT 1 FROM system_recovery_runtime WHERE singleton=1 AND enabled=0 AND installation_id=?)",
    `EXISTS(SELECT 1 FROM system_recovery_runtime r JOIN system_recovery_jobs j ON j.runtime_incarnation=r.incarnation
      WHERE r.singleton=1 AND r.enabled=1 AND r.installation_id=? AND j.id=? AND j.actor=? AND j.kind='backup' AND j.state='running'
        AND j.owner_token=? AND j.generation=? AND j.runtime_incarnation=? AND julianday(j.lease_expires_at)>julianday('now')
        AND j.lease_expires_at=? ${deadlineAt===undefined?"":"AND julianday(?)>julianday('now')"} AND EXISTS(SELECT 1 FROM system_recovery_maintenance m WHERE m.singleton=1 AND m.state='fenced'
          AND(m.checkpoint_sha256 IS NULL OR m.backup_job_id=j.id))
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL))`);
  return primaryD1(env.DB).prepare(original).bind(expectedId,claim.id,claim.actor,claim.owner_token,claim.generation,claim.runtime_incarnation,claim.lease_expires_at,...(deadlineAt===undefined?[]:[deadlineAt]));
}
async function captureOriginalWorkerV28Snapshot(env: Env, options: WorkerV28HeldCaptureOptionsCandidate,publicClaim?:RecoveryClaim): Promise<SystemBackupRecordsV5> {
  const binding = env.DB, db = primaryD1(binding), backupId = options.backupId, expectedId = options.expectedInstallationId;
  const createdAt = options.createdAt ?? new Date().toISOString(), current = options.current, signal = options.signal;
  const observedHolds = options.onHoldsInstalled,deadline=options.deadlineAt===undefined?null:Date.parse(options.deadlineAt);
  function issueCurrent(){
    return !signal?.aborted&&env.DB===binding&&(deadline===null||Number.isFinite(deadline)&&Date.now()<deadline)
      &&(!publicClaim||canAdministerSystemSettings(env,publicClaim.actor)&&Boolean(env.ACCESS_TEAM_DOMAIN&&env.ACCESS_AUD)&&allowedEmail(publicClaim.actor,env.ALLOWED_EMAILS));
  }
  ensure(typeof backupId === "string" && backupId.length > 0 && backupId.length <= 128 && !backupId.includes("\0")
    && /^[a-f0-9]{32}$/.test(expectedId) && Number.isFinite(Date.parse(createdAt)) && new Date(createdAt).toISOString() === createdAt, "identity");
  async function available() {
    ensure(issueCurrent() && await current() === true && issueCurrent(), "source_authority");
    await (publicClaim ? workerV5PublicBackupClaimFence(env,publicClaim,expectedId,options.deadlineAt) : db.prepare(V28_HELD_SOURCE_INERT_SQL_CANDIDATE).bind(expectedId)).first();
    ensure(issueCurrent() && await current() === true && issueCurrent(), "source_authority");
  }
  await available(); const preflight = await db.prepare(schemaSql).all<ExportSchemaObject>();
  ensure(preflight.success, "schema"); const platform = await inspectV28CloudflareSchemaCandidate(preflight.results);
  // This bounded port selects only the already constructed exact V28 checkpoint.
  // The observed ledger describes reviewed construction, not migration replay.
  ensure(platform.ledgerPresent, "constructed_ledger_required"); await inspectRecoveryMigrationLedger(db, true, catalog.migrations);
  await available();
  const contentSql = nativeV28SnapshotSql(), holds = installPortableSystemBackupHolds(db, backupId, createdAt);
  const prefix = [publicClaim ? workerV5PublicBackupClaimFence(env,publicClaim,expectedId,options.deadlineAt) : db.prepare(V28_HELD_SOURCE_INERT_SQL_CANDIDATE).bind(expectedId),
    db.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM file_location_holds WHERE operation_id=? OR id=?)
      AND NOT EXISTS(SELECT 1 FROM system_recovery_legacy_holds WHERE job_id=?)
      AND NOT EXISTS(SELECT 1 FROM assets WHERE r2_key IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM managed_storage_objects)
      AND NOT EXISTS(SELECT 1 FROM blob_retention_edges)
      AND NOT EXISTS(SELECT 1 FROM imports WHERE workbook_asset_key IS NOT NULL OR manifest_asset_key IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM template_versions WHERE source_asset_key IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM events WHERE asset_key IS NOT NULL)
      THEN 1 ELSE json('V28 held owner or nonnative inventory not admitted') END`).bind("fp5-backup:" + backupId, backupId, backupId),
    db.prepare(budget), ...holds, db.prepare(budget)];
  const statements=[...prefix,...contentSql.map(sql=>db.prepare(sql)),
    ...tables.map(spec=>db.prepare(recoveryTableSnapshotSql(spec))),db.prepare(schemaSql),db.prepare(ledgerSql)];
  // All original statement construction precedes the final actual claim/clock
  // check. The first public fence also checks the immutable deadline in SQL.
  if(publicClaim)ensure(await current()===true,"source_authority");
  ensure(issueCurrent(),"source_authority");
  const results=await db.batch(statements);
  const imageOffset = prefix.length + contentSql.length;
  ensure(results.length === imageOffset + tables.length + 2 && results.every(result => result.success), "atomic_snapshot");
  const inspected = await inspectV28CloudflareSchemaCandidate(results[imageOffset + tables.length].results as ExportSchemaObject[]);
  ensure(inspected.ledgerPresent, "atomic_ledger_changed");
  const imageTables = Object.fromEntries(tables.map((spec, index) => [spec.name, { columns: [...spec.columns],
    rows: results[imageOffset + index].results.map(value => { const row = value as { rowid: string | null; cells: string };
      return { rowid: row.rowid, cells: JSON.parse(row.cells) }; }) }]));
  const held = imageTables.file_location_holds;
  ensure(held, "hold_inventory");
  const holdOwner = held.columns.indexOf("operation_id"), holdId = held.columns.indexOf("id");
  const ids = held.rows.filter(row => row.cells[holdOwner].type === "text" && row.cells[holdOwner].value === "fp5-backup:" + backupId)
    .map(row => { const cell = row.cells[holdId]; ensure(cell.type === "text", "hold_identity"); return cell.value; });
  observedHolds?.(Object.freeze(ids));
  // Decode protected history from this SAME frozen typed source observation.
  const protectedHistory = protectedLocalHistoryFromV5Image({ version: 5, kind: "system-recovery-image", checkpointId: catalog.checkpointId,
    schemaSha256: catalog.schemaSha256, sourceSnapshotClock: createdAt, tables: imageTables });
  const business = await buildFullExportV28FromSnapshot(results.slice(prefix.length, imageOffset), {
    backupHoldOwner: backupId, protectedLocalHistory: protectedHistory,
    async projectSchema(objects) { return portableBusinessSchemaV28((await inspectV28CloudflareSchemaCandidate(objects)).applicationObjects); },
  });
  const content = await createFullExportV28(business, inspected.applicationObjects, protectedHistory);
  const image = validateSystemRecoveryImageV5({ version: 5, kind: "system-recovery-image", checkpointId: catalog.checkpointId,
    schemaSha256: catalog.schemaSha256, sourceSnapshotClock: content.artifacts.sourceSchema.value.snapshotClock, tables: imageTables });
  const ledgerRows = results[imageOffset + tables.length + 1].results as Array<{ id: string; name: string; appliedAt: string | null }>;
  ensure(ledgerRows.length === catalog.migrations.length && ledgerRows.every((row, index) => row.id === String(index + 1)
    && row.name === catalog.migrations[index].name && typeof row.appliedAt === "string" && Number.isFinite(Date.parse(row.appliedAt))),
  "atomic_reviewed_ledger_changed");
  const sourceMigrationLedger = validateCloudflareMigrationProvenanceV5({ kind: "cloudflare-observed-migrations/1", status: "observed",
    entries: ledgerRows.map((row, index) => ({ ...row, rawSha256: catalog.migrations[index].sha256 })) });
  const records = await validateSystemBackupRecordsV5({ schema: "system-backup-records/5", backupId, createdAt, content, image,
    sourceMigrationLedger, protectedConfiguration: systemBackupProtectedConfigurationV5(image), protectedIdentity: protectedIdentityPolicy(),
    collaborationPolicy: collaborationRecoveryPolicyV28(), origin: { format: "native", schemaVersion: 28, capturePolicy: "atomic-primary-with-byte-holds/1" } });
  ensure(records.content.blobs.every(source => source.storeKind === "r2" && source.provider === "r2" && source.byteAuthority === "file_location"
    && source.storageProfileId !== null && source.storageProfileRevision === 1 && source.locationId !== null
    && source.initialOutcome === null && source.expectedByteSize !== null && source.expectedSha256 !== null), "mapped_r2_inventory_required");
  for (const source of records.content.blobs) ensure(await db.prepare(`SELECT 1 FROM file_location_holds WHERE location_id=? AND operation_id=?
    AND hold_kind='export' AND released_at IS NULL AND expires_at IS NULL`).bind(source.locationId, "fp5-backup:" + backupId).first(), "actual_hold_required");
  await available(); return records;
}
