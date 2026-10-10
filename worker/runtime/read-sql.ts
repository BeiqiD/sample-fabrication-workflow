import type { ConfigurationSqlCell, ConfigurationSqlRow } from "./configuration-sql";

export type ReadSqlCell = ConfigurationSqlCell;
export type ReadSqlRow = ConfigurationSqlRow;
export interface ReadSqlStatement {
  bind(...values: ReadSqlCell[]): ReadSqlStatement;
  first(): Promise<ReadSqlRow | null>;
  all(): Promise<{ results: ReadSqlRow[] }>;
}
/** Narrow consumer surface for code-owned audited read queries. This interface
 * does not enforce physical read-only authority or admit caller-supplied SQL.
 * Genuine adapters keep exact cells and their underlying statement ownership. */
export interface ReadSqlDatabase {
  prepare(sql: string): ReadSqlStatement;
}
