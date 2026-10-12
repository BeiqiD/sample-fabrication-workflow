import type { ReadSqlRow, ReadSqlStatement } from "../runtime/read-sql";
import type { ReferenceSourceReadDatabase } from "../references/read-resolver";
export type ProjectSnapshotProjection = "project" | "contents" | "attachments" | "items" | "placements" | "edges" | "registry";

/** Only code-owned SELECT projections. No mutation/DDL/primary capability. */
export interface ProjectReadDatabase extends ReferenceSourceReadDatabase {
  readBatch(statements: readonly ReadSqlStatement[]): Promise<{ results: ReadSqlRow[] }[]>;
  /** Optional owned policy projection. The default Worker retains exact SQL. */
  projectSnapshotStatement?(projection: ProjectSnapshotProjection, sql: string): ReadSqlStatement;
}
export function projectSnapshotStatement(db: ProjectReadDatabase, projection: ProjectSnapshotProjection, sql: string): ReadSqlStatement {
  return db.projectSnapshotStatement ? db.projectSnapshotStatement(projection, sql) : db.prepare(sql);
}
export function projectReadSql(sql: string): string {
  // This domain uses existing SELECT statements only, including JSON read joins.
  // The genuine driver still owns single-statement parsing and transactions.
  if (!/^\s*SELECT\b/i.test(sql)) throw new TypeError("Project reads require a code-owned SELECT");
  return sql;
}
