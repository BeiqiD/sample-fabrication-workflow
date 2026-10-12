import { HTTPException } from "hono/http-exception";
import type { RunStepTarget } from "../../shared/types";
import { returnedEveryConfirmationTarget } from "../run-step-confirmation";
import { validRunStepTargets } from "./step-targets";
import type { StepConfirmationDatabase, StepConfirmationStatement } from "./confirmation-sql";

export interface StepConfirmationCapabilities {
  database(): StepConfirmationDatabase;
  /** Trusted current principal and write-admission check over the exact ingress
   * Request and installed service lifetime. No actor-only authorization default. */
  admit(actor: string): Promise<void>;
  now(): number;
  randomId(): string;
}
export function captureTargets(value: unknown): readonly Readonly<RunStepTarget>[] {
  const targets = value && typeof value === "object" ? (value as { targets?: unknown }).targets : undefined;
  if (!validRunStepTargets(targets)) throw new HTTPException(400, { message: "Between 1 and 12 step targets are required" });
  return Object.freeze(targets.map(({ sampleId, runId, stepId, expectedUpdatedAt }) => Object.freeze({ sampleId, runId, stepId, expectedUpdatedAt })));
}
/** Same all-or-none SQL and audit operation group as the mature route. An
 * uncertain/failed acknowledgement propagates: accepted data is never replayed
 * or guessed. A post-commit admission denial also retains accepted data. */
export function createStepConfirmationService(capabilities: StepConfirmationCapabilities) {
  return {
    async confirm(value: unknown, actor: string): Promise<{ ok: true; confirmed: number }> {
      const input = Object.freeze({ targets: captureTargets(value) });
      const operationGroupId = capabilities.randomId();
      const expectedTimes = input.targets.map((target) => Date.parse(target.expectedUpdatedAt)).filter(Number.isFinite);
      const now = new Date(Math.max(capabilities.now(), ...expectedTimes.map((value) => value + 1))).toISOString();
      const userEmail = actor;
      await capabilities.admit(actor);
      const database = capabilities.database();
      const values = input.targets.map(() => "(?, ?, ?, ?)").join(", ");
      const bindings = input.targets.flatMap((target) => [target.sampleId, target.runId, target.stepId, target.expectedUpdatedAt]);
      const statements: StepConfirmationStatement[] = [database.prepare(
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
        statements.push(database.prepare(
          `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'step', ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM run_steps WHERE last_mutation_id = ? AND id IN (${stepIds.map(() => "?").join(", ")})
       )`,
        ).bind(
          capabilities.randomId(), sampleId, `Confirmed ${stepIds.length} step${stepIds.length === 1 ? "" : "s"} as done`,
          JSON.stringify({ action: "confirmed_done", operationGroupId, stepIds }), userEmail, now,
          operationGroupId, ...stepIds,
        ));
        statements.push(database.prepare(
          `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL AND EXISTS (
         SELECT 1 FROM run_steps WHERE last_mutation_id = ? AND id IN (${stepIds.map(() => "?").join(", ")})
       )`,
        ).bind(userEmail, now, sampleId, operationGroupId, ...stepIds));
      }
      await capabilities.admit(actor);
      const results = await database.atomicBatch(statements);
      await capabilities.admit(actor);
      if (!returnedEveryConfirmationTarget(results[0]?.results, input.targets.map((target) => target.stepId))) {
        throw new HTTPException(409, { message: "One or more steps changed elsewhere. Reload before confirming." });
      }
      return { ok: true, confirmed: input.targets.length };
    },
  };
}
export type StepConfirmationService = ReturnType<typeof createStepConfirmationService>;
