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
  prepare(sql: string): Statement;
  /** Preserve the original independent fresh-primary selection. */
  primary(): FileBusinessMetadataDatabase<Statement>;
  authorityMode(): Promise<FileAuthorityMode>;
}
