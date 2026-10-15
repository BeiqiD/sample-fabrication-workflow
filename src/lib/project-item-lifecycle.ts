import type { ProjectItemLifecycleInput, ProjectSnapshot } from "../../shared/project-api";

/** Only revisions compared by the frozen request can prevent its later commit. */
export function projectItemLifecycleRevisionHasAdvanced(
  snapshot: ProjectSnapshot,
  itemId: string,
  input: ProjectItemLifecycleInput,
  kind: "remove" | "restore",
) {
  const item = snapshot.items.find((candidate) => candidate.id === itemId);
  if (!item) return false;
  // Obtain the original removal acknowledgement so its Undo group is retained.
  if (kind === "remove" && item.deletedAt !== null
    && item.deletionOperationId === input.operationId) return false;
  const content = snapshot.contents.find((candidate) => candidate.id === item.projectContentId);
  return item.revision > input.expectedItemRevision
    || (content !== undefined && input.expectedContentRevision !== undefined
      && content.revision > input.expectedContentRevision);
}
