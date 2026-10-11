import { configurationSqlInteger, configurationSqlRow } from "../worker/runtime/configuration-sql";
import { PROJECT_LIFECYCLE_ROW_SQL, PROJECT_LIFECYCLE_DELETE_SQL, PROJECT_LIFECYCLE_RESTORE_SQL, projectLifecycleSql,
  type ProjectLifecycleDatabase, type ProjectLifecycleStatement } from "../worker/projects/lifecycle-sql";
import { runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement, type SqliteBatchAdmission } from "./sqlite";

/** Actual same-core BEGIN admission surrounds each original lookup/mutation.
 * Direct changes are observed after the original root UPDATE, after triggers. */
export function asProjectLifecycleDatabase(core: SqliteCapability, selectAdmission: () => SqliteBatchAdmission): ProjectLifecycleDatabase {
  const wrap = (native: SqliteStatement, sql: string): ProjectLifecycleStatement => ({
    bind(...values) { return wrap(native.bind(...values), sql); },
    async first() {
      if (sql !== PROJECT_LIFECYCLE_ROW_SQL) throw new TypeError("Project lifecycle lookup requires its original row SELECT");
      const results = await runSqliteAdmittedBatch(core, [native], selectAdmission());
      if (results.length !== 1 || results[0]!.results.length > 1) throw new Error("Incomplete Project lifecycle row acknowledgement");
      const row = results[0]!.results[0]; return row === undefined ? null : configurationSqlRow(row);
    },
    async run() {
      if (sql !== PROJECT_LIFECYCLE_DELETE_SQL && sql !== PROJECT_LIFECYCLE_RESTORE_SQL) throw new TypeError("Project lifecycle mutation requires its original root UPDATE");
      const results = await runSqliteAdmittedBatch(core, [native, core.prepare("SELECT changes() AS affected_rows")], selectAdmission());
      if (results.length !== 2 || results[1]!.results.length !== 1) throw new Error("Incomplete Project lifecycle mutation acknowledgement");
      return { changes: configurationSqlInteger(results[1]!.results[0]!.affected_rows, "Project lifecycle affected_rows", 0) };
    },
  });
  return { prepare(sql) { const ownedSql = projectLifecycleSql(sql); return wrap(core.prepare(ownedSql), ownedSql); } };
}
