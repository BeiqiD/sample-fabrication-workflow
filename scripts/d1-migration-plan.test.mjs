import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  migrationSqlHash,
  normalizeSchema,
  normalizeSchemaSql,
  planD1Migrations,
  schemaFingerprint,
} from "./d1-migration-plan.mjs";

// Test-only local adapter. The production planner consumes observations and has
// no SQLite, filesystem, Wrangler, subprocess, or network capability.
function observe(database) {
  const quote = (name) => `'${name.replaceAll("'", "''")}'`;
  const objects = database.prepare("SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema ORDER BY type, name").all();
  return {
    objects,
    relations: objects.filter(({ type }) => type === "table" || type === "view").map(({ name }) => ({
      name,
      columns: database.prepare(`PRAGMA table_xinfo(${quote(name)})`).all(),
      foreignKeys: database.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all(),
      indexes: database.prepare(`PRAGMA index_list(${quote(name)})`).all().map((index) => ({
        ...index,
        columns: database.prepare(`PRAGMA index_xinfo(${quote(index.name)})`).all(),
      })),
    })),
  };
}

function schema(sql = "") {
  const db = new DatabaseSync(":memory:");
  try { db.exec(sql); return observe(db); } finally { db.close(); }
}

const baselineName = "0001_v3_baseline.sql";
const legacyName = "0001_original.sql";
const cleanupName = "0002_cleanup.sql";
const futureName = "0003_future.sql";
const initialSql = `CREATE TABLE samples (id TEXT PRIMARY KEY, body TEXT NOT NULL DEFAULT 'a  b');`;
const cleanupSql = "ALTER TABLE samples ADD COLUMN extra TEXT;";
const futureSql = "CREATE INDEX samples_body ON samples(body);";
const ledgerSql = `CREATE TABLE d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

function fixture() {
  const files = [
    { filename: legacyName, sql: initialSql },
    { filename: cleanupName, sql: cleanupSql },
    { filename: baselineName, sql: initialSql + cleanupSql },
    { filename: futureName, sql: futureSql },
  ];
  const sources = files.map(({ filename, sql }) => ({
    filename,
    sha256: migrationSqlHash(sql),
    kind: filename === legacyName ? "historical" : filename === baselineName ? "baseline" : "incremental",
  }));
  return {
    sourceFiles: files,
    catalog: {
      version: 1,
      sources,
      freshLineage: "v3-baseline",
      lineages: [
        {
          id: "v3-legacy", kind: "legacy", migrations: [legacyName, cleanupName, futureName],
          supportedStates: [
            { appliedCount: 1, schema: schema(initialSql) },
            { appliedCount: 2, schema: schema(initialSql + cleanupSql) },
            { appliedCount: 3, schema: schema(initialSql + cleanupSql + futureSql) },
          ],
        },
        {
          id: "v3-baseline", kind: "baseline", migrations: [baselineName, futureName],
          supportedStates: [
            { appliedCount: 1, schema: schema(initialSql + cleanupSql) },
            { appliedCount: 2, schema: schema(initialSql + cleanupSql + futureSql) },
          ],
        },
      ],
    },
  };
}

function target(sql = "", names = [], exists = names.length > 0) {
  return {
    schema: schema(sql + (exists ? ledgerSql : "")),
    ledger: { exists, rows: names.map((name, index) => ({ id: index + 1, name })) },
  };
}

function plan(inputTarget, overrides = {}) {
  return planD1Migrations({ ...fixture(), target: inputTarget, ...overrides });
}

const migrationNames = (result) => result.migrations.map(({ filename }) => filename);

test("empty database proposes only baseline and later increments without execution authority", () => {
  for (const exists of [false, true]) {
    const result = plan(target("", [], exists));
    assert.equal(result.classification, "empty");
    assert.deepEqual(migrationNames(result), [baselineName, futureName]);
    assert.equal(result.executionAuthorized, false);
  }
});

test("legacy and baseline paths converge without changing either ledger lineage", () => {
  const oldTarget = target(initialSql, [legacyName]);
  const before = JSON.stringify(oldTarget);
  const legacy = plan(oldTarget);
  assert.deepEqual(migrationNames(legacy), [cleanupName, futureName]);
  assert.equal(legacy.classification, "legacy");
  assert.equal(JSON.stringify(oldTarget), before);
  const baseline = plan(target(initialSql + cleanupSql, [baselineName]));
  assert.deepEqual(migrationNames(baseline), [futureName]);
  assert.equal(baseline.classification, "baseline");
  assert.equal(legacy.expectedFinalSchemaHash, baseline.expectedFinalSchemaHash);
});

test("fully migrated targets are no-op, and a completed cleanup resumes only its remaining suffix", () => {
  const partial = plan(target(initialSql + cleanupSql, [legacyName, cleanupName]));
  assert.deepEqual(migrationNames(partial), [futureName]);
  const complete = plan(target(initialSql + cleanupSql + futureSql, [legacyName, cleanupName, futureName]));
  assert.deepEqual(complete.migrations, []);
});

test("rejects unknown, mixed, non-prefix, duplicate and misordered ledger rows", () => {
  for (const names of [
    ["0099_unknown.sql"],
    [legacyName, baselineName],
    [legacyName, futureName],
    [legacyName, legacyName],
    [cleanupName, legacyName],
  ]) {
    assert.throws(() => plan(target(initialSql, names)), /Migration plan rejected:/);
  }
  const duplicateId = target(initialSql + cleanupSql, [legacyName, cleanupName]);
  duplicateId.ledger.rows[1].id = 1;
  assert.throws(() => plan(duplicateId), /ledger order or duplicate id/);
  duplicateId.ledger.rows[0].id = 3;
  duplicateId.ledger.rows[1].id = 2;
  assert.throws(() => plan(duplicateId), /ledger order or duplicate id/);
});

test("empty or missing ledger with existing application objects never receives baseline", () => {
  for (const exists of [false, true]) {
    assert.throws(() => plan(target(initialSql, [], exists)), /empty ledger with application schema/);
    assert.throws(() => plan(target("CREATE VIEW stray AS SELECT 1 AS x;", [], exists)), /empty ledger with application schema/);
  }
});

test("ledger existence and observed schema must agree", () => {
  const missingTable = target();
  missingTable.ledger.exists = true;
  assert.throws(() => plan(missingTable), /ledger existence disagrees/);
  const hiddenTable = target("", [], true);
  hiddenTable.ledger.exists = false;
  assert.throws(() => plan(hiddenTable), /ledger existence disagrees/);
});

test("schema drift covers table columns, constraints, views, indexes and triggers", () => {
  for (const drift of [
    "ALTER TABLE samples ADD COLUMN unexpected TEXT;",
    "CREATE VIEW unexpected AS SELECT id FROM samples;",
    "CREATE INDEX unexpected ON samples(body);",
    "CREATE TRIGGER unexpected AFTER INSERT ON samples BEGIN SELECT 1; END;",
  ]) {
    assert.throws(() => plan(target(initialSql + drift, [legacyName])), /schema drift/);
  }
  assert.throws(() => plan(target(initialSql.replace("TEXT NOT NULL", "TEXT"), [legacyName])), /schema drift/);
  assert.throws(() => plan(target(initialSql.replace("'a  b'", "'a b'"), [legacyName])), /schema drift/);
});

test("full PRAGMA structure participates in the fingerprint", () => {
  const sql = `CREATE TABLE parent(id TEXT PRIMARY KEY);
    CREATE TABLE child(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id), body TEXT);
    CREATE INDEX child_body ON child(body COLLATE NOCASE DESC) WHERE body IS NOT NULL;`;
  const original = schema(sql);
  for (const mutate of [
    (value) => { value.relations.find(({ name }) => name === "child").columns[1].type = "INTEGER"; },
    (value) => { value.relations.find(({ name }) => name === "child").foreignKeys[0].on_delete = "CASCADE"; },
    (value) => { value.relations.find(({ name }) => name === "child").indexes.find(({ name }) => name === "child_body").partial = 0; },
    (value) => { value.relations.find(({ name }) => name === "child").indexes.find(({ name }) => name === "child_body").columns[0].coll = "BINARY"; },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.notEqual(schemaFingerprint(original), schemaFingerprint(changed));
  }
});

test("schema normalization ignores observation order and SQL formatting but preserves quoted content", () => {
  const original = schema(initialSql + futureSql);
  const reordered = structuredClone(original);
  reordered.objects.reverse();
  reordered.relations.reverse();
  for (const relation of reordered.relations) {
    relation.columns.reverse();
    relation.indexes.reverse();
    for (const index of relation.indexes) index.columns.reverse();
  }
  assert.equal(schemaFingerprint(original), schemaFingerprint(reordered));
  assert.deepEqual(normalizeSchemaSql("CREATE TABLE a(x TEXT DEFAULT 'a  b');"), normalizeSchemaSql(" CREATE /* spacer */ TABLE a ( x TEXT DEFAULT 'a  b' ) ; -- end"));
  assert.notDeepEqual(normalizeSchemaSql("SELECT 'a  b'"), normalizeSchemaSql("SELECT 'a b'"));
  assert.notDeepEqual(normalizeSchemaSql('SELECT "quoted name"'), normalizeSchemaSql('SELECT "quoted  name"'));
  assert.throws(() => normalizeSchemaSql("SELECT 'unclosed"), /unterminated/);
  assert.throws(() => normalizeSchemaSql("SELECT /* unclosed"), /unterminated/);
});

test("rejects incomplete observations instead of treating missing metadata as an empty schema", () => {
  assert.throws(() => normalizeSchema({ objects: [], relations: undefined }), /must be an array/);
  const missingRelation = schema(initialSql);
  missingRelation.relations = [];
  assert.throws(() => normalizeSchema(missingRelation), /missing relation metadata/);
  const missingIndex = schema(initialSql + futureSql);
  missingIndex.relations[0].indexes = [];
  assert.throws(() => normalizeSchema(missingIndex), /missing index metadata/);
  const missingSql = schema(initialSql + futureSql);
  missingSql.objects = missingSql.objects.filter(({ name }) => name !== "samples_body");
  assert.throws(() => normalizeSchema(missingSql), /missing index SQL object/);
});

test("blob literals do not collide with an identifier and quoted alias in trigger SQL", () => {
  const definition = (expression) => `CREATE TABLE t(x TEXT); CREATE TABLE log(value);
    CREATE TRIGGER audit AFTER INSERT ON t BEGIN INSERT INTO log(value) SELECT ${expression} FROM t; END;`;
  const blob = definition("x'00'");
  const alias = definition("x '00'");
  assert.notEqual(schemaFingerprint(schema(blob)), schemaFingerprint(schema(alias)));
  for (const [sql, expectedType, expectedHex] of [[blob, "blob", "00"], [alias, "text", "61637475616C"]]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(sql + "INSERT INTO t VALUES ('actual');");
      const result = db.prepare("SELECT typeof(value) AS type, hex(value) AS hex FROM log").get();
      assert.equal(result.type, expectedType);
      assert.equal(result.hex, expectedHex);
    } finally { db.close(); }
  }
});

test("SQLite non-ASCII identifier adjacency does not collide with an alias", () => {
  for (const separator of ["\u00a0", "😀", "\u0301"]) {
    const identifier = `a${separator}b`;
    const definition = (expression) => `CREATE TABLE t(a TEXT, "${identifier}" TEXT); CREATE TABLE log(value);
      CREATE TRIGGER audit AFTER INSERT ON t BEGIN INSERT INTO log(value) SELECT ${expression} FROM t; END;`;
    const wholeIdentifier = definition(identifier);
    const separateAlias = definition(separator === "\u00a0" ? "a b" : `a ${separator}b`);
    assert.notEqual(schemaFingerprint(schema(wholeIdentifier)), schemaFingerprint(schema(separateAlias)));
    for (const [sql, expected] of [[wholeIdentifier, "second"], [separateAlias, "first"]]) {
      const db = new DatabaseSync(":memory:");
      try {
        db.exec(sql + "INSERT INTO t VALUES ('first', 'second');");
        assert.equal(db.prepare("SELECT value FROM log").get().value, expected);
      } finally { db.close(); }
    }
  }
});

test("only explicit platform metadata is excluded; underscore application tables remain visible", () => {
  assert.equal(schemaFingerprint(schema(initialSql)), schemaFingerprint(schema(initialSql + ledgerSql)));
  assert.notEqual(schemaFingerprint(schema(initialSql)), schemaFingerprint(schema(initialSql + "CREATE TABLE _application(id TEXT);")));
  assert.throws(() => plan(target("CREATE TABLE _application(id TEXT);", [])), /empty ledger/);
  assert.throws(() => plan(target("CREATE TABLE _cf_KV(key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID; CREATE TRIGGER unexpected AFTER INSERT ON _cf_KV BEGIN SELECT 1; END;", [])), /empty ledger/);
});

test("only exact protected engine tables may omit unavailable PRAGMA metadata", () => {
  for (const ddl of ["CREATE TABLE _cf_METADATA(key INTEGER PRIMARY KEY, value BLOB);", "CREATE TABLE _cf_KV(key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;"]) {
    const complete = schema(initialSql + ddl);
    const partial = structuredClone(complete);
    partial.relations = partial.relations.filter(({ name }) => !["_cf_METADATA", "_cf_KV"].includes(name));
    assert.equal(schemaFingerprint(partial), schemaFingerprint(schema(initialSql)));
    assert.equal(schemaFingerprint(partial), schemaFingerprint(complete));
    const applicationMissing = structuredClone(partial);
    applicationMissing.relations = [];
    assert.throws(() => normalizeSchema(applicationMissing), /missing relation metadata: samples/);
  }
  for (const sql of [
    "CREATE TABLE _cf_METADATA(id TEXT, payload TEXT);",
    "CREATE VIEW _cf_METADATA AS SELECT 1 AS key;",
    "CREATE TABLE _cf_KV(key TEXT PRIMARY KEY, value BLOB);",
    "CREATE TABLE _cf_METADATA(key INTEGER PRIMARY KEY, value BLOB); CREATE INDEX unexpected ON _cf_METADATA(value);",
  ]) assert.throws(() => normalizeSchema(schema(sql)), /unexpected protected platform/);
  const trigger = schema("CREATE TABLE _cf_METADATA(key INTEGER PRIMARY KEY, value BLOB); CREATE TRIGGER application_audit AFTER INSERT ON _cf_METADATA BEGIN SELECT 1; END;");
  trigger.relations = [];
  assert.equal(normalizeSchema(trigger).objects[0].name, "application_audit");
  const unknown = schema("CREATE TABLE _cf_application(id TEXT);");
  unknown.relations = [];
  assert.throws(() => normalizeSchema(unknown), /missing relation metadata/);
});

test("supports generated columns, expression/partial indexes and WITHOUT ROWID metadata", () => {
  const observed = schema(`CREATE TABLE generated (id TEXT PRIMARY KEY, body TEXT, doubled TEXT AS (body || body)) WITHOUT ROWID;
    CREATE INDEX generated_expression ON generated(length(body)) WHERE body IS NOT NULL;`);
  const normalized = normalizeSchema(observed);
  assert.equal(normalized.relations[0].columns[2].hidden, 2);
  assert(normalized.relations[0].indexes.some(({ columns }) => columns.some(({ cid }) => cid === -2)));
});

test("catalog hashes bind exact SQL bytes and reject uncatalogued or missing files", () => {
  const changed = fixture();
  changed.sourceFiles[0].sql += "\n-- modified";
  assert.throws(() => plan(target(), changed), /source hash mismatch/);
  const missing = fixture();
  missing.sourceFiles.pop();
  assert.throws(() => plan(target(), missing), /missing file/);
  const extra = fixture();
  extra.sourceFiles.push({ filename: "9999_extra.sql", sql: "SELECT 1;" });
  assert.throws(() => plan(target(), extra), /uncatalogued source/);
});

test("baseline cannot enter a legacy proposal and catalog cannot leave resumable states unclassified", () => {
  const mixed = fixture();
  mixed.catalog.lineages[0].migrations = [legacyName, baselineName, futureName];
  assert.throws(() => plan(target(), mixed), /legacy lineage contains baseline/);
  const gap = fixture();
  gap.catalog.lineages[0].supportedStates.splice(1, 1);
  assert.throws(() => plan(target(), gap), /missing resumable prefix/);
  const unsupported = fixture();
  unsupported.catalog.lineages[0].supportedStates.shift();
  assert.throws(() => plan(target(initialSql, [legacyName]), unsupported), /unsupported ledger prefix/);
  const ambiguous = fixture();
  ambiguous.catalog.lineages.push({ ...ambiguous.catalog.lineages[0], id: "duplicate-history" });
  assert.throws(() => plan(target(initialSql, [legacyName]), ambiguous), /ambiguous ledger/);
});

test("current complete 37-file ledger is a no-op without receiving any baseline SQL", () => {
  const directory = new URL("../migrations/", import.meta.url);
  const filenames = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  assert.equal(filenames.length, 37);
  assert.deepEqual(filenames.filter((name) => name.startsWith("0015_")), ["0015_atomic_mutation_identity.sql", "0015_managed_orphan_dedupe_repair.sql"]);
  const currentFiles = filenames.map((filename) => ({ filename, sql: readFileSync(new URL(filename, directory), "utf8") }));
  const currentSql = currentFiles.map(({ sql }) => sql).join("\n");
  const currentSchema = schema(currentSql);
  const testBaseline = { filename: baselineName, sql: currentSql };
  // The synthetic baseline here intentionally replays the same chain. It only
  // tests planner lineage isolation, not construction/qualification of clean DDL.
  const sourceFiles = [...currentFiles, testBaseline];
  const catalog = {
    version: 1,
    sources: sourceFiles.map(({ filename, sql }) => ({ filename, sha256: migrationSqlHash(sql), kind: filename === baselineName ? "baseline" : "historical" })),
    freshLineage: "baseline-fixture",
    lineages: [
      { id: "current-37", kind: "legacy", migrations: filenames, supportedStates: [{ appliedCount: 37, schema: currentSchema }] },
      { id: "baseline-fixture", kind: "baseline", migrations: [baselineName], supportedStates: [{ appliedCount: 1, schema: currentSchema }] },
    ],
  };
  const result = planD1Migrations({ catalog, sourceFiles, target: target(currentSql, filenames) });
  assert.equal(result.lineage, "current-37");
  assert.deepEqual(result.migrations, []);
  assert.equal(result.expectedFinalSchemaHash, schemaFingerprint(currentSchema));
  assert.equal(currentSchema.objects.filter(({ type }) => type === "table").length, 34);
  const omitted = filenames.filter((name) => name !== "0015_managed_orphan_dedupe_repair.sql");
  assert.throws(() => planD1Migrations({ catalog, sourceFiles, target: target(currentSql, omitted) }), /incomplete/);
});
