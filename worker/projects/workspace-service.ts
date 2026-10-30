import { HTTPException } from "hono/http-exception";
import { isCreateMarkdownProjectItemInput, isUpdateProjectMarkdownInput, isUpdateProjectPlacementInput,
  type CreateMarkdownProjectItemInput, type UpdateProjectMarkdownInput, type UpdateProjectPlacementInput,
  type ProjectItemMutationResponse, type ProjectRowMutationResponse } from "../../shared/project-api";
import type { ReferenceTargetType } from "../../shared/reference-types";
import { MAX_PROJECT_SAFE_INTEGER } from "../../shared/project-types";
import { configurationSqlInteger } from "../runtime/configuration-sql";
import type { ReadSqlRow } from "../runtime/read-sql";
import { ProjectServiceError } from "./errors";
import { projectReadProjectRow, projectReadContentRow, projectReadItemRow, projectReadAttachmentRow,
  projectReadPlacementRow, projectReadRegistryRow } from "./read-decoding";
import { serializeProject, serializeProjectAttachment, serializeProjectContent, serializeProjectItem,
  serializeProjectPlacement, type ProjectRow, type ProjectContentRow, type ProjectPlacementRow,
  type ProjectItemRow, type ProjectAttachmentRow } from "./serializers";
import { PROJECT_WORKSPACE_CHANGES_SQL, PROJECT_WORKSPACE_PROJECT_ROW_SQL, PROJECT_WORKSPACE_CONTENT_ROW_SQL, PROJECT_WORKSPACE_PLACEMENT_ROW_SQL, PROJECT_WORKSPACE_BUNDLE_REFERENCE_SQL, PROJECT_WORKSPACE_BUNDLE_PLACEMENT_SQL, PROJECT_WORKSPACE_BUNDLE_ATTACHMENT_SQL, PROJECT_WORKSPACE_BUNDLE_CONTENT_SQL, PROJECT_WORKSPACE_BUNDLE_ITEM_SQL, PROJECT_WORKSPACE_RESERVE_SEQUENCE_SQL, PROJECT_WORKSPACE_INSERT_PLACEMENT_SQL, PROJECT_WORKSPACE_INSERT_ITEM_SQL, PROJECT_WORKSPACE_INSERT_CONTENT_SQL, PROJECT_WORKSPACE_UPDATE_CONTENT_SQL, PROJECT_WORKSPACE_UPDATE_PLACEMENT_SQL, PROJECT_WORKSPACE_PROJECT_REVISION_PROOF_SQL, PROJECT_WORKSPACE_IDENTITY_PROOF_SQL, PROJECT_WORKSPACE_PLACEMENT_REVISION_PROOF_SQL, type ProjectWorkspaceDatabase, type ProjectWorkspaceStatement } from "./workspace-sql";

type ReferenceRegistryRow = { id: string; target_type: ReferenceTargetType; target_id: string };
type ItemBundle = { item: ProjectItemRow; content: ProjectContentRow | null; attachment: ProjectAttachmentRow | null;
  placement: ProjectPlacementRow | null; referenceTarget: ReferenceRegistryRow | null };

/** The three original algorithms retain their SQL/binding order, replay/CAS,
 * trigger-sensitive direct changes and result offsets on both real runtimes. */
function topLevelChanges(result: { results: ReadSqlRow[] } | undefined): number {
  return configurationSqlInteger(result?.results[0]?.affected_rows, "Project workspace affected_rows", 0);
}

async function batchMutationChanges(db: ProjectWorkspaceDatabase, statements: ProjectWorkspaceStatement[]) {
  // D1 meta.changes includes trigger writes. Read SQLite's top-level count
  // immediately after each mutation, within the same atomic batch.
  const results = await db.atomicBatch(statements.flatMap((statement) => [
    statement,
    db.prepare(PROJECT_WORKSPACE_CHANGES_SQL),
  ]));
  return statements.map((_, index) => topLevelChanges(results[index * 2 + 1]));
}

function conflict(message: string): never {
  throw new ProjectServiceError("conflict", message);
}

function notFound(message: string): never {
  throw new ProjectServiceError("not_found", message);
}

export function geometryMatches(
  row: ProjectPlacementRow,
  geometry: { x: number; y: number; width: number; height: number; zIndex: number },
) {
  return Number(row.x) === geometry.x
    && Number(row.y) === geometry.y
    && Number(row.width) === geometry.width
    && Number(row.height) === geometry.height
    && Number(row.z_index) === geometry.zIndex;
}

function constraintConflict(error: unknown) {
  return /(constraint|unique|foreign key|project |reference target|blob locator|attachment)/i
    .test(String(error));
}

async function readProjectRow(
  db: ProjectWorkspaceDatabase,
  projectId: string,
  includeDeleted = false,
): Promise<ProjectRow | null> {
  const value = await db.prepare(PROJECT_WORKSPACE_PROJECT_ROW_SQL).bind(projectId, includeDeleted ? 1 : 0).first();
  return value === null ? null : projectReadProjectRow(value);
}

export async function requireActiveProject(db: ProjectWorkspaceDatabase, projectId: string) {
  const row = await readProjectRow(db, projectId);
  if (!row) notFound("Project not found");
  return row;
}

export async function readProjectContentRow(
  db: ProjectWorkspaceDatabase,
  projectId: string,
  contentId: string,
  includeDeleted = false,
): Promise<ProjectContentRow | null> {
  const value = await db.prepare(PROJECT_WORKSPACE_CONTENT_ROW_SQL).bind(contentId, projectId, includeDeleted ? 1 : 0).first();
  return value === null ? null : projectReadContentRow(value);
}

async function readProjectPlacementRow(
  db: ProjectWorkspaceDatabase,
  projectId: string,
  placementId: string,
): Promise<ProjectPlacementRow | null> {
  const value = await db.prepare(PROJECT_WORKSPACE_PLACEMENT_ROW_SQL).bind(placementId, projectId).first();
  return value === null ? null : projectReadPlacementRow(value);
}

export async function readItemBundle(
  db: ProjectWorkspaceDatabase,
  projectId: string,
  itemId: string,
): Promise<ItemBundle | null> {
  const results = await db.readBatch([
    db.prepare(PROJECT_WORKSPACE_BUNDLE_ITEM_SQL).bind(itemId, projectId),
    db.prepare(PROJECT_WORKSPACE_BUNDLE_CONTENT_SQL).bind(itemId, projectId),
    db.prepare(PROJECT_WORKSPACE_BUNDLE_ATTACHMENT_SQL).bind(itemId, projectId),
    db.prepare(PROJECT_WORKSPACE_BUNDLE_PLACEMENT_SQL).bind(itemId, projectId),
    db.prepare(PROJECT_WORKSPACE_BUNDLE_REFERENCE_SQL).bind(itemId, projectId),
  ]);
  const row = results[0]?.results[0];
  const item = row ? projectReadItemRow(row) : null;
  if (!item) return null;
  return {
    item,
    content: results[1]?.results[0] ? projectReadContentRow(results[1]!.results[0]!) : null,
    attachment: results[2]?.results[0] ? projectReadAttachmentRow(results[2]!.results[0]!) : null,
    placement: results[3]?.results[0] ? projectReadPlacementRow(results[3]!.results[0]!) : null,
    referenceTarget: results[4]?.results[0] ? projectReadRegistryRow(results[4]!.results[0]!) : null,
  };
}

export async function requireItemBundle(db: ProjectWorkspaceDatabase, projectId: string, itemId: string) {
  const bundle = await readItemBundle(db, projectId, itemId);
  if (!bundle) notFound("Project item not found");
  if (!bundle.placement) {
    conflict("Project item is missing its authoritative placement");
  }
  return bundle;
}

export async function itemMutationResponse(
  db: ProjectWorkspaceDatabase,
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

export function reserveProjectSequenceStatement(
  db: ProjectWorkspaceDatabase,
  projectId: string,
  expectedRevision: number,
  operationId: string,
  actor: string,
  now: string,
) {
  return db.prepare(PROJECT_WORKSPACE_RESERVE_SEQUENCE_SQL).bind(
    operationId,
    actor,
    now,
    projectId,
    expectedRevision,
    MAX_PROJECT_SAFE_INTEGER,
    MAX_PROJECT_SAFE_INTEGER,
  );
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

export async function returnCreateReplayOrConflict(
  db: ProjectWorkspaceDatabase,
  projectId: string,
  itemId: string,
  matches: (bundle: ItemBundle) => boolean,
) {
  const bundle = await readItemBundle(db, projectId, itemId);
  if (bundle && matches(bundle)) return itemMutationResponse(db, projectId, itemId, true);
  conflict("A Project identity or operation ID was already used for different content");
}

export async function createMarkdownProjectItemWithDatabase(
  db: ProjectWorkspaceDatabase,
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
    db.prepare(PROJECT_WORKSPACE_INSERT_CONTENT_SQL).bind(
      input.contentId,
      projectId,
      input.markdownSource,
      input.operationId,
      actor,
      actor,
      now,
      now,
    ),
    db.prepare(PROJECT_WORKSPACE_INSERT_ITEM_SQL).bind(
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
    db.prepare(PROJECT_WORKSPACE_INSERT_PLACEMENT_SQL).bind(
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
    const changes = await batchMutationChanges(db, statements);
    if (changes.some((count) => count !== 1)) {
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

export async function updateProjectMarkdownWithDatabase(
  db: ProjectWorkspaceDatabase,
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
  const result = await db.prepare(PROJECT_WORKSPACE_UPDATE_CONTENT_SQL).bind(
    input.markdownSource,
    input.operationId,
    actor,
    now,
    contentId,
    projectId,
    input.expectedRevision,
    MAX_PROJECT_SAFE_INTEGER,
  ).run();
  if (!result.changes) conflict("Content revision conflict");
  const updated = await readProjectContentRow(db, projectId, contentId);
  if (!updated) throw new Error("Updated Markdown content disappeared");
  return { value: serializeProjectContent(updated), replayed: false };
}

export async function updateProjectPlacementWithDatabase(
  db: ProjectWorkspaceDatabase,
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
  const result = await db.prepare(PROJECT_WORKSPACE_UPDATE_PLACEMENT_SQL).bind(
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
  if (!result.changes) conflict("Placement revision conflict");
  const updated = await readProjectPlacementRow(db, projectId, placementId);
  if (!updated) throw new Error("Updated placement disappeared");
  return { value: serializeProjectPlacement(updated), replayed: false };
}

export function createProjectWorkspaceService(capabilities: {
  database(): ProjectWorkspaceDatabase; admit(actor: string): Promise<void>; now(): number;
}) {
  const execute = async <T>(actor: string, operation: (db: ProjectWorkspaceDatabase, now: string) => Promise<T>): Promise<T> => {
    await capabilities.admit(actor); const db = capabilities.database();
    await capabilities.admit(actor);
    const result = await operation(db, new Date(capabilities.now()).toISOString());
    await capabilities.admit(actor); return result;
  };
  return {
    creationSettlement(projectId: string, value: unknown, actor: string): Promise<boolean> {
      if (!isCreateMarkdownProjectItemInput(value)) return Promise.resolve(false);
      return execute(actor, async db => {
        const project = await db.prepare(PROJECT_WORKSPACE_PROJECT_REVISION_PROOF_SQL).bind(projectId).first();
        if (project && configurationSqlInteger(project.revision, "Project settlement revision", 1) > value.expectedProjectRevision) return true;
        return Boolean(await db.prepare(PROJECT_WORKSPACE_IDENTITY_PROOF_SQL)
          .bind(value.itemId, value.placementId, value.contentId, value.contentId).first());
      });
    },
    placementSettlement(projectId: string, placementId: string, value: unknown, actor: string): Promise<boolean> {
      if (!isUpdateProjectPlacementInput(value)) return Promise.resolve(false);
      return execute(actor, async db => {
        const placement = await db.prepare(PROJECT_WORKSPACE_PLACEMENT_REVISION_PROOF_SQL).bind(placementId, projectId).first();
        return Boolean(placement && configurationSqlInteger(placement.revision, "Placement settlement revision", 1) > value.expectedRevision);
      });
    },
    createMarkdown(projectId: string, value: unknown, actor: string) {
      if (!isCreateMarkdownProjectItemInput(value)) throw new HTTPException(400, { message: "Invalid Project Markdown creation request" });
      return execute(actor, (db, now) => createMarkdownProjectItemWithDatabase(db, projectId, value, actor, now));
    },
    updateMarkdown(projectId: string, contentId: string, value: unknown, actor: string) {
      if (!isUpdateProjectMarkdownInput(value)) throw new HTTPException(400, { message: "Invalid Project Markdown update request" });
      return execute(actor, (db, now) => updateProjectMarkdownWithDatabase(db, projectId, contentId, value, actor, now));
    },
    updatePlacement(projectId: string, placementId: string, value: unknown, actor: string) {
      if (!isUpdateProjectPlacementInput(value)) throw new HTTPException(400, { message: "Invalid Project placement update request" });
      return execute(actor, (db, now) => updateProjectPlacementWithDatabase(db, projectId, placementId, value, actor, now));
    },
  };
}
export type ProjectWorkspaceService = ReturnType<typeof createProjectWorkspaceService>;
