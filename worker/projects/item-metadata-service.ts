import { HTTPException } from "hono/http-exception";
import { isCreateReferenceProjectItemInput, isUpdateProjectAttachmentInput, isProjectItemLifecycleInput,
  type CreateReferenceProjectItemInput, type UpdateProjectAttachmentInput, type ProjectItemLifecycleInput,
  type ProjectItemMutationResponse, type ProjectRowMutationResponse } from "../../shared/project-api";
import { MAX_PROJECT_SAFE_INTEGER } from "../../shared/project-types";
import { configurationSqlInteger } from "../runtime/configuration-sql";
import { referenceResolutionIsEligible } from "../references/eligibility";
import { resolveReferencesReadOnly } from "../references/read-resolver";
import { referenceRegistrationStatementsWithDatabase } from "../references/registration-sql";
import { ProjectServiceError } from "./errors";
import { serializeProjectContent } from "./serializers";
import { requireActiveProject, readProjectContentRow, readItemBundle, requireItemBundle, itemMutationResponse,
  returnCreateReplayOrConflict, geometryMatches, reserveProjectSequenceStatement } from "./workspace-service";
import { PROJECT_WORKSPACE_CHANGES_SQL, PROJECT_WORKSPACE_INSERT_PLACEMENT_SQL, PROJECT_WORKSPACE_PROJECT_REVISION_PROOF_SQL,
  PROJECT_WORKSPACE_IDENTITY_PROOF_SQL, type ProjectWorkspaceStatement } from "./workspace-sql";
import { PROJECT_ITEM_METADATA_INSERT_REFERENCE_SQL, PROJECT_ITEM_METADATA_UPDATE_ATTACHMENT_SQL,
  PROJECT_ITEM_METADATA_REMOVE_EDGES_SQL, PROJECT_ITEM_METADATA_REMOVE_CONTENT_SQL, PROJECT_ITEM_METADATA_REMOVE_ITEM_SQL,
  type ProjectItemMetadataDatabase } from "./item-metadata-sql";
type ItemBundle = NonNullable<Awaited<ReturnType<typeof readItemBundle>>>;
function conflict(message: string): never { throw new ProjectServiceError("conflict", message); }
function notFound(message: string): never { throw new ProjectServiceError("not_found", message); }
function constraintConflict(error: unknown) {
  return /(constraint|unique|foreign key|project |reference target|blob locator|attachment)/i.test(String(error));
}
function resultChanges(result: { changes: number } | undefined): number { return result?.changes ?? 0; }
async function batchMutationChanges(db: ProjectItemMetadataDatabase, statements: ProjectWorkspaceStatement[]) {
  const results = await db.atomicBatch(statements.flatMap(statement => [statement, db.prepare(PROJECT_WORKSPACE_CHANGES_SQL)]));
  return statements.map((_, index) => configurationSqlInteger(results[index * 2 + 1]?.results[0]?.affected_rows, "Project metadata affected_rows", 0));
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

export async function createReferenceProjectItemWithDatabase(
  db: ProjectItemMetadataDatabase,
  projectId: string,
  input: CreateReferenceProjectItemInput,
  actor: string,
  now = new Date().toISOString(),
  registryId: string = crypto.randomUUID(),
): Promise<ProjectItemMutationResponse> {
  const existing = await readItemBundle(db, projectId, input.itemId);
  if (existing) {
    if (bundleMatchesReferenceCreate(existing, input)) {
      return itemMutationResponse(db, projectId, input.itemId, true);
    }
    conflict("A Project identity or operation ID was already used for a different reference");
  }
  await requireActiveProject(db, projectId);
  const [resolution] = await resolveReferencesReadOnly(db.referenceReadDatabase(), [input.target]);
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
    ...referenceRegistrationStatementsWithDatabase(
      db,
      input.target,
      resolution.contexts,
      now,
      registryId,
    ),
    db.prepare(PROJECT_ITEM_METADATA_INSERT_REFERENCE_SQL).bind(
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
    const reservation = changes[0];
    const item = changes[3];
    const placement = changes[4];
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

export async function updateProjectAttachmentWithDatabase(
  db: ProjectItemMetadataDatabase,
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
  const result = await db.prepare(PROJECT_ITEM_METADATA_UPDATE_ATTACHMENT_SQL).bind(
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
  if (!result.changes) conflict("Content revision conflict");
  const updated = await readProjectContentRow(db, projectId, contentId);
  if (!updated) throw new Error("Updated attachment content disappeared");
  return { value: serializeProjectContent(updated), replayed: false };
}

export async function removeProjectItemWithDatabase(
  db: ProjectItemMetadataDatabase,
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
  const statements: ProjectWorkspaceStatement[] = [
    db.prepare(PROJECT_ITEM_METADATA_REMOVE_EDGES_SQL).bind(
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
    statements.push(db.prepare(PROJECT_ITEM_METADATA_REMOVE_CONTENT_SQL).bind(
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
  statements.push(db.prepare(PROJECT_ITEM_METADATA_REMOVE_ITEM_SQL).bind(
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

  const results = await db.mutationBatch(statements);
  if (!resultChanges(results.at(-1))) conflict("Item or content revision conflict");
  if (contentId && !resultChanges(results[1])) {
    throw new Error("Owned content removal did not accompany item removal");
  }
  return itemMutationResponse(db, projectId, itemId, false);
}
export function createProjectItemMetadataService(capabilities: {
  database(): ProjectItemMetadataDatabase; admit(actor: string): Promise<void>; now(): number; registryId(): string;
}) {
  const execute = async <T>(actor: string, operation: (db: ProjectItemMetadataDatabase, now: string) => Promise<T>) => {
    await capabilities.admit(actor); const db = capabilities.database(); await capabilities.admit(actor);
    const result = await operation(db, new Date(capabilities.now()).toISOString()); await capabilities.admit(actor); return result;
  };
  return {
    createReference(projectId: string, value: unknown, actor: string) {
      if (!isCreateReferenceProjectItemInput(value)) throw new HTTPException(400, { message: "Invalid Project reference insertion request" });
      return execute(actor, (db, now) => createReferenceProjectItemWithDatabase(db, projectId, value, actor, now, capabilities.registryId()));
    },
    updateAttachment(projectId: string, contentId: string, value: unknown, actor: string) {
      if (!isUpdateProjectAttachmentInput(value)) throw new HTTPException(400, { message: "Invalid Project attachment update request" });
      return execute(actor, (db, now) => updateProjectAttachmentWithDatabase(db, projectId, contentId, value, actor, now));
    },
    removeItem(projectId: string, itemId: string, value: unknown, actor: string) {
      if (!isProjectItemLifecycleInput(value)) throw new HTTPException(400, { message: "Invalid Project item deletion request" });
      return execute(actor, (db, now) => removeProjectItemWithDatabase(db, projectId, itemId, value, actor, now));
    },
    creationSettlement(projectId: string, value: unknown, actor: string): Promise<boolean> {
      if (!isCreateReferenceProjectItemInput(value)) return Promise.resolve(false);
      return execute(actor, async db => {
        const project = await db.prepare(PROJECT_WORKSPACE_PROJECT_REVISION_PROOF_SQL).bind(projectId).first();
        if (project && configurationSqlInteger(project.revision, "Project settlement revision", 1) > value.expectedProjectRevision) return true;
        return Boolean(await db.prepare(PROJECT_WORKSPACE_IDENTITY_PROOF_SQL).bind(value.itemId, value.placementId, null, null).first());
      });
    },
  };
}
export type ProjectItemMetadataService = ReturnType<typeof createProjectItemMetadataService>;
