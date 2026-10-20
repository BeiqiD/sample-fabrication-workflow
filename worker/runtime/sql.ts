/** Only the SQL capability actually needed by health/readiness in this slice. */
export interface ReadinessStatement {
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface ReadinessDatabase {
  prepare(sql: string): ReadinessStatement;
}
