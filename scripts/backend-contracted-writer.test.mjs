// Explicit, inactive-stage qualification. This never changes the active migration
// directory or deployment configuration and does not qualify C for the S0 schema.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { installWorkerCryptoForHostTests } from "../test/worker-crypto.mjs";

const restoreHostCrypto = installWorkerCryptoForHostTests();
after(restoreHostCrypto);

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const migrations = readdirSync(new URL("migrations-history/s0/", root))
  .filter((name) => name.endsWith(".sql")).sort().map((name) => read(`migrations-history/s0/${name}`));
const schemas = {
  S1: read("scripts/fixtures/backend-schema/s1-compatibility-bridge.sql"),
  S2: read("scripts/fixtures/backend-schema/s2-final-schema.sql"),
};
const retainedSql = `
UPDATE samples SET process_revision = 37 WHERE id = 'reference-sample-a';
UPDATE run_step_comments SET body = 'Retired duplicate must never become visible'
  WHERE submission_id = 'reference-comment';
INSERT INTO run_step_comments (id, run_step_id, scope, body, actor_email, created_at)
VALUES ('contracted-retained-legacy', 'reference-step-a', 'individual',
  'Retained legacy observation 中文', 'retained@example.test', '2026-08-01T04:30:00.000Z');
`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=", "base64");
const plain = (value) => JSON.parse(JSON.stringify(value));
const runtimes = new Map();
let worker;

// Use SQLite's returned rows and total change count, including AFTER triggers,
// so the local adapter cannot hide D1's INSERT RETURNING settlement behavior.
function hostD1(native) {
  const prepare = (sql, bindings = []) => {
    function execute() {
      const statement = native.prepare(sql);
      const beforeChanges = native.prepare("SELECT total_changes() AS value").get().value;
      const results = statement.columns().length ? plain(statement.all(...bindings)) : (statement.run(...bindings), []);
      const afterChanges = native.prepare("SELECT total_changes() AS value").get().value;
      return { success: true, results, meta: { changes: Number(afterChanges - beforeChanges) } };
    }
    return {
      bind: (...values) => prepare(sql, values),
      all: async () => ({ success: true, results: plain(native.prepare(sql).all(...bindings)), meta: { changes: 0 } }),
      first: async () => plain(native.prepare(sql).get(...bindings) ?? null),
      run: async () => execute(),
      execute,
    };
  };
  const adapter = {
    native, prepare,
    loseNextBatchAcknowledgement: false,
    async batch(statements) {
      native.exec("BEGIN");
      let results;
      try {
        results = statements.map((statement) => statement.execute());
        native.exec("COMMIT");
      } catch (error) { native.exec("ROLLBACK"); throw error; }
      if (adapter.loseNextBatchAcknowledgement) {
        adapter.loseNextBatchAcknowledgement = false;
        const error = new Error("Qualification: D1 committed but its response was lost");
        error.stack = error.message;
        throw error;
      }
      return results;
    },
  };
  return adapter;
}

async function apply(database, sql) {
  if (database.native) {
    database.native.exec("BEGIN");
    try { database.native.exec(sql); database.native.exec("COMMIT"); }
    catch (error) { database.native.exec("ROLLBACK"); throw error; }
  } else await database.batch(splitSql(sql).map((statement) => database.prepare(statement)));
}

function hostBucket() {
  const objects = new Map();
  const object = (key) => {
    const stored = objects.get(key);
    if (!stored) return null;
    return { size: stored.bytes.byteLength, httpEtag: '"host-fixture"',
      body: new Response(stored.bytes).body,
      writeHttpMetadata(headers) { headers.set("content-type", stored.contentType); },
    };
  };
  return {
    async put(key, bytes, options) { objects.set(key, { bytes: new Uint8Array(bytes), contentType: options?.httpMetadata?.contentType || "application/octet-stream" }); },
    async get(key) { return object(key); }, async head(key) { return object(key); },
    async delete(key) { objects.delete(key); },
  };
}

async function fixture(stage, engine) {
  const runtime = runtimes.get(stage);
  const database = engine === "SQLite" ? hostD1(new DatabaseSync(":memory:")) : await runtime.getD1Database("DB");
  for (const migration of migrations) await apply(database, migration);
  await apply(database, read("worker/fixtures/reference-graph-s0.sql") + retainedSql);
  await apply(database, schemas.S1);
  if (stage === "S2") await apply(database, schemas.S2);
  const bucket = engine === "SQLite" ? hostBucket() : await runtime.getR2Bucket("ASSETS");
  await bucket.put("reference/private/comment.png", new Uint8Array(10), { httpMetadata: { contentType: "image/png" } });
  const request = (path, method = "GET", body, headers) => {
    const init = { method, ...(body === undefined ? {} : headers
      ? { headers, body }
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) };
    return engine === "SQLite"
      ? worker.fetch(new Request(`https://app.test/api${path}`, init), { AUTH_MODE: "disabled", DB: database, ASSETS: bucket }, { waitUntil() {}, passThroughOnException() {} })
      : runtime.dispatchFetch(`https://app.test/api${path}`, init);
  };
  const rows = async (sql, ...bindings) => (await database.prepare(sql).bind(...bindings).all()).results;
  const one = async (sql, ...bindings) => database.prepare(sql).bind(...bindings).first();
  const targets = async (scope) => Promise.all((scope === "common" ? ["a", "b"] : ["a"]).map(async (suffix) => ({
    sampleId: `reference-sample-${suffix}`, runId: `reference-run-${suffix}`, stepId: `reference-step-${suffix}`,
    expectedUpdatedAt: (await one("SELECT updated_at FROM run_steps WHERE id = ?", `reference-step-${suffix}`)).updated_at,
  })));
  const snapshot = async () => {
    const tables = (await rows("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_cf_METADATA' ORDER BY name")).map(({ name }) => name);
    return Object.fromEntries(await Promise.all(tables.map(async (name) => [name, (await rows(`SELECT * FROM "${name}"`)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])));
  };
  return { stage, database, request, rows, one, targets, snapshot, close: () => database.native?.close() };
}

async function json(response, status, label) {
  const text = await response.text();
  assert.equal(response.status, status, `${label}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function detail(f, sample = "reference-sample-a") {
  const data = await json(await f.request(`/samples/${sample}`), 200, "Sample detail");
  return data.runs.flatMap((run) => run.steps.flatMap((step) => step.comments));
}

async function resolve(f, occurrenceId) {
  const result = await json(await f.request("/references/resolve", "POST", { targets: [{ type: "comment_occurrence", id: occurrenceId }] }), 200, "Reference resolve");
  return result.results[0];
}

async function search(f, query) {
  const result = await json(await f.request("/references/search", "POST", { query, types: ["comment", "comment_occurrence"], limit: 50 }), 200, "Reference search");
  return result.results.map(({ target }) => target.id);
}

async function lifecycle(f, occurrenceIds, body) {
  const original = await f.rows("SELECT * FROM run_step_comments WHERE id IN (" + occurrenceIds.map(() => "?").join(",") + ") ORDER BY id", ...occurrenceIds);
  const oldEvents = new Set((await f.rows("SELECT id FROM events")).map(({ id }) => id));
  const deleted = await json(await f.request(`/run-step-comments/${occurrenceIds[0]}`, "DELETE"), 200, "Delete occurrence");
  assert.equal(deleted.deleted, occurrenceIds.length);
  const tombstones = await f.rows("SELECT * FROM run_step_comments WHERE id IN (" + occurrenceIds.map(() => "?").join(",") + ") ORDER BY id", ...occurrenceIds);
  assert(tombstones.every((row) => row.deleted_at && row.deletion_operation_id));
  assert.equal(new Set(tombstones.map(({ deletion_operation_id }) => deletion_operation_id)).size, 1);
  assert.deepEqual(tombstones.map(({ id, submission_id, legacy_body }) => ({ id, submission_id, legacy_body })), original.map(({ id, submission_id, legacy_body }) => ({ id, submission_id, legacy_body })));
  await json(await f.request(`/run-step-comments/${occurrenceIds[0]}/restore`, "POST"), 200, "Restore occurrence");
  const restored = await f.rows("SELECT id, submission_id, legacy_body, deleted_at FROM run_step_comments WHERE id IN (" + occurrenceIds.map(() => "?").join(",") + ") ORDER BY id", ...occurrenceIds);
  assert.deepEqual(restored, original.map(({ id, submission_id, legacy_body }) => ({ id, submission_id, legacy_body, deleted_at: null })));
  const events = (await f.rows("SELECT id, body FROM events")).filter(({ id }) => !oldEvents.has(id));
  assert.equal(events.length, occurrenceIds.length * 2);
  assert(events.every((event) => !event.body.includes("Retired duplicate") && (!body || event.body.includes(body))));
}

async function qualifyRetainedReads(f) {
  const before = await f.snapshot();
  const comments = await detail(f);
  assert.equal(comments.find(({ id }) => id === "reference-comment-occurrence-a").body, "Shared reference Comment body");
  assert.equal(comments.find(({ id }) => id === "contracted-retained-legacy").body, "Retained legacy observation 中文");
  assert.equal((await resolve(f, "reference-comment-occurrence-a")).source.excerpt, "Shared reference Comment body");
  assert.equal((await resolve(f, "contracted-retained-legacy")).source.excerpt, "Retained legacy observation 中文");
  assert.deepEqual(await search(f, "Shared reference Comment body"), ["reference-comment"]);
  assert.deepEqual(await search(f, "Retained legacy observation 中文"), ["contracted-retained-legacy"]);
  assert.deepEqual(await search(f, "Retired duplicate"), []);
  assert.deepEqual(await f.snapshot(), before, "reads preserve all retained data exactly");
}

async function qualifyLegacy(f, scope, imageOnly) {
  const body = imageOnly ? "" : `Clegacy${scope}observation 中文`;
  const input = { scope, body, targets: await f.targets(scope), ...(imageOnly ? { assetKey: "reference/private/comment.png" } : {}) };
  const created = await json(await f.request("/run-step-comments", "POST", input), 201, "Create legacy occurrence");
  const occurrences = await f.rows("SELECT * FROM run_step_comments WHERE operation_group_id = ? ORDER BY id", created.operationGroupId);
  assert.equal(occurrences.length, scope === "common" ? 2 : 1);
  assert(occurrences.every((row) => row.submission_id === null && row.legacy_body === body));
  assert(occurrences.every((row) => f.stage === "S1" ? row.body === "" : !Object.hasOwn(row, "body")), "C never writes retired duplicate text");
  const ids = occurrences.map(({ id }) => id);
  assert.equal((await detail(f)).find((comment) => ids.includes(comment.id)).body, body);
  assert.equal((await resolve(f, ids[0])).source.excerpt, body || null);
  if (body) assert.deepEqual((await search(f, body.split(" ")[0])).sort(), [...ids].sort());
  if (imageOnly) {
    await json(await f.request(`/run-step-comments/${ids[0]}/asset`, "DELETE"), 200, "Delete legacy image");
    const imageTombstones = await f.rows("SELECT asset_deleted_at, asset_deletion_operation_id, deleted_at FROM run_step_comments WHERE operation_group_id = ?", created.operationGroupId);
    assert(imageTombstones.every((row) => row.asset_deleted_at && row.asset_deletion_operation_id && row.deleted_at === null));
    assert.equal(new Set(imageTombstones.map(({ asset_deletion_operation_id }) => asset_deletion_operation_id)).size, 1);
    await json(await f.request(`/run-step-comments/${ids[0]}/asset/restore`, "POST"), 200, "Restore legacy image");
    assert((await f.rows("SELECT asset_deleted_at FROM run_step_comments WHERE operation_group_id = ?", created.operationGroupId)).every((row) => row.asset_deleted_at === null));
  }
  await lifecycle(f, ids, body);
}

async function qualifyCanonical(f, scope, imageOnly) {
  const id = `contracted-canonical-${scope}-${imageOnly ? "image" : "text"}`;
  const itemId = `${id}-item`;
  const body = imageOnly ? "" : `Ccanonical${scope}observation 中文`;
  const input = { id, body, context: { kind: "run_steps", scope, targets: await f.targets(scope) }, items: imageOnly ? [{
    id: itemId, kind: "comment_image", filename: "pixel.png", mimeType: "image/png", byteSize: png.length,
    originalFilename: "pixel.png", originalMimeType: "image/png", originalByteSize: png.length,
  }] : [] };
  await json(await f.request("/comment-submissions", "POST", input), 201, "Create canonical submission");
  if (imageOnly) await json(await f.request(`/comment-submissions/${id}/items/${itemId}/content`, "PUT", png, {
    "content-type": "image/png", "x-upload-size": String(png.length),
  }), 200, "Upload canonical image bytes");
  const lostAcknowledgement = Boolean(f.database.native && scope === "individual" && !imageOnly);
  if (lostAcknowledgement) f.database.loseNextBatchAcknowledgement = true;
  await json(await f.request(`/comment-submissions/${id}/finalize`, "POST"), lostAcknowledgement ? 500 : 200, "Finalize canonical submission");
  // The client may lose the successful finalization response. Repeating the
  // original operation must leave occurrence IDs, mutation IDs and events exact.
  const acknowledged = await f.snapshot();
  await json(await f.request(`/comment-submissions/${id}/finalize`, "POST"), 200, "Retry canonical finalization");
  assert.deepEqual(await f.snapshot(), acknowledged, "finalize retry has no duplicate side effects");
  const occurrences = await f.rows("SELECT * FROM run_step_comments WHERE submission_id = ? ORDER BY id", id);
  assert.equal(occurrences.length, scope === "common" ? 2 : 1);
  assert(occurrences.every((row) => row.legacy_body === null));
  assert(occurrences.every((row) => f.stage === "S1" ? row.body === "" : !Object.hasOwn(row, "body")));
  const ids = occurrences.map(({ id: occurrenceId }) => occurrenceId);
  assert.equal((await detail(f)).find((comment) => ids.includes(comment.id)).body, body);
  assert.equal((await resolve(f, ids[0])).source.excerpt, body || null);
  if (body) assert.deepEqual(await search(f, body.split(" ")[0]), [id]);
  const submission = await f.one("SELECT * FROM comment_submissions WHERE id = ?", id);
  await lifecycle(f, ids, body);
  assert.deepEqual(await f.one("SELECT * FROM comment_submissions WHERE id = ?", id), submission, "occurrence lifecycle preserves canonical submission identity");
  if (imageOnly) {
    await json(await f.request(`/comment-submissions/${id}/items/${itemId}`, "DELETE"), 200, "Delete canonical image");
    assert((await f.one("SELECT deleted_at FROM comment_submission_items WHERE id = ?", itemId)).deleted_at);
    await json(await f.request(`/comment-submissions/${id}/items/${itemId}/restore`, "POST"), 200, "Restore canonical image");
    assert.equal((await f.one("SELECT deleted_at FROM comment_submission_items WHERE id = ?", itemId)).deleted_at, null);
  }
  await json(await f.request(`/comment-submissions/${id}`, "DELETE"), 200, "Delete canonical submission");
  const deleted = await f.one("SELECT deleted_at, deletion_operation_id FROM comment_submissions WHERE id = ?", id);
  assert(deleted.deleted_at && deleted.deletion_operation_id);
  await json(await f.request(`/comment-submissions/${id}/restore`, "POST"), 200, "Restore canonical submission");
  assert.equal((await f.one("SELECT deleted_at FROM comment_submissions WHERE id = ?", id)).deleted_at, null);
  assert.deepEqual((await f.rows("SELECT id FROM run_step_comments WHERE submission_id = ? ORDER BY id", id)).map((row) => row.id), ids);
}

async function qualifyGuards(f) {
  const stale = (await f.targets("common")).map((target, index) => index ? target : { ...target, expectedUpdatedAt: "stale" });
  const before = await f.snapshot();
  await json(await f.request("/run-step-comments", "POST", { scope: "common", body: "Must not partially write", targets: stale }), 404, "Reject stale common legacy write");
  await json(await f.request("/comment-submissions", "POST", { id: "contracted-stale-targets", body: "Must not partially write", context: { kind: "run_steps", scope: "common", targets: stale }, items: [] }), 409, "Reject stale canonical write");
  assert.deepEqual(await f.snapshot(), before, "stale target guards preserve all rows");
  await json(await f.request("/comment-submissions", "POST", { id: "contracted-trash-targets", body: "Must not finalize after trash", context: { kind: "run_steps", scope: "common", targets: await f.targets("common") }, items: [] }), 201, "Create pending before target trash");
  await f.database.prepare("UPDATE runs SET deleted_at = '2026-09-13T00:00:00.000Z', deleted_by = 'qualification' WHERE id = 'reference-run-b'").run();
  const trashed = await f.snapshot();
  await json(await f.request("/comment-submissions/contracted-trash-targets/finalize", "POST"), 409, "Reject finalization after target trash");
  assert.deepEqual(await f.snapshot(), trashed, "hidden target cannot leave partially finalized rows");
  assert.deepEqual(await f.rows("PRAGMA foreign_key_check"), []);
  assert.deepEqual(await f.rows("PRAGMA quick_check"), [{ quick_check: "ok" }]);
}

before(async () => {
  const bundle = await build({ entryPoints: [new URL("worker/index.ts", root).pathname], write: false, bundle: true,
    format: "esm", platform: "browser", target: "es2022", conditions: ["workerd", "worker", "browser"], logLevel: "silent" });
  const script = bundle.outputFiles[0].text;
  worker = (await import(`data:text/javascript;base64,${Buffer.from(script).toString("base64")}`)).default;
  for (const stage of ["S1", "S2"]) runtimes.set(stage, new Miniflare({ modules: true, script, compatibilityDate: "2026-07-20",
    bindings: { AUTH_MODE: "disabled" }, d1Databases: ["DB"], r2Buckets: ["ASSETS"], log: new Log(LogLevel.ERROR) }));
});
after(async () => { await Promise.all([...runtimes.values()].map((runtime) => runtime.dispose())); });

for (const stage of ["S1", "S2"]) for (const engine of ["SQLite", "workerd D1"]) {
  test(`C actual Worker APIs preserve text ownership and lifecycle on ${stage} / ${engine}`, { timeout: 60_000 }, async () => {
    const f = await fixture(stage, engine);
    try {
      await qualifyRetainedReads(f);
      for (const scope of ["individual", "common"]) for (const imageOnly of [false, true]) {
        await qualifyLegacy(f, scope, imageOnly);
        await qualifyCanonical(f, scope, imageOnly);
      }
      await qualifyGuards(f);
    } finally { f.close(); }
  });
}
