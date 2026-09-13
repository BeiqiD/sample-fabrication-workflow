import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { observeD1Migrations } from "./d1-migration-observer.mjs";
import { migrationSqlHash, normalizeSchema, planD1Migrations, schemaFingerprint } from "./d1-migration-plan.mjs";
import { applyHostTransaction, assertHealthyHost, baselineFilename, compatibilityDirectory,
  formatSqlForWrangler, generateS2Baseline, observeHostSchema, quoteIdentifier, readHostTables, readSchemaSources } from "./lib/backend-schema-baseline.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { historical, stages } = readSchemaSources(root);
const baselineSql = readFileSync(resolve(root, compatibilityDirectory, baselineFilename), "utf8");
const fixtureSql = readFileSync(resolve(root, "worker/fixtures/reference-graph.sql"), "utf8") + "\n"
  + readFileSync(resolve(root, compatibilityDirectory, "retained-data.sql"), "utf8");
const ledgerSql = `CREATE TABLE d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;
const orderRows = (rows) => rows.map((row) => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));

function s0Database() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const { sql } of historical) applyHostTransaction(database, sql);
  return database;
}

function expectedS1(tables) {
  return { ...tables, run_step_comments: orderRows(tables.run_step_comments.map((row) => ({
    ...row, legacy_body: row.submission_id === null ? row.body : null,
  }))) };
}

function expectedS2(tables) {
  return { ...tables,
    samples: orderRows(tables.samples.map(({ process_revision, ...row }) => row)),
    run_step_comments: orderRows(tables.run_step_comments.map(({ body, ...row }) => row)),
  };
}

function retiredFields(tables) {
  return {
    sampleProcessRevision: tables.samples.map(({ id, process_revision }) => ({ id, value: process_revision })),
    occurrenceBody: tables.run_step_comments.map(({ id, body }) => ({ id, value: body })),
  };
}

function assertRetainedCoverage(tables, retained) {
  assert.deepEqual(retained.sampleProcessRevision.map(({ value }) => value).sort((a, b) => a - b), [37, 9007199254740000]);
  assert.equal(retained.occurrenceBody.length, 5);
  assert.equal(tables.comment_submissions.find(({ id }) => id === "reference-comment").body, "Shared reference Comment body");
  assert.equal(tables.run_step_comments.find(({ id }) => id === "retained-legacy-common-a").asset_deleted_at, "2026-08-03T00:00:00.000Z");
  assert.equal(tables.run_step_comments.find(({ id }) => id === "retained-legacy-common-b").asset_deleted_at, null);
  assert.equal(tables.run_step_comments.find(({ id }) => id === "reference-comment-occurrence-b").deletion_operation_id, "retained-partial-common-delete");
  assert.equal(tables.comment_submissions.find(({ id }) => id === "retained-pending").retry_until, "2099-01-01T00:00:00.000Z");
  assert.equal(tables.blob_integrity_quarantine.length, 1);
}

function assertOwnedDefinitionsUnchanged(original, final) {
  const owned = original.objects.filter(({ type, name }) => ["index", "trigger", "view"].includes(type) && !name.startsWith("sqlite_"));
  const finalObjects = new Map(final.objects.map((object) => [`${object.type}:${object.name}`, object]));
  for (const object of owned) assert.deepEqual(finalObjects.get(`${object.type}:${object.name}`), object,
    `Retained ${object.type} ${object.name} changed`);
  assert.equal(owned.filter(({ type }) => type === "index").length, 93);
  assert.equal(owned.filter(({ type }) => type === "trigger").length, 198);
  assert.equal(owned.filter(({ type }) => type === "view").length, 15);
  assert.equal(final.objects.filter(({ type }) => type === "table").length, 34);
  assert.equal(final.objects.filter(({ type }) => type === "trigger").length, 200);
}

test("Wrangler formatting preserves quoted identifiers, seed strings, comments and CASE results while keeping trigger statements whole", () => {
  const source = `-- CASE( END, BEGIN comments stay exact
CREATE TABLE "CASE END)"("END," TEXT, x TEXT);
CREATE TABLE audit(value TEXT);
/* END), CASE( BEGIN */
CREATE VIEW readable AS SELECT trim(CASE WHEN x IS NULL THEN 'END), CASE(' ELSE x END), "END," FROM "CASE END)";
CREATE TRIGGER traced AFTER INSERT ON "CASE END)" BEGIN
  INSERT INTO audit VALUES(CASE WHEN NEW.x IS NULL THEN 'quoted END), CASE(' ELSE NEW.x END);
  INSERT INTO audit VALUES('BEGIN CASE END, quoted');
END;
INSERT INTO "CASE END)" VALUES('unchanged END), CASE(', NULL);`;
  const formatted = formatSqlForWrangler(source);
  assert(formatted.includes('-- CASE( END, BEGIN comments stay exact'));
  assert(formatted.includes('/* END), CASE( BEGIN */'));
  assert(formatted.includes('"CASE END)"("END," TEXT'));
  const statements = splitSql(formatted);
  assert.equal(statements.length, 5);
  const database = new DatabaseSync(":memory:");
  try {
    for (const sql of statements) database.exec(sql);
    assert.deepEqual({ ...database.prepare('SELECT * FROM "CASE END)"').get() }, { "END,": "unchanged END), CASE(", x: null });
    assert.deepEqual(database.prepare("SELECT value FROM audit ORDER BY rowid").all().map(({ value }) => value),
      ["quoted END), CASE(", "BEGIN CASE END, quoted"]);
    assert.deepEqual(Object.values(database.prepare("SELECT * FROM readable").get()), ["END), CASE(", "unchanged END), CASE("]);
  } finally { database.close(); }
});

test("inactive S2 baseline is reproducible and equals the full historical chain, final guards, views, indexes and exact seeds", () => {
  const generated = generateS2Baseline(root);
  assert.equal(generated.sql, baselineSql);
  assert.equal(generated.sourceHashes.length, 39);
  const statements = splitSql(baselineSql);
  assert.equal(statements.length, 363, "Wrangler must split every candidate statement, including CASE END before punctuation");
  assert(statements.every((sql) => Buffer.byteLength(sql) < 100_000), "Candidate statements must fit the actual D1 statement limit");
  assert(!baselineSql.includes("CREATE TABLE d1_migrations"));
  const historicalDatabase = s0Database();
  const fresh = new DatabaseSync(":memory:");
  try {
    const s0Schema = observeHostSchema(historicalDatabase);
    const s0 = normalizeSchema(s0Schema);
    fresh.exec("PRAGMA foreign_keys=ON");
    applyHostTransaction(fresh, baselineSql);
    assertHealthyHost(fresh);
    const freshSchema = observeHostSchema(fresh);
    assert.deepEqual(normalizeSchema(freshSchema), generated.normalized);
    for (const type of ["view", "trigger"]) assert.deepEqual(
      freshSchema.objects.filter((object) => object.type === type).map(({ name }) => name),
      generated.schema.objects.filter((object) => object.type === type).map(({ name }) => name),
      `Final ${type} creation order must also stay unchanged`);
    assert.deepEqual(readHostTables(fresh), generated.tables);
    assert.equal(Object.values(generated.tables).flat().length, 20);
    assertOwnedDefinitionsUnchanged(s0, generated.normalized);
    const originalTriggerNames = new Set(s0Schema.objects.filter(({ type }) => type === "trigger").map(({ name }) => name));
    for (const table of s0Schema.objects.filter(({ type }) => type === "table")) {
      const originalOrder = s0Schema.objects.filter(({ type, tableName }) => type === "trigger" && tableName === table.name).map(({ name }) => name);
      const finalOrder = generated.schema.objects.filter(({ type, tableName, name }) => type === "trigger" && tableName === table.name && originalTriggerNames.has(name)).map(({ name }) => name);
      assert.deepEqual(finalOrder, originalOrder, `${table.name}: original triggers must retain their relative creation order`);
    }
    assert.throws(() => applyHostTransaction(fresh, baselineSql), /already exists/);
    assert.deepEqual(readHostTables(fresh), generated.tables, "Reapplication must not overwrite an existing database");
  } finally { historicalDatabase.close(); fresh.close(); }
});

test("S0→S1→S2 preserves every retained row apart from the explicit projections and keeps actual retired values in a separate precleanup snapshot", () => {
  const database = s0Database();
  try {
    applyHostTransaction(database, fixtureSql);
    const s0 = readHostTables(database);
    const retainedJson = JSON.stringify(retiredFields(s0));
    assertRetainedCoverage(s0, JSON.parse(retainedJson));
    applyHostTransaction(database, stages[0].sql);
    assertHealthyHost(database);
    const s1 = readHostTables(database);
    assert.deepEqual(s1, expectedS1(s0), "Rebuild must not advance timestamps, IDs, revisions or timeline rows");
    applyHostTransaction(database, stages[1].sql);
    assertHealthyHost(database);
    const s2 = readHostTables(database);
    assert.deepEqual(s2, expectedS2(s1));
    assertRetainedCoverage(s2, JSON.parse(retainedJson));
    assert.deepEqual(normalizeSchema(observeHostSchema(database)), generateS2Baseline(root).normalized);
    assert.equal(s2.run_step_comments.filter(({ submission_id }) => submission_id === null).length, 3);
    assert.equal(s2.run_step_comments.find(({ id }) => id === "retained-legacy-common-a").legacy_body, "");
    assert.equal(s2.run_step_comments.find(({ id }) => id === "retained-legacy-individual").legacy_body,
      "Legacy text: 中文, 'quoted', empty lines\n\nkept exactly.");
    assert(!Object.hasOwn(s2.samples[0], "process_revision"));
    assert(!Object.hasOwn(s2.run_step_comments[0], "body"));
  } finally { database.close(); }
});

let miniflare;
before(async () => {
  miniflare = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("isolated schema qualification") } }',
    compatibilityDate: "2026-07-20", d1Databases: ["UPGRADE", "FRESH"], log: new Log(LogLevel.ERROR) });
});
after(async () => { await miniflare?.dispose(); });

async function d1Tables(database, schema) {
  const names = normalizeSchema(schema).objects.filter(({ type }) => type === "table").map(({ name }) => name).sort();
  const results = await database.batch(names.map((name) => database.prepare(`SELECT * FROM ${quoteIdentifier(name)}`)));
  return Object.fromEntries(names.map((name, index) => { assert.equal(results[index].success, true); return [name, orderRows(results[index].results)]; }));
}

async function assertHealthyD1(database) {
  // D1 rejects full integrity_check. Use its supported quick_check plus FK
  // enforcement/checks; each corresponding host database also passes the full
  // integrity_check. These are intentionally reported as different checks.
  const results = [];
  for (const sql of ["PRAGMA foreign_keys", "PRAGMA foreign_key_check", "PRAGMA quick_check"]) {
    try { results.push(await database.prepare(sql).all()); }
    catch (error) { throw new Error(`${sql}: ${error.message}`, { cause: error }); }
  }
  assert.deepEqual(results[0].results, [{ foreign_keys: 1 }]);
  assert.deepEqual(results[1].results, []);
  assert.deepEqual(results[2].results, [{ quick_check: "ok" }]);
}

async function migrateD1(database, source, ledgerName) {
  await database.batch([...splitSql(source).map((sql) => database.prepare(sql)),
    database.prepare("INSERT INTO d1_migrations(name, applied_at) VALUES (?, '2026-09-13 00:00:00')").bind(ledgerName)]);
}

test("actual local D1 retained upgrade and fresh S2 baseline match SQLite, preserve distinct complete ledgers and never propose baseline over retained data", { timeout: 60_000 }, async (t) => {
  const upgrade = await miniflare.getD1Database("UPGRADE");
  const fresh = await miniflare.getD1Database("FRESH");
  const host = s0Database();
  try {
    await upgrade.prepare(ledgerSql).run();
    for (const source of historical) await migrateD1(upgrade, source.sql, source.filename.split("/").at(-1));
    await upgrade.batch(splitSql(fixtureSql).map((sql) => upgrade.prepare(sql)));
    applyHostTransaction(host, fixtureSql);
    const s0Observation = await observeD1Migrations(upgrade);
    assert.equal(s0Observation.ledger.rows.length, 37);
    assert.deepEqual(normalizeSchema(s0Observation.schema), normalizeSchema(observeHostSchema(host)));
    const s0Tables = await d1Tables(upgrade, s0Observation.schema);
    assert.deepEqual(s0Tables, readHostTables(host));
    const retainedJson = JSON.stringify(retiredFields(s0Tables));
    assertRetainedCoverage(s0Tables, JSON.parse(retainedJson));
    const schemaStates = [{ appliedCount: 37, schema: s0Observation.schema }];
    for (const [index, source] of stages.entries()) {
      await migrateD1(upgrade, source.sql, `003${7 + index}_${index === 0 ? "compatibility_bridge" : "final_schema"}.sql`);
      applyHostTransaction(host, source.sql);
      const observed = await observeD1Migrations(upgrade);
      assert.deepEqual(normalizeSchema(observed.schema), normalizeSchema(observeHostSchema(host)));
      const tables = await d1Tables(upgrade, observed.schema);
      assert.deepEqual(tables, readHostTables(host));
      assert.deepEqual(tables, index === 0 ? expectedS1(s0Tables) : expectedS2(expectedS1(s0Tables)));
      assertHealthyHost(host);
      await assertHealthyD1(upgrade);
      schemaStates.push({ appliedCount: 38 + index, schema: observed.schema });
    }
    const upgraded = await observeD1Migrations(upgrade);
    await fresh.prepare(ledgerSql).run();
    const baselineStatements = splitSql(baselineSql);
    const boundary = Math.floor(baselineStatements.length / 2);
    await assert.rejects(fresh.batch([
      ...baselineStatements.slice(0, boundary).map((sql) => fresh.prepare(sql)),
      fresh.prepare("CREATE TABLE qualification_baseline_fault (ok INTEGER CHECK (ok = 1))"),
      fresh.prepare("INSERT INTO qualification_baseline_fault VALUES (0)"),
      ...baselineStatements.slice(boundary).map((sql) => fresh.prepare(sql)),
      fresh.prepare("INSERT INTO d1_migrations(name) VALUES ('0001_v3_baseline.sql')"),
    ]), /CHECK constraint failed/);
    const failedBaseline = await observeD1Migrations(fresh);
    assert.deepEqual(normalizeSchema(failedBaseline.schema), { objects: [], relations: [] });
    assert.deepEqual(failedBaseline.ledger.rows, [], "A failed baseline must not claim an applied ledger entry");
    await migrateD1(fresh, baselineSql, "0001_v3_baseline.sql");
    await assertHealthyD1(fresh);
    const baseline = await observeD1Migrations(fresh);
    const generated = generateS2Baseline(root);
    assert.deepEqual(normalizeSchema(baseline.schema), normalizeSchema(upgraded.schema));
    assert.deepEqual(normalizeSchema(baseline.schema), generated.normalized);
    assert.deepEqual(await d1Tables(fresh, baseline.schema), generated.tables);
    assert.equal(upgraded.ledger.rows.length, 39);
    assert.deepEqual(upgraded.ledger.rows.slice(0, 37), s0Observation.ledger.rows);
    assert.deepEqual(baseline.ledger.rows.map(({ name }) => name), ["0001_v3_baseline.sql"]);
    assertRetainedCoverage(await d1Tables(upgrade, upgraded.schema), JSON.parse(retainedJson));

    const sourceFiles = [
      ...historical.map(({ filename, sql }) => ({ filename: filename.split("/").at(-1), sql })),
      { filename: "0037_compatibility_bridge.sql", sql: stages[0].sql },
      { filename: "0038_final_schema.sql", sql: stages[1].sql },
      { filename: "0001_v3_baseline.sql", sql: baselineSql },
    ];
    const catalog = { version: 1, freshLineage: "s2-baseline-candidate",
      sources: sourceFiles.map(({ filename, sql }, index) => ({ filename, sha256: migrationSqlHash(sql),
        kind: index === 39 ? "baseline" : index >= 37 ? "incremental" : "historical" })),
      lineages: [
        { id: "retained-historical-candidate", kind: "legacy", migrations: sourceFiles.slice(0, 39).map(({ filename }) => filename), supportedStates: schemaStates },
        { id: "s2-baseline-candidate", kind: "baseline", migrations: ["0001_v3_baseline.sql"], supportedStates: [{ appliedCount: 1, schema: baseline.schema }] },
      ],
    };
    const s0Plan = planD1Migrations({ catalog, sourceFiles, target: s0Observation });
    assert.deepEqual(s0Plan.migrations.map(({ filename }) => filename), ["0037_compatibility_bridge.sql", "0038_final_schema.sql"]);
    for (const target of [upgraded, baseline]) {
      const proposal = planD1Migrations({ catalog, sourceFiles, target });
      assert.deepEqual(proposal.migrations, []);
      assert.equal(proposal.executionAuthorized, false);
    }
    const fingerprint = schemaFingerprint(baseline.schema);
    t.diagnostic(`S2 candidate ${fingerprint}: 34 tables, 93 explicit indexes, 15 views, 200 triggers; 39-entry retained ledger and 1-entry fresh ledger stay distinct. No remote execution is authorized.`);
  } finally { host.close(); }
});
