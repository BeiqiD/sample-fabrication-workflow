import type { FileBusinessMetadataDatabase, FileBusinessMetadataStatement } from "../files/business-metadata-sql";

/** Trusted original Execution queries only. A future native adapter must use
 * genuine owned statements, validate exact scalars and preserve actual batch
 * result ordinals/trigger-sensitive changes with issued same-BEGIN current
 * Request/session/installation/resource/File guards. This shape grants no rights. */
export interface ExecutionFileMetadataStatement<Statement> extends FileBusinessMetadataStatement<Statement> {
  bind(...values: unknown[]): Statement;
  all<Row = Record<string, unknown>>(): Promise<{ results: Row[] }>;
}
export interface ExecutionFileMetadataDatabase<Statement extends ExecutionFileMetadataStatement<Statement>> extends FileBusinessMetadataDatabase<Statement> {
  primary(): ExecutionFileMetadataDatabase<Statement>;
  atomicBatch(items: Statement[]): Promise<{ meta: { changes: number | bigint } }[]>;
}
