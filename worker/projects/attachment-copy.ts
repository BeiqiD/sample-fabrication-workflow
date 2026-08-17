import type {
  CreateAttachmentProjectItemInput,
  ProjectItemMutationResponse,
} from "../../shared/project-api";
import type { CopyAttachmentProjectItemInput } from "../../shared/project-copy-paste-api";
import {
  createAttachmentProjectItem,
  ProjectServiceError,
} from "./service";

type AttachmentCopySourceRow = {
  asset_id: string | null;
  storage_object_id: string | null;
  source_active: number;
};

export async function copyAttachmentProjectItem(
  db: D1Database,
  projectId: string,
  input: CopyAttachmentProjectItemInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectItemMutationResponse> {
  const source = await db.prepare(`
    SELECT
      pca.asset_id,
      pca.storage_object_id,
      CASE WHEN p.deleted_at IS NULL
        AND pc.deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM project_items source_item
          WHERE source_item.project_id = pc.project_id
            AND source_item.project_content_id = pc.id
            AND source_item.deleted_at IS NULL
        )
      THEN 1 ELSE 0 END AS source_active
    FROM project_contents pc
    JOIN projects p ON p.id = pc.project_id
    JOIN project_content_attachments pca
      ON pca.project_content_id = pc.id
    WHERE pc.id = ? AND pc.project_id = ?
      AND pc.content_type = 'attachment'
    LIMIT 1
  `).bind(input.sourceContentId, projectId).first<AttachmentCopySourceRow>();
  if (!source) {
    throw new ProjectServiceError(
      "not_found",
      "Source Project attachment not found",
    );
  }

  const existingDestination = await db.prepare(`
    SELECT 1 AS present
    FROM project_items
    WHERE id = ? AND project_id = ?
    LIMIT 1
  `).bind(input.itemId, projectId).first<{ present: number }>();
  if (source.source_active !== 1 && !existingDestination) {
    throw new ProjectServiceError(
      "conflict",
      "Source Project attachment is no longer active",
    );
  }

  const hasAsset = typeof source.asset_id === "string";
  const hasStorageObject = typeof source.storage_object_id === "string";
  if (hasAsset === hasStorageObject) {
    throw new ProjectServiceError(
      "conflict",
      "Source Project attachment has an invalid blob binding",
    );
  }

  const createInput: CreateAttachmentProjectItemInput = {
    contentId: input.contentId,
    itemId: input.itemId,
    placementId: input.placementId,
    locator: hasAsset
      ? { assetId: source.asset_id! }
      : { storageObjectId: source.storage_object_id! },
    caption: input.caption,
    sourceUrl: input.sourceUrl,
    geometry: input.geometry,
    expectedProjectRevision: input.expectedProjectRevision,
    operationId: input.operationId,
  };
  return createAttachmentProjectItem(
    db,
    projectId,
    createInput,
    actor,
    now,
  );
}
