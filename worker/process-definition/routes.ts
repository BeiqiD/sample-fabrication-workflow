import { d1FileBusinessMetadataDatabase } from "../files/business-metadata-d1";
import { d1TemplateReferenceLifecycleDatabase } from "./reference-lifecycle-d1";
import { requirePublishedTemplateVersionWithDatabase, removeMetrologyReferenceWithDatabase, restoreMetrologyReferenceWithDatabase } from "./reference-lifecycle-service";
import { d1TemplateContentDatabase } from "./template-content-d1";
import { cloneTemplateWithDatabase, createTemplateStepWithDatabase, updateTemplateStepWithDatabase } from "./template-content-service";
import { templateReadHandlers } from "./read-worker";
import { readReadyAssetInput } from "../files/asset-input";
import { fileAuthorityActiveSql, prepareFileRestoration } from "../files/business-lifecycle";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { hashRecipeManifest, hashStateRepresentation, hashStepDefinition, stableJson, STATE_HASH_SCHEME, STEP_HASH_SCHEME } from "../../shared/content-addressing";
import { bulkInsertStatements } from "../d1-bulk";
import { contentLengthWithin } from "../request-guards";
import { publishedTemplateVersionSql } from "../template-publication";
import type { Env } from "../types";
import { requireR2UploadRequestId } from "../uploads/r2-upload-acceptance";
import { consumerFileBindingFence, resolveConsumerFileId } from "../files/consumer-binding";
import { acceptAndUploadMetrologyReference, boundedMetrologyReferenceUploadBody,
  getMetrologyReferenceUploadRequestState, rethrowMetrologyReferenceUploadError } from "../uploads/metrology-reference-acceptance";

export const routes = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();

async function requirePublishedTemplateVersion(db: D1Database, id: string) {
  return requirePublishedTemplateVersionWithDatabase(d1FileBusinessMetadataDatabase(db), id);
}

routes.get("/template-families/options", templateReadHandlers.captureIngressRequest, templateReadHandlers.options);

routes.get("/template-families", templateReadHandlers.captureIngressRequest, templateReadHandlers.families);

routes.get("/template-families/:id/versions", templateReadHandlers.captureIngressRequest, templateReadHandlers.versions);

routes.get("/metrology-templates", templateReadHandlers.captureIngressRequest, templateReadHandlers.metrology);

routes.get("/templates", templateReadHandlers.captureIngressRequest, templateReadHandlers.list);

routes.post("/metrology-templates", async (c) => {
  const input = await c.req.json<{
    name?: string; toolName?: string; parametersText?: string; commentsText?: string;
  }>();
  if (typeof input.name !== "string" || typeof input.toolName !== "string"
    || typeof input.parametersText !== "string" || typeof input.commentsText !== "string") {
    throw new HTTPException(400, { message: "Valid metrology-template fields are required" });
  }
  const name = input.name.trim();
  const toolName = input.toolName.trim();
  const parametersText = input.parametersText.trim();
  const commentsText = input.commentsText.trim();
  if (!name || name.length > 200 || toolName.length > 500
    || parametersText.length > 10_000 || commentsText.length > 10_000) {
    throw new HTTPException(400, { message: "One or more metrology-template fields are invalid" });
  }
  const definition = await hashStepDefinition({ name, toolName, parametersText, commentsText });
  const familyId = crypto.randomUUID();
  const templateId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const logicalKey = `metrology:${stepId}`;
  const manifestHash = await hashRecipeManifest([
    { logicalStepKey: logicalKey, definitionHash: definition.hash, expectedStateHash: null },
  ]);
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO recipe_families (id, name, template_type, created_by, created_at)
         VALUES (?, ?, 'module', ?, ?)`,
      ).bind(familyId, `Metrology template · ${familyId}`, userEmail, now),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO step_definitions
         (hash, hash_scheme, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
        definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now),
      c.env.DB.prepare(
        `INSERT INTO template_versions
         (id, recipe_family_id, name, template_type, template_kind, version, manifest_hash,
          content_json, created_by, created_at)
         VALUES (?, ?, ?, 'module', 'metrology', 1, ?, '{}', ?, ?)`,
      ).bind(templateId, familyId, name, manifestHash, userEmail, now),
      c.env.DB.prepare(
        `INSERT INTO template_steps
         (id, template_version_id, logical_step_key, position, definition_hash, raw_json)
         VALUES (?, ?, ?, 0, ?, '{}')`,
      ).bind(stepId, templateId, logicalKey, definition.hash),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      throw new HTTPException(409, { message: "A metrology template with this title already exists" });
    }
    throw error;
  }
  return c.json({ id: templateId, version: 1 }, 201);
});

routes.patch("/metrology-templates/:id", async (c) => {
  const id = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, id);
  const input = await c.req.json<{
    name?: string; toolName?: string; parametersText?: string; commentsText?: string;
  }>();
  if (typeof input.name !== "string" || typeof input.toolName !== "string"
    || typeof input.parametersText !== "string" || typeof input.commentsText !== "string") {
    throw new HTTPException(400, { message: "Valid metrology-template fields are required" });
  }
  const name = input.name.trim();
  const toolName = input.toolName.trim();
  const parametersText = input.parametersText.trim();
  const commentsText = input.commentsText.trim();
  if (!name || name.length > 200 || toolName.length > 500
    || parametersText.length > 10_000 || commentsText.length > 10_000) {
    throw new HTTPException(400, { message: "One or more metrology-template fields are invalid" });
  }
  const template = await c.env.DB.prepare(
    `SELECT ts.id AS template_step_id, ts.logical_step_key
     FROM template_versions tv
     JOIN template_steps ts ON ts.template_version_id = tv.id
     WHERE tv.id = ? AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL
       AND tv.deleted_at IS NULL
       AND (SELECT COUNT(*) FROM template_steps only_step WHERE only_step.template_version_id = tv.id) = 1`,
  ).bind(id).first<{ template_step_id: string; logical_step_key: string }>();
  if (!template) throw new HTTPException(404, { message: "Metrology template not found" });
  const definition = await hashStepDefinition({ name, toolName, parametersText, commentsText });
  const manifestHash = await hashRecipeManifest([
    { logicalStepKey: template.logical_step_key, definitionHash: definition.hash, expectedStateHash: null },
  ]);
  const now = new Date().toISOString();
  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO step_definitions
         (hash, hash_scheme, name, tool_name, parameters_text, comments_text, canonical_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(definition.hash, STEP_HASH_SCHEME, definition.canonical.name, definition.canonical.toolName,
        definition.canonical.parametersText, definition.canonical.commentsText, stableJson(definition.canonical), now),
      c.env.DB.prepare(
        `UPDATE template_versions SET name = ?, manifest_hash = ?
         WHERE id = ? AND template_kind = 'metrology'
           AND archived_at IS NULL AND deleted_at IS NULL`,
      ).bind(name, manifestHash, id),
      c.env.DB.prepare(
        `UPDATE template_steps SET definition_hash = ?, expected_state_hash = NULL
         WHERE id = ? AND template_version_id = ?`,
      ).bind(definition.hash, template.template_step_id, id),
    ]);
    if (results.slice(1).some((result) => !result.meta.changes)) {
      throw new HTTPException(409, { message: "This metrology template changed while it was being saved" });
    }
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (String(error).includes("UNIQUE")) {
      throw new HTTPException(409, { message: "A metrology template with this title already exists" });
    }
    throw error;
  }
  return c.json({ ok: true });
});

routes.patch("/metrology-templates/:id/notes", async (c) => {
  const id = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, id);
  const input = await c.req.json<{ notes?: string }>();
  if (typeof input.notes !== "string" || input.notes.length > 20_000) {
    throw new HTTPException(400, { message: "Equipment or method notes must be at most 20,000 characters" });
  }
  const result = await c.env.DB.prepare(
    `UPDATE template_versions SET metrology_notes = ?
     WHERE id = ? AND template_kind = 'metrology'
       AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(input.notes.trim() || null, id).run();
  if (!result.meta.changes) throw new HTTPException(404, { message: "Metrology template not found" });
  return c.json({ ok: true });
});

routes.post("/metrology-templates/:id/references", async (c) => {
  c.header("Cache-Control", "no-store");
  const requestId = requireR2UploadRequestId(c.req.header("x-upload-request-id"));
  if (!contentLengthWithin(c.req.raw, 25 * 1024 * 1024)) {
    throw new HTTPException(413, { message: "Template reference files are limited to 25 MB" });
  }
  let filename = (c.req.header("x-filename") || "reference").trim();
  const encoded = c.req.header("x-filename-uri");
  if (encoded !== undefined) {
    try { filename = decodeURIComponent(encoded); }
    catch { throw new HTTPException(400, { message: "Reference filename encoding is invalid" }); }
  }
  const mimeType = (c.req.header("content-type") || "application/octet-stream").trim();
  if (!filename.trim() || filename.includes("\0") || [...filename].length > 255 || mimeType.length > 200) {
    throw new HTTPException(400, { message: "Reference-file metadata is invalid" });
  }
  const bytes = await boundedMetrologyReferenceUploadBody(c.req.raw);
  const upload = await acceptAndUploadMetrologyReference(c.env, {
    requestId, actorEmail: c.get("userEmail"), templateId: c.req.param("id"), originalName: filename, mimeType, bytes,
  }).catch(rethrowMetrologyReferenceUploadError);
  if (upload.state.status === "ready") return c.json({ request: upload.state, reference: upload.state.result.reference },
    upload.fresh ? 201 : 200);
  return c.json({ request: upload.state }, upload.state.status === "pending" ? 202 : 409);
});

routes.get("/metrology-templates/:id/reference-upload-requests/:requestId", async (c) => {
  c.header("Cache-Control", "no-store");
  const requestId = requireR2UploadRequestId(c.req.param("requestId"));
  const state = await getMetrologyReferenceUploadRequestState(c.env, c.get("userEmail"), c.req.param("id"), requestId)
    .catch(rethrowMetrologyReferenceUploadError);
  if (!state) throw new HTTPException(404, { message: "Reference upload request not found." });
  return c.json({ request: state });
});

routes.delete("/metrology-templates/:id/references/:referenceId", async (c) => {
  const { id, referenceId } = c.req.param();
  return c.json(await removeMetrologyReferenceWithDatabase(d1TemplateReferenceLifecycleDatabase(c.env.DB), id, referenceId, c.get("userEmail")));
});

routes.post("/metrology-templates/:id/references/:referenceId/restore", async (c) => {
  const { id, referenceId } = c.req.param();
  return c.json(await restoreMetrologyReferenceWithDatabase(d1TemplateReferenceLifecycleDatabase(c.env.DB), id, referenceId));
});

routes.post("/templates/:id/clone", async (c) => {
  return c.json(await cloneTemplateWithDatabase(d1TemplateContentDatabase(c.env.DB), c.req.param("id"), c.get("userEmail")), 201);
});

routes.get("/templates/:id", templateReadHandlers.captureIngressRequest, templateReadHandlers.detail);

routes.patch("/templates/:id", async (c) => {
  const id = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, id);
  const input = await c.req.json<{ name?: string; version?: number }>();
  if (typeof input.name !== "string" || typeof input.version !== "number" || !Number.isInteger(input.version) || input.version < 1) throw new HTTPException(400, { message: "A template name and positive integer version are required" });
  const name = input.name.trim();
  if (!name || name.length > 200) throw new HTTPException(400, { message: "Template name is required and must be at most 200 characters" });
  const current = await c.env.DB.prepare(
    "SELECT locked_at, archived_at, deleted_at FROM template_versions WHERE id = ?",
  ).bind(id).first<{ locked_at: string | null; archived_at: string | null; deleted_at: string | null }>();
  if (!current) throw new HTTPException(404, { message: "Template version not found" });
  if (current.deleted_at) throw new HTTPException(404, { message: "Template version not found" });
  if (current.archived_at) throw new HTTPException(409, { message: "Archived templates cannot be edited" });
  if (current.locked_at) throw new HTTPException(409, { message: "This template version has been used by a process run and is now locked. Clone it to create an editable version." });
  try {
    const result = await c.env.DB.prepare(
      `UPDATE template_versions SET name = ?, version = ?
       WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`,
    ).bind(name, input.version, id).run();
    if (!result.meta.changes) throw new HTTPException(409, { message: "This template version was used to start a process run while you were editing it. Clone it to continue." });
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HTTPException(409, { message: `Version ${input.version} already exists for this template` });
    throw error;
  }
  return c.json({ ok: true });
});

routes.post("/templates/:id/steps", async (c) => {
  return c.json(await createTemplateStepWithDatabase(d1TemplateContentDatabase(c.env.DB), c.req.param("id"), () => c.req.json<unknown>()), 201);
});

routes.patch("/templates/:templateId/steps/:stepId", async (c) => {
  const { templateId, stepId } = c.req.param();
  return c.json(await updateTemplateStepWithDatabase(d1TemplateContentDatabase(c.env.DB), templateId, stepId, () => c.req.json<unknown>()));
});

routes.delete("/templates/:templateId/steps/:stepId", async (c) => {
  const { templateId, stepId } = c.req.param();
  await requirePublishedTemplateVersion(c.env.DB, templateId);
  const [template, step, remainingSteps] = await Promise.all([
    c.env.DB.prepare("SELECT locked_at, archived_at, deleted_at FROM template_versions WHERE id = ?")
      .bind(templateId).first<{ locked_at: string | null; archived_at: string | null; deleted_at: string | null }>(),
    c.env.DB.prepare(
      "SELECT id FROM template_steps WHERE id = ? AND template_version_id = ?",
    ).bind(stepId, templateId).first<{ id: string }>(),
    c.env.DB.prepare(
      `SELECT logical_step_key, definition_hash, expected_state_hash
       FROM template_steps WHERE template_version_id = ? AND id != ? ORDER BY position`,
    ).bind(templateId, stepId).all<{
      logical_step_key: string;
      definition_hash: string;
      expected_state_hash: string | null;
    }>(),
  ]);
  if (!template || template.deleted_at || !step) throw new HTTPException(404, { message: "Template step not found" });
  if (template.archived_at || template.locked_at) throw new HTTPException(409, { message: "Only unused active template versions can be edited" });
  const manifestHash = await hashRecipeManifest(remainingSteps.results.map((entry) => ({
    logicalStepKey: entry.logical_step_key,
    definitionHash: entry.definition_hash,
    expectedStateHash: entry.expected_state_hash,
  })));
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM template_steps
       WHERE id = ? AND template_version_id = ?
         AND EXISTS (
           SELECT 1 FROM template_versions
           WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL
         )`,
    ).bind(stepId, templateId, templateId),
    c.env.DB.prepare(
      `UPDATE template_versions SET manifest_hash = ?
       WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL`,
    ).bind(manifestHash, templateId),
  ]);
  if (!results[0].meta.changes || !results[1].meta.changes) {
    throw new HTTPException(409, { message: "This template version was used to start a process run while the step was being deleted. Clone it to continue." });
  }
  return c.json({ ok: true });
});

routes.delete("/templates/:id", async (c) => {
  const id = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, id);
  const template = await c.env.DB.prepare(
    `SELECT tv.recipe_family_id, tv.locked_at, tv.archived_at, tv.deleted_at,
            EXISTS (SELECT 1 FROM runs r WHERE r.template_version_id = tv.id) OR
            EXISTS (SELECT 1 FROM run_plan_revisions rpr WHERE rpr.template_version_id = tv.id) OR
            EXISTS (
              SELECT 1 FROM run_steps rs
              JOIN template_steps ts ON ts.id = rs.template_step_id
              WHERE ts.template_version_id = tv.id
            ) OR
            EXISTS (SELECT 1 FROM recipe_change_proposals rcp WHERE rcp.source_template_version_id = tv.id) AS referenced
     FROM template_versions tv WHERE tv.id = ?`,
  ).bind(id).first<{
    recipe_family_id: string; locked_at: string | null; archived_at: string | null;
    deleted_at: string | null; referenced: number;
  }>();
  if (!template || template.archived_at || template.deleted_at) {
    throw new HTTPException(404, { message: "Active template version not found" });
  }

  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const archive = Boolean(template.locked_at || template.referenced);
  const result = await c.env.DB.prepare(
    `UPDATE template_versions
     SET deleted_at = ?, deleted_by = ?,
         archived_at = CASE WHEN ? THEN ? ELSE archived_at END,
         archived_by = CASE WHEN ? THEN ? ELSE archived_by END
     WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL`,
  ).bind(now, userEmail, archive ? 1 : 0, now, archive ? 1 : 0, userEmail, id).run();
  if (!result.meta.changes) {
    throw new HTTPException(409, { message: "This template changed while it was being deleted" });
  }
  return c.json({ ok: true, disposition: archive ? "archived" as const : "deleted" as const });
});

routes.post("/templates/:id/restore", async (c) => {
  const id = c.req.param("id");
  await requirePublishedTemplateVersion(c.env.DB, id);
  const template = await c.env.DB.prepare(
    `SELECT deleted_at, deleted_by, archived_at, archived_by
     FROM template_versions WHERE id = ? AND deleted_at IS NOT NULL`,
  ).bind(id).first<{
    deleted_at: string; deleted_by: string | null;
    archived_at: string | null; archived_by: string | null;
  }>();
  if (!template) throw new HTTPException(404, { message: "Deleted template version not found" });
  const result = await c.env.DB.prepare(
    `UPDATE template_versions
     SET archived_at = CASE
           WHEN archived_at = deleted_at AND archived_by IS deleted_by THEN NULL
           ELSE archived_at
         END,
         archived_by = CASE
           WHEN archived_at = deleted_at AND archived_by IS deleted_by THEN NULL
           ELSE archived_by
         END,
         deleted_at = NULL,
         deleted_by = NULL
     WHERE id = ? AND deleted_at = ?`,
  ).bind(id, template.deleted_at).run();
  if (!result.meta.changes) {
    throw new HTTPException(409, { message: "The template changed while it was being restored" });
  }
  return c.json({ ok: true });
});
