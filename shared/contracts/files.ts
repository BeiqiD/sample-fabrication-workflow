/** FP1 overlap observations. These are not published files or retention roots. */
export type FilePurpose = "research_source" | "embedded_content" | "derived_preview" | "provenance" | "job_output";
export type LegacyFileStoreKind = "r2" | "managed";
export type LegacyFileProvider = "r2" | "switchdrive";
export type LegacyFileClassification = "classified" | "ambiguous" | "unclassified";

export interface LegacyFileLocator {
  storeKind: LegacyFileStoreKind;
  provider: LegacyFileProvider;
  objectKey: string;
}

/** Supplied by a trusted operator after establishing the actual physical namespace.
 * Never infer this identity from a binding label, defaults, or provider credentials.
 */
export interface LegacyStorageProfile {
  id: string;
  adapterType: LegacyFileProvider;
  namespaceIdentity: string;
  configurationSource: "bootstrap" | "environment";
  credentialReference: "environment:SWITCHDRIVE" | null;
  configurationRevision: 1;
}

export interface LegacyFileObservationReport extends LegacyFileLocator {
  fileId: string;
  locationId: string;
  classification: LegacyFileClassification;
  purpose: FilePurpose | null;
  issues: string[];
}
