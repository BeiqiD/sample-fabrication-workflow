import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { routes as imageRoutes } from "../blob-lifecycle/attachment-routes";
import { routes as projectRoutes } from "../project-foundation-routes";
import { referenceTestDatabase, SqliteD1Database, type SqliteD1Statement } from "../reference-test-support";
import { MAX_R2_UPLOAD_BYTES } from "../../shared/contracts/r2-upload";
import { sha256Hex } from "../../shared/domain/content-addressing";
import type { Env } from "../types";

const NAMESPACE = JSON.stringify({ kind: "local-r2", installationId: "4e5c6dd7-325b-4eae-8499-518eaa0fcb40", bucketName: "test-assets" });
const bytes = Uint8Array.of(137, 80, 78, 71, 1, 2, 3, 4);
const opened: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); opened.splice(0).forEach((db) => db.close()); });

function fixture() {
  const sql = referenceTestDatabase();
  opened.push(sql);
  const adapter = new SqliteD1Database(sql);
  let loseInsert = false;
  let rejectInsert = false;
  let losePublication = false;
  let rejectPublication = false;
  let failReads = false;
  let primaryReads = 0;
  const wrap = (query: string, statement: SqliteD1Statement): unknown => ({
    bind: (...args: unknown[]) => wrap(query, statement.bind(...args)),
    async first() { if (failReads && query.includes("r2_upload_requests")) throw new Error("private DB failure"); return statement.first(); },
    all: () => statement.all(),
    execute: () => statement.execute(),
    async run() {
      if (query.startsWith("INSERT INTO r2_upload_requests") && rejectInsert) throw new Error("private INSERT rejected");
      if (query.startsWith("UPDATE r2_upload_requests") && rejectPublication) throw new Error("private finalization rejected");
      const result = await statement.run();
      if (query.startsWith("INSERT INTO r2_upload_requests") && loseInsert) { loseInsert = false; throw new Error("private lost INSERT response"); }
      if (query.startsWith("UPDATE r2_upload_requests") && losePublication) { losePublication = false; throw new Error("private lost finalization response"); }
      return result;
    },
  });
  const db = {
    prepare: (query: string) => wrap(query, adapter.prepare(query)),
    batch: (statements: D1PreparedStatement[]) => adapter.batch(statements),
    withSession: (constraint: string) => { expect(constraint).toBe("first-primary"); primaryReads += 1; return db; },
  } as unknown as D1Database;
  const stored = new Map<string, Uint8Array>();
  const put = vi.fn(async (key: string, value: ArrayBuffer) => { stored.set(key, new Uint8Array(value.slice(0))); });
  const object = (value: Uint8Array) => ({ body: new Blob([value]).stream(), size: value.byteLength,
    httpEtag: '"receipt-test"', writeHttpMetadata(headers: Headers) { headers.set("content-type", "image/png"); } });
  const get = vi.fn(async (key: string) => { const value = stored.get(key); return value ? object(value) : null; });
  const head = vi.fn(async (key: string) => { const value = stored.get(key); return value ? object(value) : null; });
  const env = { DB: db, R2_BOOTSTRAP_NAMESPACE: NAMESPACE, ASSETS: { put, get, head } as unknown as R2Bucket } satisfies Env;
  const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
  app.use("*", async (c, next) => { c.set("userEmail", c.req.header("x-test-actor") ?? "owner@example.test"); await next(); });
  app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: "Unexpected error" }, 500));
  app.route("/", imageRoutes);
  app.route("/", projectRoutes);
  const request = (id: string | null, options: { path?: string; body?: BodyInit; actor?: string; filename?: string; encodedFilename?: string; mime?: string } = {}) => {
    const headers = new Headers({ "content-type": options.mime ?? "image/png", "x-filename": options.filename ?? "image.png",
      "x-project-filename-uri": encodeURIComponent(options.filename ?? "image.png") });
    if (id !== null) headers.set("x-upload-request-id", id);
    if (options.actor) headers.set("x-test-actor", options.actor);
    if (options.encodedFilename !== undefined) headers.set("x-filename-uri", options.encodedFilename);
    const init: RequestInit & { duplex?: "half" } = { method: "POST", headers, body: options.body ?? bytes };
    if (init.body instanceof ReadableStream) init.duplex = "half";
    return app.request(options.path ?? "/assets", init, env);
  };
  const status = (id: string, actor = "owner@example.test") => app.request(`/r2-upload-requests/${id}`, { headers: { "x-test-actor": actor } }, env);
  return { sql, env, request, status, put, get, head, stored,
    loseInsert: () => { loseInsert = true; }, rejectInsert: () => { rejectInsert = true; },
    losePublication: () => { losePublication = true; }, rejectPublication: () => { rejectPublication = true; },
    failReads: () => { failReads = true; }, primaryReads: () => primaryReads,
  };
}

describe("durable ordinary and Project upload acceptance", () => {
  it("requires a valid request ID before storage or acceptance, including chunked oversized bodies", async () => {
    const f = fixture();
    expect((await f.request(null)).status).toBe(428);
    expect((await f.request("bad-id")).status).toBe(400);
    let cancelled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_R2_UPLOAD_BYTES + 1)); }, cancel() { cancelled = true; } });
    expect((await f.request(crypto.randomUUID(), { body })).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(f.put).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.sql.prepare("SELECT count(*) n FROM r2_upload_requests").get()!.n).toBe(0);
  });

  it.each(["/assets", "/project-assets"])("stores immutable input, purpose and result for %s and replays without writing", async (path) => {
    const f = fixture();
    const id = crypto.randomUUID();
    const first = await f.request(id, { path });
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const result = await first.json();
    const rows = f.sql.prepare("SELECT * FROM r2_upload_requests").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "ready", client_request_id: id, request_scope: "system",
      purpose: path === "/assets" ? "embedded_content" : "research_source",
      storage_profile_revision: 1, storage_policy_revision: 1 });
    expect(JSON.parse(String(rows[0].request_input_json)).file).toMatchObject({ originalName: "image.png", byteSize: bytes.byteLength });
    expect(Date.parse(String(rows[0].expires_at)) - Date.parse(String(rows[0].created_at))).toBe(86_400_000);
    const replay = await f.request(id, { path });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    const status = await f.status(id);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.json()).toMatchObject({ requestId: id, status: "ready", result });
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(f.sql.prepare("SELECT * FROM r2_upload_requests").all()).toEqual(rows);
    expect(f.primaryReads()).toBeGreaterThan(5);
    expect(f.sql.prepare("SELECT count(*) n FROM files").get()!.n).toBe(0);
  });

  it("rejects changed actual bytes, metadata or ingress on the same actor request", async () => {
    const f = fixture();
    const id = crypto.randomUUID();
    expect((await f.request(id)).status).toBe(201);
    for (const options of [{ body: Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7) }, { filename: "renamed.png" }, { mime: "image/jpeg" }, { path: "/project-assets" }]) {
      expect((await f.request(id, options)).status).toBe(409);
    }
    expect(f.put).toHaveBeenCalledTimes(1);
  });

  it("preserves Unicode filenames through the authoritative URI header and rejects malformed encoding", async () => {
    const f = fixture();
    const id = crypto.randomUUID();
    const filename = "显微图像-é-🧪.png";
    const options = { encodedFilename: encodeURIComponent(filename), filename: "legacy-fallback.png" };
    expect((await f.request(id, options)).status).toBe(201);
    expect((await f.request(id, options)).status).toBe(200);
    const row = f.sql.prepare("SELECT request_input_json FROM r2_upload_requests").get()!;
    expect(JSON.parse(String(row.request_input_json)).file.originalName).toBe(filename);
    expect(f.sql.prepare("SELECT original_name FROM assets").get()!.original_name).toBe(filename);
    for (const encodedFilename of ["%", "%ZZ", "%E0%A4", "%00", "", encodeURIComponent("a".repeat(256))]) {
      expect((await f.request(crypto.randomUUID(), { encodedFilename })).status).toBe(400);
    }
    expect(f.put).toHaveBeenCalledTimes(1);
  });

  it("keeps actors separate and preserves legacy cross-purpose SHA deduplication", async () => {
    const f = fixture();
    const id = crypto.randomUUID();
    const first = await f.request(id);
    const firstResult = await first.json() as { id: string; key: string };
    expect((await f.status(id, "different@example.test")).status).toBe(404);
    const second = await f.request(id, { path: "/project-assets", actor: "different@example.test", filename: "raw.bin", mime: "application/octet-stream" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ...firstResult, deduplicated: true });
    expect(f.sql.prepare("SELECT count(*) n FROM r2_upload_requests").get()!.n).toBe(2);
    expect(f.sql.prepare("SELECT count(*) n FROM assets").get()!.n).toBe(1);
    expect(f.put).toHaveBeenCalledTimes(1);
  });

  it("replays historical Unicode locator identities at the SQL codepoint limits", async () => {
    const f = fixture();
    const assetId = "🧪".repeat(256);
    const key = `🔬${"x".repeat(4095)}`;
    f.sql.prepare(`INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES (?, ?, 'historical.png', 'image/png', ?, 'ready', ?, ?)`)
      .run(assetId, key, bytes.byteLength, await sha256Hex(bytes.buffer), new Date().toISOString());
    f.stored.set(key, bytes);
    const id = crypto.randomUUID();
    const uploaded = await f.request(id);
    expect(uploaded.status).toBe(200);
    expect(await uploaded.json()).toEqual({ id: assetId, key, deduplicated: true });
    expect(await (await f.status(id)).json()).toMatchObject({ status: "ready", result: { id: assetId, key } });
    expect(f.put).not.toHaveBeenCalled();
  });

  it("reconciles lost acceptance and finalization acknowledgements on the primary", async () => {
    const f = fixture();
    f.loseInsert(); f.losePublication();
    const id = crypto.randomUUID();
    expect((await f.request(id)).status).toBe(201);
    expect((await f.request(id)).status).toBe(200);
    expect(f.sql.prepare("SELECT status FROM r2_upload_requests").get()!.status).toBe("ready");
    expect(f.put).toHaveBeenCalledTimes(1);
  });

  it("does not write after rejected or unreadable acceptance", async () => {
    for (const failure of ["rejectInsert", "failReads"] as const) {
      const f = fixture(); f[failure]();
      const response = await f.request(crypto.randomUUID());
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private");
      expect(f.put).not.toHaveBeenCalled();
    }
  });

  it("preserves pending ownership when registration or publication remains uncertain", async () => {
    for (const failure of ["put", "publication"] as const) {
      const f = fixture();
      if (failure === "put") f.put.mockRejectedValue(new Error("private provider failure"));
      else f.rejectPublication();
      const id = crypto.randomUUID();
      expect((await f.request(id)).status).toBe(failure === "put" ? 503 : 202);
      expect((await f.request(id)).status).toBe(202);
      expect(await (await f.status(id)).json()).toMatchObject({ status: "pending" });
      expect(f.put).toHaveBeenCalledTimes(1);
    }
  });

  it("allows only the fresh request owner to upload while a second request observes pending", async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    f.put.mockImplementationOnce(async (key, value) => { entered(); await wait; f.stored.set(key, new Uint8Array(value)); });
    const id = crypto.randomUUID();
    const first = f.request(id);
    await writing;
    expect((await f.request(id)).status).toBe(202);
    release();
    expect((await first).status).toBe(201);
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(f.sql.prepare("SELECT count(*) n FROM r2_upload_requests").get()!.n).toBe(1);
  });

  it("checks receipt identity before current configuration and refuses a changed namespace before byte reads", async () => {
    const f = fixture();
    const id = crypto.randomUUID();
    expect((await f.request(id)).status).toBe(201);
    f.env.R2_BOOTSTRAP_NAMESPACE = NAMESPACE.replace("test-assets", "other-assets");
    f.get.mockClear();
    expect((await f.request(id, { filename: "changed.png" })).status).toBe(409);
    expect((await f.status(id)).status).toBe(503);
    expect((await f.request(id)).status).toBe(503);
    expect(f.get).not.toHaveBeenCalled();
    expect(f.put).toHaveBeenCalledTimes(1);
  });

  it("expires receipts without requiring configuration or extending their registration grace", async () => {
    const f = fixture();
    const id = crypto.randomUUID();
    expect((await f.request(id)).status).toBe(201);
    const receipt = f.sql.prepare("SELECT * FROM r2_upload_requests").get()!;
    const before = f.sql.prepare("SELECT * FROM blob_gc_ledger").all();
    vi.useFakeTimers(); vi.setSystemTime(new Date(String(receipt.expires_at)));
    f.env.R2_BOOTSTRAP_NAMESPACE = "unavailable";
    f.get.mockClear();
    expect((await f.request(id)).status).toBe(410);
    expect(await (await f.status(id)).json()).toMatchObject({ status: "expired" });
    expect(f.get).not.toHaveBeenCalled();
    expect(f.sql.prepare("SELECT * FROM r2_upload_requests").get()).toEqual(receipt);
    expect(f.sql.prepare("SELECT * FROM blob_gc_ledger").all()).toEqual(before);
  });

  it("distinguishes unavailable bytes from a transient provider failure without another write", async () => {
    const f = fixture();
    const id = crypto.randomUUID();
    const first = await f.request(id);
    const result = await first.json() as { key: string };
    f.get.mockRejectedValueOnce(new Error("private provider outage"));
    expect((await f.status(id)).status).toBe(503);
    expect(await (await f.status(id)).json()).toMatchObject({ status: "ready" });
    f.stored.set(result.key, Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0));
    expect(await (await f.status(id)).json()).toMatchObject({ status: "unavailable" });
    f.stored.delete(result.key);
    expect(await (await f.status(id)).json()).toMatchObject({ status: "unavailable" });
    expect((await f.request(id)).status).toBe(503);
    expect(f.put).toHaveBeenCalledTimes(1);
  });

  it("blocks malformed receipts, mutation and replacement even with recursive triggers disabled", async () => {
    const f = fixture();
    f.rejectPublication();
    const id = crypto.randomUUID();
    expect((await f.request(id)).status).toBe(202);
    const row = f.sql.prepare("SELECT * FROM r2_upload_requests").get()!;
    const result = { id: row.candidate_asset_id, key: row.candidate_object_key, deduplicated: false };
    const completed = new Date().toISOString();
    for (const value of [
      { id: result.id, key: result.key, extra: true }, { ...result, deduplicated: null },
      { ...result, deduplicated: 1 }, { ...result, id: "other-id" }, { ...result, key: "other-key" },
    ]) expect(() => f.sql.prepare("UPDATE r2_upload_requests SET status='ready', accepted_result_json=?, completed_at=? WHERE id=?")
      .run(JSON.stringify(value), completed, row.id)).toThrow();
    const duplicate = JSON.stringify(result).replace('"deduplicated":false', '"deduplicated":false,"deduplicated":false');
    expect(() => f.sql.prepare("UPDATE r2_upload_requests SET status='ready', accepted_result_json=?, completed_at=? WHERE id=?")
      .run(duplicate, completed, row.id)).toThrow();
    f.sql.exec("PRAGMA recursive_triggers=OFF");
    for (const query of ["DELETE FROM r2_upload_requests", "UPDATE r2_upload_requests SET request_scope='other'",
      "UPDATE r2_upload_requests SET status='failed', completed_at=created_at, expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',expires_at,'+1 day')",
      "INSERT OR REPLACE INTO r2_upload_requests SELECT * FROM r2_upload_requests"]) expect(() => f.sql.exec(query)).toThrow();
    f.sql.prepare("UPDATE r2_upload_requests SET status='ready', accepted_result_json=?, completed_at=? WHERE id=?")
      .run(JSON.stringify(result), completed, row.id);
    expect(() => f.sql.exec("UPDATE r2_upload_requests SET status='failed', accepted_result_json=NULL")).toThrow();
    expect(() => f.sql.exec("UPDATE r2_upload_requests SET status='ready'")).toThrow();
  });
});
