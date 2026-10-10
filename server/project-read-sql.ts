import type { ReadSqlStatement } from "../worker/runtime/read-sql";
import { configurationSqlRow } from "../worker/runtime/configuration-sql";
import { projectReadSql, type ProjectReadDatabase } from "../worker/projects/read-sql";
import type { SqliteCapability, SqliteStatement } from "./sqlite";

/** Genuine owned core, exact cells, and its existing atomic batch transaction.
 * No Node-native transaction/driver is duplicated by the Project read view. */
export function asProjectReadDatabase(core: SqliteCapability): ProjectReadDatabase {
  const statements = new WeakMap<ReadSqlStatement, SqliteStatement>();
  const wrap = (native: SqliteStatement): ReadSqlStatement => {
    const statement: ReadSqlStatement = {
      bind(...values) { return wrap(native.bind(...values)); },
      async first() { const row = await native.first(); return row === null ? null : configurationSqlRow(row); },
      async all() { return { results: (await native.all()).results.map(configurationSqlRow) }; },
    };
    statements.set(statement, native); return statement;
  };
  return {
    prepare(sql) { return wrap(core.prepare(projectReadSql(sql))); },
    async readBatch(items) {
      const native = items.map(item => { const value = statements.get(item); if (!value) throw new Error("Foreign Project read statement"); return value; });
      const results = await core.batch(native);
      if (results.length !== native.length) throw new Error("Incomplete Project snapshot read acknowledgement");
      return results.map(result => ({ results: result.results.map(configurationSqlRow) }));
    },
  };
}
