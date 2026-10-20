import { DatabaseSync } from "node:sqlite";
import { SqlFileJobRepository } from "../../worker/files/jobs/sql-repository";
import { asJobSqlDatabase, createSqliteCapability } from "../../server/sqlite";
import { runFileJobLoop } from "../../worker/files/jobs/migration-kernel";
import type { FileJobCapabilities } from "../../worker/files/jobs/types";
import { randomUUID } from "node:crypto";

export { runFileJobLoop };
export function openNodeFileJobRepository(path: string) {
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true, allowExtension: false });
  let capability;
  try { capability = createSqliteCapability(database, { busyTimeoutMs: 5000 }); }
  catch (error) { database.close(); throw error; }
  const sql = asJobSqlDatabase(capability);
  return { repository: new SqlFileJobRepository(sql, () => new Date(), randomUUID),
    // Existing installation/control callers retain this privileged handle.
    // The shared query capability itself does not expose native transactions.
    database, close: () => capability.close() };
}
export type NodeFileJobBindings = Pick<FileJobCapabilities, "openStorage" | "authorizeAdministrator" | "authorizeSystemCleanup">;
export function enableNodeFileJobs(database: DatabaseSync) {
  const incarnation = randomUUID();
  database.exec("BEGIN IMMEDIATE");
  try {
    const admitted = database.prepare(`SELECT 1 AS admitted FROM file_authority_control c
      JOIN file_authority_runtime_guard g ON g.singleton=c.singleton AND g.enabled=1 WHERE c.singleton=1 AND c.mode='active'`).get();
    if (!admitted) throw new Error("Active enabled File authority is required to enable job execution");
    database.prepare("UPDATE file_job_runtime_guard SET enabled=1,incarnation=?,last_heartbeat_at=NULL WHERE singleton=1").run(incarnation);
    database.prepare("UPDATE file_migration_jobs SET state='paused',reason='executor_reconfigured',generation=generation+1,owner_token=NULL,lease_expires_at=NULL,updated_at=? WHERE state IN('queued','running')")
      .run(new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) { database.exec("ROLLBACK"); throw error; }
  return incarnation;
}
