import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const migrations = readdirSync(join(root, "migrations")).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
const sourceBytes = new TextEncoder().encode("Shadow inspection verified fixture 文件");
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
const sourceKey = "PRIVATE_OBJECT_KEY_SENTINEL";
const actor = "PRIVATE_ACTOR_SENTINEL@example.invalid";
const namespace = "r2:PRIVATE_NAMESPACE_SENTINEL:bucket";
const key = (consumerId = "inspection-event") => ({ consumerKind: "event", consumerId, consumerSubId: "", fileSlot: "primary" });
const directories = [];
let api;

before(async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-inspection-module-"));
  directories.push(directory);
  const outfile = join(directory, "inspection.mjs");
  await build({ stdin: { sourcefile: "shadow-inspection-fixture.ts", resolveDir: root, contents: `
    export { inspectFileShadowSnapshot, MAX_FILE_SHADOW_INSPECTION_CONSUMERS } from './scripts/lib/file-shadow-inspection-cli.ts';
    export { readShadowBaseline } from './worker/files/shadow-baseline.ts';
    export { registerLegacyInventory } from './worker/files/legacy-inventory.ts';
    export { convertShadowConsumer, admitShadowUnresolved } from './worker/files/shadow-service.ts';
  ` }, bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent" });
  api = await import(pathToFileURL(outfile).href);
});
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

// Real host SQLite, with the transaction behavior required by the production
// services. The adapter fabricates no SQL results and has no remote capability.
function d1(database) {
  function prepare(sql, values = []) {
    function execute() {
      const statement = database.prepare(sql);
      if (statement.columns().length) return { success: true, results: statement.all(...values), meta: { changes: 0 } };
      const result = statement.run(...values);
      return { success: true, results: [], meta: { changes: Number(result.changes) } };
    }
    return {
      bind(...bindings) { return prepare(sql, bindings); },
      async all() { return execute(); },
      async first() { return database.prepare(sql).get(...values) ?? null; },
      async run() { return execute(); },
      execute,
    };
  }
  return {
    prepare,
    async batch(statements) {
      database.exec("BEGIN");
      try { const results = statements.map((statement) => statement.execute()); database.exec("COMMIT"); return results; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
}

async function fixture({ populate = true, eventId = "inspection-event", rowid = 1n, through = "0008" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "shadow-inspection-"));
  directories.push(directory);
  const databasePath = join(directory, "snapshot.sqlite"), outputPath = join(directory, "report.json");
  const sql = new DatabaseSync(databasePath);
  const now = new Date().toISOString();
  try {
    sql.exec("BEGIN");
    for (const name of migrations.filter((name) => name.slice(0, 4) <= through)) sql.exec(readFileSync(join(root, "migrations", name), "utf8"));
    if (populate) {
      sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('sample','INSPECTION','PRIVATE_TITLE_SENTINEL',?,?)").run(now, now);
      sql.prepare(`INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at)
        VALUES('asset',?,'PRIVATE_FILENAME_SENTINEL.png','image/png',?,'ready',?,?)`).run(sourceKey, sourceBytes.length, sourceSha256, now);
      sql.prepare(`INSERT INTO events(rowid,id,sample_id,kind,body,asset_key,metadata_json,created_at)
        VALUES(?,?,'sample','image','PRIVATE_BODY_SENTINEL',?,'{"action":"sample_record","private":"PRIVATE_METADATA_SENTINEL"}',?)`)
        .run(rowid, eventId, sourceKey, now);
    }
    sql.exec("COMMIT");
  } catch (error) { sql.close(); throw error; }
  sql.close();
  return { directory, databasePath, outputPath, eventId, now };
}

async function change(fixture, callback) {
  const sql = new DatabaseSync(fixture.databasePath);
  try { return await callback(sql); } finally { sql.close(); }
}

async function inspect(fixture, outputPath = fixture.outputPath) {
  const result = await api.inspectFileShadowSnapshot({ databasePath: fixture.databasePath, outputPath });
  const encoded = await readFile(outputPath, "utf8");
  return { result, encoded, report: JSON.parse(encoded) };
}

async function noReport(path) { await assert.rejects(access(path), { code: "ENOENT" }); }

async function enableFixture(fixture, { loseAcknowledgement = false } = {}) {
  const sql = new DatabaseSync(fixture.databasePath), db = d1(sql);
  try {
    await api.registerLegacyInventory(db, { observedAt: fixture.now, observations: [{ storeKind: "r2", provider: "r2", objectKey: sourceKey,
      records: [{ table: "assets", id: "asset", byte_size: sourceBytes.length, sha256: sourceSha256, status: "ready", import_id: null }], consumers: [], lifecycle: [] }] },
    [{ id: "profile", adapterType: "r2", namespaceIdentity: namespace, configurationSource: "bootstrap", credentialReference: null, configurationRevision: 1 }]);
    sql.prepare("INSERT INTO file_shadow_enablements(singleton,expected_epoch,enabled_by,enabled_at) SELECT 1,epoch,?,? FROM file_shadow_control").run(actor, fixture.now);
    sql.prepare("INSERT INTO file_shadow_profile_enablements(storage_profile_id,configuration_revision,enabled_by,enabled_at) VALUES('profile',1,?,?)").run(actor, fixture.now);
    const incarnation = randomUUID();
    sql.prepare("UPDATE file_shadow_runtime_guard SET incarnation=?,enabled=1,enabled_by=?,updated_at=?").run(incarnation, actor, fixture.now);
    const objects = new Map([[sourceKey, sourceBytes]]);
    let reads = 0, writes = 0;
    const context = { db, actor, runtimeIncarnation: incarnation, async openProfile(profile) {
      assert.deepEqual(profile, { profileId: "profile", configurationRevision: 1 });
      return { storage: { ...profile, adapterType: "r2", namespaceIdentity: namespace },
        reader: { async read(objectKey) {
          reads += 1;
          const value = objects.get(objectKey);
          return value ? { outcome: "available", body: new ReadableStream({ start(controller) { controller.enqueue(value.slice()); controller.close(); } }) }
            : { outcome: "missing" };
        } },
        writer: { accepts: "stream", async write(input) {
          writes += 1;
          objects.set(input.key, new Uint8Array(await new Response(input.body).arrayBuffer()));
          if (loseAcknowledgement) throw new Error("PRIVATE_PROVIDER_ERROR_SENTINEL");
        } },
        createHash() { const hash = createHash("sha256"); return { async write(bytes) { hash.update(bytes); }, async finish() { return hash.digest("hex"); }, async abort() {} }; },
      };
    } };
    async function request() {
      const baseline = await api.readShadowBaseline(db, key(fixture.eventId));
      assert.equal(baseline.status, "ready_to_verify");
      return { operationId: randomUUID(), key: key(fixture.eventId), expectedBaselineSha256: baseline.baselineSha256,
        destinationProfile: { profileId: "profile", configurationRevision: 1 } };
    }
    return { sql, context, request, calls: () => ({ reads, writes }) };
  } catch (error) { sql.close(); throw error; }
}

// Corruption fixtures only: restore the exact reviewed trigger SQL before the
// inspector opens the closed file, so schema-fingerprint checks cannot mask a
// missing data-consistency check. This never weakens a successful-path fixture.
function corruptRows(sql, table, mutate) {
  const triggers = sql.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=? ORDER BY name").all(table);
  sql.exec("BEGIN");
  try {
    for (const trigger of triggers) sql.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    mutate();
    for (const trigger of triggers) sql.exec(trigger.sql);
    sql.exec("COMMIT");
  } catch (error) { sql.exec("ROLLBACK"); throw error; }
}

test("V15 inspection preserves populated source bytes, historical typed keys and privacy", async () => {
  const eventId = `historical\0${"x".repeat(260)}`;
  const f = await fixture({ eventId, rowid: 9223372036854775807n });
  const before = await readFile(f.databasePath);
  const { result, report, encoded } = await inspect(f);
  assert.equal(report.kind, "file-shadow-inspection");
  assert.equal(report.schemaVersion, 15);
  for (const flag of ["executable", "providerIO", "bytesVerified", "activationReady"]) assert.equal(report[flag], false);
  assert.deepEqual(report.authority, { mode: "legacy", revision: 1 });
  assert.equal(report.runtime.enabled, false);
  assert.deepEqual(report.headCounts, { all: 1, present: 1, absent: 0 });
  assert.deepEqual(report.counts, { total: 1, resolvedUsable: 0, admittedUnresolved: 0, pending: 1, readyToVerify: 0 });
  assert.deepEqual(report.records[0].key, key(eventId));
  assert.equal(report.records[0].sourceRowid, "9223372036854775807");
  assert.equal(report.records[0].state, "pending");
  assert.match(report.records[0].baselineSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(encoded, /PRIVATE_\w+_SENTINEL/);
  assert.deepEqual(await readFile(f.databasePath), before);
  assert.match(result.reportSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.reportSha256, createHash("sha256").update(encoded).digest("hex"));
  const repeat = await inspect(f, join(f.directory, "repeat.json"));
  assert.equal(repeat.encoded, encoded, "the same closed snapshot yields the same diagnostic bytes");
});

test("empty V15 inspection validates schema and never declares activation ready", async () => {
  const f = await fixture({ populate: false });
  const before = await readFile(f.databasePath), { report } = await inspect(f);
  assert.deepEqual(report.records, []);
  assert.equal(report.counts.total, 0);
  assert.equal(report.activationReady, false);
  assert.deepEqual(await readFile(f.databasePath), before);
  for (const mode of ["old", "drift"]) {
    const invalid = await fixture({ populate: false, through: mode === "old" ? "0007" : "0008" });
    if (mode === "drift") await change(invalid, (sql) => sql.exec("DROP TRIGGER file_shadow_heads_delete_guard"));
    await assert.rejects(api.inspectFileShadowSnapshot(invalid));
    await noReport(invalid.outputPath);
  }
});

test("V15 inspection fails closed on missing, stale and extra current heads", async () => {
  const cases = {
    missing: (sql) => corruptRows(sql, "file_shadow_heads", () => sql.exec("DELETE FROM file_shadow_heads")),
    stale: (sql) => corruptRows(sql, "file_shadow_heads", () => sql.exec("UPDATE file_shadow_heads SET source_json='{}'")),
    extra: (sql) => corruptRows(sql, "events", () => sql.exec("DELETE FROM events")),
  };
  for (const [label, corrupt] of Object.entries(cases)) {
    const f = await fixture();
    await change(f, corrupt);
    const before = await readFile(f.databasePath);
    await assert.rejects(api.inspectFileShadowSnapshot(f), /coverage mismatch/i, label);
    await noReport(f.outputPath);
    assert.deepEqual(await readFile(f.databasePath), before);
  }
});

test("resolved history becomes pending when its exact published location is quarantined", async () => {
  const f = await fixture(), runtime = await enableFixture(f);
  let result;
  try {
    result = await api.convertShadowConsumer(runtime.context, await runtime.request());
    assert.equal(result.status, "resolved");
    assert.equal(runtime.calls().writes, 1);
  } finally { runtime.sql.close(); }
  const good = await inspect(f);
  assert.equal(good.report.counts.resolvedUsable, 1);
  assert.equal(good.report.counts.pending, 0);
  assert.equal(good.report.records[0].state, "resolved");
  await change(f, (sql) => {
    const time = new Date().toISOString();
    sql.prepare(`INSERT INTO file_location_integrity_quarantine(location_id,reason,expected_byte_size,observed_byte_size,
      expected_sha256,observed_sha256,operation_id,detected_at,last_checked_at) VALUES(?,'missing',?,NULL,?,NULL,?,?,?)`)
      .run(result.locationId, sourceBytes.length, sourceSha256, randomUUID(), time, time);
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM file_usable_publications WHERE file_id=?").get(result.fileId).n, 0);
    assert.equal(sql.prepare("SELECT decision FROM file_shadow_decisions WHERE operation_id=?").get(result.operationId).decision, "resolved");
  });
  const bad = await inspect(f, join(f.directory, "quarantined.json"));
  assert.equal(bad.report.counts.resolvedUsable, 0);
  assert.equal(bad.report.counts.pending, 1);
  assert.equal(bad.report.records[0].recordedDecision, "resolved");
  assert.equal(bad.report.records[0].state, "pending");
  assert(bad.report.records[0].reasons.includes("published_location_unusable"));
  assert.equal(bad.report.reasonCounts.published_location_unusable, 1);
  assert.doesNotMatch(bad.encoded, /PRIVATE_\w+_SENTINEL/);
});

test("unfinished provider-write history remains counted after its source becomes a tombstone", async () => {
  const f = await fixture(), runtime = await enableFixture(f, { loseAcknowledgement: true });
  try {
    const result = await api.convertShadowConsumer(runtime.context, await runtime.request());
    assert.equal(result.status, "pending");
    assert.equal(result.attemptState, "unknown");
    assert.equal(runtime.calls().writes, 1);
    runtime.sql.prepare("DELETE FROM events WHERE id=?").run(f.eventId);
    assert.equal(runtime.sql.prepare("SELECT COUNT(*) AS n FROM file_shadow_heads WHERE present=1").get().n, 0);
  } finally { runtime.sql.close(); }
  const before = await readFile(f.databasePath), { report, encoded } = await inspect(f);
  assert.deepEqual(report.headCounts, { all: 1, present: 0, absent: 1 });
  assert.equal(report.counts.total, 0);
  assert.equal(report.unfinishedAttempts.total, 1);
  assert.equal(report.unfinishedAttempts.byState.unknown, 1);
  assert.equal(report.pendingOperations, 1);
  assert.equal(report.activationReady, false);
  assert.deepEqual(report.records, []);
  assert.doesNotMatch(encoded, /PRIVATE_\w+_SENTINEL/);
  assert.deepEqual(await readFile(f.databasePath), before);
});

test("explicit unresolved outcomes remain blockers without disclosing their free-text explanation", async () => {
  const f = await fixture(), runtime = await enableFixture(f);
  try {
    const request = await runtime.request();
    const result = await api.admitShadowUnresolved(runtime.context, { operationId: request.operationId, key: request.key,
      expectedBaselineSha256: request.expectedBaselineSha256, reason: "PRIVATE_REASON_SENTINEL" });
    assert.equal(result.status, "admitted_unresolved");
    assert.deepEqual(runtime.calls(), { reads: 0, writes: 0 });
  } finally { runtime.sql.close(); }
  const { report, encoded } = await inspect(f);
  assert.equal(report.counts.admittedUnresolved, 1);
  assert.equal(report.counts.resolvedUsable, 0);
  assert.equal(report.activationReady, false);
  assert.equal(report.records[0].state, "admitted_unresolved");
  assert.doesNotMatch(encoded, /PRIVATE_\w+_SENTINEL/);
});

test("inspection refuses SQLite sidecars and WAL snapshots without publishing a report", async () => {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const f = await fixture({ populate: false });
    await writeFile(f.databasePath + suffix, "closed input required");
    await assert.rejects(api.inspectFileShadowSnapshot(f), /sidecar|closed|WAL/i);
    await noReport(f.outputPath);
  }
  const wal = await fixture({ populate: false });
  await change(wal, (sql) => sql.exec("PRAGMA journal_mode=WAL"));
  await assert.rejects(api.inspectFileShadowSnapshot(wal), /WAL|closed/i);
  await noReport(wal.outputPath);
});

test("inspection cannot overwrite reports, input files, or sidecars through directory aliases", async () => {
  const f = await fixture({ populate: false });
  const before = await readFile(f.databasePath);
  await writeFile(f.outputPath, "existing report");
  await assert.rejects(api.inspectFileShadowSnapshot(f), /already exists/i);
  assert.equal(await readFile(f.outputPath, "utf8"), "existing report");
  const alias = join(f.directory, "alias");
  await symlink(f.directory, alias, "dir");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    await assert.rejects(api.inspectFileShadowSnapshot({ databasePath: f.databasePath, outputPath: join(alias, `snapshot.sqlite${suffix}`) }), /different paths|output|sidecar/i);
  }
  assert.deepEqual(await readFile(f.databasePath), before);
  assert.deepEqual((await readdir(f.directory)).sort(), ["alias", "report.json", "snapshot.sqlite"]);
});

test("inspection rejects a consumer graph beyond its declared bound rather than emitting partial counts", async () => {
  const f = await fixture();
  await change(f, (sql) => {
    sql.exec("BEGIN");
    try {
      const insert = sql.prepare(`INSERT INTO events(id,sample_id,kind,asset_key,metadata_json,created_at)
        VALUES(?,'sample','image',?,'{"action":"sample_record"}',?)`);
      for (let index = 0; index < api.MAX_FILE_SHADOW_INSPECTION_CONSUMERS; index += 1) insert.run(`bound-${index}`, sourceKey, f.now);
      sql.exec("COMMIT");
    } catch (error) { sql.exec("ROLLBACK"); throw error; }
  });
  await assert.rejects(api.inspectFileShadowSnapshot(f), /bound exceeded/i);
  await noReport(f.outputPath);
});
