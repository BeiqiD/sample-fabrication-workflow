import { primaryD1 } from "../d1-primary";
import { stageAuthorityCandidate } from "../files/authority-candidates";
import { writeAuthorityCandidate } from "../files/authority-publication";
import type { Env } from "../types";
import { nativeAssetAliasBindings, nativeAssetAliasInsert, nativeAssetAliasPredicate } from "../files/native-asset-alias";

export interface ImportFileInput {
  kind: "workbook" | "manifest" | "image";
  localId: string;
  originalName: string;
  mimeType: string;
  buffer: ArrayBuffer;
  sha256: string;
}

/** Called only by the executor that created the accepted import. The returned
 * publications and aliases belong in the same batch as the import's ready
 * result and typed business bindings. Failed uploads retain their candidates;
 * request replay never calls this function or repeats a PUT. */
export async function prepareAuthorityImportFiles<T extends ImportFileInput>(
  env: Env, owner: { importId: string; operationId: string; actorEmail: string }, inputs: T[],
) {
  const db = primaryD1(env.DB);
  const statements: D1PreparedStatement[] = [];
  const assets: Array<T & { assetId: string; key: string; legacyKey: string | null; isNew: boolean; fileId: string }> = [];
  const aliases = new Map<string, { assetId: string; isNew: boolean }>();
  const receipt = await db.prepare("SELECT * FROM imports WHERE id=? AND operation_id=? AND actor_email=?")
    .bind(owner.importId, owner.operationId, owner.actorEmail).first<{ file_targets_protocol?: number | null }>();
  const perFileTargets = receipt?.file_targets_protocol === 1;
  for (const input of inputs) {
    const identity = { kind: "import_file" as const, acceptanceId: owner.importId,
      operationId: owner.operationId, actorEmail: owner.actorEmail,
      itemId: input.kind === "image" ? `image:${input.localId}` : input.kind };
    const candidate = await stageAuthorityCandidate(db, identity);
    const publication = await writeAuthorityCandidate(env, identity, candidate, {
      body: input.buffer, contentType: input.mimeType, filename: input.originalName,
    });
    statements.push(...publication.statements);
    const { objectKey: key, fileId } = publication.result;
    const native = Boolean(await db.prepare("SELECT 1 FROM storage_profiles WHERE id=? AND adapter_type='s3'")
      .bind(candidate.profile.profileId).first());
    const aliasKey = JSON.stringify([candidate.profile.profileId, key, fileId]);
    let alias = aliases.get(aliasKey);
    if (!alias) {
      const existing = native ? await db.prepare(`SELECT a.id FROM assets a LEFT JOIN imports i ON i.id=a.import_id
        WHERE ${nativeAssetAliasPredicate()} AND (a.import_id IS NULL OR i.status='ready')`)
        .bind(...nativeAssetAliasBindings(candidate, publication.result)).first<{ id: string }>()
        : await db.prepare(`SELECT a.id FROM assets a LEFT JOIN imports i ON i.id=a.import_id
        WHERE a.r2_key=? AND a.sha256=? AND a.byte_size=? AND a.status='ready'
          AND (a.import_id IS NULL OR i.status='ready')
          AND NOT EXISTS(SELECT 1 FROM blob_integrity_quarantine q WHERE q.store_kind='r2' AND q.provider='r2' AND q.object_key=a.r2_key)
          AND NOT EXISTS(SELECT 1 FROM blob_gc_ledger g WHERE g.store_kind='r2' AND g.provider='r2' AND g.object_key=a.r2_key AND g.state IN('deleting','deleted'))`)
        .bind(key, input.sha256, input.buffer.byteLength).first<{ id: string }>();
      const frozen = perFileTargets ? await db.prepare("SELECT candidate_asset_id FROM import_file_acceptances WHERE import_id=? AND item_id=?")
        .bind(owner.importId, identity.itemId).first<{ candidate_asset_id: string }>() : null;
      alias = { assetId: existing?.id ?? frozen?.candidate_asset_id ?? crypto.randomUUID(), isNew: !existing };
      aliases.set(aliasKey, alias);
      if (!existing) statements.push(native ? nativeAssetAliasInsert(db, { assetId: alias.assetId, importId: owner.importId,
        originalName: input.originalName, mimeType: input.mimeType, actorEmail: owner.actorEmail,
        createdAt: new Date().toISOString(), candidate, result: publication.result }) : db.prepare(`INSERT INTO assets
        (id,import_id,r2_key,original_name,mime_type,byte_size,status,actor_email,created_at,sha256)
        VALUES(?,?,?,?,?,?,'pending',?,?,?)`)
        .bind(alias.assetId, owner.importId, key, input.originalName, input.mimeType,
          input.buffer.byteLength, owner.actorEmail, new Date().toISOString(), input.sha256));
    }
    if (perFileTargets) statements.push(db.prepare(`UPDATE import_file_acceptances SET status='ready',result_file_id=?,result_location_id=?,completed_at=?
      WHERE import_id=? AND item_id=? AND status='pending'
        AND EXISTS(SELECT 1 FROM imports WHERE id=? AND file_targets_protocol=1 AND operation_id=? AND status='pending')`)
      .bind(fileId, publication.result.locationId, new Date().toISOString(), owner.importId, identity.itemId, owner.importId, owner.operationId));
    assets.push({ ...input, ...alias, key, legacyKey: native ? null : key, fileId });
  }
  return { assets, statements };
}
