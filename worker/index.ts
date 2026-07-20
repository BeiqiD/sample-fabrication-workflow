import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { CreateRecordInput, CreateRunStepInput, CreateSampleInput, SampleStatus, StepStatus, UpdateRunStepInput, UpdateSampleInput } from "../shared/types";
import { sampleDetail, sampleEvent, sampleSummary } from "./serializers";
import { templateStepsFromContent } from "./template-steps";
import { collectExportAssetKeys } from "./export-data";
import { authenticateRequest } from "./auth";
import { bulkInsertStatements } from "./d1-bulk";
import { contentLengthWithin, escapedLikePattern, sameOriginOrNonBrowser } from "./request-guards";
import { insertionPosition } from "./run-position";
import { resolveAssetReferences } from "./asset-dedupe";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>().basePath("/api");

async function digestSha256(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeObjectName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function deleteR2KeysInBatches(bucket: R2Bucket, keys: string[]) {
  const failures: unknown[] = [];
  for (let index = 0; index < keys.length; index += 5) {
    const results = await Promise.allSettled(keys.slice(index, index + 5).map((key) => bucket.delete(key)));
    for (const result of results) if (result.status === "rejected") failures.push(result.reason);
  }
  return failures;
}

app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  console.error(error);
  return c.json({ error: "Unexpected server error" }, 500);
});

app.use("*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !sameOriginOrNonBrowser(c.req.raw)) {
    return c.json({ error: "Cross-origin writes are not allowed" }, 403);
  }
  try {
    const identity = await authenticateRequest(c.req.raw, c.env);
    c.set("userEmail", identity.email);
    await next();
  } catch (error) {
    console.warn("Authentication rejected", error);
    return c.json({ error: "Authentication required" }, 403);
  }
});

app.get("/health", (c) => c.json({ ok: true }));

app.get("/ready", async (c) => {
  await Promise.all([
    c.env.DB.prepare("SELECT 1 AS ok").first(),
    c.env.ASSETS.list({ limit: 1 }),
  ]);
  return c.json({ ok: true });
});

app.get("/samples", async (c) => {
  const query = c.req.query("q")?.trim() ?? "";
  const pattern = escapedLikePattern(query);
  const statement = query
    ? c.env.DB.prepare(
        `SELECT * FROM samples
         WHERE code LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\'
         ORDER BY pinned DESC, updated_at DESC LIMIT 50`,
      ).bind(pattern, pattern, pattern)
    : c.env.DB.prepare("SELECT * FROM samples ORDER BY pinned DESC, updated_at DESC LIMIT 30");
  const result = await statement.all();
  return c.json({ samples: result.results.map((row) => sampleSummary(row as never)) });
});

app.post("/samples", async (c) => {
  const input = await c.req.json<CreateSampleInput>();
  if (typeof input.code !== "string" || typeof input.title !== "string" || (input.description !== undefined && typeof input.description !== "string") || (input.location !== undefined && typeof input.location !== "string") || (input.parentId !== undefined && typeof input.parentId !== "string")) {
    throw new HTTPException(400, { message: "Invalid sample fields" });
  }
  const code = input.code.trim();
  const title = input.title.trim();
  if (!code || !title) throw new HTTPException(400, { message: "Code and title are required" });
  if (code.length > 100 || title.length > 200 || (input.description?.length ?? 0) > 10_000 || (input.location?.length ?? 0) > 500) {
    throw new HTTPException(400, { message: "One or more sample fields are too long" });
  }

  const id = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO samples (id, code, title, description, location, parent_id, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, code, title, input.description?.trim() || null, input.location?.trim() || null, input.parentId || null, userEmail, userEmail, now, now),
      c.env.DB.prepare(
        "INSERT INTO events (id, sample_id, kind, body, actor_email, created_at) VALUES (?, ?, 'created', ?, ?, ?)",
      ).bind(eventId, id, `Sample ${code} created`, userEmail, now),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HTTPException(409, { message: `Sample code ${code} already exists` });
    throw error;
  }
  return c.json({ id }, 201);
});

app.get("/samples/:id", async (c) => {
  const id = c.req.param("id");
  const [sample, children, events, runRows, runAssetRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT s.*, p.id AS p_id, p.code AS p_code, p.title AS p_title
       FROM samples s LEFT JOIN samples p ON p.id = s.parent_id WHERE s.id = ?`,
    ).bind(id).first<Record<string, unknown>>(),
    c.env.DB.prepare("SELECT id, code, title FROM samples WHERE parent_id = ? ORDER BY created_at").bind(id).all(),
    c.env.DB.prepare("SELECT * FROM events WHERE sample_id = ? ORDER BY created_at DESC").bind(id).all(),
    c.env.DB.prepare(
      `SELECT r.id AS run_id, r.template_version_id, r.status AS run_status,
              r.created_at AS run_created_at, r.completed_at,
              r.template_name_snapshot AS template_name,
              r.template_type_snapshot AS template_type,
              r.template_version_snapshot AS template_version,
              rs.id AS step_id, rs.position, rs.title AS step_title,
              rs.status AS step_status, rs.notes, rs.updated_at AS step_updated_at,
              rs.origin, rs.tool_name, rs.parameters_text, rs.comments_text, rs.deviation_note,
              rs.planned_title, rs.planned_tool_name, rs.planned_parameters_text,
              rs.planned_comments_text, rs.created_at AS step_created_at
       FROM runs r
       LEFT JOIN run_steps rs ON rs.run_id = r.id
       WHERE r.sample_id = ?
       ORDER BY r.created_at DESC, rs.position ASC`,
    ).bind(id).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT rsa.run_step_id, rsa.role, a.r2_key
       FROM run_step_assets rsa
       JOIN assets a ON a.id = rsa.asset_id AND a.status = 'ready'
       JOIN run_steps rs ON rs.id = rsa.run_step_id
       JOIN runs r ON r.id = rs.run_id
       WHERE r.sample_id = ?
       ORDER BY rsa.run_step_id, rsa.role, rsa.position, rsa.created_at`,
    ).bind(id).all<{ run_step_id: string; role: "planned" | "execution"; r2_key: string }>(),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  const parent = sample.p_id
    ? { id: String(sample.p_id), code: String(sample.p_code), title: String(sample.p_title) }
    : null;
  const runs = new Map<string, {
    id: string; templateVersionId: string; templateName: string;
    templateType: string; templateVersion: number; status: string;
    createdAt: string; completedAt: string | null; steps: unknown[];
  }>();
  const stepAssets = new Map<string, { planned: string[]; execution: string[] }>();
  for (const row of runAssetRows.results) {
    const entry = stepAssets.get(row.run_step_id) ?? { planned: [], execution: [] };
    entry[row.role].push(row.r2_key);
    stepAssets.set(row.run_step_id, entry);
  }
  for (const row of runRows.results) {
    const runId = String(row.run_id);
    if (!runs.has(runId)) runs.set(runId, {
      id: runId,
      templateVersionId: String(row.template_version_id),
      templateName: String(row.template_name),
      templateType: String(row.template_type),
      templateVersion: Number(row.template_version),
      status: String(row.run_status),
      createdAt: String(row.run_created_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
      steps: [],
    });
    if (row.step_id) {
      const stepId = String(row.step_id);
      const images = stepAssets.get(stepId) ?? { planned: [], execution: [] };
      runs.get(runId)!.steps.push({
      id: stepId, position: Number(row.position), origin: String(row.origin), title: String(row.step_title),
      status: String(row.step_status), notes: row.notes ? String(row.notes) : null,
      toolName: row.tool_name ? String(row.tool_name) : null,
      parametersText: row.parameters_text ? String(row.parameters_text) : null,
      commentsText: row.comments_text ? String(row.comments_text) : null,
      deviationNote: row.deviation_note ? String(row.deviation_note) : null,
      plannedTitle: row.planned_title ? String(row.planned_title) : null,
      plannedToolName: row.planned_tool_name ? String(row.planned_tool_name) : null,
      plannedParametersText: row.planned_parameters_text ? String(row.planned_parameters_text) : null,
      plannedCommentsText: row.planned_comments_text ? String(row.planned_comments_text) : null,
      plannedImageKeys: images.planned,
      executionImageKeys: images.execution,
      createdAt: String(row.step_created_at),
      updatedAt: String(row.step_updated_at),
    });
    }
  }
  return c.json({
    ...sampleDetail(sample as never),
    parent,
    children: children.results,
    events: events.results.map((row) => sampleEvent(row as never)),
    runs: [...runs.values()],
  });
});

app.patch("/samples/:id", async (c) => {
  const id = c.req.param("id");
  const input = await c.req.json<UpdateSampleInput>();
  const allowedStatuses: SampleStatus[] = ["active", "stored", "consumed", "lost"];
  if (typeof input.expectedUpdatedAt !== "string" || (input.location !== undefined && typeof input.location !== "string") || (input.pinned !== undefined && typeof input.pinned !== "boolean")) throw new HTTPException(400, { message: "Invalid sample update" });
  if (input.location && input.location.length > 500) throw new HTTPException(400, { message: "Location is too long" });
  if (input.status !== undefined && !allowedStatuses.includes(input.status)) {
    throw new HTTPException(400, { message: "Invalid sample status" });
  }
  const current = await c.env.DB.prepare(
    "SELECT status, location, pinned, updated_at FROM samples WHERE id = ?",
  ).bind(id).first<{ status: SampleStatus; location: string | null; pinned: number; updated_at: string }>();
  if (!current) throw new HTTPException(404, { message: "Sample not found" });
  if (current.updated_at !== input.expectedUpdatedAt) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before saving." });
  }

  const nextStatus = input.status ?? current.status;
  const nextLocation = input.location === undefined ? current.location : input.location.trim() || null;
  const nextPinned = input.pinned === undefined ? Boolean(current.pinned) : input.pinned;
  const changed = nextLocation !== current.location || nextStatus !== current.status || nextPinned !== Boolean(current.pinned);
  if (!changed) return c.json({ ok: true, updatedAt: current.updated_at });

  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(
    `UPDATE samples SET status = ?, location = ?, pinned = ?, updated_by = ?, updated_at = ?
     WHERE id = ? AND updated_at = ?`,
  ).bind(nextStatus, nextLocation, nextPinned ? 1 : 0, c.get("userEmail"), now, id, input.expectedUpdatedAt).run();
  if (!result.meta.changes) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before saving." });
  }
  return c.json({ ok: true, updatedAt: now });
});

app.post("/samples/:id/records", async (c) => {
  const sampleId = c.req.param("id");
  const input = await c.req.json<CreateRecordInput>();
  const allowedStatuses: SampleStatus[] = ["active", "stored", "consumed", "lost"];
  if (typeof input.expectedUpdatedAt !== "string" || typeof input.location !== "string" || typeof input.pinned !== "boolean" || !allowedStatuses.includes(input.status) || (input.body !== undefined && typeof input.body !== "string") || (input.assetKey !== undefined && typeof input.assetKey !== "string") || (input.thumbnailKey !== undefined && typeof input.thumbnailKey !== "string")) {
    throw new HTTPException(400, { message: "A valid sample state and expectedUpdatedAt are required" });
  }
  const body = input.body?.trim() || null;
  if ((input.body?.length ?? 0) > 10_000 || input.location.length > 500) {
    throw new HTTPException(400, { message: "Record text or location is too long" });
  }
  const assetKey = input.assetKey || null;
  const thumbnailKey = input.thumbnailKey || null;
  if (thumbnailKey && !assetKey) throw new HTTPException(400, { message: "A thumbnail requires a primary asset" });
  const assetKeys = [assetKey, thumbnailKey].filter((key): key is string => Boolean(key));
  if (assetKeys.length) {
    const placeholders = assetKeys.map(() => "?").join(", ");
    const result = await c.env.DB.prepare(
      `SELECT r2_key FROM assets WHERE status = 'ready' AND r2_key IN (${placeholders})`,
    ).bind(...assetKeys).all<{ r2_key: string }>();
    if (new Set(result.results.map((row) => row.r2_key)).size !== new Set(assetKeys).size) {
      throw new HTTPException(400, { message: "One or more uploaded assets are unavailable" });
    }
  }

  const current = await c.env.DB.prepare(
    "SELECT status, location, pinned, updated_at FROM samples WHERE id = ?",
  ).bind(sampleId).first<{ status: SampleStatus; location: string | null; pinned: number; updated_at: string }>();
  if (!current) throw new HTTPException(404, { message: "Sample not found" });
  if (current.updated_at !== input.expectedUpdatedAt) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Review the current state and save again." });
  }
  const location = input.location.trim() || null;
  const detailsChanged = current.status !== input.status || current.location !== location || Boolean(current.pinned) !== input.pinned;
  if (!detailsChanged && !body && !assetKey) throw new HTTPException(400, { message: "The record has no changes" });

  const mutationId = crypto.randomUUID();
  const now = new Date(Math.max(Date.now(), Date.parse(input.expectedUpdatedAt) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const statements = [c.env.DB.prepare(
    `UPDATE samples SET status = ?, location = ?, pinned = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
     WHERE id = ? AND updated_at = ?`,
  ).bind(input.status, location, input.pinned ? 1 : 0, userEmail, mutationId, now, sampleId, input.expectedUpdatedAt)];
  if (body || assetKey) statements.push(c.env.DB.prepare(
    `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
     SELECT ?, id, ?, ?, ?, ?, ?, ? FROM samples WHERE id = ? AND last_mutation_id = ?`,
  ).bind(
    crypto.randomUUID(), assetKey ? "image" : "comment", body, assetKey,
    JSON.stringify(thumbnailKey ? { thumbnailKey } : {}), userEmail, now, sampleId, mutationId,
  ));
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "This sample changed elsewhere. Review the current state and save again." });
  if (statements.length > 1 && !results[1].meta.changes) throw new Error("Atomic record event was not created");
  return c.json({ ok: true, updatedAt: now }, 201);
});

app.post("/samples/:id/runs", async (c) => {
  const sampleId = c.req.param("id");
  const { templateVersionId } = await c.req.json<{ templateVersionId?: string }>();
  if (!templateVersionId) throw new HTTPException(400, { message: "Template version is required" });
  const [sample, template, templateStepRows, templateAssetRows] = await Promise.all([
    c.env.DB.prepare("SELECT code FROM samples WHERE id = ?").bind(sampleId).first<{ code: string }>(),
    c.env.DB.prepare(
      `SELECT tv.name, tv.template_type, tv.version, tv.content_json
       FROM template_versions tv WHERE tv.id = ? AND tv.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.template_version_id = tv.id AND i.status != 'ready')`,
    ).bind(templateVersionId).first<{ name: string; template_type: "process" | "module" | "recipe"; version: number; content_json: string }>(),
    c.env.DB.prepare(
      `SELECT id, position, name, tool_name, parameters_text, comments_text
       FROM template_steps WHERE template_version_id = ? ORDER BY position`,
    ).bind(templateVersionId).all<{ id: string; position: number; name: string; tool_name: string | null; parameters_text: string | null; comments_text: string | null }>(),
    c.env.DB.prepare(
      `SELECT tsa.template_step_id, tsa.asset_id
       FROM template_step_assets tsa JOIN assets a ON a.id = tsa.asset_id AND a.status = 'ready'
       JOIN template_steps ts ON ts.id = tsa.template_step_id
       WHERE ts.template_version_id = ? ORDER BY tsa.template_step_id, a.created_at, a.id`,
    ).bind(templateVersionId).all<{ template_step_id: string; asset_id: string }>(),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  if (!template) throw new HTTPException(404, { message: "Template version not found" });
  const steps = templateStepRows.results.length ? templateStepRows.results : templateStepsFromContent(JSON.parse(template.content_json)).map((step, index) => ({
    id: `snapshot-${index}`,
    position: step.position,
    name: step.title,
    tool_name: null,
    parameters_text: null,
    comments_text: null,
  }));
  if (!steps.length) throw new HTTPException(422, { message: "This template has no mapped steps. Re-import it with a step column." });

  const runId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const stepIds = new Map(steps.map((step) => [step.id, crypto.randomUUID()]));
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO runs
        (id, sample_id, template_version_id, template_name_snapshot, template_type_snapshot,
         template_version_snapshot, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(runId, sampleId, templateVersionId, template.name, template.template_type, template.version, userEmail, now),
    ...bulkInsertStatements(c.env.DB, "run_steps",
      ["id", "run_id", "position", "title", "template_step_id", "origin", "planned_title", "planned_tool_name", "planned_parameters_text", "planned_comments_text", "tool_name", "parameters_text", "comments_text", "created_at", "updated_by", "updated_at"],
      steps.map((step, index) => [stepIds.get(step.id), runId, (index + 1) * 1000, step.name, step.id.startsWith("snapshot-") ? null : step.id, "template", step.name, step.tool_name, step.parameters_text, step.comments_text, step.tool_name, step.parameters_text, step.comments_text, now, userEmail, now])),
    ...bulkInsertStatements(c.env.DB, "run_step_assets",
      ["id", "run_step_id", "asset_id", "role", "position", "actor_email", "created_at"],
      templateAssetRows.results.map((asset, index) => [crypto.randomUUID(), stepIds.get(asset.template_step_id), asset.asset_id, "planned", index, userEmail, now]).filter((row) => row[1])),
    c.env.DB.prepare(
      "INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at) VALUES (?, ?, 'step', ?, ?, ?, ?)",
    ).bind(eventId, sampleId, `Assigned ${template.name} v${template.version} (${steps.length} planned steps)`, JSON.stringify({ runId, templateVersionId, templateVersion: template.version }), userEmail, now),
    c.env.DB.prepare("UPDATE samples SET updated_by = ?, updated_at = ? WHERE id = ?").bind(userEmail, now, sampleId),
  ];
  if (statements.length > 49) throw new HTTPException(413, { message: "This template is too large to assign on the current plan" });
  try { await c.env.DB.batch(statements); }
  catch (error) {
    if (String(error).includes("template version archived")) throw new HTTPException(409, { message: "This template was archived before assignment completed" });
    throw error;
  }
  return c.json({ id: runId }, 201);
});

app.patch("/samples/:sampleId/runs/:runId/steps/:stepId", async (c) => {
  const { sampleId, runId, stepId } = c.req.param();
  const input = await c.req.json<UpdateRunStepInput>();
  const allowed: StepStatus[] = ["pending", "in_progress", "done", "skipped", "blocked"];
  if (!input.status || !allowed.includes(input.status) || typeof input.expectedUpdatedAt !== "string" || typeof input.title !== "string" || typeof input.toolName !== "string" || typeof input.parametersText !== "string" || typeof input.commentsText !== "string" || typeof input.deviationNote !== "string" || typeof input.notes !== "string" || (input.assetKey !== undefined && typeof input.assetKey !== "string")) throw new HTTPException(400, { message: "Valid editable step fields and expectedUpdatedAt are required" });
  const title = input.title.trim();
  if (!title) throw new HTTPException(400, { message: "Step title is required" });
  if (title.length > 200 || input.toolName.length > 500 || input.parametersText.length > 10_000 || input.commentsText.length > 10_000 || input.deviationNote.length > 4_000 || input.notes.length > 10_000) throw new HTTPException(400, { message: "One or more step fields are too long" });
  const asset = input.assetKey ? await c.env.DB.prepare("SELECT id, r2_key FROM assets WHERE status = 'ready' AND r2_key = ?").bind(input.assetKey).first<{ id: string; r2_key: string }>() : null;
  if (input.assetKey && !asset) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const step = await c.env.DB.prepare(
    `SELECT rs.title, rs.status, rs.notes, rs.tool_name, rs.parameters_text, rs.comments_text,
            rs.deviation_note, rs.origin, rs.updated_at
     FROM run_steps rs JOIN runs r ON r.id = rs.run_id
     WHERE rs.id = ? AND r.id = ? AND r.sample_id = ?`,
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
  const mutationId = crypto.randomUUID();
  const statements = [
    c.env.DB.prepare(
      `UPDATE run_steps SET status = ?, title = ?, tool_name = ?, parameters_text = ?, comments_text = ?,
       deviation_note = ?, notes = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND updated_at = ?`,
    ).bind(input.status, title, toolName, parametersText, commentsText, deviationNote, notes, userEmail, mutationId, now, stepId, input.expectedUpdatedAt),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, r.sample_id, 'step', ?, ?, ?, ? FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?`,
    ).bind(crypto.randomUUID(), `${title}: ${input.status.replace("_", " ")}${deviationNote ? ` — deviation: ${deviationNote}` : notes ? ` — ${notes}` : ""}`, JSON.stringify({
      runId, stepId, action: "updated", origin: step.origin,
      previous: { title: step.title, status: step.status, toolName: step.tool_name, parametersText: step.parameters_text, commentsText: step.comments_text, deviationNote: step.deviation_note, notes: step.notes },
      current: { title, status: input.status, toolName, parametersText, commentsText, deviationNote, notes },
    }), userEmail, now, stepId, runId, sampleId, mutationId),
  ];
  if (asset) statements.push(c.env.DB.prepare(
    `INSERT OR IGNORE INTO run_step_assets (id, run_step_id, asset_id, role, position, actor_email, created_at)
     SELECT ?, ?, ?, 'execution',
            COALESCE((SELECT MAX(position) FROM run_step_assets WHERE run_step_id = ? AND role = 'execution'), -1) + 1,
            ?, ?
     WHERE EXISTS (
       SELECT 1 FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?
     )`,
  ).bind(crypto.randomUUID(), stepId, asset.id, stepId, userEmail, now, stepId, runId, sampleId, mutationId));
  if (asset) statements.push(c.env.DB.prepare(
    `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
     SELECT ?, r.sample_id, 'image', ?, ?, ?, ?, ? FROM run_steps rs JOIN runs r ON r.id = rs.run_id
     WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?`,
  ).bind(crypto.randomUUID(), `Execution diagram for step: ${title}`, asset.r2_key, JSON.stringify({ runId, stepId }), userEmail, now, stepId, runId, sampleId, mutationId));
  statements.push(c.env.DB.prepare(
    `UPDATE samples SET updated_by = ?, updated_at = ? WHERE id = ? AND EXISTS (
       SELECT 1 FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?
     )`,
  ).bind(userEmail, now, sampleId, stepId, runId, sampleId, mutationId));
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "This step changed elsewhere. Reload before saving." });
  if (!results[1].meta.changes || !results[results.length - 1].meta.changes) throw new Error("Atomic step record was not completed");
  return c.json({ ok: true });
});

app.post("/samples/:sampleId/runs/:runId/steps", async (c) => {
  const { sampleId, runId } = c.req.param();
  const input = await c.req.json<CreateRunStepInput>();
  if (typeof input.title !== "string" || typeof input.toolName !== "string" || typeof input.parametersText !== "string" || typeof input.commentsText !== "string" || typeof input.deviationNote !== "string" || (input.afterStepId !== undefined && typeof input.afterStepId !== "string") || (input.assetKey !== undefined && typeof input.assetKey !== "string")) throw new HTTPException(400, { message: "Valid ad hoc step fields are required" });
  const title = input.title.trim();
  if (!title) throw new HTTPException(400, { message: "Step title is required" });
  if (title.length > 200 || input.toolName.length > 500 || input.parametersText.length > 10_000 || input.commentsText.length > 10_000 || input.deviationNote.length > 4_000) throw new HTTPException(400, { message: "One or more step fields are too long" });
  const [run, stepRows, asset] = await Promise.all([
    c.env.DB.prepare("SELECT id FROM runs WHERE id = ? AND sample_id = ? AND status != 'cancelled'").bind(runId, sampleId).first<{ id: string }>(),
    c.env.DB.prepare("SELECT id, position FROM run_steps WHERE run_id = ? ORDER BY position").bind(runId).all<{ id: string; position: number }>(),
    input.assetKey ? c.env.DB.prepare("SELECT id, r2_key FROM assets WHERE status = 'ready' AND r2_key = ?").bind(input.assetKey).first<{ id: string; r2_key: string }>() : Promise.resolve(null),
  ]);
  if (!run) throw new HTTPException(404, { message: "Sample run not found" });
  if (input.assetKey && !asset) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const position = insertionPosition(stepRows.results, input.afterStepId);
  if (position === null) throw new HTTPException(404, { message: "Insertion point not found" });
  const stepId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO run_steps
        (id, run_id, position, title, status, origin, tool_name, parameters_text, comments_text,
         deviation_note, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 'ad_hoc', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(stepId, runId, position, title, input.toolName.trim() || null, input.parametersText.trim() || null, input.commentsText.trim() || null, input.deviationNote.trim() || null, now, userEmail, now),
  ];
  if (asset) statements.push(c.env.DB.prepare(
    "INSERT INTO run_step_assets (id, run_step_id, asset_id, role, position, actor_email, created_at) VALUES (?, ?, ?, 'execution', 0, ?, ?)",
  ).bind(crypto.randomUUID(), stepId, asset.id, userEmail, now));
  statements.push(
    c.env.DB.prepare("UPDATE runs SET status = 'active', completed_at = NULL WHERE id = ? AND sample_id = ?").bind(runId, sampleId),
    c.env.DB.prepare(
      "INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at) VALUES (?, ?, 'step', ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), sampleId, `Added ad hoc step: ${title}`, JSON.stringify({ runId, stepId, action: "added", afterStepId: input.afterStepId ?? null, deviationNote: input.deviationNote.trim() || null }), userEmail, now),
    c.env.DB.prepare("UPDATE samples SET updated_by = ?, updated_at = ? WHERE id = ?").bind(userEmail, now, sampleId),
  );
  await c.env.DB.batch(statements);
  return c.json({ id: stepId }, 201);
});

app.post("/samples/:sampleId/runs/:runId/promote", async (c) => {
  const { sampleId, runId } = c.req.param();
  const [run, stepRows, assetRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.template_name_snapshot AS name, r.template_type_snapshot AS template_type,
              r.template_version_snapshot AS source_version, s.code AS sample_code
       FROM runs r JOIN samples s ON s.id = r.sample_id
       WHERE r.id = ? AND r.sample_id = ? AND r.status != 'cancelled'`,
    ).bind(runId, sampleId).first<{ name: string; template_type: "process" | "module" | "recipe"; source_version: number; sample_code: string }>(),
    c.env.DB.prepare(
      `SELECT id, origin, title, tool_name, parameters_text, comments_text, deviation_note, position
       FROM run_steps WHERE run_id = ? ORDER BY position`,
    ).bind(runId).all<{ id: string; origin: "template" | "ad_hoc"; title: string; tool_name: string | null; parameters_text: string | null; comments_text: string | null; deviation_note: string | null; position: number }>(),
    c.env.DB.prepare(
      `SELECT rsa.run_step_id, rsa.asset_id
       FROM run_step_assets rsa
       JOIN assets a ON a.id = rsa.asset_id AND a.status = 'ready'
       JOIN run_steps rs ON rs.id = rsa.run_step_id
       WHERE rs.run_id = ?
       ORDER BY rs.position, rsa.role, rsa.position, rsa.created_at`,
    ).bind(runId).all<{ run_step_id: string; asset_id: string }>(),
  ]);
  if (!run) throw new HTTPException(404, { message: "Sample run not found" });
  if (!run.name || !["process", "module", "recipe"].includes(run.template_type)) throw new HTTPException(422, { message: "This older run does not contain a usable template snapshot" });
  if (!stepRows.results.length) throw new HTTPException(422, { message: "A run without steps cannot become a template" });

  const latest = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM template_versions WHERE name = ? AND template_type = ?",
  ).bind(run.name, run.template_type).first<{ version: number }>();
  const id = crypto.randomUUID();
  const version = Number(latest?.version ?? 0) + 1;
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const stepIds = new Map(stepRows.results.map((step) => [step.id, crypto.randomUUID()]));
  const uniqueAssets = new Map<string, { stepId: string; assetId: string }>();
  for (const asset of assetRows.results) {
    const stepId = stepIds.get(asset.run_step_id);
    if (stepId) uniqueAssets.set(`${stepId}:${asset.asset_id}`, { stepId, assetId: asset.asset_id });
  }
  const provenance = {
    schemaVersion: 1,
    source: "sample_run",
    sampleId,
    sampleCode: run.sample_code,
    runId,
    assignedTemplateVersion: run.source_version,
    promotedAt: now,
  };
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO template_versions
        (id, name, template_type, version, content_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, run.name, run.template_type, version, JSON.stringify(provenance), userEmail, now),
    ...bulkInsertStatements(c.env.DB, "template_steps",
      ["id", "template_version_id", "position", "name", "tool_name", "parameters_text", "comments_text", "raw_json"],
      stepRows.results.map((step, index) => [
        stepIds.get(step.id), id, index, step.title, step.tool_name, step.parameters_text, step.comments_text,
        JSON.stringify({ source: "sample_run", runStepId: step.id, origin: step.origin, deviationNote: step.deviation_note }),
      ])),
    ...bulkInsertStatements(c.env.DB, "template_step_assets", ["template_step_id", "asset_id"],
      [...uniqueAssets.values()].map((asset) => [asset.stepId, asset.assetId])),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       VALUES (?, ?, 'step', ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), sampleId, `Saved actual run as ${run.name} v${version}`, JSON.stringify({ runId, templateVersionId: id, action: "promoted" }), userEmail, now),
    c.env.DB.prepare("UPDATE samples SET updated_by = ?, updated_at = ? WHERE id = ?").bind(userEmail, now, sampleId),
  ];
  if (statements.length > 49) throw new HTTPException(413, { message: "This run is too large to convert on the current plan" });
  try { await c.env.DB.batch(statements); }
  catch (error) {
    if (String(error).includes("UNIQUE")) throw new HTTPException(409, { message: "Another template version was created at the same time. Try again." });
    throw error;
  }
  return c.json({ id, version }, 201);
});

app.post("/assets", async (c) => {
  if (!contentLengthWithin(c.req.raw, 10 * 1024 * 1024)) throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
  const contentType = c.req.header("content-type") || "application/octet-stream";
  if (!contentType.toLowerCase().startsWith("image/")) throw new HTTPException(415, { message: "Ordinary asset uploads must be images" });
  const filename = c.req.header("x-filename") || "upload";
  if (filename.length > 255 || contentType.length > 200) throw new HTTPException(400, { message: "Asset metadata is too long" });
  const buffer = await c.req.arrayBuffer();
  if (buffer.byteLength > 10 * 1024 * 1024) throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
  const sha256 = await digestSha256(buffer);
  const existing = await c.env.DB.prepare(
    "SELECT id, r2_key FROM assets WHERE sha256 = ? AND status = 'ready' LIMIT 1",
  ).bind(sha256).first<{ id: string; r2_key: string }>();
  if (existing) return c.json({ id: existing.id, key: existing.r2_key, deduplicated: true });

  const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.ASSETS.put(key, buffer, { httpMetadata: { contentType } });
  try {
    await c.env.DB.prepare(
      `INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, actor_email, created_at, sha256)
       VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
    ).bind(id, key, filename, contentType, buffer.byteLength, c.get("userEmail"), now, sha256).run();
  } catch (error) {
    await c.env.ASSETS.delete(key);
    if (String(error).includes("UNIQUE")) {
      const winner = await c.env.DB.prepare(
        "SELECT id, r2_key FROM assets WHERE sha256 = ? AND status = 'ready' LIMIT 1",
      ).bind(sha256).first<{ id: string; r2_key: string }>();
      if (winner) return c.json({ id: winner.id, key: winner.r2_key, deduplicated: true });
    }
    throw error;
  }
  return c.json({ id, key, deduplicated: false }, 201);
});

app.get("/assets/:key{.+}", async (c) => {
  const object = await c.env.ASSETS.get(c.req.param("key"));
  if (!object) throw new HTTPException(404, { message: "Asset not found" });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=3600");
  headers.set("x-content-type-options", "nosniff");
  if (!headers.get("content-type")?.startsWith("image/")) headers.set("content-disposition", "attachment");
  return new Response(object.body, { headers });
});

app.get("/exports/all", async (c) => {
  const tableQueries = {
    samples: "SELECT * FROM samples ORDER BY created_at, id",
    events: "SELECT * FROM events ORDER BY created_at, id",
    template_versions: "SELECT * FROM template_versions ORDER BY created_at, id",
    template_steps: "SELECT * FROM template_steps ORDER BY template_version_id, position",
    template_step_assets: "SELECT * FROM template_step_assets ORDER BY template_step_id, asset_id",
    runs: "SELECT * FROM runs ORDER BY created_at, id",
    run_steps: "SELECT * FROM run_steps ORDER BY run_id, position",
    run_step_assets: "SELECT * FROM run_step_assets ORDER BY run_step_id, role, position",
    imports: "SELECT * FROM imports ORDER BY created_at, id",
    assets: "SELECT * FROM assets ORDER BY created_at, id",
  } as const;
  const names = Object.keys(tableQueries);
  const results = await c.env.DB.batch(Object.values(tableQueries).map((sql) => c.env.DB.prepare(sql)));
  const entries = names.map((name, index) => [name, results[index].results ?? []] as const);
  const tables = Object.fromEntries(entries) as Record<string, Array<Record<string, unknown>>>;
  return c.json({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    tables,
    assetKeys: collectExportAssetKeys(tables.assets, tables.imports),
  });
});

app.post("/imports/fabublox", async (c) => {
  if (!contentLengthWithin(c.req.raw, 50 * 1024 * 1024)) throw new HTTPException(413, { message: "FabuBlox imports are limited to 50 MB" });
  const form = await c.req.raw.formData();
  const workbook = form.get("workbook");
  const manifestFile = form.get("manifest");
  if (!(workbook instanceof File) || !(manifestFile instanceof File)) throw new HTTPException(400, { message: "Workbook and manifest files are required" });
  let parsedManifest: unknown;
  try { parsedManifest = JSON.parse(await manifestFile.text()); }
  catch { throw new HTTPException(400, { message: "The FabuBlox manifest is not valid JSON" }); }
  if (!parsedManifest || typeof parsedManifest !== "object") throw new HTTPException(400, { message: "Invalid FabuBlox manifest" });
  const manifest = parsedManifest as {
    schemaVersion: number;
    title: string;
    templateType: "process" | "module" | "recipe";
    source: { fileName: string; fileSha256: string; sheetName: string };
    steps: Array<{
      localId: string; sourceRow: number; position: number; stepNumber: string | null;
      sectionName: string | null; name: string; toolName: string | null;
      parametersText: string | null; commentsText: string | null;
      imageIds: string[]; rawCells: Record<string, unknown>;
    }>;
    images: Array<{
      localId: string; sourcePart: string; mimeType: string;
      assignedStepLocalId: string | null;
      anchor: Record<string, unknown>;
    }>;
    warnings: unknown[];
  };
  if (manifest.schemaVersion !== 1 || typeof manifest.title !== "string" || !manifest.title.trim() || manifest.title.length > 200 || typeof manifest.source?.sheetName !== "string" || !manifest.source.sheetName || !Array.isArray(manifest.steps) || !manifest.steps.length || !Array.isArray(manifest.images) || !Array.isArray(manifest.warnings)) {
    throw new HTTPException(400, { message: "Invalid FabuBlox manifest" });
  }
  if (!["process", "module", "recipe"].includes(manifest.templateType)) throw new HTTPException(400, { message: "Invalid template type" });
  if (manifest.steps.length > 180 || manifest.images.length > 40) {
    throw new HTTPException(413, { message: "This import exceeds the 180-step or 40-image deployment limit" });
  }
  for (const image of manifest.images) {
    if (!(form.get(`image:${image.localId}`) instanceof File)) throw new HTTPException(400, { message: `Missing uploaded image ${image.localId}` });
  }
  const payloadBytes = workbook.size + manifestFile.size + manifest.images.reduce((sum, image) => {
    const file = form.get(`image:${image.localId}`);
    return sum + (file instanceof File ? file.size : 0);
  }, 0);
  if (payloadBytes > 50 * 1024 * 1024) throw new HTTPException(413, { message: "FabuBlox imports are limited to 50 MB" });
  const workbookBuffer = await workbook.arrayBuffer();
  const actualSha = await digestSha256(workbookBuffer);
  if (actualSha !== manifest.source.fileSha256) throw new HTTPException(400, { message: "Workbook checksum does not match the preview" });

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const manifestBuffer = manifestBytes.buffer.slice(manifestBytes.byteOffset, manifestBytes.byteOffset + manifestBytes.byteLength) as ArrayBuffer;
  const imageInputs: Array<{
    image: typeof manifest.images[number]; file: File; buffer: ArrayBuffer; sha256: string;
  }> = [];
  for (let index = 0; index < manifest.images.length; index += 5) {
    const prepared = await Promise.all(manifest.images.slice(index, index + 5).map(async (image) => {
      const value = form.get(`image:${image.localId}`);
      if (!(value instanceof File)) throw new HTTPException(400, { message: `Missing uploaded image ${image.localId}` });
      const mimeType = value.type || image.mimeType;
      if (!mimeType.toLowerCase().startsWith("image/")) throw new HTTPException(415, { message: `Imported asset ${image.localId} is not an image` });
      const buffer = await value.arrayBuffer();
      return { image, file: value, buffer, sha256: await digestSha256(buffer) };
    }));
    imageInputs.push(...prepared);
  }

  const importId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  await c.env.DB.prepare(
    `INSERT INTO imports (id, status, source_filename, source_sha256, sheet_name, template_type, warning_count, actor_email, created_at)
     VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(importId, workbook.name, actualSha, manifest.source.sheetName, manifest.templateType, manifest.warnings.length, userEmail, now).run();

  const uploadedKeys: string[] = [];
  try {
    const prefix = `imports/${importId}`;
    type Candidate = {
      kind: "workbook" | "manifest" | "image";
      localId: string;
      originalName: string;
      mimeType: string;
      buffer: ArrayBuffer;
      sha256: string;
      image?: typeof manifest.images[number];
    };
    const candidates: Candidate[] = [
      { kind: "workbook", localId: "workbook", originalName: workbook.name, mimeType: workbook.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: workbookBuffer, sha256: actualSha },
      { kind: "manifest", localId: "manifest", originalName: "manifest.json", mimeType: "application/json", buffer: manifestBuffer, sha256: await digestSha256(manifestBuffer) },
      ...imageInputs.map(({ image, file, buffer, sha256 }) => ({ kind: "image" as const, localId: image.localId, originalName: file.name, mimeType: file.type || image.mimeType, buffer, sha256, image })),
    ];
    const hashes = [...new Set(candidates.map((candidate) => candidate.sha256))];
    const placeholders = hashes.map(() => "?").join(", ");
    const existingRows = await c.env.DB.prepare(
      `SELECT id, r2_key, sha256 FROM assets WHERE status = 'ready' AND sha256 IN (${placeholders})`,
    ).bind(...hashes).all<{ id: string; r2_key: string; sha256: string }>();
    const existingByHash = new Map<string, { assetId: string; key: string }>(
      existingRows.results.map((asset) => [asset.sha256, { assetId: asset.id, key: asset.r2_key }]),
    );
    const resolved = resolveAssetReferences(candidates, existingByHash, (candidate) => {
      const suffix = candidate.kind === "workbook" ? `source/${safeObjectName(candidate.originalName)}`
        : candidate.kind === "manifest" ? "manifest.json"
          : `images/${candidate.localId}-${safeObjectName(candidate.originalName)}`;
      return { assetId: crypto.randomUUID(), key: `${prefix}/${suffix}` };
    });
    const newAssets = [...new Map(resolved.filter((asset) => asset.isNew).map((asset) => [asset.assetId, asset])).values()];
    for (let index = 0; index < newAssets.length; index += 5) {
      const uploadResults = await Promise.allSettled(newAssets.slice(index, index + 5).map(async (asset) => {
        await c.env.ASSETS.put(asset.key, asset.buffer, { httpMetadata: { contentType: asset.mimeType } });
        uploadedKeys.push(asset.key);
      }));
      const failedUpload = uploadResults.find((result) => result.status === "rejected");
      if (failedUpload?.status === "rejected") throw failedUpload.reason;
    }
    const workbookAsset = resolved.find((asset) => asset.kind === "workbook")!;
    const manifestAsset = resolved.find((asset) => asset.kind === "manifest")!;
    const imageAssets = resolved.filter((asset) => asset.kind === "image");
    const linkRows = new Map<string, [string, string]>();

    const latest = await c.env.DB.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM template_versions WHERE name = ? AND template_type = ?",
    ).bind(manifest.title.trim(), manifest.templateType).first<{ version: number }>();
    const version = (latest?.version ?? 0) + 1;
    const templateVersionId = crypto.randomUUID();
    const stepIds = new Map(manifest.steps.map((step) => [step.localId, crypto.randomUUID()]));
    for (const asset of imageAssets) {
      const stepId = asset.image?.assignedStepLocalId ? stepIds.get(asset.image.assignedStepLocalId) : null;
      if (stepId) linkRows.set(`${stepId}:${asset.assetId}`, [stepId, asset.assetId]);
    }
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `INSERT INTO template_versions
          (id, name, template_type, version, source_filename, source_asset_key, content_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(templateVersionId, manifest.title.trim(), manifest.templateType, version, workbook.name, workbookAsset.key, JSON.stringify(manifest), userEmail, now),
      ...bulkInsertStatements(c.env.DB, "template_steps",
        ["id", "template_version_id", "position", "source_row", "step_number", "section_name", "name", "tool_name", "parameters_text", "comments_text", "raw_json"],
        manifest.steps.map((step) => [stepIds.get(step.localId), templateVersionId, step.position, step.sourceRow, step.stepNumber, step.sectionName, step.name, step.toolName, step.parametersText, step.commentsText, JSON.stringify(step.rawCells)])),
      ...bulkInsertStatements(c.env.DB, "assets",
        ["id", "import_id", "r2_key", "original_name", "mime_type", "byte_size", "status", "actor_email", "created_at", "sha256"],
        newAssets.map((asset) => [asset.assetId, importId, asset.key, asset.originalName, asset.mimeType, asset.buffer.byteLength, "ready", userEmail, now, asset.sha256])),
      ...bulkInsertStatements(c.env.DB, "template_step_assets", ["template_step_id", "asset_id"],
        [...linkRows.values()]),
      c.env.DB.prepare(
        `UPDATE imports SET status = 'ready', template_version_id = ?, workbook_asset_key = ?, manifest_asset_key = ?, completed_at = ?
         WHERE id = ? AND status = 'pending'`,
      ).bind(templateVersionId, workbookAsset.key, manifestAsset.key, new Date().toISOString(), importId),
    ];
    if (statements.length > 49) throw new Error("Import would exceed the D1 Free query limit");
    await c.env.DB.batch(statements);
    return c.json({ id: importId, templateVersionId, version }, 201);
  } catch (error) {
    const cleanupFailures = await deleteR2KeysInBatches(c.env.ASSETS, uploadedKeys);
    if (cleanupFailures.length) console.error("Could not clean every failed import object", cleanupFailures);
    await c.env.DB.prepare("UPDATE imports SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?")
      .bind(String(error), new Date().toISOString(), importId).run();
    throw error;
  }
});

app.get("/templates", async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT tv.id, tv.name, tv.template_type, tv.version, tv.source_filename, tv.created_at,
            tv.locked_at, tv.archived_at,
            (SELECT COUNT(*) FROM template_steps ts WHERE ts.template_version_id = tv.id) AS step_count
     FROM template_versions tv
     WHERE tv.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.template_version_id = tv.id AND i.status != 'ready')
     ORDER BY tv.name, tv.template_type, tv.version DESC`,
  ).all<{
    id: string;
    name: string;
    template_type: "process" | "module" | "recipe";
    version: number;
    source_filename: string | null;
    created_at: string;
    locked_at: string | null;
    archived_at: string | null;
    step_count: number;
  }>();
  return c.json({ templates: result.results.map((row) => ({
    id: row.id,
    name: row.name,
    templateType: row.template_type,
    version: row.version,
    sourceFilename: row.source_filename,
    stepCount: Number(row.step_count),
    locked: Boolean(row.locked_at),
    lockedAt: row.locked_at,
    createdAt: row.created_at,
  })) });
});

app.post("/templates/:id/clone", async (c) => {
  const sourceId = c.req.param("id");
  const [source, steps, assetRows] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM template_versions WHERE id = ?").bind(sourceId).first<Record<string, unknown>>(),
    c.env.DB.prepare("SELECT * FROM template_steps WHERE template_version_id = ? ORDER BY position").bind(sourceId).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT tsa.template_step_id, tsa.asset_id FROM template_step_assets tsa
       JOIN template_steps ts ON ts.id = tsa.template_step_id WHERE ts.template_version_id = ?`,
    ).bind(sourceId).all<{ template_step_id: string; asset_id: string }>(),
  ]);
  if (!source) throw new HTTPException(404, { message: "Template version not found" });
  const latest = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM template_versions WHERE name = ? AND template_type = ?",
  ).bind(source.name, source.template_type).first<{ version: number }>();
  const id = crypto.randomUUID();
  const version = Number(latest?.version ?? 0) + 1;
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  const stepIds = new Map(steps.results.map((step) => [String(step.id), crypto.randomUUID()]));
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO template_versions
        (id, name, template_type, version, source_filename, source_asset_key, content_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, source.name, source.template_type, version, source.source_filename, source.source_asset_key, source.content_json, userEmail, now),
    ...bulkInsertStatements(c.env.DB, "template_steps",
      ["id", "template_version_id", "position", "source_row", "step_number", "section_name", "name", "tool_name", "parameters_text", "comments_text", "raw_json"],
      steps.results.map((step) => [stepIds.get(String(step.id)), id, step.position, step.source_row, step.step_number, step.section_name, step.name, step.tool_name, step.parameters_text, step.comments_text, step.raw_json])),
    ...bulkInsertStatements(c.env.DB, "template_step_assets", ["template_step_id", "asset_id"],
      assetRows.results.map((asset) => [stepIds.get(asset.template_step_id), asset.asset_id])),
  ];
  if (statements.length > 49) throw new HTTPException(413, { message: "This template is too large to clone on the current plan" });
  await c.env.DB.batch(statements);
  return c.json({ id, version }, 201);
});

app.get("/templates/:id", async (c) => {
  const id = c.req.param("id");
  const [template, stepRows, assetRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, name, template_type, version, source_filename, locked_at, archived_at, created_at
       FROM template_versions WHERE id = ?`,
    ).bind(id).first<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT id, position, source_row, step_number, section_name, name, tool_name, parameters_text, comments_text
       FROM template_steps WHERE template_version_id = ? ORDER BY position`,
    ).bind(id).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT tsa.template_step_id, a.r2_key FROM template_step_assets tsa
       JOIN assets a ON a.id = tsa.asset_id AND a.status = 'ready'
       JOIN template_steps ts ON ts.id = tsa.template_step_id
       WHERE ts.template_version_id = ? ORDER BY tsa.template_step_id, a.created_at, a.id`,
    ).bind(id).all<{ template_step_id: string; r2_key: string }>(),
  ]);
  if (!template) throw new HTTPException(404, { message: "Template version not found" });
  const images = new Map<string, string[]>();
  for (const row of assetRows.results) images.set(row.template_step_id, [...(images.get(row.template_step_id) ?? []), row.r2_key]);
  return c.json({ template: {
    id: String(template.id), name: String(template.name), templateType: String(template.template_type), version: Number(template.version),
    sourceFilename: template.source_filename ? String(template.source_filename) : null,
    locked: Boolean(template.locked_at), lockedAt: template.locked_at ? String(template.locked_at) : null,
    archived: Boolean(template.archived_at), createdAt: String(template.created_at),
    steps: stepRows.results.map((step) => ({
      id: String(step.id), position: Number(step.position), sourceRow: step.source_row === null ? null : Number(step.source_row),
      stepNumber: step.step_number ? String(step.step_number) : null, sectionName: step.section_name ? String(step.section_name) : null,
      name: String(step.name), toolName: step.tool_name ? String(step.tool_name) : null,
      parametersText: step.parameters_text ? String(step.parameters_text) : null,
      commentsText: step.comments_text ? String(step.comments_text) : null,
      imageKeys: images.get(String(step.id)) ?? [],
    })),
  } });
});

app.patch("/templates/:id", async (c) => {
  const id = c.req.param("id");
  const input = await c.req.json<{ name?: string; version?: number }>();
  if (typeof input.name !== "string" || typeof input.version !== "number" || !Number.isInteger(input.version) || input.version < 1) throw new HTTPException(400, { message: "A template name and positive integer version are required" });
  const name = input.name.trim();
  if (!name || name.length > 200) throw new HTTPException(400, { message: "Template name is required and must be at most 200 characters" });
  const current = await c.env.DB.prepare("SELECT locked_at, archived_at FROM template_versions WHERE id = ?").bind(id).first<{ locked_at: string | null; archived_at: string | null }>();
  if (!current) throw new HTTPException(404, { message: "Template version not found" });
  if (current.archived_at) throw new HTTPException(409, { message: "Archived templates cannot be edited" });
  if (current.locked_at) throw new HTTPException(409, { message: "This template was assigned and is now locked. Clone it to create an editable version." });
  try {
    const result = await c.env.DB.prepare("UPDATE template_versions SET name = ?, version = ? WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL").bind(name, input.version, id).run();
    if (!result.meta.changes) throw new HTTPException(409, { message: "This template was assigned while you were editing it. Clone it to continue." });
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HTTPException(409, { message: `Version ${input.version} already exists for this template` });
    throw error;
  }
  return c.json({ ok: true });
});

app.post("/templates/:id/steps", async (c) => {
  const templateId = c.req.param("id");
  const input = await c.req.json<{ name?: string; toolName?: string; parametersText?: string; commentsText?: string; assetKey?: string }>();
  if (typeof input.name !== "string" || typeof input.toolName !== "string" || typeof input.parametersText !== "string" || typeof input.commentsText !== "string" || (input.assetKey !== undefined && typeof input.assetKey !== "string")) throw new HTTPException(400, { message: "Valid template step fields are required" });
  const name = input.name.trim();
  if (!name || name.length > 200 || input.toolName.length > 500 || input.parametersText.length > 10_000 || input.commentsText.length > 10_000) throw new HTTPException(400, { message: "One or more template step fields are invalid" });
  const [template, last, asset] = await Promise.all([
    c.env.DB.prepare("SELECT locked_at, archived_at FROM template_versions WHERE id = ?").bind(templateId).first<{ locked_at: string | null; archived_at: string | null }>(),
    c.env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS position FROM template_steps WHERE template_version_id = ?").bind(templateId).first<{ position: number }>(),
    input.assetKey ? c.env.DB.prepare("SELECT id FROM assets WHERE status = 'ready' AND r2_key = ?").bind(input.assetKey).first<{ id: string }>() : Promise.resolve(null),
  ]);
  if (!template) throw new HTTPException(404, { message: "Template version not found" });
  if (template.archived_at || template.locked_at) throw new HTTPException(409, { message: "Only unused active template versions can be edited" });
  if (input.assetKey && !asset) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const stepId = crypto.randomUUID();
  const statements = [c.env.DB.prepare(
    `INSERT INTO template_steps (id, template_version_id, position, name, tool_name, parameters_text, comments_text)
     SELECT ?, id, ?, ?, ?, ?, ? FROM template_versions
     WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL`,
  ).bind(stepId, Number(last?.position ?? -1) + 1, name, input.toolName.trim() || null, input.parametersText.trim() || null, input.commentsText.trim() || null, templateId)];
  if (asset) statements.push(c.env.DB.prepare("INSERT INTO template_step_assets (template_step_id, asset_id) VALUES (?, ?)").bind(stepId, asset.id));
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "This template was assigned while you were editing it. Clone it to continue." });
  return c.json({ id: stepId }, 201);
});

app.patch("/templates/:templateId/steps/:stepId", async (c) => {
  const { templateId, stepId } = c.req.param();
  const input = await c.req.json<{ name?: string; toolName?: string; parametersText?: string; commentsText?: string; assetKey?: string }>();
  if (typeof input.name !== "string" || typeof input.toolName !== "string" || typeof input.parametersText !== "string" || typeof input.commentsText !== "string" || (input.assetKey !== undefined && typeof input.assetKey !== "string")) throw new HTTPException(400, { message: "Valid template step fields are required" });
  const name = input.name.trim();
  if (!name || name.length > 200 || input.toolName.length > 500 || input.parametersText.length > 10_000 || input.commentsText.length > 10_000) throw new HTTPException(400, { message: "One or more template step fields are invalid" });
  const [template, step, asset] = await Promise.all([
    c.env.DB.prepare("SELECT locked_at, archived_at FROM template_versions WHERE id = ?").bind(templateId).first<{ locked_at: string | null; archived_at: string | null }>(),
    c.env.DB.prepare("SELECT id FROM template_steps WHERE id = ? AND template_version_id = ?").bind(stepId, templateId).first<{ id: string }>(),
    input.assetKey ? c.env.DB.prepare("SELECT id FROM assets WHERE status = 'ready' AND r2_key = ?").bind(input.assetKey).first<{ id: string }>() : Promise.resolve(null),
  ]);
  if (!template || !step) throw new HTTPException(404, { message: "Template step not found" });
  if (template.archived_at || template.locked_at) throw new HTTPException(409, { message: "Only unused active template versions can be edited" });
  if (input.assetKey && !asset) throw new HTTPException(400, { message: "The uploaded diagram is unavailable" });
  const statements = [c.env.DB.prepare(
    `UPDATE template_steps SET name = ?, tool_name = ?, parameters_text = ?, comments_text = ?
     WHERE id = ? AND template_version_id = ? AND EXISTS (
       SELECT 1 FROM template_versions WHERE id = ? AND locked_at IS NULL AND archived_at IS NULL
     )`,
  ).bind(name, input.toolName.trim() || null, input.parametersText.trim() || null, input.commentsText.trim() || null, stepId, templateId, templateId)];
  if (asset) statements.push(c.env.DB.prepare(
    `INSERT OR IGNORE INTO template_step_assets (template_step_id, asset_id)
     SELECT ?, ? WHERE EXISTS (
       SELECT 1 FROM template_steps ts JOIN template_versions tv ON tv.id = ts.template_version_id
       WHERE ts.id = ? AND ts.template_version_id = ? AND tv.locked_at IS NULL AND tv.archived_at IS NULL
     )`,
  ).bind(stepId, asset.id, stepId, templateId));
  const results = await c.env.DB.batch(statements);
  if (!results[0].meta.changes) throw new HTTPException(409, { message: "This template was assigned while you were editing it. Clone it to continue." });
  return c.json({ ok: true });
});

app.delete("/templates/:id", async (c) => {
  const id = c.req.param("id");
  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(
    "UPDATE template_versions SET archived_at = ?, archived_by = ? WHERE id = ? AND archived_at IS NULL",
  ).bind(now, c.get("userEmail"), id).run();
  if (!result.meta.changes) throw new HTTPException(404, { message: "Active template version not found" });
  return c.json({ ok: true });
});

export default app;
