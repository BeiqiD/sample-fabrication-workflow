import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { normalizeSchemaSql } from "./d1-migration-plan.mjs";

const root = new URL("../", import.meta.url);
const sqlNames = (directory) => readdirSync(new URL(directory, root)).filter((name) => name.endsWith(".sql")).sort();

for (const filename of ["0021_fp5_system_recovery.sql", "0022_fp5_recovery_evidence.sql", "0023_portable_local_identity.sql"]) {
  test(`${filename} commits populated whole-file and Wrangler-split upgrades without changing original cells, physical IDs or receipts`, () => {
    const actual = new DatabaseSync(":memory:"), whole = new DatabaseSync(":memory:");
    const quote = name => `"${name.replaceAll('"', '""')}"`;
    const sql = readFileSync(new URL(`migrations/${filename}`, root), "utf8");
    const rows = (db, name) => {
      const table = db.prepare("SELECT wr FROM pragma_table_list WHERE name=?").get(name);
      const statement = db.prepare(`SELECT ${table.wr ? "" : "rowid,"}* FROM ${quote(name)}`);
      statement.setReadBigInts(true);
      return statement.all();
    };
    try {
      for (const db of [actual, whole]) {
        db.exec('PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
        for (const prior of sqlNames("migrations/").filter(name => name < filename)) {
          db.exec(readFileSync(new URL(`migrations/${prior}`, root), "utf8"));
          db.prepare("INSERT INTO d1_migrations(name,applied_at) VALUES(?,'2026-10-05 00:00:00')").run(prior);
        }
        db.exec(readFileSync(new URL("worker/fixtures/reference-graph.sql", root), "utf8"));
        db.prepare("UPDATE assets SET rowid=? WHERE id='reference-execution-asset'").run(9223372036854775806n);
        db.prepare("UPDATE samples SET rowid=? WHERE id='reference-sample-a'").run(-9223372036854775807n);
      }
      const names = actual.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row => row.name);
      const priorRows = new Map(names.map(name => [name, rows(actual, name)]));
      const priorWholeRows = new Map(names.map(name => [name, rows(whole, name)]));
      const priorLedger = actual.prepare("SELECT * FROM d1_migrations ORDER BY id").all();
      whole.exec("BEGIN IMMEDIATE"); whole.exec(sql); whole.exec("COMMIT");
      actual.exec("BEGIN IMMEDIATE");
      for (const statement of splitSql(sql)) actual.prepare(statement).run();
      assert.deepEqual(actual.prepare("SELECT * FROM d1_migrations ORDER BY id").all(), priorLedger);
      actual.prepare("INSERT INTO d1_migrations(name) VALUES(?)").run(filename); actual.exec("COMMIT");
      for (const [name, expected] of priorRows) {
        const observed = rows(actual, name);
        assert.deepEqual(name === "d1_migrations" ? observed.slice(0, expected.length) : observed, expected, `Original typed cells and rowids: ${name}`);
        assert.deepEqual(rows(whole, name), priorWholeRows.get(name), `Whole-file preservation: ${name}`);
      }
      const catalog = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all();
      assert.deepEqual(catalog(actual), catalog(whole));
      assert.deepEqual(actual.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(actual.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
      assert.equal(actual.prepare("SELECT enabled FROM system_recovery_runtime").get().enabled, 0);
      assert.equal(actual.prepare("SELECT mode FROM file_authority_control").get().mode, "legacy");
    } finally { actual.close(); whole.close(); }
  });
}

test("the current chain admits the reviewed FP1–FP5 and portable identity suffix and retains the S2 baseline and all 37 historical SQL files byte-for-byte", () => {
  assert.deepEqual(sqlNames("migrations/"), ["0001_v3_baseline.sql", "0002_fp1_file_registry.sql", "0003_fp1_import_acceptance.sql", "0004_r2_upload_acceptance.sql", "0005_metrology_reference_acceptance.sql", "0006_comment_acceptance.sql", "0007_fp1_file_authority_transition.sql", "0008_fp1_shadow_runtime.sql", "0009_fp1_shadow_withdrawals.sql", "0010_fp1_shadow_adjudications.sql", "0011_fp1_retire_legacy_test_projects.sql", "0012_fp1_file_authority_runtime.sql", "0013_fp1_r2_role_defaults.sql", "0014_fp2_storage_configuration.sql", "0015_fp2_storage_candidate_checks.sql", "0016_fp2_credential_reenvelopes.sql", "0017_fp2_native_storage_profiles.sql", "0018_fp2_native_file_runtime.sql", "0019_fp3_file_jobs.sql", "0020_fp4_research_packages.sql", "0021_fp5_system_recovery.sql", "0022_fp5_recovery_evidence.sql", "0023_portable_local_identity.sql"]);
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

test("FP3 job migration installs identical whole-file and Wrangler-split schemas with local execution disabled", () => {
  const filename = "0019_fp3_file_jobs.sql";
  const sql = readFileSync(new URL(`migrations/${filename}`, root), "utf8");
  const tracked = splitSql(`${sql}\nINSERT INTO d1_migrations(name) VALUES('${filename}');`);
  assert.equal(tracked.length, splitSql(sql).length + 1, "The migration ledger must remain a separate last statement");
  const actual = new DatabaseSync(":memory:"), whole = new DatabaseSync(":memory:");
  const catalog = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
    .all().map(row => ({ ...row, sql: row.sql === null ? null : normalizeSchemaSql(row.sql) }));
  try {
    for (const db of [actual, whole]) {
      db.exec("PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(name TEXT NOT NULL UNIQUE)");
      for (const name of sqlNames("migrations/").filter(name => name < filename)) {
        db.exec(readFileSync(new URL(`migrations/${name}`, root), "utf8"));
      }
    }
    actual.exec("BEGIN IMMEDIATE");
    for (const [index, statement] of tracked.entries()) {
      assert.doesNotThrow(() => actual.prepare(statement).run(), `Complete FP3 Wrangler statement ${index + 1}: ${statement.slice(0, 140)}`);
    }
    actual.exec("COMMIT");
    whole.exec("BEGIN IMMEDIATE");
    whole.exec(sql);
    whole.prepare("INSERT INTO d1_migrations(name) VALUES(?)").run(filename);
    whole.exec("COMMIT");
    assert.deepEqual(catalog(actual), catalog(whole));
    for (const db of [actual, whole]) {
      assert.deepEqual(db.prepare("SELECT * FROM d1_migrations").all().map(row => ({ ...row })), [{ name: filename }]);
      assert.deepEqual(db.prepare("SELECT * FROM file_job_runtime_guard").all().map(row => ({ ...row })),
        [{ singleton: 1, enabled: 0, incarnation: null, last_heartbeat_at: null }]);
      assert.equal(db.prepare("SELECT count(*) n FROM file_job_cleanup_grants").get().n, 0);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    }
  } finally { actual.close(); whole.close(); }
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

test("native File migration preserves populated legacy aliases, receipts, signed rowids and histories under individually prepared Wrangler execution", () => {
  const filename = "0018_fp2_native_file_runtime.sql";
  const sql = readFileSync(new URL(`migrations/${filename}`, root), "utf8");
  const statements = splitSql(sql);
  const tracked = splitSql(`${sql}\nINSERT INTO d1_migrations(name) VALUES('${filename}');`);
  assert.equal(tracked.length, statements.length + 1);
  const actual = new DatabaseSync(":memory:"), whole = new DatabaseSync(":memory:"), invalid = new DatabaseSync(":memory:");
  const catalog = database => database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all().map(row => ({ ...row, sql: row.sql === null ? null : normalizeSchemaSql(row.sql) }));
  const rows = (database, table, columns) => {
    const statement = database.prepare(`SELECT ${columns.map(column => `"${column}"`).join(",")} FROM "${table}"`);
    statement.setReadBigInts(true);
    return statement.all();
  };
  const now = "2026-10-05T00:00:00.000Z", sha = "a".repeat(64);
  try {
    for (const database of [actual, whole, invalid]) {
      database.exec("PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(name TEXT NOT NULL UNIQUE)");
      for (const name of sqlNames("migrations/").filter(name => name < filename)) {
        database.exec(readFileSync(new URL(`migrations/${name}`, root), "utf8"));
        if (name === "0001_v3_baseline.sql") database.exec(readFileSync(new URL("worker/fixtures/reference-graph.sql", root), "utf8"));
      }
      database.prepare("INSERT INTO storage_profiles(rowid,id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at) VALUES(?,'retained-r2','r2',?,'bootstrap',NULL,1,'historical',?)")
        .run(-9007199254740993n, JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "retained-native-fixture" }), now);
      const input = JSON.stringify({ schema: "r2-upload-request/1", ingress: "ordinary_image", purpose: "embedded_content", scope: "system",
        file: { originalName: "retained.png", mimeType: "image/png", byteSize: 4, sha256: sha } });
      database.prepare(`INSERT INTO r2_upload_requests(id,actor_email,client_request_id,operation_id,ingress,purpose,request_sha256,request_input_json,request_scope,
        storage_profile_id,storage_profile_revision,storage_policy_revision,candidate_asset_id,candidate_object_key,status,created_at,expires_at)
        VALUES(?,'fixture@example.test',?,?,'ordinary_image','embedded_content',?,?,'system','retained-r2',1,1,?,'retained/candidate','pending',?,?)`)
        .run("10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000003", sha, input,
          "10000000-0000-4000-8000-000000000004", now, "2026-10-06T00:00:00.000Z");
      database.prepare("UPDATE assets SET rowid=? WHERE id='reference-execution-asset'").run(9223372036854775806n);
    }
    const oldTables = actual.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'d1_migrations' ORDER BY name").all();
    const before = new Map(oldTables.map(table => {
      const columns = actual.prepare(`PRAGMA table_info("${table.name}")`).all().map(column => column.name);
      return [table.name, { columns, rows: rows(actual, table.name, columns),
        rowids: /WITHOUT ROWID\s*$/i.test(table.sql) ? null : actual.prepare(`SELECT CAST(rowid AS TEXT) rowid FROM "${table.name}" ORDER BY rowid`).all() }];
    }));
    assert.ok(before.get("assets").rows.length > 0);
    assert.equal(before.get("r2_upload_requests").rows.length, 1);
    whole.exec("BEGIN IMMEDIATE"); whole.exec(sql); whole.exec("COMMIT");
    actual.exec("BEGIN IMMEDIATE");
    for (const statement of tracked.slice(0, -1)) actual.prepare(statement).run();
    assert.deepEqual(actual.prepare("SELECT * FROM d1_migrations").all(), []);
    assert.ok(actual.prepare("SELECT 1 FROM sqlite_schema WHERE name='file_native_runtime_generation_complete'").get());
    actual.prepare(tracked.at(-1)).run(); actual.exec("COMMIT");
    assert.deepEqual(catalog(actual), catalog(whole));
    for (const [table, snapshot] of before) {
      assert.deepEqual(rows(actual, table, snapshot.columns), snapshot.rows, `Every previous cell survives: ${table}`);
      if (snapshot.rowids) assert.deepEqual(actual.prepare(`SELECT CAST(rowid AS TEXT) rowid FROM "${table}" ORDER BY rowid`).all(), snapshot.rowids, `Signed rowids survive: ${table}`);
    }
    assert.deepEqual(actual.prepare("SELECT DISTINCT file_id,storage_profile_id,storage_profile_revision,object_key FROM assets").all().map(row => ({ ...row })),
      [{ file_id: null, storage_profile_id: null, storage_profile_revision: null, object_key: null }]);
    assert.deepEqual(actual.prepare("SELECT name FROM d1_migrations").all().map(row => ({ ...row })), [{ name: filename }]);
    assert.deepEqual(actual.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(whole.prepare("PRAGMA foreign_key_check").all(), []);
    invalid.exec("PRAGMA foreign_keys=OFF");
    invalid.prepare("DELETE FROM assets WHERE id='reference-execution-asset'").run();
    invalid.exec("PRAGMA foreign_keys=ON");
    assert.ok(invalid.prepare("PRAGMA foreign_key_check").all().length > 0);
    invalid.exec("BEGIN IMMEDIATE");
    assert.throws(() => invalid.exec(sql), /malformed JSON/);
    invalid.exec("ROLLBACK");
    assert.equal(invalid.prepare("SELECT 1 FROM sqlite_schema WHERE name='file_native_runtime_generation_complete'").get(), undefined);
    assert.deepEqual(invalid.prepare("SELECT * FROM d1_migrations").all(), []);
  } finally { actual.close(); whole.close(); invalid.close(); }
});
