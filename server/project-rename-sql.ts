import { configurationSqlInteger, configurationSqlRow } from "../worker/runtime/configuration-sql";
import { PROJECT_RENAME_ACTIVE_ROW_SQL, PROJECT_RENAME_UPDATE_SQL, projectRenameSql,
  type ProjectRenameDatabase, type ProjectRenameStatement } from "../worker/projects/rename-sql";
import { runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement, type SqliteBatchAdmission } from "./sqlite";

/** Actual same-core BEGIN admission also fences the replay/no-op row lookup.
 * The original title UPDATE and seven bindings remain unchanged. */
export function asProjectRenameDatabase(core: SqliteCapability, selectAdmission: () => SqliteBatchAdmission): ProjectRenameDatabase {
  const wrap = (native: SqliteStatement, sql: string): ProjectRenameStatement => ({
    bind(...values) { return wrap(native.bind(...values), sql); },
    async first() {
      if (sql !== PROJECT_RENAME_ACTIVE_ROW_SQL) throw new TypeError("Project rename lookup requires its active-row SELECT");
      const results = await runSqliteAdmittedBatch(core, [native], selectAdmission());
      if (results.length !== 1 || results[0]!.results.length > 1) throw new Error("Incomplete Project rename row acknowledgement");
      const row = results[0]!.results[0]; return row === undefined ? null : configurationSqlRow(row);
    },
    async run() {
      if (sql !== PROJECT_RENAME_UPDATE_SQL) throw new TypeError("Project rename mutation requires its title UPDATE");
      const results = await runSqliteAdmittedBatch(core, [native, core.prepare("SELECT changes() AS affected_rows")], selectAdmission());
      if (results.length !== 2 || results[1]!.results.length !== 1) throw new Error("Incomplete Project rename mutation acknowledgement");
      return { changes: configurationSqlInteger(results[1]!.results[0]!.affected_rows, "Project rename affected_rows", 0) };
    },
  });
  return { prepare(sql) { const ownedSql = projectRenameSql(sql); return wrap(core.prepare(ownedSql), ownedSql); } };
}
