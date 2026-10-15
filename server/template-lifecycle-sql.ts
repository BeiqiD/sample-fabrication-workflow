import { configurationSqlInteger, configurationSqlRow } from "../worker/runtime/configuration-sql";
import { templateLifecycleSql, TEMPLATE_LIFECYCLE_FIRST_SQL, TEMPLATE_LIFECYCLE_MUTATION_SQL,
  type TemplateLifecycleDatabase, type TemplateLifecycleStatement } from "../worker/process-definition/template-lifecycle-sql";
import { runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement, type SqliteBatchAdmission } from "./sqlite";

/** Original installed SQL/binds/results, genuine same-core admission INSIDE
 * each lookup/publication BEGIN and exact native int64/direct-change cells. */
export function asTemplateLifecycleDatabase(core: SqliteCapability,
  selectAdmission: () => SqliteBatchAdmission): TemplateLifecycleDatabase {
  const wrap = (native: SqliteStatement, sql: string): TemplateLifecycleStatement => ({
    bind(...values) { return wrap(native.bind(...values), sql); },
    async first() {
      if (!TEMPLATE_LIFECYCLE_FIRST_SQL.includes(sql)) throw new TypeError("Unsupported template lifecycle lookup");
      const results = await runSqliteAdmittedBatch(core, [native], selectAdmission());
      if (results.length !== 1 || results[0]!.results.length > 1) throw new Error("Incomplete template lifecycle row acknowledgement");
      const row = results[0]!.results[0]; return row === undefined ? null : configurationSqlRow(row);
    },
    async run() {
      if (!TEMPLATE_LIFECYCLE_MUTATION_SQL.includes(sql)) throw new TypeError("Unsupported template lifecycle mutation");
      const results = await runSqliteAdmittedBatch(core, [native], selectAdmission());
      if (results.length !== 1) throw new Error("Incomplete template lifecycle mutation acknowledgement");
      return { changes: configurationSqlInteger(results[0]!.meta.directChanges, "Template lifecycle direct changes", 0) };
    },
  });
  return { prepare(sql) { const owned = templateLifecycleSql(sql); return wrap(core.prepare(owned), owned); } };
}
