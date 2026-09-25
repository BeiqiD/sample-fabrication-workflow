import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { CreateRunStepCommentsInput } from "../../shared/types";
import type { Env } from "../types";
import { requireVisibleCommentOperationGroup } from "./comment-operation-group";
import { validRunStepTargets } from "../execution/step-targets";

export const routes = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();

routes.post("/run-step-comments", async (c) => {
  const input = await c.req.json<CreateRunStepCommentsInput>();
  if (!input || !["common", "individual"].includes(input.scope)
    || typeof input.body !== "string" || !validRunStepTargets(input.targets)
    || (input.assetKey !== undefined && typeof input.assetKey !== "string")) {
    throw new HTTPException(400, { message: "A valid comment and 1–12 step targets are required" });
  }
  const body = input.body.trim();
  const assetKey = input.assetKey?.trim() || null;
  if (!body && !assetKey) throw new HTTPException(400, { message: "Comment text or an image is required" });
  if (body.length > 10_000) throw new HTTPException(400, { message: "Comment is too long" });
  if (input.scope === "individual" && input.targets.length !== 1) {
    throw new HTTPException(400, { message: "An individual comment must target one sample step" });
  }

  const values = input.targets.map(() => "(?, ?, ?, ?)").join(", ");
  const bindings = input.targets.flatMap((target) => [target.sampleId, target.runId, target.stepId, target.expectedUpdatedAt]);
  const [matched, commentAsset] = await Promise.all([c.env.DB.prepare(
    `WITH requested(sample_id, run_id, step_id, expected_updated_at) AS (VALUES ${values})
     SELECT q.sample_id, q.run_id, q.step_id
     FROM requested q
     JOIN runs r ON r.id = q.run_id AND r.sample_id = q.sample_id
     JOIN run_steps rs ON rs.id = q.step_id AND rs.run_id = q.run_id
     JOIN samples s ON s.id = q.sample_id
     WHERE rs.updated_at = q.expected_updated_at
       AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
  ).bind(...bindings).all<{ sample_id: string; run_id: string; step_id: string }>(),
  assetKey ? c.env.DB.prepare(
    `SELECT id, r2_key FROM assets a WHERE status = 'ready' AND r2_key = ?
       AND NOT EXISTS (
         SELECT 1 FROM blob_gc_ledger bg
         WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
           AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
       )`,
  ).bind(assetKey).first<{ id: string; r2_key: string }>() : Promise.resolve(null)]);
  if (matched.results.length !== input.targets.length) {
    throw new HTTPException(404, { message: "One or more sample steps were not found" });
  }
  if (assetKey && !commentAsset) throw new HTTPException(400, { message: "The uploaded comment image is unavailable" });

  const operationGroupId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const sampleIds = [...new Set(input.targets.map((target) => target.sampleId))];
  const occurrenceTargets = input.targets.map((target) => ({
    ...target,
    occurrenceId: crypto.randomUUID(),
  }));
  const requestedValues = occurrenceTargets.map(() => "(?, ?, ?, ?, ?)").join(", ");
  const requestedBindings = occurrenceTargets.flatMap((target) => [
    target.occurrenceId,
    target.sampleId,
    target.runId,
    target.stepId,
    target.expectedUpdatedAt,
  ]);
  const occurrenceIds = occurrenceTargets.map((target) => target.occurrenceId);
  const occurrencePlaceholders = occurrenceIds.map(() => "?").join(", ");
  const statements: D1PreparedStatement[] = [c.env.DB.prepare(
    `WITH requested(comment_id, sample_id, run_id, step_id, expected_updated_at) AS (
       VALUES ${requestedValues}
     ),
     valid AS (
       SELECT q.comment_id, q.step_id
       FROM requested q
       JOIN samples s ON s.id = q.sample_id AND s.deleted_at IS NULL
       JOIN runs r ON r.id = q.run_id AND r.sample_id = q.sample_id
         AND r.deleted_at IS NULL
       JOIN run_steps rs ON rs.id = q.step_id AND rs.run_id = q.run_id
         AND rs.deleted_at IS NULL
       WHERE rs.updated_at = q.expected_updated_at
     )
     INSERT INTO run_step_comments
       (id, run_step_id, scope, operation_group_id, legacy_body, asset_id, actor_email, created_at)
     SELECT valid.comment_id, valid.step_id, ?, ?, ?, ?, ?, ?
     FROM valid
     WHERE (SELECT COUNT(*) FROM valid) = ?
     RETURNING id`,
  ).bind(
    ...requestedBindings,
    input.scope,
    operationGroupId,
    body,
    commentAsset?.id ?? null,
    userEmail,
    now,
    occurrenceTargets.length,
  )];
  statements.push(c.env.DB.prepare(
    `UPDATE run_steps
     SET actualized_at = COALESCE(actualized_at, ?), updated_by = ?, updated_at = ?
     WHERE id IN (${occurrenceTargets.map(() => "?").join(", ")})
       AND deleted_at IS NULL
       AND (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${occurrencePlaceholders})
           AND rsc.operation_group_id = ?
           AND rsc.deleted_at IS NULL
       ) = ?`,
  ).bind(
    now,
    userEmail,
    now,
    ...occurrenceTargets.map((target) => target.stepId),
    ...occurrenceIds,
    operationGroupId,
    occurrenceTargets.length,
  ));
  for (const sampleId of sampleIds) {
    const sampleTargets = occurrenceTargets.filter((target) => target.sampleId === sampleId);
    const stepIds = sampleTargets.map((target) => target.stepId);
    const sampleOccurrenceIds = sampleTargets.map((target) => target.occurrenceId);
    const sampleOccurrencePlaceholders = sampleOccurrenceIds.map(() => "?").join(", ");
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'step', ?, ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${sampleOccurrencePlaceholders})
           AND rsc.operation_group_id = ?
           AND rsc.deleted_at IS NULL
       ) = ?`,
    ).bind(
      crypto.randomUUID(), sampleId,
      input.scope === "common" ? `Common step comment: ${body || "Image attached"}` : `Step comment: ${body || "Image attached"}`,
      commentAsset?.r2_key ?? null,
      JSON.stringify({ action: "step_comment", scope: input.scope, operationGroupId, stepIds }),
      userEmail, now,
      ...sampleOccurrenceIds,
      operationGroupId,
      sampleOccurrenceIds.length,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND (
           SELECT COUNT(*) FROM run_step_comments rsc
           WHERE rsc.id IN (${sampleOccurrencePlaceholders})
             AND rsc.operation_group_id = ?
             AND rsc.deleted_at IS NULL
         ) = ?`,
    ).bind(
      userEmail,
      now,
      sampleId,
      ...sampleOccurrenceIds,
      operationGroupId,
      sampleOccurrenceIds.length,
    ));
  }
  const results = await c.env.DB.batch(statements);
  // D1 changes includes rows changed by triggers. RETURNING identifies only the
  // occurrences inserted by this statement, so require this exact generated set.
  const insertedRows = results[0]?.results;
  if (Array.isArray(insertedRows) && insertedRows.length === 0) {
    throw new HTTPException(409, { message: "One or more sample steps changed before the comment was saved" });
  }
  // A malformed acknowledgement cannot prove that the transaction did not
  // commit. Keep that uncertain outcome distinct from an empty guarded INSERT.
  if (!Array.isArray(insertedRows)) {
    throw new HTTPException(500, { message: "Unable to confirm whether the comment was saved" });
  }
  const expectedIds = new Set<string>(occurrenceIds);
  const insertedIds = insertedRows.map((row) => row && typeof row === "object" && "id" in row ? row.id : undefined);
  if (insertedIds.length !== expectedIds.size
    || new Set(insertedIds).size !== expectedIds.size
    || insertedIds.some((id) => typeof id !== "string" || !expectedIds.has(id))) {
    throw new HTTPException(500, { message: "Unable to confirm whether the comment was saved" });
  }
  return c.json({ ok: true, operationGroupId }, 201);
});

routes.delete("/run-step-comments/:id/asset", async (c) => {
  const commentId = c.req.param("id");
  const comment = await c.env.DB.prepare(
    `SELECT rsc.id, rsc.scope, rsc.operation_group_id, a.r2_key
     FROM run_step_comments rsc
     JOIN run_steps rs ON rs.id = rsc.run_step_id
     JOIN runs r ON r.id = rs.run_id
     LEFT JOIN assets a ON a.id = rsc.asset_id
     WHERE rsc.id = ? AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
       AND rsc.deleted_at IS NULL AND rsc.asset_deleted_at IS NULL
       AND (
         rsc.submission_id IS NULL
         OR EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = rsc.submission_id
             AND cs.status = 'ready' AND cs.deleted_at IS NULL
         )
       )`,
  ).bind(commentId).first<{ id: string; scope: "common" | "individual"; operation_group_id: string | null; r2_key: string | null }>();
  if (!comment) throw new HTTPException(404, { message: "Step comment not found" });
  if (!comment.r2_key) throw new HTTPException(409, { message: "This comment attachment was already deleted" });
  const removeCommonGroup = comment.scope === "common" && Boolean(comment.operation_group_id);
  if (removeCommonGroup && comment.operation_group_id) {
    await requireVisibleCommentOperationGroup(c.env.DB, comment.operation_group_id);
  }
  const targets = removeCommonGroup
    ? await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id,
              CASE WHEN rsc.submission_id IS NULL THEN rsc.legacy_body
                   ELSE (SELECT cs.body FROM comment_submissions cs WHERE cs.id = rsc.submission_id) END AS body, r.sample_id, rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id JOIN samples s ON s.id = r.sample_id
       WHERE rsc.scope = 'common' AND rsc.operation_group_id = ? AND rsc.asset_id IS NOT NULL
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         AND rsc.deleted_at IS NULL AND rsc.asset_deleted_at IS NULL
         AND (
           rsc.submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = rsc.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )`,
    ).bind(comment.operation_group_id).all<{ id: string; run_step_id: string; body: string; sample_id: string; updated_at: string; sample_updated_at: string }>()
    : await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id,
              CASE WHEN rsc.submission_id IS NULL THEN rsc.legacy_body
                   ELSE (SELECT cs.body FROM comment_submissions cs WHERE cs.id = rsc.submission_id) END AS body, r.sample_id, rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id JOIN samples s ON s.id = r.sample_id
       WHERE rsc.id = ? AND rsc.asset_id IS NOT NULL
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         AND rsc.deleted_at IS NULL AND rsc.asset_deleted_at IS NULL
         AND (
           rsc.submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = rsc.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )`,
    ).bind(comment.id).all<{ id: string; run_step_id: string; body: string; sample_id: string; updated_at: string; sample_updated_at: string }>();
  if (!targets.results.length) throw new HTTPException(409, { message: "This comment attachment was already deleted" });
  const latestUpdate = Math.max(...targets.results.flatMap((target) => [target.updated_at, target.sample_updated_at]).map(Date.parse).filter(Number.isFinite));
  const now = new Date(Math.max(Date.now(), latestUpdate + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const deletionOperationId = crypto.randomUUID();
  const stepIds = [...new Set(targets.results.map((target) => target.run_step_id))];
  const sampleIds = [...new Set(targets.results.map((target) => target.sample_id))];
  const targetIds = targets.results.map((target) => target.id);
  const targetPlaceholders = targetIds.map(() => "?").join(", ");
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE run_step_comments
       SET asset_deleted_at = ?, asset_deleted_by = ?,
           asset_deletion_operation_id = ?, last_mutation_id = ?
       WHERE id IN (${targetPlaceholders})
         AND deleted_at IS NULL AND asset_id IS NOT NULL AND asset_deleted_at IS NULL
         AND (
           SELECT COUNT(*)
           FROM run_step_comments candidate
           JOIN run_steps candidate_step
             ON candidate_step.id = candidate.run_step_id
             AND candidate_step.deleted_at IS NULL
           JOIN runs candidate_run
             ON candidate_run.id = candidate_step.run_id
             AND candidate_run.deleted_at IS NULL
           JOIN samples candidate_sample
             ON candidate_sample.id = candidate_run.sample_id
             AND candidate_sample.deleted_at IS NULL
           WHERE candidate.id IN (${targetPlaceholders})
             AND candidate.deleted_at IS NULL
             AND candidate.asset_id IS NOT NULL
             AND candidate.asset_deleted_at IS NULL
             AND (
               candidate.submission_id IS NULL
               OR EXISTS (
                 SELECT 1 FROM comment_submissions cs
                 WHERE cs.id = candidate.submission_id
                   AND cs.status = 'ready' AND cs.deleted_at IS NULL
               )
             )
         ) = ?
       RETURNING id`,
    ).bind(
      now,
      userEmail,
      deletionOperationId,
      deletionOperationId,
      ...targetIds,
      ...targetIds,
      targetIds.length,
    ),
    c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id IN (${stepIds.map(() => "?").join(", ")}) AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_comments rsc
           WHERE rsc.id IN (${targetPlaceholders})
             AND rsc.run_step_id = run_steps.id
             AND rsc.asset_deletion_operation_id = ?
             AND rsc.last_mutation_id = ?
         )`,
    ).bind(
      userEmail,
      now,
      ...stepIds,
      ...targetIds,
      deletionOperationId,
      deletionOperationId,
    ),
  ];
  if (comment.operation_group_id) statements.push(c.env.DB.prepare(
    `UPDATE events SET asset_key = NULL,
       metadata_json = json_set(metadata_json,
         '$.assetDeletedAt', ?, '$.assetDeletedBy', ?,
         '$.assetDeletionOperationId', ?)
     WHERE kind = 'step' AND json_valid(metadata_json)
       AND json_extract(metadata_json, '$.action') = 'step_comment'
       AND json_extract(metadata_json, '$.operationGroupId') = ?
       AND (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${targetPlaceholders})
           AND rsc.asset_deletion_operation_id = ?
           AND rsc.last_mutation_id = ?
       ) = ?`,
  ).bind(
    now,
    userEmail,
    deletionOperationId,
    comment.operation_group_id,
    ...targetIds,
    deletionOperationId,
    deletionOperationId,
    targetIds.length,
  ));
  for (const sampleId of sampleIds) {
    const sampleTarget = targets.results.find((target) => target.sample_id === sampleId);
    const sampleTargetIds = targets.results
      .filter((target) => target.sample_id === sampleId)
      .map((target) => target.id);
    const sampleTargetPlaceholders = sampleTargetIds.map(() => "?").join(", ");
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'step', ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${sampleTargetPlaceholders})
           AND rsc.asset_deletion_operation_id = ?
           AND rsc.last_mutation_id = ?
       ) = ?`,
    ).bind(crypto.randomUUID(), sampleId, `Deleted comment image attachment · ${sampleTarget?.body.trim() || "Image"}`,
      JSON.stringify({ action: "comment_attachment_deleted", operationGroupId: comment.operation_group_id, stepIds: targets.results.filter((target) => target.sample_id === sampleId).map((target) => target.run_step_id) }), userEmail, now,
      ...sampleTargetIds, deletionOperationId, deletionOperationId, sampleTargetIds.length));
    statements.push(c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND (
           SELECT COUNT(*) FROM run_step_comments rsc
           WHERE rsc.id IN (${sampleTargetPlaceholders})
             AND rsc.asset_deletion_operation_id = ?
             AND rsc.last_mutation_id = ?
         ) = ?`,
    ).bind(
      userEmail,
      now,
      sampleId,
      ...sampleTargetIds,
      deletionOperationId,
      deletionOperationId,
      sampleTargetIds.length,
    ));
  }
  const results = await c.env.DB.batch(statements);
  if (results[0].results.length !== targetIds.length) {
    throw new HTTPException(409, { message: "The comment attachment changed while it was being deleted" });
  }
  return c.json({ ok: true, updatedAt: now });
});

routes.post("/run-step-comments/:id/asset/restore", async (c) => {
  const commentId = c.req.param("id");
  const comment = await c.env.DB.prepare(
    `SELECT rsc.id, rsc.scope, rsc.operation_group_id, rsc.deleted_at,
            rsc.asset_deleted_at, rsc.asset_deletion_operation_id,
            rsc.submission_id,
            cs.status AS submission_status, cs.deleted_at AS submission_deleted_at
     FROM run_step_comments rsc
     JOIN run_steps rs ON rs.id = rsc.run_step_id
     JOIN runs r ON r.id = rs.run_id
     JOIN samples s ON s.id = r.sample_id
     LEFT JOIN comment_submissions cs ON cs.id = rsc.submission_id
     WHERE rsc.id = ? AND rsc.asset_id IS NOT NULL
       AND rsc.asset_deleted_at IS NOT NULL
       AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
  ).bind(commentId).first<{
    id: string; scope: "common" | "individual"; operation_group_id: string | null;
    deleted_at: string | null; asset_deleted_at: string;
    asset_deletion_operation_id: string | null; submission_id: string | null;
    submission_status: string | null; submission_deleted_at: string | null;
  }>();
  if (!comment) throw new HTTPException(404, { message: "Deleted comment attachment not found" });
  if (comment.submission_id
    && (comment.submission_status !== "ready" || comment.submission_deleted_at !== null)) {
    throw new HTTPException(409, { message: "Restore the canonical Comment before restoring this attachment" });
  }
  if (comment.deleted_at !== null) {
    throw new HTTPException(404, { message: "Deleted comment attachment not found" });
  }
  if (!comment.asset_deletion_operation_id) {
    throw new HTTPException(409, { message: "This deleted attachment has no recoverable operation identity" });
  }
  const restoreCommonGroup = comment.scope === "common" && Boolean(comment.operation_group_id);
  if (restoreCommonGroup && comment.operation_group_id) {
    await requireVisibleCommentOperationGroup(c.env.DB, comment.operation_group_id);
  }
  const targets = restoreCommonGroup
    ? await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id, r.sample_id, a.r2_key,
              rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       JOIN assets a ON a.id = rsc.asset_id AND a.status = 'ready'
       WHERE rsc.scope = 'common' AND rsc.operation_group_id = ?
         AND rsc.deleted_at IS NULL AND rsc.asset_deletion_operation_id = ?
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         AND (
           rsc.submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = rsc.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )`,
    ).bind(comment.operation_group_id, comment.asset_deletion_operation_id).all<{
      id: string; run_step_id: string; sample_id: string; r2_key: string;
      updated_at: string; sample_updated_at: string;
    }>()
    : await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id, r.sample_id, a.r2_key,
              rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       JOIN assets a ON a.id = rsc.asset_id AND a.status = 'ready'
       WHERE rsc.id = ? AND rsc.deleted_at IS NULL AND rsc.asset_deleted_at IS NOT NULL
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         AND (
           rsc.submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = rsc.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )`,
    ).bind(comment.id).all<{
      id: string; run_step_id: string; sample_id: string; r2_key: string;
      updated_at: string; sample_updated_at: string;
    }>();
  if (!targets.results.length) throw new HTTPException(404, { message: "Deleted comment attachment not found" });
  const latestUpdate = Math.max(
    Date.parse(comment.asset_deleted_at),
    ...targets.results.flatMap((target) => [target.updated_at, target.sample_updated_at]).map(Date.parse),
  );
  const now = new Date(Math.max(Date.now(), latestUpdate + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const stepIds = [...new Set(targets.results.map((target) => target.run_step_id))];
  const sampleIds = [...new Set(targets.results.map((target) => target.sample_id))];
  const targetIds = targets.results.map((target) => target.id);
  const targetPlaceholders = targetIds.map(() => "?").join(", ");
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE run_step_comments
       SET asset_deleted_at = NULL, asset_deleted_by = NULL,
           asset_deletion_operation_id = NULL, last_mutation_id = ?
       WHERE id IN (${targetPlaceholders}) AND asset_deletion_operation_id = ?
         AND (
           SELECT COUNT(*)
           FROM run_step_comments candidate
           JOIN run_steps candidate_step
             ON candidate_step.id = candidate.run_step_id
             AND candidate_step.deleted_at IS NULL
           JOIN runs candidate_run
             ON candidate_run.id = candidate_step.run_id
             AND candidate_run.deleted_at IS NULL
           JOIN samples candidate_sample
             ON candidate_sample.id = candidate_run.sample_id
             AND candidate_sample.deleted_at IS NULL
           WHERE candidate.id IN (${targetPlaceholders})
             AND candidate.deleted_at IS NULL
             AND candidate.asset_deletion_operation_id = ?
             AND (
               candidate.submission_id IS NULL
               OR EXISTS (
                 SELECT 1 FROM comment_submissions cs
                 WHERE cs.id = candidate.submission_id
                   AND cs.status = 'ready' AND cs.deleted_at IS NULL
               )
             )
         ) = ?
       RETURNING id`,
    ).bind(
      mutationId,
      ...targetIds,
      comment.asset_deletion_operation_id,
      ...targetIds,
      comment.asset_deletion_operation_id,
      targetIds.length,
    ),
    c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id IN (${stepIds.map(() => "?").join(", ")}) AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_comments rsc
           WHERE rsc.id IN (${targetPlaceholders})
             AND rsc.run_step_id = run_steps.id
             AND rsc.asset_deleted_at IS NULL
             AND rsc.last_mutation_id = ?
         )`,
    ).bind(userEmail, now, ...stepIds, ...targetIds, mutationId),
  ];
  if (comment.operation_group_id) statements.push(c.env.DB.prepare(
    `UPDATE events SET asset_key = ?,
       metadata_json = json_remove(
         metadata_json, '$.assetDeletedAt', '$.assetDeletedBy',
         '$.assetDeletionOperationId'
       )
     WHERE kind = 'step' AND json_valid(metadata_json)
       AND json_extract(metadata_json, '$.action') = 'step_comment'
       AND json_extract(metadata_json, '$.operationGroupId') = ?
       AND json_extract(metadata_json, '$.assetDeletionOperationId') = ?
       AND (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${targetPlaceholders})
           AND rsc.asset_deleted_at IS NULL AND rsc.last_mutation_id = ?
       ) = ?`,
  ).bind(
    targets.results[0].r2_key,
    comment.operation_group_id,
    comment.asset_deletion_operation_id,
    ...targetIds,
    mutationId,
    targetIds.length,
  ));
  for (const sampleId of sampleIds) {
    const sampleTargetIds = targets.results
      .filter((target) => target.sample_id === sampleId)
      .map((target) => target.id);
    const sampleTargetPlaceholders = sampleTargetIds.map(() => "?").join(", ");
    statements.push(c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND (
           SELECT COUNT(*) FROM run_step_comments rsc
           WHERE rsc.id IN (${sampleTargetPlaceholders})
             AND rsc.asset_deleted_at IS NULL AND rsc.last_mutation_id = ?
         ) = ?`,
    ).bind(userEmail, now, sampleId, ...sampleTargetIds, mutationId, sampleTargetIds.length));
  }
  const results = await c.env.DB.batch(statements);
  if (results[0].results.length !== targetIds.length) {
    throw new HTTPException(409, { message: "The comment attachment changed while it was being restored" });
  }
  return c.json({ ok: true, updatedAt: now });
});

routes.delete("/run-step-comments/:id", async (c) => {
  const commentId = c.req.param("id");
  const comment = await c.env.DB.prepare(
    `SELECT rsc.id, rsc.scope, rsc.operation_group_id
     FROM run_step_comments rsc
     JOIN run_steps rs ON rs.id = rsc.run_step_id
     JOIN runs r ON r.id = rs.run_id
     WHERE rsc.id = ? AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
       AND rsc.deleted_at IS NULL
       AND (
         rsc.submission_id IS NULL
         OR EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = rsc.submission_id
             AND cs.status = 'ready' AND cs.deleted_at IS NULL
         )
       )`,
  ).bind(commentId).first<{
    id: string; scope: "common" | "individual"; operation_group_id: string | null;
  }>();
  if (!comment) throw new HTTPException(404, { message: "Step comment not found" });

  const removeCommonGroup = comment.scope === "common" && Boolean(comment.operation_group_id);
  if (removeCommonGroup && comment.operation_group_id) {
    await requireVisibleCommentOperationGroup(c.env.DB, comment.operation_group_id);
  }
  const targets = removeCommonGroup
    ? await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id,
              CASE WHEN rsc.submission_id IS NULL THEN rsc.legacy_body
                   ELSE (SELECT cs.body FROM comment_submissions cs WHERE cs.id = rsc.submission_id) END AS body, rsc.asset_id, r.sample_id, rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       WHERE rsc.scope = 'common' AND rsc.operation_group_id = ?
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         AND rsc.deleted_at IS NULL
         AND (
           rsc.submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = rsc.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )`,
    ).bind(comment.operation_group_id).all<{ id: string; run_step_id: string; body: string; asset_id: string | null; sample_id: string; updated_at: string; sample_updated_at: string }>()
    : await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id,
              CASE WHEN rsc.submission_id IS NULL THEN rsc.legacy_body
                   ELSE (SELECT cs.body FROM comment_submissions cs WHERE cs.id = rsc.submission_id) END AS body, rsc.asset_id, r.sample_id, rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       WHERE rsc.id = ? AND s.deleted_at IS NULL AND r.deleted_at IS NULL
         AND rs.deleted_at IS NULL AND rsc.deleted_at IS NULL
         AND (
           rsc.submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = rsc.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )`,
    ).bind(comment.id).all<{ id: string; run_step_id: string; body: string; asset_id: string | null; sample_id: string; updated_at: string; sample_updated_at: string }>();
  if (!targets.results.length) throw new HTTPException(404, { message: "Step comment not found" });

  const latestUpdate = Math.max(...targets.results.flatMap((target) => [target.updated_at, target.sample_updated_at]).map((value) => Date.parse(value)).filter(Number.isFinite));
  const now = new Date(Math.max(Date.now(), latestUpdate + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const deletionOperationId = crypto.randomUUID();
  const stepIds = [...new Set(targets.results.map((target) => target.run_step_id))];
  const sampleIds = [...new Set(targets.results.map((target) => target.sample_id))];
  const targetIds = targets.results.map((target) => target.id);
  const targetPlaceholders = targetIds.map(() => "?").join(", ");
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE run_step_comments
       SET deleted_at = ?, deleted_by = ?, deletion_operation_id = ?,
           last_mutation_id = ?, updated_at = ?, updated_by = ?
       WHERE id IN (${targetPlaceholders}) AND deleted_at IS NULL
         AND (
           SELECT COUNT(*)
           FROM run_step_comments candidate
           JOIN run_steps candidate_step
             ON candidate_step.id = candidate.run_step_id
             AND candidate_step.deleted_at IS NULL
           JOIN runs candidate_run
             ON candidate_run.id = candidate_step.run_id
             AND candidate_run.deleted_at IS NULL
           JOIN samples candidate_sample
             ON candidate_sample.id = candidate_run.sample_id
             AND candidate_sample.deleted_at IS NULL
           WHERE candidate.id IN (${targetPlaceholders})
             AND candidate.deleted_at IS NULL
             AND (
               candidate.submission_id IS NULL
               OR EXISTS (
                 SELECT 1 FROM comment_submissions cs
                 WHERE cs.id = candidate.submission_id
                   AND cs.status = 'ready' AND cs.deleted_at IS NULL
               )
             )
         ) = ?
       RETURNING id`,
    ).bind(
      now,
      userEmail,
      deletionOperationId,
      deletionOperationId,
      now,
      userEmail,
      ...targetIds,
      ...targetIds,
      targetIds.length,
    ),
    c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id IN (${stepIds.map(() => "?").join(", ")}) AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_comments rsc
           WHERE rsc.id IN (${targetPlaceholders})
             AND rsc.run_step_id = run_steps.id
             AND rsc.deletion_operation_id = ?
             AND rsc.last_mutation_id = ?
         )`,
    ).bind(
      userEmail,
      now,
      ...stepIds,
      ...targetIds,
      deletionOperationId,
      deletionOperationId,
    ),
  ];
  if (comment.operation_group_id) statements.push(c.env.DB.prepare(
    `UPDATE events SET asset_key = NULL,
       metadata_json = json_set(metadata_json,
         '$.deletedAt', ?, '$.deletedBy', ?, '$.deletionOperationId', ?)
     WHERE kind = 'step' AND json_valid(metadata_json)
       AND json_extract(metadata_json, '$.action') = 'step_comment'
       AND json_extract(metadata_json, '$.operationGroupId') = ?
       AND (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${targetPlaceholders})
           AND rsc.deletion_operation_id = ? AND rsc.last_mutation_id = ?
       ) = ?`,
  ).bind(
    now,
    userEmail,
    deletionOperationId,
    comment.operation_group_id,
    ...targetIds,
    deletionOperationId,
    deletionOperationId,
    targetIds.length,
  ));
  for (const sampleId of sampleIds) {
    const sampleTargets = targets.results.filter((target) => target.sample_id === sampleId);
    const sampleStepIds = sampleTargets.map((target) => target.run_step_id);
    const sampleTargetIds = sampleTargets.map((target) => target.id);
    const sampleTargetPlaceholders = sampleTargetIds.map(() => "?").join(", ");
    const deletedSummary = sampleTargets[0]?.body.trim() || (sampleTargets.some((target) => target.asset_id) ? "Image attachment" : "Empty comment");
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'step', ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${sampleTargetPlaceholders})
           AND rsc.deletion_operation_id = ? AND rsc.last_mutation_id = ?
       ) = ?`,
    ).bind(
      crypto.randomUUID(), sampleId,
      `Deleted ${removeCommonGroup ? "common " : ""}step comment · ${deletedSummary}`,
      JSON.stringify({ action: "step_comment_deleted", operationGroupId: comment.operation_group_id, stepIds: sampleStepIds, hadAsset: sampleTargets.some((target) => Boolean(target.asset_id)) }),
      userEmail, now, ...sampleTargetIds,
      deletionOperationId, deletionOperationId, sampleTargetIds.length,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND (
           SELECT COUNT(*) FROM run_step_comments rsc
           WHERE rsc.id IN (${sampleTargetPlaceholders})
             AND rsc.deletion_operation_id = ? AND rsc.last_mutation_id = ?
         ) = ?`,
    ).bind(
      userEmail,
      now,
      sampleId,
      ...sampleTargetIds,
      deletionOperationId,
      deletionOperationId,
      sampleTargetIds.length,
    ));
  }

  const results = await c.env.DB.batch(statements);
  const deleted = results[0].results.length;
  if (deleted !== targetIds.length) {
    throw new HTTPException(409, { message: "The comment changed while it was being deleted" });
  }
  return c.json({ ok: true, deleted });
});

routes.post("/run-step-comments/:id/restore", async (c) => {
  const commentId = c.req.param("id");
  const comment = await c.env.DB.prepare(
    `SELECT rsc.id, rsc.scope, rsc.operation_group_id, rsc.deleted_at,
            rsc.deletion_operation_id, rsc.submission_id,
            cs.status AS submission_status,
            cs.deleted_at AS submission_deleted_at
     FROM run_step_comments rsc
     LEFT JOIN comment_submissions cs ON cs.id = rsc.submission_id
     WHERE rsc.id = ? AND rsc.deleted_at IS NOT NULL`,
  ).bind(commentId).first<{
    id: string; scope: "common" | "individual"; operation_group_id: string | null;
    deleted_at: string; deletion_operation_id: string | null;
    submission_id: string | null; submission_status: string | null;
    submission_deleted_at: string | null;
  }>();
  if (!comment) throw new HTTPException(404, { message: "Deleted step comment not found" });
  if (comment.submission_id
    && (comment.submission_status !== "ready" || comment.submission_deleted_at !== null)) {
    throw new HTTPException(409, { message: "Restore the canonical Comment before restoring this comment" });
  }
  if (!comment.deletion_operation_id) {
    throw new HTTPException(409, { message: "This deleted comment has no recoverable operation identity" });
  }
  const restoreCommonGroup = comment.scope === "common" && Boolean(comment.operation_group_id);
  if (restoreCommonGroup && comment.operation_group_id) {
    await requireVisibleCommentOperationGroup(c.env.DB, comment.operation_group_id);
  }
  const targets = restoreCommonGroup
    ? await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id,
              CASE WHEN rsc.submission_id IS NULL THEN rsc.legacy_body
                   ELSE (SELECT cs.body FROM comment_submissions cs WHERE cs.id = rsc.submission_id) END AS body, r.sample_id, a.r2_key,
              rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       LEFT JOIN assets a ON a.id = rsc.asset_id AND a.status = 'ready'
       WHERE rsc.scope = 'common' AND rsc.operation_group_id = ?
         AND rsc.deletion_operation_id = ?
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         AND (
           rsc.submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = rsc.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )`,
    ).bind(comment.operation_group_id, comment.deletion_operation_id).all<{
      id: string; run_step_id: string; body: string; sample_id: string; r2_key: string | null;
      updated_at: string; sample_updated_at: string;
    }>()
    : await c.env.DB.prepare(
      `SELECT rsc.id, rsc.run_step_id,
              CASE WHEN rsc.submission_id IS NULL THEN rsc.legacy_body
                   ELSE (SELECT cs.body FROM comment_submissions cs WHERE cs.id = rsc.submission_id) END AS body, r.sample_id, a.r2_key,
              rs.updated_at, s.updated_at AS sample_updated_at
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       LEFT JOIN assets a ON a.id = rsc.asset_id AND a.status = 'ready'
       WHERE rsc.id = ? AND rsc.deleted_at IS NOT NULL
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         AND (
           rsc.submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = rsc.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )`,
    ).bind(comment.id).all<{
      id: string; run_step_id: string; body: string; sample_id: string; r2_key: string | null;
      updated_at: string; sample_updated_at: string;
    }>();
  if (!targets.results.length) throw new HTTPException(409, { message: "Restore the comment source before restoring this comment" });
  const latestUpdate = Math.max(
    Date.parse(comment.deleted_at),
    ...targets.results.flatMap((target) => [target.updated_at, target.sample_updated_at]).map(Date.parse),
  );
  const now = new Date(Math.max(Date.now(), latestUpdate + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const stepIds = [...new Set(targets.results.map((target) => target.run_step_id))];
  const sampleIds = [...new Set(targets.results.map((target) => target.sample_id))];
  const targetIds = targets.results.map((target) => target.id);
  const targetPlaceholders = targetIds.map(() => "?").join(", ");
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE run_step_comments
       SET deleted_at = NULL, deleted_by = NULL, deletion_operation_id = NULL,
           last_mutation_id = ?, updated_at = ?, updated_by = ?
       WHERE id IN (${targetPlaceholders}) AND deletion_operation_id = ?
         AND (
           submission_id IS NULL
           OR EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = run_step_comments.submission_id
               AND cs.status = 'ready' AND cs.deleted_at IS NULL
           )
         )
         AND (
           SELECT COUNT(*)
           FROM run_step_comments candidate
           JOIN run_steps candidate_step
             ON candidate_step.id = candidate.run_step_id
             AND candidate_step.deleted_at IS NULL
           JOIN runs candidate_run
             ON candidate_run.id = candidate_step.run_id
             AND candidate_run.deleted_at IS NULL
           JOIN samples candidate_sample
             ON candidate_sample.id = candidate_run.sample_id
             AND candidate_sample.deleted_at IS NULL
           WHERE candidate.id IN (${targetPlaceholders})
             AND candidate.deletion_operation_id = ?
             AND (
               candidate.submission_id IS NULL
               OR EXISTS (
                 SELECT 1 FROM comment_submissions cs
                 WHERE cs.id = candidate.submission_id
                   AND cs.status = 'ready' AND cs.deleted_at IS NULL
               )
             )
         ) = ?
       RETURNING id`,
    ).bind(
      mutationId,
      now,
      userEmail,
      ...targetIds,
      comment.deletion_operation_id,
      ...targetIds,
      comment.deletion_operation_id,
      targetIds.length,
    ),
    c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id IN (${stepIds.map(() => "?").join(", ")}) AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_comments rsc
           WHERE rsc.id IN (${targetPlaceholders})
             AND rsc.run_step_id = run_steps.id
             AND rsc.deleted_at IS NULL AND rsc.last_mutation_id = ?
         )`,
    ).bind(userEmail, now, ...stepIds, ...targetIds, mutationId),
  ];
  if (comment.operation_group_id) statements.push(c.env.DB.prepare(
    `UPDATE events SET asset_key = ?,
       metadata_json = json_remove(
         metadata_json, '$.deletedAt', '$.deletedBy', '$.deletionOperationId'
       )
     WHERE kind = 'step' AND json_valid(metadata_json)
       AND json_extract(metadata_json, '$.action') = 'step_comment'
       AND json_extract(metadata_json, '$.operationGroupId') = ?
       AND json_extract(metadata_json, '$.deletionOperationId') = ?
       AND (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${targetPlaceholders})
           AND rsc.deleted_at IS NULL AND rsc.last_mutation_id = ?
       ) = ?`,
  ).bind(
    targets.results[0].r2_key,
    comment.operation_group_id,
    comment.deletion_operation_id,
    ...targetIds,
    mutationId,
    targetIds.length,
  ));
  for (const sampleId of sampleIds) {
    const sampleTarget = targets.results.find((target) => target.sample_id === sampleId);
    const sampleTargetIds = targets.results
      .filter((target) => target.sample_id === sampleId)
      .map((target) => target.id);
    const sampleTargetPlaceholders = sampleTargetIds.map(() => "?").join(", ");
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'step', ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${sampleTargetPlaceholders})
           AND rsc.deleted_at IS NULL AND rsc.last_mutation_id = ?
       ) = ?`,
    ).bind(
      crypto.randomUUID(), sampleId,
      `Restored ${restoreCommonGroup ? "common " : ""}step comment · ${sampleTarget?.body.trim() || "Image attachment"}`,
      JSON.stringify({ action: "step_comment_restored", operationGroupId: comment.operation_group_id,
        stepIds: targets.results.filter((target) => target.sample_id === sampleId).map((target) => target.run_step_id) }),
      userEmail, now, ...sampleTargetIds, mutationId, sampleTargetIds.length,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND (
           SELECT COUNT(*) FROM run_step_comments rsc
           WHERE rsc.id IN (${sampleTargetPlaceholders})
             AND rsc.deleted_at IS NULL AND rsc.last_mutation_id = ?
         ) = ?`,
    ).bind(userEmail, now, sampleId, ...sampleTargetIds, mutationId, sampleTargetIds.length));
  }
  const results = await c.env.DB.batch(statements);
  if (results[0].results.length !== targetIds.length) {
    throw new HTTPException(409, { message: "The comment changed while it was being restored" });
  }
  return c.json({ ok: true, restored: results[0].results.length, updatedAt: now });
});
