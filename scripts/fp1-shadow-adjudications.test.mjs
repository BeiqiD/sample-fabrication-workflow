import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import { splitTestSql as splitSql } from "./lib/test-sql-split-cache.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const migration = "0010_fp1_shadow_adjudications.sql";
const priorMigrations = readdirSync(new URL("migrations/", root))
  .filter((name) => name.endsWith(".sql") && name < migration).sort();
const NOW = "2026-09-28T00:00:00.000Z";
const SHA = "d".repeat(64);
const plain = (value) => JSON.parse(JSON.stringify(value));
const statement = (sql, ...params) => ({ sql, params });

async function harness(engine) {
  if (engine === "SQLite") {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys=ON");
    const db = {
      async all(sql, ...params) { return plain(database.prepare(sql).all(...params)); },
      async batch(statements) {
        database.exec("BEGIN");
        try {
          for (const entry of statements) {
            if (typeof entry === "string") database.exec(entry);
            else database.prepare(entry.sql).run(...entry.params);
          }
          database.exec("COMMIT");
        } catch (error) { database.exec("ROLLBACK"); throw error; }
      },
      async close() { database.close(); },
    };
    return db;
  }
  const mf = new Miniflare({ modules: true, script: `export default { fetch() { return new Response("qualification"); } };`, compatibilityDate: "2026-07-20",
    d1Databases: ["DB"], r2Buckets: ["ASSETS"], log: new Log(LogLevel.ERROR) });
  const database = await mf.getD1Database("DB");
  return {
    async all(sql, ...params) { return (await database.prepare(sql).bind(...params).all()).results; },
    async batch(statements) {
      await database.batch(statements.map((entry) => typeof entry === "string"
        ? database.prepare(entry) : database.prepare(entry.sql).bind(...entry.params)));
    },
    async close() { await mf.dispose(); },
  };
}

async function apply(db, sql) { await db.batch(splitSql(sql)); }
async function seedThroughV16(db, populated = false) {
  assert.equal(priorMigrations.length, 9, "run every exact migration preceding 0010");
  for (const name of priorMigrations) {
    await apply(db, read(`migrations/${name}`));
    if (populated && name.startsWith("0007_")) {
      await apply(db, read("worker/fixtures/reference-graph.sql"));
      await apply(db, `
        INSERT INTO events (id,sample_id,kind,asset_key,metadata_json,created_at)
          VALUES ('adjudication-event','reference-sample-a','image','reference/private/comment.png','{}','${NOW}'),
            ('adjudication-peer','reference-sample-a','image','reference/private/comment.png','{}','${NOW}');
        INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at)
          VALUES('adjudication-asset','private/adjudication-object','shared.png','image/png',10,'ready','${SHA}','${NOW}');
        INSERT INTO projects(id,title,last_mutation_id,created_by,updated_by,created_at,updated_at)
          VALUES('adjudication-project','Historical attachments','project-create','native-qualification','native-qualification','${NOW}','${NOW}');
        INSERT INTO project_contents(id,project_id,content_type,last_mutation_id,created_by,updated_by,created_at,updated_at)
          VALUES('content-a','adjudication-project','attachment','content-create-a','native-qualification','native-qualification','${NOW}','${NOW}'),
            ('content-b','adjudication-project','attachment','content-create-b','native-qualification','native-qualification','${NOW}','${NOW}');
        INSERT INTO project_content_attachments(project_content_id,asset_id,original_name,mime_type,byte_size,created_by,created_at,creation_operation_id)
          VALUES('content-a','adjudication-asset','first.png','image/png',10,'native-qualification','${NOW}','attachment-create-a'),
            ('content-b','adjudication-asset','peer.png','image/png',10,'native-qualification','${NOW}','attachment-create-b');
        INSERT INTO storage_profiles
          (id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at)
          VALUES ('adjudication-r2','r2','adjudication-fixture-bucket','bootstrap',NULL,1,'historical','${NOW}'),
            ('other-r2','r2','other-fixture-bucket','bootstrap',NULL,1,'historical','${NOW}');
      `);
    }
  }
}

async function snapshot(db) {
  const schema = await db.all(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND name <> '_cf_METADATA' ORDER BY type,name`);
  const rows = {};
  await Promise.all(schema.filter(({ type }) => type === "table").map(async ({ name }) => {
    rows[name] = (await db.all(`SELECT * FROM "${name.replaceAll('"', '""')}"`))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }));
  return { schema, rows };
}

const digest = (value) => createHash("sha256").update(value).digest("hex");
const key = (consumerId = "content-a") => ({ consumerKind: "project_content_attachment", consumerId, consumerSubId: "", fileSlot: "primary" });
async function epoch(db) { return (await db.all("SELECT epoch FROM file_shadow_control WHERE singleton=1"))[0].epoch; }
async function head(db, consumerId = "content-a") {
  return (await db.all(`SELECT * FROM file_shadow_heads
    WHERE consumer_kind='project_content_attachment' AND consumer_id=? AND consumer_sub_id='' AND file_slot='primary'`, consumerId))[0];
}
async function overlap(db) {
  await db.batch([statement("INSERT INTO file_shadow_enablements VALUES (1,?,'native-qualification',?)", await epoch(db), NOW)]);
}
async function runtime(db, enabled) {
  await db.batch([enabled
    ? statement("UPDATE file_shadow_runtime_guard SET incarnation=?,enabled=1,enabled_by='native-qualification',updated_at=? WHERE singleton=1", randomUUID(), NOW)
    : statement("UPDATE file_shadow_runtime_guard SET enabled=0,updated_at=? WHERE singleton=1", NOW)]);
}
async function setup(engine, { pausedOverlap = true } = {}) {
  const db = await harness(engine);
  try {
    await seedThroughV16(db, true);
    await apply(db, read(`migrations/${migration}`));
    if (pausedOverlap) await overlap(db);
    return db;
  } catch (error) { await db.close(); throw error; }
}
async function adjudication(db, consumerId = "content-a", overrides = {}) {
  const source = await head(db, consumerId);
  const [guard] = await db.all("SELECT * FROM file_shadow_runtime_guard WHERE singleton=1");
  const input = {
    requestId: randomUUID(), key: key(consumerId), occurrenceId: source.occurrence_id, generation: source.generation,
    sourceSha256: digest(source.source_json), sourceLocator: { storeKind: "r2", provider: "r2", objectKey: "private/adjudication-object" },
    expectedBaselineSha256: SHA, expectedEpoch: await epoch(db), expectedIncarnation: guard.incarnation,
    sourceProfile: { profileId: "adjudication-r2", configurationRevision: 1 }, purpose: "research_source",
    purposeStatement: "This attachment is the original research source for the project.",
    namespaceStatement: "The operator confirmed the upload belonged to this exact registered bucket.",
    evidenceReference: "Local original and historic operator upload record, native qualification fixture.",
    supersedesId: null, ...overrides,
  };
  const baseline = { version: 1, kind: "file-shadow-baseline", bytesVerified: false, key: input.key,
    epoch: input.expectedEpoch, runtime: guard, head: { ...source, source_sha256: digest(source.source_json) },
    sourceLocator: input.sourceLocator, sourceProfile: null, purpose: null, baselineSha256: SHA,
    status: "ambiguous", reasons: ["consumer_purpose_unresolved", "namespace_evidence_missing"] };
  return { input, sourceJson: source.source_json, baselineJson: JSON.stringify(baseline) };
}
function acceptance(frozen, { input = frozen.input, sourceJson = frozen.sourceJson, baselineJson = frozen.baselineJson,
  requestJson = JSON.stringify(input), ...extra } = {}) {
  const row = { id: input.requestId, occurrence_id: input.occurrenceId, supersedes_id: input.supersedesId,
    request_json: requestJson, request_sha256: digest(requestJson), source_json: sourceJson, baseline_json: baselineJson,
    source_expected_byte_size: 10, source_expected_sha256: SHA, created_by: "native-qualification", created_at: NOW, ...extra };
  return statement(`INSERT INTO file_shadow_adjudications (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`, ...Object.values(row));
}
function withdrawal(frozen) {
  const requestJson = JSON.stringify(frozen.input);
  return statement(`INSERT INTO file_shadow_adjudication_withdrawals
    (request_id,request_json,request_sha256,created_by,created_at) VALUES (?,?,?,'native-qualification',?)`,
    frozen.input.requestId, requestJson, digest(requestJson), NOW);
}
function revocation(frozen, overrides = {}) {
  const input = { requestId: randomUUID(), adjudicationId: frozen.input.requestId,
    adjudicationRequestSha256: digest(JSON.stringify(frozen.input)), reason: "Operator corrected the current assessment.", ...overrides };
  const requestJson = JSON.stringify(input);
  return statement(`INSERT INTO file_shadow_adjudication_revocations
    (id,adjudication_id,request_json,request_sha256,created_by,created_at) VALUES (?,?,?,?,'native-qualification',?)`,
    input.requestId, input.adjudicationId, requestJson, digest(requestJson), NOW);
}
async function claim(db, { consumerId = "content-a", operationId = randomUUID(), sourceProfile = "adjudication-r2", purpose = "research_source" } = {}) {
  const source = await head(db, consumerId);
  return { operationId, occurrenceId: source.occurrence_id, statement: statement(`INSERT INTO file_shadow_operations
    (id,occurrence_id,captured_epoch,baseline_sha256,purpose,access_scope,source_store_kind,source_provider,source_object_key,
     source_profile_id,source_profile_revision,source_expected_byte_size,source_expected_sha256,destination_profile_id,
     destination_profile_revision,status,created_by,created_at)
    VALUES (?,?,?, ?,?,'system','r2','r2','private/adjudication-object',?,1,10,?,'adjudication-r2',1,'pending','native-qualification',?)`,
    operationId, source.occurrence_id, await epoch(db), SHA, purpose, sourceProfile, SHA, NOW) };
}
async function cancel(db, operationId) {
  await db.batch([
    statement("UPDATE file_shadow_attempts SET state='cancelled',completed_at=? WHERE operation_id=?", NOW, operationId),
    statement("UPDATE file_shadow_operations SET status='cancelled',completed_at=? WHERE id=?", NOW, operationId),
    statement("UPDATE file_shadow_legacy_holds SET released_at=? WHERE operation_id=?", NOW, operationId),
  ]);
}
function attempt(operationId, incarnation) {
  return statement(`INSERT INTO file_shadow_attempts
    (id,operation_id,attempt_number,owner_token,runtime_incarnation,state,lease_expires_at,created_at)
    VALUES (?,?,1,?,?,'staged','2099-01-01T00:00:00.000Z',?)`, randomUUID(), operationId, randomUUID(), incarnation, NOW);
}

for (const engine of ["SQLite", "D1"]) {
  test(`0010 ${engine}: empty and populated upgrades preserve history and roll back atomically`, { timeout: 90_000 }, async () => {
    for (const populated of [false, true]) {
      const db = await harness(engine);
      try {
        await seedThroughV16(db, populated);
        const before = await snapshot(db);
        const statements = splitSql(read(`migrations/${migration}`));
        assert(statements.every((sql) => Buffer.byteLength(sql) < 100_000));
        await assert.rejects(db.batch([...statements, "INSERT INTO file_shadow_control VALUES (1,0)"]));
        assert.deepEqual(await snapshot(db), before, "failed DDL leaves no partial sidecar or guard");
        await db.batch(statements);
        const after = await snapshot(db);
        for (const [table, rows] of Object.entries(before.rows)) assert.deepEqual(after.rows[table], rows, table);
        for (const table of ["file_shadow_adjudications", "file_shadow_adjudication_withdrawals", "file_shadow_adjudication_revocations", "file_shadow_operation_adjudications"]) {
          assert.deepEqual(after.rows[table], []);
          await assert.rejects(db.all(`SELECT rowid FROM ${table}`), /no such column.*rowid/i);
        }
        assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
        assert.deepEqual(await db.all("PRAGMA quick_check"), [{ quick_check: "ok" }]);
      } finally { await db.close(); }
    }
  });

  test(`0010 ${engine}: acceptance requires paused overlap and the exact current occurrence`, { timeout: 90_000 }, async () => {
    const db = await setup(engine, { pausedOverlap: false });
    try {
      await assert.rejects(db.batch([acceptance(await adjudication(db))]));
      await overlap(db);
      await runtime(db, true);
      await assert.rejects(db.batch([acceptance(await adjudication(db))]));
      await runtime(db, false);
      const valid = await adjudication(db);
      const before = await snapshot(db);
      for (const mutate of [
        (x) => ({ ...x, occurrenceId: "missing-occurrence" }),
        (x) => ({ ...x, generation: x.generation + 1 }),
        (x) => ({ ...x, expectedEpoch: x.expectedEpoch + 1 }),
        (x) => ({ ...x, expectedIncarnation: randomUUID() }),
        (x) => ({ ...x, key: key("content-b") }),
        (x) => ({ ...x, sourceLocator: { ...x.sourceLocator, objectKey: "other/object" } }),
        (x) => ({ ...x, sourceProfile: { profileId: "missing-profile", configurationRevision: 1 } }),
        (x) => ({ ...x, sourceProfile: { profileId: "adjudication-r2", configurationRevision: 2 } }),
        (x) => ({ ...x, purpose: "embedded_content" }),
        (x) => ({ ...x, key: { consumerKind: "event", consumerId: "adjudication-event", consumerSubId: "", fileSlot: "primary" } }),
        (x) => ({ ...x, namespaceStatement: "" }),
        (x) => ({ ...x, unexpected: "field" }),
      ]) await assert.rejects(db.batch([acceptance(valid, { input: mutate(valid.input) })]));
      await assert.rejects(db.batch([acceptance(valid, { sourceJson: "{}" })]));
      await assert.rejects(db.batch([acceptance(valid, { source_expected_byte_size: 11 })]));
      await assert.rejects(db.batch([acceptance(valid, { source_expected_sha256: "b".repeat(64) })]));
      assert.deepEqual(await snapshot(db), before, "every stale or malformed insert is atomic");
      await db.batch([acceptance(valid)]);
      const after = await snapshot(db);
      for (const [table, rows] of Object.entries(before.rows)) {
        if (!["file_shadow_adjudications", "file_shadow_control"].includes(table)) assert.deepEqual(after.rows[table], rows, table);
      }
      assert.equal(after.rows.file_shadow_adjudications.length, 1);
      assert.equal(after.rows.file_shadow_control[0].epoch, before.rows.file_shadow_control[0].epoch + 1,
        "acceptance invalidates frozen baselines without manufacturing an occurrence");
      assert.deepEqual(await db.all("SELECT id FROM file_shadow_active_adjudications"), [{ id: valid.input.requestId }]);
    } finally { await db.close(); }
  });

  test(`0010 ${engine}: withdrawal seals a delayed acceptance and every receipt is immutable`, { timeout: 90_000 }, async () => {
    const db = await setup(engine);
    try {
      const frozen = await adjudication(db);
      const delayed = acceptance(frozen);
      await db.batch([withdrawal(frozen)]);
      const sealed = await snapshot(db);
      const witness = await adjudication(db, "content-b");
      await assert.rejects(db.batch([withdrawal(witness), delayed]));
      assert.deepEqual(await snapshot(db), sealed, "the witness write rolls back with the losing delayed acceptance");
      const withdrawnInsert = withdrawal(frozen);
      const accepted = await adjudication(db);
      const acceptedInsert = acceptance(accepted);
      await db.batch([acceptedInsert]);
      await assert.rejects(db.batch([withdrawal(accepted)]));
      const revokedInsert = revocation(accepted);
      await db.batch([revokedInsert]);
      const changedIdRevocation = revocation(accepted);
      const beforeReplacement = await snapshot(db);
      await assert.rejects(db.batch([{ ...changedIdRevocation,
        sql: changedIdRevocation.sql.replace("INSERT INTO", "INSERT OR REPLACE INTO") }]));
      assert.deepEqual(await snapshot(db), beforeReplacement,
        "REPLACE through UNIQUE(adjudication_id) cannot rewrite a prior revocation under a fresh ID");
      for (const [table, primary, id, insert] of [
        ["file_shadow_adjudications", "id", accepted.input.requestId, acceptedInsert],
        ["file_shadow_adjudication_withdrawals", "request_id", frozen.input.requestId, withdrawnInsert],
        ["file_shadow_adjudication_revocations", "id", revokedInsert.params[0], revokedInsert],
      ]) {
        const before = await snapshot(db);
        for (const mutation of [
          statement(`UPDATE ${table} SET created_by='replacement' WHERE ${primary}=?`, id),
          statement(`DELETE FROM ${table} WHERE ${primary}=?`, id),
          { ...insert, sql: insert.sql.replace("INSERT INTO", "INSERT OR REPLACE INTO") },
          { ...insert, sql: insert.sql + ` ON CONFLICT(${primary}) DO UPDATE SET created_by='replacement'` },
          { ...insert, sql: insert.sql.replace("INSERT INTO", "INSERT OR IGNORE INTO") },
        ]) await assert.rejects(db.batch([mutation]), undefined, `${table} cannot rewrite durable history`);
        assert.deepEqual(await snapshot(db), before);
      }
      assert.deepEqual(await db.all("SELECT id FROM file_shadow_active_adjudications"), []);
      await assert.rejects(db.batch([withdrawal(accepted)]), undefined, "revocation never turns an accepted ID into a withdrawal");
    } finally { await db.close(); }
  });

  test(`0010 ${engine}: correction is append-only, single-successor and occurrence-local`, { timeout: 90_000 }, async () => {
    const db = await setup(engine);
    try {
      const first = await adjudication(db);
      await db.batch([acceptance(first)]);
      const premature = await adjudication(db, "content-a", { supersedesId: first.input.requestId });
      await assert.rejects(db.batch([acceptance(premature)]));
      await db.batch([revocation(first)]);
      await assert.rejects(db.batch([acceptance(await adjudication(db))]), undefined, "a correction must reference the revoked predecessor");
      await assert.rejects(db.batch([acceptance(await adjudication(db, "content-b", { supersedesId: first.input.requestId }))]), undefined,
        "a shared locator cannot transfer a correction to a peer occurrence");
      const correction = await adjudication(db, "content-a", { supersedesId: first.input.requestId, evidenceReference: "Corrected evidence record." });
      await db.batch([acceptance(correction)]);
      await assert.rejects(db.batch([acceptance(await adjudication(db, "content-a", { supersedesId: first.input.requestId }))]));
      await db.batch([revocation(correction)]);
      await assert.rejects(db.batch([acceptance(await adjudication(db, "content-a", { supersedesId: first.input.requestId }))]), undefined,
        "a revoked descendant does not permit branching from its predecessor");
      const final = await adjudication(db, "content-a", { supersedesId: correction.input.requestId });
      await db.batch([acceptance(final)]);
      assert.deepEqual(await db.all("SELECT id FROM file_shadow_active_adjudications"), [{ id: final.input.requestId }]);
      assert.equal((await db.all("SELECT id FROM file_shadow_adjudications")).length, 3);
      assert.equal((await db.all("SELECT id FROM file_shadow_adjudication_revocations")).length, 2);
    } finally { await db.close(); }
  });

  test(`0010 ${engine}: conversion auto-captures adjudication, peers stay unapproved, safe cancellation permits revocation`, { timeout: 90_000 }, async () => {
    const db = await setup(engine);
    try {
      const accepted = await adjudication(db);
      await db.batch([acceptance(accepted)]);
      assert.deepEqual(await db.all("SELECT * FROM file_shadow_namespace_evidence WHERE object_key='private/adjudication-object'"), [],
        "operator assessment never manufactures locator-wide upload evidence");
      const peer = await claim(db, { consumerId: "content-b" });
      await assert.rejects(db.batch([peer.statement]), undefined, "the peer shares bytes but has no purpose or namespace approval");
      const wrong = await claim(db, { sourceProfile: "other-r2" });
      await assert.rejects(db.batch([wrong.statement]));
      const current = await claim(db);
      await db.batch([current.statement]);
      assert.deepEqual(await db.all("SELECT * FROM file_shadow_operation_adjudications"), [{ operation_id: current.operationId,
        adjudication_id: accepted.input.requestId, adjudication_request_sha256: digest(JSON.stringify(accepted.input)) }]);
      const before = await snapshot(db);
      await assert.rejects(db.batch([revocation(accepted)]));
      assert.deepEqual(await snapshot(db), before, "a pending bound conversion fences revocation");
      for (const sql of [
        statement("DELETE FROM file_shadow_operation_adjudications WHERE operation_id=?", current.operationId),
        statement("UPDATE file_shadow_operation_adjudications SET adjudication_request_sha256=? WHERE operation_id=?", "b".repeat(64), current.operationId),
        statement("INSERT OR REPLACE INTO file_shadow_operation_adjudications VALUES (?,?,?)", current.operationId, accepted.input.requestId, digest(JSON.stringify(accepted.input))),
        statement("INSERT INTO file_shadow_operation_adjudications VALUES (?,?,?) ON CONFLICT(operation_id) DO UPDATE SET adjudication_request_sha256=excluded.adjudication_request_sha256", current.operationId, accepted.input.requestId, digest(JSON.stringify(accepted.input))),
      ]) await assert.rejects(db.batch([sql]));
      await cancel(db, current.operationId);
      await db.batch([revocation(accepted)]);
      const stale = await claim(db);
      await assert.rejects(db.batch([stale.statement]), undefined, "a delayed claim cannot use revoked evidence");
      assert.equal((await db.all("SELECT * FROM file_shadow_operation_adjudications")).length, 1,
        "revocation preserves the original conversion's evidence identity");
    } finally { await db.close(); }
  });

  test(`0010 ${engine}: a write-started conversion wins the revocation race and retains its source`, { timeout: 90_000 }, async () => {
    const db = await setup(engine);
    try {
      // Profile admission changes dependency generations, so qualify only after
      // it is final. Runtime enablement itself does not change the source head.
      await db.batch([statement("INSERT INTO file_shadow_profile_enablements VALUES ('adjudication-r2',1,'native-qualification',?)", NOW)]);
      const accepted = await adjudication(db);
      await db.batch([acceptance(accepted)]);
      await runtime(db, true);
      const [{ incarnation }] = await db.all("SELECT incarnation FROM file_shadow_runtime_guard");
      const current = await claim(db);
      const staged = attempt(current.operationId, incarnation);
      const fileId = randomUUID(), locationId = randomUUID(), objectKey = `converted/${randomUUID()}`;
      await db.batch([
        current.statement, staged,
        statement(`INSERT INTO file_shadow_legacy_holds
          (id,operation_id,store_kind,provider,object_key,storage_profile_id,profile_revision,acquired_at)
          VALUES (?,?,'r2','r2','private/adjudication-object','adjudication-r2',1,?)`, randomUUID(), current.operationId, NOW),
        statement(`INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at)
          VALUES (?,'research_source','system',10,?,'unresolved',?)`, fileId, SHA, NOW),
        statement(`INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at)
          VALUES (?,?,'adjudication-r2',?,'unresolved',?)`, locationId, fileId, objectKey, NOW),
        statement(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at)
          VALUES (?,?,'transition_destination',?,'native qualification pending conversion',?)`, randomUUID(), locationId, current.operationId, NOW),
        statement(`UPDATE file_shadow_attempts SET candidate_file_id=?,candidate_location_id=?,candidate_object_key=?,
          verified_byte_size=10,verified_sha256=?,source_verified_at=?,state='write_started',write_started_at=? WHERE id=?`,
          fileId, locationId, objectKey, SHA, NOW, NOW, staged.params[0]),
      ]);
      await runtime(db, false);
      const protectedState = await snapshot(db);
      await assert.rejects(db.batch([revocation(accepted)]), /paused settled work/);
      await assert.rejects(cancel(db, current.operationId), undefined, "a begun provider write cannot be labelled safely cancelled");
      assert.deepEqual(await snapshot(db), protectedState);
      assert.deepEqual(await db.all("SELECT id FROM file_shadow_active_adjudications"), [{ id: accepted.input.requestId }]);
      assert.equal((await db.all("SELECT * FROM file_shadow_operation_adjudications WHERE operation_id=?", current.operationId)).length, 1);
      assert.equal((await db.all("SELECT * FROM file_shadow_legacy_holds WHERE operation_id=? AND released_at IS NULL", current.operationId)).length, 1);
      assert.equal((await db.all("SELECT * FROM file_shadow_legacy_retention_edges WHERE source_id=? AND retention_reason='shadow_source_hold'", current.operationId)).length, 1);
      assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
    } finally { await db.close(); }
  });


  test(`0010 ${engine}: restored source, parent and registry values cannot revive a frozen baseline`, { timeout: 90_000 }, async (t) => {
    const mutations = [
      ["attachment owner caption ABA", [
        "UPDATE project_contents SET attachment_caption='Changed',revision=revision+1,last_mutation_id='caption-change' WHERE id='content-a'",
        "UPDATE project_contents SET attachment_caption=NULL,revision=revision+1,last_mutation_id='caption-restore' WHERE id='content-a'",
      ]],
      ["source locator ABA", [
        "UPDATE assets SET r2_key='private/temporary-object' WHERE id='adjudication-asset'",
        "UPDATE assets SET r2_key='private/adjudication-object' WHERE id='adjudication-asset'",
      ]],
      ["parent project ABA", [
        "UPDATE projects SET title='Changed',revision=revision+1,last_mutation_id='title-change' WHERE id='adjudication-project'",
        "UPDATE projects SET title='Historical attachments',revision=revision+1,last_mutation_id='title-restore' WHERE id='adjudication-project'",
      ]],
      ["asset checksum ABA", [
        statement("UPDATE assets SET sha256=? WHERE id='adjudication-asset'", "f".repeat(64)),
        statement("UPDATE assets SET sha256=? WHERE id='adjudication-asset'", SHA),
      ]],
      ["profile runtime admission", [statement("INSERT INTO file_shadow_profile_enablements VALUES ('adjudication-r2',1,'native-qualification',?)", NOW)]],
    ];
    for (const [label, statements] of mutations) await t.test(label, async () => {
      const db = await setup(engine);
      try {
        const frozen = await adjudication(db);
        await db.batch(statements);
        assert((await epoch(db)) > frozen.input.expectedEpoch);
        assert.notEqual((await head(db)).occurrence_id, frozen.input.occurrenceId);
        const before = await snapshot(db);
        await assert.rejects(db.batch([acceptance(frozen)]), /exact paused primary baseline/);
        assert.deepEqual(await snapshot(db), before, "restored visible values do not erase generation history");
        const fresh = await adjudication(db);
        await db.batch([acceptance(fresh)]);
        assert.deepEqual(await db.all("SELECT id FROM file_shadow_active_adjudications"), [{ id: fresh.input.requestId }],
          "a fresh review still works after the historical change");
      } finally { await db.close(); }
    });
  });

  test(`0010 ${engine}: lifecycle and import evidence cannot be overwritten by an operator statement`, { timeout: 90_000 }, async (t) => {
    const exclusions = [
      ["legacy GC ledger", [statement(`INSERT INTO blob_gc_ledger
        (store_kind,provider,object_key,state,orphaned_at,updated_at)
        VALUES ('r2','r2','private/adjudication-object','orphaned',?,?)`, NOW, NOW)]],
      ["integrity quarantine", [statement(`INSERT INTO blob_integrity_quarantine
        (store_kind,provider,object_key,blob_record_id,reason,expected_byte_size,observed_byte_size,operation_id,detected_at,last_checked_at)
        VALUES ('r2','r2','private/adjudication-object','adjudication-asset','size_mismatch',10,11,'native-quarantine',?,?)`, NOW, NOW)]],
      ["accepted import candidate", [statement(`INSERT INTO imports
        (id,status,source_filename,source_sha256,sheet_name,template_type,workbook_asset_key,actor_email,created_at,operation_id,
         client_request_id,request_sha256,request_input_json,request_scope,storage_profile_id,storage_profile_revision,storage_policy_revision)
        VALUES ('adjudication-import','pending','source.xlsx',?,'Sheet1','process','private/adjudication-object','native-qualification',?,'native-import',
          ?,?,'{}','system','adjudication-r2',1,1)`, SHA, NOW, randomUUID(), SHA)]],
    ];
    for (const [label, statements] of exclusions) await t.test(label, async () => {
      const db = await setup(engine);
      try {
        await db.batch(statements);
        const fresh = await adjudication(db);
        const before = await snapshot(db);
        await assert.rejects(db.batch([acceptance(fresh)]), /cannot override existing evidence/);
        assert.deepEqual(await snapshot(db), before, "rejection preserves all original lifecycle evidence");
      } finally { await db.close(); }
    });
  });

}
