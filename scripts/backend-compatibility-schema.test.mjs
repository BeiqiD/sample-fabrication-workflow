import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";

const root = new URL("../", import.meta.url);
const migrationNames = readdirSync(new URL("migrations/", root)).filter((name) => name.endsWith(".sql")).sort();
const migrations = migrationNames.map((name) => readFileSync(new URL(`migrations/${name}`, root), "utf8"));
const s1Sql = readFileSync(new URL("fixtures/backend-schema/s1-compatibility-bridge.sql", import.meta.url), "utf8");
const s2Sql = readFileSync(new URL("fixtures/backend-schema/s2-final-schema.sql", import.meta.url), "utf8");
const referenceSql = readFileSync(new URL("worker/fixtures/reference-graph.sql", root), "utf8");
const retainedSql = `
UPDATE samples SET process_revision = 37 WHERE id = 'reference-sample-a';
UPDATE run_step_comments SET body = 'Retired canonical duplicate' WHERE submission_id = 'reference-comment';
INSERT INTO run_step_comments
  (id, run_step_id, scope, operation_group_id, body, asset_id, actor_email, created_at,
   updated_at, updated_by, deleted_at, deleted_by, asset_deleted_at, asset_deleted_by,
   last_mutation_id, deletion_operation_id, asset_deletion_operation_id)
VALUES
  ('retained-legacy-individual', 'reference-step-a', 'individual', NULL, 'Legacy note', NULL, 'original-author', '2026-08-01', '2026-08-02', 'last-author', NULL, NULL, NULL, NULL, 'legacy-write', NULL, NULL),
  ('retained-legacy-common-a', 'reference-step-a', 'common', 'retained-common', 'Common legacy', NULL, 'original-author', '2026-08-01', '2026-08-02', 'last-author', NULL, NULL, NULL, NULL, 'common-write', NULL, NULL),
  ('retained-legacy-common-b', 'reference-step-b', 'common', 'retained-common', 'Common legacy', NULL, 'original-author', '2026-08-01', '2026-08-02', 'last-author', '2026-08-03', 'deleted-author', NULL, NULL, 'delete-write', 'delete-operation', NULL),
  ('retained-image-only', 'reference-step-a', 'individual', NULL, '', 'reference-comment-asset', 'image-author', '2026-08-01', '2026-08-02', 'last-author', NULL, NULL, '2026-08-03', 'image-delete-author', 'image-delete-write', NULL, 'image-delete-operation');
INSERT INTO comment_submissions
  (id, context_kind, sample_id, scope, body, status, actor_email, created_at, updated_at, retry_until, error_message)
VALUES
  ('retained-empty-canonical', 'run_steps', NULL, 'individual', '', 'ready', 'original-author', '2026-08-01', '2026-08-02', NULL, NULL),
  ('retained-retry', 'sample', 'reference-sample-a', NULL, 'Retry body', 'failed', 'original-author', '2026-08-01', '2026-08-02', '2030-01-01', 'unfinished upload');
INSERT INTO comment_submission_targets(submission_id, sample_id, run_id, run_step_id, expected_updated_at)
VALUES ('retained-empty-canonical', 'reference-sample-a', 'reference-run-a', 'reference-step-a', '2026-08-01T02:00:00.000Z');
INSERT INTO run_step_comments(id, run_step_id, scope, body, submission_id, created_at)
VALUES ('retained-empty-occurrence', 'reference-step-a', 'individual', 'Never revive this duplicate', 'retained-empty-canonical', '2026-08-01');
`;
const ledgerSql = "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)";
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const plain = (value) => JSON.parse(JSON.stringify(value));

function hostD1(database) {
  function prepare(sql, bindings = []) {
    return {
      bind(...values) { return prepare(sql, values); },
      async all() { return { success: true, results: plain(database.prepare(sql).all(...bindings)), meta: { changes: 0 } }; },
      async first() { return plain(database.prepare(sql).get(...bindings) ?? null); },
      async run() { return execute(); },
      execute,
    };
    function execute() {
      const statement = database.prepare(sql);
      if (statement.columns().length) return { success: true, results: plain(statement.all(...bindings)), meta: { changes: 0 } };
      const result = statement.run(...bindings);
      return { success: true, results: [], meta: { changes: Number(result.changes) } };
    }
  }
  return {
    nativeDatabase: database,
    prepare,
    async batch(statements) {
      database.exec("BEGIN");
      try { const results = statements.map((statement) => statement.execute()); database.exec("COMMIT"); return results; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
}

async function sqlBatch(database, sql) {
  if (database.nativeDatabase) {
    database.nativeDatabase.exec("BEGIN");
    try { database.nativeDatabase.exec(sql); database.nativeDatabase.exec("COMMIT"); }
    catch (error) { database.nativeDatabase.exec("ROLLBACK"); throw error; }
    return;
  }
  return database.batch(splitSql(sql).map((statement) => database.prepare(statement)));
}

async function seed(database) {
  await sqlBatch(database, ledgerSql);
  for (const [index, sql] of migrations.entries()) {
    if (database.nativeDatabase) {
      database.nativeDatabase.exec("BEGIN");
      try {
        database.nativeDatabase.exec(sql);
        database.nativeDatabase.prepare("INSERT INTO d1_migrations(name) VALUES (?)").run(migrationNames[index]);
        database.nativeDatabase.exec("COMMIT");
      } catch (error) { database.nativeDatabase.exec("ROLLBACK"); throw error; }
    } else await database.batch([
      ...splitSql(sql).map((statement) => database.prepare(statement)),
      database.prepare("INSERT INTO d1_migrations(name) VALUES (?)").bind(migrationNames[index]),
    ]);
  }
  await sqlBatch(database, referenceSql + retainedSql);
}

async function applyStage(database, sql, stage, afterLedger = []) {
  if (database.nativeDatabase) {
    database.nativeDatabase.exec("BEGIN");
    try {
      database.nativeDatabase.exec(sql);
      database.nativeDatabase.prepare("INSERT INTO d1_migrations(name) VALUES (?)").run(`inactive-${stage}-qualification.sql`);
      database.nativeDatabase.exec("COMMIT");
    } catch (error) { database.nativeDatabase.exec("ROLLBACK"); throw error; }
    return;
  }
  return database.batch([
    ...splitSql(sql).map((statement) => database.prepare(statement)),
    database.prepare("INSERT INTO d1_migrations(name) VALUES (?)").bind(`inactive-${stage}-qualification.sql`),
    ...afterLedger,
  ]);
}

async function snapshot(database) {
  const objects = (await database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name <> '_cf_METADATA' ORDER BY type, name").all()).results;
  const names = objects.filter(({ type }) => type === "table").map(({ name }) => name);
  const results = await database.batch(names.map((name) => database.prepare(`SELECT * FROM ${quote(name)}`)));
  return { objects, rows: Object.fromEntries(names.map((name, i) => [name, results[i].results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])) };
}

async function integrity(database) {
  assert.equal((await database.prepare("PRAGMA foreign_keys").first()).foreign_keys, 1);
  assert.deepEqual((await database.prepare("PRAGMA foreign_key_check").all()).results, []);
  assert.deepEqual((await database.prepare("PRAGMA quick_check").all()).results, [{ quick_check: "ok" }]);
}

function preserved(before, after, stage) {
  const oldLedger = before.rows.d1_migrations;
  const newLedger = after.rows.d1_migrations;
  assert.equal(newLedger.length, oldLedger.length + 1, `${stage} appends one ledger entry`);
  for (const row of oldLedger) assert.deepEqual(newLedger.find(({ id }) => id === row.id), row, `${stage} retains historical ledger entry ${row.id}`);
  const added = newLedger.filter(({ id }) => !oldLedger.some((row) => row.id === id));
  assert.equal(added[0].name, `inactive-${stage.toLowerCase()}-qualification.sql`);
  assert.deepEqual(after.rows.sqlite_sequence, before.rows.sqlite_sequence.map((row) => ({
    ...row, seq: row.name === "d1_migrations" ? row.seq + 1 : row.seq,
  })), `${stage} advances only the migration ledger sequence`);
  for (const [name, rows] of Object.entries(before.rows)) {
    if (name === "d1_migrations" || name === "sqlite_sequence") continue;
    const expected = rows.map((row) => {
      const result = { ...row };
      if (name === "run_step_comments" && stage === "S1") result.legacy_body = row.submission_id === null ? row.body : null;
      if (name === "run_step_comments" && stage === "S2") delete result.body;
      if (name === "samples" && stage === "S2") delete result.process_revision;
      return result;
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(after.rows[name], expected, `${stage} retained rows: ${name}`);
  }
  for (const object of before.objects) {
    if ((object.type === "table" && (object.name === "run_step_comments" || (stage === "S2" && object.name === "samples")))) continue;
    if (stage === "S2" && object.name === "run_step_comments_bridge_legacy_insert") continue;
    assert.deepEqual(after.objects.find(({ type, name }) => type === object.type && name === object.name), object, `${stage} retained schema: ${object.name}`);
  }
  const expectedNames = before.objects.map(({ type, name }) => `${type}:${name}`);
  if (stage === "S1") expectedNames.push("trigger:run_step_comments_bridge_legacy_insert");
  else {
    expectedNames.splice(expectedNames.indexOf("trigger:run_step_comments_bridge_legacy_insert"), 1);
    expectedNames.push("trigger:run_step_comments_guard_text_owner_insert", "trigger:run_step_comments_guard_text_owner_update");
  }
  assert.deepEqual(after.objects.map(({ type, name }) => `${type}:${name}`).sort(), expectedNames.sort(), `${stage} has no leftover assertion or replacement objects`);
}

let miniflare, oldWorker;
before(async () => {
  const bundle = await build({ entryPoints: [new URL("worker/index.ts", root).pathname], write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", conditions: ["workerd", "worker", "browser"], logLevel: "silent" });
  const script = bundle.outputFiles[0].text;
  oldWorker = (await import(`data:text/javascript;base64,${Buffer.from(script).toString("base64")}`)).default;
  miniflare = new Miniflare({ modules: true, script, compatibilityDate: "2026-07-20", bindings: { AUTH_MODE: "disabled" }, d1Databases: ["DB", "COPY", "SWAP", "RECREATE", "CONTRACT", "RETURNING"], r2Buckets: ["ASSETS"], log: new Log(LogLevel.ERROR) });
});
after(async () => { await miniflare?.dispose(); });

test("real D1 RETURNING isolates inserted IDs from legacy bridge trigger changes", async () => {
  const database = await miniflare.getD1Database("RETURNING");
  await database.batch([
    database.prepare("CREATE TABLE occurrence(id TEXT PRIMARY KEY, body TEXT NOT NULL, legacy_body TEXT)"),
    database.prepare("CREATE TRIGGER bridge AFTER INSERT ON occurrence WHEN NEW.legacy_body IS NULL BEGIN UPDATE occurrence SET legacy_body = NEW.body WHERE id = NEW.id; END"),
  ]);
  const [result] = await database.batch([database.prepare("INSERT INTO occurrence(id, body) VALUES ('first', 'A'), ('second', 'B') RETURNING id")]);
  assert.equal(result.meta.changes, 4, "the old count-based ACK would reject the two committed rows");
  assert.deepEqual(result.results, [{ id: "first" }, { id: "second" }]);
  assert.deepEqual((await database.prepare("SELECT * FROM occurrence ORDER BY id").all()).results, [
    { id: "first", body: "A", legacy_body: "A" }, { id: "second", body: "B", legacy_body: "B" },
  ]);
});

async function oldWorkerBehavior(database, request) {
  const detail = async () => {
    const response = await request("/samples/reference-sample-a");
    assert.equal(response.status, 200);
    return response.json();
  };
  let data = await detail();
  const comments = data.runs.flatMap((run) => run.steps.flatMap((step) => step.comments));
  assert.equal(comments.find(({ id }) => id === "reference-comment-occurrence-a").body, "Shared reference Comment body");
  assert.equal(comments.find(({ id }) => id === "retained-legacy-individual").body, "Legacy note");
  assert.equal(comments.find(({ id }) => id === "retained-empty-occurrence").body, "");
  const targets = async (scope = "individual") => Promise.all((scope === "common" ? ["a", "b"] : ["a"]).map(async (suffix) => ({
    sampleId: `reference-sample-${suffix}`, runId: `reference-run-${suffix}`, stepId: `reference-step-${suffix}`,
    expectedUpdatedAt: (await database.prepare("SELECT updated_at FROM run_steps WHERE id = ?").bind(`reference-step-${suffix}`).first()).updated_at,
  })));
  for (const scope of ["individual", "common"]) {
    const body = `A writer legacy ${scope}`;
    const requestedTargets = await targets(scope);
    const response = await request("/run-step-comments", "POST", { scope, body, targets: requestedTargets });
    assert.equal(response.status, 201, await response.text());
    const inserted = (await database.prepare("SELECT run_step_id, legacy_body FROM run_step_comments WHERE body = ? ORDER BY run_step_id").bind(body).all()).results;
    assert.deepEqual(inserted, requestedTargets.map(({ stepId }) => ({ run_step_id: stepId, legacy_body: body })));
  }
  let response = await request("/comment-submissions", "POST", { id: "qualified-canonical-submission", body: "A canonical writer", context: { kind: "run_steps", scope: "individual", targets: await targets() }, items: [] });
  assert.equal(response.status, 201, await response.text());
  response = await request("/comment-submissions/qualified-canonical-submission/finalize", "POST");
  assert.equal(response.status, 200, await response.text());
  const finalized = await snapshot(database);
  response = await request("/comment-submissions/qualified-canonical-submission/finalize", "POST");
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(await snapshot(database), finalized, "finalize retry preserves settlement identity and events");
  const occurrence = await database.prepare("SELECT id, body, legacy_body FROM run_step_comments WHERE submission_id = 'qualified-canonical-submission'").first();
  assert.equal(occurrence.body, "A canonical writer");
  assert.equal(occurrence.legacy_body, null);
  for (const [path, method] of [[`/run-step-comments/${occurrence.id}`, "DELETE"], [`/run-step-comments/${occurrence.id}/restore`, "POST"]]) {
    response = await request(path, method);
    assert.equal(response.status, 200, await response.text());
  }
  data = await detail();
  assert(data.runs.flatMap((run) => run.steps.flatMap((step) => step.comments)).some(({ id, body }) => id === occurrence.id && body === "A canonical writer"));
}

test("host and real D1 retain original data and run the prepared pre-B Worker on S1", { timeout: 60_000 }, async () => {
  const host = new DatabaseSync(":memory:");
  try {
    for (const [database, request] of [
      [hostD1(host), (path, method = "GET", body) => oldWorker.fetch(new Request(`https://app.test/api${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }), { AUTH_MODE: "disabled", DB: hostD1(host), ASSETS: {} }, { waitUntil() {}, passThroughOnException() {} })],
      [await miniflare.getD1Database("DB"), (path, method = "GET", body) => miniflare.dispatchFetch(`https://app.test/api${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) })],
    ]) {
      await seed(database);
      const before = await snapshot(database);
      await applyStage(database, s1Sql, "s1");
      const expanded = await snapshot(database);
      preserved(before, expanded, "S1");
      await integrity(database);
      await oldWorkerBehavior(database, request);
      // B dual-write and C legacy-only inputs are exercised at the SQL boundary.
      // A is intentionally not claimed compatible with C's legacy-only writes.
      await sqlBatch(database, `INSERT INTO run_step_comments(id,run_step_id,scope,body,legacy_body,created_at) VALUES ('new-b-legacy','reference-step-a','individual','B text','B text','2026-09-13');
        INSERT INTO run_step_comments(id,run_step_id,scope,legacy_body,created_at) VALUES ('new-c-legacy','reference-step-a','individual','C text','2026-09-13');
        INSERT INTO run_step_comments(id,run_step_id,scope,legacy_body,created_at) VALUES ('new-c-empty','reference-step-a','individual','','2026-09-13');
        INSERT INTO run_step_comments(id,run_step_id,scope,submission_id,created_at) VALUES ('new-c-canonical','reference-step-a','individual','reference-comment','2026-09-13');`);
      assert.deepEqual((await database.prepare("SELECT id, body, legacy_body FROM run_step_comments WHERE id LIKE 'new-%' ORDER BY id").all()).results, [
        { id: "new-b-legacy", body: "B text", legacy_body: "B text" },
        { id: "new-c-canonical", body: "", legacy_body: null },
        { id: "new-c-empty", body: "", legacy_body: "" },
        { id: "new-c-legacy", body: "", legacy_body: "C text" },
      ]);
      const precleanup = await snapshot(database);
      await applyStage(database, s2Sql, "s2");
      preserved(precleanup, await snapshot(database), "S2");
      await integrity(database);
      for (const sql of [
        "INSERT INTO run_step_comments(id,run_step_id,scope,created_at) VALUES ('bad-legacy','reference-step-a','individual','2026-09-13')",
        "INSERT INTO run_step_comments(id,run_step_id,scope,submission_id,legacy_body,created_at) VALUES ('bad-canonical','reference-step-a','individual','reference-comment','bad','2026-09-13')",
        "UPDATE run_step_comments SET legacy_body = NULL WHERE id = 'new-c-legacy'",
        "UPDATE run_step_comments SET legacy_body = 'bad' WHERE id = 'new-c-canonical'",
      ]) await assert.rejects(database.prepare(sql).run(), /text ownership is invalid/);
      await sqlBatch(database, "INSERT INTO run_step_comments(id,run_step_id,scope,legacy_body,created_at) VALUES ('valid-final-empty','reference-step-a','individual','','2026-09-13')");
    }
  assert.deepEqual(plain(host.prepare("PRAGMA integrity_check").all()), [{ integrity_check: "ok" }]);
  } finally { host.close(); }
});

for (const [binding, checkpoint] of [["COPY", "before-copy"], ["SWAP", "after-swap"], ["RECREATE", "after-recreate"]]) {
  test(`real D1 stage B ${binding.toLowerCase()} failure rolls back schema/data/ledger and can retry`, { timeout: 60_000 }, async () => {
    const database = await miniflare.getD1Database(binding);
    await seed(database);
    const before = await snapshot(database);
    const fault = binding === "COPY"
      ? "CREATE TRIGGER compatibility_copy_fault BEFORE INSERT ON compatibility_run_step_comments_s1 WHEN NEW.id = 'reference-comment-occurrence-b' BEGIN SELECT RAISE(ABORT, 'injected copy failure'); END;"
      : "INSERT INTO compatibility_stage_b_assertion VALUES (0);";
    const broken = s1Sql.replace(`-- qualification checkpoint: ${checkpoint}`, fault);
    assert.notEqual(broken, s1Sql);
    await assert.rejects(applyStage(database, broken, "s1"), /injected copy failure|CHECK constraint failed/);
    assert.deepEqual(await snapshot(database), before);
    await integrity(database);
    if (binding === "COPY") {
      // Fail after the first ledger INSERT has executed in the same batch.
      await assert.rejects(applyStage(database, s1Sql, "s1", [database.prepare("INSERT INTO d1_migrations(name) VALUES ('inactive-s1-qualification.sql')")]), /UNIQUE constraint failed/);
      assert.deepEqual(await snapshot(database), before);
    }
    await applyStage(database, s1Sql, "s1");
    preserved(before, await snapshot(database), "S1");
    await integrity(database);
  });
}

test("real D1 each contraction failure retains S1 values, retry state and ledger before retry", { timeout: 60_000 }, async () => {
  const database = await miniflare.getD1Database("CONTRACT");
  await seed(database);
  await applyStage(database, s1Sql, "s1");
  const before = await snapshot(database);
  for (const checkpoint of ["after-occurrence-contraction", "after-sample-contraction"]) {
    const broken = s2Sql.replace(`-- qualification checkpoint: ${checkpoint}`, "INSERT INTO compatibility_stage_d_assertion VALUES (0);");
    await assert.rejects(applyStage(database, broken, "s2"), /CHECK constraint failed/);
    assert.deepEqual(await snapshot(database), before);
    await integrity(database);
  }
  await assert.rejects(applyStage(database, s2Sql, "s2", [database.prepare("INSERT INTO d1_migrations(name) VALUES ('inactive-s2-qualification.sql')")]), /UNIQUE constraint failed/);
  assert.deepEqual(await snapshot(database), before);
  await applyStage(database, s2Sql, "s2");
  preserved(before, await snapshot(database), "S2");
  await integrity(database);
});
