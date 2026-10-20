/** SQLite rowids span signed int64. Preserve their decimal spelling across
 * JSON/D1 boundaries instead of passing them through JavaScript numbers. */
export function isFileShadowRowid(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 20 || !/^-?(?:0|[1-9][0-9]*)$/.test(value)) return false;
  const rowid = BigInt(value);
  return rowid >= -(1n << 63n) && rowid < (1n << 63n) && rowid.toString() === value;
}

export function isFileShadowRowidColumn(table: string, column: string): boolean {
  return column === "source_rowid" && (table === "file_shadow_occurrences" || table === "file_shadow_heads");
}

/** The archive and restore readback must use the same lossless wire projection. */
export function fileShadowArchiveColumn(table: string, column: string): string {
  const name = `"${column.replaceAll('"', '""')}"`;
  return isFileShadowRowidColumn(table, column) ? `CAST(${name} AS TEXT) AS ${name}` : name;
}
