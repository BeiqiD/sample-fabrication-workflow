// The complete original Sample record algorithm, selected from the reviewed
// neutral donor. This library port grants no Request or resource/File rights.
import { HTTPException } from "hono/http-exception";
import { isSampleRecordEvent } from "../../shared/sample-records";
import { isSampleStatus, type CreateRecordInput, type SampleStatus } from "../../shared/types";
import { fileAuthorityActiveSqlWithDatabase, deletedEventAssetSqlWithDatabase, deletedEventMetadataSqlWithDatabase } from "../files/business-lifecycle-service";
import { consumerFileBindingFenceWithDatabase, resolveConsumerFileIdWithDatabase } from "../files/consumer-binding-service";
import type { SampleFileMetadataDatabase, SampleFileMetadataStatement } from "./file-metadata-sql";

export async function createSampleRecordWithDatabase<Statement extends SampleFileMetadataStatement<Statement>>(db: SampleFileMetadataDatabase<Statement>, sampleId: string, input: CreateRecordInput, userEmail: string) {
  if (typeof input.expectedUpdatedAt !== "string" || typeof input.location !== "string" || typeof input.pinned !== "boolean" || !isSampleStatus(input.status)
    || (input.body !== undefined && typeof input.body !== "string") || (input.assetKey !== undefined && typeof input.assetKey !== "string")
    || (input.thumbnailKey !== undefined && typeof input.thumbnailKey !== "string")
    || (input.assetId !== undefined && (typeof input.assetId !== "string" || !input.assetId || input.assetId.length > 256 || input.assetId.includes("\0")))
    || (input.thumbnailAssetId !== undefined && (typeof input.thumbnailAssetId !== "string" || !input.thumbnailAssetId || input.thumbnailAssetId.length > 256 || input.thumbnailAssetId.includes("\0")))
    || (input.assetKey !== undefined && input.assetId !== undefined) || (input.thumbnailKey !== undefined && input.thumbnailAssetId !== undefined)) {
    throw new HTTPException(400, { message: "A valid sample state and expectedUpdatedAt are required" });
  }
  const body = input.body?.trim() || null;
  if ((input.body?.length ?? 0) > 10_000 || input.location.length > 500) {
    throw new HTTPException(400, { message: "Record text or location is too long" });
  }
  let assetKey = input.assetKey || null;
  let thumbnailKey = input.thumbnailKey || null;
  if ((thumbnailKey || input.thumbnailAssetId) && !assetKey && !input.assetId) throw new HTTPException(400, { message: "A thumbnail requires a primary asset" });
  const byId = async (assetId: string) => {
    const asset = await db.prepare(`SELECT a.id,a.r2_key FROM assets a WHERE a.id=? AND a.status='ready'
      AND (a.import_id IS NULL OR EXISTS(SELECT 1 FROM imports i WHERE i.id=a.import_id AND i.status='ready'))`)
      .bind(assetId).first<{ id: string; r2_key: string | null }>();
    if (!asset) throw new HTTPException(400, { message: "One or more uploaded assets are unavailable" });
    return asset;
  };
  const primaryAsset = input.assetId ? await byId(input.assetId) : null;
  const previewAsset = input.thumbnailAssetId ? await byId(input.thumbnailAssetId) : null;
  if (primaryAsset) assetKey = primaryAsset.r2_key;
  if (previewAsset) thumbnailKey = previewAsset.r2_key;
  const hasAsset = Boolean(assetKey || primaryAsset);
  const assetKeys = [assetKey, thumbnailKey].filter((key): key is string => Boolean(key));
  if (assetKeys.length) {
    const placeholders = assetKeys.map(() => "?").join(", ");
    const result = await db.prepare(
      `SELECT r2_key FROM assets a
       WHERE status = 'ready' AND r2_key IN (${placeholders})
         AND (
           a.import_id IS NULL
           OR EXISTS (
             SELECT 1 FROM imports i
             WHERE i.id = a.import_id AND i.status = 'ready'
           )
         )
         AND (${await fileAuthorityActiveSqlWithDatabase(db)} OR NOT EXISTS (
           SELECT 1 FROM blob_gc_ledger bg
           WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
             AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
         ))
         AND (${await fileAuthorityActiveSqlWithDatabase(db)} OR NOT EXISTS (
           SELECT 1 FROM blob_integrity_quarantine biq
           WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
             AND biq.object_key = a.r2_key
         ))`,
    ).bind(...assetKeys).all<{ r2_key: string }>();
    if (new Set(result.results.map((row) => row.r2_key)).size !== new Set(assetKeys).size) {
      throw new HTTPException(400, { message: "One or more uploaded assets are unavailable" });
    }
  }

  const primaryInput = primaryAsset ? { assetId: primaryAsset.id, nativeAsset: primaryAsset.r2_key === null, purpose: "embedded_content" as const }
    : assetKey ? { assetKey, purpose: "embedded_content" as const } : null;
  const fileId = primaryInput ? await resolveConsumerFileIdWithDatabase(db, primaryInput) : null;
  if (primaryAsset?.r2_key === null && !fileId) throw new HTTPException(409, { message: "Native images require active File authority" });
  const previewInput = previewAsset ? { assetId: previewAsset.id, nativeAsset: previewAsset.r2_key === null, purpose: "derived_preview" as const, sourceFileId: fileId }
    : thumbnailKey ? { assetKey: thumbnailKey, purpose: "derived_preview" as const, sourceFileId: fileId } : null;
  const previewFileId = previewInput ? await resolveConsumerFileIdWithDatabase(db, previewInput) : null;
  if (previewAsset?.r2_key === null && !previewFileId) throw new HTTPException(409, { message: "Native previews require active File authority" });
  const fences = [
    ...(primaryInput ? [consumerFileBindingFenceWithDatabase(db, primaryInput, fileId)] : []),
    ...(previewInput ? [consumerFileBindingFenceWithDatabase(db, previewInput, previewFileId)] : []),
  ];

  const current = await db.prepare(
    "SELECT status, location, pinned, updated_at FROM samples WHERE id = ? AND deleted_at IS NULL",
  ).bind(sampleId).first<{ status: SampleStatus; location: string | null; pinned: number; updated_at: string }>();
  if (!current) throw new HTTPException(404, { message: "Sample not found" });
  if (current.updated_at !== input.expectedUpdatedAt) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Review the current state and save again." });
  }
  const location = input.location.trim() || null;
  const detailsChanged = current.status !== input.status || current.location !== location || Boolean(current.pinned) !== input.pinned;
  if (!detailsChanged && !body && !hasAsset) throw new HTTPException(400, { message: "The record has no changes" });

  const mutationId = crypto.randomUUID();
  const now = new Date(Math.max(Date.now(), Date.parse(input.expectedUpdatedAt) + 1)).toISOString();
  const statements = [db.prepare(
    `UPDATE samples SET status = ?, location = ?, pinned = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
     WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
  ).bind(input.status, location, input.pinned ? 1 : 0, userEmail, mutationId, now, sampleId, input.expectedUpdatedAt)];
  if (body || hasAsset) statements.push(db.prepare(
    `INSERT INTO events (id, sample_id, kind, body, asset_key, asset_file_id, thumbnail_file_id, metadata_json, actor_email, created_at)
     SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ? FROM samples
     WHERE id = ? AND last_mutation_id = ? AND deleted_at IS NULL`,
  ).bind(
    crypto.randomUUID(), hasAsset ? "image" : "comment", body, assetKey, fileId, previewFileId,
    JSON.stringify({ action: "sample_record", ...(thumbnailKey ? { thumbnailKey } : {}),
      ...(primaryAsset?.r2_key === null ? { assetId: primaryAsset.id } : {}),
      ...(previewAsset?.r2_key === null ? { thumbnailAssetId: previewAsset.id } : {}) }), userEmail, now, sampleId, mutationId,
  ));
  const results = (await db.atomicBatch([...fences, ...statements])).slice(fences.length);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "This sample changed elsewhere. Review the current state and save again." });
  if (statements.length > 1 && !results[1].meta.changes) throw new Error("Atomic record event was not created");
  return { ok: true, updatedAt: now };
}

export async function sampleHasFileBindingsWithDatabase<Statement extends SampleFileMetadataStatement<Statement>>(db: SampleFileMetadataDatabase<Statement>): Promise<boolean> {
  // Retained pre-File databases do not have these columns. Inspect the actual
  // schema before preparing either query shape; partial upgrades fail closed.
  const schema = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sqlite_schema
       WHERE type = 'table' AND name = 'file_authority_control') AS authority_tables,
      (SELECT COUNT(*) FROM pragma_table_info('run_step_assets') WHERE name = 'file_id')
        + (SELECT COUNT(*) FROM pragma_table_info('state_representation_assets') WHERE name = 'file_id')
        + (SELECT COUNT(*) FROM pragma_table_info('run_step_comments') WHERE name = 'file_id')
        + (SELECT COUNT(*) FROM pragma_table_info('events') WHERE name IN ('asset_file_id', 'thumbnail_file_id')) AS file_columns
  `).first<{ authority_tables: number; file_columns: number }>();
  if (schema?.authority_tables === 0 && schema.file_columns === 0) return false;
  if (schema?.authority_tables === 1 && schema.file_columns === 5) return true;
  throw new HTTPException(503, { message: "Sample File metadata is unavailable" });
}

export async function removeSampleRecordWithDatabase<Statement extends SampleFileMetadataStatement<Statement>>(db: SampleFileMetadataDatabase<Statement>, sampleId: string, eventId: string, userEmail: string) {
  const hasFileBindings = await sampleHasFileBindingsWithDatabase(db);
  const event = await db.prepare(
    `SELECT id, kind, body, asset_key, ${hasFileBindings ? "asset_file_id" : "NULL"} AS asset_file_id,
            metadata_json FROM events WHERE id = ? AND sample_id = ?`,
  ).bind(eventId, sampleId).first<{ id: string; kind: string; body: string | null; asset_key: string | null; asset_file_id: string | null; metadata_json: string }>();
  if (!event) throw new HTTPException(404, { message: "Sample record not found" });
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(event.metadata_json || "{}") as Record<string, unknown>; }
  catch { throw new HTTPException(409, { message: "This record cannot be safely deleted" }); }
  if (!isSampleRecordEvent(event.kind, metadata)) throw new HTTPException(400, { message: "Execution history cannot be deleted as a sample comment" });

  const sample = await db.prepare(
    "SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL",
  ).bind(sampleId).first<{ updated_at: string }>();
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  const now = new Date(Math.max(Date.now(), Date.parse(sample.updated_at) + 1)).toISOString();
  const { thumbnailKey: _thumbnailKey, ...retainedMetadata } = metadata;
  const deletedSummary = event.body?.trim() || (event.asset_key || event.asset_file_id ? "Photo attachment" : "Empty record");
  const deletionOperationId = crypto.randomUUID();
  const results = await db.atomicBatch([
    db.prepare(
      `UPDATE events
       SET asset_key = ${await deletedEventAssetSqlWithDatabase(db)}, metadata_json = ${await deletedEventMetadataSqlWithDatabase(db)}
       WHERE id = ? AND sample_id = ?
         AND json_extract(metadata_json, '$.deletedAt') IS NULL
         AND EXISTS (
           SELECT 1 FROM samples s
           WHERE s.id = events.sample_id AND s.id = ?
             AND s.updated_at = ? AND s.deleted_at IS NULL
         )`,
    ).bind(
      JSON.stringify({
        ...retainedMetadata,
        deletedAt: now,
        deletedBy: userEmail,
        deletionOperationId,
        hadAsset: Boolean(event.asset_key || event.asset_file_id),
      }),
      eventId,
      sampleId,
      sampleId,
      sample.updated_at,
    ),
    db.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, source.sample_id, 'comment', ?, ?, ?, ?
       FROM events source
       JOIN samples s ON s.id = source.sample_id
       WHERE source.id = ? AND source.sample_id = ?
         AND json_extract(source.metadata_json, '$.deletionOperationId') = ?
         AND s.deleted_at IS NULL`,
    ).bind(
      crypto.randomUUID(),
      `Deleted sample record · ${deletedSummary}`,
      JSON.stringify({ action: "sample_record_deleted", originalEventId: eventId, hadAsset: Boolean(event.asset_key) }),
      userEmail,
      now,
      eventId,
      sampleId,
      deletionOperationId,
    ),
    db.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM events source
           WHERE source.id = ? AND source.sample_id = samples.id
             AND json_extract(source.metadata_json, '$.deletionOperationId') = ?
         )`,
    ).bind(userEmail, now, sampleId, eventId, deletionOperationId),
  ]);
  if (!results[0].meta.changes || !results[2].meta.changes) {
    throw new HTTPException(409, { message: "The sample record or its Sample changed before deletion" });
  }
  return { ok: true, updatedAt: now };
}
