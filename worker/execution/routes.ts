import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { DEFAULT_SAMPLE_STATUS, isSampleStatus, type ApplyPlanUpdateInput, type ConfirmRunStepsInput, type CreateMetrologyRunEntryInput, type CreateRunStepInput, type CreateStateVerificationInput, type DeleteRunInput, type FinishProcessRunInput, type RunStepAssetPresentationInput, type SampleStatus, type StartMetrologyRunInput, type StartProcessRunInput, type StepStatus, type UpdateRunStepInput } from "../../shared/types";
import { hashStepDefinition, stableJson, STEP_HASH_SCHEME } from "../../shared/content-addressing";
import { alignFuturePlan } from "./plan-alignment";
import { isCanonicalMimeType } from "../../shared/mime-type";
import { bulkInsertStatements } from "../d1-bulk";
import { insertionPosition } from "../run-position";
import { ACTIVATE_SAMPLE_FOR_RUN_SQL } from "../run-lifecycle";
import { returnedEveryConfirmationTarget } from "../run-step-confirmation";
import { loadPlanContext } from "../plan-context";
import { validateSubstrateTransition } from "../run-start";
import { resolvePlanUpdateStructureTarget } from "../plan-update";
import type { Env } from "../types";
import { loadCurrentSampleStructure, stateAssets } from "../application/sample-structure";
import { validRunStepTargets } from "./step-targets";
import { parseInitialSubstrateStep } from "../process-definition/substrate";

function validRunStepAssetPresentation(
  value: unknown,
): value is RunStepAssetPresentationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<RunStepAssetPresentationInput>;
  return typeof candidate.filename === "string"
    && !candidate.filename.includes("\u0000")
    && candidate.filename.trim().length >= 1
    && [...candidate.filename].length <= 255
    && isCanonicalMimeType(candidate.mimeType)
    && typeof candidate.byteSize === "number"
    && Number.isSafeInteger(candidate.byteSize)
    && candidate.byteSize >= 0;
}

async function resolveRunStepAssetPresentation(
  db: D1Database,
  assetId: string,
  requested: RunStepAssetPresentationInput | undefined,
): Promise<RunStepAssetPresentationInput> {
  const blob = await db.prepare(`
    SELECT original_name, mime_type, byte_size
    FROM assets WHERE id = ? AND status = 'ready'
    LIMIT 1
  `).bind(assetId).first<{
    original_name: string;
    mime_type: string;
    byte_size: number;
  }>();
  if (!blob) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const presentation = requested ?? {
    filename: blob.original_name,
    mimeType: blob.mime_type,
    byteSize: Number(blob.byte_size),
  };
  if (presentation.byteSize !== Number(blob.byte_size)) {
    throw new HTTPException(400, { message: "The uploaded diagram size does not match the selected asset" });
  }
  return presentation;
}

function compareSubstrateStructures(
  previousStateHash: string | null,
  previousImageHashes: string[],
  templateStateHash: string | null,
  templateImageHashes: string[],
): "same" | "different" | "no_previous_structure" | "not_comparable" {
  if (!previousStateHash) return "no_previous_structure";
  if (previousStateHash === templateStateHash) return "same";
  if (!previousImageHashes.length || !templateImageHashes.length) return "not_comparable";
  return previousImageHashes.length === templateImageHashes.length
    && previousImageHashes.every((hash, index) => hash === templateImageHashes[index])
    ? "same"
    : "different";
}

export const routes = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
// The composition root mounts these after legacy Evidence to retain route order.
export const verificationRoutes = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();

routes.post("/samples/:id/runs/preview", async (c) => {
  const sampleId = c.req.param("id");
  const { templateVersionId } = await c.req.json<{ templateVersionId?: string }>();
  if (!templateVersionId) throw new HTTPException(400, { message: "A process-template version is required" });
  const [sample, template, latestRun, currentState] = await Promise.all([
    c.env.DB.prepare("SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL").bind(sampleId).first<{ updated_at: string }>(),
    c.env.DB.prepare(
      `SELECT id, name, version, initial_state_hash, content_json
       FROM template_versions
       WHERE id = ? AND template_kind = 'process' AND archived_at IS NULL
         AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.template_version_id = template_versions.id AND i.status != 'ready')`,
    ).bind(templateVersionId).first<{ id: string; name: string; version: number; initial_state_hash: string | null; content_json: string | null }>(),
    c.env.DB.prepare(
      "SELECT id, status FROM runs WHERE sample_id = ? AND run_kind = 'process' AND deleted_at IS NULL ORDER BY sequence_no DESC LIMIT 1",
    ).bind(sampleId).first<{ id: string; status: string }>(),
    loadCurrentSampleStructure(c.env.DB, sampleId),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  if (!template) throw new HTTPException(404, { message: "Process-template version not found" });
  if (latestRun?.status === "active") {
    throw new HTTPException(409, { message: "Finish the active process run or update its process template instead." });
  }
  const templateAssets = await stateAssets(c.env.DB, template.initial_state_hash);
  const initialSubstrateStep = parseInitialSubstrateStep(template.content_json);
  const canConfirm = Boolean(template.initial_state_hash && initialSubstrateStep);
  return c.json({
    successor: Boolean(latestRun),
    sampleUpdatedAt: sample.updated_at,
    expectedLatestRunId: latestRun?.id ?? null,
    comparison: compareSubstrateStructures(
      currentState.stateHash,
      currentState.imageHashes,
      template.initial_state_hash,
      templateAssets.map((asset) => asset.sha256),
    ),
    canConfirm,
    blockingReason: canConfirm ? null : "This process-template version has no valid Step 0: Substrate Stack snapshot. Re-import it before starting a run.",
    comparisonTarget: canConfirm ? {
      kind: "initial_substrate" as const,
      key: `initial-substrate:${template.id}`,
      stateHash: template.initial_state_hash,
      imageKeys: templateAssets.map((asset) => asset.r2_key),
      stepId: null,
      stepTitle: initialSubstrateStep!.name,
    } : null,
    template: {
      id: template.id,
      name: template.name,
      version: template.version,
      initialSubstrateStep,
    },
    sampleCurrentState: {
      hash: currentState.stateHash,
      stepTitle: currentState.stepTitle,
      imageKeys: currentState.imageKeys,
    },
  });
});

routes.post("/samples/:id/runs", async (c) => {
  const sampleId = c.req.param("id");
  const input = await c.req.json<StartProcessRunInput>();
  if (!input || typeof input !== "object") throw new HTTPException(400, { message: "A process-template version and substrate confirmation are required" });
  const { templateVersionId } = input;
  if (typeof templateVersionId !== "string" || !templateVersionId) throw new HTTPException(400, { message: "Template version is required" });
  const [sample, template, templateStepRows, latestRun, latestSequence] = await Promise.all([
    c.env.DB.prepare("SELECT code, updated_at FROM samples WHERE id = ? AND deleted_at IS NULL").bind(sampleId).first<{ code: string; updated_at: string }>(),
    c.env.DB.prepare(
      `SELECT tv.name, tv.template_type, tv.version, tv.recipe_family_id, tv.initial_state_hash, tv.content_json
       FROM template_versions tv WHERE tv.id = ? AND tv.template_kind = 'process' AND tv.archived_at IS NULL
       AND tv.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.template_version_id = tv.id AND i.status != 'ready')`,
    ).bind(templateVersionId).first<{ name: string; template_type: "process" | "module" | "recipe"; version: number; recipe_family_id: string; initial_state_hash: string | null; content_json: string | null }>(),
    c.env.DB.prepare(
      `SELECT id, position, logical_step_key, definition_hash, expected_state_hash
       FROM template_steps WHERE template_version_id = ? ORDER BY position`,
    ).bind(templateVersionId).all<{ id: string; position: number; logical_step_key: string; definition_hash: string; expected_state_hash: string | null }>(),
    c.env.DB.prepare(
      `SELECT id, status, sequence_no
       FROM runs WHERE sample_id = ? AND run_kind = 'process' AND deleted_at IS NULL
       ORDER BY sequence_no DESC LIMIT 1`,
    ).bind(sampleId).first<{ id: string; status: "active" | "complete" | "cancelled" | "superseded"; sequence_no: number }>(),
    c.env.DB.prepare("SELECT COALESCE(MAX(sequence_no), 0) AS sequence_no FROM runs WHERE sample_id = ?")
      .bind(sampleId).first<{ sequence_no: number }>(),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  if (!template) throw new HTTPException(404, { message: "Template version not found" });
  if (!parseInitialSubstrateStep(template.content_json)) {
    throw new HTTPException(409, { message: "This process-template version has no valid Step 0: Substrate Stack snapshot. Re-import it before starting a run." });
  }
  if (latestRun?.status === "active") throw new HTTPException(409, { message: "This sample already has an active process run. Update its process template or finish it before starting a new run." });
  const currentState = await loadCurrentSampleStructure(c.env.DB, sampleId);
  const initialState = validateSubstrateTransition(input.substrateConfirmation, {
    sampleUpdatedAt: sample.updated_at,
    previousStateHash: currentState.stateHash,
    templateStructureKey: `initial-substrate:${templateVersionId}`,
    templateStateHash: template.initial_state_hash,
    templateStateRequired: true,
    latestRunId: latestRun?.id ?? null,
  });
  if (!initialState.ok) {
    throw new HTTPException(409, {
      message: initialState.reason === "template_structure_missing"
        ? "This process-template version has no valid Step 0: Substrate Stack snapshot. Re-import it before starting a run."
        : initialState.reason === "confirmation_required"
          ? "Compare the previous structure with Step 0 and confirm that the handoff is expected."
          : "The sample, previous run, or template changed after review. Compare the structures again.",
    });
  }
  const steps = templateStepRows.results;
  if (!steps.length) throw new HTTPException(422, { message: "This template has no mapped steps. Re-import it with a step column." });

  const runId = crypto.randomUUID();
  const planRevisionId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const now = new Date(Math.max(Date.now(), Date.parse(sample.updated_at) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const stepIds = new Map(steps.map((step) => [step.id, crypto.randomUUID()]));
  const anchor = latestRun ? await c.env.DB.prepare(
    `SELECT id FROM run_steps
     WHERE run_id = ? AND entry_kind = 'fabrication' AND actualized_at IS NOT NULL
       AND deleted_at IS NULL
     ORDER BY position DESC LIMIT 1`,
  ).bind(latestRun.id).first<{ id: string }>() : null;
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, current_plan_revision_id,
         predecessor_run_id, anchor_step_id, sequence_no, run_group_id, run_kind,
         template_name_snapshot, template_type_snapshot, template_version_snapshot,
         initial_state_hash, created_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'process', ?, ?, ?, ?, ?, ?
       FROM samples s
       WHERE s.id = ? AND s.updated_at = ? AND s.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM runs active
           WHERE active.sample_id = s.id AND active.status = 'active' AND active.run_kind = 'process'
             AND active.deleted_at IS NULL
         )
         AND COALESCE((
           SELECT id FROM runs latest
           WHERE latest.sample_id = s.id AND latest.run_kind = 'process'
             AND latest.deleted_at IS NULL
           ORDER BY sequence_no DESC LIMIT 1
         ), '')
             = COALESCE(?, '')`,
    ).bind(runId, sampleId, template.recipe_family_id, templateVersionId, planRevisionId,
      latestRun?.id ?? null, anchor?.id ?? null, Number(latestSequence?.sequence_no ?? 0) + 1, crypto.randomUUID(),
      template.name, template.template_type, template.version, initialState.confirmedTemplateStateHash, userEmail, now,
      sampleId, input.substrateConfirmation!.expectedSampleUpdatedAt, latestRun?.id ?? null),
    c.env.DB.prepare(
      `INSERT INTO run_plan_revisions
       (id, run_id, revision_no, template_version_id, effective_after_step_id, reason, actor_email, created_at)
       VALUES (?, ?, 1, ?, ?, 'Initial assignment', ?, ?)`,
    ).bind(planRevisionId, runId, templateVersionId, anchor?.id ?? null, userEmail, now),
    ...bulkInsertStatements(c.env.DB, "run_steps",
      ["id", "run_id", "previous_step_id", "position", "origin", "plan_status", "template_step_id", "logical_step_key", "definition_hash", "expected_state_hash", "created_at", "updated_by", "updated_at"],
      steps.map((step, index) => [stepIds.get(step.id), runId, index ? stepIds.get(steps[index - 1].id) : anchor?.id ?? null,
        (index + 1) * 1000, "template", "current", step.id, step.logical_step_key, step.definition_hash, step.expected_state_hash, now, userEmail, now])),
    ...bulkInsertStatements(c.env.DB, "run_step_plan_links",
      ["run_plan_revision_id", "template_step_id", "run_step_id", "relation", "created_at"],
      steps.map((step) => [planRevisionId, step.id, stepIds.get(step.id), "planned", now])),
    c.env.DB.prepare(
      "INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at) VALUES (?, ?, 'run', ?, ?, ?, ?)",
    ).bind(eventId, sampleId, `${latestRun ? "Started new process run" : "Started first process run"} · ${template.name} v${template.version} (${steps.length} planned steps)`, JSON.stringify({
      runId,
      templateVersionId,
      templateVersion: template.version,
      predecessorRunId: latestRun?.id ?? null,
      anchorStepId: anchor?.id ?? null,
      initialStateHash: initialState.confirmedTemplateStateHash,
      initialStateSource: "process_template_step_0",
      substrateConfirmation: {
        previousStateHash: currentState.stateHash,
        templateInitialStateHash: template.initial_state_hash,
        exactStateHashMatch: currentState.stateHash === template.initial_state_hash,
      },
    }), userEmail, now),
    c.env.DB.prepare(ACTIVATE_SAMPLE_FOR_RUN_SQL).bind(userEmail, now, sampleId),
  ];
  if (statements.length > 49) throw new HTTPException(413, { message: "This process template is too large to start on the current plan" });
  try { await c.env.DB.batch(statements); }
  catch (error) {
    if (/template version (archived|unavailable)/.test(String(error))) {
      throw new HTTPException(409, { message: "This process-template version became unavailable before the run started" });
    }
    if (String(error).includes("FOREIGN KEY") || String(error).includes("constraint")) {
      throw new HTTPException(409, { message: "The sample or its latest run changed while the structures were being confirmed. Review them again." });
    }
    throw error;
  }
  return c.json({ id: runId }, 201);
});

routes.post("/samples/:sampleId/runs/:runId/finish", async (c) => {
  const { sampleId, runId } = c.req.param();
  const input = await c.req.json<FinishProcessRunInput>();
  if (!input || typeof input.expectedSampleUpdatedAt !== "string"
    || (input.confirmSkipUnfinishedSteps !== undefined && typeof input.confirmSkipUnfinishedSteps !== "boolean")) {
    throw new HTTPException(400, { message: "The current sample revision is required" });
  }
  const [run, sample, unfinished] = await Promise.all([
    c.env.DB.prepare(
      "SELECT id, template_name_snapshot, template_version_snapshot, status FROM runs WHERE id = ? AND sample_id = ? AND run_kind = 'process' AND deleted_at IS NULL",
    ).bind(runId, sampleId).first<{ id: string; template_name_snapshot: string; template_version_snapshot: number; status: string }>(),
    c.env.DB.prepare("SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL").bind(sampleId).first<{ updated_at: string }>(),
    c.env.DB.prepare(
      `SELECT id FROM run_steps
       WHERE run_id = ? AND entry_kind = 'fabrication' AND deleted_at IS NULL
         AND plan_status = 'current' AND status NOT IN ('done', 'skipped')
       ORDER BY position, id`,
    ).bind(runId).all<{ id: string }>(),
  ]);
  if (!run || !sample) throw new HTTPException(404, { message: "Process run not found" });
  if (run.status !== "active") throw new HTTPException(409, { message: "Only the active process run can be finished" });
  if (sample.updated_at !== input.expectedSampleUpdatedAt) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before finishing the run." });
  }
  const unfinishedStepIds = unfinished.results.map((step) => step.id);
  if (unfinishedStepIds.length && input.confirmSkipUnfinishedSteps !== true) {
    throw new HTTPException(409, {
      message: `Finishing this run will mark ${unfinishedStepIds.length} unfinished step${unfinishedStepIds.length === 1 ? "" : "s"} as skipped. Confirm this action before continuing.`,
    });
  }
  const now = new Date(Math.max(Date.now(), Date.parse(sample.updated_at) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
    ).bind(userEmail, mutationId, now, sampleId, input.expectedSampleUpdatedAt),
    c.env.DB.prepare(
      `UPDATE run_steps
       SET status = 'skipped', actualized_at = COALESCE(actualized_at, ?),
           updated_by = ?, last_mutation_id = ?, updated_at = ?
       WHERE run_id = ? AND entry_kind = 'fabrication' AND deleted_at IS NULL
         AND plan_status = 'current' AND status NOT IN ('done', 'skipped')
         AND EXISTS (
           SELECT 1 FROM runs
           WHERE id = ? AND sample_id = ? AND run_kind = 'process' AND status = 'active'
             AND deleted_at IS NULL
         )
         AND EXISTS (
           SELECT 1 FROM samples WHERE id = ? AND last_mutation_id = ? AND deleted_at IS NULL
         )`,
    ).bind(now, userEmail, mutationId, now, runId, runId, sampleId, sampleId, mutationId),
    c.env.DB.prepare(
      `UPDATE runs SET status = 'complete', completed_at = COALESCE(completed_at, ?)
       WHERE id = ? AND sample_id = ? AND run_kind = 'process'
         AND deleted_at IS NULL
         AND status IN ('active', 'complete')
         AND NOT EXISTS (
           SELECT 1 FROM run_steps
           WHERE run_id = ? AND entry_kind = 'fabrication'
             AND plan_status = 'current' AND status NOT IN ('done', 'skipped')
         )
         AND EXISTS (
           SELECT 1 FROM samples WHERE id = ? AND last_mutation_id = ? AND deleted_at IS NULL
         )`,
    ).bind(now, runId, sampleId, runId, sampleId, mutationId),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, s.id, 'run', ?, ?, ?, ? FROM samples s
       WHERE s.id = ? AND s.last_mutation_id = ? AND s.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM runs r
           WHERE r.id = ? AND r.sample_id = s.id AND r.status = 'complete'
             AND r.deleted_at IS NULL
         )`,
    ).bind(
      crypto.randomUUID(),
      `Finished process run · ${run.template_name_snapshot} v${run.template_version_snapshot}${unfinishedStepIds.length
        ? ` · ${unfinishedStepIds.length} unfinished step${unfinishedStepIds.length === 1 ? "" : "s"} marked skipped`
        : ""}`,
      JSON.stringify({
        action: "process_run_finished",
        runId,
        skippedUnfinishedStepCount: unfinishedStepIds.length,
        skippedUnfinishedStepIds: unfinishedStepIds,
      }),
      userEmail,
      now,
      sampleId,
      mutationId,
      runId,
    ),
  ]);
  if (!results[0].meta.changes
    || Number(results[1].meta.changes ?? 0) !== unfinishedStepIds.length
    || !results[2].meta.changes
    || !results[3].meta.changes) {
    throw new HTTPException(409, { message: "The process run changed while it was being finished. Reload and try again." });
  }
  return c.json({ ok: true, completedAt: now, skippedStepCount: unfinishedStepIds.length });
});

routes.delete("/samples/:sampleId/runs/:runId", async (c) => {
  const { sampleId, runId } = c.req.param();
  const input = await c.req.json<DeleteRunInput>().catch(() => null);
  if (!input || typeof input.expectedSampleUpdatedAt !== "string") {
    throw new HTTPException(400, { message: "The current sample revision is required" });
  }
  const run = await c.env.DB.prepare(
    `SELECT r.id, r.run_kind, r.status, r.sequence_no,
            r.template_name_snapshot, r.template_version_snapshot, r.created_at,
            s.status AS sample_status, s.updated_at AS sample_updated_at,
            (SELECT COUNT(*) FROM runs active
             WHERE active.sample_id = r.sample_id
               AND active.status = 'active'
               AND active.deleted_at IS NULL
               AND active.id != r.id) AS other_active_count
     FROM runs r
     JOIN samples s ON s.id = r.sample_id
     WHERE r.id = ? AND r.sample_id = ?
       AND s.deleted_at IS NULL AND r.deleted_at IS NULL`,
  ).bind(runId, sampleId).first<{
    id: string;
    run_kind: "process" | "metrology";
    status: "active" | "complete" | "cancelled" | "superseded";
    sequence_no: number;
    template_name_snapshot: string;
    template_version_snapshot: number;
    created_at: string;
    sample_status: SampleStatus;
    sample_updated_at: string;
    other_active_count: number;
  }>();
  if (!run) throw new HTTPException(404, { message: "Run not found" });
  if (run.sample_updated_at !== input.expectedSampleUpdatedAt) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before deleting the run." });
  }

  const matchedActivationEvent = await c.env.DB.prepare(
    `SELECT metadata_json FROM events
     WHERE sample_id = ? AND kind = 'status' AND created_at = ?
       AND json_extract(metadata_json, '$.current') = 'active'
     ORDER BY id DESC LIMIT 1`,
  ).bind(sampleId, run.created_at).first<{ metadata_json: string }>();
  let nextSampleStatus = run.sample_status;
  if (run.status === "active" && Number(run.other_active_count) === 0 && run.sample_status === "active") {
    let previousStatus: unknown;
    try {
      previousStatus = JSON.parse(matchedActivationEvent?.metadata_json || "{}").previous;
    } catch {
      previousStatus = null;
    }
    nextSampleStatus = isSampleStatus(previousStatus) && previousStatus !== "active"
      ? previousStatus
      : DEFAULT_SAMPLE_STATUS;
  }

  const now = new Date(Math.max(Date.now(), Date.parse(run.sample_updated_at) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const guardSql = "EXISTS (SELECT 1 FROM samples WHERE id = ? AND last_mutation_id = ? AND deleted_at IS NULL)";
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE samples
       SET status = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
    ).bind(nextSampleStatus, userEmail, mutationId, now, sampleId, input.expectedSampleUpdatedAt),
    c.env.DB.prepare(
      `UPDATE runs SET deleted_at = ?, deleted_by = ?
       WHERE id = ? AND sample_id = ? AND deleted_at IS NULL AND ${guardSql}`,
    ).bind(now, userEmail, runId, sampleId, sampleId, mutationId),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'run', ?, ?, ?, ?
       WHERE ${guardSql} AND EXISTS (
         SELECT 1 FROM runs
         WHERE id = ? AND sample_id = ? AND deleted_at = ?
       )`,
    ).bind(
      crypto.randomUUID(),
      sampleId,
      `Moved ${run.run_kind} run to trash · ${run.template_name_snapshot}${run.run_kind === "process" ? ` v${run.template_version_snapshot}` : ""}`,
      JSON.stringify({
        action: "run_deleted",
        deletedRunId: runId,
        runKind: run.run_kind,
        sequenceNo: Number(run.sequence_no),
        templateName: run.template_name_snapshot,
        templateVersion: Number(run.template_version_snapshot),
        recoverable: true,
      }),
      userEmail,
      now,
      sampleId,
      mutationId,
      runId,
      sampleId,
      now,
    ),
  ];

  const results = await c.env.DB.batch(statements);
  if (results.some((result) => !result.meta.changes)) {
    throw new HTTPException(409, { message: "The run changed while it was being deleted. Reload and try again." });
  }
  return c.json({ ok: true, updatedAt: now });
});

routes.post("/samples/:sampleId/runs/:runId/restore", async (c) => {
  const { sampleId, runId } = c.req.param();
  const input = await c.req.json<DeleteRunInput>().catch(() => null);
  if (!input || typeof input.expectedSampleUpdatedAt !== "string") {
    throw new HTTPException(400, { message: "The current sample revision is required" });
  }
  const run = await c.env.DB.prepare(
    `SELECT r.id, r.run_kind, r.status, r.sequence_no, r.predecessor_run_id, r.deleted_at,
            r.template_name_snapshot, r.template_version_snapshot,
            s.status AS sample_status, s.updated_at AS sample_updated_at,
            (SELECT COUNT(*) FROM runs active
             WHERE active.sample_id = r.sample_id
               AND active.run_kind = 'process'
               AND active.status = 'active'
               AND active.deleted_at IS NULL
               AND active.id != r.id) AS active_process_count
            ,(SELECT COUNT(*) FROM runs newer
              WHERE newer.sample_id = r.sample_id
                AND newer.run_kind = 'process'
                AND newer.sequence_no > r.sequence_no
                AND newer.deleted_at IS NULL) AS newer_visible_process_count
            ,(SELECT COUNT(*) FROM runs successor
              WHERE r.predecessor_run_id IS NOT NULL
                AND successor.predecessor_run_id = r.predecessor_run_id
                AND successor.deleted_at IS NULL
                AND successor.id != r.id) AS successor_conflict_count
     FROM runs r
     JOIN samples s ON s.id = r.sample_id
     WHERE r.id = ? AND r.sample_id = ?
       AND s.deleted_at IS NULL AND r.deleted_at IS NOT NULL`,
  ).bind(runId, sampleId).first<{
    id: string;
    run_kind: "process" | "metrology";
    status: "active" | "complete" | "cancelled" | "superseded";
    sequence_no: number;
    predecessor_run_id: string | null;
    deleted_at: string;
    template_name_snapshot: string;
    template_version_snapshot: number;
    sample_status: SampleStatus;
    sample_updated_at: string;
    active_process_count: number;
    newer_visible_process_count: number;
    successor_conflict_count: number;
  }>();
  if (!run) throw new HTTPException(404, { message: "Run not found in trash" });
  if (run.sample_updated_at !== input.expectedSampleUpdatedAt) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before restoring the run." });
  }
  if (run.run_kind === "process" && run.status === "active" && Number(run.active_process_count) > 0) {
    throw new HTTPException(409, { message: "Finish or move the current active process run to trash before restoring this run." });
  }
  if (run.run_kind === "process" && run.status === "active" && Number(run.newer_visible_process_count) > 0) {
    throw new HTTPException(409, { message: "An active process run can only be restored when it is the latest visible process run." });
  }
  if (run.predecessor_run_id && Number(run.successor_conflict_count) > 0) {
    throw new HTTPException(409, { message: "Another visible run already succeeds this run's predecessor." });
  }

  const now = new Date(Math.max(
    Date.now(),
    Date.parse(run.sample_updated_at) + 1,
    Date.parse(run.deleted_at) + 1,
  )).toISOString();
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const nextSampleStatus = run.status === "active" ? "active" : run.sample_status;
  const guardSql = "EXISTS (SELECT 1 FROM samples WHERE id = ? AND last_mutation_id = ? AND deleted_at IS NULL)";
  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE samples
         SET status = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
         WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
      ).bind(nextSampleStatus, userEmail, mutationId, now, sampleId, input.expectedSampleUpdatedAt),
      c.env.DB.prepare(
        `UPDATE runs SET deleted_at = NULL, deleted_by = NULL
         WHERE id = ? AND sample_id = ? AND deleted_at = ? AND ${guardSql}
           AND NOT EXISTS (
             SELECT 1 FROM runs successor
             WHERE runs.predecessor_run_id IS NOT NULL
               AND successor.predecessor_run_id = runs.predecessor_run_id
               AND successor.deleted_at IS NULL
               AND successor.id != runs.id
           )
           AND NOT (
             run_kind = 'process' AND status = 'active' AND EXISTS (
               SELECT 1 FROM runs newer
               WHERE newer.sample_id = runs.sample_id
                 AND newer.run_kind = 'process'
                 AND newer.sequence_no > runs.sequence_no
                 AND newer.deleted_at IS NULL
             )
           )`,
      ).bind(runId, sampleId, run.deleted_at, sampleId, mutationId),
      c.env.DB.prepare(
        `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
         SELECT ?, ?, 'run', ?, ?, ?, ?
         WHERE ${guardSql} AND EXISTS (
           SELECT 1 FROM runs
           WHERE id = ? AND sample_id = ? AND deleted_at IS NULL
         )`,
      ).bind(
        crypto.randomUUID(),
        sampleId,
        `Restored ${run.run_kind} run · ${run.template_name_snapshot}${run.run_kind === "process" ? ` v${run.template_version_snapshot}` : ""}`,
        JSON.stringify({
          action: "run_restored",
          restoredRunId: runId,
          runKind: run.run_kind,
          sequenceNo: Number(run.sequence_no),
          templateName: run.template_name_snapshot,
          templateVersion: Number(run.template_version_snapshot),
        }),
        userEmail,
        now,
        sampleId,
        mutationId,
        runId,
        sampleId,
      ),
    ]);
    if (results.some((result) => !result.meta.changes)) {
      throw new HTTPException(409, { message: "The run changed while it was being restored. Reload and try again." });
    }
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (/runs_single_successor_idx|UNIQUE constraint failed: runs\.predecessor_run_id/.test(String(error))) {
      throw new HTTPException(409, { message: "Another visible run already succeeds this run's predecessor." });
    }
    if (/runs_one_active_process_per_sample_idx|UNIQUE constraint failed: runs\.sample_id/.test(String(error))) {
      throw new HTTPException(409, { message: "Another active process run became visible before this run was restored." });
    }
    throw error;
  }
  return c.json({ ok: true, updatedAt: now });
});

routes.post("/samples/:sampleId/runs/:runId/plan-update/preview", async (c) => {
  const { sampleId, runId } = c.req.param();
  const { templateVersionId } = await c.req.json<{ templateVersionId?: string }>();
  if (!templateVersionId) throw new HTTPException(400, { message: "A template version is required" });
  const context = await loadPlanContext(c.env.DB, sampleId, runId, templateVersionId);
  const [sample, latestRun, currentState] = await Promise.all([
    c.env.DB.prepare("SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL").bind(sampleId).first<{ updated_at: string }>(),
    c.env.DB.prepare("SELECT id, status FROM runs WHERE sample_id = ? AND run_kind = 'process' AND deleted_at IS NULL ORDER BY sequence_no DESC LIMIT 1")
      .bind(sampleId).first<{ id: string; status: string }>(),
    loadCurrentSampleStructure(c.env.DB, sampleId),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  const sameFamily = context.run.recipe_family_id === context.nextTemplate.recipe_family_id;
  const isNewerVersion = context.nextTemplate.version > Number(context.run.current_template_version_number);
  const alignment = sameFamily ? alignFuturePlan(context.existing, context.next) : {
    matches: [], additions: [], supersededStepIds: [], historicalDifferences: [],
  };
  const canReopen = context.run.status === "complete" && latestRun?.id === runId;
  const lifecycleAllowed = context.run.status === "active" || canReopen;
  const pendingAdditions = alignment.additions.filter((step) => step.initialStatus === "pending");
  const hasFutureWork = context.run.status === "active" || pendingAdditions.length > 0;
  const initialSubstrateStep = parseInitialSubstrateStep(context.nextTemplate.content_json);
  const hasInitialSubstrate = Boolean(context.nextTemplate.initial_state_hash && initialSubstrateStep);
  const comparisonTarget = sameFamily ? resolvePlanUpdateStructureTarget(
    alignment,
    currentState.stepId,
    context.next,
    {
      templateVersionId,
      stateHash: context.nextTemplate.initial_state_hash,
      valid: hasInitialSubstrate,
    },
  ) : null;
  const comparisonAssets = await stateAssets(c.env.DB, comparisonTarget?.stateHash ?? null);
  const hasComparisonTarget = Boolean(comparisonTarget);
  const blockingReason = !sameFamily
    ? "An in-place update must use another version of the same process template."
    : !isNewerVersion
      ? "Choose a newer version of this process template."
    : !lifecycleAllowed
      ? "Only an active run or the latest completed run can be updated."
      : !hasFutureWork
        ? "This version adds no future work after the completed run."
        : !hasComparisonTarget
          ? currentState.stepId
            ? "The step that produced the current structure could not be matched in this template version."
            : "This process-template version has no valid Step 0: Substrate Stack snapshot."
          : null;
  return c.json({
    compatible: blockingReason === null,
    blockingReason,
    currentTemplateVersionId: context.run.current_template_version_id,
    nextTemplateVersionId: templateVersionId,
    canReopen,
    substrateTransition: {
      successor: false,
      sampleUpdatedAt: sample.updated_at,
      expectedLatestRunId: latestRun?.id ?? null,
      comparison: compareSubstrateStructures(
        currentState.stateHash,
        currentState.imageHashes,
        comparisonTarget?.stateHash ?? null,
        comparisonAssets.map((asset) => asset.sha256),
      ),
      canConfirm: hasComparisonTarget,
      blockingReason: hasComparisonTarget ? null : currentState.stepId
        ? "The current structure-producing step has no match in this template version. Review the step alignment before updating the run."
        : "This process-template version has no valid Step 0: Substrate Stack snapshot. Re-import it before updating the run.",
      comparisonTarget: comparisonTarget ? {
        ...comparisonTarget,
        imageKeys: comparisonAssets.map((asset) => asset.r2_key),
      } : null,
      template: {
        id: context.nextTemplate.id,
        name: context.nextTemplate.name,
        version: context.nextTemplate.version,
        initialSubstrateStep,
      },
      sampleCurrentState: {
        hash: currentState.stateHash,
        stepTitle: currentState.stepTitle,
        imageKeys: currentState.imageKeys,
      },
    },
    preservedCount: alignment.matches.length,
    additionCount: alignment.additions.length,
    skippedAdditionCount: alignment.additions.length - pendingAdditions.length,
    supersededCount: alignment.supersededStepIds.length,
    historicalDifferences: alignment.historicalDifferences,
    familyMismatch: !sameFamily,
  });
});

routes.post("/samples/:sampleId/runs/:runId/plan-update", async (c) => {
  const { sampleId, runId } = c.req.param();
  const input = await c.req.json<ApplyPlanUpdateInput>();
  if (!input || typeof input !== "object" || typeof input.templateVersionId !== "string" || !input.templateVersionId || (input.reason !== undefined && typeof input.reason !== "string")) {
    throw new HTTPException(400, { message: "A process-template version, substrate confirmation, and optional reason are required" });
  }
  const context = await loadPlanContext(c.env.DB, sampleId, runId, input.templateVersionId);
  const [sample, latestRun, currentState] = await Promise.all([
    c.env.DB.prepare("SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL").bind(sampleId).first<{ updated_at: string }>(),
    c.env.DB.prepare("SELECT id, status FROM runs WHERE sample_id = ? AND run_kind = 'process' AND deleted_at IS NULL ORDER BY sequence_no DESC LIMIT 1")
      .bind(sampleId).first<{ id: string; status: string }>(),
    loadCurrentSampleStructure(c.env.DB, sampleId),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  const reopening = context.run.status === "complete";
  if (context.run.status !== "active" && !(reopening && latestRun?.id === runId)) {
    throw new HTTPException(409, { message: "Only an active run or the latest completed run can receive this process update" });
  }
  if (context.run.recipe_family_id !== context.nextTemplate.recipe_family_id) {
    throw new HTTPException(409, { message: "An in-place process update must use another version of the same process template. Finish this run before choosing a different template." });
  }
  if (context.nextTemplate.version <= Number(context.run.current_template_version_number)) {
    throw new HTTPException(409, { message: "A process update must use a newer version of the current process template." });
  }
  const alignment = alignFuturePlan(context.existing, context.next);
  const pendingAdditions = alignment.additions.filter((step) => step.initialStatus === "pending");
  if (reopening && !pendingAdditions.length) {
    throw new HTTPException(409, { message: "This template version adds no future work after the completed run. Start a new run if this is a separate processing stage." });
  }
  const initialSubstrateStep = parseInitialSubstrateStep(context.nextTemplate.content_json);
  const comparisonTarget = resolvePlanUpdateStructureTarget(
    alignment,
    currentState.stepId,
    context.next,
    {
      templateVersionId: input.templateVersionId,
      stateHash: context.nextTemplate.initial_state_hash,
      valid: Boolean(context.nextTemplate.initial_state_hash && initialSubstrateStep),
    },
  );
  if (!comparisonTarget) {
    throw new HTTPException(409, {
      message: currentState.stepId
        ? "The step that produced the current structure could not be matched in this template version."
        : "This process-template version has no valid Step 0: Substrate Stack snapshot. Re-import it before updating the run.",
    });
  }
  const transition = validateSubstrateTransition(input.substrateConfirmation, {
    sampleUpdatedAt: sample.updated_at,
    previousStateHash: currentState.stateHash,
    templateStructureKey: comparisonTarget.key,
    templateStateHash: comparisonTarget.stateHash,
    templateStateRequired: comparisonTarget.kind === "initial_substrate",
    latestRunId: latestRun?.id ?? null,
    currentPlanRevisionId: context.run.current_plan_revision_id,
  });
  if (!transition.ok) {
    throw new HTTPException(409, {
      message: transition.reason === "template_structure_missing"
        ? "The current structure-producing step could not be matched to a valid comparison point in this template version."
        : transition.reason === "confirmation_required"
          ? "Compare the current recorded structure with the matched step in the updated template."
          : "The sample, run plan, or template changed after review. Compare the structures again.",
    });
  }

  const now = new Date(Math.max(Date.now(), Date.parse(sample.updated_at) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const revisionId = crypto.randomUUID();
  const matchByTemplate = new Map(alignment.matches.map((match) => [match.templateStepId, match]));
  const existingById = new Map(context.existing.map((step) => [step.id, step]));
  const additionByTemplate = new Map(alignment.additions.map((step) => [step.id, step]));
  const addedIds = new Map(alignment.additions.map((step) => [step.id, crypto.randomUUID()]));
  const executionHead = [...context.existing].filter((step) => step.actualized).sort((left, right) => right.position - left.position)[0] ?? null;
  let previousStepId = executionHead?.id ?? null;
  let futureIndex = 0;
  const futureMatches: Array<{
    id: string; position: number; previousStepId: string | null; templateStepId: string;
    logicalStepKey: string; definitionHash: string; expectedStateHash: string | null;
  }> = [];
  const actualizedMatches: Array<{
    id: string; templateStepId: string; logicalStepKey: string;
    definitionHash: string; expectedStateHash: string | null;
  }> = [];
  const newSteps: unknown[][] = [];
  for (const step of context.next) {
    const match = matchByTemplate.get(step.id);
    if (match && existingById.get(match.existingStepId)?.actualized) {
      actualizedMatches.push({
        id: match.existingStepId,
        templateStepId: step.id,
        logicalStepKey: step.logicalStepKey,
        definitionHash: step.definitionHash,
        expectedStateHash: step.expectedStateHash,
      });
      continue;
    }
    const position = Number(executionHead?.position ?? 0) + (++futureIndex * 1000);
    if (match) {
      futureMatches.push({
        id: match.existingStepId, position, previousStepId, templateStepId: step.id,
        logicalStepKey: step.logicalStepKey, definitionHash: step.definitionHash,
        expectedStateHash: step.expectedStateHash,
      });
      previousStepId = match.existingStepId;
    } else {
      const id = addedIds.get(step.id)!;
      const initialStatus = additionByTemplate.get(step.id)?.initialStatus ?? "pending";
      newSteps.push([id, runId, previousStepId, position, "template", "current", step.id,
        step.logicalStepKey, step.definitionHash, step.expectedStateHash,
        initialStatus, initialStatus === "skipped" ? now : null, now, userEmail, now]);
      previousStepId = id;
    }
  }

  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO run_plan_revisions
       (id, run_id, revision_no, template_version_id, effective_after_step_id, reason, actor_email, created_at)
       SELECT ?, r.id, ?, ?, ?, ?, ?, ?
       FROM runs r JOIN samples s ON s.id = r.sample_id
       WHERE r.id = ? AND r.sample_id = ? AND r.current_plan_revision_id = ?
         AND r.status = ? AND r.deleted_at IS NULL
         AND s.deleted_at IS NULL AND s.updated_at = ?
         AND (? = 0 OR NOT EXISTS (
           SELECT 1 FROM runs successor
           WHERE successor.predecessor_run_id = r.id AND successor.deleted_at IS NULL
         ))`,
    ).bind(revisionId, Number(context.run.revision_no) + 1, input.templateVersionId,
      executionHead?.id ?? null, input.reason?.trim() || "Imported process-template version update", userEmail, now,
      runId, sampleId, input.substrateConfirmation.expectedCurrentPlanRevisionId,
      reopening ? "complete" : "active", input.substrateConfirmation.expectedSampleUpdatedAt, reopening ? 1 : 0),
    c.env.DB.prepare(
      `UPDATE run_steps SET position = -1000000000 - (? * 1000000) - position
       WHERE run_id = ? AND origin = 'template' AND actualized_at IS NULL AND plan_status = 'current'
         AND EXISTS (SELECT 1 FROM run_plan_revisions WHERE id = ?)`,
    ).bind(Number(context.run.revision_no) + 1, runId, revisionId),
  ];
  statements.push(...bulkInsertStatements(c.env.DB, "run_steps",
    ["id", "run_id", "previous_step_id", "position", "origin", "plan_status", "template_step_id", "logical_step_key", "definition_hash", "expected_state_hash", "status", "actualized_at", "created_at", "updated_by", "updated_at"],
    newSteps));
  for (let index = 0; index < actualizedMatches.length; index += 16) {
    const chunk = actualizedMatches.slice(index, index + 16);
    const values = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const bindings = chunk.flatMap((step) => [step.id, step.templateStepId,
      step.logicalStepKey, step.definitionHash, step.expectedStateHash]);
    statements.push(c.env.DB.prepare(
      `WITH changes(id, template_step_id, logical_step_key, definition_hash, expected_state_hash) AS (VALUES ${values})
       UPDATE run_steps SET
         template_step_id = (SELECT template_step_id FROM changes WHERE changes.id = run_steps.id),
         logical_step_key = (SELECT logical_step_key FROM changes WHERE changes.id = run_steps.id),
         definition_hash = (SELECT definition_hash FROM changes WHERE changes.id = run_steps.id),
         expected_state_hash = (SELECT expected_state_hash FROM changes WHERE changes.id = run_steps.id),
         updated_by = ?, updated_at = ?
       WHERE id IN (SELECT id FROM changes)
         AND EXISTS (SELECT 1 FROM run_plan_revisions WHERE id = ?)`,
    ).bind(...bindings, userEmail, now, revisionId));
  }
  for (let index = 0; index < futureMatches.length; index += 12) {
    const chunk = futureMatches.slice(index, index + 12);
    const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const bindings = chunk.flatMap((step) => [step.id, step.position, step.previousStepId, step.templateStepId,
      step.logicalStepKey, step.definitionHash, step.expectedStateHash]);
    statements.push(c.env.DB.prepare(
      `WITH changes(id, position, previous_step_id, template_step_id, logical_step_key, definition_hash, expected_state_hash) AS (VALUES ${values})
       UPDATE run_steps SET
         position = (SELECT position FROM changes WHERE changes.id = run_steps.id),
         previous_step_id = (SELECT previous_step_id FROM changes WHERE changes.id = run_steps.id),
         template_step_id = (SELECT template_step_id FROM changes WHERE changes.id = run_steps.id),
         logical_step_key = (SELECT logical_step_key FROM changes WHERE changes.id = run_steps.id),
         definition_hash = (SELECT definition_hash FROM changes WHERE changes.id = run_steps.id),
         expected_state_hash = (SELECT expected_state_hash FROM changes WHERE changes.id = run_steps.id),
         plan_status = 'current', updated_by = ?, updated_at = ?
       WHERE id IN (SELECT id FROM changes)
         AND EXISTS (SELECT 1 FROM run_plan_revisions WHERE id = ?)`,
    ).bind(...bindings, userEmail, now, revisionId));
  }
  if (alignment.supersededStepIds.length) {
    for (let index = 0; index < alignment.supersededStepIds.length; index += 80) {
      const ids = alignment.supersededStepIds.slice(index, index + 80);
      statements.push(c.env.DB.prepare(
        `UPDATE run_steps SET plan_status = 'superseded', updated_by = ?, updated_at = ?
         WHERE run_id = ? AND id IN (${ids.map(() => "?").join(", ")})
           AND EXISTS (SELECT 1 FROM run_plan_revisions WHERE id = ?)`,
      ).bind(userEmail, now, runId, ...ids, revisionId));
    }
  }
  const linkRows = context.next.map((step) => {
    const match = matchByTemplate.get(step.id);
    const addition = match ? null : additionByTemplate.get(step.id);
    return [revisionId, step.id, match?.existingStepId ?? addedIds.get(step.id),
      match?.relation ?? (addition?.initialStatus === "skipped" ? "skipped" : "planned"), now];
  });
  statements.push(
    ...bulkInsertStatements(c.env.DB, "run_step_plan_links",
      ["run_plan_revision_id", "template_step_id", "run_step_id", "relation", "created_at"], linkRows),
    c.env.DB.prepare(
      `UPDATE runs SET current_plan_revision_id = ?, template_version_id = ?,
              template_name_snapshot = ?, template_type_snapshot = ?, template_version_snapshot = ?,
              status = 'active', completed_at = NULL
       WHERE id = ? AND sample_id = ? AND status = ?
         AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM run_plan_revisions WHERE id = ?)`,
    ).bind(revisionId, input.templateVersionId, context.nextTemplate.name, context.nextTemplate.template_type,
      context.nextTemplate.version, runId, sampleId, reopening ? "complete" : "active", revisionId),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'plan', ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM runs
         WHERE id = ? AND current_plan_revision_id = ? AND deleted_at IS NULL
       )`,
    ).bind(crypto.randomUUID(), sampleId,
      `${reopening ? "Reopened process run with" : "Updated active plan to"} ${context.nextTemplate.name} v${context.nextTemplate.version}`,
      JSON.stringify({ runId, planRevisionId: revisionId, fromTemplateVersionId: context.run.current_template_version_id,
        toTemplateVersionId: input.templateVersionId, preserved: alignment.matches.length,
        added: alignment.additions.length, superseded: alignment.supersededStepIds.length,
        autoSkippedAdditions: alignment.additions.length - pendingAdditions.length,
        historicalDifferences: alignment.historicalDifferences, action: reopening ? "process_run_reopened" : "active_plan_updated",
        structureConfirmation: {
          previousStateHash: currentState.stateHash,
          templateStructureKey: comparisonTarget.key,
          templateStateHash: comparisonTarget.stateHash,
          templateStepId: comparisonTarget.stepId,
        } }), userEmail, now, runId, revisionId),
    c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL AND EXISTS (
         SELECT 1 FROM runs
         WHERE id = ? AND current_plan_revision_id = ? AND deleted_at IS NULL
       )`,
    ).bind(userEmail, now, sampleId, runId, revisionId),
  );
  if (statements.length > 49) throw new HTTPException(413, { message: "This plan update is too large for one atomic operation" });
  try {
    const results = await c.env.DB.batch(statements);
    if (!results[0].meta.changes || !results[results.length - 3].meta.changes
      || !results[results.length - 2].meta.changes || !results[results.length - 1].meta.changes) {
      throw new HTTPException(409, { message: "The run or sample changed while the structures were being confirmed. Review them again." });
    }
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (/template version (archived|unavailable)/.test(String(error))) {
      throw new HTTPException(409, { message: "This process-template version became unavailable before the plan update was saved." });
    }
    throw error;
  }
  return c.json({ ok: true, planRevisionId: revisionId, revisionNumber: Number(context.run.revision_no) + 1 });
});

routes.patch("/samples/:sampleId/runs/:runId/steps/:stepId", async (c) => {
  const { sampleId, runId, stepId } = c.req.param();
  const input = await c.req.json<UpdateRunStepInput>();
  const allowed: StepStatus[] = ["pending", "in_progress", "done", "skipped", "blocked"];
  if (!input.status || !allowed.includes(input.status) || typeof input.expectedUpdatedAt !== "string" || typeof input.title !== "string" || typeof input.toolName !== "string" || typeof input.parametersText !== "string" || typeof input.commentsText !== "string" || typeof input.deviationNote !== "string" || typeof input.notes !== "string" || (input.assetKey !== undefined && typeof input.assetKey !== "string") || (input.assetMetadata !== undefined && (!input.assetKey || !validRunStepAssetPresentation(input.assetMetadata)))) throw new HTTPException(400, { message: "Valid editable step fields and expectedUpdatedAt are required" });
  const title = input.title.trim();
  if (!title) throw new HTTPException(400, { message: "Step title is required" });
  if (title.length > 200 || input.toolName.length > 500 || input.parametersText.length > 10_000 || input.commentsText.length > 10_000 || input.deviationNote.length > 4_000 || input.notes.length > 10_000) throw new HTTPException(400, { message: "One or more step fields are too long" });
  const asset = input.assetKey ? await c.env.DB.prepare(
    `SELECT id, r2_key FROM assets a WHERE status = 'ready' AND r2_key = ?
       AND NOT EXISTS (
         SELECT 1 FROM blob_gc_ledger bg
         WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
           AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
       )`,
  ).bind(input.assetKey).first<{ id: string; r2_key: string }>() : null;
  if (input.assetKey && !asset) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const assetPresentation = asset
    ? await resolveRunStepAssetPresentation(c.env.DB, asset.id, input.assetMetadata)
    : null;
  const runStepAssetId = asset
    ? (await c.env.DB.prepare(
      "SELECT id FROM run_step_assets WHERE run_step_id = ? AND asset_id = ? AND role = 'execution' AND superseded_by_occurrence_id IS NULL",
    ).bind(stepId, asset.id).first<{ id: string }>())?.id ?? crypto.randomUUID()
    : null;
  const step = await c.env.DB.prepare(
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
  const userEmail = c.get("userEmail");
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
    c.env.DB.prepare(
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
    c.env.DB.prepare(
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
  if (asset && runStepAssetId) statements.push(c.env.DB.prepare(
    `INSERT OR IGNORE INTO run_step_assets (
       id, run_step_id, asset_id, role, position,
       filename, mime_type, byte_size, actor_email, created_at
     )
     SELECT ?, ?, ?, 'execution',
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
  if (asset && runStepAssetId) statements.push(c.env.DB.prepare(
    `UPDATE run_step_assets
     SET filename = ?, mime_type = ?, byte_size = ?,
         deleted_at = NULL, deleted_by = NULL, last_mutation_id = ?
     WHERE id = ? AND run_step_id = ? AND asset_id = ? AND role = 'execution'
       AND superseded_by_occurrence_id IS NULL
       AND EXISTS (
         SELECT 1 FROM run_steps rs JOIN runs r ON r.id = rs.run_id
         WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?
           AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
       )`,
  ).bind(
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
  if (asset && runStepAssetId) statements.push(c.env.DB.prepare(
    `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
     SELECT ?, r.sample_id, 'image', ?, ?, ?, ?, ? FROM run_steps rs JOIN runs r ON r.id = rs.run_id
     WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?
       AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
  ).bind(crypto.randomUUID(), `Execution diagram for step: ${title}`, asset.r2_key,
    JSON.stringify({ runId, stepId, runStepAssetId }), userEmail, now, stepId, runId, sampleId, mutationId));
  statements.push(c.env.DB.prepare(
    `UPDATE samples SET updated_by = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL AND EXISTS (
       SELECT 1 FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?
         AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
     )`,
  ).bind(userEmail, now, sampleId, stepId, runId, sampleId, mutationId));
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "This step changed elsewhere. Reload before saving." });
  if (!results[1].meta.changes || !results[results.length - 1].meta.changes) throw new Error("Atomic step record was not completed");
  return c.json({ ok: true });
});

routes.delete("/samples/:sampleId/runs/:runId/steps/:stepId/assets", async (c) => {
  const { sampleId, runId, stepId } = c.req.param();
  const input = await c.req.json<{ assetKey?: string }>();
  if (typeof input.assetKey !== "string" || !input.assetKey) throw new HTTPException(400, { message: "An image attachment is required" });
  const attachment = await c.env.DB.prepare(
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
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const title = attachment.title || attachment.planned_title || "Step";
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
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
    c.env.DB.prepare(
      `UPDATE events SET asset_key = NULL,
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
    c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id = ? AND run_id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_assets rsa
           WHERE rsa.id = ? AND rsa.run_step_id = run_steps.id
             AND rsa.last_mutation_id = ?
         )`,
    ).bind(userEmail, now, stepId, runId, attachment.id, mutationId),
    c.env.DB.prepare(
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
    c.env.DB.prepare(
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
  return c.json({ ok: true, updatedAt: now });
});

routes.post("/samples/:sampleId/runs/:runId/steps/:stepId/assets/restore", async (c) => {
  const { sampleId, runId, stepId } = c.req.param();
  const input = await c.req.json<{ assetKey?: string }>();
  if (typeof input.assetKey !== "string" || !input.assetKey) {
    throw new HTTPException(400, { message: "An image attachment is required" });
  }
  const attachment = await c.env.DB.prepare(
    `SELECT rsa.id, rsa.deleted_at, rs.title, sd.name AS planned_title,
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
    id: string; deleted_at: string; title: string | null; planned_title: string | null;
    updated_at: string; sample_updated_at: string;
  }>();
  if (!attachment) throw new HTTPException(404, { message: "Deleted execution image not found" });
  const now = new Date(Math.max(
    Date.now(), Date.parse(attachment.deleted_at) + 1,
    Date.parse(attachment.updated_at) + 1, Date.parse(attachment.sample_updated_at) + 1,
  )).toISOString();
  const userEmail = c.get("userEmail");
  const mutationId = crypto.randomUUID();
  const title = attachment.title || attachment.planned_title || "Step";
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
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
    c.env.DB.prepare(
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
    c.env.DB.prepare(
      `UPDATE run_steps SET updated_by = ?, updated_at = ?
       WHERE id = ? AND run_id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_step_assets rsa
           WHERE rsa.id = ? AND rsa.run_step_id = run_steps.id
             AND rsa.last_mutation_id = ?
         )`,
    ).bind(userEmail, now, stepId, runId, attachment.id, mutationId),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
       SELECT ?, s.id, 'image', ?, ?, ?, ?, ?
       FROM run_step_assets rsa
       JOIN run_steps rs ON rs.id = rsa.run_step_id
       JOIN runs r ON r.id = rs.run_id
       JOIN samples s ON s.id = r.sample_id
       WHERE rsa.id = ? AND rsa.last_mutation_id = ?
         AND rs.id = ? AND r.id = ? AND s.id = ?
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL`,
    ).bind(
      crypto.randomUUID(), `Restored execution image attachment · ${title}`, input.assetKey,
      JSON.stringify({ action: "execution_attachment_restored", runId, stepId }),
      userEmail, now, attachment.id, mutationId, stepId, runId, sampleId,
    ),
    c.env.DB.prepare(
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
  if (!results[0].meta.changes) {
    throw new HTTPException(409, { message: "The execution image changed while it was being restored" });
  }
  return c.json({ ok: true, updatedAt: now });
});

routes.post("/samples/:sampleId/runs/:runId/steps", async (c) => {
  const { sampleId, runId } = c.req.param();
  const input = await c.req.json<CreateRunStepInput>();
  if (typeof input.title !== "string" || typeof input.toolName !== "string" || typeof input.parametersText !== "string" || typeof input.commentsText !== "string" || typeof input.deviationNote !== "string" || (input.afterStepId !== undefined && typeof input.afterStepId !== "string") || (input.assetKey !== undefined && typeof input.assetKey !== "string") || (input.assetMetadata !== undefined && (!input.assetKey || !validRunStepAssetPresentation(input.assetMetadata)))) throw new HTTPException(400, { message: "Valid ad hoc step fields are required" });
  const title = input.title.trim();
  if (!title) throw new HTTPException(400, { message: "Step title is required" });
  if (title.length > 200 || input.toolName.length > 500 || input.parametersText.length > 10_000 || input.commentsText.length > 10_000 || input.deviationNote.length > 4_000) throw new HTTPException(400, { message: "One or more step fields are too long" });
  const definition = await hashStepDefinition({ name: title, toolName: input.toolName, parametersText: input.parametersText, commentsText: input.commentsText });
  const [run, stepRows, asset] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.id, r.anchor_step_id FROM runs r
       JOIN samples s ON s.id = r.sample_id
       WHERE r.id = ? AND r.sample_id = ? AND r.run_kind = 'process' AND r.status = 'active'
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL`,
    ).bind(runId, sampleId).first<{ id: string; anchor_step_id: string | null }>(),
    c.env.DB.prepare("SELECT id, position, updated_at FROM run_steps WHERE run_id = ? AND deleted_at IS NULL ORDER BY position")
      .bind(runId).all<{ id: string; position: number; updated_at: string }>(),
    input.assetKey ? c.env.DB.prepare(
      `SELECT id, r2_key FROM assets a WHERE status = 'ready' AND r2_key = ?
         AND NOT EXISTS (
           SELECT 1 FROM blob_gc_ledger bg
           WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
             AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
         )`,
    ).bind(input.assetKey).first<{ id: string; r2_key: string }>() : Promise.resolve(null),
  ]);
  if (!run) throw new HTTPException(404, { message: "Sample run not found" });
  if (input.assetKey && !asset) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const assetPresentation = asset
    ? await resolveRunStepAssetPresentation(c.env.DB, asset.id, input.assetMetadata)
    : null;
  const position = insertionPosition(stepRows.results, input.afterStepId);
  if (position === null) throw new HTTPException(404, { message: "Insertion point not found" });
  const stepId = crypto.randomUUID();
  const runStepAssetId = asset ? crypto.randomUUID() : null;
  const mutationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
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
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE runs SET last_mutation_id = ?
       WHERE id = ? AND sample_id = ? AND run_kind = 'process'
         AND status = 'active' AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM samples s
           WHERE s.id = runs.sample_id AND s.deleted_at IS NULL
         )
         ${stepSnapshotSql}`,
    ).bind(mutationId, runId, sampleId, ...stepSnapshotBindings),
    c.env.DB.prepare(
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
    c.env.DB.prepare(
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
  if (nextStepId) statements.push(c.env.DB.prepare(
    `UPDATE run_steps SET previous_step_id = ?
     WHERE id = ? AND run_id = ? AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM run_steps inserted JOIN runs r ON r.id = inserted.run_id
         WHERE inserted.id = ? AND inserted.run_id = ?
           AND r.last_mutation_id = ? AND r.status = 'active'
           AND r.deleted_at IS NULL
       )`,
  ).bind(stepId, nextStepId, runId, stepId, runId, mutationId));
  if (asset && runStepAssetId) statements.push(c.env.DB.prepare(
    `INSERT INTO run_step_assets
     (id, run_step_id, asset_id, role, position,
      filename, mime_type, byte_size, actor_email, created_at)
     SELECT ?, inserted.id, ?, 'execution', 0, ?, ?, ?, ?, ?
     FROM run_steps inserted JOIN runs r ON r.id = inserted.run_id
     WHERE inserted.id = ? AND inserted.run_id = ?
       AND r.last_mutation_id = ? AND r.status = 'active'
       AND r.deleted_at IS NULL`,
  ).bind(
    runStepAssetId,
    asset.id,
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
    c.env.DB.prepare(
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
    c.env.DB.prepare(
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
  if (asset && runStepAssetId) statements.push(c.env.DB.prepare(
    `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
     SELECT ?, s.id, 'image', ?, ?, ?, ?, ?
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
    asset.r2_key,
    JSON.stringify({ runId, stepId, runStepAssetId, action: "execution_attachment_added" }),
    userEmail,
    now,
    runStepAssetId,
    stepId,
    runId,
    mutationId,
  ));
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes || !results[2].meta.changes) {
    throw new HTTPException(409, { message: "The process run changed while the step was being added" });
  }
  return c.json({ id: stepId }, 201);
});

routes.post("/samples/:sampleId/runs/:runId/metrology", async (c) => {
  const { sampleId, runId } = c.req.param();
  const input = await c.req.json<CreateMetrologyRunEntryInput>();
  if (!input || typeof input.templateVersionId !== "string" || !input.templateVersionId
    || (input.afterStepId !== undefined && typeof input.afterStepId !== "string")) {
    throw new HTTPException(400, { message: "A metrology template and insertion point are required" });
  }
  const [run, template, stepRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.id, r.anchor_step_id FROM runs r
       JOIN samples s ON s.id = r.sample_id
       WHERE r.id = ? AND r.sample_id = ? AND r.run_kind = 'process' AND r.status = 'active'
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL`,
    ).bind(runId, sampleId).first<{ id: string; anchor_step_id: string | null }>(),
    c.env.DB.prepare(
      `SELECT tv.id, tv.name, tv.version, tv.recipe_family_id,
              ts.id AS template_step_id, ts.logical_step_key, ts.definition_hash
       FROM template_versions tv
       JOIN template_steps ts ON ts.template_version_id = tv.id
       WHERE tv.id = ? AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL
         AND tv.deleted_at IS NULL
         AND (SELECT COUNT(*) FROM template_steps only_step WHERE only_step.template_version_id = tv.id) = 1`,
    ).bind(input.templateVersionId).first<{
      id: string; name: string; version: number; recipe_family_id: string;
      template_step_id: string; logical_step_key: string; definition_hash: string;
    }>(),
    c.env.DB.prepare("SELECT id, position, updated_at FROM run_steps WHERE run_id = ? AND deleted_at IS NULL ORDER BY position")
      .bind(runId).all<{ id: string; position: number; updated_at: string }>(),
  ]);
  if (!run) throw new HTTPException(404, { message: "Active process run not found" });
  if (!template) throw new HTTPException(404, { message: "Metrology template not found" });
  const position = insertionPosition(stepRows.results, input.afterStepId);
  if (position === null) throw new HTTPException(404, { message: "Insertion point not found" });
  const afterIndex = input.afterStepId ? stepRows.results.findIndex((step) => step.id === input.afterStepId) : -1;
  const nextStepId = stepRows.results[afterIndex + 1]?.id ?? null;
  const stepId = crypto.randomUUID();
  const mutationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
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
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE runs SET last_mutation_id = ?
       WHERE id = ? AND sample_id = ? AND run_kind = 'process'
         AND status = 'active' AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM samples s
           WHERE s.id = runs.sample_id AND s.deleted_at IS NULL
         )
         AND EXISTS (
           SELECT 1 FROM template_versions tv
           WHERE tv.id = ? AND tv.template_kind = 'metrology'
             AND tv.archived_at IS NULL AND tv.deleted_at IS NULL
         )
         ${stepSnapshotSql}`,
    ).bind(mutationId, runId, sampleId, input.templateVersionId, ...stepSnapshotBindings),
    c.env.DB.prepare(
      `INSERT INTO run_steps
        (id, run_id, previous_step_id, position, status, origin, entry_kind, template_step_id,
         logical_step_key, definition_hash, actualized_at, created_at, updated_by, updated_at)
       SELECT ?, r.id, ?, ?, 'pending', 'ad_hoc', 'metrology', ?, ?, ?, ?, ?, ?, ?
       FROM runs r JOIN template_versions tv ON tv.id = ?
       WHERE r.id = ? AND r.sample_id = ? AND r.run_kind = 'process' AND r.status = 'active'
         AND r.deleted_at IS NULL AND r.last_mutation_id = ?
         AND EXISTS (
           SELECT 1 FROM samples s
           WHERE s.id = r.sample_id AND s.deleted_at IS NULL
         )
         AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL
         AND tv.deleted_at IS NULL`,
    ).bind(stepId, input.afterStepId ?? run.anchor_step_id, position, template.template_step_id,
      template.logical_step_key, template.definition_hash, now, now, userEmail, now,
      input.templateVersionId, runId, sampleId, mutationId),
  ];
  if (nextStepId) statements.push(c.env.DB.prepare(
    `UPDATE run_steps SET previous_step_id = ?
     WHERE id = ? AND run_id = ? AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM run_steps inserted JOIN runs r ON r.id = inserted.run_id
         WHERE inserted.id = ? AND inserted.run_id = ?
           AND r.last_mutation_id = ? AND r.status = 'active'
           AND r.deleted_at IS NULL
       )`,
  ).bind(stepId, nextStepId, runId, stepId, runId, mutationId));
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'step', ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM run_steps inserted JOIN runs r ON r.id = inserted.run_id
         WHERE inserted.id = ? AND inserted.run_id = ?
           AND r.last_mutation_id = ? AND r.status = 'active'
           AND r.deleted_at IS NULL
       )`,
    ).bind(crypto.randomUUID(), sampleId, `Added metrology: ${template.name}`,
      JSON.stringify({ runId, stepId, action: "metrology_added", templateVersionId: template.id, afterStepId: input.afterStepId ?? null }),
      userEmail, now, stepId, runId, mutationId),
    c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_steps inserted JOIN runs r ON r.id = inserted.run_id
           WHERE inserted.id = ? AND inserted.run_id = ?
             AND r.sample_id = samples.id AND r.last_mutation_id = ?
             AND r.status = 'active' AND r.deleted_at IS NULL
             AND inserted.deleted_at IS NULL
         )`,
    ).bind(userEmail, now, sampleId, stepId, runId, mutationId),
  );
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes || !results[1].meta.changes || !results.at(-1)?.meta.changes) {
    throw new HTTPException(409, { message: "The process run or metrology template changed while the record was being added" });
  }
  return c.json({ id: stepId }, 201);
});

routes.post("/samples/:sampleId/metrology-runs", async (c) => {
  const sampleId = c.req.param("sampleId");
  const input = await c.req.json<StartMetrologyRunInput>();
  if (!input || typeof input.templateVersionId !== "string" || !input.templateVersionId) {
    throw new HTTPException(400, { message: "A metrology template is required" });
  }
  const [sample, template, latestSequence] = await Promise.all([
    c.env.DB.prepare("SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL")
      .bind(sampleId).first<{ updated_at: string }>(),
    c.env.DB.prepare(
      `SELECT tv.id, tv.name, tv.version, tv.recipe_family_id, tv.template_type,
              ts.id AS template_step_id, ts.logical_step_key, ts.definition_hash
       FROM template_versions tv
       JOIN template_steps ts ON ts.template_version_id = tv.id
       WHERE tv.id = ? AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL
         AND tv.deleted_at IS NULL
         AND (SELECT COUNT(*) FROM template_steps only_step WHERE only_step.template_version_id = tv.id) = 1`,
    ).bind(input.templateVersionId).first<{
      id: string; name: string; version: number; recipe_family_id: string; template_type: string;
      template_step_id: string; logical_step_key: string; definition_hash: string;
    }>(),
    c.env.DB.prepare("SELECT COALESCE(MAX(sequence_no), 0) AS sequence_no FROM runs WHERE sample_id = ?")
      .bind(sampleId).first<{ sequence_no: number }>(),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  if (!template) throw new HTTPException(404, { message: "Metrology template not found" });
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const now = new Date(Math.max(Date.now(), Date.parse(sample.updated_at) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, sequence_no, run_group_id, run_kind,
         template_name_snapshot, template_type_snapshot, template_version_snapshot,
         created_by, created_at)
       SELECT ?, s.id, ?, ?, ?, ?, 'metrology', ?, ?, ?, ?, ?
       FROM samples s
       WHERE s.id = ? AND s.updated_at = ? AND s.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM template_versions tv
           WHERE tv.id = ? AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL
             AND tv.deleted_at IS NULL
         )`,
    ).bind(runId, template.recipe_family_id, template.id, Number(latestSequence?.sequence_no ?? 0) + 1,
      crypto.randomUUID(), template.name, template.template_type, template.version, userEmail, now,
      sampleId, sample.updated_at, template.id),
    c.env.DB.prepare(
      `INSERT INTO run_steps
        (id, run_id, position, status, origin, entry_kind, template_step_id,
         logical_step_key, definition_hash, created_at, updated_by, updated_at)
       SELECT ?, ?, 1000, 'pending', 'template', 'metrology', ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND run_kind = 'metrology')`,
    ).bind(stepId, runId, template.template_step_id, template.logical_step_key,
      template.definition_hash, now, userEmail, now, runId),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'run', ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND run_kind = 'metrology')`,
    ).bind(crypto.randomUUID(), sampleId, `Started metrology run · ${template.name}`,
      JSON.stringify({ runId, stepId, action: "metrology_run_started", templateVersionId: template.id }),
      userEmail, now, runId),
    c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND run_kind = 'metrology' AND deleted_at IS NULL)`,
    ).bind(userEmail, now, sampleId, runId),
  ]);
  if (results.some((result) => !result.meta.changes)) {
    throw new HTTPException(409, { message: "The sample or metrology template changed while the run was being started" });
  }
  return c.json({ id: runId }, 201);
});

verificationRoutes.post("/run-steps/confirm", async (c) => {
  const input = await c.req.json<ConfirmRunStepsInput>();
  if (!input || !validRunStepTargets(input.targets)) {
    throw new HTTPException(400, { message: "Between 1 and 12 step targets are required" });
  }
  const operationGroupId = crypto.randomUUID();
  const expectedTimes = input.targets.map((target) => Date.parse(target.expectedUpdatedAt)).filter(Number.isFinite);
  const now = new Date(Math.max(Date.now(), ...expectedTimes.map((value) => value + 1))).toISOString();
  const userEmail = c.get("userEmail");
  const values = input.targets.map(() => "(?, ?, ?, ?)").join(", ");
  const bindings = input.targets.flatMap((target) => [target.sampleId, target.runId, target.stepId, target.expectedUpdatedAt]);
  const statements: D1PreparedStatement[] = [c.env.DB.prepare(
    `WITH requested(sample_id, run_id, step_id, expected_updated_at) AS (VALUES ${values}),
     valid AS (
       SELECT q.step_id
       FROM requested q
       JOIN runs r ON r.id = q.run_id AND r.sample_id = q.sample_id
       JOIN run_steps rs ON rs.id = q.step_id AND rs.run_id = q.run_id
       JOIN samples s ON s.id = q.sample_id
       WHERE rs.updated_at = q.expected_updated_at AND rs.status IN ('pending', 'in_progress')
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
     )
     UPDATE run_steps
     SET status = 'done', actualized_at = COALESCE(actualized_at, ?), updated_by = ?, last_mutation_id = ?, updated_at = ?
     WHERE id IN (SELECT step_id FROM valid)
       AND (SELECT COUNT(*) FROM valid) = ?
     RETURNING id`,
  ).bind(...bindings, now, userEmail, operationGroupId, now, input.targets.length)];

  const sampleIds = [...new Set(input.targets.map((target) => target.sampleId))];
  for (const sampleId of sampleIds) {
    const stepIds = input.targets.filter((target) => target.sampleId === sampleId).map((target) => target.stepId);
    statements.push(c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'step', ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM run_steps WHERE last_mutation_id = ? AND id IN (${stepIds.map(() => "?").join(", ")})
       )`,
    ).bind(
      crypto.randomUUID(), sampleId, `Confirmed ${stepIds.length} step${stepIds.length === 1 ? "" : "s"} as done`,
      JSON.stringify({ action: "confirmed_done", operationGroupId, stepIds }), userEmail, now,
      operationGroupId, ...stepIds,
    ));
    statements.push(c.env.DB.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL AND EXISTS (
         SELECT 1 FROM run_steps WHERE last_mutation_id = ? AND id IN (${stepIds.map(() => "?").join(", ")})
       )`,
    ).bind(userEmail, now, sampleId, operationGroupId, ...stepIds));
  }
  const results = await c.env.DB.batch(statements);
  if (!returnedEveryConfirmationTarget(results[0].results, input.targets.map((target) => target.stepId))) {
    throw new HTTPException(409, { message: "One or more steps changed elsewhere. Reload before confirming." });
  }
  return c.json({ ok: true, confirmed: input.targets.length });
});

verificationRoutes.post("/samples/:sampleId/runs/:runId/steps/:stepId/verify-state", async (c) => {
  const { sampleId, runId, stepId } = c.req.param();
  const input = await c.req.json<CreateStateVerificationInput>();
  if (!input || !["matched", "mismatched"].includes(input.result)
    || typeof input.note !== "string" || typeof input.expectedUpdatedAt !== "string"
    || (input.completeStep !== undefined && typeof input.completeStep !== "boolean")
    || (input.assetKey !== undefined && typeof input.assetKey !== "string")) {
    throw new HTTPException(400, { message: "A valid verification result and current step timestamp are required" });
  }
  if (input.note.length > 10_000) throw new HTTPException(400, { message: "Verification note is too long" });
  const [target, evidence, previous, chainRows] = await Promise.all([
    c.env.DB.prepare(
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
    input.assetKey ? c.env.DB.prepare(
      `SELECT id, r2_key FROM assets a WHERE status = 'ready' AND r2_key = ?
         AND NOT EXISTS (
           SELECT 1 FROM blob_gc_ledger bg
           WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
             AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted')
         )`,
    ).bind(input.assetKey).first<{ id: string; r2_key: string }>() : Promise.resolve(null),
    c.env.DB.prepare(
      `SELECT sv.id, sv.after_run_step_id
       FROM state_verifications sv
       JOIN run_steps endpoint ON endpoint.id = sv.after_run_step_id
       JOIN runs endpoint_run ON endpoint_run.id = endpoint.run_id
       WHERE sv.sample_id = ? AND sv.status = 'valid'
         AND endpoint_run.deleted_at IS NULL AND endpoint.deleted_at IS NULL
       ORDER BY sv.created_at DESC, sv.id DESC LIMIT 1`,
    ).bind(sampleId).first<{ id: string; after_run_step_id: string }>(),
    c.env.DB.prepare(
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
  if (input.assetKey && !evidence) throw new HTTPException(400, { message: "The verification image is unavailable" });

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
  const userEmail = c.get("userEmail");
  const verificationId = crypto.randomUUID();
  const note = input.note.trim() || null;
  const coveredJson = JSON.stringify(covered.map((step, ordinal) => ({ stepId: step.id, ordinal })));
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
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
    c.env.DB.prepare(
      `INSERT INTO state_verifications
       (id, sample_id, after_run_step_id, previous_verification_id, run_plan_revision_id,
        expected_state_hash, result, evidence_asset_id, note, actor_email, created_at)
       SELECT ?, s.id, rs.id, ?, ?, ?, ?, ?, ?, ?, ?
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
      note,
      userEmail,
      now,
      stepId,
      runId,
      sampleId,
      verificationId,
    ),
    c.env.DB.prepare(
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
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
       SELECT ?, s.id, 'verification', ?, ?, ?, ?, ?
       FROM state_verifications sv
       JOIN samples s ON s.id = sv.sample_id
       JOIN run_steps endpoint ON endpoint.id = sv.after_run_step_id
       WHERE sv.id = ? AND endpoint.last_mutation_id = ?
         AND s.deleted_at IS NULL`,
    ).bind(crypto.randomUUID(),
      `State ${input.result === "matched" ? "verified" : "mismatch recorded"} after ${covered.length} step${covered.length === 1 ? "" : "s"}`,
      evidence?.r2_key ?? null,
      JSON.stringify({ verificationId, runId, stepId, previousVerificationId: previous?.id ?? null, coveredStepIds: covered.map((step) => step.id), result: input.result }),
      userEmail, now, verificationId, verificationId),
    c.env.DB.prepare(
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
  if (input.result === "mismatched") statements.push(c.env.DB.prepare(
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
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "This step changed elsewhere. Reload before verifying its state." });
  return c.json({
    verification: {
      id: verificationId, sampleId, afterRunStepId: stepId, previousVerificationId: previous?.id ?? null,
      runPlanRevisionId: target.current_plan_revision_id, expectedStateHash: target.expected_state_hash,
      result: input.result, note, status: "valid", actorEmail: userEmail, createdAt: now,
      coveredRunStepIds: covered.map((step) => step.id),
    },
  }, 201);
});
