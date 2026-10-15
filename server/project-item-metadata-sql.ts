import { configurationSqlInteger, configurationSqlRow } from "../worker/runtime/configuration-sql";
import type { ReadSqlDatabase, ReadSqlStatement } from "../worker/runtime/read-sql";
import { PROJECT_WORKSPACE_FIRST_SQL, PROJECT_WORKSPACE_BUNDLE_SQL, PROJECT_WORKSPACE_CHANGES_SQL,
  type ProjectWorkspaceStatement } from "../worker/projects/workspace-sql";
import { projectItemMetadataSql, projectItemRemovalOrder, PROJECT_ITEM_METADATA_CREATE_SQL, PROJECT_ITEM_METADATA_UPDATE_ATTACHMENT_SQL,
  type ProjectItemMetadataDatabase } from "../worker/projects/item-metadata-sql";
import { runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement, type SqliteBatchAdmission } from "./sqlite";
/** Code-owned mature reference resolver reads use the same exact core-issued
 * BEGIN admission as the Project writes. No D1/Env facade or physical read-only grant. */
function admittedReferenceReadDatabase(core: SqliteCapability, admission: () => SqliteBatchAdmission): ReadSqlDatabase {
  const wrap = (native: SqliteStatement): ReadSqlStatement => ({
    bind(...values) { return wrap(native.bind(...values)); },
    async first() { const r = await runSqliteAdmittedBatch(core, [native], admission()); if (r.length !== 1 || r[0]!.results.length > 1) throw new Error("Incomplete reference resolver lookup"); const row = r[0]!.results[0]; return row === undefined ? null : configurationSqlRow(row); },
    async all() { const r = await runSqliteAdmittedBatch(core, [native], admission()); if (r.length !== 1) throw new Error("Incomplete reference resolver read"); return { results: r[0]!.results.map(configurationSqlRow) }; },
  }); return { prepare(sql) { return wrap(core.prepare(sql)); } };
}
export function asProjectItemMetadataDatabase(core: SqliteCapability, admission: () => SqliteBatchAdmission): ProjectItemMetadataDatabase {
  const statements = new WeakMap<ProjectWorkspaceStatement, { native: SqliteStatement; sql: string }>();
  const wrap = (native: SqliteStatement, sql: string): ProjectWorkspaceStatement => {
    const statement: ProjectWorkspaceStatement = {
      bind(...values) { return wrap(native.bind(...values), sql); },
      async first() { if (!PROJECT_WORKSPACE_FIRST_SQL.includes(sql)) throw new TypeError("Unsupported Project metadata lookup"); const r = await runSqliteAdmittedBatch(core, [native], admission()); if (r.length !== 1 || r[0]!.results.length > 1) throw new Error("Incomplete Project metadata lookup"); const row = r[0]!.results[0]; return row === undefined ? null : configurationSqlRow(row); },
      async run() { if (sql !== PROJECT_ITEM_METADATA_UPDATE_ATTACHMENT_SQL) throw new TypeError("Unsupported Project metadata single mutation"); const r = await runSqliteAdmittedBatch(core, [native, core.prepare(PROJECT_WORKSPACE_CHANGES_SQL)], admission()); if (r.length !== 2 || r[1]!.results.length !== 1) throw new Error("Incomplete Project metadata mutation acknowledgement"); return { changes: configurationSqlInteger(r[1]!.results[0]!.affected_rows, "Project metadata affected_rows", 0) }; },
    }; statements.set(statement, { native, sql }); return statement;
  };
  const select = (items: readonly ProjectWorkspaceStatement[]) => items.map(item => { const value = statements.get(item); if (!value) throw new TypeError("Foreign Project metadata statement"); return value; });
  const rows = async (items: readonly ProjectWorkspaceStatement[], expected: readonly string[]) => {
    const selected = select(items); if (selected.length !== expected.length || selected.some((value, i) => value.sql !== expected[i])) throw new TypeError("Invalid Project metadata batch order");
    const r = await runSqliteAdmittedBatch(core, selected.map(value => value.native), admission()); if (r.length !== items.length) throw new Error("Incomplete Project metadata batch acknowledgement"); return r.map(result => ({ results: result.results.map(configurationSqlRow) }));
  };
  return { prepare(sql) { const owned = projectItemMetadataSql(sql); return wrap(core.prepare(owned), owned); },
    readBatch(items) { return rows(items, PROJECT_WORKSPACE_BUNDLE_SQL); }, atomicBatch(items) { return rows(items, PROJECT_ITEM_METADATA_CREATE_SQL); },
    async mutationBatch(items) { const selected = select(items); if (!projectItemRemovalOrder(selected.map(value => value.sql))) throw new TypeError("Invalid Project item removal order");
      const r = await runSqliteAdmittedBatch(core, selected.flatMap(value => [value.native, core.prepare(PROJECT_WORKSPACE_CHANGES_SQL)]), admission()); if (r.length !== items.length * 2) throw new Error("Incomplete Project item removal acknowledgement");
      return selected.map((_, i) => { if (r[i * 2 + 1]!.results.length !== 1) throw new Error("Incomplete direct removal changes acknowledgement"); return { changes: configurationSqlInteger(r[i * 2 + 1]!.results[0]!.affected_rows, "Project item removal affected_rows", 0) }; });
    }, referenceReadDatabase() { return admittedReferenceReadDatabase(core, admission); },
  };
}
