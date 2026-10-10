import type { ReadSqlCell } from "../runtime/read-sql";
import { configurationSqlCell, configurationSqlInteger, configurationSqlRow } from "../runtime/configuration-sql";
import type { StepConfirmationDatabase, StepConfirmationStatement } from "./confirmation-sql";

/** The current genuine Worker binding retains its request-local maintenance
 * and File execution guards. Never construct a local D1/Env facade. */
export function d1StepConfirmationDatabase(database: D1Database): StepConfirmationDatabase {
  const owners = new WeakMap<StepConfirmationStatement, D1PreparedStatement>();
  const wrap = (native: D1PreparedStatement): StepConfirmationStatement => {
    const statement: StepConfirmationStatement = Object.freeze({
      bind(...values: ReadSqlCell[]) {
        const bindings = values.map(value => {
          const checked = configurationSqlCell(value);
          return typeof checked === "bigint" ? configurationSqlInteger(checked, "Step confirmation D1 binding", Number.MIN_SAFE_INTEGER) : checked;
        });
        return wrap(native.bind(...bindings));
      },
    });
    owners.set(statement, native); return statement;
  };
  return Object.freeze({
    prepare(sql: string) { return wrap(database.prepare(sql)); },
    async atomicBatch(statements: readonly StepConfirmationStatement[]) {
      if (!statements.length) throw new Error("Empty Step confirmation batch");
      const native = statements.map(statement => {
        const selected = owners.get(statement);
        if (!selected) throw new Error("Foreign Step confirmation statement");
        return selected;
      });
      const results = await database.batch<Record<string, unknown>>(native);
      if (results.length !== native.length || results.some(result => !result.success)) throw new Error("Incomplete Step confirmation batch acknowledgement");
      return results.map(result => ({ results: result.results.map(configurationSqlRow) }));
    },
  });
}
