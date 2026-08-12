import type {
  CreateAttachmentProjectItemInput,
  ProjectItemMutationResponse,
} from "../../shared/project-api";
import { MAX_PROJECT_SAFE_INTEGER } from "../../shared/project-types";
import {
  serializeProject,
  serializeProjectAttachment,
  serializeProjectContent,
  serializeProjectItem,
  serializeProjectPlacement,
  type ProjectAttachmentRow,
  type ProjectContentRow,
  type ProjectItemRow,
  type ProjectPlacementRow,
  type ProjectRow,
} from "./serializers";
import { ProjectServiceError } from "./service";

type AttachmentBundle = {
  item: ProjectItemRow;
  content: ProjectContentRow | null;
  attachment: ProjectAttachmentRow | null;
  placement: ProjectPlacementRow | null;
};

type BlobRecordRow = {
  id: string;
  original_name: string;
  mime_type: string;
  byte_size: number;
};

function resultRows<T>(result: unknown): T[] {
  return ((result as { results?: T[] } | undefined)?.results ?? []);
}

function resultChanges(result: unknown): number {
  return Number((result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
}

function conflict(message: string): never {
  throw new ProjectServiceError("conflict", message);
}

function notFound(message: string): never {
  throw new ProjectServiceError("not_found", message);
}

function constraintConflict(error: unknown) {
  return /(constraint|unique|foreign key|project |blob locator|attachment)/i
    .test(String(error));
}

function geometryMatches(
  row: ProjectPlacementRow,
  input: CreateAttachmentProjectItemInput,
) {
  return Number(row.x) === input.geometry.x
    && Number(row.y) === input.geometry.y
    && Number(row.width) === input.geometry.width
    && Number(row.height) === input.geometry.height
    && Number(row.z_index) === input.geometry.zIndex;
}

async function readProjectRow(db: D1Database, projectId: string) {
  return db.prepare(`
    SELECT * FROM projects
    WHERE id = ? AND deleted_at IS NULL
    LIMIT 1
  `).bind(projectId).first<ProjectRow>();
}

async function requireActiveProject(db: D1Database, projectId: string) {
  const row = await readProjectRow(db, projectId);
  if (!row) notFound("Project not found");
  return row;
}

async function readAttachmentBundle(
  db: D1Database,
  projectId: string,
  itemId: string,
): Promise<AttachmentBundle | null> {
  const results = await db.batch([
    db.prepare(`
      SELECT * FROM project_items
      WHERE id = ? AND project_id = ?
      LIMIT 1
    `).bind(itemId, projectId),
    db.prepare(`
      SELECT pc.*
      FROM project_items pi
      JOIN project_contents pc ON pc.id = pi.project_content_id
      WHERE pi.id = ? AND pi.project_id = ?
      LIMIT 1
    `).bind(itemId, projectId),
    db.prepare(`
      SELECT pca.*, pc.project_id
      FROM project_items pi
      JOIN project_contents pc ON pc.id = pi.project_content_id
      JOIN project_content_attachments pca ON pca.project_content_id = pc.id
      WHERE pi.id = ? AND pi.project_id = ?
      LIMIT 1
    `).bind(itemId, projectId),
    db.prepare(`
      SELECT pmp.*
      FROM project_map_placements pmp
      JOIN project_items pi ON pi.id = pmp.project_item_id
      WHERE pi.id = ? AND pi.project_id = ?
      LIMIT 1
    `).bind(itemId, projectId),
  ]);
  const item = resultRows<ProjectItemRow>(results[0])[0];
  if (!item) return null;
  return {
    item,
    content: resultRows<ProjectContentRow>(results[1])[0] ?? null,
    attachment: resultRows<ProjectAttachmentRow>(results[2])[0] ?? null,
    placement: resultRows<ProjectPlacementRow>(results[3])[0] ?? null,
  };
}

function bundleMatchesAttachmentCreate(
  bundle: AttachmentBundle,
  input: CreateAttachmentProjectItemInput,
) {
  const locatorMatches = "assetId" in input.locator
    ? bundle.attachment?.asset_id === input.locator.assetId
    : bundle.attachment?.storage_object_id === input.locator.storageObjectId;
  const intrinsicMatches = !input.intrinsicMetadata || (
    bundle.attachment?.original_name === input.intrinsicMetadata.originalName
    && bundle.attachment.mime_type === input.intrinsicMetadata.mimeType
    && Number(bundle.attachment.byte_size) === input.intrinsicMetadata.byteSize
  );
  return bundle.item.item_type === "content"
    && bundle.item.id === input.itemId
    && bundle.item.project_content_id === input.contentId
    && bundle.item.last_mutation_id === input.operationId
    && bundle.item.deleted_at === null
    && bundle.content?.content_type === "attachment"
    && bundle.content.id === input.contentId
    && bundle.content.attachment_caption === input.caption
    && bundle.content.attachment_source_url === input.sourceUrl
    && bundle.content.last_mutation_id === input.operationId
    && bundle.content.deleted_at === null
    && bundle.attachment?.creation_operation_id === input.operationId
    && locatorMatches
    && intrinsicMatches
    && bundle.placement?.id === input.placementId
    && bundle.placement.last_mutation_id === input.operationId
    && geometryMatches(bundle.placement, input);
}

async function itemMutationResponse(
  db: D1Database,
  projectId: string,
  itemId: string,
  replayed: boolean,
): Promise<ProjectItemMutationResponse> {
  const [bundle, project] = await Promise.all([
    readAttachmentBundle(db, projectId, itemId),
    requireActiveProject(db, projectId),
  ]);
  if (!bundle || !bundle.content || !bundle.attachment || !bundle.placement) {
    conflict("Project attachment is missing authoritative records");
  }
  return {
    item: serializeProjectItem(bundle.item),
    content: serializeProjectContent(bundle.content),
    attachment: serializeProjectAttachment(bundle.attachment),
    placement: serializeProjectPlacement(bundle.placement),
    project: serializeProject(project),
    replayed,
  };
}

async function readAttachmentBlobRecord(
  db: D1Database,
  input: CreateAttachmentProjectItemInput,
): Promise<BlobRecordRow> {
  if ("assetId" in input.locator) {
    const row = await db.prepare(`
      SELECT a.id, a.original_name, a.mime_type, a.byte_size
      FROM assets a
      WHERE a.id = ? AND a.status = 'ready'
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
        )
      LIMIT 1
    `).bind(input.locator.assetId).first<BlobRecordRow>();
    if (!row) throw new ProjectServiceError("blob_unavailable", "The selected asset is unavailable");
    return row;
  }

  const row = await db.prepare(`
    SELECT mso.id, mso.original_name, mso.mime_type, mso.byte_size
    FROM managed_storage_objects mso
    WHERE mso.id = ? AND mso.status IN ('ready', 'orphaned')
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'managed' AND bg.provider = mso.provider
          AND bg.object_key = mso.object_key AND bg.state IN ('deleting', 'deleted')
      )
    LIMIT 1
  `).bind(input.locator.storageObjectId).first<BlobRecordRow>();
  if (!row) throw new ProjectServiceError("blob_unavailable", "The selected managed file is unavailable");
  return row;
}

function reserveProjectSequenceStatement(
  db: D1Database,
  projectId: string,
  expectedRevision: number,
  operationId: string,
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
    operationId,
    actor,
    now,
    projectId,
    expectedRevision,
    MAX_PROJECT_SAFE_INTEGER,
    MAX_PROJECT_SAFE_INTEGER,
  );
}

function sequenceSubquerySql() {
  return `(SELECT next_created_sequence - 1
    FROM projects
    WHERE id = ? AND last_mutation_id = ? AND updated_at = ? AND deleted_at IS NULL)`;
}

async function returnCreateReplayOrConflict(
  db: D1Database,
  projectId: string,
  input: CreateAttachmentProjectItemInput,
) {
  const bundle = await readAttachmentBundle(db, projectId, input.itemId);
  if (bundle && bundleMatchesAttachmentCreate(bundle, input)) {
    return itemMutationResponse(db, projectId, input.itemId, true);
  }
  conflict("A Project identity or operation ID was already used for a different attachment");
}

export async function createAttachmentProjectItem(
  db: D1Database,
  projectId: string,
  input: CreateAttachmentProjectItemInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectItemMutationResponse> {
  const existing = await readAttachmentBundle(db, projectId, input.itemId);
  if (existing) {
    if (bundleMatchesAttachmentCreate(existing, input)) {
      return itemMutationResponse(db, projectId, input.itemId, true);
    }
    conflict("A Project identity or operation ID was already used for a different attachment");
  }
  await requireActiveProject(db, projectId);
  const blob = await readAttachmentBlobRecord(db, input);
  if (input.intrinsicMetadata && input.intrinsicMetadata.byteSize !== Number(blob.byte_size)) {
    conflict("Project attachment byte-size metadata does not match the uploaded blob");
  }
  const intrinsic = input.intrinsicMetadata ?? {
    originalName: blob.original_name,
    mimeType: blob.mime_type,
    byteSize: Number(blob.byte_size),
  };
  const assetId = "assetId" in input.locator ? input.locator.assetId : null;
  const storageObjectId = "storageObjectId" in input.locator
    ? input.locator.storageObjectId
    : null;

  const statements = [
    reserveProjectSequenceStatement(
      db,
      projectId,
      input.expectedProjectRevision,
      input.operationId,
      actor,
      now,
    ),
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
    db.prepare(`
      INSERT INTO project_content_attachments (
        project_content_id, asset_id, storage_object_id,
        original_name, mime_type, byte_size,
        created_by, created_at, creation_operation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.contentId,
      assetId,
      storageObjectId,
      intrinsic.originalName,
      intrinsic.mimeType,
      intrinsic.byteSize,
      actor,
      now,
      input.operationId,
    ),
    db.prepare(`
      INSERT INTO project_items (
        id, project_id, item_type, project_content_id, reference_target_id,
        created_sequence, revision, last_mutation_id,
        created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, 'content', ?, NULL, ${sequenceSubquerySql()},
                1, ?, ?, ?, ?, ?)
    `).bind(
      input.itemId,
      projectId,
      input.contentId,
      projectId,
      input.operationId,
      now,
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
    if (results.some((result) => resultChanges(result) !== 1)) {
      return returnCreateReplayOrConflict(db, projectId, input);
    }
  } catch (error) {
    const replay = await readAttachmentBundle(db, projectId, input.itemId);
    if (replay && bundleMatchesAttachmentCreate(replay, input)) {
      return itemMutationResponse(db, projectId, input.itemId, true);
    }
    if (constraintConflict(error)) conflict("Project revision, blob, or identity conflict");
    throw error;
  }
  return itemMutationResponse(db, projectId, input.itemId, false);
}