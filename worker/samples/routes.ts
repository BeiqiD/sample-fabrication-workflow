import { fileAuthorityActiveSql, deletedEventAssetSql, deletedVerificationAssetSql, deletedEventMetadataSql } from "../files/business-lifecycle";
import { consumerFileBindingFence, resolveConsumerFileId } from "../files/consumer-binding";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { isSampleStatus, MAX_SPLIT_PIECES, type CreateRecordInput, type SampleStatus, type SplitSampleInput } from "../../shared/types";
import { isSampleRecordEvent } from "../../shared/sample-records";
import { prepareSplitInheritedState } from "../sample-split-state";
import { sampleMetadataHandlers } from "./metadata-worker";
import { sampleReadHandlers } from "./read-worker";
import type { Env } from "../types";
import { loadCurrentSampleStructure } from "../application/sample-structure";
import { requireVisibleCommentOperationGroup } from "../evidence/comment-operation-group";

export const routes = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();

async function sampleHasFileBindings(db: D1Database): Promise<boolean> {
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

routes.get("/sample-directory-options", sampleReadHandlers.captureIngressRequest, sampleReadHandlers.directoryOptions);

routes.get("/samples", sampleReadHandlers.captureIngressRequest, sampleReadHandlers.directory);

routes.post("/samples", sampleMetadataHandlers.captureIngressRequest, sampleMetadataHandlers.create);

routes.post("/samples/:id/split", async (c) => {
  const parentId = c.req.param("id");
  const input = await c.req.json<SplitSampleInput>();
  if (!input || typeof input.expectedUpdatedAt !== "string"
    || (input.parentStatusAfter !== "active" && input.parentStatusAfter !== "consumed")
    || !Array.isArray(input.pieces) || input.pieces.length < 1 || input.pieces.length > MAX_SPLIT_PIECES) {
    throw new HTTPException(400, { message: `A split requires 1–${MAX_SPLIT_PIECES} valid pieces and a parent status` });
  }

  const pieces = input.pieces.map((piece) => {
    if (!piece || typeof piece !== "object" || typeof piece.code !== "string" || typeof piece.title !== "string"
      || typeof piece.location !== "string" || !isSampleStatus(piece.status)
      || (piece.description !== undefined && typeof piece.description !== "string")) {
      throw new HTTPException(400, { message: "Every split piece needs valid sample fields" });
    }
    const normalized = {
      code: piece.code.trim(),
      title: piece.title.trim(),
      description: piece.description?.trim() || null,
      location: piece.location.trim(),
      status: piece.status,
    };
    if (!normalized.code || !normalized.title || !normalized.location) {
      throw new HTTPException(400, { message: "Every split piece needs a code, sample name, and location" });
    }
    if (normalized.code.length > 100 || normalized.title.length > 200 || (normalized.description?.length ?? 0) > 10_000 || normalized.location.length > 500) {
      throw new HTTPException(400, { message: "One or more split-piece fields are too long" });
    }
    return normalized;
  });
  const normalizedCodes = pieces.map((piece) => piece.code.toLocaleLowerCase());
  if (new Set(normalizedCodes).size !== normalizedCodes.length) {
    throw new HTTPException(409, { message: "Every new piece must have a unique sample code" });
  }

  const [parent, parentStructure] = await Promise.all([
    c.env.DB.prepare(
      "SELECT code, updated_at FROM samples WHERE id = ? AND deleted_at IS NULL",
    ).bind(parentId).first<{ code: string; updated_at: string }>(),
    loadCurrentSampleStructure(c.env.DB, parentId),
  ]);
  if (!parent) throw new HTTPException(404, { message: "Parent sample not found" });
  if (parent.updated_at !== input.expectedUpdatedAt) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before splitting." });
  }

  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const children = pieces.map((piece) => ({ ...piece, id: crypto.randomUUID() }));
  const inherited = await prepareSplitInheritedState(c.env.DB, parentId, input.expectedUpdatedAt, parentStructure, now);
  const statements: D1PreparedStatement[] = [...inherited.statements];
  for (const child of children) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO samples
          (id, code, title, description, status, location, parent_id, inherited_state_hash,
           created_by, updated_by, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, id, ?, ?, ?, ?, ?
         FROM samples WHERE id = ? AND updated_at = ? AND deleted_at IS NULL
           AND ${inherited.guardSql}`,
      ).bind(child.id, child.code, child.title, child.description, child.status, child.location,
        inherited.stateHash, userEmail, userEmail, now, now, parentId, input.expectedUpdatedAt, ...inherited.guardBindings),
      c.env.DB.prepare(
        `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
         SELECT ?, id, 'created', ?, ?, ?, ? FROM samples
         WHERE id = ? AND parent_id = ? AND deleted_at IS NULL`,
      ).bind(
        crypto.randomUUID(), `Created by splitting parent ${parent.code}`,
        JSON.stringify({
          action: "created_by_split",
          parentId,
          parentCode: parent.code,
          inheritedStateHash: inherited.stateHash,
        }), userEmail, now, child.id, parentId,
      ),
    );
  }
  const childCodes = children.map((child) => child.code);
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, id, 'status', ?, ?, ?, ? FROM samples
       WHERE id = ? AND updated_at = ? AND deleted_at IS NULL
         AND ${inherited.guardSql}`,
    ).bind(
      crypto.randomUUID(), `Split into ${children.length} child samples: ${childCodes.join(", ")}`,
      JSON.stringify({ action: "sample_split", childIds: children.map((child) => child.id), childCodes, parentStatusAfter: input.parentStatusAfter }),
      userEmail, now, parentId, input.expectedUpdatedAt, ...inherited.guardBindings,
    ),
    c.env.DB.prepare(
      `UPDATE samples SET status = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND updated_at = ? AND deleted_at IS NULL
         AND ${inherited.guardSql}`,
    ).bind(input.parentStatusAfter, userEmail, mutationId, now, parentId, input.expectedUpdatedAt, ...inherited.guardBindings),
  );

  try {
    const results = await c.env.DB.batch(statements);
    if (!results.at(-1)?.meta.changes) {
      throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before splitting." });
    }
    if (results.slice(inherited.statements.length).some((result) => !result.meta.changes)) throw new Error("The complete split audit trail was not created");
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (String(error).includes("UNIQUE")) throw new HTTPException(409, { message: "One or more generated sample codes already exist" });
    throw error;
  }
  return c.json({ children: children.map(({ id, code }) => ({ id, code })), updatedAt: now }, 201);
});

routes.get("/samples/:id", sampleReadHandlers.captureIngressRequest, sampleReadHandlers.detail);

routes.patch("/samples/:id", sampleMetadataHandlers.captureIngressRequest, sampleMetadataHandlers.update);

routes.delete("/samples/:id", sampleMetadataHandlers.captureIngressRequest, sampleMetadataHandlers.remove);

routes.post("/samples/:id/restore", sampleMetadataHandlers.captureIngressRequest, sampleMetadataHandlers.restore);

routes.post("/samples/:id/records", async (c) => {
  const sampleId = c.req.param("id");
  const input = await c.req.json<CreateRecordInput>();
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
    const asset = await c.env.DB.prepare(`SELECT a.id,a.r2_key FROM assets a WHERE a.id=? AND a.status='ready'
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
    const result = await c.env.DB.prepare(
      `SELECT r2_key FROM assets a
       WHERE status = 'ready' AND r2_key IN (${placeholders})
         AND (
           a.import_id IS NULL
           OR EXISTS (
             SELECT 1 FROM imports i
             WHERE i.id = a.import_id AND i.status = 'ready'
           )
         )
         AND (${await fileAuthorityActiveSql(c.env.DB)} OR NOT EXISTS (
           SELECT 1 FROM blob_gc_ledger bg
           WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
             AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
         ))
         AND (${await fileAuthorityActiveSql(c.env.DB)} OR NOT EXISTS (
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
  const fileId = primaryInput ? await resolveConsumerFileId(c.env.DB, primaryInput) : null;
  if (primaryAsset?.r2_key === null && !fileId) throw new HTTPException(409, { message: "Native images require active File authority" });
  const previewInput = previewAsset ? { assetId: previewAsset.id, nativeAsset: previewAsset.r2_key === null, purpose: "derived_preview" as const, sourceFileId: fileId }
    : thumbnailKey ? { assetKey: thumbnailKey, purpose: "derived_preview" as const, sourceFileId: fileId } : null;
  const previewFileId = previewInput ? await resolveConsumerFileId(c.env.DB, previewInput) : null;
  if (previewAsset?.r2_key === null && !previewFileId) throw new HTTPException(409, { message: "Native previews require active File authority" });
  const fences = [
    ...(primaryInput ? [consumerFileBindingFence(c.env.DB, primaryInput, fileId)] : []),
    ...(previewInput ? [consumerFileBindingFence(c.env.DB, previewInput, previewFileId)] : []),
  ];

  const current = await c.env.DB.prepare(
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
  const userEmail = c.get("userEmail");
  const statements = [c.env.DB.prepare(
    `UPDATE samples SET status = ?, location = ?, pinned = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
     WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
  ).bind(input.status, location, input.pinned ? 1 : 0, userEmail, mutationId, now, sampleId, input.expectedUpdatedAt)];
  if (body || hasAsset) statements.push(c.env.DB.prepare(
    `INSERT INTO events (id, sample_id, kind, body, asset_key, asset_file_id, thumbnail_file_id, metadata_json, actor_email, created_at)
     SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ? FROM samples
     WHERE id = ? AND last_mutation_id = ? AND deleted_at IS NULL`,
  ).bind(
    crypto.randomUUID(), hasAsset ? "image" : "comment", body, assetKey, fileId, previewFileId,
    JSON.stringify({ action: "sample_record", ...(thumbnailKey ? { thumbnailKey } : {}),
      ...(primaryAsset?.r2_key === null ? { assetId: primaryAsset.id } : {}),
      ...(previewAsset?.r2_key === null ? { thumbnailAssetId: previewAsset.id } : {}) }), userEmail, now, sampleId, mutationId,
  ));
  const results = (await c.env.DB.batch([...fences, ...statements])).slice(fences.length);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "This sample changed elsewhere. Review the current state and save again." });
  if (statements.length > 1 && !results[1].meta.changes) throw new Error("Atomic record event was not created");
  return c.json({ ok: true, updatedAt: now }, 201);
});

routes.delete("/samples/:id/records/:eventId", async (c) => {
  const sampleId = c.req.param("id");
  const eventId = c.req.param("eventId");
  const hasFileBindings = await sampleHasFileBindings(c.env.DB);
  const event = await c.env.DB.prepare(
    `SELECT id, kind, body, asset_key, ${hasFileBindings ? "asset_file_id" : "NULL"} AS asset_file_id,
            metadata_json FROM events WHERE id = ? AND sample_id = ?`,
  ).bind(eventId, sampleId).first<{ id: string; kind: string; body: string | null; asset_key: string | null; asset_file_id: string | null; metadata_json: string }>();
  if (!event) throw new HTTPException(404, { message: "Sample record not found" });
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(event.metadata_json || "{}") as Record<string, unknown>; }
  catch { throw new HTTPException(409, { message: "This record cannot be safely deleted" }); }
  if (!isSampleRecordEvent(event.kind, metadata)) throw new HTTPException(400, { message: "Execution history cannot be deleted as a sample comment" });

  const sample = await c.env.DB.prepare(
    "SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL",
  ).bind(sampleId).first<{ updated_at: string }>();
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  const now = new Date(Math.max(Date.now(), Date.parse(sample.updated_at) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const { thumbnailKey: _thumbnailKey, ...retainedMetadata } = metadata;
  const deletedSummary = event.body?.trim() || (event.asset_key || event.asset_file_id ? "Photo attachment" : "Empty record");
  const deletionOperationId = crypto.randomUUID();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE events
       SET asset_key = ${await deletedEventAssetSql(c.env.DB)}, metadata_json = ${await deletedEventMetadataSql(c.env.DB)}
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
    c.env.DB.prepare(
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
    c.env.DB.prepare(
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
  return c.json({ ok: true, updatedAt: now });
});

routes.delete("/samples/:id/events/:eventId/asset", async (c) => {
  const sampleId = c.req.param("id");
  const eventId = c.req.param("eventId");
  const hasFileBindings = await sampleHasFileBindings(c.env.DB);
  const event = await c.env.DB.prepare(
    `SELECT id, kind, body, asset_key, ${hasFileBindings ? "asset_file_id" : "NULL"} AS asset_file_id,
            metadata_json FROM events WHERE id = ? AND sample_id = ?`,
  ).bind(eventId, sampleId).first<{ id: string; kind: string; body: string | null; asset_key: string | null; asset_file_id: string | null; metadata_json: string }>();
  if (!event) throw new HTTPException(404, { message: "Timeline entry not found" });
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(event.metadata_json || "{}") as Record<string, unknown>; }
  catch { throw new HTTPException(409, { message: "This image attachment cannot be safely deleted" }); }
  if (metadata.assetDeletedAt || metadata.deletedAt) throw new HTTPException(409, { message: "This image attachment was already deleted" });
  const nativeAssetId = !event.asset_key && event.asset_file_id && typeof metadata.assetId === "string" ? metadata.assetId : null;
  if (!event.asset_key && !nativeAssetId) throw new HTTPException(409, { message: "This image attachment was already deleted" });
  if (nativeAssetId && !await c.env.DB.prepare("SELECT 1 FROM assets WHERE id=? AND r2_key IS NULL AND file_id=?")
    .bind(nativeAssetId,event.asset_file_id).first()) throw new HTTPException(409, { message: "This image attachment no longer has its recorded File alias" });
  const assetLocator = nativeAssetId ?? event.asset_key;
  const assetColumn = nativeAssetId ? "id" : "r2_key";
  const eventColumn = nativeAssetId ? "json_extract(metadata_json,'$.assetId')" : "asset_key";

  const sourceAction = typeof metadata.action === "string" ? metadata.action : null;
  const operationGroupId = typeof metadata.operationGroupId === "string" ? metadata.operationGroupId : null;
  const verificationId = typeof metadata.verificationId === "string" ? metadata.verificationId : null;
  const stepId = typeof metadata.stepId === "string" ? metadata.stepId : null;
  const runId = typeof metadata.runId === "string" ? metadata.runId : null;
  const eventRunStepAssetId = typeof metadata.runStepAssetId === "string" ? metadata.runStepAssetId : null;
  if (runId) {
    const liveRun = await c.env.DB.prepare(
      "SELECT id FROM runs WHERE id = ? AND sample_id = ? AND deleted_at IS NULL",
    ).bind(runId, sampleId).first<{ id: string }>();
    if (!liveRun) throw new HTTPException(404, { message: "Active timeline source not found" });
  }
  let executionOccurrenceId: string | null = null;
  if (stepId && runId && event.kind === "image") {
    const occurrences = eventRunStepAssetId
      ? (await c.env.DB.prepare(
        `SELECT rsa.id
         FROM run_step_assets rsa
         JOIN assets a ON a.id = rsa.asset_id
         JOIN run_steps rs ON rs.id = rsa.run_step_id
         JOIN runs r ON r.id = rs.run_id
         JOIN samples s ON s.id = r.sample_id
         WHERE rsa.id = ? AND rsa.run_step_id = ? AND rsa.role = 'execution'
           AND a.${assetColumn} = ? AND rs.id = ? AND r.id = ? AND s.id = ?
           AND rsa.deleted_at IS NULL AND rs.deleted_at IS NULL
           AND r.deleted_at IS NULL AND s.deleted_at IS NULL`,
      ).bind(
        eventRunStepAssetId, stepId, assetLocator,
        stepId, runId, sampleId,
      ).all<{ id: string }>()).results
      : (await c.env.DB.prepare(
        `SELECT rsa.id
         FROM run_step_assets rsa
         JOIN assets a ON a.id = rsa.asset_id
         JOIN run_steps rs ON rs.id = rsa.run_step_id
         JOIN runs r ON r.id = rs.run_id
         JOIN samples s ON s.id = r.sample_id
         WHERE rsa.run_step_id = ? AND rsa.role = 'execution' AND a.${assetColumn} = ?
           AND rs.id = ? AND r.id = ? AND s.id = ?
           AND rsa.deleted_at IS NULL AND rs.deleted_at IS NULL
           AND r.deleted_at IS NULL AND s.deleted_at IS NULL`,
      ).bind(stepId, assetLocator, stepId, runId, sampleId).all<{ id: string }>()).results;
    if (occurrences.length !== 1) {
      throw new HTTPException(409, { message: "This execution image no longer identifies one attachment occurrence" });
    }
    executionOccurrenceId = occurrences[0].id;
  }
  const affectedEvents = operationGroupId && sourceAction === "step_comment"
    ? (await c.env.DB.prepare(
      `SELECT id, sample_id FROM events
       WHERE kind = 'step' AND json_valid(metadata_json)
         AND json_extract(metadata_json, '$.action') = 'step_comment'
         AND json_extract(metadata_json, '$.operationGroupId') = ?
         AND ${eventColumn} = ?
       ORDER BY id`,
    ).bind(operationGroupId, assetLocator).all<{ id: string; sample_id: string }>()).results
    : executionOccurrenceId && stepId && runId && event.kind === "image"
      ? (await c.env.DB.prepare(
        `SELECT id, sample_id
         FROM events
         WHERE sample_id = ? AND kind = 'image' AND ${eventColumn} = ? AND json_valid(metadata_json)
           AND (
             json_extract(metadata_json, '$.runStepAssetId') = ?
             OR (
               json_extract(metadata_json, '$.runStepAssetId') IS NULL
               AND json_extract(metadata_json, '$.runId') = ?
               AND json_extract(metadata_json, '$.stepId') = ?
             )
           )
         ORDER BY id`,
      ).bind(
        sampleId, assetLocator, executionOccurrenceId, runId, stepId,
      ).all<{ id: string; sample_id: string }>()).results
    : [{ id: eventId, sample_id: sampleId }];
  const affectedSampleIds = [...new Set(affectedEvents.map((row) => row.sample_id))];
  if (!affectedEvents.length) {
    throw new HTTPException(409, { message: "This image attachment was already deleted" });
  }
  if (operationGroupId && sourceAction === "step_comment") {
    await requireVisibleCommentOperationGroup(c.env.DB, operationGroupId);
  }
  const sampleRows = await c.env.DB.prepare(
    `SELECT id, updated_at FROM samples
     WHERE id IN (${affectedSampleIds.map(() => "?").join(", ")}) AND deleted_at IS NULL`,
  ).bind(...affectedSampleIds).all<{ id: string; updated_at: string }>();
  if (sampleRows.results.length !== affectedSampleIds.length) {
    throw new HTTPException(404, { message: "Sample not found" });
  }
  const latestUpdate = Math.max(...sampleRows.results.map((row) => Date.parse(row.updated_at)).filter(Number.isFinite));
  const now = new Date(Math.max(Date.now(), latestUpdate + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const deletionOperationId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];
  const affectedEventIds = affectedEvents.map((row) => row.id);
  const affectedEventPlaceholders = affectedEventIds.map(() => "?").join(", ");

  if (sourceAction === "step_comment" && operationGroupId) {
    statements.push(c.env.DB.prepare(
      `WITH valid_events AS MATERIALIZED (
         SELECT id FROM events
         WHERE id IN (${affectedEventPlaceholders})
           AND kind = 'step' AND ${eventColumn} = ? AND json_valid(metadata_json)
           AND json_extract(metadata_json, '$.action') = 'step_comment'
           AND json_extract(metadata_json, '$.operationGroupId') = ?
       ),
       valid_comments AS MATERIALIZED (
         SELECT rsc.id
         FROM run_step_comments rsc
         JOIN run_steps rs ON rs.id = rsc.run_step_id
         JOIN runs r ON r.id = rs.run_id
         JOIN samples s ON s.id = r.sample_id
         WHERE rsc.operation_group_id = ?
           AND rsc.asset_id = (SELECT id FROM assets WHERE ${assetColumn} = ?)
           AND rsc.deleted_at IS NULL AND rsc.asset_deleted_at IS NULL
           AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
           AND (
             rsc.submission_id IS NULL
             OR EXISTS (
               SELECT 1 FROM comment_submissions cs
               WHERE cs.id = rsc.submission_id
                 AND cs.status = 'ready' AND cs.deleted_at IS NULL
             )
           )
       )
       UPDATE events
       SET asset_key = ${await deletedEventAssetSql(c.env.DB)},
           metadata_json = json_set(
             metadata_json,
             '$.assetDeletedAt', ?,
             '$.assetDeletedBy', ?,
             '$.assetDeletionOperationId', ?
           )
       WHERE id IN (SELECT id FROM valid_events)
         AND (SELECT COUNT(*) FROM valid_events) = ?
         AND EXISTS (SELECT 1 FROM valid_comments)
         AND (
           SELECT COUNT(*) FROM valid_comments
         ) = (
           SELECT COUNT(*) FROM run_step_comments
           WHERE operation_group_id = ?
             AND asset_id = (SELECT id FROM assets WHERE ${assetColumn} = ?)
             AND deleted_at IS NULL AND asset_deleted_at IS NULL
         )
       RETURNING 1 AS affected`,
    ).bind(
      ...affectedEventIds,
      assetLocator,
      operationGroupId,
      operationGroupId,
      assetLocator,
      now,
      userEmail,
      deletionOperationId,
      affectedEventIds.length,
      operationGroupId,
      assetLocator,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE run_step_comments
       SET asset_deleted_at = ?, asset_deleted_by = ?,
           asset_deletion_operation_id = ?, last_mutation_id = ?
       WHERE operation_group_id = ?
         AND asset_id = (SELECT id FROM assets WHERE ${assetColumn} = ?)
         AND deleted_at IS NULL AND asset_deleted_at IS NULL
         AND (
           SELECT COUNT(*) FROM events source
           WHERE source.id IN (${affectedEventPlaceholders})
             AND json_extract(source.metadata_json, '$.assetDeletionOperationId') = ?
         ) = ?`,
    ).bind(
      now,
      userEmail,
      deletionOperationId,
      deletionOperationId,
      operationGroupId,
      assetLocator,
      ...affectedEventIds,
      deletionOperationId,
      affectedEventIds.length,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id IN (
         SELECT run_step_id FROM run_step_comments
         WHERE operation_group_id = ? AND last_mutation_id = ?
       )
         AND deleted_at IS NULL`,
    ).bind(userEmail, now, operationGroupId, deletionOperationId));
  } else if (verificationId && event.kind === "verification") {
    statements.push(c.env.DB.prepare(
      `UPDATE events SET asset_key = ${await deletedEventAssetSql(c.env.DB)},
         metadata_json = json_set(
           metadata_json, '$.assetDeletedAt', ?, '$.assetDeletedBy', ?,
           '$.assetDeletionOperationId', ?
         )
       WHERE id = ? AND sample_id = ? AND ${eventColumn} = ?
         AND EXISTS (
           SELECT 1
           FROM state_verifications sv
           JOIN run_steps endpoint ON endpoint.id = sv.after_run_step_id
           JOIN runs r ON r.id = endpoint.run_id
           JOIN samples s ON s.id = sv.sample_id
           WHERE sv.id = ? AND sv.sample_id = ?
             AND sv.evidence_asset_id = (SELECT id FROM assets WHERE ${assetColumn} = ?)
             AND s.deleted_at IS NULL AND r.deleted_at IS NULL
             AND endpoint.deleted_at IS NULL
         )
       RETURNING 1 AS affected`,
    ).bind(
      now, userEmail, deletionOperationId,
      eventId, sampleId, assetLocator,
      verificationId, sampleId, assetLocator,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE state_verifications SET evidence_asset_id = ${await deletedVerificationAssetSql(c.env.DB)}
       WHERE id = ? AND sample_id = ?
         AND evidence_asset_id = (SELECT id FROM assets WHERE ${assetColumn} = ?)
         AND EXISTS (
           SELECT 1 FROM events source
           WHERE source.id = ? AND source.sample_id = ?
             AND json_extract(source.metadata_json, '$.assetDeletionOperationId') = ?
         )`,
    ).bind(
      verificationId, sampleId, assetLocator,
      eventId, sampleId, deletionOperationId,
    ));
  } else if (stepId && runId && event.kind === "image" && executionOccurrenceId) {
    statements.push(c.env.DB.prepare(
      `WITH candidate_events AS MATERIALIZED (
         SELECT id
         FROM events
         WHERE sample_id = ? AND kind = 'image' AND ${eventColumn} = ? AND json_valid(metadata_json)
           AND (
             json_extract(metadata_json, '$.runStepAssetId') = ?
             OR (
               json_extract(metadata_json, '$.runStepAssetId') IS NULL
               AND json_extract(metadata_json, '$.runId') = ?
               AND json_extract(metadata_json, '$.stepId') = ?
             )
           )
       ),
       valid_occurrence AS MATERIALIZED (
         SELECT rsa.id
         FROM run_step_assets rsa
         JOIN assets a ON a.id = rsa.asset_id
         JOIN run_steps rs ON rs.id = rsa.run_step_id
         JOIN runs r ON r.id = rs.run_id
         JOIN samples s ON s.id = r.sample_id
         WHERE rsa.id = ? AND rsa.run_step_id = ? AND rsa.role = 'execution'
           AND a.${assetColumn} = ? AND rs.id = ? AND r.id = ? AND s.id = ?
           AND rsa.deleted_at IS NULL AND rs.deleted_at IS NULL
           AND r.deleted_at IS NULL AND s.deleted_at IS NULL
       )
       UPDATE events SET asset_key = ${await deletedEventAssetSql(c.env.DB)},
         metadata_json = json_set(
           metadata_json, '$.runStepAssetId', ?,
           '$.assetDeletedAt', ?, '$.assetDeletedBy', ?,
           '$.assetDeletionOperationId', ?
         )
       WHERE id IN (SELECT id FROM candidate_events)
         AND (SELECT COUNT(*) FROM candidate_events) = ?
         AND EXISTS (SELECT 1 FROM valid_occurrence)
       RETURNING 1 AS affected`,
    ).bind(
      sampleId, assetLocator, executionOccurrenceId, runId, stepId,
      executionOccurrenceId, stepId, assetLocator, stepId, runId, sampleId,
      executionOccurrenceId, now, userEmail, deletionOperationId,
      affectedEventIds.length,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE run_step_assets
       SET deleted_at = ?, deleted_by = ?, last_mutation_id = ?
       WHERE id = ? AND run_step_id = ? AND deleted_at IS NULL
         AND asset_id = (SELECT id FROM assets WHERE ${assetColumn} = ?)
         AND (
           SELECT COUNT(*) FROM events source
           WHERE source.sample_id = ? AND source.kind = 'image'
             AND json_valid(source.metadata_json)
             AND json_extract(source.metadata_json, '$.runStepAssetId') = ?
             AND json_extract(source.metadata_json, '$.assetDeletionOperationId') = ?
         ) = ?`,
    ).bind(
      now, userEmail, deletionOperationId,
      executionOccurrenceId, stepId, assetLocator,
      sampleId, executionOccurrenceId, deletionOperationId, affectedEventIds.length,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id = ? AND run_id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_assets rsa
           WHERE rsa.id = ? AND rsa.run_step_id = run_steps.id
             AND rsa.last_mutation_id = ?
         )`,
    ).bind(
      userEmail, now, stepId, runId,
      executionOccurrenceId, deletionOperationId,
    ));
  } else if (isSampleRecordEvent(event.kind, metadata)) {
    const { thumbnailKey: _thumbnailKey, ...retainedMetadata } = metadata;
    statements.push(c.env.DB.prepare(
      `UPDATE events SET asset_key = ${await deletedEventAssetSql(c.env.DB)}, metadata_json = ${await deletedEventMetadataSql(c.env.DB)}
       WHERE id = ? AND sample_id = ? AND ${eventColumn} = ?
         AND EXISTS (
           SELECT 1 FROM samples s
           WHERE s.id = events.sample_id AND s.deleted_at IS NULL
         )
       RETURNING 1 AS affected`,
    ).bind(
      JSON.stringify({
        ...retainedMetadata,
        assetDeletedAt: now,
        assetDeletedBy: userEmail,
        assetDeletionOperationId: deletionOperationId,
      }),
      eventId,
      sampleId,
      assetLocator,
    ));
  } else {
    throw new HTTPException(400, { message: "This timeline image is not a removable attachment" });
  }

  for (const affectedSampleId of affectedSampleIds) {
    const sampleEventIds = affectedEvents
      .filter((row) => row.sample_id === affectedSampleId)
      .map((row) => row.id);
    if (executionOccurrenceId) {
      statements.push(c.env.DB.prepare(
        `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
         SELECT ?, ?, 'comment', ?, ?, ?, ?
         WHERE (
           SELECT COUNT(*) FROM events source
           WHERE source.sample_id = ? AND source.kind = 'image'
             AND json_valid(source.metadata_json)
             AND json_extract(source.metadata_json, '$.runStepAssetId') = ?
             AND json_extract(source.metadata_json, '$.assetDeletionOperationId') = ?
         ) = ?`,
      ).bind(
        crypto.randomUUID(), affectedSampleId, `Deleted image attachment · ${event.body?.trim() || "Image"}`,
        JSON.stringify({ action: "image_attachment_deleted", originalEventId: eventId, sourceAction, hadAsset: true }),
        userEmail, now,
        affectedSampleId, executionOccurrenceId, deletionOperationId, sampleEventIds.length,
      ));
      statements.push(c.env.DB.prepare(
        `UPDATE samples SET updated_by = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL
           AND (
             SELECT COUNT(*) FROM events source
             WHERE source.sample_id = samples.id AND source.kind = 'image'
               AND json_valid(source.metadata_json)
               AND json_extract(source.metadata_json, '$.runStepAssetId') = ?
               AND json_extract(source.metadata_json, '$.assetDeletionOperationId') = ?
           ) = ?`,
      ).bind(
        userEmail, now, affectedSampleId,
        executionOccurrenceId, deletionOperationId, sampleEventIds.length,
      ));
      continue;
    }
    const sampleEventPlaceholders = sampleEventIds.map(() => "?").join(", ");
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'comment', ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM events source
         WHERE source.id IN (${sampleEventPlaceholders})
           AND source.sample_id = ?
           AND json_extract(source.metadata_json, '$.assetDeletionOperationId') = ?
       ) = ?`,
    ).bind(
      crypto.randomUUID(), affectedSampleId, `Deleted image attachment · ${event.body?.trim() || "Image"}`,
      JSON.stringify({ action: "image_attachment_deleted", originalEventId: eventId, sourceAction, hadAsset: true }),
      userEmail, now,
      ...sampleEventIds,
      affectedSampleId,
      deletionOperationId,
      sampleEventIds.length,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND (
           SELECT COUNT(*) FROM events source
           WHERE source.id IN (${sampleEventPlaceholders})
             AND source.sample_id = samples.id
             AND json_extract(source.metadata_json, '$.assetDeletionOperationId') = ?
         ) = ?`,
    ).bind(
      userEmail,
      now,
      affectedSampleId,
      ...sampleEventIds,
      deletionOperationId,
      sampleEventIds.length,
    ));
  }
  const results = await c.env.DB.batch(statements);
  if (results[0].results.length !== affectedEventIds.length) {
    throw new HTTPException(409, { message: "The image attachment source changed before deletion" });
  }
  return c.json({ ok: true, updatedAt: now });
});
