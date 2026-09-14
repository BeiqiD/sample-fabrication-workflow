import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const requestId = "8c4d5fab-6bdd-4486-81b1-76daa781938a";
const namespace = JSON.stringify({ kind: "local-r2", installationId: "b72529f0-273b-4b72-9fc7-155a93461d83", bucketName: "fixture-assets" });
const modes = ["ordinary-replay", "project-replay", "concurrent", "held-pending", "lost-acceptance-ack",
  "lost-finalization-ack", "lost-http-ack", "failed-put", "unavailable-read", "missing-header",
  "missing-namespace", "namespace-change", "expired", "gc-unavailable", "quarantine-unavailable", "cross-ingress", "actor-independent", "deduplicated"];
const bindings = Object.fromEntries(modes.map((mode, index) => [mode, `DB_${index}`]));
const migrations = readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql")).sort();

function hostAdapter(database) {
  const prepare = (sql, values = []) => ({
    bind(...bindings) { return prepare(sql, bindings); },
    async all() { return this.execute(); },
    async first() { return plain(database.prepare(sql).get(...values) ?? null); },
    async run() { return this.execute(); },
    execute() {
      const statement = database.prepare(sql);
      return statement.columns().length
        ? { success: true, results: plain(statement.all(...values)), meta: { changes: 0 } }
        : { success: true, results: [], meta: { changes: Number(statement.run(...values).changes) } };
    },
  });
  return { nativeDatabase: database, prepare, async batch(statements) {
    database.exec("BEGIN");
    try { const result = statements.map((statement) => statement.execute()); database.exec("COMMIT"); return result; }
    catch (error) { database.exec("ROLLBACK"); throw error; }
  } };
}
async function apply(db, sql) {
  if (db.nativeDatabase) {
    db.nativeDatabase.exec("BEGIN");
    try { db.nativeDatabase.exec(sql); db.nativeDatabase.exec("COMMIT"); }
    catch (error) { db.nativeDatabase.exec("ROLLBACK"); throw error; }
    return;
  }
  return db.batch(splitSql(sql).map((statement) => db.prepare(statement)));
}
async function rows(db, table) { return (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results; }
async function seedBeforeUpgrade(db) {
  for (const name of migrations.filter((name) => name < "0004_r2_upload_acceptance.sql")) await apply(db, read(`migrations/${name}`));
  await apply(db, `
    INSERT INTO samples (id, code, title, created_at, updated_at) VALUES ('previous-sample', 'PREVIOUS', 'Previous sample', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, sha256, status, created_at)
      VALUES ('previous-asset', 'previous/image', 'previous.png', 'image/png', 4, '${hash("old!")}', 'ready', '2026-08-01T00:00:00.000Z');
    INSERT INTO events (id, sample_id, kind, asset_key, created_at)
      VALUES ('previous-event', 'previous-sample', 'image', 'previous/image', '2026-08-01T00:00:00.000Z');
  `);
}
async function upgrade(db) {
  const oldCatalog = (await db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).results;
  const oldRows = {};
  for (const table of ["samples", "assets", "events", "imports", "storage_profiles", "files", "file_locations", "legacy_file_mappings"]) oldRows[table] = await rows(db, table);
  const oldRetention = (await db.prepare("SELECT * FROM blob_retention_edges ORDER BY source_type, source_id, occurrence_type, occurrence_id").all()).results;
  await apply(db, read("migrations/0004_r2_upload_acceptance.sql"));
  const newCatalog = (await db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND tbl_name <> 'r2_upload_requests' ORDER BY type, name").all()).results;
  assert.deepEqual(newCatalog, oldCatalog, "forward upgrade preserves every previous table, index, view and guard verbatim");
  for (const table of Object.keys(oldRows)) assert.deepEqual(await rows(db, table), oldRows[table]);
  assert.deepEqual((await db.prepare("SELECT * FROM blob_retention_edges ORDER BY source_type, source_id, occurrence_type, occurrence_id").all()).results, oldRetention);
  assert.equal((await rows(db, "r2_upload_requests")).length, 0);
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
}

async function qualifySqlGuards(db) {
  const id = "b8f77b62-46b7-46ba-a635-c7d9e96c541e";
  const operation = "b8f77b62-46b7-46ba-a635-c7d9e96c541f";
  const candidate = "b8f77b62-46b7-46ba-a635-c7d9e96c5420";
  const created = "2026-08-01T00:00:00.000Z";
  const input = JSON.stringify({ schema: "r2-upload-request/1", ingress: "ordinary_image", purpose: "embedded_content", scope: "system",
    file: { originalName: "fixture.png", mimeType: "image/png", byteSize: 4, sha256: hash("data") } });
  await db.prepare("INSERT INTO storage_profiles VALUES ('guard-profile', 'r2', 'local-r2:guard:bucket', 'bootstrap', NULL, 1, 'historical', ?)").bind(created).run();
  await db.prepare(`INSERT INTO r2_upload_requests (id, actor_email, client_request_id, operation_id, ingress, purpose,
    request_sha256, request_input_json, request_scope, storage_profile_id, storage_profile_revision, storage_policy_revision,
    candidate_asset_id, candidate_object_key, status, created_at, expires_at)
    VALUES (?, 'owner@example.com', ?, ?, 'ordinary_image', 'embedded_content', ?, ?, 'system', 'guard-profile', 1, 1, ?, 'guard/data', 'pending', ?, '2026-08-02T00:00:00.000Z')`)
    .bind(id, requestId, operation, hash(input), input, candidate, created).run();
  const before = await rows(db, "r2_upload_requests");
  assert.equal(before.length, 1, "guard fixture has one accepted receipt");
  for (const sql of [
    "UPDATE r2_upload_requests SET purpose = 'research_source'",
    "UPDATE r2_upload_requests SET candidate_object_key = 'elsewhere'",
    "UPDATE r2_upload_requests SET actor_email = 'other@example.com'",
    "UPDATE r2_upload_requests SET expires_at = '2026-08-03T00:00:00.000Z'",
    "UPDATE r2_upload_requests SET request_sha256 = '" + "b".repeat(64) + "'",
    "DELETE FROM r2_upload_requests",
    "INSERT OR REPLACE INTO r2_upload_requests SELECT * FROM r2_upload_requests",
  ]) {
    await assert.rejects(db.prepare(sql).run(), /immutable|cannot be deleted|constraint|publication/i, sql);
    assert.deepEqual(await rows(db, "r2_upload_requests"), before);
  }
  const result = JSON.stringify({ id: candidate, key: "guard/data", deduplicated: false });
  const publish = () => db.prepare("UPDATE r2_upload_requests SET status = 'ready', completed_at = '2026-08-01T00:00:01.000Z', accepted_result_json = ? WHERE id = ?").bind(result, id).run();
  await assert.rejects(publish(), /publication/i, "a receipt cannot authorize a missing asset");
  await db.prepare("INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, sha256, status, created_at) VALUES (?, 'guard/data', 'fixture.png', 'image/png', 4, ?, 'ready', ?)")
    .bind(candidate, hash("data"), created).run();
  await publish();
  const ready = await rows(db, "r2_upload_requests");
  assert.equal(ready[0].status, "ready");
  for (const sql of ["UPDATE r2_upload_requests SET status = 'pending', completed_at = NULL, accepted_result_json = NULL",
    "UPDATE r2_upload_requests SET accepted_result_json = '{}'", "DELETE FROM r2_upload_requests",
    "INSERT OR REPLACE INTO r2_upload_requests SELECT * FROM r2_upload_requests"]) {
    await assert.rejects(db.prepare(sql).run(), /immutable|cannot be deleted|constraint|publication/i, sql);
    assert.deepEqual(await rows(db, "r2_upload_requests"), ready);
  }
  const retention = (await db.prepare("SELECT * FROM blob_retention_edges WHERE object_key = 'guard/data'").all()).results;
  assert.deepEqual(retention, [], "upload receipt does not retain its asset");
  await db.prepare("DELETE FROM assets WHERE id = ?").bind(candidate).run();
  assert.deepEqual(await rows(db, "r2_upload_requests"), ready, "receipt stores identity without preventing normal asset deletion");
  // A future authoritative reconciler may record failed; this terminal state
  // cannot become permission to claim or execute the same request again.
  const failed = { ...before[0], id: "c8f77b62-46b7-46ba-a635-c7d9e96c541e", client_request_id: "c8f77b62-46b7-46ba-a635-c7d9e96c541f",
    operation_id: "c8f77b62-46b7-46ba-a635-c7d9e96c5420", candidate_asset_id: "c8f77b62-46b7-46ba-a635-c7d9e96c5421", candidate_object_key: "guard/failed" };
  const columns = Object.keys(failed);
  await db.prepare(`INSERT INTO r2_upload_requests (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).bind(...columns.map((column) => failed[column])).run();
  await db.prepare("UPDATE r2_upload_requests SET status = 'failed', completed_at = '2026-08-01T00:00:01.000Z' WHERE id = ?").bind(failed.id).run();
  await assert.rejects(db.prepare("UPDATE r2_upload_requests SET status = 'pending', completed_at = NULL WHERE id = ?").bind(failed.id).run(), /immutable/);
}

const workerSource = `
import { Hono } from "hono";
import { routes as imageRoutes } from "./worker/blob-lifecycle/attachment-routes.ts";
import { routes as projectRoutes } from "./worker/project-foundation-routes.ts";
import { handleError } from "./worker/platform/http.ts";
import { snapshotFullExportV13 } from "./worker/export-v13-snapshot.ts";
const app = new Hono().basePath("/api");
app.onError(handleError);
app.use("*", async (c, next) => { c.set("userEmail", c.req.header("X-Fixture-Actor") || "owner@example.com"); await next(); });
app.route("/", imageRoutes); app.route("/", projectRoutes);
export default { async fetch(request, env, ctx) {
  const { mode, binding } = await request.json();
  const rawDb = env[binding];
  const stats = { puts: [], gets: [], heads: [], deletes: 0, insertAttempts: 0, sessions: [],
    lostAcceptance: 0, lostFinalization: 0, acceptedBeforeEachPut: [] };
  let releaseInsert; const insertGate = new Promise(resolve => { releaseInsert = resolve; });
  let releasePut; const putGate = new Promise(resolve => { releasePut = resolve; });
  let firstPutStarted; const firstPut = new Promise(resolve => { firstPutStarted = resolve; });
  let phase = "first";
  function database(native) {
    function statement(sql, inner) { return {
      sql, inner,
      bind(...values) { return statement(sql, inner.bind(...values)); },
      first(...args) { return inner.first(...args); }, all(...args) { return inner.all(...args); }, raw(...args) { return inner.raw(...args); },
      async run(...args) {
        const acceptance = /^\\s*INSERT INTO r2_upload_requests\\b/i.test(sql);
        const finalization = /UPDATE r2_upload_requests/.test(sql) && /SET status = 'ready'/.test(sql);
        if (acceptance) {
          stats.insertAttempts++;
          if (mode === "concurrent" && phase === "first") { if (stats.insertAttempts === 2) releaseInsert(); await insertGate; }
        }
        const result = await inner.run(...args);
        if (acceptance && mode === "lost-acceptance-ack" && stats.lostAcceptance++ === 0) throw new Error("PRIVATE_PROVIDER_ERROR lost committed acceptance");
        if (finalization && mode === "lost-finalization-ack" && stats.lostFinalization++ === 0) throw new Error("PRIVATE_PROVIDER_ERROR lost committed finalization");
        return result;
      }
    }; }
    return {
      prepare(sql) { return statement(sql, native.prepare(sql)); },
      withSession(constraint) { stats.sessions.push(constraint); return database(typeof native.withSession === "function" ? native.withSession(constraint) : native); },
      async batch(statements) {
        const result = await native.batch(statements.map(item => item.inner));
        if (mode === "lost-finalization-ack" && !stats.lostFinalization && statements.some(item => /UPDATE r2_upload_requests/.test(item.sql) && /SET status = 'ready'/.test(item.sql))) {
          stats.lostFinalization++; throw new Error("PRIVATE_PROVIDER_ERROR lost committed finalization");
        }
        return result;
      },
    };
  }
  const bucket = {
    async put(key, bytes, options) {
      stats.puts.push(key);
      stats.acceptedBeforeEachPut.push(await rawDb.prepare("SELECT * FROM r2_upload_requests WHERE client_request_id = ? ORDER BY created_at").bind(${JSON.stringify(requestId)}).all());
      if (mode === "held-pending" && stats.puts.length === 1) { firstPutStarted(); await putGate; }
      if (mode === "failed-put") throw new Error("PRIVATE_PROVIDER_ERROR provider unavailable before PUT");
      const result = await env.BUCKET.put(key, bytes, options);
      if (mode === "unavailable-read") throw new Error("PRIVATE_PROVIDER_ERROR uncertain provider PUT");
      return result;
    },
    async get(key, options) { stats.gets.push(key); if (mode === "unavailable-read") throw new Error("PRIVATE_PROVIDER_ERROR provider unavailable on GET"); return env.BUCKET.get(key, options); },
    async head(key) { stats.heads.push(key); if (mode === "unavailable-read") throw new Error("PRIVATE_PROVIDER_ERROR provider unavailable on HEAD"); return env.BUCKET.head(key); },
    async delete() { stats.deletes++; throw new Error("upload acceptance must not delete bytes"); },
  };
  const routeEnv = { DB: database(rawDb), ASSETS: bucket, AUTH_MODE: "disabled", R2_BOOTSTRAP_NAMESPACE: mode === "missing-namespace" ? undefined : ${JSON.stringify(namespace)} };
  const bytes = new TextEncoder().encode("native image fixture " + mode);
  async function sha(value) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))].map(value => value.toString(16).padStart(2, "0")).join(""); }
  if (mode === "deduplicated") {
    await env.BUCKET.put("reusable-image", bytes);
    await rawDb.prepare("INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, sha256, status, created_at) VALUES ('reusable-asset', 'reusable-image', 'previous.png', 'image/png', ?, ?, 'ready', '2026-08-01T00:00:00.000Z')").bind(bytes.byteLength, await sha(bytes)).run();
  }
  const ingress = mode === "project-replay" ? "project_attachment" : "ordinary_image";
  async function post(options = {}) {
    const selected = options.ingress || ingress;
    const headers = new Headers({ "Content-Type": options.mime || "image/png", "X-Fixture-Actor": options.actor || "owner@example.com" });
    if (!options.omitHeader) headers.set("X-Upload-Request-Id", options.requestId || ${JSON.stringify(requestId)});
    headers.set(selected === "ordinary_image" ? "X-Filename" : "X-Project-Filename-Uri", options.filename || "fixture.png");
    const response = await app.fetch(new Request("https://app.test/api/" + (selected === "ordinary_image" ? "assets" : "project-assets"), {
      method: "POST", headers, body: options.changed ? new Uint8Array([...bytes, 42]) : bytes,
    }), routeEnv, ctx);
    if (mode === "lost-http-ack" && phase === "first") { await response.arrayBuffer(); return { status: 0, body: null }; }
    return { status: response.status, body: await response.json() };
  }
  async function poll(actor = "owner@example.com") {
    const response = await app.fetch(new Request("https://app.test/api/r2-upload-requests/" + ${JSON.stringify(requestId)}, { headers: { "X-Fixture-Actor": actor } }), routeEnv, ctx);
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get("cache-control") };
  }
  async function snapshot() {
    const result = {};
    for (const table of ["r2_upload_requests", "assets", "storage_profiles", "blob_gc_ledger", "blob_integrity_quarantine"]) result[table] = (await rawDb.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()).results;
    return result;
  }
  const before = await snapshot(); const missing = await poll();
  let first; let pending = null; let pendingPoll = null; let pendingIo = null;
  const io = () => ({ puts: [...stats.puts], gets: [...stats.gets], heads: [...stats.heads], deletes: stats.deletes });
  if (mode === "concurrent") first = await Promise.all([post(), post()]);
  else if (mode === "held-pending") {
    const running = post(); await firstPut; const beforePending = io();
    pending = await post(); pendingPoll = await poll(); pendingIo = { before: beforePending, after: io() };
    releasePut(); first = await running;
  } else first = await post({ omitHeader: mode === "missing-header" });
  phase = "retry";
  const afterFirst = await snapshot(); const firstIo = io();
  const originalDate = Date;
  if (mode === "expired") globalThis.Date = class extends originalDate {
    constructor(...args) { super(...(args.length ? args : [originalDate.now() + 86400001])); }
    static now() { return originalDate.now() + 86400001; }
  };
  try {
    if (mode === "namespace-change") routeEnv.R2_BOOTSTRAP_NAMESPACE = JSON.stringify({ kind: "local-r2", installationId: "b72529f0-273b-4b72-9fc7-155a93461d83", bucketName: "different-bucket" });
    const readyRow = afterFirst.r2_upload_requests[0];
    const accepted = readyRow?.accepted_result_json ? JSON.parse(readyRow.accepted_result_json) : null;
    if (mode === "gc-unavailable") await rawDb.prepare("INSERT INTO blob_gc_ledger (store_kind, provider, object_key, state, operation_id, updated_at) VALUES ('r2', 'r2', ?, 'deleted', 'qualification-gc', ?)").bind(accepted.key, new Date().toISOString()).run();
    if (mode === "quarantine-unavailable") await rawDb.prepare("INSERT INTO blob_integrity_quarantine (store_kind, provider, object_key, reason, expected_byte_size, observed_byte_size, operation_id, detected_at, last_checked_at) VALUES ('r2', 'r2', ?, 'size_mismatch', ?, ?, 'qualification-quarantine', ?, ?)").bind(accepted.key, bytes.byteLength, bytes.byteLength + 1, new Date().toISOString(), new Date().toISOString()).run();
    const retryBefore = await snapshot(); const state = await poll(); const otherActor = await poll("other@example.com");
    let retry = null; let conflicts = []; let otherAcceptance = null;
    if (!["missing-header", "missing-namespace"].includes(mode)) retry = await post();
    if (["ordinary-replay", "project-replay"].includes(mode)) for (const options of [{ changed: true }, { filename: "changed.png" }, { mime: "image/webp" }]) conflicts.push(await post(options));
    if (mode === "cross-ingress") conflicts.push(await post({ ingress: "project_attachment" }));
    const retryIo = io();
    if (mode === "actor-independent") otherAcceptance = await post({ actor: "other@example.com" });
    const afterRetry = await snapshot();
    const physical = [];
    for (const row of afterFirst.r2_upload_requests) if (row.accepted_result_json) {
      const result = JSON.parse(row.accepted_result_json); const blob = await env.BUCKET.get(result.key);
      physical.push({ id: result.id, key: result.key, size: blob?.size ?? null, sha256: blob ? await sha(await blob.arrayBuffer()) : null });
    }
    return Response.json({ before, missing, first, pending, pendingPoll, pendingIo, afterFirst, firstIo, retryBefore, state, otherActor,
      retry, conflicts, retryIo, otherAcceptance, afterRetry, physical, stats,
      archive: mode === "ordinary-replay" ? await snapshotFullExportV13(rawDb) : null });
  } finally { globalThis.Date = originalDate; }
} };
`;

async function bundle(source, platform = "neutral") {
  return (await build({ stdin: { contents: source, resolveDir: root, sourcefile: "fp1-r2-upload-qualification.ts" },
    bundle: true, format: "esm", platform, write: false,
    ...(platform === "node" ? { banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } } : {}),
  })).outputFiles[0].text;
}

test("R2 upload acceptance upgrades populated host SQLite without changing old authority or retention", async () => {
  const host = new DatabaseSync(":memory:");
  try {
    host.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = OFF");
    const db = hostAdapter(host); await seedBeforeUpgrade(db); await upgrade(db); await qualifySqlGuards(db);
  } finally { host.close(); }
});

test("production R2 upload routes preserve durable ownership on real workerd, D1 and R2", { timeout: 180_000 }, async (t) => {
  const mf = new Miniflare({ modules: true, script: await bundle(workerSource), compatibilityDate: "2026-07-20",
    r2Buckets: ["BUCKET"], d1Databases: [...Object.values(bindings), "DB_GUARDS"], log: new Log(LogLevel.ERROR) });
  const scratch = await mkdtemp(join(tmpdir(), "fp1-r2-upload-"));
  try {
    for (const binding of [...Object.values(bindings), "DB_GUARDS"]) {
      const db = await mf.getD1Database(binding); await seedBeforeUpgrade(db); await upgrade(db);
      for (const name of migrations.filter((name) => name > "0004_r2_upload_acceptance.sql")) await apply(db, read(`migrations/${name}`));
    }
    await t.test("D1 enforces immutable identities and terminal results with recursive triggers disabled", async () => {
      const db = await mf.getD1Database("DB_GUARDS"); await db.prepare("PRAGMA recursive_triggers = OFF").run(); await qualifySqlGuards(db);
    });
    for (const mode of modes) await t.test(mode, async () => {
      const response = await mf.dispatchFetch("https://qualification.test/", { method: "POST", body: JSON.stringify({ mode, binding: bindings[mode] }) });
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      assert.equal(result.missing.status, 404); assert.equal(result.otherActor.status, 404);
      assert.equal(result.stats.deletes, 0); assert(!JSON.stringify([result.first, result.state, result.retry]).includes("PRIVATE_PROVIDER_ERROR"));
      assert.equal(result.state.cacheControl, "no-store");
      assert.deepEqual(result.retryIo.puts, result.firstIo.puts, "polling, retries and conflicts never replay a provider write");
      assert.deepEqual(result.retryIo.heads, result.firstIo.heads, "replay does not restart registration");
      if (["missing-header", "missing-namespace"].includes(mode)) {
        assert.equal(result.first.status, mode === "missing-header" ? 428 : 503);
        assert.deepEqual(result.afterFirst, result.before); assert.equal(result.stats.insertAttempts, 0);
        assert.deepEqual(result.firstIo, { puts: [], gets: [], heads: [], deletes: 0 }); return;
      }
      const receipt = result.afterFirst.r2_upload_requests[0]; assert(receipt);
      assert.equal(result.firstIo.puts.length, mode === "deduplicated" ? 0 : 1, "only the accepted executor can issue one initial PUT");
      assert.equal(receipt.client_request_id, requestId); assert.equal(receipt.actor_email, "owner@example.com");
      assert.equal(receipt.purpose, mode === "project-replay" ? "research_source" : "embedded_content");
      assert.equal(Date.parse(receipt.expires_at) - Date.parse(receipt.created_at), 86_400_000);
      assert.equal(receipt.request_sha256, hash(receipt.request_input_json));
      const input = JSON.parse(receipt.request_input_json);
      assert.equal(input.file.sha256, hash("native image fixture " + mode));
      for (const observation of result.stats.acceptedBeforeEachPut) {
        assert(observation.results.some((row) => row.status === "pending" && row.operation_id === receipt.operation_id));
      }
      if (mode !== "actor-independent") assert.deepEqual(result.afterRetry, result.retryBefore, "observation never mutates saved acceptance");
      if (["failed-put", "unavailable-read"].includes(mode)) {
        assert.equal(result.first.status, 503); assert.equal(receipt.accepted_result_json, null);
        assert(["pending", "failed"].includes(receipt.status)); assert.equal(result.state.body.status, receipt.status);
        assert.equal(result.retry.status, receipt.status === "pending" ? 202 : 409); return;
      }
      assert.equal(receipt.status, "ready");
      const saved = JSON.parse(receipt.accepted_result_json);
      for (const physical of result.physical) { assert.equal(physical.size, input.file.byteSize); assert.equal(physical.sha256, input.file.sha256); }
      if (mode === "namespace-change") { assert.equal(result.state.status, 503); assert.equal(result.retry.status, 503); return; }
      if (["expired", "gc-unavailable", "quarantine-unavailable"].includes(mode)) {
        assert.equal(result.state.body.status, mode === "expired" ? "expired" : "unavailable");
        assert.equal(result.retry.status, mode === "expired" ? 410 : 503);
        assert.equal(result.state.body.result, undefined); return;
      }
      assert.equal(result.retry.status, 200); assert.deepEqual(result.retry.body, saved); assert.deepEqual(result.state.body.result, saved);
      assert(result.stats.sessions.includes("first-primary"), "acceptance and reconciliation use primary D1 observations");
      if (mode === "concurrent") {
        assert.equal(result.stats.insertAttempts, 2); assert.equal(result.first.filter((response) => response.status === 201).length, 1);
        assert(result.first.every((response) => [200, 201, 202].includes(response.status))); assert.equal(result.stats.puts.length, 1);
      } else assert.equal(result.first.status, mode === "lost-http-ack" ? 0 : mode === "deduplicated" ? 200 : 201);
      if (mode === "held-pending") { assert.equal(result.pending.status, 202); assert.equal(result.pendingPoll.body.status, "pending"); assert.deepEqual(result.pendingIo.before, result.pendingIo.after); }
      if (mode === "lost-acceptance-ack") assert.equal(result.stats.lostAcceptance, 1);
      if (mode === "lost-finalization-ack") assert.equal(result.stats.lostFinalization, 1);
      if (mode === "actor-independent") { assert([200, 201].includes(result.otherAcceptance.status)); assert.equal(result.afterRetry.r2_upload_requests.length, 2); }
      if (mode === "deduplicated") { assert.equal(saved.id, "reusable-asset"); assert.equal(saved.deduplicated, true); }
      if (result.conflicts.length) assert(result.conflicts.every((response) => response.status === 409));
      if (mode === "ordinary-replay") {
        const source = `export { snapshotFullExportV13 } from './worker/export-v13-snapshot.ts'; export { buildFullExportArchiveV13 } from './src/lib/exportAll.ts'; export { restoreExportToIsolatedDirectory } from './scripts/lib/export-restore.ts';`;
        const modulePath = join(scratch, "restore-qualification.mjs"); await writeFile(modulePath, await bundle(source, "node"));
        const service = await import(pathToFileURL(modulePath).href);
        const byUrl = new Map(result.archive.blobs.map((blob) => [blob.downloadUrl, blob]));
        const archive = await service.buildFullExportArchiveV13(result.archive, undefined, async (url) => {
          const blob = byUrl.get(String(url));
          const stored = blob && await (await mf.getR2Bucket("BUCKET")).get(blob.objectKey);
          return stored ? new Response(await stored.arrayBuffer()) : new Response(null, { status: 404 });
        });
        const archivePath = join(scratch, "recovery-contract.zip"); await writeFile(archivePath, Buffer.from(await archive.archive.arrayBuffer()));
        const originalHash = hash(await readFile(archivePath));
        const restored = await service.restoreExportToIsolatedDirectory({ archivePath, destination: join(scratch, "restored"), migrationsDirectory: join(root, "migrations"), targetCompatibilitySchema: "S2" });
        assert.equal(restored.report.schemaVersion, 13); assert.equal(restored.report.verification.rowsEqual, true); assert.equal(restored.report.verification.foreignKeys, true);
        assert(restored.report.restoredBlobCount > 0);
        const recovered = new DatabaseSync(join(restored.restoredDirectory, "database.sqlite"));
        try {
          const snapshot = await service.snapshotFullExportV13(hostAdapter(recovered));
          assert.deepEqual(snapshot.tables, result.archive.tables, "nonempty D1 archive restores all historical rows and accepted identity exactly");
          assert.deepEqual(snapshot.tables.r2_upload_requests, result.afterFirst.r2_upload_requests);
          assert.throws(() => recovered.exec("DELETE FROM r2_upload_requests"), /cannot be deleted/);
        } finally { recovered.close(); }
        assert.equal(hash(await readFile(archivePath)), originalHash);
      }
    });
  } finally { await mf.dispose(); await rm(scratch, { recursive: true, force: true }); }
});
