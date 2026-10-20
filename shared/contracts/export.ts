import type { FullExportBlobEntry } from "./types";

export const FULL_EXPORT_ARCHIVE_SCHEMA_V8 = 8 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V9 = 9 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V10 = 10 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V11 = 11 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V12 = 12 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V13 = 13 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V14 = 14 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V15 = 15 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V16 = 16 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V17 = 17 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V18 = 18 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V19 = 19 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V20 = 20 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V21 = 21 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V22 = 22 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V23 = 23 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V24 = 24 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA = FULL_EXPORT_ARCHIVE_SCHEMA_V24;
export const FULL_EXPORT_ARCHIVE_PROFILE_V9 = "fp1-legacy-overlap" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V10 = "fp1-import-acceptance" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V11 = "fp1-r2-upload-acceptance" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V12 = "fp1-metrology-reference-acceptance" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V13 = "fp1-comment-acceptance" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V14 = "fp1-file-authority-transition" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V15 = "fp1-shadow-conversion" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V16 = "fp1-shadow-withdrawals" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V17 = "fp1-shadow-adjudications" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V18 = "fp1-file-runtime" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V19 = "fp1-r2-role-defaults" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V20 = "fp2-native-profile-admission" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V21 = "fp2-native-file-runtime" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V22 = "fp3-file-migrations" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V23 = "fp4-research-packages" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V24 = "fp5-system-recovery-evidence" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE = FULL_EXPORT_ARCHIVE_PROFILE_V24;
export const FULL_EXPORT_ARCHIVE_WRITER = 1 as const;

export type ExportCell = string | number | null;
export type ExportRow = Record<string, ExportCell>;
export type ExportTables = Record<string, ExportRow[]>;
export type CompatibilitySchema = "S0" | "S1" | "S2";

export interface ExportSchemaObject {
  type: "table" | "index" | "view" | "trigger";
  name: string;
  tableName: string;
  sql: string | null;
}

// Observations and rows must originate in the same D1 snapshot batch. The
// physical schema is evidence, not something inferred from a Worker version.
export interface ObservedExportSchema {
  version: 1;
  kind: "observed-sqlite-schema";
  objects: ExportSchemaObject[];
  compatibilityColumns: { samples: string[]; run_step_comments: string[] };
}

/** Successor retention views share one source SQLite clock. Historical
 * observations keep their original artifact shape and clock limitations. */
export interface ObservedNativeExportSchema extends ObservedExportSchema {
  snapshotClock: string;
}

export interface RetiredExportField<T extends ExportCell> {
  presentInSourceSchema: boolean;
  complete: boolean;
  sourceRowCount: number;
  values: Array<{ id: string; value: T }>;
}

export interface RetiredExportFields {
  version: 1;
  samplesProcessRevision: RetiredExportField<number>;
  runStepCommentsBody: RetiredExportField<string>;
}

export interface ExportJsonArtifact<T> {
  path: string;
  byteSize: number;
  sha256: string;
  value: T;
}

export interface FullExportManifestV8 {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V8;
  archiveWriter: typeof FULL_EXPORT_ARCHIVE_WRITER;
  exportedAt: string;
  tables: ExportTables;
  blobs: FullExportBlobEntry[];
  artifacts: {
    sourceSchema: ExportJsonArtifact<ObservedExportSchema>;
    retiredFields: ExportJsonArtifact<RetiredExportFields>;
  };
}

// The first file schema is dormant metadata: existing locators own reads,
// writes and retention until the separate runtime conversion is qualified.
export interface FullExportManifestV9 extends Omit<FullExportManifestV8, "schemaVersion"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V9;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V9;
}

// Import acceptance remains on the existing import operation; File authority
// is still dormant. The new profile preserves the immutable retry decision.
export interface FullExportManifestV10 extends Omit<FullExportManifestV8, "schemaVersion"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V10;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V10;
}

// Durable R2 upload decisions remain historical receipts, not File authority
// or a new retention root.
export interface FullExportManifestV11 extends Omit<FullExportManifestV8, "schemaVersion"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V11;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V11;
}

// Metrology business publication receipts retain the accepted occurrence result
// independently of its later lifecycle, without extending byte retention.
export interface FullExportManifestV12 extends Omit<FullExportManifestV8, "schemaVersion"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V12;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V12;
}

// Comment acceptance preserves canonical submission and item identities plus
// immutable execution decisions; its receipts do not extend byte retention.
export interface FullExportManifestV13 extends Omit<FullExportManifestV8, "schemaVersion"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V13;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V13;
}

// Schema 14 records the additive File-authority transition. Legacy locators
// remain the sole byte authority until a separately reviewed publication gate.
export interface FullExportManifestV14 extends Omit<FullExportManifestV8, "schemaVersion"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V14;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V14;
}

// Profile identities are part of a V15 location's byte address. A same-key
// legacy entry and a new shadow placement must never alias in the archive.
export interface FullExportBlobEntryV15 extends FullExportBlobEntry {
  byteAuthority: "legacy" | "file_location";
  storageProfileId: string | null;
  storageProfileRevision: number | null;
  locationId: string | null;
}

export interface FileShadowSourceRowids {
  version: 1;
  kind: "file-shadow-source-rowids";
  // Entries have the same ordinal as their hashed logical archive table rows.
  // Signed int64 decimal text, also used by V15 heads/occurrences.source_rowid.
  tables: Record<string, Array<{ rowid: string; rowSha256: string }>>;
}

export interface FullExportManifestV15 extends Omit<FullExportManifestV8, "schemaVersion" | "blobs" | "artifacts"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V15;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V15;
  blobs: FullExportBlobEntryV15[];
  artifacts: FullExportManifestV8["artifacts"] & { sourceRowids: ExportJsonArtifact<FileShadowSourceRowids> };
}

// Durable no-claim withdrawal receipts survive backup and block delayed replay.
export interface FullExportManifestV16 extends Omit<FullExportManifestV15, "schemaVersion" | "archiveProfile"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V16;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V16;
}

// Historical operator decisions and their immutable conversion bindings.
export interface FullExportManifestV17 extends Omit<FullExportManifestV15, "schemaVersion" | "archiveProfile"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V17;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V17;
}

// File runtime candidates, typed bindings and accepted publication provenance.
export interface FullExportManifestV18 extends Omit<FullExportManifestV15, "schemaVersion" | "archiveProfile"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V18;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V18;
}

// Immutable R2 role defaults and Comment receipts with frozen original destinations.
export interface FullExportManifestV19 extends Omit<FullExportManifestV15, "schemaVersion" | "archiveProfile"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V19;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V19;
}

// AWS-account-qualified S3 registration remains metadata-only and never grants execution.
export interface FullExportManifestV20 extends Omit<FullExportManifestV15, "schemaVersion" | "archiveProfile"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V20;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V20;
}

/** Native provider bytes have no legacy managed-object identity. Keep this
 * successor wire type separate from the frozen V7–V20 blob contracts. */
export interface FullExportNativeBlobEntryV21 extends Omit<FullExportBlobEntryV15, "storeKind" | "provider" | "byteAuthority" | "storageProfileId" | "storageProfileRevision" | "locationId"> {
  storeKind: "file";
  provider: "s3";
  byteAuthority: "file_location";
  storageProfileId: string;
  storageProfileRevision: number;
  locationId: string;
}

export type FullExportBlobEntryV21 = FullExportBlobEntryV15 | FullExportNativeBlobEntryV21;

export interface FullExportManifestV21 extends Omit<FullExportManifestV15, "schemaVersion" | "archiveProfile" | "blobs" | "artifacts"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V21;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V21;
  blobs: FullExportBlobEntryV21[];
  artifacts: Omit<FullExportManifestV15["artifacts"], "sourceSchema"> & {
    sourceSchema: ExportJsonArtifact<ObservedNativeExportSchema>;
  };
}

export interface FullExportManifestV22 extends Omit<FullExportManifestV21, "schemaVersion" | "archiveProfile"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V22;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V22;
}

/** Temporary package output bytes are not recursive full-backup inputs.
 * Their portable ownership and verification history remains in the tables. */
export interface ExcludedResearchPackageOutput {
  locationId: string;
  fileId: string;
  jobId: string;
  reason: "disposable_job_output";
}

export interface FullExportManifestV23 extends Omit<FullExportManifestV22, "schemaVersion" | "archiveProfile"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V23;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V23;
  excludedOutputs: ExcludedResearchPackageOutput[];
}

/** FP5 preserves qualified recovery File publications and unverified imported
 * preview provenance without changing the historical V23 contract. */
export interface FullExportManifestV24 extends Omit<FullExportManifestV23, "schemaVersion" | "archiveProfile"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V24;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V24;
  relocatedSources: RelocatedSystemRecoverySource[];
  backupHoldOwner: string | null;
}

export interface RelocatedSystemRecoverySource {
  evidenceId: string; sourceLocatorId: string; sourceLocationId: string | null; sourceFileId: string | null;
  destinationFileId: string; destinationLocationId: string; byteSize: number; sha256: string;
  reason: "verified_recovery_relocation";
}
