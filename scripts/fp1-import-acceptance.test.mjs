import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";

const root = new URL("../", import.meta.url);
const modes = ["replay", "concurrent", "held-pending", "lost-acceptance-ack",
  "lost-finalization-ack", "failed", "pending-error", "missing-header", "missing-namespace"];
const bindings = Object.fromEntries(modes.map((mode, index) => [mode, "DB_" + index]));
const requestId = "2af37c38-7a3b-444d-917f-b096353d7918";
const namespace = JSON.stringify({ kind: "local-r2",
  installationId: "b72529f0-273b-4b72-9fc7-155a93461d83", bucketName: "fixture-assets" });

const workerSource = `
import { Hono } from "hono";
import { routes } from "./worker/imports/fabublox-routes.ts";
import { handleError } from "./worker/platform/http.ts";
import { queueFabubloxImportCleanup } from "./worker/fabublox-import-recovery.ts";

// Authentication transport is the fixture; route actor ownership, acceptance,
// publication and recovery all execute their production implementation.
const app = new Hono().basePath("/api");
app.onError(handleError);
app.use("*", async (c, next) => { c.set("userEmail", c.req.header("X-Fixture-Actor") || "owner@example.com"); await next(); });
app.route("/", routes);

export default {
  async fetch(request, env, ctx) {
    const { mode, binding } = await request.json();
    const rawDb = env[binding];
    const stats = { puts: [], gets: [], heads: [], deletes: 0, insertAttempts: 0,
      lostAcceptance: 0, lostFinalization: 0, acceptedBeforeEachPut: [] };
    let phase = "first";
    let releaseInsert;
    const insertGate = new Promise(resolve => { releaseInsert = resolve; });
    let releasePut;
    const putGate = new Promise(resolve => { releasePut = resolve; });
    let putStarted;
    const firstPut = new Promise(resolve => { putStarted = resolve; });
    function database(native) {
      function statement(sql, inner) {
        return {
          sql, inner,
          bind(...args) { return statement(sql, inner.bind(...args)); },
          first(...args) { return inner.first(...args); },
          all(...args) { return inner.all(...args); },
          raw(...args) { return inner.raw(...args); },
          async run(...args) {
            const acceptance = /^\\s*INSERT INTO imports\\b/i.test(sql);
            if (acceptance) {
              stats.insertAttempts++;
              if (mode === "concurrent" && phase === "first") {
                if (stats.insertAttempts === 2) releaseInsert();
                await insertGate;
              }
            }
            const result = await inner.run(...args);
            if (acceptance && mode === "lost-acceptance-ack" && stats.lostAcceptance++ === 0) {
              throw new Error("synthetic secret: committed acceptance acknowledgement lost");
            }
            return result;
          },
        };
      }
      return {
        prepare(sql) { return statement(sql, native.prepare(sql)); },
        withSession(constraint) { return database(typeof native.withSession === "function" ? native.withSession(constraint) : native); },
        async batch(statements) {
          const result = await native.batch(statements.map(item => item.inner));
          if (mode === "lost-finalization-ack" && !stats.lostFinalization
            && statements.some(item => /UPDATE imports/.test(item.sql) && /SET status = 'ready'/.test(item.sql))) {
            stats.lostFinalization++;
            throw new Error("synthetic secret: committed finalization acknowledgement lost");
          }
          return result;
        },
      };
    }
    const db = database(rawDb);
    const bucket = {
      async put(key, value, options) {
        stats.puts.push(key);
        const putIndex = stats.puts.length;
        const accepted = await rawDb.prepare("SELECT * FROM imports WHERE client_request_id = ?")
          .bind(${JSON.stringify(requestId)}).first();
        stats.acceptedBeforeEachPut.push(accepted);
        if (mode === "held-pending" && putIndex === 1) { putStarted(); await putGate; }
        const result = await env.BUCKET.put(key, value, options);
        if (mode === "failed" || mode === "pending-error") throw new Error("synthetic secret: lost PUT response");
        return result;
      },
      async get(key) {
        stats.gets.push(key);
        if (mode === "pending-error") throw new Error("synthetic secret: unavailable provider read");
        return env.BUCKET.get(key);
      },
      async head(key) { stats.heads.push(key); return env.BUCKET.head(key); },
      async delete() { stats.deletes++; throw new Error("acceptance must not delete bytes"); },
    };
    const routeEnv = { DB: db, ASSETS: bucket, AUTH_MODE: "disabled",
      R2_BOOTSTRAP_NAMESPACE: mode === "missing-namespace" ? undefined : ${JSON.stringify(namespace)} };
    async function hash(buffer) {
      return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))]
        .map(value => value.toString(16).padStart(2, "0")).join("");
    }
    async function form(variant = "same") {
      const source = new TextEncoder().encode("native accepted workbook " + mode + (variant === "workbook" ? " changed" : ""));
      const image = Uint8Array.from([137, 80, 78, 71, 7, 11, 13, variant === "image" ? 19 : 17]);
      const title = "Native acceptance " + mode + (variant === "title" ? " changed" : "");
      const manifest = {
        schemaVersion: 2, title,
        source: { fileName: "fixture.xlsx", fileSha256: await hash(source), sheetName: "Process" },
        initialSubstrateStep: null,
        steps: [{ localId: "step-1", sourceRow: 2, position: 0, stepNumber: "1", sectionName: null,
          name: "Fixture growth", toolName: null, parametersText: null, commentsText: null,
          imageIds: ["image-1"], rawCells: {} }],
        images: [{ localId: "image-1", sourcePart: "xl/media/image1.png", mimeType: "image/png",
          assignedStepLocalId: "step-1", anchor: {} }],
        initialStateImageIds: [], warnings: [],
      };
      const result = new FormData();
      result.set("workbook", new File([source], variant === "filename" ? "renamed.xlsx" : "fixture.xlsx",
        { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      result.set("manifest", new File([JSON.stringify(manifest)], "manifest.json", { type: "application/json" }));
      result.set("image:image-1", new File([image], "state.png", { type: "image/png" }));
      return result;
    }
    async function post(options = {}) {
      const headers = new Headers({ "X-Fixture-Actor": options.actor || "owner@example.com" });
      if (!options.omitHeader) headers.set("X-Import-Request-Id", options.requestId || ${JSON.stringify(requestId)});
      const response = await app.fetch(new Request("https://app.test/api/imports/fabublox", {
        method: "POST", headers, body: await form(options.variant),
      }), routeEnv, ctx);
      return { status: response.status, body: await response.json() };
    }
    async function poll(actor = "owner@example.com", id = ${JSON.stringify(requestId)}) {
      const response = await app.fetch(new Request("https://app.test/api/imports/fabublox/requests/" + id,
        { headers: { "X-Fixture-Actor": actor } }), routeEnv, ctx);
      if (response.headers.get("cache-control") !== "private, no-store") {
        throw new Error("Actor-scoped import observations must never be cached");
      }
      return { status: response.status, body: await response.json() };
    }
    async function snapshot() {
      const result = {};
      for (const table of ["imports", "assets", "recipe_families", "template_versions", "template_steps",
        "state_representations", "state_representation_assets", "storage_profiles", "blob_gc_ledger", "blob_integrity_quarantine"]) {
        result[table] = (await rawDb.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()).results;
      }
      return result;
    }
    const before = await snapshot();
    const missingPoll = await poll();
    let first;
    let pending = null;
    let pendingPoll = null;
    let pendingStats = null;
    if (mode === "concurrent") {
      first = await Promise.all([post(), post()]);
    } else if (mode === "held-pending") {
      const running = post();
      await firstPut;
      pendingStats = structuredClone(stats);
      pending = await post();
      pendingPoll = await poll();
      const afterPendingStats = structuredClone(stats);
      releasePut();
      first = await running;
      pendingStats = { before: pendingStats, after: afterPendingStats };
    } else {
      first = await post({ omitHeader: mode === "missing-header" });
    }
    phase = "retry";
    const afterFirst = await snapshot();
    const firstStats = structuredClone(stats);
    const state = await poll();
    const otherActor = await poll("other@example.com");
    let retry = null;
    let retryBefore = null;
    let conflicts = [];
    let namespaceMismatch = null;
    let recoveryMismatch = null;
    if (!["missing-header", "missing-namespace"].includes(mode)) {
      if (mode === "replay") {
        await rawDb.prepare("UPDATE recipe_families SET name = name || ' renamed', archived_at = '2026-09-13T00:00:00.000Z'").run();
      }
      // Established request identity is resolved before mutable family/default
      // lookup or the current storage profile, including unavailable config.
      routeEnv.R2_BOOTSTRAP_NAMESPACE = undefined;
      retryBefore = await snapshot();
      retry = await post();
      if (mode === "replay") {
        for (const variant of ["title", "workbook", "image", "filename"]) conflicts.push(await post({ variant }));
      }
      routeEnv.R2_BOOTSTRAP_NAMESPACE = JSON.stringify({ kind: "local-r2",
        installationId: "b72529f0-273b-4b72-9fc7-155a93461d83", bucketName: "different-assets" });
      namespaceMismatch = await post({ requestId: "029387da-1909-48c5-9ab1-e19b8e7075d8" });
      if (mode === "pending-error") {
        const accepted = afterFirst.imports[0];
        try {
          await queueFabubloxImportCleanup(routeEnv, { importId: accepted.id, operationId: accepted.operation_id,
            error: "qualification recovery", recoveryOperationId: "qualification-profile-mismatch" });
          recoveryMismatch = { rejected: false };
        } catch { recoveryMismatch = { rejected: true }; }
      }
    }
    const afterRetry = await snapshot();
    const physical = [];
    for (const asset of afterFirst.assets) {
      const stored = await env.BUCKET.get(asset.r2_key);
      physical.push({ key: asset.r2_key, byteSize: stored?.size ?? null,
        sha256: stored ? await hash(await stored.arrayBuffer()) : null });
    }
    return Response.json({ before, missingPoll, first, pending, pendingPoll, pendingStats,
      afterFirst, firstStats, state, otherActor, retryBefore, retry, conflicts,
      namespaceMismatch, recoveryMismatch, afterRetry, physical, stats });
  },
};
`;

test("native workerd import acceptance preserves request identity across retries and uncertain outcomes", { timeout: 120_000 }, async (t) => {
  const bundle = await build({
    stdin: { contents: workerSource, resolveDir: fileURLToPath(root), sourcefile: "fp1-import-acceptance-worker.mjs" },
    bundle: true, format: "esm", platform: "neutral", write: false,
  });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20",
    r2Buckets: ["BUCKET"], d1Databases: Object.values(bindings), log: new Log(LogLevel.ERROR) });
  try {
    const directory = new URL("migrations/", root);
    const migrations = readdirSync(directory).filter(name => name.endsWith(".sql")).sort()
      .flatMap(name => splitSql(readFileSync(new URL(name, directory), "utf8")));
    for (const binding of Object.values(bindings)) {
      const db = await mf.getD1Database(binding);
      await db.batch(migrations.map(sql => db.prepare(sql)));
    }
    async function exercise(mode) {
      const response = await mf.dispatchFetch("https://qualification.test/", {
        method: "POST", body: JSON.stringify({ mode, binding: bindings[mode] }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.missingPoll.status, 404);
      assert.equal(result.otherActor.status, 404, "request state is visible only to its accepting actor");
      assert.equal(result.stats.deletes, 0);
      assert.equal(JSON.stringify([result.first, result.retry]).includes("synthetic secret"), false);
      return result;
    }
    function acceptedBeforeIo(result) {
      assert.equal(result.afterFirst.imports.length, 1);
      assert.equal(result.afterFirst.storage_profiles.length, 1);
      const row = result.afterFirst.imports[0];
      assert.equal(row.client_request_id, requestId);
      assert.equal(row.actor_email, "owner@example.com");
      assert.equal(row.request_scope, "system");
      assert.match(row.request_sha256, /^[a-f0-9]{64}$/);
      assert.equal(typeof JSON.parse(row.request_input_json), "object");
      assert.equal(row.storage_profile_id, result.afterFirst.storage_profiles[0].id);
      assert.equal(row.storage_profile_revision, 1);
      assert.equal(row.storage_policy_revision, 1);
      for (const observed of result.stats.acceptedBeforeEachPut) {
        assert.equal(observed.id, row.id);
        assert.equal(observed.operation_id, row.operation_id);
        assert.equal(observed.status, "pending");
        assert.equal(observed.request_sha256, row.request_sha256);
        assert.equal(observed.storage_profile_id, row.storage_profile_id);
      }
      assert.deepEqual(result.afterRetry, result.retryBefore, "retry, conflict, profile mismatch and polling never mutate accepted state");
      assert.deepEqual(result.stats, result.firstStats, "retry never opens the provider or starts another execution");
      assert.equal(result.namespaceMismatch.status, 503);
      return row;
    }
    for (const mode of ["replay", "lost-acceptance-ack", "lost-finalization-ack"]) {
      await t.test(mode + " returns the same durable ready result with no replayed PUT", async () => {
        const result = await exercise(mode);
        const row = acceptedBeforeIo(result);
        assert.equal(result.first.status, 201);
        assert.equal(result.retry.status, 200);
        assert.deepEqual(result.retry.body, result.first.body);
        assert.deepEqual(JSON.parse(row.accepted_result_json), result.first.body);
        assert.deepEqual(result.state, { status: 200, body: {
          requestId, importId: row.id, status: "ready", result: result.first.body,
        } });
        assert.equal(result.firstStats.puts.length, 3);
        assert.equal(new Set(result.firstStats.puts).size, 3);
        for (const physical of result.physical) {
          const asset = result.afterFirst.assets.find(asset => asset.r2_key === physical.key);
          assert.equal(physical.byteSize, asset.byte_size);
          assert.equal(physical.sha256, asset.sha256);
        }
        assert.equal(result.afterFirst.template_versions.length, result.before.template_versions.length + 1);
        if (mode === "replay") {
          assert.equal(result.conflicts.length, 4);
          assert(result.conflicts.every(response => response.status === 409));
        }
        if (mode === "lost-acceptance-ack") assert.equal(result.stats.lostAcceptance, 1);
        if (mode === "lost-finalization-ack") assert.equal(result.stats.lostFinalization, 1);
      });
    }
    await t.test("concurrent identical acceptance has one executor and one durable result", async () => {
      const result = await exercise("concurrent");
      const row = acceptedBeforeIo(result);
      assert.equal(result.stats.insertAttempts, 2, "both requests reached the real D1 unique constraint race");
      assert.equal(result.first.filter(response => response.status === 201).length, 1);
      assert(result.first.every(response => [200, 201, 409].includes(response.status)));
      assert.equal(result.stats.puts.length, 3);
      assert.equal(result.afterFirst.template_versions.length, result.before.template_versions.length + 1);
      assert.equal(result.retry.status, 200);
      assert.deepEqual(result.retry.body, JSON.parse(row.accepted_result_json));
    });
    await t.test("in-flight status and retry expose pending ownership without provider replay", async () => {
      const result = await exercise("held-pending");
      const row = acceptedBeforeIo(result);
      assert.equal(result.pending.status, 409);
      assert.deepEqual(result.pending.body.request, result.pendingPoll.body);
      assert.equal(result.pendingPoll.status, 200);
      assert.equal(result.pendingPoll.body.status, "pending");
      assert.equal(result.pendingPoll.body.requestId, requestId);
      assert.equal(result.pendingPoll.body.importId, row.id);
      assert.equal(typeof result.pendingPoll.body.leaseExpiresAt, "string");
      assert.deepEqual(result.pendingStats.after.puts, result.pendingStats.before.puts);
      assert.equal(result.first.status, 201);
      assert.equal(result.retry.status, 200);
    });
    for (const mode of ["failed", "pending-error"]) {
      await t.test(mode + " keeps the accepted terminal or uncertain outcome and refuses to restart", async () => {
        const result = await exercise(mode);
        const row = acceptedBeforeIo(result);
        const expected = mode === "failed" ? "failed" : "pending";
        assert.equal(result.first.status, 503);
        assert.equal(row.status, expected);
        assert.equal(row.accepted_result_json, null);
        assert.equal(result.retry.status, 409);
        assert.equal(result.retry.body.request.status, expected);
        assert.deepEqual(result.retry.body.request, result.state.body);
        assert.deepEqual(result.afterFirst.template_versions, result.before.template_versions);
        if (mode === "pending-error") {
          assert.deepEqual(result.recoveryMismatch, { rejected: true });
          assert.equal(row.recovery_operation_id, null);
        }
      });
    }
    for (const mode of ["missing-header", "missing-namespace"]) {
      await t.test(mode + " rejects before acceptance or storage I/O", async () => {
        const result = await exercise(mode);
        assert.equal(result.first.status, mode === "missing-header" ? 428 : 503);
        assert.deepEqual(result.afterFirst, result.before);
        assert.deepEqual(result.afterRetry, result.before);
        assert.equal(result.stats.insertAttempts, 0);
        assert.deepEqual(result.stats.puts, []);
        assert.deepEqual(result.stats.gets, []);
        assert.deepEqual(result.stats.heads, []);
      });
    }
  } finally {
    await mf.dispose();
  }
});
