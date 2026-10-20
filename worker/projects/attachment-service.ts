import type { CreateAttachmentProjectItemInput, ProjectItemLifecycleInput, ProjectItemMutationResponse } from "../../shared/project-api";
import { MAX_PROJECT_SAFE_INTEGER } from "../../shared/project-types";
import { fileAuthorityActiveSqlWithDatabase, prepareFileRestorationWithDatabase } from "../files/business-lifecycle-service";
import { consumerFileBindingFenceWithDatabase, resolveConsumerFileIdWithDatabase } from "../files/consumer-binding-service";
import { geometryMatches, readItemBundle, requireItemBundle, requireActiveProject, itemMutationResponse, reserveProjectSequenceStatement, returnCreateReplayOrConflict } from "./workspace-service";
import type { ProjectWorkspaceStatement } from "./workspace-sql";
import type { ProjectAttachmentDatabase } from "./attachment-sql";
import { ProjectServiceError } from "./errors";
type BlobRecordRow = { r2_key?: string | null; id: string; original_name: string; mime_type: string; byte_size: number | bigint };
type AttachmentPresentation = NonNullable<CreateAttachmentProjectItemInput["presentation"]>;
/** Complete original attachment creation and item restoration algorithms. This
 * neutral structural database is not a File grant, provider or HTTP adapter. */
function resultRows<T>(result: unknown): T[] {
  return ((result as { results?: T[] } | undefined)?.results ?? []);
}

function resultChanges(result: unknown): number {
  return Number((result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
}

function topLevelChanges(result: unknown): number {
  return Number(resultRows<{ affected_rows: number }>(result)[0]?.affected_rows ?? 0);
}

async function batchMutationChanges(db: ProjectAttachmentDatabase, statements: ProjectWorkspaceStatement[]) {
  // D1 meta.changes includes trigger writes. Read SQLite's top-level count
  // immediately after each mutation, within the same atomic batch.
  const results = await db.atomicBatch(statements.flatMap((statement) => [
    statement,
    db.prepare("SELECT changes() AS affected_rows"),
  ]));
  return statements.map((_, index) => topLevelChanges(results[index * 2 + 1]));
}

function conflict(message: string): never {
  throw new ProjectServiceError("conflict", message);
}

function constraintConflict(error: unknown) {
  return /(constraint|unique|foreign key|project |reference target|blob locator|attachment)/i
    .test(String(error));
}

function sequenceSubquerySql() {
  return `(SELECT next_created_sequence - 1
    FROM projects
    WHERE id = ? AND last_mutation_id = ? AND updated_at = ? AND deleted_at IS NULL)`;
}

function bundleMatchesAttachmentCreateBase(
  bundle: NonNullable<Awaited<ReturnType<typeof readItemBundle>>>,
  input: CreateAttachmentProjectItemInput,
) {
  const locatorMatches = "assetId" in input.locator
    ? bundle.attachment?.asset_id === input.locator.assetId
    : bundle.attachment?.storage_object_id === input.locator.storageObjectId;
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
    && bundle.placement?.id === input.placementId
    && bundle.placement.last_mutation_id === input.operationId
    && geometryMatches(bundle.placement, input.geometry);
}

function bundleMatchesAttachmentCreate(
  bundle: NonNullable<Awaited<ReturnType<typeof readItemBundle>>>,
  input: CreateAttachmentProjectItemInput,
  presentation: AttachmentPresentation,
) {
  return bundleMatchesAttachmentCreateBase(bundle, input)
    && bundle.attachment?.original_name === presentation.originalName
    && bundle.attachment.mime_type === presentation.mimeType
    && Number(bundle.attachment.byte_size) === presentation.byteSize;
}

async function readAttachmentBlobRecord(
  db: ProjectAttachmentDatabase,
  input: CreateAttachmentProjectItemInput,
): Promise<BlobRecordRow> {
  if ("assetId" in input.locator) {
    const row = await db.prepare(`
      SELECT a.id, a.r2_key, a.original_name, a.mime_type, a.byte_size
      FROM assets a
      WHERE a.id = ? AND a.status = 'ready'
        AND (${await fileAuthorityActiveSqlWithDatabase(db)} OR NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
        ))
        AND (${await fileAuthorityActiveSqlWithDatabase(db)} OR NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        ))
        AND (
          a.import_id IS NULL
          OR EXISTS (
            SELECT 1 FROM imports i
            WHERE i.id = a.import_id AND i.status = 'ready'
          )
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
      AND (${await fileAuthorityActiveSqlWithDatabase(db)} OR NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'managed' AND bg.provider = mso.provider
          AND bg.object_key = mso.object_key AND bg.state IN ('deleting', 'deleted')
      ))
      AND (${await fileAuthorityActiveSqlWithDatabase(db)} OR NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'managed' AND biq.provider = mso.provider
          AND biq.object_key = mso.object_key
      ))
    LIMIT 1
  `).bind(input.locator.storageObjectId).first<BlobRecordRow>();
  if (!row) throw new ProjectServiceError("blob_unavailable", "The selected managed file is unavailable");
  return row;
}

async function readAttachmentRegistrationRecord(
  db: ProjectAttachmentDatabase,
  input: CreateAttachmentProjectItemInput,
): Promise<BlobRecordRow | null> {
  if ("assetId" in input.locator) {
    return db.prepare(`
      SELECT id, original_name, mime_type, byte_size
      FROM assets
      WHERE id = ?
      LIMIT 1
    `).bind(input.locator.assetId).first<BlobRecordRow>();
  }
  return db.prepare(`
    SELECT id, original_name, mime_type, byte_size
    FROM managed_storage_objects
    WHERE id = ?
    LIMIT 1
  `).bind(input.locator.storageObjectId).first<BlobRecordRow>();
}

export async function createAttachmentProjectItemWithDatabase(
  db: ProjectAttachmentDatabase,
  projectId: string,
  input: CreateAttachmentProjectItemInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectItemMutationResponse> {
  const existing = await readItemBundle(db, projectId, input.itemId);
  if (existing) {
    if (bundleMatchesAttachmentCreateBase(existing, input)) {
      const registration = input.presentation
        ? null
        : await readAttachmentRegistrationRecord(db, input);
      const replayPresentation: AttachmentPresentation | null = input.presentation ?? (
        registration
          ? {
            originalName: registration.original_name,
            mimeType: registration.mime_type,
            byteSize: Number(registration.byte_size),
          }
          : null
      );
      if (replayPresentation
        && bundleMatchesAttachmentCreate(existing, input, replayPresentation)) {
        return itemMutationResponse(db, projectId, input.itemId, true);
      }
    }
    conflict("A Project identity or operation ID was already used for a different attachment");
  }
  await requireActiveProject(db, projectId);
  const blob = await readAttachmentBlobRecord(db, input);
  const presentation: AttachmentPresentation = input.presentation ?? {
    originalName: blob.original_name,
    mimeType: blob.mime_type,
    byteSize: Number(blob.byte_size),
  };
  if (presentation.byteSize !== Number(blob.byte_size)) {
    conflict("Project attachment byte size does not match the selected blob");
  }
  const assetId = "assetId" in input.locator ? input.locator.assetId : null;
  const storageObjectId = "storageObjectId" in input.locator
    ? input.locator.storageObjectId
    : null;
  const binding = { assetId: assetId ?? undefined, storageObjectId: storageObjectId ?? undefined,
    nativeAsset: assetId !== null && blob.r2_key === null, purpose: "research_source" as const };
  const fileId = await resolveConsumerFileIdWithDatabase(db, binding);

  const statements = [
    ...(fileId ? [consumerFileBindingFenceWithDatabase(db, binding, fileId)] : []),
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
        created_by, created_at, creation_operation_id${fileId ? ', file_id' : ''}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?${fileId ? ', ?' : ''})
    `).bind(
      input.contentId,
      assetId,
      storageObjectId,
      presentation.originalName,
      presentation.mimeType,
      presentation.byteSize,
      actor,
      now,
      input.operationId,
      ...(fileId ? [fileId] : []),
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
    const changes = (await batchMutationChanges(db, statements)).slice(fileId ? 1 : 0);
    if (
      changes[0] !== 1
      || changes[1] !== 1
      || changes[2] < 1
      || changes[3] !== 1
      || changes[4] !== 1
    ) {
      return returnCreateReplayOrConflict(
        db,
        projectId,
        input.itemId,
        (bundle) => bundleMatchesAttachmentCreate(bundle, input, presentation),
      );
    }
  } catch (error) {
    const replay = await readItemBundle(db, projectId, input.itemId);
    if (replay && bundleMatchesAttachmentCreate(replay, input, presentation)) {
      return itemMutationResponse(db, projectId, input.itemId, true);
    }
    if (constraintConflict(error)) conflict("Project revision, blob, or identity conflict");
    throw error;
  }
  return itemMutationResponse(db, projectId, input.itemId, false);
}

export async function restoreProjectItemWithDatabase(
  db: ProjectAttachmentDatabase,
  projectId: string,
  itemId: string,
  input: ProjectItemLifecycleInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectItemMutationResponse> {
  await requireActiveProject(db, projectId);
  const current = await requireItemBundle(db, projectId, itemId);
  if (current.item.deleted_at === null) {
    const contentReplayed = !current.content
      || (current.content.deleted_at === null
        && current.content.last_mutation_id === input.operationId);
    if (current.item.last_mutation_id === input.operationId && contentReplayed) {
      return itemMutationResponse(db, projectId, itemId, true);
    }
    conflict("Project item is already active");
  }
  if (current.item.revision !== input.expectedItemRevision) conflict("Item revision conflict");
  if (current.content) {
    if (input.expectedContentRevision === undefined
      || current.content.revision !== input.expectedContentRevision) {
      conflict("Content revision conflict");
    }
  } else if (input.expectedContentRevision !== undefined) {
    conflict("Reference items do not own Project content");
  }

  const statements: ProjectWorkspaceStatement[] = [];
  if (current.content) {
    statements.push(db.prepare(`
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
    `).bind(
      input.operationId,
      actor,
      now,
      current.content.id,
      projectId,
      input.expectedContentRevision,
      MAX_PROJECT_SAFE_INTEGER,
      itemId,
      projectId,
      input.expectedItemRevision,
    ));
  }
  statements.push(db.prepare(`
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
  `).bind(
    input.operationId,
    actor,
    now,
    itemId,
    projectId,
    input.expectedItemRevision,
    MAX_PROJECT_SAFE_INTEGER,
    input.operationId,
  ));

  const fences = current.content?.content_type === "attachment"
    ? await prepareFileRestorationWithDatabase(db, "project_attachment", [current.content.id]) : [];
  const results = (await db.atomicBatch([...fences, ...statements])).slice(fences.length);
  if (!resultChanges(results.at(-1))) conflict("Item or content revision conflict");
  if (current.content && !resultChanges(results[0])) {
    throw new Error("Owned content restore did not accompany item restore");
  }
  return itemMutationResponse(db, projectId, itemId, false);
}

