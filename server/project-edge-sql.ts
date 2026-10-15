import { configurationSqlInteger, configurationSqlRow } from "../worker/runtime/configuration-sql";
import { PROJECT_EDGE_FIRST_SQL, PROJECT_EDGE_ALL_SQL, PROJECT_EDGE_MUTATION_SQL, projectEdgeSql,
  type ProjectEdgeDatabase, type ProjectEdgeStatement } from "../worker/projects/edge-sql";
import { runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement, type SqliteBatchAdmission } from "./sqlite";
/** Exact issued core admission guards each original read/write inside its true
 * BEGIN. SELECT changes() preserves D1's direct mutation ordinal after triggers. */
export function asProjectEdgeDatabase(core: SqliteCapability, selectAdmission: () => SqliteBatchAdmission): ProjectEdgeDatabase {
  const wrap = (native: SqliteStatement, sql: string): ProjectEdgeStatement => ({
    bind(...values) { return wrap(native.bind(...values), sql); },
    async first() {
      if (!PROJECT_EDGE_FIRST_SQL.includes(sql)) throw new TypeError("Project edge first requires its original row/proof SELECT");
      const results = await runSqliteAdmittedBatch(core, [native], selectAdmission());
      if (results.length !== 1 || results[0]!.results.length > 1) throw new Error("Incomplete Project edge row acknowledgement");
      const row = results[0]!.results[0]; return row === undefined ? null : configurationSqlRow(row);
    },
    async all() {
      if (!PROJECT_EDGE_ALL_SQL.includes(sql)) throw new TypeError("Project edge all requires its original endpoint proof SELECT");
      const results = await runSqliteAdmittedBatch(core, [native], selectAdmission());
      if (results.length !== 1) throw new Error("Incomplete Project edge proof acknowledgement");
      return { results: results[0]!.results.map(configurationSqlRow) };
    },
    async run() {
      if (!PROJECT_EDGE_MUTATION_SQL.includes(sql)) throw new TypeError("Project edge mutation requires its original INSERT/UPDATE");
      const results = await runSqliteAdmittedBatch(core, [native, core.prepare("SELECT changes() AS affected_rows")], selectAdmission());
      if (results.length !== 2 || results[1]!.results.length !== 1) throw new Error("Incomplete Project edge mutation acknowledgement");
      return { changes: configurationSqlInteger(results[1]!.results[0]!.affected_rows, "Project edge affected_rows", 0) };
    },
  });
  return { prepare(sql) { const owned = projectEdgeSql(sql); return wrap(core.prepare(owned), owned); } };
}
