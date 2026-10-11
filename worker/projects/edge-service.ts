import { HTTPException } from "hono/http-exception";
import { isCreateProjectEdgeInput, isUpdateProjectEdgeInput, isProjectEdgeLifecycleInput,
  type CreateProjectEdgeInput, type UpdateProjectEdgeInput, type ProjectEdgeLifecycleInput, type ProjectRowMutationResponse } from "../../shared/project-api";
import { MAX_PROJECT_SAFE_INTEGER } from "../../shared/project-types";
import { configurationSqlInteger } from "../runtime/configuration-sql";
import { ProjectServiceError } from "./errors";
import { projectReadEdgeRow } from "./read-decoding";
import { serializeProjectEdge, type ProjectEdgeRow } from "./serializers";
import { PROJECT_EDGE_ROW_SQL, PROJECT_EDGE_CREATE_SQL, PROJECT_EDGE_UPDATE_SQL, PROJECT_EDGE_DELETE_SQL, PROJECT_EDGE_RESTORE_SQL,
  PROJECT_EDGE_ENDPOINT_PROOF_SQL, PROJECT_EDGE_IDENTITY_PROOF_SQL, type ProjectEdgeDatabase } from "./edge-sql";
function conflict(message: string): never { throw new ProjectServiceError("conflict", message); }
function notFound(message: string): never { throw new ProjectServiceError("not_found", message); }
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

async function readProjectEdgeRow(db: ProjectEdgeDatabase, projectId: string, edgeId: string, includeDeleted = false): Promise<ProjectEdgeRow | null> {
  const row = await db.prepare(PROJECT_EDGE_ROW_SQL).bind(edgeId, projectId, includeDeleted ? 1 : 0).first();
  return row === null ? null : projectReadEdgeRow(row);
}

export async function createProjectEdgeWithDatabase(
  db: ProjectEdgeDatabase,
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

  const result = await db.prepare(PROJECT_EDGE_CREATE_SQL).bind(
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
  if (!result.changes) conflict("Project or endpoint revision conflict");
  const created = await readProjectEdgeRow(db, projectId, input.edgeId);
  if (!created) throw new Error("Created edge disappeared");
  return { value: serializeProjectEdge(created), replayed: false };
}

export async function updateProjectEdgeWithDatabase(
  db: ProjectEdgeDatabase,
  projectId: string,
  edgeId: string,
  input: UpdateProjectEdgeInput,
  actor: string,
  now = new Date().toISOString(),
): Promise<ProjectRowMutationResponse<ReturnType<typeof serializeProjectEdge>>> {
  const current = await readProjectEdgeRow(db, projectId, edgeId);
  if (!current) notFound("Project edge not found");
  const reconnecting = input.sourceItemId !== undefined;
  const desired = {
    sourceItemId: input.sourceItemId ?? current.source_item_id,
    targetItemId: input.targetItemId ?? current.target_item_id,
    sourceHandle: input.sourceHandle ?? current.source_handle,
    targetHandle: input.targetHandle ?? current.target_handle,
    markerStart: input.markerStart,
    markerEnd: input.markerEnd,
    label: input.label,
  };
  const unchanged = current.source_item_id === desired.sourceItemId
    && current.target_item_id === desired.targetItemId
    && edgeShapeMatches(current, desired);
  if (current.last_mutation_id === input.operationId) {
    if (!unchanged) {
      conflict("The operation ID was reused with different edge content");
    }
    return { value: serializeProjectEdge(current), replayed: true };
  }
  if (current.revision !== input.expectedRevision) conflict("Edge revision conflict");
  if (unchanged) {
    return { value: serializeProjectEdge(current), replayed: false };
  }

  // A single guarded write commits endpoints and presentation together. Checking
  // both item revisions here also rejects a remove/restore race after the read.
  try {
    const result = await db.prepare(PROJECT_EDGE_UPDATE_SQL).bind(
      desired.sourceItemId,
      desired.targetItemId,
      desired.sourceHandle,
      desired.targetHandle,
      desired.markerStart,
      desired.markerEnd,
      desired.label,
      input.operationId,
      actor,
      now,
      edgeId,
      projectId,
      input.expectedRevision,
      MAX_PROJECT_SAFE_INTEGER,
      desired.sourceItemId,
      desired.targetItemId,
      reconnecting ? 1 : 0,
      input.expectedSourceItemRevision ?? null,
      input.expectedTargetItemRevision ?? null,
    ).run();
    if (!result.changes) conflict("Project, edge, or endpoint revision conflict");
  } catch (error) {
    if (error instanceof ProjectServiceError) throw error;
    if (constraintConflict(error)) conflict("Edge endpoints or relationship conflict");
    throw error;
  }
  const updated = await readProjectEdgeRow(db, projectId, edgeId);
  if (!updated) throw new Error("Updated edge disappeared");
  return { value: serializeProjectEdge(updated), replayed: false };
}

export async function deleteProjectEdgeWithDatabase(
  db: ProjectEdgeDatabase,
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

  const result = await db.prepare(PROJECT_EDGE_DELETE_SQL).bind(
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
  if (!result.changes) conflict("Edge revision conflict");
  const updated = await readProjectEdgeRow(db, projectId, edgeId, true);
  if (!updated) throw new Error("Deleted edge disappeared");
  return { value: serializeProjectEdge(updated), replayed: false };
}

export async function restoreProjectEdgeWithDatabase(
  db: ProjectEdgeDatabase,
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
    const result = await db.prepare(PROJECT_EDGE_RESTORE_SQL).bind(
      input.operationId,
      actor,
      now,
      edgeId,
      projectId,
      input.expectedRevision,
      MAX_PROJECT_SAFE_INTEGER,
    ).run();
    if (!result.changes) conflict("Edge revision conflict");
  } catch (error) {
    if (constraintConflict(error)) conflict("Edge endpoints are no longer available");
    throw error;
  }
  const updated = await readProjectEdgeRow(db, projectId, edgeId);
  if (!updated) throw new Error("Restored edge disappeared");
  return { value: serializeProjectEdge(updated), replayed: false };
}

export function createProjectEdgeService(capabilities: {
  database(): ProjectEdgeDatabase; admit(actor: string): Promise<void>; now(): number;
}) {
  const execute = async <T>(actor: string, operation: (db: ProjectEdgeDatabase, now: string) => Promise<T>): Promise<T> => {
    await capabilities.admit(actor); const db = capabilities.database(); await capabilities.admit(actor);
    const result = await operation(db, new Date(capabilities.now()).toISOString());
    await capabilities.admit(actor); return result;
  };
  return {
    create(projectId: string, value: unknown, actor: string) {
      if (!isCreateProjectEdgeInput(value)) throw new HTTPException(400, { message: "Invalid Project edge creation request" });
      return execute(actor, (db, now) => createProjectEdgeWithDatabase(db, projectId, value, actor, now));
    },
    update(projectId: string, edgeId: string, value: unknown, actor: string) {
      if (!isUpdateProjectEdgeInput(value)) throw new HTTPException(400, { message: "Invalid Project edge update request" });
      return execute(actor, (db, now) => updateProjectEdgeWithDatabase(db, projectId, edgeId, value, actor, now));
    },
    remove(projectId: string, edgeId: string, value: unknown, actor: string) {
      if (!isProjectEdgeLifecycleInput(value)) throw new HTTPException(400, { message: "Invalid Project edge deletion request" });
      return execute(actor, (db, now) => deleteProjectEdgeWithDatabase(db, projectId, edgeId, value, actor, now));
    },
    restore(projectId: string, edgeId: string, value: unknown, actor: string) {
      if (!isProjectEdgeLifecycleInput(value)) throw new HTTPException(400, { message: "Invalid Project edge restore request" });
      return execute(actor, (db, now) => restoreProjectEdgeWithDatabase(db, projectId, edgeId, value, actor, now));
    },
    creationSettlement(projectId: string, value: unknown, actor: string): Promise<boolean> {
      if (!isCreateProjectEdgeInput(value)) return Promise.resolve(false);
      return execute(actor, async db => {
        // Original anySettlementProof order: strictly advanced endpoint revision,
        // then immutable edge identity. Missing/deleted endpoints alone do not prove rejection.
        const result = await db.prepare(PROJECT_EDGE_ENDPOINT_PROOF_SQL).bind(projectId, value.sourceItemId, value.targetItemId).all();
        const revisions = new Map(result.results.map(row => {
          if (typeof row.id !== "string") throw new TypeError("Invalid edge endpoint proof ID");
          return [row.id, configurationSqlInteger(row.revision, "Edge endpoint proof revision", 1)] as const;
        }));
        const sourceRevision = revisions.get(value.sourceItemId), targetRevision = revisions.get(value.targetItemId);
        if ((sourceRevision !== undefined && sourceRevision > value.expectedSourceItemRevision)
          || (targetRevision !== undefined && targetRevision > value.expectedTargetItemRevision)) return true;
        return Boolean(await db.prepare(PROJECT_EDGE_IDENTITY_PROOF_SQL).bind(value.edgeId).first());
      });
    },
  };
}
export type ProjectEdgeService = ReturnType<typeof createProjectEdgeService>;
