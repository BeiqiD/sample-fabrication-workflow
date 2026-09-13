import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { CreateRunStepCommentsInput, InitialSubstrateStep } from "../shared/types";
import { hashInitialSubstrateRepresentation, hashRecipeManifest, hashStateRepresentation, hashStepDefinition, logicalStepKey, normalizedStepName, sha256Hex, stableJson, STATE_HASH_SCHEME, STEP_HASH_SCHEME } from "../shared/content-addressing";
import { authenticateRequest } from "./auth";
import { bulkInsertStatements } from "./d1-bulk";
import { primaryD1 } from "./d1-primary";
import { contentLengthWithin, sameOriginOrNonBrowser } from "./request-guards";
import { resolveAssetReferences } from "./asset-dedupe";
import { routes as commentSubmissionRoutes } from "./comment-submission-routes";
import { routes as projectRoutes } from "./project-routes";
import { routes as referenceRoutes } from "./reference-routes";
import { cleanupCommentUploads } from "./comment-upload-cleanup";
import {
  AttachmentIngestionUnavailableError,
  ingestR2Attachment,
  safeAttachmentObjectName,
} from "./attachment-ingestion";
import {
  fabubloxImportLeaseExpiresAt,
  queueFabubloxImportCleanup,
  readFabubloxImportState,
} from "./fabublox-import-recovery";
import {
  BlobReuseProviderUnavailableError,
  findReusableR2Asset,
} from "./blob-lifecycle/reuse";
import {
  BlobRegistrationAuthorityUnavailableError,
  registerR2Asset,
} from "./blob-lifecycle/registration";
import {
  ASSET_OWNING_IMPORT_NOT_READY_SQL_ERROR,
  publishedAssetSql,
  publishedTemplateVersionSql,
  TEMPLATE_VERSION_NOT_PUBLISHED_SQL_ERROR,
} from "./template-publication";
import { getBlob } from "./blob-lifecycle/storage";
import { managedStorageStatus } from "./managed-storage";
import { likeBindings, paginationMeta, readPagination, repeatedLikeSql, searchTokens } from "./directory-query";
import type { Env } from "./types";
import { routes as sampleRoutes } from "./samples/routes";
import { stateAssets } from "./application/sample-structure";
import { requireVisibleCommentOperationGroup } from "./evidence/comment-operation-group";
import { routes as executionRoutes, verificationRoutes as executionVerificationRoutes } from "./execution/routes";
import { validRunStepTargets } from "./execution/step-targets";
import { normalizedSubstrateStepName, parseInitialSubstrateStep } from "./process-definition/substrate";

const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>().basePath("/api");
const MAX_FABUBLOX_IMPORT_STEPS = 180;
const MAX_FABUBLOX_IMPORT_IMAGES = MAX_FABUBLOX_IMPORT_STEPS;

async function digestSha256(buffer: ArrayBuffer) {
  return sha256Hex(buffer);
}

async function reusableR2Asset(env: Env, sha256: string) {
  try {
    return await findReusableR2Asset(env, sha256);
  } catch (error) {
    if (error instanceof BlobReuseProviderUnavailableError) {
      throw new HTTPException(503, { message: error.message });
    }
    throw error;
  }
}

function safeObjectName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function blobLocatorConflict(error: unknown): "unavailable" | "quarantined" | null {
  const message = String(error);
  if (message.includes("blob locator is quarantined")) return "quarantined";
  if (message.includes("blob locator is unavailable")) return "unavailable";
  return null;
}

function publicationBoundaryConflict(error: unknown): "template" | "asset" | null {
  const message = String(error);
  if (message.includes(TEMPLATE_VERSION_NOT_PUBLISHED_SQL_ERROR)) return "template";
  if (message.includes(ASSET_OWNING_IMPORT_NOT_READY_SQL_ERROR)) return "asset";
  return null;
}

app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  const locatorConflict = blobLocatorConflict(error);
  if (locatorConflict === "quarantined") {
    return c.json({
      error: "The selected file failed an integrity check. Upload a verified replacement.",
    }, 409);
  }
  if (locatorConflict === "unavailable") {
    return c.json({ error: "The selected file is being cleaned up. Retry with a new upload." }, 409);
  }
  const publicationConflict = publicationBoundaryConflict(error);
  if (publicationConflict === "template") {
    return c.json({ error: "The selected template import has not been published yet." }, 409);
  }
  if (publicationConflict === "asset") {
    return c.json({ error: "The selected imported file has not been published yet." }, 409);
  }
  console.error(error);
  return c.json({ error: "Unexpected server error" }, 500);
});

app.use("*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !sameOriginOrNonBrowser(c.req.raw)) {
    return c.json({ error: "Cross-origin writes are not allowed" }, 403);
  }
  try {
    const identity = await authenticateRequest(c.req.raw, c.env);
    c.set("userEmail", identity.email);
    await next();
  } catch (error) {
    console.warn("Authentication rejected", error);
    return c.json({ error: "Authentication required" }, 403);
  }
});

app.get("/health", (c) => c.json({ ok: true }));

app.get("/ready", async (c) => {
  const checks: Promise<unknown>[] = [
    c.env.DB.prepare("SELECT 1 AS ok").first(),
    c.env.ASSETS.list({ limit: 1 }),
  ];
  if (c.env.MANAGED_STORAGE_PROVIDER) {
    const storageStatus = await managedStorageStatus(c.env);
    if (!storageStatus.available) throw new HTTPException(503, { message: storageStatus.message });
  }
  await Promise.all(checks);
  return c.json({ ok: true });
});

app.route("/", commentSubmissionRoutes);
app.route("/", projectRoutes);
app.route("/", referenceRoutes);
app.route("/", sampleRoutes);

async function stateImageKeys(db: D1Database, stateHash: string | null) {
  return (await stateAssets(db, stateHash)).map((row) => row.r2_key);
}

app.route("/", executionRoutes);

app.post("/run-step-comments", async (c) => {
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
       (id, run_step_id, scope, operation_group_id, body, asset_id, actor_email, created_at)
     SELECT valid.comment_id, valid.step_id, ?, ?, ?, ?, ?, ?
     FROM valid
     WHERE (SELECT COUNT(*) FROM valid) = ?`,
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
  if (results[0].meta.changes !== input.targets.length) {
    throw new HTTPException(409, { message: "One or more sample steps changed before the comment was saved" });
  }
  return c.json({ ok: true, operationGroupId }, 201);
});

app.delete("/run-step-comments/:id/asset", async (c) => {
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
      `SELECT rsc.id, rsc.run_step_id, rsc.body, r.sample_id, rs.updated_at, s.updated_at AS sample_updated_at
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
      `SELECT rsc.id, rsc.run_step_id, rsc.body, r.sample_id, rs.updated_at, s.updated_at AS sample_updated_at
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
         ) = ?`,
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
  if (results[0].meta.changes !== targetIds.length) {
    throw new HTTPException(409, { message: "The comment attachment changed while it was being deleted" });
  }
  return c.json({ ok: true, updatedAt: now });
});

app.post("/run-step-comments/:id/asset/restore", async (c) => {
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
         ) = ?`,
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
  if (results[0].meta.changes !== targetIds.length) {
    throw new HTTPException(409, { message: "The comment attachment changed while it was being restored" });
  }
  return c.json({ ok: true, updatedAt: now });
});

app.delete("/run-step-comments/:id", async (c) => {
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
      `SELECT rsc.id, rsc.run_step_id, rsc.body, rsc.asset_id, r.sample_id, rs.updated_at, s.updated_at AS sample_updated_at
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
      `SELECT rsc.id, rsc.run_step_id, rsc.body, rsc.asset_id, r.sample_id, rs.updated_at, s.updated_at AS sample_updated_at
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
         ) = ?`,
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
  const deleted = results[0].meta.changes ?? 0;
  if (deleted !== targetIds.length) {
    throw new HTTPException(409, { message: "The comment changed while it was being deleted" });
  }
  return c.json({ ok: true, deleted });
});

app.post("/run-step-comments/:id/restore", async (c) => {
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
      `SELECT rsc.id, rsc.run_step_id, rsc.body, r.sample_id, a.r2_key,
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
      `SELECT rsc.id, rsc.run_step_id, rsc.body, r.sample_id, a.r2_key,
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
         ) = ?`,
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
  if (results[0].meta.changes !== targetIds.length) {
    throw new HTTPException(409, { message: "The comment changed while it was being restored" });
  }
  return c.json({ ok: true, restored: results[0].meta.changes ?? 0, updatedAt: now });
});

app.route("/", executionVerificationRoutes);

app.post("/assets", async (c) => {
  if (!contentLengthWithin(c.req.raw, 10 * 1024 * 1024)) throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
  const contentType = c.req.header("content-type") || "application/octet-stream";
  if (!contentType.toLowerCase().startsWith("image/")) throw new HTTPException(415, { message: "Ordinary asset uploads must be images" });
  const filename = c.req.header("x-filename") || "upload";
  if (filename.length > 255 || contentType.length > 200) throw new HTTPException(400, { message: "Asset metadata is too long" });
  const buffer = await c.req.arrayBuffer();
  if (buffer.byteLength > 10 * 1024 * 1024) throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
  const registration = await ingestR2Attachment(c.env, {
    originalName: filename,
    mimeType: contentType,
    actorEmail: c.get("userEmail"),
    bytes: buffer,
    objectKey: (id) => `${new Date().toISOString().slice(0, 10)}/${id}-${safeAttachmentObjectName(filename)}`,
  }).catch((error: unknown) => {
    if (error instanceof AttachmentIngestionUnavailableError) {
      throw new HTTPException(503, { message: error.publicMessage });
    }
    throw error;
  });
  const payload = {
    id: registration.record.id,
    key: registration.record.r2_key,
    deduplicated: registration.deduplicated,
  };
  return registration.deduplicated
    ? c.json(payload)
    : c.json(payload, 201);
});

app.get("/exports/r2/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const registered = await c.env.DB.prepare(
    `SELECT 1 AS registered
     WHERE (
       EXISTS (SELECT 1 FROM assets WHERE r2_key = ?)
       OR EXISTS (SELECT 1 FROM imports WHERE workbook_asset_key = ? OR manifest_asset_key = ?)
       OR EXISTS (SELECT 1 FROM template_versions WHERE source_asset_key = ?)
       OR EXISTS (SELECT 1 FROM events WHERE asset_key = ?)
       OR EXISTS (
         SELECT 1 FROM blob_retention_edges
         WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = ?
       )
     )
     AND NOT EXISTS (
       SELECT 1 FROM blob_gc_ledger
       WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = ? AND state = 'deleted'
     )`,
  ).bind(key, key, key, key, key, key, key).first<{ registered: number }>();
  if (!registered) throw new HTTPException(404, { message: "Export blob not found" });
  const object = await getBlob(c.env, {
    storeKind: "r2", provider: "r2", objectKey: key, blobRecordId: null,
  });
  if (object.outcome === "missing") throw new HTTPException(404, { message: "Export blob is missing" });
  if (object.outcome === "provider_unavailable") {
    throw new HTTPException(503, { message: "R2 is unavailable" });
  }
  return new Response(object.body, {
    headers: {
      "content-type": object.contentType,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...(object.etag ? { etag: object.etag } : {}),
    },
  });
});

app.get("/exports/managed/:objectId", async (c) => {
  const objectId = c.req.param("objectId");
  const row = await c.env.DB.prepare(
    `SELECT mso.id, mso.provider, mso.object_key, mso.mime_type
     FROM managed_storage_objects mso
     WHERE mso.id = ? AND mso.status IN ('ready', 'orphaned')
       AND NOT EXISTS (
         SELECT 1 FROM blob_gc_ledger bg
         WHERE bg.store_kind = 'managed' AND bg.provider = mso.provider
           AND bg.object_key = mso.object_key AND bg.state = 'deleted'
       )`,
  ).bind(objectId).first<{
    id: string; provider: string; object_key: string; mime_type: string;
  }>();
  if (!row) throw new HTTPException(404, { message: "Export blob not found" });
  const object = await getBlob(c.env, {
    storeKind: "managed",
    provider: row.provider,
    objectKey: row.object_key,
    blobRecordId: row.id,
  });
  if (object.outcome === "missing") throw new HTTPException(404, { message: "Export blob is missing" });
  if (object.outcome === "provider_unavailable") {
    throw new HTTPException(503, { message: "Managed storage is unavailable" });
  }
  return new Response(object.body, {
    headers: {
      "content-type": object.contentType || row.mime_type,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...(object.etag ? { etag: object.etag } : {}),
    },
  });
});

app.post("/imports/fabublox", async (c) => {
  if (!contentLengthWithin(c.req.raw, 50 * 1024 * 1024)) throw new HTTPException(413, { message: "FabuBlox imports are limited to 50 MB" });
  const form = await c.req.raw.formData();
  const workbook = form.get("workbook");
  const manifestFile = form.get("manifest");
  if (!(workbook instanceof File) || !(manifestFile instanceof File)) throw new HTTPException(400, { message: "Workbook and manifest files are required" });
  let parsedManifest: unknown;
  try { parsedManifest = JSON.parse(await manifestFile.text()); }
  catch { throw new HTTPException(400, { message: "The FabuBlox manifest is not valid JSON" }); }
  if (!parsedManifest || typeof parsedManifest !== "object") throw new HTTPException(400, { message: "Invalid FabuBlox manifest" });
  const manifest = parsedManifest as {
    schemaVersion: number;
    title: string;
    recipeFamilyId?: string | null;
    source: { fileName: string; fileSha256: string; sheetName: string };
    initialSubstrateStep: InitialSubstrateStep | null;
    steps: Array<{
      localId: string; sourceRow: number; position: number; stepNumber: string | null;
      sectionName: string | null; name: string; toolName: string | null;
      parametersText: string | null; commentsText: string | null;
      imageIds: string[]; rawCells: Record<string, unknown>;
    }>;
    images: Array<{
      localId: string; sourcePart: string; mimeType: string;
      assignedStepLocalId: string | null;
      anchor: Record<string, unknown>;
    }>;
    initialStateImageIds: string[];
    warnings: unknown[];
  };
  if (manifest.schemaVersion !== 2 || typeof manifest.title !== "string" || !manifest.title.trim() || manifest.title.length > 200 || typeof manifest.source?.sheetName !== "string" || !manifest.source.sheetName || !Array.isArray(manifest.steps) || !manifest.steps.length || !Array.isArray(manifest.images) || !Array.isArray(manifest.initialStateImageIds) || !Array.isArray(manifest.warnings)
    || (manifest.initialSubstrateStep !== null && (typeof manifest.initialSubstrateStep !== "object"
      || manifest.initialSubstrateStep.stepNumber !== "0"
      || typeof manifest.initialSubstrateStep.name !== "string"
      || normalizedSubstrateStepName(manifest.initialSubstrateStep.name) !== "substrate stack"
      || !Array.isArray(manifest.initialSubstrateStep.imageIds)))) {
    throw new HTTPException(400, { message: "Invalid FabuBlox manifest" });
  }
  if (manifest.recipeFamilyId !== undefined && manifest.recipeFamilyId !== null && typeof manifest.recipeFamilyId !== "string") {
    throw new HTTPException(400, { message: "Invalid process-template family" });
  }
  if (manifest.steps.length > MAX_FABUBLOX_IMPORT_STEPS || manifest.images.length > MAX_FABUBLOX_IMPORT_IMAGES) {
    throw new HTTPException(413, { message: `This import exceeds the ${MAX_FABUBLOX_IMPORT_STEPS}-step or ${MAX_FABUBLOX_IMPORT_IMAGES}-image deployment limit` });
  }
  for (const image of manifest.images) {
    if (!(form.get(`image:${image.localId}`) instanceof File)) throw new HTTPException(400, { message: `Missing uploaded image ${image.localId}` });
  }
  const imageIds = new Set(manifest.images.map((image) => image.localId));
  if (imageIds.size !== manifest.images.length || manifest.images.some((image) => typeof image.localId !== "string" || !image.localId)) {
    throw new HTTPException(400, { message: "Imported image identifiers must be unique" });
  }
  if (new Set(manifest.initialStateImageIds).size !== manifest.initialStateImageIds.length
    || manifest.initialStateImageIds.some((id) => typeof id !== "string" || !imageIds.has(id))) {
    throw new HTTPException(400, { message: "Invalid initial substrate image selection" });
  }
  if (manifest.initialSubstrateStep) {
    const declared = new Set(manifest.initialSubstrateStep.imageIds);
    if (manifest.initialStateImageIds.some((id) => !declared.has(id))
      || manifest.initialSubstrateStep.imageIds.some((id) => !manifest.initialStateImageIds.includes(id))
      || manifest.steps.some((step) => step.localId === manifest.initialSubstrateStep?.localId)) {
      throw new HTTPException(400, { message: "Step 0 must be represented only as the initial substrate" });
    }
  } else if (manifest.initialStateImageIds.length) {
    throw new HTTPException(400, { message: "Initial substrate images require Step 0: Substrate Stack" });
  }
  const processStepIds = new Set(manifest.steps.map((step) => step.localId));
  if (processStepIds.size !== manifest.steps.length
    || (manifest.initialSubstrateStep && processStepIds.has(manifest.initialSubstrateStep.localId))) {
    throw new HTTPException(400, { message: "Process and substrate step identifiers must be unique" });
  }
  const allowedStepIds = new Set([
    ...processStepIds,
    ...(manifest.initialSubstrateStep ? [manifest.initialSubstrateStep.localId] : []),
  ]);
  for (const image of manifest.images) {
    if (image.assignedStepLocalId !== null && !allowedStepIds.has(image.assignedStepLocalId)) {
      throw new HTTPException(400, { message: `Image ${image.localId} refers to an unknown process row` });
    }
  }
  const payloadBytes = workbook.size + manifestFile.size + manifest.images.reduce((sum, image) => {
    const file = form.get(`image:${image.localId}`);
    return sum + (file instanceof File ? file.size : 0);
  }, 0);
  if (payloadBytes > 50 * 1024 * 1024) throw new HTTPException(413, { message: "FabuBlox imports are limited to 50 MB" });
  const workbookBuffer = await workbook.arrayBuffer();
  const actualSha = await digestSha256(workbookBuffer);
  if (actualSha !== manifest.source.fileSha256) throw new HTTPException(400, { message: "Workbook checksum does not match the preview" });

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const manifestBuffer = manifestBytes.buffer.slice(manifestBytes.byteOffset, manifestBytes.byteOffset + manifestBytes.byteLength) as ArrayBuffer;
  const imageInputs: Array<{
    image: typeof manifest.images[number]; file: File; buffer: ArrayBuffer; sha256: string;
  }> = [];
  for (let index = 0; index < manifest.images.length; index += 5) {
    const prepared = await Promise.all(manifest.images.slice(index, index + 5).map(async (image) => {
      const value = form.get(`image:${image.localId}`);
      if (!(value instanceof File)) throw new HTTPException(400, { message: `Missing uploaded image ${image.localId}` });
      const mimeType = value.type || image.mimeType;
      if (!mimeType.toLowerCase().startsWith("image/")) throw new HTTPException(415, { message: `Imported asset ${image.localId} is not an image` });
      const buffer = await value.arrayBuffer();
      return { image, file: value, buffer, sha256: await digestSha256(buffer) };
    }));
    imageInputs.push(...prepared);
  }

  const existingFamily = manifest.recipeFamilyId
    ? await c.env.DB.prepare("SELECT id, name, template_type FROM recipe_families WHERE id = ? AND archived_at IS NULL")
      .bind(manifest.recipeFamilyId).first<{ id: string; name: string; template_type: string }>()
    : await c.env.DB.prepare("SELECT id, name, template_type FROM recipe_families WHERE name = ? AND template_type = 'process' AND archived_at IS NULL")
      .bind(manifest.title.trim()).first<{ id: string; name: string; template_type: string }>();
  if (manifest.recipeFamilyId && !existingFamily) throw new HTTPException(404, { message: "Process-template family not found" });
  const internalTemplateType = existingFamily?.template_type ?? "process";
  const recipeFamilyId = existingFamily?.id ?? crypto.randomUUID();
  const recipeName = existingFamily?.name ?? manifest.title.trim();
  const importId = crypto.randomUUID();
  const importOperationId = crypto.randomUUID();
  const finalizationId = crypto.randomUUID();
  const startedAt = new Date();
  const now = startedAt.toISOString();
  const leaseExpiresAt = fabubloxImportLeaseExpiresAt(startedAt);
  const userEmail = c.get("userEmail");
  const importDb = primaryD1(c.env.DB);
  await importDb.prepare(
    `INSERT INTO imports (
       id, status, source_filename, source_sha256, sheet_name, template_type,
       recipe_family_id, warning_count, actor_email, created_at,
       operation_id, lease_expires_at
     ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    importId,
    workbook.name,
    actualSha,
    manifest.source.sheetName,
    internalTemplateType,
    recipeFamilyId,
    manifest.warnings.length,
    userEmail,
    now,
    importOperationId,
    leaseExpiresAt,
  ).run();

  let completedTemplateVersionId: string | null = null;
  let completedVersion: number | null = null;
  try {
    const prefix = `imports/${importId}`;
    type Candidate = {
      kind: "workbook" | "manifest" | "image";
      localId: string;
      originalName: string;
      mimeType: string;
      buffer: ArrayBuffer;
      sha256: string;
      image?: typeof manifest.images[number];
    };
    const candidates: Candidate[] = [
      { kind: "workbook", localId: "workbook", originalName: workbook.name, mimeType: workbook.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: workbookBuffer, sha256: actualSha },
      { kind: "manifest", localId: "manifest", originalName: "manifest.json", mimeType: "application/json", buffer: manifestBuffer, sha256: await digestSha256(manifestBuffer) },
      ...imageInputs.map(({ image, file, buffer, sha256 }) => ({ kind: "image" as const, localId: image.localId, originalName: file.name, mimeType: file.type || image.mimeType, buffer, sha256, image })),
    ];
    const hashes = [...new Set(candidates.map((candidate) => candidate.sha256))];
    const existingByHash = new Map<string, { assetId: string; key: string }>();
    for (let index = 0; index < hashes.length; index += 5) {
      const verified = await Promise.all(hashes.slice(index, index + 5).map(async (hash) => ({
        hash,
        asset: await reusableR2Asset(c.env, hash),
      })));
      for (const candidate of verified) {
        if (candidate.asset) {
          existingByHash.set(candidate.hash, {
            assetId: candidate.asset.id,
            key: candidate.asset.r2_key,
          });
        }
      }
    }
    const resolved = resolveAssetReferences(candidates, existingByHash, (candidate) => {
      const suffix = candidate.kind === "workbook" ? `source/${safeObjectName(candidate.originalName)}`
        : candidate.kind === "manifest" ? "manifest.json"
          : `images/${candidate.localId}-${safeObjectName(candidate.originalName)}`;
      return { assetId: crypto.randomUUID(), key: `${prefix}/${suffix}` };
    });
    const newAssets = [...new Map(resolved.filter((asset) => asset.isNew)
      .map((asset) => [asset.assetId, asset])).values()];
    const stagedAssets: typeof newAssets = [];
    for (const asset of newAssets) {
      let registered = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const registrationDb = primaryD1(c.env.DB);
          await registrationDb.prepare(
            `INSERT INTO assets
             (id, import_id, r2_key, original_name, mime_type, byte_size,
              status, actor_email, created_at, sha256)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          ).bind(
            asset.assetId,
            importId,
            asset.key,
            asset.originalName,
            asset.mimeType,
            asset.buffer.byteLength,
            userEmail,
            now,
            asset.sha256,
          ).run();
          stagedAssets.push(asset);
          registered = true;
          break;
        } catch (error) {
          const ownRegistration = await primaryD1(c.env.DB).prepare(`
            SELECT id
            FROM assets
            WHERE id = ? AND import_id = ? AND r2_key = ?
              AND original_name = ? AND mime_type = ? AND byte_size = ?
              AND status = 'pending' AND sha256 = ?
          `).bind(
            asset.assetId,
            importId,
            asset.key,
            asset.originalName,
            asset.mimeType,
            asset.buffer.byteLength,
            asset.sha256,
          ).first<{ id: string }>();
          if (ownRegistration) {
            stagedAssets.push(asset);
            registered = true;
            break;
          }
          const winner = await reusableR2Asset(c.env, asset.sha256);
          if (winner) {
            for (const candidate of resolved) {
              if (candidate.sha256 !== asset.sha256) continue;
              candidate.assetId = winner.id;
              candidate.key = winner.r2_key;
              candidate.isNew = false;
            }
            registered = true;
            break;
          }
          if (attempt === 1) throw error;
        }
      }
      if (!registered) {
        throw new HTTPException(409, {
          message: "Imported asset registration could not be reconciled",
        });
      }
    }

    // Every provider write now has a durable pending asset row first. A lost or
    // failed PUT can therefore be recovered by the lease reaper and GC queue.
    for (let index = 0; index < stagedAssets.length; index += 5) {
      const uploadResults = await Promise.allSettled(
        stagedAssets.slice(index, index + 5).map((asset) =>
          c.env.ASSETS.put(asset.key, asset.buffer, {
            httpMetadata: { contentType: asset.mimeType },
          })),
      );
      const failedUpload = uploadResults.find((result) => result.status === "rejected");
      if (failedUpload?.status === "rejected") throw failedUpload.reason;
    }

    const workbookAsset = resolved.find((asset) => asset.kind === "workbook")!;
    const manifestAsset = resolved.find((asset) => asset.kind === "manifest")!;
    const imageAssets = resolved.filter((asset) => asset.kind === "image");
    const latest = await c.env.DB.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM template_versions WHERE recipe_family_id = ?",
    ).bind(recipeFamilyId).first<{ version: number }>();
    const version = (latest?.version ?? 0) + 1;
    const templateVersionId = crypto.randomUUID();
    completedVersion = version;
    completedTemplateVersionId = templateVersionId;
    const stepIds = new Map(manifest.steps.map((step) => [step.localId, crypto.randomUUID()]));

    const occurrences = new Map<string, number>();
    const definitions = new Map<string, Awaited<ReturnType<typeof hashStepDefinition>>>();
    const states = new Map<string, { hash: string; canonical: Record<string, unknown> }>();
    const stateAssetRows = new Map<string, [string, string, number]>();
    const initialStateAssets = imageAssets.filter((asset) => manifest.initialStateImageIds.includes(asset.localId));
    let initialStateHash: string | null = null;
    if (manifest.initialSubstrateStep) {
      const initialState = await hashInitialSubstrateRepresentation(
        manifest.initialSubstrateStep,
        initialStateAssets.map((asset) => asset.sha256),
      );
      states.set(initialState.hash, initialState);
      initialStateHash = initialState.hash;
      initialStateAssets.forEach((asset, index) =>
        stateAssetRows.set(`${initialState.hash}:${asset.assetId}`, [initialState.hash, asset.assetId, index]));
    }
    let inheritedStateHash: string | null = initialStateHash;
    const preparedSteps: Array<{
      source: typeof manifest.steps[number]; logicalKey: string; definitionHash: string; expectedStateHash: string | null;
    }> = [];
    for (const step of manifest.steps) {
      const occurrenceKey = normalizedStepName(step.name);
      const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
      occurrences.set(occurrenceKey, occurrence);
      const logicalKey = logicalStepKey(step, occurrence);
      const definition = await hashStepDefinition(step);
      definitions.set(definition.hash, definition);
      const assignedAssets = imageAssets.filter((asset) => asset.image?.assignedStepLocalId === step.localId);
      if (assignedAssets.length) {
        const state = await hashStateRepresentation(assignedAssets.map((asset) => asset.sha256));
        states.set(state.hash, state);
        inheritedStateHash = state.hash;
        assignedAssets.forEach((asset, index) => stateAssetRows.set(`${state.hash}:${asset.assetId}`, [state.hash, asset.assetId, index]));
      }
      preparedSteps.push({ source: step, logicalKey, definitionHash: definition.hash, expectedStateHash: inheritedStateHash });
    }
    const manifestHash = await hashRecipeManifest(preparedSteps.map((step) => ({
      logicalStepKey: step.logicalKey, definitionHash: step.definitionHash, expectedStateHash: step.expectedStateHash,
    })));

    const existingDefinitionHashes = new Set<string>();
    const definitionHashes = [...definitions.keys()];
    for (let index = 0; index < definitionHashes.length; index += 90) {
      const chunk = definitionHashes.slice(index, index + 90);
      const rows = await c.env.DB.prepare(`SELECT hash FROM step_definitions WHERE hash IN (${chunk.map(() => "?").join(", ")})`)
        .bind(...chunk).all<{ hash: string }>();
      rows.results.forEach((row) => existingDefinitionHashes.add(row.hash));
    }
    const stateHashes = [...states.keys()];
    const existingStateHashes = new Set<string>();
    if (stateHashes.length) {
      const rows = await c.env.DB.prepare(
        "SELECT hash FROM state_representations WHERE hash IN (SELECT value FROM json_each(?))",
      ).bind(JSON.stringify(stateHashes)).all<{ hash: string }>();
      rows.results.forEach((row) => existingStateHashes.add(row.hash));
    }

    const metadataStatements: D1PreparedStatement[] = [
      ...(!existingFamily ? [c.env.DB.prepare(
        `INSERT INTO recipe_families (id, name, template_type, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(recipeFamilyId, recipeName, internalTemplateType, userEmail, now)] : []),
      c.env.DB.prepare(
        `UPDATE imports SET template_version_id = ?
         WHERE id = ? AND status = 'pending' AND operation_id = ?
           AND finalization_id IS NULL AND lease_expires_at > ?`,
      ).bind(templateVersionId, importId, importOperationId, now),
      ...bulkInsertStatements(c.env.DB, "step_definitions",
        ["hash", "hash_scheme", "name", "tool_name", "parameters_text", "comments_text", "canonical_json", "created_at"],
        [...definitions.values()].filter((definition) => !existingDefinitionHashes.has(definition.hash)).map((definition) => [
          definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
          definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now,
        ])),
      ...bulkInsertStatements(c.env.DB, "state_representations",
        ["hash", "hash_scheme", "representation_type", "content_json", "created_at"],
        [...states.values()].filter((state) => !existingStateHashes.has(state.hash)).map((state) => [
          state.hash, String(state.canonical.schema), String(state.canonical.type), stableJson(state.canonical), now,
        ])),
      c.env.DB.prepare(
        `INSERT INTO template_versions
          (id, recipe_family_id, name, template_type, version, manifest_hash, initial_state_hash,
           source_filename, source_asset_key, content_json, created_by, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM imports owning_import
         WHERE owning_import.id = ? AND owning_import.status = 'pending'
           AND owning_import.operation_id = ? AND owning_import.finalization_id IS NULL
           AND owning_import.template_version_id = ? AND owning_import.lease_expires_at > ?`,
      ).bind(templateVersionId, recipeFamilyId, recipeName, internalTemplateType, version, manifestHash, initialStateHash, workbook.name, workbookAsset.key, JSON.stringify({
        schemaVersion: manifest.schemaVersion,
        source: manifest.source,
        importedTitle: manifest.title,
        objectKind: "process_template",
        initialSubstrateStep: manifest.initialSubstrateStep,
        warningCount: manifest.warnings.length,
      }), userEmail, now, importId, importOperationId, templateVersionId, now),
      ...bulkInsertStatements(c.env.DB, "template_steps",
        ["id", "template_version_id", "logical_step_key", "position", "source_row", "step_number", "section_name", "definition_hash", "expected_state_hash", "raw_json"],
        preparedSteps.map((step) => [stepIds.get(step.source.localId), templateVersionId, step.logicalKey, step.source.position,
          step.source.sourceRow, step.source.stepNumber, step.source.sectionName, step.definitionHash, step.expectedStateHash, JSON.stringify(step.source.rawCells)])),
    ];
    for (let index = 0; index < metadataStatements.length; index += 45) {
      await c.env.DB.batch(metadataStatements.slice(index, index + 45));
    }

    const completedAt = new Date().toISOString();
    const finalizationDb = primaryD1(c.env.DB);
    const finalizationAssetRows = JSON.stringify([...stateAssetRows.values()]);
    const [finalizationResult] = await finalizationDb.batch([
      finalizationDb.prepare(`
        UPDATE imports
        SET status = 'ready', workbook_asset_key = ?, manifest_asset_key = ?,
            finalization_id = ?, completed_at = ?, lease_expires_at = NULL
        WHERE id = ? AND status = 'pending' AND operation_id = ?
          AND template_version_id = ? AND lease_expires_at > ?
      `).bind(
        workbookAsset.key,
        manifestAsset.key,
        finalizationId,
        completedAt,
        importId,
        importOperationId,
        templateVersionId,
        completedAt,
      ),
      finalizationDb.prepare(`
        INSERT INTO state_representation_assets (state_hash, asset_id, position)
        SELECT CAST(json_extract(entry.value, '$[0]') AS TEXT),
               CAST(json_extract(entry.value, '$[1]') AS TEXT),
               CAST(json_extract(entry.value, '$[2]') AS INTEGER)
        FROM json_each(?) entry
        WHERE EXISTS (
          SELECT 1 FROM imports owning_import
          WHERE owning_import.id = ? AND owning_import.status = 'ready'
            AND owning_import.operation_id = ?
            AND owning_import.finalization_id = ?
            AND owning_import.template_version_id = ?
        )
        ON CONFLICT(state_hash, asset_id) DO UPDATE SET
          position = excluded.position
      `).bind(
        finalizationAssetRows,
        importId,
        importOperationId,
        finalizationId,
        templateVersionId,
      ),
    ]);
    if (!finalizationResult.meta.changes) {
      throw new HTTPException(409, {
        message: "The import lease changed before finalization",
      });
    }
    return c.json({ id: importId, templateVersionId, version }, 201);
  } catch (error) {
    let authoritative;
    try {
      authoritative = await readFabubloxImportState(c.env.DB, importId);
    } catch (readError) {
      console.error("Could not determine FabuBlox finalization outcome", readError);
      throw new HTTPException(503, {
        message: "Import finalization outcome is unknown; persistent recovery will reconcile it",
      });
    }

    if (authoritative?.status === "ready"
      && authoritative.operation_id === importOperationId
      && authoritative.finalization_id === finalizationId
      && authoritative.template_version_id === completedTemplateVersionId
      && completedTemplateVersionId !== null
      && completedVersion !== null) {
      return c.json({
        id: importId,
        templateVersionId: completedTemplateVersionId,
        version: completedVersion,
      }, 201);
    }

    if (authoritative?.status === "pending"
      && authoritative.operation_id === importOperationId
      && authoritative.finalization_id === null) {
      try {
        await queueFabubloxImportCleanup(c.env, {
          importId,
          operationId: importOperationId,
          error,
        });
      } catch (recoveryError) {
        // Provider bytes remain untouched. The persisted lease allows the
        // scheduled reaper to retry this metadata-only recovery safely.
        console.error("Could not queue failed FabuBlox import recovery", recoveryError);
      }
    }
    throw error;
  }
});

type ProcessTemplateDirectoryRow = {
  id: string;
  recipe_family_id: string;
  name: string;
  template_type: "process" | "module" | "recipe";
  version: number;
  source_filename: string | null;
  step_count: number;
  initial_state_hash: string | null;
  has_initial_substrate_step: number;
  initial_asset_count: number;
  locked_at: string | null;
  created_at: string;
  version_count?: number;
};

function processTemplateVersionSummary(row: ProcessTemplateDirectoryRow) {
  return {
    id: row.id,
    recipeFamilyId: row.recipe_family_id,
    name: row.name,
    templateType: row.template_type,
    version: Number(row.version),
    sourceFilename: row.source_filename,
    stepCount: Number(row.step_count),
    initialStateHash: row.initial_state_hash,
    hasInitialSubstrateStep: Boolean(row.has_initial_substrate_step),
    initialStateImageCount: Number(row.initial_asset_count),
    locked: Boolean(row.locked_at),
    createdAt: row.created_at,
  };
}

async function requirePublishedTemplateVersion(db: D1Database, id: string) {
  const row = await db.prepare(`
    SELECT 1 AS published
    FROM template_versions tv
    WHERE tv.id = ? AND ${publishedTemplateVersionSql("tv")}
  `).bind(id).first<{ published: number }>();
  if (!row) throw new HTTPException(404, { message: "Template version not found" });
}

const visibleProcessTemplateSql = (alias: string) => `
  ${alias}.template_kind = 'process'
  AND ${alias}.archived_at IS NULL
  AND ${alias}.deleted_at IS NULL
  AND ${publishedTemplateVersionSql(alias)}`;

function processTemplateFamilySearch(query: string, familyAlias: string) {
  const tokens = searchTokens(query);
  if (!tokens.length) return { sql: "1 = 1", bindings: [] as string[] };
  const haystack = `LOWER(
    COALESCE(candidate.name, '') || ' ' ||
    COALESCE(candidate.template_type, '') || ' process fabrication ' ||
    COALESCE(candidate.source_filename, '') || ' v' ||
    CAST(candidate.version AS TEXT) || ' version ' ||
    CAST(candidate.version AS TEXT) || ' ' ||
    CAST((SELECT COUNT(*) FROM template_steps search_steps WHERE search_steps.template_version_id = candidate.id) AS TEXT) ||
    ' steps ' || CASE WHEN candidate.locked_at IS NULL THEN 'editable' ELSE 'locked' END
  )`;
  return {
    sql: `EXISTS (
      SELECT 1
      FROM template_versions candidate
      WHERE candidate.recipe_family_id = ${familyAlias}.recipe_family_id
        AND ${visibleProcessTemplateSql("candidate")}
        AND ${repeatedLikeSql(haystack, tokens)}
    )`,
    bindings: likeBindings(tokens),
  };
}

function metrologyTemplateSearch(query: string) {
  const tokens = searchTokens(query);
  if (!tokens.length) return { sql: "1 = 1", bindings: [] as string[] };
  const haystack = `LOWER(
    COALESCE(tv.name, '') || ' metrology ' ||
    COALESCE(sd.tool_name, '') || ' ' ||
    COALESCE(sd.parameters_text, '') || ' ' ||
    COALESCE(sd.comments_text, '')
  )`;
  return { sql: repeatedLikeSql(haystack, tokens), bindings: likeBindings(tokens) };
}

const processTemplateDirectoryColumns = `
  tv.id, tv.recipe_family_id, tv.name, tv.template_type, tv.version,
  tv.source_filename, tv.initial_state_hash, tv.locked_at, tv.created_at,
  (SELECT COUNT(*) FROM template_steps ts WHERE ts.template_version_id = tv.id) AS step_count,
  CASE WHEN json_valid(tv.content_json)
    AND json_type(tv.content_json, '$.initialSubstrateStep') = 'object'
    THEN 1 ELSE 0 END AS has_initial_substrate_step,
  (SELECT COUNT(*)
   FROM state_representation_assets sra
   JOIN assets initial_asset ON initial_asset.id = sra.asset_id AND initial_asset.status = 'ready'
   WHERE sra.state_hash = tv.initial_state_hash
     AND ${publishedAssetSql("initial_asset")}) AS initial_asset_count`;

app.get("/template-families/options", async (c) => {
  const d1Started = performance.now();
  const result = await c.env.DB.prepare(
    `SELECT tv.recipe_family_id, tv.name, tv.version
     FROM template_versions tv
     WHERE ${visibleProcessTemplateSql("tv")}
       AND NOT EXISTS (
         SELECT 1 FROM template_versions newer
         WHERE newer.recipe_family_id = tv.recipe_family_id
           AND ${visibleProcessTemplateSql("newer")}
           AND newer.version > tv.version
       )
     ORDER BY tv.name, tv.template_type, tv.recipe_family_id`,
  ).all<{ recipe_family_id: string; name: string; version: number }>();
  const d1Duration = performance.now() - d1Started;
  const serializeStarted = performance.now();
  const payload = { families: result.results.map((row) => ({
    recipeFamilyId: row.recipe_family_id,
    name: row.name,
    latestVersion: Number(row.version),
  })) };
  const serializeDuration = performance.now() - serializeStarted;
  const response = c.json(payload);
  response.headers.set("Server-Timing", `d1;dur=${d1Duration.toFixed(1)}, serialize;dur=${serializeDuration.toFixed(1)}`);
  return response;
});

app.get("/template-families", async (c) => {
  const query = c.req.query("q")?.trim() ?? "";
  const { page, pageSize, offset } = readPagination(c.req.query("page"), c.req.query("pageSize"), 20);
  const search = processTemplateFamilySearch(query, "tv");
  const latestWhere = `
    ${visibleProcessTemplateSql("tv")}
    AND NOT EXISTS (
      SELECT 1 FROM template_versions newer
      WHERE newer.recipe_family_id = tv.recipe_family_id
        AND ${visibleProcessTemplateSql("newer")}
        AND newer.version > tv.version
    )
    AND ${search.sql}`;
  const d1Started = performance.now();
  const [result, countRow] = await Promise.all([
    c.env.DB.prepare(
      `SELECT ${processTemplateDirectoryColumns},
              (SELECT COUNT(*) FROM template_versions family_version
               WHERE family_version.recipe_family_id = tv.recipe_family_id
                 AND ${visibleProcessTemplateSql("family_version")}) AS version_count
       FROM template_versions tv
       WHERE ${latestWhere}
       ORDER BY tv.name, tv.template_type, tv.recipe_family_id
       LIMIT ? OFFSET ?`,
    ).bind(...search.bindings, pageSize, offset).all<ProcessTemplateDirectoryRow>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total
       FROM template_versions tv
       WHERE ${latestWhere}`,
    ).bind(...search.bindings).first<{ total: number }>(),
  ]);
  const d1Duration = performance.now() - d1Started;
  const serializeStarted = performance.now();
  const payload = {
    families: result.results.map((row) => ({
      recipeFamilyId: row.recipe_family_id,
      name: row.name,
      templateType: row.template_type,
      latestVersion: Number(row.version),
      versionCount: Number(row.version_count ?? 1),
      latest: processTemplateVersionSummary(row),
    })),
    pagination: paginationMeta(Number(countRow?.total ?? 0), page, pageSize),
  };
  const serializeDuration = performance.now() - serializeStarted;
  const response = c.json(payload);
  response.headers.set("Server-Timing", `d1;dur=${d1Duration.toFixed(1)}, serialize;dur=${serializeDuration.toFixed(1)}`);
  return response;
});

app.get("/template-families/:id/versions", async (c) => {
  const recipeFamilyId = c.req.param("id");
  const search = processTemplateFamilySearch(c.req.query("q")?.trim() ?? "", "tv");
  const d1Started = performance.now();
  const result = await c.env.DB.prepare(
    `SELECT ${processTemplateDirectoryColumns}
     FROM template_versions tv
     WHERE tv.recipe_family_id = ?
       AND ${visibleProcessTemplateSql("tv")}
       AND ${search.sql}
     ORDER BY tv.version DESC, tv.created_at DESC`,
  ).bind(recipeFamilyId, ...search.bindings).all<ProcessTemplateDirectoryRow>();
  const d1Duration = performance.now() - d1Started;
  const serializeStarted = performance.now();
  const payload = { versions: result.results.map(processTemplateVersionSummary) };
  const serializeDuration = performance.now() - serializeStarted;
  const response = c.json(payload);
  response.headers.set("Server-Timing", `d1;dur=${d1Duration.toFixed(1)}, serialize;dur=${serializeDuration.toFixed(1)}`);
  return response;
});

app.get("/metrology-templates", async (c) => {
  const query = c.req.query("q")?.trim() ?? "";
  const { page, pageSize, offset } = readPagination(c.req.query("page"), c.req.query("pageSize"), 25);
  const search = metrologyTemplateSearch(query);
  const fromSql = `
    FROM template_versions tv
    LEFT JOIN template_steps ts ON ts.template_version_id = tv.id AND ts.position = 0
    LEFT JOIN step_definitions sd ON sd.hash = ts.definition_hash
    WHERE tv.template_kind = 'metrology'
      AND tv.archived_at IS NULL
      AND tv.deleted_at IS NULL
      AND ${publishedTemplateVersionSql("tv")}
      AND ${search.sql}`;
  const d1Started = performance.now();
  const [result, countRow] = await Promise.all([
    c.env.DB.prepare(
      `SELECT tv.id, tv.name, tv.created_at, sd.tool_name,
              CASE WHEN NULLIF(TRIM(sd.parameters_text), '') IS NOT NULL
                     OR NULLIF(TRIM(sd.comments_text), '') IS NOT NULL
                   THEN 1 ELSE 0 END AS has_default_content
       ${fromSql}
       ORDER BY tv.name, tv.created_at DESC, tv.id
       LIMIT ? OFFSET ?`,
    ).bind(...search.bindings, pageSize, offset).all<{
      id: string;
      name: string;
      created_at: string;
      tool_name: string | null;
      has_default_content: number;
    }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total ${fromSql}`)
      .bind(...search.bindings).first<{ total: number }>(),
  ]);
  const d1Duration = performance.now() - d1Started;
  const serializeStarted = performance.now();
  const payload = {
    templates: result.results.map((row) => ({
      id: row.id,
      name: row.name,
      toolName: row.tool_name,
      hasDefaultContent: Boolean(row.has_default_content),
      createdAt: row.created_at,
    })),
    pagination: paginationMeta(Number(countRow?.total ?? 0), page, pageSize),
  };
  const serializeDuration = performance.now() - serializeStarted;
  const response = c.json(payload);
  response.headers.set("Server-Timing", `d1;dur=${d1Duration.toFixed(1)}, serialize;dur=${serializeDuration.toFixed(1)}`);
  return response;
});

app.get("/templates", async (c) => {
  const pickerView = c.req.query("view") === "picker";
  const d1Started = performance.now();
  const [result, initialAssetRows] = await Promise.all([
    c.env.DB.prepare(
    `SELECT tv.id, tv.recipe_family_id, tv.name, tv.template_type, tv.template_kind,
            tv.version, tv.manifest_hash,
            tv.initial_state_hash, tv.source_filename, ${pickerView ? "NULL" : "tv.content_json"} AS content_json, tv.created_at,
            tv.locked_at, tv.archived_at,
            (SELECT COUNT(*) FROM template_steps ts WHERE ts.template_version_id = tv.id) AS step_count,
            (SELECT sd.tool_name FROM template_steps ts JOIN step_definitions sd ON sd.hash = ts.definition_hash
             WHERE ts.template_version_id = tv.id ORDER BY ts.position LIMIT 1) AS tool_name,
            (SELECT sd.parameters_text FROM template_steps ts JOIN step_definitions sd ON sd.hash = ts.definition_hash
             WHERE ts.template_version_id = tv.id ORDER BY ts.position LIMIT 1) AS parameters_text,
            (SELECT sd.comments_text FROM template_steps ts JOIN step_definitions sd ON sd.hash = ts.definition_hash
             WHERE ts.template_version_id = tv.id ORDER BY ts.position LIMIT 1) AS comments_text
     FROM template_versions tv
     WHERE tv.archived_at IS NULL AND tv.deleted_at IS NULL
       AND ${publishedTemplateVersionSql("tv")}
     ORDER BY tv.name, tv.template_type, tv.version DESC`,
  ).all<{
    id: string;
    recipe_family_id: string;
    name: string;
    template_type: "process" | "module" | "recipe";
    template_kind: "process" | "metrology";
    version: number;
    manifest_hash: string;
    initial_state_hash: string | null;
    content_json: string | null;
    source_filename: string | null;
    created_at: string;
    locked_at: string | null;
    archived_at: string | null;
    step_count: number;
    tool_name: string | null;
    parameters_text: string | null;
    comments_text: string | null;
  }>(),
    pickerView ? Promise.resolve({ results: [] as Array<{ template_version_id: string; r2_key: string }> }) : c.env.DB.prepare(
      `SELECT tv.id AS template_version_id, a.r2_key
       FROM template_versions tv
       JOIN state_representation_assets sra ON sra.state_hash = tv.initial_state_hash
       JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
       WHERE tv.archived_at IS NULL AND tv.deleted_at IS NULL
         AND ${publishedTemplateVersionSql("tv")}
         AND ${publishedAssetSql("a")}
       ORDER BY tv.id, sra.position, a.id`,
    ).all<{ template_version_id: string; r2_key: string }>(),
  ]);
  const initialAssets = new Map<string, string[]>();
  for (const row of initialAssetRows.results) {
    initialAssets.set(row.template_version_id, [...(initialAssets.get(row.template_version_id) ?? []), row.r2_key]);
  }
  const d1Duration = performance.now() - d1Started;
  const serializeStarted = performance.now();
  const payload = { templates: result.results.map((row) => ({
    id: row.id,
    recipeFamilyId: row.recipe_family_id,
    name: row.name,
    templateType: row.template_type,
    templateKind: row.template_kind,
    version: row.version,
    manifestHash: row.manifest_hash,
    sourceFilename: row.source_filename,
    stepCount: Number(row.step_count),
    toolName: row.tool_name,
    parametersText: row.parameters_text,
    commentsText: row.comments_text,
    initialStateHash: row.initial_state_hash,
    initialStateImageKeys: initialAssets.get(row.id) ?? [],
    initialSubstrateStep: pickerView ? null : parseInitialSubstrateStep(row.content_json),
    locked: Boolean(row.locked_at),
    lockedAt: row.locked_at,
    createdAt: row.created_at,
  })) };
  const serializeDuration = performance.now() - serializeStarted;
  const response = c.json(payload);
  response.headers.set("Server-Timing", `d1;dur=${d1Duration.toFixed(1)}, serialize;dur=${serializeDuration.toFixed(1)}`);
  return response;
});

app.post("/metrology-templates", async (c) => {
  const input = await c.req.json<{
    name?: string; toolName?: string; parametersText?: string; commentsText?: string;
  }>();
  if (typeof input.name !== "string" || typeof input.toolName !== "string"
    || typeof input.parametersText !== "string" || typeof input.commentsText !== "string") {
    throw new HTTPException(400, { message: "Valid metrology-template fields are required" });
  }
  const name = input.name.trim();
  const toolName = input.toolName.trim();
  const parametersText = input.parametersText.trim();
  const commentsText = input.commentsText.trim();
  if (!name || name.length > 200 || toolName.length > 500
    || parametersText.length > 10_000 || commentsText.length > 10_000) {
    throw new HTTPException(400, { message: "One or more metrology-template fields are invalid" });
  }
  const definition = await hashStepDefinition({ name, toolName, parametersText, commentsText });
  const familyId = crypto.randomUUID();
  const templateId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const logicalKey = `metrology:${stepId}`;
  const manifestHash = await hashRecipeManifest([
    { logicalStepKey: logicalKey, definitionHash: definition.hash, expectedStateHash: null },
  ]);
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO recipe_families (id, name, template_type, created_by, created_at)
         VALUES (?, ?, 'module', ?, ?)`,
      ).bind(familyId, `Metrology template · ${familyId}`, userEmail, now),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO step_definitions
         (hash, hash_scheme, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
        definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now),
      c.env.DB.prepare(
        `INSERT INTO template_versions
         (id, recipe_family_id, name, template_type, template_kind, version, manifest_hash,
          content_json, created_by, created_at)
         VALUES (?, ?, ?, 'module', 'metrology', 1, ?, '{}', ?, ?)`,
      ).bind(templateId, familyId, name, manifestHash, userEmail, now),
      c.env.DB.prepare(
        `INSERT INTO template_steps
         (id, template_version_id, logical_step_key, position, definition_hash, raw_json)
         VALUES (?, ?, ?, 0, ?, '{}')`,
      ).bind(stepId, templateId, logicalKey, definition.hash),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      throw new HTTPException(409, { message: "A metrology template with this title already exists" });
    }
    throw error;
  }
  return c.json({ id: templateId, version: 1 }, 201);
});

app.patch("/metrology-templates/:id", async (c) => {
  const id = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, id);
  const input = await c.req.json<{
    name?: string; toolName?: string; parametersText?: string; commentsText?: string;
  }>();
  if (typeof input.name !== "string" || typeof input.toolName !== "string"
    || typeof input.parametersText !== "string" || typeof input.commentsText !== "string") {
    throw new HTTPException(400, { message: "Valid metrology-template fields are required" });
  }
  const name = input.name.trim();
  const toolName = input.toolName.trim();
  const parametersText = input.parametersText.trim();
  const commentsText = input.commentsText.trim();
  if (!name || name.length > 200 || toolName.length > 500
    || parametersText.length > 10_000 || commentsText.length > 10_000) {
    throw new HTTPException(400, { message: "One or more metrology-template fields are invalid" });
  }
  const template = await c.env.DB.prepare(
    `SELECT ts.id AS template_step_id, ts.logical_step_key
     FROM template_versions tv
     JOIN template_steps ts ON ts.template_version_id = tv.id
     WHERE tv.id = ? AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL
       AND tv.deleted_at IS NULL
       AND (SELECT COUNT(*) FROM template_steps only_step WHERE only_step.template_version_id = tv.id) = 1`,
  ).bind(id).first<{ template_step_id: string; logical_step_key: string }>();
  if (!template) throw new HTTPException(404, { message: "Metrology template not found" });
  const definition = await hashStepDefinition({ name, toolName, parametersText, commentsText });
  const manifestHash = await hashRecipeManifest([
    { logicalStepKey: template.logical_step_key, definitionHash: definition.hash, expectedStateHash: null },
  ]);
  const now = new Date().toISOString();
  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO step_definitions
         (hash, hash_scheme, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
        definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now),
      c.env.DB.prepare(
        `UPDATE template_versions SET name = ?, manifest_hash = ?
         WHERE id = ? AND template_kind = 'metrology'
           AND archived_at IS NULL AND deleted_at IS NULL`,
      ).bind(name, manifestHash, id),
      c.env.DB.prepare(
        `UPDATE template_steps SET definition_hash = ?, expected_state_hash = NULL
         WHERE id = ? AND template_version_id = ?`,
      ).bind(definition.hash, template.template_step_id, id),
    ]);
    if (results.slice(1).some((result) => !result.meta.changes)) {
      throw new HTTPException(409, { message: "This metrology template changed while it was being saved" });
    }
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (String(error).includes("UNIQUE")) {
      throw new HTTPException(409, { message: "A metrology template with this title already exists" });
    }
    throw error;
  }
  return c.json({ ok: true });
});

app.patch("/metrology-templates/:id/notes", async (c) => {
  const id = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, id);
  const input = await c.req.json<{ notes?: string }>();
  if (typeof input.notes !== "string" || input.notes.length > 20_000) {
    throw new HTTPException(400, { message: "Equipment or method notes must be at most 20,000 characters" });
  }
  const result = await c.env.DB.prepare(
    `UPDATE template_versions SET metrology_notes = ?
     WHERE id = ? AND template_kind = 'metrology'
       AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(input.notes.trim() || null, id).run();
  if (!result.meta.changes) throw new HTTPException(404, { message: "Metrology template not found" });
  return c.json({ ok: true });
});

app.post("/metrology-templates/:id/references", async (c) => {
  const templateId = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, templateId);
  if (!contentLengthWithin(c.req.raw, 25 * 1024 * 1024)) {
    throw new HTTPException(413, { message: "Template reference files are limited to 25 MB" });
  }
  const filename = (c.req.header("x-filename") || "reference").trim();
  const mimeType = (c.req.header("content-type") || "application/octet-stream").trim();
  if (!filename || filename.length > 255 || mimeType.length > 200) {
    throw new HTTPException(400, { message: "Reference-file metadata is invalid" });
  }
  const template = await c.env.DB.prepare(
    `SELECT id FROM template_versions
     WHERE id = ? AND template_kind = 'metrology'
       AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(templateId).first<{ id: string }>();
  if (!template) throw new HTTPException(404, { message: "Metrology template not found" });
  const buffer = await c.req.arrayBuffer();
  if (!buffer.byteLength || buffer.byteLength > 25 * 1024 * 1024) {
    throw new HTTPException(413, { message: "Template reference files must be between 1 byte and 25 MB" });
  }
  const sha256 = await digestSha256(buffer);
  const existingReference = await c.env.DB.prepare(
    `SELECT mtr.id, mtr.asset_id, mtr.display_name, mtr.created_at, mtr.deleted_at
     FROM metrology_template_references mtr
     JOIN assets a ON a.id = mtr.asset_id AND a.status = 'ready'
     WHERE mtr.template_version_id = ? AND a.sha256 = ?
       AND ${publishedAssetSql("a")}
     ORDER BY mtr.created_at DESC LIMIT 1`,
  ).bind(templateId, sha256).first<{
    id: string; asset_id: string; display_name: string;
    created_at: string; deleted_at: string | null;
  }>();

  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const assetId = crypto.randomUUID();
  const key = `metrology/${templateId}/${assetId}-${safeObjectName(filename)}`;
  const registration = await registerR2Asset(c.env, {
      id: assetId,
      objectKey: key,
      originalName: filename,
      mimeType,
      byteSize: buffer.byteLength,
      sha256,
      actorEmail: userEmail,
      bytes: buffer,
      findWinner: () => reusableR2Asset(c.env, sha256),
    }).catch((error: unknown) => {
      if (error instanceof BlobRegistrationAuthorityUnavailableError) {
        throw new HTTPException(503, {
          message: error.publicMessage,
        });
      }
      throw error;
    });
  const asset = registration.asset;

  if (existingReference) {
    const displayName = existingReference.deleted_at ? filename : existingReference.display_name;
    if (existingReference.deleted_at || existingReference.asset_id !== asset.id) {
      try {
        const updated = await c.env.DB.prepare(
          `UPDATE metrology_template_references
           SET asset_id = ?, display_name = ?, deleted_at = NULL, deleted_by = NULL
           WHERE id = ? AND template_version_id = ?`,
        ).bind(asset.id, displayName, existingReference.id, templateId).run();
        if (!updated.meta.changes) throw new HTTPException(409, { message: "This reference file changed elsewhere" });
      } catch (error) {
        // A committed ready asset may already have been reused elsewhere.
        // Leave an unattached row to the shared registration-grace/GC path.
        throw error;
      }
    }
    return c.json({ reference: {
      id: existingReference.id,
      filename: displayName,
      mimeType: asset.mime_type,
      byteSize: Number(asset.byte_size),
      assetKey: asset.r2_key,
      createdAt: existingReference.created_at,
    } });
  }

  const referenceId = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      `INSERT INTO metrology_template_references
       (id, template_version_id, asset_id, display_name, position, actor_email, created_at)
       VALUES (?, ?, ?, ?, COALESCE((
         SELECT MAX(position) + 1 FROM metrology_template_references WHERE template_version_id = ?
       ), 0), ?, ?)`,
    ).bind(referenceId, templateId, asset.id, filename, templateId, userEmail, now).run();
  } catch (error) {
    // Once ready registration commits, route-local rollback no longer owns the
    // provider object. Unattached assets are reclaimed through shared GC.
    if (String(error).includes("UNIQUE")) {
      throw new HTTPException(409, { message: "This reference file is already attached" });
    }
    throw error;
  }
  return c.json({ reference: {
    id: referenceId,
    filename,
    mimeType: asset.mime_type,
    byteSize: Number(asset.byte_size),
    assetKey: asset.r2_key,
    createdAt: now,
  } }, 201);
});

app.delete("/metrology-templates/:id/references/:referenceId", async (c) => {
  const { id, referenceId } = c.req.param();
  await requirePublishedTemplateVersion(c.env.DB, id);
  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(
    `UPDATE metrology_template_references
     SET deleted_at = ?, deleted_by = ?
     WHERE id = ? AND template_version_id = ?
       AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM template_versions
         WHERE id = ? AND template_kind = 'metrology'
           AND archived_at IS NULL AND deleted_at IS NULL
       )`,
  ).bind(now, c.get("userEmail"), referenceId, id, id).run();
  if (!result.meta.changes) throw new HTTPException(404, { message: "Template reference not found" });
  return c.json({ ok: true });
});

app.post("/metrology-templates/:id/references/:referenceId/restore", async (c) => {
  const { id, referenceId } = c.req.param();
  await requirePublishedTemplateVersion(c.env.DB, id);
  const result = await c.env.DB.prepare(
    `UPDATE metrology_template_references
     SET deleted_at = NULL, deleted_by = NULL
     WHERE id = ? AND template_version_id = ? AND deleted_at IS NOT NULL
       AND superseded_by_occurrence_id IS NULL
       AND EXISTS (
         SELECT 1 FROM template_versions
         WHERE id = ? AND template_kind = 'metrology'
           AND archived_at IS NULL AND deleted_at IS NULL
       )`,
  ).bind(referenceId, id, id).run();
  if (!result.meta.changes) throw new HTTPException(404, { message: "Deleted template reference not found" });
  return c.json({ ok: true });
});

app.post("/templates/:id/clone", async (c) => {
  const sourceId = c.req.param("id");
  const [source, steps] = await Promise.all([
    c.env.DB.prepare(
      `SELECT * FROM template_versions tv
       WHERE tv.id = ? AND tv.deleted_at IS NULL
         AND ${publishedTemplateVersionSql("tv")}`,
    ).bind(sourceId).first<Record<string, unknown>>(),
    c.env.DB.prepare("SELECT * FROM template_steps WHERE template_version_id = ? ORDER BY position").bind(sourceId).all<Record<string, unknown>>(),
  ]);
  if (!source) throw new HTTPException(404, { message: "Template version not found" });
  const latest = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM template_versions WHERE recipe_family_id = ?",
  ).bind(source.recipe_family_id).first<{ version: number }>();
  const id = crypto.randomUUID();
  const version = Number(latest?.version ?? 0) + 1;
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const stepIds = new Map(steps.results.map((step) => [String(step.id), crypto.randomUUID()]));
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO template_versions
        (id, recipe_family_id, name, template_type, template_kind, version, manifest_hash, initial_state_hash,
         source_filename, source_asset_key, content_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, source.recipe_family_id, source.name, source.template_type, source.template_kind, version, source.manifest_hash,
      source.initial_state_hash, source.source_filename, source.source_asset_key, source.content_json, userEmail, now),
    ...bulkInsertStatements(c.env.DB, "template_steps",
      ["id", "template_version_id", "logical_step_key", "position", "source_row", "step_number", "section_name", "definition_hash", "expected_state_hash", "raw_json"],
      steps.results.map((step) => [stepIds.get(String(step.id)), id, step.logical_step_key, step.position,
        step.source_row, step.step_number, step.section_name, step.definition_hash, step.expected_state_hash, step.raw_json])),
  ];
  if (statements.length > 49) throw new HTTPException(413, { message: "This template is too large to clone on the current plan" });
  await c.env.DB.batch(statements);
  return c.json({ id, version }, 201);
});

app.get("/templates/:id", async (c) => {
  const id = c.req.param("id");
  const [template, stepRows, assetRows, initialAssetRows, referenceRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, recipe_family_id, name, template_type, template_kind, metrology_notes,
              version, manifest_hash, initial_state_hash,
              source_filename, content_json, locked_at, archived_at, created_at
       FROM template_versions tv
       WHERE tv.id = ? AND tv.deleted_at IS NULL
         AND ${publishedTemplateVersionSql("tv")}`,
    ).bind(id).first<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT ts.id, ts.logical_step_key, ts.definition_hash, ts.expected_state_hash,
              ts.position, ts.source_row, ts.step_number, ts.section_name,
              sd.name, sd.tool_name, sd.parameters_text, sd.comments_text
       FROM template_steps ts JOIN step_definitions sd ON sd.hash = ts.definition_hash
       WHERE ts.template_version_id = ? ORDER BY ts.position`,
    ).bind(id).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT ts.id AS template_step_id, a.r2_key
       FROM template_steps ts
       JOIN state_representation_assets sra ON sra.state_hash = ts.expected_state_hash
       JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
       WHERE ts.template_version_id = ?
         AND ${publishedAssetSql("a")}
       ORDER BY ts.id, sra.position, a.id`,
    ).bind(id).all<{ template_step_id: string; r2_key: string }>(),
    c.env.DB.prepare(
      `SELECT a.r2_key
       FROM template_versions tv
       JOIN state_representation_assets sra ON sra.state_hash = tv.initial_state_hash
       JOIN assets a ON a.id = sra.asset_id AND a.status = 'ready'
       WHERE tv.id = ?
         AND ${publishedTemplateVersionSql("tv")}
         AND ${publishedAssetSql("a")}
       ORDER BY sra.position, a.id`,
    ).bind(id).all<{ r2_key: string }>(),
    c.env.DB.prepare(
      `SELECT mtr.id, mtr.display_name, a.mime_type, a.byte_size, a.r2_key, mtr.created_at
       FROM metrology_template_references mtr
       JOIN assets a ON a.id = mtr.asset_id AND a.status = 'ready'
       WHERE mtr.template_version_id = ? AND mtr.deleted_at IS NULL
         AND ${publishedAssetSql("a")}
       ORDER BY mtr.position, mtr.created_at, mtr.id`,
    ).bind(id).all<{
      id: string; display_name: string; mime_type: string; byte_size: number;
      r2_key: string; created_at: string;
    }>(),
  ]);
  if (!template) throw new HTTPException(404, { message: "Template version not found" });
  const images = new Map<string, string[]>();
  for (const row of assetRows.results) images.set(row.template_step_id, [...(images.get(row.template_step_id) ?? []), row.r2_key]);
  return c.json({ template: {
    id: String(template.id), recipeFamilyId: String(template.recipe_family_id), name: String(template.name),
    templateType: String(template.template_type), templateKind: String(template.template_kind),
    version: Number(template.version),
    manifestHash: String(template.manifest_hash),
    initialStateHash: template.initial_state_hash ? String(template.initial_state_hash) : null,
    initialStateImageKeys: initialAssetRows.results.map((row) => row.r2_key),
    initialSubstrateStep: parseInitialSubstrateStep(template.content_json ? String(template.content_json) : null),
    sourceFilename: template.source_filename ? String(template.source_filename) : null,
    metrologyNotes: template.metrology_notes ? String(template.metrology_notes) : null,
    referenceAttachments: referenceRows.results.map((reference) => ({
      id: reference.id,
      filename: reference.display_name,
      mimeType: reference.mime_type,
      byteSize: Number(reference.byte_size),
      assetKey: reference.r2_key,
      createdAt: reference.created_at,
    })),
    locked: Boolean(template.locked_at), lockedAt: template.locked_at ? String(template.locked_at) : null,
    archived: Boolean(template.archived_at), createdAt: String(template.created_at),
    steps: stepRows.results.map((step) => ({
      id: String(step.id), logicalStepKey: String(step.logical_step_key), definitionHash: String(step.definition_hash),
      expectedStateHash: step.expected_state_hash ? String(step.expected_state_hash) : null,
      position: Number(step.position), sourceRow: step.source_row === null ? null : Number(step.source_row),
      stepNumber: step.step_number ? String(step.step_number) : null, sectionName: step.section_name ? String(step.section_name) : null,
      name: String(step.name), toolName: step.tool_name ? String(step.tool_name) : null,
      parametersText: step.parameters_text ? String(step.parameters_text) : null,
      commentsText: step.comments_text ? String(step.comments_text) : null,
      imageKeys: images.get(String(step.id)) ?? [],
    })),
  } });
});

app.patch("/templates/:id", async (c) => {
  const id = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, id);
  const input = await c.req.json<{ name?: string; version?: number }>();
  if (typeof input.name !== "string" || typeof input.version !== "number" || !Number.isInteger(input.version) || input.version < 1) throw new HTTPException(400, { message: "A template name and positive integer version are required" });
  const name = input.name.trim();
  if (!name || name.length > 200) throw new HTTPException(400, { message: "Template name is required and must be at most 200 characters" });
  const current = await c.env.DB.prepare(
    "SELECT locked_at, archived_at, deleted_at FROM template_versions WHERE id = ?",
  ).bind(id).first<{ locked_at: string | null; archived_at: string | null; deleted_at: string | null }>();
  if (!current) throw new HTTPException(404, { message: "Template version not found" });
  if (current.deleted_at) throw new HTTPException(404, { message: "Template version not found" });
  if (current.archived_at) throw new HTTPException(409, { message: "Archived templates cannot be edited" });
  if (current.locked_at) throw new HTTPException(409, { message: "This template version has been used by a process run and is now locked. Clone it to create an editable version." });
  try {
    const result = await c.env.DB.prepare(
      `UPDATE template_versions SET name = ?, version = ?
       WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`,
    ).bind(name, input.version, id).run();
    if (!result.meta.changes) throw new HTTPException(409, { message: "This template version was used to start a process run while you were editing it. Clone it to continue." });
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HTTPException(409, { message: `Version ${input.version} already exists for this template` });
    throw error;
  }
  return c.json({ ok: true });
});

app.post("/templates/:id/steps", async (c) => {
  const templateId = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, templateId);
  const input = await c.req.json<{ name?: string; toolName?: string; parametersText?: string; commentsText?: string; assetKey?: string }>();
  if (typeof input.name !== "string" || typeof input.toolName !== "string" || typeof input.parametersText !== "string" || typeof input.commentsText !== "string" || (input.assetKey !== undefined && typeof input.assetKey !== "string")) throw new HTTPException(400, { message: "Valid template step fields are required" });
  const name = input.name.trim();
  if (!name || name.length > 200 || input.toolName.length > 500 || input.parametersText.length > 10_000 || input.commentsText.length > 10_000) throw new HTTPException(400, { message: "One or more template step fields are invalid" });
  const definition = await hashStepDefinition({ name, toolName: input.toolName, parametersText: input.parametersText, commentsText: input.commentsText });
  const [template, existingSteps, asset] = await Promise.all([
    c.env.DB.prepare(
      "SELECT locked_at, archived_at, deleted_at FROM template_versions WHERE id = ?",
    ).bind(templateId).first<{ locked_at: string | null; archived_at: string | null; deleted_at: string | null }>(),
    c.env.DB.prepare("SELECT logical_step_key, definition_hash, expected_state_hash, position FROM template_steps WHERE template_version_id = ? ORDER BY position")
      .bind(templateId).all<{ logical_step_key: string; definition_hash: string; expected_state_hash: string | null; position: number }>(),
    input.assetKey ? c.env.DB.prepare(
      `SELECT id, sha256 FROM assets a WHERE status = 'ready' AND r2_key = ?
         AND ${publishedAssetSql("a")}
         AND NOT EXISTS (
           SELECT 1 FROM blob_gc_ledger bg
           WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
             AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
         )`,
    ).bind(input.assetKey).first<{ id: string; sha256: string }>() : Promise.resolve(null),
  ]);
  if (!template || template.deleted_at) throw new HTTPException(404, { message: "Template version not found" });
  if (template.archived_at || template.locked_at) throw new HTTPException(409, { message: "Only unused active template versions can be edited" });
  if (input.assetKey && !asset) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const stepId = crypto.randomUUID();
  const now = new Date().toISOString();
  const state = asset ? await hashStateRepresentation([asset.sha256]) : null;
  const expectedStateHash = state?.hash ?? existingSteps.results.at(-1)?.expected_state_hash ?? null;
  const logicalKey = `manual:${stepId}`;
  const manifestHash = await hashRecipeManifest([
    ...existingSteps.results.map((step) => ({ logicalStepKey: step.logical_step_key, definitionHash: step.definition_hash, expectedStateHash: step.expected_state_hash })),
    { logicalStepKey: logicalKey, definitionHash: definition.hash, expectedStateHash },
  ]);
  const statements = [
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO step_definitions
       (hash, hash_scheme, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
      definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now),
  ];
  if (state) statements.push(c.env.DB.prepare(
    `INSERT OR IGNORE INTO state_representations (hash, hash_scheme, representation_type, content_json, created_at)
     VALUES (?, ?, 'diagram', ?, ?)`,
  ).bind(state.hash, STATE_HASH_SCHEME, stableJson(state.canonical), now));
  if (state && asset) statements.push(c.env.DB.prepare(
    "INSERT OR IGNORE INTO state_representation_assets (state_hash, asset_id, position) VALUES (?, ?, 0)",
  ).bind(state.hash, asset.id));
  statements.push(c.env.DB.prepare(
    `INSERT INTO template_steps
     (id, template_version_id, logical_step_key, position, definition_hash, expected_state_hash)
     SELECT ?, id, ?, ?, ?, ? FROM template_versions
     WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(stepId, logicalKey, Number(existingSteps.results.at(-1)?.position ?? -1) + 1, definition.hash, expectedStateHash, templateId));
  statements.push(c.env.DB.prepare(
    `UPDATE template_versions SET manifest_hash = ?
     WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(manifestHash, templateId));
  const results = await c.env.DB.batch(statements);
  if (!results[results.length - 2].meta.changes || !results.at(-1)?.meta.changes) throw new HTTPException(409, { message: "This template version was used to start a process run while you were editing it. Clone it to continue." });
  return c.json({ id: stepId }, 201);
});

app.patch("/templates/:templateId/steps/:stepId", async (c) => {
  const { templateId, stepId } = c.req.param();
  await requirePublishedTemplateVersion(c.env.DB, templateId);
  const input = await c.req.json<{ name?: string; toolName?: string; parametersText?: string; commentsText?: string; assetKey?: string }>();
  if (typeof input.name !== "string" || typeof input.toolName !== "string" || typeof input.parametersText !== "string" || typeof input.commentsText !== "string" || (input.assetKey !== undefined && typeof input.assetKey !== "string")) throw new HTTPException(400, { message: "Valid template step fields are required" });
  const name = input.name.trim();
  if (!name || name.length > 200 || input.toolName.length > 500 || input.parametersText.length > 10_000 || input.commentsText.length > 10_000) throw new HTTPException(400, { message: "One or more template step fields are invalid" });
  const definition = await hashStepDefinition({ name, toolName: input.toolName, parametersText: input.parametersText, commentsText: input.commentsText });
  const [template, step, allSteps, asset] = await Promise.all([
    c.env.DB.prepare(
      "SELECT locked_at, archived_at, deleted_at FROM template_versions WHERE id = ?",
    ).bind(templateId).first<{ locked_at: string | null; archived_at: string | null; deleted_at: string | null }>(),
    c.env.DB.prepare("SELECT id, logical_step_key, expected_state_hash FROM template_steps WHERE id = ? AND template_version_id = ?")
      .bind(stepId, templateId).first<{ id: string; logical_step_key: string; expected_state_hash: string | null }>(),
    c.env.DB.prepare("SELECT id, logical_step_key, definition_hash, expected_state_hash FROM template_steps WHERE template_version_id = ? ORDER BY position")
      .bind(templateId).all<{ id: string; logical_step_key: string; definition_hash: string; expected_state_hash: string | null }>(),
    input.assetKey ? c.env.DB.prepare(
      `SELECT id, sha256 FROM assets a WHERE status = 'ready' AND r2_key = ?
         AND ${publishedAssetSql("a")}
         AND NOT EXISTS (
           SELECT 1 FROM blob_gc_ledger bg
           WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
             AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
         )`,
    ).bind(input.assetKey).first<{ id: string; sha256: string }>() : Promise.resolve(null),
  ]);
  if (!template || template.deleted_at || !step) throw new HTTPException(404, { message: "Template step not found" });
  if (template.archived_at || template.locked_at) throw new HTTPException(409, { message: "Only unused active template versions can be edited" });
  if (input.assetKey && !asset) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const now = new Date().toISOString();
  const state = asset ? await hashStateRepresentation([asset.sha256]) : null;
  const expectedStateHash = state?.hash ?? step.expected_state_hash;
  const manifestHash = await hashRecipeManifest(allSteps.results.map((entry) => ({
    logicalStepKey: entry.logical_step_key,
    definitionHash: entry.id === stepId ? definition.hash : entry.definition_hash,
    expectedStateHash: entry.id === stepId ? expectedStateHash : entry.expected_state_hash,
  })));
  const statements = [c.env.DB.prepare(
    `INSERT OR IGNORE INTO step_definitions
     (hash, hash_scheme, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
    definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now)];
  if (state) statements.push(c.env.DB.prepare(
    `INSERT OR IGNORE INTO state_representations (hash, hash_scheme, representation_type, content_json, created_at)
     VALUES (?, ?, 'diagram', ?, ?)`,
  ).bind(state.hash, STATE_HASH_SCHEME, stableJson(state.canonical), now));
  if (state && asset) statements.push(c.env.DB.prepare(
    "INSERT OR IGNORE INTO state_representation_assets (state_hash, asset_id, position) VALUES (?, ?, 0)",
  ).bind(state.hash, asset.id));
  statements.push(c.env.DB.prepare(
    `UPDATE template_steps SET definition_hash = ?, expected_state_hash = ?
     WHERE id = ? AND template_version_id = ? AND EXISTS (
       SELECT 1 FROM template_versions
       WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL
     )`,
  ).bind(definition.hash, expectedStateHash, stepId, templateId, templateId));
  statements.push(c.env.DB.prepare(
    `UPDATE template_versions SET manifest_hash = ?
     WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(manifestHash, templateId));
  const results = await c.env.DB.batch(statements);
  if (!results[results.length - 2].meta.changes || !results.at(-1)?.meta.changes) throw new HTTPException(409, { message: "This template version was used to start a process run while you were editing it. Clone it to continue." });
  return c.json({ ok: true });
});

app.delete("/templates/:templateId/steps/:stepId", async (c) => {
  const { templateId, stepId } = c.req.param();
  await requirePublishedTemplateVersion(c.env.DB, templateId);
  const [template, step, remainingSteps] = await Promise.all([
    c.env.DB.prepare("SELECT locked_at, archived_at, deleted_at FROM template_versions WHERE id = ?")
      .bind(templateId).first<{ locked_at: string | null; archived_at: string | null; deleted_at: string | null }>(),
    c.env.DB.prepare(
      "SELECT id FROM template_steps WHERE id = ? AND template_version_id = ?",
    ).bind(stepId, templateId).first<{ id: string }>(),
    c.env.DB.prepare(
      `SELECT logical_step_key, definition_hash, expected_state_hash
       FROM template_steps WHERE template_version_id = ? AND id != ? ORDER BY position`,
    ).bind(templateId, stepId).all<{
      logical_step_key: string;
      definition_hash: string;
      expected_state_hash: string | null;
    }>(),
  ]);
  if (!template || template.deleted_at || !step) throw new HTTPException(404, { message: "Template step not found" });
  if (template.archived_at || template.locked_at) throw new HTTPException(409, { message: "Only unused active template versions can be edited" });
  const manifestHash = await hashRecipeManifest(remainingSteps.results.map((entry) => ({
    logicalStepKey: entry.logical_step_key,
    definitionHash: entry.definition_hash,
    expectedStateHash: entry.expected_state_hash,
  })));
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM template_steps
       WHERE id = ? AND template_version_id = ?
         AND EXISTS (
           SELECT 1 FROM template_versions
           WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL
         )`,
    ).bind(stepId, templateId, templateId),
    c.env.DB.prepare(
      `UPDATE template_versions SET manifest_hash = ?
       WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`,
    ).bind(manifestHash, templateId),
  ]);
  if (!results[0].meta.changes || !results[1].meta.changes) {
    throw new HTTPException(409, { message: "This template version was used to start a process run while the step was being deleted. Clone it to continue." });
  }
  return c.json({ ok: true });
});

app.delete("/templates/:id", async (c) => {
  const id = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, id);
  const template = await c.env.DB.prepare(
    `SELECT tv.recipe_family_id, tv.locked_at, tv.archived_at, tv.deleted_at,
            EXISTS (SELECT 1 FROM runs r WHERE r.template_version_id = tv.id) OR
            EXISTS (SELECT 1 FROM run_plan_revisions rpr WHERE rpr.template_version_id = tv.id) OR
            EXISTS (
              SELECT 1 FROM run_steps rs
              JOIN template_steps ts ON ts.id = rs.template_step_id
              WHERE ts.template_version_id = tv.id
            ) OR
            EXISTS (SELECT 1 FROM recipe_change_proposals rcp WHERE rcp.source_template_version_id = tv.id) AS referenced
     FROM template_versions tv WHERE tv.id = ?`,
  ).bind(id).first<{
    recipe_family_id: string; locked_at: string | null; archived_at: string | null;
    deleted_at: string | null; referenced: number;
  }>();
  if (!template || template.archived_at || template.deleted_at) {
    throw new HTTPException(404, { message: "Active template version not found" });
  }

  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const archive = Boolean(template.locked_at || template.referenced);
  const result = await c.env.DB.prepare(
    `UPDATE template_versions
     SET deleted_at = ?, deleted_by = ?,
         archived_at = CASE WHEN ? THEN ? ELSE archived_at END,
         archived_by = CASE WHEN ? THEN ? ELSE archived_by END
     WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(now, userEmail, archive ? 1 : 0, now, archive ? 1 : 0, userEmail, id).run();
  if (!result.meta.changes) {
    throw new HTTPException(409, { message: "This template changed while it was being deleted" });
  }
  return c.json({ ok: true, disposition: archive ? "archived" as const : "deleted" as const });
});

app.post("/templates/:id/restore", async (c) => {
  const id = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, id);
  const template = await c.env.DB.prepare(
    `SELECT deleted_at, deleted_by, archived_at, archived_by
     FROM template_versions WHERE id = ? AND deleted_at IS NOT NULL`,
  ).bind(id).first<{
    deleted_at: string; deleted_by: string | null;
    archived_at: string | null; archived_by: string | null;
  }>();
  if (!template) throw new HTTPException(404, { message: "Deleted template version not found" });
  const result = await c.env.DB.prepare(
    `UPDATE template_versions
     SET archived_at = CASE
           WHEN archived_at = deleted_at AND archived_by IS deleted_by THEN NULL
           ELSE archived_at
         END,
         archived_by = CASE
           WHEN archived_at = deleted_at AND archived_by IS deleted_by THEN NULL
           ELSE archived_by
         END,
         deleted_at = NULL,
         deleted_by = NULL
     WHERE id = ? AND deleted_at = ?`,
  ).bind(id, template.deleted_at).run();
  if (!result.meta.changes) {
    throw new HTTPException(409, { message: "The template changed while it was being restored" });
  }
  return c.json({ ok: true });
});

export default {
  fetch: (request: Request, env: Env, executionContext: ExecutionContext) => app.fetch(request, env, executionContext),
  scheduled: (_event: ScheduledController, env: Env, executionContext: ExecutionContext) => {
    executionContext.waitUntil(cleanupCommentUploads(env));
  },
} satisfies ExportedHandler<Env>;
