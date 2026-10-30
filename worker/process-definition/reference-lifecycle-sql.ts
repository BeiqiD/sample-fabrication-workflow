import type { FileBusinessMetadataDatabase, FileBusinessMetadataStatement } from "../files/business-metadata-sql";
export interface TemplateReferenceLifecycleResult {
  /** Exact mature D1 meta.changes semantics; consumed only as nonzero ACK. */
  changes: number;
}
export interface TemplateReferenceLifecycleDatabase<Statement extends FileBusinessMetadataStatement<Statement>> extends FileBusinessMetadataDatabase<Statement> {
  mutation(statement: Statement): Promise<TemplateReferenceLifecycleResult>;
  atomicBatch(statements: readonly Statement[]): Promise<TemplateReferenceLifecycleResult[]>;
}
