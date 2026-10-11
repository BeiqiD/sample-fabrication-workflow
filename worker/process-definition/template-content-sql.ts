import type { FileBusinessMetadataDatabase, FileBusinessMetadataStatement } from "../files/business-metadata-sql";

/** Code-owned mature template metadata queries only; this structural port issues
 * no Request, resource, File, provider or administrator authority. */
export interface TemplateContentStatement<Statement> extends FileBusinessMetadataStatement<Statement> {
  bind(...values: unknown[]): Statement;
  all<Row = Record<string, unknown>>(): Promise<{ results: Row[] }>;
}
export interface TemplateContentDatabase<Statement extends TemplateContentStatement<Statement>> extends FileBusinessMetadataDatabase<Statement> {
  atomicBatch(items: Statement[]): Promise<{ meta: { changes: number | bigint } }[]>;
}
