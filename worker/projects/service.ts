import type {
  CreateAttachmentProjectItemInput,
  CreateMarkdownProjectItemInput,
  CreateProjectEdgeInput,
  CreateProjectInput,
  CreateReferenceProjectItemInput,
  ProjectAttachmentRecord,
  ProjectEdgeLifecycleInput,
  ProjectItemLifecycleInput,
  ProjectItemMutationResponse,
  ProjectLifecycleInput,
  ProjectListResponse,
  ProjectMutationResponse,
  ProjectRowMutationResponse,
  ProjectSnapshot,
  RenameProjectInput,
  UpdateProjectAttachmentInput,
  UpdateProjectEdgeInput,
  UpdateProjectMarkdownInput,
  UpdateProjectPlacementInput,
} from "../../shared/project-api";
import type {
  ReferenceResolution,
  ReferenceTarget,
  ReferenceTargetType,
} from "../../shared/reference-types";
import {
  MAX_PROJECT_SAFE_INTEGER,
  PROJECT_SCHEMA_VERSION,
} from "../../shared/project-types";
import type { BlobLocator } from "../blob-lifecycle/types";
import { referenceResolutionIsEligible } from "../references/eligibility";
import {
  referenceRegistrationStatements,
} from "../references/registry";
import {
  referenceTargetKey,
  resolveReferences,
} from "../references/resolver";
import {
  serializeProject,
  serializeProjectAttachment,
  serializeProjectContent,
  serializeProjectEdge,
  serializeProjectItem,
  serializeProjectPlacement,
  type ProjectAttachmentRow,
  type ProjectContentRow,
  type ProjectEdgeRow,
  type ProjectItemRow,
  type ProjectPlacementRow,
  type ProjectRow,
} from "./serializers";

export type ProjectServiceErrorCode =
  | "not_found"
  | "conflict"
  | "reference_unavailable"
  | "blob_unavailable";

export class ProjectServiceError extends Error {
  constructor(
    readonly code: ProjectServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectServiceError";
  }
}

type ReferenceRegistryRow = {
  id: string;
  target_type: ReferenceTargetType;
  target_id: string;
};

type ItemBundle = {
  item: ProjectItemRow;
  content: ProjectContentRow | null;
  attachment: ProjectAttachmentRow | null;
  placement: ProjectPlacementRow | null;
  referenceTarget: ReferenceRegistryRow | null;
};

type BlobRecordRow = {
  id: string;
  original_name: string;
  mime_type: string;
  byte_size: number;
};

export type ProjectAttachmentMediaSource = {
  locator: BlobLocator;
  originalName: string;
  mimeType: string;
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

function geometryMatches(
  row: ProjectPlacementRow,
  geometry: { x: number; y: number; width: number; height: number; zIndex: number },
) {
  return Number(row.x) === geometry.x
    && Number(row.y) === geometry.y
    && Number(row.width) === geometry.width
    && Number(row.height) === geometry.height
    && Number(row.z_index) === geometry.zIndex;
}

function edgeShapeMatches(
  row: ProjectEdgeRow,
  input: Pick<CreateProjectEdgeInput, "sourceHandle" | "targetHandle" | "markerStart" | "markerEnd" | "label">,
) {
  return row.source_handle === input.sourceHandle
    && row.target_handle === input.targetHandle
    && row.marker_start === input.markerStart
    && row.marker_end === input.markerEnd
    && row.label === input.label;
}

function constraintConflict(error: unknown) {
  return /(constraint|unique|foreign key|project |reference target|blob locator|attachment)/i
    .test(String(error));
}

async function readProjectRow(
  db: D1Database,
  projectId: string,
  includeDeleted = false,
): Promise<ProjectRow | null> {
  return db.prepare(`
    SELECT * FROM projects
    WHERE id = ? AND (? = 1 OR deleted_at IS NULL)
    LIMIT 1
  `).bind(projectId, includeDeleted ? 1 : 0).first<ProjectRow>();
}

async function requireActiveProject(db: D1Database, projectId: string) {
  const row = await readProjectRow(db, projectId);
  if (!row) notFound("Project not found");
  return row;
}

async function readProjectContentRow(
  db: D1Database,
  projectId: string,
  contentId: string,
  includeDeleted = false,
): Promise<ProjectContentRow | null> {
  return db.prepare(`
    SELECT pc.*
    FROM project_contents pc
    JOIN projects p ON p.id = pc.project_id
    WHERE pc.id = ? AND pc.project_id = ?
      AND p.deleted_at IS NULL
      AND (? = 1 OR pc.deleted_at IS NULL)
    LIMIT 1
  `).bind(contentId, projectId, includeDeleted ? 1 : 0).first<ProjectContentRow>();
}

async function readProjectPlacementRow(
  db: D1Database,
  projectId: string,
  placementId: string,
): Promise<ProjectPlacementRow | null> {
  return db.prepare(`
    SELECT pmp.*
    FROM project_map_placements pmp
    JOIN project_items pi ON pi.id = pmp.project_item_id
    JOIN projects p ON p.id = pi.project_id
    WHERE pmp.id = ? AND pi.project_id = ?
      AND pi.deleted_at IS NULL AND p.deleted_at IS NULL
    LIMIT 1
  `).bind(placementId, projectId).first<ProjectPlacementRow>();
}

async function readProjectEdgeRow(
  db: D1Database,
  projectId: string,
  edgeId: string,
  includeDeleted = false,
): Promise<ProjectEdgeRow | null> {
  return db.prepare(`
    SELECT pe.*
    FROM project_edges pe
    JOIN projects p ON p.id = pe.project_id
    WHERE pe.id = ? AND pe.project_id = ?
      AND p.deleted_at IS NULL
      AND (? = 1 OR pe.deleted_at IS NULL)
    LIMIT 1
  `).bind(edgeId, projectId, includeDeleted ? 1 : 0).first<ProjectEdgeRow>();
}

async function readItemBundle(
  db: D1Database,
  projectId: string,
  itemId: string,
): Promise<ItemBundle | null> {
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
    db.prepare(`
      SELECT rt.id, rt.target_type, rt.target_id
      FROM project_items pi
      JOIN reference_targets rt ON rt.id = pi.reference_target_id
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
    referenceTarget: resultRows<ReferenceRegistryRow>(results[4])[0] ?? null,
  };
}

async function requireItemBundle(db: D1Database, projectId: string, itemId: string) {
  const bundle = await readItemBundle(db, projectId, itemId);
  if (!bundle) notFound("Project item not found");
  if (!bundle.placement) {
    conflict("Project item is missing its authoritative placement");
  }
  return bundle;
}

async function itemMutationResponse(
  db: D1Database,
  projectId: string,
  itemId: string,
  replayed: boolean,
): Promise<ProjectItemMutationResponse> {
  const [bundle, project] = await Promise.all([
    requireItemBundle(db, projectId, itemId),
    requireActiveProject(db, projectId),
  ]);
  if (!bundle.placement) throw new Error("Project item is missing its authoritative placement");
  return {
    item: serializeProjectItem(bundle.item),
    content: bundle.content ? serializeProjectContent(bundle.content) : null,
    attachment: bundle.attachment ? serializeProjectAttachment(bundle.attachment) : null,
    placement: serializeProjectPlacement(bundle.placement),
    project: serializeProject(project),
    replayed,
  };
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

function bundleMatchesMarkdownCreate(
  bundle: ItemBundle,
  input: CreateMarkdownProjectItemInput,
) {
  return bundle.item.item_type === "content"
    && bundle.item.id === input.itemId
    && bundle.item.project_content_id === input.contentId
    && bundle.item.last_mutation_id === input.operationId
    && bundle.item.deleted_at === null
    && bundle.content?.content_type === "markdown"
    && bundle.content.id === input.contentId
    && bundle.content.markdown_source === input.markdownSource
    && bundle.content.last_mutation_id === input.operationId
    && bundle.content.deleted_at === null
    && bundle.placement?.id === input.placementId
    && bundle.placement.last_mutation_id === input.operationId
    && geometryMatches(bundle.placement, input.geometry);
}

function bundleMatchesReferenceCreate(
  bundle: ItemBundle,
  input: CreateReferenceProjectItemInput,
) {
  return bundle.item.item_type === "reference"
    && bundle.item.id === input.itemId
    && bundle.item.last_mutation_id === input.operationId
    && bundle.item.deleted_at === null
    && bundle.referenceTarget?.target_type === input.target.type
    && bundle.referenceTarget.target_id === input.target.id
    && bundle.placement?.id === input.placementId
    && bundle.placement.last_mutation_id === input.operationId
    && geometryMatches(bundle.placement, input.geometry);
}

function bundleMatchesAttachmentCreate(
  bundle: ItemBundle,
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

async function returnCreateReplayOrConflict(
  db: D1Database,
  projectId: string,
  itemId: string,
  matches: (bundle: ItemBundle) => boolean,
) {
  const bundle = await readItemBundle(db, projectId, itemId);
  if (bundle && matches(bundle)) return itemMutationResponse(db, projectId, itemId, true);
  conflict("A Project identity or operation ID was already used for different content");
}

export async function listProjects(
  db: D1Database,
  includeDeleted = false,
): Promise<ProjectListResponse> {
  const result = await db.prepare(`
    SELECT * FROM projects
    WHERE (? = 1 OR deleted_at IS NULL)
    ORDER BY (deleted_at IS NOT NULL), updated_at DESC, id
  `).bind(includeDeleted ? 1 : 0).all<ProjectRow>();
  return { projects: result.results.map(serializeProject) };
}

export async function createProject(
  db: D1Database,
  input: CreateProjectInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectMutationResponse> {
  const results = await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO projects (
        id, title, revision, next_created_sequence, last_mutation_id,
        created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?)
    `).bind(input.id, input.title, input.operationId, actor, actor, now, now),
    db.prepare("SELECT * FROM projects WHERE id = ? LIMIT 1").bind(input.id),
  ]);
  const row = resultRows<ProjectRow>(results[1])[0];
  if (!row) throw new Error("Project creation did not return a row");
  const inserted = resultChanges(results[0]) === 1;
  if (!inserted && (
    row.title !== input.title
    || row.last_mutation_id !== input.operationId
    || row.created_by !== actor
  )) {
    conflict("The Project ID or operation ID is already in use");
  }
  return { project: serializeProject(row), replayed: !inserted };
}

export async function renameProject(
  db: D1Database,
  projectId: string,
  input: RenameProjectInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectMutationResponse> {
  const current = await requireActiveProject(db, projectId);
  if (current.last_mutation_id === input.operationId) {
    if (current.title !== input.title) conflict("The operation ID was reused with a different title");
    return { project: serializeProject(current), replayed: true };
  }
  if (current.revision !== input.expectedRevision) conflict("Project revision conflict");
  if (current.title === input.title) return { project: serializeProject(current), replayed: false };

  const result = await db.prepare(`
    UPDATE projects
    SET title = ?, revision = revision + 1, last_mutation_id = ?,
        updated_by = ?, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NULL AND revision < ?
  `).bind(
    input.title,
    input.operationId,
    actor,
    now,
    projectId,
    input.expectedRevision,
    MAX_PROJECT_SAFE_INTEGER,
  ).run();
  if (!result.meta.changes) conflict("Project revision conflict");
  const updated = await requireActiveProject(db, projectId);
  return { project: serializeProject(updated), replayed: false };
}

export async function deleteProject(
  db: D1Database,
  projectId: string,
  input: ProjectLifecycleInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectMutationResponse> {
  const current = await readProjectRow(db, projectId, true);
  if (!current) notFound("Project not found");
  if (current.deleted_at !== null) {
    if (current.deletion_operation_id === input.operationId
      && current.last_mutation_id === input.operationId) {
      return { project: serializeProject(current), replayed: true };
    }
    conflict("Project is already deleted");
  }
  if (current.last_mutation_id === input.operationId) {
    conflict("The operation ID was reused with different Project state");
  }
  if (current.revision !== input.expectedRevision) conflict("Project revision conflict");

  const result = await db.prepare(`
    UPDATE projects
    SET deleted_at = ?, deleted_by = ?, deletion_operation_id = ?,
        revision = revision + 1, last_mutation_id = ?,
        updated_by = ?, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NULL AND revision < ?
  `).bind(
    now,
    actor,
    input.operationId,
    input.operationId,
    actor,
    now,
    projectId,
    input.expectedRevision,
    MAX_PROJECT_SAFE_INTEGER,
  ).run();
  if (!result.meta.changes) conflict("Project revision conflict");
  const updated = await readProjectRow(db, projectId, true);
  if (!updated) throw new Error("Deleted Project disappeared");
  return { project: serializeProject(updated), replayed: false };
}

export async function restoreProject(
  db: D1Database,
  projectId: string,
  input: ProjectLifecycleInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectMutationResponse> {
  const current = await readProjectRow(db, projectId, true);
  if (!current) notFound("Project not found");
  if (current.deleted_at === null) {
    if (current.last_mutation_id === input.operationId) {
      return { project: serializeProject(current), replayed: true };
    }
    conflict("Project is already active");
  }
  if (current.revision !== input.expectedRevision) conflict("Project revision conflict");

  const result = await db.prepare(`
    UPDATE projects
    SET deleted_at = NULL, deleted_by = NULL, deletion_operation_id = NULL,
        revision = revision + 1, last_mutation_id = ?,
        updated_by = ?, updated_at = ?
    WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL AND revision < ?
  `).bind(
    input.operationId,
    actor,
    now,
    projectId,
    input.expectedRevision,
    MAX_PROJECT_SAFE_INTEGER,
  ).run();
  if (!result.meta.changes) conflict("Project revision conflict");
  const updated = await requireActiveProject(db, projectId);
  return { project: serializeProject(updated), replayed: false };
}

export async function readProjectSnapshot(
  db: D1Database,
  projectId: string,
  includeDeleted = false,
): Promise<ProjectSnapshot> {
  const results = await db.batch([
    db.prepare(`
      SELECT * FROM projects
      WHERE id = ? AND (? = 1 OR deleted_at IS NULL)
      LIMIT 1
    `).bind(projectId, includeDeleted ? 1 : 0),
    db.prepare(`
      SELECT pc.*
      FROM project_contents pc
      JOIN project_items pi ON pi.project_content_id = pc.id
      WHERE pc.project_id = ?
    AND (? = 1 OR (pc.deleted_at IS NULL AND pi.deleted_at IS NULL))
  ORDER BY pi.created_sequence, pc.id
`).bind(projectId, includeDeleted ? 1 : 0),
    db.prepare(`
      SELECT pca.*, pc.project_id
      FROM project_content_attachments pca
      JOIN project_contents pc ON pc.id = pca.project_content_id
      JOIN project_items pi ON pi.project_content_id = pc.id
      WHERE pc.project_id = ?
    AND (? = 1 OR (pc.deleted_at IS NULL AND pi.deleted_at IS NULL))
  ORDER BY pi.created_sequence, pca.project_content_id
`).bind(projectId, includeDeleted ? 1 : 0),
    db.prepare(`
      SELECT * FROM project_items
  WHERE project_id = ? AND (? = 1 OR deleted_at IS NULL)
  ORDER BY created_sequence, id
`).bind(projectId, includeDeleted ? 1 : 0),
    db.prepare(`
      SELECT pmp.*
      FROM project_map_placements pmp
      JOIN project_items pi ON pi.id = pmp.project_item_id
      WHERE pi.project_id = ? AND (? = 1 OR pi.deleted_at IS NULL)
  ORDER BY pi.created_sequence, pmp.id
`).bind(projectId, includeDeleted ? 1 : 0),
    db.prepare(`
      SELECT pe.*
      FROM project_edges pe
      JOIN project_items source ON source.id = pe.source_item_id
      JOIN project_items target ON target.id = pe.target_item_id
      WHERE pe.project_id = ?
    AND (? = 1 OR (
      pe.deleted_at IS NULL
      AND source.deleted_at IS NULL
      AND target.deleted_at IS NULL
    ))
  ORDER BY pe.created_at, pe.id
`).bind(projectId, includeDeleted ? 1 : 0),
    db.prepare(`
      SELECT DISTINCT rt.id, rt.target_type, rt.target_id
      FROM project_items pi
      JOIN reference_targets rt ON rt.id = pi.reference_target_id
      WHERE pi.project_id = ? AND (? = 1 OR pi.deleted_at IS NULL)
  ORDER BY rt.target_type, rt.target_id
`).bind(projectId, includeDeleted ? 1 : 0),
  ]);

  const project = resultRows<ProjectRow>(results[0])[0];
  if (!project) notFound("Project not found");
  const registryRows = resultRows<ReferenceRegistryRow>(results[6]);
  const targets: ReferenceTarget[] = registryRows.map((row) => ({
    type: row.target_type,
    id: row.target_id,
  }));
  const resolutions = targets.length ? await resolveReferences(db, targets) : [];
  const resolutionsByTarget = new Map(
    resolutions.map((resolution) => [referenceTargetKey(resolution.target), resolution]),
  );

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    project: serializeProject(project),
    contents: resultRows<ProjectContentRow>(results[1]).map(serializeProjectContent),
    attachments: resultRows<ProjectAttachmentRow>(results[2]).map(serializeProjectAttachment),
    items: resultRows<ProjectItemRow>(results[3]).map(serializeProjectItem),
    placements: resultRows<ProjectPlacementRow>(results[4]).map(serializeProjectPlacement),
    edges: resultRows<ProjectEdgeRow>(results[5]).map(serializeProjectEdge),
    references: registryRows.map((row) => ({
      registryId: row.id,
      resolution: resolutionsByTarget.get(referenceTargetKey({
        type: row.target_type,
        id: row.target_id,
      })) as ReferenceResolution,
    })),
  };
}

export async function createMarkdownProjectItem(
  db: D1Database,
  projectId: string,
  input: CreateMarkdownProjectItemInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectItemMutationResponse> {
  const existing = await readItemBundle(db, projectId, input.itemId);
  if (existing) {
    if (bundleMatchesMarkdownCreate(existing, input)) {
      return itemMutationResponse(db, projectId, input.itemId, true);
    }
    conflict("A Project identity or operation ID was already used for different content");
  }
  await requireActiveProject(db, projectId);

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
        id, project_id, content_type, markdown_source, format_version,
        revision, last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, 'markdown', ?, 1, 1, ?, ?, ?, ?, ?)
    `).bind(
      input.contentId,
      projectId,
      input.markdownSource,
      input.operationId,
      actor,
      actor,
      now,
      now,
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
      return returnCreateReplayOrConflict(
        db,
        projectId,
        input.itemId,
        (bundle) => bundleMatchesMarkdownCreate(bundle, input),
      );
    }
  } catch (error) {
    const replay = await readItemBundle(db, projectId, input.itemId);
    if (replay && bundleMatchesMarkdownCreate(replay, input)) {
      return itemMutationResponse(db, projectId, input.itemId, true);
    }
    if (constraintConflict(error)) conflict("Project revision or identity conflict");
    throw error;
  }
  return itemMutationResponse(db, projectId, input.itemId, false);
}

export async function createReferenceProjectItem(
  db: D1Database,
  projectId: string,
  input: CreateReferenceProjectItemInput,
  actor: string,
  now = new Date().toISOString(),
  registryId = crypto.randomUUID(),
): Promise<ProjectItemMutationResponse> {
  const existing = await readItemBundle(db, projectId, input.itemId);
  if (existing) {
    if (bundleMatchesReferenceCreate(existing, input)) {
      return itemMutationResponse(db, projectId, input.itemId, true);
    }
    conflict("A Project identity or operation ID was already used for a different reference");
  }
  await requireActiveProject(db, projectId);
  const [resolution] = await resolveReferences(db, [input.target]);
  if (!resolution || !referenceResolutionIsEligible(resolution)) {
    throw new ProjectServiceError(
      "reference_unavailable",
      "The reference target is not currently eligible for Project insertion",
    );
  }

  const statements = [
    reserveProjectSequenceStatement(
      db,
      projectId,
      input.expectedProjectRevision,
      input.operationId,
      actor,
      now,
    ),
    ...referenceRegistrationStatements(
      db,
      input.target,
      resolution.contexts,
      now,
      registryId,
    ),
    db.prepare(`
      INSERT INTO project_items (
        id, project_id, item_type, project_content_id, reference_target_id,
        created_sequence, revision, last_mutation_id,
        created_by, updated_by, created_at, updated_at
      ) VALUES (
        ?, ?, 'reference', NULL,
        (SELECT id FROM reference_targets
         WHERE target_type = ? AND target_id = ? AND tombstoned_at IS NULL),
        ${sequenceSubquerySql()},
        1, ?, ?, ?, ?, ?
      )
    `).bind(
      input.itemId,
      projectId,
      input.target.type,
      input.target.id,
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
    const reservation = resultChanges(results[0]);
    const item = resultChanges(results[3]);
    const placement = resultChanges(results[4]);
    if (reservation !== 1 || item !== 1 || placement !== 1) {
      return returnCreateReplayOrConflict(
        db,
        projectId,
        input.itemId,
        (bundle) => bundleMatchesReferenceCreate(bundle, input),
      );
    }
  } catch (error) {
    const replay = await readItemBundle(db, projectId, input.itemId);
    if (replay && bundleMatchesReferenceCreate(replay, input)) {
      return itemMutationResponse(db, projectId, input.itemId, true);
    }
    if (constraintConflict(error)) conflict("Project revision, reference, or identity conflict");
    throw error;
  }
  return itemMutationResponse(db, projectId, input.itemId, false);
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
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
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
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'managed' AND bg.provider = mso.provider
          AND bg.object_key = mso.object_key AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'managed' AND biq.provider = mso.provider
          AND biq.object_key = mso.object_key
      )
    LIMIT 1
  `).bind(input.locator.storageObjectId).first<BlobRecordRow>();
  if (!row) throw new ProjectServiceError("blob_unavailable", "The selected managed file is unavailable");
  return row;
}

export async function createAttachmentProjectItem(
  db: D1Database,
  projectId: string,
  input: CreateAttachmentProjectItemInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectItemMutationResponse> {
  const existing = await readItemBundle(db, projectId, input.itemId);
  if (existing) {
    if (bundleMatchesAttachmentCreate(existing, input)) {
      return itemMutationResponse(db, projectId, input.itemId, true);
    }
    conflict("A Project identity or operation ID was already used for a different attachment");
  }
  await requireActiveProject(db, projectId);
  const blob = await readAttachmentBlobRecord(db, input);
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
      blob.original_name,
      blob.mime_type,
      blob.byte_size,
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
    if (
    resultChanges(results[0]) !== 1
    || resultChanges(results[1]) !== 1
    || resultChanges(results[2]) < 1
    || resultChanges(results[3]) !== 1
    || resultChanges(results[4]) !== 1
  ) {
    return returnCreateReplayOrConflict(
      db,
      projectId,
      input.itemId,
      (bundle) => bundleMatchesAttachmentCreate(bundle, input),
    );
  }
  } catch (error) {
    const replay = await readItemBundle(db, projectId, input.itemId);
    if (replay && bundleMatchesAttachmentCreate(replay, input)) {
      return itemMutationResponse(db, projectId, input.itemId, true);
    }
    if (constraintConflict(error)) conflict("Project revision, blob, or identity conflict");
    throw error;
  }
  return itemMutationResponse(db, projectId, input.itemId, false);
}

export async function updateProjectMarkdown(
  db: D1Database,
  projectId: string,
  contentId: string,
  input: UpdateProjectMarkdownInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectRowMutationResponse<ReturnType<typeof serializeProjectContent>>> {
  const current = await readProjectContentRow(db, projectId, contentId);
  if (!current || current.content_type !== "markdown") notFound("Project Markdown content not found");
  if (current.last_mutation_id === input.operationId) {
    if (current.markdown_source !== input.markdownSource) {
      conflict("The operation ID was reused with different Markdown");
    }
    return { value: serializeProjectContent(current), replayed: true };
  }
  if (current.revision !== input.expectedRevision) conflict("Content revision conflict");
  if (current.markdown_source === input.markdownSource) {
    return { value: serializeProjectContent(current), replayed: false };
  }
  const result = await db.prepare(`
    UPDATE project_contents
    SET markdown_source = ?, revision = revision + 1,
        last_mutation_id = ?, updated_by = ?, updated_at = ?
    WHERE id = ? AND project_id = ? AND content_type = 'markdown'
      AND revision = ? AND deleted_at IS NULL AND revision < ?
  `).bind(
    input.markdownSource,
    input.operationId,
    actor,
    now,
    contentId,
    projectId,
    input.expectedRevision,
    MAX_PROJECT_SAFE_INTEGER,
  ).run();
  if (!result.meta.changes) conflict("Content revision conflict");
  const updated = await readProjectContentRow(db, projectId, contentId);
  if (!updated) throw new Error("Updated Markdown content disappeared");
  return { value: serializeProjectContent(updated), replayed: false };
}

export async function updateProjectAttachment(
  db: D1Database,
  projectId: string,
  contentId: string,
  input: UpdateProjectAttachmentInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectRowMutationResponse<ReturnType<typeof serializeProjectContent>>> {
  const current = await readProjectContentRow(db, projectId, contentId);
  if (!current || current.content_type !== "attachment") notFound("Project attachment content not found");
  if (current.last_mutation_id === input.operationId) {
    if (current.attachment_caption !== input.caption
      || current.attachment_source_url !== input.sourceUrl) {
      conflict("The operation ID was reused with different attachment metadata");
    }
    return { value: serializeProjectContent(current), replayed: true };
  }
  if (current.revision !== input.expectedRevision) conflict("Content revision conflict");
  if (current.attachment_caption === input.caption
    && current.attachment_source_url === input.sourceUrl) {
    return { value: serializeProjectContent(current), replayed: false };
  }
  const result = await db.prepare(`
    UPDATE project_contents
    SET attachment_caption = ?, attachment_source_url = ?,
        revision = revision + 1, last_mutation_id = ?,
        updated_by = ?, updated_at = ?
    WHERE id = ? AND project_id = ? AND content_type = 'attachment'
      AND revision = ? AND deleted_at IS NULL AND revision < ?
  `).bind(
    input.caption,
    input.sourceUrl,
    input.operationId,
    actor,
    now,
    contentId,
    projectId,
    input.expectedRevision,
    MAX_PROJECT_SAFE_INTEGER,
  ).run();
  if (!result.meta.changes) conflict("Content revision conflict");
  const updated = await readProjectContentRow(db, projectId, contentId);
  if (!updated) throw new Error("Updated attachment content disappeared");
  return { value: serializeProjectContent(updated), replayed: false };
}

export async function updateProjectPlacement(
  db: D1Database,
  projectId: string,
  placementId: string,
  input: UpdateProjectPlacementInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectRowMutationResponse<ReturnType<typeof serializeProjectPlacement>>> {
  const current = await readProjectPlacementRow(db, projectId, placementId);
  if (!current) notFound("Project placement not found");
  if (current.last_mutation_id === input.operationId) {
    if (!geometryMatches(current, input.geometry)) {
      conflict("The operation ID was reused with different geometry");
    }
    return { value: serializeProjectPlacement(current), replayed: true };
  }
  if (current.revision !== input.expectedRevision) conflict("Placement revision conflict");
  if (geometryMatches(current, input.geometry)) {
    return { value: serializeProjectPlacement(current), replayed: false };
  }
  const result = await db.prepare(`
    UPDATE project_map_placements
    SET x = ?, y = ?, width = ?, height = ?, z_index = ?,
        revision = revision + 1, last_mutation_id = ?,
        updated_by = ?, updated_at = ?
    WHERE id = ? AND revision = ? AND revision < ?
      AND EXISTS (
        SELECT 1 FROM project_items pi JOIN projects p ON p.id = pi.project_id
        WHERE pi.id = project_map_placements.project_item_id
          AND pi.project_id = ? AND pi.deleted_at IS NULL AND p.deleted_at IS NULL
      )
  `).bind(
    input.geometry.x,
    input.geometry.y,
    input.geometry.width,
    input.geometry.height,
    input.geometry.zIndex,
    input.operationId,
    actor,
    now,
    placementId,
    input.expectedRevision,
    MAX_PROJECT_SAFE_INTEGER,
    projectId,
  ).run();
  if (!result.meta.changes) conflict("Placement revision conflict");
  const updated = await readProjectPlacementRow(db, projectId, placementId);
  if (!updated) throw new Error("Updated placement disappeared");
  return { value: serializeProjectPlacement(updated), replayed: false };
}

export async function removeProjectItem(
  db: D1Database,
  projectId: string,
  itemId: string,
  input: ProjectItemLifecycleInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectItemMutationResponse> {
  await requireActiveProject(db, projectId);
  const current = await requireItemBundle(db, projectId, itemId);
  if (current.item.deleted_at !== null) {
    const contentMatches = !current.content
      || current.content.deletion_operation_id === input.operationId;
    if (current.item.deletion_operation_id === input.operationId && contentMatches) {
      return itemMutationResponse(db, projectId, itemId, true);
    }
    conflict("Project item is already removed");
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

  const contentId = current.content?.id ?? null;
  const contentRevision = input.expectedContentRevision ?? -1;
  const sharedPrecondition = `
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
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      UPDATE project_edges
      SET deleted_at = ?, deleted_by = ?, deletion_operation_id = ?,
          revision = revision + 1, last_mutation_id = ?,
          updated_by = ?, updated_at = ?
      WHERE project_id = ? AND deleted_at IS NULL AND revision < ?
        AND (source_item_id = ? OR target_item_id = ?)
        AND ${sharedPrecondition}
    `).bind(
      now,
      actor,
      input.operationId,
      input.operationId,
      actor,
      now,
      projectId,
      MAX_PROJECT_SAFE_INTEGER,
      itemId,
      itemId,
      itemId,
      projectId,
      input.expectedItemRevision,
      MAX_PROJECT_SAFE_INTEGER,
      contentRevision,
      MAX_PROJECT_SAFE_INTEGER,
    ),
  ];
  if (contentId) {
    statements.push(db.prepare(`
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
    `).bind(
      now,
      actor,
      input.operationId,
      input.operationId,
      actor,
      now,
      contentId,
      projectId,
      contentRevision,
      MAX_PROJECT_SAFE_INTEGER,
      itemId,
      projectId,
      input.expectedItemRevision,
    ));
  }
  statements.push(db.prepare(`
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
  `).bind(
    now,
    actor,
    input.operationId,
    input.operationId,
    actor,
    now,
    itemId,
    projectId,
    input.expectedItemRevision,
    MAX_PROJECT_SAFE_INTEGER,
    input.operationId,
    now,
  ));

  const results = await db.batch(statements);
  if (!resultChanges(results.at(-1))) conflict("Item or content revision conflict");
  if (contentId && !resultChanges(results[1])) {
    throw new Error("Owned content removal did not accompany item removal");
  }
  return itemMutationResponse(db, projectId, itemId, false);
}

export async function restoreProjectItem(
  db: D1Database,
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

  const statements: D1PreparedStatement[] = [];
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

  const results = await db.batch(statements);
  if (!resultChanges(results.at(-1))) conflict("Item or content revision conflict");
  if (current.content && !resultChanges(results[0])) {
    throw new Error("Owned content restore did not accompany item restore");
  }
  return itemMutationResponse(db, projectId, itemId, false);
}

export async function createProjectEdge(
  db: D1Database,
  projectId: string,
  input: CreateProjectEdgeInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectRowMutationResponse<ReturnType<typeof serializeProjectEdge>>> {
  const existing = await readProjectEdgeRow(db, projectId, input.edgeId, true);
  if (existing) {
    if (existing.last_mutation_id === input.operationId
      && existing.source_item_id === input.sourceItemId
      && existing.target_item_id === input.targetItemId
      && existing.deleted_at === null
      && edgeShapeMatches(existing, input)) {
      return { value: serializeProjectEdge(existing), replayed: true };
    }
    conflict("The edge ID or operation ID is already in use");
  }

  const result = await db.prepare(`
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
  `).bind(
    input.edgeId,
    projectId,
    input.sourceHandle,
    input.targetHandle,
    input.markerStart,
    input.markerEnd,
    input.label,
    input.operationId,
    actor,
    actor,
    now,
    now,
    input.targetItemId,
    projectId,
    input.sourceItemId,
    projectId,
    projectId,
    input.expectedSourceItemRevision,
    input.expectedTargetItemRevision,
  ).run();
  if (!result.meta.changes) conflict("Project or endpoint revision conflict");
  const created = await readProjectEdgeRow(db, projectId, input.edgeId);
  if (!created) throw new Error("Created edge disappeared");
  return { value: serializeProjectEdge(created), replayed: false };
}

export async function updateProjectEdge(
  db: D1Database,
  projectId: string,
  edgeId: string,
  input: UpdateProjectEdgeInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectRowMutationResponse<ReturnType<typeof serializeProjectEdge>>> {
  const current = await readProjectEdgeRow(db, projectId, edgeId);
  if (!current) notFound("Project edge not found");
  if (current.last_mutation_id === input.operationId) {
    if (!edgeShapeMatches(current, {
      sourceHandle: current.source_handle,
      targetHandle: current.target_handle,
      markerStart: input.markerStart,
      markerEnd: input.markerEnd,
      label: input.label,
    })) {
      conflict("The operation ID was reused with different edge metadata");
    }
    return { value: serializeProjectEdge(current), replayed: true };
  }
  if (current.revision !== input.expectedRevision) conflict("Edge revision conflict");
  if (current.marker_start === input.markerStart
    && current.marker_end === input.markerEnd
    && current.label === input.label) {
    return { value: serializeProjectEdge(current), replayed: false };
  }

  const result = await db.prepare(`
    UPDATE project_edges
    SET marker_start = ?, marker_end = ?, label = ?,
        revision = revision + 1, last_mutation_id = ?,
        updated_by = ?, updated_at = ?
    WHERE id = ? AND project_id = ? AND revision = ?
      AND deleted_at IS NULL AND revision < ?
  `).bind(
    input.markerStart,
    input.markerEnd,
    input.label,
    input.operationId,
    actor,
    now,
    edgeId,
    projectId,
    input.expectedRevision,
    MAX_PROJECT_SAFE_INTEGER,
  ).run();
  if (!result.meta.changes) conflict("Edge revision conflict");
  const updated = await readProjectEdgeRow(db, projectId, edgeId);
  if (!updated) throw new Error("Updated edge disappeared");
  return { value: serializeProjectEdge(updated), replayed: false };
}

export async function deleteProjectEdge(
  db: D1Database,
  projectId: string,
  edgeId: string,
  input: ProjectEdgeLifecycleInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectRowMutationResponse<ReturnType<typeof serializeProjectEdge>>> {
  const current = await readProjectEdgeRow(db, projectId, edgeId, true);
  if (!current) notFound("Project edge not found");
  if (current.deleted_at !== null) {
    if (current.deletion_operation_id === input.operationId
      && current.last_mutation_id === input.operationId) {
      return { value: serializeProjectEdge(current), replayed: true };
    }
    conflict("Project edge is already deleted");
  }
  if (current.revision !== input.expectedRevision) conflict("Edge revision conflict");

  const result = await db.prepare(`
    UPDATE project_edges
    SET deleted_at = ?, deleted_by = ?, deletion_operation_id = ?,
        revision = revision + 1, last_mutation_id = ?,
        updated_by = ?, updated_at = ?
    WHERE id = ? AND project_id = ? AND revision = ?
      AND deleted_at IS NULL AND revision < ?
  `).bind(
    now,
    actor,
    input.operationId,
    input.operationId,
    actor,
    now,
    edgeId,
    projectId,
    input.expectedRevision,
    MAX_PROJECT_SAFE_INTEGER,
  ).run();
  if (!result.meta.changes) conflict("Edge revision conflict");
  const updated = await readProjectEdgeRow(db, projectId, edgeId, true);
  if (!updated) throw new Error("Deleted edge disappeared");
  return { value: serializeProjectEdge(updated), replayed: false };
}

export async function restoreProjectEdge(
  db: D1Database,
  projectId: string,
  edgeId: string,
  input: ProjectEdgeLifecycleInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectRowMutationResponse<ReturnType<typeof serializeProjectEdge>>> {
  const current = await readProjectEdgeRow(db, projectId, edgeId, true);
  if (!current) notFound("Project edge not found");
  if (current.deleted_at === null) {
    if (current.last_mutation_id === input.operationId) {
      return { value: serializeProjectEdge(current), replayed: true };
    }
    conflict("Project edge is already active");
  }
  if (current.revision !== input.expectedRevision) conflict("Edge revision conflict");

  try {
    const result = await db.prepare(`
      UPDATE project_edges
      SET deleted_at = NULL, deleted_by = NULL, deletion_operation_id = NULL,
          revision = revision + 1, last_mutation_id = ?,
          updated_by = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND revision = ?
        AND deleted_at IS NOT NULL AND revision < ?
    `).bind(
      input.operationId,
      actor,
      now,
      edgeId,
      projectId,
      input.expectedRevision,
      MAX_PROJECT_SAFE_INTEGER,
    ).run();
    if (!result.meta.changes) conflict("Edge revision conflict");
  } catch (error) {
    if (constraintConflict(error)) conflict("Edge endpoints are no longer available");
    throw error;
  }
  const updated = await readProjectEdgeRow(db, projectId, edgeId);
  if (!updated) throw new Error("Restored edge disappeared");
  return { value: serializeProjectEdge(updated), replayed: false };
}

export async function readProjectAttachmentMediaSource(
  db: D1Database,
  projectId: string,
  contentId: string,
): Promise<ProjectAttachmentMediaSource> {
  const row = await db.prepare(`
    SELECT source.store_kind, source.provider, source.object_key,
           source.blob_record_id, source.original_name, source.mime_type
    FROM (
      SELECT 'r2' AS store_kind, 'r2' AS provider, a.r2_key AS object_key,
             a.id AS blob_record_id, pca.original_name, pca.mime_type
      FROM project_content_attachments pca
      JOIN project_contents pc ON pc.id = pca.project_content_id
      JOIN projects p ON p.id = pc.project_id
      JOIN assets a ON a.id = pca.asset_id AND a.status = 'ready'
      WHERE pc.id = ? AND pc.project_id = ?
        AND pc.content_type = 'attachment'
        AND pc.deleted_at IS NULL AND p.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
        AND (
          a.import_id IS NULL
          OR EXISTS (
            SELECT 1 FROM imports i
            WHERE i.id = a.import_id AND i.status = 'ready'
          )
        )

      UNION ALL

      SELECT 'managed', mso.provider, mso.object_key,
             mso.id, pca.original_name, pca.mime_type
      FROM project_content_attachments pca
      JOIN project_contents pc ON pc.id = pca.project_content_id
      JOIN projects p ON p.id = pc.project_id
      JOIN managed_storage_objects mso ON mso.id = pca.storage_object_id
        AND mso.status IN ('ready', 'orphaned')
      WHERE pc.id = ? AND pc.project_id = ?
        AND pc.content_type = 'attachment'
        AND pc.deleted_at IS NULL AND p.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'managed' AND bg.provider = mso.provider
            AND bg.object_key = mso.object_key AND bg.state IN ('deleting', 'deleted')
        )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'managed' AND biq.provider = mso.provider
          AND biq.object_key = mso.object_key
      )
    ) source
    LIMIT 1
  `).bind(contentId, projectId, contentId, projectId).first<{
    store_kind: "r2" | "managed";
    provider: string;
    object_key: string;
    blob_record_id: string | null;
    original_name: string;
    mime_type: string;
  }>();
  if (!row) notFound("Project attachment not found");
  return {
    locator: {
      storeKind: row.store_kind,
      provider: row.provider,
      objectKey: row.object_key,
      blobRecordId: row.blob_record_id,
    },
    originalName: row.original_name,
    mimeType: row.mime_type,
  };
}
