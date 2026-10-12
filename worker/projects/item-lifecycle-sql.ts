import type { ProjectItemMetadataDatabase } from "./item-metadata-sql";
import type { ProjectWorkspaceStatement } from "./workspace-sql";
/** Exact mature restore writes. This port grants no File restoration authority. */
export const PROJECT_ITEM_RESTORE_CONTENT_SQL = `
      UPDATE project_contents
      SET deleted_at = NULL, deleted_by = NULL, deletion_operation_id = NULL,
          revision = revision + 1, last_mutation_id = ?,
          updated_by = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND revision = ?
        AND deleted_at IS NOT NULL AND revision < ?
        AND EXISTS (
          SELECT 1 FROM project_items pi
          WHERE pi.id = ? AND pi.project_id = ? AND pi.revision = ?
            AND pi.project_content_id = project_contents.id AND pi.deleted_at IS NOT NULL
        )
    `;
export const PROJECT_ITEM_RESTORE_ITEM_SQL = `
    UPDATE project_items
    SET deleted_at = NULL, deleted_by = NULL, deletion_operation_id = NULL,
        revision = revision + 1, last_mutation_id = ?,
        updated_by = ?, updated_at = ?
    WHERE id = ? AND project_id = ? AND revision = ?
      AND deleted_at IS NOT NULL AND revision < ?
      AND (
        project_content_id IS NULL
        OR EXISTS (
          SELECT 1 FROM project_contents pc
          WHERE pc.id = project_items.project_content_id
            AND pc.last_mutation_id = ? AND pc.deleted_at IS NULL
        )
      )
  `;

export interface ProjectItemLifecycleDatabase extends ProjectItemMetadataDatabase {
  prepareFileRestoration(kind: "project_attachment", contentIds: readonly string[]): Promise<ProjectWorkspaceStatement[]>;
}
export function projectItemRestoreOrder(sqls: readonly string[]): boolean {
  return (sqls.length === 2 && sqls[0] === PROJECT_ITEM_RESTORE_CONTENT_SQL && sqls[1] === PROJECT_ITEM_RESTORE_ITEM_SQL)
    || (sqls.length === 1 && sqls[0] === PROJECT_ITEM_RESTORE_ITEM_SQL);
}
