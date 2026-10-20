import type {
  ProjectEdgeRecord,
  ProjectItemRecord,
  ProjectSnapshot,
} from "../../shared/project-api";

export interface ProjectTrashEntry {
  itemId: string;
  title: string;
  kind: "Markdown" | "Attachment" | "Reference";
  deletedAt: string;
}

/** A deletion token, not just an edge ID, prevents resurrecting a later manual deletion. */
export interface ProjectRecoverableEdge {
  edgeId: string;
  deletionOperationId: string;
}

export function projectTrashEntries(snapshot: ProjectSnapshot | null): ProjectTrashEntry[] {
  if (!snapshot) return [];
  return snapshot.items.filter((item) => item.deletedAt !== null).map((item) => {
    const content = snapshot.contents.find((candidate) => candidate.id === item.projectContentId);
    const attachment = snapshot.attachments.find((candidate) => (
      candidate.projectContentId === item.projectContentId
    ));
    const reference = snapshot.references.find((candidate) => candidate.registryId === item.referenceTargetId);
    const kind: ProjectTrashEntry["kind"] = item.itemType === "reference" ? "Reference"
      : content?.contentType === "attachment" ? "Attachment" : "Markdown";
    const title = kind === "Reference" ? reference?.resolution.source?.title ?? "Reference"
      : kind === "Attachment" ? attachment?.originalName ?? content?.attachmentCaption ?? "Attachment"
        : content?.markdownSource?.split("\n").find((line) => line.trim())?.replace(/^#{1,6}\s+/, "")
          ?? "Untitled note";
    return { itemId: item.id, title: title.slice(0, 160), kind, deletedAt: item.deletedAt! };
  }).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || a.itemId.localeCompare(b.itemId));
}

export function projectActiveTrashSnapshot(snapshot: ProjectSnapshot): ProjectSnapshot {
  const items = snapshot.items.filter((item) => item.deletedAt === null);
  const itemIds = new Set(items.map((item) => item.id));
  const contentIds = new Set(items.flatMap((item) => item.projectContentId ? [item.projectContentId] : []));
  return {
    ...snapshot,
    items,
    contents: snapshot.contents.filter((content) => content.deletedAt === null && contentIds.has(content.id)),
    attachments: snapshot.attachments.filter((attachment) => contentIds.has(attachment.projectContentId)),
    placements: snapshot.placements.filter((placement) => itemIds.has(placement.projectItemId)),
    edges: snapshot.edges.filter((edge) => edge.deletedAt === null
      && itemIds.has(edge.sourceItemId) && itemIds.has(edge.targetItemId)),
  };
}

export function projectRememberCascadeEdges(
  snapshot: ProjectSnapshot,
  items: readonly ProjectItemRecord[],
  remembered: readonly ProjectRecoverableEdge[],
): ProjectRecoverableEdge[] {
  const operations = new Set(items.flatMap((item) => (
    item.deletedAt && item.deletionOperationId ? [item.deletionOperationId] : []
  )));
  const byId = new Map(remembered.map((candidate) => [candidate.edgeId, candidate]));
  for (const edge of snapshot.edges) {
    if (edge.deletedAt && edge.deletionOperationId && operations.has(edge.deletionOperationId)) {
      byId.set(edge.id, { edgeId: edge.id, deletionOperationId: edge.deletionOperationId });
    }
  }
  return [...byId.values()];
}

export function projectRecoverableEdges(
  snapshot: ProjectSnapshot,
  remembered: readonly ProjectRecoverableEdge[],
): ProjectEdgeRecord[] {
  const activeIds = new Set(snapshot.items.filter((item) => item.deletedAt === null).map((item) => item.id));
  const tokens = new Map(remembered.map((entry) => [entry.edgeId, entry.deletionOperationId]));
  return snapshot.edges.filter((edge) => edge.deletedAt !== null
    && edge.deletionOperationId != null
    && tokens.get(edge.id) === edge.deletionOperationId
    && activeIds.has(edge.sourceItemId)
    && activeIds.has(edge.targetItemId));
}
