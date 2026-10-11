const MAX_BOUND_PARAMETERS = 100;

export function chunkRows<T>(rows: T[][], columnsPerRow: number) {
  if (columnsPerRow < 1 || columnsPerRow > MAX_BOUND_PARAMETERS) throw new Error("Invalid bulk insert width");
  const rowsPerStatement = Math.floor(MAX_BOUND_PARAMETERS / columnsPerRow);
  const chunks: T[][][] = [];
  for (let index = 0; index < rows.length; index += rowsPerStatement) chunks.push(rows.slice(index, index + rowsPerStatement));
  return chunks;
}
