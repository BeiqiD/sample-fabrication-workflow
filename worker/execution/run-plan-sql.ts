import type { ReadSqlCell, ReadSqlDatabase, ReadSqlStatement } from "../runtime/read-sql";
import { chunkRows } from "../runtime/bulk-rows";
export interface RunPlanStatement extends ReadSqlStatement {
  bind(...values: ReadSqlCell[]): RunPlanStatement;
}
export interface RunPlanResult {
  /** Genuine original D1 meta.changes / native trigger-inclusive delta. Only
   * nonzero acknowledgement is consumed by the mature plan CAS checks. */
  changes: number;
}
export interface RunPlanDatabase extends ReadSqlDatabase {
  prepare(sql: string): RunPlanStatement;
  atomicBatch(statements: readonly RunPlanStatement[]): Promise<RunPlanResult[]>;
}
const SAFE_SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
/** Same mature 100-bound-parameter bulk packing; no wider database interface. */
export function bulkInsertRunPlanStatements(db: RunPlanDatabase, table: string, columns: string[], rows: ReadSqlCell[][]): RunPlanStatement[] {
  if (!rows.length) return [];
  if (!SAFE_SQL_IDENTIFIER.test(table) || columns.some(column => !SAFE_SQL_IDENTIFIER.test(column))) throw new Error("Unsafe bulk insert identifier");
  if (rows.some(row => row.length !== columns.length)) throw new Error("Bulk insert row width mismatch");
  return chunkRows(rows, columns.length).map(chunk => {
    const placeholders = chunk.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
    return db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders}`).bind(...chunk.flat());
  });
}
