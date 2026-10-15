import type { ReadSqlCell, ReadSqlRow, ReadSqlStatement } from "../runtime/read-sql";
/** Finish-owned read and atomic RETURNING result capability. No standalone
 * writes/driver, provider, configuration or confirmation interface widening. */
export interface RunFinishStatement extends ReadSqlStatement {
  bind(...values: ReadSqlCell[]): RunFinishStatement;
}
export interface RunFinishResult { directChanges: number | bigint; results: ReadSqlRow[] }
export interface RunFinishDatabase {
  prepare(sql: string): RunFinishStatement;
  atomicBatch(statements: readonly RunFinishStatement[]): Promise<RunFinishResult[]>;
}
