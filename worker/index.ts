import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { CreateEventInput, CreateSampleInput } from "../shared/types";
import { sampleDetail, sampleEvent, sampleSummary } from "./serializers";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>().basePath("/api");

app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
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
  const [sample, children, events] = await Promise.all([
    c.env.DB.prepare(
      `SELECT s.*, p.id AS p_id, p.code AS p_code, p.title AS p_title
       FROM samples s LEFT JOIN samples p ON p.id = s.parent_id WHERE s.id = ?`,
    ).bind(id).first<Record<string, unknown>>(),
    c.env.DB.prepare("SELECT id, code, title FROM samples WHERE parent_id = ? ORDER BY created_at").bind(id).all(),
    c.env.DB.prepare("SELECT * FROM events WHERE sample_id = ? ORDER BY created_at DESC").bind(id).all(),
  ]);
  if (!sample) throw new HTTPException(404, { message: "Sample not found" });
  const parent = sample.p_id
    ? { id: String(sample.p_id), code: String(sample.p_code), title: String(sample.p_title) }
    : null;
  return c.json({
    ...sampleDetail(sample as never),
    parent,
    children: children.results,
    events: events.results.map((row) => sampleEvent(row as never)),
  });
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
  await c.env.ASSETS.put(key, c.req.raw.body, { httpMetadata: { contentType } });
  return c.json({ key }, 201);
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

app.get("/templates", async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT id, name, template_type, version, source_filename, created_at
     FROM template_versions ORDER BY created_at DESC`,
  ).all<{
    id: string;
    name: string;
    template_type: "process" | "module" | "recipe";
    version: number;
    source_filename: string | null;
    created_at: string;
  }>();
  return c.json({ templates: result.results.map((row) => ({
    id: row.id,
    name: row.name,
    templateType: row.template_type,
    version: row.version,
    sourceFilename: row.source_filename,
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
