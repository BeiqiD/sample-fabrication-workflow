import type { ReadSqlCell, ReadSqlRow } from "../runtime/read-sql";

/** Execution-owned statements only: no standalone execution, configuration
 * publication, Project read-batch, provider or caller-supplied SQL capability. */
export interface StepConfirmationStatement {
  bind(...values: ReadSqlCell[]): StepConfirmationStatement;
}
export interface StepConfirmationResult { results: ReadSqlRow[] }
export interface StepConfirmationDatabase {
  prepare(sql: string): StepConfirmationStatement;
  /** One actual atomic batch, including the first WITH/UPDATE/RETURNING result.
   * Exact cells remain exact; the service consumes only the returned text IDs.
   * This narrow interface is for audited code-owned SQL, not an SQL firewall. */
  atomicBatch(statements: readonly StepConfirmationStatement[]): Promise<StepConfirmationResult[]>;
}
