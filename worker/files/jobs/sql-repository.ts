import {
  checkedAcceptFileMigration, FILE_JOB_LEASE_MS, FILE_JOB_MAX_BYTES, FILE_JOB_MAX_ATTEMPTS, FILE_JOB_SOURCE_GRACE_MS,
  FILE_JOB_HEARTBEAT_STALE_MS, type AcceptFileMigrationInput, type FileJobExecutorStatus,
  type FileJobStatus, type FileMigrationPlan, type FileMigrationInventory, type FileMigrationItems, type FileMigrationItemStatus,
} from "../../../shared/contracts/file-jobs";
import type { FilePurpose } from "../../../shared/contracts/files";
import type { FileJobRepository, JobClaim, MigrationAttempt, MigrationItem, MigrationCleanupCopy, MigrationCleanupArtifact } from "./types";

export interface JobSqlStatement {
  bind(...values: unknown[]): JobSqlStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface JobSqlDatabase {
  prepare(sql: string): JobSqlStatement;
  batch(statements: JobSqlStatement[]): Promise<unknown>;
  /** Every authority/uncertain-outcome read starts at the current primary. */
  primary(): JobSqlDatabase;
}
const execution = `EXISTS(SELECT 1 FROM file_job_runtime_guard g
  JOIN file_authority_runtime_guard fg ON fg.singleton=g.singleton AND fg.enabled=1
  JOIN file_authority_control fc ON fc.singleton=g.singleton AND fc.mode='active'
  WHERE g.singleton=1 AND g.enabled=1 AND g.incarnation=file_migration_jobs.runtime_incarnation)`;
const owned = `id=? AND owner_token=? AND generation=? AND runtime_incarnation=?
  AND state='running' AND julianday(lease_expires_at)>julianday('now') AND ${execution}`;
const claimValues = (claim: JobClaim) => [claim.id, claim.owner_token, claim.generation, claim.runtime_incarnation];
interface PlanRow extends MigrationItem { purpose: FilePurpose }

/** Repository commands use native atomic batches/transactions. Object I/O and
 * policy evaluation stay outside them. A lost acknowledgement is settled by a
 * fresh primary read of the immutable receipt or exact ownership tuple. */
export class SqlFileJobRepository implements FileJobRepository {
  constructor(private readonly database: JobSqlDatabase, private readonly clock: () => Date,
    private readonly randomId: () => string) {}
  private now() { return this.clock().toISOString(); }
  private guard(db: JobSqlDatabase, claim: JobClaim) {
    return db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_migration_jobs WHERE ${owned})
      THEN 1 ELSE json('File job lease is unavailable') END`).bind(...claimValues(claim));
  }
  private async selected(input: AcceptFileMigrationInput): Promise<PlanRow[]> {
    const rows = await this.database.primary().prepare(`SELECT f.file_id,f.purpose,f.active_location_id AS source_location_id,
      l.storage_profile_id AS source_profile_id,p.configuration_revision AS source_configuration_revision,
      p.namespace_identity AS source_namespace,l.object_key AS source_object_key,
      f.verified_byte_size AS byte_size,f.verified_sha256 AS sha256
      FROM file_usable_publications f JOIN file_location_publications l ON l.location_id=f.active_location_id
      JOIN storage_profiles p ON p.id=l.storage_profile_id
      JOIN file_authority_control fc ON fc.singleton=1 AND fc.mode='active'
      WHERE f.access_scope='system' AND f.file_id IN(${input.fileIds.map(() => "?").join(",")}) ORDER BY f.file_id`)
      .bind(...input.fileIds).all<PlanRow>();
    if (rows.results.length !== input.fileIds.length) throw new Error("Some selected Files are unavailable");
    return rows.results;
  }
  async plan(raw: AcceptFileMigrationInput): Promise<FileMigrationPlan> {
    const input = checkedAcceptFileMigration(raw), rows = await this.selected(input);
    const target = await this.database.primary().prepare(`SELECT 1 AS ready FROM storage_profiles p
      JOIN storage_profile_runtime r ON r.storage_profile_id=p.id WHERE p.id=? AND p.configuration_revision=?
      AND r.state='read_write'`).bind(input.target.profileId, input.target.configurationRevision).first();
    if (!target) throw new Error("Migration destination is not writable");
    const bytes = rows.reduce((sum, row) => sum + row.byte_size, 0);
    return { target: input.target, items: rows.map(row => ({ fileId: row.file_id, purpose: row.purpose,
      sourceLocationId: row.source_location_id, sourceProfileId: row.source_profile_id,
      byteSize: row.byte_size, sha256: row.sha256,
      status: row.byte_size > FILE_JOB_MAX_BYTES ? "unsupported_size"
        : row.source_profile_id === input.target.profileId ? "same_profile" : "eligible" })),
      bytes, retainedSourceBytes: bytes, stagingBytes: bytes * FILE_JOB_MAX_ATTEMPTS, transferAndVerificationBytes: bytes * 3,
      maxTransferAndVerificationBytes: bytes * 3 * FILE_JOB_MAX_ATTEMPTS, maxAttemptsPerFile: 5, bytesVerified: false };
  }
  async accept(raw: AcceptFileMigrationInput, actor: string, authorize?: () => boolean): Promise<FileJobStatus> {
    if (authorize && authorize() !== true) throw new Error("Administrator authorization is unavailable");
    const input = checkedAcceptFileMigration(raw), inputJson = JSON.stringify(input), db = this.database.primary();
    const existing = await db.prepare("SELECT id,actor,input_json FROM file_migration_jobs WHERE request_id=?")
      .bind(input.requestId).first<{ id: string; actor: string; input_json: string }>();
    if (existing) {
      if (existing.actor !== actor || existing.input_json !== inputJson) throw new Error("File job retry differs from its accepted input");
      return (await this.status(existing.id))!;
    }
    const plan = await this.plan(input);
    if (plan.items.some(item => item.status !== "eligible")) throw new Error("Migration plan has blocking Files");
    const rows = await this.selected(input), id = this.randomId(), at = this.now();
    if (rows.some(row => row.byte_size > FILE_JOB_MAX_BYTES || row.source_profile_id === input.target.profileId)) {
      throw new Error("Migration plan changed to a blocked selection");
    }
    const statements = [db.prepare(`INSERT INTO file_migration_jobs(id,request_id,actor,input_json,target_profile_id,
      target_configuration_revision,target_namespace,accepted_at,state,updated_at)
      SELECT ?,?,?,?,?,?,p.namespace_identity,?,'queued',? FROM storage_profiles p
      JOIN storage_profile_runtime r ON r.storage_profile_id=p.id AND r.state='read_write'
      WHERE p.id=? AND p.configuration_revision=?`)
      .bind(id, input.requestId, actor, inputJson, input.target.profileId, input.target.configurationRevision,
        at, at, input.target.profileId, input.target.configurationRevision)];
    for (const row of rows) {
      const operation = `fp3:${id}:${this.randomId()}`;
      statements.push(db.prepare(`INSERT INTO file_migration_items(job_id,file_id,purpose,source_location_id,
        source_profile_id,source_configuration_revision,source_namespace,source_object_key,byte_size,sha256,
        hold_operation_id,state,updated_at)
        SELECT ?,f.file_id,f.purpose,l.location_id,l.storage_profile_id,p.configuration_revision,p.namespace_identity,
          l.object_key,f.verified_byte_size,f.verified_sha256,?,'pending',?
        FROM file_usable_publications f JOIN file_location_publications l ON l.location_id=f.active_location_id
        JOIN storage_profiles p ON p.id=l.storage_profile_id WHERE f.file_id=? AND f.active_location_id=?
          AND f.verified_byte_size=? AND f.verified_sha256=? AND f.access_scope='system'
          AND l.storage_profile_id<>? AND f.verified_byte_size<=?
          AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')`)
        .bind(id, operation, at, row.file_id, row.source_location_id, row.byte_size, row.sha256, input.target.profileId, FILE_JOB_MAX_BYTES));
      statements.push(db.prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at)
        SELECT ?,source_location_id,'transition_source',hold_operation_id,'Accepted File migration source',?
        FROM file_migration_items WHERE job_id=? AND file_id=?`)
        .bind(this.randomId(), at, id, row.file_id));
    }
    statements.push(db.prepare(`SELECT CASE WHEN (SELECT count(*) FROM file_migration_items WHERE job_id=?)=?
      THEN 1 ELSE json('File migration snapshot changed') END`).bind(id, input.fileIds.length));
    if (authorize && authorize() !== true) throw new Error("Administrator authorization is unavailable");
    try { await db.batch(statements); } catch { /* Settle the immutable receipt below before retrying acceptance. */ }
    const committed = await this.database.primary().prepare("SELECT id,actor,input_json FROM file_migration_jobs WHERE request_id=?")
      .bind(input.requestId).first<{ id: string; actor: string; input_json: string }>();
    if (!committed || committed.actor !== actor || committed.input_json !== inputJson) throw new Error("File migration acceptance did not commit");
    return (await this.status(committed.id))!;
  }
  async claim(incarnation: string, owner: string, authorize: (actor: string) => boolean): Promise<JobClaim | null> {
    const db = this.database.primary();
    const candidates = await db.prepare(`SELECT id,actor FROM file_migration_jobs WHERE state='queued'
      OR (state='running' AND julianday(lease_expires_at)<=julianday('now')) ORDER BY updated_at,id LIMIT 10`)
      .all<{ id: string; actor: string }>();
    for (const candidate of candidates.results) {
      if (!authorize(candidate.actor)) {
        await db.prepare("UPDATE file_migration_jobs SET state='paused',reason='administrator_revoked',updated_at=?,generation=generation+1 WHERE id=? AND state IN('queued','running')")
          .bind(this.now(), candidate.id).run(); continue;
      }
      const at = this.now(), lease = new Date(this.clock().getTime() + FILE_JOB_LEASE_MS).toISOString();
      try { await db.prepare(`UPDATE file_migration_jobs SET state='running',owner_token=?,generation=generation+1,
        runtime_incarnation=?,lease_expires_at=?,admin_checked_at=?,updated_at=?,reason=NULL
        WHERE id=? AND (state='queued' OR (state='running' AND julianday(lease_expires_at)<=julianday('now')))
        AND EXISTS(SELECT 1 FROM file_job_runtime_guard g JOIN file_authority_runtime_guard fg ON fg.singleton=g.singleton
          AND fg.enabled=1 JOIN file_authority_control fc ON fc.singleton=g.singleton AND fc.mode='active'
          WHERE g.singleton=1 AND g.enabled=1 AND g.incarnation=?)`)
        .bind(owner, incarnation, lease, at, at, candidate.id, incarnation).run(); } catch { /* Primary ownership read settles a lost ACK. */ }
      const claim = await this.database.primary().prepare(`SELECT id,actor,target_profile_id,target_configuration_revision,
        target_namespace,owner_token,generation,runtime_incarnation FROM file_migration_jobs
        WHERE id=? AND owner_token=? AND runtime_incarnation=? AND state='running' AND ${execution}`)
        .bind(candidate.id, owner, incarnation).first<JobClaim>();
      if (claim) return claim;
    }
    return null;
  }
  async owns(claim: JobClaim) {
    return !!await this.database.primary().prepare(`SELECT 1 AS owned FROM file_migration_jobs WHERE ${owned}`)
      .bind(...claimValues(claim)).first();
  }
  async nextItem(claim: JobClaim) {
    if (!await this.owns(claim)) return null;
    return this.database.primary().prepare(`SELECT * FROM file_migration_items WHERE job_id=?
      AND state IN('pending','copying') ORDER BY file_id LIMIT 1`).bind(claim.id).first<MigrationItem>();
  }
  async attempt(item: MigrationItem) {
    return this.database.primary().prepare(`SELECT id,location_id,object_key,state,owner_token,generation,runtime_incarnation,io_settled_at
      FROM file_migration_attempts WHERE job_id=? AND file_id=? ORDER BY generation DESC,created_at DESC,id DESC LIMIT 1`)
      .bind(item.job_id, item.file_id).first<MigrationAttempt>();
  }
  async stage(claim: JobClaim, item: MigrationItem): Promise<MigrationAttempt> {
    const db = this.database.primary(), id = this.randomId(), location = this.randomId(), at = this.now();
    const count = await db.prepare("SELECT count(*) AS attempts FROM file_migration_attempts WHERE job_id=? AND file_id=?")
      .bind(claim.id, item.file_id).first<{ attempts: number }>();
    if (Number(count?.attempts) >= FILE_JOB_MAX_ATTEMPTS) throw new Error("retry_limit_exhausted");
    const key = `file-migrations/${claim.id}/${id}`;
    try { await db.batch([this.guard(db, claim),
      db.prepare("INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at) VALUES(?,?,?,?,'unresolved',?)")
        .bind(location, item.file_id, claim.target_profile_id, key, at),
      db.prepare(`INSERT INTO file_migration_attempts(id,job_id,file_id,location_id,object_key,owner_token,generation,
        runtime_incarnation,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'staged',?,?)`)
        .bind(id, claim.id, item.file_id, location, key, claim.owner_token, claim.generation, claim.runtime_incarnation, at, at),
      db.prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at)
        VALUES(?,?,'transition_destination',?,'File migration candidate',?)`)
        .bind(this.randomId(), location, item.hold_operation_id, at),
      db.prepare("UPDATE file_migration_items SET state='copying',updated_at=?,reason=NULL WHERE job_id=? AND file_id=? AND state IN('pending','failed','copying')")
        .bind(at, claim.id, item.file_id),
    ]); } catch { /* Registered candidate readback precedes provider I/O. */ }
    const attempt = await db.primary().prepare(`SELECT id,location_id,object_key,state,owner_token,generation,runtime_incarnation,io_settled_at
      FROM file_migration_attempts WHERE id=? AND job_id=? AND file_id=? AND location_id=? AND object_key=?
      AND owner_token=? AND generation=? AND runtime_incarnation=?`)
      .bind(id,claim.id,item.file_id,location,key,claim.owner_token,claim.generation,claim.runtime_incarnation).first<MigrationAttempt>();
    if (!attempt || attempt.id !== id || !await this.owns(claim)) throw new Error("Candidate registration did not commit");
    return attempt;
  }
  async startWrite(claim: JobClaim, attempt: MigrationAttempt) {
    const db = this.database.primary(), at = this.now();
    try { await db.batch([this.guard(db, claim), db.prepare(`UPDATE file_migration_attempts SET state='write_started',write_started_at=?,updated_at=?
      WHERE id=? AND state='staged' AND owner_token=? AND generation=? AND runtime_incarnation=?`)
      .bind(at, at, attempt.id, claim.owner_token, claim.generation, claim.runtime_incarnation)]); }
    catch { /* The exact write-start receipt below settles a lost ACK. */ }
    const row = await this.database.primary().prepare("SELECT state,write_started_at FROM file_migration_attempts WHERE id=?")
      .bind(attempt.id).first<{ state: string; write_started_at: string }>();
    if (row?.state !== "write_started" || row.write_started_at !== at || !await this.owns(claim)) throw new Error("Write admission did not commit");
    attempt.state = "write_started";
  }
  async observeSettled(attempt: MigrationAttempt) {
    const at = this.now();
    await this.database.primary().prepare(`UPDATE file_migration_attempts SET io_settled_at=coalesce(io_settled_at,?),updated_at=?
      WHERE id=? AND owner_token=? AND generation=? AND runtime_incarnation=? AND state IN('write_started','unknown','verified')`)
      .bind(at, at, attempt.id, attempt.owner_token, attempt.generation, attempt.runtime_incarnation).run();
    attempt.io_settled_at = at;
  }
  async verify(claim: JobClaim, item: MigrationItem, attempt: MigrationAttempt) {
    const db = this.database.primary(), at = this.now();
    try { await db.batch([this.guard(db, claim),
      db.prepare("UPDATE file_migration_jobs SET admin_checked_at=? WHERE id=?").bind(at, claim.id),
      db.prepare(`UPDATE file_migration_attempts SET state='verified',verified_byte_size=?,verified_sha256=?,verified_at=?,
        verified_owner_token=?,verified_generation=?,verified_runtime_incarnation=?,updated_at=?
        WHERE id=? AND io_settled_at IS NOT NULL AND state IN('write_started','unknown','verified')`)
        .bind(item.byte_size, item.sha256, at, claim.owner_token, claim.generation, claim.runtime_incarnation, at, attempt.id),
      db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM file_migration_live_verified_attempts WHERE id=?) THEN 1 ELSE json('File verification lost ownership') END")
        .bind(attempt.id),
    ]); } catch { /* Exact current verified ownership settles a lost ACK. */ }
    if (!await this.database.primary().prepare("SELECT 1 AS verified FROM file_migration_live_verified_attempts WHERE id=?")
      .bind(attempt.id).first()) throw new Error("Verification did not commit");
    attempt.state = "verified";
  }
  async cutover(claim: JobClaim, item: MigrationItem, attempt: MigrationAttempt) {
    const db = this.database.primary(), at = this.now(), grace = new Date(this.clock().getTime() + FILE_JOB_SOURCE_GRACE_MS).toISOString();
    const source = await db.prepare("SELECT 1 AS matches FROM file_publications WHERE file_id=? AND state='ready' AND active_location_id=?")
      .bind(item.file_id, item.source_location_id).first();
    if (!source) {
      await db.batch([this.guard(db, claim), db.prepare("UPDATE file_migration_items SET state='stale',reason='source_changed',updated_at=? WHERE job_id=? AND file_id=?")
        .bind(at, claim.id, item.file_id)]); return false;
    }
    try { await db.batch([this.guard(db, claim),
      db.prepare("UPDATE file_migration_jobs SET admin_checked_at=? WHERE id=?").bind(at, claim.id),
      db.prepare(`INSERT INTO file_location_publications(location_id,file_id,storage_profile_id,object_key,
        verified_byte_size,verified_sha256,verification_method,verification_operation_id,verified_at,published_at)
        SELECT a.location_id,a.file_id,j.target_profile_id,a.object_key,a.verified_byte_size,a.verified_sha256,
        'full_read_sha256',a.id,a.verified_at,? FROM file_migration_live_verified_attempts a
        JOIN file_migration_jobs j ON j.id=a.job_id WHERE a.id=?
        AND NOT EXISTS(SELECT 1 FROM file_location_publications WHERE location_id=a.location_id)`)
        .bind(at, attempt.id),
      db.prepare("UPDATE file_publications SET active_location_id=? WHERE file_id=? AND state='ready' AND active_location_id=?")
        .bind(attempt.location_id, item.file_id, item.source_location_id),
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_publications WHERE file_id=? AND active_location_id=?)
        THEN 1 ELSE json('File migration source changed') END`).bind(item.file_id, attempt.location_id),
      db.prepare("UPDATE file_migration_items SET state='moved',destination_location_id=?,cleanup_not_before=?,updated_at=?,reason=NULL WHERE job_id=? AND file_id=?")
        .bind(attempt.location_id, grace, at, claim.id, item.file_id),
      db.prepare("UPDATE file_migration_attempts SET state='published',updated_at=? WHERE id=?").bind(at, attempt.id),
      db.prepare("UPDATE file_location_holds SET released_at=? WHERE location_id=? AND operation_id=? AND released_at IS NULL")
        .bind(at, attempt.location_id, item.hold_operation_id),
    ]); } catch { /* Exact winner and item receipt settle a lost ACK. */ }
    const committed = await this.database.primary().prepare(`SELECT 1 AS moved FROM file_migration_items
      WHERE job_id=? AND file_id=? AND state='moved' AND destination_location_id=?`)
      .bind(claim.id, item.file_id, attempt.location_id).first();
    if (!committed) throw new Error("Cutover did not commit");
    return true;
  }
  async fail(claim: JobClaim, item: MigrationItem, attempt: MigrationAttempt | null, reason: string) {
    if (!await this.owns(claim)) return;
    const db = this.database.primary(), at = this.now(), statements = [this.guard(db, claim)];
    if (attempt) statements.push(db.prepare(`UPDATE file_migration_attempts SET state=CASE WHEN state IN('write_started','unknown','verified')
      AND io_settled_at IS NULL THEN 'unknown' ELSE 'failed' END,reason=?,updated_at=? WHERE id=? AND state<>'published'`)
      .bind(reason, at, attempt.id));
    statements.push(db.prepare(`UPDATE file_migration_items SET state=CASE WHEN EXISTS(SELECT 1 FROM file_migration_attempts a
      WHERE a.job_id=? AND a.file_id=? AND a.state='unknown') THEN 'copying' ELSE 'failed' END,reason=?,updated_at=?
      WHERE job_id=? AND file_id=? AND state<>'moved'`).bind(claim.id, item.file_id, reason, at, claim.id, item.file_id));
    await db.batch(statements);
  }
  async pause(claim: JobClaim, reason: string) {
    await this.database.primary().prepare(`UPDATE file_migration_jobs SET state='paused',reason=?,updated_at=?,generation=generation+1
      WHERE ${owned}`).bind(reason, this.now(), ...claimValues(claim)).run();
  }
  async release(claim: JobClaim) {
    await this.database.primary().prepare(`UPDATE file_migration_jobs SET state=CASE WHEN EXISTS(SELECT 1 FROM file_migration_items
      WHERE job_id=file_migration_jobs.id AND state IN('pending','copying')) THEN 'queued' ELSE 'completed' END,
      owner_token=NULL,lease_expires_at=NULL,updated_at=?,generation=generation+1 WHERE ${owned}`)
      .bind(this.now(), ...claimValues(claim)).run();
  }
  async heartbeat(incarnation: string) {
    await this.database.primary().prepare("UPDATE file_job_runtime_guard SET last_heartbeat_at=? WHERE singleton=1 AND enabled=1 AND incarnation=?")
      .bind(this.now(), incarnation).run();
  }
  async status(id: string): Promise<FileJobStatus | null> {
    const row = await this.database.primary().prepare(`SELECT j.*,
      (SELECT count(*) FROM file_migration_items i WHERE i.job_id=j.id AND i.state='moved') AS moved,
      (SELECT count(*) FROM file_migration_items i WHERE i.job_id=j.id AND i.state IN('pending','copying')) AS remaining,
      (SELECT count(*) FROM file_migration_items i WHERE i.job_id=j.id AND i.state IN('failed','stale')) AS failed,
      (SELECT count(*) FROM file_migration_items i WHERE i.job_id=j.id AND ((i.state IN('moved','stale') AND NOT EXISTS(
          SELECT 1 FROM file_location_gc_ledger g WHERE g.location_id=i.source_location_id AND g.state='deleted'))
        OR EXISTS(SELECT 1 FROM file_migration_attempts a
          WHERE a.job_id=i.job_id AND a.file_id=i.file_id AND a.state<>'published'
            AND ((a.write_started_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_location_gc_ledger g
              WHERE g.location_id=a.location_id AND g.state='deleted'))
              OR EXISTS(SELECT 1 FROM file_location_holds h WHERE h.location_id=a.location_id
                AND h.operation_id=i.hold_operation_id AND h.released_at IS NULL))))) AS cleanup_pending
      FROM file_migration_jobs j WHERE j.id=?`).bind(id).first<Record<string, unknown>>();
    if (!row) return null;
    return { id: String(row.id), actor: String(row.actor), state: row.state as FileJobStatus["state"],
      target: { profileId: String(row.target_profile_id), configurationRevision: Number(row.target_configuration_revision) },
      acceptedAt: String(row.accepted_at), updatedAt: String(row.updated_at), reason: row.reason as string | null,
      moved: Number(row.moved), remaining: Number(row.remaining), failed: Number(row.failed), cleanupPending: Number(row.cleanup_pending) };
  }
  async list() {
    const ids = await this.database.primary().prepare("SELECT id FROM file_migration_jobs ORDER BY accepted_at DESC,id DESC LIMIT 100").all<{ id: string }>();
    return Promise.all(ids.results.map(async row => (await this.status(row.id))!));
  }
  async executorStatus(): Promise<FileJobExecutorStatus> {
    const row = await this.database.primary().prepare("SELECT enabled,last_heartbeat_at FROM file_job_runtime_guard WHERE singleton=1")
      .first<{ enabled: number; last_heartbeat_at: string | null }>();
    return { enabled: row?.enabled === 1, lastHeartbeatAt: row?.last_heartbeat_at ?? null,
      stale: !row?.last_heartbeat_at || this.clock().getTime() - Date.parse(row.last_heartbeat_at) > FILE_JOB_HEARTBEAT_STALE_MS,
      cadenceSeconds: 120, maxFilesPerStep: 1, maxStepMs: 60000 };
  }
  async control(id: string, action: "pause" | "resume" | "cancel" | "retry") {
    const db = this.database.primary(), at = this.now();
    const status = await this.status(id);
    if (!status) throw new Error("File job does not exist");
    if (status.state === 'cancelled') return status;
    const statements: JobSqlStatement[] = [db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_migration_jobs
      WHERE id=? AND state<>'cancelled') THEN 1 ELSE json('Cancelled File job cannot change') END`).bind(id)];
    if (action === "retry") statements.push(db.prepare(`UPDATE file_migration_items SET state='pending',reason=NULL,updated_at=?
      WHERE job_id=? AND state IN('failed','copying') AND (SELECT count(*) FROM file_migration_attempts a
        WHERE a.job_id=file_migration_items.job_id AND a.file_id=file_migration_items.file_id)<?`)
      .bind(at, id, FILE_JOB_MAX_ATTEMPTS));
    if (action === "retry") statements.push(db.prepare(`UPDATE file_migration_items SET reason='retry_limit_exhausted',updated_at=?
      WHERE job_id=? AND state IN('failed','copying') AND (SELECT count(*) FROM file_migration_attempts a
        WHERE a.job_id=file_migration_items.job_id AND a.file_id=file_migration_items.file_id)>=?`).bind(at, id, FILE_JOB_MAX_ATTEMPTS));
    if (action === "cancel") {
      statements.push(db.prepare("UPDATE file_migration_attempts SET state='cancelled',updated_at=? WHERE job_id=? AND state='staged'").bind(at, id));
      statements.push(db.prepare(`UPDATE file_migration_items SET state='cancelled',updated_at=? WHERE job_id=? AND state IN('pending','copying','failed')
        AND NOT EXISTS(SELECT 1 FROM file_migration_attempts a WHERE a.job_id=file_migration_items.job_id
          AND a.file_id=file_migration_items.file_id AND a.state IN('write_started','unknown','verified'))`).bind(at, id));
      // Cancelling execution can drop a never-written candidate. Any PUT that
      // began still requires a separately accepted cleanup before GC admission,
      // including a known-settled write that failed its content verification.
      statements.push(db.prepare(`UPDATE file_location_holds SET released_at=? WHERE operation_id IN(SELECT i.hold_operation_id
        FROM file_migration_items i WHERE i.job_id=? AND i.state='cancelled'
        AND NOT EXISTS(SELECT 1 FROM file_migration_attempts a WHERE a.job_id=i.job_id AND a.file_id=i.file_id
          AND a.state<>'published' AND a.write_started_at IS NOT NULL)) AND released_at IS NULL`).bind(at, id));
    }
    statements.push(db.prepare(`UPDATE file_migration_jobs SET state=?,reason=?,generation=generation+1,owner_token=NULL,
      lease_expires_at=NULL,updated_at=? WHERE id=? AND state NOT IN('cancelled')`)
      .bind(action === "cancel" ? "cancelled" : action === "pause" ? "paused" : "queued",
        action === "pause" ? "operator_paused" : action === "cancel" ? "operator_cancelled" : null, at, id));
    await db.batch(statements);
    if (action === "retry") await db.prepare(`UPDATE file_migration_jobs SET state='paused',reason='retry_limit_exhausted'
      WHERE id=? AND state='queued' AND NOT EXISTS(SELECT 1 FROM file_migration_items i WHERE i.job_id=? AND i.state='pending')
        AND EXISTS(SELECT 1 FROM file_migration_items i WHERE i.job_id=? AND i.reason='retry_limit_exhausted')`)
      .bind(id, id, id).run();
    return (await this.status(id))!;
  }
  async requestCleanup(id: string, actor: string, authorize?: () => boolean) {
    if (authorize && authorize() !== true) throw new Error("Administrator authorization is unavailable");
    const at = this.now();
    const db = this.database.primary();
    await db.batch([
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_job_runtime_guard g
        JOIN file_authority_runtime_guard fg ON fg.singleton=g.singleton AND fg.enabled=1
        JOIN file_authority_control fc ON fc.singleton=g.singleton AND fc.mode='active'
        WHERE g.singleton=1 AND g.enabled=1 AND g.incarnation IS NOT NULL)
        AND EXISTS(SELECT 1 FROM file_migration_jobs WHERE id=?) THEN 1 ELSE json('Cleanup execution is not enabled') END`).bind(id),
      db.prepare(`UPDATE file_migration_items SET cleanup_requested_at=coalesce(cleanup_requested_at,?),
      cleanup_actor=coalesce(cleanup_actor,?),cleanup_not_before=coalesce(cleanup_not_before,?)
      WHERE job_id=? AND state IN('moved','stale','failed','cancelled','copying') AND cleanup_released_at IS NULL`)
      .bind(at, actor, new Date(this.clock().getTime() + FILE_JOB_SOURCE_GRACE_MS).toISOString(), id),
      db.prepare(`INSERT INTO file_job_cleanup_grants(job_id,runtime_incarnation,requested_at,actor)
        SELECT ?,incarnation,?,? FROM file_job_runtime_guard WHERE singleton=1 AND enabled=1
        ON CONFLICT(job_id) DO UPDATE SET runtime_incarnation=excluded.runtime_incarnation,
          requested_at=excluded.requested_at,actor=excluded.actor`).bind(id, at, actor),
    ]);
    const status = await this.status(id); if (!status) throw new Error("File job does not exist"); return status;
  }
  async cleanupCopy(incarnation: string): Promise<MigrationCleanupCopy | null> {
    const db = this.database.primary(), hold = this.randomId(), at = this.now();
    const selected = await db.prepare(`SELECT i.job_id,i.file_id FROM file_migration_items i
      JOIN file_publications f ON f.file_id=i.file_id AND f.state='ready' AND f.active_location_id<>i.source_location_id
      WHERE i.state IN('moved','stale','failed','cancelled') AND i.cleanup_requested_at IS NOT NULL AND i.cleanup_released_at IS NULL
      AND EXISTS(SELECT 1 FROM file_job_cleanup_grants approval WHERE approval.job_id=i.job_id AND approval.runtime_incarnation=?)
      AND julianday(i.cleanup_not_before)<=julianday('now')
      AND NOT EXISTS(SELECT 1 FROM file_migration_attempts a JOIN file_location_holds h ON h.location_id=a.location_id
        AND h.operation_id=i.hold_operation_id AND h.released_at IS NULL WHERE a.job_id=i.job_id AND a.file_id=i.file_id AND a.state<>'published')
      AND EXISTS(SELECT 1 FROM file_job_runtime_guard g JOIN file_authority_runtime_guard fg
        ON fg.singleton=g.singleton AND fg.enabled=1 WHERE g.singleton=1 AND g.enabled=1 AND g.incarnation=?)
      ORDER BY i.cleanup_requested_at,i.job_id,i.file_id LIMIT 1`).bind(incarnation, incarnation)
      .first<{ job_id: string; file_id: string }>();
    if (!selected) return null;
    // Pin a current required copy atomically before independent verification.
    await db.prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at,expires_at)
      SELECT ?,f.active_location_id,'read',?,'Source cleanup destination verification',?,?
      FROM file_usable_publications f JOIN file_migration_items i ON i.file_id=f.file_id
      WHERE i.job_id=? AND i.file_id=? AND f.active_location_id<>i.source_location_id AND i.cleanup_released_at IS NULL
        AND EXISTS(SELECT 1 FROM file_job_cleanup_grants approval JOIN file_job_runtime_guard g
          ON g.singleton=1 AND g.enabled=1 AND g.incarnation=approval.runtime_incarnation
          WHERE approval.job_id=i.job_id AND approval.runtime_incarnation=?)`)
      .bind(hold, hold, at, new Date(this.clock().getTime() + FILE_JOB_LEASE_MS).toISOString(), selected.job_id, selected.file_id, incarnation).run();
    return db.prepare(`SELECT i.job_id,i.file_id,i.source_location_id,i.hold_operation_id,
      l.location_id AS active_location_id,l.storage_profile_id AS profile_id,p.configuration_revision,
      l.object_key,i.byte_size,i.sha256,h.id AS verification_hold_id
      FROM file_location_holds h JOIN file_location_publications l ON l.location_id=h.location_id
      JOIN storage_profiles p ON p.id=l.storage_profile_id
      JOIN file_migration_items i ON i.job_id=? AND i.file_id=? WHERE h.id=? AND h.released_at IS NULL`)
      .bind(selected.job_id, selected.file_id, hold).first<MigrationCleanupCopy>();
  }
  async releaseCleanup(copy: MigrationCleanupCopy, incarnation: string) {
    const db = this.database.primary(), at = this.now();
    await db.batch([
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_job_runtime_guard g JOIN file_authority_runtime_guard fg
        ON fg.singleton=g.singleton AND fg.enabled=1 JOIN file_authority_control fc ON fc.singleton=g.singleton AND fc.mode='active'
        WHERE g.singleton=1 AND g.enabled=1 AND g.incarnation=?) AND EXISTS(SELECT 1 FROM file_job_cleanup_grants approval
          WHERE approval.job_id=? AND approval.runtime_incarnation=?) AND EXISTS(SELECT 1 FROM file_usable_publications f
        JOIN file_location_holds h ON h.location_id=f.active_location_id AND h.id=? AND h.released_at IS NULL
        AND julianday(h.expires_at)>julianday('now') WHERE f.file_id=? AND f.active_location_id=?
        AND f.verified_sha256=? AND f.verified_byte_size=?) THEN 1 ELSE json('Required cleanup copy changed') END`)
        .bind(incarnation, copy.job_id, incarnation, copy.verification_hold_id, copy.file_id, copy.active_location_id, copy.sha256, copy.byte_size),
      db.prepare(`UPDATE file_location_holds SET released_at=? WHERE location_id=? AND operation_id=?
        AND released_at IS NULL AND NOT EXISTS(SELECT 1 FROM file_migration_attempts a
          WHERE a.job_id=? AND a.file_id=? AND a.state IN('write_started','unknown'))`)
        .bind(at, copy.source_location_id, copy.hold_operation_id, copy.job_id, copy.file_id),
      db.prepare(`UPDATE file_migration_items SET cleanup_released_at=? WHERE job_id=? AND file_id=?
        AND cleanup_requested_at IS NOT NULL AND julianday(cleanup_not_before)<=julianday('now')
        AND NOT EXISTS(SELECT 1 FROM file_location_holds h WHERE h.location_id=? AND h.operation_id=? AND h.released_at IS NULL)`)
        .bind(at, copy.job_id, copy.file_id, copy.source_location_id, copy.hold_operation_id),
    ]);
    return !!await this.database.primary().prepare("SELECT 1 AS released FROM file_migration_items WHERE job_id=? AND file_id=? AND cleanup_released_at IS NOT NULL")
      .bind(copy.job_id, copy.file_id).first();
  }
  async releaseVerificationHold(copy: MigrationCleanupCopy) {
    await this.database.primary().prepare("UPDATE file_location_holds SET released_at=? WHERE id=? AND released_at IS NULL")
      .bind(this.now(), copy.verification_hold_id).run();
  }
  async inventory(input: { profileId?: string; cursor?: string; limit: number }): Promise<FileMigrationInventory> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error("Invalid File page limit");
    const rows = await this.database.primary().prepare(`SELECT f.file_id,f.purpose,f.active_location_id AS source_location_id,
      l.storage_profile_id AS source_profile_id,f.verified_byte_size AS byte_size,f.verified_sha256 AS sha256
      FROM file_usable_publications f JOIN file_location_publications l ON l.location_id=f.active_location_id
      WHERE f.access_scope='system' AND f.file_id>? AND (? IS NULL OR l.storage_profile_id=?)
      ORDER BY f.file_id LIMIT ?`).bind(input.cursor ?? "", input.profileId ?? null, input.profileId ?? null, input.limit + 1)
      .all<{ file_id: string; purpose: FilePurpose; source_location_id: string; source_profile_id: string; byte_size: number; sha256: string }>();
    const visible = rows.results.slice(0, input.limit);
    return { items: visible.map(row => ({ fileId: row.file_id, purpose: row.purpose, locationId: row.source_location_id,
      profileId: row.source_profile_id, byteSize: row.byte_size, sha256: row.sha256 })),
      nextCursor: rows.results.length > input.limit ? visible.at(-1)!.file_id : null };
  }
  async items(id: string, cursor = ""): Promise<FileMigrationItems> {
    const rows = await this.database.primary().prepare(`SELECT i.*,
      (SELECT id FROM file_migration_attempts a WHERE a.job_id=i.job_id AND a.file_id=i.file_id ORDER BY generation DESC,created_at DESC,id DESC LIMIT 1) AS attempt_id,
      (SELECT state FROM file_migration_attempts a WHERE a.job_id=i.job_id AND a.file_id=i.file_id ORDER BY generation DESC,created_at DESC,id DESC LIMIT 1) AS attempt_state,
      (SELECT io_settled_at FROM file_migration_attempts a WHERE a.job_id=i.job_id AND a.file_id=i.file_id ORDER BY generation DESC,created_at DESC,id DESC LIMIT 1) AS attempt_settled,
      (SELECT count(*) FROM file_migration_attempts a WHERE a.job_id=i.job_id AND a.file_id=i.file_id) AS attempt_count,
      (SELECT count(*) FROM file_migration_attempts a WHERE a.job_id=i.job_id AND a.file_id=i.file_id AND a.state<>'published'
        AND ((a.write_started_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_location_gc_ledger g
          WHERE g.location_id=a.location_id AND g.state='deleted'))
          OR EXISTS(SELECT 1 FROM file_location_holds h WHERE h.location_id=a.location_id
            AND h.operation_id=i.hold_operation_id AND h.released_at IS NULL))) AS artifact_cleanup_pending,
      EXISTS(SELECT 1 FROM file_location_gc_ledger g WHERE g.location_id=i.source_location_id AND g.state='deleted') AS source_deleted
      FROM file_migration_items i WHERE i.job_id=? AND i.file_id>? ORDER BY i.file_id LIMIT 101`)
      .bind(id, cursor).all<Record<string, unknown>>();
    const visible = rows.results.slice(0, 100);
    return { items: visible.map(row => {
      const artifactCleanupPending = Number(row.artifact_cleanup_pending);
      const sourceCleanupPending = (row.state === 'moved' || row.state === 'stale') && row.source_deleted !== 1;
      const cleanupState: FileMigrationItemStatus['cleanupState'] = row.source_deleted === 1 && !artifactCleanupPending ? 'deleted'
        : row.cleanup_requested_at && !sourceCleanupPending && !artifactCleanupPending ? 'complete'
        : !row.cleanup_requested_at ? 'not_requested'
        : Date.parse(String(row.cleanup_not_before)) > this.clock().getTime() ? 'waiting_grace'
        : row.cleanup_released_at ? 'released_to_gc' : 'pending';
      return { fileId: String(row.file_id), purpose: row.purpose as FilePurpose,
      state: row.state as FileMigrationItemStatus["state"], reason: row.reason as string | null,
      sourceLocationId: String(row.source_location_id), sourceProfileId: String(row.source_profile_id),
      destinationLocationId: row.destination_location_id as string | null, byteSize: Number(row.byte_size), sha256: String(row.sha256),
      attempt: row.attempt_id ? { id: String(row.attempt_id), state: String(row.attempt_state), settled: row.attempt_settled !== null } : null,
      attemptState: row.attempt_state as string | null,
      attemptCount: Number(row.attempt_count), maxAttempts: 5,
      artifactCleanupPending, sourceCleanupPending, cleanupState,
      cleanup: { requestedAt: row.cleanup_requested_at as string | null, notBefore: row.cleanup_not_before as string | null,
        releasedToGcAt: row.cleanup_released_at as string | null, deleted: row.source_deleted === 1 } } }),
      hasMore: false };
  }
  async runtimeEnabled(incarnation: string) {
    return !!await this.database.primary().prepare(`SELECT 1 AS enabled FROM file_job_runtime_guard g
      JOIN file_authority_runtime_guard fg ON fg.singleton=g.singleton AND fg.enabled=1
      JOIN file_authority_control fc ON fc.singleton=g.singleton AND fc.mode='active'
      WHERE g.singleton=1 AND g.enabled=1 AND g.incarnation=?`).bind(incarnation).first();
  }
  async cleanupGranted(jobId: string, incarnation: string) {
    return await this.runtimeEnabled(incarnation) && !!await this.database.primary().prepare(`SELECT 1 AS granted
      FROM file_job_cleanup_grants WHERE job_id=? AND runtime_incarnation=?`).bind(jobId, incarnation).first();
  }
  async releaseUnneededSource(incarnation: string) {
    if (!await this.runtimeEnabled(incarnation)) return false;
    const db = this.database.primary(), at = this.now();
    const released = await db.prepare(`UPDATE file_location_holds SET released_at=? WHERE operation_id IN(
      SELECT i.hold_operation_id FROM file_migration_items i JOIN file_publications f ON f.file_id=i.file_id AND f.state='retired'
      WHERE i.cleanup_requested_at IS NOT NULL AND i.cleanup_released_at IS NULL AND julianday(i.cleanup_not_before)<=julianday('now')
        AND EXISTS(SELECT 1 FROM file_job_cleanup_grants approval WHERE approval.job_id=i.job_id AND approval.runtime_incarnation=?)
        AND NOT EXISTS(SELECT 1 FROM file_retention_edges e WHERE e.file_id=i.file_id)
        AND NOT EXISTS(SELECT 1 FROM file_holds h WHERE h.file_id=i.file_id AND h.released_at IS NULL
          AND (h.expires_at IS NULL OR julianday(h.expires_at)>julianday('now')))
        AND NOT EXISTS(SELECT 1 FROM file_migration_attempts a JOIN file_location_holds h ON h.location_id=a.location_id
          AND h.operation_id=i.hold_operation_id AND h.released_at IS NULL WHERE a.job_id=i.job_id AND a.file_id=i.file_id AND a.state<>'published')
        AND EXISTS(SELECT 1 FROM file_location_holds h WHERE h.operation_id=i.hold_operation_id
          AND h.hold_kind='transition_source' AND h.released_at IS NULL)
        AND EXISTS(SELECT 1 FROM file_job_runtime_guard g JOIN file_authority_runtime_guard fg
          ON fg.singleton=g.singleton AND fg.enabled=1 JOIN file_authority_control fc
          ON fc.singleton=g.singleton AND fc.mode='active' WHERE g.singleton=1 AND g.enabled=1 AND g.incarnation=?)
      ORDER BY i.cleanup_requested_at,i.job_id,i.file_id LIMIT 1)
      AND hold_kind='transition_source' AND released_at IS NULL RETURNING operation_id`)
      .bind(at, incarnation, incarnation).first<{ operation_id: string }>();
    if (!released) return false;
    await db.prepare("UPDATE file_migration_items SET cleanup_released_at=? WHERE hold_operation_id=?")
      .bind(at, released.operation_id).run();
    return true;
  }
  async cleanupArtifact(incarnation: string): Promise<MigrationCleanupArtifact | null> {
    if (!await this.runtimeEnabled(incarnation)) return null;
    return this.database.primary().prepare(`SELECT a.*,j.target_profile_id AS profile_id,
      j.target_configuration_revision AS configuration_revision,j.target_namespace AS namespace_identity,
      i.byte_size,i.sha256,i.hold_operation_id FROM file_migration_attempts a
      JOIN file_migration_items i ON i.job_id=a.job_id AND i.file_id=a.file_id
      JOIN file_migration_jobs j ON j.id=a.job_id
      JOIN file_location_holds h ON h.location_id=a.location_id AND h.operation_id=i.hold_operation_id AND h.released_at IS NULL
      WHERE i.cleanup_requested_at IS NOT NULL AND julianday(i.cleanup_not_before)<=julianday('now')
        AND EXISTS(SELECT 1 FROM file_job_cleanup_grants approval WHERE approval.job_id=i.job_id AND approval.runtime_incarnation=?)
        AND (j.state='cancelled' OR i.state IN('failed','stale','cancelled','moved')) AND a.state<>'published'
        AND NOT EXISTS(SELECT 1 FROM file_location_publications p WHERE p.location_id=a.location_id)
      ORDER BY i.cleanup_requested_at,a.created_at,a.id LIMIT 1`).bind(incarnation).first<MigrationCleanupArtifact>();
  }
  async releaseArtifact(artifact: MigrationCleanupArtifact, incarnation: string) {
    const db = this.database.primary(), at = this.now();
    await db.batch([
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_job_runtime_guard g JOIN file_authority_runtime_guard fg
        ON fg.singleton=g.singleton AND fg.enabled=1 JOIN file_authority_control fc ON fc.singleton=g.singleton AND fc.mode='active'
        WHERE g.singleton=1 AND g.enabled=1 AND g.incarnation=?) AND EXISTS(SELECT 1 FROM file_job_cleanup_grants approval
          WHERE approval.job_id=? AND approval.runtime_incarnation=?) AND EXISTS(SELECT 1 FROM file_migration_attempts a
        WHERE a.id=? AND (a.io_settled_at IS NOT NULL OR a.write_started_at IS NULL)
        AND a.state<>'published' AND NOT EXISTS(SELECT 1 FROM file_location_publications p WHERE p.location_id=a.location_id))
        THEN 1 ELSE json('Migration artifact is not safely settled') END`).bind(incarnation, artifact.job_id, incarnation, artifact.id),
      db.prepare("UPDATE file_migration_attempts SET state='cancelled',updated_at=? WHERE id=?").bind(at, artifact.id),
      db.prepare("UPDATE file_location_holds SET released_at=? WHERE location_id=? AND operation_id=? AND released_at IS NULL")
        .bind(at, artifact.location_id, artifact.hold_operation_id),
      // An unchanged active source remains protected by the authoritative
      // pointer. A previous source instead needs protected-copy verification.
      db.prepare(`UPDATE file_location_holds SET released_at=? WHERE operation_id=? AND hold_kind='transition_source'
        AND released_at IS NULL AND EXISTS(SELECT 1 FROM file_publications f WHERE f.file_id=? AND
          (f.active_location_id=file_location_holds.location_id OR f.state='retired'))
        AND NOT EXISTS(SELECT 1 FROM file_migration_attempts a JOIN file_location_holds h ON h.location_id=a.location_id
          AND h.operation_id=? AND h.released_at IS NULL WHERE a.job_id=? AND a.file_id=? AND a.state<>'published')`)
        .bind(at, artifact.hold_operation_id, artifact.file_id, artifact.hold_operation_id, artifact.job_id, artifact.file_id),
      db.prepare(`UPDATE file_migration_items SET state=CASE WHEN state='copying' THEN 'cancelled' ELSE state END,
        cleanup_released_at=CASE WHEN NOT EXISTS(SELECT 1 FROM file_location_holds h
          WHERE h.operation_id=file_migration_items.hold_operation_id AND h.released_at IS NULL) THEN ? ELSE cleanup_released_at END
        WHERE job_id=? AND file_id=?`).bind(at, artifact.job_id, artifact.file_id),
    ]);
  }
}
