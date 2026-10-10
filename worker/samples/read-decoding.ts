import { SAMPLE_STATUSES } from "../../shared/types";
import type { CommentSubmissionItemRow, CommentSubmissionRow } from "../comment-submission-serialization";
import { configurationSqlInteger } from "../runtime/configuration-sql";
import type { ReadSqlCell, ReadSqlRow } from "../runtime/read-sql";
import type { sampleEvent, sampleSummary } from "../serializers";

export function sampleReadText(value: ReadSqlCell | undefined, field: string): string {
  if (typeof value !== "string") throw new TypeError(`Invalid SQL text: ${field}`);
  return value;
}
function nullableText(value: ReadSqlCell | undefined, field: string): string | null {
  return value == null ? null : sampleReadText(value, field);
}
function choice<T extends string>(value: ReadSqlCell | undefined, field: string, allowed: readonly T[]): T {
  const matched = allowed.find(item => item === value);
  if (matched === undefined) throw new TypeError(`Invalid SQL value: ${field}`);
  return matched;
}
/** Step positions are decimal business values, unlike revisions/counts. */
export function sampleReadDecimal(value: ReadSqlCell | undefined, field: string): number {
  if (typeof value === "bigint") return configurationSqlInteger(value, field, Number.MIN_SAFE_INTEGER);
  if (typeof value !== "number" || !Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new RangeError(`SQL decimal outside exact domain range: ${field}`);
  }
  return value;
}
export function sampleIdentityRow(row: ReadSqlRow) {
  return { id: sampleReadText(row.id, "sample.id"), code: sampleReadText(row.code, "sample.code"),
    title: sampleReadText(row.title, "sample.title") };
}
/** Project only fields used by the existing serializer. Retained noncanonical
 * pinned cells keep their original Boolean wire meaning; the stored cell is untouched. */
export function sampleSerializerRow(row: ReadSqlRow): Parameters<typeof sampleSummary>[0] {
  return {
    ...sampleIdentityRow(row),
    status: choice(row.status, "sample.status", SAMPLE_STATUSES),
    description: nullableText(row.description, "sample.description"),
    location: nullableText(row.location, "sample.location"),
    parent_id: nullableText(row.parent_id, "sample.parent_id"),
    inherited_state_hash: nullableText(row.inherited_state_hash, "sample.inherited_state_hash"),
    pinned: row.pinned ? 1 : 0,
    created_at: row.created_at == null ? undefined : sampleReadText(row.created_at, "sample.created_at"),
    updated_at: sampleReadText(row.updated_at, "sample.updated_at"),
    latest_workflow_name: nullableText(row.latest_workflow_name, "sample.latest_workflow_name"),
    latest_workflow_version: row.latest_workflow_version == null ? null
      : configurationSqlInteger(row.latest_workflow_version, "sample.latest_workflow_version", Number.MIN_SAFE_INTEGER),
    latest_run_status: row.latest_run_status == null ? null
      : choice(row.latest_run_status, "sample.latest_run_status", ["active", "complete", "cancelled", "superseded"] as const),
    current_step_title: nullableText(row.current_step_title, "sample.current_step_title"),
    current_state_step_title: nullableText(row.current_state_step_title, "sample.current_state_step_title"),
    current_state_thumbnail_key: nullableText(row.current_state_thumbnail_key, "sample.current_state_thumbnail_key"),
    current_state_thumbnail_json: nullableText(row.current_state_thumbnail_json, "sample.current_state_thumbnail_json"),
  };
}
export function sampleEventRow(row: ReadSqlRow): Parameters<typeof sampleEvent>[0] {
  return {
    id: sampleReadText(row.id, "event.id"), sample_id: sampleReadText(row.sample_id, "event.sample_id"),
    kind: choice(row.kind, "event.kind", ["comment", "image", "location", "status", "created", "step", "run", "plan", "verification"] as const),
    body: nullableText(row.body, "event.body"), asset_key: nullableText(row.asset_key, "event.asset_key"),
    asset_file_id: nullableText(row.asset_file_id, "event.asset_file_id"),
    thumbnail_file_id: nullableText(row.thumbnail_file_id, "event.thumbnail_file_id"),
    metadata_json: sampleReadText(row.metadata_json, "event.metadata_json"),
    actor_email: nullableText(row.actor_email, "event.actor_email"),
    created_at: sampleReadText(row.created_at, "event.created_at"),
  };
}
export function sampleRunAssetRow(row: ReadSqlRow) {
  return { run_step_id: sampleReadText(row.run_step_id, "run_asset.run_step_id"),
    role: choice(row.role, "run_asset.role", ["planned", "execution"] as const),
    r2_key: nullableText(row.r2_key, "run_asset.r2_key"), asset_id: sampleReadText(row.asset_id, "run_asset.asset_id"),
    file_id: nullableText(row.file_id, "run_asset.file_id") };
}
export function sampleRunInitialAssetRow(row: ReadSqlRow) {
  return { run_id: sampleReadText(row.run_id, "initial_asset.run_id"), r2_key: nullableText(row.r2_key, "initial_asset.r2_key"),
    asset_id: sampleReadText(row.asset_id, "initial_asset.asset_id"), file_id: nullableText(row.file_id, "initial_asset.file_id") };
}
export function sampleRunCommentRow(row: ReadSqlRow) {
  return { id: sampleReadText(row.id, "run_comment.id"), run_step_id: sampleReadText(row.run_step_id, "run_comment.run_step_id"),
    scope: choice(row.scope, "run_comment.scope", ["common", "individual"] as const),
    operation_group_id: nullableText(row.operation_group_id, "run_comment.operation_group_id"),
    // Legacy comments may have a nullable legacy_body. Keep the existing payload.
    body: nullableText(row.body, "run_comment.body"), asset_key: nullableText(row.asset_key, "run_comment.asset_key"),
    asset_id: nullableText(row.asset_id, "run_comment.asset_id"), file_id: nullableText(row.file_id, "run_comment.file_id"),
    submission_id: nullableText(row.submission_id, "run_comment.submission_id"),
    actor_email: nullableText(row.actor_email, "run_comment.actor_email"), created_at: sampleReadText(row.created_at, "run_comment.created_at") };
}
export function sampleVerificationStepRow(row: ReadSqlRow) {
  return { verification_id: sampleReadText(row.verification_id, "verification_step.verification_id"),
    run_step_id: sampleReadText(row.run_step_id, "verification_step.run_step_id") };
}
export function sampleCommentTargetRow(row: ReadSqlRow) {
  return { submission_id: sampleReadText(row.submission_id, "comment_target.submission_id"),
    run_step_id: sampleReadText(row.run_step_id, "comment_target.run_step_id") };
}
export function sampleCommentSubmissionRow(row: ReadSqlRow): CommentSubmissionRow {
  return {
    id: sampleReadText(row.id, "submission.id"),
    context_kind: choice(row.context_kind, "submission.context_kind", ["sample", "run_steps"] as const),
    sample_id: nullableText(row.sample_id, "submission.sample_id"),
    scope: row.scope == null ? null : choice(row.scope, "submission.scope", ["common", "individual"] as const),
    body: sampleReadText(row.body, "submission.body"),
    status: choice(row.status, "submission.status", ["draft", "uploading", "ready", "failed", "cancelled"] as const),
    error_message: nullableText(row.error_message, "submission.error_message"),
    actor_email: nullableText(row.actor_email, "submission.actor_email"),
    created_at: sampleReadText(row.created_at, "submission.created_at"), updated_at: sampleReadText(row.updated_at, "submission.updated_at"),
  };
}
export function sampleCommentSubmissionItemRow(row: ReadSqlRow): CommentSubmissionItemRow {
  return {
    id: sampleReadText(row.id, "comment_item.id"), submission_id: sampleReadText(row.submission_id, "comment_item.submission_id"),
    kind: choice(row.kind, "comment_item.kind", ["comment_image", "attachment", "link"] as const),
    status: choice(row.status, "comment_item.status", ["pending", "uploading", "ready", "failed", "cancelled"] as const),
    filename: nullableText(row.filename, "comment_item.filename"), mime_type: nullableText(row.mime_type, "comment_item.mime_type"),
    byte_size: row.byte_size == null ? null : configurationSqlInteger(row.byte_size, "comment_item.byte_size"),
    original_filename: nullableText(row.original_filename, "comment_item.original_filename"),
    original_mime_type: nullableText(row.original_mime_type, "comment_item.original_mime_type"),
    original_byte_size: row.original_byte_size == null ? null : configurationSqlInteger(row.original_byte_size, "comment_item.original_byte_size"),
    title: nullableText(row.title, "comment_item.title"), description: nullableText(row.description, "comment_item.description"),
    external_url: nullableText(row.external_url, "comment_item.external_url"), sha256: nullableText(row.sha256, "comment_item.sha256"),
    related_item_id: nullableText(row.related_item_id, "comment_item.related_item_id"),
    error_message: nullableText(row.error_message, "comment_item.error_message"), asset_key: nullableText(row.asset_key, "comment_item.asset_key"),
    asset_id: nullableText(row.asset_id, "comment_item.asset_id"), storage_object_id: nullableText(row.storage_object_id, "comment_item.storage_object_id"),
    file_id: nullableText(row.file_id, "comment_item.file_id"),
  };
}
