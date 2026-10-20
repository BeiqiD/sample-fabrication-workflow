import type { FileAuthoritySqlDatabase, FileAuthoritySqlStatement } from "../runtime/file-authority-sql";
import type { StagedAuthorityCandidate } from "../files/authority-candidates-core";
import type { VerifiedAuthorityPublication } from "../files/authority-publication-core";
import { nativeAssetAliasBindings, nativeAssetAliasPredicate, prepareNativeAssetAliasInsert } from "../files/native-asset-alias-core";

/** Only prepares the mature ordinary accepted upload's final alias/receipt
 * statements. The genuine caller must supply its verified unpublished File
 * statements and current provider/principal fences in the SAME native batch.
 * `aliasKind` chooses a public result shape; it does not admit a provider,
 * authorize I/O, allocate an executor, or make the receipt ready by itself. */
export function prepareActiveFileUploadReceiptStatements(database: FileAuthoritySqlDatabase,
  row: Readonly<{ id: string; operation_id: string; candidate_asset_id: string; actor_email: string }>,
  candidate: StagedAuthorityCandidate, result: VerifiedAuthorityPublication["result"],
  input: Readonly<{ originalName: string; mimeType: string; completedAt: string; aliasKind: "r2" | "native" }>,
): FileAuthoritySqlStatement[] {
  const native = input.aliasKind === "native", completedAt = input.completedAt;
  return [
    native ? prepareNativeAssetAliasInsert<FileAuthoritySqlStatement>(database, { assetId: row.candidate_asset_id,
      originalName: input.originalName, mimeType: input.mimeType, actorEmail: row.actor_email, createdAt: completedAt, candidate, result })
      : database.prepare(`INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,actor_email,created_at)
          SELECT ?,?,?,?,?,'ready',?,?,? WHERE NOT EXISTS(SELECT 1 FROM assets WHERE r2_key=?)`)
        .bind(row.candidate_asset_id, result.objectKey, input.originalName, input.mimeType,
          candidate.expectedBytes.byteSize, candidate.expectedBytes.sha256, row.actor_email, completedAt, result.objectKey),
    native ? database.prepare(`UPDATE r2_upload_requests SET status='ready',completed_at=?,accepted_result_json=(
          SELECT json_object('id',a.id,'key',NULL,'storageKind','native','fileId',a.file_id,'url','/api/file-assets/'||a.id,
            'deduplicated',json(CASE WHEN a.id<>? OR ?<>? THEN 'true' ELSE 'false' END))
          FROM assets a WHERE ${nativeAssetAliasPredicate()}
        ) WHERE id=? AND operation_id=? AND status='pending' AND expires_at>?`)
      .bind(completedAt, row.candidate_asset_id, result.fileId, candidate.fileId,
        ...nativeAssetAliasBindings(candidate, result), row.id, row.operation_id, completedAt)
      : database.prepare(`UPDATE r2_upload_requests SET status='ready',completed_at=?,accepted_result_json=(
          SELECT json_object('id',a.id,'key',a.r2_key,'deduplicated',json(CASE WHEN a.id<>? OR ?<>? THEN 'true' ELSE 'false' END))
          FROM assets a WHERE a.r2_key=? AND a.status='ready' AND a.byte_size=? AND a.sha256=?
        ) WHERE id=? AND operation_id=? AND status='pending' AND expires_at>?`)
        .bind(completedAt, row.candidate_asset_id, result.fileId, candidate.fileId,
          result.objectKey, candidate.expectedBytes.byteSize, candidate.expectedBytes.sha256, row.id, row.operation_id, completedAt),
    database.prepare(`SELECT CASE WHEN changes()=1 AND EXISTS(SELECT 1 FROM r2_upload_requests
          WHERE id=? AND operation_id=? AND status='ready') THEN 1 ELSE json('Accepted File upload did not publish') END`)
      .bind(row.id, row.operation_id),
  ];
}
