import type { ReadSqlCell, ReadSqlRow } from "../runtime/read-sql";

/** Only the three mature creation statements, in their existing atomic order.
 * This supplies no item, media, attachment, rename or lifecycle writer. */
export const PROJECT_CREATE_INSERT_SQL = `
      INSERT OR IGNORE INTO projects (
        id, title, revision, next_created_sequence, last_mutation_id,
        created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?)
    `;
export const PROJECT_CREATE_CHANGES_SQL = "SELECT changes() AS affected_rows";
export const PROJECT_CREATE_ROW_SQL = "SELECT * FROM projects WHERE id = ? LIMIT 1";
export interface ProjectCreateStatement { bind(...values: ReadSqlCell[]): ProjectCreateStatement }
export interface ProjectCreateDatabase {
  prepare(sql: string): ProjectCreateStatement;
  atomicBatch(statements: readonly ProjectCreateStatement[]): Promise<{ results: ReadSqlRow[] }[]>;
}
export function projectCreateSql(sql: string): string {
  if (![PROJECT_CREATE_INSERT_SQL, PROJECT_CREATE_CHANGES_SQL, PROJECT_CREATE_ROW_SQL].includes(sql)) throw new TypeError("Project creation requires its code-owned three statements");
  return sql;
}
