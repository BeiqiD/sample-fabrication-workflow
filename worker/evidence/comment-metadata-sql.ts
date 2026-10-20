import type { FileBusinessMetadataDatabase, FileBusinessMetadataStatement } from "../files/business-metadata-sql";

/** Trusted original Comment queries only. This structural port conveys no
 * collaboration/library/resource/File or Request rights. Future native adapters
 * must own genuine statements, validate exact scalar rows and guard all affected
 * roots in the same BEGIN, keeping actual RETURNING rows separate from changes. */
export interface CommentMetadataStatement<Statement> extends FileBusinessMetadataStatement<Statement> {
  bind(...values: unknown[]): Statement;
  all<Row = Record<string, unknown>>(): Promise<{ results: Row[] }>;
}
export interface CommentMetadataDatabase<Statement extends CommentMetadataStatement<Statement>> extends FileBusinessMetadataDatabase<Statement> {
  atomicBatch(items: Statement[]): Promise<{
    results: Record<string, unknown>[];
    meta: { changes: number | bigint };
  }[]>;
}
