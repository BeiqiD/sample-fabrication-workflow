import type { ReferencePermanentDeleteSourceType } from "../../shared/reference-types";

export type BlobStoreKind = "r2" | "managed";

export interface BlobLocator {
  storeKind: BlobStoreKind;
  provider: string;
  objectKey: string;
  blobRecordId: string | null;
}

export interface RetentionEdgeRow {
  store_kind: BlobStoreKind;
  provider: string;
  object_key: string;
  blob_record_id: string | null;
  source_type: string;
  source_id: string;
  occurrence_type: string;
  occurrence_id: string;
  retention_reason: string;
  retain_until: string | null;
}

export type BlobGcState = "orphaned" | "deleting" | "deleted";

export interface BlobGcLedgerRow {
  store_kind: BlobStoreKind;
  provider: string;
  object_key: string;
  blob_record_id: string | null;
  state: BlobGcState;
  operation_id: string | null;
  orphaned_at: string | null;
  deletion_started_at: string | null;
  deleted_at: string | null;
  attempt_count: number;
  last_error: string | null;
  updated_at: string;
}

export interface PermanentDeleteTarget {
  sourceType: ReferencePermanentDeleteSourceType;
  sourceId: string;
}

export interface PermanentDeleteBlocker {
  sourceType: PermanentDeleteTarget["sourceType"];
  sourceId: string;
  relation: string;
  blockerType: string;
  blockerId: string;
  blockerState: string;
}
