import type { ReadSqlCell } from "../worker/runtime/read-sql";
import { configurationSqlCell, configurationSqlInteger, configurationSqlRow } from "../worker/runtime/configuration-sql";
import type { RunPlanDatabase, RunPlanStatement } from "../worker/execution/run-plan-sql";
import { runSqliteAdmittedBatch, type SqliteBatchAdmission, type SqliteCapability, type SqliteStatement } from "./sqlite";
/** Actual owned native core; existing CTE writes retain one real BEGIN with
 * session/installation/control predicates in that same transaction. */
export function asRunPlanDatabase(core: SqliteCapability, selectAdmission: () => SqliteBatchAdmission): RunPlanDatabase {
  const owners = new WeakMap<RunPlanStatement, SqliteStatement>();
  const wrap = (native: SqliteStatement): RunPlanStatement => {
    const statement: RunPlanStatement = Object.freeze({
      bind(...values: ReadSqlCell[]) { return wrap(native.bind(...values.map(configurationSqlCell))); },
      async first() { const row = await native.first(); return row === null ? null : configurationSqlRow(row); },
      async all() { return { results: (await native.all()).results.map(configurationSqlRow) }; },
    });
    owners.set(statement, native); return statement;
  };
  return Object.freeze({
    prepare(sql: string) { return wrap(core.prepare(sql)); },
    async atomicBatch(statements: readonly RunPlanStatement[]) {
      if (!statements.length || statements.length > 49) throw new Error("Invalid Run plan batch size");
      const native = statements.map(statement => { const selected = owners.get(statement); if (!selected) throw new Error("Foreign Run plan statement"); return selected; });
      const result = await runSqliteAdmittedBatch(core, native, selectAdmission());
      if (result.length !== native.length) throw new Error("Incomplete Run plan batch acknowledgement");
      return result.map(row => ({ changes: configurationSqlInteger(row.meta.totalChanges, "Run plan native changes") }));
    },
  });
}
