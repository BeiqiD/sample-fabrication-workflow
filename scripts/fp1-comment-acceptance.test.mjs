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
const submissionId = "native-comment-request";
const itemId = "native-comment-image";
const revision = "2026-08-01T00:00:00.000Z";
const migration = "0006_comment_acceptance.sql";
const parentTable = "comment_submission_acceptances";
const itemTable = "comment_item_acceptances";
const namespace = JSON.stringify({ kind: "local-r2", installationId: "b72529f0-273b-4b72-9fc7-155a93461d83", bucketName: "fixture-assets" });
const modes = ["image-replay", "ready-after-expiry", "managed-replay", "text-only", "maximum-targets-items", "concurrent-create", "concurrent-upload", "concurrent-finalize",
  "lost-create-ack", "lost-claim-ack", "lost-provider-ack", "lost-managed-provider-ack", "lost-item-ack", "lost-finalization-ack", "lost-http-ack",
  "unavailable-provider", "wrong-content-hash", "wrong-upload-header", "r2-profile-flip", "managed-profile-flip", "inflight-profile-flip",
  "remove-during-put", "cancel-during-put", "expired-before-put", "expired-during-put", "expiry-cleanup-failure",
  "unfinished-items", "finalize-gc", "finalize-quarantine", "finalize-missing", "finalize-corrupt", "target-deleted", "target-revision",
  "item-zero-row", "finalization-zero-row", "untrusted-preview", "ready-delete", "legacy-pending", "maximum-image", "maximum-managed"];
const bindings = Object.fromEntries(modes.map((mode, index) => [mode, `DB_${index}`]));
const oldTables = ["samples", "runs", "run_steps", "assets", "managed_storage_objects", "events", "run_step_comments",
  "comment_submissions", "comment_submission_items", "comment_submission_targets", "storage_profiles", "files", "file_locations",
  "legacy_file_mappings", "r2_upload_requests", "metrology_reference_upload_requests", "attachment_derivatives"];
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
  await apply(db, seedSql());
}
async function upgrade(db) {
  const catalog = async (exclude = false) => (await db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
    ${exclude ? `AND tbl_name NOT IN ('${parentTable}', '${itemTable}')` : ""} ORDER BY type, name`).all()).results;
  const oldCatalog = await catalog(); const oldRows = {};
  for (const name of oldTables) oldRows[name] = await rows(db, name);
  const retention = async () => (await db.prepare("SELECT * FROM blob_retention_edges ORDER BY source_type, source_id, occurrence_type, occurrence_id").all()).results;
  const oldRetention = await retention(); await apply(db, read(`migrations/${migration}`));
  const oldIdentities = new Set(oldCatalog.map((row) => row.type + ":" + row.name));
  const upgradedCatalog = await catalog(true);
  assert.deepEqual(upgradedCatalog.filter((row) => oldIdentities.has(row.type + ":" + row.name)), oldCatalog,
    "forward upgrade preserves all previous SQL definitions verbatim");
  const addedGuards = new Set(["comment_accepted_submission_identity_guard", "comment_accepted_submission_cancel", "comment_accepted_item_cancel",
    "comment_accepted_submission_replace_guard", "comment_accepted_item_replace_guard", "comment_accepted_target_replace_guard",
    "comment_accepted_target_update_guard", "comment_accepted_target_delete_guard", "comment_accepted_item_identity_guard"]);
  for (const definition of upgradedCatalog.filter((row) => !oldIdentities.has(row.type + ":" + row.name))) {
    assert.equal(definition.type, "trigger"); assert(addedGuards.has(definition.name), definition.name);
  }
  for (const name of oldTables) assert.deepEqual(await rows(db, name), oldRows[name], name);
  assert.deepEqual(await retention(), oldRetention, "acceptance ledgers add no retention roots");
  assert.deepEqual(await rows(db, parentTable), []); assert.deepEqual(await rows(db, itemTable), []);
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
}
function seedSql() {
  return `
    INSERT INTO recipe_families (id, name, template_type, created_at) VALUES ('native-family', 'Native Comment process', 'process', '${revision}');
    INSERT INTO template_versions (id, recipe_family_id, name, template_type, version, manifest_hash, content_json, created_at, template_kind)
      VALUES ('native-template', 'native-family', 'Native Comment process', 'process', 1, '${hash("native-template")}', '{}', '${revision}', 'process');
    INSERT INTO samples (id, code, title, created_at, updated_at) VALUES ('native-sample', 'NATIVE-COMMENT', 'Native Comment sample', '${revision}', '${revision}');
    INSERT INTO runs (id, sample_id, recipe_family_id, template_version_id, sequence_no, run_group_id, template_name_snapshot, template_type_snapshot,
      template_version_snapshot, status, created_at, run_kind)
      VALUES ('native-run', 'native-sample', 'native-family', 'native-template', 1, 'native-run-group', 'Native Comment process', 'process', 1, 'active', '${revision}', 'process');
    INSERT INTO run_steps (id, run_id, position, origin, plan_status, title, status, entry_kind, created_at, updated_at)
      VALUES ${Array.from({ length: 12 }, (_, i) => `('native-step-${i}', 'native-run', ${i}, 'ad_hoc', 'current', 'Native step ${i}', 'pending', 'fabrication', '${revision}', '${revision}')`).join(",")};
    INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, sha256, status, created_at)
      VALUES ('previous-asset', 'previous/comment-image', 'previous.png', 'image/png', 4, '${hash("old!")}', 'ready', '${revision}');
    INSERT INTO comment_submissions (id, context_kind, sample_id, scope, body, status, actor_email, created_at, updated_at, retry_until, completed_at, retry_closed_at, retry_closed_by)
      VALUES ('legacy-pending-comment', 'sample', 'native-sample', NULL, 'Legacy pending Comment', 'draft', 'owner@example.com', '${revision}', '${revision}', '2026-08-02T00:00:00.000Z', NULL, NULL, NULL),
        ('legacy-ready-comment', 'run_steps', NULL, 'individual', 'Legacy ready Comment', 'ready', 'owner@example.com', '${revision}', '${revision}', '2026-08-02T00:00:00.000Z', '${revision}', '${revision}', 'owner@example.com');
    INSERT INTO comment_submission_targets (submission_id, sample_id, run_id, run_step_id, expected_updated_at)
      VALUES ('legacy-ready-comment', 'native-sample', 'native-run', 'native-step-0', '${revision}');
    INSERT INTO run_step_comments (id, run_step_id, scope, submission_id, legacy_body, actor_email, created_at, updated_at)
      VALUES ('legacy-ready-occurrence', 'native-step-0', 'individual', 'legacy-ready-comment', NULL, 'owner@example.com', '${revision}', '${revision}');
    INSERT INTO comment_submission_items (id, submission_id, kind, status, position, filename, mime_type, byte_size, original_filename, original_mime_type,
      original_byte_size, title, asset_id, sha256, created_at, updated_at)
      VALUES ('legacy-pending-item', 'legacy-pending-comment', 'comment_image', 'pending', 0, 'pending.png', 'image/png', 4, 'pending.png', 'image/png', 4, 'Pending image', NULL, NULL, '${revision}', '${revision}'),
        ('legacy-ready-item', 'legacy-ready-comment', 'comment_image', 'ready', 0, 'previous.png', 'image/png', 4, 'previous.png', 'image/png', 4, 'Previous image', 'previous-asset', '${hash("old!")}', '${revision}', '${revision}');
    INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
      VALUES ('legacy-ready-event', 'native-sample', 'comment', 'Step comment: Legacy ready Comment', '{"action":"comment_submission","submissionId":"legacy-ready-comment","scope":"individual","stepIds":["native-step-0"]}', 'owner@example.com', '${revision}');
  `;
}
const allTables = [...oldTables, parentTable, itemTable, "blob_gc_ledger", "blob_integrity_quarantine"];
const workerSource = `
import { Hono } from "hono";
import { routes } from "./worker/comment-submission-routes.ts";
import { handleError } from "./worker/platform/http.ts";
import { snapshotFullExportV15 } from "./worker/export-v15-snapshot.ts";
import { closeExpiredRetryWindows } from "./worker/evidence/retry-maintenance.ts";
const app = new Hono().basePath("/api"); app.onError(handleError);
app.use("*", async (c, next) => { c.set("userEmail", c.req.header("X-Fixture-Actor") || "owner@example.com"); await next(); });
app.route("/", routes);
export default { async fetch(request, env, ctx) {
  const { mode, binding, deleted } = await request.json(); const rawDb = env[binding];
  if (mode === "restored") {
    let puts = 0;
    const routeEnv = { DB: rawDb, R2_BOOTSTRAP_NAMESPACE: ${JSON.stringify(namespace)}, ASSETS: {
      get(key) { return env.RESTORED_BUCKET.get(key); }, head(key) { return env.RESTORED_BUCKET.head(key); },
      put() { puts++; throw new Error("historical Comment observation cannot publish bytes"); },
      delete() { throw new Error("historical Comment observation cannot delete bytes"); },
    } };
    async function call(id, method, suffix, body, headers = {}) {
      const url = suffix === "create" ? "https://app.test/api/comment-submissions" : "https://app.test/api/comment-submissions/" + id + suffix;
      const response = await app.fetch(new Request(url, { method, headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body }) }), routeEnv, ctx);
      return { status: response.status, body: await response.json() };
    }
    let deletion = null;
    if (deleted) deletion = await call("${submissionId}", "DELETE", "");
    const before = (await snapshotFullExportV15(rawDb)).tables;
    const accepted = await rawDb.prepare("SELECT request_input_json FROM comment_submission_acceptances WHERE submission_id = ?").bind("${submissionId}").first();
    const observed = await call("${submissionId}", "GET", "/acceptance");
    const pending = await call("restored-pending-request", "GET", "/acceptance");
    const legacy = await call("legacy-pending-comment", "GET", "/acceptance");
    const create = await call("${submissionId}", "POST", "create", accepted.request_input_json);
    const input = JSON.parse(accepted.request_input_json); const file = input.items[0];
    const upload = await call("${submissionId}", "PUT", "/items/" + file.id + "/content", repeatedStream(file.byteSize), { "Content-Type": file.mimeType, "X-Upload-Size": String(file.byteSize), "X-Content-Sha256": file.sha256 });
    const finalize = await call("${submissionId}", "POST", "/finalize");
    const legacyPut = await call("legacy-pending-comment", "PUT", "/items/legacy-pending-item/content", new TextEncoder().encode("old!"), { "Content-Type": "image/png", "X-Upload-Size": "4", "X-Content-Sha256": "${hash('old!')}" });
    return Response.json({ observed, pending, legacy, create, upload, finalize, legacyPut, deletion, puts, before, after: (await snapshotFullExportV15(rawDb)).tables });
  }
  const stats = { puts: [], gets: [], heads: [], deletes: [], webdav: [], acceptanceBeforePut: [], sessions: [],
    createAttempts: 0, claimAttempts: 0, lostCreate: 0, lostClaim: 0, lostProvider: 0, lostItem: 0, lostFinalize: 0, cleanupFailures: 0 };
  let phase = "create"; let releaseCreate; const createGate = new Promise(resolve => { releaseCreate = resolve; });
  let releaseClaim; const claimGate = new Promise(resolve => { releaseClaim = resolve; });
  let releasePut; const putGate = new Promise(resolve => { releasePut = resolve; });
  let putStarted; const firstPut = new Promise(resolve => { putStarted = resolve; });
  const createSql = sql => /INSERT(?: OR IGNORE)? INTO comment_submission_acceptances\\b/i.test(sql);
  const claimSql = sql => /UPDATE comment_item_acceptances\\b/i.test(sql) && /SET\\s+execution_token\\s*=/.test(sql);
  const itemReadySql = sql => /UPDATE comment_item_acceptances\\b/i.test(sql) && /status\\s*=\\s*'ready'/.test(sql);
  const finalSql = sql => /UPDATE comment_submission_acceptances\\b/i.test(sql) && /status\\s*=\\s*'ready'/.test(sql);
  async function beforeStatements(sqls) {
    if (sqls.some(createSql)) {
      stats.createAttempts++;
      if (mode === "concurrent-create" && phase === "create") { if (stats.createAttempts === 2) releaseCreate(); await createGate; }
    }
    if (sqls.some(claimSql)) {
      stats.claimAttempts++;
      if (mode === "concurrent-upload" && phase === "upload") { if (stats.claimAttempts === 2) releaseClaim(); await claimGate; }
    }
  }
  function afterStatements(sqls) {
    if (sqls.some(createSql) && mode === "lost-create-ack" && stats.lostCreate++ === 0) throw new Error("FIXTURE_PRIVATE lost committed create response");
    if (sqls.some(claimSql) && mode === "lost-claim-ack" && stats.lostClaim++ === 0) throw new Error("FIXTURE_PRIVATE lost committed item ownership response");
    if (sqls.some(itemReadySql) && mode === "lost-item-ack" && stats.lostItem++ === 0) throw new Error("FIXTURE_PRIVATE lost committed item response");
    if (sqls.some(finalSql) && mode === "lost-finalization-ack" && stats.lostFinalize++ === 0) throw new Error("FIXTURE_PRIVATE lost committed publication response");
  }
  function database(native) {
    function statement(sql, inner) { return { sql, inner,
      bind(...values) { return statement(sql, inner.bind(...values)); }, first(...args) { return inner.first(...args); },
      all(...args) { return inner.all(...args); }, raw(...args) { return inner.raw(...args); },
      async run(...args) { await beforeStatements([sql]); const result = await inner.run(...args); afterStatements([sql]); return result; }
    }; }
    return { prepare(sql) { return statement(sql, native.prepare(sql)); },
      withSession(constraint) { stats.sessions.push(constraint); return database(typeof native.withSession === "function" ? native.withSession(constraint) : native); },
      async batch(statements) {
        const sqls = statements.map(item => item.sql); await beforeStatements(sqls);
        if (mode === "target-deleted" && sqls.some(finalSql)) await rawDb.prepare("UPDATE run_steps SET deleted_at = ?, deleted_by = 'other@example.com' WHERE id = 'native-step-11'").bind(new Date().toISOString()).run();
        if (mode === "expiry-cleanup-failure" && phase === "cleanup" && sqls.some(sql => /system:cleanup/.test(sql))) { stats.cleanupFailures++; throw new Error("FIXTURE_PRIVATE cleanup database unavailable"); }
        const result = await native.batch(statements.map(item => item.inner)); afterStatements(sqls); return result;
      }
    };
  }
  const originalDate = Date;
  function expire(days = 7) { globalThis.Date = class extends originalDate {
    constructor(...args) { super(...(args.length ? args : [originalDate.now() + days * 86400000 + 1])); }
    static now() { return originalDate.now() + days * 86400000 + 1; }
  }; }
  async function observePut(store, key) {
    stats.puts.push({ store, key });
    stats.acceptanceBeforePut.push({ parent: (await rawDb.prepare("SELECT * FROM comment_submission_acceptances").all()).results,
      items: (await rawDb.prepare("SELECT * FROM comment_item_acceptances").all()).results });
    if (["remove-during-put", "cancel-during-put"].includes(mode)) { putStarted(); await putGate; }
    if (mode === "expired-during-put") expire();
    if (mode === "inflight-profile-flip") routeEnv.R2_BOOTSTRAP_NAMESPACE = ${JSON.stringify(namespace)}.replace("fixture-assets", "different-assets");
  }
  const bucket = {
    async put(key, bytes, options) {
      await observePut("r2", key); const result = await env.BUCKET.put(key, bytes, options);
      if (["lost-provider-ack", "unavailable-provider"].includes(mode) && stats.lostProvider++ === 0) throw new Error("FIXTURE_PRIVATE uncertain provider acknowledgement");
      return result;
    },
    async get(key, options) { stats.gets.push({ store: "r2", key }); if (mode === "unavailable-provider") throw new Error("FIXTURE_PRIVATE unavailable provider GET"); return env.BUCKET.get(key, options); },
    async head(key) { stats.heads.push({ store: "r2", key }); if (mode === "unavailable-provider") throw new Error("FIXTURE_PRIVATE unavailable provider HEAD"); return env.BUCKET.head(key); },
    async delete(key) { stats.deletes.push({ store: "r2", key }); throw new Error("acceptance cannot delete provider bytes"); },
  };
  const routeEnv = { DB: database(rawDb), ASSETS: bucket, AUTH_MODE: "disabled", R2_BOOTSTRAP_NAMESPACE: ${JSON.stringify(namespace)},
    MANAGED_STORAGE_PROVIDER: "switchdrive", SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/fixture%40example.ch",
    SWITCHDRIVE_USERNAME: "fixture@example.ch", SWITCHDRIVE_APP_PASSWORD: "fixture-only-password", SWITCHDRIVE_ROOT: "qualification-root" };
  function repeatedStream(size, byte = 37) {
    let remaining = size;
    return new ReadableStream({ pull(controller) {
      if (!remaining) { controller.close(); return; }
      const count = Math.min(64 * 1024, remaining); remaining -= count; controller.enqueue(new Uint8Array(count).fill(byte));
    } });
  }
  async function digestStream(stream) {
    const digest = new crypto.DigestStream("SHA-256"); await stream.pipeTo(digest);
    return [...new Uint8Array(await digest.digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  }
  const providerObjects = new Map(); const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const address = new URL(String(url)); const method = init.method || "GET";
    if (address.origin !== "https://drive.switch.ch" || !address.pathname.startsWith("/remote.php/dav/files/fixture%40example.ch/")) throw new Error("Unexpected native provider address");
    const headers = new Headers(init.headers);
    stats.webdav.push({ method, path: address.pathname, manualRedirect: init.redirect === "manual", authenticated: /^Basic /.test(headers.get("authorization") || "") });
    if (init.redirect !== "manual" || !headers.has("authorization")) throw new Error("Official provider request contract was not honored");
    if (method === "PROPFIND") return new Response(null, { status: 207 });
    if (method === "MKCOL") return new Response(null, { status: 201 });
    if (method === "PUT") {
      await observePut("managed", address.pathname);
      const reader = init.body.getReader(); const digest = new crypto.DigestStream("SHA-256"); const writer = digest.getWriter(); let size = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
        if (next.value.some(value => value !== 37)) throw new Error("Managed fixture received changed bytes"); await writer.write(next.value); }
        await writer.close();
      } finally { reader.releaseLock(); writer.releaseLock(); }
      const sha256 = [...new Uint8Array(await digest.digest)].map(value => value.toString(16).padStart(2, "0")).join("");
      providerObjects.set(address.pathname, { size, sha256, mime: headers.get("content-type") });
      if (mode === "lost-managed-provider-ack" && stats.lostProvider++ === 0) throw new Error("FIXTURE_PRIVATE committed WebDAV response lost");
      return new Response(null, { status: 201 });
    }
    const object = providerObjects.get(address.pathname);
    if (method === "HEAD") { stats.heads.push({ store: "managed", key: address.pathname }); return new Response(null, { status: object ? 200 : 404,
      headers: object ? { "content-length": String(object.size), "content-type": object.mime } : {} }); }
    if (method === "GET") { stats.gets.push({ store: "managed", key: address.pathname }); return new Response(object ? repeatedStream(object.size) : null,
      { status: object ? 200 : 404, headers: object ? { "content-type": object.mime, "content-length": String(object.size) } : {} }); }
    if (method === "DELETE") { stats.deletes.push({ store: "managed", key: address.pathname }); throw new Error("Comment acceptance cannot delete provider bytes"); }
    throw new Error("Unexpected native provider method");
  };
  try {
    await env.BUCKET.put("previous/comment-image", new TextEncoder().encode("old!"));
    const managed = ["managed-replay", "lost-managed-provider-ack", "managed-profile-flip", "maximum-managed"].includes(mode);
    const largeImage = mode === "maximum-image"; const size = mode === "maximum-managed" ? 100 * 1024 * 1024 : largeImage ? 5 * 1024 * 1024 : 37;
    const sha256 = await digestStream(repeatedStream(size));
    const imageItem = { id: "${itemId}", kind: "comment_image", filename: "测量预览.png", mimeType: "image/png", byteSize: size,
      originalFilename: "测量.png", originalMimeType: "image/png", originalByteSize: size, sha256 };
    const attachmentItem = { id: "${itemId}", kind: "attachment", filename: "原始测量.pdf", mimeType: "application/pdf", byteSize: size, sha256 };
    const runContext = ["maximum-targets-items", "target-deleted", "target-revision"].includes(mode);
    const context = runContext ? { kind: "run_steps", scope: "common", targets: Array.from({ length: 12 }, (_, i) => ({ sampleId: "native-sample", runId: "native-run", stepId: "native-step-" + i, expectedUpdatedAt: "${revision}" })) }
      : { kind: "sample", sampleId: "native-sample", expectedUpdatedAt: "${revision}" };
    const items = mode === "text-only" ? [] : mode === "maximum-targets-items" ? Array.from({ length: 24 }, (_, i) => ({ id: "native-link-" + i, kind: "link", title: "Reference " + i, url: "https://example.test/reference/" + i }))
      : managed ? [attachmentItem] : [imageItem];
    if (mode === "unfinished-items") items.push({ ...imageItem, id: "unfinished-image" });
    if (mode === "untrusted-preview") {
      Object.assign(imageItem, { originalFilename: "original.tiff", originalMimeType: "image/tiff", relatedAttachmentId: "original-attachment" });
      items.push({ ...attachmentItem, id: "original-attachment", filename: "original.tiff", mimeType: "image/tiff", relatedCommentImageId: imageItem.id });
    }
    const input = { protocol: "comment-submission/1", id: "${submissionId}", body: "Native durable Comment", context, items };
    const url = "https://app.test/api/comment-submissions/${submissionId}";
    async function invoke(method, suffix, body, options = {}) {
      const response = await app.fetch(new Request(suffix === "create" ? "https://app.test/api/comment-submissions" : url + suffix, {
        method, headers: { "Content-Type": "application/json", "X-Fixture-Actor": options.actor || "owner@example.com" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), routeEnv, ctx);
      if (mode === "lost-http-ack" && phase === "finalize" && suffix === "/finalize") { await response.arrayBuffer(); return { status: 0, body: null }; }
      return { status: response.status, body: await response.json(), cacheControl: response.headers.get("cache-control") };
    }
    const create = (options = {}) => invoke("POST", "create", options.input || input, options);
    const poll = (actor) => invoke("GET", "/acceptance", undefined, { actor });
    async function upload(item = items.find(item => item.kind !== "link"), options = {}) {
      const response = await app.fetch(new Request(url + "/items/" + item.id + "/content", { method: "PUT",
        headers: { "Content-Type": item.mimeType, "X-Upload-Size": String(item.byteSize), "X-Content-Sha256": options.wrongHeader ? "b".repeat(64) : item.sha256, "X-Fixture-Actor": "owner@example.com" },
        body: repeatedStream(item.byteSize, options.changed ? 38 : 37),
      }), routeEnv, ctx);
      return { status: response.status, body: await response.json() };
    }
    async function snapshot() { const result = {}; for (const name of ${JSON.stringify(allTables)})
      result[name] = (await rawDb.prepare("SELECT * FROM " + name + " ORDER BY rowid").all()).results; return result; }
    const io = () => ({ puts: [...stats.puts], gets: stats.gets.length, heads: stats.heads.length, deletes: [...stats.deletes] });
    if (mode === "legacy-pending") {
      const before = await snapshot(); const responses = [];
      for (const [method, suffix] of [["GET", "/acceptance"], ["PUT", "/items/legacy-pending-item/content"], ["POST", "/finalize"]]) {
        const response = await app.fetch(new Request("https://app.test/api/comment-submissions/legacy-pending-comment" + suffix, { method,
          ...(method === "PUT" ? { headers: { "Content-Type": "image/png", "X-Upload-Size": "4", "X-Content-Sha256": "a".repeat(64) }, body: repeatedStream(4) } : {}) }), routeEnv, ctx);
        responses.push({ status: response.status, body: await response.json() });
      }
      return Response.json({ before, afterRetry: await snapshot(), responses, stats });
    }
    const before = await snapshot(); const missing = await poll();
    const created = mode === "concurrent-create" ? await Promise.all([create(), create()]) : await create();
    const afterCreate = await snapshot(); const creationConflicts = [];
    if (mode === "image-replay") {
      for (const changed of [{ ...input, body: "Changed body" }, { ...input, context: { ...context, expectedUpdatedAt: "2026-08-02T00:00:00.000Z" } },
        { ...input, items: [{ ...imageItem, filename: "changed.png" }] }, { ...input, items: [{ ...imageItem, sha256: "b".repeat(64) }] },
        { ...input, items: [{ ...imageItem, originalFilename: "changed-original.png" }] }]) creationConflicts.push(await create({ input: changed }));
    }
    if (["maximum-targets-items", "untrusted-preview"].includes(mode)) creationConflicts.push(await create({ input: { ...input, items: [...input.items].reverse() } }));
    if (mode === "maximum-targets-items") creationConflicts.push(await create({ input: { ...input, context: { ...context, targets: [...context.targets].reverse() } } }));
    const otherCreate = await create({ actor: "other@example.com" });
    const invalidInputs = [];
    if (mode === "image-replay") {
      for (const invalid of [
        { ...input, id: "oversized-image-request", items: [{ ...imageItem, id: "oversized-image-item", byteSize: 5 * 1024 * 1024 + 1 }] },
        { ...input, id: "oversized-managed-request", items: [{ ...attachmentItem, id: "oversized-managed-item", byteSize: 100 * 1024 * 1024 + 1 }] },
        { ...input, id: "too-many-items-request", items: Array.from({ length: 25 }, (_, i) => ({ id: "too-many-link-" + i, kind: "link", title: "Link", url: "https://example.test/" + i })) },
        { ...input, id: "too-many-targets-request", context: { kind: "run_steps", scope: "common", targets: Array.from({ length: 13 }, (_, i) => ({ sampleId: "native-sample", runId: "native-run", stepId: "native-step-" + i, expectedUpdatedAt: "${revision}" })) } },
      ]) invalidInputs.push(await create({ input: invalid }));
    }
    const afterInvalid = await snapshot();
    if (mode === "r2-profile-flip") routeEnv.R2_BOOTSTRAP_NAMESPACE = ${JSON.stringify(namespace)}.replace("fixture-assets", "different-assets");
    if (mode === "managed-profile-flip") routeEnv.SWITCHDRIVE_ROOT = "different-root";
    if (mode === "expired-before-put") expire();
    if (mode === "item-zero-row") await rawDb.prepare("CREATE TRIGGER qualification_ignore_item BEFORE UPDATE OF status ON comment_item_acceptances WHEN NEW.status = 'ready' BEGIN SELECT RAISE(IGNORE); END;").run();
    if (mode === "finalization-zero-row") await rawDb.prepare("CREATE TRIGGER qualification_ignore_parent BEFORE UPDATE OF status ON comment_submission_acceptances WHEN NEW.status = 'ready' BEGIN SELECT RAISE(IGNORE); END;").run();
    phase = "upload"; let uploaded = null; let interference = null;
    if (mode === "untrusted-preview") uploaded = [await upload(items[1]), await upload(items[0])];
    else if (["remove-during-put", "cancel-during-put"].includes(mode)) {
      const running = upload(); await firstPut;
      interference = mode === "remove-during-put" ? await invoke("DELETE", "/items/${itemId}") : await invoke("POST", "/cancel");
      releasePut(); uploaded = await running;
    } else if (mode === "concurrent-upload") uploaded = await Promise.all([upload(), upload()]);
    else if (items.some(item => item.kind !== "link")) uploaded = await upload(undefined, { changed: mode === "wrong-content-hash", wrongHeader: mode === "wrong-upload-header" });
    const afterUpload = await snapshot();
    if (["finalize-gc", "finalize-quarantine", "finalize-missing", "finalize-corrupt"].includes(mode)) {
      const asset = afterUpload.assets.find(row => row.id !== "previous-asset");
      if (mode === "finalize-gc") await rawDb.prepare("INSERT INTO blob_gc_ledger (store_kind, provider, object_key, state, operation_id, updated_at) VALUES ('r2', 'r2', ?, 'deleted', 'qualification-gc', ?)").bind(asset.r2_key, new Date().toISOString()).run();
      if (mode === "finalize-quarantine") await rawDb.prepare("INSERT INTO blob_integrity_quarantine (store_kind, provider, object_key, reason, expected_byte_size, observed_byte_size, operation_id, detected_at, last_checked_at) VALUES ('r2', 'r2', ?, 'size_mismatch', ?, ?, 'qualification-quarantine', ?, ?)").bind(asset.r2_key, size, size + 1, new Date().toISOString(), new Date().toISOString()).run();
      if (mode === "finalize-missing") await env.BUCKET.delete(asset.r2_key);
      if (mode === "finalize-corrupt") await env.BUCKET.put(asset.r2_key, new Uint8Array(size).fill(38));
    }
    if (mode === "target-revision") await rawDb.prepare("UPDATE run_steps SET updated_at = '2026-08-02T00:00:00.000Z', title = 'Changed elsewhere' WHERE id = 'native-step-11'").run();
    if (mode === "expiry-cleanup-failure") { phase = "cleanup"; expire(); try { await closeExpiredRetryWindows(routeEnv, new Date()); } catch { interference = { cleanupFailed: true }; } }
    phase = "finalize";
    const finalized = mode === "concurrent-finalize" ? await Promise.all([invoke("POST", "/finalize"), invoke("POST", "/finalize")]) : await invoke("POST", "/finalize");
    const afterFirst = await snapshot(); const firstIo = io(); phase = "retry";
    if (mode === "ready-after-expiry") expire(8);
    if (mode === "ready-delete") interference = await invoke("DELETE", "");
    const replayBefore = await snapshot(); const state = await poll(); const otherActor = await poll("other@example.com");
    const retriedCreate = await create(); const retriedUpload = items.some(item => item.kind !== "link") ? await upload(undefined, { changed: mode === "wrong-content-hash", wrongHeader: mode === "wrong-upload-header" }) : null;
    const retriedFinalize = await invoke("POST", "/finalize"); const afterRetry = await snapshot(); const retryIo = io();
    const physicalCandidates = []; let cancelledUnknown = null;
    if (["lost-provider-ack", "lost-managed-provider-ack"].includes(mode)) {
      for (const item of afterFirst.comment_item_acceptances) {
        if (mode === "lost-provider-ack") {
          const blob = await env.BUCKET.get(item.candidate_object_key);
          physicalCandidates.push({ id: item.candidate_blob_id, key: item.candidate_object_key, size: blob?.size ?? null, sha256: blob ? await digestStream(blob.body) : null });
        } else {
          const suffix = "/" + item.candidate_object_key.split("/").map(encodeURIComponent).join("/");
          const stored = [...providerObjects.entries()].find(([path]) => path.endsWith(suffix))?.[1];
          physicalCandidates.push({ id: item.candidate_blob_id, key: item.candidate_object_key, size: stored?.size ?? null, sha256: stored?.sha256 ?? null });
        }
      }
      const cancel = await invoke("POST", "/cancel"); const before = await snapshot(); const state = await poll(); const put = await upload();
      cancelledUnknown = { cancel, before, state, put, after: await snapshot(), io: io() };
    }
    let archived = null;
    if (mode === "image-replay") {
      const current = await rawDb.prepare("SELECT updated_at FROM samples WHERE id = 'native-sample'").first();
      const pending = await create({ input: { ...input, id: "restored-pending-request", context: { ...context, expectedUpdatedAt: current.updated_at }, items: [{ ...imageItem, id: "restored-pending-image" }] } });
      if (pending.status !== 201) throw new Error("Native pending recovery fixture was not accepted: " + JSON.stringify(pending));
      archived = await snapshotFullExportV15(rawDb);
    }
    return Response.json({ input, before, missing, created, afterCreate, creationConflicts, otherCreate, invalidInputs, afterInvalid, uploaded, afterUpload, interference,
      finalized, afterFirst, firstIo, replayBefore, state, otherActor, retriedCreate, retriedUpload, retriedFinalize, afterRetry, retryIo, stats,
      providerObjects: [...providerObjects.entries()], physicalCandidates, cancelledUnknown, observedAt: new Date().toISOString(), archive: archived });
  } finally { globalThis.fetch = originalFetch; globalThis.Date = originalDate; }
} };
`;
async function bundle(source, platform = "neutral") {
  return (await build({ stdin: { contents: source, resolveDir: root, sourcefile: "fp1-comment-qualification.ts" }, bundle: true, format: "esm", platform, write: false,
    ...(platform === "node" ? { banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } } : {}),
  })).outputFiles[0].text;
}
async function insertRow(db, name, row) {
  const columns = Object.keys(row);
  return db.prepare(`INSERT INTO "${name}" (${columns.map((name) => `"${name}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .bind(...columns.map((column) => row[column])).run();
}
async function qualifySqlGuards(db, fixture) {
  for (const profile of fixture.afterCreate.storage_profiles) await insertRow(db, "storage_profiles", profile);
  await insertRow(db, "comment_submissions", fixture.afterCreate.comment_submissions.find((row) => row.id === submissionId));
  for (const item of fixture.afterCreate.comment_submission_items.filter((row) => row.submission_id === submissionId)) await insertRow(db, "comment_submission_items", item);
  const parent = fixture.afterCreate[parentTable][0]; const item = fixture.afterCreate[itemTable][0];
  await insertRow(db, parentTable, parent); await insertRow(db, itemTable, item);
  const originalParent = await rows(db, parentTable); const originalItems = await rows(db, itemTable);
  for (const statement of [
    `UPDATE ${parentTable} SET actor_email='other@example.com'`, `UPDATE ${parentTable} SET request_sha256='${"b".repeat(64)}'`,
    `UPDATE ${parentTable} SET expires_at='2026-10-01T00:00:00.000Z'`, `UPDATE ${parentTable} SET publication_plan_json='{}'`,
    `UPDATE ${itemTable} SET purpose='research_source'`, `UPDATE ${itemTable} SET expected_sha256='${"b".repeat(64)}'`,
    `UPDATE ${itemTable} SET candidate_object_key='other/object'`, `UPDATE ${itemTable} SET storage_profile_revision=2`,
    `DELETE FROM ${parentTable}`, `DELETE FROM ${itemTable}`,
    `INSERT OR REPLACE INTO ${parentTable} SELECT * FROM ${parentTable}`, `INSERT OR REPLACE INTO ${itemTable} SELECT * FROM ${itemTable}`,
    `INSERT OR REPLACE INTO comment_submissions SELECT * FROM comment_submissions WHERE id='${submissionId}'`,
    `INSERT OR REPLACE INTO comment_submission_items SELECT * FROM comment_submission_items WHERE id='${itemId}'`,
    `UPDATE comment_submissions SET body='Changed by SQL' WHERE id='${submissionId}'`,
    `UPDATE comment_submission_items SET filename='changed.png' WHERE id='${itemId}'`,
  ]) {
    await assert.rejects(db.prepare(statement).run(), /immutable|cannot be deleted|constraint|accept|publication|identity/i, statement);
    assert.deepEqual(await rows(db, parentTable), originalParent); assert.deepEqual(await rows(db, itemTable), originalItems);
  }
  const readyParent = fixture.afterFirst[parentTable][0]; const readyItem = fixture.afterFirst[itemTable][0];
  await assert.rejects(db.prepare(`UPDATE ${parentTable} SET status='ready',completed_at=?,accepted_result_json=? WHERE submission_id=?`)
    .bind(readyParent.completed_at, readyParent.accepted_result_json, submissionId).run(), /publication|result|accept/i, "receipt cannot publish absent canonical occurrences/events");
  await assert.rejects(db.prepare(`UPDATE ${itemTable} SET status='ready',execution_token=?,started_at=?,accepted_result_json=? WHERE item_id=?`)
    .bind(readyItem.execution_token, readyItem.started_at, readyItem.accepted_result_json, itemId).run(), /publication|result|accept/i, "receipt cannot publish a missing or unbound provider result");
  assert.deepEqual(await rows(db, parentTable), originalParent); assert.deepEqual(await rows(db, itemTable), originalItems);
}
async function qualifyRestore(mf, scratch, fixture) {
  const modulePath = join(scratch, "restore-qualification.mjs");
  await writeFile(modulePath, await bundle(`export { snapshotFullExportV15 } from './worker/export-v15-snapshot.ts'; export { buildFullExportArchiveV15 } from './src/lib/exportAll.ts'; export { restoreExportToIsolatedDirectory } from './scripts/lib/export-restore.ts';`, "node"));
  const service = await import(pathToFileURL(modulePath).href); const byUrl = new Map(fixture.archive.blobs.map((blob) => [blob.downloadUrl, blob]));
  const archive = await service.buildFullExportArchiveV15(fixture.archive, undefined, async (url) => {
    const blob = byUrl.get(String(url)); const stored = blob && await (await mf.getR2Bucket("BUCKET")).get(blob.objectKey);
    return stored ? new Response(await stored.arrayBuffer()) : new Response(null, { status: 404 });
  });
  const archivePath = join(scratch, "comment-recovery-contract.zip"); await writeFile(archivePath, Buffer.from(await archive.archive.arrayBuffer()));
  const originalHash = hash(await readFile(archivePath));
  const restored = await service.restoreExportToIsolatedDirectory({ archivePath, destination: join(scratch, "restored"), migrationsDirectory: join(root, "migrations"), targetCompatibilitySchema: "S2" });
  assert.equal(restored.report.schemaVersion, 15); assert.equal(restored.report.archiveProfile, "fp1-shadow-conversion");
  assert.deepEqual(restored.report.appliedForwardMigrations, []);
  assert.equal(restored.report.verification.rowsEqual, true); assert.equal(restored.report.verification.foreignKeys, true);
  assert(restored.report.restoredBlobCount > 0); const recovered = new DatabaseSync(join(restored.restoredDirectory, "database.sqlite"));
  try {
    assertLegacyFileAuthority(recovered);
    const snapshot = await service.snapshotFullExportV15(hostAdapter(recovered)); assert.deepEqual(snapshot.tables, fixture.archive.tables);
    assert.equal(snapshot.tables[parentTable].length, 2); assert.equal(snapshot.tables[itemTable].length, 2);
    const providerManifest = JSON.parse(await readFile(join(restored.restoredDirectory, "provider-manifest.json"), "utf8"));
    const restoredBucket = await mf.getR2Bucket("RESTORED_BUCKET");
    for (const entry of providerManifest) if (entry.path) await restoredBucket.put(entry.objectKey, await readFile(join(restored.restoredDirectory, entry.path)));
    // An isolated, empty D1 receives the exact restored schema and rows before
    // its guards are installed. Existing databases never lose their guards.
    const db = await mf.getD1Database("DB_RESTORED");
    const catalog = recovered.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name").all();
    const statements = [db.prepare("PRAGMA defer_foreign_keys=ON")];
    for (const definition of catalog.filter((row) => row.type === "table")) statements.push(db.prepare(definition.sql));
    for (const definition of catalog.filter((row) => row.type === "table")) for (const row of recovered.prepare(`SELECT * FROM "${definition.name}"`).all()
      .sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : JSON.stringify(left) > JSON.stringify(right) ? 1 : 0)) {
      const columns = Object.keys(row);
      statements.push(db.prepare(`INSERT INTO "${definition.name}" (${columns.map((name) => `"${name}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
        .bind(...columns.map((column) => row[column])));
    }
    for (const definition of catalog.filter((row) => row.type !== "table")) statements.push(db.prepare(definition.sql));
    await db.batch(statements); assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    for (const deleted of [false, true]) {
      const response = await mf.dispatchFetch("https://qualification.test/", { method: "POST", body: JSON.stringify({ mode: "restored", binding: "DB_RESTORED", deleted }) });
      assert.equal(response.status, 200, await response.clone().text()); const result = await response.json();
      assert.equal(result.observed.status, 200); assert.equal(result.observed.body.request.status, deleted ? "unavailable" : "ready");
      assert.equal(result.pending.body.request.status, "pending"); assert(result.pending.body.request.items.every((item) => item.status === "pending"));
      assert.equal(result.legacy.body.request.status, "legacy"); assert([409, 428].includes(result.legacyPut.status));
      assert.equal(result.create.status, 200); assert.equal(result.upload.status, deleted ? 409 : 200); assert.equal(result.finalize.status, deleted ? 409 : 200);
      if (deleted) { assert.equal(result.deletion.status, 200); assert.equal(result.observed.body.request.result, undefined); }
      else { assert.deepEqual(result.before, snapshot.tables); assert.deepEqual(result.observed.body.request.result, JSON.parse(fixture.afterFirst[parentTable][0].accepted_result_json)); }
      assert.equal(result.puts, 0); assert.deepEqual(result.after, result.before, "restored ready, cancelled and pending historical observations remain read-only");
    }
    for (const name of [parentTable, itemTable]) {
      assert.throws(() => recovered.exec(`DELETE FROM ${name}`), /cannot be deleted/);
      assert.throws(() => recovered.exec(`INSERT OR REPLACE INTO ${name} SELECT * FROM ${name}`), /immutable|accept|constraint/i);
      await assert.rejects(db.prepare(`DELETE FROM ${name}`).run(), /cannot be deleted/);
      await assert.rejects(db.prepare(`INSERT OR REPLACE INTO ${name} SELECT * FROM ${name}`).run(), /immutable|accept|constraint/i);
    }
  } finally { recovered.close(); }
  assert.equal(hash(await readFile(archivePath)), originalHash);
}
const blockedModes = new Set(["lost-provider-ack", "lost-managed-provider-ack", "unavailable-provider", "wrong-content-hash", "wrong-upload-header", "r2-profile-flip", "managed-profile-flip", "inflight-profile-flip",
  "cancel-during-put", "expired-before-put", "expired-during-put", "expiry-cleanup-failure", "unfinished-items", "finalize-gc", "finalize-quarantine",
  "finalize-missing", "finalize-corrupt", "target-deleted", "item-zero-row", "finalization-zero-row"]);

test("Comment acceptance upgrades populated legacy Comment history without changing retention", async () => {
  const host = new DatabaseSync(":memory:");
  try { host.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=OFF"); const db = hostAdapter(host); await seedBeforeUpgrade(db); await upgrade(db); }
  finally { host.close(); }
});
test("durable Comment publication qualifies on real workerd/D1/R2 and the production WebDAV adapter", { timeout: 300_000 }, async (t) => {
  const mf = new Miniflare({ modules: true, script: await bundle(workerSource), compatibilityDate: "2026-07-20",
    r2Buckets: ["BUCKET", "RESTORED_BUCKET"], d1Databases: [...Object.values(bindings), "DB_GUARDS", "DB_RESTORED"], log: new Log(LogLevel.ERROR) });
  const scratch = await mkdtemp(join(tmpdir(), "fp1-comment-")); let replayFixture;
  try {
    for (const binding of Object.values(bindings)) {
      const db = await mf.getD1Database(binding); await seedBeforeUpgrade(db); await upgrade(db);
      for (const name of readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql") && name > migration).sort()) await apply(db, read(`migrations/${name}`));
    }
    for (const mode of modes) await t.test(mode, async () => {
      const response = await mf.dispatchFetch("https://qualification.test/", { method: "POST", body: JSON.stringify({ mode, binding: bindings[mode] }) });
      assert.equal(response.status, 200, await response.clone().text()); const result = await response.json();
      if (mode === "legacy-pending") {
        assert.equal(result.responses[0].body.request.status, "legacy"); assert(result.responses.slice(1).every((entry) => [409, 428].includes(entry.status)));
        assert.deepEqual(result.afterRetry, result.before); assert.equal(result.stats.puts.length, 0); return;
      }
      assert.equal(result.missing.status, 404); assert.equal(result.otherActor.status, 404); assert([404, 409].includes(result.otherCreate.status));
      assert(result.invalidInputs.every((entry) => entry.status === 400)); assert.deepEqual(result.afterInvalid, result.afterCreate);
      assert(!JSON.stringify([result.created, result.uploaded, result.finalized, result.state]).includes("FIXTURE_PRIVATE"));
      assert(!JSON.stringify(result.afterRetry).includes("fixture-only-password"));
      assert.deepEqual(result.stats.deletes, [], "acceptance never owns provider deletion");
      assert(result.stats.webdav.every((entry) => !entry.path.includes("/different-root/")), "captured managed operations never enter a changed namespace");
      const receipt = result.afterCreate[parentTable].find((row) => row.submission_id === submissionId);
      assert(receipt, JSON.stringify({ created: result.created, uploaded: result.uploaded, finalized: result.finalized }));
      assert.equal(receipt.actor_email, "owner@example.com"); assert.equal(receipt.request_scope, "system");
      assert.equal(Date.parse(receipt.expires_at) - Date.parse(receipt.created_at), 7 * 86_400_000);
      assert.equal(receipt.request_sha256, hash(receipt.request_input_json)); assert.deepEqual(JSON.parse(receipt.request_input_json), result.input);
      assert.equal(result.afterCreate[itemTable].length, result.input.items.filter((item) => item.kind !== "link").length);
      assert.equal(result.state.cacheControl, "no-store");
      assert.deepEqual(result.retryIo.puts, result.firstIo.puts, "same accepted operation never gets a second provider PUT");
      assert.deepEqual(result.afterRetry, result.replayBefore, "replays and observations cannot rewrite immutable acceptance or publication");
      assert(result.creationConflicts.every((entry) => entry.status === 409));
      for (const observed of result.stats.acceptanceBeforePut) {
        assert.equal(observed.parent.length, 1); assert.equal(observed.parent[0].status, "pending");
        assert(observed.items.some((row) => row.execution_token && row.status === "pending"), "a captured item executor precedes provider writes");
      }
      const parent = result.afterFirst[parentTable].find((row) => row.submission_id === submissionId);
      const newEvents = result.afterFirst.events.filter((row) => !result.before.events.some((before) => before.id === row.id));
      const newOccurrences = result.afterFirst.run_step_comments.filter((row) => !result.before.run_step_comments.some((before) => before.id === row.id));
      if (blockedModes.has(mode)) {
        assert.notEqual(parent.status, "ready", JSON.stringify({ mode, uploaded: result.uploaded, finalized: result.finalized }));
        assert.equal(parent.accepted_result_json, null); assert.equal(newEvents.length, 0); assert.equal(newOccurrences.length, 0);
        if (["lost-provider-ack", "lost-managed-provider-ack"].includes(mode)) {
          assert.equal(result.uploaded.status, 503); assert.equal(result.state.body.request.status, "pending");
          assert.equal(result.state.body.request.items[0].status, "uploading"); assert.equal(result.stats.lostProvider, 1);
          const item = result.afterFirst[itemTable][0]; assert(item.execution_token); assert.equal(item.status, "pending"); assert.equal(item.accepted_result_json, null);
          assert.equal(result.physicalCandidates.length, 1); assert.equal(result.physicalCandidates[0].size, item.expected_byte_size); assert.equal(result.physicalCandidates[0].sha256, item.expected_sha256);
          const tracked = [...result.afterFirst.assets, ...result.afterFirst.managed_storage_objects].find((row) => row.id === item.candidate_blob_id);
          assert(tracked, "unknown provider bytes remain associated with a tracked immutable candidate");
          assert.deepEqual(result.retryIo, result.firstIo, "unknown provider outcomes are observed without repeating provider I/O");
          assert.equal(result.cancelledUnknown.cancel.status, 200); assert.equal(result.cancelledUnknown.state.body.request.status, "cancelled"); assert.equal(result.cancelledUnknown.put.status, 409);
          assert.deepEqual(result.cancelledUnknown.after, result.cancelledUnknown.before); assert.deepEqual(result.cancelledUnknown.io.puts, result.firstIo.puts);
        }
        if (mode === "item-zero-row") assert.notEqual(result.afterUpload.comment_submission_items.find((row) => row.id === itemId).status, "ready", "zero-row item receipt rolls back canonical item mutation");
        if (["expired-before-put", "r2-profile-flip", "managed-profile-flip", "wrong-upload-header"].includes(mode)) assert.equal(result.stats.puts.length, 0);
        if (["expired-before-put", "expired-during-put", "expiry-cleanup-failure"].includes(mode)) assert.equal(result.state.body.request.status, "expired");
        if (mode === "expiry-cleanup-failure") { assert.equal(result.stats.cleanupFailures, 1); assert.equal(result.interference.cleanupFailed, true); }
        return;
      }
      assert.equal(parent.status, "ready", JSON.stringify({ created: result.created, uploaded: result.uploaded, finalized: result.finalized }));
      const saved = JSON.parse(parent.accepted_result_json); assert.equal(saved.submissionId, submissionId);
      assert.equal(newEvents.length, 1); assert.equal(newOccurrences.length, ["maximum-targets-items", "target-revision"].includes(mode) ? 12 : 0);
      assert.deepEqual(saved.eventIds, newEvents.map((row) => row.id));
      assert.deepEqual([...saved.occurrenceIds].sort(), newOccurrences.map((row) => row.id).sort());
      if (mode === "target-revision") assert.equal(result.afterFirst.run_steps.find((row) => row.id === "native-step-11").title, "Changed elsewhere", "append keeps unrelated target edits");
      if (mode === "ready-delete") { assert.equal(result.state.body.request.status, "unavailable"); assert.equal(result.state.body.request.result, undefined); return; }
      assert.equal(result.state.body.request.status, "ready"); assert.deepEqual(result.state.body.request.result, saved);
      assert.equal(result.retriedCreate.status, 200); assert.equal(result.retriedFinalize.status, 200);
      if (mode === "ready-after-expiry") {
        assert(Date.parse(result.observedAt) - Date.parse(receipt.created_at) > 8 * 86_400_000, "ready replay actually runs after the unfinished upload deadline");
        assert.equal(result.state.body.request.expiresAt, receipt.expires_at, "historical acceptance timestamps remain unchanged");
        assert.equal(result.retriedUpload.status, 200); assert.deepEqual(result.retriedUpload.body.request.result, saved);
        assert.deepEqual(result.retriedCreate.body.request.result, saved); assert.deepEqual(result.retriedFinalize.body.request.result, saved);
      }
      if (mode === "remove-during-put") {
        assert.deepEqual(saved.itemIds, []); assert.equal(result.afterFirst[itemTable][0].status, "cancelled");
        assert.equal(result.afterFirst.comment_submission_items.find((row) => row.id === itemId).status, "cancelled");
      } else assert.deepEqual(saved.itemIds, result.input.items.map((item) => item.id));
      const binaryItems = result.input.items.filter((item) => item.kind !== "link");
      assert.equal(result.stats.puts.length, binaryItems.length);
      for (const accepted of result.afterFirst[itemTable]) if (accepted.status === "ready") {
        const savedItem = JSON.parse(accepted.accepted_result_json);
        assert.equal(savedItem.sha256, accepted.expected_sha256); assert.equal(savedItem.byteSize, accepted.expected_byte_size);
        assert.equal(accepted.purpose, result.input.items.find((item) => item.id === accepted.item_id).kind === "attachment" ? "research_source" : mode === "untrusted-preview" ? "derived_preview" : "embedded_content");
      }
      if (mode === "untrusted-preview") assert.deepEqual(result.afterFirst.attachment_derivatives, [], "client previews never become trusted shared derivatives");
      for (const [path, stored] of result.providerObjects) {
        const item = result.input.items.find((entry) => entry.kind === "attachment"); assert(item);
        assert.equal(stored.size, item.byteSize); assert.equal(stored.sha256, item.sha256); assert(path.includes("qualification-root/"));
      }
      assert(result.stats.webdav.every((entry) => entry.manualRedirect && entry.authenticated));
      if (mode === "concurrent-create") assert.equal(result.stats.createAttempts, 2);
      if (mode === "concurrent-upload") assert.equal(result.stats.claimAttempts, 2);
      for (const [scenario, field] of [["lost-create-ack", "lostCreate"], ["lost-claim-ack", "lostClaim"], ["lost-provider-ack", "lostProvider"],
        ["lost-managed-provider-ack", "lostProvider"], ["lost-item-ack", "lostItem"], ["lost-finalization-ack", "lostFinalize"]]) if (mode === scenario) assert.equal(result.stats[field], 1);
      if (mode === "image-replay") replayFixture = result;
    });
    await t.test("host and native D1 enforce immutable manifests, candidate ownership and publication guards", async () => {
      assert(replayFixture); const host = new DatabaseSync(":memory:");
      try {
        host.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=OFF"); const db = hostAdapter(host); await seedBeforeUpgrade(db); await upgrade(db);
        for (const name of readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql") && name > migration).sort()) await apply(db, read(`migrations/${name}`));
        await qualifySqlGuards(db, replayFixture);
      }
      finally { host.close(); }
      const db = await mf.getD1Database("DB_GUARDS"); await seedBeforeUpgrade(db); await upgrade(db);
      for (const name of readdirSync(join(root, "migrations")).filter((name) => name.endsWith(".sql") && name > migration).sort()) await apply(db, read(`migrations/${name}`));
      await db.prepare("PRAGMA recursive_triggers=OFF").run(); await qualifySqlGuards(db, replayFixture);
    });
    await t.test("V15 isolated restore preserves acceptance history and legacy File authority without executing uploads", async () => { assert(replayFixture); await qualifyRestore(mf, scratch, replayFixture); });
  } finally { await mf.dispose(); await rm(scratch, { recursive: true, force: true }); }
});
