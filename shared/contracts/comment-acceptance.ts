import { sha256Hex, stableJson } from "../domain/content-addressing";
import { validateCommentSubmissionInput, validSha256, validSubmissionId } from "./comment-submissions";
import type { CommentSubmissionItemInput, CreateCommentSubmissionInput } from "./types";

export const COMMENT_ACCEPTANCE_PROTOCOL = "comment-submission/1";
export const COMMENT_ACCEPTANCE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_COMMENT_ACCEPTANCE_INPUT_BYTES = 512 * 1024;
export type AcceptedCommentItemInput = CommentSubmissionItemInput & { sha256?: string };
export type AcceptedCommentSubmissionInput = Omit<CreateCommentSubmissionInput, "items"> & {
  protocol: typeof COMMENT_ACCEPTANCE_PROTOCOL; items: AcceptedCommentItemInput[];
};
export interface CommentPublicationPlan {
  schema: "comment-publication/1"; mutationId: string; operationGroupId: string | null;
  occurrences: { id: string; targetIndex: number }[];
  events: { id: string; sampleId: string }[];
}
export interface CommentPublicationResult {
  submissionId: string; completedAt: string; occurrenceIds: string[]; eventIds: string[]; itemIds: string[];
}
export interface CommentAcceptedItemResult {
  storeKind: "r2" | "managed"; provider: "r2" | "switchdrive"; blobRecordId: string; objectKey: string;
  sha256: string; byteSize: number; deduplicated: boolean;
}
export interface CommentAcceptanceState {
  submissionId: string; inputSha256: string | null; expiresAt: string | null;
  status: "pending" | "ready" | "cancelled" | "expired" | "unavailable" | "legacy";
  input: AcceptedCommentSubmissionInput | null;
  items: { id: string; kind: CommentSubmissionItemInput["kind"]; status: "pending" | "uploading" | "ready" | "cancelled" | "unavailable"; sha256: string | null }[];
  result?: CommentPublicationResult;
}
export interface CommentAcceptanceResponse { request: CommentAcceptanceState }
function record(v: unknown): v is Record<string, unknown> { return Boolean(v && typeof v === "object" && !Array.isArray(v)); }
function exact(v: Record<string, unknown>, keys: string[]) { return Object.keys(v).sort().join(",") === [...keys].sort().join(","); }
function text(v: unknown, max = 256): v is string { return typeof v === "string" && v.length > 0 && [...v].length <= max && !v.includes("\0"); }
function uuid(v: unknown): v is string { return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v); }
function iso(v: unknown): v is string { return typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v; }
function bounded<T>(v: T): T { if (new TextEncoder().encode(stableJson(v)).byteLength > MAX_COMMENT_ACCEPTANCE_INPUT_BYTES) throw new Error("Comment acceptance input exceeds its byte limit"); return v; }
export function validateCommentAcceptanceInput(value: unknown): AcceptedCommentSubmissionInput {
  if (!record(value) || !exact(value, ["protocol", "id", "body", "context", "items"]) || value.protocol !== COMMENT_ACCEPTANCE_PROTOCOL
    || validateCommentSubmissionInput(value) || typeof value.body !== "string" || value.body.includes("\0") || !Array.isArray(value.items)
    || !record(value.context)) throw new Error("Invalid accepted Comment input");
  const context = value.context;
  if (context.kind === "sample") {
    if (!exact(context, ["kind", "sampleId", "expectedUpdatedAt"])) throw new Error("Invalid accepted Comment context");
  } else if (!exact(context, ["kind", "scope", "targets"]) || !Array.isArray(context.targets)
    || context.targets.some((target) => !record(target) || !exact(target, ["sampleId", "runId", "stepId", "expectedUpdatedAt"]))) throw new Error("Invalid accepted Comment targets");
  for (const item of value.items) {
    if (!record(item)) throw new Error("Invalid accepted Comment item");
    const allowed = item.kind === "comment_image" ? ["id", "kind", "filename", "mimeType", "byteSize", "originalFilename", "originalMimeType", "originalByteSize", "relatedAttachmentId", "sha256"]
      : item.kind === "attachment" ? ["id", "kind", "filename", "mimeType", "byteSize", "title", "relatedCommentImageId", "sha256"] : ["id", "kind", "url", "title", "description"];
    if (Object.keys(item).some((key) => !allowed.includes(key)) || item.kind !== "link" && !validSha256(item.sha256)) throw new Error("Every accepted upload requires its prepared byte checksum");
  }
  return bounded({ ...value, body: value.body.trim() } as unknown as AcceptedCommentSubmissionInput);
}
export async function canonicalCommentAcceptanceInput(value: unknown) {
  const input = validateCommentAcceptanceInput(value); const json = stableJson(input);
  return { input, json, sha256: await sha256Hex(json) };
}
export function validateCommentPublicationPlan(value: unknown): CommentPublicationPlan {
  if (!record(value) || !exact(value, ["schema", "mutationId", "operationGroupId", "occurrences", "events"])
    || value.schema !== "comment-publication/1" || !uuid(value.mutationId) || !(value.operationGroupId === null || uuid(value.operationGroupId))
    || !Array.isArray(value.occurrences) || value.occurrences.length > 12 || !Array.isArray(value.events) || !value.events.length || value.events.length > 12
    || value.occurrences.some((entry) => !record(entry) || !exact(entry, ["id", "targetIndex"]) || !uuid(entry.id) || !Number.isSafeInteger(entry.targetIndex) || Number(entry.targetIndex) < 0 || Number(entry.targetIndex) > 11)
    || value.events.some((entry) => !record(entry) || !exact(entry, ["id", "sampleId"]) || !uuid(entry.id) || !text(entry.sampleId, 200))) throw new Error("Invalid Comment publication plan");
  const ids = [...value.occurrences, ...value.events].map((entry) => entry.id);
  if (new Set(ids).size !== ids.length || new Set(value.occurrences.map((entry) => entry.targetIndex)).size !== value.occurrences.length
    || new Set(value.events.map((entry) => entry.sampleId)).size !== value.events.length) throw new Error("Duplicate Comment publication identity");
  return bounded(value as unknown as CommentPublicationPlan);
}
export function validateCommentPublicationResult(value: unknown): CommentPublicationResult {
  if (!record(value) || !exact(value, ["submissionId", "completedAt", "occurrenceIds", "eventIds", "itemIds"])
    || !validSubmissionId(value.submissionId) || !iso(value.completedAt)
    || !Array.isArray(value.occurrenceIds) || value.occurrenceIds.length > 12 || value.occurrenceIds.some((id) => !uuid(id))
    || !Array.isArray(value.eventIds) || !value.eventIds.length || value.eventIds.length > 12 || value.eventIds.some((id) => !uuid(id))
    || !Array.isArray(value.itemIds) || value.itemIds.length > 24 || value.itemIds.some((id) => !validSubmissionId(id))) throw new Error("Invalid Comment publication result");
  for (const key of ["occurrenceIds", "eventIds", "itemIds"] as const) if (new Set(value[key] as string[]).size !== (value[key] as string[]).length) throw new Error("Duplicate Comment result identity");
  return bounded(value as unknown as CommentPublicationResult);
}
export function validateCommentAcceptedItemResult(value: unknown): CommentAcceptedItemResult {
  if (!record(value) || !exact(value, ["storeKind", "provider", "blobRecordId", "objectKey", "sha256", "byteSize", "deduplicated"])
    || !((value.storeKind === "r2" && value.provider === "r2") || (value.storeKind === "managed" && value.provider === "switchdrive"))
    || !text(value.blobRecordId) || !text(value.objectKey, 4096) || !validSha256(value.sha256) || !Number.isSafeInteger(value.byteSize)
    || Number(value.byteSize) < 1 || Number(value.byteSize) > (value.storeKind === "r2" ? 5 : 100) * 1024 * 1024
    || typeof value.deduplicated !== "boolean") throw new Error("Invalid accepted Comment upload result");
  return value as unknown as CommentAcceptedItemResult;
}
