import type { ReadSqlCell, ReadSqlRow } from "../runtime/read-sql";
/** Original mature edge SQL and proof queries. Same-project/lifecycle guards
 * remain owned by the exact installed schema; no File byte port is opened. */
export const PROJECT_EDGE_CREATE_SQL = `
    INSERT INTO project_edges (
      id, project_id, source_item_id, target_item_id,
      source_handle, target_handle, marker_start, marker_end, label,
      revision, last_mutation_id, created_by, updated_by, created_at, updated_at
    )
    SELECT ?, ?, source.id, target.id, ?, ?, ?, ?, ?,
           1, ?, ?, ?, ?, ?
    FROM project_items source
    JOIN project_items target ON target.id = ?
    JOIN projects p ON p.id = ?
    WHERE source.id = ?
      AND source.project_id = ? AND target.project_id = ?
      AND source.revision = ? AND target.revision = ?
      AND source.deleted_at IS NULL AND target.deleted_at IS NULL
      AND p.deleted_at IS NULL
  `;
export const PROJECT_EDGE_UPDATE_SQL = `
      UPDATE project_edges
      SET source_item_id = ?, target_item_id = ?, source_handle = ?, target_handle = ?,
          marker_start = ?, marker_end = ?, label = ?,
          revision = revision + 1, last_mutation_id = ?,
          updated_by = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND revision = ?
        AND deleted_at IS NULL AND revision < ?
        AND EXISTS (
          SELECT 1
          FROM projects p
          JOIN project_items source ON source.id = ?
          JOIN project_items target ON target.id = ?
          WHERE p.id = project_edges.project_id AND p.deleted_at IS NULL
            AND source.project_id = p.id AND target.project_id = p.id
            AND source.deleted_at IS NULL AND target.deleted_at IS NULL
            AND (? = 0 OR (source.revision = ? AND target.revision = ?))
        )
    `;
export const PROJECT_EDGE_DELETE_SQL = `
    UPDATE project_edges
    SET deleted_at = ?, deleted_by = ?, deletion_operation_id = ?,
        revision = revision + 1, last_mutation_id = ?,
        updated_by = ?, updated_at = ?
    WHERE id = ? AND project_id = ? AND revision = ?
      AND deleted_at IS NULL AND revision < ?
  `;
export const PROJECT_EDGE_RESTORE_SQL = `
      UPDATE project_edges
      SET deleted_at = NULL, deleted_by = NULL, deletion_operation_id = NULL,
          revision = revision + 1, last_mutation_id = ?,
          updated_by = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND revision = ?
        AND deleted_at IS NOT NULL AND revision < ?
    `;
export const PROJECT_EDGE_ROW_SQL = `
    SELECT pe.*
    FROM project_edges pe
    JOIN projects p ON p.id = pe.project_id
    WHERE pe.id = ? AND pe.project_id = ?
      AND p.deleted_at IS NULL
      AND (? = 1 OR pe.deleted_at IS NULL)
    LIMIT 1
  `;
export const PROJECT_EDGE_IDENTITY_PROOF_SQL = `
    SELECT 1 AS occupied FROM project_edges WHERE id = ? LIMIT 1
  `;
export const PROJECT_EDGE_ENDPOINT_PROOF_SQL = `
      SELECT id, revision
      FROM project_items
      WHERE project_id = ? AND id IN (?, ?)
    `;
export const PROJECT_EDGE_FIRST_SQL = Object.freeze([PROJECT_EDGE_ROW_SQL, PROJECT_EDGE_IDENTITY_PROOF_SQL]);
export const PROJECT_EDGE_ALL_SQL = Object.freeze([PROJECT_EDGE_ENDPOINT_PROOF_SQL]);
export const PROJECT_EDGE_MUTATION_SQL = Object.freeze([PROJECT_EDGE_CREATE_SQL, PROJECT_EDGE_UPDATE_SQL, PROJECT_EDGE_DELETE_SQL, PROJECT_EDGE_RESTORE_SQL]);
export interface ProjectEdgeStatement {
  bind(...values: ReadSqlCell[]): ProjectEdgeStatement;
  first(): Promise<ReadSqlRow | null>;
  all(): Promise<{ results: ReadSqlRow[] }>;
  run(): Promise<{ changes: number }>;
}
export interface ProjectEdgeDatabase { prepare(sql: string): ProjectEdgeStatement }
export function projectEdgeSql(sql: string): string {
  if (![...PROJECT_EDGE_FIRST_SQL, ...PROJECT_EDGE_ALL_SQL, ...PROJECT_EDGE_MUTATION_SQL].includes(sql)) throw new TypeError("Unsupported Project edge SQL");
  return sql;
}
