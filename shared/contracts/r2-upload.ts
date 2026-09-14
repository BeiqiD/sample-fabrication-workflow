import { sha256Hex, stableJson } from "../domain/content-addressing";

export const MAX_R2_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_R2_UPLOAD_REQUEST_INPUT_BYTES = 8192;
export const R2_UPLOAD_REQUEST_HEADER = "X-Upload-Request-Id";
export const R2_UPLOAD_RECEIPT_LIFETIME_MS = 24 * 60 * 60 * 1000;

export type R2UploadIngress = "ordinary_image" | "project_attachment";
export type R2UploadPurpose = "embedded_content" | "research_source";
export interface R2UploadFileInput {
  originalName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
}
export interface R2UploadInput {
  schema: "r2-upload-request/1";
  ingress: R2UploadIngress;
  purpose: R2UploadPurpose;
  scope: "system";
  file: R2UploadFileInput;
}
export interface R2UploadResult { id: string; key: string; deduplicated: boolean }
interface R2UploadStateIdentity { requestId: string; ingress: R2UploadIngress; expiresAt: string }
export type R2UploadRequestState = R2UploadStateIdentity & (
  | { status: "pending" | "failed" | "expired" | "unavailable" }
  | { status: "ready"; result: R2UploadResult }
);

export function normalizeR2UploadRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ? id : null;
}
export function r2UploadPurpose(ingress: R2UploadIngress): R2UploadPurpose {
  if (ingress === "ordinary_image") return "embedded_content";
  if (ingress === "project_attachment") return "research_source";
  throw new Error("Invalid R2 upload ingress");
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function keys(value: Record<string, unknown>, expected: string[]) {
  return Object.keys(value).sort().join(",") === expected.sort().join(",");
}
function metadataText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0")
    && [...value].length <= maximum;
}

/** Strict shared metadata admission. The Worker hashes the actual bounded body;
 * an archive reader separately checks the saved canonical input digest. */
export function validateR2UploadInput(value: unknown): R2UploadInput {
  if (!record(value) || !keys(value, ["schema", "ingress", "purpose", "scope", "file"])
    || value.schema !== "r2-upload-request/1" || value.scope !== "system"
    || !(value.ingress === "ordinary_image" || value.ingress === "project_attachment")
    || value.purpose !== r2UploadPurpose(value.ingress) || !record(value.file)) {
    throw new Error("Invalid R2 upload input");
  }
  const file = value.file;
  if (!keys(file, ["originalName", "mimeType", "byteSize", "sha256"])
    || !metadataText(file.originalName, 255) || !metadataText(file.mimeType, 200)
    || !/^[\x20-\x7e]+$/.test(file.mimeType) || file.mimeType.trim() !== file.mimeType
    || value.ingress === "ordinary_image" && !file.mimeType.toLowerCase().startsWith("image/")
    || typeof file.byteSize !== "number" || !Number.isSafeInteger(file.byteSize)
    || file.byteSize < 0 || file.byteSize > MAX_R2_UPLOAD_BYTES
    || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
    throw new Error("Invalid R2 upload file metadata");
  }
  const result: R2UploadInput = {
    schema: "r2-upload-request/1", ingress: value.ingress, purpose: r2UploadPurpose(value.ingress), scope: "system",
    file: { originalName: file.originalName, mimeType: file.mimeType, byteSize: file.byteSize, sha256: file.sha256 },
  };
  if (new TextEncoder().encode(stableJson(result)).byteLength > MAX_R2_UPLOAD_REQUEST_INPUT_BYTES) {
    throw new Error("R2 upload input exceeds its byte limit");
  }
  return result;
}

export async function canonicalR2UploadInput(ingress: R2UploadIngress, file: R2UploadFileInput) {
  const input = validateR2UploadInput({ schema: "r2-upload-request/1", ingress,
    purpose: r2UploadPurpose(ingress), scope: "system", file });
  const json = stableJson(input);
  return { input, json, sha256: await sha256Hex(json) };
}
