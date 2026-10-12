import { HTTPException } from "hono/http-exception";
import type { ApplyPlanUpdateInput, StartProcessRunInput, SubstrateTransitionConfirmation } from "../../shared/types";
import type { ReadSqlCell, ReadSqlRow } from "../runtime/read-sql";
import { configurationSqlInteger } from "../runtime/configuration-sql";
import { loadCurrentSampleStructureSql, type SampleStructureReadCapabilities } from "../application/sample-structure-read";
import { loadPlanContextSql } from "./plan-context-read";
import { alignFuturePlan } from "./plan-alignment";
import { resolvePlanUpdateStructureTarget } from "../plan-update";
import { parseInitialSubstrateStep } from "../process-definition/substrate";
import { validateSubstrateTransition } from "../run-start";
import { ACTIVATE_SAMPLE_FOR_RUN_SQL } from "../run-lifecycle";
import { bulkInsertRunPlanStatements, type RunPlanDatabase, type RunPlanStatement } from "./run-plan-sql";

export interface RunPlanCapabilities extends SampleStructureReadCapabilities {
  database(): RunPlanDatabase;
  /** Original Request/current installation/actor/control policy, never actor syntax. */
  admit(actor: string): Promise<void>;
  now(): number;
  randomId(): string;
}
function text(row: ReadSqlRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`Invalid Run plan SQL text: ${field}`);
  return value;
}
function nullableText(row: ReadSqlRow, field: string): string | null {
  return row[field] === null ? null : text(row, field);
}
function integer(row: ReadSqlRow, field: string): number {
  return configurationSqlInteger(row[field], `Run plan ${field}`, Number.MIN_SAFE_INTEGER);
}
function startTemplate(row: ReadSqlRow) {
  return { name: text(row, "name"), template_type: text(row, "template_type"), version: integer(row, "version"),
    recipe_family_id: text(row, "recipe_family_id"), initial_state_hash: nullableText(row, "initial_state_hash"), content_json: nullableText(row, "content_json") };
}
function startStep(row: ReadSqlRow) {
  return { id: text(row, "id"), logical_step_key: text(row, "logical_step_key"),
    definition_hash: text(row, "definition_hash"), expected_state_hash: nullableText(row, "expected_state_hash") };
}
function captureConfirmation(value: SubstrateTransitionConfirmation | undefined) {
  return value === undefined ? undefined : Object.freeze({ ...value });
}
export function captureStartInput(value: unknown): StartProcessRunInput | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as StartProcessRunInput;
  return Object.freeze({ templateVersionId: candidate.templateVersionId, substrateConfirmation: captureConfirmation(candidate.substrateConfirmation) });
}
export function capturePlanInput(value: unknown): ApplyPlanUpdateInput | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as ApplyPlanUpdateInput;
  return Object.freeze({ templateVersionId: candidate.templateVersionId, reason: candidate.reason, substrateConfirmation: Object.freeze({ ...candidate.substrateConfirmation }) });
}

/** Mature start/update algorithms and SQL retain one business batch <=49 and
 * existing CAS/replay semantics. Native SQL failures roll back the batch;
 * post-commit count conflicts/HTTP loss do not promise rollback or replay. */
async function startRun(capabilities: RunPlanCapabilities, sampleId: string, value: unknown, actor: string) {
  const input = captureStartInput(value);
  if (!input || typeof input !== "object") throw new HTTPException(400, { message: "A process-template version and substrate confirmation are required" });
  const { templateVersionId } = input;
  if (typeof templateVersionId !== "string" || !templateVersionId) throw new HTTPException(400, { message: "Template version is required" });
  await capabilities.admit(actor);
  const db = capabilities.database();
  const [sampleRow, templateRow, templateStepRows, latestRunRow, latestSequenceRow] = await Promise.all([
    db.prepare("SELECT code, updated_at FROM samples WHERE id = ? AND deleted_at IS NULL").bind(sampleId).first(),
    db.prepare(
      `SELECT tv.name, tv.template_type, tv.version, tv.recipe_family_id, tv.initial_state_hash, tv.content_json
       FROM template_versions tv WHERE tv.id = ? AND tv.template_kind = 'process' AND tv.archived_at IS NULL
       AND tv.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.template_version_id = tv.id AND i.status != 'ready')`,
    ).bind(templateVersionId).first(),
    db.prepare(
      `SELECT id, position, logical_step_key, definition_hash, expected_state_hash
       FROM template_steps WHERE template_version_id = ? ORDER BY position`,
    ).bind(templateVersionId).all(),
    db.prepare(
      `SELECT id, status, sequence_no
       FROM runs WHERE sample_id = ? AND run_kind = 'process' AND deleted_at IS NULL
       ORDER BY sequence_no DESC LIMIT 1`,
    ).bind(sampleId).first(),
    db.prepare("SELECT COALESCE(MAX(sequence_no), 0) AS sequence_no FROM runs WHERE sample_id = ?")
      .bind(sampleId).first(),
  ]);
  const sample = sampleRow === null ? null : { code: text(sampleRow, "code"), updated_at: text(sampleRow, "updated_at") };
  const template = templateRow === null ? null : startTemplate(templateRow);
  const latestRun = latestRunRow === null ? null : { id: text(latestRunRow, "id"), status: text(latestRunRow, "status"), sequence_no: integer(latestRunRow, "sequence_no") };
  const latestSequence = latestSequenceRow === null ? null : { sequence_no: integer(latestSequenceRow, "sequence_no") };
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  if (!template) throw new HTTPException(404, { message: "Template version not found" });
  if (!parseInitialSubstrateStep(template.content_json)) {
    throw new HTTPException(409, { message: "This process-template version has no valid Step 0: Substrate Stack snapshot. Re-import it before starting a run." });
  }
  if (latestRun?.status === "active") throw new HTTPException(409, { message: "This sample already has an active process run. Update its process template or finish it before starting a new run." });
  const currentState = await loadCurrentSampleStructureSql(capabilities, sampleId);
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
  const steps = templateStepRows.results.map(startStep);
  if (!steps.length) throw new HTTPException(422, { message: "This template has no mapped steps. Re-import it with a step column." });

  const runId = capabilities.randomId();
  const planRevisionId = capabilities.randomId();
  const eventId = capabilities.randomId();
  const now = new Date(Math.max(capabilities.now(), Date.parse(sample.updated_at) + 1)).toISOString();
  const userEmail = actor;
  const stepIds = new Map(steps.map((step) => [step.id, capabilities.randomId()]));
  const anchorRow = latestRun ? await db.prepare(
    `SELECT id FROM run_steps
     WHERE run_id = ? AND entry_kind = 'fabrication' AND actualized_at IS NOT NULL
       AND deleted_at IS NULL
     ORDER BY position DESC LIMIT 1`,
  ).bind(latestRun.id).first() : null;
  const anchor = anchorRow === null ? null : { id: text(anchorRow, "id") };
  const statements: RunPlanStatement[] = [
    db.prepare(
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
      latestRun?.id ?? null, anchor?.id ?? null, Number(latestSequence?.sequence_no ?? 0) + 1, capabilities.randomId(),
      template.name, template.template_type, template.version, initialState.confirmedTemplateStateHash, userEmail, now,
      sampleId, input.substrateConfirmation!.expectedSampleUpdatedAt, latestRun?.id ?? null),
    db.prepare(
      `INSERT INTO run_plan_revisions
       (id, run_id, revision_no, template_version_id, effective_after_step_id, reason, actor_email, created_at)
       VALUES (?, ?, 1, ?, ?, 'Initial assignment', ?, ?)`,
    ).bind(planRevisionId, runId, templateVersionId, anchor?.id ?? null, userEmail, now),
    ...bulkInsertRunPlanStatements(db, "run_steps",
      ["id", "run_id", "previous_step_id", "position", "origin", "plan_status", "template_step_id", "logical_step_key", "definition_hash", "expected_state_hash", "created_at", "updated_by", "updated_at"],
      steps.map((step, index) => [stepIds.get(step.id)!, runId, index ? stepIds.get(steps[index - 1].id)! : anchor?.id ?? null,
        (index + 1) * 1000, "template", "current", step.id, step.logical_step_key, step.definition_hash, step.expected_state_hash, now, userEmail, now])),
    ...bulkInsertRunPlanStatements(db, "run_step_plan_links",
      ["run_plan_revision_id", "template_step_id", "run_step_id", "relation", "created_at"],
      steps.map((step) => [planRevisionId, step.id, stepIds.get(step.id)!, "planned", now])),
    db.prepare(
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
    db.prepare(ACTIVATE_SAMPLE_FOR_RUN_SQL).bind(userEmail, now, sampleId),
  ];
  if (statements.length > 49) throw new HTTPException(413, { message: "This process template is too large to start on the current plan" });
  await capabilities.admit(actor);
  try { await db.atomicBatch(statements); }
  catch (error) {
    if (/template version (archived|unavailable)/.test(String(error))) {
      throw new HTTPException(409, { message: "This process-template version became unavailable before the run started" });
    }
    if (String(error).includes("FOREIGN KEY") || String(error).includes("constraint")) {
      throw new HTTPException(409, { message: "The sample or its latest run changed while the structures were being confirmed. Review them again." });
    }
    throw error;
  }
  await capabilities.admit(actor);
  return { id: runId };
}

async function applyPlanUpdate(capabilities: RunPlanCapabilities, sampleId: string, runId: string, value: unknown, actor: string) {
  const input = capturePlanInput(value);
  if (!input || typeof input !== "object" || typeof input.templateVersionId !== "string" || !input.templateVersionId || (input.reason !== undefined && typeof input.reason !== "string")) {
    throw new HTTPException(400, { message: "A process-template version, substrate confirmation, and optional reason are required" });
  }
  await capabilities.admit(actor);
  const db = capabilities.database();
  const context = await loadPlanContextSql(db, sampleId, runId, input.templateVersionId);
  const [sampleRow, latestRunRow, currentState] = await Promise.all([
    db.prepare("SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL").bind(sampleId).first(),
    db.prepare("SELECT id, status FROM runs WHERE sample_id = ? AND run_kind = 'process' AND deleted_at IS NULL ORDER BY sequence_no DESC LIMIT 1")
      .bind(sampleId).first(),
    loadCurrentSampleStructureSql(capabilities, sampleId),
  ]);
  const sample = sampleRow === null ? null : { updated_at: text(sampleRow, "updated_at") };
  const latestRun = latestRunRow === null ? null : { id: text(latestRunRow, "id"), status: text(latestRunRow, "status") };
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

  const now = new Date(Math.max(capabilities.now(), Date.parse(sample.updated_at) + 1)).toISOString();
  const userEmail = actor;
  const revisionId = capabilities.randomId();
  const matchByTemplate = new Map(alignment.matches.map((match) => [match.templateStepId, match]));
  const existingById = new Map(context.existing.map((step) => [step.id, step]));
  const additionByTemplate = new Map(alignment.additions.map((step) => [step.id, step]));
  const addedIds = new Map(alignment.additions.map((step) => [step.id, capabilities.randomId()]));
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
  const newSteps: ReadSqlCell[][] = [];
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

  const statements: RunPlanStatement[] = [
    db.prepare(
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
      runId, sampleId, input.substrateConfirmation.expectedCurrentPlanRevisionId!,
      reopening ? "complete" : "active", input.substrateConfirmation.expectedSampleUpdatedAt, reopening ? 1 : 0),
    db.prepare(
      `UPDATE run_steps SET position = -1000000000 - (? * 1000000) - position
       WHERE run_id = ? AND origin = 'template' AND actualized_at IS NULL AND plan_status = 'current'
         AND EXISTS (SELECT 1 FROM run_plan_revisions WHERE id = ?)`,
    ).bind(Number(context.run.revision_no) + 1, runId, revisionId),
  ];
  statements.push(...bulkInsertRunPlanStatements(db, "run_steps",
    ["id", "run_id", "previous_step_id", "position", "origin", "plan_status", "template_step_id", "logical_step_key", "definition_hash", "expected_state_hash", "status", "actualized_at", "created_at", "updated_by", "updated_at"],
    newSteps));
  for (let index = 0; index < actualizedMatches.length; index += 16) {
    const chunk = actualizedMatches.slice(index, index + 16);
    const values = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const bindings = chunk.flatMap((step) => [step.id, step.templateStepId,
      step.logicalStepKey, step.definitionHash, step.expectedStateHash]);
    statements.push(db.prepare(
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
    statements.push(db.prepare(
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
      statements.push(db.prepare(
        `UPDATE run_steps SET plan_status = 'superseded', updated_by = ?, updated_at = ?
         WHERE run_id = ? AND id IN (${ids.map(() => "?").join(", ")})
           AND EXISTS (SELECT 1 FROM run_plan_revisions WHERE id = ?)`,
      ).bind(userEmail, now, runId, ...ids, revisionId));
    }
  }
  const linkRows = context.next.map((step) => {
    const match = matchByTemplate.get(step.id);
    const addition = match ? null : additionByTemplate.get(step.id);
    return [revisionId, step.id, match?.existingStepId ?? addedIds.get(step.id)!,
      match?.relation ?? (addition?.initialStatus === "skipped" ? "skipped" : "planned"), now];
  });
  statements.push(
    ...bulkInsertRunPlanStatements(db, "run_step_plan_links",
      ["run_plan_revision_id", "template_step_id", "run_step_id", "relation", "created_at"], linkRows),
    db.prepare(
      `UPDATE runs SET current_plan_revision_id = ?, template_version_id = ?,
              template_name_snapshot = ?, template_type_snapshot = ?, template_version_snapshot = ?,
              status = 'active', completed_at = NULL
       WHERE id = ? AND sample_id = ? AND status = ?
         AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM run_plan_revisions WHERE id = ?)`,
    ).bind(revisionId, input.templateVersionId, context.nextTemplate.name, context.nextTemplate.template_type,
      context.nextTemplate.version, runId, sampleId, reopening ? "complete" : "active", revisionId),
    db.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'plan', ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM runs
         WHERE id = ? AND current_plan_revision_id = ? AND deleted_at IS NULL
       )`,
    ).bind(capabilities.randomId(), sampleId,
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
    db.prepare(
      `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL AND EXISTS (
         SELECT 1 FROM runs
         WHERE id = ? AND current_plan_revision_id = ? AND deleted_at IS NULL
       )`,
    ).bind(userEmail, now, sampleId, runId, revisionId),
  );
  if (statements.length > 49) throw new HTTPException(413, { message: "This plan update is too large for one atomic operation" });
  await capabilities.admit(actor);
  try {
    const results = await db.atomicBatch(statements);
    if (!results[0].changes || !results[results.length - 3].changes
      || !results[results.length - 2].changes || !results[results.length - 1].changes) {
      throw new HTTPException(409, { message: "The run or sample changed while the structures were being confirmed. Review them again." });
    }
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (/template version (archived|unavailable)/.test(String(error))) {
      throw new HTTPException(409, { message: "This process-template version became unavailable before the plan update was saved." });
    }
    throw error;
  }
  await capabilities.admit(actor);
  return { ok: true as const, planRevisionId: revisionId, revisionNumber: Number(context.run.revision_no) + 1 };
}

export function createRunPlanService(capabilities: RunPlanCapabilities) {
  return { start: (sampleId: string, value: unknown, actor: string) => startRun(capabilities, sampleId, value, actor),
    apply: (sampleId: string, runId: string, value: unknown, actor: string) => applyPlanUpdate(capabilities, sampleId, runId, value, actor) };
}
export type RunPlanService = ReturnType<typeof createRunPlanService>;
