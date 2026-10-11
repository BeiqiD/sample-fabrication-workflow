import type { ReadSqlDatabase } from "../runtime/read-sql";
import type { ProjectWorkspaceDatabase, ProjectWorkspaceStatement } from "./workspace-sql";
import { PROJECT_WORKSPACE_FIRST_SQL, PROJECT_WORKSPACE_BUNDLE_SQL, PROJECT_WORKSPACE_RESERVE_SEQUENCE_SQL,
  PROJECT_WORKSPACE_INSERT_PLACEMENT_SQL, PROJECT_WORKSPACE_CHANGES_SQL } from "./workspace-sql";
import { REFERENCE_REGISTRATION_INSERT_SQL, REFERENCE_REGISTRATION_UPDATE_SQL } from "../references/registration-sql";
/** Complete original metadata writes; lifecycle/File orphan triggers remain
 * installed-schema owners and no bytes/provider/restoration port is fabricated. */
export const PROJECT_ITEM_METADATA_INSERT_REFERENCE_SQL = `
      INSERT INTO project_items (
        id, project_id, item_type, project_content_id, reference_target_id,
        created_sequence, revision, last_mutation_id,
        created_by, updated_by, created_at, updated_at
      ) VALUES (
        ?, ?, 'reference', NULL,
        (SELECT id FROM reference_targets
         WHERE target_type = ? AND target_id = ? AND tombstoned_at IS NULL),
        (SELECT next_created_sequence - 1
    FROM projects
    WHERE id = ? AND last_mutation_id = ? AND updated_at = ? AND deleted_at IS NULL),
        1, ?, ?, ?, ?, ?
      )
    `;
export const PROJECT_ITEM_METADATA_UPDATE_ATTACHMENT_SQL = `
    UPDATE project_contents
    SET attachment_caption = ?, attachment_source_url = ?,
        revision = revision + 1, last_mutation_id = ?,
        updated_by = ?, updated_at = ?
    WHERE id = ? AND project_id = ? AND content_type = 'attachment'
      AND revision = ? AND deleted_at IS NULL AND revision < ?
  `;
export const PROJECT_ITEM_METADATA_REMOVE_PRECONDITION_SQL = `
    EXISTS (
      SELECT 1 FROM project_items pi
      WHERE pi.id = ? AND pi.project_id = ?
        AND pi.revision = ? AND pi.revision < ? AND pi.deleted_at IS NULL
        AND (
          pi.project_content_id IS NULL
          OR EXISTS (
            SELECT 1 FROM project_contents pc
            WHERE pc.id = pi.project_content_id AND pc.project_id = pi.project_id
              AND pc.revision = ? AND pc.revision < ? AND pc.deleted_at IS NULL
          )
        )
    )`;
export const PROJECT_ITEM_METADATA_REMOVE_EDGES_SQL = `
      UPDATE project_edges
      SET deleted_at = ?, deleted_by = ?, deletion_operation_id = ?,
          revision = revision + 1, last_mutation_id = ?,
          updated_by = ?, updated_at = ?
      WHERE project_id = ? AND deleted_at IS NULL AND revision < ?
        AND (source_item_id = ? OR target_item_id = ?)
        AND ${PROJECT_ITEM_METADATA_REMOVE_PRECONDITION_SQL}
    `;
export const PROJECT_ITEM_METADATA_REMOVE_CONTENT_SQL = `
      UPDATE project_contents
      SET deleted_at = ?, deleted_by = ?, deletion_operation_id = ?,
          revision = revision + 1, last_mutation_id = ?,
          updated_by = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND revision = ?
        AND deleted_at IS NULL AND revision < ?
        AND EXISTS (
          SELECT 1 FROM project_items pi
          WHERE pi.id = ? AND pi.project_id = ? AND pi.revision = ?
            AND pi.project_content_id = project_contents.id AND pi.deleted_at IS NULL
        )
    `;
export const PROJECT_ITEM_METADATA_REMOVE_ITEM_SQL = `
    UPDATE project_items
    SET deleted_at = ?, deleted_by = ?, deletion_operation_id = ?,
        revision = revision + 1, last_mutation_id = ?,
        updated_by = ?, updated_at = ?
    WHERE id = ? AND project_id = ? AND revision = ?
      AND deleted_at IS NULL AND revision < ?
      AND (
        project_content_id IS NULL
        OR EXISTS (
          SELECT 1 FROM project_contents pc
          WHERE pc.id = project_items.project_content_id
            AND pc.last_mutation_id = ? AND pc.deleted_at = ?
        )
      )
  `;
export const PROJECT_ITEM_METADATA_CREATE_SQL = Object.freeze([
  PROJECT_WORKSPACE_RESERVE_SEQUENCE_SQL, PROJECT_WORKSPACE_CHANGES_SQL,
  REFERENCE_REGISTRATION_INSERT_SQL, PROJECT_WORKSPACE_CHANGES_SQL,
  REFERENCE_REGISTRATION_UPDATE_SQL, PROJECT_WORKSPACE_CHANGES_SQL,
  PROJECT_ITEM_METADATA_INSERT_REFERENCE_SQL, PROJECT_WORKSPACE_CHANGES_SQL,
  PROJECT_WORKSPACE_INSERT_PLACEMENT_SQL, PROJECT_WORKSPACE_CHANGES_SQL,
]);
export const PROJECT_ITEM_METADATA_REMOVE_SQL = Object.freeze([PROJECT_ITEM_METADATA_REMOVE_EDGES_SQL, PROJECT_ITEM_METADATA_REMOVE_CONTENT_SQL, PROJECT_ITEM_METADATA_REMOVE_ITEM_SQL]);
export interface ProjectItemMetadataDatabase extends ProjectWorkspaceDatabase {
  mutationBatch(statements: readonly ProjectWorkspaceStatement[]): Promise<{ changes: number }[]>;
  referenceReadDatabase(): ReadSqlDatabase;
}
export function projectItemMetadataSql(sql: string): string {
  if (![...PROJECT_WORKSPACE_FIRST_SQL, ...PROJECT_WORKSPACE_BUNDLE_SQL, ...PROJECT_ITEM_METADATA_CREATE_SQL,
    PROJECT_ITEM_METADATA_UPDATE_ATTACHMENT_SQL, ...PROJECT_ITEM_METADATA_REMOVE_SQL].includes(sql)) throw new TypeError("Unsupported Project item metadata SQL");
  return sql;
}
export function projectItemRemovalOrder(sqls: readonly string[]): boolean {
  return (sqls.length === 3 && sqls.every((sql, i) => sql === PROJECT_ITEM_METADATA_REMOVE_SQL[i]))
    || (sqls.length === 2 && sqls[0] === PROJECT_ITEM_METADATA_REMOVE_EDGES_SQL && sqls[1] === PROJECT_ITEM_METADATA_REMOVE_ITEM_SQL);
}
