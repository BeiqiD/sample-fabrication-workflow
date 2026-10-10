import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { primaryD1 } from "../d1-primary";
import { assertSystemAdministrator } from "../storage/system-administrator";
import type { Env } from "../types";
import { checkedSystemRecoveryMaintenanceInput, checkedSystemRecoveryMaintenanceStatus,
  type SystemRecoveryMaintenanceInput, type SystemRecoveryMaintenanceReceipt } from "../../shared/contracts/system-recovery";

export interface SourceMaintenance {
  state: "open" | "draining" | "fenced";
  generation: number;
  token: string | null;
  checkpoint: string | null;
  backupJobId: string | null;
  activeWriters: number;
}
export interface SourceWriteLease { id: string; generation: number }
const conflict = (message: string) => new HTTPException(409, { message });
function configured(env: Env) { return Boolean(env.RECOVERY_DB || env.RECOVERY_TARGET_ID); }
async function installed(env: Env): Promise<boolean> {
  const table = await primaryD1(env.DB).prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='system_recovery_maintenance'")
    .first<{ present: number }>();
  if (table?.present === 1) return true;
  if (configured(env)) throw new HTTPException(503, { message: "System recovery maintenance state is unavailable" });
  return false;
}
function generation(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new HTTPException(400, { message: "Invalid source maintenance revision" });
}
function digest(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new HTTPException(400, { message: "Invalid source checkpoint" });
}

export async function readSourceMaintenance(env: Env): Promise<SourceMaintenance> {
  if (!await installed(env)) return { state: "open", generation: 0, token: null, checkpoint: null, backupJobId: null, activeWriters: 0 };
  const db = primaryD1(env.DB);
  const result = await db.batch([
    db.prepare("SELECT state,generation,token,checkpoint_sha256,backup_job_id FROM system_recovery_maintenance WHERE singleton=1"),
    db.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL"),
  ]);
  const row = result[0]?.results?.[0] as { state: SourceMaintenance["state"]; generation: number; token: string | null; checkpoint_sha256: string | null; backup_job_id: string | null } | undefined;
  const writers = (result[1]?.results as { n: number }[] | undefined)?.[0]?.n;
  if (result.length !== 2 || result.some(item => !item.success) || !row || !["open", "draining", "fenced"].includes(row.state)
    || !Number.isSafeInteger(row.generation) || row.generation < 0 || !Number.isSafeInteger(writers) || writers! < 0)
    throw new HTTPException(503, { message: "System recovery maintenance state is unavailable" });
  return { state: row.state, generation: row.generation, token: row.token, checkpoint: row.checkpoint_sha256,
    backupJobId: row.backup_job_id, activeWriters: writers! };
}

/** Lease creation and the open-state predicate are one SQLite write. There is
 * no read-then-admit race with an administrator entering maintenance. Expiry is
 * diagnostic only: it cannot establish settlement of an outstanding writer. */
export async function acquireSourceWriteLease(env: Env, owner: string, kind: "http" | "scheduled"): Promise<SourceWriteLease | null> {
  if (!await installed(env)) return null;
  const id = crypto.randomUUID(), now = new Date(), expires = new Date(now.getTime() + 300_000).toISOString();
  const row = await primaryD1(env.DB).prepare(`INSERT INTO system_recovery_write_leases(id,owner,kind,generation,created_at,expires_at)
    SELECT ?,?,?,generation,?,? FROM system_recovery_maintenance WHERE singleton=1 AND state='open' RETURNING id,generation`)
    .bind(id, owner, kind, now.toISOString(), expires).first<{ id: string; generation: number }>();
  if (!row) throw new HTTPException(503, { message: "Source mutations are paused for system recovery" });
  return row;
}

export async function releaseSourceWriteLease(env: Env, lease: SourceWriteLease | null): Promise<void> {
  if (!lease) return;
  await primaryD1(env.DB).prepare("UPDATE system_recovery_write_leases SET released_at=? WHERE id=? AND generation=? AND released_at IS NULL")
    .bind(new Date().toISOString(), lease.id, lease.generation).run();
}

export async function sourceMaintenanceReceipt(env: Env, actor: string, requestId: string): Promise<SystemRecoveryMaintenanceReceipt | null> {
  assertSystemAdministrator(env, actor);
  const row = await primaryD1(env.DB).prepare("SELECT actor,action,expected_generation,result_json FROM system_recovery_maintenance_requests WHERE request_id=?")
    .bind(requestId).first<{ actor: string; action: SystemRecoveryMaintenanceInput["action"]; expected_generation: number; result_json: string }>();
  if (!row) return null;
  if (row.actor !== actor) throw conflict("This maintenance request belongs to another administrator");
  return { requestId, action: row.action, expectedGeneration: row.expected_generation,
    status: checkedSystemRecoveryMaintenanceStatus(JSON.parse(row.result_json)) };
}

/** The state CAS and exact request receipt commit together. A lost response is
 * reconciled by its request ID, never guessed from a later maintenance state. */
export async function controlSourceMaintenance(env: Env, actor: string, raw: SystemRecoveryMaintenanceInput): Promise<SystemRecoveryMaintenanceReceipt> {
  assertSystemAdministrator(env, actor);
  const input = checkedSystemRecoveryMaintenanceInput(raw); generation(input.expectedGeneration);
  if (!await installed(env)) throw conflict("Install the reviewed recovery schema before changing maintenance state");
  if (input.action === "enter" && !configured(env)) throw conflict("Configure an isolated recovery target before pausing source writes");
  const prior = await sourceMaintenanceReceipt(env, actor, input.requestId);
  if (prior) {
    if (prior.action !== input.action || prior.expectedGeneration !== input.expectedGeneration) throw conflict("Maintenance request ID was already used with different input");
    return prior;
  }
  const db = primaryD1(env.DB), now = new Date().toISOString();
  const allowedState = input.action === "enter" ? "state='open'" : input.action === "finalize" ? "state='draining'" : "state IN('draining','fenced')";
  // A deadline is not proof that a provider PUT stopped. Even an intent which
  // might still receive bytes must be settled/cancelled before a planned fence.
  const drained = input.action === "finalize" ? `AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM file_shadow_attempts WHERE state IN('write_started','unknown'))
    AND NOT EXISTS(SELECT 1 FROM file_migration_attempts WHERE state IN('write_started','unknown'))
    AND NOT EXISTS(SELECT 1 FROM research_package_attempts WHERE state IN('write_started','unknown'))
    AND NOT EXISTS(SELECT 1 FROM r2_upload_requests WHERE status='pending')
    AND NOT EXISTS(SELECT 1 FROM metrology_reference_upload_requests WHERE status='pending')
    AND NOT EXISTS(SELECT 1 FROM comment_submission_acceptances WHERE status='pending')
    AND NOT EXISTS(SELECT 1 FROM import_file_acceptances WHERE status='pending')
    AND NOT EXISTS(SELECT 1 FROM system_storage_candidate_checks WHERE status='running' OR cleanup_outcome='running' OR write_outcome='unknown')` : "";
  const update = input.action === "enter"
    ? db.prepare(`UPDATE system_recovery_maintenance SET state='draining',generation=generation+1,token=?,requested_by=?,
        backup_job_id=NULL,checkpoint_sha256=NULL,started_at=?,fenced_at=NULL,updated_at=? WHERE singleton=1 AND generation=? AND ${allowedState}`)
        .bind(input.requestId, actor, now, now, input.expectedGeneration)
    : input.action === "finalize"
      ? db.prepare("UPDATE system_recovery_maintenance SET state='fenced',fenced_at=?,updated_at=? WHERE singleton=1 AND generation=? AND state='draining'")
        .bind(now, now, input.expectedGeneration)
      : db.prepare(`UPDATE system_recovery_maintenance SET state='open',generation=generation+1,token=NULL,requested_by=NULL,
          backup_job_id=NULL,checkpoint_sha256=NULL,started_at=NULL,fenced_at=NULL,updated_at=? WHERE singleton=1 AND generation=? AND ${allowedState}`)
        .bind(now, input.expectedGeneration);
  try {
    await db.batch([
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_maintenance WHERE singleton=1 AND generation=? AND ${allowedState})
        ${drained} THEN 1 ELSE json('Source maintenance revision changed or writers remain unsettled') END`).bind(input.expectedGeneration),
      update,
      db.prepare(`INSERT INTO system_recovery_maintenance_requests(request_id,actor,action,expected_generation,result_json,created_at)
        SELECT ?,?,?,?,json_object('state',state,'generation',generation,'token',token,'checkpoint',checkpoint_sha256,'backupJobId',backup_job_id,
          'activeWriters',(SELECT count(*) FROM system_recovery_write_leases WHERE released_at IS NULL)),?
        FROM system_recovery_maintenance WHERE singleton=1`)
        .bind(input.requestId, actor, input.action, input.expectedGeneration, now),
    ]);
  } catch {
    // Concurrent duplicate requests may have committed this same exact receipt.
    const receipt = await sourceMaintenanceReceipt(env, actor, input.requestId);
    if (receipt && receipt.action === input.action && receipt.expectedGeneration === input.expectedGeneration) return receipt;
    throw conflict("Source writers remain unsettled or the maintenance revision/request changed");
  }
  const receipt = await sourceMaintenanceReceipt(env, actor, input.requestId);
  if (!receipt) throw new HTTPException(503, { message: "Maintenance receipt is temporarily unavailable; reconcile the same request ID" });
  return receipt;
}

export async function enterSourceMaintenance(env: Env, actor: string, expectedGeneration: number): Promise<SourceMaintenance> {
  return (await controlSourceMaintenance(env, actor, { requestId: crypto.randomUUID(), action: "enter", expectedGeneration })).status;
}
export async function finalizeSourceMaintenance(env: Env, actor: string, expectedGeneration: number): Promise<SourceMaintenance> {
  return (await controlSourceMaintenance(env, actor, { requestId: crypto.randomUUID(), action: "finalize", expectedGeneration })).status;
}
export async function releaseSourceMaintenance(env: Env, actor: string, expectedGeneration: number): Promise<SourceMaintenance> {
  return (await controlSourceMaintenance(env, actor, { requestId: crypto.randomUUID(), action: "release", expectedGeneration })).status;
}

/** Caller computes the checkpoint from the same immutable semantic snapshot as
 * the backup. Local job/lease clocks are not canonical research changes. */
export async function recordSourceCheckpoint(env: Env, jobId: string, sha256: string): Promise<void> {
  digest(sha256);
  const row = await primaryD1(env.DB).prepare(`UPDATE system_recovery_maintenance SET backup_job_id=?,checkpoint_sha256=?,updated_at=?
    WHERE singleton=1 AND state='fenced' AND (backup_job_id IS NULL OR backup_job_id=?)
    AND (checkpoint_sha256 IS NULL OR checkpoint_sha256=?) RETURNING generation`)
    .bind(jobId, sha256, new Date().toISOString(), jobId, sha256).first();
  if (!row) throw conflict("A final source checkpoint requires the current drained maintenance window");
}

/** freshlyComputedSha must be obtained by recapturing the source, not taken from
 * an upload, request argument or a previously stored recovery preview. */
export async function verifySourceCheckpoint(env: Env, jobId: string, freshlyComputedSha: string): Promise<SourceMaintenance> {
  digest(freshlyComputedSha);
  const status = await readSourceMaintenance(env);
  if (status.state !== "fenced" || status.activeWriters !== 0 || status.backupJobId !== jobId || status.checkpoint !== freshlyComputedSha) {
    throw conflict("The final source checkpoint changed; recapture and revalidate before cutover");
  }
  return status;
}

export const sourceMaintenanceAdmission: MiddlewareHandler<{ Bindings: Env; Variables: { userEmail: string } }> = async (c, next) => {
  const readOnlyPost = c.req.method === "POST" && [
    "/api/files/shadow/baseline", "/api/files/shadow/evidence-review",
    "/api/files/shadow/operation", "/api/files/shadow/evidence/prepare",
    "/api/files/shadow/evidence/request", "/api/files/shadow/evidence/revocation/request",
  ].includes(c.req.path);
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method) || readOnlyPost
    || c.req.path === "/api/system-recovery" || c.req.path.startsWith("/api/system-recovery/")) return next();

  // Parsing, local authorization and shape checks retain their zero-I/O boundary.
  // The first execution, not statement construction, admits this whole request.
  const originalEnv = c.env;
  let admission: Promise<SourceWriteLease | null> | undefined;
  let admissionFailure: unknown;
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const admit = () => {
    if (closed) return Promise.reject(new HTTPException(503, { message: "Source request execution is finished" }));
    return admission ??= acquireSourceWriteLease(originalEnv, c.get("userEmail"), "http").catch(error => {
      admissionFailure = error;
      throw error;
    });
  };
  const run = (operation: () => unknown): Promise<unknown> => {
    const work = (async () => { await admit(); return operation(); })();
    pending.add(work);
    // Both rejection and success are consumed here; the caller owns the outcome.
    void work.then(() => { pending.delete(work); }, () => { pending.delete(work); });
    return work;
  };
  const originals = new WeakMap<object, object>();
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property === "bind") return (...args: unknown[]) => wrapStatement(Reflect.apply(value, target, args));
        if (["first", "all", "run", "raw"].includes(String(property))) return (...args: unknown[]) =>
          run(() => Reflect.apply(value, target, args));
        return value.bind(target);
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  };
  const wrapDatabase = (database: D1Database): D1Database => new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "prepare") return (...args: unknown[]) => wrapStatement(Reflect.apply(value, target, args));
      if (property === "withSession") return (...args: unknown[]) => wrapDatabase(Reflect.apply(value, target, args));
      if (property === "batch") return (statements: D1PreparedStatement[]) =>
        run(() => Reflect.apply(value, target, [statements.map(statement => originals.get(statement) ?? statement)]));
      if (property === "exec" || property === "dump") return (...args: unknown[]) =>
        run(() => Reflect.apply(value, target, args));
      return value.bind(target);
    },
  });
  const wrapMultipart = (upload: R2MultipartUpload): R2MultipartUpload => new Proxy(upload, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (["uploadPart", "abort", "complete"].includes(String(property))) return (...args: unknown[]) =>
        run(() => Reflect.apply(value, target, args));
      return value.bind(target);
    },
  });
  const wrapAssets = (bucket: R2Bucket): R2Bucket => new Proxy(bucket, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "resumeMultipartUpload") return (...args: unknown[]) => wrapMultipart(Reflect.apply(value, target, args));
      if (property === "createMultipartUpload") return (...args: unknown[]) =>
        run(async () => wrapMultipart(await Reflect.apply(value, target, args)));
      if (["head", "get", "put", "delete", "list"].includes(String(property))) return (...args: unknown[]) =>
        run(() => Reflect.apply(value, target, args));
      return value.bind(target);
    },
  });
  // Preserve absent bindings in old/test fixtures; no capability is invented.
  const assets = originalEnv.ASSETS;
  const requestEnv = { ...originalEnv, DB: wrapDatabase(originalEnv.DB) };
  if (assets && (typeof assets === "object" || typeof assets === "function")) requestEnv.ASSETS = wrapAssets(assets);
  // Context owns this clone. Shared Env, namespace and auth fields remain exact.
  c.env = requestEnv;
  try {
    await next();
  } finally {
    closed = true;
    // Deadline/response completion is not settlement of an issued binding call.
    // A pending call leaves the exact lease retained until its Promise settles.
    while (pending.size) await Promise.allSettled([...pending]);
    if (admission) {
      const lease = await admission.catch(() => null);
      await releaseSourceWriteLease(originalEnv, lease);
    }
    // Services may translate admission exceptions or detach their first call.
    // Apply the actual source denial only after issued binding calls settle.
    if (admissionFailure instanceof HTTPException && admissionFailure.status === 503) c.res = c.json({ error: admissionFailure.message }, 503);
  }
};

/** All existing scheduled writers must share the same admission/drain lease.
 * The FP5 executor is separate: it may write only owned recovery staging while
 * the source semantic checkpoint is fenced. */
export async function runSourceScheduledWriters(env: Env, scheduledTime: number, write: () => Promise<unknown>): Promise<void> {
  let lease: SourceWriteLease | null;
  try { lease = await acquireSourceWriteLease(env, `scheduled:${scheduledTime}`, "scheduled"); }
  catch (error) { if (error instanceof HTTPException && error.status === 503) return; throw error; }
  try { await write(); } finally { await releaseSourceWriteLease(env, lease); }
}
