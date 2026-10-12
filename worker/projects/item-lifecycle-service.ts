import { HTTPException } from "hono/http-exception";
import { isProjectItemLifecycleInput, type ProjectItemLifecycleInput, type ProjectItemMutationResponse } from "../../shared/project-api";
import { MAX_PROJECT_SAFE_INTEGER } from "../../shared/project-types";
import { ProjectServiceError } from "./errors";
import { requireActiveProject, requireItemBundle, itemMutationResponse } from "./workspace-service";
import { removeProjectItemWithDatabase } from "./item-metadata-service";
import { PROJECT_ITEM_RESTORE_CONTENT_SQL, PROJECT_ITEM_RESTORE_ITEM_SQL, type ProjectItemLifecycleDatabase } from "./item-lifecycle-sql";
import type { ProjectWorkspaceStatement } from "./workspace-sql";
function conflict(message: string): never { throw new ProjectServiceError("conflict",message); }
function resultChanges(result: { changes: number } | undefined): number { return result?.changes ?? 0; }

/** Complete original restore algorithm; only types, two exact SQL ports and
 * the existing batch/File-restoration ports are neutralized. Neither this
 * library nor its File-restoration method is an operation permission grant. */
export async function restoreProjectItemWithDatabase(
  db: ProjectItemLifecycleDatabase,
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
    statements.push(db.prepare(PROJECT_ITEM_RESTORE_CONTENT_SQL).bind(
      input.operationId,
      actor,
      now,
      current.content.id,
      projectId,
      input.expectedContentRevision!,
      MAX_PROJECT_SAFE_INTEGER,
      itemId,
      projectId,
      input.expectedItemRevision,
    ));
  }
  statements.push(db.prepare(PROJECT_ITEM_RESTORE_ITEM_SQL).bind(
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
    ? await db.prepareFileRestoration("project_attachment", [current.content.id]) : [];
  const results = (await db.mutationBatch([...fences, ...statements])).slice(fences.length);
  if (!resultChanges(results.at(-1))) conflict("Item or content revision conflict");
  if (current.content && !resultChanges(results[0])) {
    throw new Error("Owned content restore did not accompany item restore");
  }
  return itemMutationResponse(db, projectId, itemId, false);
}

export function createProjectItemLifecycleService(capabilities: {
  database(): ProjectItemLifecycleDatabase; admit(actor: string): Promise<void>; now(): number;
}) {
  const execute = async <T>(actor: string, work: (database: ProjectItemLifecycleDatabase, now: string) => Promise<T>) => {
    await capabilities.admit(actor); const database = capabilities.database(); await capabilities.admit(actor);
    const result = await work(database,new Date(capabilities.now()).toISOString()); await capabilities.admit(actor); return result;
  };
  return {
    removeItem(projectId: string,itemId: string,value: unknown,actor: string) {
      if (!isProjectItemLifecycleInput(value)) throw new HTTPException(400,{message:"Invalid Project item deletion request"});
      return execute(actor,(database,now)=>removeProjectItemWithDatabase(database,projectId,itemId,value,actor,now));
    },
    restoreItem(projectId: string,itemId: string,value: unknown,actor: string) {
      if (!isProjectItemLifecycleInput(value)) throw new HTTPException(400,{message:"Invalid Project item restore request"});
      return execute(actor,(database,now)=>restoreProjectItemWithDatabase(database,projectId,itemId,value,actor,now));
    },
  };
}
