import type { ReadSqlCell, ReadSqlRow } from "../runtime/read-sql";
import { publishedTemplateVersionSql } from "../template-publication";
export interface TemplateLifecycleStatement {
  bind(...values: ReadSqlCell[]): TemplateLifecycleStatement;
  first(): Promise<ReadSqlRow | null>;
  run(): Promise<{ changes: number }>;
}
export interface TemplateLifecycleDatabase { prepare(sql: string): TemplateLifecycleStatement }
export const TEMPLATE_LIFECYCLE_PUBLISHED_SQL = `
    SELECT 1 AS published
    FROM template_versions tv
    WHERE tv.id = ? AND ${publishedTemplateVersionSql("tv")}
  `;
export const TEMPLATE_LIFECYCLE_RENAME_SQL = `UPDATE template_versions SET name = ?, version = ?
       WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`;
export const TEMPLATE_LIFECYCLE_EDIT_STATE_SQL = `SELECT locked_at, archived_at, deleted_at FROM template_versions WHERE id = ?`;
export const TEMPLATE_LIFECYCLE_REMOVE_SQL = `UPDATE template_versions
     SET deleted_at = ?, deleted_by = ?,
         archived_at = CASE WHEN ? THEN ? ELSE archived_at END,
         archived_by = CASE WHEN ? THEN ? ELSE archived_by END
     WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL`;
export const TEMPLATE_LIFECYCLE_DELETE_STATE_SQL = `SELECT tv.recipe_family_id, tv.locked_at, tv.archived_at, tv.deleted_at,
            EXISTS (SELECT 1 FROM runs r WHERE r.template_version_id = tv.id) OR
            EXISTS (SELECT 1 FROM run_plan_revisions rpr WHERE rpr.template_version_id = tv.id) OR
            EXISTS (
              SELECT 1 FROM run_steps rs
              JOIN template_steps ts ON ts.id = rs.template_step_id
              WHERE ts.template_version_id = tv.id
            ) OR
            EXISTS (SELECT 1 FROM recipe_change_proposals rcp WHERE rcp.source_template_version_id = tv.id) AS referenced
     FROM template_versions tv WHERE tv.id = ?`;
export const TEMPLATE_LIFECYCLE_RESTORE_SQL = `UPDATE template_versions
     SET archived_at = CASE
           WHEN archived_at = deleted_at AND archived_by IS deleted_by THEN NULL
           ELSE archived_at
         END,
         archived_by = CASE
           WHEN archived_at = deleted_at AND archived_by IS deleted_by THEN NULL
           ELSE archived_by
         END,
         deleted_at = NULL,
         deleted_by = NULL
     WHERE id = ? AND deleted_at = ?`;
export const TEMPLATE_LIFECYCLE_RESTORE_STATE_SQL = `SELECT deleted_at, deleted_by, archived_at, archived_by
     FROM template_versions WHERE id = ? AND deleted_at IS NOT NULL`;

export const TEMPLATE_LIFECYCLE_FIRST_SQL = Object.freeze([TEMPLATE_LIFECYCLE_PUBLISHED_SQL, TEMPLATE_LIFECYCLE_EDIT_STATE_SQL, TEMPLATE_LIFECYCLE_DELETE_STATE_SQL, TEMPLATE_LIFECYCLE_RESTORE_STATE_SQL]);
export const TEMPLATE_LIFECYCLE_MUTATION_SQL = Object.freeze([TEMPLATE_LIFECYCLE_RENAME_SQL, TEMPLATE_LIFECYCLE_REMOVE_SQL, TEMPLATE_LIFECYCLE_RESTORE_SQL]);
const catalog = new Set<string>([...TEMPLATE_LIFECYCLE_FIRST_SQL, ...TEMPLATE_LIFECYCLE_MUTATION_SQL]);
export function templateLifecycleSql(sql: string): string { if (!catalog.has(sql)) throw new TypeError("Unsupported template lifecycle SQL"); return sql; }
