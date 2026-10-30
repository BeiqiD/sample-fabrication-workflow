import type { ProjectMapGeometry } from "../../shared/project-types";
import {
  isProjectMapGeometry,
  MAX_PROJECT_MAP_COORDINATE_ABS,
  MAX_PROJECT_MAP_Z_INDEX_ABS,
} from "../../shared/project-types";
import { ProjectApiError } from "./project-client";

export type ProjectOwnedContentMutationStatus = "editing" | "uploading" | "saving" | "error" | "conflict" | "uncertain";

export interface ProjectMapMarkdownEditorState {
  itemId: string;
  value: string;
  isNew: boolean;
  geometry: ProjectMapGeometry | null;
  status: ProjectOwnedContentMutationStatus;
  message: string | null;
}

export interface ProjectPendingAttachmentPlacement {
  localId: string;
  filename: string;
  mimeType: string;
  geometry: ProjectMapGeometry;
  status: Exclude<ProjectOwnedContentMutationStatus, "editing">;
  message: string | null;
}

const PROJECT_ATTACHMENT_IMAGE_PREVIEW_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function normalizedProjectAttachmentMimeType(value: string | null | undefined) {
  return (value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function boundedCoordinate(value: number) {
  return Math.max(-MAX_PROJECT_MAP_COORDINATE_ABS, Math.min(MAX_PROJECT_MAP_COORDINATE_ABS, value));
}

function boundedZIndex(value: number) {
  return Math.max(-MAX_PROJECT_MAP_Z_INDEX_ABS, Math.min(MAX_PROJECT_MAP_Z_INDEX_ABS, Math.trunc(value)));
}

function centeredGeometry(
  point: { x: number; y: number },
  width: number,
  height: number,
  zIndex: number,
): ProjectMapGeometry | null {
  const geometry: ProjectMapGeometry = {
    x: boundedCoordinate(point.x - width / 2),
    y: boundedCoordinate(point.y - Math.min(72, height / 3)),
    width,
    height,
    zIndex: boundedZIndex(zIndex),
  };
  return isProjectMapGeometry(geometry) ? geometry : null;
}

export function projectMarkdownGeometryAtPoint(
  point: { x: number; y: number },
  zIndex: number,
) {
  return centeredGeometry(point, 360, 220, zIndex);
}

export function projectAttachmentGeometryAtPoint(
  point: { x: number; y: number },
  zIndex: number,
  mimeType: string,
) {
  return projectAttachmentCanPreviewImage(mimeType)
    ? centeredGeometry(point, 360, 300, zIndex)
    : centeredGeometry(point, 340, 170, zIndex);
}

export function projectAttachmentCanPreviewImage(mimeType: string | null | undefined) {
  return PROJECT_ATTACHMENT_IMAGE_PREVIEW_MIME_TYPES.has(
    normalizedProjectAttachmentMimeType(mimeType),
  );
}

export function projectOwnedContentFailureStatus(caught: unknown): "uncertain" | "error" | "conflict" {
  if (caught instanceof ProjectApiError) {
    if (caught.status === 409) return "conflict";
    if (caught.status >= 400 && caught.status < 500 && caught.status !== 408 && caught.status !== 429) {
      return "error";
    }
  }
  return "uncertain";
}
