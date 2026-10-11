import { HTTPException } from "hono/http-exception";
import { isCreateProjectInput, type CreateProjectInput, type ProjectMutationResponse } from "../../shared/project-api";
import { configurationSqlInteger } from "../runtime/configuration-sql";
import { ProjectServiceError } from "./errors";
import { projectReadProjectRow } from "./read-decoding";
import { serializeProject } from "./serializers";
import { PROJECT_CREATE_INSERT_SQL, PROJECT_CREATE_CHANGES_SQL, PROJECT_CREATE_ROW_SQL, type ProjectCreateDatabase } from "./create-sql";

/** Extracted mature INSERT OR IGNORE/changes/read order and seven bindings.
 * Replay is exact id/title/operationId/creator equality, never a new grant. */
export async function createProjectWithDatabase(db: ProjectCreateDatabase, input: CreateProjectInput, actor: string,
  now = new Date().toISOString()): Promise<ProjectMutationResponse> {
  const results = await db.atomicBatch([
    db.prepare(PROJECT_CREATE_INSERT_SQL).bind(input.id, input.title, input.operationId, actor, actor, now, now),
    db.prepare(PROJECT_CREATE_CHANGES_SQL),
    db.prepare(PROJECT_CREATE_ROW_SQL).bind(input.id),
  ]);
  const value = results[2]?.results[0]; if (!value) throw new Error("Project creation did not return a row");
  const row = projectReadProjectRow(value);
  const inserted = configurationSqlInteger(results[1]?.results[0]?.affected_rows, "Project creation affected_rows") === 1;
  if (!inserted && (row.title !== input.title || row.last_mutation_id !== input.operationId || row.created_by !== actor)) {
    throw new ProjectServiceError("conflict", "The Project ID or operation ID is already in use");
  }
  return { project: serializeProject(row), replayed: !inserted };
}
export function createProjectCreationService(capabilities: {
  database(): ProjectCreateDatabase;
  admit(actor: string): Promise<void>;
  now(): number;
}) {
  return {
    async create(value: unknown, actor: string): Promise<ProjectMutationResponse> {
      if (!isCreateProjectInput(value)) throw new HTTPException(400, { message: "Invalid Project creation request" });
      await capabilities.admit(actor); const db = capabilities.database();
      await capabilities.admit(actor);
      const result = await createProjectWithDatabase(db, value, actor, new Date(capabilities.now()).toISOString());
      // A denied response retains any already accepted native commit.
      await capabilities.admit(actor); return result;
    },
  };
}
export type ProjectCreationService = ReturnType<typeof createProjectCreationService>;
