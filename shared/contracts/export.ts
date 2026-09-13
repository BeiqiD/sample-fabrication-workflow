import type { FullExportBlobEntry } from "./types";

export const FULL_EXPORT_ARCHIVE_SCHEMA_V8 = 8 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA_V9 = 9 as const;
export const FULL_EXPORT_ARCHIVE_SCHEMA = 10 as const;
export const FULL_EXPORT_ARCHIVE_PROFILE_V9 = "fp1-legacy-overlap" as const;
export const FULL_EXPORT_ARCHIVE_PROFILE = "fp1-import-acceptance" as const;
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
  schemaVersion: typeof FULL_EXPORT_ARCHIVE_SCHEMA;
  archiveProfile: typeof FULL_EXPORT_ARCHIVE_PROFILE;
}
