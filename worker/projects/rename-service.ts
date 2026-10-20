import { HTTPException } from "hono/http-exception";
import { isProjectApiId, isRenameProjectInput, type RenameProjectInput, type ProjectMutationResponse } from "../../shared/project-api";
import { MAX_PROJECT_SAFE_INTEGER } from "../../shared/project-types";
import { ProjectServiceError } from "./errors";
import { projectReadProjectRow } from "./read-decoding";
import { serializeProject } from "./serializers";
import { PROJECT_RENAME_ACTIVE_ROW_SQL, PROJECT_RENAME_UPDATE_SQL, type ProjectRenameDatabase } from "./rename-sql";

async function requireActiveProject(db: ProjectRenameDatabase, projectId: string) {
  const value = await db.prepare(PROJECT_RENAME_ACTIVE_ROW_SQL).bind(projectId, 0).first();
  if (!value) throw new ProjectServiceError("not_found", "Project not found");
  return projectReadProjectRow(value);
}
/** Mature read/replay/revision/no-op/CAS/read order and seven bindings. Each
 * genuine adapter owns its original SQL execution and current admission. */
export async function renameProjectWithDatabase(db: ProjectRenameDatabase, projectId: string,
  input: RenameProjectInput, actor: string, now = new Date().toISOString()): Promise<ProjectMutationResponse> {
  const current = await requireActiveProject(db, projectId);
  if (current.last_mutation_id === input.operationId) {
    if (current.title !== input.title) throw new ProjectServiceError("conflict", "The operation ID was reused with a different title");
    return { project: serializeProject(current), replayed: true };
  }
  if (current.revision !== input.expectedRevision) throw new ProjectServiceError("conflict", "Project revision conflict");
  if (current.title === input.title) return { project: serializeProject(current), replayed: false };
  const result = await db.prepare(PROJECT_RENAME_UPDATE_SQL).bind(
    input.title, input.operationId, actor, now, projectId, input.expectedRevision, MAX_PROJECT_SAFE_INTEGER,
  ).run();
  if (!result.changes) throw new ProjectServiceError("conflict", "Project revision conflict");
  const updated = await requireActiveProject(db, projectId);
  return { project: serializeProject(updated), replayed: false };
}
export function createProjectRenameService(capabilities: {
  database(): ProjectRenameDatabase;
  admit(actor: string): Promise<void>;
  now(): number;
}) {
  return {
    async rename(projectId: string, value: unknown, actor: string): Promise<ProjectMutationResponse> {
      if (!isProjectApiId(projectId)) throw new HTTPException(400, { message: "A valid Project ID is required" });
      if (!isRenameProjectInput(value)) throw new HTTPException(400, { message: "Invalid Project update request" });
      await capabilities.admit(actor); const db = capabilities.database();
      await capabilities.admit(actor);
      const result = await renameProjectWithDatabase(db, projectId, value, actor, new Date(capabilities.now()).toISOString());
      // A current-authority denial retains any already accepted title change.
      await capabilities.admit(actor); return result;
    },
  };
}
export type ProjectRenameService = ReturnType<typeof createProjectRenameService>;
