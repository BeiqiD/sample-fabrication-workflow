import { HTTPException } from 'hono/http-exception';
import type { JobSqlDatabase, JobSqlStatement } from '../../worker/files/jobs/sql-repository.ts';
import { checkedSystemRecoveryMaintenanceInput, checkedSystemRecoveryMaintenanceStatus,
  type SystemRecoveryMaintenanceInput, type SystemRecoveryMaintenanceReceipt,
  type SystemRecoveryMaintenanceStatus } from '../../shared/contracts/system-recovery.ts';

const conflict = (message: string) => new HTTPException(409, { message });
const unavailable = () => new HTTPException(503, { message: 'System recovery maintenance state is unavailable' });
const requestChanged = () => conflict('Maintenance request ID was already used with different input');
interface MaintenanceReceiptRow {
  actor: string;
  action: SystemRecoveryMaintenanceInput['action'];
  expected_generation: number;
  result_json: string;
}

/** Trusted Recovery-only composition. The host supplies an admitted primary
 * JobSQL view which checks its actual installation, current authenticated local
 * administrator/session and sole Linux writer owner inside the SAME BEGIN.
 * This component neither accepts an Env/target substitute nor issues authority.
 * The explicit host has no source business/File/GC writers and owns its real
 * private artifact namespace; enter does not provision a recovery destination.
 */
export function createNodeRecoverySourceMaintenance(database: JobSqlDatabase): {
  read(): Promise<SystemRecoveryMaintenanceStatus>;
  receipt(actor: string, requestId: string): Promise<SystemRecoveryMaintenanceReceipt | null>;
  control(actor: string, input: SystemRecoveryMaintenanceInput): Promise<SystemRecoveryMaintenanceReceipt>;
} {
  async function read(): Promise<SystemRecoveryMaintenanceStatus> {
    // Status and writer count share one actual SQLite snapshot. Expiry remains
    // diagnostic: every unreleased source writer blocks planned finalization.
    const row = await database.primary().prepare(`SELECT state,generation,token,
      checkpoint_sha256 AS checkpoint,backup_job_id AS backupJobId,
      (SELECT count(*) FROM system_recovery_write_leases WHERE released_at IS NULL) AS activeWriters
      FROM system_recovery_maintenance WHERE singleton=1`).first<unknown>();
    if (!row) throw unavailable();
    try { return checkedSystemRecoveryMaintenanceStatus(row); }
    catch { throw unavailable(); }
  }
  async function receipt(actor: string, requestId: string): Promise<SystemRecoveryMaintenanceReceipt | null> {
    const row = await database.primary().prepare(`SELECT actor,action,expected_generation,result_json
      FROM system_recovery_maintenance_requests WHERE request_id=?`)
      .bind(requestId).first<MaintenanceReceiptRow>();
    if (!row) return null;
    if (row.actor !== actor) throw conflict('This maintenance request belongs to another administrator');
    try {
      return { ...checkedSystemRecoveryMaintenanceInput({ requestId, action: row.action,
        expectedGeneration: row.expected_generation }), status: checkedSystemRecoveryMaintenanceStatus(JSON.parse(row.result_json)) };
    } catch { throw unavailable(); }
  }
  function exactReceipt(existing: SystemRecoveryMaintenanceReceipt, input: SystemRecoveryMaintenanceInput): SystemRecoveryMaintenanceReceipt {
    if (existing.action !== input.action || existing.expectedGeneration !== input.expectedGeneration) throw requestChanged();
    return existing;
  }
  async function control(actor: string, raw: SystemRecoveryMaintenanceInput): Promise<SystemRecoveryMaintenanceReceipt> {
    let input: SystemRecoveryMaintenanceInput;
    try { input = checkedSystemRecoveryMaintenanceInput(raw); }
    catch { throw new HTTPException(400, { message: 'Invalid source maintenance input' }); }
    const prior = await receipt(actor, input.requestId);
    // Exact accepted input always returns its original receipt, even after a
    // later action changed the source window. Current state is never a retry ACK.
    if (prior) return exactReceipt(prior, input);
    const db = database.primary(), now = new Date().toISOString();
    const allowedState = input.action === 'enter' ? "state='open' AND generation<9007199254740991"
      : input.action === 'finalize' ? "state='draining'" : "state IN('draining','fenced') AND generation<9007199254740991";
    // The original provider/ingress ledger predicates remain conservative.
    // Pausing a job or disabling its executor does not settle an issued PUT,
    // unknown attempt, pending acceptance, unfinished check or source lease.
    const drained = input.action === 'finalize' ? `AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM file_shadow_attempts WHERE state IN('write_started','unknown'))
      AND NOT EXISTS(SELECT 1 FROM file_migration_attempts WHERE state IN('write_started','unknown'))
      AND NOT EXISTS(SELECT 1 FROM research_package_attempts WHERE state IN('write_started','unknown'))
      AND NOT EXISTS(SELECT 1 FROM r2_upload_requests WHERE status='pending')
      AND NOT EXISTS(SELECT 1 FROM metrology_reference_upload_requests WHERE status='pending')
      AND NOT EXISTS(SELECT 1 FROM comment_submission_acceptances WHERE status='pending')
      AND NOT EXISTS(SELECT 1 FROM import_file_acceptances WHERE status='pending')
      AND NOT EXISTS(SELECT 1 FROM system_storage_candidate_checks
        WHERE status='running' OR cleanup_outcome='running' OR write_outcome='unknown')
      AND (SELECT enabled FROM file_authority_runtime_guard WHERE singleton=1)=0
      AND (SELECT enabled FROM file_shadow_runtime_guard WHERE singleton=1)=0
      AND (SELECT enabled FROM file_job_runtime_guard WHERE singleton=1)=0
      AND NOT EXISTS(SELECT 1 FROM file_migration_jobs WHERE state IN('queued','running'))
      AND NOT EXISTS(SELECT 1 FROM research_package_jobs WHERE state IN('queued','running'))` : '';
    const update = input.action === 'enter'
      ? db.prepare(`UPDATE system_recovery_maintenance SET state='draining',generation=generation+1,token=?,requested_by=?,
          backup_job_id=NULL,checkpoint_sha256=NULL,started_at=?,fenced_at=NULL,updated_at=?
          WHERE singleton=1 AND generation=? AND ${allowedState}`)
          .bind(input.requestId, actor, now, now, input.expectedGeneration)
      : input.action === 'finalize'
        ? db.prepare("UPDATE system_recovery_maintenance SET state='fenced',fenced_at=?,updated_at=? WHERE singleton=1 AND generation=? AND state='draining'")
          .bind(now, now, input.expectedGeneration)
        : db.prepare(`UPDATE system_recovery_maintenance SET state='open',generation=generation+1,token=NULL,requested_by=NULL,
            backup_job_id=NULL,checkpoint_sha256=NULL,started_at=NULL,fenced_at=NULL,updated_at=?
            WHERE singleton=1 AND generation=? AND ${allowedState}`).bind(now, input.expectedGeneration);
    const pause: JobSqlStatement[] = input.action === 'enter' ? [
      db.prepare('UPDATE file_authority_runtime_guard SET enabled=0,enabled_by=?,updated_at=? WHERE singleton=1').bind(actor, now),
      db.prepare('UPDATE file_shadow_runtime_guard SET enabled=0,enabled_by=?,updated_at=? WHERE singleton=1').bind(actor, now),
      db.prepare('UPDATE file_job_runtime_guard SET enabled=?,incarnation=?,last_heartbeat_at=NULL WHERE singleton=1').bind(0, null),
      // Preserve the original explicit executor-control-service pause writes.
      // Attempts, holds, accepted business rows, roles and profile bindings stay
      // untouched. Neither release nor a later executor enable resumes history.
      db.prepare("UPDATE file_migration_jobs SET state='paused',reason='executor_reconfigured',generation=generation+1,owner_token=NULL,lease_expires_at=NULL,updated_at=? WHERE state IN('queued','running')").bind(now),
      db.prepare("UPDATE research_package_jobs SET state='paused',reason='executor_reconfigured',generation=generation+1,owner_token=NULL,lease_expires_at=NULL,updated_at=? WHERE state IN('queued','running')").bind(now),
    ] : [];
    try {
      await db.batch([
        db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_maintenance
          WHERE singleton=1 AND generation=? AND ${allowedState}) ${drained}
          THEN 1 ELSE json('Source maintenance revision changed or writers remain unsettled') END`).bind(input.expectedGeneration),
        update, ...pause,
        db.prepare(`INSERT INTO system_recovery_maintenance_requests(request_id,actor,action,expected_generation,result_json,created_at)
          SELECT ?,?,?,?,json_object('state',state,'generation',generation,'token',token,'checkpoint',checkpoint_sha256,
            'backupJobId',backup_job_id,'activeWriters',(SELECT count(*) FROM system_recovery_write_leases WHERE released_at IS NULL)),?
          FROM system_recovery_maintenance WHERE singleton=1`)
          .bind(input.requestId, actor, input.action, input.expectedGeneration, now),
      ]);
    } catch {
      // Reconcile the immutable receipt before reporting a failed/lost batch
      // ACK. A concurrent exact duplicate may have committed this same request.
      const committed = await receipt(actor, input.requestId);
      if (committed) return exactReceipt(committed, input);
      throw conflict('Source writers remain unsettled or the maintenance revision/request changed');
    }
    const committed = await receipt(actor, input.requestId);
    if (!committed) throw new HTTPException(503, {
      message: 'Maintenance receipt is temporarily unavailable; reconcile the same request ID',
    });
    return exactReceipt(committed, input);
  }
  return Object.freeze({ read, receipt, control });
}
