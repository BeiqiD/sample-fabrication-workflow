/** Original identifier, row-width and 100-parameter chunking algorithm.
 * Preparing these trusted statements is not a mutation authority grant. */
import { chunkRows } from "./bulk-rows";
export { chunkRows } from "./bulk-rows";
const SAFE_SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;


export function bulkInsertStatementsWithDatabase<Statement>(
  db: { prepare(sql: string): { bind(...values: unknown[]): Statement } },
  table: string,
  columns: string[],
  rows: unknown[][],
) {
  if (!rows.length) return [];
  if (!SAFE_SQL_IDENTIFIER.test(table) || columns.some((column) => !SAFE_SQL_IDENTIFIER.test(column))) throw new Error("Unsafe bulk insert identifier");
  if (rows.some((row) => row.length !== columns.length)) throw new Error("Bulk insert row width mismatch");
  return chunkRows(rows, columns.length).map((chunk) => {
    const placeholders = chunk.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
    return db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders}`).bind(...chunk.flat());
  });
}
