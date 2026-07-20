const MAX_BOUND_PARAMETERS = 100;

export function chunkRows<T>(rows: T[][], columnsPerRow: number) {
  if (columnsPerRow < 1 || columnsPerRow > MAX_BOUND_PARAMETERS) throw new Error("Invalid bulk insert width");
  const rowsPerStatement = Math.floor(MAX_BOUND_PARAMETERS / columnsPerRow);
  const chunks: T[][][] = [];
  for (let index = 0; index < rows.length; index += rowsPerStatement) chunks.push(rows.slice(index, index + rowsPerStatement));
  return chunks;
}

export function bulkInsertStatements(
  db: D1Database,
  table: string,
  columns: string[],
  rows: unknown[][],
) {
  if (!rows.length) return [];
  if (!/^[a-z_]+$/.test(table) || columns.some((column) => !/^[a-z_]+$/.test(column))) throw new Error("Unsafe bulk insert identifier");
  if (rows.some((row) => row.length !== columns.length)) throw new Error("Bulk insert row width mismatch");
  return chunkRows(rows, columns.length).map((chunk) => {
    const placeholders = chunk.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
    return db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders}`).bind(...chunk.flat());
  });
}
