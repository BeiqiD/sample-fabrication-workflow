import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { observeD1Migrations } from "./d1-migration-observer.mjs";
import { migrationSqlHash, normalizeSchema, planD1Migrations, schemaFingerprint } from "./d1-migration-plan.mjs";

const ledgerSql = `CREATE TABLE d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

// Independent host observation: ordinary PRAGMAs, not the adapter's JSON query.
function observeHost(database) {
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const objects = database.prepare("SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema").all();
  return {
    objects,
    relations: objects.filter(({ type }) => type === "table" || type === "view").map(({ name }) => ({
      name,
      columns: database.prepare(`PRAGMA table_xinfo(${quote(name)})`).all(),
      foreignKeys: database.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all(),
      indexes: database.prepare(`PRAGMA index_list(${quote(name)})`).all().map((index) => ({
        ...index, columns: database.prepare(`PRAGMA index_xinfo(${quote(index.name)})`).all(),
      })),
    })),
  };
}

function hostD1(database, { beforeBatch, afterBatch, afterProbe } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return { sql, async all() {
        calls.push({ kind: "probe", sql });
        const result = { success: true, results: database.prepare(sql).all() };
        return afterProbe ? afterProbe(result) : result;
      } };
    },
    async batch(statements) {
      beforeBatch?.();
      calls.push({ kind: "batch", statements: statements.map(({ sql }) => sql) });
      database.exec("BEGIN");
      try {
        const results = statements.map(({ sql }) => ({ success: true, results: database.prepare(sql).all() }));
        database.exec("COMMIT");
        return afterBatch ? afterBatch(results) : results;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
}

test("observer performs only reads, keeps a missing ledger absent, and snapshots in one batch", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE samples(id TEXT PRIMARY KEY, body TEXT); INSERT INTO samples VALUES ('kept', 'original');");
    const before = database.prepare("SELECT * FROM sqlite_schema").all();
    const d1 = hostD1(database);
    const observed = await observeD1Migrations(d1);
    assert.deepEqual(normalizeSchema(observed.schema), normalizeSchema(observeHost(database)));
    assert.deepEqual(observed.ledger, { exists: false, rows: [] });
    assert.deepEqual(d1.calls.map(({ kind }) => kind), ["probe", "batch"]);
    assert.equal(d1.calls[1].statements.length, 1);
    assert(d1.calls.every((call) => (call.statements ?? [call.sql]).every((sql) => /^\s*(SELECT|WITH)\b/.test(sql))));
    assert.deepEqual(database.prepare("SELECT * FROM sqlite_schema").all(), before);
    assert.equal(database.prepare("SELECT body FROM samples WHERE id = 'kept'").get().body, "original");
  } finally { database.close(); }
});

test("schema and ledger use the batch state rather than the preliminary probe state", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(ledgerSql);
    const d1 = hostD1(database, { beforeBatch() {
      database.exec("CREATE TABLE newly_migrated(id TEXT); INSERT INTO d1_migrations(name) VALUES ('0001_new.sql');");
    } });
    const observed = await observeD1Migrations(d1);
    assert(observed.schema.objects.some(({ name }) => name === "newly_migrated"));
    assert.deepEqual(observed.ledger.rows.map(({ name }) => name), ["0001_new.sql"]);
    assert.equal(d1.calls[1].statements.length, 2);
  } finally { database.close(); }
});

test("ledger creation or removal between probe and snapshot rejects without repair", async () => {
  for (const initiallyExists of [false, true]) {
    const database = new DatabaseSync(":memory:");
    try {
      if (initiallyExists) database.exec(ledgerSql);
      const d1 = hostD1(database, { beforeBatch() {
        database.exec(initiallyExists ? "DROP TABLE d1_migrations" : ledgerSql);
      } });
      await assert.rejects(observeD1Migrations(d1), initiallyExists ? /no such table/ : /ledger existence changed/);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'd1_migrations'").get().count, initiallyExists ? 0 : 1);
    } finally { database.close(); }
  }
});

test("malformed or missing D1 results fail closed", async () => {
  for (const hook of [
    { afterProbe: () => ({ results: [{ ledger_exists: 0 }] }) },
    { afterProbe: () => ({ success: true, results: [{ ledger_exists: "0" }] }) },
    { afterBatch: () => [] },
    { afterBatch: () => [{ success: false, results: [] }] },
    { afterBatch: () => [{ success: true, results: [] }] },
    { afterBatch: () => [{ success: true, results: [{ schema_json: "bad JSON" }] }] },
    { afterBatch: () => [{ success: true, results: [{ schema_json: '{"objects":[],"relations":null}' }] }] },
    { afterBatch: (results) => { const schema = JSON.parse(results[0].results[0].schema_json); schema.relations = []; results[0].results[0].schema_json = JSON.stringify(schema); return results; } },
  ]) {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("CREATE TABLE kept(id TEXT)");
      await assert.rejects(observeD1Migrations(hostD1(database, hook)), /D1 migration observation rejected/);
    } finally { database.close(); }
  }
});

test("invalid ledger rows and a view masquerading as the ledger reject", async () => {
  for (const setup of [
    "CREATE VIEW d1_migrations AS SELECT 1 AS id, 'wrong' AS name;",
    "CREATE TABLE d1_migrations(id, name, applied_at); INSERT INTO d1_migrations VALUES (1, 'same.sql', 'now'), (2, 'same.sql', 'now');",
    "CREATE TABLE d1_migrations(id, name, applied_at); INSERT INTO d1_migrations VALUES ('1', 'wrong.sql', 'now');",
    "CREATE TABLE d1_migrations(id, name, applied_at); INSERT INTO d1_migrations VALUES (1, 'wrong.sql', NULL);",
  ]) {
    const database = new DatabaseSync(":memory:");
    try { database.exec(setup); await assert.rejects(observeD1Migrations(hostD1(database)), /D1 migration observation rejected/); }
    finally { database.close(); }
  }
});

let miniflare;
before(async () => {
  miniflare = new Miniflare({
    modules: true, script: 'export default { fetch() { return new Response("local observer test") } }',
    compatibilityDate: "2026-07-20", d1Databases: ["EMPTY", "COMPLEX", "CURRENT"], log: new Log(LogLevel.ERROR),
  });
});
after(async () => { await miniflare?.dispose(); });

test("real local D1 observes empty schema without initializing its migration ledger", async () => {
  const database = await miniflare.getD1Database("EMPTY");
  const before = await database.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
  const observed = await observeD1Migrations(database);
  assert.deepEqual(normalizeSchema(observed.schema), { objects: [], relations: [] });
  assert.deepEqual(observed.ledger, { exists: false, rows: [] });
  const after = await database.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
  // The local D1 engine can create its protected bookmark table after its first
  // query, even a SELECT. Neither application objects nor the ledger are added.
  assert.deepEqual(after.results.filter(({ name }) => name !== "_cf_METADATA"), before.results.filter(({ name }) => name !== "_cf_METADATA"));
  assert.equal(after.results.some(({ name }) => name === "d1_migrations"), false);
});

test("real local D1 matches independent host metadata for quoted names, generated columns, indexes, foreign keys and triggers", async () => {
  const database = await miniflare.getD1Database("COMPLEX");
  const host = new DatabaseSync(":memory:");
  const sql = `${ledgerSql}
    CREATE TABLE parent(id TEXT PRIMARY KEY);
    CREATE TABLE "odd'); SELECT 1; --"(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE, body TEXT DEFAULT 'a  b', doubled TEXT AS (body || body)) WITHOUT ROWID;
    CREATE INDEX "quoted'index" ON "odd'); SELECT 1; --"(length(body), body COLLATE NOCASE DESC) WHERE body IS NOT NULL;
    CREATE VIEW visible AS SELECT id, doubled FROM "odd'); SELECT 1; --";
    CREATE TABLE audit(value TEXT);
    CREATE TRIGGER tracked AFTER INSERT ON parent BEGIN INSERT INTO audit VALUES (NEW.id); END;
    INSERT INTO d1_migrations(name, applied_at) VALUES ('0001_fixture.sql', '2026-09-13 00:00:00');`;
  try {
    host.exec(sql);
    await database.batch(splitSql(sql).map((statement) => database.prepare(statement)));
    const observed = await observeD1Migrations(database);
    assert.deepEqual(normalizeSchema(observed.schema), normalizeSchema(observeHost(host)));
    assert.deepEqual(observed.ledger.rows, JSON.parse(JSON.stringify(host.prepare("SELECT * FROM d1_migrations ORDER BY id").all())));
  } finally { host.close(); }
});

test("actual 37-file local D1 schema and ledger match host SQLite and produce a no-op legacy proposal", { timeout: 60_000 }, async (t) => {
  const database = await miniflare.getD1Database("CURRENT");
  const host = new DatabaseSync(":memory:");
  const directory = new URL("../migrations-history/s0/", import.meta.url);
  const filenames = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  const sources = filenames.map((filename) => ({ filename, sql: readFileSync(new URL(filename, directory), "utf8") }));
  try {
    assert.equal(filenames.length, 37);
    host.exec(ledgerSql);
    await database.prepare(ledgerSql).run();
    for (const source of sources) {
      host.exec(source.sql);
      host.prepare("INSERT INTO d1_migrations(name, applied_at) VALUES (?, '2026-09-13 00:00:00')").run(source.filename);
      await database.batch([
        ...splitSql(source.sql).map((statement) => database.prepare(statement)),
        database.prepare("INSERT INTO d1_migrations(name, applied_at) VALUES (?, '2026-09-13 00:00:00')").bind(source.filename),
      ]);
    }
    let preparedCount = 0;
    let snapshotResults;
    const observed = await observeD1Migrations({
      prepare(sql) { preparedCount += 1; return database.prepare(sql); },
      async batch(statements) { snapshotResults = await database.batch(statements); return snapshotResults; },
    });
    assert.equal(preparedCount, 3);
    assert.equal(snapshotResults.length, 2);
    t.diagnostic(`Local D1 observer: 1 probe + 2 snapshot statements; snapshot rows_read=${snapshotResults.map(({ meta }) => meta.rows_read).join(",")}; schema JSON bytes=${Buffer.byteLength(snapshotResults[0].results[0].schema_json)}`);
    const expected = observeHost(host);
    assert.deepEqual(normalizeSchema(observed.schema), normalizeSchema(expected));
    assert.deepEqual(observed.ledger.rows, JSON.parse(JSON.stringify(host.prepare("SELECT * FROM d1_migrations ORDER BY id").all())));
    const baseline = { filename: "0001_v3_baseline.sql", sql: sources.map(({ sql }) => sql).join("\n") };
    // Test-only concatenation qualifies observer/planner wiring, not a baseline.
    const sourceFiles = [...sources, baseline];
    const catalog = {
      version: 1, freshLineage: "baseline-fixture",
      sources: sourceFiles.map(({ filename, sql }) => ({ filename, sha256: migrationSqlHash(sql), kind: filename === baseline.filename ? "baseline" : "historical" })),
      lineages: [
        { id: "current-37", kind: "legacy", migrations: filenames, supportedStates: [{ appliedCount: 37, schema: expected }] },
        { id: "baseline-fixture", kind: "baseline", migrations: [baseline.filename], supportedStates: [{ appliedCount: 1, schema: expected }] },
      ],
    };
    const proposal = planD1Migrations({ catalog, sourceFiles, target: observed });
    assert.equal(proposal.lineage, "current-37");
    assert.deepEqual(proposal.migrations, []);
    assert.equal(proposal.observedSchemaHash, schemaFingerprint(expected));
    assert.equal(proposal.executionAuthorized, false);
  } finally { host.close(); }
});
