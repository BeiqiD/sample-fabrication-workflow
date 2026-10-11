import type { ReadSqlCell } from "../worker/runtime/read-sql";
import { configurationSqlCell, configurationSqlRow } from "../worker/runtime/configuration-sql";
import type { StepConfirmationDatabase, StepConfirmationStatement } from "../worker/execution/confirmation-sql";
import { runSqliteAdmittedBatch, type SqliteBatchAdmission, type SqliteCapability, type SqliteStatement } from "./sqlite";

/** Genuine owned Node core.batch keeps the RETURNING rows and one transaction;
 * it does not widen the configuration mutation or Project read interfaces. */
export function asStepConfirmationDatabase(core: SqliteCapability, selectAdmission?: () => SqliteBatchAdmission): StepConfirmationDatabase {
  const owners = new WeakMap<StepConfirmationStatement, SqliteStatement>();
  const wrap = (native: SqliteStatement): StepConfirmationStatement => {
    const statement: StepConfirmationStatement = Object.freeze({
      bind(...values: ReadSqlCell[]) { return wrap(native.bind(...values.map(configurationSqlCell))); },
    });
    owners.set(statement, native); return statement;
  };
  return Object.freeze({
    prepare(sql: string) { return wrap(core.prepare(sql)); },
    async atomicBatch(statements: readonly StepConfirmationStatement[]) {
      if (!statements.length) throw new Error("Empty Step confirmation batch");
      const native = statements.map(statement => {
        const selected = owners.get(statement);
        if (!selected) throw new Error("Foreign Step confirmation statement");
        return selected;
      });
      const results = selectAdmission ? await runSqliteAdmittedBatch(core, native, selectAdmission()) : await core.batch(native);
      if (results.length !== native.length) throw new Error("Incomplete Step confirmation batch acknowledgement");
      return results.map(result => ({ results: result.results.map(configurationSqlRow) }));
    },
  });
}
