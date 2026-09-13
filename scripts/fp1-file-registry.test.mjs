import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { migrationSqlHash, planD1Migrations } from "./d1-migration-plan.mjs";
import { observeHostSchema } from "./lib/backend-schema-baseline.mjs";

const root = new URL("../", import.meta.url);
const baseline = readFileSync(new URL("migrations/0001_v3_baseline.sql", root), "utf8");
const suffix = readFileSync(new URL("migrations/0002_fp1_file_registry.sql", root), "utf8");
const fixture = readFileSync(new URL("worker/fixtures/reference-graph.sql", root), "utf8");
const registry = ["file_locations", "files", "legacy_file_mappings", "storage_profiles"];
const plain = (value) => JSON.parse(JSON.stringify(value));
const profile = (id, namespace = id) => `INSERT INTO storage_profiles VALUES ('${id}', 'r2', '${namespace}', 'bootstrap', NULL, 1, 'historical', '2026-09-13')`;
const file = (id, purpose = "'embedded_content'") => `INSERT INTO files VALUES ('${id}', ${purpose}, 'system', 5, '${"a".repeat(64)}', NULL, 'unresolved', NULL, '2026-09-13')`;
const location = (id, fileId, profileId, key = "same-key") => `INSERT INTO file_locations VALUES ('${id}', '${fileId}', '${profileId}', '${key}', 'unresolved', '2026-09-13')`;
const mapping = (fileId, locationId, key = "same-key", classification = "classified") => `INSERT INTO legacy_file_mappings VALUES ('r2', 'r2', '${key}', '${fileId}', '${locationId}', '${classification}', '{}', '2026-09-13')`;

function hostAdapter(db) {
  return {
    async all(sql) { return plain(db.prepare(sql).all()); },
    async batch(sql) {
      db.exec("BEGIN");
      try { for (const statement of sql) db.exec(statement); db.exec("COMMIT"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}
function d1Adapter(db) {
  return {
    async all(sql) { return (await db.prepare(sql).all()).results; },
    async batch(sql) { await db.batch(sql.map((statement) => db.prepare(statement))); },
  };
}
async function snapshot(db) {
  const schema = await db.all("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name <> '_cf_METADATA' ORDER BY type, name");
  const rows = {};
  for (const { name } of schema.filter(({ type }) => type === "table")) {
    rows[name] = (await db.all(`SELECT * FROM "${name}"`)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return { schema, rows, retention: await db.all("SELECT * FROM blob_retention_edges ORDER BY store_kind, provider, object_key, occurrence_id") };
}
async function exercise(db) {
  await db.batch(splitSql(baseline));
  await db.batch(splitSql(fixture));
  await db.batch(["CREATE TABLE d1_migrations (name TEXT PRIMARY KEY)", "INSERT INTO d1_migrations VALUES ('0001_v3_baseline.sql')"]);
  const before = await snapshot(db);
  const statements = splitSql(suffix);
  assert(statements.every((sql) => Buffer.byteLength(sql) < 100_000));
  await assert.rejects(db.batch([...statements, "INSERT INTO d1_migrations VALUES ('0002_fp1_file_registry.sql')", "INSERT INTO d1_migrations VALUES ('0001_v3_baseline.sql')"]), /UNIQUE/);
  assert.deepEqual(await snapshot(db), before, "failed suffix rolls back schema, populated data and ledger");
  await db.batch([...statements, "INSERT INTO d1_migrations VALUES ('0002_fp1_file_registry.sql')"]);
  const after = await snapshot(db);
  for (const object of before.schema) assert.deepEqual(after.schema.find(({ type, name }) => type === object.type && name === object.name), object);
  for (const [name, rows] of Object.entries(before.rows)) if (name !== "d1_migrations") assert.deepEqual(after.rows[name], rows, name);
  assert.deepEqual(after.retention, before.retention, "observations do not change legacy retention");
  assert.deepEqual(registry.map((name) => after.rows[name]), [[], [], [], []], "migration does not invent physical namespace or verified bytes");
  assert.deepEqual(after.rows.d1_migrations, [{ name: "0001_v3_baseline.sql" }, { name: "0002_fp1_file_registry.sql" }]);
  await db.batch([profile("one"), profile("two"), file("first"), file("second"), location("a", "first", "one"), location("b", "second", "two"), mapping("first", "a")]);
  assert.equal((await db.all("SELECT * FROM file_locations WHERE object_key = 'same-key'")).length, 2, "same key on different instances is distinct");
  const captured = await snapshot(db);
  await db.batch(["PRAGMA recursive_triggers = OFF", profile("one"), file("first"), location("a", "first", "one"), mapping("first", "a")]);
  assert.deepEqual(await snapshot(db), captured, "exact replay is a no-op");
  for (const sql of [
    profile("alias", "one"),
    "UPDATE storage_profiles SET namespace_identity = 'replacement' WHERE id = 'one'",
    "UPDATE files SET purpose = 'provenance' WHERE id = 'first'",
    "UPDATE file_locations SET file_id = 'second' WHERE id = 'a'",
    "UPDATE legacy_file_mappings SET object_key = 'different'",
    file("ready").replace("'unresolved'", "'ready'"),
    file("active").replace("'unresolved', NULL", "'unresolved', 'a'"),
    file("verified").replace("NULL, 'unresolved'", `'${"a".repeat(64)}', 'unresolved'`),
    mapping("second", "a", "cross-file"),
    mapping("second", "b", "other-key"),
    location("duplicate", "second", "one"),
    "DELETE FROM storage_profiles WHERE id = 'one'",
    "DELETE FROM files WHERE id = 'first'",
    "DELETE FROM file_locations WHERE id = 'a'",
    "DELETE FROM legacy_file_mappings",
    profile("one", "replacement").replace("INSERT INTO", "INSERT OR REPLACE INTO"),
    mapping("second", "b").replace("INSERT INTO", "INSERT OR REPLACE INTO"),
    "INSERT INTO storage_profiles VALUES ('bad-webdav', 'switchdrive', 'namespace', 'environment', NULL, 1, 'historical', '2026-09-13')",
  ]) await assert.rejects(db.batch([sql]), /constraint|immutable|mismatch|cannot be deleted/i, sql);
  assert.deepEqual(await snapshot(db), captured, "rejected writes preserve observations and all original rows");
  await assert.rejects(db.batch([file("unknown", "NULL"), location("unknown-location", "unknown", "one", "unknown-key"), mapping("unknown", "unknown-location", "unknown-key")]), /mismatch/);
  assert.equal((await db.all("SELECT * FROM files WHERE id = 'unknown'")).length, 0, "failed mapping rolls back file and location candidates");
  await db.batch([file("unknown", "NULL"), location("unknown-location", "unknown", "one", "unknown-key"), mapping("unknown", "unknown-location", "unknown-key", "ambiguous")]);
  assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
  assert.deepEqual(await db.all("PRAGMA quick_check"), [{ quick_check: "ok" }]);
  return (await snapshot(db)).rows;
}

test("populated S2 forward upgrade and dormant registry guards agree on host SQLite and actual D1", { timeout: 60_000 }, async () => {
  const host = new DatabaseSync(":memory:");
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("FP1 qualification") } }', compatibilityDate: "2026-07-20", d1Databases: ["DB", "FRESH"], log: new Log(LogLevel.ERROR) });
  try {
    const expected = await exercise(hostAdapter(host));
    const actual = await exercise(d1Adapter(await mf.getD1Database("DB")));
    // The existing status-event trigger generates random IDs independently on
    // each runtime. Their exact values were already preserved by each upgrade.
    const comparison = (rows) => ({ ...rows, events: rows.events.map(({ id, ...row }) => row)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
    assert.deepEqual(comparison(actual), comparison(expected));
    assert.deepEqual(plain(host.prepare("PRAGMA integrity_check").all()), [{ integrity_check: "ok" }]);
    const fresh = d1Adapter(await mf.getD1Database("FRESH"));
    await fresh.batch(splitSql(baseline));
    await fresh.batch(splitSql(suffix));
    assert.deepEqual(await fresh.all("PRAGMA foreign_key_check"), []);
    for (const table of registry) assert.deepEqual(await fresh.all(`SELECT * FROM ${table}`), []);
  } finally { host.close(); await mf.dispose(); }
});

test("the reviewed S2 lineage proposes only FP1 for an existing database and no reset or execution authority", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const empty = observeHostSchema(db);
    db.exec(baseline);
    db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE, applied_at TEXT)");
    const s2 = observeHostSchema(db);
    db.exec(suffix);
    const fp1 = observeHostSchema(db);
    const sourceFiles = [{ filename: "0001_v3_baseline.sql", sql: baseline }, { filename: "0002_fp1_file_registry.sql", sql: suffix }];
    const catalog = { version: 1, freshLineage: "s2-fp1", sources: sourceFiles.map(({ filename, sql }, index) => ({ filename, sha256: migrationSqlHash(sql), kind: index ? "incremental" : "baseline" })),
      lineages: [{ id: "s2-fp1", kind: "baseline", migrations: sourceFiles.map(({ filename }) => filename), supportedStates: [{ appliedCount: 1, schema: s2 }, { appliedCount: 2, schema: fp1 }] }] };
    for (const [schema, appliedCount, expected] of [[empty, 0, sourceFiles], [s2, 1, sourceFiles.slice(1)], [fp1, 2, []]]) {
      const plan = planD1Migrations({ catalog, sourceFiles, target: { schema, ledger: { exists: appliedCount > 0, rows: sourceFiles.slice(0, appliedCount).map(({ filename }, index) => ({ id: index + 1, name: filename })) } } });
      assert.deepEqual(plan.migrations.map(({ filename }) => filename), expected.map(({ filename }) => filename));
      assert.equal(plan.executionAuthorized, false);
    }
  } finally { db.close(); }
});
