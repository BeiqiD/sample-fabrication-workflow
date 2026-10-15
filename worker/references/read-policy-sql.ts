import type { ReferenceTarget, ReferenceTargetType } from "../../shared/reference-types";
import type { ReadSqlDatabase, ReadSqlStatement } from "../runtime/read-sql";

/** Optional genuine owner hooks for code-owned candidate statements. These
 * structural interfaces issue no permission. Ordinary Worker databases keep
 * the complete original SELECT, bindings, ranking, overflow and limit logic. */
export interface ReferenceCandidateReadDatabase extends ReadSqlDatabase {
  referenceSearchStatement?(type: ReferenceTargetType, idSql: string, sql: string): ReadSqlStatement;
  referenceChildrenStatement?(parent: ReferenceTarget, sql: string): ReadSqlStatement;
}

export function referenceChildrenStatement(db: ReadSqlDatabase, parent: ReferenceTarget, sql: string): ReadSqlStatement {
  const owned = db as ReferenceCandidateReadDatabase;
  return owned.referenceChildrenStatement?.(parent, sql) ?? db.prepare(sql);
}
