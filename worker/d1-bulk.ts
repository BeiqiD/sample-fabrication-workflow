import { bulkInsertStatementsWithDatabase } from "./runtime/bulk-insert";
export { chunkRows } from "./runtime/bulk-rows";

export function bulkInsertStatements(db: D1Database, table: string, columns: string[], rows: unknown[][]) {
  return bulkInsertStatementsWithDatabase(db, table, columns, rows);
}
