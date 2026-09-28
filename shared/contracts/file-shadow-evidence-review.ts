import type { FilePurpose } from "./files";

/** Safe, read-only metadata for reviewing one historical Project reference.
 * Recorded byte expectations are not a new byte verification or admission. */
export interface FileShadowReviewKey {
  consumerKind: string;
  consumerId: string;
  consumerSubId: string;
  fileSlot: string;
}
export interface FileShadowIdentification {
  projectId: string;
  projectTitle: string;
  attachmentName: string;
}
export interface FileShadowEvidenceReview {
  version: 1;
  kind: "file-shadow-evidence-review";
  readOnly: true;
  bytesVerified: false;
  key: FileShadowReviewKey;
  head: { generation: number; occurrenceId: string; sourceMetadataSha256: string } | null;
  baselineSha256: string;
  status: "absent" | "resolved" | "admitted_unresolved" | "pending_no_locator" | "unavailable" | "ambiguous" | "ready_to_verify";
  reasons: string[];
  identification: FileShadowIdentification | null;
  purpose: FilePurpose | null;
  expectedBytes: number | null;
  expectedSha256: string | null;
  sourceProvider: "r2" | "other" | null;
  sourceProfile: { profileId: string; configurationRevision: 1 } | null;
  peerReferences: Array<{ key: FileShadowReviewKey; purpose: FilePurpose | null }>;
}
export const MAX_FILE_SHADOW_REVIEW_BYTES = 512 * 1024;
export const MAX_FILE_SHADOW_IDENTIFICATION_LABEL_BYTES = 4096;
export const MAX_FILE_SHADOW_REVIEW_KEY_BYTES = 64 * 1024;
export const MAX_FILE_SHADOW_REVIEW_PEERS = 100;
const FILE_SHADOW_REVIEW_REASONS = new Set([
  "event_locator_semantics_invalid", "consumer_unavailable_without_locator", "registry_record_missing", "consumer_has_no_locator",
  "consumer_generation_unfinished", "consumer_parent_missing", "unsupported_legacy_provider", "legacy_locator_requires_explicit_resolution",
  "conflicting_registry_bindings", "legacy_registry_not_ready", "legacy_lifecycle_blocks_verification", "unexpected_existing_file_binding",
  "expected_byte_metadata_incomplete", "expected_byte_metadata_conflict", "acceptance_unfinished", "accepted_result_invalid",
  "accepted_registry_identity_mismatch", "consumer_purpose_unresolved", "recorded_purpose_conflict", "derivation_not_assessed",
  "shared_locator_purpose_unresolved", "independent_verified_copies_required", "namespace_evidence_missing", "namespace_evidence_invalid",
  "namespace_conflict", "namespace_revision_mismatch", "source_exceeds_verified_byte_limit", "source_profile_unresolved",
]);
const encoder = new TextEncoder();
function invalid(): never { throw new Error("Invalid File shadow evidence review"); }
function object(value: unknown, names: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const actual = Object.keys(value).sort(), expected = [...names].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || encoder.encode(value).length > maximum) invalid();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
function purpose(value: unknown): FilePurpose | null {
  if (value === null) return null;
  if (typeof value !== "string" || !["research_source", "embedded_content", "derived_preview", "provenance", "job_output"].includes(value)) invalid();
  return value as FilePurpose;
}
function typedKey(value: unknown): FileShadowReviewKey {
  const row = object(value, ["consumerKind", "consumerId", "consumerSubId", "fileSlot"]);
  const result = { consumerKind: text(row.consumerKind, MAX_FILE_SHADOW_REVIEW_KEY_BYTES), consumerId: text(row.consumerId, MAX_FILE_SHADOW_REVIEW_KEY_BYTES),
    consumerSubId: text(row.consumerSubId, MAX_FILE_SHADOW_REVIEW_KEY_BYTES), fileSlot: text(row.fileSlot, MAX_FILE_SHADOW_REVIEW_KEY_BYTES) };
  if (encoder.encode(JSON.stringify(result)).length > MAX_FILE_SHADOW_REVIEW_KEY_BYTES) invalid();
  return result;
}
/** Preserve opaque historical strings. Only the reviewed slot is narrowed. */
export function checkedFileShadowReviewKey(value: unknown): FileShadowReviewKey {
  const key = typedKey(value);
  if (key.consumerKind !== "project_content_attachment" || key.fileSlot !== "primary") invalid();
  return key;
}
export function checkedFileShadowIdentification(value: unknown): FileShadowIdentification | null {
  if (value === null) return null;
  const row = object(value, ["projectId", "projectTitle", "attachmentName"]);
  return { projectId: text(row.projectId, MAX_FILE_SHADOW_REVIEW_KEY_BYTES),
    projectTitle: text(row.projectTitle, MAX_FILE_SHADOW_IDENTIFICATION_LABEL_BYTES),
    attachmentName: text(row.attachmentName, MAX_FILE_SHADOW_IDENTIFICATION_LABEL_BYTES) };
}
/** Reject extra metadata instead of accidentally exposing it through a spread. */
export function checkedFileShadowEvidenceReview(value: unknown): FileShadowEvidenceReview {
  const row = object(value, ["version", "kind", "readOnly", "bytesVerified", "key", "head", "baselineSha256", "status", "reasons", "identification",
    "purpose", "expectedBytes", "expectedSha256", "sourceProvider", "sourceProfile", "peerReferences"]);
  if (row.version !== 1 || row.kind !== "file-shadow-evidence-review" || row.readOnly !== true || row.bytesVerified !== false) invalid();
  const key = checkedFileShadowReviewKey(row.key);
  let head: FileShadowEvidenceReview["head"] = null;
  if (row.head !== null) {
    const h = object(row.head, ["generation", "occurrenceId", "sourceMetadataSha256"]);
    if (!Number.isSafeInteger(h.generation) || Number(h.generation) < 1) invalid();
    const occurrenceId = text(h.occurrenceId, 1024);
    if (!occurrenceId || occurrenceId.includes("\0")) invalid();
    head = { generation: h.generation as number, occurrenceId, sourceMetadataSha256: digest(h.sourceMetadataSha256) };
  }
  if (typeof row.status !== "string" || !["absent", "resolved", "admitted_unresolved", "pending_no_locator", "unavailable", "ambiguous", "ready_to_verify"].includes(row.status)) invalid();
  if (row.status !== "absent" && head === null) invalid();
  if (!Array.isArray(row.reasons) || row.reasons.length > 64 || row.reasons.some(reason => typeof reason !== "string" || !FILE_SHADOW_REVIEW_REASONS.has(reason))) invalid();
  if (row.expectedBytes !== null && (!Number.isSafeInteger(row.expectedBytes) || Number(row.expectedBytes) < 0)) invalid();
  if (![null, "r2", "other"].includes(row.sourceProvider as null | string)) invalid();
  let sourceProfile: FileShadowEvidenceReview["sourceProfile"] = null;
  if (row.sourceProfile !== null) {
    const profile = object(row.sourceProfile, ["profileId", "configurationRevision"]);
    const profileId = text(profile.profileId, 1024);
    if (!profileId || profileId.includes("\0") || profile.configurationRevision !== 1) invalid();
    sourceProfile = { profileId, configurationRevision: 1 };
  }
  if (!Array.isArray(row.peerReferences) || row.peerReferences.length > MAX_FILE_SHADOW_REVIEW_PEERS) invalid();
  let peerBytes = 0;
  const keyIdentity = (value: FileShadowReviewKey) => JSON.stringify([value.consumerKind, value.consumerId, value.consumerSubId, value.fileSlot]);
  const identities = new Set([keyIdentity(key)]);
  const peerReferences = row.peerReferences.map(value => {
    const peer = object(value, ["key", "purpose"]), result = { key: typedKey(peer.key), purpose: purpose(peer.purpose) };
    const identity = keyIdentity(result.key);
    if (identities.has(identity)) invalid();
    identities.add(identity);
    peerBytes += encoder.encode(JSON.stringify(result)).length;
    if (peerBytes > MAX_FILE_SHADOW_REVIEW_BYTES) invalid();
    return result;
  });
  const result: FileShadowEvidenceReview = { version: 1, kind: "file-shadow-evidence-review", readOnly: true, bytesVerified: false,
    key, head, baselineSha256: digest(row.baselineSha256), status: row.status as FileShadowEvidenceReview["status"],
    reasons: [...row.reasons], identification: checkedFileShadowIdentification(row.identification), purpose: purpose(row.purpose),
    expectedBytes: row.expectedBytes as number | null, expectedSha256: row.expectedSha256 === null ? null : digest(row.expectedSha256),
    sourceProvider: row.sourceProvider as FileShadowEvidenceReview["sourceProvider"], sourceProfile, peerReferences };
  if (encoder.encode(JSON.stringify(result)).length > MAX_FILE_SHADOW_REVIEW_BYTES) invalid();
  return result;
}
