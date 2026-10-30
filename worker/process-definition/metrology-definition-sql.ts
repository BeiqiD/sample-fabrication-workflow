import type { ReadSqlCell, ReadSqlRow } from "../runtime/read-sql";
import { publishedTemplateVersionSql } from "../template-publication";
export interface MetrologyDefinitionStatement {
  bind(...values: ReadSqlCell[]): MetrologyDefinitionStatement;
  first(): Promise<ReadSqlRow | null>;
  run(): Promise<{ changes: number }>;
}
export interface MetrologyDefinitionDatabase {
  prepare(sql: string): MetrologyDefinitionStatement;
  atomicBatch(items: readonly MetrologyDefinitionStatement[]): Promise<{ changes: number; results: ReadSqlRow[] }[]>;
}
export const METROLOGY_DEFINITION_PUBLISHED_SQL = `
    SELECT 1 AS published
    FROM template_versions tv
    WHERE tv.id = ? AND ${publishedTemplateVersionSql("tv")}
  `;
export const METROLOGY_DEFINITION_INSERT_STEP_SQL = `INSERT INTO template_steps
         (id, template_version_id, logical_step_key, position, definition_hash, raw_json)
         VALUES (?, ?, ?, 0, ?, '{}')`;
export const METROLOGY_DEFINITION_INSERT_VERSION_SQL = `INSERT INTO template_versions
         (id, recipe_family_id, name, template_type, template_kind, version, manifest_hash,
          content_json, created_by, created_at)
         VALUES (?, ?, ?, 'module', 'metrology', 1, ?, '{}', ?, ?)`;
export const METROLOGY_DEFINITION_INSERT_DEFINITION_SQL = `INSERT OR IGNORE INTO step_definitions
         (hash, hash_scheme, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
export const METROLOGY_DEFINITION_INSERT_FAMILY_SQL = `INSERT INTO recipe_families (id, name, template_type, created_by, created_at)
         VALUES (?, ?, 'module', ?, ?)`;
export const METROLOGY_DEFINITION_UPDATE_STEP_SQL = `UPDATE template_steps SET definition_hash = ?, expected_state_hash = NULL
         WHERE id = ? AND template_version_id = ?`;
export const METROLOGY_DEFINITION_UPDATE_VERSION_SQL = `UPDATE template_versions SET name = ?, manifest_hash = ?
         WHERE id = ? AND template_kind = 'metrology'
           AND archived_at IS NULL AND deleted_at IS NULL`;
export const METROLOGY_DEFINITION_SINGLE_STEP_SQL = `SELECT ts.id AS template_step_id, ts.logical_step_key
     FROM template_versions tv
     JOIN template_steps ts ON ts.template_version_id = tv.id
     WHERE tv.id = ? AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL
       AND tv.deleted_at IS NULL
       AND (SELECT COUNT(*) FROM template_steps only_step WHERE only_step.template_version_id = tv.id) = 1`;
export const METROLOGY_DEFINITION_UPDATE_NOTES_SQL = `UPDATE template_versions SET metrology_notes = ?
     WHERE id = ? AND template_kind = 'metrology'
       AND archived_at IS NULL AND deleted_at IS NULL`;

export const METROLOGY_DEFINITION_FIRST_SQL = Object.freeze([METROLOGY_DEFINITION_PUBLISHED_SQL, METROLOGY_DEFINITION_SINGLE_STEP_SQL]);
export const METROLOGY_DEFINITION_CREATE_SQL = Object.freeze([METROLOGY_DEFINITION_INSERT_FAMILY_SQL, METROLOGY_DEFINITION_INSERT_DEFINITION_SQL, METROLOGY_DEFINITION_INSERT_VERSION_SQL, METROLOGY_DEFINITION_INSERT_STEP_SQL]);
export const METROLOGY_DEFINITION_UPDATE_SQL = Object.freeze([METROLOGY_DEFINITION_INSERT_DEFINITION_SQL, METROLOGY_DEFINITION_UPDATE_VERSION_SQL, METROLOGY_DEFINITION_UPDATE_STEP_SQL]);
const catalog = new Set<string>([...METROLOGY_DEFINITION_FIRST_SQL, ...METROLOGY_DEFINITION_CREATE_SQL, ...METROLOGY_DEFINITION_UPDATE_SQL, METROLOGY_DEFINITION_UPDATE_NOTES_SQL]);
export function metrologyDefinitionSql(sql: string): string { if (!catalog.has(sql)) throw new TypeError("Unsupported metrology definition SQL"); return sql; }
