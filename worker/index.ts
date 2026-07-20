import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { CreateEventInput, CreateSampleInput, SampleStatus, StepStatus, UpdateSampleInput } from "../shared/types";
import { sampleDetail, sampleEvent, sampleSummary } from "./serializers";
import { templateStepsFromContent } from "./template-steps";
import { collectExportAssetKeys } from "./export-data";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>().basePath("/api");

async function digestSha256(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeObjectName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function batchInChunks(db: D1Database, statements: D1PreparedStatement[]) {
  for (let index = 0; index < statements.length; index += 50) await db.batch(statements.slice(index, index + 50));
}

app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  console.error(error);
  return c.json({ error: "Unexpected server error" }, 500);
});

app.get("/health", (c) => c.json({ ok: true }));

app.get("/samples", async (c) => {
  const query = c.req.query("q")?.trim() ?? "";
  const pattern = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
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
  const code = input.code?.trim();
  const title = input.title?.trim();
  if (!code || !title) throw new HTTPException(400, { message: "Code and title are required" });

  const id = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO samples (id, code, title, description, location, parent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, code, title, input.description?.trim() || null, input.location?.trim() || null, input.parentId || null, now, now),
      c.env.DB.prepare(
        "INSERT INTO events (id, sample_id, kind, body, created_at) VALUES (?, ?, 'created', ?, ?)",
      ).bind(eventId, id, `Sample ${code} created`, now),
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
  if (!input.expectedUpdatedAt) throw new HTTPException(400, { message: "expectedUpdatedAt is required" });
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
    `UPDATE samples SET status = ?, location = ?, pinned = ?, updated_at = ?
     WHERE id = ? AND updated_at = ?`,
  ).bind(nextStatus, nextLocation, nextPinned ? 1 : 0, now, id, input.expectedUpdatedAt).run();
  if (!result.meta.changes) {
    throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before saving." });
  }
  return c.json({ ok: true, updatedAt: now });
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
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO runs (id, sample_id, template_version_id, created_at) VALUES (?, ?, ?, ?)").bind(runId, sampleId, templateVersionId, now),
    ...steps.map((step) => c.env.DB.prepare(
      "INSERT INTO run_steps (id, run_id, position, title, template_step_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), runId, step.position, step.title, step.templateStepId, now)),
    c.env.DB.prepare(
      "INSERT INTO events (id, sample_id, kind, body, metadata_json, created_at) VALUES (?, ?, 'step', ?, ?, ?)",
    ).bind(eventId, sampleId, `Assigned ${template.name} (${steps.length} steps)`, JSON.stringify({ runId, templateVersionId }), now),
    c.env.DB.prepare("UPDATE samples SET updated_at = ? WHERE id = ?").bind(now, sampleId),
  ]);
  return c.json({ id: runId }, 201);
});

app.patch("/samples/:sampleId/runs/:runId/steps/:stepId", async (c) => {
  const { sampleId, runId, stepId } = c.req.param();
  const input = await c.req.json<{ status?: StepStatus; notes?: string }>();
  const allowed: StepStatus[] = ["pending", "in_progress", "done", "skipped", "blocked"];
  if (!input.status || !allowed.includes(input.status)) throw new HTTPException(400, { message: "Valid step status is required" });
  const step = await c.env.DB.prepare(
    `SELECT rs.title FROM run_steps rs JOIN runs r ON r.id = rs.run_id
     WHERE rs.id = ? AND r.id = ? AND r.sample_id = ?`,
  ).bind(stepId, runId, sampleId).first<{ title: string }>();
  if (!step) throw new HTTPException(404, { message: "Run step not found" });
  const now = new Date().toISOString();
  const notes = input.notes?.trim() || null;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE run_steps SET status = ?, notes = ?, updated_at = ? WHERE id = ?").bind(input.status, notes, now, stepId),
    c.env.DB.prepare(
      "INSERT INTO events (id, sample_id, kind, body, metadata_json, created_at) VALUES (?, ?, 'step', ?, ?, ?)",
    ).bind(crypto.randomUUID(), sampleId, `${step.title}: ${input.status.replace("_", " ")}${notes ? ` — ${notes}` : ""}`, JSON.stringify({ runId, stepId, status: input.status }), now),
    c.env.DB.prepare("UPDATE samples SET updated_at = ? WHERE id = ?").bind(now, sampleId),
  ]);
  const remaining = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM run_steps WHERE run_id = ? AND status NOT IN ('done', 'skipped')",
  ).bind(runId).first<{ count: number }>();
  if ((remaining?.count ?? 0) === 0) {
    await c.env.DB.prepare("UPDATE runs SET status = 'complete', completed_at = ? WHERE id = ?").bind(now, runId).run();
  } else {
    await c.env.DB.prepare("UPDATE runs SET status = 'active', completed_at = NULL WHERE id = ?").bind(runId).run();
  }
  return c.json({ ok: true });
});

app.post("/samples/:id/events", async (c) => {
  const sampleId = c.req.param("id");
  const input = await c.req.json<CreateEventInput>();
  if (!input.kind) throw new HTTPException(400, { message: "Event kind is required" });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, sampleId, input.kind, input.body?.trim() || null, input.assetKey || null, JSON.stringify(input.metadata ?? {}), now),
    c.env.DB.prepare("UPDATE samples SET updated_at = ? WHERE id = ?").bind(now, sampleId),
  ]);
  if (!result[1].meta.changes) throw new HTTPException(404, { message: "Sample not found" });
  return c.json({ id }, 201);
});

app.post("/assets", async (c) => {
  const contentType = c.req.header("content-type") || "application/octet-stream";
  const filename = c.req.header("x-filename") || "upload";
  const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const buffer = await c.req.arrayBuffer();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.ASSETS.put(key, buffer, { httpMetadata: { contentType } });
  try {
    await c.env.DB.prepare(
      `INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'ready', ?)`,
    ).bind(id, key, filename, contentType, buffer.byteLength, now).run();
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
  const entries = await Promise.all(Object.entries(tableQueries).map(async ([name, sql]) => {
    const result = await c.env.DB.prepare(sql).all<Record<string, unknown>>();
    return [name, result.results] as const;
  }));
  const tables = Object.fromEntries(entries) as Record<string, Array<Record<string, unknown>>>;
  return c.json({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    tables,
    assetKeys: collectExportAssetKeys(tables.assets, tables.imports),
  });
});

app.post("/imports/fabublox", async (c) => {
  const form = await c.req.raw.formData();
  const workbook = form.get("workbook");
  const manifestFile = form.get("manifest");
  if (!(workbook instanceof File) || !(manifestFile instanceof File)) throw new HTTPException(400, { message: "Workbook and manifest files are required" });
  const manifest = JSON.parse(await manifestFile.text()) as {
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
  if (manifest.schemaVersion !== 1 || !manifest.title?.trim() || !manifest.source?.sheetName || !Array.isArray(manifest.steps) || !manifest.steps.length) {
    throw new HTTPException(400, { message: "Invalid FabuBlox manifest" });
  }
  if (!["process", "module", "recipe"].includes(manifest.templateType)) throw new HTTPException(400, { message: "Invalid template type" });
  const workbookBuffer = await workbook.arrayBuffer();
  const actualSha = await digestSha256(workbookBuffer);
  if (actualSha !== manifest.source.fileSha256) throw new HTTPException(400, { message: "Workbook checksum does not match the preview" });

  const importId = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO imports (id, status, source_filename, source_sha256, sheet_name, template_type, warning_count, created_at)
     VALUES (?, 'pending', ?, ?, ?, ?, ?, ?)`,
  ).bind(importId, workbook.name, actualSha, manifest.source.sheetName, manifest.templateType, manifest.warnings.length, now).run();

  try {
    const prefix = `imports/${importId}`;
    const workbookKey = `${prefix}/source/${safeObjectName(workbook.name)}`;
    const manifestKey = `${prefix}/manifest.json`;
    await Promise.all([
      c.env.ASSETS.put(workbookKey, workbookBuffer, { httpMetadata: { contentType: workbook.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } }),
      c.env.ASSETS.put(manifestKey, JSON.stringify(manifest, null, 2), { httpMetadata: { contentType: "application/json" } }),
    ]);

    const uploadedAssets = await Promise.all(manifest.images.map(async (image) => {
      const value = form.get(`image:${image.localId}`);
      if (!(value instanceof File)) throw new Error(`Missing uploaded image ${image.localId}`);
      const assetId = crypto.randomUUID();
      const key = `${prefix}/images/${image.localId}-${safeObjectName(value.name)}`;
      await c.env.ASSETS.put(key, await value.arrayBuffer(), { httpMetadata: { contentType: value.type || image.mimeType } });
      return { image, file: value, assetId, key };
    }));

    const latest = await c.env.DB.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM template_versions WHERE name = ? AND template_type = ?",
    ).bind(manifest.title.trim(), manifest.templateType).first<{ version: number }>();
    const version = (latest?.version ?? 0) + 1;
    const templateVersionId = crypto.randomUUID();
    const stepIds = new Map(manifest.steps.map((step) => [step.localId, crypto.randomUUID()]));
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `INSERT INTO template_versions
          (id, name, template_type, version, source_filename, source_asset_key, content_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(templateVersionId, manifest.title.trim(), manifest.templateType, version, workbook.name, workbookKey, JSON.stringify(manifest), now),
      c.env.DB.prepare(
        "UPDATE imports SET template_version_id = ?, workbook_asset_key = ?, manifest_asset_key = ? WHERE id = ?",
      ).bind(templateVersionId, workbookKey, manifestKey, importId),
      ...manifest.steps.map((step) => c.env.DB.prepare(
        `INSERT INTO template_steps
          (id, template_version_id, position, source_row, step_number, section_name, name, tool_name, parameters_text, comments_text, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(stepIds.get(step.localId), templateVersionId, step.position, step.sourceRow, step.stepNumber, step.sectionName, step.name, step.toolName, step.parametersText, step.commentsText, JSON.stringify(step.rawCells))),
      ...uploadedAssets.map(({ assetId, key, file }) => c.env.DB.prepare(
        `INSERT INTO assets (id, import_id, r2_key, original_name, mime_type, byte_size, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ready', ?)`,
      ).bind(assetId, importId, key, file.name, file.type || "application/octet-stream", file.size, now)),
      ...uploadedAssets.flatMap(({ image, assetId }) => {
        const stepId = image.assignedStepLocalId ? stepIds.get(image.assignedStepLocalId) : null;
        return stepId ? [c.env.DB.prepare("INSERT INTO template_step_assets (template_step_id, asset_id) VALUES (?, ?)").bind(stepId, assetId)] : [];
      }),
    ];
    await batchInChunks(c.env.DB, statements);
    const completedAt = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE imports SET status = 'ready', completed_at = ? WHERE id = ?`,
    ).bind(completedAt, importId).run();
    return c.json({ id: importId, templateVersionId, version }, 201);
  } catch (error) {
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

app.post("/templates", async (c) => {
  const input = await c.req.json<{
    name: string;
    templateType: "process" | "module" | "recipe";
    sourceFilename?: string;
    sourceAssetKey?: string;
    content: unknown;
  }>();
  const name = input.name?.trim();
  if (!name || !["process", "module", "recipe"].includes(input.templateType)) {
    throw new HTTPException(400, { message: "A name and valid template type are required" });
  }
  const latest = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM template_versions WHERE name = ? AND template_type = ?",
  ).bind(name, input.templateType).first<{ version: number }>();
  const version = (latest?.version ?? 0) + 1;
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO template_versions
      (id, name, template_type, version, source_filename, source_asset_key, content_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    name,
    input.templateType,
    version,
    input.sourceFilename || null,
    input.sourceAssetKey || null,
    JSON.stringify(input.content),
    new Date().toISOString(),
  ).run();
  return c.json({ id, version }, 201);
});

export default app;
