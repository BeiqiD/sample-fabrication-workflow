import { sha256Hex, stableJson } from "../domain/content-addressing";
import type { MetrologyTemplateReference } from "./template";
import type { R2UploadFileInput } from "./r2-upload";

export const MAX_METROLOGY_REFERENCE_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_METROLOGY_REFERENCE_REQUEST_INPUT_BYTES = 8192;
export interface MetrologyReferenceUploadInput {
  schema: "metrology-reference-upload/1";
  ingress: "metrology_reference";
  purpose: "research_source";
  scope: "system";
  templateId: string;
  file: R2UploadFileInput;
}
export interface MetrologyReferenceOccurrenceSnapshot {
  id: string; assetId: string; filename: string; position: number;
  actorEmail: string | null; createdAt: string; deletedAt: string | null; deletedBy: string | null;
}
export type MetrologyReferencePublicationPlan = {
  schema: "metrology-reference-publication/1";
} & ({ action: "create"; reference: null } | { action: "reuse" | "restore"; reference: MetrologyReferenceOccurrenceSnapshot });
export interface MetrologyReferenceUploadResult {
  assetId: string;
  deduplicated: boolean;
  reference: MetrologyTemplateReference;
}
export type MetrologyReferenceUploadRequestState = {
  requestId: string; templateId: string; expiresAt: string;
} & ({ status: "pending" | "failed" | "expired" | "unavailable" }
  | { status: "ready"; result: MetrologyReferenceUploadResult });
export interface MetrologyReferenceUploadResponse {
  request: MetrologyReferenceUploadRequestState;
  reference?: MetrologyTemplateReference;
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function keys(value: Record<string, unknown>, expected: string[]) {
  return Object.keys(value).sort().join(",") === expected.sort().join(",");
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && [...value].length <= max && !value.includes("\0");
}
function optionalText(value: unknown, max: number): value is string | null { return value === null || text(value, max); }
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function bounded<T>(value: T): T {
  if (new TextEncoder().encode(stableJson(value)).byteLength > MAX_METROLOGY_REFERENCE_REQUEST_INPUT_BYTES) throw new Error("Metrology reference request exceeds its byte limit");
  return value;
}
export function validateMetrologyReferenceUploadInput(value: unknown): MetrologyReferenceUploadInput {
  if (!record(value) || !keys(value, ["schema", "ingress", "purpose", "scope", "templateId", "file"])
    || value.schema !== "metrology-reference-upload/1" || value.ingress !== "metrology_reference"
    || value.purpose !== "research_source" || value.scope !== "system" || !text(value.templateId, 256) || !record(value.file)) throw new Error("Invalid metrology reference input");
  const file = value.file;
  if (!keys(file, ["originalName", "mimeType", "byteSize", "sha256"]) || !text(file.originalName, 255)
    || !text(file.mimeType, 200) || !/^[\x20-\x7e]+$/.test(file.mimeType) || file.mimeType.trim() !== file.mimeType
    || typeof file.byteSize !== "number" || !Number.isSafeInteger(file.byteSize) || file.byteSize < 1 || file.byteSize > MAX_METROLOGY_REFERENCE_UPLOAD_BYTES
    || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid metrology reference file metadata");
  return bounded({ schema: value.schema, ingress: value.ingress, purpose: value.purpose, scope: value.scope, templateId: value.templateId,
    file: { originalName: file.originalName, mimeType: file.mimeType, byteSize: file.byteSize, sha256: file.sha256 } });
}
export async function canonicalMetrologyReferenceUploadInput(templateId: string, file: R2UploadFileInput) {
  const input = validateMetrologyReferenceUploadInput({ schema: "metrology-reference-upload/1", ingress: "metrology_reference", purpose: "research_source", scope: "system", templateId, file });
  const json = stableJson(input);
  return { input, json, sha256: await sha256Hex(json) };
}
export function validateMetrologyReferencePublicationPlan(value: unknown): MetrologyReferencePublicationPlan {
  if (!record(value) || !keys(value, ["schema", "action", "reference"]) || value.schema !== "metrology-reference-publication/1") throw new Error("Invalid metrology reference publication plan");
  if (value.action === "create" && value.reference === null) return bounded({ schema: value.schema, action: value.action, reference: null });
  const ref = value.reference;
  if (!(value.action === "reuse" || value.action === "restore") || !record(ref)
    || !keys(ref, ["id", "assetId", "filename", "position", "actorEmail", "createdAt", "deletedAt", "deletedBy"])
    || !text(ref.id, 256) || !text(ref.assetId, 256) || !text(ref.filename, 255)
    || typeof ref.position !== "number" || !Number.isSafeInteger(ref.position) || ref.position < 0
    || !optionalText(ref.actorEmail, 256) || !timestamp(ref.createdAt) || !optionalText(ref.deletedBy, 256)
    || !(ref.deletedAt === null || timestamp(ref.deletedAt))
    || value.action === "reuse" && (ref.deletedAt !== null || ref.deletedBy !== null)
    || value.action === "restore" && ref.deletedAt === null) throw new Error("Invalid metrology reference occurrence snapshot");
  return bounded({ schema: value.schema, action: value.action, reference: { id: ref.id, assetId: ref.assetId, filename: ref.filename,
    position: ref.position, actorEmail: ref.actorEmail, createdAt: ref.createdAt, deletedAt: ref.deletedAt, deletedBy: ref.deletedBy } });
}
export function validateMetrologyReferenceUploadResult(value: unknown): MetrologyReferenceUploadResult {
  if (!record(value) || !keys(value, ["assetId", "deduplicated", "reference"]) || !text(value.assetId, 256)
    || typeof value.deduplicated !== "boolean" || !record(value.reference)) throw new Error("Invalid metrology reference result");
  const ref = value.reference;
  if (!keys(ref, ["id", "filename", "mimeType", "byteSize", "assetKey", "createdAt"])
    || !text(ref.id, 256) || !text(ref.filename, 255) || !text(ref.mimeType, 200) || !/^[\x20-\x7e]+$/.test(ref.mimeType)
    || ref.mimeType.trim() !== ref.mimeType || typeof ref.byteSize !== "number" || !Number.isSafeInteger(ref.byteSize)
    || ref.byteSize < 1 || ref.byteSize > MAX_METROLOGY_REFERENCE_UPLOAD_BYTES || !text(ref.assetKey, 4096) || !timestamp(ref.createdAt)) throw new Error("Invalid metrology reference result snapshot");
  return bounded({ assetId: value.assetId, deduplicated: value.deduplicated, reference: { id: ref.id, filename: ref.filename,
    mimeType: ref.mimeType, byteSize: ref.byteSize, assetKey: ref.assetKey, createdAt: ref.createdAt } });
}
