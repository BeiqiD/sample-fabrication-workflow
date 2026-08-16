import { HTTPException } from "hono/http-exception";
import { publishedTemplateVersionSql } from "./template-publication";

type PlanContext = {
  run: {
    id: string;
    status: string;
    recipe_family_id: string;
    current_plan_revision_id: string;
    revision_no: number;
    current_template_version_id: string;
    current_template_version_number: number;
  };
  nextTemplate: {
    id: string;
    recipe_family_id: string;
    name: string;
    template_type: string;
    version: number;
    initial_state_hash: string | null;
    content_json: string | null;
  };
  existing: Array<{
    id: string;
    name: string;
    logicalStepKey: string | null;
    definitionHash: string | null;
    position: number;
    alignmentPosition: number;
    actualized: boolean;
    origin: "template" | "ad_hoc";
  }>;
  next: Array<{
    id: string;
    name: string;
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
              rpr.revision_no, rpr.template_version_id AS current_template_version_id,
              current_tv.version AS current_template_version_number
       FROM runs r
       JOIN run_plan_revisions rpr ON rpr.id = r.current_plan_revision_id
       JOIN template_versions current_tv ON current_tv.id = rpr.template_version_id
       WHERE r.id = ? AND r.sample_id = ? AND r.run_kind = 'process'
         AND r.deleted_at IS NULL`,
    ).bind(runId, sampleId).first<PlanContext["run"]>(),
    db.prepare(
      `SELECT tv.id, tv.recipe_family_id, tv.name, tv.template_type, tv.version,
              tv.initial_state_hash, tv.content_json
       FROM template_versions tv
       WHERE tv.id = ? AND tv.template_kind = 'process'
         AND tv.archived_at IS NULL AND tv.deleted_at IS NULL
         AND ${publishedTemplateVersionSql("tv")}`,
    ).bind(templateVersionId).first<PlanContext["nextTemplate"]>(),
    db.prepare(
      `SELECT rs.id, COALESCE(sd.name, rs.title) AS name, rs.logical_step_key, rs.definition_hash, rs.position,
              COALESCE(current_ts.position, rs.position) AS alignment_position,
              CASE WHEN rs.actualized_at IS NOT NULL THEN 1 ELSE 0 END AS actualized, rs.origin
       FROM run_steps rs
       JOIN runs current_run ON current_run.id = rs.run_id
       LEFT JOIN run_step_plan_links current_link
         ON current_link.run_plan_revision_id = current_run.current_plan_revision_id
        AND current_link.run_step_id = rs.id
       LEFT JOIN template_steps current_ts ON current_ts.id = current_link.template_step_id
       LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash
       WHERE rs.run_id = ? AND rs.entry_kind = 'fabrication'
         AND current_run.deleted_at IS NULL AND rs.deleted_at IS NULL
         AND (rs.plan_status = 'current' OR rs.origin = 'ad_hoc')
       ORDER BY rs.position`,
    ).bind(runId).all<{
      id: string;
      name: string;
      logical_step_key: string | null;
      definition_hash: string | null;
      position: number;
      alignment_position: number;
      actualized: number;
      origin: "template" | "ad_hoc";
    }>(),
    db.prepare(
      `SELECT ts.id, sd.name, ts.logical_step_key, ts.definition_hash, ts.expected_state_hash, ts.position
       FROM template_steps ts
       JOIN step_definitions sd ON sd.hash = ts.definition_hash
       WHERE ts.template_version_id = ? ORDER BY ts.position`,
    ).bind(templateVersionId).all<{
      id: string;
      name: string;
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
      name: row.name,
      logicalStepKey: row.logical_step_key,
      definitionHash: row.definition_hash,
      position: Number(row.position),
      alignmentPosition: Number(row.alignment_position),
      actualized: Boolean(row.actualized),
      origin: row.origin,
    })),
    next: nextRows.results.map((row) => ({
      id: row.id,
      name: row.name,
      logicalStepKey: row.logical_step_key,
      definitionHash: row.definition_hash,
      expectedStateHash: row.expected_state_hash,
      position: Number(row.position),
    })),
  };
}
