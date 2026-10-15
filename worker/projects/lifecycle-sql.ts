import type { ReadSqlCell, ReadSqlRow } from "../runtime/read-sql";

/** Exact mature root soft-delete/restore SQL. Installed child/File/reference
 * guards remain owned by the unchanged schema; no bytes or providers open. */
export const PROJECT_LIFECYCLE_ROW_SQL = `
    SELECT * FROM projects
    WHERE id = ? AND (? = 1 OR deleted_at IS NULL)
    LIMIT 1
  `;
export const PROJECT_LIFECYCLE_DELETE_SQL = `
    UPDATE projects
    SET deleted_at = ?, deleted_by = ?, deletion_operation_id = ?,
        revision = revision + 1, last_mutation_id = ?,
        updated_by = ?, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NULL AND revision < ?
  `;
export const PROJECT_LIFECYCLE_RESTORE_SQL = `
    UPDATE projects
    SET deleted_at = NULL, deleted_by = NULL, deletion_operation_id = NULL,
        revision = revision + 1, last_mutation_id = ?,
        updated_by = ?, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL AND revision < ?
  `;
export interface ProjectLifecycleStatement {
  bind(...values: ReadSqlCell[]): ProjectLifecycleStatement;
  first(): Promise<ReadSqlRow | null>;
  run(): Promise<{ changes: number }>;
}
export interface ProjectLifecycleDatabase { prepare(sql: string): ProjectLifecycleStatement }
export function projectLifecycleSql(sql: string): string {
  if (![PROJECT_LIFECYCLE_ROW_SQL, PROJECT_LIFECYCLE_DELETE_SQL, PROJECT_LIFECYCLE_RESTORE_SQL].includes(sql)) throw new TypeError("Unsupported Project lifecycle SQL");
  return sql;
}
