import type { FullExportBlobEntry } from "./types";

export const FULL_EXPORT_ARCHIVE_SCHEMA_V8 = 8 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V9 = 9 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V10 = 10 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V11 = 11 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V12 = 12 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V13 = 13 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V14 = 14 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V15 = 15 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA = FULL_EXPORT_ARCHIVE_SCHEMA_V15;
export const FULL_EXPORT_ARCHIVE_PROFILE_V9 = "fp1-legacy-overlap" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V10 = "fp1-import-acceptance" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V11 = "fp1-r2-upload-acceptance" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V12 = "fp1-metrology-reference-acceptance" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V13 = "fp1-comment-acceptance" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V14 = "fp1-file-authority-transition" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V15 = "fp1-shadow-conversion" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE = FULL_EXPORT_ARCHIVE_PROFILE_V15;
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
  tables: Record<string, Array<{ rowid: string; rowSha256: string }>>;
}

export interface FullExportManifestV15 extends Omit<FullExportManifestV8, "schemaVersion" | "blobs" | "artifacts"> {
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA_V15;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE_V15;
  blobs: FullExportBlobEntryV15[];
  artifacts: FullExportManifestV8["artifacts"] & { sourceRowids: ExportJsonArtifact<FileShadowSourceRowids> };
}
