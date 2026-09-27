import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import { splitTestSql as splitSql } from "./lib/test-sql-split-cache.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const migration = "0009_fp1_shadow_withdrawals.sql";
const priorMigrations = readdirSync(new URL("migrations/", root))
  .filter((name) => name.endsWith(".sql") && name < migration).sort();
const NOW = "2026-09-28T00:00:00.000Z";
const INCARNATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SHA = "a".repeat(64);
const plain = (value) => JSON.parse(JSON.stringify(value));
const statement = (sql, ...params) => ({ sql, params });

// The provider sentinel represents the old Worker's post-claim readback barrier.
// It deliberately knows nothing about withdrawals: only the database trigger can
// reject its already-prepared claim after a newer Worker seals the request ID.
const oldClaimWorker = `export default { async fetch(request, env) {
  const input = await request.json();
  let error = null;
  try { await env.DB.batch(input.statements.map(({sql,params}) => env.DB.prepare(sql).bind(...params))); }
  catch (caught) { error = caught.message; }
  const claim = await env.DB.prepare('SELECT id FROM file_shadow_operations WHERE id=?').bind(input.operationId).first();
  let providerCalls = 0;
  if (claim) { providerCalls += 1; await env.ASSETS.put('claim-sentinel/' + input.operationId, 'claimed'); }
  return Response.json({ error, claimed: !!claim, providerCalls });
} };`;

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
  const mf = new Miniflare({ modules: true, script: oldClaimWorker, compatibilityDate: "2026-07-20",
    d1Databases: ["DB"], r2Buckets: ["ASSETS"], log: new Log(LogLevel.ERROR) });
  const database = await mf.getD1Database("DB");
  return {
    async all(sql, ...params) { return (await database.prepare(sql).bind(...params).all()).results; },
    async batch(statements) {
      await database.batch(statements.map((entry) => typeof entry === "string"
        ? database.prepare(entry) : database.prepare(entry.sql).bind(...entry.params)));
    },
    async oldClaim(operationId, statements) {
      const response = await mf.dispatchFetch("https://qualification.invalid/", {
        method: "POST", body: JSON.stringify({ operationId, statements }),
        headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200);
      return response.json();
    },
    async providerHasClaim(operationId) {
      return (await (await mf.getR2Bucket("ASSETS")).get(`claim-sentinel/${operationId}`)) !== null;
    },
    async close() { await mf.dispose(); },
  };
}

async function apply(db, sql) { await db.batch(splitSql(sql)); }
async function seedThroughV15(db, populated = false) {
  assert.equal(priorMigrations.length, 8, "run every exact migration preceding 0009");
  for (const name of priorMigrations) {
    await apply(db, read(`migrations/${name}`));
    if (populated && name.startsWith("0007_")) {
      await apply(db, read("worker/fixtures/reference-graph.sql"));
      await apply(db, `
        INSERT INTO events (id,sample_id,kind,asset_key,metadata_json,created_at)
          VALUES ('withdrawal-event','reference-sample-a','image','reference/private/comment.png','{}','${NOW}');
        INSERT INTO storage_profiles
          (id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at)
          VALUES ('withdrawal-r2','r2','withdrawal-fixture-bucket','bootstrap',NULL,1,'historical','${NOW}');
        INSERT INTO files (id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at)
          VALUES ('withdrawal-file','embedded_content','system',10,'${SHA}','unresolved','${NOW}');
        INSERT INTO file_locations (id,file_id,storage_profile_id,object_key,state,created_at)
          VALUES ('withdrawal-location','withdrawal-file','withdrawal-r2','reference/private/comment.png','unresolved','${NOW}');
        INSERT INTO legacy_file_mappings
          (store_kind,provider,object_key,file_id,location_id,classification,evidence_json,observed_at)
          VALUES ('r2','r2','reference/private/comment.png','withdrawal-file','withdrawal-location','classified','{}','${NOW}');
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

function request(operationId = randomUUID()) {
  return { operationId,
    key: { consumerKind: "event", consumerId: "withdrawal-event", consumerSubId: "", fileSlot: "primary" },
    expectedBaselineSha256: SHA, destinationProfile: { profileId: "withdrawal-r2", configurationRevision: 1 },
    runtimeIncarnation: INCARNATION };
}

function withdrawal(input = request(), { json = JSON.stringify(input), ...overrides } = {}) {
  const row = { operation_id: input.operationId, request_json: json,
    request_sha256: createHash("sha256").update(json).digest("hex"), created_by: "native-qualification", created_at: NOW,
    ...overrides };
  return statement(`INSERT INTO file_shadow_withdrawals
    (operation_id,request_json,request_sha256,created_by,created_at) VALUES (?,?,?,?,?)`, ...Object.values(row));
}

async function enable(db) {
  const [{ epoch }] = await db.all("SELECT epoch FROM file_shadow_control WHERE singleton=1");
  await db.batch([
    statement("INSERT INTO file_shadow_enablements VALUES (1,?,'native-qualification',?)", epoch, NOW),
    statement(`UPDATE file_shadow_runtime_guard SET incarnation=?,enabled=1,enabled_by='native-qualification',updated_at=?
      WHERE singleton=1`, INCARNATION, NOW),
  ]);
}

async function frozenClaim(db, operationId) {
  const [head] = await db.all(`SELECT occurrence_id FROM file_shadow_heads
    WHERE consumer_kind='event' AND consumer_id='withdrawal-event' AND consumer_sub_id='' AND file_slot='primary'`);
  const [{ epoch }] = await db.all("SELECT epoch FROM file_shadow_control WHERE singleton=1");
  return [
    statement(`INSERT INTO file_shadow_operations
      (id,occurrence_id,captured_epoch,baseline_sha256,purpose,access_scope,source_store_kind,source_provider,source_object_key,
       source_profile_id,source_profile_revision,source_expected_byte_size,source_expected_sha256,
       destination_profile_id,destination_profile_revision,status,created_by,created_at)
      SELECT ?,?,?,?,'embedded_content','system','r2','r2','reference/private/comment.png','withdrawal-r2',1,10,?,
        'withdrawal-r2',1,'pending','native-qualification',?
      WHERE (SELECT epoch FROM file_shadow_control WHERE singleton=1)=?
        AND EXISTS(SELECT 1 FROM file_shadow_heads WHERE occurrence_id=? AND present=1)
        AND EXISTS(SELECT 1 FROM file_shadow_runtime_guard WHERE singleton=1 AND enabled=1 AND incarnation=?)`,
      operationId, head.occurrence_id, epoch, SHA, SHA, NOW, epoch, head.occurrence_id, INCARNATION),
    statement(`INSERT INTO file_shadow_attempts
      (id,operation_id,attempt_number,owner_token,runtime_incarnation,state,lease_expires_at,created_at)
      VALUES (?,?,1,?,?,'staged','2099-01-01T00:00:00.000Z',?)`, randomUUID(), operationId, randomUUID(), INCARNATION, NOW),
    statement(`INSERT INTO file_shadow_legacy_holds
      (id,operation_id,store_kind,provider,object_key,storage_profile_id,profile_revision,acquired_at)
      VALUES (?,?,'r2','r2','reference/private/comment.png','withdrawal-r2',1,?)`, randomUUID(), operationId, NOW),
  ];
}

for (const engine of ["SQLite", "D1"]) {
  test(`0009 ${engine}: empty upgrade, independent withdrawals and immutable request identity`, { timeout: 90_000 }, async (t) => {
    const db = await harness(engine);
    try {
      await seedThroughV15(db);
      const before = await snapshot(db);
      await apply(db, read(`migrations/${migration}`));
      const after = await snapshot(db);
      for (const [table, rows] of Object.entries(before.rows)) assert.deepEqual(after.rows[table], rows, table);
      assert.deepEqual(after.rows.file_shadow_withdrawals, []);
      assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
      assert.deepEqual(await db.all("PRAGMA quick_check"), [{ quick_check: "ok" }]);
      await assert.rejects(db.all("SELECT rowid FROM file_shadow_withdrawals"), /no such column.*rowid/i);

      await t.test("withdrawals preserve empty/NUL historical keys without consumers, profiles or enablement", async () => {
        const input = request();
        input.key = { consumerKind: "", consumerId: "historical\0id", consumerSubId: "", fileSlot: "旧引用\0" };
        await db.batch([withdrawal(input)]);
        const [saved] = await db.all("SELECT * FROM file_shadow_withdrawals WHERE operation_id=?", input.operationId);
        assert.deepEqual(JSON.parse(saved.request_json), input);
        assert.deepEqual(await db.all("SELECT id FROM storage_profiles"), []);
        assert.deepEqual(await db.all("SELECT * FROM file_shadow_heads"), []);
        assert.deepEqual(await db.all("SELECT mode FROM file_authority_control"), [{ mode: "legacy" }]);
        assert.deepEqual(await db.all("SELECT enabled,incarnation FROM file_shadow_runtime_guard"), [{ enabled: 0, incarnation: null }]);
        assert.deepEqual(await db.all("SELECT * FROM file_shadow_control"), before.rows.file_shadow_control,
          "sealing an ID grants no conversion authority and does not invalidate other baselines");
      });

      await t.test("malformed shapes and identities reject atomically", async () => {
        const malformed = [
          (x) => ({ ...x, extra: true }), (x) => ({ ...x, key: null }),
          (x) => ({ ...x, key: { ...x.key, fileSlot: 1 } }),
          (x) => ({ ...x, key: { ...x.key, extra: "" } }),
          (x) => ({ ...x, expectedBaselineSha256: "A".repeat(64) }),
          (x) => ({ ...x, destinationProfile: { ...x.destinationProfile, configurationRevision: 2 } }),
          (x) => ({ ...x, destinationProfile: { configurationRevision: 1 } }),
          (x) => ({ ...x, destinationProfile: { ...x.destinationProfile, profileId: "bad\0profile" } }),
          (x) => ({ ...x, runtimeIncarnation: "not-a-runtime-id" }),
          (x) => ({ ...x, key: { ...x.key, consumerId: "x".repeat(65536) } }),
        ];
        const initial = await db.all("SELECT * FROM file_shadow_withdrawals ORDER BY operation_id");
        for (const mutate of malformed) {
          const input = request();
          await assert.rejects(db.batch([withdrawal(input, { json: JSON.stringify(mutate(input)) })]));
        }
        for (const overrides of [
          { operation_id: "invalid" }, { request_sha256: "a".repeat(63) },
          { created_by: "" }, { created_at: "not-a-date" },
        ]) await assert.rejects(db.batch([withdrawal(request(), overrides)]));
        const duplicate = request();
        await assert.rejects(db.batch([withdrawal(duplicate, {
          json: JSON.stringify(duplicate).replace('"fileSlot":"primary"', '"consumerId":"other"'),
        })]), /Invalid shadow withdrawal request/);
        assert.deepEqual(await db.all("SELECT * FROM file_shadow_withdrawals ORDER BY operation_id"), initial);
      });

      await t.test("UPDATE, DELETE, REPLACE and UPSERT never alter the sealed outcome", async () => {
        const input = request();
        const insert = withdrawal(input);
        await db.batch([insert]);
        const beforeMutation = await db.all("SELECT * FROM file_shadow_withdrawals ORDER BY operation_id");
        for (const sql of [
          statement("UPDATE file_shadow_withdrawals SET operation_id=? WHERE operation_id=?", randomUUID(), input.operationId),
          statement("UPDATE file_shadow_withdrawals SET request_sha256=? WHERE operation_id=?", "b".repeat(64), input.operationId),
          statement("DELETE FROM file_shadow_withdrawals WHERE operation_id=?", input.operationId),
          { ...insert, sql: insert.sql.replace("INSERT INTO", "INSERT OR REPLACE INTO") },
          { ...insert, sql: insert.sql + " ON CONFLICT(operation_id) DO UPDATE SET created_by='replacement'" },
          { ...insert, sql: insert.sql.replace("INSERT INTO", "INSERT OR IGNORE INTO") },
        ]) await assert.rejects(db.batch([sql]), /immutable|already has an outcome/);
        assert.deepEqual(await db.all("SELECT * FROM file_shadow_withdrawals ORDER BY operation_id"), beforeMutation);
      });
    } finally { await db.close(); }
  });

  test(`0009 ${engine}: populated atomic upgrade and late old-Worker claim fencing`, { timeout: 90_000 }, async (t) => {
    const db = await harness(engine);
    try {
      await seedThroughV15(db, true);
      await enable(db);
      const preexisting = request();
      await db.batch(await frozenClaim(db, preexisting.operationId));
      const before = await snapshot(db);
      const migrationStatements = splitSql(read(`migrations/${migration}`));
      assert(migrationStatements.every((sql) => Buffer.byteLength(sql) < 100_000));
      await assert.rejects(db.batch([...migrationStatements, "INSERT INTO file_shadow_control VALUES (1,0)"]));
      assert.deepEqual(await snapshot(db), before, "failed DDL rolls back every schema object and populated row");
      await db.batch(migrationStatements);
      const after = await snapshot(db);
      for (const [table, rows] of Object.entries(before.rows)) assert.deepEqual(after.rows[table], rows, table);
      assert.deepEqual(after.schema.filter(({ name }) => before.schema.some((old) => old.name === name)), before.schema,
        "0009 never rewrites the frozen 0001–0008 schema");

      await t.test("an accepted operation retains its receipt, attempt and holds when withdrawal loses", async () => {
        const acceptedState = await snapshot(db);
        await assert.rejects(db.batch([withdrawal(preexisting)]), /already has an outcome/);
        await assert.rejects(db.batch([{ ...withdrawal(preexisting), sql: withdrawal(preexisting).sql.replace("INSERT INTO", "INSERT OR REPLACE INTO") }]),
          /already has an outcome/);
        assert.deepEqual(await snapshot(db), acceptedState);
        await db.batch([
          statement("UPDATE file_shadow_attempts SET state='cancelled',completed_at=? WHERE operation_id=?", NOW, preexisting.operationId),
          statement("UPDATE file_shadow_operations SET status='cancelled',completed_at=? WHERE id=?", NOW, preexisting.operationId),
          statement("UPDATE file_shadow_legacy_holds SET released_at=? WHERE operation_id=?", NOW, preexisting.operationId),
        ]);
        const terminalState = await snapshot(db);
        await assert.rejects(db.batch([withdrawal(preexisting)]), /already has an outcome/,
          "even a safely cancelled accepted operation can never acquire a no-claim receipt");
        assert.deepEqual(await snapshot(db), terminalState);
      });

      await t.test("a previously absent ID cannot be claimed after withdrawal, with whole-batch rollback", async () => {
        const input = request();
        assert.deepEqual(await db.all("SELECT id FROM file_shadow_operations WHERE id=?", input.operationId), []);
        const staleStatements = await frozenClaim(db, input.operationId);
        const [{ epoch }] = await db.all("SELECT epoch FROM file_shadow_control");
        await db.batch([withdrawal(input)]);
        assert.deepEqual(await db.all("SELECT epoch FROM file_shadow_control"), [{ epoch }],
          "the losing claim is still otherwise current; it is fenced by the withdrawal itself");
        const sealedState = await snapshot(db);
        const rollbackWitness = request();
        await assert.rejects(db.batch([withdrawal(rollbackWitness), ...staleStatements]), /withdrawn before acceptance/);
        assert.deepEqual(await snapshot(db), sealedState,
          "the earlier witness write rolls back, and no operation, attempt, hold or File candidate survives");
        await assert.rejects(db.batch(staleStatements.map((entry, index) => index ? entry
          : { ...entry, sql: entry.sql.replace("INSERT INTO", "INSERT OR REPLACE INTO") })), /withdrawn before acceptance/);
        if (db.oldClaim) {
          const result = await db.oldClaim(input.operationId, staleStatements);
          assert.match(result.error, /withdrawn before acceptance/);
          assert.equal(result.claimed, false);
          assert.equal(result.providerCalls, 0);
          assert.equal(await db.providerHasClaim(input.operationId), false);
          assert.deepEqual(await snapshot(db), sealedState);
        }
        // Positive control: exactly the same frozen source/runtime/namespace can
        // still create a fresh unrelated claim, so the stale case is not passing
        // merely because an unrelated 0008 guard happens to reject all claims.
        const other = request();
        const valid = await frozenClaim(db, other.operationId);
        if (db.oldClaim) {
          const result = await db.oldClaim(other.operationId, valid);
          assert.deepEqual(result, { error: null, claimed: true, providerCalls: 1 });
          assert.equal(await db.providerHasClaim(other.operationId), true);
        } else await db.batch(valid);
        assert.equal((await db.all("SELECT * FROM file_shadow_attempts WHERE operation_id=?", other.operationId)).length, 1);
        assert.equal((await db.all("SELECT * FROM file_shadow_legacy_holds WHERE operation_id=?", other.operationId)).length, 1);
        await assert.rejects(db.batch([statement("UPDATE file_shadow_operations SET id=? WHERE id=?", input.operationId, other.operationId)]),
          /immutable/);
        await assert.rejects(db.batch([withdrawal(other)]), /already has an outcome/);
      });
      assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
      assert.deepEqual(await db.all("PRAGMA quick_check"), [{ quick_check: "ok" }]);
    } finally { await db.close(); }
  });
}
