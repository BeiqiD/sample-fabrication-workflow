// The complete original Sample timeline attachment mutation. The structural
// metadata port grants no Request, resource, File, provider or Group authority.
import { HTTPException } from "hono/http-exception";
import { isSampleRecordEvent } from "../../shared/sample-records";
import { deletedEventAssetSqlWithDatabase, deletedEventMetadataSqlWithDatabase, deletedVerificationAssetSqlWithDatabase } from "../files/business-lifecycle-service";
import { requireVisibleCommentOperationGroupWithDatabase } from "../evidence/comment-operation-group-service";
import { sampleHasFileBindingsWithDatabase } from "./file-metadata-service";
import type { SampleFileMetadataStatement } from "./file-metadata-sql";
import type { SampleTimelineAttachmentDatabase } from "./timeline-attachment-sql";

export async function removeSampleTimelineAttachmentWithDatabase<Statement extends SampleFileMetadataStatement<Statement>>(
  db: SampleTimelineAttachmentDatabase<Statement>,
  sampleId: string,
  eventId: string,
  userEmail: string,
) {
  const hasFileBindings = await sampleHasFileBindingsWithDatabase(db);
  const event = await db.prepare(
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
  if (nativeAssetId && !await db.prepare("SELECT 1 FROM assets WHERE id=? AND r2_key IS NULL AND file_id=?")
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
    const liveRun = await db.prepare(
      "SELECT id FROM runs WHERE id = ? AND sample_id = ? AND deleted_at IS NULL",
    ).bind(runId, sampleId).first<{ id: string }>();
    if (!liveRun) throw new HTTPException(404, { message: "Active timeline source not found" });
  }
  let executionOccurrenceId: string | null = null;
  if (stepId && runId && event.kind === "image") {
    const occurrences = eventRunStepAssetId
      ? (await db.prepare(
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
      : (await db.prepare(
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
    ? (await db.prepare(
      `SELECT id, sample_id FROM events
       WHERE kind = 'step' AND json_valid(metadata_json)
         AND json_extract(metadata_json, '$.action') = 'step_comment'
         AND json_extract(metadata_json, '$.operationGroupId') = ?
         AND ${eventColumn} = ?
       ORDER BY id`,
    ).bind(operationGroupId, assetLocator).all<{ id: string; sample_id: string }>()).results
    : executionOccurrenceId && stepId && runId && event.kind === "image"
      ? (await db.prepare(
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
    await requireVisibleCommentOperationGroupWithDatabase(db, operationGroupId);
  }
  const sampleRows = await db.prepare(
    `SELECT id, updated_at FROM samples
     WHERE id IN (${affectedSampleIds.map(() => "?").join(", ")}) AND deleted_at IS NULL`,
  ).bind(...affectedSampleIds).all<{ id: string; updated_at: string }>();
  if (sampleRows.results.length !== affectedSampleIds.length) {
    throw new HTTPException(404, { message: "Sample not found" });
  }
  const latestUpdate = Math.max(...sampleRows.results.map((row) => Date.parse(row.updated_at)).filter(Number.isFinite));
  const now = new Date(Math.max(Date.now(), latestUpdate + 1)).toISOString();
  const deletionOperationId = crypto.randomUUID();
  const statements: Statement[] = [];
  const affectedEventIds = affectedEvents.map((row) => row.id);
  const affectedEventPlaceholders = affectedEventIds.map(() => "?").join(", ");

  if (sourceAction === "step_comment" && operationGroupId) {
    statements.push(db.prepare(
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
       SET asset_key = ${await deletedEventAssetSqlWithDatabase(db)},
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
    statements.push(db.prepare(
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
    statements.push(db.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id IN (
         SELECT run_step_id FROM run_step_comments
         WHERE operation_group_id = ? AND last_mutation_id = ?
       )
         AND deleted_at IS NULL`,
    ).bind(userEmail, now, operationGroupId, deletionOperationId));
  } else if (verificationId && event.kind === "verification") {
    statements.push(db.prepare(
      `UPDATE events SET asset_key = ${await deletedEventAssetSqlWithDatabase(db)},
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
    statements.push(db.prepare(
      `UPDATE state_verifications SET evidence_asset_id = ${await deletedVerificationAssetSqlWithDatabase(db)}
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
    statements.push(db.prepare(
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
       UPDATE events SET asset_key = ${await deletedEventAssetSqlWithDatabase(db)},
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
    statements.push(db.prepare(
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
    statements.push(db.prepare(
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
    statements.push(db.prepare(
      `UPDATE events SET asset_key = ${await deletedEventAssetSqlWithDatabase(db)}, metadata_json = ${await deletedEventMetadataSqlWithDatabase(db)}
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
      statements.push(db.prepare(
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
      statements.push(db.prepare(
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
    statements.push(db.prepare(
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
    statements.push(db.prepare(
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
  const results = await db.atomicBatch(statements);
  if (results[0].results.length !== affectedEventIds.length) {
    throw new HTTPException(409, { message: "The image attachment source changed before deletion" });
  }
  return { ok: true, updatedAt: now };
}
