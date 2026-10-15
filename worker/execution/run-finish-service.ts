import { HTTPException } from "hono/http-exception";
import type { FinishProcessRunInput } from "../../shared/types";
import type { ReadSqlRow } from "../runtime/read-sql";
import { configurationSqlInteger } from "../runtime/configuration-sql";
import type { RunFinishDatabase } from "./run-finish-sql";

export interface RunFinishCapabilities {
  database(): RunFinishDatabase;
  /** Genuine current principal and persisted control fences; never actor syntax. */
  admit(actor: string): Promise<void>;
  now(): number;
  randomId(): string;
}
function text(row: ReadSqlRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`Invalid Run finish ${field}`);
  return value;
}
/** Mature metadata-only finish owner. Statement atomicity does not promise
 * rollback on a post-batch count conflict or a lost HTTP acknowledgement. */
export function createRunFinishService(capabilities: RunFinishCapabilities) {
  return { async finish(sampleId: string, runId: string, value: unknown, actor: string) {
  const candidate = value as Partial<FinishProcessRunInput> | null;
  const input = candidate && Object.freeze({ expectedSampleUpdatedAt: candidate.expectedSampleUpdatedAt, confirmSkipUnfinishedSteps: candidate.confirmSkipUnfinishedSteps });
  if (!input || typeof input.expectedSampleUpdatedAt !== "string"
    || (input.confirmSkipUnfinishedSteps !== undefined && typeof input.confirmSkipUnfinishedSteps !== "boolean")) {
    throw new HTTPException(400, { message: "The current sample revision is required" });
  }
  await capabilities.admit(actor);
  const database = capabilities.database();
  const [rawRun, rawSample, unfinished] = await Promise.all([
    database.prepare(
      "SELECT id, template_name_snapshot, template_version_snapshot, status FROM runs WHERE id = ? AND sample_id = ? AND run_kind = 'process' AND deleted_at IS NULL",
    ).bind(runId, sampleId).first(),
    database.prepare("SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL").bind(sampleId).first(),
    database.prepare(
      `SELECT id FROM run_steps
       WHERE run_id = ? AND entry_kind = 'fabrication' AND deleted_at IS NULL
         AND plan_status = 'current' AND status NOT IN ('done', 'skipped')
       ORDER BY position, id`,
    ).bind(runId).all(),
  ]);
  if (!rawRun || !rawSample) throw new HTTPException(404, { message: "Process run not found" });
  const run = { status: text(rawRun, "status"), template_name_snapshot: text(rawRun, "template_name_snapshot"),
    template_version_snapshot: configurationSqlInteger(rawRun.template_version_snapshot, "Run finish template_version_snapshot", Number.MIN_SAFE_INTEGER) };
  const sample = { updated_at: text(rawSample, "updated_at") };
  if (run.status !== "active") throw new HTTPException(409, { message: "Only the active process run can be finished" });
  if (sample.updated_at !== input.expectedSampleUpdatedAt) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before finishing the run." });
  }
  const unfinishedStepIds = unfinished.results.map((step) => text(step, "id"));
  if (unfinishedStepIds.length && input.confirmSkipUnfinishedSteps !== true) {
    throw new HTTPException(409, {
      message: `Finishing this run will mark ${unfinishedStepIds.length} unfinished step${unfinishedStepIds.length === 1 ? "" : "s"} as skipped. Confirm this action before continuing.`,
    });
  }
  const now = new Date(Math.max(capabilities.now(), Date.parse(sample.updated_at) + 1)).toISOString();
  const userEmail = actor;
  const mutationId = capabilities.randomId();
  await capabilities.admit(actor);
  const results = await database.atomicBatch([
    database.prepare(
      `UPDATE samples SET updated_by = ?, last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
    ).bind(userEmail, mutationId, now, sampleId, input.expectedSampleUpdatedAt),
    database.prepare(
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
         )
       RETURNING 1 AS affected`,
    ).bind(now, userEmail, mutationId, now, runId, runId, sampleId, sampleId, mutationId),
    database.prepare(
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
    database.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, s.id, 'run', ?, ?, ?, ? FROM samples s
       WHERE s.id = ? AND s.last_mutation_id = ? AND s.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM runs r
           WHERE r.id = ? AND r.sample_id = s.id AND r.status = 'complete'
             AND r.deleted_at IS NULL
         )`,
    ).bind(
      capabilities.randomId(),
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
  if (results.length !== 4) throw new Error("Incomplete Run finish batch acknowledgement");
  if (!configurationSqlInteger(results[0].directChanges, "Run finish sample changes")
    || results[1].results.length !== unfinishedStepIds.length
    || !configurationSqlInteger(results[2].directChanges, "Run finish run changes")
    || !configurationSqlInteger(results[3].directChanges, "Run finish audit changes")) {
    throw new HTTPException(409, { message: "The process run changed while it was being finished. Reload and try again." });
  }
  await capabilities.admit(actor);
  return { ok: true as const, completedAt: now, skippedStepCount: unfinishedStepIds.length };
  } };
}
export type RunFinishService = ReturnType<typeof createRunFinishService>;
