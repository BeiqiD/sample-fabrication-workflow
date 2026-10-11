import type { FileBusinessMetadataDatabase, FileBusinessMetadataStatement } from "../files/business-metadata-sql";

/** Only trusted original Sample metadata algorithms prepare this structural
 * port. It grants no Request/resource/File/provider or administrator rights.
 * A future native composer must validate each exact business scalar, retain
 * actual statements and surround original batches with issued same-BEGIN
 * current identity, installation and explicit Sample/File operation guards. */
export interface SampleFileMetadataStatement<Statement> extends FileBusinessMetadataStatement<Statement> {
  bind(...values: unknown[]): Statement;
  all<Row = Record<string, unknown>>(): Promise<{ results: Row[] }>;
}
export interface SampleFileMetadataDatabase<Statement extends SampleFileMetadataStatement<Statement>> extends FileBusinessMetadataDatabase<Statement> {
  atomicBatch(items: Statement[]): Promise<{ meta: { changes: number | bigint } }[]>;
}
