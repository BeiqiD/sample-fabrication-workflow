import type { FileBusinessMetadataDatabase, FileBusinessMetadataStatement } from "../files/business-metadata-sql";
import type { ReadSqlRow } from "../runtime/read-sql";
import type { ProjectWorkspaceDatabase, ProjectWorkspaceStatement } from "./workspace-sql";
export interface ProjectAttachmentStatement extends FileBusinessMetadataStatement<ProjectAttachmentStatement> {
  /** Preserve original D1 input shape; real adapters validate each actual cell. */
  bind(...values: unknown[]): ProjectAttachmentStatement;
  first<Row = ReadSqlRow>(): Promise<Row | null>;
  run(): Promise<{ changes: number }>;
}
export interface ProjectAttachmentResult { results: ReadSqlRow[]; meta: { changes: number } }
/** Trusted metadata only. This port issues no File/resource authority, installed
 * Request/session grant, provider adapter, or structural native capability. */
export interface ProjectAttachmentDatabase extends FileBusinessMetadataDatabase<ProjectAttachmentStatement>, ProjectWorkspaceDatabase {
  prepare(sql: string): ProjectAttachmentStatement;
  primary(): ProjectAttachmentDatabase;
  readBatch(statements: readonly ProjectWorkspaceStatement[]): Promise<ProjectAttachmentResult[]>;
  atomicBatch(statements: readonly ProjectWorkspaceStatement[]): Promise<ProjectAttachmentResult[]>;
}
