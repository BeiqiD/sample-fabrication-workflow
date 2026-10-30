import type { StagedAuthorityCandidate } from "./authority-candidates";
import type { VerifiedAuthorityPublication } from "./authority-publication";

export { hasRecoveryAssetAliasEvidence, qualifiedRecoveryLegacyAssetAliasSql } from "./recovery-asset-alias-sql";

/** A native alias is an exact File placement receipt. Its R2 locator is NULL. */
export function nativeAssetAliasPredicate(alias = "a"): string {
  return `${alias}.r2_key IS NULL AND ${alias}.file_id=? AND ${alias}.storage_profile_id=?
    AND ${alias}.storage_profile_revision=? AND ${alias}.object_key=? AND ${alias}.status='ready'
    AND ${alias}.byte_size=? AND ${alias}.sha256=?`;
}
export function nativeAssetAliasBindings(candidate: StagedAuthorityCandidate, result: VerifiedAuthorityPublication["result"]) {
  return [result.fileId, candidate.profile.profileId, candidate.profile.configurationRevision, result.objectKey,
    candidate.expectedBytes.byteSize, candidate.expectedBytes.sha256];
}

/** Place after verified publication statements in the same business batch.
 * Reuse requires the exact published File/profile/key; equal hash alone is insufficient. */
export function nativeAssetAliasInsert(db: D1Database, input: {
  assetId: string; importId?: string; originalName: string; mimeType: string; actorEmail: string; createdAt: string;
  candidate: StagedAuthorityCandidate; result: VerifiedAuthorityPublication["result"];
}): D1PreparedStatement {
  const { candidate, result } = input;
  return db.prepare(`INSERT INTO assets(id,import_id,r2_key,file_id,storage_profile_id,storage_profile_revision,object_key,
    original_name,mime_type,byte_size,status,sha256,actor_email,created_at)
    SELECT ?,?,NULL,?,?,?,?,?,?,?,'ready',?,?,? WHERE NOT EXISTS(
      SELECT 1 FROM assets a WHERE ${nativeAssetAliasPredicate()})`)
    .bind(input.assetId, input.importId ?? null, result.fileId, candidate.profile.profileId, candidate.profile.configurationRevision,
      result.objectKey, input.originalName, input.mimeType, candidate.expectedBytes.byteSize, candidate.expectedBytes.sha256,
      input.actorEmail, input.createdAt, ...nativeAssetAliasBindings(candidate, result));
}
