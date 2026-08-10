import { Hono } from "hono";
import { PROJECT_EXPORT_SCHEMA_VERSION } from "../shared/project-types";
import { buildBlobExportPlan } from "./export-data";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };
type ExportRow = Record<string, unknown>;

// Project owns the canonical complete export. The core Worker mounts the
// Project aggregate directly, and the superseded monolithic export handler has
// been removed. One D1 batch remains the complete snapshot boundary.
export const PROJECT_EXPORT_TABLE_QUERIES = {
  samples: "SELECT * FROM samples ORDER BY created_at, id",
  events: "SELECT * FROM events ORDER BY created_at, id",
  recipe_families: "SELECT * FROM recipe_families ORDER BY created_at, id",
  step_definitions: "SELECT * FROM step_definitions ORDER BY hash",
  state_representations: "SELECT * FROM state_representations ORDER BY hash",
  state_representation_assets: "SELECT * FROM state_representation_assets ORDER BY state_hash, position",
  template_versions: "SELECT * FROM template_versions ORDER BY created_at, id",
  template_steps: "SELECT * FROM template_steps ORDER BY template_version_id, position",
  metrology_template_references: "SELECT * FROM metrology_template_references ORDER BY template_version_id, position, id",
  runs: "SELECT * FROM runs ORDER BY created_at, id",
  run_plan_revisions: "SELECT * FROM run_plan_revisions ORDER BY run_id, revision_no",
  run_steps: "SELECT * FROM run_steps ORDER BY run_id, position",
  run_step_plan_links: "SELECT * FROM run_step_plan_links ORDER BY run_plan_revision_id, template_step_id",
  run_step_comments: "SELECT * FROM run_step_comments ORDER BY run_step_id, created_at, id",
  run_step_assets: "SELECT * FROM run_step_assets ORDER BY run_step_id, role, position",
  state_verifications: "SELECT * FROM state_verifications ORDER BY sample_id, created_at, id",
  state_verification_steps: "SELECT * FROM state_verification_steps ORDER BY verification_id, ordinal",
  recipe_change_proposals: "SELECT * FROM recipe_change_proposals ORDER BY created_at, id",
  imports: "SELECT * FROM imports ORDER BY created_at, id",
  assets: "SELECT * FROM assets ORDER BY created_at, id",
  comment_submissions: "SELECT * FROM comment_submissions ORDER BY created_at, id",
  comment_submission_targets: "SELECT * FROM comment_submission_targets ORDER BY submission_id, run_step_id",
  comment_submission_items: "SELECT * FROM comment_submission_items ORDER BY submission_id, position",
  managed_storage_objects: "SELECT * FROM managed_storage_objects ORDER BY created_at, id",
  reference_targets: "SELECT * FROM reference_targets ORDER BY target_type, target_id",
  projects: "SELECT * FROM projects ORDER BY created_at, id",
  project_contents: "SELECT * FROM project_contents ORDER BY project_id, created_at, id",
  project_content_attachments: "SELECT * FROM project_content_attachments ORDER BY project_content_id",
  project_items: "SELECT * FROM project_items ORDER BY project_id, created_sequence, id",
  project_map_placements: "SELECT * FROM project_map_placements ORDER BY project_item_id, id",
  project_edges: "SELECT * FROM project_edges ORDER BY project_id, created_at, id",
  blob_gc_ledger: "SELECT * FROM blob_gc_ledger ORDER BY store_kind, provider, object_key",
  blob_retention_edges: `SELECT * FROM blob_retention_edges
    ORDER BY store_kind, provider, object_key, source_type, source_id, occurrence_type, occurrence_id`,
} as const;

export const routes = new Hono<AppBindings>();

routes.get("/exports/all", async (c) => {
  const names = Object.keys(PROJECT_EXPORT_TABLE_QUERIES);
  const results = await c.env.DB.batch(
    Object.values(PROJECT_EXPORT_TABLE_QUERIES).map((sql) => c.env.DB.prepare(sql)),
  );
  const entries = names.map((name, index) => [name, results[index].results ?? []] as const);
  const tables = Object.fromEntries(entries) as Record<string, ExportRow[]>;
  return c.json({
    schemaVersion: PROJECT_EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    tables,
    blobs: buildBlobExportPlan(tables),
  });
});
