import type { ReadSqlCell } from "../runtime/read-sql";
import type { FileAuthorityMode } from "./authority-mode";

/** Trusted code-owned metadata queries only. This structural port does not
 * grant File/resource authority or physical read-only access. A native adapter
 * must own genuine statements and same-BEGIN session/resource admission. */
export interface FileBusinessMetadataStatement<Statement> {
  bind(...values: ReadSqlCell[]): Statement;
  first<Row = Record<string, unknown>>(): Promise<Row | null>;
}
export interface FileBusinessMetadataDatabase<Statement extends FileBusinessMetadataStatement<Statement>> {
  /** A closed code-owned metadata selector, never a Request/File grant.
   * Omission preserves the original Worker S3 native-alias query. Only an
   * independently issued physical local Request adapter selects local. */
  readonly nativeAssetAdapter?: "s3" | "local";
  /** Local metadata selection is restricted to these two genuinely captured
   * physical role profiles. This remains metadata, never a grant or raw port. */
  readonly nativeAssetProfileIds?: readonly [string, string];
  prepare(sql: string): Statement;
  /** Preserve the original independent fresh-primary selection. */
  primary(): FileBusinessMetadataDatabase<Statement>;
  authorityMode(): Promise<FileAuthorityMode>;
}
