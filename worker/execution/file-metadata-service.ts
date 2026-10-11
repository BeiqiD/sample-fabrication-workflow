// Complete original Execution metadata algorithms, including both native File
// aliases and legacy attachments. Structural trusted SQL ports convey no request,
// library, resource, File, provider or administrator authority.
import { HTTPException } from "hono/http-exception";
import type { StepStatus, UpdateRunStepInput } from "../../shared/types";
import { readReadyAssetInputWithDatabase } from "../files/asset-input-service";
import { fileAuthorityActiveSqlWithDatabase, deletedEventAssetSqlWithDatabase, prepareFileRestorationWithDatabase } from "../files/business-lifecycle-service";
import { consumerFileBindingFenceWithDatabase, resolveConsumerFileIdWithDatabase } from "../files/consumer-binding-service";
import { validRunStepAssetPresentation, resolveRunStepAssetPresentationWithDatabase } from "./asset-presentation-service";
import { changeNativeExecutionAssetWithDatabase } from "./native-asset-lifecycle-service";
import type { ExecutionFileMetadataDatabase, ExecutionFileMetadataStatement } from "./file-metadata-sql";

export async function updateExecutionStepWithDatabase<Statement extends ExecutionFileMetadataStatement<Statement>>(db: ExecutionFileMetadataDatabase<Statement>, sampleId: string, runId: string, stepId: string, input: UpdateRunStepInput, userEmail: string) {
  const allowed: StepStatus[] = ["pending", "in_progress", "done", "skipped", "blocked"];
  if (!input.status || !allowed.includes(input.status) || typeof input.expectedUpdatedAt !== "string" || typeof input.title !== "string" || typeof input.toolName !== "string" || typeof input.parametersText !== "string" || typeof input.commentsText !== "string" || typeof input.deviationNote !== "string" || typeof input.notes !== "string" || (input.assetKey !== undefined && typeof input.assetKey !== "string") || (input.assetMetadata !== undefined && (!(input.assetKey || input.assetId) || !validRunStepAssetPresentation(input.assetMetadata)))) throw new HTTPException(400, { message: "Valid editable step fields and expectedUpdatedAt are required" });
  const title = input.title.trim();
  if (!title) throw new HTTPException(400, { message: "Step title is required" });
  if (title.length > 200 || input.toolName.length > 500 || input.parametersText.length > 10_000 || input.commentsText.length > 10_000 || input.deviationNote.length > 4_000 || input.notes.length > 10_000) throw new HTTPException(400, { message: "One or more step fields are too long" });
  const asset = await readReadyAssetInputWithDatabase(db, input);
  if ((input.assetKey || input.assetId) && !asset) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const assetFileInput = asset ? { assetId: asset.id, nativeAsset: asset.r2_key === null, purpose: "embedded_content" as const } : null;
  const assetFileId = assetFileInput ? await resolveConsumerFileIdWithDatabase(db, assetFileInput) : null;
  const assetPresentation = asset
    ? await resolveRunStepAssetPresentationWithDatabase(db, asset.id, input.assetMetadata)
    : null;
  const runStepAssetId = asset
    ? (await db.prepare(
      "SELECT id FROM run_step_assets WHERE run_step_id = ? AND asset_id = ? AND role = 'execution' AND superseded_by_occurrence_id IS NULL",
    ).bind(stepId, asset.id).first<{ id: string }>())?.id ?? crypto.randomUUID()
    : null;
  const step = await db.prepare(
    `SELECT COALESCE(rs.title, sd.name) AS title, rs.status, rs.notes,
            COALESCE(rs.tool_name, sd.tool_name) AS tool_name,
            COALESCE(rs.parameters_text, sd.parameters_text) AS parameters_text,
            COALESCE(rs.comments_text, sd.comments_text) AS comments_text,
            sd.name AS planned_title, sd.tool_name AS planned_tool_name,
            sd.parameters_text AS planned_parameters_text, sd.comments_text AS planned_comments_text,
            rs.deviation_note, rs.origin, rs.updated_at
     FROM run_steps rs JOIN runs r ON r.id = rs.run_id
     JOIN samples s ON s.id = r.sample_id
     LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
     WHERE rs.id = ? AND r.id = ? AND r.sample_id = ?
       AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
  ).bind(stepId, runId, sampleId).first<Record<string, string | null>>();
  if (!step) throw new HTTPException(404, { message: "Run step not found" });
  if (step.updated_at !== input.expectedUpdatedAt) throw new HTTPException(409, { message: "This step changed elsewhere. Reload before saving." });
  const now = new Date(Math.max(Date.now(), Date.parse(input.expectedUpdatedAt) + 1)).toISOString();
  const notes = input.notes?.trim() || null;
  const toolName = input.toolName.trim() || null;
  const parametersText = input.parametersText.trim() || null;
  const commentsText = input.commentsText.trim() || null;
  const deviationNote = input.deviationNote.trim() || null;
  const titleOverride = title === step.planned_title ? null : title;
  const toolOverride = toolName === step.planned_tool_name ? null : toolName;
  const parametersOverride = parametersText === step.planned_parameters_text ? null : parametersText;
  const commentsOverride = commentsText === step.planned_comments_text ? null : commentsText;
  const mutationId = crypto.randomUUID();
  const statements = [
    db.prepare(
      `UPDATE run_steps SET status = ?, title = ?, tool_name = ?, parameters_text = ?, comments_text = ?,
       deviation_note = ?, notes = ?, actualized_at = COALESCE(actualized_at, ?), updated_by = ?, last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND updated_at = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM runs
           JOIN samples s ON s.id = runs.sample_id
           WHERE runs.id = run_steps.run_id
             AND s.deleted_at IS NULL AND runs.deleted_at IS NULL
         )`,
    ).bind(input.status, titleOverride, toolOverride, parametersOverride, commentsOverride, deviationNote, notes, now, userEmail, mutationId, now, stepId, input.expectedUpdatedAt),
    db.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, r.sample_id, 'step', ?, ?, ?, ? FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?
         AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
    ).bind(crypto.randomUUID(), `${title}: ${input.status.replace("_", " ")}${deviationNote ? ` — deviation: ${deviationNote}` : notes ? ` — ${notes}` : ""}`, JSON.stringify({
      runId, stepId, action: "updated", origin: step.origin,
      previous: { title: step.title, status: step.status, toolName: step.tool_name, parametersText: step.parameters_text, commentsText: step.comments_text, deviationNote: step.deviation_note, notes: step.notes },
      current: { title, status: input.status, toolName, parametersText, commentsText, deviationNote, notes },
    }), userEmail, now, stepId, runId, sampleId, mutationId),
  ];
  if (asset && runStepAssetId) statements.push(db.prepare(
    `INSERT OR IGNORE INTO run_step_assets (
       id, run_step_id, asset_id, file_id, role, position,
       filename, mime_type, byte_size, actor_email, created_at
     )
     SELECT ?, ?, ?, ?, 'execution',
            COALESCE((SELECT MAX(position) FROM run_step_assets WHERE run_step_id = ? AND role = 'execution'), -1) + 1,
            ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?
         AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
     )`,
  ).bind(
    runStepAssetId,
    stepId,
    asset.id,
    assetFileId,
    stepId,
    assetPresentation!.filename,
    assetPresentation!.mimeType,
    assetPresentation!.byteSize,
    userEmail,
    now,
    stepId,
    runId,
    sampleId,
    mutationId,
  ));
  if (asset && runStepAssetId) statements.push(db.prepare(
    `UPDATE run_step_assets
     SET file_id = COALESCE(file_id, ?), filename = ?, mime_type = ?, byte_size = ?,
         deleted_at = NULL, deleted_by = NULL, last_mutation_id = ?
     WHERE id = ? AND run_step_id = ? AND asset_id = ? AND role = 'execution'
       AND superseded_by_occurrence_id IS NULL
       AND EXISTS (
         SELECT 1 FROM run_steps rs JOIN runs r ON r.id = rs.run_id
         WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?
           AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
       )`,
  ).bind(
    assetFileId,
    assetPresentation!.filename,
    assetPresentation!.mimeType,
    assetPresentation!.byteSize,
    mutationId,
    runStepAssetId,
    stepId,
    asset.id,
    stepId,
    runId,
    sampleId,
    mutationId,
  ));
  if (asset && runStepAssetId) statements.push(db.prepare(
    `INSERT INTO events (id, sample_id, kind, body, asset_key, asset_file_id, metadata_json, actor_email, created_at)
     SELECT ?, r.sample_id, 'image', ?, ?, ?, ?, ?, ? FROM run_steps rs JOIN runs r ON r.id = rs.run_id
     WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?
       AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
  ).bind(crypto.randomUUID(), `Execution diagram for step: ${title}`, asset.r2_key, assetFileId,
    JSON.stringify({ runId, stepId, runStepAssetId, ...(asset.r2_key === null ? { assetId: asset.id } : {}) }), userEmail, now, stepId, runId, sampleId, mutationId));
  statements.push(db.prepare(
    `UPDATE samples SET updated_by = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL AND EXISTS (
       SELECT 1 FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?
         AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
     )`,
  ).bind(userEmail, now, sampleId, stepId, runId, sampleId, mutationId));
  const fences = assetFileInput ? [consumerFileBindingFenceWithDatabase(db, assetFileInput, assetFileId)] : [];
  const results = (await db.atomicBatch([...fences, ...statements])).slice(fences.length);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "This step changed elsewhere. Reload before saving." });
  if (!results[1].meta.changes || !results[results.length - 1].meta.changes) throw new Error("Atomic step record was not completed");
  return { ok: true };
}

export async function removeExecutionAssetWithDatabase<Statement extends ExecutionFileMetadataStatement<Statement>>(db: ExecutionFileMetadataDatabase<Statement>, sampleId: string, runId: string, stepId: string, input: { assetKey?: string; assetId?: string }, userEmail: string) {
  if (input.assetId !== undefined) {
    if (typeof input.assetId !== "string" || input.assetKey !== undefined) throw new HTTPException(400, { message: "One image attachment is required" });
    return await changeNativeExecutionAssetWithDatabase(db, { sampleId, runId, stepId, assetId: input.assetId,
      actor: userEmail, restore: false });
  }
  if (typeof input.assetKey !== "string" || !input.assetKey) throw new HTTPException(400, { message: "An image attachment is required" });
  const attachment = await db.prepare(
    `SELECT rsa.id, rs.title, sd.name AS planned_title, rs.updated_at, s.updated_at AS sample_updated_at
     FROM run_step_assets rsa JOIN run_steps rs ON rs.id = rsa.run_step_id
     JOIN runs r ON r.id = rs.run_id JOIN samples s ON s.id = r.sample_id
     LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
     JOIN assets a ON a.id = rsa.asset_id
     WHERE rsa.run_step_id = ? AND r.id = ? AND r.sample_id = ? AND a.r2_key = ?
       AND s.deleted_at IS NULL AND r.deleted_at IS NULL
       AND rs.deleted_at IS NULL AND rsa.deleted_at IS NULL`,
  ).bind(stepId, runId, sampleId, input.assetKey).first<{ id: string; title: string | null; planned_title: string | null; updated_at: string; sample_updated_at: string }>();
  if (!attachment) throw new HTTPException(404, { message: "Execution image not found" });
  const now = new Date(Math.max(Date.now(), Date.parse(attachment.updated_at) + 1, Date.parse(attachment.sample_updated_at) + 1)).toISOString();
  const mutationId = crypto.randomUUID();
  const title = attachment.title || attachment.planned_title || "Step";
  const results = await db.atomicBatch([
    db.prepare(
      `UPDATE run_step_assets
       SET deleted_at = ?, deleted_by = ?, last_mutation_id = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM run_steps rs
           JOIN runs r ON r.id = rs.run_id
           JOIN samples s ON s.id = r.sample_id
           WHERE rs.id = run_step_assets.run_step_id
             AND rs.id = ? AND r.id = ? AND s.id = ?
             AND s.deleted_at IS NULL AND r.deleted_at IS NULL
             AND rs.deleted_at IS NULL
         )`,
    ).bind(now, userEmail, mutationId, attachment.id, stepId, runId, sampleId),
    db.prepare(
      `UPDATE events SET asset_key = ${await deletedEventAssetSqlWithDatabase(db)},
         metadata_json = json_set(metadata_json,
           '$.runStepAssetId', ?, '$.assetDeletedAt', ?, '$.assetDeletedBy', ?,
           '$.assetMutationId', ?)
       WHERE sample_id = ? AND kind = 'image' AND asset_key = ? AND json_valid(metadata_json)
         AND json_extract(metadata_json, '$.runId') = ? AND json_extract(metadata_json, '$.stepId') = ?
         AND (json_extract(metadata_json, '$.runStepAssetId') IS NULL
           OR json_extract(metadata_json, '$.runStepAssetId') = ?)
         AND EXISTS (
           SELECT 1 FROM run_step_assets rsa
           WHERE rsa.id = ? AND rsa.last_mutation_id = ?
         )`,
    ).bind(
      attachment.id, now, userEmail, mutationId,
      sampleId, input.assetKey, runId, stepId, attachment.id,
      attachment.id, mutationId,
    ),
    db.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id = ? AND run_id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_assets rsa
           WHERE rsa.id = ? AND rsa.run_step_id = run_steps.id
             AND rsa.last_mutation_id = ?
         )`,
    ).bind(userEmail, now, stepId, runId, attachment.id, mutationId),
    db.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, s.id, 'image', ?, ?, ?, ?
       FROM run_step_assets rsa
       JOIN run_steps rs ON rs.id = rsa.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       WHERE rsa.id = ? AND rsa.last_mutation_id = ?
         AND rs.id = ? AND r.id = ? AND s.id = ?
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
    ).bind(
      crypto.randomUUID(),
      `Deleted execution image attachment · ${title}`,
      JSON.stringify({ action: "execution_attachment_deleted", runId, stepId, hadAsset: true }),
      userEmail, now, attachment.id, mutationId, stepId, runId, sampleId,
    ),
    db.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM run_step_assets rsa
           JOIN run_steps rs ON rs.id = rsa.run_step_id
           JOIN runs r ON r.id = rs.run_id
           WHERE rsa.id = ? AND rsa.last_mutation_id = ?
             AND rs.id = ? AND r.id = ? AND r.sample_id = samples.id
             AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         )`,
    ).bind(userEmail, now, sampleId, attachment.id, mutationId, stepId, runId),
  ]);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "This execution image was already deleted" });
  return { ok: true, updatedAt: now };
}

export async function restoreExecutionAssetWithDatabase<Statement extends ExecutionFileMetadataStatement<Statement>>(db: ExecutionFileMetadataDatabase<Statement>, sampleId: string, runId: string, stepId: string, input: { assetKey?: string; assetId?: string }, userEmail: string) {
  if (input.assetId !== undefined) {
    if (typeof input.assetId !== "string" || input.assetKey !== undefined) throw new HTTPException(400, { message: "One image attachment is required" });
    return await changeNativeExecutionAssetWithDatabase(db, { sampleId, runId, stepId, assetId: input.assetId,
      actor: userEmail, restore: true });
  }
  if (typeof input.assetKey !== "string" || !input.assetKey) {
    throw new HTTPException(400, { message: "An image attachment is required" });
  }
  const active = await fileAuthorityActiveSqlWithDatabase(db) === "1";
  const attachment = await db.prepare(
    `SELECT rsa.id, ${active ? "rsa.file_id" : "NULL AS file_id"}, rsa.deleted_at, rs.title, sd.name AS planned_title,
            rs.updated_at, s.updated_at AS sample_updated_at
     FROM run_step_assets rsa
     JOIN run_steps rs ON rs.id = rsa.run_step_id
     JOIN runs r ON r.id = rs.run_id
     JOIN samples s ON s.id = r.sample_id
     LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
     JOIN assets a ON a.id = rsa.asset_id AND a.status = 'ready'
     WHERE rsa.run_step_id = ? AND r.id = ? AND r.sample_id = ? AND a.r2_key = ?
       AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
       AND rsa.deleted_at IS NOT NULL`,
  ).bind(stepId, runId, sampleId, input.assetKey).first<{
    id: string; file_id: string | null; deleted_at: string; title: string | null; planned_title: string | null;
    updated_at: string; sample_updated_at: string;
  }>();
  if (!attachment) throw new HTTPException(404, { message: "Deleted execution image not found" });
  const now = new Date(Math.max(
    Date.now(), Date.parse(attachment.deleted_at) + 1,
    Date.parse(attachment.updated_at) + 1, Date.parse(attachment.sample_updated_at) + 1,
  )).toISOString();
  const mutationId = crypto.randomUUID();
  const title = attachment.title || attachment.planned_title || "Step";
  const fences = await prepareFileRestorationWithDatabase(db, "execution", [attachment.id]);
  const results = (await db.atomicBatch([...fences,
    db.prepare(
      `UPDATE run_step_assets
       SET deleted_at = NULL, deleted_by = NULL, last_mutation_id = ?
       WHERE id = ? AND deleted_at = ?
         AND EXISTS (
           SELECT 1
           FROM run_steps rs
           JOIN runs r ON r.id = rs.run_id
           JOIN samples s ON s.id = r.sample_id
           WHERE rs.id = run_step_assets.run_step_id
             AND rs.id = ? AND r.id = ? AND s.id = ?
             AND s.deleted_at IS NULL AND r.deleted_at IS NULL
             AND rs.deleted_at IS NULL
         )`,
    ).bind(mutationId, attachment.id, attachment.deleted_at, stepId, runId, sampleId),
    db.prepare(
      `UPDATE events SET asset_key = ?,
         metadata_json = json_remove(
           metadata_json, '$.assetDeletedAt', '$.assetDeletedBy',
           '$.assetMutationId', '$.assetDeletionOperationId'
         )
       WHERE sample_id = ? AND kind = 'image' AND json_valid(metadata_json)
         AND json_extract(metadata_json, '$.runId') = ?
         AND json_extract(metadata_json, '$.stepId') = ?
         AND json_extract(metadata_json, '$.assetDeletedAt') = ?
         AND (json_extract(metadata_json, '$.runStepAssetId') = ?
           OR json_extract(metadata_json, '$.runStepAssetId') IS NULL)
         AND EXISTS (
           SELECT 1 FROM run_step_assets rsa
           WHERE rsa.id = ? AND rsa.last_mutation_id = ?
         )`,
    ).bind(
      input.assetKey, sampleId, runId, stepId, attachment.deleted_at,
      attachment.id, attachment.id, mutationId,
    ),
    db.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id = ? AND run_id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_assets rsa
           WHERE rsa.id = ? AND rsa.run_step_id = run_steps.id
             AND rsa.last_mutation_id = ?
         )`,
    ).bind(userEmail, now, stepId, runId, attachment.id, mutationId),
    db.prepare(
      `INSERT INTO events (id, sample_id, kind, body, asset_key${active ? ", asset_file_id" : ""}, metadata_json, actor_email, created_at)
       SELECT ?, s.id, 'image', ?, ?${active ? ", ?" : ""}, ?, ?, ?
       FROM run_step_assets rsa
       JOIN run_steps rs ON rs.id = rsa.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       WHERE rsa.id = ? AND rsa.last_mutation_id = ?
         AND rs.id = ? AND r.id = ? AND s.id = ?
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
    ).bind(
      crypto.randomUUID(), `Restored execution image attachment · ${title}`, input.assetKey, ...(active ? [attachment.file_id] : []),
      JSON.stringify({ action: "execution_attachment_restored", runId, stepId }),
      userEmail, now, attachment.id, mutationId, stepId, runId, sampleId,
    ),
    db.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM run_step_assets rsa
           JOIN run_steps rs ON rs.id = rsa.run_step_id
           JOIN runs r ON r.id = rs.run_id
           WHERE rsa.id = ? AND rsa.last_mutation_id = ?
             AND rs.id = ? AND r.id = ? AND r.sample_id = samples.id
             AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
         )`,
    ).bind(userEmail, now, sampleId, attachment.id, mutationId, stepId, runId),
  ])).slice(fences.length);
  if (!results[0].meta.changes) {
    throw new HTTPException(409, { message: "The execution image changed while it was being restored" });
  }
  return { ok: true, updatedAt: now };
}

