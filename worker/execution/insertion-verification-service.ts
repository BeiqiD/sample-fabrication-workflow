// Complete retained ad-hoc insertion and state-verification algorithms. Every
// original optional File attachment branch, CAS snapshot, chain guard, journal
// and result ordinal is retained. This structural SQL port grants no permission.
import { HTTPException } from "hono/http-exception";
import type { CreateRunStepInput, CreateStateVerificationInput, StepStatus } from "../../shared/types";
import { hashStepDefinition, stableJson, STEP_HASH_SCHEME } from "../../shared/content-addressing";
import { insertionPosition } from "../run-position";
import { readReadyAssetInputWithDatabase } from "../files/asset-input-service";
import { consumerFileBindingFenceWithDatabase, resolveConsumerFileIdWithDatabase } from "../files/consumer-binding-service";
import { validRunStepAssetPresentation, resolveRunStepAssetPresentationWithDatabase } from "./asset-presentation-service";
import type { ExecutionFileMetadataDatabase, ExecutionFileMetadataStatement } from "./file-metadata-sql";

export async function createExecutionStepWithDatabase<Statement extends ExecutionFileMetadataStatement<Statement>>(db: ExecutionFileMetadataDatabase<Statement>, sampleId: string, runId: string, input: CreateRunStepInput, userEmail: string) {
  if (typeof input.title !== "string" || typeof input.toolName !== "string" || typeof input.parametersText !== "string" || typeof input.commentsText !== "string" || typeof input.deviationNote !== "string" || (input.afterStepId !== undefined && typeof input.afterStepId !== "string") || (input.assetKey !== undefined && typeof input.assetKey !== "string") || (input.assetMetadata !== undefined && (!(input.assetKey || input.assetId) || !validRunStepAssetPresentation(input.assetMetadata)))) throw new HTTPException(400, { message: "Valid ad hoc step fields are required" });
  const title = input.title.trim();
  if (!title) throw new HTTPException(400, { message: "Step title is required" });
  if (title.length > 200 || input.toolName.length > 500 || input.parametersText.length > 10_000 || input.commentsText.length > 10_000 || input.deviationNote.length > 4_000) throw new HTTPException(400, { message: "One or more step fields are too long" });
  const definition = await hashStepDefinition({ name: title, toolName: input.toolName, parametersText: input.parametersText, commentsText: input.commentsText });
  const [run, stepRows, asset] = await Promise.all([
    db.prepare(
      `SELECT r.id, r.anchor_step_id FROM runs r
       JOIN samples s ON s.id = r.sample_id
       WHERE r.id = ? AND r.sample_id = ? AND r.run_kind = 'process' AND r.status = 'active'
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL`,
    ).bind(runId, sampleId).first<{ id: string; anchor_step_id: string | null }>(),
    db.prepare("SELECT id, position, updated_at FROM run_steps WHERE run_id = ? AND deleted_at IS NULL ORDER BY position")
      .bind(runId).all<{ id: string; position: number; updated_at: string }>(),
    readReadyAssetInputWithDatabase(db, input),
  ]);
  if (!run) throw new HTTPException(404, { message: "Sample run not found" });
  if ((input.assetKey || input.assetId) && !asset) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const assetFileInput = asset ? { assetId: asset.id, nativeAsset: asset.r2_key === null, purpose: "embedded_content" as const } : null;
  const assetFileId = assetFileInput ? await resolveConsumerFileIdWithDatabase(db, assetFileInput) : null;
  const assetPresentation = asset
    ? await resolveRunStepAssetPresentationWithDatabase(db, asset.id, input.assetMetadata)
    : null;
  const position = insertionPosition(stepRows.results, input.afterStepId);
  if (position === null) throw new HTTPException(404, { message: "Insertion point not found" });
  const stepId = crypto.randomUUID();
  const runStepAssetId = asset ? crypto.randomUUID() : null;
  const mutationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const afterIndex = input.afterStepId ? stepRows.results.findIndex((step) => step.id === input.afterStepId) : -1;
  const previousStepId = input.afterStepId ?? run.anchor_step_id;
  const nextStepId = stepRows.results[afterIndex + 1]?.id ?? null;
  const adjacentSteps = stepRows.results.filter((step) => step.id === input.afterStepId || step.id === nextStepId);
  const stepSnapshotSql = `AND (
       SELECT COUNT(*) FROM run_steps snapshot
       WHERE snapshot.run_id = runs.id AND snapshot.deleted_at IS NULL
     ) = ?
     ${adjacentSteps.map(() => `AND EXISTS (
       SELECT 1 FROM run_steps snapshot
       WHERE snapshot.run_id = runs.id AND snapshot.id = ?
         AND snapshot.position = ? AND snapshot.updated_at = ?
         AND snapshot.deleted_at IS NULL
     )`).join("\n")}`;
  const stepSnapshotBindings = [
    stepRows.results.length,
    ...adjacentSteps.flatMap((step) => [step.id, step.position, step.updated_at]),
  ];
  const statements: Statement[] = [
    db.prepare(
      `UPDATE runs SET last_mutation_id = ?
       WHERE id = ? AND sample_id = ? AND run_kind = 'process'
         AND status = 'active' AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM samples s
           WHERE s.id = runs.sample_id AND s.deleted_at IS NULL
         )
         ${stepSnapshotSql}`,
    ).bind(mutationId, runId, sampleId, ...stepSnapshotBindings),
    db.prepare(
      `INSERT OR IGNORE INTO step_definitions
       (hash, hash_scheme, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM runs r
         WHERE r.id = ? AND r.last_mutation_id = ?
           AND r.status = 'active' AND r.deleted_at IS NULL
       )`,
    ).bind(definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
      definition.canonical.parametersText, definition.canonical.commentsText,
      stableJson(definition.canonical), now, runId, mutationId),
    db.prepare(
      `INSERT INTO run_steps
        (id, run_id, previous_step_id, position, title, status, origin, entry_kind, logical_step_key, definition_hash,
         tool_name, parameters_text, comments_text, deviation_note, actualized_at, created_at, updated_by, updated_at)
       SELECT ?, r.id, ?, ?, ?, 'pending', 'ad_hoc', 'fabrication', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM runs r JOIN samples s ON s.id = r.sample_id
       WHERE r.id = ? AND r.sample_id = ? AND r.last_mutation_id = ?
         AND r.run_kind = 'process' AND r.status = 'active'
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL`,
    ).bind(stepId, previousStepId, position, title, `ad-hoc:${stepId}`, definition.hash,
      input.toolName.trim() || null, input.parametersText.trim() || null, input.commentsText.trim() || null,
      input.deviationNote.trim() || null, now, now, userEmail, now,
      runId, sampleId, mutationId),
  ];
  if (nextStepId) statements.push(db.prepare(
    `UPDATE run_steps SET previous_step_id = ?
     WHERE id = ? AND run_id = ? AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM run_steps inserted JOIN runs r ON r.id = inserted.run_id
         WHERE inserted.id = ? AND inserted.run_id = ?
           AND r.last_mutation_id = ? AND r.status = 'active'
           AND r.deleted_at IS NULL
       )`,
  ).bind(stepId, nextStepId, runId, stepId, runId, mutationId));
  if (asset && runStepAssetId) statements.push(db.prepare(
    `INSERT INTO run_step_assets
     (id, run_step_id, asset_id, file_id, role, position,
      filename, mime_type, byte_size, actor_email, created_at)
     SELECT ?, inserted.id, ?, ?, 'execution', 0, ?, ?, ?, ?, ?
     FROM run_steps inserted JOIN runs r ON r.id = inserted.run_id
     WHERE inserted.id = ? AND inserted.run_id = ?
       AND r.last_mutation_id = ? AND r.status = 'active'
       AND r.deleted_at IS NULL`,
  ).bind(
    runStepAssetId,
    asset.id,
    assetFileId,
    assetPresentation!.filename,
    assetPresentation!.mimeType,
    assetPresentation!.byteSize,
    userEmail,
    now,
    stepId,
    runId,
    mutationId,
  ));
  statements.push(
    db.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, s.id, 'step', ?, ?, ?, ?
       FROM run_steps inserted
       JOIN runs r ON r.id = inserted.run_id
       JOIN samples s ON s.id = r.sample_id
       WHERE inserted.id = ? AND inserted.run_id = ?
         AND r.last_mutation_id = ? AND r.status = 'active'
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL`,
    ).bind(
      crypto.randomUUID(),
      `Added ad hoc step: ${title}`,
      JSON.stringify({
        runId,
        stepId,
        action: "added",
        afterStepId: input.afterStepId ?? null,
        deviationNote: input.deviationNote.trim() || null,
      }),
      userEmail,
      now,
      stepId,
      runId,
      mutationId,
    ),
    db.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_steps inserted JOIN runs r ON r.id = inserted.run_id
           WHERE inserted.id = ? AND inserted.run_id = ?
             AND r.sample_id = samples.id AND r.last_mutation_id = ?
             AND r.status = 'active' AND r.deleted_at IS NULL
         )`,
    ).bind(userEmail, now, sampleId, stepId, runId, mutationId),
  );
  if (asset && runStepAssetId) statements.push(db.prepare(
    `INSERT INTO events (id, sample_id, kind, body, asset_key, asset_file_id, metadata_json, actor_email, created_at)
     SELECT ?, s.id, 'image', ?, ?, ?, ?, ?, ?
     FROM run_step_assets rsa
     JOIN run_steps inserted ON inserted.id = rsa.run_step_id
     JOIN runs r ON r.id = inserted.run_id
     JOIN samples s ON s.id = r.sample_id
     WHERE rsa.id = ? AND inserted.id = ? AND r.id = ?
       AND r.last_mutation_id = ? AND r.status = 'active'
       AND s.deleted_at IS NULL AND r.deleted_at IS NULL`,
  ).bind(
    crypto.randomUUID(),
    `Execution diagram for step: ${title}`,
    asset.r2_key, assetFileId,
    JSON.stringify({ runId, stepId, runStepAssetId, action: "execution_attachment_added", ...(asset.r2_key === null ? { assetId: asset.id } : {}) }),
    userEmail,
    now,
    runStepAssetId,
    stepId,
    runId,
    mutationId,
  ));
  const fences = assetFileInput ? [consumerFileBindingFenceWithDatabase(db, assetFileInput, assetFileId)] : [];
  const results = (await db.atomicBatch([...fences, ...statements])).slice(fences.length);
  if (!results[0].meta.changes || !results[2].meta.changes) {
    throw new HTTPException(409, { message: "The process run changed while the step was being added" });
  }
  return { id: stepId };
}

export async function verifyExecutionStateWithDatabase<Statement extends ExecutionFileMetadataStatement<Statement>>(db: ExecutionFileMetadataDatabase<Statement>, sampleId: string, runId: string, stepId: string, input: CreateStateVerificationInput, userEmail: string) {
  if (!input || !["matched", "mismatched"].includes(input.result)
    || typeof input.note !== "string" || typeof input.expectedUpdatedAt !== "string"
    || (input.completeStep !== undefined && typeof input.completeStep !== "boolean")
    || (input.assetKey !== undefined && typeof input.assetKey !== "string")) {
    throw new HTTPException(400, { message: "A valid verification result and current step timestamp are required" });
  }
  if (input.note.length > 10_000) throw new HTTPException(400, { message: "Verification note is too long" });
  const [target, evidence, previous, chainRows] = await Promise.all([
    db.prepare(
      `SELECT rs.id, rs.status, rs.updated_at, rs.expected_state_hash, rs.position,
              r.sequence_no, r.current_plan_revision_id, r.recipe_family_id, r.template_version_id
       FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ?
         AND r.run_kind = 'process' AND rs.entry_kind = 'fabrication'
         AND rs.plan_status = 'current'
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
    ).bind(stepId, runId, sampleId).first<{
      id: string; status: StepStatus; updated_at: string; expected_state_hash: string | null;
      position: number; sequence_no: number; current_plan_revision_id: string;
      recipe_family_id: string; template_version_id: string;
    }>(),
    readReadyAssetInputWithDatabase(db, input),
    db.prepare(
      `SELECT sv.id, sv.after_run_step_id
       FROM state_verifications sv
       JOIN run_steps endpoint ON endpoint.id = sv.after_run_step_id
       JOIN runs endpoint_run ON endpoint_run.id = endpoint.run_id
       WHERE sv.sample_id = ? AND sv.status = 'valid'
         AND endpoint_run.deleted_at IS NULL AND endpoint.deleted_at IS NULL
       ORDER BY sv.created_at DESC, sv.id DESC LIMIT 1`,
    ).bind(sampleId).first<{ id: string; after_run_step_id: string }>(),
    db.prepare(
      `SELECT rs.id, rs.status, rs.plan_status, rs.actualized_at, r.sequence_no, rs.position
       FROM runs r JOIN run_steps rs ON rs.run_id = r.id
       WHERE r.sample_id = ? AND r.run_kind = 'process' AND rs.entry_kind = 'fabrication'
         AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
       ORDER BY r.sequence_no, rs.position`,
    ).bind(sampleId).all<{
      id: string; status: StepStatus; plan_status: "current" | "superseded";
      actualized_at: string | null; sequence_no: number; position: number;
    }>(),
  ]);
  if (!target) throw new HTTPException(404, { message: "Current run step not found" });
  if (target.updated_at !== input.expectedUpdatedAt) throw new HTTPException(409, { message: "This step changed elsewhere. Reload before verifying its state." });
  if ((input.assetKey || input.assetId) && !evidence) throw new HTTPException(400, { message: "The verification image is unavailable" });

  const evidenceFileInput = evidence ? { assetId: evidence.id, nativeAsset: evidence.r2_key === null, purpose: "embedded_content" as const } : null;
  const evidenceFileId = evidenceFileInput ? await resolveConsumerFileIdWithDatabase(db, evidenceFileInput) : null;

  const targetIndex = chainRows.results.findIndex((step) => step.id === stepId);
  const previousIndex = previous ? chainRows.results.findIndex((step) => step.id === previous.after_run_step_id) : -1;
  if (targetIndex < 0 || previousIndex >= targetIndex) throw new HTTPException(409, { message: "The verification endpoint is not after the previous verified state" });
  const segment = chainRows.results.slice(previousIndex + 1, targetIndex + 1)
    .filter((step) => step.plan_status === "current" || step.actualized_at);
  const incomplete = segment.find((step) => step.plan_status === "current"
    && !["done", "skipped"].includes(step.status)
    && !(step.id === stepId && input.completeStep));
  if (incomplete) throw new HTTPException(409, { message: "Finish or skip each current step since the previous verification before verifying this state" });
  const covered = segment.filter((step) => step.actualized_at || step.id === stepId);

  const now = new Date(Math.max(Date.now(), Date.parse(input.expectedUpdatedAt) + 1)).toISOString();
  const verificationId = crypto.randomUUID();
  const note = input.note.trim() || null;
  const coveredJson = JSON.stringify(covered.map((step, ordinal) => ({ stepId: step.id, ordinal })));
  const statements: Statement[] = [
    db.prepare(
      `WITH covered AS MATERIALIZED (
         SELECT CAST(json_extract(value, '$.stepId') AS TEXT) AS run_step_id
         FROM json_each(?)
       )
       UPDATE run_steps SET status = CASE WHEN ? THEN 'done' ELSE status END,
              actualized_at = COALESCE(actualized_at, ?), updated_by = ?,
              last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND run_id = ? AND updated_at = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM runs r JOIN samples s ON s.id = r.sample_id
           WHERE r.id = run_steps.run_id AND r.id = ? AND r.sample_id = ?
             AND s.deleted_at IS NULL AND r.deleted_at IS NULL
         )
         AND (
           SELECT COUNT(*)
           FROM run_steps covered_step
           JOIN runs covered_run ON covered_run.id = covered_step.run_id
           JOIN samples covered_sample ON covered_sample.id = covered_run.sample_id
           WHERE covered_step.id IN (SELECT run_step_id FROM covered)
             AND covered_run.sample_id = ?
             AND covered_sample.deleted_at IS NULL
             AND covered_run.deleted_at IS NULL
             AND covered_step.deleted_at IS NULL
         ) = ?`,
    ).bind(
      coveredJson,
      input.completeStep ? 1 : 0,
      now,
      userEmail,
      verificationId,
      now,
      stepId,
      runId,
      input.expectedUpdatedAt,
      runId,
      sampleId,
      sampleId,
      covered.length,
    ),
    db.prepare(
      `INSERT INTO state_verifications
       (id, sample_id, after_run_step_id, previous_verification_id, run_plan_revision_id,
        expected_state_hash, result, evidence_asset_id, evidence_file_id, note, actor_email, created_at)
       SELECT ?, s.id, rs.id, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM run_steps rs
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       WHERE rs.id = ? AND r.id = ? AND s.id = ?
         AND rs.last_mutation_id = ?
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
    ).bind(
      verificationId,
      previous?.id ?? null,
      target.current_plan_revision_id,
      target.expected_state_hash,
      input.result,
      evidence?.id ?? null,
      evidenceFileId,
      note,
      userEmail,
      now,
      stepId,
      runId,
      sampleId,
      verificationId,
    ),
    db.prepare(
      `WITH covered AS MATERIALIZED (
         SELECT CAST(json_extract(value, '$.stepId') AS TEXT) AS run_step_id,
                CAST(json_extract(value, '$.ordinal') AS INTEGER) AS ordinal
         FROM json_each(?)
       )
       INSERT INTO state_verification_steps (verification_id, run_step_id, ordinal)
       SELECT ?, covered.run_step_id, covered.ordinal
       FROM covered
       JOIN run_steps rs ON rs.id = covered.run_step_id AND rs.deleted_at IS NULL
       JOIN runs r ON r.id = rs.run_id AND r.deleted_at IS NULL
       JOIN samples s ON s.id = r.sample_id AND s.deleted_at IS NULL
       WHERE s.id = ?
         AND EXISTS (
           SELECT 1
           FROM state_verifications sv
           JOIN run_steps endpoint ON endpoint.id = sv.after_run_step_id
           WHERE sv.id = ? AND endpoint.last_mutation_id = ?
         )
         AND (
           SELECT COUNT(*)
           FROM covered candidate
           JOIN run_steps candidate_step
             ON candidate_step.id = candidate.run_step_id
             AND candidate_step.deleted_at IS NULL
           JOIN runs candidate_run
             ON candidate_run.id = candidate_step.run_id
             AND candidate_run.deleted_at IS NULL
           JOIN samples candidate_sample
             ON candidate_sample.id = candidate_run.sample_id
             AND candidate_sample.deleted_at IS NULL
           WHERE candidate_sample.id = ?
       ) = ?`,
    ).bind(
      coveredJson,
      verificationId,
      sampleId,
      verificationId,
      verificationId,
      sampleId,
      covered.length,
    ),
    db.prepare(
      `INSERT INTO events (id, sample_id, kind, body, asset_key, asset_file_id, metadata_json, actor_email, created_at)
       SELECT ?, s.id, 'verification', ?, ?, ?, ?, ?, ?
       FROM state_verifications sv
       JOIN samples s ON s.id = sv.sample_id
       JOIN run_steps endpoint ON endpoint.id = sv.after_run_step_id
       WHERE sv.id = ? AND endpoint.last_mutation_id = ?
         AND s.deleted_at IS NULL`,
    ).bind(crypto.randomUUID(),
      `State ${input.result === "matched" ? "verified" : "mismatch recorded"} after ${covered.length} step${covered.length === 1 ? "" : "s"}`,
      evidence?.r2_key ?? null,
      evidenceFileId,
      JSON.stringify({ verificationId, runId, stepId, previousVerificationId: previous?.id ?? null, coveredStepIds: covered.map((step) => step.id), result: input.result,
        ...(evidence?.r2_key === null ? { assetId: evidence.id } : {}) }),
      userEmail, now, verificationId, verificationId),
    db.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM state_verifications sv
           JOIN run_steps endpoint ON endpoint.id = sv.after_run_step_id
           WHERE sv.id = ? AND sv.sample_id = samples.id
             AND endpoint.last_mutation_id = ?
         )`,
    ).bind(userEmail, now, sampleId, verificationId, verificationId),
  ];
  if (input.result === "mismatched") statements.push(db.prepare(
    `INSERT INTO recipe_change_proposals
     (id, recipe_family_id, source_template_version_id, source_verification_id, change_type, body, actor_email, created_at)
     SELECT ?, ?, ?, sv.id, 'expected_state', ?, ?, ?
     FROM state_verifications sv
     JOIN run_steps endpoint ON endpoint.id = sv.after_run_step_id
     WHERE sv.id = ? AND endpoint.last_mutation_id = ?`,
  ).bind(
    crypto.randomUUID(),
    target.recipe_family_id,
    target.template_version_id,
    note || "Observed state did not match the process template's expected state",
    userEmail,
    now,
    verificationId,
    verificationId,
  ));
  const fences = evidenceFileInput ? [consumerFileBindingFenceWithDatabase(db, evidenceFileInput, evidenceFileId)] : [];
  const results = (await db.atomicBatch([...fences, ...statements])).slice(fences.length);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "This step changed elsewhere. Reload before verifying its state." });
  return {
    verification: {
      id: verificationId, sampleId, afterRunStepId: stepId, previousVerificationId: previous?.id ?? null,
      runPlanRevisionId: target.current_plan_revision_id, expectedStateHash: target.expected_state_hash,
      result: input.result, note, status: "valid", actorEmail: userEmail, createdAt: now,
      coveredRunStepIds: covered.map((step) => step.id),
    },
  };
}

