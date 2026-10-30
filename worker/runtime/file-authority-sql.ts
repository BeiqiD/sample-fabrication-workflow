import type { ConfigurationSqlCell, ConfigurationSqlRow } from "./configuration-sql";

/** Reuse the existing exact SQL-cell boundary without widening configuration's
 * mutation-only transaction contract. Domain integer conversion happens only
 * after a particular File field has been checked. */
export type FileAuthoritySqlCell = ConfigurationSqlCell;
export type FileAuthoritySqlRow = ConfigurationSqlRow;
export interface FileAuthoritySqlResult {
  success: true;
  results: FileAuthoritySqlRow[];
}
export interface FileAuthoritySqlStatement {
  bind(...values: FileAuthoritySqlCell[]): FileAuthoritySqlStatement;
  first(): Promise<FileAuthoritySqlRow | null>;
  all(): Promise<FileAuthoritySqlResult>;
  run(): Promise<FileAuthoritySqlResult>;
}
/** The accepted File pipeline prepares code-owned SELECT fences, mutations,
 * and a final selected receipt in one atomic batch. This is a view of the
 * existing native engine, never a separate transaction/acceptance protocol. */
export interface FileAuthoritySqlDatabase {
  prepare(sql: string): FileAuthoritySqlStatement;
  batch(statements: readonly FileAuthoritySqlStatement[]): Promise<FileAuthoritySqlResult[]>;
  primary(): FileAuthoritySqlDatabase;
}
