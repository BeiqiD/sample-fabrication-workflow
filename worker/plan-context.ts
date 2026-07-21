import { HTTPException } from "hono/http-exception";

type PlanContext = {
  run: {
    id: string;
    status: string;
    recipe_family_id: string;
    current_plan_revision_id: string;
    revision_no: number;
    current_template_version_id: string;
  };
  nextTemplate: {
    id: string;
    recipe_family_id: string;
    name: string;
    template_type: string;
    version: number;
  };
  existing: Array<{
    id: string;
    logicalStepKey: string | null;
    definitionHash: string | null;
    position: number;
    actualized: boolean;
    origin: "template" | "ad_hoc";
  }>;
  next: Array<{
    id: string;
    logicalStepKey: string;
    definitionHash: string;
    expectedStateHash: string | null;
    position: number;
  }>;
};

export async function loadPlanContext(db: D1Database, sampleId: string, runId: string, templateVersionId: string): Promise<PlanContext> {
  const [run, nextTemplate, existingRows, nextRows] = await Promise.all([
    db.prepare(
      `SELECT r.id, r.status, r.recipe_family_id, r.current_plan_revision_id,
              rpr.revision_no, rpr.template_version_id AS current_template_version_id
       FROM runs r JOIN run_plan_revisions rpr ON rpr.id = r.current_plan_revision_id
       WHERE r.id = ? AND r.sample_id = ?`,
    ).bind(runId, sampleId).first<PlanContext["run"]>(),
    db.prepare(
      `SELECT id, recipe_family_id, name, template_type, version FROM template_versions
       WHERE id = ? AND archived_at IS NULL`,
    ).bind(templateVersionId).first<PlanContext["nextTemplate"]>(),
    db.prepare(
      `SELECT id, logical_step_key, definition_hash, position,
              CASE WHEN actualized_at IS NOT NULL THEN 1 ELSE 0 END AS actualized, origin
       FROM run_steps WHERE run_id = ? AND (plan_status = 'current' OR origin = 'ad_hoc')
       ORDER BY position`,
    ).bind(runId).all<{
      id: string;
      logical_step_key: string | null;
      definition_hash: string | null;
      position: number;
      actualized: number;
      origin: "template" | "ad_hoc";
    }>(),
    db.prepare(
      `SELECT id, logical_step_key, definition_hash, expected_state_hash, position
       FROM template_steps WHERE template_version_id = ? ORDER BY position`,
    ).bind(templateVersionId).all<{
      id: string;
      logical_step_key: string;
      definition_hash: string;
      expected_state_hash: string | null;
      position: number;
    }>(),
  ]);
  if (!run) throw new HTTPException(404, { message: "Sample run not found" });
  if (!nextTemplate) throw new HTTPException(404, { message: "Template version not found" });
  return {
    run,
    nextTemplate,
    existing: existingRows.results.map((row) => ({
      id: row.id,
      logicalStepKey: row.logical_step_key,
      definitionHash: row.definition_hash,
      position: Number(row.position),
      actualized: Boolean(row.actualized),
      origin: row.origin,
    })),
    next: nextRows.results.map((row) => ({
      id: row.id,
      logicalStepKey: row.logical_step_key,
      definitionHash: row.definition_hash,
      expectedStateHash: row.expected_state_hash,
      position: Number(row.position),
    })),
  };
}
