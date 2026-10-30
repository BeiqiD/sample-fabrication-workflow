import type { ReadSqlRow } from "../runtime/read-sql";
import { configurationSqlInteger } from "../runtime/configuration-sql";
import { isProjectContentType, isProjectItemType, isProjectEdgeHandle, isProjectEdgeMarker, MAX_PROJECT_MAP_COORDINATE_ABS, MAX_PROJECT_MAP_NODE_SIZE, MAX_PROJECT_MAP_Z_INDEX_ABS } from "../../shared/project-types";
import { isReferenceTargetType } from "../../shared/reference-types";
import type { ProjectRow, ProjectContentRow, ProjectAttachmentRow, ProjectItemRow, ProjectPlacementRow, ProjectEdgeRow } from "./serializers";

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`Invalid Project SQL text: ${field}`);
  return value;
}
function nullableText(value: unknown, field: string): string | null { return value === null ? null : text(value, field); }
function enumValue<T extends string>(value: unknown, field: string, guard: (value: unknown) => value is T): T {
  if (!guard(value)) throw new TypeError(`Invalid Project SQL enum: ${field}`);
  return value;
}
export function projectReadDecimal(value: unknown, field: string, minimum: number, maximum: number): number {
  const number = typeof value === "bigint" ? configurationSqlInteger(value, field, Number.MIN_SAFE_INTEGER) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < minimum || number > maximum
    || Number.isInteger(number) && !Number.isSafeInteger(number)) throw new RangeError(`Invalid Project SQL geometry: ${field}`);
  return number;
}
function integer(value: unknown, field: string, minimum = 1): number { return configurationSqlInteger(value, field, minimum); }

export function projectReadProjectRow(row: ReadSqlRow): ProjectRow {
  return {
    id: text(row.id, "project.id"),
    title: text(row.title, "project.title"),
    revision: integer(row.revision, "project.revision"),
    next_created_sequence: integer(row.next_created_sequence, "project.next_created_sequence"),
    last_mutation_id: text(row.last_mutation_id, "project.last_mutation_id"),
    created_by: text(row.created_by, "project.created_by"),
    updated_by: text(row.updated_by, "project.updated_by"),
    created_at: text(row.created_at, "project.created_at"),
    updated_at: text(row.updated_at, "project.updated_at"),
    deleted_at: nullableText(row.deleted_at, "project.deleted_at"),
    deleted_by: nullableText(row.deleted_by, "project.deleted_by"),
    deletion_operation_id: nullableText(row.deletion_operation_id, "project.deletion_operation_id"),
  };
}

export function projectReadContentRow(row: ReadSqlRow): ProjectContentRow {
  return {
    id: text(row.id, "project.id"),
    project_id: text(row.project_id, "project.project_id"),
    content_type: enumValue(row.content_type, "project.content_type", isProjectContentType),
    markdown_source: nullableText(row.markdown_source, "project.markdown_source"),
    attachment_caption: nullableText(row.attachment_caption, "project.attachment_caption"),
    attachment_source_url: nullableText(row.attachment_source_url, "project.attachment_source_url"),
    format_version: integer(row.format_version, "project.format_version"),
    revision: integer(row.revision, "project.revision"),
    last_mutation_id: text(row.last_mutation_id, "project.last_mutation_id"),
    created_by: text(row.created_by, "project.created_by"),
    updated_by: text(row.updated_by, "project.updated_by"),
    created_at: text(row.created_at, "project.created_at"),
    updated_at: text(row.updated_at, "project.updated_at"),
    deleted_at: nullableText(row.deleted_at, "project.deleted_at"),
    deleted_by: nullableText(row.deleted_by, "project.deleted_by"),
    deletion_operation_id: nullableText(row.deletion_operation_id, "project.deletion_operation_id"),
  };
}

export function projectReadAttachmentRow(row: ReadSqlRow): ProjectAttachmentRow {
  return {
    project_content_id: text(row.project_content_id, "project.project_content_id"),
    project_id: text(row.project_id, "project.project_id"),
    asset_id: nullableText(row.asset_id, "project.asset_id"),
    storage_object_id: nullableText(row.storage_object_id, "project.storage_object_id"),
    original_name: text(row.original_name, "project.original_name"),
    mime_type: text(row.mime_type, "project.mime_type"),
    byte_size: integer(row.byte_size, "project.byte_size", 0),
    created_by: text(row.created_by, "project.created_by"),
    created_at: text(row.created_at, "project.created_at"),
    creation_operation_id: text(row.creation_operation_id, "project.creation_operation_id"),
  };
}

export function projectReadItemRow(row: ReadSqlRow): ProjectItemRow {
  return {
    id: text(row.id, "project.id"),
    project_id: text(row.project_id, "project.project_id"),
    item_type: enumValue(row.item_type, "project.item_type", isProjectItemType),
    project_content_id: nullableText(row.project_content_id, "project.project_content_id"),
    reference_target_id: nullableText(row.reference_target_id, "project.reference_target_id"),
    created_sequence: integer(row.created_sequence, "project.created_sequence"),
    revision: integer(row.revision, "project.revision"),
    last_mutation_id: text(row.last_mutation_id, "project.last_mutation_id"),
    created_by: text(row.created_by, "project.created_by"),
    updated_by: text(row.updated_by, "project.updated_by"),
    created_at: text(row.created_at, "project.created_at"),
    updated_at: text(row.updated_at, "project.updated_at"),
    deleted_at: nullableText(row.deleted_at, "project.deleted_at"),
    deleted_by: nullableText(row.deleted_by, "project.deleted_by"),
    deletion_operation_id: nullableText(row.deletion_operation_id, "project.deletion_operation_id"),
  };
}

export function projectReadPlacementRow(row: ReadSqlRow): ProjectPlacementRow {
  return {
    id: text(row.id, "project.id"),
    project_item_id: text(row.project_item_id, "project.project_item_id"),
    x: projectReadDecimal(row.x, "project.x", -MAX_PROJECT_MAP_COORDINATE_ABS, MAX_PROJECT_MAP_COORDINATE_ABS),
    y: projectReadDecimal(row.y, "project.y", -MAX_PROJECT_MAP_COORDINATE_ABS, MAX_PROJECT_MAP_COORDINATE_ABS),
    width: projectReadDecimal(row.width, "project.width", Number.MIN_VALUE, MAX_PROJECT_MAP_NODE_SIZE),
    height: projectReadDecimal(row.height, "project.height", Number.MIN_VALUE, MAX_PROJECT_MAP_NODE_SIZE),
    z_index: projectReadDecimal(integer(row.z_index, "project.z_index", -MAX_PROJECT_MAP_Z_INDEX_ABS), "project.z_index", -MAX_PROJECT_MAP_Z_INDEX_ABS, MAX_PROJECT_MAP_Z_INDEX_ABS),
    revision: integer(row.revision, "project.revision"),
    last_mutation_id: text(row.last_mutation_id, "project.last_mutation_id"),
    created_by: text(row.created_by, "project.created_by"),
    updated_by: text(row.updated_by, "project.updated_by"),
    created_at: text(row.created_at, "project.created_at"),
    updated_at: text(row.updated_at, "project.updated_at"),
  };
}

export function projectReadEdgeRow(row: ReadSqlRow): ProjectEdgeRow {
  return {
    id: text(row.id, "project.id"),
    project_id: text(row.project_id, "project.project_id"),
    source_item_id: text(row.source_item_id, "project.source_item_id"),
    target_item_id: text(row.target_item_id, "project.target_item_id"),
    source_handle: enumValue(row.source_handle, "project.source_handle", isProjectEdgeHandle),
    target_handle: enumValue(row.target_handle, "project.target_handle", isProjectEdgeHandle),
    marker_start: enumValue(row.marker_start, "project.marker_start", isProjectEdgeMarker),
    marker_end: enumValue(row.marker_end, "project.marker_end", isProjectEdgeMarker),
    label: nullableText(row.label, "project.label"),
    revision: integer(row.revision, "project.revision"),
    last_mutation_id: text(row.last_mutation_id, "project.last_mutation_id"),
    created_by: text(row.created_by, "project.created_by"),
    updated_by: text(row.updated_by, "project.updated_by"),
    created_at: text(row.created_at, "project.created_at"),
    updated_at: text(row.updated_at, "project.updated_at"),
    deleted_at: nullableText(row.deleted_at, "project.deleted_at"),
    deleted_by: nullableText(row.deleted_by, "project.deleted_by"),
    deletion_operation_id: nullableText(row.deletion_operation_id, "project.deletion_operation_id"),
  };
}

export function projectReadRegistryRow(row: ReadSqlRow) {
  const type = row.target_type;
  if (!isReferenceTargetType(type)) throw new TypeError("Invalid Project reference target type");
  return { id: text(row.id, "project.registry.id"), target_type: type, target_id: text(row.target_id, "project.registry.target_id") };
}
