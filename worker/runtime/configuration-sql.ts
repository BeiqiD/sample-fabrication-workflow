/** Exact SQL cells cross the adapter boundary. Domain integer conversion occurs
 * only after a particular field has been checked, never across whole rows. */
export type ConfigurationSqlCell = null | string | number | bigint | Uint8Array;
export type ConfigurationSqlRow = Record<string, ConfigurationSqlCell>;
export interface ConfigurationSqlStatement {
  bind(...values: ConfigurationSqlCell[]): ConfigurationSqlStatement;
  first(): Promise<ConfigurationSqlRow | null>;
  all(): Promise<{ results: ConfigurationSqlRow[] }>;
}
export interface ConfigurationSqlWriteResult {
  /** Top-level statement changes only; trigger-inclusive totals are different. */
  directChanges: number;
}
export interface ConfigurationSqlDatabase {
  prepare(sql: string): ConfigurationSqlStatement;
  /** This domain batches top-level mutations only. Read/DDL/CTE statements are
   * not admitted here; reads use first/all and schema belongs to the installer. */
  batch(statements: readonly ConfigurationSqlStatement[]): Promise<ConfigurationSqlWriteResult[]>;
  /** Fresh primary selection for authority and uncertain acknowledgement reads. */
  primary(): ConfigurationSqlDatabase;
}
export function configurationSqlMutation(sql: string): boolean {
  return /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
}
export function configurationSqlInteger(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== "number" && typeof value !== "bigint") throw new TypeError(`Invalid SQL integer: ${field}`);
  const converted = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(converted) || converted < minimum || typeof value === "bigint" && BigInt(converted) !== value) {
    throw new RangeError(`SQL integer outside exact domain range: ${field}`);
  }
  return converted;
}
export function configurationSqlCell(value: unknown): ConfigurationSqlCell {
  if (value === null || typeof value === "string" || typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new TypeError("Invalid or inexact SQL cell");
}
export function configurationSqlRow(value: Record<string, unknown>): ConfigurationSqlRow {
  return Object.fromEntries(Object.entries(value).map(([name, cell]) => [name, configurationSqlCell(cell)]));
}
