import { primaryD1 } from "../d1-primary";
import { stageAuthorityCandidate } from "../files/authority-candidates";
import { writeAuthorityCandidate } from "../files/authority-publication";
import type { Env } from "../types";

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
  const assets: Array<T & { assetId: string; key: string; isNew: boolean; fileId: string }> = [];
  const aliases = new Map<string, { assetId: string; isNew: boolean }>();
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
    let alias = aliases.get(key);
    if (!alias) {
      const existing = await db.prepare(`SELECT a.id FROM assets a LEFT JOIN imports i ON i.id=a.import_id
        WHERE a.r2_key=? AND a.sha256=? AND a.byte_size=? AND a.status='ready'
          AND (a.import_id IS NULL OR i.status='ready')
          AND NOT EXISTS(SELECT 1 FROM blob_integrity_quarantine q WHERE q.store_kind='r2' AND q.provider='r2' AND q.object_key=a.r2_key)
          AND NOT EXISTS(SELECT 1 FROM blob_gc_ledger g WHERE g.store_kind='r2' AND g.provider='r2' AND g.object_key=a.r2_key AND g.state IN('deleting','deleted'))`)
        .bind(key, input.sha256, input.buffer.byteLength).first<{ id: string }>();
      alias = { assetId: existing?.id ?? crypto.randomUUID(), isNew: !existing };
      aliases.set(key, alias);
      if (!existing) statements.push(db.prepare(`INSERT INTO assets
        (id,import_id,r2_key,original_name,mime_type,byte_size,status,actor_email,created_at,sha256)
        VALUES(?,?,?,?,?,?,'pending',?,?,?)`)
        .bind(alias.assetId, owner.importId, key, input.originalName, input.mimeType,
          input.buffer.byteLength, owner.actorEmail, new Date().toISOString(), input.sha256));
    }
    assets.push({ ...input, ...alias, key, fileId });
  }
  return { assets, statements };
}
