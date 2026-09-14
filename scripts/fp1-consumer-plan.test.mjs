import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";

const root = fileURLToPath(new URL("../", import.meta.url));
const NOW = "2026-08-01T00:00:00.000Z";
const EXPIRED = "2000-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const plain = (value) => JSON.parse(JSON.stringify(value));
const read = (path) => readFileSync(join(root, path), "utf8");

function hostAdapter(database) {
  const prepare = (sql, values = []) => ({
    bind(...bindings) { return prepare(sql, bindings); },
    async all() { return this.execute(); },
    async first() { return plain(database.prepare(sql).get(...values) ?? null); },
    async run() { return this.execute(); },
    execute() {
      const statement = database.prepare(sql);
      return statement.columns().length
        ? { success: true, results: plain(statement.all(...values)), meta: { changes: 0 } }
        : { success: true, results: [], meta: { changes: Number(statement.run(...values).changes) } };
    },
  });
  return {
    nativeDatabase: database,
    prepare,
    async batch(statements) {
      database.exec("BEGIN");
      try { const result = statements.map((statement) => statement.execute()); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
}

async function sql(db, text) {
  if (db.nativeDatabase) {
    db.nativeDatabase.exec("BEGIN");
    try { db.nativeDatabase.exec(text); db.nativeDatabase.exec("COMMIT"); }
    catch (error) { db.nativeDatabase.exec("ROLLBACK"); throw error; }
    return;
  }
  await db.batch(splitSql(text).map((statement) => db.prepare(statement)));
}

/** Direct-only and legacy Comment roots are real historical rows. Apply the
 * original reviewed migrations in order; never disable a production guard to
 * insert something which the current schema would refuse. */
async function seed(db) {
  const historical = readdirSync(join(root, "migrations-history/s0")).filter((name) => name.endsWith(".sql")).sort();
  for (const name of historical.filter((name) => name <= "0024_blob_integrity_quarantine.sql")) {
    await sql(db, read(`migrations-history/s0/${name}`));
  }
  await sql(db, read("worker/fixtures/reference-graph-s0.sql"));
  await sql(db, `
    INSERT INTO assets (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at) VALUES
      ('shared:asset', 'same-key', 'original.png', 'image/png', 4, 'ready', '${hash("same")}', '${NOW}'),
      ('nullable-sha', 'unhashed-key', 'old.bin', 'application/octet-stream', 4, 'ready', NULL, '${NOW}'),
      ('preview-live', 'live-preview', 'preview.webp', 'image/webp', 4, 'ready', '${hash("live")}', '${NOW}'),
      ('preview-expired', 'expired-preview', 'preview.webp', 'image/webp', 7, 'ready', '${hash("expired")}', '${NOW}');
    INSERT INTO managed_storage_objects (id, provider, object_key, original_name, mime_type, byte_size, sha256, status, created_at)
      VALUES ('managed-same', 'switchdrive', 'same-key', 'raw.bin', 'application/octet-stream', 7, '${hash("managed")}', 'ready', '${NOW}');
    INSERT INTO imports (id, status, source_filename, source_sha256, sheet_name, template_type, workbook_asset_key, manifest_asset_key, created_at)
      VALUES ('legacy:import', 'ready', 'source.xlsx', '${hash("same")}', 'Sheet1', 'process', 'same-key', 'direct-manifest', '${NOW}'),
        ('direct-import', 'failed', 'old.xlsx', '${hash("old")}', 'Sheet1', 'process', 'direct-workbook', NULL, '${NOW}'),
        ('legacy-recovery', 'failed', 'recover.xlsx', '${hash("recover")}', 'Sheet1', 'process', NULL, NULL, '${NOW}');
    UPDATE assets SET import_id = 'legacy-recovery', status = 'failed', byte_size = 4, sha256 = '${hash("same")}'
      WHERE id = 'reference-execution-asset';
    UPDATE template_versions SET source_asset_key = 'direct-template' WHERE id = 'reference-process-template';
    INSERT INTO events (id, sample_id, kind, asset_key, metadata_json, created_at) VALUES
      ('event:direct', 'reference-sample-a', 'image', 'direct-event', '{"thumbnailKey":"direct-thumbnail"}', '${NOW}'),
      ('event:same', 'reference-sample-a', 'image', 'same-key', '{"thumbnailKey":"same-key"}', '${NOW}');
    INSERT INTO state_representations (hash, content_json, created_at) VALUES ('state:with:colon', '{}', '${NOW}');
    INSERT INTO state_representation_assets (state_hash, asset_id, position) VALUES ('state:with:colon', 'shared:asset', 3);
    INSERT INTO run_step_comments (id, run_step_id, scope, body, asset_id, created_at)
      VALUES ('legacy:comment', 'reference-step-a', 'individual', 'Historical text stays private', 'nullable-sha', '${NOW}');
    INSERT INTO state_verifications (id, sample_id, after_run_step_id, result, evidence_asset_id, status, created_at)
      VALUES ('stale:verification', 'reference-sample-a', 'reference-step-a', 'mismatched', 'shared:asset', 'stale', '${NOW}');
    INSERT INTO comment_submission_items (id, submission_id, kind, status, position, asset_id, created_at, updated_at)
      VALUES ('original:shared', 'reference-comment', 'attachment', 'ready', 1, 'shared:asset', '${NOW}', '${NOW}'),
        ('preview:shared', 'reference-comment', 'comment_image', 'ready', 2, 'preview-live', '${NOW}', '${NOW}');
    UPDATE comment_submission_items SET related_item_id = 'preview:shared' WHERE id = 'original:shared';
    UPDATE comment_submission_items SET related_item_id = 'original:shared' WHERE id = 'preview:shared';
    INSERT INTO comment_submission_items (id, submission_id, kind, status, position, storage_object_id, created_at, updated_at)
      VALUES ('managed:original', 'reference-comment', 'attachment', 'ready', 3, 'managed-same', '${NOW}', '${NOW}');
    INSERT INTO comment_submissions (id, context_kind, sample_id, body, status, created_at, updated_at)
      VALUES ('failed:comment', 'sample', 'reference-sample-a', 'Private failed text', 'failed', '${NOW}', '${NOW}');
    INSERT INTO comment_submission_items (id, submission_id, kind, status, position, created_at, updated_at)
      VALUES ('pending:unbound', 'failed:comment', 'attachment', 'pending', 0, '${NOW}', '${NOW}');
  `);
  for (const name of historical.filter((name) => name > "0024_blob_integrity_quarantine.sql")) {
    await sql(db, read(`migrations-history/s0/${name}`));
  }
  for (const name of ["s1-compatibility-bridge.sql", "s2-final-schema.sql"]) await sql(db, read(`scripts/fixtures/backend-schema/${name}`));
  for (const name of ["0002_fp1_file_registry.sql", "0003_fp1_import_acceptance.sql"]) await sql(db, read(`migrations/${name}`));
  await sql(db, `
    UPDATE imports SET recovery_operation_id = 'supersede' WHERE id = 'legacy-recovery';
    INSERT INTO run_step_assets (id, run_step_id, asset_id, role, position, created_at)
      VALUES ('superseded:execution', 'reference-step-a', 'shared:asset', 'execution', 1, '${NOW}');
    UPDATE run_step_assets SET superseded_by_occurrence_id = 'superseded:execution', superseded_at = '${NOW}',
      superseded_by = 'system:fabublox-import-recovery', supersession_operation_id = 'supersede',
      deleted_at = '${EXPIRED}', deleted_by = 'system:fabublox-import-recovery', last_mutation_id = 'supersede'
      WHERE id = 'reference-execution-image';
    UPDATE run_step_assets SET deleted_at = '${EXPIRED}', deleted_by = 'fixture' WHERE id = 'superseded:execution';
    UPDATE metrology_template_references SET deleted_at = '${EXPIRED}', deleted_by = 'fixture' WHERE id = 'reference-metrology-reference';
    UPDATE run_step_comments SET asset_deleted_at = '${EXPIRED}', asset_deleted_by = 'fixture' WHERE id = 'legacy:comment';
    UPDATE comment_submission_items SET deleted_at = '${EXPIRED}', deleted_by = 'fixture' WHERE id = 'managed:original';
    UPDATE comment_submissions SET retry_until = '${EXPIRED}', retry_closed_at = '${EXPIRED}', retry_closed_by = 'fixture' WHERE id = 'failed:comment';
    INSERT INTO attachment_derivatives (id, source_sha256, source_byte_size, derivative_kind, generator_version,
      derived_asset_id, status, retain_until, created_at, updated_at) VALUES
      ('derivative:live', '${hash("source-live")}', 11, 'browser_preview', 'fixture-trusted-producer', 'preview-live', 'ready', '${FUTURE}', '${NOW}', '${NOW}'),
      ('derivative:expired', '${hash("source-expired")}', 14, 'browser_preview', 'fixture-trusted-producer', 'preview-expired', 'ready', '${EXPIRED}', '${NOW}', '${NOW}');
    INSERT INTO projects (id, title, last_mutation_id, created_by, updated_by, created_at, updated_at)
      VALUES ('history-project', 'History project', 'create', 'fixture', 'fixture', '${NOW}', '${NOW}');
    INSERT INTO project_contents (id, project_id, content_type, last_mutation_id, created_by, updated_by, created_at, updated_at)
      VALUES ('project-attachment', 'history-project', 'attachment', 'content', 'fixture', 'fixture', '${NOW}', '${NOW}');
    INSERT INTO project_content_attachments (project_content_id, storage_object_id, original_name, mime_type, byte_size, created_by, created_at, creation_operation_id)
      VALUES ('project-attachment', 'managed-same', 'raw.bin', 'application/octet-stream', 7, 'fixture', '${NOW}', 'bind');
    UPDATE project_contents SET deleted_at = '${EXPIRED}', deleted_by = 'fixture', deletion_operation_id = 'trash-content',
      revision = revision + 1, last_mutation_id = 'trash-content' WHERE id = 'project-attachment';
    UPDATE projects SET deleted_at = '${EXPIRED}', deleted_by = 'fixture', deletion_operation_id = 'trash-project',
      revision = revision + 1, last_mutation_id = 'trash-project' WHERE id = 'history-project';
    INSERT INTO blob_gc_ledger (store_kind, provider, object_key, state, operation_id, updated_at, last_error) VALUES
      ('r2', 'r2', 'gc-only', 'deleted', 'gc-operation', '${NOW}', 'PRIVATE_PROVIDER_ERROR'),
      ('r2', 'r2', 'expired-preview', 'orphaned', 'orphan-operation', '${NOW}', NULL);
    INSERT INTO blob_integrity_quarantine (store_kind, provider, object_key, reason, expected_byte_size, observed_byte_size,
      operation_id, detected_at, last_checked_at) VALUES
      ('r2', 'r2', 'quarantine-only', 'size_mismatch', 8, 9, 'quarantine-operation', '${NOW}', '${NOW}');
    INSERT INTO storage_profiles VALUES
      ('profile-r2', 'r2', 'r2:fixture:bucket-one', 'bootstrap', NULL, 1, 'historical', '${NOW}'),
      ('profile-managed', 'switchdrive', 'switchdrive:fixture:root', 'environment', 'environment:SWITCHDRIVE', 1, 'historical', '${NOW}');
    INSERT INTO files VALUES
      ('observed-shared', NULL, 'system', 999, '${hash("conflicting-metadata")}', NULL, 'unresolved', NULL, '${NOW}'),
      ('observed-managed', 'research_source', 'system', 7, '${hash("managed")}', NULL, 'unresolved', NULL, '${NOW}');
    INSERT INTO file_locations VALUES
      ('location-shared', 'observed-shared', 'profile-r2', 'same-key', 'unresolved', '${NOW}'),
      ('location-managed', 'observed-managed', 'profile-managed', 'same-key', 'unresolved', '${NOW}');
    INSERT INTO legacy_file_mappings VALUES
      ('r2', 'r2', 'same-key', 'observed-shared', 'location-shared', 'ambiguous', '{}', '${NOW}'),
      ('managed', 'switchdrive', 'same-key', 'observed-managed', 'location-managed', 'classified', '{}', '${NOW}');
  `);
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  assert.deepEqual((await db.prepare("PRAGMA quick_check").all()).results, [{ quick_check: "ok" }]);
}

async function bundle(source, platform = "node") {
  return (await build({ stdin: { contents: source, resolveDir: root, sourcefile: "fp1-consumer-qualification.ts" },
    bundle: true, format: "esm", platform, write: false,
    ...(platform === "node" ? { banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } } : {}),
  })).outputFiles[0].text;
}

function semantic(plan) {
  // Preserve every planning result. Snapshot provenance deliberately includes
  // exporter timestamps and observed platform/schema SQL, so it is independently
  // checked below rather than relabeled to imitate the other runtime.
  const { source, ...result } = plan;
  return result;
}

function assertCoverage(plan) {
  assert.equal(plan.executable, false);
  assert.equal(plan.bytesVerified, false);
  assert.equal(plan.source.basis, "archive-snapshot");
  assert.equal(plan.source.schemaVersion, 10);
  assert.equal(plan.source.archiveProfile, "fp1-import-acceptance");
  assert.match(plan.source.inputSha256, /^[a-f0-9]{64}$/);
  assert.equal(plan.coverage.unmatchedEdges.length, 0);
  assert.equal(plan.coverage.ambiguousEdges.length, 0);
  assert.equal(plan.coverage.matchedEdges, plan.coverage.retentionEdges);
  const consumers = [...plan.groups.flatMap((group) => group.consumers), ...plan.unresolvedConsumers];
  const tables = new Set(consumers.map((consumer) => consumer.source.table));
  assert.deepEqual([...tables].sort(), ["state_representation_assets", "run_step_assets", "metrology_template_references",
    "run_step_comments", "state_verifications", "comment_submission_items", "events", "imports", "template_versions",
    "project_content_attachments", "attachment_derivatives"].sort());
  const shared = plan.groups.find((group) => group.locator.storeKind === "r2" && group.locator.objectKey === "same-key");
  const managed = plan.groups.find((group) => group.locator.storeKind === "managed" && group.locator.objectKey === "same-key");
  assert(shared && managed);
  assert.equal(shared.namespace.status, "resolved");
  assert.equal(managed.namespace.status, "resolved");
  assert(shared.blockers.includes("expected_size_conflict"));
  assert(shared.blockers.includes("expected_hash_conflict"));
  assert.equal(shared.expectedByteSize, null);
  assert.equal(shared.expectedSha256, null);
  assert.deepEqual(shared.proposals.map((proposal) => proposal.purpose).sort(), ["embedded_content", "provenance", "research_source"]);
  assert(shared.proposals.every((proposal) => proposal.requiresIndependentVerifiedCopy));
  assert.equal(new Set([...shared.proposals, ...managed.proposals].map((proposal) => proposal.proposedFileId)).size,
    shared.proposals.length + managed.proposals.length, "same physical key across providers and purposes never merges proposed Files");
  assert(consumers.some((consumer) => consumer.source.table === "state_representation_assets"
    && consumer.source.primaryKey.state_hash === "state:with:colon" && consumer.source.primaryKey.asset_id === "shared:asset"));
  assert(consumers.some((consumer) => consumer.history.supersededBy === "superseded:execution"));
  assert(consumers.some((consumer) => consumer.source.primaryKey.id === "derivative:expired" && consumer.history.retainUntil === EXPIRED));
  assert(consumers.some((consumer) => consumer.source.primaryKey.id === "legacy:comment" && consumer.history.assetDeletedAt === EXPIRED));
  const unhashed = plan.groups.find((group) => group.locator.objectKey === "unhashed-key");
  assert(unhashed.blockers.includes("expected_hash_incomplete"));
  assert.equal(unhashed.expectedSha256, null);
  assert(plan.unresolvedConsumers.some((consumer) => consumer.source.primaryKey.id === "pending:unbound"));
  assert(plan.groups.some((group) => group.locator.objectKey === "direct-workbook" && group.namespace.status === "unresolved"));
  assert(plan.groups.some((group) => group.locator.objectKey === "gc-only" && group.lifecycle.length));
  assert(plan.groups.some((group) => group.locator.objectKey === "quarantine-only" && group.lifecycle.length));
  assert(!JSON.stringify(plan).includes("PRIVATE_PROVIDER_ERROR"));
  assert(!JSON.stringify(plan).includes("Historical text stays private"));
}

test("canonical consumer planning agrees on host SQLite, workerd/D1 and populated V10 isolated restore", { timeout: 120_000 }, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "fp1-consumer-plan-"));
  const source = `export { snapshotFullExportV10 } from './worker/export-v10-snapshot.ts';
    export { planFileMigration } from './shared/contracts/file-migration-plan.ts';`;
  const main = await bundle(source + `
    export { buildFullExportArchiveV10 } from './src/lib/exportAll.ts';
    export { restoreExportToIsolatedDirectory } from './scripts/lib/export-restore.ts';`);
  const servicePath = join(scratch, "qualification.mjs");
  await writeFile(servicePath, main);
  const service = await import(pathToFileURL(servicePath).href);
  const worker = await bundle(source + `
    import { snapshotFullExportV10 } from './worker/export-v10-snapshot.ts';
    import { planFileMigration } from './shared/contracts/file-migration-plan.ts';
    export default { async fetch(request, env) {
      const before = await snapshotFullExportV10(env.DB);
      const plan = await planFileMigration(before);
      const after = await snapshotFullExportV10(env.DB);
      return Response.json({ before, plan, after });
    } };`, "neutral");
  const host = new DatabaseSync(":memory:");
  const mf = new Miniflare({ modules: true, script: worker, compatibilityDate: "2026-07-20", d1Databases: ["DB"], log: new Log(LogLevel.ERROR) });
  try {
    const db = hostAdapter(host);
    await seed(db);
    const before = await service.snapshotFullExportV10(db);
    const serialized = JSON.stringify(before);
    const expected = await service.planFileMigration(before);
    assertCoverage(expected);
    assert.equal(JSON.stringify(before), serialized, "planning does not mutate the supplied archive snapshot");
    const after = await service.snapshotFullExportV10(db);
    assert.deepEqual(after.tables, before.tables, "host canonical and lifecycle rows stay unchanged");
    assert.deepEqual(after.artifacts, before.artifacts, "host source schema stays unchanged");
    await t.test("actual workerd executes the production exporter and planner without provider capabilities", async () => {
      await seed(await mf.getD1Database("DB"));
      const response = await mf.dispatchFetch("https://fixture.test/plan");
      assert.equal(response.status, 200, await response.clone().text());
      const actual = await response.json();
      assertCoverage(actual.plan);
      assert.deepEqual(actual.after.tables, actual.before.tables);
      assert.deepEqual(actual.after.artifacts, actual.before.artifacts);
      assert.deepEqual(semantic(actual.plan), semantic(expected),
        "only snapshot timestamp/platform schema evidence may differ; canonical plans must be identical");
    });
    await t.test("the mandatory archive protocol rehearsal preserves plan identity and does not mutate the source", async () => {
      // This is an isolated recovery-contract fixture, not deferred browser ZIP
      // acceptance or a test of arbitrary ZIP file ingestion.
      const provider = new Map([["same-key", "same"], ["unhashed-key", "data"], ["live-preview", "live"], ["expired-preview", "expired"]]);
      const byUrl = new Map(before.blobs.map((entry) => [entry.downloadUrl, entry]));
      const archive = await service.buildFullExportArchiveV10(before, undefined, async (url) => {
        const entry = byUrl.get(String(url));
        const value = entry?.storeKind === "managed" && entry.objectKey === "same-key" ? "managed" : provider.get(entry?.objectKey);
        return value === undefined ? new Response(null, { status: 404 }) : new Response(value);
      });
      const archivePath = join(scratch, "protocol-fixture.zip");
      await writeFile(archivePath, Buffer.from(await archive.archive.arrayBuffer()));
      const archiveHash = hash(await readFile(archivePath));
      // This qualification binds a frozen V10 snapshot to the same V10 target.
      // V10-to-current forward restoration is covered by export-v10-protocol.
      const migrationsDirectory = join(scratch, "v10-migrations");
      await mkdir(migrationsDirectory);
      for (const name of ["0001_v3_baseline.sql", "0002_fp1_file_registry.sql", "0003_fp1_import_acceptance.sql"]) {
        await writeFile(join(migrationsDirectory, name), read(`migrations/${name}`));
      }
      const restored = await service.restoreExportToIsolatedDirectory({ archivePath, destination: join(scratch, "restored-plan"),
        migrationsDirectory, targetCompatibilitySchema: "S2" });
      assert.equal(restored.report.schemaVersion, 10);
      assert.equal(restored.report.verification.rowsEqual, true);
      assert.equal(restored.report.verification.foreignKeys, true);
      assert(restored.report.restoredBlobCount > 0, "the rehearsal restores real packaged bytes as well as unavailable historical locators");
      assert(restored.report.warnings.some((warning) => warning.code === "missing"));
      const recovered = new DatabaseSync(join(restored.restoredDirectory, "database.sqlite"));
      try {
        const recoveredManifest = await service.snapshotFullExportV10(hostAdapter(recovered));
        const recoveredPlan = await service.planFileMigration(recoveredManifest);
        assertCoverage(recoveredPlan);
        assert.deepEqual(semantic(recoveredPlan), semantic(expected));
        assert.deepEqual(recoveredManifest.tables, before.tables, "all populated canonical and historical rows survive restore");
        assert.throws(() => recovered.exec("UPDATE files SET state = 'ready' WHERE id = 'observed-shared'"), /immutable|unresolved|constraint/i);
      } finally { recovered.close(); }
      assert.equal(hash(await readFile(archivePath)), archiveHash);
      assert.deepEqual((await service.snapshotFullExportV10(db)).tables, before.tables);
    });
  } finally { host.close(); await mf.dispose(); await rm(scratch, { recursive: true, force: true }); }
});
