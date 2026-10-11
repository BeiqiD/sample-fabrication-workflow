import { configurationSqlInteger, configurationSqlRow } from "../worker/runtime/configuration-sql";
import { templateStepDeleteSql, TEMPLATE_STEP_DELETE_FIRST_SQL, TEMPLATE_STEP_DELETE_REMAINING_SQL, TEMPLATE_STEP_DELETE_MUTATION_SQL, type TemplateStepDeleteDatabase, type TemplateStepDeleteStatement } from "../worker/process-definition/template-step-delete-sql";
import { runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement, type SqliteBatchAdmission } from "./sqlite";
/** Actual core-owned reads and original ordered two mutations under genuine
 * current session/install/lease guards in each native BEGIN. */
export function asTemplateStepDeleteDatabase(core: SqliteCapability, selectAdmission: () => SqliteBatchAdmission): TemplateStepDeleteDatabase {
  const originals = new WeakMap<TemplateStepDeleteStatement, { native: SqliteStatement; sql: string }>();
  const wrap = (native: SqliteStatement, sql: string): TemplateStepDeleteStatement => {
    const read = async () => { const results = await runSqliteAdmittedBatch(core, [native], selectAdmission()); if (results.length !== 1) throw new Error("Incomplete step delete read acknowledgement"); return results[0]!.results.map(configurationSqlRow); };
    const statement: TemplateStepDeleteStatement = {
      bind(...values) { return wrap(native.bind(...values), sql); },
      async first() { if (!TEMPLATE_STEP_DELETE_FIRST_SQL.includes(sql)) throw new TypeError("Unsupported step delete lookup"); const rows = await read(); if (rows.length > 1) throw new Error("Unexpected step delete lookup count"); return rows[0] ?? null; },
      async all() { if (sql !== TEMPLATE_STEP_DELETE_REMAINING_SQL) throw new TypeError("Unsupported step delete row list"); return { results: await read() }; },
    }; originals.set(statement, { native, sql }); return statement;
  };
  return {
    prepare(sql) { const owned = templateStepDeleteSql(sql); return wrap(core.prepare(owned), owned); },
    async batch(statements) {
      if (!Array.isArray(statements) || statements.length !== 2) throw new TypeError("Step delete requires its original two-statement batch");
      const entries = statements.map(s => { const entry = originals.get(s); if (!entry) throw new TypeError("Foreign step delete statement"); return entry; });
      if (entries.some((e, i) => e.sql !== TEMPLATE_STEP_DELETE_MUTATION_SQL[i])) throw new TypeError("Unsupported step delete mutation order");
      const result = await runSqliteAdmittedBatch(core, entries.map(e => e.native), selectAdmission());
      if (result.length !== 2) throw new Error("Incomplete step delete batch acknowledgement");
      return result.map(row => ({ changes: configurationSqlInteger(row.meta.directChanges, "Template step native direct changes", 0) }));
    },
  };
}
