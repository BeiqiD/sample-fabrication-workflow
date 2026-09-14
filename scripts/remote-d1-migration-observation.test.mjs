import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { observeD1Migrations } from "./d1-migration-observer.mjs";
import { migrationSqlHash, normalizeSchema } from "./d1-migration-plan.mjs";
import { observeRemoteD1Migrations, runRemoteObservationCli, writeRemoteD1Observation } from "./observe-remote-d1-migrations.mjs";

const target = { accountId: "0123456789abcdef0123456789abcdef", databaseId: "01234567-89ab-cdef-0123-456789abcdef" };
const env = { CLOUDFLARE_API_TOKEN: "offline-fixture-token-never-real" };
const ledgerSql = "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL);";
const envelope = (results) => ({ success: true, errors: [], messages: [], result: [{ success: true, results, meta: { changed_db: false, rows_written: 0 } }] });
const jsonResponse = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

function hostFixture({ ledger = true, beforeSnapshot, mapResponse } = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE kept(id TEXT PRIMARY KEY, body TEXT); INSERT INTO kept VALUES ('original', 'preserved');");
  if (ledger) database.exec(`${ledgerSql} INSERT INTO d1_migrations(name, applied_at) VALUES ('0001_fixture.sql', '2026-09-13 00:00:00');`);
  const requests = [];
  return { database, requests, dependencies: { env, async fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    requests.push({ url, init, body });
    if (requests.length === 2) beforeSnapshot?.(database);
    const value = envelope(JSON.parse(JSON.stringify(database.prepare(body.sql).all())));
    return mapResponse ? mapResponse(value, requests.length) : jsonResponse(value);
  } } };
}

test("fixed HTTPS transport observes schema and ledger in one statement and preserves all data", async () => {
  for (const ledger of [false, true]) {
    const fixture = hostFixture({ ledger });
    try {
      const before = fixture.database.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
      const artifact = await observeRemoteD1Migrations(target, fixture.dependencies);
      assert.equal(artifact.executionAuthorized, false);
      assert.equal(artifact.consistency, "schema-and-ledger-in-one-sql-statement");
      assert.equal(artifact.observation.ledger.exists, ledger);
      assert.equal(artifact.observation.ledger.rows.length, ledger ? 1 : 0);
      assert.equal(fixture.requests.length, 2);
      assert.deepEqual(artifact.requests.map(({ role, statementCount }) => ({ role, statementCount })), [
        { role: "ledger-probe", statementCount: 1 }, { role: "snapshot", statementCount: 1 },
      ]);
      for (const { url, init, body } of fixture.requests) {
        assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/d1/database/${target.databaseId}/query`);
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "error");
        assert.equal(init.headers.authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
        assert.deepEqual(Object.keys(body), ["sql"]);
        assert.equal(splitSql(body.sql).length, 1);
        assert.match(body.sql, /^\s*(SELECT|WITH)\b/);
      }
      assert(fixture.requests[0].init.signal.aborted, "request resources are aborted after completion");
      assert.deepEqual(fixture.database.prepare("SELECT * FROM sqlite_schema ORDER BY name").all(), before);
      assert.equal(fixture.database.prepare("SELECT body FROM kept").get().body, "preserved");
      assert.equal(JSON.stringify(artifact).includes(env.CLOUDFLARE_API_TOKEN), false);
      const { artifactHash, ...payload } = artifact;
      assert.equal(artifactHash, migrationSqlHash(JSON.stringify(payload)));
      assert.equal(artifact.observationHash, migrationSqlHash(JSON.stringify({ schema: normalizeSchema(artifact.observation.schema), ledger: artifact.observation.ledger })));
      assert(Date.parse(artifact.completedAt) >= Date.parse(artifact.startedAt));
    } finally { fixture.database.close(); }
  }
});

test("probe-era data is discarded and ledger appearance/disappearance fails closed", async () => {
  const fixture = hostFixture({ beforeSnapshot(database) {
    database.exec("CREATE TABLE arrived(id TEXT); INSERT INTO d1_migrations(name, applied_at) VALUES ('0002_arrived.sql', 'later');");
  } });
  try {
    const { observation } = await observeRemoteD1Migrations(target, fixture.dependencies);
    assert(observation.schema.objects.some(({ name }) => name === "arrived"));
    assert.equal(observation.ledger.rows.at(-1).name, "0002_arrived.sql");
  } finally { fixture.database.close(); }
  for (const ledger of [false, true]) {
    const racing = hostFixture({ ledger, beforeSnapshot: (database) => database.exec(ledger ? "DROP TABLE d1_migrations" : ledgerSql) });
    try { await assert.rejects(observeRemoteD1Migrations(target, racing.dependencies), /query or observation validation failed/); }
    finally { racing.database.close(); }
  }
});

test("incomplete envelopes, cardinality, metadata and nested snapshots reject without provider text", async () => {
  const mutations = [
    (value) => { value.success = false; value.errors = [{ message: env.CLOUDFLARE_API_TOKEN }]; },
    (value) => { delete value.errors; },
    (value) => { delete value.messages; },
    (value) => { value.result.push(value.result[0]); },
    (value) => { value.result = []; },
    (value) => { value.result_info = { cursor: "another-page" }; },
    (value) => { value.result[0].success = false; },
    (value) => { value.result[0].results = [null]; },
    (value) => { value.result[0].meta.changed_db = true; },
    (value) => { value.result[0].meta.rows_written = 1; },
    (value) => { value.result[0].error = env.CLOUDFLARE_API_TOKEN; },
    (value) => { value.result[0].results = []; },
    (value) => { value.result[0].results[0].schema_json = "malformed schema"; },
    (value) => { value.result[0].results[0].ledger_json = "malformed ledger"; },
    (value) => { value.result[0].results[0].ledger_json = '{"not":"rows"}'; },
    (value) => { value.result[0].results[0].ledger_json = JSON.stringify([{ id: 1, name: "duplicate", applied_at: "now" }, { id: 2, name: "duplicate", applied_at: "now" }]); },
  ];
  for (const mutate of mutations) {
    const fixture = hostFixture({ mapResponse(value, request) { if (request === 2) mutate(value); return jsonResponse(value); } });
    try {
      await assert.rejects(observeRemoteD1Migrations(target, fixture.dependencies), (error) => {
        assert.match(error.message, /^Remote D1 observation rejected:/);
        assert.equal(error.message.includes(env.CLOUDFLARE_API_TOKEN), false);
        return true;
      });
    } finally { fixture.database.close(); }
  }
});

test("HTTP failures, redirects, bounded streamed bodies, invalid encodings and timeouts are redacted", async () => {
  let streamCancelled = false;
  const fixtures = [
    () => new Response(env.CLOUDFLARE_API_TOKEN, { status: 403 }),
    () => new Response(null, { status: 302, headers: { location: "https://example.invalid/" } }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () => new Response("{}", { headers: { "content-type": "application/json", "content-length": String(9 * 1024 * 1024) } }),
    () => new Response("invalid JSON", { headers: { "content-type": "application/json" } }),
    () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { streamCancelled = true; } }), { headers: { "content-type": "application/json" } }),
    () => { throw new Error(env.CLOUDFLARE_API_TOKEN); },
  ];
  for (const fetchImpl of fixtures) {
    await assert.rejects(observeRemoteD1Migrations(target, { env, fetchImpl }), (error) => {
      assert.match(error.message, /^Remote D1 observation rejected:/);
      assert(!error.message.includes(env.CLOUDFLARE_API_TOKEN));
      return true;
    });
  }
  assert(streamCancelled);
  for (const pendingBody of [false, true]) {
    let signal;
    const fetchImpl = async (_url, init) => {
      signal = init.signal;
      if (!pendingBody) return new Promise(() => {});
      return new Response(new ReadableStream({ pull() {} }), { headers: { "content-type": "application/json" } });
    };
    await assert.rejects(observeRemoteD1Migrations(target, { env, fetchImpl, timeoutMs: 20 }), /observation timeout/);
    assert(signal.aborted);
  }
});

test("target identifiers, credentials and unsupported CLI arguments reject before requests", async () => {
  let calls = 0;
  const dependencies = { env, fetchImpl: () => { calls++; throw new Error("must not run"); } };
  for (const options of [null, {}, { ...target, accountId: "../../another" }, { ...target, databaseId: "https://example.invalid" }, { ...target, sql: "DROP TABLE kept" }]) {
    await assert.rejects(observeRemoteD1Migrations(options, dependencies), /rejected/);
  }
  for (const token of [undefined, "", "bad\ntoken", " ", "x".repeat(4097)]) {
    await assert.rejects(observeRemoteD1Migrations(target, { ...dependencies, env: { CLOUDFLARE_API_TOKEN: token } }), /environment token/);
  }
  const argv = ["--account-id", target.accountId, "--database-id", target.databaseId, "--output", "unused.json"];
  for (const suffix of [["--sql", "SELECT 1"], ["--url", "https://example.invalid"], ["--token", env.CLOUDFLARE_API_TOKEN], ["--config", "other.json"], ["--account-id", target.accountId], ["--output"]]) {
    await assert.rejects(runRemoteObservationCli([...argv, ...suffix], dependencies), /CLI argument/);
  }
  assert.match(await runRemoteObservationCli(["--help"], dependencies), /D1 Read/);
  assert.equal(calls, 0);
});

test("artifact output is exclusive, private, free of credentials and cleaned on observation failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-d1-observation-test-"));
  const fixture = hostFixture();
  try {
    const output = join(directory, "observed.json");
    const message = await runRemoteObservationCli(["--account-id", target.accountId, "--database-id", target.databaseId, "--output", output], fixture.dependencies);
    assert.match(message, /execution remains unauthorized/);
    assert(!message.includes(env.CLOUDFLARE_API_TOKEN));
    const content = await readFile(output, "utf8");
    assert.equal(JSON.parse(content).executionAuthorized, false);
    assert(!content.includes(env.CLOUDFLARE_API_TOKEN));
    if (process.platform !== "win32") assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(writeRemoteD1Observation(target, output, fixture.dependencies), /new writable file/);
    assert.equal(fixture.requests.length, 2, "existing output is rejected before remote work");
    const link = join(directory, "symlink.json");
    await symlink(output, link);
    await assert.rejects(writeRemoteD1Observation(target, link, fixture.dependencies), /new writable file/);
    assert.equal(await readFile(output, "utf8"), content);
    const failed = join(directory, "failed.json");
    await assert.rejects(writeRemoteD1Observation(target, failed, { env, fetchImpl() { throw new Error(env.CLOUDFLARE_API_TOKEN); } }), /query or observation validation failed/);
    assert.equal((await readdir(directory)).includes("failed.json"), false);
  } finally { fixture.database.close(); await rm(directory, { recursive: true, force: true }); }
});

test("replacement of the reserved output does not report success or remove the replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-d1-output-race-"));
  const fixture = hostFixture();
  const output = join(directory, "observation.json");
  let moved = false;
  try {
    const dependencies = { env, async fetchImpl(url, init) {
      if (!moved) {
        moved = true;
        await rename(output, join(directory, "moved.json"));
        await writeFile(output, "replacement must remain");
      }
      return fixture.dependencies.fetchImpl(url, init);
    } };
    await assert.rejects(writeRemoteD1Observation(target, output, dependencies), /private output was replaced or exposed/);
    assert.equal(await readFile(output, "utf8"), "replacement must remain");
  } finally { fixture.database.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const fixture of [
  { name: "complete 37-file S0 schema", directory: "../migrations-history/s0/", count: 37 },
  { name: "current S2 plus FP1 chain", directory: "../migrations/", filenames: ["0001_v3_baseline.sql", "0002_fp1_file_registry.sql", "0003_fp1_import_acceptance.sql", "0004_r2_upload_acceptance.sql", "0005_metrology_reference_acceptance.sql", "0006_comment_acceptance.sql"] },
]) {
test(`single remote SELECT has parity with actual local D1 across the ${fixture.name}`, { timeout: 60_000 }, async (t) => {
  const miniflare = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("offline D1 parity") } }', compatibilityDate: "2026-07-20", d1Databases: ["CURRENT"], log: new Log(LogLevel.ERROR) });
  try {
    const database = await miniflare.getD1Database("CURRENT");
    await database.prepare(ledgerSql).run();
    const directory = new URL(fixture.directory, import.meta.url);
    const filenames = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    if (fixture.filenames) assert.deepEqual(filenames, fixture.filenames);
    else assert.equal(filenames.length, fixture.count);
    for (const filename of filenames) {
      const sql = await readFile(new URL(filename, directory), "utf8");
      await database.batch([
        ...splitSql(sql).map((statement) => database.prepare(statement)),
        database.prepare("INSERT INTO d1_migrations(name, applied_at) VALUES (?, '2026-09-13 00:00:00')").bind(filename),
      ]);
    }
    const expected = await observeD1Migrations(database);
    let requests = 0;
    const { observation } = await observeRemoteD1Migrations(target, { env, async fetchImpl(_url, init) {
      requests++;
      const { sql } = JSON.parse(init.body);
      assert.equal(splitSql(sql).length, 1);
      const result = await database.prepare(sql).all();
      if (requests === 2) t.diagnostic(`Offline REST response backed by actual local D1 (${fixture.name}): one snapshot SELECT, rows_read=${result.meta.rows_read}, response bytes=${Buffer.byteLength(JSON.stringify(result))}`);
      return jsonResponse({ success: true, errors: [], messages: [], result: [result] });
    } });
    assert.equal(requests, 2);
    assert.deepEqual(normalizeSchema(observation.schema), normalizeSchema(expected.schema));
    assert.deepEqual(observation.ledger, expected.ledger);
    assert.deepEqual(observation.ledger.rows.map(({ name }) => name), filenames);
  } finally { await miniflare.dispose(); }
});
}
