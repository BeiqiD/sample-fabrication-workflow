import { sha256Hex, stableJson } from "../domain/content-addressing";

/** A present-day operator statement, never a recovered upload receipt. */
export interface ShadowAdjudicationRequest {
  requestId: string;
  key: { consumerKind: "project_content_attachment"; consumerId: string; consumerSubId: string; fileSlot: "primary" };
  occurrenceId: string;
  generation: number;
  sourceSha256: string;
  sourceLocator: { storeKind: "r2"; provider: "r2"; objectKey: string };
  expectedBaselineSha256: string;
  expectedEpoch: number;
  expectedIncarnation: string | null;
  sourceProfile: { profileId: string; configurationRevision: 1 };
  purpose: "research_source";
  purposeStatement: string;
  namespaceStatement: string;
  evidenceReference: string;
  supersedesId: string | null;
}
export interface ShadowAdjudicationRevocationRequest {
  requestId: string; adjudicationId: string; adjudicationRequestSha256: string; reason: string;
}
export interface ShadowAdjudicationReceipt {
  request: ShadowAdjudicationRequest; requestSha256: string; createdBy: string; createdAt: string;
  status: "accepted" | "withdrawn";
}
export interface ShadowAdjudicationRevocationReceipt {
  request: ShadowAdjudicationRevocationRequest; requestSha256: string; createdBy: string; createdAt: string;
}
export const FILE_SHADOW_ADJUDICATION_EXPORT_COLUMNS = {
  file_shadow_adjudications: ["id", "occurrence_id", "supersedes_id", "request_json", "request_sha256", "source_json", "baseline_json", "source_expected_byte_size", "source_expected_sha256", "created_by", "created_at"],
  file_shadow_adjudication_withdrawals: ["request_id", "request_json", "request_sha256", "created_by", "created_at"],
  file_shadow_adjudication_revocations: ["id", "adjudication_id", "request_json", "request_sha256", "created_by", "created_at"],
  file_shadow_operation_adjudications: ["operation_id", "adjudication_id", "adjudication_request_sha256"],
} as const;
export const MAX_SHADOW_ADJUDICATION_REQUEST_BYTES = 80 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
function invalid(): never { throw new Error("Invalid File shadow adjudication request"); }
function object(value: unknown, names: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const actual = Object.keys(value).sort(), expected = [...names].sort();
  if (actual.length !== expected.length || actual.some((name, i) => name !== expected[i])) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, bound: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= bound && !value.includes("\0");
}
function narrative(value: unknown): value is string { return text(value, 4000) && !!value.trim() && encoder.encode(value).length <= 16000; }
export function checkedShadowAdjudicationRequest(value: unknown): ShadowAdjudicationRequest {
  const input = object(value, ["requestId", "key", "occurrenceId", "generation", "sourceSha256", "sourceLocator", "expectedBaselineSha256", "expectedEpoch", "expectedIncarnation", "sourceProfile", "purpose", "purposeStatement", "namespaceStatement", "evidenceReference", "supersedesId"]);
  const key = object(input.key, ["consumerKind", "consumerId", "consumerSubId", "fileSlot"]);
  const locator = object(input.sourceLocator, ["storeKind", "provider", "objectKey"]);
  const profile = object(input.sourceProfile, ["profileId", "configurationRevision"]);
  if (typeof input.requestId !== "string" || !UUID.test(input.requestId)
    || key.consumerKind !== "project_content_attachment" || key.fileSlot !== "primary"
    || Object.values(key).some((part) => typeof part !== "string") || encoder.encode(stableJson(key)).length > 64 * 1024
    || !text(input.occurrenceId, 256) || typeof input.generation !== "number" || !Number.isSafeInteger(input.generation) || input.generation < 1
    || typeof input.sourceSha256 !== "string" || !SHA.test(input.sourceSha256)
    || locator.storeKind !== "r2" || locator.provider !== "r2" || !text(locator.objectKey, 4096) || !locator.objectKey.trim() || encoder.encode(locator.objectKey).length > 4096
    || typeof input.expectedBaselineSha256 !== "string" || !SHA.test(input.expectedBaselineSha256)
    || typeof input.expectedEpoch !== "number" || !Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 0
    || input.expectedIncarnation !== null && (typeof input.expectedIncarnation !== "string" || !UUID.test(input.expectedIncarnation))
    || !text(profile.profileId, 256) || profile.configurationRevision !== 1 || input.purpose !== "research_source"
    || !narrative(input.purposeStatement) || !narrative(input.namespaceStatement) || !narrative(input.evidenceReference)
    || input.supersedesId !== null && (typeof input.supersedesId !== "string" || !UUID.test(input.supersedesId) || input.supersedesId === input.requestId)) invalid();
  const result = JSON.parse(stableJson(input)) as ShadowAdjudicationRequest;
  if (encoder.encode(stableJson(result)).length > MAX_SHADOW_ADJUDICATION_REQUEST_BYTES) invalid();
  return result;
}
export function checkedShadowAdjudicationRevocationRequest(value: unknown): ShadowAdjudicationRevocationRequest {
  const input = object(value, ["requestId", "adjudicationId", "adjudicationRequestSha256", "reason"]);
  if (typeof input.requestId !== "string" || !UUID.test(input.requestId)
    || typeof input.adjudicationId !== "string" || !UUID.test(input.adjudicationId)
    || typeof input.adjudicationRequestSha256 !== "string" || !SHA.test(input.adjudicationRequestSha256) || !narrative(input.reason)) invalid();
  return JSON.parse(stableJson(input)) as ShadowAdjudicationRevocationRequest;
}
export async function shadowAdjudicationRequestSha256(input: ShadowAdjudicationRequest): Promise<string> {
  return sha256Hex(stableJson(checkedShadowAdjudicationRequest(input)));
}
export async function shadowAdjudicationRevocationRequestSha256(input: ShadowAdjudicationRevocationRequest): Promise<string> {
  return sha256Hex(stableJson(checkedShadowAdjudicationRevocationRequest(input)));
}
