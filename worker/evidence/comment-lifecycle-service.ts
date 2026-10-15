import { HTTPException } from "hono/http-exception";
import type { CommentLifecycleDatabase, CommentLifecycleStatement } from "./comment-lifecycle-sql";

export interface CommentLifecycleCapabilities {
  database(): CommentLifecycleDatabase;
  admit(actor: string): Promise<void>;
  now(): number;
  randomId(): string;
  deletedEventAssetSql(): Promise<"asset_key" | "NULL">;
  prepareFileRestoration(kind: "legacy_comment", ids: string[]): Promise<CommentLifecycleStatement[]>;
}
/** Same mature visibility SQL for the COMPLETE operation group, without an
 * environment facade. Availability is distinct from the host's actual rights. */
export async function requireVisibleCommentOperationGroupWithDatabase(db: CommentLifecycleDatabase, operationGroupId: string) {
  const counts = await db.prepare(
    `SELECT COUNT(*) AS target_count,
            COALESCE(SUM(CASE
              WHEN s.id IS NOT NULL AND s.deleted_at IS NULL
                AND r.id IS NOT NULL AND r.deleted_at IS NULL
                AND rs.id IS NOT NULL AND rs.deleted_at IS NULL
                AND (
                  rsc.submission_id IS NULL
                  OR EXISTS (
                    SELECT 1
                    FROM comment_submissions cs
                    WHERE cs.id = rsc.submission_id
                      AND cs.status = 'ready'
                      AND cs.deleted_at IS NULL
                  )
                )
              THEN 1 ELSE 0 END), 0) AS visible_count
     FROM run_step_comments rsc
     LEFT JOIN run_steps rs ON rs.id = rsc.run_step_id
     LEFT JOIN runs r ON r.id = rs.run_id
     LEFT JOIN samples s ON s.id = r.sample_id
     WHERE rsc.operation_group_id = ?`,
  ).bind(operationGroupId).first<{ target_count: number; visible_count: number }>();
  if (!counts || Number(counts.target_count) < 1
    || Number(counts.visible_count) !== Number(counts.target_count)) {
    throw new HTTPException(409, {
      message: "A common comment target is no longer available. Restore every target before changing the group.",
    });
  }
}

export async function removeRunStepCommentsWithDatabase(capabilities: CommentLifecycleCapabilities, commentId: string, actor: string) {
  await capabilities.admit(actor);
  const db = capabilities.database();
  const comment = await db.prepare(
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
    await requireVisibleCommentOperationGroupWithDatabase(db, comment.operation_group_id);
  }
  const targets = removeCommonGroup
    ? await db.prepare(
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
    : await db.prepare(
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
  const now = new Date(Math.max(capabilities.now(), latestUpdate + 1)).toISOString();
  const userEmail = actor;
  const deletionOperationId = capabilities.randomId();
  const stepIds = [...new Set(targets.results.map((target) => target.run_step_id))];
  const sampleIds = [...new Set(targets.results.map((target) => target.sample_id))];
  const targetIds = targets.results.map((target) => target.id);
  const targetPlaceholders = targetIds.map(() => "?").join(", ");
  const statements: CommentLifecycleStatement[] = [
    db.prepare(
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
    db.prepare(
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
  if (comment.operation_group_id) statements.push(db.prepare(
    `UPDATE events SET asset_key = ${await capabilities.deletedEventAssetSql()},
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
    statements.push(db.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'step', ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${sampleTargetPlaceholders})
           AND rsc.deletion_operation_id = ? AND rsc.last_mutation_id = ?
       ) = ?`,
    ).bind(
      capabilities.randomId(), sampleId,
      `Deleted ${removeCommonGroup ? "common " : ""}step comment · ${deletedSummary}`,
      JSON.stringify({ action: "step_comment_deleted", operationGroupId: comment.operation_group_id, stepIds: sampleStepIds, hadAsset: sampleTargets.some((target) => Boolean(target.asset_id)) }),
      userEmail, now, ...sampleTargetIds,
      deletionOperationId, deletionOperationId, sampleTargetIds.length,
    ));
    statements.push(db.prepare(
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

  await capabilities.admit(actor);
  const results = await db.atomicBatch(statements);
  const deleted = results[0].results.length;
  if (deleted !== targetIds.length) {
    throw new HTTPException(409, { message: "The comment changed while it was being deleted" });
  }
  await capabilities.admit(actor);
  return { ok: true as const, deleted };
}

export async function restoreRunStepCommentsWithDatabase(capabilities: CommentLifecycleCapabilities, commentId: string, actor: string) {
  await capabilities.admit(actor);
  const db = capabilities.database();
  const comment = await db.prepare(
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
    await requireVisibleCommentOperationGroupWithDatabase(db, comment.operation_group_id);
  }
  const targets = restoreCommonGroup
    ? await db.prepare(
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
    : await db.prepare(
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
  const now = new Date(Math.max(capabilities.now(), latestUpdate + 1)).toISOString();
  const userEmail = actor;
  const mutationId = capabilities.randomId();
  const stepIds = [...new Set(targets.results.map((target) => target.run_step_id))];
  const sampleIds = [...new Set(targets.results.map((target) => target.sample_id))];
  const targetIds = targets.results.map((target) => target.id);
  const targetPlaceholders = targetIds.map(() => "?").join(", ");
  const statements: CommentLifecycleStatement[] = [
    db.prepare(
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
    db.prepare(
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
  if (comment.operation_group_id) statements.push(db.prepare(
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
    statements.push(db.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'step', ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${sampleTargetPlaceholders})
           AND rsc.deleted_at IS NULL AND rsc.last_mutation_id = ?
       ) = ?`,
    ).bind(
      capabilities.randomId(), sampleId,
      `Restored ${restoreCommonGroup ? "common " : ""}step comment · ${sampleTarget?.body.trim() || "Image attachment"}`,
      JSON.stringify({ action: "step_comment_restored", operationGroupId: comment.operation_group_id,
        stepIds: targets.results.filter((target) => target.sample_id === sampleId).map((target) => target.run_step_id) }),
      userEmail, now, ...sampleTargetIds, mutationId, sampleTargetIds.length,
    ));
    statements.push(db.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND (
           SELECT COUNT(*) FROM run_step_comments rsc
           WHERE rsc.id IN (${sampleTargetPlaceholders})
             AND rsc.deleted_at IS NULL AND rsc.last_mutation_id = ?
         ) = ?`,
    ).bind(userEmail, now, sampleId, ...sampleTargetIds, mutationId, sampleTargetIds.length));
  }
  const fences = await capabilities.prepareFileRestoration("legacy_comment", targetIds);
  await capabilities.admit(actor);
  const results = (await db.atomicBatch([...fences, ...statements])).slice(fences.length);
  if (results[0].results.length !== targetIds.length) {
    throw new HTTPException(409, { message: "The comment changed while it was being restored" });
  }
  await capabilities.admit(actor);
  return { ok: true as const, restored: results[0].results.length, updatedAt: now };
}
