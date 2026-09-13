import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";

const root = new URL("../", import.meta.url);
const workerSource = `
import { r2ByteDeleter } from "./worker/files/storage-adapters/r2-deleter.ts";
import { collectBlobGarbage, runBlobGarbageCollection } from "./worker/blob-lifecycle/gc.ts";

export default {
  async fetch(request, env) {
    const { mode } = await request.json();
    const key = "qualification/" + mode + "/object.bin";
    const stats = { deletes: 0, gets: 0, heads: 0 };
    if (mode !== "gc-managed-rollback") {
      await env.BUCKET_A.put(key, "exact instance");
      await env.BUCKET_B.put(key, "other instance");
    }
    let onFirstDelete;
    const firstDelete = new Promise((resolve) => { onFirstDelete = resolve; });
    let releaseFirstDelete;
    const heldDelete = new Promise((resolve) => { releaseFirstDelete = resolve; });
    let onReclaimStat;
    const reclaimStat = new Promise((resolve) => { onReclaimStat = resolve; });
    let releaseReclaimStat;
    const heldStat = new Promise((resolve) => { releaseReclaimStat = resolve; });
    const bucket = {
      async delete(objectKey) {
        stats.deletes++;
        const attempt = stats.deletes;
        await env.BUCKET_A.delete(objectKey);
        if (attempt === 1) {
          onFirstDelete();
          if (mode.startsWith("gc-overlap")) await heldDelete;
          if (mode === "lost-ack" || mode === "gc-lost-ack" || mode === "gc-overlap-lost-ack") {
            throw new Error("synthetic provider credential and response body must not escape");
          }
        }
      },
      async get(objectKey) { stats.gets++; return env.BUCKET_A.get(objectKey); },
      async head(objectKey) {
        stats.heads++;
        if (mode.startsWith("gc-overlap")) {
          onReclaimStat();
          await heldStat;
        }
        return env.BUCKET_A.head(objectKey);
      },
    };
    // Physical observations bypass the instrumented adapter dependency so they
    // cannot be confused with an adapter replay or metadata-based inference.
    async function physical() {
      const [exactHead, exactGet, otherGet] = await Promise.all([
        env.BUCKET_A.head(key), env.BUCKET_A.get(key), env.BUCKET_B.get(key),
      ]);
      return { exactHeadMissing: exactHead === null, exactGetMissing: exactGet === null,
        otherContents: otherGet ? await otherGet.text() : null };
    }
    if (!mode.startsWith("gc-")) {
      const deleter = r2ByteDeleter(bucket);
      const first = await deleter.delete(key);
      const afterFirst = await physical();
      const firstStats = { ...stats };
      // The second invocation belongs to the caller and deliberately happens
      // only after recording the first outcome and its provider-call count.
      const second = mode === "acknowledged" ? await deleter.delete(key) : null;
      return Response.json({ first, second, afterFirst, firstStats, stats });
    }

    const old = "2026-01-01T00:00:00.000Z";
    const now = new Date("2026-09-13T00:00:00.000Z");
    const retryAt = new Date("2026-09-13T00:16:00.000Z");
    if (mode === "gc-managed-rollback") {
      const db = env.DB_MANAGED_ROLLBACK;
      await db.batch([
        db.prepare("INSERT INTO managed_storage_objects (id, provider, object_key, original_name, mime_type, byte_size, sha256, status, created_at, orphaned_at) VALUES (?, 'switchdrive', ?, 'object.bin', 'application/octet-stream', 14, ?, 'orphaned', ?, ?)")
          .bind(mode, key, "a".repeat(64), old, old),
        db.prepare("INSERT INTO blob_gc_ledger (store_kind, provider, object_key, blob_record_id, state, orphaned_at, updated_at) VALUES ('managed', 'switchdrive', ?, ?, 'orphaned', ?, ?)")
          .bind(key, mode, old, old),
        db.prepare("CREATE TRIGGER qualification_abort_managed_finalization BEFORE UPDATE OF status ON managed_storage_objects WHEN NEW.status = 'deleted' BEGIN SELECT RAISE(ABORT, 'synthetic managed finalization failure'); END"),
      ]);
      const ledger = () => db.prepare("SELECT * FROM blob_gc_ledger WHERE object_key = ?").bind(key).first();
      const managed = () => db.prepare("SELECT * FROM managed_storage_objects WHERE id = ?").bind(mode).first();
      const beforeManaged = await managed();
      let objectExists = true;
      const observedLocators = [];
      // Only the provider transport is a fixture. This case qualifies the real
      // D1 transaction spanning the two production finalization UPDATEs.
      const dependencies = { db, newOperationId: () => "managed-rollback-operation", storage: {
        async remove(locator) { stats.deletes++; observedLocators.push(locator); objectExists = false; },
        async stat(locator) {
          stats.heads++;
          observedLocators.push(locator);
          return objectExists ? { outcome: "available", byteSize: 14, contentType: "application/octet-stream", etag: null }
            : { outcome: "missing" };
        },
      } };
      const first = await collectBlobGarbage(dependencies, now);
      const afterFirst = await ledger();
      const managedAfterFirst = await managed();
      const firstStats = { ...stats };
      await db.prepare("DROP TRIGGER qualification_abort_managed_finalization").run();
      const retry = await collectBlobGarbage(dependencies, retryAt);
      return Response.json({ first, afterFirst, beforeManaged, managedAfterFirst, firstStats,
        retry, afterRetry: await ledger(), managedAfterRetry: await managed(), observedLocators, stats });
    }
    const db = mode === "gc-lost-ack" ? env.DB_LOST
      : mode === "gc-overlap-ack" ? env.DB_OVERLAP_ACK : env.DB_OVERLAP_LOST;
    await db.batch([
      db.prepare("INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, created_at) VALUES (?, ?, 'object.bin', 'application/octet-stream', 14, 'ready', ?)")
        .bind(mode, key, old),
      db.prepare("INSERT INTO blob_gc_ledger (store_kind, provider, object_key, blob_record_id, state, orphaned_at, updated_at) VALUES ('r2', 'r2', ?, ?, 'orphaned', ?, ?)")
        .bind(key, mode, old, old),
    ]);
    const gcEnv = { DB: db, ASSETS: bucket };
    const ledger = () => db.prepare("SELECT * FROM blob_gc_ledger WHERE object_key = ?").bind(key).first();
    if (mode === "gc-lost-ack") {
      const first = await runBlobGarbageCollection(gcEnv, now);
      const afterFirst = await ledger();
      const firstStats = { ...stats };
      const physicalAfterFirst = await physical();
      const early = await runBlobGarbageCollection(gcEnv, now);
      const afterEarly = await ledger();
      const earlyStats = { ...stats };
      const retry = await runBlobGarbageCollection(gcEnv, retryAt);
      return Response.json({ first, afterFirst, firstStats, physicalAfterFirst, early, afterEarly,
        earlyStats, retry, afterRetry: await ledger(), stats, physicalAfterRetry: await physical() });
    }
    const oldAttempt = runBlobGarbageCollection(gcEnv, now);
    await firstDelete;
    const afterClaim = await ledger();
    const newAttemptPending = runBlobGarbageCollection(gcEnv, retryAt);
    await reclaimStat;
    const afterReclaim = await ledger();
    releaseFirstDelete();
    const oldResult = await oldAttempt;
    const afterOldAttempt = await ledger();
    releaseReclaimStat();
    const newAttempt = await newAttemptPending;
    return Response.json({ afterClaim, afterReclaim, oldResult, afterOldAttempt,
      newAttempt, afterNewAttempt: await ledger(), stats, physical: await physical() });
  },
};
`;

test("native workerd R2 deletion and real D1 claims preserve physical identity and uncertain outcomes", { timeout: 60_000 }, async (t) => {
  const bundle = await build({
    stdin: { contents: workerSource, resolveDir: fileURLToPath(root), sourcefile: "fp1-byte-deletion-worker.mjs" },
    bundle: true, format: "esm", platform: "neutral", write: false,
  });
  const databases = ["DB_LOST", "DB_OVERLAP_ACK", "DB_OVERLAP_LOST", "DB_MANAGED_ROLLBACK"];
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20",
    r2Buckets: ["BUCKET_A", "BUCKET_B"], d1Databases: databases, log: new Log(LogLevel.ERROR),
  });
  async function exercise(mode) {
    const response = await mf.dispatchFetch("https://qualification.test/", {
      method: "POST", body: JSON.stringify({ mode }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.stats.gets, 0, "deletion and stale-claim reconciliation must not open content GET");
    if (!mode.startsWith("gc-")) assert.equal(result.stats.heads, 0, "the adapter must not infer acknowledgement from HEAD");
    return result;
  }
  const physicalExpected = { exactHeadMissing: true, exactGetMissing: true, otherContents: "other instance" };
  try {
    const directory = new URL("migrations/", root);
    const migrations = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()
      .flatMap((name) => splitSql(readFileSync(new URL(name, directory), "utf8")));
    for (const name of databases) {
      const db = await mf.getD1Database(name);
      await db.batch(migrations.map((sql) => db.prepare(sql)));
    }
    await t.test("deletes one exact binding while the same key in another binding survives; explicit missing retry acknowledges", async () => {
      const result = await exercise("acknowledged");
      assert.deepEqual(result.first, { outcome: "acknowledged" });
      assert.deepEqual(result.afterFirst, physicalExpected);
      assert.deepEqual(result.firstStats, { deletes: 1, gets: 0, heads: 0 });
      assert.deepEqual(result.second, { outcome: "acknowledged" });
      assert.deepEqual(result.stats, { deletes: 2, gets: 0, heads: 0 });
    });
    await t.test("a lost acknowledgement stays unavailable despite physical absence and performs exactly one provider DELETE", async () => {
      const result = await exercise("lost-ack");
      assert.deepEqual(result.first, { outcome: "unavailable" });
      assert.deepEqual(result.afterFirst, physicalExpected);
      assert.deepEqual(result.stats, { deletes: 1, gets: 0, heads: 0 });
      assert.equal(result.second, null);
    });
    await t.test("real D1 keeps a lost acknowledgement fenced until a later lease reclaim acknowledges absence", async () => {
      const result = await exercise("gc-lost-ack");
      assert.equal(result.first.imageDeleted, 0);
      assert.equal(result.first.failures, 1);
      assert.equal(result.afterFirst.state, "deleting");
      assert.equal(result.afterFirst.attempt_count, 1);
      assert.equal(result.afterFirst.deleted_at, null);
      assert.equal(result.afterFirst.deletion_started_at, "2026-09-13T00:00:00.000Z");
      assert.equal(typeof result.afterFirst.last_error, "string");
      assert(!result.afterFirst.last_error.includes("synthetic provider"));
      assert.deepEqual(result.physicalAfterFirst, physicalExpected);
      assert.deepEqual(result.firstStats, { deletes: 1, gets: 0, heads: 0 });
      assert.deepEqual(result.afterEarly, result.afterFirst);
      assert.deepEqual(result.earlyStats, result.firstStats, "before lease expiry GC cannot replay DELETE");
      assert.equal(result.retry.imageDeleted, 1);
      assert.equal(result.retry.failures, 0);
      assert.equal(result.afterRetry.state, "deleted");
      assert.equal(result.afterRetry.attempt_count, 2);
      assert.equal(result.afterRetry.deleted_at, "2026-09-13T00:16:00.000Z");
      assert.equal(result.afterRetry.last_error, null);
      assert.deepEqual(result.stats, { deletes: 1, gets: 0, heads: 1 },
        "explicit later GC reconciles missing bytes without replaying the uncertain DELETE");
      assert.deepEqual(result.physicalAfterRetry, physicalExpected);
    });
    for (const mode of ["gc-overlap-ack", "gc-overlap-lost-ack"]) {
      await t.test("real D1 fences an old " + (mode.endsWith("lost-ack") ? "lost acknowledgement" : "acknowledgement") + " while a newer claim still owns deletion", async () => {
        const result = await exercise(mode);
        assert.equal(result.afterClaim.state, "deleting");
        assert.equal(result.afterClaim.attempt_count, 1);
        assert.equal(result.afterReclaim.state, "deleting");
        assert.equal(result.afterReclaim.attempt_count, 2);
        assert.equal(result.afterReclaim.operation_id, result.afterClaim.operation_id,
          "attempt fencing is necessary even when the stable operation ID is unchanged");
        assert.equal(result.afterReclaim.deletion_started_at, "2026-09-13T00:16:00.000Z");
        assert.equal(result.afterReclaim.deleted_at, null);
        assert.deepEqual(result.afterOldAttempt, result.afterReclaim,
          "the old completion cannot finalize or change diagnostics on the newer deleting attempt");
        assert.equal(result.newAttempt.imageDeleted, 1);
        assert.equal(result.afterNewAttempt.state, "deleted");
        assert.equal(result.afterNewAttempt.attempt_count, 2);
        assert.equal(result.afterNewAttempt.deleted_at, "2026-09-13T00:16:00.000Z");
        assert.equal(result.oldResult.imageDeleted, 0);
        assert.deepEqual(result.stats, { deletes: 1, gets: 0, heads: 1 });
        assert.deepEqual(result.physical, physicalExpected);
      });
    }
    await t.test("real D1 rolls back the ledger when managed finalization fails inside the same batch", async () => {
      const result = await exercise("gc-managed-rollback");
      assert.equal(result.first.managedDeleted, 0);
      assert.equal(result.first.failures, 1);
      assert.equal(result.afterFirst.state, "deleting");
      assert.equal(result.afterFirst.attempt_count, 1);
      assert.equal(result.afterFirst.deleted_at, null,
        "the ledger's first UPDATE must roll back when the batch's managed UPDATE aborts");
      assert.equal(result.afterFirst.last_error, "deletion_unavailable");
      assert.deepEqual(result.managedAfterFirst, result.beforeManaged,
        "the aborted batch cannot partially publish managed-object deletion");
      assert.deepEqual(result.firstStats, { deletes: 1, gets: 0, heads: 0 });
      assert.equal(result.retry.managedDeleted, 1);
      assert.equal(result.retry.failures, 0);
      assert.equal(result.afterRetry.state, "deleted");
      assert.equal(result.afterRetry.attempt_count, 2);
      assert.equal(result.afterRetry.deleted_at, "2026-09-13T00:16:00.000Z");
      assert.equal(result.afterRetry.last_error, null);
      assert.deepEqual(result.managedAfterRetry, { ...result.beforeManaged, status: "deleted" });
      assert.deepEqual(result.stats, { deletes: 1, gets: 0, heads: 1 },
        "the next lease reconciles the acknowledged removal instead of issuing another DELETE");
      assert.deepEqual(result.observedLocators, Array.from({ length: 2 }, () => ({
        storeKind: "managed", provider: "switchdrive",
        objectKey: "qualification/gc-managed-rollback/object.bin", blobRecordId: "gc-managed-rollback",
      })));
    });
    t.diagnostic("Qualification uses local workerd, two actual local R2 bindings and migrated local D1 databases; the managed rollback case uses a provider transport fixture. It does not qualify a deployed provider or establish File/Location authority.");
  } finally { await mf.dispose(); }
});
