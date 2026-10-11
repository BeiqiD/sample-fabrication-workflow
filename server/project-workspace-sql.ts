import { configurationSqlInteger, configurationSqlRow } from "../worker/runtime/configuration-sql";
import { projectWorkspaceSql, PROJECT_WORKSPACE_FIRST_SQL, PROJECT_WORKSPACE_UPDATE_SQL,
  PROJECT_WORKSPACE_BUNDLE_SQL, PROJECT_WORKSPACE_CREATE_SQL, PROJECT_WORKSPACE_CHANGES_SQL,
  type ProjectWorkspaceDatabase, type ProjectWorkspaceStatement } from "../worker/projects/workspace-sql";
import { runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement, type SqliteBatchAdmission } from "./sqlite";

/** Genuine same-core tokens guard even replay/no-op reads inside actual BEGIN.
 * Original eight creation statements retain their direct-change ordinals;
 * guards never add a returned result. Native int64 cells remain exact. */
export function asProjectWorkspaceDatabase(core: SqliteCapability,
  selectAdmission: () => SqliteBatchAdmission): ProjectWorkspaceDatabase {
  const statements = new WeakMap<ProjectWorkspaceStatement, { native: SqliteStatement; sql: string }>();
  const wrap = (native: SqliteStatement, sql: string): ProjectWorkspaceStatement => {
    const statement: ProjectWorkspaceStatement = {
      bind(...values) { return wrap(native.bind(...values), sql); },
      async first() {
        if (!PROJECT_WORKSPACE_FIRST_SQL.includes(sql)) throw new TypeError("Unsupported Project workspace lookup");
        const result = await runSqliteAdmittedBatch(core, [native], selectAdmission());
        if (result.length !== 1 || result[0]!.results.length > 1) throw new Error("Incomplete Project workspace row acknowledgement");
        const row = result[0]!.results[0]; return row === undefined ? null : configurationSqlRow(row);
      },
      async run() {
        if (!PROJECT_WORKSPACE_UPDATE_SQL.includes(sql)) throw new TypeError("Unsupported Project workspace mutation");
        const result = await runSqliteAdmittedBatch(core, [native, core.prepare(PROJECT_WORKSPACE_CHANGES_SQL)], selectAdmission());
        if (result.length !== 2 || result[1]!.results.length !== 1) throw new Error("Incomplete Project workspace mutation acknowledgement");
        return { changes: configurationSqlInteger(result[1]!.results[0]!.affected_rows, "Project workspace affected_rows", 0) };
      },
    };
    statements.set(statement, { native, sql }); return statement;
  };
  const batch = async (items: readonly ProjectWorkspaceStatement[], expected: readonly string[]) => {
    const selected = items.map(item => { const value = statements.get(item); if (!value) throw new TypeError("Foreign Project workspace statement"); return value; });
    if (selected.length !== expected.length || selected.some((value, index) => value.sql !== expected[index])) throw new TypeError("Invalid Project workspace batch order");
    const results = await runSqliteAdmittedBatch(core, selected.map(value => value.native), selectAdmission());
    if (results.length !== items.length) throw new Error("Incomplete Project workspace batch acknowledgement");
    return results.map(result => ({ results: result.results.map(configurationSqlRow) }));
  };
  return {
    prepare(sql) { const owned = projectWorkspaceSql(sql); return wrap(core.prepare(owned), owned); },
    readBatch(items) { return batch(items, PROJECT_WORKSPACE_BUNDLE_SQL); },
    atomicBatch(items) { return batch(items, PROJECT_WORKSPACE_CREATE_SQL); },
  };
}
