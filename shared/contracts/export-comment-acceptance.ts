import type { ExportRow, ExportTables } from "./export";
import { normalizeR2UploadRequestId } from "./r2-upload";
import { isTiffMetadata } from "../domain/tiff";
import { validSubmissionId } from "./comment-submissions";
import { COMMENT_ACCEPTANCE_LIFETIME_MS, MAX_COMMENT_ACCEPTANCE_INPUT_BYTES,
  validateCommentAcceptanceInput, validateCommentPublicationPlan, validateCommentPublicationResult,
  validateCommentAcceptedItemResult, type AcceptedCommentSubmissionInput } from "./comment-acceptance";
import { sha256Hex, stableJson } from "../domain/content-addressing";

// Frozen schema-13 historical decisions. These ledgers neither require current
// canonical occurrences/provider bytes nor extend their existing retention.
export const COMMENT_ACCEPTANCE_EXPORT_COLUMNS = {
  comment_submission_acceptances: ["submission_id", "actor_email", "operation_id", "request_sha256", "request_input_json",
    "publication_plan_json", "request_scope", "storage_policy_revision", "status", "accepted_result_json", "created_at", "completed_at", "expires_at"],
  comment_item_acceptances: ["item_id", "submission_id", "actor_email", "purpose", "expected_sha256", "expected_byte_size",
    "storage_profile_id", "storage_profile_revision", "candidate_blob_id", "candidate_object_key", "execution_token", "started_at", "status", "accepted_result_json", "created_at"],
} as const;
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid Comment acceptance ${message}`);
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && [...value].length > 0 && [...value].length <= max && !value.includes("\0");
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && normalizeR2UploadRequestId(value) === value;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function parsed<T>(validator: (value: unknown) => T, source: unknown, canonical = true, maximum = MAX_COMMENT_ACCEPTANCE_INPUT_BYTES): T {
  ensure(typeof source === "string" && new TextEncoder().encode(source).byteLength <= maximum, "JSON size");
  let value: T;
  try { value = validator(JSON.parse(source)); } catch { ensure(false, "input, plan or result schema"); }
  if (canonical) ensure(stableJson(value) === source, "noncanonical input or plan");
  else {
    // Terminal result objects contain scalar values and string arrays. Their
    // exact member counts reject duplicates lost by JSON.parse.
    const members = (source.replace(/"(?:\\.|[^"\\])*"/g, '""').match(/:/g) ?? []).length;
    ensure(members === Object.keys(value as Record<string, unknown>).length, "duplicate result members");
  }
  return value;
}
function binaryItems(input: AcceptedCommentSubmissionInput) { return input.items.filter((item) => item.kind !== "link"); }
function same(left: unknown, right: unknown) { return stableJson(left) === stableJson(right); }

export async function validateCommentAcceptance(tables: ExportTables) {
  const submissions = new Map<string, { row: ExportRow; input: AcceptedCommentSubmissionInput }>();
  const operations = new Set<unknown>();
  for (const row of tables.comment_submission_acceptances) {
    ensure(validSubmissionId(row.submission_id) && !submissions.has(String(row.submission_id))
      && uuid(row.operation_id) && !operations.has(row.operation_id), "submission or operation identity");
    operations.add(row.operation_id);
    ensure(text(row.actor_email, 256) && row.request_scope === "system" && row.storage_policy_revision === 1, "actor, scope or policy revision");
    const input = parsed(validateCommentAcceptanceInput, row.request_input_json);
    ensure(input.id === row.submission_id && row.request_sha256 === await sha256Hex(String(row.request_input_json)), "request identity or hash");
    const plan = parsed(validateCommentPublicationPlan, row.publication_plan_json, true, 32_768);
    const targets = input.context.kind === "run_steps" ? input.context.targets : [];
    const sampleIds = input.context.kind === "sample" ? [input.context.sampleId] : [...new Set(targets.map((target) => target.sampleId))];
    ensure(same(plan.occurrences.map((entry) => entry.targetIndex), targets.map((_, index) => index))
      && same(plan.events.map((entry) => entry.sampleId), sampleIds), "publication plan context or target order");
    ensure(targets.length > 1 ? plan.operationGroupId !== null : plan.operationGroupId === null, "publication operation group");
    ensure(timestamp(row.created_at) && timestamp(row.expires_at)
      && Date.parse(row.expires_at) - Date.parse(row.created_at) === COMMENT_ACCEPTANCE_LIFETIME_MS, "receipt lifetime");
    ensure(["pending", "ready", "cancelled"].includes(String(row.status)), "submission publication state");
    submissions.set(String(row.submission_id), { row, input });
    if (row.status === "pending") {
      ensure(row.completed_at === null && row.accepted_result_json === null, "pending submission result");
      continue;
    }
    ensure(timestamp(row.completed_at) && row.completed_at >= row.created_at, "submission completion");
    if (row.status === "cancelled") {
      ensure(row.accepted_result_json === null, "cancelled submission result");
      continue;
    }
    ensure(row.completed_at < row.expires_at, "submission publication after expiry");
    const result = parsed(validateCommentPublicationResult, row.accepted_result_json, false, 32_768);
    ensure(result.submissionId === row.submission_id && result.completedAt === row.completed_at
      && same(result.occurrenceIds, plan.occurrences.map((entry) => entry.id)) && same(result.eventIds, plan.events.map((entry) => entry.id)), "frozen publication result");
    ensure(input.body.trim().length > 0 || result.itemIds.length > 0, "empty published Comment");
    const ids = new Set(result.itemIds);
    ensure(same(result.itemIds, input.items.filter((item) => ids.has(item.id)).map((item) => item.id)), "published item identity or order");
    for (const item of input.items) {
      if (item.kind === "comment_image" && item.relatedAttachmentId && isTiffMetadata(item.originalFilename, item.originalMimeType) && ids.has(item.id)) ensure(ids.has(item.relatedAttachmentId), "published preview without its original");
    }
  }
  const profiles = new Map(tables.storage_profiles.map((row) => [row.id, row]));
  const items = new Map<string, ExportRow>();
  const itemsBySubmission = new Map<string, string[]>();
  const candidateIds = new Set<unknown>(), candidateKeys = new Set<unknown>(), executionTokens = new Set<unknown>();
  for (const row of tables.comment_item_acceptances) {
    ensure(validSubmissionId(row.item_id) && !items.has(String(row.item_id)) && uuid(row.candidate_blob_id)
      && !candidateIds.has(row.candidate_blob_id) && text(row.candidate_object_key, 4096) && !candidateKeys.has(row.candidate_object_key), "item or candidate identity");
    candidateIds.add(row.candidate_blob_id); candidateKeys.add(row.candidate_object_key); items.set(String(row.item_id), row);
    const submission = submissions.get(String(row.submission_id));
    ensure(submission && row.actor_email === submission.row.actor_email && row.created_at === submission.row.created_at, "item acceptance owner");
    const siblingIds = itemsBySubmission.get(String(row.submission_id)) ?? [];
    siblingIds.push(String(row.item_id)); itemsBySubmission.set(String(row.submission_id), siblingIds);
    const item = binaryItems(submission.input).find((item) => item.id === row.item_id);
    ensure(item && row.expected_sha256 === item.sha256 && row.expected_byte_size === item.byteSize, "item input checksum or size");
    const purpose = item.kind === "attachment" ? "research_source" : item.relatedAttachmentId ? "derived_preview" : "embedded_content";
    ensure(row.purpose === purpose && row.storage_profile_revision === 1, "item purpose or profile revision");
    const profile = profiles.get(row.storage_profile_id);
    const managed = item.kind === "attachment";
    ensure(profile && profile.adapter_type === (managed ? "switchdrive" : "r2") && profile.configuration_revision === row.storage_profile_revision
      && profile.configuration_source === (managed ? "environment" : "bootstrap")
      && profile.credential_reference === (managed ? "environment:SWITCHDRIVE" : null) && profile.state === "historical", "item profile identity");
    ensure(["pending", "ready", "cancelled"].includes(String(row.status)), "item publication state");
    if (row.execution_token === null) ensure(row.started_at === null && row.status !== "ready", "unclaimed item result");
    else {
      ensure(uuid(row.execution_token) && !executionTokens.has(row.execution_token) && timestamp(row.started_at)
        && row.started_at >= String(row.created_at) && row.started_at < String(submission.row.expires_at), "item execution identity or start");
      executionTokens.add(row.execution_token);
    }
    if (row.status !== "ready") { ensure(row.accepted_result_json === null, "unfinished item result"); continue; }
    const result = parsed(validateCommentAcceptedItemResult, row.accepted_result_json, false, 8192);
    ensure(result.storeKind === (managed ? "managed" : "r2") && result.provider === profile.adapter_type
      && result.sha256 === row.expected_sha256 && result.byteSize === row.expected_byte_size, "published item provider or byte evidence");
    ensure(result.deduplicated || result.blobRecordId === row.candidate_blob_id && result.objectKey === row.candidate_object_key, "published item candidate identity");
  }
  for (const { row, input } of submissions.values()) {
    const expected = binaryItems(input).map((item) => item.id).sort();
    ensure(same((itemsBySubmission.get(String(row.submission_id)) ?? []).sort(), expected), "complete accepted item inventory");
    if (row.status !== "ready") continue;
    const result = parsed(validateCommentPublicationResult, row.accepted_result_json, false, 32_768);
    for (const id of result.itemIds) {
      const item = input.items.find((entry) => entry.id === id)!;
      if (item.kind !== "link") ensure(items.get(id)?.status === "ready", "published item lacks accepted bytes");
    }
  }
}
