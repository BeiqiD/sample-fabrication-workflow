import type { ReadSqlDatabase, ReadSqlRow, ReadSqlStatement } from "../runtime/read-sql";

/** Only code-owned SELECT projections. No mutation/DDL/primary capability. */
export interface ProjectReadDatabase extends ReadSqlDatabase {
  readBatch(statements: readonly ReadSqlStatement[]): Promise<{ results: ReadSqlRow[] }[]>;
}
export function projectReadSql(sql: string): string {
  // This domain uses existing SELECT statements only, including JSON read joins.
  // The genuine driver still owns single-statement parsing and transactions.
  if (!/^\s*SELECT\b/i.test(sql)) throw new TypeError("Project reads require a code-owned SELECT");
  return sql;
}
