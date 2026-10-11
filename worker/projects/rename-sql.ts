import type { ReadSqlCell, ReadSqlRow } from "../runtime/read-sql";

/** Exact mature active-row lookup and seven-binding title CAS. No lifecycle,
 * item, attachment, map, edge or media write is supplied by this port. */
export const PROJECT_RENAME_ACTIVE_ROW_SQL = `
    SELECT * FROM projects
    WHERE id = ? AND (? = 1 OR deleted_at IS NULL)
    LIMIT 1
  `;
export const PROJECT_RENAME_UPDATE_SQL = `
    UPDATE projects
    SET title = ?, revision = revision + 1, last_mutation_id = ?,
        updated_by = ?, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NULL AND revision < ?
  `;
export interface ProjectRenameStatement {
  bind(...values: ReadSqlCell[]): ProjectRenameStatement;
  first(): Promise<ReadSqlRow | null>;
  run(): Promise<{ changes: number }>;
}
export interface ProjectRenameDatabase { prepare(sql: string): ProjectRenameStatement }
export function projectRenameSql(sql: string): string {
  if (sql !== PROJECT_RENAME_ACTIVE_ROW_SQL && sql !== PROJECT_RENAME_UPDATE_SQL) {
    throw new TypeError("Project rename requires its code-owned two statements");
  }
  return sql;
}
