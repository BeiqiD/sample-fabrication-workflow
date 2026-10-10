import type { FilePurpose } from "../../shared/contracts/files";
import type { ResearchRecordKind } from "../../shared/contracts/research-package-catalog";
import type { ImportDomainIdentity } from "./import-domain-identity";
import type { ResearchPackagePreview, ResearchRoot } from "../../shared/contracts/research-package-api";

export interface ImportDomainFileTarget {
  packageFileId: string; destinationFileId: string; assetId: string; profileId: string;
  profileRevision: number; namespaceIdentity: string; purpose: FilePurpose;
  sha256: string; byteSize: number; scope: "system"; locationId?: string;
  originalName?: string | null; mimeType?: string | null; aliasCreatedAt?: string;
}
export interface ImportDomainFileReuse { packageFileId: string; fileId: string; locationId: string; assetId: string }
export interface ImportDestinationColumn { name: string; notNull: boolean; defaultValue: string | null }
export interface ImportDestinationDefinition {
  kind: "state" | "stepDefinition"; hash: string; data: Record<string, unknown>;
}
export interface ImportDestinationStateMedia {
  stateHash: string; position: number; assetId: string; fileId: string | null; locationId: string | null;
  purpose: FilePurpose | null; scope: string | null; profileId: string | null;
  profileRevision: number | null; namespaceIdentity: string | null; sha256: string | null; byteSize: number | null;
}
export interface ImportDestinationSnapshot {
  columns: Record<string, ImportDestinationColumn[]>;
  names: { sample: string[]; recipeFamily: Array<{ name: string; type: string }>;
    recipeRevision: Array<{ name: string; type: string; version: number }>; project: string[] };
  definitions: ImportDestinationDefinition[]; stateMedia: ImportDestinationStateMedia[];
}
export interface ImportDomainRow {
  kind: ResearchRecordKind; sourceId: string; table: string; id: string; data: Record<string, unknown>;
}
export interface ImportDomainNaming {
  kind: "sample" | "recipeFamily" | "recipeRevision" | "project";
  sourceId: string; field: string; original: string; destination: string;
}
export interface ImportDomainCanonicalFence {
  kind: "state" | "stepDefinition"; hash: string; data: Record<string, unknown>;
  existing: boolean; media: Array<{ assetId: string; position: number }>;
}
export interface FrozenImportDomainPlan {
  schema: "research-domain-import/1"; packageId: string; acceptedAt: string;
  rows: ImportDomainRow[]; identities: ImportDomainIdentity[]; naming: ImportDomainNaming[];
  roots: ResearchRoot[]; namingPreview: NonNullable<ResearchPackagePreview["naming"]>;
  canonicalFences: ImportDomainCanonicalFence[]; fileReuses: ImportDomainFileReuse[];
  files: ImportDomainFileTarget[]; publicationStatements: number;
}
export interface ImportDomainPlanBudget {
  supported: boolean; estimatedBytes: number | null; maximumBytes: number; reason: string | null;
}
