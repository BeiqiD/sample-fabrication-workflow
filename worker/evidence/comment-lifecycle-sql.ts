import type { ReadSqlCell, ReadSqlRow } from "../runtime/read-sql";

/** Code-owned mature SQL result types only. These annotations are not an
 * admission policy and never give a structural database resource authority. */
export interface CommentLifecycleStatement {
  bind(...values: ReadSqlCell[]): CommentLifecycleStatement;
  first<T extends object = ReadSqlRow>(): Promise<T | null>;
  all<T extends object = ReadSqlRow>(): Promise<{results: T[]}>;
}
export interface CommentLifecycleResult { readonly results: ReadSqlRow[] }
export interface CommentLifecycleDatabase {
  prepare(sql: string): CommentLifecycleStatement;
  atomicBatch(statements: readonly CommentLifecycleStatement[]): Promise<CommentLifecycleResult[]>;
}
