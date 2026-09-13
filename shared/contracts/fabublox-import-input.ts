/** Metadata for the exact normalized bytes accepted by a FabuBlox import.
 * The manifest digest binds the title, family selection and full parsed graph.
 * No workbook/image bytes or deployment credentials belong in this snapshot. */
export interface FabubloxImportInputFile {
  sha256: string;
  byteSize: number;
  mimeType: string;
  originalName: string;
  purpose: "provenance" | "embedded_content";
}

export interface FabubloxImportInput {
  schema: "fabublox-import-request/1";
  workbook: FabubloxImportInputFile & { purpose: "provenance" };
  manifest: FabubloxImportInputFile & { purpose: "provenance" };
  images: Array<FabubloxImportInputFile & { localId: string; purpose: "embedded_content" }>;
}
