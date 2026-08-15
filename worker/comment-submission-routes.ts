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
import {
  listItemBlobLocators,
  listSubmissionBlobLocators,
  markOrphanCandidate,
  retryUntil,
} from "./blob-lifecycle/reachability";
import {
  BlobReuseProviderUnavailableError,
  findReusableManagedObject,
  findReusableR2Asset,
} from "./blob-lifecycle/reuse";
import {
  reconcileCommittedManagedObject,
  reconcileR2RegistrationFailure,
} from "./blob-lifecycle/registration";
import type { Env } from "./types";
import { isTiffMetadata } from "../shared/tiff";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };

async function reusableCommentR2Asset(env: Env, sha256: string) {
  try {
    return await findReusableR2Asset(env, sha256);
  } catch (error) {
    if (error instanceof BlobReuseProviderUnavailableError) {
      throw new HTTPException(503, { message: error.message });
    }
    throw error;
  }
}

async function reusableCommentManagedObject(
  env: Env,
  provider: string,
  sha256: string,
  byteSize: number,
) {
  try {
    return await findReusableManagedObject(env, provider, sha256, byteSize);
  } catch (error) {
    if (error instanceof BlobReuseProviderUnavailableError) {
      throw new HTTPException(503, { message: error.message });
    }
    throw error;
  }
}

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

async function managedKeyForSubmission(
  env: Env,
  submission: SubmissionRow,
  submissionId: string,
  itemId: string,
  filename: string,
) {
  if (submission.sample_id) {
    const sample = await env.DB.prepare("SELECT id, code FROM samples WHERE id = ? AND deleted_at IS NULL")
      .bind(submission.sample_id).first<{ id: string; code: string }>();
    return managedObjectKey(submissionId, itemId, filename, sample ?? undefined);
  }
  const samples = await env.DB.prepare(
    `SELECT DISTINCT s.id, s.code
     FROM comment_submission_targets cst
     JOIN samples s ON s.id = cst.sample_id AND s.deleted_at IS NULL
     WHERE cst.submission_id = ?
     ORDER BY s.code, s.id
     LIMIT 2`,
  ).bind(submissionId).all<{ id: string; code: string }>();
  return managedObjectKey(
    submissionId,
    itemId,
    filename,
    samples.results.length === 1 ? samples.results[0] : undefined,
  );
}

export const routes = new Hono<AppBindings>();

routes.get("/storage/status", async (c) => c.json(await managedStorageStatus(c.env)));

routes.post("/comment-submissions", async (c) => {
  const input = await c.req.json<CreateCommentSubmissionInput>().catch(() => null);
  const validationError = validateCommentSubmissionInput(input);
  if (validationError || !input) throw new HTTPException(400, { message: validationError || "Invalid comment submission" });
  if (requiresManagedStorage(input.items)) {
    const storageStatus = await managedStorageStatus(c.env);
    if (!storageStatus.available) {
      throw new HTTPException(503, { message: storageStatus.message });
    }
  }
  if (input.context.kind === "run_steps" && !validTargets(input.context.targets)) {
    throw new HTTPException(400, { message: "Valid process-step targets are required" });
  }

  const existing = await c.env.DB.prepare(
    "SELECT id, actor_email, deleted_at FROM comment_submissions WHERE id = ?",
  ).bind(input.id).first<{ id: string; actor_email: string | null; deleted_at: string | null }>();
  if (existing) {
    if (existing.deleted_at) throw new HTTPException(409, { message: "Submission ID belongs to a deleted comment" });
    if (existing.actor_email !== c.get("userEmail")) throw new HTTPException(409, { message: "Submission ID is already in use" });
    return c.json({ id: existing.id, deduplicated: true });
  }

  if (input.context.kind === "sample") {
    const sample = await c.env.DB.prepare("SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL")
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
       JOIN samples s ON s.id = r.sample_id
       WHERE rs.id IN (${targets.map(() => "?").join(", ")})
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
    ).bind(...targets.map((target) => target.stepId)).all<{
      id: string; updated_at: string; run_id: string; sample_id: string;
    }>();
    const byId = new Map(rows.results.map((row) => [row.id, row]));
    if (targets.some((target) => {
      const row = byId.get(target.stepId);
      return !row || row.run_id !== target.runId || row.sample_id !== target.sampleId || row.updated_at !== target.expectedUpdatedAt;
    })) throw new HTTPException(409, { message: "One or more process steps changed before the comment was submitted." });
  }

  const nowDate = new Date();
  const now = nowDate.toISOString();
  const retryDeadline = retryUntil(nowDate);
  const userEmail = c.get("userEmail");
  const submissionMutation = input.context.kind === "sample"
    ? c.env.DB.prepare(
      `INSERT OR IGNORE INTO comment_submissions
       (id, context_kind, sample_id, scope, body, status, actor_email,
        created_at, updated_at, retry_until)
       SELECT ?, 'sample', s.id, NULL, ?, 'uploading', ?, ?, ?, ?
       FROM samples s
       WHERE s.id = ? AND s.updated_at = ? AND s.deleted_at IS NULL`,
    ).bind(
      input.id,
      input.body.trim(),
      userEmail,
      now,
      now,
      retryDeadline,
      input.context.sampleId,
      input.context.expectedUpdatedAt,
    )
    : c.env.DB.prepare(
      `WITH requested(sample_id, run_id, step_id, expected_updated_at) AS (
         VALUES ${input.context.targets.map(() => "(?, ?, ?, ?)").join(", ")}
       ),
       valid AS (
         SELECT q.step_id
         FROM requested q
         JOIN samples s ON s.id = q.sample_id AND s.deleted_at IS NULL
         JOIN runs r ON r.id = q.run_id AND r.sample_id = q.sample_id
           AND r.deleted_at IS NULL
         JOIN run_steps rs ON rs.id = q.step_id AND rs.run_id = q.run_id
           AND rs.deleted_at IS NULL
         WHERE rs.updated_at = q.expected_updated_at
       )
       INSERT OR IGNORE INTO comment_submissions
       (id, context_kind, sample_id, scope, body, status, actor_email,
        created_at, updated_at, retry_until)
       SELECT ?, 'run_steps', NULL, ?, ?, 'uploading', ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM valid) = ?`,
    ).bind(
      ...input.context.targets.flatMap((target) => [
        target.sampleId,
        target.runId,
        target.stepId,
        target.expectedUpdatedAt,
      ]),
      input.id,
      input.context.scope,
      input.body.trim(),
      userEmail,
      now,
      now,
      retryDeadline,
      input.context.targets.length,
    );
  const statements = [submissionMutation];
  if (input.context.kind === "run_steps") {
    for (const target of input.context.targets) statements.push(c.env.DB.prepare(
      `INSERT INTO comment_submission_targets
       (submission_id, sample_id, run_id, run_step_id, expected_updated_at)
       SELECT ?, s.id, r.id, rs.id, ?
       FROM comment_submissions cs
       JOIN samples s ON s.id = ? AND s.deleted_at IS NULL
       JOIN runs r ON r.id = ? AND r.sample_id = s.id AND r.deleted_at IS NULL
       JOIN run_steps rs ON rs.id = ? AND rs.run_id = r.id AND rs.deleted_at IS NULL
       WHERE cs.id = ? AND cs.status = 'uploading'
         AND rs.updated_at = ?`,
    ).bind(
      input.id,
      target.expectedUpdatedAt,
      target.sampleId,
      target.runId,
      target.stepId,
      input.id,
      target.expectedUpdatedAt,
    ));
  }
  for (const [position, item] of input.items.entries()) statements.push(c.env.DB.prepare(
    `INSERT INTO comment_submission_items
     (id, submission_id, kind, status, position, filename, mime_type, byte_size,
      original_filename, original_mime_type, original_byte_size, title, description,
      external_url, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM comment_submissions cs
       WHERE cs.id = ? AND cs.status = 'uploading' AND cs.deleted_at IS NULL
     )`,
  ).bind(...itemBindings(item, input.id, position, now), input.id));
  for (const item of input.items) {
    const relatedId = item.kind === "comment_image"
      ? item.relatedAttachmentId
      : item.kind === "attachment" ? item.relatedCommentImageId : undefined;
    if (relatedId) statements.push(c.env.DB.prepare(
      "UPDATE comment_submission_items SET related_item_id = ? WHERE id = ? AND submission_id = ?",
    ).bind(relatedId, item.id, input.id));
  }
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes) {
    throw new HTTPException(409, {
      message: "The comment target changed before the upload submission was created",
    });
  }
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
  if (submission.retry_closed_at) {
    throw new HTTPException(409, { message: "The retry window for this upload is closed" });
  }

  const item = await c.env.DB.prepare(
    `SELECT csi.id, csi.submission_id, csi.kind, csi.status, csi.filename, csi.mime_type,
            csi.byte_size, csi.asset_id, csi.storage_object_id, cs.actor_email
     FROM comment_submission_items csi
     JOIN comment_submissions cs ON cs.id = csi.submission_id
     WHERE csi.id = ? AND csi.submission_id = ?
       AND csi.deleted_at IS NULL AND cs.deleted_at IS NULL`,
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
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const retryDeadline = retryUntil(nowDate);
  const retryResults = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE comment_submissions
       SET status = 'uploading', error_message = NULL, retry_until = ?, updated_at = ?
       WHERE id = ? AND status NOT IN ('ready', 'cancelled')
         AND retry_closed_at IS NULL AND deleted_at IS NULL`,
    ).bind(retryDeadline, now, submissionId),
    c.env.DB.prepare(
      `UPDATE comment_submission_items
       SET status = 'uploading', error_message = NULL, updated_at = ?
       WHERE id = ? AND submission_id = ? AND status <> 'ready' AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = comment_submission_items.submission_id
             AND cs.status = 'uploading' AND cs.retry_until = ?
             AND cs.retry_closed_at IS NULL
         )`,
    ).bind(now, itemId, submissionId, retryDeadline),
  ]);
  if (!retryResults[0].meta.changes || !retryResults[1].meta.changes) {
    throw new HTTPException(409, { message: "This upload changed before the retry could start" });
  }

  try {
    if (item.kind === "comment_image") {
      if (!contentType.startsWith("image/") || item.byte_size > MAX_COMMENT_IMAGE_UPLOAD_BYTES) {
        throw new HTTPException(415, { message: "Comment image content is invalid" });
      }
      const buffer = await c.req.arrayBuffer();
      if (buffer.byteLength !== item.byte_size) throw new HTTPException(400, { message: "Comment image size changed during upload" });
      const sha256 = await sha256Hex(buffer);
      let asset = await reusableCommentR2Asset(c.env, sha256);
      let deduplicated = Boolean(asset);
      if (!asset) {
        const key = `comments/${submissionId}/${itemId}-${item.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        const assetId = crypto.randomUUID();
        await c.env.ASSETS.put(key, buffer, { httpMetadata: { contentType } });
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await c.env.DB.prepare(
              `INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, actor_email, created_at, sha256)
               VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
            ).bind(assetId, key, item.filename, contentType, item.byte_size, c.get("userEmail"), now, sha256).run();
            asset = {
              id: assetId,
              r2_key: key,
              original_name: item.filename,
              mime_type: contentType,
              byte_size: item.byte_size,
              sha256,
            };
            break;
          } catch (error) {
            let resolution;
            try {
              resolution = await reconcileR2RegistrationFailure(c.env, {
                id: assetId,
                objectKey: key,
                sha256,
                findWinner: () => reusableCommentR2Asset(c.env, sha256),
              });
            } catch (verificationError) {
              await c.env.ASSETS.delete(key);
              throw verificationError;
            }
            if (resolution) {
              asset = resolution.asset;
              deduplicated = resolution.deduplicated;
              break;
            }
            if (attempt === 1) {
              await c.env.ASSETS.delete(key);
              throw error;
            }
          }
        }
      }
      if (!asset) throw new HTTPException(409, { message: "Comment image registration could not be reconciled" });
      await c.env.DB.prepare(
        `UPDATE comment_submission_items
         SET status = CASE
               WHEN EXISTS (
                 SELECT 1 FROM comment_submissions cs
                 WHERE cs.id = comment_submission_items.submission_id AND cs.status = 'cancelled'
               ) THEN 'cancelled' ELSE 'ready' END,
             asset_id = ?, sha256 = ?, error_message = NULL, updated_at = ?
         WHERE id = ? AND submission_id = ? AND deleted_at IS NULL`,
      ).bind(asset.id, sha256, new Date().toISOString(), itemId, submissionId).run();
      const latest = await c.env.DB.prepare(
        "SELECT status FROM comment_submissions WHERE id = ? AND deleted_at IS NULL",
      )
        .bind(submissionId).first<{ status: string }>();
      if (latest?.status === "cancelled") {
        const locators = await listItemBlobLocators(c.env.DB, submissionId, itemId);
        for (const locator of locators) {
          await markOrphanCandidate(c.env.DB, locator, crypto.randomUUID(), new Date());
        }
        throw new HTTPException(409, { message: "This upload was cancelled" });
      }
      return c.json({ ok: true, deduplicated });
    }

    if (item.byte_size > MAX_MANAGED_ATTACHMENT_BYTES) throw new HTTPException(413, { message: "Managed attachments are limited to 100 MB" });
    const sha256 = c.req.header("x-content-sha256")?.toLowerCase();
    if (!validSha256(sha256)) throw new HTTPException(400, { message: "A SHA-256 content hash is required" });
    const storage = managedStorage(c.env);
    if (!storage) throw new HTTPException(503, { message: "Managed attachment storage is not configured" });
    let storageObject = await reusableCommentManagedObject(
      c.env,
      storage.provider,
      sha256,
      item.byte_size,
    );
    let deduplicated = Boolean(storageObject);
    if (!storageObject) {
      const storageObjectId = crypto.randomUUID();
      const key = await managedKeyForSubmission(c.env, submission, submissionId, itemId, item.filename);
      const stored = await storage.put({
        key,
        body: c.req.raw.body,
        contentType,
        filename: item.filename,
        sha256,
        byteSize: item.byte_size,
      });
      if (stored.byteSize !== item.byte_size) {
        await storage.delete(key);
        throw new HTTPException(400, { message: "Attachment size changed during upload" });
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await c.env.DB.prepare(
            `INSERT INTO managed_storage_objects
             (id, provider, object_key, original_name, mime_type, byte_size, sha256, status, actor_email, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
          ).bind(storageObjectId, storage.provider, key, item.filename, contentType, item.byte_size, sha256, c.get("userEmail"), now).run();
          storageObject = {
            id: storageObjectId,
            provider: storage.provider,
            object_key: key,
            original_name: item.filename,
            mime_type: contentType,
            byte_size: item.byte_size,
            sha256,
          };
          break;
        } catch (error) {
          const committed = await reconcileCommittedManagedObject(c.env.DB, {
            id: storageObjectId,
            provider: storage.provider,
            objectKey: key,
            sha256,
            byteSize: item.byte_size,
          });
          if (committed) {
            storageObject = committed;
            deduplicated = false;
            break;
          }

          let winner;
          try {
            winner = await reusableCommentManagedObject(
              c.env,
              storage.provider,
              sha256,
              item.byte_size,
            );
          } catch (verificationError) {
            await storage.delete(key);
            throw verificationError;
          }
          if (winner) {
            await storage.delete(key);
            storageObject = winner;
            deduplicated = true;
            break;
          }
          if (attempt === 1) {
            await storage.delete(key);
            throw error;
          }
        }
      }
    }
    if (!storageObject) throw new HTTPException(409, { message: "Managed attachment registration could not be reconciled" });
    await c.env.DB.prepare(
      `UPDATE comment_submission_items
       SET status = CASE
             WHEN EXISTS (
               SELECT 1 FROM comment_submissions cs
               WHERE cs.id = comment_submission_items.submission_id AND cs.status = 'cancelled'
             ) THEN 'cancelled' ELSE 'ready' END,
           storage_object_id = ?, sha256 = ?, error_message = NULL, updated_at = ?
       WHERE id = ? AND submission_id = ? AND deleted_at IS NULL`,
    ).bind(storageObject.id, sha256, new Date().toISOString(), itemId, submissionId).run();
    const latest = await c.env.DB.prepare(
      "SELECT status FROM comment_submissions WHERE id = ? AND deleted_at IS NULL",
    )
      .bind(submissionId).first<{ status: string }>();
    if (latest?.status === "cancelled") {
      const locators = await listItemBlobLocators(c.env.DB, submissionId, itemId);
      for (const locator of locators) {
        await markOrphanCandidate(c.env.DB, locator, crypto.randomUUID(), new Date());
      }
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
  const submission = await ownedSubmission(c, submissionId);
  if (submission.retry_closed_at || ["ready", "cancelled"].includes(submission.status)) {
    throw new HTTPException(409, { message: "This upload no longer accepts retry updates" });
  }
  const input = await c.req.json<{ error?: string }>().catch((): { error?: string } => ({}));
  if (!await markItemFailed(
    c.env,
    submissionId,
    itemId,
    input.error?.trim() || "The upload did not reach the server",
  )) {
    throw new HTTPException(409, { message: "The retry window for this upload is closed" });
  }
  return c.json({ ok: true });
});

routes.delete("/comment-submissions/:submissionId/items/:itemId", async (c) => {
  const submissionId = c.req.param("submissionId");
  const itemId = c.req.param("itemId");
  const submission = await ownedSubmission(c, submissionId);
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

routes.post("/comment-submissions/:submissionId/finalize", async (c) => {
  const submissionId = c.req.param("submissionId");
  const submission = await ownedSubmission(c, submissionId);
  if (submission.status === "ready") return c.json({ ok: true, status: "ready" as const });
  if (submission.status === "cancelled") throw new HTTPException(409, { message: "This upload was cancelled" });
  if (submission.retry_closed_at) {
    throw new HTTPException(409, { message: "The retry window for this upload is closed" });
  }
  const items = await c.env.DB.prepare(
    "SELECT status FROM comment_submission_items WHERE submission_id = ? AND deleted_at IS NULL",
  ).bind(submissionId).all<{ status: string }>();
  const unfinished = items.results.filter((item) => !["ready", "cancelled"].includes(item.status));
  if (unfinished.length) {
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE comment_submissions SET status = 'failed', error_message = ?, updated_at = ?
       WHERE id = ? AND status NOT IN ('ready', 'cancelled') AND deleted_at IS NULL`,
    ).bind("One or more files still require attention", now, submissionId).run();
    throw new HTTPException(409, { message: "One or more files still require attention" });
  }

  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const statements = [c.env.DB.prepare(
    `UPDATE comment_submissions
     SET status = 'ready', error_message = NULL, completed_at = ?, updated_at = ?,
         last_mutation_id = ?, retry_closed_at = ?, retry_closed_by = ?
     WHERE id = ? AND status NOT IN ('ready', 'cancelled') AND deleted_at IS NULL
       AND retry_closed_at IS NULL
       AND ${visibleSubmissionTargetsSql("comment_submissions")}`,
  ).bind(now, now, mutationId, now, userEmail, submissionId)];
  if (submission.context_kind === "sample" && submission.sample_id) {
    const sample = await c.env.DB.prepare(
      "SELECT id FROM samples WHERE id = ? AND deleted_at IS NULL",
    ).bind(submission.sample_id).first<{ id: string }>();
    if (!sample) throw new HTTPException(409, { message: "The target sample is no longer available" });
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, s.id, 'comment', ?, ?, ?, ?
       FROM samples s JOIN comment_submissions cs ON cs.sample_id = s.id
       WHERE s.id = ? AND s.deleted_at IS NULL
         AND cs.id = ? AND cs.last_mutation_id = ?`,
    ).bind(
      crypto.randomUUID(), submission.body,
      JSON.stringify({ action: "comment_submission", submissionId }), userEmail, now,
      submission.sample_id, submissionId, mutationId,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = ? AND cs.last_mutation_id = ?
         )`,
    ).bind(userEmail, now, submission.sample_id, submissionId, mutationId));
  } else {
    const [targets, targetCount] = await Promise.all([
      c.env.DB.prepare(
        `SELECT cst.sample_id, cst.run_id, cst.run_step_id
         FROM comment_submission_targets cst
         JOIN run_steps rs ON rs.id = cst.run_step_id AND rs.run_id = cst.run_id
         JOIN runs r ON r.id = cst.run_id AND r.sample_id = cst.sample_id
         JOIN samples s ON s.id = cst.sample_id
         WHERE cst.submission_id = ?
           AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         ORDER BY cst.run_step_id`,
      ).bind(submissionId).all<{ sample_id: string; run_id: string; run_step_id: string }>(),
      c.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM comment_submission_targets WHERE submission_id = ?",
      ).bind(submissionId).first<{ count: number }>(),
    ]);
    if (targets.results.length !== Number(targetCount?.count ?? 0)) {
      throw new HTTPException(409, { message: "A target run was moved to trash before this comment was finalized." });
    }
    const operationGroupId = targets.results.length > 1 ? crypto.randomUUID() : null;
    const occurrenceTargets = targets.results.map((target) => ({
      ...target,
      occurrenceId: crypto.randomUUID(),
    }));
    for (const target of occurrenceTargets) statements.push(c.env.DB.prepare(
      `INSERT INTO run_step_comments
       (id, run_step_id, scope, operation_group_id, body, submission_id, actor_email, created_at)
       SELECT ?, rs.id, ?, ?, ?, ?, ?, ?
       FROM comment_submission_targets cst
       JOIN run_steps rs ON rs.id = cst.run_step_id AND rs.run_id = cst.run_id
       JOIN runs r ON r.id = cst.run_id AND r.sample_id = cst.sample_id
       JOIN samples s ON s.id = cst.sample_id
       JOIN comment_submissions cs ON cs.id = cst.submission_id
       WHERE cst.submission_id = ? AND cst.run_step_id = ?
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         AND cs.last_mutation_id = ?`,
    ).bind(
      target.occurrenceId,
      submission.scope,
      operationGroupId,
      submission.body,
      submissionId,
      userEmail,
      now,
      submissionId,
      target.run_step_id,
      mutationId,
    ));
    for (const target of occurrenceTargets) statements.push(c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id = ? AND run_id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_comments rsc
           WHERE rsc.id = ? AND rsc.run_step_id = run_steps.id
             AND rsc.submission_id = ? AND rsc.deleted_at IS NULL
         )`,
    ).bind(userEmail, now, target.run_step_id, target.run_id, target.occurrenceId, submissionId));
    for (const sampleId of new Set(occurrenceTargets.map((target) => target.sample_id))) {
      const sampleTargets = occurrenceTargets.filter((target) => target.sample_id === sampleId);
      const stepIds = sampleTargets.map((target) => target.run_step_id);
      const occurrenceIds = sampleTargets.map((target) => target.occurrenceId);
      const occurrencePlaceholders = occurrenceIds.map(() => "?").join(", ");
      statements.push(c.env.DB.prepare(
        `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
         SELECT ?, ?, 'comment', ?, ?, ?, ?
         WHERE (
           SELECT COUNT(*) FROM run_step_comments rsc
           WHERE rsc.id IN (${occurrencePlaceholders})
             AND rsc.submission_id = ? AND rsc.deleted_at IS NULL
         ) = ?
           AND EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = ? AND cs.last_mutation_id = ?
           )`,
      ).bind(
        crypto.randomUUID(), sampleId,
        `${submission.scope === "common" ? "Common step comment" : "Step comment"}: ${submission.body || "Files attached"}`,
        JSON.stringify({ action: "comment_submission", submissionId, scope: submission.scope, stepIds }),
        userEmail, now,
        ...occurrenceIds,
        submissionId,
        occurrenceIds.length,
        submissionId,
        mutationId,
      ));
      statements.push(c.env.DB.prepare(
        `UPDATE samples SET updated_by = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL
           AND (
             SELECT COUNT(*) FROM run_step_comments rsc
             WHERE rsc.id IN (${occurrencePlaceholders})
               AND rsc.submission_id = ? AND rsc.deleted_at IS NULL
           ) = ?
           AND EXISTS (
             SELECT 1 FROM comment_submissions cs
             WHERE cs.id = ? AND cs.last_mutation_id = ?
           )`,
      ).bind(
        userEmail,
        now,
        sampleId,
        ...occurrenceIds,
        submissionId,
        occurrenceIds.length,
        submissionId,
        mutationId,
      ));
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
  const mutationId = crypto.randomUUID();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE comment_submissions
       SET status = 'cancelled', error_message = NULL, cancelled_at = ?,
           last_mutation_id = ?, retry_closed_at = ?, retry_closed_by = ?, updated_at = ?
       WHERE id = ? AND status NOT IN ('ready', 'cancelled')
         AND retry_closed_at IS NULL AND deleted_at IS NULL`,
    ).bind(now, mutationId, now, c.get("userEmail"), now, submissionId),
    c.env.DB.prepare(
      `UPDATE comment_submission_items SET status = 'cancelled', updated_at = ?
       WHERE submission_id = ? AND status NOT IN ('ready', 'cancelled')
         AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM comment_submissions cs
           WHERE cs.id = comment_submission_items.submission_id
             AND cs.status = 'cancelled' AND cs.last_mutation_id = ?
         )`,
    ).bind(now, submissionId, mutationId),
  ]);
  if (!results[0].meta.changes) {
    throw new HTTPException(409, { message: "This submission changed while it was being cancelled" });
  }
  const locators = await listSubmissionBlobLocators(c.env.DB, submissionId);
  for (const locator of locators) {
    await markOrphanCandidate(c.env.DB, locator, crypto.randomUUID(), new Date(now));
  }
  return c.json({ ok: true });
});

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
