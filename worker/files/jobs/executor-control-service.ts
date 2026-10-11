import { HTTPException } from "hono/http-exception";
import type { JobSqlDatabase } from "./sql-repository";
import type { FileJobRepository } from "./types";

export async function setFileJobExecutionWithDatabase(database: JobSqlDatabase, repository: Pick<FileJobRepository, "executorStatus">, enabled: boolean,
  clock: () => Date = () => new Date(), randomId: () => string = () => crypto.randomUUID()) {
  const db = database.primary(), incarnation = enabled ? randomId() : null, at = clock().toISOString();
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
  return repository.executorStatus();
}
