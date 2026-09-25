import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const NOW = "2026-09-14T00:00:00.000Z";
const EVENT_BYTES = "0123456789";
const EVENT_SHA256 = createHash("sha256").update(EVENT_BYTES).digest("hex");
const R2_NAMESPACE = JSON.stringify({ kind: "local-r2", installationId: "11111111-1111-4111-8111-111111111111", bucketName: "shadow-native" });
const hash = (character) => character.repeat(64);
const migrationNames = readdirSync(new URL("migrations/", root))
  .filter((name) => name.endsWith(".sql") && name <= "0007_fp1_file_authority_transition.sql").sort();
const slots = [
  ["state_representation_asset", "primary"], ["run_step_asset", "primary"],
  ["metrology_template_reference", "primary"], ["run_step_comment", "primary"],
  ["state_verification", "evidence"], ["comment_submission_item", "primary"],
  ["project_content_attachment", "primary"], ["attachment_derivative", "derived"],
  ["event", "primary"], ["event", "thumbnail"], ["import", "workbook"],
  ["import", "manifest"], ["template_version", "source"],
].map(([kind, slot]) => `${kind}/${slot}`).sort();

async function apply(db, source) {
  await db.batch(splitSql(source).map((statement) => db.prepare(statement)));
}

async function seedLegacy(db, { populate = true } = {}) {
  assert.equal(migrationNames.length, 7, "qualification applies the exact reviewed 0001–0007 generation");
  for (const name of migrationNames) {
    await apply(db, read(`migrations/${name}`));
  }
  if (populate) await seedLegacyFixture(db);
}

async function seedLegacyFixture(db) {
  await apply(db, read("worker/fixtures/reference-graph.sql"));
  // All rows are inserted through the unchanged current schema. No guard is
  // disabled to manufacture legacy content or a File-authoritative consumer.
  await apply(db, `
    INSERT INTO state_representations (hash, content_json, created_at)
      VALUES ('baseline:state', '{}', '${NOW}');
    INSERT INTO state_representation_assets (state_hash, asset_id, position)
      VALUES ('baseline:state', 'reference-comment-asset', 0);
    INSERT INTO run_step_comments (id, run_step_id, scope, legacy_body, asset_id, created_at)
      VALUES ('baseline:legacy-comment', 'reference-step-a', 'individual', 'PRIVATE_LEGACY_BODY',
        'reference-comment-asset', '${NOW}');
    INSERT INTO state_verifications (id, sample_id, after_run_step_id, result, evidence_asset_id, status, created_at)
      VALUES ('baseline:verification', 'reference-sample-a', 'reference-step-a', 'matched',
        'reference-comment-asset', 'valid', '${NOW}');
    INSERT INTO managed_storage_objects
      (id, provider, object_key, original_name, mime_type, byte_size, sha256, status, created_at)
      VALUES ('baseline-managed', 'switchdrive', 'baseline/managed', 'source.bin', 'application/octet-stream',
        10, '${hash("d")}', 'ready', '${NOW}');
    INSERT INTO projects (id, title, last_mutation_id, created_by, updated_by, created_at, updated_at)
      VALUES ('baseline-project', 'Baseline project', 'create', 'fixture', 'fixture', '${NOW}', '${NOW}');
    INSERT INTO project_contents (id, project_id, content_type, last_mutation_id, created_by, updated_by, created_at, updated_at)
      VALUES ('baseline-attachment', 'baseline-project', 'attachment', 'create', 'fixture', 'fixture', '${NOW}', '${NOW}');
    INSERT INTO project_content_attachments
      (project_content_id, storage_object_id, original_name, mime_type, byte_size, created_by, created_at, creation_operation_id)
      VALUES ('baseline-attachment', 'baseline-managed', 'source.bin', 'application/octet-stream',
        10, 'fixture', '${NOW}', 'attach');
    INSERT INTO attachment_derivatives (id, source_sha256, source_byte_size, derivative_kind, generator_version,
      derived_asset_id, status, retain_until, created_at, updated_at)
      VALUES ('baseline:derivative', '${hash("e")}', 100, 'browser_preview', 'fixture-v1',
        'reference-comment-asset', 'ready', '2099-01-01T00:00:00.000Z', '${NOW}', '${NOW}');
    INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
      VALUES ('baseline-event-asset', 'baseline/event-original', 'event.png', 'image/png', 10,
        'ready', '${EVENT_SHA256}', '2000-01-01T00:00:00.000Z');
    INSERT INTO events (id, sample_id, kind, asset_key, metadata_json, created_at)
      VALUES ('baseline:event', 'reference-sample-a', 'image', 'baseline/event-original',
        '{"thumbnailKey":"baseline/direct-thumbnail","private":"PRIVATE_EVENT_BODY"}', '${NOW}');
    INSERT INTO imports
      (id, status, source_filename, source_sha256, sheet_name, template_type, workbook_asset_key, manifest_asset_key, created_at)
      VALUES ('baseline:import', 'ready', 'baseline.xlsx', '${hash("a")}', 'Sheet1', 'process',
        'baseline/direct-workbook', 'baseline/direct-manifest', '${NOW}');
    UPDATE template_versions SET source_asset_key = 'baseline/direct-template' WHERE id = 'reference-process-template';
    INSERT INTO storage_profiles
      (id, adapter_type, namespace_identity, configuration_source, credential_reference, configuration_revision, state, created_at)
      VALUES ('baseline-r2', 'r2', '${R2_NAMESPACE}', 'bootstrap', NULL, 1, 'historical', '${NOW}'),
        ('baseline-switch', 'switchdrive', 'switchdrive:fixture:root', 'environment', 'environment:SWITCHDRIVE', 1, 'historical', '${NOW}');
    INSERT INTO files
      (id, purpose, access_scope, expected_byte_size, expected_sha256, verified_sha256, state, active_location_id, created_at)
      VALUES ('baseline-event-file', 'embedded_content', 'system', 10, '${EVENT_SHA256}', NULL, 'unresolved', NULL, '${NOW}');
    INSERT INTO file_locations (id, file_id, storage_profile_id, object_key, state, created_at)
      VALUES ('baseline-event-location', 'baseline-event-file', 'baseline-r2', 'baseline/event-original', 'unresolved', '${NOW}');
    INSERT INTO legacy_file_mappings
      (store_kind, provider, object_key, file_id, location_id, classification, evidence_json, observed_at)
      VALUES ('r2', 'r2', 'baseline/event-original', 'baseline-event-file', 'baseline-event-location', 'classified', '{}', '${NOW}');
  `);
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  assert.deepEqual((await db.prepare("PRAGMA quick_check").all()).results, [{ quick_check: "ok" }]);
}

async function snapshot(db) {
  const schema = (await db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND name <> '_cf_METADATA' ORDER BY type, name`).all()).results;
  const rows = {};
  for (const { name } of schema.filter((entry) => entry.type === "table")) {
    rows[name] = (await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()).results
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return { schema, rows };
}

const shadowMigration = "0008_fp1_shadow_runtime.sql";
const key = (kind, id, slot = "primary", sub = "") => [kind, id, sub, slot];
async function currentHead(db, identity) {
  return db.prepare(`SELECT * FROM file_shadow_heads
    WHERE consumer_kind = ? AND consumer_id = ? AND consumer_sub_id = ? AND file_slot = ?`)
    .bind(...identity).first();
}
async function epoch(db) {
  return (await db.prepare("SELECT epoch FROM file_shadow_control WHERE singleton = 1").first()).epoch;
}
async function enable(db) {
  await db.prepare(`INSERT INTO file_shadow_enablements
    (singleton, expected_epoch, enabled_by, enabled_at) VALUES (1, ?, 'native-qualification', ?)`)
    .bind(await epoch(db), NOW).run();
}
async function operationStatement(db, id, identity = key("event", "baseline:event"), profile = "baseline-r2") {
  const head = await currentHead(db, identity);
  const occurrence = await db.prepare("SELECT * FROM file_shadow_occurrences WHERE id = ?").bind(head.occurrence_id).first();
  return db.prepare(`INSERT INTO file_shadow_operations
    (id, occurrence_id, captured_epoch, baseline_sha256, purpose, access_scope,
     source_store_kind, source_provider, source_object_key, source_profile_id, source_profile_revision,
     source_expected_byte_size, source_expected_sha256, destination_profile_id, destination_profile_revision,
     status, created_by, created_at, completed_at)
    VALUES (?, ?, ?, ?, 'embedded_content', 'system', ?, ?, ?, ?, 1, 10, ?, 'baseline-r2', 1, 'pending', 'fixture', ?, NULL)`)
    .bind(id, head.occurrence_id, await epoch(db), hash("a"), occurrence.legacy_store_kind, occurrence.legacy_provider,
      occurrence.legacy_object_key, profile, EVENT_SHA256, NOW);
}
function holdStatement(db, id, operationId, profile = "baseline-r2") {
  return db.prepare(`INSERT INTO file_shadow_legacy_holds
    (id, operation_id, store_kind, provider, object_key, storage_profile_id, profile_revision, acquired_at, released_at)
    VALUES (?, ?, 'r2', 'r2', 'baseline/event-original', ?, 1, ?, NULL)`)
    .bind(id, operationId, profile, NOW);
}
async function assertHistory(db, identity) {
  const head = await currentHead(db, identity);
  assert(head, `missing current/tombstone head ${JSON.stringify(identity)}`);
  const occurrences = (await db.prepare(`SELECT * FROM file_shadow_occurrences
    WHERE consumer_kind = ? AND consumer_id = ? AND consumer_sub_id = ? AND file_slot = ? ORDER BY generation`)
    .bind(...identity).all()).results;
  assert.equal(occurrences.length, head.generation, "generation numbers have no holes or reset");
  assert.deepEqual(occurrences.map((entry) => entry.generation), Array.from({ length: head.generation }, (_, i) => i + 1));
  assert.equal(occurrences.at(-1).id, head.occurrence_id);
  assert.equal(occurrences.at(-1).present, head.present);
  assert.equal(occurrences.at(-1).source_json, head.source_json);
  for (let index = 0; index < occurrences.length - 1; index += 1) {
    const closure = await db.prepare("SELECT * FROM file_shadow_closures WHERE occurrence_id = ?")
      .bind(occurrences[index].id).first();
    assert(closure, "every superseded generation has a durable closure");
    assert.equal(closure.successor_occurrence_id, occurrences[index + 1].id);
  }
  assert.equal(await db.prepare("SELECT * FROM file_shadow_closures WHERE occurrence_id = ?").bind(head.occurrence_id).first(), null);
  return { head, occurrences };
}

const nativeWorkers = new Map();
async function workerSource(runtime = false) {
  if (nativeWorkers.has(runtime)) return nativeWorkers.get(runtime);
  const built = (await build({ stdin: {
    contents: `
      import { markOrphanCandidate, claimBlobDeletion, reclaimBlobDeletion } from './worker/blob-lifecycle/reachability.ts';
      import { fileShadowSchemaFingerprint, FILE_SHADOW_SCHEMA_FINGERPRINT_SHA256 } from './shared/contracts/export-file-shadow.ts';
      import { snapshotFullExportV15 } from './worker/export-v15-snapshot.ts';
      ${runtime ? `
      import { convertShadowConsumer } from './worker/files/shadow-service.ts';
      import { readShadowBaseline } from './worker/files/shadow-baseline.ts';
      import { openShadowProfile } from './worker/files/shadow-profile.ts';
      ` : ""}
      export default { async fetch(request, env) {
        const input = await request.json();
        const trace = [];
        try {
          if (input.action === 'fingerprint') {
            const schema = await env.DB.prepare('SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema ORDER BY type, name').all();
            return Response.json({ actual: await fileShadowSchemaFingerprint(schema.results), expected: FILE_SHADOW_SCHEMA_FINGERPRINT_SHA256 });
          }
          if (input.action === 'snapshotV15') {
            const manifest = await snapshotFullExportV15(env.DB);
            return Response.json({ schemaVersion: manifest.schemaVersion, archiveProfile: manifest.archiveProfile,
              heads: manifest.tables.file_shadow_heads,
              sourceRowids: manifest.artifacts.sourceRowids.value,
              exportedTables: Object.keys(manifest.tables),
              authority: manifest.tables.file_authority_control,
              fileLocationBlobs: manifest.blobs.filter(blob => blob.byteAuthority === 'file_location').length });
          }
          ${runtime ? `
          if (input.action === 'convert') {
            const key = { consumerKind: 'event', consumerId: 'baseline:event', consumerSubId: '', fileSlot: 'primary' };
            const baseline = await readShadowBaseline(env.DB, key);
            if (baseline.status !== 'ready_to_verify' && !input.expectedBaselineSha256) return Response.json({error:'baseline not ready',baseline,trace},{status:422});
            let injected = false;
            const context = { db: env.DB, actor: 'operator@example.test', runtimeIncarnation: input.incarnation,
              openProfile: async (profile, access) => {
                const bound = await openShadowProfile(env, profile, access);
                return { ...bound, reader: { stat: (...args) => bound.reader.stat(...args), read: async (objectKey) => {
                  trace.push({ action: 'read', objectKey });
                  if (input.race && !injected && objectKey === 'baseline/event-original') {
                    injected = true;
                    const holds = await env.DB.prepare('SELECT * FROM file_shadow_legacy_holds WHERE released_at IS NULL').all();
                    trace.push({action:'source_holds_before_io',count:holds.results.length});
                    await env.DB.prepare("UPDATE events SET asset_key='baseline/event-replacement' WHERE id='baseline:event'").run();
                    const locator = {storeKind:'r2',provider:'r2',objectKey};
                    const marked = await markOrphanCandidate(env.DB,locator,'native-barrier-mark',new Date('2026-09-15T00:00:00.000Z'));
                    const claimed = await claimBlobDeletion(env.DB,locator,'native-barrier-claim',new Date('2026-09-23T00:00:00.000Z'));
                    trace.push({action:'legacy_gc_during_source_read',marked,claimed});
                  }
                  return bound.reader.read(objectKey);
                } }, ...(bound.writer ? { writer: { ...bound.writer, write: async (input) => {
                  trace.push({action:'put',objectKey:input.key}); return bound.writer.write(input);
                } } } : {}) };
              } };
            const result = await convertShadowConsumer(context, {operationId:input.operationId,key,
              expectedBaselineSha256:input.expectedBaselineSha256 ?? baseline.baselineSha256,
              destinationProfile:{profileId:'baseline-r2',configurationRevision:1}});
            return Response.json({result,baseline,trace});
          }
          ` : ""}
          const locator = { storeKind: 'r2', provider: 'r2', objectKey: input.key };
          if (input.action === 'mark') return Response.json({ result: await markOrphanCandidate(env.DB, locator, 'native-mark', new Date('2026-09-15T00:00:00.000Z')) });
          if (input.action === 'claim') return Response.json({ result: await claimBlobDeletion(env.DB, locator, 'native-claim', new Date('2026-09-23T00:00:00.000Z')) });
          if (input.action === 'reclaim') return Response.json({ result: await reclaimBlobDeletion(env.DB, locator, 'native-claim', new Date('2026-09-24T00:00:00.000Z'), '2026-09-23T12:00:00.000Z') });
          return new Response('unknown action', { status: 400 });
        } catch(error) { return Response.json({error:error.message,trace}, {status:422}); }
      } };`,
    sourcefile: "fp1-shadow-native-fixture.ts", resolveDir: fileURLToPath(root),
  }, platform: "neutral", bundle: true, format: "esm", write: false })).outputFiles[0].text;
  nativeWorkers.set(runtime, built);
  return built;
}
async function harness({ migrate = true, seedAfterMigration = false, runtime = false } = {}) {
  const mf = new Miniflare({ modules: true, script: await workerSource(runtime), compatibilityDate: "2026-07-20",
    d1Databases: ["DB"], r2Buckets: ["ASSETS"], bindings: { R2_BOOTSTRAP_NAMESPACE: R2_NAMESPACE }, log: new Log(LogLevel.ERROR) });
  try {
    const db = await mf.getD1Database("DB");
    await seedLegacy(db, { populate: !seedAfterMigration });
    if (migrate) await apply(db, read(`migrations/${shadowMigration}`));
    if (seedAfterMigration) await seedLegacyFixture(db);
    return { db, mf, async gc(action, objectKey = "baseline/event-original") {
      const response = await mf.dispatchFetch("https://qualification.invalid/", {
        method: "POST", body: JSON.stringify({ action, key: objectKey }), headers: { "content-type": "application/json" },
      });
      return { status: response.status, ...await response.json() };
    } };
  } catch(error) { await mf.dispose(); throw error; }
}

async function enableRuntime(db, incarnation) {
  await enable(db);
  await db.prepare(`INSERT INTO file_shadow_profile_enablements
    (storage_profile_id, configuration_revision, enabled_by, enabled_at)
    VALUES ('baseline-r2', 1, 'native-qualification', ?)`)
    .bind(NOW).run();
  await db.prepare(`UPDATE file_shadow_runtime_guard SET incarnation = ?, enabled = 1,
    enabled_by = 'native-qualification', updated_at = ? WHERE singleton = 1`)
    .bind(incarnation, NOW).run();
  await db.prepare(`UPDATE events SET metadata_json =
    '{"action":"sample_record","thumbnailKey":"baseline/direct-thumbnail"}' WHERE id = 'baseline:event'`).run();
}

async function convert(mf, input) {
  const response = await mf.dispatchFetch("https://qualification.invalid/", {
    method: "POST", body: JSON.stringify({ action: "convert", ...input }),
    headers: { "content-type": "application/json" },
  });
  return { status: response.status, ...await response.json() };
}

test("0008 native populated migration is atomic, captures all 13 slots and supports a full V15 snapshot", { timeout: 90_000 }, async () => {
  const { db, mf } = await harness({ migrate: false });
  try {
    const before = await snapshot(db);
    const statements = splitSql(read(`migrations/${shadowMigration}`));
    assert(statements.every((statement) => Buffer.byteLength(statement) < 100_000));
    await assert.rejects(db.batch([...statements, "INSERT INTO file_authority_control (singleton, mode, revision, updated_at) VALUES (1, 'legacy', 1, 'invalid')"]
      .map((statement) => db.prepare(statement))));
    assert.deepEqual(await snapshot(db), before, "a failed native DDL batch preserves every old schema object and row");
    await apply(db, read(`migrations/${shadowMigration}`));
    const fingerprintResponse = await mf.dispatchFetch("https://qualification.invalid/", {
      method: "POST", body: JSON.stringify({ action: "fingerprint" }), headers: { "content-type": "application/json" },
    });
    assert.equal(fingerprintResponse.status, 200);
    const fingerprint = await fingerprintResponse.json();
    assert.equal(fingerprint.actual, fingerprint.expected, "native D1 schema matches the reviewed whole-file/split V15 generation");
    assert.deepEqual((await db.prepare("SELECT mode, revision, activated_at FROM file_authority_control").all()).results,
      [{ mode: "legacy", revision: 1, activated_at: null }]);
    const heads = (await db.prepare("SELECT * FROM file_shadow_heads WHERE present = 1").all()).results;
    assert.deepEqual(heads.map((head) => `${head.consumer_kind}/${head.file_slot}`).sort(), slots);
    for (const head of heads) await assertHistory(db, [head.consumer_kind, head.consumer_id, head.consumer_sub_id, head.file_slot]);
    const exportEpoch = await epoch(db);
    const archiveResponse = await mf.dispatchFetch("https://qualification.invalid/", {
      method: "POST", body: JSON.stringify({ action: "snapshotV15" }), headers: { "content-type": "application/json" },
    });
    const archive = await archiveResponse.json();
    assert.equal(archiveResponse.status, 200, JSON.stringify(archive));
    assert.equal(archive.schemaVersion, 15);
    assert.deepEqual(archive.heads.map((head) => `${head.consumer_kind}/${head.file_slot}`).sort(), slots,
      "the production snapshot reads and validates every populated source slot inside real D1");
    assert.equal(archive.authority[0].mode, "legacy");
    assert.equal(archive.fileLocationBlobs, 1);
    assert.equal(archive.exportedTables.includes("file_shadow_runtime_guard"), false);
    assert.equal(archive.exportedTables.includes("file_shadow_runtime_incarnations"), false);
    assert.equal(archive.sourceRowids.tables.events.length, before.rows.events.length,
      "physical source rowids preserve non-file events as well as the populated file slots");
    assert(archive.sourceRowids.tables.events.every((entry) => typeof entry.rowid === "string"));
    assert.equal(await epoch(db), exportEpoch, "export grants no runtime execution or source mutation");
    assert.deepEqual((await db.prepare("SELECT * FROM file_shadow_heads WHERE present = 1").all()).results, heads);
    for (const [table, oldRows] of Object.entries(before.rows)) {
      if (table === "file_authority_control") continue;
      const current = (await db.prepare(`SELECT * FROM "${table}"`).all()).results
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      assert.deepEqual(current, oldRows, `${table} is not silently backfilled or rewritten`);
    }
    assert.deepEqual((await db.prepare("SELECT * FROM file_consumer_migration_decisions").all()).results, []);
    assert.deepEqual((await db.prepare("SELECT DISTINCT file_id FROM file_consumer_projection").all()).results, [{ file_id: null }]);
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await mf.dispose(); }
});

test("unchanged old Worker INSERT shapes capture all 13 slots after the schema upgrade", { timeout: 90_000 }, async () => {
  const { db, mf } = await harness({ seedAfterMigration: true });
  try {
    const heads = (await db.prepare("SELECT * FROM file_shadow_heads WHERE present = 1").all()).results;
    assert.deepEqual(heads.map((head) => `${head.consumer_kind}/${head.file_slot}`).sort(), slots);
    for (const head of heads) await assertHistory(db, [head.consumer_kind, head.consumer_id, head.consumer_sub_id, head.file_slot]);
    assert.equal((await db.prepare("SELECT mode FROM file_authority_control").first()).mode, "legacy",
      "capture is installed before runtime opt-in so old writes cannot fall into a migration gap");
    assert.deepEqual((await db.prepare("SELECT DISTINCT file_id FROM file_consumer_projection").all()).results, [{ file_id: null }]);
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await mf.dispose(); }
});

test("native explicit overlap admission is epoch fenced and never activates File authority", { timeout: 90_000 }, async () => {
  const { db, mf } = await harness();
  try {
    const before = await snapshot(db);
    await assert.rejects(db.prepare("UPDATE file_authority_control SET mode = 'overlap', activated_at = ?").bind(NOW).run());
    await assert.rejects(db.prepare(`INSERT INTO file_shadow_enablements (singleton, expected_epoch, enabled_by, enabled_at)
      VALUES (1, ?, 'stale-native-admission', ?)`).bind((await epoch(db)) + 1, NOW).run());
    await assert.rejects(db.prepare(`UPDATE file_shadow_runtime_guard SET enabled = 1, incarnation = 'native-before-admission',
      enabled_by = 'fixture' WHERE singleton = 1`).run());
    assert.deepEqual(await snapshot(db), before, "rejected admission has no partial mode, history or enablement write");
    await enable(db);
    assert.equal((await db.prepare("SELECT mode FROM file_authority_control").first()).mode, "overlap");
    const overlap = await snapshot(db);
    await assert.rejects(db.prepare("UPDATE file_authority_control SET mode = 'active'").run());
    await assert.rejects(db.prepare("UPDATE file_authority_control SET mode = 'legacy', activated_at = NULL").run());
    await assert.rejects(db.prepare("DELETE FROM file_shadow_enablements").run());
    await assert.rejects(enable(db));
    assert.deepEqual(await snapshot(db), overlap);
    assert.deepEqual((await db.prepare("SELECT * FROM file_location_gc_ledger").all()).results, []);
    for (const incarnation of ["native-incarnation-a", "native-incarnation-b"]) {
      await db.prepare(`UPDATE file_shadow_runtime_guard SET enabled = 1, incarnation = ?,
        enabled_by = 'fixture' WHERE singleton = 1`).bind(incarnation).run();
      await db.prepare("UPDATE file_shadow_runtime_guard SET enabled = 0 WHERE singleton = 1").run();
    }
    const incarnationHistory = await snapshot(db);
    await assert.rejects(db.prepare(`UPDATE file_shadow_runtime_guard SET enabled = 1,
      incarnation = 'native-incarnation-a', enabled_by = 'fixture' WHERE singleton = 1`).run(), /incarnation/i);
    assert.deepEqual(await snapshot(db), incarnationHistory, "A → B → A cannot revive a retired executor even without attempts");
  } finally { await mf.dispose(); }
});

test("old Worker locator clear/restore/delete/reinsert creates durable generations and prevents ABA", { timeout: 90_000 }, async () => {
  const { db, mf } = await harness();
  try {
    await enable(db);
    const primary = key("event", "baseline:event");
    const thumbnail = key("event", "baseline:event", "thumbnail");
    const initial = await currentHead(db, primary);
    await db.prepare("UPDATE events SET asset_key = NULL, metadata_json = '{}' WHERE id = 'baseline:event'").run();
    const cleared = await currentHead(db, primary);
    assert.equal(cleared.present, 0);
    assert.equal((await currentHead(db, thumbnail)).present, 0);
    assert(cleared.generation > initial.generation);
    await db.prepare(`UPDATE events SET asset_key = 'baseline/event-original', metadata_json = '{"thumbnailKey":"baseline/direct-thumbnail"}'
      WHERE id = 'baseline:event'`).run();
    const restored = await currentHead(db, primary);
    assert.equal(restored.present, 1);
    assert(restored.generation > cleared.generation);
    assert.notEqual(restored.occurrence_id, initial.occurrence_id, "same key never resurrects an earlier occurrence");
    await db.prepare("DELETE FROM events WHERE id = 'baseline:event'").run();
    assert.equal((await currentHead(db, primary)).present, 0);
    await db.prepare(`INSERT INTO events (id, sample_id, kind, asset_key, metadata_json, created_at)
      VALUES ('baseline:event', 'reference-sample-a', 'image', 'baseline/event-original',
        '{"thumbnailKey":"baseline/direct-thumbnail"}', ?)`).bind(NOW).run();
    assert((await currentHead(db, primary)).generation > restored.generation);
    await assertHistory(db, primary);
    await assertHistory(db, thumbnail);
    assert.deepEqual((await db.prepare("SELECT asset_file_id, thumbnail_file_id FROM events WHERE id = 'baseline:event'").all()).results,
      [{ asset_file_id: null, thumbnail_file_id: null }]);
  } finally { await mf.dispose(); }
});

test("old Worker updates and existing UPSERT winners remain compatible with generation capture", { timeout: 90_000 }, async () => {
  const { db, mf } = await harness();
  try {
    await enable(db);
    const mutations = [
      [key("state_representation_asset", "baseline:state", "primary", "reference-comment-asset"),
        "INSERT INTO state_representation_assets (state_hash, asset_id, position) VALUES ('baseline:state', 'reference-comment-asset', 3) ON CONFLICT(state_hash, asset_id) DO UPDATE SET position = excluded.position"],
      [key("run_step_asset", "reference-execution-image"),
        "UPDATE run_step_assets SET asset_id = 'baseline-event-asset' WHERE id = 'reference-execution-image'"],
      [key("metrology_template_reference", "reference-metrology-reference"),
        "UPDATE metrology_template_references SET asset_id = 'reference-comment-asset' WHERE id = 'reference-metrology-reference'"],
      [key("run_step_comment", "baseline:legacy-comment"),
        "UPDATE run_step_comments SET asset_id = NULL WHERE id = 'baseline:legacy-comment'"],
      [key("state_verification", "baseline:verification", "evidence"),
        "UPDATE state_verifications SET evidence_asset_id = NULL WHERE id = 'baseline:verification'"],
      [key("comment_submission_item", "reference-comment-attachment"),
        "UPDATE comment_submission_items SET asset_id = 'baseline-event-asset' WHERE id = 'reference-comment-attachment'"],
      [key("attachment_derivative", "baseline:derivative", "derived"),
        `INSERT INTO attachment_derivatives (id, source_sha256, source_byte_size, derivative_kind, generator_version,
          derived_asset_id, status, retain_until, created_at, updated_at)
          VALUES ('native-ignored-new-id', '${hash("e")}', 100, 'browser_preview', 'fixture-v1',
            'reference-comment-asset', 'ready', '2099-02-01T00:00:00.000Z', '${NOW}', '${NOW}')
          ON CONFLICT(source_sha256, source_byte_size, derivative_kind, generator_version)
          DO UPDATE SET retain_until = excluded.retain_until`],
      [key("import", "baseline:import", "workbook"),
        "UPDATE imports SET workbook_asset_key = 'baseline/changed-workbook', manifest_asset_key = 'baseline/changed-manifest' WHERE id = 'baseline:import'"],
      [key("template_version", "reference-process-template", "source"),
        "UPDATE template_versions SET source_asset_key = 'baseline/changed-template' WHERE id = 'reference-process-template'"],
    ];
    for (const [identity, statement] of mutations) {
      const before = await currentHead(db, identity);
      await db.prepare(statement).run();
      const { head } = await assertHistory(db, identity);
      assert(head.generation > before.generation, `legacy mutation captured for ${identity[0]}`);
    }
    assert.equal(await currentHead(db, key("attachment_derivative", "native-ignored-new-id", "derived")), null,
      "a candidate discarded by the old UPSERT does not manufacture an occurrence");
    assert.equal((await db.prepare("SELECT byte_size FROM run_step_assets WHERE id = 'reference-execution-image'").first()).byte_size, 10,
      "existing nested AFTER trigger still updates occurrence metadata");
    assert.equal((await db.prepare("SELECT legacy_object_key FROM file_shadow_occurrences WHERE id = ?")
      .bind((await currentHead(db, key("import", "baseline:import", "manifest"))).occurrence_id).first()).legacy_object_key,
    "baseline/changed-manifest", "both import slots capture a single old Worker update");
    const beforeNoop = await currentHead(db, key("metrology_template_reference", "reference-metrology-reference"));
    await db.prepare(`INSERT INTO metrology_template_references
      (id, template_version_id, asset_id, display_name, position, actor_email, created_at)
      VALUES ('native-noop-reference', 'reference-metrology-template', 'reference-comment-asset', 'Noop', 3, 'fixture', ?)
      ON CONFLICT(template_version_id, asset_id) DO NOTHING`).bind(NOW).run();
    assert.deepEqual(await currentHead(db, key("metrology_template_reference", "reference-metrology-reference")), beforeNoop);
    assert.equal(await currentHead(db, key("metrology_template_reference", "native-noop-reference")), null);
    assert.deepEqual((await db.prepare("SELECT DISTINCT file_id FROM file_consumer_projection").all()).results, [{ file_id: null }]);
    assert.deepEqual((await db.prepare("SELECT * FROM file_consumer_migration_decisions").all()).results, []);
  } finally { await mf.dispose(); }
});

test("native capture retains displaced owners through REPLACE, UPDATE OR REPLACE and hidden rowid reuse", { timeout: 90_000 }, async () => {
  const { db, mf } = await harness();
  try {
    await enable(db);
    for (const recursive of [0, 1]) {
      await db.prepare(`PRAGMA recursive_triggers = ${recursive}`).run();
      const oldId = `native-rowid-owner-${recursive}`;
      const newId = `native-rowid-successor-${recursive}`;
      await db.prepare(`INSERT INTO events (id, sample_id, kind, asset_key, created_at)
        VALUES (?, 'reference-sample-a', 'image', 'native/rowid-original', ?)`).bind(oldId, NOW).run();
      const rowid = (await db.prepare("SELECT rowid FROM events WHERE id = ?").bind(oldId).first()).rowid;
      await db.prepare(`INSERT OR REPLACE INTO events (rowid, id, sample_id, kind, asset_key, created_at)
        VALUES (?, ?, 'reference-sample-a', 'image', 'native/rowid-replacement', ?)`).bind(rowid, newId, NOW).run();
      assert.equal((await assertHistory(db, key("event", oldId))).head.present, 0,
        `hidden rowid victim is closed with recursive_triggers=${recursive}`);
      assert.equal((await assertHistory(db, key("event", newId))).head.present, 1);
      const inserted = await currentHead(db, key("event", newId));
      await db.prepare(`INSERT OR REPLACE INTO events (id, sample_id, kind, asset_key, created_at)
        VALUES (?, 'reference-sample-a', 'image', 'native/primary-key-replacement', ?)`).bind(newId, NOW).run();
      assert((await assertHistory(db, key("event", newId))).head.generation > inserted.generation);

      const moverId = `native-mover-${recursive}`;
      await db.prepare(`INSERT INTO events (id, sample_id, kind, asset_key, created_at)
        VALUES (?, 'reference-sample-a', 'image', 'native/moved-key', ?)`).bind(moverId, NOW).run();
      const replaced = await currentHead(db, key("event", newId));
      await db.prepare("UPDATE OR REPLACE events SET id = ? WHERE id = ?").bind(newId, moverId).run();
      assert.equal((await assertHistory(db, key("event", moverId))).head.present, 0);
      assert((await assertHistory(db, key("event", newId))).head.generation > replaced.generation);

      const derivativeId = `native-derivative-${recursive}`;
      const replacedDerivative = recursive === 0 ? "baseline:derivative" : "native-derivative-0";
      await db.prepare(`INSERT OR REPLACE INTO attachment_derivatives
        (id, source_sha256, source_byte_size, derivative_kind, generator_version, derived_asset_id,
         status, retain_until, created_at, updated_at)
        VALUES (?, ?, 100, 'browser_preview', 'fixture-v1', 'reference-comment-asset',
          'ready', '2099-01-01T00:00:00.000Z', ?, ?)`).bind(derivativeId, hash("e"), NOW, NOW).run();
      assert.equal((await assertHistory(db, key("attachment_derivative", replacedDerivative, "derived"))).head.present, 0,
        "secondary UNIQUE replacement closes the displaced ID even when its DELETE trigger does not fire");
      assert.equal((await assertHistory(db, key("attachment_derivative", derivativeId, "derived"))).head.present, 1);
      for (const specialRowid of [-1, 0]) {
        const priorId = `native-special-${recursive}-${specialRowid}`;
        const successorId = `${priorId}-successor`;
        // BEFORE INSERT's automatic-rowid sentinel must not be confused with
        // these real, legal identities observed by AFTER capture.
        await db.prepare(`INSERT OR REPLACE INTO events (rowid, id, sample_id, kind, asset_key, created_at)
          VALUES (?, ?, 'reference-sample-a', 'image', 'native/special-rowid', ?)`).bind(specialRowid, priorId, NOW).run();
        await db.prepare("DELETE FROM events WHERE id = ?").bind(priorId).run();
        await db.prepare(`INSERT INTO events (rowid, id, sample_id, kind, asset_key, created_at)
          VALUES (?, ?, 'reference-sample-a', 'image', 'native/special-rowid-successor', ?)`).bind(specialRowid, successorId, NOW).run();
        assert.equal((await assertHistory(db, key("event", priorId))).head.present, 0);
        assert.equal((await assertHistory(db, key("event", successorId))).head.present, 1);
      }
    }
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    assert.deepEqual((await db.prepare("PRAGMA quick_check").all()).results, [{ quick_check: "ok" }]);
  } finally { await mf.dispose(); }
});

test("parent and registry mutations invalidate conversion epochs, and a rejected batch rolls back capture", { timeout: 90_000 }, async () => {
  const { db, mf } = await harness();
  try {
    await enable(db);
    for (const statement of [
      "UPDATE samples SET updated_at = '2026-09-14T01:00:00.000Z' WHERE id = 'reference-sample-a'",
      "UPDATE run_steps SET updated_at = '2026-09-14T01:00:00.000Z' WHERE id = 'reference-step-a'",
      "UPDATE runs SET last_mutation_id = 'native-parent-change' WHERE id = 'reference-run-a'",
      "UPDATE projects SET title = 'Changed', revision = revision + 1, last_mutation_id = 'native-parent-change' WHERE id = 'baseline-project'",
      "UPDATE project_contents SET attachment_caption = 'Changed', revision = revision + 1, last_mutation_id = 'native-content-change' WHERE id = 'baseline-attachment'",
      `UPDATE assets SET sha256 = '${hash("2")}' WHERE id = 'baseline-event-asset'`,
      "UPDATE managed_storage_objects SET byte_size = 12 WHERE id = 'baseline-managed'",
    ]) {
      const previous = await epoch(db);
      await db.prepare(statement).run();
      assert(await epoch(db) > previous, `dependency change is fenced: ${statement}`);
    }
    const before = await snapshot(db);
    await assert.rejects(db.batch([
      db.prepare("UPDATE events SET asset_key = 'native/rolled-back' WHERE id = 'baseline:event'"),
      db.prepare("UPDATE file_authority_control SET mode = 'active'"),
    ]));
    assert.deepEqual(await snapshot(db), before, "a later rejected statement rolls back source, head, history, closure and epoch together");
  } finally { await mf.dispose(); }
});

test("shadow occurrence history cannot be edited, erased or rewound independently of its live owner", { timeout: 90_000 }, async () => {
  const { db, mf } = await harness();
  try {
    await enable(db);
    const identity = key("event", "baseline:event");
    const original = await currentHead(db, identity);
    await db.prepare("UPDATE events SET asset_key = 'native/next-generation' WHERE id = 'baseline:event'").run();
    const before = await snapshot(db);
    for (const statement of [
      db.prepare("UPDATE file_shadow_occurrences SET legacy_object_key = 'native/forged' WHERE id = ?").bind(original.occurrence_id),
      db.prepare("DELETE FROM file_shadow_occurrences WHERE id = ?").bind(original.occurrence_id),
      db.prepare("DELETE FROM file_shadow_closures WHERE occurrence_id = ?").bind(original.occurrence_id),
      db.prepare(`UPDATE file_shadow_heads SET occurrence_id = ?, generation = ?
        WHERE consumer_kind = ? AND consumer_id = ? AND consumer_sub_id = ? AND file_slot = ?`)
        .bind(original.occurrence_id, original.generation, ...identity),
      db.prepare(`DELETE FROM file_shadow_heads
        WHERE consumer_kind = ? AND consumer_id = ? AND consumer_sub_id = ? AND file_slot = ?`).bind(...identity),
      db.prepare(`INSERT INTO file_shadow_occurrences
        (id, consumer_kind, consumer_id, consumer_sub_id, file_slot, generation, present,
         source_rowid, source_json, legacy_store_kind, legacy_provider, legacy_object_key,
         expected_purpose, observed_epoch, observed_at)
        SELECT 'native-forged-current-source', o.consumer_kind, o.consumer_id, o.consumer_sub_id, o.file_slot,
          o.generation + 1, o.present, o.source_rowid, json_set(o.source_json, '$.forged_metadata', 'forged'),
          o.legacy_store_kind, o.legacy_provider, o.legacy_object_key, o.expected_purpose,
          (SELECT epoch FROM file_shadow_control WHERE singleton = 1), o.observed_at
        FROM file_shadow_occurrences o JOIN file_shadow_heads h ON h.occurrence_id = o.id
        WHERE h.consumer_kind = ? AND h.consumer_id = ? AND h.consumer_sub_id = ? AND h.file_slot = ?`).bind(...identity),
    ]) await assert.rejects(statement.run());
    assert.deepEqual(await snapshot(db), before);
  } finally { await mf.dispose(); }
});

test("hold-first fence protects a released legacy locator and survives executor lease expiry", { timeout: 90_000 }, async () => {
  const { db, mf, gc } = await harness();
  try {
    await enable(db);
    await db.prepare(`UPDATE file_shadow_runtime_guard SET incarnation = 'native-executor', enabled = 1,
      enabled_by = 'fixture', updated_at = ? WHERE singleton = 1`).bind(NOW).run();
    await db.batch([await operationStatement(db, "native-held-operation"), holdStatement(db, "native-held-source", "native-held-operation")]);
    await db.prepare(`INSERT INTO file_shadow_attempts
      (id, operation_id, attempt_number, owner_token, runtime_incarnation, state, lease_expires_at, created_at)
      VALUES ('native-expired-attempt', 'native-held-operation', 1, 'native-owner', 'native-executor', 'staged',
        '2026-09-15T00:00:00.000Z', ?)`).bind(NOW).run();
    await db.prepare("UPDATE events SET asset_key = 'baseline/event-replacement' WHERE id = 'baseline:event'").run();
    const retained = (await db.prepare(`SELECT retention_reason, retain_until FROM blob_retention_edges
      WHERE object_key = 'baseline/event-original'`).all()).results;
    assert.deepEqual(retained, [{ retention_reason: "shadow_source_hold", retain_until: null }],
      "the old source remains retained independently of the current business locator and expired executor lease");
    assert.deepEqual(await gc("mark"), { status: 200, result: false });
    assert.deepEqual(await gc("claim"), { status: 200, result: null });
    const protectedState = await snapshot(db);
    await assert.rejects(db.prepare(`INSERT INTO blob_gc_ledger
      (store_kind, provider, object_key, state, operation_id, orphaned_at, deletion_started_at, attempt_count, updated_at)
      VALUES ('r2', 'r2', 'baseline/event-original', 'deleting', 'forged-claim', ?, ?, 1, ?)`)
      .bind(NOW, NOW, NOW).run(), /(?:hold|retention).*(?:deletion|fence)/i);
    await assert.rejects(db.prepare("UPDATE file_shadow_legacy_holds SET released_at = ? WHERE id = 'native-held-source'").bind(NOW).run(),
      /terminal reconciliation/i);
    assert.deepEqual(await snapshot(db), protectedState, "rejected claim/release changes no state");
    await assert.rejects(db.prepare("UPDATE file_shadow_operations SET status = 'cancelled', completed_at = ? WHERE id = 'native-held-operation'").bind(NOW).run(),
      /terminal|contract/i, "an operation cannot hide an unfinished attempt by becoming terminal");
    assert.deepEqual(await snapshot(db), protectedState);
    await db.prepare("UPDATE file_shadow_attempts SET state = 'cancelled', completed_at = ? WHERE id = 'native-expired-attempt'").bind(NOW).run();
    await assert.rejects(db.prepare("UPDATE file_shadow_legacy_holds SET released_at = ? WHERE id = 'native-held-source'").bind(NOW).run(),
      /terminal reconciliation/i, "a cancelled attempt alone does not release the pending operation's source hold");
    await db.prepare("UPDATE file_shadow_operations SET status = 'cancelled', completed_at = ? WHERE id = 'native-held-operation'").bind(NOW).run();
    await db.prepare("UPDATE file_shadow_legacy_holds SET released_at = ? WHERE id = 'native-held-source'").bind(NOW).run();
    assert.deepEqual(await gc("mark"), { status: 200, result: true });
    const claimed = await gc("claim");
    assert.equal(claimed.status, 200);
    assert.equal(claimed.result.operationId, "native-claim");
    assert.equal(claimed.result.attemptCount, 1);
  } finally { await mf.dispose(); }
});

test("GC-first fence cannot be undone by a new hold, mapping, replacement or reopened ledger", { timeout: 90_000 }, async () => {
  const { db, mf, gc } = await harness();
  try {
    await enable(db);
    // Retained historical metadata is still a conversion source even after its
    // old byte-retention window expires. This is a real legacy GC candidate.
    await db.prepare(`UPDATE run_step_assets SET asset_id = 'baseline-event-asset',
      deleted_at = '2000-01-01T00:00:00.000Z', deleted_by = 'fixture' WHERE id = 'reference-execution-image'`).run();
    await db.prepare("UPDATE events SET asset_key = 'baseline/event-replacement' WHERE id = 'baseline:event'").run();
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM blob_retention_edges WHERE object_key = 'baseline/event-original'").first()).count, 0);
    assert.deepEqual(await gc("mark"), { status: 200, result: true });
    assert.equal((await gc("claim")).result.attemptCount, 1);
    assert.deepEqual(await gc("mark"), { status: 200, result: false },
      "unchanged old GC retry must remain a no-op after another invocation claimed deletion");
    const before = await snapshot(db);
    await assert.rejects(db.batch([
      await operationStatement(db, "native-late-operation", key("run_step_asset", "reference-execution-image")),
      holdStatement(db, "native-late-hold", "native-late-operation"),
    ]), /hold|deletion|source/i);
    await assert.rejects(db.prepare(`INSERT INTO file_location_holds
      (id, location_id, hold_kind, operation_id, reason, acquired_at)
      VALUES ('native-late-location-hold', 'baseline-event-location', 'transition_source', 'native-late-location', 'too late', ?)`)
      .bind(NOW).run(), /legacy deletion/i);
    await assert.rejects(db.prepare("DELETE FROM blob_gc_ledger WHERE object_key = 'baseline/event-original'").run(), /cannot be erased/i);
    await assert.rejects(db.prepare("UPDATE blob_gc_ledger SET state = 'orphaned' WHERE object_key = 'baseline/event-original'").run(), /cannot be reopened/i);
    await assert.rejects(db.prepare(`INSERT OR REPLACE INTO blob_gc_ledger
      (store_kind, provider, object_key, state, operation_id, updated_at)
      VALUES ('r2', 'r2', 'baseline/event-original', 'orphaned', 'native-reopen', ?)`)
      .bind(NOW).run(), /cannot be replaced/i);
    assert.deepEqual(await snapshot(db), before, "a failed hold batch leaves no orphan operation and never revives a claimed source");
    const reclaimed = await gc("reclaim");
    assert.equal(reclaimed.status, 200);
    assert.equal(reclaimed.result.attemptCount, 2, "unchanged old GC can reconcile its exact existing claim");
    // SQLite can implicitly erase a rowid victim without firing its DELETE
    // guard. The insertion guard also fences that displaced terminal owner.
    await db.prepare("PRAGMA recursive_triggers = 0").run();
    const ledgerRowid = (await db.prepare("SELECT rowid FROM blob_gc_ledger WHERE object_key = 'baseline/event-original'").first()).rowid;
    const beforeRowidReplacement = await snapshot(db);
    await assert.rejects(db.prepare(`INSERT OR REPLACE INTO blob_gc_ledger
      (rowid, store_kind, provider, object_key, state, operation_id, updated_at)
      VALUES (?, 'r2', 'r2', 'native/displaced-ledger', 'orphaned', 'native-hidden-rowid-replacement', ?)`)
      .bind(ledgerRowid, NOW).run(), /claimed.*replaced/i);
    assert.deepEqual(await snapshot(db), beforeRowidReplacement,
      "a hidden-rowid ledger replacement cannot erase an already issued remote DELETE");
  } finally { await mf.dispose(); }
});

test("legacy source holds cannot borrow a same-key namespace from another storage profile", { timeout: 90_000 }, async () => {
  const { db, mf } = await harness();
  try {
    await enable(db);
    await db.prepare(`INSERT INTO storage_profiles
      (id, adapter_type, namespace_identity, configuration_source, credential_reference, configuration_revision, state, created_at)
      VALUES ('native-wrong-profile', 'r2', 'r2:fixture:different-bucket', 'bootstrap', NULL, 1, 'historical', ?)`)
      .bind(NOW).run();
    const before = await snapshot(db);
    await assert.rejects(db.batch([
      await operationStatement(db, "native-wrong-profile-operation", key("event", "baseline:event"), "native-wrong-profile"),
      holdStatement(db, "native-wrong-profile-hold", "native-wrong-profile-operation", "native-wrong-profile"),
    ]), /profile|source|namespace/i,
    "a self-consistent claimed profile is not evidence that this legacy locator belongs to that physical namespace");
    assert.deepEqual(await snapshot(db), before);
  } finally { await mf.dispose(); }
});

test("real R2 runtime conversion copies verified bytes and replay cannot regain write ownership", { timeout: 90_000 }, async () => {
  const { db, mf } = await harness({ runtime: true });
  try {
    const incarnation = "11111111-2222-4333-8444-555555555555";
    const operationId = "11111111-2222-4333-8444-666666666666";
    await enableRuntime(db, incarnation);
    const bucket = await mf.getR2Bucket("ASSETS");
    await bucket.put("baseline/event-original", EVENT_BYTES);
    const accepted = await convert(mf, { operationId, incarnation });
    assert.equal(accepted.status, 200, JSON.stringify(accepted));
    assert.equal(accepted.result.status, "resolved", JSON.stringify(accepted));
    assert.equal(accepted.result.attemptState, "published");
    assert.equal(accepted.trace.filter((entry) => entry.action === "put").length, 1);
    const published = await db.prepare(`SELECT l.object_key, l.storage_profile_id, f.expected_byte_size, f.expected_sha256,
      p.verified_sha256, p.state FROM files f JOIN file_publications p ON p.file_id = f.id
      JOIN file_locations l ON l.id = p.active_location_id WHERE f.id = ?`)
      .bind(accepted.result.fileId).first();
    assert(published.object_key.startsWith(`file-shadow/${operationId}/`));
    assert.equal(published.storage_profile_id, "baseline-r2");
    assert.equal(published.expected_sha256, EVENT_SHA256);
    assert.equal(published.verified_sha256, EVENT_SHA256);
    assert.equal(published.expected_byte_size, EVENT_BYTES.length);
    assert.equal(published.state, "ready");
    assert.equal(await (await bucket.get(published.object_key)).text(), EVENT_BYTES);
    assert.equal(await (await bucket.get("baseline/event-original")).text(), EVENT_BYTES);
    assert.equal((await db.prepare("SELECT asset_file_id FROM events WHERE id = 'baseline:event'").first()).asset_file_id, null);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM file_consumer_migration_decisions").first()).count, 0);
    assert.equal((await db.prepare("SELECT mode FROM file_authority_control").first()).mode, "overlap");
    const committed = await snapshot(db);
    const replay = await convert(mf, { operationId, incarnation, expectedBaselineSha256: accepted.baseline.baselineSha256 });
    assert.equal(replay.status, 200, JSON.stringify(replay));
    assert.deepEqual(replay.result, accepted.result);
    assert.deepEqual(replay.trace, [], "same operation observes the receipt without reopening source or destination I/O");
    assert.deepEqual(await snapshot(db), committed);
  } finally { await mf.dispose(); }
});

test("real R2 source-read barrier holds legacy bytes while changed generation blocks publication", { timeout: 90_000 }, async () => {
  const { db, mf } = await harness({ runtime: true });
  try {
    const incarnation = "22222222-2222-4333-8444-555555555555";
    const operationId = "22222222-2222-4333-8444-666666666666";
    await enableRuntime(db, incarnation);
    const bucket = await mf.getR2Bucket("ASSETS");
    await bucket.put("baseline/event-original", EVENT_BYTES);
    const initialHead = await currentHead(db, key("event", "baseline:event"));
    const raced = await convert(mf, { operationId, incarnation, race: true });
    assert.equal(raced.status, 422, JSON.stringify(raced));
    assert.match(raced.error, /baseline changed/i);
    assert.deepEqual(raced.trace.find((entry) => entry.action === "source_holds_before_io"),
      { action: "source_holds_before_io", count: 1 });
    assert.deepEqual(raced.trace.find((entry) => entry.action === "legacy_gc_during_source_read"),
      { action: "legacy_gc_during_source_read", marked: false, claimed: null });
    assert.equal(raced.trace.filter((entry) => entry.action === "put").length, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM file_shadow_decisions").first()).count, 0);
    const attempt = await db.prepare("SELECT * FROM file_shadow_attempts WHERE operation_id = ?").bind(operationId).first();
    assert.equal(attempt.state, "staged");
    assert.equal(attempt.candidate_file_id, null, "rejected staging rolls back both File identity and location");
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM files").first()).count, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM file_shadow_legacy_holds WHERE released_at IS NULL").first()).count, 1);
    assert.equal(await (await bucket.get("baseline/event-original")).text(), EVENT_BYTES);
    const current = await currentHead(db, key("event", "baseline:event"));
    assert(current.generation > initialHead.generation);
    assert.notEqual(current.occurrence_id, initialHead.occurrence_id);
  } finally { await mf.dispose(); }
});
