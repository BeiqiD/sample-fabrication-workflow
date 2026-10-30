import { configurationSqlRow } from "../worker/runtime/configuration-sql";
import { projectCreateSql, type ProjectCreateDatabase, type ProjectCreateStatement } from "../worker/projects/create-sql";
import { runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement, type SqliteBatchAdmission } from "./sqlite";

/** Actual owned core with a REQUIRED current transaction admission. SELECT
 * changes stays adjacent to the original insert and before the row read. */
export function asProjectCreateDatabase(core: SqliteCapability, selectAdmission: () => SqliteBatchAdmission): ProjectCreateDatabase {
  const statements = new WeakMap<ProjectCreateStatement, SqliteStatement>();
  const wrap = (native: SqliteStatement): ProjectCreateStatement => {
    const statement: ProjectCreateStatement = { bind(...values) { return wrap(native.bind(...values)); } };
    statements.set(statement, native); return statement;
  };
  return {
    prepare(sql) { return wrap(core.prepare(projectCreateSql(sql))); },
    async atomicBatch(items) {
      const native = items.map(item => { const selected = statements.get(item); if (!selected) throw new Error("Foreign Node Project creation statement"); return selected; });
      const results = await runSqliteAdmittedBatch(core, native, selectAdmission());
      if (results.length !== native.length) throw new Error("Incomplete Project creation batch acknowledgement");
      return results.map(result => ({ results: result.results.map(configurationSqlRow) }));
    },
  };
}
