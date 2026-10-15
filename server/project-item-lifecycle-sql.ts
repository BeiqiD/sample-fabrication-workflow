import { configurationSqlInteger } from "../worker/runtime/configuration-sql";
import { PROJECT_WORKSPACE_CHANGES_SQL, type ProjectWorkspaceStatement } from "../worker/projects/workspace-sql";
import { PROJECT_ITEM_RESTORE_CONTENT_SQL, PROJECT_ITEM_RESTORE_ITEM_SQL, projectItemRestoreOrder,
  type ProjectItemLifecycleDatabase } from "../worker/projects/item-lifecycle-sql";
import { asProjectItemMetadataDatabase } from "./project-item-metadata-sql";
import { runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement, type SqliteBatchAdmission } from "./sqlite";

/** Private Markdown-only native adapter, never a File restoration provider.
 * All original metadata lookups/removal writes delegate their exact existing
 * adapter. Restore writes retain exact content/item order and direct changes(). */
export function asProjectItemLifecycleDatabase(core: SqliteCapability, admission: () => SqliteBatchAdmission): ProjectItemLifecycleDatabase {
  const metadata = asProjectItemMetadataDatabase(core,admission);
  const statements = new WeakMap<ProjectWorkspaceStatement,{native:SqliteStatement;sql:string}>();
  const wrap = (native:SqliteStatement,sql:string):ProjectWorkspaceStatement => {
    const statement:ProjectWorkspaceStatement = {
      bind(...values) { return wrap(native.bind(...values),sql); },
      async first() { throw new TypeError("Restore mutation is not a Project lookup"); },
      async run() { throw new TypeError("Restore requires its complete original ordered batch"); },
    };
    statements.set(statement,{native,sql}); return statement;
  };
  return {
    ...metadata,
    prepare(sql) {
      return sql === PROJECT_ITEM_RESTORE_CONTENT_SQL || sql === PROJECT_ITEM_RESTORE_ITEM_SQL
        ? wrap(core.prepare(sql),sql) : metadata.prepare(sql);
    },
    async mutationBatch(items) {
      const selected=items.map(item=>statements.get(item));
      if (selected.every(value=>value===undefined)) return metadata.mutationBatch(items);
      if (selected.some(value=>value===undefined)) throw new TypeError("Mixed or foreign Project restore batch");
      const owned=selected.map(value=>value!);
      if (!projectItemRestoreOrder(owned.map(value=>value.sql))) throw new TypeError("Invalid original Project restore order");
      const result=await runSqliteAdmittedBatch(core,owned.flatMap(value=>[value.native,core.prepare(PROJECT_WORKSPACE_CHANGES_SQL)]),admission());
      if(result.length!==owned.length*2) throw new Error("Incomplete original Project restore acknowledgement");
      return owned.map((_,index)=>{
        const count=result[index*2+1]!;
        if(count.results.length!==1) throw new Error("Incomplete original direct Project restore count");
        return {changes:configurationSqlInteger(count.results[0]!.affected_rows,"Project item restore affected_rows",0)};
      });
    },
    async prepareFileRestoration() { throw new TypeError("This Markdown-only owner has no File restoration authority"); },
  };
}
