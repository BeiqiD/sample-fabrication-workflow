import { configurationSqlInteger, configurationSqlRow } from "../worker/runtime/configuration-sql";
import { metrologyDefinitionSql, METROLOGY_DEFINITION_FIRST_SQL, METROLOGY_DEFINITION_CREATE_SQL,
  METROLOGY_DEFINITION_UPDATE_SQL, METROLOGY_DEFINITION_UPDATE_NOTES_SQL,
  type MetrologyDefinitionDatabase, type MetrologyDefinitionStatement } from "../worker/process-definition/metrology-definition-sql";
import { runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement, type SqliteBatchAdmission } from "./sqlite";

/** Current genuine Request session/installation/control guards run inside the
 * original publication BEGIN. Existing installed publication triggers remain
 * the domain fence; original mutation/result order and int64 cells are kept. */
export function asMetrologyDefinitionDatabase(core: SqliteCapability,
  selectAdmission: () => SqliteBatchAdmission): MetrologyDefinitionDatabase {
  const statements = new WeakMap<MetrologyDefinitionStatement, { native: SqliteStatement; sql: string }>();
  const wrap = (native: SqliteStatement, sql: string): MetrologyDefinitionStatement => {
    const statement: MetrologyDefinitionStatement = {
      bind(...values) { return wrap(native.bind(...values), sql); },
      async first() {
        if (!METROLOGY_DEFINITION_FIRST_SQL.includes(sql)) throw new TypeError("Unsupported metrology definition lookup");
        const results = await runSqliteAdmittedBatch(core, [native], selectAdmission());
        if (results.length !== 1 || results[0]!.results.length > 1) throw new Error("Incomplete metrology definition row acknowledgement");
        const row = results[0]!.results[0]; return row === undefined ? null : configurationSqlRow(row);
      },
      async run() {
        if (sql !== METROLOGY_DEFINITION_UPDATE_NOTES_SQL) throw new TypeError("Unsupported metrology notes mutation");
        const results = await runSqliteAdmittedBatch(core, [native], selectAdmission());
        if (results.length !== 1) throw new Error("Incomplete metrology notes mutation acknowledgement");
        return { changes: configurationSqlInteger(results[0]!.meta.directChanges, "Metrology notes direct changes", 0) };
      },
    };
    statements.set(statement, { native, sql }); return statement;
  };
  return {
    prepare(sql) { const owned = metrologyDefinitionSql(sql); return wrap(core.prepare(owned), owned); },
    async atomicBatch(items) {
      const selected = items.map(item => { const value = statements.get(item); if (!value) throw new TypeError("Foreign metrology definition statement"); return value; });
      const expected = selected[0]?.sql === METROLOGY_DEFINITION_CREATE_SQL[0] ? METROLOGY_DEFINITION_CREATE_SQL : METROLOGY_DEFINITION_UPDATE_SQL;
      if (selected.length !== expected.length || selected.some((value, index) => value.sql !== expected[index])) throw new TypeError("Invalid metrology definition batch order");
      const results = await runSqliteAdmittedBatch(core, selected.map(value => value.native), selectAdmission());
      if (results.length !== items.length) throw new Error("Incomplete metrology definition batch acknowledgement");
      return results.map(result => ({ changes: configurationSqlInteger(result.meta.directChanges, "Metrology definition direct changes", 0), results: result.results.map(configurationSqlRow) }));
    },
  };
}
