import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { reapStaleFabubloxImports } from "./fabublox-import-recovery";
import { SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const migrationDirectory = new URL("../migrations/", import.meta.url);
const migrationNames = () => readdirSync(migrationDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort();

function applyMigrations(
  database: DatabaseSync,
  predicate: (name: string) => boolean,
) {
  for (const filename of migrationNames().filter(predicate)) {
    database.exec(readFileSync(new URL(filename, migrationDirectory), "utf8"));
  }
}

describe("blob lifecycle migration safety", () => {
  it("applies thumbnail retention over malformed legacy event metadata", () => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(database, (name) => name < "0017_blob_lifecycle_review_fixes.sql");
    database.exec(`
      INSERT INTO samples (id, code, title, created_at, updated_at)
      VALUES ('sample-1', 'S-1', 'Sample', '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z');
      INSERT INTO events
        (id, sample_id, kind, metadata_json, created_at)
      VALUES
        ('event-malformed', 'sample-1', 'comment', '{not-json',
          '2026-07-01T00:00:00.000Z'),
        ('event-valid', 'sample-1', 'comment',
          '{"thumbnailKey":"records/thumbnail.bin"}',
          '2026-07-01T00:00:00.000Z');
      INSERT INTO assets
        (id, r2_key, original_name, mime_type, byte_size, status, sha256,
         created_at)
      VALUES ('asset-thumbnail', 'records/thumbnail.bin', 'thumbnail.bin',
        'application/octet-stream', 4, 'ready', '${"a".repeat(64)}',
        '2026-07-01T00:00:00.000Z');
    `);

    expect(() => database.exec(readFileSync(
      new URL("0017_blob_lifecycle_review_fixes.sql", migrationDirectory),
      "utf8",
    ))).not.toThrow();
    expect(database.prepare(
      `SELECT occurrence_id, retention_reason
       FROM blob_retention_edges
       WHERE object_key = 'records/thumbnail.bin'`,
    ).get()).toEqual({
      occurrence_id: "event-valid:thumbnail",
      retention_reason: "sample_record_thumbnail",
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM blob_retention_edges WHERE occurrence_id = 'event-malformed:thumbnail'",
    ).get()).toEqual({ count: 0 });
    database.close();
  });

  it("upgrades through-0024 partial imports, blocks unpublished SQL edges, and recovers legacy failed rows", async () => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(database, (name) => name <= "0024_blob_integrity_quarantine.sql");
    database.exec(`
      INSERT INTO recipe_families (id, name, template_type, created_at)
      VALUES
        ('legacy-failed-family', 'Legacy failed family', 'process', '2026-07-01T00:00:00.000Z'),
        ('legacy-pending-family', 'Legacy pending family', 'process', '2026-07-01T00:00:00.000Z'),
        ('standalone-family', 'Standalone family', 'process', '2026-07-01T00:00:00.000Z');

      INSERT INTO state_representations
        (hash, representation_type, content_json, created_at)
      VALUES
        ('legacy-failed-state', 'diagram', '{}', '2026-07-01T00:00:00.000Z'),
        ('legacy-pending-state', 'diagram', '{}', '2026-07-01T00:00:00.000Z');

      INSERT INTO step_definitions (hash, name, canonical_json, created_at)
      VALUES
        ('legacy-failed-definition', 'Legacy failed step', '{}', '2026-07-01T00:00:00.000Z'),
        ('legacy-pending-definition', 'Legacy pending step', '{}', '2026-07-01T00:00:00.000Z'),
        ('standalone-definition', 'Standalone step', '{}', '2026-07-01T00:00:00.000Z');

      INSERT INTO template_versions
        (id, recipe_family_id, name, template_type, version, manifest_hash,
         initial_state_hash, source_asset_key, content_json, created_at, template_kind)
      VALUES
        ('legacy-failed-template', 'legacy-failed-family', 'Legacy failed template', 'process', 1,
          'legacy-failed-manifest', 'legacy-failed-state', 'imports/legacy-failed/image.png',
          '{}', '2026-07-01T00:00:00.000Z', 'process'),
        ('legacy-pending-template', 'legacy-pending-family', 'Legacy pending template', 'process', 1,
          'legacy-pending-manifest', 'legacy-pending-state', 'imports/legacy-pending/image.png',
          '{}', '2026-07-01T00:00:00.000Z', 'process'),
        ('standalone-template', 'standalone-family', 'Standalone template', 'process', 1,
          'standalone-manifest', NULL, NULL, '{}', '2026-07-01T00:00:00.000Z', 'process');

      INSERT INTO template_steps
        (id, template_version_id, logical_step_key, position, definition_hash,
         expected_state_hash, raw_json)
      VALUES
        ('legacy-failed-template-step', 'legacy-failed-template', 'legacy:failed', 0,
          'legacy-failed-definition', 'legacy-failed-state', '{}'),
        ('legacy-pending-template-step', 'legacy-pending-template', 'legacy:pending', 0,
          'legacy-pending-definition', 'legacy-pending-state', '{}'),
        ('standalone-template-step', 'standalone-template', 'standalone:step', 0,
          'standalone-definition', NULL, '{}');

      INSERT INTO imports
        (id, status, source_filename, source_sha256, sheet_name, template_type,
         recipe_family_id, template_version_id, workbook_asset_key, manifest_asset_key,
         actor_email, created_at, completed_at, operation_id, lease_expires_at)
      VALUES
        ('legacy-failed-import', 'failed', 'legacy-failed.zip', '${"1".repeat(64)}', 'manifest', 'process',
          'legacy-failed-family', 'legacy-failed-template', 'imports/legacy-failed/image.png',
          'imports/legacy-failed/image.png', 'legacy@example.com',
          '2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z',
          'legacy-failed-operation', NULL),
        ('legacy-pending-import', 'pending', 'legacy-pending.zip', '${"2".repeat(64)}', 'manifest', 'process',
          'legacy-pending-family', 'legacy-pending-template', 'imports/legacy-pending/image.png',
          'imports/legacy-pending/image.png', 'legacy@example.com',
          '2026-07-01T00:00:00.000Z', NULL, 'legacy-pending-operation',
          '2026-07-02T00:00:00.000Z');

      INSERT INTO assets
        (id, import_id, r2_key, original_name, mime_type, byte_size, status,
         sha256, created_at)
      VALUES
        ('legacy-failed-asset', 'legacy-failed-import', 'imports/legacy-failed/image.png',
          'image.png', 'image/png', 10, 'ready', '${"b".repeat(64)}',
          '2026-07-01T00:00:00.000Z'),
        ('legacy-pending-asset', 'legacy-pending-import', 'imports/legacy-pending/image.png',
          'image.png', 'image/png', 11, 'pending', '${"c".repeat(64)}',
          '2026-07-01T00:00:00.000Z'),
        ('legacy-reused-winner', NULL, 'ready/reused-winner.png',
          'winner.png', 'image/png', 12, 'ready', '${"d".repeat(64)}',
          '2026-06-01T00:00:00.000Z');

      INSERT INTO state_representation_assets (state_hash, asset_id, position)
      VALUES
        ('legacy-failed-state', 'legacy-reused-winner', 0),
        ('legacy-pending-state', 'legacy-pending-asset', 0);

      INSERT INTO samples (id, code, title, created_at, updated_at)
      VALUES ('legacy-sample', 'LEGACY', 'Legacy sample',
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');

      INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, sequence_no,
         run_group_id, template_name_snapshot, template_type_snapshot,
         template_version_snapshot, status, created_at, run_kind)
      VALUES
        ('legacy-run', 'legacy-sample', 'legacy-failed-family', 'legacy-failed-template', 1,
         'legacy-run-group', 'Legacy failed template', 'process', 1, 'cancelled',
         '2026-07-01T01:00:00.000Z', 'process');

      INSERT INTO run_plan_revisions
        (id, run_id, revision_no, template_version_id, created_at)
      VALUES ('legacy-plan', 'legacy-run', 1, 'legacy-failed-template',
        '2026-07-01T01:00:00.000Z');

      INSERT INTO run_steps
        (id, run_id, position, origin, plan_status, template_step_id,
         definition_hash, expected_state_hash, title, status, entry_kind,
         created_at, updated_at)
      VALUES
        ('legacy-run-step-1', 'legacy-run', 0, 'template', 'current',
          'legacy-failed-template-step', 'legacy-failed-definition', 'legacy-failed-state',
          'Failed staged step', 'pending', 'fabrication',
          '2026-07-01T02:00:00.000Z', '2026-07-01T02:00:00.000Z'),
        ('legacy-run-step-2', 'legacy-run', 1, 'template', 'current',
          'standalone-template-step', 'standalone-definition', NULL,
          'Standalone step 2', 'pending', 'fabrication',
          '2026-07-01T02:00:00.000Z', '2026-07-01T02:00:00.000Z'),
        ('legacy-run-step-3', 'legacy-run', 2, 'template', 'current',
          'standalone-template-step', 'standalone-definition', NULL,
          'Standalone step 3', 'pending', 'fabrication',
          '2026-07-01T02:00:00.000Z', '2026-07-01T02:00:00.000Z');

      INSERT INTO run_step_plan_links
        (run_plan_revision_id, template_step_id, run_step_id, relation, created_at)
      VALUES
        ('legacy-plan', 'legacy-failed-template-step', 'legacy-run-step-1', 'planned',
          '2026-07-01T02:00:00.000Z'),
        ('legacy-plan', 'standalone-template-step', 'legacy-run-step-2', 'planned',
          '2026-07-01T02:00:00.000Z');

      INSERT INTO events
        (id, sample_id, kind, asset_key, metadata_json, created_at)
      VALUES
        ('legacy-event-asset', 'legacy-sample', 'image', 'imports/legacy-failed/image.png',
          '{}', '2026-07-01T03:00:00.000Z'),
        ('legacy-event-thumbnail', 'legacy-sample', 'image', NULL,
          '{"thumbnailKey":"imports/legacy-failed/image.png"}',
          '2026-07-01T03:00:00.000Z'),
        ('clean-event-asset', 'legacy-sample', 'image', NULL, '{}',
          '2026-07-01T03:00:00.000Z'),
        ('clean-event-thumbnail', 'legacy-sample', 'image', NULL, '{}',
          '2026-07-01T03:00:00.000Z');
    `);

    expect(() => database.exec(readFileSync(
      new URL("0025_fabublox_publication_boundaries.sql", migrationDirectory),
      "utf8",
    ))).not.toThrow();

    expect(() => database.exec(`
      INSERT INTO run_steps
        (id, run_id, position, origin, plan_status, template_step_id,
         definition_hash, title, status, entry_kind, created_at, updated_at)
      VALUES ('blocked-run-step', 'legacy-run', 3, 'template', 'current',
        'legacy-failed-template-step', 'legacy-failed-definition', 'Blocked',
        'pending', 'fabrication', '2026-07-01T04:00:00.000Z',
        '2026-07-01T04:00:00.000Z');
    `)).toThrow(/template version is not published/);
    expect(() => database.exec(`
      UPDATE run_steps
      SET template_step_id = 'legacy-failed-template-step'
      WHERE id = 'legacy-run-step-2';
    `)).toThrow(/template version is not published/);
    expect(() => database.exec(`
      INSERT INTO run_step_plan_links
        (run_plan_revision_id, template_step_id, run_step_id, relation, created_at)
      VALUES ('legacy-plan', 'legacy-failed-template-step', 'legacy-run-step-3',
        'planned', '2026-07-01T04:00:00.000Z');
    `)).toThrow(/template version is not published/);
    expect(() => database.exec(`
      UPDATE run_step_plan_links
      SET template_step_id = 'legacy-failed-template-step'
      WHERE run_plan_revision_id = 'legacy-plan'
        AND template_step_id = 'standalone-template-step'
        AND run_step_id = 'legacy-run-step-2';
    `)).toThrow(/template version is not published/);
    expect(() => database.exec(`
      INSERT INTO events
        (id, sample_id, kind, asset_key, metadata_json, created_at)
      VALUES ('blocked-event-asset', 'legacy-sample', 'image',
        'imports/legacy-failed/image.png', '{}', '2026-07-01T04:00:00.000Z');
    `)).toThrow(/asset owning import is not ready/);
    expect(() => database.exec(`
      UPDATE events
      SET asset_key = 'imports/legacy-failed/image.png'
      WHERE id = 'clean-event-asset';
    `)).toThrow(/asset owning import is not ready/);
    expect(() => database.exec(`
      INSERT INTO events
        (id, sample_id, kind, metadata_json, created_at)
      VALUES ('blocked-event-thumbnail', 'legacy-sample', 'image',
        '{"thumbnailKey":"imports/legacy-failed/image.png"}',
        '2026-07-01T04:00:00.000Z');
    `)).toThrow(/asset owning import is not ready/);
    expect(() => database.exec(`
      UPDATE events
      SET metadata_json = '{"thumbnailKey":"imports/legacy-failed/image.png"}'
      WHERE id = 'clean-event-thumbnail';
    `)).toThrow(/asset owning import is not ready/);

    const env = { DB: new SqliteD1Database(database) } as unknown as Env;
    const recovery = await reapStaleFabubloxImports(
      env,
      new Date("2026-08-20T00:00:00.000Z"),
    );
    expect(recovery).toEqual({
      staleImportsFailed: 2,
      staleImportAssetsReleased: 1,
      staleImportObjectsQueued: 1,
      staleImportRecoveryFailures: 0,
    });

    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM template_steps
      WHERE template_version_id IN ('legacy-failed-template', 'legacy-pending-template')
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT template_step_id FROM run_steps WHERE id = 'legacy-run-step-1'
    `).get()).toEqual({ template_step_id: null });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM run_step_plan_links
      WHERE template_step_id = 'legacy-failed-template-step'
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM run_step_plan_links
      WHERE template_step_id = 'standalone-template-step'
        AND run_step_id = 'legacy-run-step-2'
    `).get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT asset_key FROM events WHERE id = 'legacy-event-asset'
    `).get()).toEqual({ asset_key: "imports/legacy-failed/image.png" });
    expect(database.prepare(`
      SELECT json_extract(metadata_json, '$.thumbnailKey') AS thumbnail_key
      FROM events WHERE id = 'legacy-event-thumbnail'
    `).get()).toEqual({ thumbnail_key: "imports/legacy-failed/image.png" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM state_representation_assets
      WHERE state_hash IN ('legacy-failed-state', 'legacy-pending-state')
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT workbook_asset_key, manifest_asset_key,
             recovery_operation_id IS NOT NULL AS recovered
      FROM imports WHERE id = 'legacy-failed-import'
    `).get()).toEqual({
      workbook_asset_key: null,
      manifest_asset_key: null,
      recovered: 1,
    });
    expect(database.prepare(`
      SELECT source_asset_key, initial_state_hash,
             archived_at IS NOT NULL AS archived,
             deleted_at IS NOT NULL AS deleted
      FROM template_versions WHERE id = 'legacy-failed-template'
    `).get()).toEqual({
      source_asset_key: null,
      initial_state_hash: null,
      archived: 1,
      deleted: 1,
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM blob_retention_edges
      WHERE object_key = 'imports/legacy-failed/image.png'
    `).get()).toEqual({ count: 2 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM blob_retention_edges
      WHERE object_key IN (
        'imports/legacy-pending/image.png',
        'ready/reused-winner.png'
      )
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM blob_gc_ledger
      WHERE state = 'orphaned'
        AND object_key = 'imports/legacy-pending/image.png'
    `).get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM blob_gc_ledger
      WHERE object_key = 'imports/legacy-failed/image.png'
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM assets
      WHERE import_id IN ('legacy-failed-import', 'legacy-pending-import')
        AND status = 'failed' AND sha256 IS NULL
    `).get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT import_id, status, sha256
      FROM assets WHERE id = 'legacy-failed-asset'
    `).get()).toEqual({
      import_id: null,
      status: "ready",
      sha256: "b".repeat(64),
    });
    expect(database.prepare(`
      SELECT status, sha256 FROM assets WHERE id = 'legacy-reused-winner'
    `).get()).toEqual({ status: "ready", sha256: "d".repeat(64) });
    database.close();
  });

  it("preserves A-to-B deduplication, Run/Sample state images, and event attachments during through-0024 recovery", async () => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(database, (name) => name <= "0024_blob_integrity_quarantine.sql");
    database.exec(`
      INSERT INTO recipe_families (id, name, template_type, created_at)
      VALUES
        ('failed-family', 'Failed import family', 'process', '2026-07-01T00:00:00.000Z'),
        ('ready-family', 'Ready import family', 'process', '2026-07-01T00:00:00.000Z'),
        ('run-family', 'Independent run family', 'process', '2026-07-01T00:00:00.000Z');

      INSERT INTO state_representations
        (hash, representation_type, content_json, created_at)
      VALUES
        ('shared-import-state', 'diagram', '{}', '2026-07-01T00:00:00.000Z'),
        ('independent-run-state', 'diagram', '{}', '2026-07-01T00:00:00.000Z'),
        ('inherited-sample-state', 'diagram', '{}', '2026-07-01T00:00:00.000Z');

      INSERT INTO step_definitions (hash, name, canonical_json, created_at)
      VALUES
        ('shared-definition', 'Shared state', '{}', '2026-07-01T00:00:00.000Z'),
        ('run-state-definition', 'Run state', '{}', '2026-07-01T00:00:00.000Z'),
        ('sample-state-definition', 'Sample state', '{}', '2026-07-01T00:00:00.000Z'),
        ('independent-definition', 'Independent step', '{}', '2026-07-01T00:00:00.000Z');

      INSERT INTO template_versions
        (id, recipe_family_id, name, template_type, version, manifest_hash,
         initial_state_hash, source_asset_key, content_json, created_at, template_kind)
      VALUES
        ('failed-template-a', 'failed-family', 'Failed template A', 'process', 1,
          'failed-manifest-a', 'shared-import-state', 'imports/a/workbook.bin',
          '{}', '2026-07-01T00:00:00.000Z', 'process'),
        ('ready-template-b', 'ready-family', 'Ready template B', 'process', 1,
          'ready-manifest-b', 'shared-import-state', NULL,
          '{}', '2026-07-01T00:00:00.000Z', 'process'),
        ('independent-template', 'run-family', 'Independent template', 'process', 1,
          'independent-manifest', NULL, NULL,
          '{}', '2026-07-01T00:00:00.000Z', 'process');

      INSERT INTO template_steps
        (id, template_version_id, logical_step_key, position, definition_hash,
         expected_state_hash, raw_json)
      VALUES
        ('failed-shared-step', 'failed-template-a', 'failed:shared', 0,
          'shared-definition', 'shared-import-state', '{}'),
        ('failed-run-state-step', 'failed-template-a', 'failed:run-state', 1,
          'run-state-definition', 'independent-run-state', '{}'),
        ('failed-sample-state-step', 'failed-template-a', 'failed:sample-state', 2,
          'sample-state-definition', 'inherited-sample-state', '{}'),
        ('ready-shared-step', 'ready-template-b', 'ready:shared', 0,
          'shared-definition', 'shared-import-state', '{}'),
        ('independent-template-step', 'independent-template', 'independent:step', 0,
          'independent-definition', NULL, '{}');

      INSERT INTO imports
        (id, status, source_filename, source_sha256, sheet_name, template_type,
         recipe_family_id, template_version_id, workbook_asset_key, manifest_asset_key,
         actor_email, created_at, completed_at, operation_id, lease_expires_at)
      VALUES
        ('failed-import-a', 'failed', 'a.zip', '${"1".repeat(64)}', 'manifest', 'process',
          'failed-family', 'failed-template-a', 'imports/a/workbook.bin',
          'imports/a/manifest.json', 'legacy@example.com',
          '2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z',
          'failed-operation-a', NULL),
        ('ready-import-b', 'ready', 'b.zip', '${"2".repeat(64)}', 'manifest', 'process',
          'ready-family', 'ready-template-b', NULL, NULL, 'ready@example.com',
          '2026-07-01T00:30:00.000Z', '2026-07-01T02:00:00.000Z',
          'ready-operation-b', NULL);

      INSERT INTO assets
        (id, import_id, r2_key, original_name, mime_type, byte_size, status,
         sha256, created_at)
      VALUES
        ('shared-asset-a', 'failed-import-a', 'imports/a/shared.png',
          'shared.png', 'image/png', 10, 'ready', '${"a".repeat(64)}',
          '2026-07-01T00:00:00.000Z'),
        ('run-state-asset-a', 'failed-import-a', 'imports/a/run-state.png',
          'run-state.png', 'image/png', 11, 'ready', '${"b".repeat(64)}',
          '2026-07-01T00:00:00.000Z'),
        ('sample-state-asset-a', 'failed-import-a', 'imports/a/sample-state.png',
          'sample-state.png', 'image/png', 12, 'ready', '${"c".repeat(64)}',
          '2026-07-01T00:00:00.000Z'),
        ('event-asset-a', 'failed-import-a', 'imports/a/event.png',
          'event.png', 'image/png', 13, 'ready', '${"d".repeat(64)}',
          '2026-07-01T00:00:00.000Z');

      INSERT INTO state_representation_assets (state_hash, asset_id, position)
      VALUES
        ('shared-import-state', 'shared-asset-a', 0),
        ('independent-run-state', 'run-state-asset-a', 0),
        ('inherited-sample-state', 'sample-state-asset-a', 0);

      INSERT INTO samples
        (id, code, title, inherited_state_hash, created_at, updated_at)
      VALUES
        ('run-sample', 'RUN-SAMPLE', 'Run sample', NULL,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
        ('inherited-sample', 'INHERITED-SAMPLE', 'Inherited sample',
          'inherited-sample-state', '2026-07-01T00:00:00.000Z',
          '2026-07-01T00:00:00.000Z'),
        ('event-sample', 'EVENT-SAMPLE', 'Event sample', NULL,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');

      INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, sequence_no,
         run_group_id, template_name_snapshot, template_type_snapshot,
         template_version_snapshot, status, created_at, run_kind, initial_state_hash)
      VALUES
        ('independent-run', 'run-sample', 'run-family', 'independent-template', 1,
          'independent-run-group', 'Independent template', 'process', 1,
          'complete', '2026-07-01T03:00:00.000Z', 'process',
          'independent-run-state');

      INSERT INTO events
        (id, sample_id, kind, asset_key, metadata_json, created_at)
      VALUES
        ('durable-event-primary', 'event-sample', 'image', 'imports/a/event.png',
          '{}', '2026-07-01T04:00:00.000Z'),
        ('durable-event-thumbnail', 'event-sample', 'image', NULL,
          '{"thumbnailKey":"imports/a/event.png"}',
          '2026-07-01T04:00:00.000Z');
    `);

    expect(() => database.exec(readFileSync(
      new URL("0025_fabublox_publication_boundaries.sql", migrationDirectory),
      "utf8",
    ))).not.toThrow();

    const env = { DB: new SqliteD1Database(database) } as unknown as Env;
    const recovery = await reapStaleFabubloxImports(
      env,
      new Date("2026-08-20T00:00:00.000Z"),
    );
    expect(recovery).toEqual({
      staleImportsFailed: 1,
      staleImportAssetsReleased: 0,
      staleImportObjectsQueued: 0,
      staleImportRecoveryFailures: 0,
    });

    expect(database.prepare(`
      SELECT status FROM imports WHERE id = 'ready-import-b'
    `).get()).toEqual({ status: "ready" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM state_representation_assets
      WHERE (state_hash = 'shared-import-state' AND asset_id = 'shared-asset-a')
         OR (state_hash = 'independent-run-state' AND asset_id = 'run-state-asset-a')
         OR (state_hash = 'inherited-sample-state' AND asset_id = 'sample-state-asset-a')
    `).get()).toEqual({ count: 3 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM template_versions tv
      JOIN template_steps ts ON ts.template_version_id = tv.id
      JOIN state_representation_assets sra ON sra.state_hash = ts.expected_state_hash
      WHERE tv.id = 'ready-template-b' AND sra.asset_id = 'shared-asset-a'
    `).get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM runs r
      JOIN state_representation_assets sra ON sra.state_hash = r.initial_state_hash
      WHERE r.id = 'independent-run' AND sra.asset_id = 'run-state-asset-a'
    `).get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM samples s
      JOIN state_representation_assets sra ON sra.state_hash = s.inherited_state_hash
      WHERE s.id = 'inherited-sample' AND sra.asset_id = 'sample-state-asset-a'
    `).get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT asset_key FROM events WHERE id = 'durable-event-primary'
    `).get()).toEqual({ asset_key: "imports/a/event.png" });
    expect(database.prepare(`
      SELECT json_extract(metadata_json, '$.thumbnailKey') AS thumbnail_key
      FROM events WHERE id = 'durable-event-thumbnail'
    `).get()).toEqual({ thumbnail_key: "imports/a/event.png" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM assets
      WHERE id IN (
        'shared-asset-a', 'run-state-asset-a',
        'sample-state-asset-a', 'event-asset-a'
      )
        AND import_id IS NULL AND status = 'ready' AND sha256 IS NOT NULL
    `).get()).toEqual({ count: 4 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM blob_gc_ledger
      WHERE object_key IN (
        'imports/a/shared.png', 'imports/a/run-state.png',
        'imports/a/sample-state.png', 'imports/a/event.png'
      )
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM blob_retention_edges
      WHERE object_key IN (
        'imports/a/shared.png', 'imports/a/run-state.png',
        'imports/a/sample-state.png', 'imports/a/event.png'
      )
    `).get()).toEqual({ count: 5 });
    database.close();
  });
});
