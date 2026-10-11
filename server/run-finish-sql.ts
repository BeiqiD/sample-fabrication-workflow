import type { ReadSqlCell } from "../worker/runtime/read-sql";
import { configurationSqlCell, configurationSqlInteger, configurationSqlRow } from "../worker/runtime/configuration-sql";
import type { RunFinishDatabase, RunFinishStatement } from "../worker/execution/run-finish-sql";
import { runSqliteAdmittedBatch, type SqliteBatchAdmission, type SqliteCapability, type SqliteStatement } from "./sqlite";
/** Actual owned native core; first/all and one transactional batch preserve exact cells. */
export function asRunFinishDatabase(core: SqliteCapability, selectAdmission?: () => SqliteBatchAdmission): RunFinishDatabase {
  const owners = new WeakMap<RunFinishStatement, SqliteStatement>();
  const wrap = (native: SqliteStatement): RunFinishStatement => {
    const statement: RunFinishStatement = Object.freeze({
      bind(...values: ReadSqlCell[]) { return wrap(native.bind(...values.map(configurationSqlCell))); },
      async first() { const row = await native.first(); return row === null ? null : configurationSqlRow(row); },
      async all() { return { results: (await native.all()).results.map(configurationSqlRow) }; },
    });
    owners.set(statement, native); return statement;
  };
  return Object.freeze({
    prepare(sql: string) { return wrap(core.prepare(sql)); },
    async atomicBatch(statements: readonly RunFinishStatement[]) {
      if (!statements.length) throw new Error("Empty Run finish batch");
      const native = statements.map(statement => {
        const selected = owners.get(statement);
        if (!selected) throw new Error("Foreign Run finish statement");
        return selected;
      });
      const results = selectAdmission ? await runSqliteAdmittedBatch(core, native, selectAdmission()) : await core.batch(native);
      if (results.length !== native.length) throw new Error("Incomplete Run finish batch acknowledgement");
      return results.map(result => ({ directChanges: configurationSqlInteger(result.meta.directChanges, "Run finish native direct changes"),
        results: result.results.map(configurationSqlRow) }));
    },
  });
}
