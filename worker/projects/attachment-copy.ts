import type {
  CreateAttachmentProjectItemInput,
  ProjectItemMutationResponse,
} from "../../shared/project-api";
import type { CopyAttachmentProjectItemInput } from "../../shared/project-copy-paste-api";
import { MAX_PROJECT_SAFE_INTEGER } from "../../shared/project-types";
import {
  createAttachmentProjectItem,
  ProjectServiceError,
} from "./service";

type AttachmentCopySourceRow = {
  asset_id: string | null;
  storage_object_id: string | null;
  source_active: number;
};

function resultChanges(result: unknown) {
  return Number((result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
}

function constraintConflict(error: unknown) {
  return /(constraint|unique|foreign key|project |blob locator|attachment)/i
    .test(String(error));
}

async function destinationItemExists(
  db: D1Database,
  projectId: string,
  itemId: string,
) {
  return Boolean(await db.prepare(`
    SELECT 1 AS present
    FROM project_items
    WHERE id = ? AND project_id = ?
    LIMIT 1
  `).bind(itemId, projectId).first<{ present: number }>());
}

function createInputFromSource(
  input: CopyAttachmentProjectItemInput,
  source: AttachmentCopySourceRow,
): CreateAttachmentProjectItemInput {
  const hasAsset = typeof source.asset_id === "string";
  const hasStorageObject = typeof source.storage_object_id === "string";
  if (hasAsset === hasStorageObject) {
    throw new ProjectServiceError(
      "conflict",
      "Source Project attachment has an invalid blob binding",
    );
  }
  return {
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
}

function reserveProjectSequenceStatement(
  db: D1Database,
  projectId: string,
  input: CopyAttachmentProjectItemInput,
  actor: string,
  now: string,
) {
  return db.prepare(`
    UPDATE projects
    SET revision = revision + 1,
        next_created_sequence = next_created_sequence + 1,
        last_mutation_id = ?, updated_by = ?, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NULL
      AND revision < ? AND next_created_sequence < ?
  `).bind(
    input.operationId,
    actor,
    now,
    projectId,
    input.expectedProjectRevision,
    MAX_PROJECT_SAFE_INTEGER,
    MAX_PROJECT_SAFE_INTEGER,
  );
}

function sourceAuthorizedBindingStatement(
  db: D1Database,
  projectId: string,
  input: CopyAttachmentProjectItemInput,
  actor: string,
  now: string,
) {
  return db.prepare(`
    INSERT INTO project_content_attachments (
      project_content_id, asset_id, storage_object_id,
      original_name, mime_type, byte_size,
      created_by, created_at, creation_operation_id
    )
    SELECT ?, source.asset_id, source.storage_object_id,
           source.original_name, source.mime_type, source.byte_size,
           ?, ?, ?
    FROM (
      SELECT
        pca.asset_id AS asset_id,
        NULL AS storage_object_id,
        a.original_name AS original_name,
        a.mime_type AS mime_type,
        a.byte_size AS byte_size
      FROM project_contents pc
      JOIN projects p ON p.id = pc.project_id
      JOIN project_items source_item
        ON source_item.project_id = pc.project_id
       AND source_item.project_content_id = pc.id
      JOIN project_map_placements source_placement
        ON source_placement.project_item_id = source_item.id
      JOIN project_content_attachments pca
        ON pca.project_content_id = pc.id
      JOIN assets a ON a.id = pca.asset_id
      LEFT JOIN imports i ON i.id = a.import_id
      WHERE pc.id = ? AND pc.project_id = ?
        AND pc.content_type = 'attachment'
        AND p.deleted_at IS NULL
        AND pc.deleted_at IS NULL
        AND source_item.deleted_at IS NULL
        AND a.status = 'ready'
        AND (a.import_id IS NULL OR (i.id IS NOT NULL AND i.status = 'ready'))
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )

      UNION ALL

      SELECT
        NULL AS asset_id,
        pca.storage_object_id AS storage_object_id,
        mso.original_name AS original_name,
        mso.mime_type AS mime_type,
        mso.byte_size AS byte_size
      FROM project_contents pc
      JOIN projects p ON p.id = pc.project_id
      JOIN project_items source_item
        ON source_item.project_id = pc.project_id
       AND source_item.project_content_id = pc.id
      JOIN project_map_placements source_placement
        ON source_placement.project_item_id = source_item.id
      JOIN project_content_attachments pca
        ON pca.project_content_id = pc.id
      JOIN managed_storage_objects mso
        ON mso.id = pca.storage_object_id
      WHERE pc.id = ? AND pc.project_id = ?
        AND pc.content_type = 'attachment'
        AND p.deleted_at IS NULL
        AND pc.deleted_at IS NULL
        AND source_item.deleted_at IS NULL
        AND mso.status IN ('ready', 'orphaned')
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'managed' AND bg.provider = mso.provider
            AND bg.object_key = mso.object_key
            AND bg.state IN ('deleting', 'deleted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'managed' AND biq.provider = mso.provider
            AND biq.object_key = mso.object_key
        )
    ) source
    LIMIT 1
  `).bind(
    input.contentId,
    actor,
    now,
    input.operationId,
    input.sourceContentId,
    projectId,
    input.sourceContentId,
    projectId,
  );
}

async function exactReplay(
  db: D1Database,
  projectId: string,
  createInput: CreateAttachmentProjectItemInput,
  actor: string,
  now: string,
) {
  return createAttachmentProjectItem(db, projectId, createInput, actor, now);
}

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
          JOIN project_map_placements source_placement
            ON source_placement.project_item_id = source_item.id
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

  const createInput = createInputFromSource(input, source);
  if (await destinationItemExists(db, projectId, input.itemId)) {
    return exactReplay(db, projectId, createInput, actor, now);
  }
  if (source.source_active !== 1) {
    throw new ProjectServiceError(
      "conflict",
      "Source Project attachment is no longer active",
    );
  }

  const statements: D1PreparedStatement[] = [
    reserveProjectSequenceStatement(db, projectId, input, actor, now),
    db.prepare(`
      INSERT INTO project_contents (
        id, project_id, content_type, markdown_source,
        attachment_caption, attachment_source_url, format_version,
        revision, last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, 'attachment', NULL, ?, ?, 1, 1, ?, ?, ?, ?, ?)
    `).bind(
      input.contentId,
      projectId,
      input.caption,
      input.sourceUrl,
      input.operationId,
      actor,
      actor,
      now,
      now,
    ),
    sourceAuthorizedBindingStatement(db, projectId, input, actor, now),
    db.prepare(`
      INSERT INTO project_items (
        id, project_id, item_type, project_content_id, reference_target_id,
        created_sequence, revision, last_mutation_id,
        created_by, updated_by, created_at, updated_at
      ) VALUES (
        ?, ?, 'content', ?, NULL,
        (SELECT next_created_sequence - 1
         FROM projects
         WHERE id = ? AND last_mutation_id = ? AND updated_at = ?
           AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM project_content_attachments pca
             WHERE pca.project_content_id = ?
           )),
        1, ?, ?, ?, ?, ?
      )
    `).bind(
      input.itemId,
      projectId,
      input.contentId,
      projectId,
      input.operationId,
      now,
      input.contentId,
      input.operationId,
      actor,
      actor,
      now,
      now,
    ),
    db.prepare(`
      INSERT INTO project_map_placements (
        id, project_item_id, x, y, width, height, z_index,
        revision, last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).bind(
      input.placementId,
      input.itemId,
      input.geometry.x,
      input.geometry.y,
      input.geometry.width,
      input.geometry.height,
      input.geometry.zIndex,
      input.operationId,
      actor,
      actor,
      now,
      now,
    ),
  ];

  try {
    const results = await db.batch(statements);
    if (results.length !== 5
      || resultChanges(results[0]) !== 1
      || resultChanges(results[1]) !== 1
      || resultChanges(results[2]) !== 1
      || resultChanges(results[3]) !== 1
      || resultChanges(results[4]) !== 1) {
      throw new ProjectServiceError(
        "conflict",
        "Project attachment copy did not commit atomically",
      );
    }
  } catch (error) {
    if (await destinationItemExists(db, projectId, input.itemId)) {
      return exactReplay(db, projectId, createInput, actor, now);
    }
    if (error instanceof ProjectServiceError) throw error;
    if (constraintConflict(error)) {
      throw new ProjectServiceError(
        "conflict",
        "Project revision, source attachment, blob, or identity conflict",
      );
    }
    throw error;
  }

  const committed = await exactReplay(db, projectId, createInput, actor, now);
  return { ...committed, replayed: false };
}
