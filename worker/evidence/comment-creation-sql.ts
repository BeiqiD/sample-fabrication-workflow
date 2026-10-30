import type { ReadSqlCell, ReadSqlRow } from "../runtime/read-sql";

export interface RunStepCommentStatement {
  bind(...values: ReadSqlCell[]): RunStepCommentStatement;
  first(): Promise<ReadSqlRow | null>;
  all(): Promise<{ results: ReadSqlRow[] }>;
}
export interface RunStepCommentResult { readonly results?: unknown }
/** Audited original Evidence statements. RETURNING and its original uncertain
 * acknowledgement shape remain visible to the service; this is not an SQL firewall. */
export interface RunStepCommentDatabase {
  prepare(sql: string): RunStepCommentStatement;
  atomicBatch(items: readonly RunStepCommentStatement[]): Promise<RunStepCommentResult[]>;
}
