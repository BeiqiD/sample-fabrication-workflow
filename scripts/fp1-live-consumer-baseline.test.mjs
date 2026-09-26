import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const NOW = "2026-09-14T00:00:00.000Z";
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

async function seed(db, { expand = true } = {}) {
  assert.equal(migrationNames.length, 7, "qualification applies the exact reviewed 0001–0007 generation");
  for (const name of migrationNames.filter((name) => expand || !name.startsWith("0007_"))) {
    await apply(db, read(`migrations/${name}`));
  }
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
        'ready', '${hash("f")}', '2000-01-01T00:00:00.000Z');
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
      VALUES ('baseline-r2', 'r2', 'r2:fixture:bucket', 'bootstrap', NULL, 1, 'historical', '${NOW}'),
        ('baseline-switch', 'switchdrive', 'switchdrive:fixture:root', 'environment', 'environment:SWITCHDRIVE', 1, 'historical', '${NOW}');
    INSERT INTO files
      (id, purpose, access_scope, expected_byte_size, expected_sha256, verified_sha256, state, active_location_id, created_at)
      VALUES ('baseline-event-file', 'embedded_content', 'system', 10, '${hash("f")}', NULL, 'unresolved', NULL, '${NOW}');
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

let workerPromise;
function workerSource() {
  return workerPromise ??= build({ stdin: {
    contents: `
      import { readFileConsumerBaseline } from './worker/files/live-consumer-baseline.ts';
      import { markOrphanCandidate, claimBlobDeletion } from './worker/blob-lifecycle/reachability.ts';
      export default { async fetch(request, env) {
        const input = await request.json();
        const trace = { constraints: [], statements: [] };
        // This is an observation wrapper around workerd's actual D1 capability.
        // Every statement executes on D1; no SQL result is fabricated.
        const observe = (database) => ({ prepare(sql) {
          trace.statements.push(sql);
          return database.prepare(sql);
        } });
        const database = { ...observe(env.DB), withSession(constraint) {
          trace.constraints.push(constraint);
          return observe(env.DB.withSession(constraint));
        } };
        try {
          if (input.action === 'legacy-gc-claim') {
            const locator = { storeKind: 'r2', provider: 'r2', objectKey: 'baseline/event-original' };
            const marked = await markOrphanCandidate(env.DB, locator, 'baseline-orphan', new Date('2026-09-15T00:00:00.000Z'));
            const claim = await claimBlobDeletion(env.DB, locator, 'baseline-delete', new Date('2026-09-23T00:00:00.000Z'));
            return Response.json({ marked, claim });
          }
          const baseline = await readFileConsumerBaseline(database, input.options ?? {});
          return Response.json({ baseline, trace });
        } catch (error) {
          return Response.json({ error: error.message, trace }, { status: 422 });
        }
      } };`,
    resolveDir: fileURLToPath(root), sourcefile: "fp1-live-consumer-native-fixture.ts",
  }, bundle: true, format: "esm", platform: "neutral", write: false }).then((result) => result.outputFiles[0].text);
}

async function harness(options) {
  const mf = new Miniflare({ modules: true, script: await workerSource(), compatibilityDate: "2026-07-20",
    d1Databases: ["DB"], log: new Log(LogLevel.ERROR) });
  try {
    const db = await mf.getD1Database("DB");
    await seed(db, options);
    return { db, mf, async request(options = {}, action = "baseline") {
      const response = await mf.dispatchFetch("https://qualification.invalid/", {
        method: "POST", body: JSON.stringify({ options, action }), headers: { "content-type": "application/json" },
      });
      return { status: response.status, ...await response.json() };
    } };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

test("live consumer preflight reads all 13 populated slots on actual 0001–0007 D1 without writing", { timeout: 90_000 }, async () => {
  const { db, mf, request } = await harness();
  try {
    assert.deepEqual((await db.prepare(`SELECT consumer_kind, file_slot FROM file_consumer_projection
      ORDER BY consumer_kind, file_slot`).all()).results.map((row) => `${row.consumer_kind}/${row.file_slot}`).sort(), slots);
    const before = await snapshot(db);
    const result = await request();
    assert.equal(result.status, 200, result.error);
    assert.equal(result.baseline.executable, false);
    assert.equal(result.baseline.bytesVerified, false);
    assert.equal(result.baseline.records.length, 13);
    assert.deepEqual(result.baseline.records.map(({ key }) => `${key.consumerKind}/${key.fileSlot}`).sort(), slots);
    assert.equal(result.baseline.authority.mode, "legacy");
    assert.equal(result.baseline.authority.revision, 1);
    assert.equal(result.baseline.nextCursor, null);
    assert.match(result.baseline.baselineSha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(result.baseline), /PRIVATE_LEGACY_BODY|PRIVATE_EVENT_BODY/,
      "the diagnostic report contains locator metadata, never private body text");
    assert.deepEqual(result.trace.constraints, ["first-primary"]);
    assert.equal(result.trace.statements.length, 1, "authority and evidence share one actual primary SQL read");
    assert.deepEqual(await snapshot(db), before, "preflight cannot write business rows, ledger, authority, or schema");
    assert.deepEqual((await request()).baseline, result.baseline, "unchanged evidence yields a deterministic baseline");
  } finally { await mf.dispose(); }
});

test("native preflight preserves pending consumer coverage that the typed projection cannot yet expose", { timeout: 90_000 }, async () => {
  const { db, mf, request } = await harness();
  try {
    await apply(db, `
      INSERT INTO comment_submissions (id, context_kind, sample_id, body, status, created_at, updated_at)
        VALUES ('baseline-pending-submission', 'sample', 'reference-sample-a', 'PRIVATE_PENDING_BODY', 'failed', '${NOW}', '${NOW}');
      INSERT INTO comment_submission_items (id, submission_id, kind, status, position, created_at, updated_at)
        VALUES ('baseline:pending-item', 'baseline-pending-submission', 'attachment', 'pending', 0, '${NOW}', '${NOW}'),
          ('baseline:link-item', 'baseline-pending-submission', 'link', 'pending', 1, '${NOW}', '${NOW}');
      INSERT INTO attachment_derivatives (id, source_sha256, source_byte_size, derivative_kind, generator_version,
        status, error_code, created_at, updated_at)
        VALUES ('baseline:failed-derivative', '${hash("1")}', 11, 'browser_preview', 'fixture-v1',
          'failed', 'PRIVATE_DERIVATIVE_ERROR', '${NOW}', '${NOW}');
    `);
    const before = await snapshot(db);
    const result = await request();
    assert.equal(result.status, 200, result.error);
    assert.equal(result.baseline.records.length, 15);
    for (const [id, expectedStatus, expectedReason] of [
      ["baseline:pending-item", "pending_no_locator", "consumer_has_no_locator"],
      ["baseline:failed-derivative", "unavailable", "consumer_unavailable_without_locator"],
    ]) {
      const record = result.baseline.records.find(({ key }) => key.consumerId === id);
      assert(record, `${id} stays visible without a bound locator`);
      assert.equal(record.locator, null);
      assert.equal(record.status, expectedStatus);
      assert.deepEqual(record.reasons, [expectedReason]);
    }
    assert(!result.baseline.records.some(({ key }) => key.consumerId === "baseline:link-item"));
    assert.doesNotMatch(JSON.stringify(result.baseline), /PRIVATE_PENDING_BODY|PRIVATE_DERIVATIVE_ERROR/);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM file_consumer_projection").first()).count, 13);
    assert.deepEqual(await snapshot(db), before);
  } finally { await mf.dispose(); }
});

test("native preflight keyset pagination is complete and row/byte overflow fails closed", { timeout: 90_000 }, async () => {
  const { db, mf, request } = await harness();
  try {
    const before = await snapshot(db);
    const whole = await request();
    assert.equal(whole.status, 200, whole.error);
    const records = [];
    let after;
    let pageCount = 0;
    do {
      const page = await request({ limit: 2, ...(after ? { after } : {}) });
      assert.equal(page.status, 200, page.error);
      assert(page.baseline.records.length <= 2);
      assert.deepEqual(page.trace.constraints, ["first-primary"]);
      assert.equal(page.trace.statements.length, 1);
      records.push(...page.baseline.records);
      after = page.baseline.nextCursor;
      assert(++pageCount < 10, "cursor must advance");
    } while (after);
    assert.equal(pageCount, 7);
    assert.deepEqual(records, whole.baseline.records, "pagination loses, duplicates, or reclassifies no consumer");
    assert.equal(new Set(records.map((record) => JSON.stringify(record.key))).size, 13);
    const outputBytes = Buffer.byteLength(JSON.stringify(whole.baseline), "utf8");
    const exactBytes = await request({ maxBytes: outputBytes });
    assert.equal(exactBytes.status, 200, exactBytes.error);
    assert.deepEqual(exactBytes.baseline, whole.baseline);
    const byteOverflow = await request({ maxBytes: outputBytes - 1 });
    assert.equal(byteOverflow.status, 422, "the final serialized report has an exact byte ceiling");
    assert.match(byteOverflow.error, /byte bound/i);
    assert.equal(byteOverflow.baseline, undefined);
    const empty = await request({ after: records.at(-1).key });
    assert.equal(empty.status, 200, empty.error);
    assert.deepEqual(empty.baseline.records, []);
    assert.equal(empty.baseline.nextCursor, null);
    for (const options of [{ limit: 0 }, { limit: 21 }, { limit: 1.5 }, { maxBytes: 0 }, { maxEvidenceRows: 0 },
      { maxEvidenceRows: 101 }, { after: { consumerKind: "event", consumerId: 1, consumerSubId: "", fileSlot: "primary" } }]) {
      const rejected = await request(options);
      assert.equal(rejected.status, 422, JSON.stringify(options));
      assert.equal(rejected.baseline, undefined, "invalid request never returns a partial baseline");
    }
    for (const options of [{ maxBytes: 1024 }, { maxEvidenceRows: 1 }]) {
      const rejected = await request(options);
      assert.equal(rejected.status, 422, JSON.stringify(options));
      assert.match(rejected.error, /bound|byte|evidence|large|limit|overflow/i);
      assert.equal(rejected.baseline, undefined, "over-budget evidence cannot become a usable partial baseline");
    }
    assert.deepEqual(await snapshot(db), before, "successful pages and failed bounds checks leave every SQL row untouched");
  } finally { await mf.dispose(); }
});

test("native preflight detects source mutations and missing generation while authority remains legacy", { timeout: 90_000 }, async () => {
  const { db, mf, request } = await harness();
  try {
    const initial = await request();
    assert.equal(initial.status, 200, initial.error);
    await db.prepare("UPDATE events SET asset_key = 'baseline/event-replacement' WHERE id = 'baseline:event'").run();
    const afterMutation = await snapshot(db);
    const changed = await request();
    assert.equal(changed.status, 200, changed.error);
    assert.notEqual(changed.baseline.baselineSha256, initial.baseline.baselineSha256,
      "a mutable legacy locator invalidates the observation digest");
    assert(changed.baseline.records.some((record, index) => record.baselineSha256 !== initial.baseline.records[index].baselineSha256));
    assert.deepEqual(await snapshot(db), afterMutation);
    for (const mutation of [
      `UPDATE file_authority_control SET mode = 'overlap', activated_at = '${NOW}'`,
      "UPDATE file_authority_control SET revision = 2",
      "DELETE FROM file_authority_control",
    ]) {
      await assert.rejects(db.prepare(mutation).run(), /reviewed forward migration|cannot be deleted/i);
    }
    assert.deepEqual((await db.prepare("SELECT mode, revision, activated_at FROM file_authority_control").all()).results,
      [{ mode: "legacy", revision: 1, activated_at: null }]);
    assert.deepEqual(await snapshot(db), afterMutation, "qualification never disables the authority guards");
  } finally { await mf.dispose(); }

  const legacy = await harness({ expand: false });
  try {
    const before = await snapshot(legacy.db);
    const rejected = await legacy.request();
    assert.equal(rejected.status, 422);
    assert.match(rejected.error, /no such table|generation|authority|schema/i);
    assert.equal(rejected.baseline, undefined, "0006 cannot be relabeled as a 0007 snapshot");
    assert.deepEqual(await snapshot(legacy.db), before);
  } finally { await legacy.mf.dispose(); }
});

test("isolated legacy race probe: observing a File mapping does not freeze an event or retain its previous bytes", { timeout: 90_000 }, async () => {
  const { db, mf, request } = await harness();
  try {
    // This probe demonstrates a blocker; it does not exercise or authorize a
    // shadow writer. It uses an isolated DB and the existing legacy GC SQL.
    const initial = await request();
    assert.equal(initial.status, 200, initial.error);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM blob_retention_edges WHERE object_key = 'baseline/event-original'").first()).count, 1);
    const reachable = await request({}, "legacy-gc-claim");
    assert.equal(reachable.marked, false);
    assert.equal(reachable.claim, null, "the current event still retains its bytes");

    await db.prepare("UPDATE events SET asset_key = 'baseline/event-replacement' WHERE id = 'baseline:event'").run();
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM blob_retention_edges WHERE object_key = 'baseline/event-original'").first()).count, 0);
    const collected = await request({}, "legacy-gc-claim");
    assert.equal(collected.marked, true);
    assert.deepEqual(collected.claim, {
      operationId: "baseline-delete", attemptCount: 1, deletionStartedAt: "2026-09-23T00:00:00.000Z",
    }, "an inventory File/location/mapping is not a legacy GC hold");
    assert.deepEqual((await db.prepare("SELECT file_id, location_id FROM legacy_file_mappings WHERE object_key = 'baseline/event-original'").all()).results,
      [{ file_id: "baseline-event-file", location_id: "baseline-event-location" }]);
    assert.deepEqual((await db.prepare("SELECT state FROM blob_gc_ledger WHERE object_key = 'baseline/event-original'").all()).results,
      [{ state: "deleting" }]);
    await assert.rejects(db.prepare("UPDATE events SET asset_key = 'baseline/event-original' WHERE id = 'baseline:event'").run(),
      /blob locator is unavailable/i, "the unchanged legacy rebind guard still rejects a claimed object");
    assert.deepEqual((await db.prepare("SELECT mode, revision FROM file_authority_control").all()).results,
      [{ mode: "legacy", revision: 1 }]);
    assert.deepEqual((await db.prepare("SELECT * FROM file_consumer_migration_decisions").all()).results, []);
    assert.deepEqual((await db.prepare("SELECT * FROM file_acceptance_candidates").all()).results, []);
  } finally { await mf.dispose(); }
});
