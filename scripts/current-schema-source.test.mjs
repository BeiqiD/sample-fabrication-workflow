import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { normalizeSchemaSql } from "./d1-migration-plan.mjs";

const root = new URL("../", import.meta.url);
const sqlNames = (directory) => readdirSync(new URL(directory, root)).filter((name) => name.endsWith(".sql")).sort();

test("the current chain admits the reviewed FP1 suffix and retains the S2 baseline and all 37 historical SQL files byte-for-byte", () => {
  assert.deepEqual(sqlNames("migrations/"), ["0001_v3_baseline.sql", "0002_fp1_file_registry.sql", "0003_fp1_import_acceptance.sql", "0004_r2_upload_acceptance.sql", "0005_metrology_reference_acceptance.sql", "0006_comment_acceptance.sql", "0007_fp1_file_authority_transition.sql", "0008_fp1_shadow_runtime.sql"]);
  const baseline = readFileSync(new URL("scripts/fixtures/backend-schema/s2-baseline.sql", root));
  assert.deepEqual(readFileSync(new URL("migrations/0001_v3_baseline.sql", root)), baseline);
  const recorded = [...baseline.toString("utf8").matchAll(/^-- Source migrations\/([^ /]+\.sql) sha256=([a-f0-9]{64})$/gm)];
  assert.equal(recorded.length, 37);
  assert.deepEqual(sqlNames("migrations-history/s0/"), recorded.map((match) => match[1]).sort());
  for (const [, name, expected] of recorded) {
    const actual = createHash("sha256").update(readFileSync(new URL(`migrations-history/s0/${name}`, root))).digest("hex");
    assert.equal(actual, expected, `Retained historical SQL bytes: ${name}`);
  }
});

test("upload migration has five complete statements and records its ledger only after all four guards", () => {
  const filename = "0004_r2_upload_acceptance.sql";
  const sql = readFileSync(new URL(`migrations/${filename}`, root), "utf8");
  const statements = splitSql(sql);
  assert.equal(statements.length, 5, "One table and four triggers must remain independent complete statements");
  const tracked = splitSql(`${sql}\nINSERT INTO d1_migrations (name) VALUES ('${filename}');`);
  assert.equal(tracked.length, 6, "Wrangler's appended migration ledger INSERT must remain independent");
  const actual = new DatabaseSync(":memory:");
  const whole = new DatabaseSync(":memory:");
  const catalog = (db) => db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'r2_upload_requests' ORDER BY type, name")
    .all().map((row) => ({ ...row, sql: row.sql === null ? null : normalizeSchemaSql(row.sql) }));
  try {
    for (const db of [actual, whole]) {
      db.exec("PRAGMA foreign_keys = ON; CREATE TABLE d1_migrations (name TEXT NOT NULL UNIQUE);");
      for (const name of sqlNames("migrations/").filter((name) => name < filename)) {
        db.exec(readFileSync(new URL(`migrations/${name}`, root), "utf8"));
      }
    }
    // prepare executes one statement; unlike whole-file exec, it cannot conceal
    // an incorrectly merged tail of trigger definitions or the ledger INSERT.
    for (const statement of tracked) actual.prepare(statement).run();
    whole.exec(sql);
    assert.deepEqual(catalog(actual), catalog(whole));
    assert.deepEqual(actual.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'r2_upload_requests' ORDER BY name")
      .all().map(({ name }) => name), [
      "r2_upload_requests_delete_guard", "r2_upload_requests_insert_guard",
      "r2_upload_requests_publication_guard", "r2_upload_requests_update_guard",
    ]);
    assert.deepEqual(actual.prepare("SELECT name FROM d1_migrations").all().map(({ name }) => name), [filename]);
    assert.deepEqual(actual.prepare("PRAGMA foreign_key_check").all(), []);

    // Reproduce the released formatting defect without storing a second schema.
    const unsafe = sql.replace(/ END[ \t]+(?=[);])/g, " END");
    assert.deepEqual(normalizeSchemaSql(unsafe), normalizeSchemaSql(sql), "The correction changes whitespace only");
    assert.equal(splitSql(unsafe).length, 1, "CASE END before punctuation concealed all later statements");
    assert.equal((sql.match(/ END ;/g) ?? []).length, 9, "Keep inline CASE endings distinct from terminal trigger END; as in deployed 0003");
  } finally {
    actual.close();
    whole.close();
  }
});

test("metrology migration publishes all four guards before its tracking row under individual prepared execution", () => {
  const filename = "0005_metrology_reference_acceptance.sql";
  const sql = readFileSync(new URL(`migrations/${filename}`, root), "utf8");
  assert.equal(splitSql(sql).length, 5, "One business receipt table and four complete guards");
  const tracked = splitSql(`${sql}\nINSERT INTO d1_migrations (name) VALUES ('${filename}');`);
  assert.equal(tracked.length, 6, "Tracking cannot be swallowed by a CASE or trigger body");
  const actual = new DatabaseSync(":memory:");
  const whole = new DatabaseSync(":memory:");
  const catalog = (db) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all().map((row) => ({ ...row, sql: row.sql === null ? null : normalizeSchemaSql(row.sql) }));
  try {
    for (const db of [actual, whole]) {
      db.exec("PRAGMA foreign_keys = ON; CREATE TABLE d1_migrations (name TEXT NOT NULL UNIQUE);");
      for (const name of sqlNames("migrations/").filter((name) => name < filename)) {
        db.exec(readFileSync(new URL(`migrations/${name}`, root), "utf8"));
      }
      db.prepare("INSERT INTO samples (id, code, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("retained-before-fp1i", "FP1I", "Retained sample", "2026-09-14T00:00:00.000Z", "2026-09-14T00:00:00.000Z");
    }
    const previous = catalog(actual);
    const rowsBefore = actual.prepare("SELECT * FROM samples").all();
    for (const statement of tracked) actual.prepare(statement).run();
    whole.exec(sql);
    assert.deepEqual(catalog(actual), catalog(whole));
    assert.deepEqual(catalog(actual).filter((row) => row.tbl_name !== "metrology_reference_upload_requests"), previous,
      "No old schema object may change in this additive migration");
    assert.deepEqual(actual.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'metrology_reference_upload_requests' ORDER BY name")
      .all().map(({ name }) => name), [
      "metrology_reference_upload_requests_delete_guard", "metrology_reference_upload_requests_insert_guard",
      "metrology_reference_upload_requests_publication_guard", "metrology_reference_upload_requests_update_guard",
    ]);
    assert.deepEqual(actual.prepare("SELECT * FROM samples").all(), rowsBefore);
    assert.deepEqual(actual.prepare("SELECT name FROM d1_migrations").all().map(({ name }) => name), [filename]);
    assert.deepEqual(actual.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { actual.close(); whole.close(); }
});

test("Comment migration installs every complete statement before tracking while preserving populated canonical state", () => {
  const filename = "0006_comment_acceptance.sql";
  const sql = readFileSync(new URL(`migrations/${filename}`, root), "utf8");
  const tracked = splitSql(`${sql}\nINSERT INTO d1_migrations (name) VALUES ('${filename}');`);
  const actual = new DatabaseSync(":memory:");
  const whole = new DatabaseSync(":memory:");
  const catalog = (db) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all().map((row) => ({ ...row, sql: row.sql === null ? null : normalizeSchemaSql(row.sql) }));
  const key = (row) => `${row.type}:${row.name}`;
  try {
    for (const db of [actual, whole]) {
      db.exec("PRAGMA foreign_keys = ON; CREATE TABLE d1_migrations (name TEXT NOT NULL UNIQUE);");
      for (const name of sqlNames("migrations/").filter((name) => name < filename)) {
        db.exec(readFileSync(new URL(`migrations/${name}`, root), "utf8"));
      }
      db.prepare("INSERT INTO samples (id, code, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("retained-before-fp1j", "FP1J", "Retained sample", "2026-09-14T00:00:00.000Z", "2026-09-14T00:00:00.000Z");
      db.prepare("INSERT INTO comment_submissions (id, context_kind, sample_id, body, status, actor_email, created_at, updated_at) VALUES (?, 'sample', ?, ?, 'ready', ?, ?, ?)")
        .run("retained-comment-fp1j", "retained-before-fp1j", "Historical ready comment", "fixture@example.test", "2026-09-14T00:00:00.000Z", "2026-09-14T00:00:00.000Z");
    }
    const before = catalog(actual);
    const oldKeys = new Set(before.map(key));
    const tables = before.filter((row) => row.type === "table").map((row) => row.name);
    const beforeRows = new Map(tables.map((name) => [name, actual.prepare(`SELECT * FROM "${name}"`).all()]));
    const retentionBefore = actual.prepare("SELECT * FROM blob_retention_edges").all();
    whole.exec(sql);
    const expected = catalog(whole);
    const additions = expected.filter((row) => !oldKeys.has(key(row)));
    assert.deepEqual(additions.filter((row) => row.type === "table").map((row) => row.name),
      ["comment_item_acceptances", "comment_submission_acceptances"]);
    assert.ok(additions.some((row) => row.type === "trigger" && row.tbl_name === "comment_submissions"), "Canonical cancellation/identity guards are part of the migration");
    assert.equal(splitSql(sql).length, additions.length, "Each schema addition must be a complete Wrangler statement");
    assert.equal(tracked.length, additions.length + 1, "Migration tracking must remain a distinct final statement");
    for (const statement of tracked) actual.prepare(statement).run();
    assert.deepEqual(catalog(actual), expected, "Prepared execution must install exactly the whole-file schema");
    assert.deepEqual(expected.filter((row) => oldKeys.has(key(row))), before, "Every previous schema object keeps its definition");
    for (const name of tables.filter((name) => name !== "d1_migrations")) {
      assert.deepEqual(actual.prepare(`SELECT * FROM "${name}"`).all(), beforeRows.get(name), `Retained rows: ${name}`);
    }
    assert.deepEqual(actual.prepare("SELECT * FROM blob_retention_edges").all(), retentionBefore);
    assert.deepEqual(actual.prepare("SELECT * FROM comment_submission_acceptances").all(), []);
    assert.deepEqual(actual.prepare("SELECT * FROM comment_item_acceptances").all(), []);
    assert.deepEqual(actual.prepare("SELECT name FROM d1_migrations").all().map(({ name }) => name), [filename]);
    assert.deepEqual(actual.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { actual.close(); whole.close(); }
});
