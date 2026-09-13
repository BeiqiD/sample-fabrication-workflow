import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";

const root = new URL("../", import.meta.url);
const NOW = "2026-09-13T12:00:00.000Z";
const profiles = [{
  id: "legacy-r2", adapterType: "r2", namespaceIdentity: "r2:account:bucket",
  configurationSource: "bootstrap", credentialReference: null, configurationRevision: 1,
}, {
  id: "legacy-switch", adapterType: "switchdrive", namespaceIdentity: "switchdrive:drive.example:user-root",
  configurationSource: "environment", credentialReference: "environment:SWITCHDRIVE", configurationRevision: 1,
}];

function hostAdapter(database) {
  const prepare = (sql, values = []) => ({
    bind(...bindings) { return prepare(sql, bindings); },
    async all() { return { success: true, results: database.prepare(sql).all(...values) }; },
    execute() { database.prepare(sql).run(...values); return { success: true }; },
  });
  return {
    prepare,
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        database.exec("COMMIT");
        return results;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
}

async function inventoryRows(db) {
  const rows = {};
  for (const table of ["storage_profiles", "files", "file_locations", "legacy_file_mappings"]) {
    rows[table] = (await db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3`).all()).results;
  }
  return JSON.parse(JSON.stringify(rows));
}

async function exercise(db, service) {
  for (const migration of ["0001_v3_baseline.sql", "0002_fp1_file_registry.sql"]) {
    await db.batch(splitSql(readFileSync(new URL(`migrations/${migration}`, root), "utf8")).map((sql) => db.prepare(sql)));
  }
  await db.batch([
    db.prepare(`INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES ('asset', 'same-key', 'file.png', 'image/png', 10, 'ready', ?, ?)`).bind("a".repeat(64), NOW),
    db.prepare(`INSERT INTO managed_storage_objects (id, provider, object_key, original_name, mime_type, byte_size, sha256, status, created_at)
      VALUES ('managed', 'switchdrive', 'same-key', 'file.png', 'image/png', 10, ?, 'failed', ?)`).bind("a".repeat(64), NOW),
    db.prepare(`INSERT INTO imports
      (id, status, source_filename, source_sha256, sheet_name, template_type, workbook_asset_key, manifest_asset_key, created_at)
      VALUES ('import', 'ready', 'source.xlsx', ?, 'sheet', 'process', 'direct-workbook', 'direct-manifest', ?)`).bind("b".repeat(64), NOW),
    db.prepare(`INSERT INTO blob_gc_ledger (store_kind, provider, object_key, state, updated_at, last_error)
      VALUES ('r2', 'r2', 'gc-only', 'deleted', ?, 'SECRET-not-evidence')`).bind(NOW),
  ]);
  const beforeRetention = (await db.prepare("SELECT * FROM blob_retention_edges ORDER BY object_key").all()).results;
  const page = await service.readLegacyInventoryPage(db, { observedAt: NOW, limit: 3 });
  assert.equal(page.observations.length, 3);
  assert(page.nextCursor);
  const plan = await service.registerLegacyInventory(db, page, profiles);
  const captured = await inventoryRows(db);
  assert.deepEqual(await service.registerLegacyInventory(db, page, profiles), plan);
  assert.deepEqual(await inventoryRows(db), captured);
  const next = await service.readLegacyInventoryPage(db, { observedAt: "2026-09-13T12:01:00.000Z", limit: 3, after: page.nextCursor });
  assert.equal(next.observations.length, 2);
  assert.equal(next.nextCursor, null);
  await service.registerLegacyInventory(db, next, profiles);
  const all = await inventoryRows(db);
  assert.equal(all.files.length, 5);
  assert(all.files.every((file) => file.state === "unresolved" && file.active_location_id === null && file.verified_sha256 === null));
  assert.equal(all.file_locations.filter((location) => location.object_key === "same-key").length, 2);
  assert(!JSON.stringify(all).includes("SECRET"));
  assert.deepEqual((await db.prepare("SELECT * FROM blob_retention_edges ORDER BY object_key").all()).results, beforeRetention);
  await assert.rejects(service.registerLegacyInventory(db, next, [
    { ...profiles[0], namespaceIdentity: "r2:different-account:different-bucket" }, profiles[1],
  ]));
  const changed = structuredClone(page.observations[0]);
  changed.records[0].byte_size = 11;
  const newCandidate = { ...structuredClone(changed), objectKey: "must-roll-back", consumers: [] };
  await assert.rejects(service.registerLegacyInventory(db, { observedAt: NOW, observations: [newCandidate, changed] }, profiles));
  assert.deepEqual(await inventoryRows(db), all, "conflicts roll back the entire page, including a newly inserted candidate");
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  return all;
}

test("the real inventory service observes, registers and retries bounded pages identically on SQLite and local D1", { timeout: 60_000 }, async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("worker/files/legacy-inventory.ts", root))],
    bundle: true, format: "esm", platform: "neutral", write: false,
  });
  const service = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  const host = new DatabaseSync(":memory:");
  const mf = new Miniflare({
    modules: true, script: 'export default { fetch() { return new Response("FP1 local inventory qualification") } }',
    compatibilityDate: "2026-07-20", d1Databases: ["DB"], log: new Log(LogLevel.ERROR),
  });
  try {
    const expected = await exercise(hostAdapter(host), service);
    const actual = await exercise(await mf.getD1Database("DB"), service);
    assert.deepEqual(actual, expected);
  } finally { host.close(); await mf.dispose(); }
});
