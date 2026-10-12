import { HTTPException } from "hono/http-exception";
import type { CreateRunStepCommentsInput, RunStepTarget } from "../../shared/types";
import { validRunStepTargets } from "../execution/step-targets";
import type { ReadSqlRow } from "../runtime/read-sql";
import type { RunStepCommentDatabase, RunStepCommentStatement } from "./comment-creation-sql";

export type CapturedRunStepCommentInput = Readonly<{
  scope: "common" | "individual"; body: string; assetKey?: string;
  targets: readonly Readonly<RunStepTarget>[];
}>;
export type RunStepCommentFileInput = Readonly<{ assetId: string; purpose: "embedded_content" }>;
export interface RunStepCommentCreationCapabilities {
  database(): RunStepCommentDatabase;
  /** Genuine original Request/current principal/control; a syntax-only actor is never a grant. */
  admit(actor: string): Promise<void>;
  now(): number;
  randomId(): string;
  fileAuthorityActiveSql(): Promise<"1" | "0">;
  resolveConsumerFileId(input: RunStepCommentFileInput): Promise<string | null>;
  consumerFileBindingFence(input: RunStepCommentFileInput, fileId: string | null): RunStepCommentStatement;
}
function rowText(row: ReadSqlRow, field: string): string {
  const value=row[field]; if(typeof value!=="string") throw new TypeError(`Invalid Comment SQL text: ${field}`); return value;
}
/** Original route validator, followed only by immutable selector capture. */
export function captureRunStepCommentInput(value: unknown): CapturedRunStepCommentInput {
  const input = value as CreateRunStepCommentsInput;
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

  return Object.freeze({ scope: input.scope, body: input.body,
    ...(input.assetKey === undefined ? {} : { assetKey: input.assetKey }),
    targets: Object.freeze(input.targets.map(target=>Object.freeze({sampleId:target.sampleId,
      runId:target.runId,stepId:target.stepId,expectedUpdatedAt:target.expectedUpdatedAt}))),
  });
}

/** Complete mature common/individual creation SQL, target CAS, occurrence RETURNING
 * proof, actor audits and File fences. No structural port supplies resource rights. */
export async function createRunStepCommentsWithDatabase(capabilities:RunStepCommentCreationCapabilities,
  value:unknown, actor:string) {
  const input=captureRunStepCommentInput(value);
  const body=input.body.trim(), assetKey=input.assetKey?.trim() || null;
  await capabilities.admit(actor); const db=capabilities.database();

  const values = input.targets.map(() => "(?, ?, ?, ?)").join(", ");
  const bindings = input.targets.flatMap((target) => [target.sampleId, target.runId, target.stepId, target.expectedUpdatedAt]);
  const [matched, commentAsset] = await Promise.all([db.prepare(
    `WITH requested(sample_id, run_id, step_id, expected_updated_at) AS (VALUES ${values})
     SELECT q.sample_id, q.run_id, q.step_id
     FROM requested q
     JOIN runs r ON r.id = q.run_id AND r.sample_id = q.sample_id
     JOIN run_steps rs ON rs.id = q.step_id AND rs.run_id = q.run_id
     JOIN samples s ON s.id = q.sample_id
     WHERE rs.updated_at = q.expected_updated_at
       AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
  ).bind(...bindings).all(),
  assetKey ? db.prepare(
    `SELECT id, r2_key FROM assets a WHERE status = 'ready' AND r2_key = ?
       AND (${await capabilities.fileAuthorityActiveSql()} OR NOT EXISTS (
         SELECT 1 FROM blob_gc_ledger bg
         WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
           AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
       ))`,
  ).bind(assetKey).first() : Promise.resolve(null)]);
  if (matched.results.length !== input.targets.length) {
    throw new HTTPException(404, { message: "One or more sample steps were not found" });
  }
  if (assetKey && !commentAsset) throw new HTTPException(400, { message: "The uploaded comment image is unavailable" });

  const fileInput = commentAsset ? { assetId: rowText(commentAsset, "id"), purpose: "embedded_content" as const } : null;
  const fileId = fileInput ? await capabilities.resolveConsumerFileId(fileInput) : null;
  const operationGroupId = capabilities.randomId();
  const now = new Date(capabilities.now()).toISOString();
  const userEmail = actor;
  const sampleIds = [...new Set(input.targets.map((target) => target.sampleId))];
  const occurrenceTargets = input.targets.map((target) => ({
    ...target,
    occurrenceId: capabilities.randomId(),
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
  const statements: RunStepCommentStatement[] = [db.prepare(
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
       (id, run_step_id, scope, operation_group_id, legacy_body, asset_id, file_id, actor_email, created_at)
     SELECT valid.comment_id, valid.step_id, ?, ?, ?, ?, ?, ?, ?
     FROM valid
     WHERE (SELECT COUNT(*) FROM valid) = ?
     RETURNING id`,
  ).bind(
    ...requestedBindings,
    input.scope,
    operationGroupId,
    body,
    commentAsset ? rowText(commentAsset, "id") : null,
    fileId,
    userEmail,
    now,
    occurrenceTargets.length,
  )];
  statements.push(db.prepare(
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
    statements.push(db.prepare(
      `INSERT INTO events (id, sample_id, kind, body, asset_key, asset_file_id, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'step', ?, ?, ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM run_step_comments rsc
         WHERE rsc.id IN (${sampleOccurrencePlaceholders})
           AND rsc.operation_group_id = ?
           AND rsc.deleted_at IS NULL
       ) = ?`,
    ).bind(
      capabilities.randomId(), sampleId,
      input.scope === "common" ? `Common step comment: ${body || "Image attached"}` : `Step comment: ${body || "Image attached"}`,
      commentAsset ? rowText(commentAsset, "r2_key") : null,
      fileId,
      JSON.stringify({ action: "step_comment", scope: input.scope, operationGroupId, stepIds }),
      userEmail, now,
      ...sampleOccurrenceIds,
      operationGroupId,
      sampleOccurrenceIds.length,
    ));
    statements.push(db.prepare(
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
  const fences = fileInput ? [capabilities.consumerFileBindingFence(fileInput, fileId)] : [];
  await capabilities.admit(actor);
  const results = (await db.atomicBatch([...fences, ...statements])).slice(fences.length);
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
  await capabilities.admit(actor);
  return { ok: true as const, operationGroupId };
}
