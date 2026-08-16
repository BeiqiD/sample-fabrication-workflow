import type {
  ProjectItemRecord,
  ProjectReferenceRecord,
  ProjectSnapshot,
} from "../../shared/project-api";
import type {
  ReferenceContextSegment,
  ReferenceResolutionStatus,
  ReferenceTargetType,
} from "../../shared/reference-types";
import {
  formatByteSize,
  projectMapNodes,
  type ProjectNodeDescriptor,
} from "./project-map-model";

export interface ProjectInspectorField {
  label: string;
  value: string;
}

export interface ProjectInspectorRelationship {
  edgeId: string;
  direction: "incoming" | "outgoing" | "self";
  label: string;
  relatedItemId: string;
  relatedTitle: string;
}

export interface ProjectInspectorContextSegment {
  type: string;
  id: string;
  label: string;
  lifecycle: "active" | "archived" | "deleted";
}

export interface ProjectInspectorContext {
  label: string;
  segments: ProjectInspectorContextSegment[];
  openSourceUrl: string | null;
}

export interface ProjectInspectorAction {
  href: string;
  label: string;
  external: boolean;
}

export interface ProjectInspectorMedia {
  url: string;
  alt: string;
}

export interface ProjectInspectorProjection {
  kindLabel: string;
  title: string;
  subtitle: string | null;
  excerpt: string | null;
  occurrenceFields: ProjectInspectorField[];
  relationshipSummary: string;
  relationships: ProjectInspectorRelationship[];
  identityHeading: "Project-owned content" | "Source & provenance";
  identityFields: ProjectInspectorField[];
  detailFields: ProjectInspectorField[];
  contexts: ProjectInspectorContext[];
  primaryAction: ProjectInspectorAction | null;
  media: ProjectInspectorMedia | null;
}

const TARGET_LABELS: Record<ReferenceTargetType, string> = {
  sample: "Sample",
  run: "Process run",
  run_step: "Run step",
  comment: "Comment",
  comment_occurrence: "Comment occurrence",
  comment_attachment: "Comment attachment",
  execution_image: "Execution image",
  metrology_reference: "Metrology reference",
  recipe_revision: "Recipe revision",
};

const CONTEXT_LABELS: Record<ReferenceContextSegment["type"], string> = {
  sample: "Sample",
  run: "Run",
  run_step: "Step",
  recipe_revision: "Recipe revision",
};

export function projectInspectorReferenceTypeLabel(type: ReferenceTargetType) {
  return TARGET_LABELS[type];
}

function externalHref(href: string) {
  return /^https?:\/\//i.test(href);
}

function lifecycleLabel(
  deletedAt: string | null,
  archivedAt: string | null,
): "active" | "archived" | "deleted" {
  if (deletedAt) return "deleted";
  if (archivedAt) return "archived";
  return "active";
}

function resolutionLabel(resolution: ReferenceResolutionStatus) {
  return resolution.replaceAll("_", " ");
}

function relationshipProjection(
  snapshot: ProjectSnapshot,
  item: ProjectItemRecord,
) {
  const nodeLabels = new Map(projectMapNodes(snapshot).map((node) => [node.itemId, node.title]));
  const activeEdges = snapshot.edges.filter((edge) => (
    !edge.deletedAt && (edge.sourceItemId === item.id || edge.targetItemId === item.id)
  ));
  const incoming = activeEdges.filter((edge) => edge.targetItemId === item.id).length;
  const outgoing = activeEdges.filter((edge) => edge.sourceItemId === item.id).length;
  const relationships = activeEdges.map((edge): ProjectInspectorRelationship => {
    const direction = edge.sourceItemId === item.id && edge.targetItemId === item.id
      ? "self"
      : edge.sourceItemId === item.id
        ? "outgoing"
        : "incoming";
    const relatedItemId = direction === "incoming"
      ? edge.sourceItemId
      : edge.targetItemId;
    return {
      edgeId: edge.id,
      direction,
      label: edge.label?.trim() || "Unlabelled relationship",
      relatedItemId,
      relatedTitle: nodeLabels.get(relatedItemId) ?? relatedItemId,
    };
  });
  return {
    summary: incoming === 0 && outgoing === 0
      ? "No Project relationships"
      : `${incoming} incoming · ${outgoing} outgoing`,
    relationships,
  };
}

function referenceContexts(reference: ProjectReferenceRecord): ProjectInspectorContext[] {
  const urls = reference.resolution.destination.contextOpenSourceUrls;
  return reference.resolution.contexts.map((context, index) => {
    const segments = context.segments.map((segment): ProjectInspectorContextSegment => ({
      type: CONTEXT_LABELS[segment.type],
      id: segment.id,
      label: segment.label,
      lifecycle: lifecycleLabel(segment.deletedAt, segment.archivedAt),
    }));
    return {
      label: segments.length
        ? segments.map((segment) => segment.label).join(" › ")
        : `Context ${index + 1}`,
      segments,
      openSourceUrl: urls[index] ?? null,
    };
  });
}

function referenceStateField(type: ReferenceTargetType) {
  switch (type) {
    case "sample": return "Sample state";
    case "run": return "Run state";
    case "run_step": return "Step state";
    case "comment":
    case "comment_occurrence": return "Comment state";
    case "comment_attachment":
    case "execution_image": return "Media state";
    case "metrology_reference": return "Metrology state";
    case "recipe_revision": return "Recipe state";
  }
}

function referenceProjection(
  descriptor: ProjectNodeDescriptor,
  item: ProjectItemRecord,
  reference: ProjectReferenceRecord | undefined,
): Pick<
  ProjectInspectorProjection,
  "identityHeading" | "identityFields" | "detailFields" | "contexts" | "primaryAction" | "media"
> {
  if (!reference) {
    return {
      identityHeading: "Source & provenance",
      identityFields: [
        { label: "Ownership", value: "Referenced source" },
        { label: "Registry identity", value: item.referenceTargetId ?? "Unavailable" },
      ],
      detailFields: [{ label: "Resolution", value: "Reference metadata unavailable" }],
      contexts: [],
      primaryAction: descriptor.openReferenceUrl
        ? {
          href: descriptor.openReferenceUrl,
          label: "Open reference record",
          external: externalHref(descriptor.openReferenceUrl),
        }
        : null,
      media: null,
    };
  }

  const { resolution } = reference;
  const { target, source, destination } = resolution;
  const sourceLifecycle = source
    ? lifecycleLabel(source.deletedAt, source.archivedAt)
    : resolution.resolution === "tombstoned"
      ? "deleted"
      : "unavailable";
  const identityFields: ProjectInspectorField[] = [
    { label: "Ownership", value: "Referenced source" },
    { label: "Source type", value: projectInspectorReferenceTypeLabel(target.type) },
    { label: "Source identity", value: `${target.type}:${target.id}` },
    { label: "Registry identity", value: reference.registryId },
    { label: "Source lifecycle", value: sourceLifecycle },
  ];
  const detailFields: ProjectInspectorField[] = [
    { label: "Resolution", value: resolutionLabel(resolution.resolution) },
  ];
  if (source?.kind) detailFields.push({ label: "Source kind", value: source.kind });
  if (source?.state) {
    detailFields.push({ label: referenceStateField(target.type), value: source.state });
  }
  if (source?.updatedAt) detailFields.push({ label: "Source updated", value: source.updatedAt });

  const href = destination.openSourceUrl ?? destination.referenceUrl;
  return {
    identityHeading: "Source & provenance",
    identityFields,
    detailFields,
    contexts: referenceContexts(reference),
    primaryAction: href
      ? {
        href,
        label: destination.openSourceUrl ? "Open exact source" : "Open reference record",
        external: externalHref(href),
      }
      : null,
    media: null,
  };
}

function projectOwnedProjection(
  snapshot: ProjectSnapshot,
  descriptor: ProjectNodeDescriptor,
  item: ProjectItemRecord,
): Pick<
  ProjectInspectorProjection,
  "identityHeading" | "identityFields" | "detailFields" | "contexts" | "primaryAction" | "media"
> {
  const content = item.projectContentId
    ? snapshot.contents.find((candidate) => candidate.id === item.projectContentId)
    : null;
  const attachment = content?.contentType === "attachment"
    ? snapshot.attachments.find((candidate) => candidate.projectContentId === content.id)
    : null;

  const identityFields: ProjectInspectorField[] = [
    { label: "Ownership", value: "Project-owned" },
    { label: "Content identity", value: content?.id ?? item.projectContentId ?? "Unavailable" },
  ];
  const detailFields: ProjectInspectorField[] = [];
  if (!content) {
    detailFields.push({ label: "Content", value: "Metadata unavailable" });
  } else if (content.contentType === "markdown") {
    const source = content.markdownSource ?? "";
    detailFields.push(
      { label: "Content type", value: "Markdown" },
      { label: "Format version", value: String(content.formatVersion) },
      { label: "Content revision", value: String(content.revision) },
      { label: "Characters", value: String(source.length) },
      { label: "Lines", value: String(source === "" ? 0 : source.split(/\r?\n/).length) },
      { label: "Content updated", value: content.updatedAt },
    );
  } else {
    detailFields.push(
      { label: "Content type", value: "Attachment" },
      { label: "Content revision", value: String(content.revision) },
    );
    if (attachment) {
      detailFields.push(
        { label: "Filename", value: attachment.originalName },
        { label: "MIME type", value: attachment.mimeType || "Unknown" },
        { label: "File size", value: formatByteSize(attachment.byteSize) },
        { label: "Uploaded", value: attachment.createdAt },
      );
    } else {
      detailFields.push({ label: "File", value: "Attachment metadata unavailable" });
    }
    if (content.attachmentCaption) {
      detailFields.push({ label: "Caption", value: content.attachmentCaption });
    }
  }

  const fileUrl = attachment?.fileUrl ?? descriptor.fileUrl;
  const image = Boolean(
    fileUrl
      && (attachment?.mimeType ?? descriptor.mimeType)?.toLowerCase().startsWith("image/"),
  );
  return {
    identityHeading: "Project-owned content",
    identityFields,
    detailFields,
    contexts: [],
    primaryAction: fileUrl
      ? {
        href: fileUrl,
        label: "Open attachment",
        external: externalHref(fileUrl),
      }
      : null,
    media: image && fileUrl
      ? {
        url: fileUrl,
        alt: content?.attachmentCaption || attachment?.originalName || descriptor.title,
      }
      : null,
  };
}

export function projectInspectorProjection(
  snapshot: ProjectSnapshot,
  descriptor: ProjectNodeDescriptor,
): ProjectInspectorProjection | null {
  const item = snapshot.items.find((candidate) => candidate.id === descriptor.itemId);
  if (!item) return null;
  const relationships = relationshipProjection(snapshot, item);
  const reference = item.referenceTargetId
    ? snapshot.references.find((candidate) => candidate.registryId === item.referenceTargetId)
    : undefined;
  const specific = item.itemType === "reference"
    ? referenceProjection(descriptor, item, reference)
    : projectOwnedProjection(snapshot, descriptor, item);

  return {
    kindLabel: descriptor.kind === "reference"
      ? "Reference"
      : descriptor.kind === "attachment"
        ? "Project attachment"
        : "Project Markdown",
    title: descriptor.title,
    subtitle: descriptor.subtitle,
    excerpt: descriptor.excerpt,
    occurrenceFields: [
      { label: "Occurrence", value: item.id },
      { label: "Sequence", value: `#${item.createdSequence}` },
      { label: "Item revision", value: String(item.revision) },
      { label: "Created", value: item.createdAt },
      { label: "Updated", value: item.updatedAt },
      {
        label: "Position",
        value: `${Math.round(descriptor.geometry.x)}, ${Math.round(descriptor.geometry.y)}`,
      },
      {
        label: "Size",
        value: `${Math.round(descriptor.geometry.width)} × ${Math.round(descriptor.geometry.height)}`,
      },
      { label: "Relationships", value: relationships.summary },
    ],
    relationshipSummary: relationships.summary,
    relationships: relationships.relationships,
    ...specific,
  };
}

export function projectInspectorEdgeDirectionLabel(
  relationship: ProjectInspectorRelationship,
) {
  if (relationship.direction === "incoming") return "From";
  if (relationship.direction === "outgoing") return "To";
  return "Self";
}

export function projectInspectorRelationshipAriaLabel(
  relationship: ProjectInspectorRelationship,
) {
  const direction = relationship.direction === "self"
    ? "Self relationship"
    : `${relationship.direction} relationship`;
  return `${direction}: ${relationship.label}; ${relationship.relatedTitle}`;
}

