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
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const requestId = "8c4d5fab-6bdd-4486-81b1-76daa781938a";
const otherRequestId = "8c4d5fab-6bdd-4486-81b1-76daa781938b";
const table = "metrology_reference_upload_requests";
const migration = "0005_metrology_reference_acceptance.sql";
const namespace = JSON.stringify({ kind: "local-r2", installationId: "b72529f0-273b-4b72-9fc7-155a93461d83", bucketName: "fixture-assets" });
const modes = ["replay", "concurrent", "concurrent-distinct", "held-pending", "lost-acceptance-ack", "lost-finalization-ack", "lost-http-ack",
  "failed-put", "unavailable-read", "missing-header", "invalid-header", "missing-namespace", "namespace-change", "missing-profile", "expired",
  "gc-unavailable", "quarantine-unavailable", "actor-independent", "deduplicated", "reuse-active", "restore-deleted", "later-delete", "restore-race",
  "delete-during-put", "archive-during-put", "finalization-rejected", "finalization-zero-row", "large-body", "oversized-body", "empty-body"];
const bindings = Object.fromEntries(modes.map((mode, index) => [mode, `DB_${index}`]));
const oldTables = ["samples", "assets", "events", "imports", "recipe_families", "template_versions", "metrology_template_references",
  "storage_profiles", "files", "file_locations", "legacy_file_mappings", "r2_upload_requests"];
const typedFileSlots = [
  ["state_representation_assets", "file_id"], ["run_step_assets", "file_id"],
  ["metrology_template_references", "file_id"], ["run_step_comments", "file_id"],
  ["state_verifications", "evidence_file_id"], ["comment_submission_items", "file_id"],
  ["project_content_attachments", "file_id"], ["attachment_derivatives", "derived_file_id"],
  ["events", "asset_file_id"], ["events", "thumbnail_file_id"],
  ["imports", "workbook_file_id"], ["imports", "manifest_file_id"], ["template_versions", "source_file_id"],
];

function assertLegacyFileAuthority(database) {
  assert.deepEqual(plain(database.prepare("SELECT singleton, mode, revision, activated_at FROM file_authority_control").get()),
    { singleton: 1, mode: "legacy", revision: 1, activated_at: null });
  assert.equal(typedFileSlots.length, 13);
  for (const [name, column] of typedFileSlots) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM "${name}" WHERE "${column}" IS NOT NULL`).get().count, 0,
      `${name}.${column} remains null after restore`);
  }
}
function hostAdapter(database) {
  const prepare = (sql, values = []) => ({
    bind(...bindings) { return prepare(sql, bindings); },
    async all() { return this.execute(); },
    async first() { return plain(database.prepare(sql).get(...values) ?? null); },
    async run() { return this.execute(); },
    execute() {
      const statement = database.prepare(sql);
      return statement.columns().length ? { success: true, results: plain(statement.all(...values)), meta: { changes: 0 } }
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
async function rows(db, name) { return (await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results; }
async function seedBeforeUpgrade(db) {
  for (const name of readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql") && name < migration).sort()) await apply(db, read(`migrations/${name}`));
  await apply(db, `
    INSERT INTO samples (id, code, title, created_at, updated_at) VALUES ('previous-sample', 'PREVIOUS', 'Previous sample', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, sha256, status, created_at)
      VALUES ('previous-asset', 'previous/image', 'previous.png', 'image/png', 4, '${hash("old!")}', 'ready', '2026-08-01T00:00:00.000Z');
    INSERT INTO events (id, sample_id, kind, asset_key, created_at) VALUES ('previous-event', 'previous-sample', 'image', 'previous/image', '2026-08-01T00:00:00.000Z');
    INSERT INTO recipe_families (id, name, template_type, created_at) VALUES ('native-family', 'Native metrology', 'module', '2026-08-01T00:00:00.000Z');
    INSERT INTO template_versions (id, recipe_family_id, name, template_type, version, manifest_hash, content_json, created_at, template_kind)
      VALUES ('native-template', 'native-family', 'Native metrology', 'module', 1, '${hash("template")}', '{}', '2026-08-01T00:00:00.000Z', 'metrology'),
      ('other-template', 'native-family', 'Other metrology', 'module', 2, '${hash("other-template")}', '{}', '2026-08-01T00:00:00.000Z', 'metrology');
    INSERT INTO metrology_template_references (id, template_version_id, asset_id, display_name, position, actor_email, created_at)
      VALUES ('previous-reference', 'native-template', 'previous-asset', 'Previous reference', 0, 'owner@example.com', '2026-08-01T00:00:00.000Z');
    INSERT INTO storage_profiles VALUES ('previous-profile', 'r2', '${namespace}', 'bootstrap', NULL, 1, 'historical', '2026-08-01T00:00:00.000Z');
  `);
  const input = canonical({ schema: "r2-upload-request/1", ingress: "ordinary_image", purpose: "embedded_content", scope: "system",
    file: { originalName: "previous.png", mimeType: "image/png", byteSize: 4, sha256: hash("old!") } });
  await db.prepare(`INSERT INTO r2_upload_requests (id, actor_email, client_request_id, operation_id, ingress, purpose, request_sha256,
    request_input_json, request_scope, storage_profile_id, storage_profile_revision, storage_policy_revision,
    candidate_asset_id, candidate_object_key, status, created_at, expires_at)
    VALUES ('b8f77b62-46b7-46ba-a635-c7d9e96c541e', 'previous@example.com', 'b8f77b62-46b7-46ba-a635-c7d9e96c541f',
      'b8f77b62-46b7-46ba-a635-c7d9e96c5420', 'ordinary_image', 'embedded_content', ?, ?, 'system', 'previous-profile', 1, 1,
      'b8f77b62-46b7-46ba-a635-c7d9e96c5421', 'previous/pending', 'pending', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z')`)
    .bind(hash(input), input).run();
}
async function upgrade(db) {
  const catalog = async (exclude = false) => (await db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
    ${exclude ? `AND tbl_name <> '${table}'` : ""} ORDER BY type, name`).all()).results;
  const oldCatalog = await catalog(); const oldRows = {};
  for (const name of oldTables) oldRows[name] = await rows(db, name);
  const retention = async () => (await db.prepare("SELECT * FROM blob_retention_edges ORDER BY source_type, source_id, occurrence_type, occurrence_id").all()).results;
  const oldRetention = await retention(); await apply(db, read(`migrations/${migration}`));
  assert.deepEqual(await catalog(true), oldCatalog, "forward upgrade preserves all previous SQL definitions verbatim");
  for (const name of oldTables) assert.deepEqual(await rows(db, name), oldRows[name], name);
  assert.deepEqual(await retention(), oldRetention, "receipts add no retention roots"); assert.deepEqual(await rows(db, table), []);
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
}
const workerSource = `
import { Hono } from "hono";
import { routes } from "./worker/process-definition/routes.ts";
import { handleError } from "./worker/platform/http.ts";
import { snapshotFullExportV14 } from "./worker/export-v14-snapshot.ts";
const app = new Hono().basePath("/api"); app.onError(handleError);
app.use("*", async (c, next) => { c.set("userEmail", c.req.header("X-Fixture-Actor") || "owner@example.com"); await next(); });
app.route("/", routes);
export default { async fetch(request, env, ctx) {
  const { mode, binding, missingBytes } = await request.json(); const rawDb = env[binding];
  if (mode === "restored") {
    let puts = 0;
    const before = (await snapshotFullExportV14(rawDb)).tables;
    const routeEnv = { DB: rawDb, R2_BOOTSTRAP_NAMESPACE: ${JSON.stringify(namespace)}, ASSETS: {
      get(key) { return missingBytes ? null : env.RESTORED_BUCKET.get(key); },
      head(key) { return missingBytes ? null : env.RESTORED_BUCKET.head(key); },
      put() { puts++; throw new Error("historical receipt cannot republish bytes"); },
      delete() { throw new Error("historical receipt cannot delete bytes"); },
    } };
    const getResponse = await app.fetch(new Request("https://app.test/api/metrology-templates/native-template/reference-upload-requests/${requestId}"), routeEnv, ctx);
    const postResponse = await app.fetch(new Request("https://app.test/api/metrology-templates/native-template/references", {
      method: "POST", headers: { "Content-Type": "application/pdf", "X-Filename-Uri": encodeURIComponent("原始测量.pdf"), "X-Upload-Request-Id": "${requestId}" },
      body: new TextEncoder().encode("native metrology fixture replay"),
    }), routeEnv, ctx);
    return Response.json({ get: { status: getResponse.status, body: await getResponse.json() }, post: { status: postResponse.status, body: await postResponse.json() },
      puts, before, after: (await snapshotFullExportV14(rawDb)).tables });
  }
  const stats = { puts: [], gets: [], heads: [], deletes: 0, insertAttempts: 0, sessions: [], lostAcceptance: 0, lostFinalization: 0,
    acceptedBeforeEachPut: [], raceMutations: 0, sqlErrors: [] };
  let releaseInsert; const insertGate = new Promise(resolve => { releaseInsert = resolve; });
  let releasePut; const putGate = new Promise(resolve => { releasePut = resolve; });
  let firstPutStarted; const firstPut = new Promise(resolve => { firstPutStarted = resolve; });
  let phase = "first";
  const acceptanceSql = sql => /^\\s*INSERT INTO ${table}\\b/i.test(sql);
  const finalizationSql = sql => /UPDATE ${table}/.test(sql) && /SET status = 'ready'/.test(sql);
  function database(native) {
    function statement(sql, inner) { return { sql, inner,
      bind(...values) { return statement(sql, inner.bind(...values)); },
      async first(...args) {
        if (mode === "missing-profile" && phase === "retry" && /FROM storage_profiles/.test(sql)) return null;
        return inner.first(...args);
      }, all(...args) { return inner.all(...args); }, raw(...args) { return inner.raw(...args); },
      async run(...args) {
        if (acceptanceSql(sql)) {
          stats.insertAttempts++;
          if (["concurrent", "concurrent-distinct"].includes(mode) && phase === "first") {
            if (stats.insertAttempts === 2) releaseInsert(); await insertGate;
          }
        }
        let result; try { result = await inner.run(...args); } catch (error) { stats.sqlErrors.push({sql, error: String(error)}); throw error; }
        if (acceptanceSql(sql) && mode === "lost-acceptance-ack" && stats.lostAcceptance++ === 0) throw new Error("PRIVATE_PROVIDER_ERROR lost committed acceptance");
        if (finalizationSql(sql) && mode === "lost-finalization-ack" && stats.lostFinalization++ === 0) throw new Error("PRIVATE_PROVIDER_ERROR lost committed finalization");
        return result;
      }
    }; }
    return { prepare(sql) { return statement(sql, native.prepare(sql)); },
      withSession(constraint) { stats.sessions.push(constraint); return database(typeof native.withSession === "function" ? native.withSession(constraint) : native); },
      async batch(statements) {
        const result = await native.batch(statements.map(item => item.inner));
        if (mode === "lost-finalization-ack" && !stats.lostFinalization && statements.some(item => finalizationSql(item.sql))) {
          stats.lostFinalization++; throw new Error("PRIVATE_PROVIDER_ERROR lost committed finalization");
        }
        return result;
      }
    };
  }
  async function raceRestore() {
    if (mode !== "restore-race" || stats.raceMutations || phase !== "first") return;
    const accepted = await rawDb.prepare("SELECT COUNT(*) AS n FROM ${table}").first();
    if (!accepted.n) return;
    await rawDb.prepare("UPDATE metrology_template_references SET display_name = 'Changed elsewhere' WHERE id = 'reusable-reference'").run();
    stats.raceMutations++;
  }
  const bucket = {
    async put(key, bytes, options) {
      stats.puts.push(key);
      stats.acceptedBeforeEachPut.push(await rawDb.prepare("SELECT * FROM ${table} ORDER BY rowid").all());
      if (mode === "held-pending" && stats.puts.length === 1) { firstPutStarted(); await putGate; }
      if (mode === "delete-during-put") await rawDb.prepare("UPDATE template_versions SET deleted_at = ?, deleted_by = 'other@example.com' WHERE id = 'native-template'").bind(new Date().toISOString()).run();
      if (mode === "archive-during-put") await rawDb.prepare("UPDATE template_versions SET archived_at = ?, archived_by = 'other@example.com' WHERE id = 'native-template'").bind(new Date().toISOString()).run();
      if (mode === "failed-put") throw new Error("PRIVATE_PROVIDER_ERROR provider unavailable before PUT");
      const result = await env.BUCKET.put(key, bytes, options);
      if (mode === "unavailable-read") throw new Error("PRIVATE_PROVIDER_ERROR uncertain provider PUT");
      return result;
    },
    async get(key, options) { stats.gets.push(key); await raceRestore(); if (mode === "unavailable-read") throw new Error("PRIVATE_PROVIDER_ERROR unavailable GET"); return env.BUCKET.get(key, options); },
    async head(key) { stats.heads.push(key); await raceRestore(); if (mode === "unavailable-read") throw new Error("PRIVATE_PROVIDER_ERROR unavailable HEAD"); return env.BUCKET.head(key); },
    async delete() { stats.deletes++; throw new Error("upload receipt cannot delete bytes"); },
  };
  const routeEnv = { DB: database(rawDb), ASSETS: bucket, AUTH_MODE: "disabled", R2_BOOTSTRAP_NAMESPACE: mode === "missing-namespace" ? undefined : ${JSON.stringify(namespace)} };
  const bytes = mode === "large-body" ? new Uint8Array(25 * 1024 * 1024).fill(37)
    : mode === "oversized-body" ? new Uint8Array(25 * 1024 * 1024 + 1).fill(38)
    : mode === "empty-body" ? new Uint8Array() : new TextEncoder().encode("native metrology fixture " + mode);
  async function sha(value) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))].map(value => value.toString(16).padStart(2, "0")).join(""); }
  await env.BUCKET.put("previous/image", new TextEncoder().encode("old!"));
  if (["deduplicated", "reuse-active", "restore-deleted", "later-delete", "restore-race"].includes(mode)) {
    await env.BUCKET.put("reusable-" + mode, bytes);
    await rawDb.prepare("INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, sha256, status, created_at) VALUES ('reusable-asset', ?, 'previous.pdf', 'application/pdf', ?, ?, 'ready', '2026-08-01T00:00:00.000Z')")
      .bind("reusable-" + mode, bytes.byteLength, await sha(bytes)).run();
    if (mode !== "deduplicated") await rawDb.prepare("INSERT INTO metrology_template_references (id, template_version_id, asset_id, display_name, position, actor_email, created_at, deleted_at, deleted_by) VALUES ('reusable-reference', 'native-template', 'reusable-asset', 'Previous label', 1, 'previous@example.com', '2026-08-01T00:00:00.000Z', ?, ?)")
      .bind(mode === "reuse-active" ? null : "2026-08-02T00:00:00.000Z", mode === "reuse-active" ? null : "previous@example.com").run();
  }
  if (["finalization-rejected", "finalization-zero-row"].includes(mode)) {
    await rawDb.prepare("CREATE TRIGGER qualification_reject_receipt BEFORE UPDATE OF status ON ${table} WHEN NEW.status = 'ready' BEGIN SELECT RAISE(" + (mode === "finalization-rejected" ? "ABORT, 'qualification publication rejected'" : "IGNORE") + "); END;").run();
  }
  async function post(options = {}) {
    const headers = new Headers({ "Content-Type": options.mime || "application/pdf", "X-Fixture-Actor": options.actor || "owner@example.com", "X-Filename-Uri": encodeURIComponent(options.filename || "原始测量.pdf") });
    if (!options.omitHeader) headers.set("X-Upload-Request-Id", options.requestId || ${JSON.stringify(requestId)});
    const response = await app.fetch(new Request("https://app.test/api/metrology-templates/" + (options.templateId || "native-template") + "/references", {
      method: "POST", headers, body: options.changed ? new Uint8Array([...bytes, 42]) : bytes,
    }), routeEnv, ctx);
    if (mode === "lost-http-ack" && phase === "first") { await response.arrayBuffer(); return { status: 0, body: null }; }
    return { status: response.status, body: await response.json() };
  }
  async function poll(actor = "owner@example.com", templateId = "native-template") {
    const response = await app.fetch(new Request("https://app.test/api/metrology-templates/" + templateId + "/reference-upload-requests/" + ${JSON.stringify(requestId)}, { headers: { "X-Fixture-Actor": actor } }), routeEnv, ctx);
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get("cache-control") };
  }
  async function snapshot() {
    const result = {};
    for (const name of ["${table}", "assets", "metrology_template_references", "template_versions", "storage_profiles", "blob_gc_ledger", "blob_integrity_quarantine"])
      result[name] = (await rawDb.prepare("SELECT * FROM " + name + " ORDER BY rowid").all()).results;
    return result;
  }
  const io = () => ({ puts: [...stats.puts], gets: [...stats.gets], heads: [...stats.heads], deletes: stats.deletes });
  const before = await snapshot(); const missing = await poll(); let first; let pending = null; let pendingPoll = null; let pendingIo = null;
  if (["concurrent", "concurrent-distinct"].includes(mode)) first = await Promise.all([post(), post({ requestId: mode === "concurrent" ? ${JSON.stringify(requestId)} : ${JSON.stringify(otherRequestId)} })]);
  else if (mode === "held-pending") {
    const running = post(); await firstPut; const beforePending = io(); pending = await post(); pendingPoll = await poll(); pendingIo = { before: beforePending, after: io() };
    releasePut(); first = await running;
  } else first = await post({ omitHeader: mode === "missing-header", requestId: mode === "invalid-header" ? "invalid" : undefined });
  phase = "retry";
  const afterFirst = await snapshot(); const firstIo = io(); const originalDate = Date;
  if (mode === "expired") globalThis.Date = class extends originalDate {
    constructor(...args) { super(...(args.length ? args : [originalDate.now() + 86400001])); }
    static now() { return originalDate.now() + 86400001; }
  };
  try {
    if (mode === "namespace-change") routeEnv.R2_BOOTSTRAP_NAMESPACE = JSON.stringify({ kind: "local-r2", installationId: "b72529f0-273b-4b72-9fc7-155a93461d83", bucketName: "different-bucket" });
    const receipt = afterFirst.${table}.find(row => row.client_request_id === ${JSON.stringify(requestId)});
    const accepted = receipt?.accepted_result_json ? JSON.parse(receipt.accepted_result_json) : null;
    if (mode === "gc-unavailable") await rawDb.prepare("INSERT INTO blob_gc_ledger (store_kind, provider, object_key, state, operation_id, updated_at) VALUES ('r2', 'r2', ?, 'deleted', 'qualification-gc', ?)").bind(accepted.reference.assetKey, new Date().toISOString()).run();
    if (mode === "quarantine-unavailable") await rawDb.prepare("INSERT INTO blob_integrity_quarantine (store_kind, provider, object_key, reason, expected_byte_size, observed_byte_size, operation_id, detected_at, last_checked_at) VALUES ('r2', 'r2', ?, 'size_mismatch', ?, ?, 'qualification-quarantine', ?, ?)").bind(accepted.reference.assetKey, bytes.byteLength, bytes.byteLength + 1, new Date().toISOString(), new Date().toISOString()).run();
    if (mode === "later-delete") await rawDb.prepare("UPDATE metrology_template_references SET deleted_at = ?, deleted_by = 'later@example.com' WHERE id = ?").bind(new Date().toISOString(), accepted.reference.id).run();
    const retryBefore = await snapshot(); const state = await poll(); const otherActor = await poll("other@example.com"); const otherTemplate = await poll("owner@example.com", "other-template");
    let retry = null; const conflicts = []; let otherAcceptance = null;
    if (!["missing-header", "invalid-header", "missing-namespace", "oversized-body", "empty-body"].includes(mode)) retry = await post();
    if (mode === "replay") for (const options of [{ changed: true }, { filename: "changed.pdf" }, { mime: "text/plain" }, { templateId: "other-template" }]) conflicts.push(await post(options));
    const retryIo = io();
    if (mode === "actor-independent") otherAcceptance = await post({ actor: "other@example.com" });
    const afterRetry = await snapshot(); const physical = [];
    for (const row of afterFirst.${table}) if (row.accepted_result_json) {
      const result = JSON.parse(row.accepted_result_json); const blob = await env.BUCKET.get(result.reference.assetKey);
      physical.push({ id: result.assetId, size: blob?.size ?? null, sha256: blob ? await sha(await blob.arrayBuffer()) : null });
    }
    return Response.json({ before, missing, first, pending, pendingPoll, pendingIo, afterFirst, firstIo, retryBefore, state, otherActor, otherTemplate,
      retry, conflicts, retryIo, otherAcceptance, afterRetry, physical, stats, archive: mode === "replay" ? await snapshotFullExportV14(rawDb) : null });
  } finally { globalThis.Date = originalDate; }
} };
`;
async function bundle(source, platform = "neutral") {
  return (await build({ stdin: { contents: source, resolveDir: root, sourcefile: "fp1-metrology-reference-qualification.ts" },
    bundle: true, format: "esm", platform, write: false,
    ...(platform === "node" ? { banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } } : {}),
  })).outputFiles[0].text;
}
async function insertRow(db, name, row) {
  const columns = Object.keys(row);
  await db.prepare(`INSERT INTO ${name} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).bind(...columns.map((column) => row[column])).run();
}
async function qualifySqlGuards(db, fixture) {
  const ready = fixture.afterFirst[table][0]; const pending = fixture.stats.acceptedBeforeEachPut[0].results[0];
  const profile = fixture.afterFirst.storage_profiles.find((row) => row.id === ready.storage_profile_id);
  assert.deepEqual((await rows(db, "storage_profiles")).find((row) => row.id === profile.id), profile);
  const malformed = { ...pending, publication_plan_json: '{"schema":"metrology-reference-publication/1","action":"create","unexpected":null}' };
  await assert.rejects(insertRow(db, table, malformed), /constraint|publication|plan/i, "missing plan members cannot bypass SQL checks through NULL");
  assert.deepEqual(await rows(db, table), []);
  await insertRow(db, table, pending);
  for (const sql of [
    `UPDATE ${table} SET template_version_id = 'other-template'`, `UPDATE ${table} SET candidate_reference_id = '${otherRequestId}'`,
    `UPDATE ${table} SET publication_plan_json = '{}'`, `UPDATE ${table} SET candidate_object_key = 'elsewhere'`,
    `UPDATE ${table} SET actor_email = 'other@example.com'`, `UPDATE ${table} SET expires_at = '2026-09-16T00:00:00.000Z'`,
    `UPDATE ${table} SET request_sha256 = '${"b".repeat(64)}'`, `DELETE FROM ${table}`, `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`,
  ]) {
    await assert.rejects(db.prepare(sql).run(), /immutable|cannot be deleted|constraint|publication/i, sql);
    assert.deepEqual(await rows(db, table), [pending]);
  }
  const publish = () => db.prepare(`UPDATE ${table} SET status = 'ready', completed_at = ?, accepted_result_json = ? WHERE id = ?`)
    .bind(ready.completed_at, ready.accepted_result_json, ready.id).run();
  await assert.rejects(publish(), /publication/i, "a receipt cannot authorize a missing asset or occurrence");
  const accepted = JSON.parse(ready.accepted_result_json);
  await insertRow(db, "assets", fixture.afterFirst.assets.find((row) => row.id === accepted.assetId));
  await assert.rejects(publish(), /publication/i, "a ready asset alone cannot publish the occurrence result");
  await insertRow(db, "metrology_template_references", fixture.afterFirst.metrology_template_references.find((row) => row.id === accepted.reference.id));
  await publish(); assert.deepEqual(await rows(db, table), [ready]);
  for (const sql of [`UPDATE ${table} SET status = 'pending', completed_at = NULL, accepted_result_json = NULL`,
    `UPDATE ${table} SET accepted_result_json = '{}'`, `DELETE FROM ${table}`, `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`]) {
    await assert.rejects(db.prepare(sql).run(), /immutable|cannot be deleted|constraint|publication/i, sql);
    assert.deepEqual(await rows(db, table), [ready]);
  }
  const retained = (await db.prepare("SELECT occurrence_type FROM blob_retention_edges WHERE object_key = ?").bind(accepted.reference.assetKey).all()).results;
  assert.deepEqual(retained, [{ occurrence_type: "metrology_template_reference" }], "only the domain occurrence retains bytes");
}
async function qualifyRestore(mf, scratch, fixture) {
  const source = `export { snapshotFullExportV14 } from './worker/export-v14-snapshot.ts'; export { buildFullExportArchiveV14 } from './src/lib/exportAll.ts'; export { restoreExportToIsolatedDirectory } from './scripts/lib/export-restore.ts';`;
  const modulePath = join(scratch, "restore-qualification.mjs"); await writeFile(modulePath, await bundle(source, "node"));
  const service = await import(pathToFileURL(modulePath).href); const byUrl = new Map(fixture.archive.blobs.map((blob) => [blob.downloadUrl, blob]));
  const archive = await service.buildFullExportArchiveV14(fixture.archive, undefined, async (url) => {
    const blob = byUrl.get(String(url)); const stored = blob && await (await mf.getR2Bucket("BUCKET")).get(blob.objectKey);
    return stored ? new Response(await stored.arrayBuffer()) : new Response(null, { status: 404 });
  });
  const archivePath = join(scratch, "recovery-contract.zip"); await writeFile(archivePath, Buffer.from(await archive.archive.arrayBuffer()));
  const originalHash = hash(await readFile(archivePath));
  const restored = await service.restoreExportToIsolatedDirectory({ archivePath, destination: join(scratch, "restored"), migrationsDirectory: join(root, "migrations"), targetCompatibilitySchema: "S2" });
  assert.equal(restored.report.schemaVersion, 14); assert.equal(restored.report.archiveProfile, "fp1-file-authority-transition");
  assert.deepEqual(restored.report.appliedForwardMigrations, []);
  assert.equal(restored.report.verification.rowsEqual, true); assert.equal(restored.report.verification.foreignKeys, true);
  assert(restored.report.restoredBlobCount > 0);
  const recovered = new DatabaseSync(join(restored.restoredDirectory, "database.sqlite"));
  try {
    assertLegacyFileAuthority(recovered);
    const snapshot = await service.snapshotFullExportV14(hostAdapter(recovered));
    assert.deepEqual(snapshot.tables, fixture.archive.tables, "nonempty D1 V14 restores previous history and new receipt rows exactly");
    assert.deepEqual(snapshot.tables[table], fixture.afterFirst[table]);
    const providerManifest = JSON.parse(await readFile(join(restored.restoredDirectory, "provider-manifest.json"), "utf8"));
    const restoredBucket = await mf.getR2Bucket("RESTORED_BUCKET");
    for (const entry of providerManifest) if (entry.path) await restoredBucket.put(entry.objectKey, await readFile(join(restored.restoredDirectory, entry.path)));
    // Build a separate, empty D1 instance from the isolated restore's exact SQL
    // and rows. Guards are installed after row loading, as in isolated restore;
    // no guard is removed or disabled in an existing database.
    const restoredDb = await mf.getD1Database("DB_RESTORED");
    const catalog = recovered.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name").all();
    const statements = [restoredDb.prepare("PRAGMA defer_foreign_keys = ON")];
    for (const definition of catalog.filter((row) => row.type === "table")) statements.push(restoredDb.prepare(definition.sql));
    for (const definition of catalog.filter((row) => row.type === "table")) {
      for (const row of recovered.prepare(`SELECT * FROM "${definition.name}"`).all()
        .sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : JSON.stringify(left) > JSON.stringify(right) ? 1 : 0)) {
        const columns = Object.keys(row);
        statements.push(restoredDb.prepare(`INSERT INTO "${definition.name}" (${columns.map((name) => `"${name}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
          .bind(...columns.map((column) => row[column])));
      }
    }
    for (const definition of catalog.filter((row) => row.type !== "table")) statements.push(restoredDb.prepare(definition.sql));
    await restoredDb.batch(statements);
    assert.deepEqual((await restoredDb.prepare("PRAGMA foreign_key_check").all()).results, []);
    for (const missingBytes of [false, true]) {
      const response = await mf.dispatchFetch("https://qualification.test/", { method: "POST", body: JSON.stringify({ mode: "restored", binding: "DB_RESTORED", missingBytes }) });
      assert.equal(response.status, 200, await response.clone().text()); const observed = await response.json();
      assert.equal(observed.get.status, 200); assert.equal(observed.post.status, missingBytes ? 409 : 200);
      assert.equal(observed.get.body.request.status, missingBytes ? "unavailable" : "ready");
      assert.equal(observed.post.body.request.status, missingBytes ? "unavailable" : "ready");
      if (missingBytes) { assert.equal(observed.get.body.request.result, undefined); assert.equal(observed.post.body.reference, undefined); }
      else { assert.deepEqual(observed.get.body.request.result, JSON.parse(fixture.afterFirst[table][0].accepted_result_json)); assert.deepEqual(observed.post.body.request.result, observed.get.body.request.result); }
      assert.equal(observed.puts, 0); assert.deepEqual(observed.before, snapshot.tables); assert.deepEqual(observed.after, observed.before);
    }
    await assert.rejects(restoredDb.prepare(`DELETE FROM ${table}`).run(), /cannot be deleted/);
    await assert.rejects(restoredDb.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`).run(), /immutable|publication|constraint/i);
    assert.throws(() => recovered.exec(`DELETE FROM ${table}`), /cannot be deleted/);
    assert.throws(() => recovered.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`), /immutable|publication|constraint/i);
  } finally { recovered.close(); }
  assert.equal(hash(await readFile(archivePath)), originalHash);
}
test("metrology upload acceptance upgrades populated host SQLite without changing previous authority or retention", async () => {
  const host = new DatabaseSync(":memory:");
  try { host.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = OFF"); const db = hostAdapter(host); await seedBeforeUpgrade(db); await upgrade(db); }
  finally { host.close(); }
});
test("production metrology upload routes qualify durable publication on real workerd, D1 and R2", { timeout: 240_000 }, async (t) => {
  const mf = new Miniflare({ modules: true, script: await bundle(workerSource), compatibilityDate: "2026-07-20", r2Buckets: ["BUCKET", "RESTORED_BUCKET"],
    d1Databases: [...Object.values(bindings), "DB_GUARDS", "DB_RESTORED"], log: new Log(LogLevel.ERROR) });
  const scratch = await mkdtemp(join(tmpdir(), "fp1-metrology-reference-")); let replayFixture;
  try {
    for (const binding of [...Object.values(bindings), "DB_GUARDS"]) {
      const db = await mf.getD1Database(binding); await seedBeforeUpgrade(db); await upgrade(db);
      for (const name of readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql") && name > migration).sort()) await apply(db, read(`migrations/${name}`));
    }
    for (const mode of modes) await t.test(mode, async () => {
      const response = await mf.dispatchFetch("https://qualification.test/", { method: "POST", body: JSON.stringify({ mode, binding: bindings[mode] }) });
      assert.equal(response.status, 200, await response.clone().text()); const result = await response.json();
      assert.equal(result.missing.status, 404); assert.equal(result.otherActor.status, 404); assert.equal(result.otherTemplate.status, 404);
      assert.equal(result.stats.deletes, 0); assert(!JSON.stringify([result.first, result.state, result.retry]).includes("PRIVATE_PROVIDER_ERROR"));
      assert.equal(result.state.cacheControl, "no-store");
      assert.deepEqual(result.retryIo.puts, result.firstIo.puts, "polls, replay and conflicts never reissue PUT");
      assert.deepEqual(result.retryIo.heads, result.firstIo.heads, "replay does not resume registration");
      if (["missing-header", "invalid-header", "missing-namespace", "oversized-body", "empty-body"].includes(mode)) {
        assert.equal(result.first.status, mode === "missing-header" ? 428 : mode === "invalid-header" ? 400 : mode === "missing-namespace" ? 503 : 413);
        assert.deepEqual(result.afterFirst, result.before); assert.equal(result.stats.insertAttempts, 0);
        assert.deepEqual(result.firstIo, { puts: [], gets: [], heads: [], deletes: 0 }); return;
      }
      const receipt = result.afterFirst[table].find((row) => row.client_request_id === requestId); assert(receipt, JSON.stringify({first:result.first,sqlErrors:result.stats.sqlErrors}));
      assert.equal(receipt.actor_email, "owner@example.com"); assert.equal(receipt.template_version_id, "native-template");
      assert.equal(receipt.purpose, "research_source"); assert.equal(receipt.request_scope, "system");
      assert.equal(Date.parse(receipt.expires_at) - Date.parse(receipt.created_at), 86_400_000);
      assert.equal(receipt.request_sha256, hash(receipt.request_input_json));
      const input = JSON.parse(receipt.request_input_json); assert.equal(input.file.originalName, "原始测量.pdf");
      const expectedBytes = mode === "large-body" ? Buffer.alloc(25 * 1024 * 1024, 37) : Buffer.from("native metrology fixture " + mode);
      assert.equal(input.file.sha256, hash(expectedBytes)); assert.equal(input.file.byteSize, expectedBytes.byteLength);
      for (const observation of result.stats.acceptedBeforeEachPut) assert(observation.results.some((row) => row.status === "pending"), "acceptance precedes every provider PUT");
      if (mode !== "actor-independent") assert.deepEqual(result.afterRetry, result.retryBefore, "all observations preserve saved authority");
      if (["failed-put", "unavailable-read", "delete-during-put", "archive-during-put", "restore-race", "finalization-rejected", "finalization-zero-row"].includes(mode)) {
        assert.notEqual(receipt.status, "ready"); assert.equal(receipt.accepted_result_json, null);
        assert.equal(result.afterFirst.metrology_template_references.filter((row) => !["previous-reference", "reusable-reference"].includes(row.id)).length, 0,
          "failed or zero-row receipt finalization rolls back domain publication");
        if (mode === "restore-race") { const prior = result.afterFirst.metrology_template_references.find((row) => row.id === "reusable-reference"); assert.equal(prior.display_name, "Changed elsewhere"); assert(prior.deleted_at); assert.equal(result.stats.raceMutations, 1); }
        assert([202, 409, 503].includes(result.retry.status)); return;
      }
      if (mode === "concurrent-distinct") {
        assert.equal(result.afterFirst[table].length, 2);
        assert.equal(result.afterFirst.metrology_template_references.length, 2, "distinct requests for identical bytes publish one occurrence");
        assert(result.first.some((item) => item.status === 201));
        const readyRows = result.afterFirst[table].filter((row) => row.status === "ready");
        assert.equal(new Set(readyRows.map((row) => JSON.parse(row.accepted_result_json).reference.id)).size, 1);
        return;
      }
      assert.equal(receipt.status, "ready"); const accepted = JSON.parse(receipt.accepted_result_json);
      for (const physical of result.physical) { assert.equal(physical.size, expectedBytes.byteLength); assert.equal(physical.sha256, input.file.sha256); }
      if (["namespace-change", "missing-profile"].includes(mode)) { assert.equal(result.state.status, 503); assert.equal(result.retry.status, 503); return; }
      if (["expired", "gc-unavailable", "quarantine-unavailable", "later-delete"].includes(mode)) {
        assert.equal(result.state.body.request.status, mode === "expired" ? "expired" : "unavailable");
        assert.equal(result.state.body.request.result, undefined); assert.equal(result.retry.status, 409);
        if (mode === "later-delete") assert.equal(result.afterRetry.metrology_template_references.find((row) => row.id === "reusable-reference").deleted_by, "later@example.com");
        return;
      }
      assert.equal(result.retry.status, 200); assert.deepEqual(result.retry.body.request.result, accepted); assert.deepEqual(result.state.body.request.result, accepted);
      assert(result.stats.sessions.includes("first-primary"));
      if (mode === "concurrent") { assert.equal(result.stats.insertAttempts, 2); assert.equal(result.first.filter((item) => item.status === 201).length, 1); assert(result.first.every((item) => [200, 201, 202].includes(item.status))); }
      else assert.equal(result.first.status, mode === "lost-http-ack" ? 0 : ["reuse-active", "restore-deleted"].includes(mode) ? 200 : 201);
      assert.equal(result.firstIo.puts.length, ["deduplicated", "reuse-active", "restore-deleted", "later-delete"].includes(mode) ? 0 : 1);
      if (mode === "held-pending") { assert.equal(result.pending.status, 202); assert.equal(result.pendingPoll.body.request.status, "pending"); assert.deepEqual(result.pendingIo.before, result.pendingIo.after); }
      if (mode === "lost-acceptance-ack") assert.equal(result.stats.lostAcceptance, 1);
      if (mode === "lost-finalization-ack") assert.equal(result.stats.lostFinalization, 1);
      if (mode === "actor-independent") { assert.equal(result.otherAcceptance.status, 200); assert.equal(result.afterRetry[table].length, 2); }
      if (["reuse-active", "restore-deleted"].includes(mode)) { assert.equal(accepted.reference.id, "reusable-reference"); assert.equal(accepted.reference.filename, mode === "reuse-active" ? "Previous label" : "原始测量.pdf"); }
      assert(result.conflicts.every((item) => item.status === 409));
      if (mode === "replay") replayFixture = result;
    });
    await t.test("host and D1 reject identity replacement and invalid publication with recursive triggers disabled", async () => {
      assert(replayFixture); const host = new DatabaseSync(":memory:");
      try {
        host.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = OFF"); const db = hostAdapter(host); await seedBeforeUpgrade(db); await upgrade(db);
        for (const name of readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql") && name > migration).sort()) await apply(db, read(`migrations/${name}`));
        await qualifySqlGuards(db, replayFixture);
      }
      finally { host.close(); }
      const db = await mf.getD1Database("DB_GUARDS"); await db.prepare("PRAGMA recursive_triggers = OFF").run(); await qualifySqlGuards(db, replayFixture);
    });
    await t.test("nonempty V14 archive preserves historical receipts, legacy File authority, and installed guards on isolated restore", async () => { assert(replayFixture); await qualifyRestore(mf, scratch, replayFixture); });
  } finally { await mf.dispose(); await rm(scratch, { recursive: true, force: true }); }
});
