import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { PROJECT_EXPORT_SCHEMA_VERSION } from "../shared/project-types";
import {
  AttachmentIngestionUnavailableError,
  ingestR2Attachment,
  safeAttachmentObjectName,
} from "./attachment-ingestion";
import { buildBlobExportPlan } from "./export-data";
import { contentLengthWithin } from "./request-guards";
import type { Env } from "./types";

type AppBindings = { Bindings: Env; Variables: { userEmail: string } };
type ExportRow = Record<string, unknown>;
type ProjectAssetRow = {
  id: string;
  r2_key: string;
  original_name: string;
  mime_type: string;
  byte_size: number;
};

const MAX_PROJECT_ATTACHMENT_UPLOAD_BYTES = 10 * 1024 * 1024;

function projectUploadFilename(encoded: string | undefined) {
  if (!encoded) throw new HTTPException(400, { message: "A Project attachment filename is required" });
  let filename: string;
  try {
    filename = decodeURIComponent(encoded);
  } catch {
    throw new HTTPException(400, { message: "Project attachment filename encoding is invalid" });
  }
  if (!filename.trim() || filename.includes("\u0000") || [...filename].length > 255) {
    throw new HTTPException(400, { message: "Project attachment filename is invalid" });
  }
  return filename;
}

function returnReusableProjectAsset(
  row: ProjectAssetRow,
  deduplicated = true,
) {
  return { id: row.id, key: row.r2_key, deduplicated };
}

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
  attachment_derivatives: `SELECT * FROM attachment_derivatives
    ORDER BY source_sha256, source_byte_size, derivative_kind, generator_version, id`,
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
  blob_integrity_quarantine: "SELECT * FROM blob_integrity_quarantine ORDER BY store_kind, provider, object_key",
  blob_retention_edges: `SELECT * FROM blob_retention_edges
    ORDER BY store_kind, provider, object_key, source_type, source_id, occurrence_type, occurrence_id`,
} as const;

export const routes = new Hono<AppBindings>();

routes.post("/project-assets", async (c) => {
  if (!contentLengthWithin(c.req.raw, MAX_PROJECT_ATTACHMENT_UPLOAD_BYTES)) {
    throw new HTTPException(413, { message: "Project attachment uploads are limited to 10 MB" });
  }
  const contentType = (c.req.header("content-type") || "application/octet-stream").trim();
  const filename = projectUploadFilename(c.req.header("x-project-filename-uri"));
  if (!contentType || contentType.length > 200) {
    throw new HTTPException(400, { message: "Project attachment MIME metadata is invalid" });
  }
  const buffer = await c.req.arrayBuffer();
  if (buffer.byteLength > MAX_PROJECT_ATTACHMENT_UPLOAD_BYTES) {
    throw new HTTPException(413, { message: "Project attachment uploads are limited to 10 MB" });
  }

  const registration = await ingestR2Attachment(c.env, {
    originalName: filename,
    mimeType: contentType,
    actorEmail: c.get("userEmail"),
    bytes: buffer,
    objectKey: (id) => `${new Date().toISOString().slice(0, 10)}/${id}-${safeAttachmentObjectName(filename)}`,
  }).catch((error: unknown) => {
    if (error instanceof AttachmentIngestionUnavailableError) {
      throw new HTTPException(503, { message: error.publicMessage });
    }
    throw error;
  });
  const payload = returnReusableProjectAsset(
    registration.record,
    registration.deduplicated,
  );
  return registration.deduplicated
    ? c.json(payload)
    : c.json(payload, 201);
});

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