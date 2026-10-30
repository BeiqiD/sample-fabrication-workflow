import type { FilePurpose, LegacyFileLocator } from "./files";

/** Real relational keys, never an identifier recovered by splitting a view key. */
export type FileConsumerSource =
  | { table: "state_representation_assets"; primaryKey: { state_hash: string; asset_id: string }; slot: "asset_id" }
  | { table: "run_step_assets" | "metrology_template_references" | "run_step_comments"; primaryKey: { id: string }; slot: "asset_id" }
  | { table: "state_verifications"; primaryKey: { id: string }; slot: "evidence_asset_id" }
  | { table: "comment_submission_items"; primaryKey: { id: string }; slot: "asset_id" | "storage_object_id" | "pending_content" }
  | { table: "events"; primaryKey: { id: string }; slot: "asset_key" | "metadata_json.thumbnailKey" }
  | { table: "imports"; primaryKey: { id: string }; slot: "workbook_asset_key" | "manifest_asset_key" }
  | { table: "template_versions"; primaryKey: { id: string }; slot: "source_asset_key" }
  | { table: "project_content_attachments"; primaryKey: { project_content_id: string }; slot: "asset_id" | "storage_object_id" | "pending_content" }
  | { table: "attachment_derivatives"; primaryKey: { id: string }; slot: "derived_asset_id" };

export interface FileConsumerRegistryObservation {
  table: "assets" | "managed_storage_objects";
  id: string;
  status: string | null;
  expectedSha256: string | null;
  expectedByteSize: number | null;
  importId: string | null;
}

export interface FileConsumerRetentionIdentity {
  sourceType: string;
  sourceId: string;
  occurrenceType: string;
  occurrenceId: string;
}

export interface FileConsumerObservation {
  /** Canonical JSON of the typed source, independent of array ordering. */
  id: string;
  source: FileConsumerSource;
  /** Original value of the real locator column; null for an unbound diagnostic. */
  recordedValue: string | null;
  locator: LegacyFileLocator | null;
  registry: FileConsumerRegistryObservation | null;
  purpose: FilePurpose | null;
  classificationReasons: string[];
  /** Metadata only. No body, filename, arbitrary JSON or provider error payload. */
  history: {
    status: string | null;
    deletedAt: string | null;
    assetDeletedAt: string | null;
    supersededBy: string | null;
    supersededAt: string | null;
    position: number | null;
    retainUntil: string | null;
    parentStatus: string | null;
    parentDeletedAt: string | null;
    parentRetryUntil: string | null;
    parentRetryClosedAt: string | null;
  };
  retentionIdentity: FileConsumerRetentionIdentity;
  /** Purpose is not evidence that this representation was derived from a source. */
  derivationTrust: "not_assessed";
}

export interface FileConsumerRetentionEdge extends FileConsumerRetentionIdentity {
  locator: LegacyFileLocator;
  blobRecordId: string | null;
  retentionReason: string;
  retainUntil: string | null;
}

export interface FileConsumerCoverageIssue {
  edge: FileConsumerRetentionEdge;
  consumerIds: string[];
  reason: "no_canonical_consumer" | "ambiguous_canonical_identity" | "registry_identity_mismatch";
}

export interface FileConsumerProjection {
  version: 1;
  consumers: FileConsumerObservation[];
  coverage: {
    retentionEdges: number;
    matchedEdges: number;
    unmatchedEdges: FileConsumerCoverageIssue[];
    ambiguousEdges: FileConsumerCoverageIssue[];
    /** Absence is informational: expiry/supersession can legitimately remove an edge. */
    consumersWithoutRetention: string[];
  };
}

export const MAX_FILE_CONSUMER_INPUT_ROWS = 20_000;
export const MAX_FILE_CONSUMER_OBSERVATIONS = 20_000;
export const MAX_FILE_CONSUMER_OUTPUT_BYTES = 8 * 1024 * 1024;
