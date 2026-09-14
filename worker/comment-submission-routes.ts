import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { managedStorageStatus } from "./managed-storage";
import { getBlob } from "./blob-lifecycle/storage";
import {
  listItemBlobLocators,
  markOrphanCandidate,
  retryUntil,
} from "./blob-lifecycle/reachability";
import type { Env } from "./types";
import { isTiffMetadata } from "../shared/tiff";
import { acceptedComment, createAcceptedComment, uploadAcceptedCommentItem, finalizeAcceptedComment, cancelAcceptedComment, removeAcceptedCommentItem, rethrowCommentAcceptanceError } from "./uploads/comment-acceptance";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };

type SubmissionRow = {
  id: string;
  context_kind: "sample" | "run_steps";
  sample_id: string | null;
  scope: "common" | "individual" | null;
  body: string;
  status: "draft" | "uploading" | "ready" | "failed" | "cancelled";
  actor_email: string | null;
  retry_until: string | null;
  retry_closed_at: string | null;
};

const MAX_COMMENT_UPLOAD_FAILURE_MESSAGE_LENGTH = 1_000;
const DEFAULT_COMMENT_UPLOAD_FAILURE_MESSAGE = "The upload did not reach the server";

function commentUploadFailureMessage(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HTTPException(400, { message: "Comment upload failure payload is invalid" });
  }
  const error = (input as Record<string, unknown>).error;
  if (error === undefined) return DEFAULT_COMMENT_UPLOAD_FAILURE_MESSAGE;
  if (typeof error !== "string"
    || error.length > MAX_COMMENT_UPLOAD_FAILURE_MESSAGE_LENGTH
    || error.includes("\u0000")) {
    throw new HTTPException(400, { message: "Comment upload failure payload is invalid" });
  }
  return error.trim() || DEFAULT_COMMENT_UPLOAD_FAILURE_MESSAGE;
}

function visibleSubmissionTargetsSql(alias: string) {
  return `(
    (
      ${alias}.context_kind = 'sample'
      AND EXISTS (
        SELECT 1 FROM samples s
        WHERE s.id = ${alias}.sample_id AND s.deleted_at IS NULL
      )
    )
    OR
    (
      ${alias}.context_kind = 'run_steps'
      AND EXISTS (
        SELECT 1 FROM comment_submission_targets cst
        WHERE cst.submission_id = ${alias}.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM comment_submission_targets cst
        LEFT JOIN samples s ON s.id = cst.sample_id
        LEFT JOIN runs r ON r.id = cst.run_id AND r.sample_id = cst.sample_id
        LEFT JOIN run_steps rs ON rs.id = cst.run_step_id AND rs.run_id = cst.run_id
        WHERE cst.submission_id = ${alias}.id
          AND (
            s.id IS NULL OR s.deleted_at IS NOT NULL
            OR r.id IS NULL OR r.deleted_at IS NOT NULL
            OR rs.id IS NULL OR rs.deleted_at IS NOT NULL
          )
      )
    )
  )`;
}

function readableSubmissionTargetsSql(alias: string) {
  return `(
    (
      ${alias}.context_kind = 'sample'
      AND EXISTS (
        SELECT 1 FROM samples s
        WHERE s.id = ${alias}.sample_id AND s.deleted_at IS NULL
      )
    )
    OR
    (
      ${alias}.context_kind = 'run_steps'
      AND EXISTS (
        SELECT 1
        FROM comment_submission_targets cst
        JOIN samples s ON s.id = cst.sample_id AND s.deleted_at IS NULL
        JOIN runs r ON r.id = cst.run_id AND r.sample_id = cst.sample_id
          AND r.deleted_at IS NULL
        JOIN run_steps rs ON rs.id = cst.run_step_id AND rs.run_id = cst.run_id
          AND rs.deleted_at IS NULL
        WHERE cst.submission_id = ${alias}.id
      )
    )
  )`;
}

async function ownedSubmission(c: Context<AppBindings>, id: string) {
  const submission = await c.env.DB.prepare(
    `SELECT id, context_kind, sample_id, scope, body, status, actor_email,
            retry_until, retry_closed_at
     FROM comment_submissions WHERE id = ? AND deleted_at IS NULL`,
  ).bind(id).first<SubmissionRow>();
  if (!submission) throw new HTTPException(404, { message: "Comment submission not found" });
  if (submission.actor_email && submission.actor_email !== c.get("userEmail")) {
    throw new HTTPException(403, { message: "Only the submission author can change an unfinished upload" });
  }
  return submission;
}

async function requireVisibleSubmissionTargets(
  c: Context<AppBindings>,
  submission: Pick<SubmissionRow, "context_kind" | "sample_id">,
  submissionId: string,
) {
  if (submission.context_kind === "sample") {
    const sample = submission.sample_id
      ? await c.env.DB.prepare("SELECT id FROM samples WHERE id = ? AND deleted_at IS NULL")
        .bind(submission.sample_id).first<{ id: string }>()
      : null;
    if (!sample) throw new HTTPException(409, { message: "The comment target is no longer available" });
    return;
  }
  const counts = await c.env.DB.prepare(
    `SELECT COUNT(*) AS target_count,
            COALESCE(SUM(CASE
              WHEN s.id IS NOT NULL AND s.deleted_at IS NULL
                AND r.id IS NOT NULL AND r.deleted_at IS NULL
                AND rs.id IS NOT NULL AND rs.deleted_at IS NULL
              THEN 1 ELSE 0 END), 0) AS visible_count
     FROM comment_submission_targets cst
     LEFT JOIN samples s ON s.id = cst.sample_id
     LEFT JOIN runs r ON r.id = cst.run_id AND r.sample_id = cst.sample_id
     LEFT JOIN run_steps rs ON rs.id = cst.run_step_id AND rs.run_id = cst.run_id
     WHERE cst.submission_id = ?`,
  ).bind(submissionId).first<{ target_count: number; visible_count: number }>();
  if (!counts || Number(counts.target_count) < 1
    || Number(counts.visible_count) !== Number(counts.target_count)) {
    throw new HTTPException(409, { message: "One or more comment targets are no longer available" });
  }
}

async function requireCommentItemDependency(
  c: Context<AppBindings>,
  submissionId: string,
  itemId: string,
  action: "delete" | "restore",
) {
  if (action === "delete") {
    const requiredOriginal = await c.env.DB.prepare(
      `SELECT image.original_filename, image.original_mime_type
       FROM comment_submission_items original
       JOIN comment_submission_items image
        ON image.submission_id = original.submission_id
        AND image.kind = 'comment_image'
        AND image.related_item_id = original.id
        AND image.status <> 'cancelled' AND image.deleted_at IS NULL
       WHERE original.id = ? AND original.submission_id = ? AND original.kind = 'attachment'
         AND original.deleted_at IS NULL`,
    ).bind(itemId, submissionId).first<{ original_filename: string; original_mime_type: string }>();
    if (requiredOriginal && isTiffMetadata(requiredOriginal.original_filename, requiredOriginal.original_mime_type)) {
      throw new HTTPException(409, { message: "The original TIFF is required while its comment preview is present" });
    }
    return;
  }

  const preview = await c.env.DB.prepare(
    `SELECT image.original_filename, image.original_mime_type,
            original.id AS original_id, original.status AS original_status,
            original.deleted_at AS original_deleted_at
     FROM comment_submission_items image
     LEFT JOIN comment_submission_items original
       ON original.id = image.related_item_id
       AND original.submission_id = image.submission_id
       AND original.kind = 'attachment'
     WHERE image.id = ? AND image.submission_id = ? AND image.kind = 'comment_image'`,
  ).bind(itemId, submissionId).first<{
    original_filename: string;
    original_mime_type: string;
    original_id: string | null;
    original_status: string | null;
    original_deleted_at: string | null;
  }>();
  if (preview && isTiffMetadata(preview.original_filename, preview.original_mime_type)
    && (!preview.original_id || preview.original_status !== "ready" || preview.original_deleted_at !== null)) {
    throw new HTTPException(409, { message: "Restore the original TIFF before restoring its comment preview" });
  }
}

async function markItemFailed(env: Env, submissionId: string, itemId: string, message: string) {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const retryDeadline = retryUntil(nowDate);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE comment_submission_items
       SET status = 'failed', error_message = ?, updated_at = ?
       WHERE id = ? AND submission_id = ? AND status NOT IN ('ready', 'cancelled')
         AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = comment_submission_items.submission_id
             AND cs.status <> 'cancelled' AND cs.retry_closed_at IS NULL
             AND cs.deleted_at IS NULL
         )`,
    ).bind(message.slice(0, 1_000), now, itemId, submissionId),
    env.DB.prepare(
      `UPDATE comment_submissions
       SET status = 'failed', error_message = ?, retry_until = ?, updated_at = ?
       WHERE id = ? AND status NOT IN ('ready', 'cancelled')
         AND retry_closed_at IS NULL AND deleted_at IS NULL`,
    ).bind("One or more files could not be uploaded", retryDeadline, now, submissionId),
  ]);
  return Boolean(results[1].meta.changes);
}

export const routes = new Hono<AppBindings>();

routes.get("/storage/status", async (c) => c.json(await managedStorageStatus(c.env)));

routes.post("/comment-submissions", (c) => createAcceptedComment(c).catch(rethrowCommentAcceptanceError));

routes.get("/comment-submissions/:submissionId/acceptance", (c) => acceptedComment(c).catch(rethrowCommentAcceptanceError));

routes.put("/comment-submissions/:submissionId/items/:itemId/content", (c) => uploadAcceptedCommentItem(c).catch(rethrowCommentAcceptanceError));

routes.post("/comment-submissions/:submissionId/items/:itemId/fail", async (c) => {
  const submissionId = c.req.param("submissionId");
  const itemId = c.req.param("itemId");
  const submission = await ownedSubmission(c, submissionId);
  if (await c.env.DB.prepare("SELECT 1 FROM comment_submission_acceptances WHERE submission_id = ?").bind(submissionId).first()) {
    throw new HTTPException(409, { message: "Check the accepted Comment upload before taking another action." });
  }
  if (submission.retry_closed_at || ["ready", "cancelled"].includes(submission.status)) {
    throw new HTTPException(409, { message: "This upload no longer accepts retry updates" });
  }
  const input = await c.req.json<unknown>().catch(() => null);
  const failureMessage = commentUploadFailureMessage(input);
  if (!await markItemFailed(
    c.env,
    submissionId,
    itemId,
    failureMessage,
  )) {
    throw new HTTPException(409, { message: "The retry window for this upload is closed" });
  }
  return c.json({ ok: true });
});

routes.delete("/comment-submissions/:submissionId/items/:itemId", async (c) => {
  const submissionId = c.req.param("submissionId");
  const itemId = c.req.param("itemId");
  const submission = await ownedSubmission(c, submissionId);
  if (submission.status !== "ready" && await c.env.DB.prepare("SELECT 1 FROM comment_submission_acceptances WHERE submission_id = ?").bind(submissionId).first()) {
    return removeAcceptedCommentItem(c).catch(rethrowCommentAcceptanceError);
  }
  if (submission.status === "cancelled") throw new HTTPException(409, { message: "Cancelled submissions cannot be changed" });
  await requireVisibleSubmissionTargets(c, submission, submissionId);
  await requireCommentItemDependency(c, submissionId, itemId, "delete");
  const now = new Date().toISOString();
  if (submission.status === "ready") {
    const result = await c.env.DB.prepare(
      `UPDATE comment_submission_items
       SET deleted_at = ?, deleted_by = ?, updated_at = ?
       WHERE id = ? AND submission_id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = comment_submission_items.submission_id
             AND cs.status = 'ready' AND cs.deleted_at IS NULL
             AND ${visibleSubmissionTargetsSql("cs")}
         )`,
    ).bind(now, c.get("userEmail"), now, itemId, submissionId).run();
    if (!result.meta.changes) {
      throw new HTTPException(409, { message: "The comment target changed while the attachment was being deleted" });
    }
    return c.json({ ok: true, updatedAt: now });
  }
  const result = await c.env.DB.prepare(
    `UPDATE comment_submission_items
     SET status = 'cancelled', error_message = NULL, updated_at = ?
     WHERE id = ? AND submission_id = ? AND status <> 'cancelled' AND deleted_at IS NULL`,
  ).bind(now, itemId, submissionId).run();
  if (!result.meta.changes) throw new HTTPException(404, { message: "Submission item not found" });
  const locators = await listItemBlobLocators(c.env.DB, submissionId, itemId);
  for (const locator of locators) {
    await markOrphanCandidate(c.env.DB, locator, crypto.randomUUID(), new Date(now));
  }
  return c.json({ ok: true });
});

routes.post("/comment-submissions/:submissionId/items/:itemId/restore", async (c) => {
  const submissionId = c.req.param("submissionId");
  const itemId = c.req.param("itemId");
  const submission = await ownedSubmission(c, submissionId);
  if (submission.status !== "ready") throw new HTTPException(409, { message: "Only completed comment attachments can be restored" });
  await requireVisibleSubmissionTargets(c, submission, submissionId);
  await requireCommentItemDependency(c, submissionId, itemId, "restore");
  const item = await c.env.DB.prepare(
    `SELECT csi.deleted_at
     FROM comment_submission_items csi
     JOIN comment_submissions cs ON cs.id = csi.submission_id
     WHERE csi.id = ? AND csi.submission_id = ? AND csi.deleted_at IS NOT NULL
       AND cs.status = 'ready' AND cs.deleted_at IS NULL`,
  ).bind(itemId, submissionId).first<{ deleted_at: string }>();
  if (!item) throw new HTTPException(404, { message: "Deleted attachment occurrence not found" });
  const now = new Date(Math.max(Date.now(), Date.parse(item.deleted_at) + 1)).toISOString();
  const result = await c.env.DB.prepare(
    `UPDATE comment_submission_items
     SET deleted_at = NULL, deleted_by = NULL, updated_at = ?
     WHERE id = ? AND submission_id = ? AND deleted_at = ?
       AND EXISTS (
         SELECT 1 FROM comment_submissions cs
         WHERE cs.id = comment_submission_items.submission_id
           AND cs.status = 'ready' AND cs.deleted_at IS NULL
           AND ${visibleSubmissionTargetsSql("cs")}
       )`,
  ).bind(now, itemId, submissionId, item.deleted_at).run();
  if (!result.meta.changes) {
    throw new HTTPException(409, { message: "The attachment changed while it was being restored" });
  }
  return c.json({ ok: true, updatedAt: now });
});

routes.post("/comment-submissions/:submissionId/finalize", (c) => finalizeAcceptedComment(c).catch(rethrowCommentAcceptanceError));

routes.post("/comment-submissions/:submissionId/cancel", (c) => cancelAcceptedComment(c).catch(rethrowCommentAcceptanceError));

routes.delete("/comment-submissions/:submissionId", async (c) => {
  const submissionId = c.req.param("submissionId");
  const submission = await c.env.DB.prepare(
    `SELECT id, context_kind, sample_id, scope, body, status, actor_email
     FROM comment_submissions WHERE id = ? AND deleted_at IS NULL`,
  ).bind(submissionId).first<SubmissionRow>();
  if (!submission || submission.status === "cancelled") throw new HTTPException(404, { message: "Comment not found" });
  if (submission.status !== "ready") throw new HTTPException(409, { message: "Use cancel for an unfinished upload" });
  await requireVisibleSubmissionTargets(c, submission, submissionId);
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const deletionOperationId = crypto.randomUUID();
  const submissionMutation = submission.context_kind === "sample" && submission.sample_id
    ? c.env.DB.prepare(
      `UPDATE comment_submissions
       SET deleted_at = ?, deleted_by = ?, deletion_operation_id = ?,
           last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND status = 'ready' AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM samples s
           WHERE s.id = comment_submissions.sample_id AND s.deleted_at IS NULL
         )`,
    ).bind(now, userEmail, deletionOperationId, deletionOperationId, now, submissionId)
    : c.env.DB.prepare(
      `UPDATE comment_submissions
       SET deleted_at = ?, deleted_by = ?, deletion_operation_id = ?,
           last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND status = 'ready' AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM comment_submission_targets cst
           WHERE cst.submission_id = comment_submissions.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM comment_submission_targets cst
           LEFT JOIN samples s ON s.id = cst.sample_id
           LEFT JOIN runs r ON r.id = cst.run_id AND r.sample_id = cst.sample_id
           LEFT JOIN run_steps rs ON rs.id = cst.run_step_id AND rs.run_id = cst.run_id
           WHERE cst.submission_id = comment_submissions.id
             AND (
               s.id IS NULL OR s.deleted_at IS NOT NULL
               OR r.id IS NULL OR r.deleted_at IS NOT NULL
               OR rs.id IS NULL OR rs.deleted_at IS NOT NULL
             )
         )`,
    ).bind(now, userEmail, deletionOperationId, deletionOperationId, now, submissionId);
  const statements: D1PreparedStatement[] = [submissionMutation];
  if (submission.context_kind === "sample" && submission.sample_id) {
    statements.push(c.env.DB.prepare(
      `UPDATE events
       SET metadata_json = json_set(metadata_json,
         '$.deletedAt', ?, '$.deletedBy', ?, '$.deletionOperationId', ?)
       WHERE sample_id = ? AND json_extract(metadata_json, '$.submissionId') = ?
         AND EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = ? AND cs.deletion_operation_id = ?
             AND cs.last_mutation_id = ?
         )`,
    ).bind(
      now,
      userEmail,
      deletionOperationId,
      submission.sample_id,
      submissionId,
      submissionId,
      deletionOperationId,
      deletionOperationId,
    ));
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'comment', ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM comment_submissions cs
         WHERE cs.id = ? AND cs.deletion_operation_id = ?
           AND cs.last_mutation_id = ?
       )`,
    ).bind(
      crypto.randomUUID(), submission.sample_id,
      `Deleted sample comment · ${submission.body || "Files attached"}`,
      JSON.stringify({ action: "comment_submission_deleted", submissionId }), userEmail, now,
      submissionId, deletionOperationId, deletionOperationId,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = ? AND cs.deletion_operation_id = ?
             AND cs.last_mutation_id = ?
         )`,
    )
      .bind(
        userEmail,
        now,
        submission.sample_id,
        submissionId,
        deletionOperationId,
        deletionOperationId,
      ));
  } else {
    const targets = await c.env.DB.prepare(
      `SELECT DISTINCT r.sample_id, rsc.run_step_id
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id AND rs.deleted_at IS NULL
       JOIN runs r ON r.id = rs.run_id AND r.deleted_at IS NULL
       JOIN samples s ON s.id = r.sample_id AND s.deleted_at IS NULL
       WHERE rsc.submission_id = ? AND rsc.deleted_at IS NULL`,
    ).bind(submissionId).all<{ sample_id: string; run_step_id: string }>();
    statements.push(c.env.DB.prepare(
      `UPDATE run_step_comments
       SET deleted_at = ?, deleted_by = ?, deletion_operation_id = ?,
           last_mutation_id = ?, updated_at = ?, updated_by = ?
       WHERE submission_id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = run_step_comments.submission_id
             AND cs.deletion_operation_id = ?
             AND cs.last_mutation_id = ?
         )`,
    ).bind(
      now,
      userEmail,
      deletionOperationId,
      deletionOperationId,
      now,
      userEmail,
      submissionId,
      deletionOperationId,
      deletionOperationId,
    ));
    for (const target of targets.results) statements.push(c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_comments rsc
           WHERE rsc.run_step_id = run_steps.id AND rsc.submission_id = ?
             AND rsc.deletion_operation_id = ? AND rsc.last_mutation_id = ?
         )`,
    ).bind(
      userEmail,
      now,
      target.run_step_id,
      submissionId,
      deletionOperationId,
      deletionOperationId,
    ));
    for (const sampleId of new Set(targets.results.map((target) => target.sample_id))) {
      statements.push(c.env.DB.prepare(
        `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
         SELECT ?, ?, 'comment', ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1
           FROM run_step_comments rsc
           JOIN run_steps rs ON rs.id = rsc.run_step_id
           JOIN runs r ON r.id = rs.run_id
           WHERE rsc.submission_id = ? AND r.sample_id = ?
             AND rsc.deletion_operation_id = ? AND rsc.last_mutation_id = ?
         )`,
      ).bind(
        crypto.randomUUID(), sampleId,
        `Deleted ${submission.scope === "common" ? "common " : ""}step comment · ${submission.body || "Files attached"}`,
        JSON.stringify({
          action: "comment_submission_deleted",
          submissionId,
          stepIds: targets.results.filter((target) => target.sample_id === sampleId).map((target) => target.run_step_id),
        }),
        userEmail,
        now,
        submissionId,
        sampleId,
        deletionOperationId,
        deletionOperationId,
      ));
      statements.push(c.env.DB.prepare(
        `UPDATE samples SET updated_by = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM run_step_comments rsc
             JOIN run_steps rs ON rs.id = rsc.run_step_id
             JOIN runs r ON r.id = rs.run_id
             WHERE rsc.submission_id = ? AND r.sample_id = samples.id
               AND rsc.deletion_operation_id = ? AND rsc.last_mutation_id = ?
           )`,
      )
        .bind(
          userEmail,
          now,
          sampleId,
          submissionId,
          deletionOperationId,
          deletionOperationId,
        ));
    }
  }
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "The comment changed while it was being deleted" });
  return c.json({ ok: true });
});

routes.post("/comment-submissions/:submissionId/restore", async (c) => {
  const submissionId = c.req.param("submissionId");
  const submission = await c.env.DB.prepare(
    `SELECT id, context_kind, sample_id, scope, body, status, deleted_at, deleted_by,
            deletion_operation_id
     FROM comment_submissions WHERE id = ? AND deleted_at IS NOT NULL`,
  ).bind(submissionId).first<SubmissionRow & {
    deleted_at: string;
    deleted_by: string | null;
    deletion_operation_id: string | null;
  }>();
  if (!submission) throw new HTTPException(404, { message: "Deleted comment not found" });
  if (submission.status !== "ready") throw new HTTPException(409, { message: "Only completed comments can be restored" });
  if (!submission.deletion_operation_id) {
    throw new HTTPException(409, { message: "This deleted Comment has no recoverable operation identity" });
  }
  await requireVisibleSubmissionTargets(c, submission, submissionId);
  const now = new Date(Math.max(Date.now(), Date.parse(submission.deleted_at) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const submissionMutation = submission.context_kind === "sample" && submission.sample_id
    ? c.env.DB.prepare(
      `UPDATE comment_submissions
       SET deleted_at = NULL, deleted_by = NULL, deletion_operation_id = NULL,
           last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND status = 'ready' AND deletion_operation_id = ?
         AND EXISTS (
           SELECT 1 FROM samples s
           WHERE s.id = comment_submissions.sample_id AND s.deleted_at IS NULL
         )`,
    ).bind(mutationId, now, submissionId, submission.deletion_operation_id)
    : c.env.DB.prepare(
      `UPDATE comment_submissions
       SET deleted_at = NULL, deleted_by = NULL, deletion_operation_id = NULL,
           last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND status = 'ready' AND deletion_operation_id = ?
         AND EXISTS (
           SELECT 1 FROM comment_submission_targets cst
           WHERE cst.submission_id = comment_submissions.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM comment_submission_targets cst
           LEFT JOIN samples s ON s.id = cst.sample_id
           LEFT JOIN runs r ON r.id = cst.run_id AND r.sample_id = cst.sample_id
           LEFT JOIN run_steps rs ON rs.id = cst.run_step_id AND rs.run_id = cst.run_id
           WHERE cst.submission_id = comment_submissions.id
             AND (
               s.id IS NULL OR s.deleted_at IS NOT NULL
               OR r.id IS NULL OR r.deleted_at IS NOT NULL
               OR rs.id IS NULL OR rs.deleted_at IS NOT NULL
             )
         )`,
    ).bind(mutationId, now, submissionId, submission.deletion_operation_id);
  const statements: D1PreparedStatement[] = [submissionMutation];
  if (submission.context_kind === "sample" && submission.sample_id) {
    statements.push(c.env.DB.prepare(
      `UPDATE events
       SET metadata_json = json_remove(
         metadata_json, '$.deletedAt', '$.deletedBy', '$.deletionOperationId'
       )
       WHERE sample_id = ? AND json_extract(metadata_json, '$.submissionId') = ?
         AND json_extract(metadata_json, '$.deletionOperationId') = ?
         AND EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = ? AND cs.deleted_at IS NULL
             AND cs.last_mutation_id = ?
         )`,
    ).bind(
      submission.sample_id,
      submissionId,
      submission.deletion_operation_id,
      submissionId,
      mutationId,
    ));
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, id, 'comment', ?, ?, ?, ? FROM samples
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = ? AND cs.deleted_at IS NULL
             AND cs.last_mutation_id = ?
         )`,
    ).bind(
      crypto.randomUUID(), submission.body || "Files attached",
      JSON.stringify({ action: "comment_submission_restored", submissionId }),
      userEmail, now, submission.sample_id, submissionId, mutationId,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = ? AND cs.deleted_at IS NULL
             AND cs.last_mutation_id = ?
         )`,
    ).bind(userEmail, now, submission.sample_id, submissionId, mutationId));
  } else {
    const targets = await c.env.DB.prepare(
      `SELECT DISTINCT r.sample_id, rsc.run_step_id
       FROM run_step_comments rsc
       JOIN run_steps rs ON rs.id = rsc.run_step_id AND rs.deleted_at IS NULL
       JOIN runs r ON r.id = rs.run_id AND r.deleted_at IS NULL
       JOIN samples s ON s.id = r.sample_id AND s.deleted_at IS NULL
       WHERE rsc.submission_id = ?
         AND rsc.deletion_operation_id = ?`,
    ).bind(
      submissionId,
      submission.deletion_operation_id,
    ).all<{ sample_id: string; run_step_id: string }>();
    statements.push(c.env.DB.prepare(
      `UPDATE run_step_comments
       SET deleted_at = NULL, deleted_by = NULL, deletion_operation_id = NULL,
           last_mutation_id = ?, updated_at = ?, updated_by = ?
       WHERE submission_id = ? AND deletion_operation_id = ?
         AND EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = run_step_comments.submission_id
             AND cs.deleted_at IS NULL AND cs.last_mutation_id = ?
         )
         AND EXISTS (
           SELECT 1 FROM run_steps rs
           JOIN runs r ON r.id = rs.run_id
           JOIN samples s ON s.id = r.sample_id
           WHERE rs.id = run_step_comments.run_step_id
             AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         )`,
    ).bind(
      mutationId,
      now,
      userEmail,
      submissionId,
      submission.deletion_operation_id,
      mutationId,
    ));
    for (const target of targets.results) statements.push(c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_comments rsc
           WHERE rsc.run_step_id = run_steps.id AND rsc.submission_id = ?
             AND rsc.deleted_at IS NULL AND rsc.last_mutation_id = ?
         )`,
    ).bind(userEmail, now, target.run_step_id, submissionId, mutationId));
    for (const sampleId of new Set(targets.results.map((target) => target.sample_id))) {
      const stepIds = targets.results
        .filter((target) => target.sample_id === sampleId)
        .map((target) => target.run_step_id);
      statements.push(c.env.DB.prepare(
        `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
         SELECT ?, ?, 'comment', ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1
           FROM run_step_comments rsc
           JOIN run_steps rs ON rs.id = rsc.run_step_id
           JOIN runs r ON r.id = rs.run_id
           WHERE rsc.submission_id = ? AND r.sample_id = ?
             AND rsc.deleted_at IS NULL AND rsc.last_mutation_id = ?
         )`,
      ).bind(
        crypto.randomUUID(), sampleId,
        `Restored ${submission.scope === "common" ? "common " : ""}step comment · ${submission.body || "Files attached"}`,
        JSON.stringify({ action: "comment_submission_restored", submissionId, stepIds }),
        userEmail, now, submissionId, sampleId, mutationId,
      ));
      statements.push(c.env.DB.prepare(
        `UPDATE samples SET updated_by = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM run_step_comments rsc
             JOIN run_steps rs ON rs.id = rsc.run_step_id
             JOIN runs r ON r.id = rs.run_id
             WHERE rsc.submission_id = ? AND r.sample_id = samples.id
               AND rsc.deleted_at IS NULL AND rsc.last_mutation_id = ?
           )`,
      ).bind(userEmail, now, sampleId, submissionId, mutationId));
    }
  }
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes) {
    throw new HTTPException(409, { message: "The comment changed while it was being restored" });
  }
  return c.json({ ok: true, updatedAt: now });
});

routes.get("/exports/attachments/:itemId", async (c) => {
  const itemId = c.req.param("itemId");
  const row = await c.env.DB.prepare(
    `SELECT COALESCE(csi.filename, mso.original_name, 'attachment') AS filename,
            mso.provider, mso.object_key, mso.mime_type
     FROM comment_submission_items csi
     JOIN managed_storage_objects mso ON mso.id = csi.storage_object_id AND mso.status = 'ready'
     WHERE csi.id = ? AND csi.kind = 'attachment' AND csi.status = 'ready'`,
  ).bind(itemId).first<{ filename: string; provider: string; object_key: string; mime_type: string }>();
  if (!row) throw new HTTPException(404, { message: "Export attachment not found" });
  const object = await getBlob(c.env, {
    storeKind: "managed", provider: row.provider, objectKey: row.object_key, blobRecordId: null,
  });
  if (object.outcome === "provider_unavailable") {
    throw new HTTPException(503, { message: "Attachment storage is unavailable" });
  }
  if (object.outcome === "missing") throw new HTTPException(404, { message: "Attachment object not found" });
  const fallback = row.filename.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
  const encoded = encodeURIComponent(row.filename);
  return new Response(object.body, {
    headers: {
      "content-type": object.contentType || row.mime_type,
      "content-disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...(object.etag ? { etag: object.etag } : {}),
    },
  });
});

routes.get("/attachments/:itemId/download", async (c) => {
  const itemId = c.req.param("itemId");
  const row = await c.env.DB.prepare(
    `SELECT csi.filename, mso.provider, mso.object_key, mso.mime_type
     FROM comment_submission_items csi
     JOIN managed_storage_objects mso ON mso.id = csi.storage_object_id AND mso.status = 'ready'
     JOIN comment_submissions cs ON cs.id = csi.submission_id
       AND cs.status = 'ready' AND cs.deleted_at IS NULL
     WHERE csi.id = ? AND csi.kind = 'attachment' AND csi.status = 'ready'
       AND csi.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM blob_integrity_quarantine biq
         WHERE biq.store_kind = 'managed' AND biq.provider = mso.provider
           AND biq.object_key = mso.object_key
       )
       AND ${readableSubmissionTargetsSql("cs")}`,
  ).bind(itemId).first<{ filename: string; provider: string; object_key: string; mime_type: string }>();
  if (!row) throw new HTTPException(404, { message: "Attachment not found" });
  const object = await getBlob(c.env, {
    storeKind: "managed", provider: row.provider, objectKey: row.object_key, blobRecordId: null,
  });
  if (object.outcome === "provider_unavailable") {
    throw new HTTPException(503, { message: "Attachment storage is unavailable" });
  }
  if (object.outcome === "missing") throw new HTTPException(404, { message: "Attachment object not found" });
  const fallback = row.filename.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
  const encoded = encodeURIComponent(row.filename);
  return new Response(object.body, {
    headers: {
      "content-type": object.contentType || row.mime_type,
      "content-disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...(object.etag ? { etag: object.etag } : {}),
    },
  });
});
