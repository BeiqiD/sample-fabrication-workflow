import type { ReadSqlCell, ReadSqlStatement } from "../runtime/read-sql";
import { configurationSqlCell, configurationSqlInteger, configurationSqlRow } from "../runtime/configuration-sql";
import { primaryD1 } from "../d1-primary";
import { projectReadSql, type ProjectReadDatabase } from "./read-sql";

/** Actual Worker binding only. Node never fabricates D1 for this view. */
export function d1ProjectReadDatabase(database: D1Database): ProjectReadDatabase {
  const source = primaryD1(database);
  const statements = new WeakMap<ReadSqlStatement, D1PreparedStatement>();
  const wrap = (native: D1PreparedStatement): ReadSqlStatement => {
    const statement: ReadSqlStatement = {
      bind(...values: ReadSqlCell[]) {
        const bindings = values.map(value => {
          const cell = configurationSqlCell(value);
          return typeof cell === "bigint" ? configurationSqlInteger(cell, "Project D1 binding", Number.MIN_SAFE_INTEGER) : cell;
        });
        return wrap(native.bind(...bindings));
      },
      async first() { const row = await native.first<Record<string, unknown>>(); return row === null ? null : configurationSqlRow(row); },
      async all() { return { results: (await native.all<Record<string, unknown>>()).results.map(configurationSqlRow) }; },
    };
    statements.set(statement, native); return statement;
  };
  return {
    prepare(sql) { return wrap(source.prepare(projectReadSql(sql))); },
    async readBatch(items) {
      const native = items.map(item => { const value = statements.get(item); if (!value) throw new Error("Foreign Project read statement"); return value; });
      if (!native.length) return [];
      const results = await source.batch<Record<string, unknown>>(native);
      if (results.length !== native.length) throw new Error("Incomplete Project snapshot read acknowledgement");
      return results.map(result => ({ results: result.results.map(configurationSqlRow) }));
    },
  };
}
