import type {
  ProjectAttachmentRecord,
  ProjectContentRecord,
  ProjectItemRecord,
  ProjectPlacementRecord,
  ProjectReferenceRecord,
  ProjectSnapshot,
} from "../../shared/project-api";
import type { ProjectMapGeometry } from "../../shared/project-types";

export type ProjectNodeKind = "markdown" | "attachment" | "reference";

export interface ProjectNodeDescriptor {
  itemId: string;
  placementId: string;
  kind: ProjectNodeKind;
  title: string;
  subtitle: string | null;
  excerpt: string | null;
  geometry: ProjectMapGeometry;
  createdSequence: number;
  contentId: string | null;
  markdownSource: string | null;
  attachmentCaption: string | null;
  attachmentSourceUrl: string | null;
  mimeType: string | null;
  attachmentByteSize: number | null;
  fileUrl: string | null;
  openReferenceUrl: string | null;
}

export interface ProjectGeometryCommand {
  placementId: string;
  before: ProjectMapGeometry;
  after: ProjectMapGeometry;
}

function geometryFromPlacement(placement: ProjectPlacementRecord): ProjectMapGeometry {
  return {
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    zIndex: placement.zIndex,
  };
}

function compactMarkdownTitle(markdown: string | null) {
  const firstContentLine = markdown?.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  const withoutHeading = firstContentLine.replace(/^#{1,6}\s+/, "").trim();
  return withoutHeading || "Untitled Markdown";
}

function boundedExcerpt(value: string | null, limit = 220) {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function contentNode(
  item: ProjectItemRecord,
  placement: ProjectPlacementRecord,
  content: ProjectContentRecord,
  attachment: ProjectAttachmentRecord | undefined,
): ProjectNodeDescriptor {
  if (content.contentType === "attachment") {
    return {
      itemId: item.id,
      placementId: placement.id,
      kind: "attachment",
      title: attachment?.originalName || "Attachment",
      subtitle: attachment
        ? `${attachment.mimeType || "File"} · ${formatByteSize(attachment.byteSize)}`
        : "Attachment metadata unavailable",
      excerpt: boundedExcerpt(content.attachmentCaption),
      geometry: geometryFromPlacement(placement),
      createdSequence: item.createdSequence,
      contentId: content.id,
      markdownSource: null,
      attachmentCaption: content.attachmentCaption,
      attachmentSourceUrl: content.attachmentSourceUrl,
      mimeType: attachment?.mimeType ?? null,
      attachmentByteSize: attachment?.byteSize ?? null,
      fileUrl: attachment?.fileUrl ?? null,
      openReferenceUrl: null,
    };
  }

  return {
    itemId: item.id,
    placementId: placement.id,
    kind: "markdown",
    title: compactMarkdownTitle(content.markdownSource),
    subtitle: "Project Markdown",
    excerpt: boundedExcerpt(content.markdownSource),
    geometry: geometryFromPlacement(placement),
    createdSequence: item.createdSequence,
    contentId: content.id,
    markdownSource: content.markdownSource,
    attachmentCaption: null,
    attachmentSourceUrl: null,
    mimeType: null,
    attachmentByteSize: null,
    fileUrl: null,
    openReferenceUrl: null,
  };
}

function referenceNode(
  item: ProjectItemRecord,
  placement: ProjectPlacementRecord,
  reference: ProjectReferenceRecord | undefined,
): ProjectNodeDescriptor {
  const resolution = reference?.resolution;
  const target = resolution?.target;
  return {
    itemId: item.id,
    placementId: placement.id,
    kind: "reference",
    title: resolution?.source?.title || target?.id || item.referenceTargetId || "Reference",
    subtitle: resolution?.source?.subtitle
      || (target ? `${target.type.replaceAll("_", " ")} · ${resolution.resolution}` : "Reference unavailable"),
    excerpt: boundedExcerpt(resolution?.source?.excerpt ?? null),
    geometry: geometryFromPlacement(placement),
    createdSequence: item.createdSequence,
    contentId: null,
    markdownSource: null,
    attachmentCaption: null,
    attachmentSourceUrl: null,
    mimeType: null,
    attachmentByteSize: null,
    fileUrl: null,
    openReferenceUrl: resolution?.destination.referenceUrl ?? null,
  };
}

export function projectMapNodes(snapshot: ProjectSnapshot): ProjectNodeDescriptor[] {
  const placements = new Map(snapshot.placements.map((placement) => [placement.projectItemId, placement]));
  const contents = new Map(snapshot.contents.map((content) => [content.id, content]));
  const attachments = new Map(snapshot.attachments.map((attachment) => [attachment.projectContentId, attachment]));
  const references = new Map(snapshot.references.map((reference) => [reference.registryId, reference]));

  return snapshot.items.flatMap((item) => {
    const placement = placements.get(item.id);
    if (!placement) return [];
    if (item.itemType === "content" && item.projectContentId) {
      const content = contents.get(item.projectContentId);
      if (!content) return [];
      return [contentNode(item, placement, content, attachments.get(content.id))];
    }
    if (item.itemType === "reference" && item.referenceTargetId) {
      return [referenceNode(item, placement, references.get(item.referenceTargetId))];
    }
    return [];
  });
}

export function projectReadingNodes(snapshot: ProjectSnapshot) {
  return projectMapNodes(snapshot).sort((left, right) => (
    left.createdSequence - right.createdSequence || left.itemId.localeCompare(right.itemId)
  ));
}

export function projectPlacementIndex(snapshot: ProjectSnapshot) {
  return Object.fromEntries(snapshot.placements.map((placement) => [placement.id, placement]));
}

export function projectGeometryEquals(left: ProjectMapGeometry, right: ProjectMapGeometry) {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
    && left.zIndex === right.zIndex;
}

export function projectDirtyPlacements(
  baseline: Record<string, ProjectPlacementRecord>,
  current: Record<string, ProjectMapGeometry>,
) {
  return Object.entries(current).filter(([placementId, geometry]) => {
    const saved = baseline[placementId];
    return Boolean(saved && !projectGeometryEquals(saved, geometry));
  });
}

export function applyProjectGeometryCommand(
  current: Record<string, ProjectMapGeometry>,
  command: ProjectGeometryCommand,
  direction: "undo" | "redo",
) {
  return {
    ...current,
    [command.placementId]: direction === "undo" ? command.before : command.after,
  };
}

export function formatByteSize(value: number) {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} kB`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)} MB`;
  return `${(value / 1_000_000_000).toFixed(1)} GB`;
}
