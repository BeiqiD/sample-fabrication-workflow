import type { FileAuthorityMode } from "../files/authority-mode";
import type { ReadSqlCell, ReadSqlDatabase, ReadSqlStatement } from "../runtime/read-sql";

export interface SampleSplitStatement extends ReadSqlStatement {
  bind(...values: ReadSqlCell[]): SampleSplitStatement;
}
export interface SampleSplitResult {
  /** Exact original D1 meta.changes / native trigger-inclusive acknowledgement. */
  meta: { changes: number };
}
export interface SampleSplitDatabase extends ReadSqlDatabase {
  prepare(sql: string): SampleSplitStatement;
  batch(statements: readonly SampleSplitStatement[]): Promise<SampleSplitResult[]>;
}
export interface SplitInheritedStateCapabilities {
  database(): SampleSplitDatabase;
  authorityDatabase(): ReadSqlDatabase;
  fileAuthorityMode(): Promise<FileAuthorityMode>;
  resolveConsumerFileId(input: Readonly<{ assetId: string; purpose: "embedded_content" }>): Promise<string | null>;
  consumerFileBindingFence(input: Readonly<{ assetId: string; purpose: "embedded_content" }>, fileId: string | null): SampleSplitStatement;
}
export interface SampleSplitCapabilities extends SplitInheritedStateCapabilities {
  admit(actor: string): Promise<void>;
  now(): number;
  randomId(): string;
  /** Optional owner coupling keeps the complete original statements/results in
   * order; child resource/manager rows must join that same transaction. */
  commitSplit?(source: Readonly<{ parentId: string; childIds: readonly string[]; actor: string; createdAt: string }>,
    statements: readonly SampleSplitStatement[]): Promise<SampleSplitResult[]>;
}
