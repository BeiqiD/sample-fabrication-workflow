import { primaryD1 } from "../../d1-primary";
import { HTTPException } from "hono/http-exception";
import { canAdministerSystemSettings } from "../../storage/system-administrator";
import { allowedEmail } from "../../auth";
import type { Env } from "../../types";
import { ensureFileAuthorityExecution } from "../authority-execution";
import { openShadowProfile } from "../shadow-profile";
import { d1FileJobRepository } from "./d1-repository";
import { runFileJobStep, runFileJobCleanupStep } from "./migration-kernel";
import type { FileJobCapabilities } from "./types";

export async function inspectWorkerFileJobRuntime(env: Env): Promise<{ outcome: "available" | "unsupported" | "disabled" | "paused" | "unavailable"; incarnation?: string }> {
  try {
    const db = primaryD1(env.DB);
    const schema = await db.prepare("SELECT count(*) AS installed FROM sqlite_schema WHERE type='table' AND name IN('file_job_runtime_guard','file_job_cleanup_grants','file_authority_runtime_guard','file_authority_control')")
      .first<{ installed: number }>();
    if (schema?.installed !== 4) return { outcome: "unsupported" };
    const row = await db.prepare(`SELECT j.enabled,j.incarnation,c.mode,g.enabled AS file_enabled FROM file_job_runtime_guard j
      JOIN file_authority_control c ON c.singleton=j.singleton JOIN file_authority_runtime_guard g ON g.singleton=j.singleton WHERE j.singleton=1`)
      .first<{ enabled: number; incarnation: string | null; mode: string; file_enabled: number }>();
    if (!row || row.enabled !== 1 || !row.incarnation) return { outcome: "disabled" };
    if (row.mode !== "active" || row.file_enabled !== 1) return { outcome: "paused" };
    if (typeof FixedLengthStream !== "function" || typeof (crypto as Crypto & { DigestStream?: unknown }).DigestStream !== "function") return { outcome: "unsupported" };
    return { outcome: "available", incarnation: row.incarnation };
  } catch { return { outcome: "unavailable" }; }
}
export async function workerFileJobCapabilities(env: Env): Promise<FileJobCapabilities | null> {
  const row = await inspectWorkerFileJobRuntime(env);
  if (row.outcome !== "available" || !row.incarnation) return null;
  return {
    repository: d1FileJobRepository(env.DB), incarnation: row.incarnation,
    now: () => new Date(), randomId: () => crypto.randomUUID(),
    // An accepted background job must retain both current application access
    // and the separate administrator grant. Recheck deployment-owned policy
    // on every claim/request/publication fence, without reusing an old JWT.
    authorizeAdministrator: actor => canAdministerSystemSettings(env, actor)
      && Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) && allowedEmail(actor, env.ALLOWED_EMAILS),
    // This capability is supplied only to the installation's explicitly
    // enabled independent maintenance invocation, never from a job actor.
    authorizeSystemCleanup: () => true,
    async openStorage(target, access, beforeRequest, signal) {
      const profile = await openShadowProfile(env, target, access, { beforeRequest, signal });
      return { namespaceIdentity: profile.storage.namespaceIdentity, adapterType: profile.storage.adapterType,
        reader: profile.reader, writer: profile.writer, createHash: profile.createHash,
        atomicSinglePut: profile.storage.adapterType === "r2" || profile.storage.adapterType === "s3" };
    },
  };
}

/** Independent scheduled entry point. HTTP handlers only persist/control jobs.
 * Composition may await this bounded step in a scheduled event; no production
 * cadence/trigger is installed by this development change. */
export async function dispatchFileJobs(env: Env) {
  const status = await inspectWorkerFileJobRuntime(env);
  if (status.outcome !== "available") return { jobId: null, outcome: status.outcome };
  const capabilities = await workerFileJobCapabilities(env);
  if (!capabilities) return { jobId: null, outcome: "disabled" };
  await ensureFileAuthorityExecution(env.DB);
  const cleanup = await runFileJobCleanupStep(capabilities);
  if (!["idle", "disabled"].includes(cleanup.outcome)) return { jobId: null, outcome: cleanup.outcome };
  return runFileJobStep(capabilities);
}
export async function setFileJobExecution(env: Env, enabled: boolean) {
  const db = primaryD1(env.DB), incarnation = enabled ? crypto.randomUUID() : null, at = new Date().toISOString();
  if (enabled) {
    const admitted = await db.prepare(`SELECT 1 AS admitted FROM file_authority_control c
      JOIN file_authority_runtime_guard g ON g.singleton=c.singleton AND g.enabled=1
      WHERE c.singleton=1 AND c.mode='active'`).first();
    if (!admitted) throw new HTTPException(503, { message: "Active enabled File authority is required to enable job execution" });
  }
  const packagesInstalled=Boolean(await db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='research_package_jobs'").first());
  await db.batch([
    ...(enabled ? [db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_authority_control c
      JOIN file_authority_runtime_guard g ON g.singleton=c.singleton AND g.enabled=1 WHERE c.singleton=1 AND c.mode='active')
      THEN 1 ELSE json('File job enablement lost authority') END`)] : []),
    db.prepare("UPDATE file_job_runtime_guard SET enabled=?,incarnation=?,last_heartbeat_at=NULL WHERE singleton=1")
      .bind(enabled ? 1 : 0, incarnation),
    // Restored queued history must also require an explicit per-job resume.
    // Global enablement is installation admission, not a replay instruction.
    db.prepare("UPDATE file_migration_jobs SET state='paused',reason='executor_reconfigured',generation=generation+1,owner_token=NULL,lease_expires_at=NULL,updated_at=? WHERE state IN('queued','running')")
      .bind(at),
    ...(packagesInstalled?[db.prepare("UPDATE research_package_jobs SET state='paused',reason='executor_reconfigured',generation=generation+1,owner_token=NULL,lease_expires_at=NULL,updated_at=? WHERE state IN('queued','running')").bind(at)]:[]),
  ]);
  return d1FileJobRepository(env.DB).executorStatus();
}
