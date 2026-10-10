import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SqlFileJobRepository, type JobSqlDatabase, type JobSqlStatement } from "../../worker/files/jobs/sql-repository";
import { runFileJobLoop } from "../../worker/files/jobs/migration-kernel";
import type { FileJobCapabilities } from "../../worker/files/jobs/types";
import { randomUUID } from "node:crypto";

export { runFileJobLoop };
export function openNodeFileJobRepository(path: string) {
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true, allowExtension: false });
  database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  const statements = new WeakMap<JobSqlStatement, { sql: string; values: SQLInputValue[] }>();
  const statement = (sql: string, values: SQLInputValue[] = []): JobSqlStatement => {
    const result: JobSqlStatement = {
      bind(...bindings) { return statement(sql, bindings as SQLInputValue[]); },
      async first<T>() { return database.prepare(sql).get(...values) as T ?? null; },
      async all<T>() { return { results: database.prepare(sql).all(...values) as T[] }; },
      async run() { return database.prepare(sql).run(...values); },
    };
    statements.set(result, { sql, values }); return result;
  };
  const sql: JobSqlDatabase = {
    prepare: statement,
    async batch(batch) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = batch.map(item => {
          const bound = statements.get(item); if (!bound) throw new Error("Foreign Node File job statement");
          return database.prepare(bound.sql).all(...bound.values);
        });
        database.exec("COMMIT"); return results;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
    primary() { return sql; },
  };
  return { repository: new SqlFileJobRepository(sql, () => new Date(), randomUUID),
    database, close: () => database.close() };
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
