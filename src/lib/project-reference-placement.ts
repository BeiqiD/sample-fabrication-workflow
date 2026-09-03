import { referenceUrlForTarget } from "../../shared/reference-destinations";
import type { ReferenceSearchResult } from "../../shared/reference-search";
import {
  isReferenceTarget,
  type ReferenceResolution,
  type ReferenceTarget,
} from "../../shared/reference-types";
import type {
  ProjectReferenceRecord,
} from "../../shared/project-api";
import {
  isProjectMapGeometry,
  type ProjectMapGeometry,
} from "../../shared/project-types";

export const PROJECT_REFERENCE_DRAG_MIME = "application/x-samples-project-reference+json";
export const PROJECT_REFERENCE_DRAG_VERSION = 1 as const;
export const PROJECT_REFERENCE_NODE_WIDTH = 300;
export const PROJECT_REFERENCE_NODE_HEIGHT = 180;

const MAX_PREVIEW_TITLE = 300;
const MAX_PREVIEW_SUBTITLE = 500;
const MAX_PREVIEW_EXCERPT = 1_000;
const MAX_PREVIEW_URL = 1_024;

export interface ProjectReferencePreview {
  title: string;
  subtitle: string | null;
  excerpt: string | null;
  referenceUrl: string;
  openSourceUrl: string | null;
}

export interface ProjectReferenceDragPayload {
  version: typeof PROJECT_REFERENCE_DRAG_VERSION;
  target: ReferenceTarget;
  preview: ProjectReferencePreview;
}

export type ProjectPendingReferenceStatus = "placing" | "reconciling" | "uncertain" | "error" | "conflict";

export interface ProjectPendingReferencePlacement {
  localId: string;
  target: ReferenceTarget;
  preview: ProjectReferencePreview;
  geometry: ProjectMapGeometry;
  status: ProjectPendingReferenceStatus;
  message: string | null;
}

function boundedText(value: string | null | undefined, maximum: number) {
  if (!value) return null;
  const withoutNul = value.replaceAll("\u0000", "");
  return Array.from(withoutNul).slice(0, maximum).join("");
}

function safeReferenceUrl(value: string | null | undefined) {
  if (!value || value.length > MAX_PREVIEW_URL || value.includes("\u0000")) return null;
  if (!value.startsWith("/")) return null;
  return value;
}

export function projectReferencePreviewFromResolution(
  resolution: ReferenceResolution,
): ProjectReferencePreview {
  const source = resolution.source;
  return {
    title: boundedText(source?.title || resolution.target.id, MAX_PREVIEW_TITLE)
      || resolution.target.id,
    subtitle: boundedText(source?.subtitle, MAX_PREVIEW_SUBTITLE),
    excerpt: boundedText(source?.excerpt, MAX_PREVIEW_EXCERPT),
    referenceUrl: safeReferenceUrl(resolution.destination.referenceUrl)
      || referenceUrlForTarget(resolution.target),
    openSourceUrl: safeReferenceUrl(resolution.destination.openSourceUrl),
  };
}

export function projectReferencePreviewFromResult(
  result: ReferenceSearchResult,
): ProjectReferencePreview {
  return projectReferencePreviewFromResolution(result.resolution);
}

export function projectReferenceDragPayloadFromResolution(
  resolution: ReferenceResolution,
): ProjectReferenceDragPayload {
  return {
    version: PROJECT_REFERENCE_DRAG_VERSION,
    target: resolution.target,
    preview: projectReferencePreviewFromResolution(resolution),
  };
}

export function projectReferenceDragPayloadFromResult(
  result: ReferenceSearchResult,
): ProjectReferenceDragPayload {
  return projectReferenceDragPayloadFromResolution(result.resolution);
}

function isNullableBoundedText(value: unknown, maximum: number): value is string | null {
  return value === null
    || (typeof value === "string"
      && !value.includes("\u0000")
      && Array.from(value).length <= maximum);
}

export function isProjectReferenceDragPayload(
  value: unknown,
): value is ProjectReferenceDragPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ProjectReferenceDragPayload>;
  if (candidate.version !== PROJECT_REFERENCE_DRAG_VERSION || !isReferenceTarget(candidate.target)) {
    return false;
  }
  if (!candidate.preview || typeof candidate.preview !== "object" || Array.isArray(candidate.preview)) {
    return false;
  }
  const preview = candidate.preview as Partial<ProjectReferencePreview>;
  return typeof preview.title === "string"
    && preview.title.length > 0
    && !preview.title.includes("\u0000")
    && Array.from(preview.title).length <= MAX_PREVIEW_TITLE
    && isNullableBoundedText(preview.subtitle, MAX_PREVIEW_SUBTITLE)
    && isNullableBoundedText(preview.excerpt, MAX_PREVIEW_EXCERPT)
    && typeof preview.referenceUrl === "string"
    && preview.referenceUrl.startsWith("/")
    && preview.referenceUrl.length <= MAX_PREVIEW_URL
    && !preview.referenceUrl.includes("\u0000")
    && (preview.openSourceUrl === null
      || (typeof preview.openSourceUrl === "string"
        && preview.openSourceUrl.startsWith("/")
        && preview.openSourceUrl.length <= MAX_PREVIEW_URL
        && !preview.openSourceUrl.includes("\u0000")));
}

export function writeProjectReferenceDragPayload(
  dataTransfer: DataTransfer,
  result: ReferenceSearchResult,
) {
  return writeProjectReferenceResolutionDragPayload(dataTransfer, result.resolution);
}

export function writeProjectReferenceResolutionDragPayload(
  dataTransfer: DataTransfer,
  resolution: ReferenceResolution,
) {
  const payload = projectReferenceDragPayloadFromResolution(resolution);
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(PROJECT_REFERENCE_DRAG_MIME, JSON.stringify(payload));
  return payload;
}

export function readProjectReferenceDragPayload(
  dataTransfer: DataTransfer,
): ProjectReferenceDragPayload | null {
  const encoded = dataTransfer.getData(PROJECT_REFERENCE_DRAG_MIME);
  if (!encoded) return null;
  try {
    const value = JSON.parse(encoded) as unknown;
    return isProjectReferenceDragPayload(value) ? value : null;
  } catch {
    return null;
  }
}

export function projectReferenceGeometryAtPoint(
  point: { x: number; y: number },
  zIndex = 0,
): ProjectMapGeometry | null {
  const geometry: ProjectMapGeometry = {
    x: point.x - PROJECT_REFERENCE_NODE_WIDTH / 2,
    y: point.y - PROJECT_REFERENCE_NODE_HEIGHT / 2,
    width: PROJECT_REFERENCE_NODE_WIDTH,
    height: PROJECT_REFERENCE_NODE_HEIGHT,
    zIndex,
  };
  return isProjectMapGeometry(geometry) ? geometry : null;
}

export function projectReferenceRecordFromPreview(
  registryId: string,
  payload: ProjectReferenceDragPayload,
): ProjectReferenceRecord {
  return {
    registryId,
    resolution: {
      target: payload.target,
      resolution: "resolved",
      source: {
        title: payload.preview.title,
        subtitle: payload.preview.subtitle,
        excerpt: payload.preview.excerpt,
        kind: payload.target.type,
        state: null,
        updatedAt: null,
        deletedAt: null,
        archivedAt: null,
      },
      contexts: [],
      destination: {
        referenceUrl: payload.preview.referenceUrl,
        mode: "source",
        openSourceUrl: payload.preview.openSourceUrl,
        contextOpenSourceUrls: [],
      },
    },
  };
}
