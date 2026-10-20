import { HTTPException } from "hono/http-exception";
import { isProjectLifecycleInput, type ProjectLifecycleInput, type ProjectMutationResponse } from "../../shared/project-api";
import { MAX_PROJECT_SAFE_INTEGER } from "../../shared/project-types";
import { ProjectServiceError } from "./errors";
import { projectReadProjectRow } from "./read-decoding";
import { serializeProject, type ProjectRow } from "./serializers";
import { PROJECT_LIFECYCLE_ROW_SQL, PROJECT_LIFECYCLE_DELETE_SQL, PROJECT_LIFECYCLE_RESTORE_SQL, type ProjectLifecycleDatabase } from "./lifecycle-sql";

function conflict(message: string): never { throw new ProjectServiceError("conflict", message); }
function notFound(message: string): never { throw new ProjectServiceError("not_found", message); }
async function readProjectRow(
  db: ProjectLifecycleDatabase,
  projectId: string,
  includeDeleted = false,
): Promise<ProjectRow | null> {
  const value = await db.prepare(PROJECT_LIFECYCLE_ROW_SQL).bind(projectId, includeDeleted ? 1 : 0).first();
  return value === null ? null : projectReadProjectRow(value);
}

async function requireActiveProject(db: ProjectLifecycleDatabase, projectId: string) {
  const row = await readProjectRow(db, projectId);
  if (!row) notFound("Project not found"); return row;
}
/** Original root-only replay/CAS/read order, nine/six binds and response. */
export async function deleteProjectWithDatabase(
  db: ProjectLifecycleDatabase,
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

  const result = await db.prepare(PROJECT_LIFECYCLE_DELETE_SQL).bind(
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
  if (!result.changes) conflict("Project revision conflict");
  const updated = await readProjectRow(db, projectId, true);
  if (!updated) throw new Error("Deleted Project disappeared");
  return { project: serializeProject(updated), replayed: false };
}

export async function restoreProjectWithDatabase(
  db: ProjectLifecycleDatabase,
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

  const result = await db.prepare(PROJECT_LIFECYCLE_RESTORE_SQL).bind(
    input.operationId,
    actor,
    now,
    projectId,
    input.expectedRevision,
    MAX_PROJECT_SAFE_INTEGER,
  ).run();
  if (!result.changes) conflict("Project revision conflict");
  const updated = await requireActiveProject(db, projectId);
  return { project: serializeProject(updated), replayed: false };
}


export function createProjectLifecycleService(capabilities: {
  database(): ProjectLifecycleDatabase; admit(actor: string): Promise<void>; now(): number;
}) {
  const execute = async (projectId: string, value: unknown, actor: string, restore: boolean): Promise<ProjectMutationResponse> => {
    if (!isProjectLifecycleInput(value)) throw new HTTPException(400, { message: restore ? "Invalid Project restore request" : "Invalid Project deletion request" });
    await capabilities.admit(actor); const db = capabilities.database(); await capabilities.admit(actor);
    const operation = restore ? restoreProjectWithDatabase : deleteProjectWithDatabase;
    const result = await operation(db, projectId, value, actor, new Date(capabilities.now()).toISOString());
    await capabilities.admit(actor); return result;
  };
  return {
    remove: (projectId: string, value: unknown, actor: string) => execute(projectId, value, actor, false),
    restore: (projectId: string, value: unknown, actor: string) => execute(projectId, value, actor, true),
  };
}
export type ProjectLifecycleService = ReturnType<typeof createProjectLifecycleService>;
