import type {
  ProjectAttachmentRecord,
  ProjectContentRecord,
  ProjectEdgeRecord,
  ProjectItemRecord,
  ProjectPlacementRecord,
  ProjectRecord,
} from "../../shared/project-api";
import type {
  ProjectContentType,
  ProjectEdgeHandle,
  ProjectEdgeMarker,
} from "../../shared/project-types";

export interface ProjectRow {
  id: string;
  title: string;
  revision: number;
  next_created_sequence: number;
  last_mutation_id: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  deletion_operation_id: string | null;
}

export interface ProjectContentRow {
  id: string;
  project_id: string;
  content_type: ProjectContentType;
  markdown_source: string | null;
  attachment_caption: string | null;
  attachment_source_url: string | null;
  format_version: number;
  revision: number;
  last_mutation_id: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  deletion_operation_id: string | null;
}

export interface ProjectAttachmentRow {
  project_content_id: string;
  project_id: string;
  original_name: string;
  mime_type: string;
  byte_size: number;
  created_by: string;
  created_at: string;
  creation_operation_id: string;
}

export interface ProjectItemRow {
  id: string;
  project_id: string;
  item_type: "content" | "reference";
  project_content_id: string | null;
  reference_target_id: string | null;
  created_sequence: number;
  revision: number;
  last_mutation_id: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  deletion_operation_id: string | null;
}

export interface ProjectPlacementRow {
  id: string;
  project_item_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z_index: number;
  revision: number;
  last_mutation_id: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectEdgeRow {
  id: string;
  project_id: string;
  source_item_id: string;
  target_item_id: string;
  source_handle: ProjectEdgeHandle;
  target_handle: ProjectEdgeHandle;
  marker_start: ProjectEdgeMarker;
  marker_end: ProjectEdgeMarker;
  label: string | null;
  revision: number;
  last_mutation_id: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  deletion_operation_id: string | null;
}

export function serializeProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    title: row.title,
    revision: Number(row.revision),
    nextCreatedSequence: Number(row.next_created_sequence),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
  };
}

export function serializeProjectContent(row: ProjectContentRow): ProjectContentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    contentType: row.content_type,
    markdownSource: row.markdown_source,
    attachmentCaption: row.attachment_caption,
    attachmentSourceUrl: row.attachment_source_url,
    formatVersion: Number(row.format_version),
    revision: Number(row.revision),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
  };
}

export function serializeProjectAttachment(
  row: ProjectAttachmentRow,
): ProjectAttachmentRecord {
  return {
    projectContentId: row.project_content_id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    createdBy: row.created_by,
    createdAt: row.created_at,
    fileUrl: `/api/projects/${encodeURIComponent(row.project_id)}/contents/${encodeURIComponent(row.project_content_id)}/file`,
  };
}

export function serializeProjectItem(row: ProjectItemRow): ProjectItemRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    itemType: row.item_type,
    projectContentId: row.project_content_id,
    referenceTargetId: row.reference_target_id,
    createdSequence: Number(row.created_sequence),
    revision: Number(row.revision),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
  };
}

export function serializeProjectPlacement(
  row: ProjectPlacementRow,
): ProjectPlacementRecord {
  return {
    id: row.id,
    projectItemId: row.project_item_id,
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    zIndex: Number(row.z_index),
    revision: Number(row.revision),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeProjectEdge(row: ProjectEdgeRow): ProjectEdgeRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceItemId: row.source_item_id,
    targetItemId: row.target_item_id,
    sourceHandle: row.source_handle,
    targetHandle: row.target_handle,
    markerStart: row.marker_start,
    markerEnd: row.marker_end,
    label: row.label,
    revision: Number(row.revision),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
  };
}
