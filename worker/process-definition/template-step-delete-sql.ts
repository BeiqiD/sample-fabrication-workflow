import type { ReadSqlCell, ReadSqlRow } from "../runtime/read-sql";
import { publishedTemplateVersionSql } from "../template-publication";
export const TEMPLATE_STEP_DELETE_PUBLISHED_SQL = `
    SELECT 1 AS published
    FROM template_versions tv
    WHERE tv.id = ? AND ${publishedTemplateVersionSql("tv")}
  `;
export const TEMPLATE_STEP_DELETE_STATE_SQL = "SELECT locked_at, archived_at, deleted_at FROM template_versions WHERE id = ?";
export const TEMPLATE_STEP_DELETE_STEP_SQL = "SELECT id FROM template_steps WHERE id = ? AND template_version_id = ?";
export const TEMPLATE_STEP_DELETE_REMAINING_SQL = `SELECT logical_step_key, definition_hash, expected_state_hash
       FROM template_steps WHERE template_version_id = ? AND id != ? ORDER BY position`;
export const TEMPLATE_STEP_DELETE_REMOVE_SQL = `DELETE FROM template_steps
       WHERE id = ? AND template_version_id = ?
         AND EXISTS (
           SELECT 1 FROM template_versions
           WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL
         )`;
export const TEMPLATE_STEP_DELETE_MANIFEST_SQL = `UPDATE template_versions SET manifest_hash = ?
       WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`;

export interface TemplateStepDeleteStatement {
  bind(...values: ReadSqlCell[]): TemplateStepDeleteStatement;
  first(): Promise<ReadSqlRow | null>;
  all(): Promise<{ results: ReadSqlRow[] }>;
}
export interface TemplateStepDeleteDatabase {
  prepare(sql: string): TemplateStepDeleteStatement;
  batch(statements: readonly TemplateStepDeleteStatement[]): Promise<{ changes: number }[]>;
}
export const TEMPLATE_STEP_DELETE_FIRST_SQL = Object.freeze([TEMPLATE_STEP_DELETE_PUBLISHED_SQL, TEMPLATE_STEP_DELETE_STATE_SQL, TEMPLATE_STEP_DELETE_STEP_SQL]);
export const TEMPLATE_STEP_DELETE_MUTATION_SQL = Object.freeze([TEMPLATE_STEP_DELETE_REMOVE_SQL, TEMPLATE_STEP_DELETE_MANIFEST_SQL]);
export function templateStepDeleteSql(sql: string): string {
  if (![...TEMPLATE_STEP_DELETE_FIRST_SQL, TEMPLATE_STEP_DELETE_REMAINING_SQL, ...TEMPLATE_STEP_DELETE_MUTATION_SQL].includes(sql)) throw new TypeError("Unsupported template step delete SQL"); return sql;
}
