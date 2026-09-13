import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";

const root = new URL("../", import.meta.url);
const LIMIT = 100 * 1024 * 1024;
const SMALL_SIZE = 128 * 1024 + 1;
const modes = ["known", "null-sha", "corrupt", "canonical", "corrupt-canonical",
  "truncated", "tail-error", "over-limit", "null-limit", "claim-race",
  "key-race", "source-gc-race", "canonical-gc-race", "quarantine-race", "finalization-race"];
const bindings = Object.fromEntries(modes.map((mode, index) => [mode, "DB_" + index]));

function digest(byteSize) {
  const hash = createHash("sha256");
  for (let offset = 0; offset < byteSize; offset += 1024 * 1024) {
    hash.update(Buffer.alloc(Math.min(1024 * 1024, byteSize - offset), 7));
  }
  return hash.digest("hex");
}

const workerSource = `
import worker from "./worker/index.ts";
import { inspectFabubloxRecoveryAssets } from "./worker/fabublox-recovery-assets.ts";
import { queueFabubloxImportCleanup } from "./worker/fabublox-import-recovery.ts";

export default {
  async fetch(request, env, ctx) {
    const { mode, binding, byteSize } = await request.json();
    const db = env[binding];
    const key = "imports/a/" + mode + ".bin";
    const canonicalKey = "ready/" + mode + ".bin";
    const stats = { gets: [], heads: [], deletes: 0, streamedBytes: 0, streamCancels: 0,
      nativeDigestStream: typeof crypto.DigestStream === "function" };
    const bytes = new Uint8Array(${SMALL_SIZE}).fill(7);
    if (mode === "corrupt") bytes[0] ^= 1;
    // Ordinary fixtures use physical R2 objects. Only fault injection and the
    // 100 MiB boundary case replace transport; database and recovery stay real.
    await env.BUCKET.put(key, mode === "truncated" ? bytes.subarray(0, bytes.length - 1) : bytes,
      { httpMetadata: { contentType: "application/octet-stream" } });
    if (mode === "canonical" || mode === "corrupt-canonical" || mode === "canonical-gc-race") {
      const winnerBytes = bytes.slice();
      if (mode === "corrupt-canonical") winnerBytes[0] ^= 1;
      await env.BUCKET.put(canonicalKey, winnerBytes,
        { httpMetadata: { contentType: "application/octet-stream" } });
    }
    let phase = "inspection";
    let cleanupGets = 0;
    let concurrentSnapshot = null;
    const release = [];
    const arrival = [];
    const arrived = [0, 1].map(index => new Promise(resolve => { arrival[index] = resolve; }));
    const holds = [0, 1].map(index => new Promise(resolve => { release[index] = resolve; }));
    const bucket = {
      async get(objectKey) {
        stats.gets.push(objectKey);
        if (mode === "claim-race" && phase === "cleanup") {
          const index = cleanupGets++;
          arrival[index]();
          await holds[index];
        }
        const object = await env.BUCKET.get(objectKey);
        if (!object) return null;
        if (phase === "cleanup" && concurrentSnapshot === null
          && ["key-race", "source-gc-race", "canonical-gc-race", "quarantine-race", "finalization-race"].includes(mode)
          && objectKey === (mode === "canonical-gc-race" ? canonicalKey : key)) {
          // Mutate real D1 after bytes were opened, before their verified result
          // reaches the recovery claim. The atomic fence must reject that stale
          // observation without undoing the legitimate concurrent mutation.
          if (mode === "key-race") {
            await db.prepare("UPDATE assets SET r2_key = ? WHERE id = 'shared-asset'")
              .bind(key + ".replaced").run();
          } else if (mode === "source-gc-race" || mode === "canonical-gc-race") {
            await db.prepare("INSERT INTO blob_gc_ledger (store_kind, provider, object_key, blob_record_id, state, operation_id, deletion_started_at, attempt_count, updated_at) VALUES ('r2', 'r2', ?, ?, 'deleting', 'concurrent-gc', '2026-09-13T00:00:00.000Z', 1, '2026-09-13T00:00:00.000Z')")
              .bind(objectKey, mode === "canonical-gc-race" ? "canonical-winner" : "shared-asset").run();
          } else if (mode === "quarantine-race") {
            await db.prepare("INSERT INTO blob_integrity_quarantine (store_kind, provider, object_key, blob_record_id, reason, expected_byte_size, observed_byte_size, operation_id, detected_at, last_checked_at) VALUES ('r2', 'r2', ?, 'shared-asset', 'size_mismatch', ?, 0, 'concurrent-quarantine', '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z')")
              .bind(key, byteSize).run();
          } else {
            await db.prepare("UPDATE imports SET status = 'ready', finalization_id = 'concurrent-finalization', completed_at = '2026-09-13T00:00:00.000Z', workbook_asset_key = ?, manifest_asset_key = ?, lease_expires_at = NULL WHERE id = 'import-a'")
              .bind(key, key).run();
          }
          concurrentSnapshot = await snapshot();
        }
        if (mode === "null-limit") {
          await object.body.cancel();
          let offset = 0;
          return {
            size: byteSize, httpEtag: object.httpEtag,
            writeHttpMetadata: headers => object.writeHttpMetadata(headers),
            body: new ReadableStream({
              pull(controller) {
                if (offset === byteSize) { controller.close(); return; }
                const chunk = new Uint8Array(Math.min(1024 * 1024, byteSize - offset)).fill(7);
                offset += chunk.byteLength;
                stats.streamedBytes += chunk.byteLength;
                controller.enqueue(chunk);
              },
              cancel() { stats.streamCancels++; },
            }, { highWaterMark: 0 }),
          };
        }
        if (mode !== "tail-error") return object;
        const reader = object.body.getReader();
        return {
          size: object.size, httpEtag: object.httpEtag,
          writeHttpMetadata: headers => object.writeHttpMetadata(headers),
          body: new ReadableStream({
            async pull(controller) {
              const result = await reader.read();
              if (result.done) {
                reader.releaseLock();
                controller.error(new Error("synthetic transport secret after complete bytes"));
              } else {
                stats.streamedBytes += result.value.byteLength;
                controller.enqueue(result.value);
              }
            },
            async cancel() { stats.streamCancels++; await reader.cancel(); reader.releaseLock(); },
          }, { highWaterMark: 0 }),
        };
      },
      async head(objectKey) { stats.heads.push(objectKey); return env.BUCKET.head(objectKey); },
      async delete() { stats.deletes++; throw new Error("recovery must not delete bytes"); },
    };
    const recoveryEnv = { DB: db, ASSETS: bucket, AUTH_MODE: "disabled" };
    async function snapshot() {
      const tables = ["imports", "assets", "state_representation_assets", "samples",
        "template_versions", "blob_gc_ledger", "blob_integrity_quarantine"];
      const snapshot = {};
      for (const table of tables) {
        snapshot[table] = (await db.prepare("SELECT * FROM " + table).all()).results;
      }
      return snapshot;
    }
    async function media(objectKey) {
      const response = await worker.fetch(new Request("https://app.test/api/assets/" + objectKey),
        { DB: db, ASSETS: env.BUCKET, AUTH_MODE: "disabled" }, ctx);
      if (response.status !== 200) { await response.body?.cancel(); return { status: response.status }; }
      const data = await response.arrayBuffer();
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
        .map(byte => byte.toString(16).padStart(2, "0")).join("");
      return { status: response.status, byteSize: data.byteLength, sha256 };
    }
    const before = await snapshot();
    const mediaBefore = await media(key);
    let inspections = null;
    let inspectionError = null;
    try { inspections = await inspectFabubloxRecoveryAssets(recoveryEnv, db, "import-a"); }
    catch (error) { inspectionError = { name: error.name, message: error.message }; }
    const afterInspection = await snapshot();
    const inspectionStats = structuredClone(stats);
    phase = "cleanup";
    let cleanup = null;
    let cleanupError = null;
    let race = null;
    const clean = recoveryOperationId => queueFabubloxImportCleanup(recoveryEnv, {
      importId: "import-a", operationId: "operation-a", recoveryOperationId,
      error: "qualification recovery", now: new Date("2026-09-13T00:00:00.000Z"),
    });
    try {
      if (mode === "claim-race") {
        const first = clean("recovery-first");
        await arrived[0];
        const second = clean("recovery-second");
        await arrived[1];
        release[1]();
        const winner = await second;
        const afterWinner = await snapshot();
        release[0]();
        race = { winner, loser: await first, afterWinner };
      } else { cleanup = await clean("recovery-qualification"); }
    } catch (error) { cleanupError = { name: error.name, message: error.message }; }
    const afterCleanup = await snapshot();
    // The large case is a streaming transport qualification, so do not mistake
    // the small backing R2 placeholder for its simulated 100 MiB response.
    const mediaAfter = mode === "null-limit" ? null : await media(key);
    const canonicalMedia = mode === "canonical" ? await media(canonicalKey) : null;
    return Response.json({ before, afterInspection, afterCleanup, mediaBefore, mediaAfter,
      canonicalMedia, inspections, inspectionError, cleanup, cleanupError, race, concurrentSnapshot, inspectionStats, stats });
  },
};
`;

function legacySeed(mode, byteSize, sha256) {
  const storedSha = ["null-sha", "canonical", "corrupt-canonical", "canonical-gc-race", "null-limit", "over-limit"].includes(mode)
    ? "NULL" : "'" + sha256 + "'";
  return splitSql(`
    INSERT INTO recipe_families (id, name, template_type, created_at)
      VALUES ('family-a', 'Recovery fixture', 'process', '2026-07-01T00:00:00.000Z');
    INSERT INTO state_representations (hash, representation_type, content_json, created_at)
      VALUES ('shared-state', 'diagram', '{}', '2026-07-01T00:00:00.000Z');
    INSERT INTO template_versions (id, recipe_family_id, name, template_type, version,
      manifest_hash, initial_state_hash, content_json, created_at, template_kind)
      VALUES ('template-a', 'family-a', 'Recovery fixture', 'process', 1, 'manifest-a',
        'shared-state', '{}', '2026-07-01T00:00:00.000Z', 'process');
    INSERT INTO imports (id, status, source_filename, source_sha256, sheet_name, template_type,
      recipe_family_id, template_version_id, created_at, completed_at, operation_id, lease_expires_at)
      VALUES ('import-a', '${mode === "finalization-race" ? "pending" : "failed"}', 'fixture.zip', '${"1".repeat(64)}', 'manifest', 'process',
        'family-a', 'template-a', '2026-07-01T00:00:00.000Z', ${mode === "finalization-race" ? "NULL" : "'2026-07-02T00:00:00.000Z'"},
        'operation-a', ${mode === "finalization-race" ? "'2026-09-14T00:00:00.000Z'" : "NULL"});
    INSERT INTO assets (id, import_id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES ('shared-asset', 'import-a', 'imports/a/${mode}.bin', 'fixture.bin',
        'application/octet-stream', ${byteSize}, '${mode === "finalization-race" ? "pending" : "failed"}', ${storedSha}, '2026-07-01T00:00:00.000Z');
    INSERT INTO state_representation_assets (state_hash, asset_id, position)
      VALUES ('shared-state', 'shared-asset', 0);
    INSERT INTO samples (id, code, title, inherited_state_hash, created_at, updated_at)
      VALUES ('public-sample', 'RECOVERY', 'Retained state consumer', 'shared-state',
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    ${mode === "canonical" || mode === "corrupt-canonical" || mode === "canonical-gc-race" ? `
      INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
        VALUES ('canonical-winner', 'ready/${mode}.bin', 'canonical.bin', 'application/octet-stream',
          ${byteSize}, 'ready', '${sha256}', '2026-06-01T00:00:00.000Z');` : ""}
  `);
}

test("native workerd FabuBlox recovery verifies bytes before real D1 claims and public adoption", { timeout: 120_000 }, async (t) => {
  const bundle = await build({
    stdin: { contents: workerSource, resolveDir: fileURLToPath(root), sourcefile: "fp1-recovery-worker.mjs" },
    bundle: true, format: "esm", platform: "neutral", write: false,
  });
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20",
    r2Buckets: ["BUCKET"], d1Databases: Object.values(bindings), log: new Log(LogLevel.ERROR),
  });
  const smallSha = digest(SMALL_SIZE);
  const largeSha = digest(LIMIT);
  const sizes = Object.fromEntries(modes.map(mode => [mode,
    mode === "null-limit" ? LIMIT : mode === "over-limit" ? LIMIT + 1 : SMALL_SIZE]));
  try {
    // Genuine historical occurrences can predate publication guards. Upgrade
    // the populated database instead of disabling present-day safety triggers.
    const directory = new URL("migrations-history/s0/", root);
    const migrationNames = readdirSync(directory).filter(name => name.endsWith(".sql")).sort();
    const statements = names => names.flatMap(name => splitSql(readFileSync(new URL(name, directory), "utf8")));
    const before = statements(migrationNames.filter(name => name <= "0024_blob_integrity_quarantine.sql"));
    const after = statements(migrationNames.filter(name => name > "0024_blob_integrity_quarantine.sql"));
    after.push(...splitSql(readFileSync(new URL("migrations/0002_fp1_file_registry.sql", root), "utf8")));
    for (const mode of modes) {
      const db = await mf.getD1Database(bindings[mode]);
      await db.batch(before.map(sql => db.prepare(sql)));
      await db.batch(legacySeed(mode, sizes[mode], mode === "null-limit" ? largeSha : smallSha).map(sql => db.prepare(sql)));
      await db.batch(after.map(sql => db.prepare(sql)));
    }
    async function exercise(mode) {
      const response = await mf.dispatchFetch("https://qualification.test/", {
        method: "POST", body: JSON.stringify({ mode, binding: bindings[mode], byteSize: sizes[mode] }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.stats.nativeDigestStream, true);
      assert.equal(result.stats.deletes, 0);
      assert.equal(result.mediaBefore.status, 404, "failed import bytes are private before recovery");
      assert.deepEqual(result.afterInspection, result.before, "inspection cannot claim recovery or change occurrences");
      return result;
    }
    const asset = result => result.afterCleanup.assets.find(row => row.id === "shared-asset");
    const owner = result => result.afterCleanup.imports.find(row => row.id === "import-a");
    for (const mode of ["known", "null-sha", "null-limit"]) {
      await t.test(mode + " reads to EOF and only then publishes retained bytes", async () => {
        const result = await exercise(mode);
        const expectedSha = mode === "null-limit" ? largeSha : smallSha;
        assert.equal(result.inspectionError, null);
        assert.equal(result.cleanupError, null);
        assert.equal(result.inspections[0].available, true);
        assert.equal(result.inspections[0].sha256, expectedSha);
        assert.equal(result.cleanup.importsFailed, 1);
        assert.equal(asset(result).status, "ready");
        assert.equal(asset(result).import_id, null);
        assert.equal(asset(result).sha256, expectedSha);
        assert.equal(asset(result).byte_size, sizes[mode]);
        assert.equal(owner(result).recovery_operation_id, "recovery-qualification");
        assert.deepEqual(result.afterCleanup.state_representation_assets, result.before.state_representation_assets);
        assert.deepEqual(result.afterCleanup.samples, result.before.samples);
        assert.equal(result.afterCleanup.blob_integrity_quarantine.length, 0);
        assert.equal(result.afterCleanup.blob_gc_ledger.length, 0);
        assert.deepEqual(result.stats.heads, [], "a metadata-only check cannot verify recovery bytes");
        assert.equal(result.inspectionStats.gets.length, 1);
        assert.equal(result.stats.gets.length, 2, "cleanup performs its own fresh pre-claim verification");
        if (mode === "null-limit") {
          assert.equal(result.inspectionStats.streamedBytes, LIMIT);
          assert.equal(result.stats.streamedBytes, 2 * LIMIT);
        } else {
          assert.deepEqual(result.mediaAfter, { status: 200, byteSize: SMALL_SIZE, sha256: smallSha });
        }
      });
    }
    for (const mode of ["corrupt", "corrupt-canonical", "tail-error", "over-limit"]) {
      await t.test(mode + " fails before a recovery claim or durable occurrence adoption", async () => {
        const result = await exercise(mode);
        assert.equal(result.inspections, null);
        assert.equal(result.inspectionError.name, "FabubloxRecoveryProviderUnavailableError");
        assert.equal(result.cleanupError.name, "FabubloxRecoveryProviderUnavailableError");
        assert(!JSON.stringify(result.inspectionError).includes("synthetic transport secret"));
        assert(!JSON.stringify(result.cleanupError).includes("synthetic transport secret"));
        assert.deepEqual(result.afterCleanup, result.before);
        assert.equal(result.mediaAfter.status, 404);
        if (mode === "over-limit") assert.deepEqual(result.stats.gets, [], "reject unsupported size before opening GET");
        if (mode === "corrupt-canonical") assert(result.inspectionStats.gets.includes("ready/corrupt-canonical.bin"));
        if (mode === "tail-error") assert.equal(result.inspectionStats.streamedBytes, SMALL_SIZE,
          "receiving every expected byte without successful EOF is insufficient");
      });
    }
    await t.test("verified canonical bytes are adopted and only the old locator is queued", async () => {
      const result = await exercise("canonical");
      assert.equal(result.cleanupError, null);
      assert.equal(result.inspections[0].canonicalAssetId, "canonical-winner");
      assert.deepEqual(result.afterCleanup.state_representation_assets,
        [{ state_hash: "shared-state", asset_id: "canonical-winner", position: 0 }]);
      assert.deepEqual(result.afterCleanup.samples, result.before.samples);
      assert.equal(asset(result).status, "failed");
      assert.equal(asset(result).sha256, null);
      assert.equal(result.afterCleanup.blob_gc_ledger.length, 1);
      assert.equal(result.afterCleanup.blob_gc_ledger[0].object_key, "imports/a/canonical.bin");
      assert.equal(result.afterCleanup.blob_gc_ledger[0].state, "orphaned");
      assert.equal(result.mediaAfter.status, 404);
      assert.deepEqual(result.canonicalMedia, { status: 200, byteSize: SMALL_SIZE, sha256: smallSha });
      assert(result.inspectionStats.gets.includes("ready/canonical.bin"));
    });
    await t.test("clean short EOF retains the historical occurrence behind size quarantine", async () => {
      const result = await exercise("truncated");
      assert.equal(result.cleanupError, null);
      assert.equal(result.inspections[0].available, false);
      assert.equal(result.inspections[0].quarantineReason, "size_mismatch");
      assert.equal(result.inspections[0].observedByteSize, SMALL_SIZE - 1);
      assert.deepEqual(result.afterCleanup.state_representation_assets, result.before.state_representation_assets);
      assert.deepEqual(result.afterCleanup.samples, result.before.samples);
      assert.equal(asset(result).status, "failed");
      assert.equal(asset(result).sha256, null);
      assert.equal(result.afterCleanup.blob_integrity_quarantine[0].reason, "size_mismatch");
      assert.equal(result.afterCleanup.blob_integrity_quarantine[0].observed_byte_size, SMALL_SIZE - 1);
      assert.equal(result.afterCleanup.blob_gc_ledger.length, 0);
      assert.equal(result.mediaAfter.status, 404);
    });
    await t.test("real D1 fences a slower verifier after another recovery claim has committed", async () => {
      const result = await exercise("claim-race");
      assert.equal(result.cleanupError, null);
      assert.equal(result.race.winner.importsFailed, 1);
      assert.equal(result.race.loser.importsFailed, 0);
      assert(Object.values(result.race.loser).every(value => value === 0));
      assert.equal(owner(result).recovery_operation_id, "recovery-second");
      assert.deepEqual(result.afterCleanup, result.race.afterWinner,
        "a stale verified result cannot replace the winner's durable recovery identity");
      assert.deepEqual(result.mediaAfter, { status: 200, byteSize: SMALL_SIZE, sha256: smallSha });
    });
    for (const mode of ["key-race", "source-gc-race", "canonical-gc-race", "quarantine-race"]) {
      await t.test(mode + " rolls back the claim when inspected metadata or health changes during GET", async () => {
        const result = await exercise(mode);
        assert.equal(result.inspectionError, null);
        assert.equal(result.inspections[0].available, true);
        assert(result.concurrentSnapshot, "the conflicting write actually committed in real D1");
        assert(result.cleanupError, "the adjacent changes()-guarded assertion must abort the stale claim");
        assert.deepEqual(result.afterCleanup, result.concurrentSnapshot,
          "claim and all cleanup statements roll back while the independent concurrent write survives");
        assert.equal(owner(result).recovery_operation_id, null);
        assert.deepEqual(result.afterCleanup.state_representation_assets, result.before.state_representation_assets);
        assert.deepEqual(result.afterCleanup.samples, result.before.samples);
        assert.equal(result.mediaAfter.status, 404);
      });
    }
    await t.test("a finalization committed during GET wins; the adjacent zero-change guard is a no-op", async () => {
      const result = await exercise("finalization-race");
      assert.equal(result.inspectionError, null);
      assert.equal(result.cleanupError, null);
      assert(result.concurrentSnapshot);
      assert(Object.values(result.cleanup).every(value => value === 0));
      assert.deepEqual(result.afterCleanup, result.concurrentSnapshot);
      assert.equal(owner(result).status, "ready");
      assert.equal(owner(result).finalization_id, "concurrent-finalization");
      assert.equal(owner(result).recovery_operation_id, null);
      assert.equal(asset(result).status, "ready");
      assert.equal(asset(result).import_id, "import-a");
      assert.deepEqual(result.mediaAfter, { status: 200, byteSize: SMALL_SIZE, sha256: smallSha });
    });
  } finally {
    await mf.dispose();
  }
});
