import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  MAX_COMMENT_IMAGE_UPLOAD_BYTES,
  MAX_MANAGED_ATTACHMENT_BYTES,
  requiresManagedStorage,
  validateCommentSubmissionInput,
  validSha256,
  validSubmissionId,
} from "../shared/comment-submissions";
import type {
  CommentSubmissionItemInput,
  CreateCommentSubmissionInput,
  RunStepTarget,
} from "../shared/types";
import { sha256Hex } from "../shared/content-addressing";
import { managedObjectKey, managedStorage, managedStorageStatus } from "./managed-storage";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };

type SubmissionRow = {
  id: string;
  context_kind: "sample" | "run_steps";
  sample_id: string | null;
  scope: "common" | "individual" | null;
  body: string;
  status: "draft" | "uploading" | "ready" | "failed" | "cancelled";
  actor_email: string | null;
};

type ItemRow = {
  id: string;
  submission_id: string;
  kind: "comment_image" | "attachment" | "link";
  status: "pending" | "uploading" | "ready" | "failed" | "cancelled";
  filename: string | null;
  mime_type: string | null;
  byte_size: number | null;
  asset_id: string | null;
  storage_object_id: string | null;
  actor_email: string | null;
};

function validTargets(value: unknown): value is RunStepTarget[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) return false;
  const ids = new Set<string>();
  return value.every((target) => {
    if (!target || typeof target !== "object") return false;
    const candidate = target as Partial<RunStepTarget>;
    if (!candidate.sampleId || !candidate.runId || !candidate.stepId || !candidate.expectedUpdatedAt
      || ids.has(candidate.stepId)) return false;
    ids.add(candidate.stepId);
    return true;
  });
}

function itemBindings(item: CommentSubmissionItemInput, submissionId: string, position: number, now: string) {
  if (item.kind === "comment_image") return [
    item.id, submissionId, item.kind, "pending", position,
    item.filename, item.mimeType, item.byteSize,
    item.originalFilename, item.originalMimeType, item.originalByteSize,
    null, null, null, now, now,
  ];
  if (item.kind === "attachment") return [
    item.id, submissionId, item.kind, "pending", position,
    item.filename, item.mimeType || "application/octet-stream", item.byteSize,
    item.filename, item.mimeType || "application/octet-stream", item.byteSize,
    item.title?.trim() || item.filename, null, null, now, now,
  ];
  return [
    item.id, submissionId, item.kind, "ready", position,
    null, null, null, null, null, null,
    item.title.trim(), item.description?.trim() || null, item.url, now, now,
  ];
}

async function ownedSubmission(c: Context<AppBindings>, id: string) {
  const submission = await c.env.DB.prepare(
    `SELECT id, context_kind, sample_id, scope, body, status, actor_email
     FROM comment_submissions WHERE id = ?`,
  ).bind(id).first<SubmissionRow>();
  if (!submission) throw new HTTPException(404, { message: "Comment submission not found" });
  if (submission.actor_email && submission.actor_email !== c.get("userEmail")) {
    throw new HTTPException(403, { message: "Only the submission author can change an unfinished upload" });
  }
  return submission;
}

async function markItemFailed(env: Env, submissionId: string, itemId: string, message: string) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE comment_submission_items
       SET status = 'failed', error_message = ?, updated_at = ?
       WHERE id = ? AND submission_id = ? AND status NOT IN ('ready', 'cancelled')
         AND EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = comment_submission_items.submission_id AND cs.status <> 'cancelled'
         )`,
    ).bind(message.slice(0, 1_000), now, itemId, submissionId),
    env.DB.prepare(
      `UPDATE comment_submissions
       SET status = 'failed', error_message = ?, updated_at = ?
       WHERE id = ? AND status NOT IN ('ready', 'cancelled')`,
    ).bind("One or more files could not be uploaded", now, submissionId),
  ]);
}

export const routes = new Hono<AppBindings>();

routes.get("/storage/status", (c) => c.json(managedStorageStatus(c.env)));

routes.post("/comment-submissions", async (c) => {
  const input = await c.req.json<CreateCommentSubmissionInput>().catch(() => null);
  const validationError = validateCommentSubmissionInput(input);
  if (validationError || !input) throw new HTTPException(400, { message: validationError || "Invalid comment submission" });
  if (requiresManagedStorage(input.items) && !managedStorage(c.env)) {
    throw new HTTPException(503, { message: managedStorageStatus(c.env).message });
  }
  if (input.context.kind === "run_steps" && !validTargets(input.context.targets)) {
    throw new HTTPException(400, { message: "Valid process-step targets are required" });
  }

  const existing = await c.env.DB.prepare(
    "SELECT id, actor_email FROM comment_submissions WHERE id = ?",
  ).bind(input.id).first<{ id: string; actor_email: string | null }>();
  if (existing) {
    if (existing.actor_email !== c.get("userEmail")) throw new HTTPException(409, { message: "Submission ID is already in use" });
    return c.json({ id: existing.id, deduplicated: true });
  }

  if (input.context.kind === "sample") {
    const sample = await c.env.DB.prepare("SELECT updated_at FROM samples WHERE id = ?")
      .bind(input.context.sampleId).first<{ updated_at: string }>();
    if (!sample) throw new HTTPException(404, { message: "Sample not found" });
    if (sample.updated_at !== input.context.expectedUpdatedAt) {
      throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before adding the comment." });
    }
  } else {
    const targets = input.context.targets;
    const rows = await c.env.DB.prepare(
      `SELECT rs.id, rs.updated_at, r.id AS run_id, r.sample_id
       FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       WHERE rs.id IN (${targets.map(() => "?").join(", ")})`,
    ).bind(...targets.map((target) => target.stepId)).all<{
      id: string; updated_at: string; run_id: string; sample_id: string;
    }>();
    const byId = new Map(rows.results.map((row) => [row.id, row]));
    if (targets.some((target) => {
      const row = byId.get(target.stepId);
      return !row || row.run_id !== target.runId || row.sample_id !== target.sampleId || row.updated_at !== target.expectedUpdatedAt;
    })) throw new HTTPException(409, { message: "One or more process steps changed before the comment was submitted." });
  }

  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const statements = [c.env.DB.prepare(
    `INSERT INTO comment_submissions
     (id, context_kind, sample_id, scope, body, status, actor_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'uploading', ?, ?, ?)`,
  ).bind(
    input.id,
    input.context.kind,
    input.context.kind === "sample" ? input.context.sampleId : null,
    input.context.kind === "run_steps" ? input.context.scope : null,
    input.body.trim(),
    userEmail,
    now,
    now,
  )];
  if (input.context.kind === "run_steps") {
    for (const target of input.context.targets) statements.push(c.env.DB.prepare(
      `INSERT INTO comment_submission_targets
       (submission_id, sample_id, run_id, run_step_id, expected_updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(input.id, target.sampleId, target.runId, target.stepId, target.expectedUpdatedAt));
  }
  for (const [position, item] of input.items.entries()) statements.push(c.env.DB.prepare(
    `INSERT INTO comment_submission_items
     (id, submission_id, kind, status, position, filename, mime_type, byte_size,
      original_filename, original_mime_type, original_byte_size, title, description,
      external_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(...itemBindings(item, input.id, position, now)));
  for (const item of input.items) {
    const relatedId = item.kind === "comment_image"
      ? item.relatedAttachmentId
      : item.kind === "attachment" ? item.relatedCommentImageId : undefined;
    if (relatedId) statements.push(c.env.DB.prepare(
      "UPDATE comment_submission_items SET related_item_id = ? WHERE id = ? AND submission_id = ?",
    ).bind(relatedId, item.id, input.id));
  }
  await c.env.DB.batch(statements);
  return c.json({ id: input.id, deduplicated: false }, 201);
});

routes.put("/comment-submissions/:submissionId/items/:itemId/content", async (c) => {
  const submissionId = c.req.param("submissionId");
  const itemId = c.req.param("itemId");
  if (!validSubmissionId(submissionId) || !validSubmissionId(itemId)) {
    throw new HTTPException(400, { message: "Invalid upload identifier" });
  }
  const submission = await ownedSubmission(c, submissionId);
  if (submission.status === "cancelled") throw new HTTPException(409, { message: "This upload was cancelled" });
  if (submission.status === "ready") return c.json({ ok: true, deduplicated: true });

  const item = await c.env.DB.prepare(
    `SELECT csi.id, csi.submission_id, csi.kind, csi.status, csi.filename, csi.mime_type,
            csi.byte_size, csi.asset_id, csi.storage_object_id, cs.actor_email
     FROM comment_submission_items csi
     JOIN comment_submissions cs ON cs.id = csi.submission_id
     WHERE csi.id = ? AND csi.submission_id = ?`,
  ).bind(itemId, submissionId).first<ItemRow>();
  if (!item) throw new HTTPException(404, { message: "Upload item not found" });
  if (item.kind === "link") throw new HTTPException(400, { message: "Link attachments do not receive file content" });
  if (item.status === "ready") return c.json({ ok: true, deduplicated: true });
  if (!c.req.raw.body || !item.filename || !item.mime_type || !item.byte_size) {
    throw new HTTPException(400, { message: "The upload body is missing" });
  }
  const declaredSize = Number(c.req.header("x-upload-size"));
  const contentType = c.req.header("content-type") || "application/octet-stream";
  if (declaredSize !== item.byte_size || contentType !== item.mime_type) {
    await markItemFailed(c.env, submissionId, itemId, "The uploaded file does not match the confirmed draft");
    throw new HTTPException(400, { message: "The uploaded file does not match the confirmed draft" });
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE comment_submission_items SET status = 'uploading', error_message = NULL, updated_at = ?
     WHERE id = ? AND submission_id = ? AND status <> 'ready'`,
  ).bind(now, itemId, submissionId).run();

  try {
    if (item.kind === "comment_image") {
      if (!contentType.startsWith("image/") || item.byte_size > MAX_COMMENT_IMAGE_UPLOAD_BYTES) {
        throw new HTTPException(415, { message: "Comment image content is invalid" });
      }
      const buffer = await c.req.arrayBuffer();
      if (buffer.byteLength !== item.byte_size) throw new HTTPException(400, { message: "Comment image size changed during upload" });
      const sha256 = await sha256Hex(buffer);
      const existing = await c.env.DB.prepare(
        "SELECT id, r2_key FROM assets WHERE sha256 = ? AND status = 'ready' LIMIT 1",
      ).bind(sha256).first<{ id: string; r2_key: string }>();
      let assetId = existing?.id;
      let deduplicated = Boolean(existing);
      if (!assetId) {
        const key = `comments/${submissionId}/${itemId}-${item.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        assetId = crypto.randomUUID();
        await c.env.ASSETS.put(key, buffer, { httpMetadata: { contentType } });
        try {
          await c.env.DB.prepare(
            `INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, actor_email, created_at, sha256)
             VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
          ).bind(assetId, key, item.filename, contentType, item.byte_size, c.get("userEmail"), now, sha256).run();
        } catch (error) {
          await c.env.ASSETS.delete(key);
          const winner = await c.env.DB.prepare(
            "SELECT id FROM assets WHERE sha256 = ? AND status = 'ready' LIMIT 1",
          ).bind(sha256).first<{ id: string }>();
          if (!winner) throw error;
          assetId = winner.id;
          deduplicated = true;
        }
      }
      await c.env.DB.prepare(
        `UPDATE comment_submission_items
         SET status = CASE
               WHEN EXISTS (
                 SELECT 1 FROM comment_submissions cs
                 WHERE cs.id = comment_submission_items.submission_id AND cs.status = 'cancelled'
               ) THEN 'cancelled' ELSE 'ready' END,
             asset_id = ?, sha256 = ?, error_message = NULL, updated_at = ?
         WHERE id = ? AND submission_id = ?`,
      ).bind(assetId, sha256, new Date().toISOString(), itemId, submissionId).run();
      const latest = await c.env.DB.prepare("SELECT status FROM comment_submissions WHERE id = ?")
        .bind(submissionId).first<{ status: string }>();
      if (latest?.status === "cancelled") throw new HTTPException(409, { message: "This upload was cancelled" });
      return c.json({ ok: true, deduplicated });
    }

    if (item.byte_size > MAX_MANAGED_ATTACHMENT_BYTES) throw new HTTPException(413, { message: "Managed attachments are limited to 100 MB" });
    const sha256 = c.req.header("x-content-sha256")?.toLowerCase();
    if (!validSha256(sha256)) throw new HTTPException(400, { message: "A SHA-256 content hash is required" });
    const storage = managedStorage(c.env);
    if (!storage) throw new HTTPException(503, { message: managedStorageStatus(c.env).message });
    const existing = await c.env.DB.prepare(
      `SELECT id FROM managed_storage_objects
       WHERE provider = ? AND sha256 = ? AND byte_size = ? AND status = 'ready' LIMIT 1`,
    ).bind(storage.provider, sha256, item.byte_size).first<{ id: string }>();
    let storageObjectId = existing?.id;
    let deduplicated = Boolean(existing);
    if (!storageObjectId) {
      storageObjectId = crypto.randomUUID();
      const key = managedObjectKey(submissionId, itemId, item.filename);
      const stored = await storage.put({
        key,
        body: c.req.raw.body,
        contentType,
        filename: item.filename,
        sha256,
      });
      if (stored.byteSize !== item.byte_size) {
        await storage.delete(key);
        throw new HTTPException(400, { message: "Attachment size changed during upload" });
      }
      try {
        await c.env.DB.prepare(
          `INSERT INTO managed_storage_objects
           (id, provider, object_key, original_name, mime_type, byte_size, sha256, status, actor_email, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
        ).bind(storageObjectId, storage.provider, key, item.filename, contentType, item.byte_size, sha256, c.get("userEmail"), now).run();
      } catch (error) {
        await storage.delete(key);
        const winner = await c.env.DB.prepare(
          `SELECT id FROM managed_storage_objects
           WHERE provider = ? AND sha256 = ? AND byte_size = ? AND status = 'ready' LIMIT 1`,
        ).bind(storage.provider, sha256, item.byte_size).first<{ id: string }>();
        if (!winner) throw error;
        storageObjectId = winner.id;
        deduplicated = true;
      }
    }
    await c.env.DB.prepare(
      `UPDATE comment_submission_items
       SET status = CASE
             WHEN EXISTS (
               SELECT 1 FROM comment_submissions cs
               WHERE cs.id = comment_submission_items.submission_id AND cs.status = 'cancelled'
             ) THEN 'cancelled' ELSE 'ready' END,
           storage_object_id = ?, sha256 = ?, error_message = NULL, updated_at = ?
       WHERE id = ? AND submission_id = ?`,
    ).bind(storageObjectId, sha256, new Date().toISOString(), itemId, submissionId).run();
    const latest = await c.env.DB.prepare("SELECT status FROM comment_submissions WHERE id = ?")
      .bind(submissionId).first<{ status: string }>();
    if (latest?.status === "cancelled") {
      await c.env.DB.prepare(
        `UPDATE managed_storage_objects SET status = 'orphaned', orphaned_at = ?
         WHERE id = ? AND status = 'ready'
           AND NOT EXISTS (
             SELECT 1 FROM comment_submission_items csi
             JOIN comment_submissions cs ON cs.id = csi.submission_id
             WHERE csi.storage_object_id = managed_storage_objects.id AND cs.status = 'ready'
           )`,
      ).bind(new Date().toISOString(), storageObjectId).run();
      throw new HTTPException(409, { message: "This upload was cancelled" });
    }
    return c.json({ ok: true, deduplicated });
  } catch (error) {
    const message = error instanceof HTTPException ? error.message : "The file upload failed";
    await markItemFailed(c.env, submissionId, itemId, message);
    throw error;
  }
});

routes.post("/comment-submissions/:submissionId/items/:itemId/fail", async (c) => {
  const submissionId = c.req.param("submissionId");
  const itemId = c.req.param("itemId");
  await ownedSubmission(c, submissionId);
  const input = await c.req.json<{ error?: string }>().catch((): { error?: string } => ({}));
  await markItemFailed(c.env, submissionId, itemId, input.error?.trim() || "The upload did not reach the server");
  return c.json({ ok: true });
});

routes.delete("/comment-submissions/:submissionId/items/:itemId", async (c) => {
  const submissionId = c.req.param("submissionId");
  const itemId = c.req.param("itemId");
  const submission = await ownedSubmission(c, submissionId);
  if (submission.status === "ready" || submission.status === "cancelled") {
    throw new HTTPException(409, { message: "Completed submissions cannot be changed" });
  }
  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(
    `UPDATE comment_submission_items
     SET status = 'cancelled', error_message = NULL, updated_at = ?
     WHERE id = ? AND submission_id = ? AND status <> 'cancelled'`,
  ).bind(now, itemId, submissionId).run();
  if (!result.meta.changes) throw new HTTPException(404, { message: "Submission item not found" });
  return c.json({ ok: true });
});

routes.post("/comment-submissions/:submissionId/finalize", async (c) => {
  const submissionId = c.req.param("submissionId");
  const submission = await ownedSubmission(c, submissionId);
  if (submission.status === "ready") return c.json({ ok: true, status: "ready" as const });
  if (submission.status === "cancelled") throw new HTTPException(409, { message: "This upload was cancelled" });
  const items = await c.env.DB.prepare(
    "SELECT status FROM comment_submission_items WHERE submission_id = ?",
  ).bind(submissionId).all<{ status: string }>();
  const unfinished = items.results.filter((item) => !["ready", "cancelled"].includes(item.status));
  if (unfinished.length) {
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE comment_submissions SET status = 'failed', error_message = ?, updated_at = ?
       WHERE id = ? AND status NOT IN ('ready', 'cancelled')`,
    ).bind("One or more files still require attention", now, submissionId).run();
    throw new HTTPException(409, { message: "One or more files still require attention" });
  }

  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const statements = [c.env.DB.prepare(
    `UPDATE comment_submissions
     SET status = 'ready', error_message = NULL, completed_at = ?, updated_at = ?
     WHERE id = ? AND status NOT IN ('ready', 'cancelled')`,
  ).bind(now, now, submissionId)];
  if (submission.context_kind === "sample" && submission.sample_id) {
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       VALUES (?, ?, 'comment', ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), submission.sample_id, submission.body,
      JSON.stringify({ action: "comment_submission", submissionId }), userEmail, now,
    ));
    statements.push(c.env.DB.prepare(
      "UPDATE samples SET updated_by = ?, updated_at = ? WHERE id = ?",
    ).bind(userEmail, now, submission.sample_id));
  } else {
    const targets = await c.env.DB.prepare(
      `SELECT sample_id, run_id, run_step_id
       FROM comment_submission_targets WHERE submission_id = ? ORDER BY run_step_id`,
    ).bind(submissionId).all<{ sample_id: string; run_id: string; run_step_id: string }>();
    const operationGroupId = targets.results.length > 1 ? crypto.randomUUID() : null;
    for (const target of targets.results) statements.push(c.env.DB.prepare(
      `INSERT INTO run_step_comments
       (id, run_step_id, scope, operation_group_id, body, submission_id, actor_email, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), target.run_step_id, submission.scope, operationGroupId, submission.body, submissionId, userEmail, now));
    for (const target of targets.results) statements.push(c.env.DB.prepare(
      "UPDATE run_steps SET updated_by = ?, updated_at = ? WHERE id = ? AND run_id = ?",
    ).bind(userEmail, now, target.run_step_id, target.run_id));
    for (const sampleId of new Set(targets.results.map((target) => target.sample_id))) {
      const stepIds = targets.results.filter((target) => target.sample_id === sampleId).map((target) => target.run_step_id);
      statements.push(c.env.DB.prepare(
        `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
         VALUES (?, ?, 'comment', ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), sampleId,
        `${submission.scope === "common" ? "Common step comment" : "Step comment"}: ${submission.body || "Files attached"}`,
        JSON.stringify({ action: "comment_submission", submissionId, scope: submission.scope, stepIds }),
        userEmail, now,
      ));
      statements.push(c.env.DB.prepare(
        "UPDATE samples SET updated_by = ?, updated_at = ? WHERE id = ?",
      ).bind(userEmail, now, sampleId));
    }
  }
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "This submission changed while it was being finalized" });
  return c.json({ ok: true, status: "ready" as const });
});

routes.post("/comment-submissions/:submissionId/cancel", async (c) => {
  const submissionId = c.req.param("submissionId");
  const submission = await ownedSubmission(c, submissionId);
  if (submission.status === "ready") throw new HTTPException(409, { message: "A completed comment cannot be cancelled" });
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE comment_submissions
       SET status = 'cancelled', error_message = NULL, cancelled_at = ?, updated_at = ?
       WHERE id = ? AND status <> 'ready'`,
    ).bind(now, now, submissionId),
    c.env.DB.prepare(
      `UPDATE comment_submission_items SET status = 'cancelled', updated_at = ?
       WHERE submission_id = ? AND status NOT IN ('ready', 'cancelled')`,
    ).bind(now, submissionId),
    c.env.DB.prepare(
      `UPDATE managed_storage_objects SET status = 'orphaned', orphaned_at = ?
       WHERE id IN (
         SELECT storage_object_id FROM comment_submission_items
         WHERE submission_id = ? AND storage_object_id IS NOT NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM comment_submission_items other
         JOIN comment_submissions cs ON cs.id = other.submission_id
         WHERE other.storage_object_id = managed_storage_objects.id
           AND other.submission_id <> ? AND cs.status = 'ready'
       )`,
    ).bind(now, submissionId, submissionId),
  ]);
  return c.json({ ok: true });
});

routes.delete("/comment-submissions/:submissionId", async (c) => {
  const submissionId = c.req.param("submissionId");
  const submission = await c.env.DB.prepare(
    `SELECT id, context_kind, sample_id, scope, body, status, actor_email
     FROM comment_submissions WHERE id = ?`,
  ).bind(submissionId).first<SubmissionRow>();
  if (!submission || submission.status === "cancelled") throw new HTTPException(404, { message: "Comment not found" });
  if (submission.status !== "ready") throw new HTTPException(409, { message: "Use cancel for an unfinished upload" });
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const statements = [c.env.DB.prepare(
    `UPDATE comment_submissions
     SET status = 'cancelled', cancelled_at = ?, updated_at = ?
     WHERE id = ? AND status = 'ready'`,
  ).bind(now, now, submissionId)];
  if (submission.context_kind === "sample" && submission.sample_id) {
    statements.push(c.env.DB.prepare(
      `UPDATE events
       SET metadata_json = json_set(metadata_json, '$.deletedAt', ?, '$.deletedBy', ?)
       WHERE sample_id = ? AND json_extract(metadata_json, '$.submissionId') = ?`,
    ).bind(now, userEmail, submission.sample_id, submissionId));
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       VALUES (?, ?, 'comment', ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), submission.sample_id,
      `Deleted sample comment · ${submission.body || "Files attached"}`,
      JSON.stringify({ action: "comment_submission_deleted", submissionId }), userEmail, now,
    ));
    statements.push(c.env.DB.prepare("UPDATE samples SET updated_by = ?, updated_at = ? WHERE id = ?")
      .bind(userEmail, now, submission.sample_id));
  } else {
    const targets = await c.env.DB.prepare(
      "SELECT DISTINCT sample_id, run_step_id FROM comment_submission_targets WHERE submission_id = ?",
    ).bind(submissionId).all<{ sample_id: string; run_step_id: string }>();
    statements.push(c.env.DB.prepare(
      "DELETE FROM run_step_comments WHERE submission_id = ?",
    ).bind(submissionId));
    for (const target of targets.results) statements.push(c.env.DB.prepare(
      "UPDATE run_steps SET updated_by = ?, updated_at = ? WHERE id = ?",
    ).bind(userEmail, now, target.run_step_id));
    for (const sampleId of new Set(targets.results.map((target) => target.sample_id))) {
      statements.push(c.env.DB.prepare(
        `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
         VALUES (?, ?, 'comment', ?, ?, ?, ?)`,
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
      ));
      statements.push(c.env.DB.prepare("UPDATE samples SET updated_by = ?, updated_at = ? WHERE id = ?")
        .bind(userEmail, now, sampleId));
    }
  }
  statements.push(c.env.DB.prepare(
    `UPDATE managed_storage_objects SET status = 'orphaned', orphaned_at = ?
     WHERE id IN (
       SELECT storage_object_id FROM comment_submission_items
       WHERE submission_id = ? AND storage_object_id IS NOT NULL
     )
     AND NOT EXISTS (
       SELECT 1 FROM comment_submission_items other
       JOIN comment_submissions cs ON cs.id = other.submission_id
       WHERE other.storage_object_id = managed_storage_objects.id
         AND other.submission_id <> ? AND cs.status = 'ready'
     )`,
  ).bind(now, submissionId, submissionId));
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "The comment changed while it was being deleted" });
  return c.json({ ok: true });
});

routes.get("/attachments/:itemId/download", async (c) => {
  const itemId = c.req.param("itemId");
  const row = await c.env.DB.prepare(
    `SELECT csi.filename, mso.provider, mso.object_key, mso.mime_type
     FROM comment_submission_items csi
     JOIN managed_storage_objects mso ON mso.id = csi.storage_object_id AND mso.status = 'ready'
     JOIN comment_submissions cs ON cs.id = csi.submission_id AND cs.status = 'ready'
     WHERE csi.id = ? AND csi.kind = 'attachment' AND csi.status = 'ready'`,
  ).bind(itemId).first<{ filename: string; provider: string; object_key: string; mime_type: string }>();
  if (!row) throw new HTTPException(404, { message: "Attachment not found" });
  const storage = managedStorage(c.env);
  if (!storage || storage.provider !== row.provider) throw new HTTPException(503, { message: "Attachment storage is unavailable" });
  const object = await storage.get(row.object_key);
  if (!object) throw new HTTPException(404, { message: "Attachment object not found" });
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
