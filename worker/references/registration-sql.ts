import type { ReferenceContext, ReferenceTarget } from "../../shared/reference-types";
import type { ReadSqlCell } from "../runtime/read-sql";
/** Original two registration writes, shared by genuine Worker and Node ports. */
export const REFERENCE_REGISTRATION_INSERT_SQL = `
      INSERT OR IGNORE INTO reference_targets
        (id, registry_version, target_type, target_id,
         first_registered_at, last_validated_at, last_known_contexts_json)
      VALUES (?, 1, ?, ?, ?, ?, ?)
    `;
export const REFERENCE_REGISTRATION_UPDATE_SQL = `
      UPDATE reference_targets
      SET last_validated_at = ?, last_known_contexts_json = ?
      WHERE target_type = ? AND target_id = ? AND tombstoned_at IS NULL
        AND last_validated_at <= ?
    `;
export function referenceRegistrationStatementsWithDatabase<Statement>(
  db: { prepare(sql: string): { bind(...values: ReadSqlCell[]): Statement } }, target: ReferenceTarget,
  contexts: readonly ReferenceContext[], now: string, registryId: string,
): Statement[] {
  const contextsJson = JSON.stringify(contexts);
  return [
    db.prepare(REFERENCE_REGISTRATION_INSERT_SQL).bind(registryId, target.type, target.id, now, now, contextsJson),
    db.prepare(REFERENCE_REGISTRATION_UPDATE_SQL).bind(now, contextsJson, target.type, target.id, now),
  ];
}
