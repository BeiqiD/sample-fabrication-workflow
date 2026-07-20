import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { CreateRecordInput, CreateSampleInput, SampleStatus, StepStatus, UpdateRunStepInput, UpdateSampleInput } from "../shared/types";
import { sampleDetail, sampleEvent, sampleSummary } from "./serializers";
import { templateStepsFromContent } from "./template-steps";
import { collectExportAssetKeys } from "./export-data";
import { authenticateRequest } from "./auth";
import { bulkInsertStatements } from "./d1-bulk";
import { contentLengthWithin, escapedLikePattern, sameOriginOrNonBrowser } from "./request-guards";
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
  const [sample, children, events, runRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT s.*, p.id AS p_id, p.code AS p_code, p.title AS p_title
       FROM samples s LEFT JOIN samples p ON p.id = s.parent_id WHERE s.id = ?`,
    ).bind(id).first<Record<string, unknown>>(),
    c.env.DB.prepare("SELECT id, code, title FROM samples WHERE parent_id = ? ORDER BY created_at").bind(id).all(),
    c.env.DB.prepare("SELECT * FROM events WHERE sample_id = ? ORDER BY created_at DESC").bind(id).all(),
    c.env.DB.prepare(
      `SELECT r.id AS run_id, r.template_version_id, r.status AS run_status,
              r.created_at AS run_created_at, r.completed_at,
              tv.name AS template_name, tv.template_type, tv.version AS template_version,
              rs.id AS step_id, rs.position, rs.title AS step_title,
              rs.status AS step_status, rs.notes, rs.updated_at AS step_updated_at,
              ts.tool_name, ts.parameters_text, ts.comments_text AS template_comments_text,
              (SELECT a.r2_key FROM template_step_assets tsa
                JOIN assets a ON a.id = tsa.asset_id
                WHERE tsa.template_step_id = ts.id AND a.status = 'ready' LIMIT 1) AS template_image_key
       FROM runs r
       JOIN template_versions tv ON tv.id = r.template_version_id
       LEFT JOIN run_steps rs ON rs.run_id = r.id
       LEFT JOIN template_steps ts ON ts.id = rs.template_step_id
       WHERE r.sample_id = ?
       ORDER BY r.created_at DESC, rs.position ASC`,
    ).bind(id).all<Record<string, unknown>>(),
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
    if (row.step_id) runs.get(runId)!.steps.push({
      id: String(row.step_id), position: Number(row.position), title: String(row.step_title),
      status: String(row.step_status), notes: row.notes ? String(row.notes) : null,
      toolName: row.tool_name ? String(row.tool_name) : null,
      parametersText: row.parameters_text ? String(row.parameters_text) : null,
      templateCommentsText: row.template_comments_text ? String(row.template_comments_text) : null,
      templateImageKey: row.template_image_key ? String(row.template_image_key) : null,
      updatedAt: String(row.step_updated_at),
    });
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
  const [sample, template, templateStepRows] = await Promise.all([
    c.env.DB.prepare("SELECT code FROM samples WHERE id = ?").bind(sampleId).first<{ code: string }>(),
    c.env.DB.prepare(
      `SELECT tv.name, tv.content_json FROM template_versions tv WHERE tv.id = ?
       AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.template_version_id = tv.id AND i.status != 'ready')`,
    ).bind(templateVersionId).first<{ name: string; content_json: string }>(),
    c.env.DB.prepare("SELECT id, position, name FROM template_steps WHERE template_version_id = ? ORDER BY position").bind(templateVersionId).all<{ id: string; position: number; name: string }>(),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  if (!template) throw new HTTPException(404, { message: "Template version not found" });
  const steps = templateStepRows.results.length
    ? templateStepRows.results.map((step) => ({ position: step.position, title: step.name, templateStepId: step.id }))
    : templateStepsFromContent(JSON.parse(template.content_json)).map((step) => ({ ...step, templateStepId: null }));
  if (!steps.length) throw new HTTPException(422, { message: "This template has no mapped steps. Re-import it with a step column." });

  const runId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();
  const userEmail = c.get("userEmail");
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO runs (id, sample_id, template_version_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)").bind(runId, sampleId, templateVersionId, userEmail, now),
    ...bulkInsertStatements(c.env.DB, "run_steps",
      ["id", "run_id", "position", "title", "template_step_id", "updated_by", "updated_at"],
      steps.map((step) => [crypto.randomUUID(), runId, step.position, step.title, step.templateStepId, userEmail, now])),
    c.env.DB.prepare(
      "INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at) VALUES (?, ?, 'step', ?, ?, ?, ?)",
    ).bind(eventId, sampleId, `Assigned ${template.name} (${steps.length} steps)`, JSON.stringify({ runId, templateVersionId }), userEmail, now),
    c.env.DB.prepare("UPDATE samples SET updated_by = ?, updated_at = ? WHERE id = ?").bind(userEmail, now, sampleId),
  ]);
  return c.json({ id: runId }, 201);
});

app.patch("/samples/:sampleId/runs/:runId/steps/:stepId", async (c) => {
  const { sampleId, runId, stepId } = c.req.param();
  const input = await c.req.json<UpdateRunStepInput>();
  const allowed: StepStatus[] = ["pending", "in_progress", "done", "skipped", "blocked"];
  if (!input.status || !allowed.includes(input.status) || typeof input.expectedUpdatedAt !== "string" || typeof input.notes !== "string" || (input.assetKey !== undefined && typeof input.assetKey !== "string") || (input.thumbnailKey !== undefined && typeof input.thumbnailKey !== "string")) throw new HTTPException(400, { message: "Valid step status, notes, and expectedUpdatedAt are required" });
  if (input.notes.length > 10_000) throw new HTTPException(400, { message: "Step notes are too long" });
  if (input.thumbnailKey && !input.assetKey) throw new HTTPException(400, { message: "A thumbnail requires a primary asset" });
  const assetKeys = [input.assetKey, input.thumbnailKey].filter((key): key is string => Boolean(key));
  if (assetKeys.length) {
    const result = await c.env.DB.prepare(
      `SELECT r2_key FROM assets WHERE status = 'ready' AND r2_key IN (${assetKeys.map(() => "?").join(", ")})`,
    ).bind(...assetKeys).all<{ r2_key: string }>();
    if (new Set(result.results.map((row) => row.r2_key)).size !== new Set(assetKeys).size) throw new HTTPException(400, { message: "One or more uploaded assets are unavailable" });
  }
  const step = await c.env.DB.prepare(
    `SELECT rs.title, rs.updated_at FROM run_steps rs JOIN runs r ON r.id = rs.run_id
     WHERE rs.id = ? AND r.id = ? AND r.sample_id = ?`,
  ).bind(stepId, runId, sampleId).first<{ title: string; updated_at: string }>();
  if (!step) throw new HTTPException(404, { message: "Run step not found" });
  if (step.updated_at !== input.expectedUpdatedAt) throw new HTTPException(409, { message: "This step changed elsewhere. Reload before saving." });
  const now = new Date(Math.max(Date.now(), Date.parse(input.expectedUpdatedAt) + 1)).toISOString();
  const userEmail = c.get("userEmail");
  const notes = input.notes?.trim() || null;
  const mutationId = crypto.randomUUID();
  const statements = [
    c.env.DB.prepare("UPDATE run_steps SET status = ?, notes = ?, updated_by = ?, last_mutation_id = ?, updated_at = ? WHERE id = ? AND updated_at = ?")
      .bind(input.status, notes, userEmail, mutationId, now, stepId, input.expectedUpdatedAt),
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, r.sample_id, 'step', ?, ?, ?, ? FROM run_steps rs JOIN runs r ON r.id = rs.run_id
       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?`,
    ).bind(crypto.randomUUID(), `${step.title}: ${input.status.replace("_", " ")}${notes ? ` — ${notes}` : ""}`, JSON.stringify({ runId, stepId, status: input.status }), userEmail, now, stepId, runId, sampleId, mutationId),
  ];
  if (input.assetKey) statements.push(c.env.DB.prepare(
    `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
     SELECT ?, r.sample_id, 'image', ?, ?, ?, ?, ? FROM run_steps rs JOIN runs r ON r.id = rs.run_id
     WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?`,
  ).bind(crypto.randomUUID(), `Attachment for step: ${step.title}`, input.assetKey, JSON.stringify({ runId, stepId, thumbnailKey: input.thumbnailKey }), userEmail, now, stepId, runId, sampleId, mutationId));
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

app.post("/assets", async (c) => {
  if (!contentLengthWithin(c.req.raw, 10 * 1024 * 1024)) throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
  const contentType = c.req.header("content-type") || "application/octet-stream";
  if (!contentType.toLowerCase().startsWith("image/")) throw new HTTPException(415, { message: "Ordinary asset uploads must be images" });
  const filename = c.req.header("x-filename") || "upload";
  if (filename.length > 255 || contentType.length > 200) throw new HTTPException(400, { message: "Asset metadata is too long" });
  const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const buffer = await c.req.arrayBuffer();
  if (buffer.byteLength > 10 * 1024 * 1024) throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.ASSETS.put(key, buffer, { httpMetadata: { contentType } });
  try {
    await c.env.DB.prepare(
      `INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, actor_email, created_at)
       VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)`,
    ).bind(id, key, filename, contentType, buffer.byteLength, c.get("userEmail"), now).run();
  } catch (error) {
    await c.env.ASSETS.delete(key);
    throw error;
  }
  return c.json({ id, key }, 201);
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
    const workbookKey = `${prefix}/source/${safeObjectName(workbook.name)}`;
    const manifestKey = `${prefix}/manifest.json`;
    await c.env.ASSETS.put(workbookKey, workbookBuffer, { httpMetadata: { contentType: workbook.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
    uploadedKeys.push(workbookKey);
    await c.env.ASSETS.put(manifestKey, JSON.stringify(manifest, null, 2), { httpMetadata: { contentType: "application/json" } });
    uploadedKeys.push(manifestKey);

    const uploadedAssets: Array<{ image: typeof manifest.images[number]; file: File; assetId: string; key: string }> = [];
    for (let index = 0; index < manifest.images.length; index += 5) {
      const uploadResults = await Promise.allSettled(manifest.images.slice(index, index + 5).map(async (image) => {
        const value = form.get(`image:${image.localId}`);
        if (!(value instanceof File)) throw new Error(`Missing uploaded image ${image.localId}`);
        const assetId = crypto.randomUUID();
        const key = `${prefix}/images/${image.localId}-${safeObjectName(value.name)}`;
        await c.env.ASSETS.put(key, await value.arrayBuffer(), { httpMetadata: { contentType: value.type || image.mimeType } });
        uploadedKeys.push(key);
        return { image, file: value, assetId, key };
      }));
      const failedUpload = uploadResults.find((result) => result.status === "rejected");
      for (const result of uploadResults) if (result.status === "fulfilled") uploadedAssets.push(result.value);
      if (failedUpload?.status === "rejected") throw failedUpload.reason;
    }

    const latest = await c.env.DB.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM template_versions WHERE name = ? AND template_type = ?",
    ).bind(manifest.title.trim(), manifest.templateType).first<{ version: number }>();
    const version = (latest?.version ?? 0) + 1;
    const templateVersionId = crypto.randomUUID();
    const stepIds = new Map(manifest.steps.map((step) => [step.localId, crypto.randomUUID()]));
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `INSERT INTO template_versions
          (id, name, template_type, version, source_filename, source_asset_key, content_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(templateVersionId, manifest.title.trim(), manifest.templateType, version, workbook.name, workbookKey, JSON.stringify(manifest), userEmail, now),
      ...bulkInsertStatements(c.env.DB, "template_steps",
        ["id", "template_version_id", "position", "source_row", "step_number", "section_name", "name", "tool_name", "parameters_text", "comments_text", "raw_json"],
        manifest.steps.map((step) => [stepIds.get(step.localId), templateVersionId, step.position, step.sourceRow, step.stepNumber, step.sectionName, step.name, step.toolName, step.parametersText, step.commentsText, JSON.stringify(step.rawCells)])),
      ...bulkInsertStatements(c.env.DB, "assets",
        ["id", "import_id", "r2_key", "original_name", "mime_type", "byte_size", "status", "actor_email", "created_at"],
        uploadedAssets.map(({ assetId, key, file }) => [assetId, importId, key, file.name, file.type || "application/octet-stream", file.size, "ready", userEmail, now])),
      ...bulkInsertStatements(c.env.DB, "template_step_assets", ["template_step_id", "asset_id"],
        uploadedAssets.flatMap(({ image, assetId }) => {
          const stepId = image.assignedStepLocalId ? stepIds.get(image.assignedStepLocalId) : null;
          return stepId ? [[stepId, assetId]] : [];
        })),
      c.env.DB.prepare(
        `UPDATE imports SET status = 'ready', template_version_id = ?, workbook_asset_key = ?, manifest_asset_key = ?, completed_at = ?
         WHERE id = ? AND status = 'pending'`,
      ).bind(templateVersionId, workbookKey, manifestKey, new Date().toISOString(), importId),
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
    `SELECT tv.id, tv.name, tv.template_type, tv.version, tv.source_filename, tv.content_json, tv.created_at
     FROM template_versions tv
     WHERE NOT EXISTS (SELECT 1 FROM imports i WHERE i.template_version_id = tv.id AND i.status != 'ready')
     ORDER BY tv.created_at DESC`,
  ).all<{
    id: string;
    name: string;
    template_type: "process" | "module" | "recipe";
    version: number;
    source_filename: string | null;
    content_json: string;
    created_at: string;
  }>();
  return c.json({ templates: result.results.map((row) => ({
    id: row.id,
    name: row.name,
    templateType: row.template_type,
    version: row.version,
    sourceFilename: row.source_filename,
    stepCount: templateStepsFromContent(JSON.parse(row.content_json)).length,
    createdAt: row.created_at,
  })) });
});

export default app;
