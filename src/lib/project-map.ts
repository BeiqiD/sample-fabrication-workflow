import type {
  ProjectContentRecord,
  ProjectItemRecord,
  ProjectPlacementRecord,
  ProjectSnapshot,
} from "../../shared/project-api";
import type { ProjectMapGeometry } from "../../shared/project-types";

export type ProjectMapNodeKind = "markdown" | "attachment" | "reference";

export interface ProjectMapNodeModel {
  itemId: string;
  placementId: string;
  placementRevision: number;
  createdSequence: number;
  kind: ProjectMapNodeKind;
  title: string;
  meta: string | null;
  excerpt: string | null;
  openUrl: string | null;
  imageUrl: string | null;
  geometry: ProjectMapGeometry;
}

export interface ProjectMapEdgeModel {
  id: string;
  sourceItemId: string;
  targetItemId: string;
  sourceHandle: "top" | "right" | "bottom" | "left";
  targetHandle: "top" | "right" | "bottom" | "left";
  markerStart: "none" | "arrow";
  markerEnd: "none" | "arrow";
  label: string | null;
}

export interface ProjectPlacementDraft {
  placementId: string;
  itemId: string;
  expectedRevision: number;
  baseline: ProjectMapGeometry;
  geometry: ProjectMapGeometry;
}

export interface ProjectMapCommand {
  itemId: string;
  before: ProjectMapGeometry;
  after: ProjectMapGeometry;
}

function active<T extends { deletedAt?: string | null }>(rows: T[]): T[] {
  return rows.filter((row) => row.deletedAt == null);
}

function truncate(value: string | null, maximum: number) {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maximum) return compact || null;
  return `${compact.slice(0, maximum - 1).trimEnd()}…`;
}

function contentNode(
  item: ProjectItemRecord,
  placement: ProjectPlacementRecord,
  content: ProjectContentRecord,
  snapshot: ProjectSnapshot,
): ProjectMapNodeModel {
  if (content.contentType === "markdown") {
    return {
      itemId: item.id,
      placementId: placement.id,
      placementRevision: placement.revision,
      createdSequence: item.createdSequence,
      kind: "markdown",
      title: "Markdown",
      meta: null,
      excerpt: truncate(content.markdownSource, 360),
      openUrl: null,
      imageUrl: null,
      geometry: placement,
    };
  }

  const attachment = snapshot.attachments.find((row) => row.projectContentId === content.id);
  const caption = truncate(content.attachmentCaption, 180);
  const isImage = Boolean(attachment?.mimeType?.toLowerCase().startsWith("image/"));
  return {
    itemId: item.id,
    placementId: placement.id,
    placementRevision: placement.revision,
    createdSequence: item.createdSequence,
    kind: "attachment",
    title: caption || attachment?.originalName || "Attachment",
    meta: attachment
      ? `${attachment.mimeType || "File"} · ${formatBytes(attachment.byteSize)}`
      : "Attachment metadata unavailable",
    excerpt: caption && caption !== attachment?.originalName ? caption : null,
    openUrl: attachment?.fileUrl ?? null,
    imageUrl: isImage ? attachment?.fileUrl ?? null : null,
    geometry: placement,
  };
}

function referenceNode(
  item: ProjectItemRecord,
  placement: ProjectPlacementRecord,
  snapshot: ProjectSnapshot,
): ProjectMapNodeModel {
  const reference = snapshot.references.find((row) => row.registryId === item.referenceTargetId);
  const resolution = reference?.resolution;
  const source = resolution?.source;
  const title = source?.title
    || (resolution ? `${resolution.target.type} · ${resolution.target.id}` : "Unavailable reference");
  return {
    itemId: item.id,
    placementId: placement.id,
    placementRevision: placement.revision,
    createdSequence: item.createdSequence,
    kind: "reference",
    title,
    meta: source?.subtitle || source?.kind || resolution?.resolution || "Reference",
    excerpt: truncate(source?.excerpt ?? null, 260),
    openUrl: resolution?.destination.referenceUrl ?? null,
    imageUrl: null,
    geometry: placement,
  };
}

export function projectMapNodes(snapshot: ProjectSnapshot): ProjectMapNodeModel[] {
  const contents = new Map(active(snapshot.contents).map((row) => [row.id, row]));
  const placements = new Map(snapshot.placements.map((row) => [row.projectItemId, row]));
  const nodes: ProjectMapNodeModel[] = [];

  for (const item of active(snapshot.items)) {
    const placement = placements.get(item.id);
    if (!placement) continue;
    if (item.itemType === "content" && item.projectContentId) {
      const content = contents.get(item.projectContentId);
      if (content) nodes.push(contentNode(item, placement, content, snapshot));
      continue;
    }
    if (item.itemType === "reference" && item.referenceTargetId) {
      nodes.push(referenceNode(item, placement, snapshot));
    }
  }

  return nodes;
}

export function projectMapEdges(snapshot: ProjectSnapshot): ProjectMapEdgeModel[] {
  const activeItemIds = new Set(active(snapshot.items).map((item) => item.id));
  return active(snapshot.edges)
    .filter((edge) => activeItemIds.has(edge.sourceItemId) && activeItemIds.has(edge.targetItemId))
    .map((edge) => ({
      id: edge.id,
      sourceItemId: edge.sourceItemId,
      targetItemId: edge.targetItemId,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      markerStart: edge.markerStart,
      markerEnd: edge.markerEnd,
      label: edge.label,
    }));
}

export function projectMobileItems(snapshot: ProjectSnapshot): ProjectMapNodeModel[] {
  return projectMapNodes(snapshot).sort((a, b) =>
    a.createdSequence - b.createdSequence || a.itemId.localeCompare(b.itemId));
}

export function placementDrafts(nodes: ProjectMapNodeModel[]): Record<string, ProjectPlacementDraft> {
  return Object.fromEntries(nodes.map((node) => [node.itemId, {
    placementId: node.placementId,
    itemId: node.itemId,
    expectedRevision: node.placementRevision,
    baseline: geometryCopy(node.geometry),
    geometry: geometryCopy(node.geometry),
  }]));
}

export function geometryCopy(geometry: ProjectMapGeometry): ProjectMapGeometry {
  return {
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
    zIndex: geometry.zIndex,
  };
}

export function sameGeometry(a: ProjectMapGeometry, b: ProjectMapGeometry) {
  return a.x === b.x
    && a.y === b.y
    && a.width === b.width
    && a.height === b.height
    && a.zIndex === b.zIndex;
}

export function dirtyPlacementDrafts(
  drafts: Record<string, ProjectPlacementDraft>,
): ProjectPlacementDraft[] {
  return Object.values(drafts).filter((draft) => !sameGeometry(draft.baseline, draft.geometry));
}

export function newProjectOperationId(prefix = "map") {
  const uuid = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${uuid}`;
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "Unknown size";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  for (const unit of units) {
    if (size < 1024 || unit === units.at(-1)) return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
    size /= 1024;
  }
  return `${value} B`;
}
