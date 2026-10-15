import type { NativeExportSnapshotReader } from "../worker/export-v24-core";
import { checkedSafeInteger, type SqliteCapability } from "./sqlite";

/** The native core retains int64/BLOB cells. The existing business export has
 * safe Number cells and decimal rowid SQL, so every integer conversion checks. */
export function createNodeExportSnapshotReader(database: SqliteCapability): NativeExportSnapshotReader {
  return {
    async readBatch(sql) {
      const current = database.primary();
      return (await current.batch(sql.map(value => current.prepare(value)))).map(result => ({ success: result.success,
        results: result.results.map(row => Object.fromEntries(Object.entries(row).map(([column, cell]) =>
          [column, typeof cell === "bigint" ? checkedSafeInteger(cell, `Export column ${column}`) : cell]))) }));
    },
  };
}
