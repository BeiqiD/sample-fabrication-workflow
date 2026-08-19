import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(filename, directory), "utf8"));
  }
  return database;
}

function seedSourceGraph(database: DatabaseSync) {
  database.exec(`
    INSERT INTO samples (id, code, title, created_at, updated_at)
    VALUES ('sample-1', 'S-1', 'Sample', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    INSERT INTO recipe_families (id, name, template_type, created_at)
    VALUES ('family-1', 'Process', 'process', '2026-07-01T00:00:00.000Z');
    INSERT INTO template_versions
      (id, recipe_family_id, name, template_type, version, manifest_hash,
       content_json, created_at, source_asset_key)
    VALUES ('template-1', 'family-1', 'Process', 'process', 1, 'manifest-1',
      '{}', '2026-07-01T00:00:00.000Z', 'direct/template.json');
    INSERT INTO runs
      (id, sample_id, recipe_family_id, template_version_id, sequence_no,
       run_group_id, template_name_snapshot, template_type_snapshot,
       template_version_snapshot, status, created_at)
    VALUES ('run-1', 'sample-1', 'family-1', 'template-1', 1, 'group-1',
      'Process', 'process', 1, 'complete', '2026-07-01T00:00:00.000Z');
    INSERT INTO run_steps
      (id, run_id, position, title, status, created_at, updated_at)
    VALUES ('step-1', 'run-1', 1000, 'Step', 'done',
      '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    INSERT INTO state_representations (hash, content_json, created_at)
    VALUES ('state-1', '{}', '2026-07-01T00:00:00.000Z');
  `);
}

function addAsset(database: DatabaseSync, id: string) {
  database.prepare(
    `INSERT INTO assets
      (id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at)
     VALUES (?, ?, ?, 'application/octet-stream', 4, 'ready', ?, '2026-07-01T00:00:00.000Z')`,
  ).run(id, `blobs/${id}.bin`, `${id}.bin`, id.padEnd(64, "0").slice(0, 64));
}

describe("blob retention reachability", () => {
  it("repairs a legacy orphan mark when an unfinished submission still retains the object", () => {
    const database = new DatabaseSync(":memory:");
    const directory = new URL("../migrations/", import.meta.url);
    const migrations = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
    for (const filename of migrations.filter((name) => name < "0016_blob_lifecycle_control.sql")) {
      database.exec(readFileSync(new URL(filename, directory), "utf8"));
    }
    database.exec(`
      INSERT INTO samples (id, code, title, created_at, updated_at)
      VALUES ('sample-1', 'S-1', 'Sample', '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z');
      INSERT INTO managed_storage_objects
        (id, provider, object_key, original_name, mime_type, byte_size, sha256,
         status, created_at, orphaned_at)
      VALUES ('managed-legacy', 'switchdrive', 'legacy/shared.bin', 'shared.bin',
        'application/octet-stream', 4, '${"f".repeat(64)}', 'orphaned',
        '2026-07-01T00:00:00.000Z', '2026-07-10T00:00:00.000Z');
      INSERT INTO comment_submissions
        (id, context_kind, sample_id, body, status, created_at, updated_at)
      VALUES ('submission-legacy', 'sample', 'sample-1', 'Unfinished', 'uploading',
        '2026-07-01T00:00:00.000Z', '2026-07-10T00:00:00.000Z');
      INSERT INTO comment_submission_items
        (id, submission_id, kind, status, position, storage_object_id, created_at, updated_at)
      VALUES ('item-legacy', 'submission-legacy', 'attachment', 'ready', 0,
        'managed-legacy', '2026-07-01T00:00:00.000Z', '2026-07-10T00:00:00.000Z');
    `);
    database.exec(readFileSync(new URL("0016_blob_lifecycle_control.sql", directory), "utf8"));
    expect(database.prepare(
      "SELECT status, orphaned_at FROM managed_storage_objects WHERE id = 'managed-legacy'",
    ).get()).toEqual({ status: "ready", orphaned_at: null });
    expect(database.prepare("SELECT COUNT(*) AS count FROM blob_gc_ledger").get())
      .toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT retention_reason FROM blob_retention_edges WHERE object_key = 'legacy/shared.bin'",
    ).get()).toEqual({ retention_reason: "unfinished_comment_item" });
    database.close();
  });

  it("materializes every current durable, unfinished, retry, and provenance edge", () => {
    const database = migratedDatabase();
    seedSourceGraph(database);
    for (const id of ["state", "run", "metrology", "legacy", "verification", "ready", "retry", "closed", "uploading", "cancelled"]) {
      addAsset(database, `asset-${id}`);
    }
    database.exec(`
      INSERT INTO state_representation_assets (state_hash, asset_id, position)
      VALUES ('state-1', 'asset-state', 0);
      INSERT INTO run_step_assets (id, run_step_id, asset_id, role, created_at)
      VALUES ('run-asset-1', 'step-1', 'asset-run', 'execution', '2026-07-01T00:00:00.000Z');
      INSERT INTO metrology_template_references
        (id, template_version_id, asset_id, display_name, created_at)
      VALUES ('reference-1', 'template-1', 'asset-metrology', 'Reference', '2026-07-01T00:00:00.000Z');
      INSERT INTO run_step_comments
        (id, run_step_id, scope, body, asset_id, created_at)
      VALUES ('legacy-comment-1', 'step-1', 'individual', 'Legacy', 'asset-legacy',
        '2026-07-01T00:00:00.000Z');
      INSERT INTO state_verifications
        (id, sample_id, after_run_step_id, result, evidence_asset_id, created_at)
      VALUES ('verification-1', 'sample-1', 'step-1', 'matched', 'asset-verification',
        '2026-07-01T00:00:00.000Z');
      INSERT INTO events
        (id, sample_id, kind, asset_key, created_at)
      VALUES ('event-1', 'sample-1', 'image', 'direct/event.bin', '2026-07-01T00:00:00.000Z');
      INSERT INTO imports
        (id, status, source_filename, source_sha256, sheet_name, template_type,
         workbook_asset_key, manifest_asset_key, created_at)
      VALUES ('import-1', 'ready', 'source.xlsx', 'hash', 'Sheet1', 'process',
        'direct/workbook.xlsx', 'direct/manifest.json', '2026-07-01T00:00:00.000Z');

      INSERT INTO comment_submissions
        (id, context_kind, sample_id, body, status, created_at, updated_at,
         retry_until, retry_closed_at)
      VALUES
        ('comment-ready', 'sample', 'sample-1', 'Ready', 'ready',
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', NULL,
          '2026-07-01T00:00:00.000Z'),
        ('comment-retry', 'sample', 'sample-1', 'Retry', 'failed',
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z', NULL),
        ('comment-closed', 'sample', 'sample-1', 'Closed', 'failed',
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
          '2026-07-02T00:00:00.000Z', '2026-07-03T00:00:00.000Z'),
        ('comment-uploading', 'sample', 'sample-1', 'Uploading', 'uploading',
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z', NULL),
        ('comment-cancelled', 'sample', 'sample-1', 'Cancelled', 'cancelled',
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', NULL,
          '2026-07-01T00:00:00.000Z');
      INSERT INTO comment_submission_items
        (id, submission_id, kind, status, position, asset_id, created_at, updated_at)
      VALUES
        ('item-ready', 'comment-ready', 'comment_image', 'ready', 0, 'asset-ready',
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
        ('item-retry', 'comment-retry', 'comment_image', 'ready', 0, 'asset-retry',
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
        ('item-closed', 'comment-closed', 'comment_image', 'ready', 0, 'asset-closed',
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
        ('item-uploading', 'comment-uploading', 'comment_image', 'ready', 0, 'asset-uploading',
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
        ('item-cancelled', 'comment-cancelled', 'comment_image', 'ready', 0, 'asset-cancelled',
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');

      INSERT INTO run_step_assets
        (id, run_step_id, asset_id, role, created_at, deleted_at)
      VALUES ('cross-type-soft-deleted', 'step-1', 'asset-state', 'state_observation',
        '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
      UPDATE template_versions
      SET archived_at = '2026-08-01T00:00:00.000Z'
      WHERE id = 'template-1';
      UPDATE metrology_template_references
      SET deleted_at = '2026-08-01T00:00:00.000Z'
      WHERE id = 'reference-1';
    `);

    const reasons = new Set((database.prepare(
      "SELECT retention_reason FROM blob_retention_edges",
    ).all() as { retention_reason: string }[]).map((row) => row.retention_reason));
    expect([...reasons]).toEqual(expect.arrayContaining([
      "state_representation",
      "run_step_asset",
      "metrology_template_reference",
      "legacy_comment_asset",
      "verification_evidence",
      "ready_comment_item",
      "retryable_comment_item",
      "unfinished_comment_item",
      "legacy_event_asset",
      "import_provenance",
      "template_provenance",
    ]));
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM blob_retention_edges
       WHERE object_key IN ('blobs/asset-closed.bin', 'blobs/asset-cancelled.bin')`,
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      `SELECT retention_reason FROM blob_retention_edges
       WHERE object_key = 'blobs/asset-state.bin' ORDER BY retention_reason`,
    ).all()).toEqual([
      { retention_reason: "state_representation" },
    ]);
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM blob_retention_edges
       WHERE source_type = 'template_version' AND source_id = 'template-1'`,
    ).get()).toEqual({ count: 2 });
    database.close();
  });

  it("atomically releases orphan state on edge creation and rejects claimed locators", () => {
    const database = migratedDatabase();
    seedSourceGraph(database);
    addAsset(database, "asset-orphan");
    addAsset(database, "asset-claimed");
    database.exec(`
      INSERT INTO blob_gc_ledger
        (store_kind, provider, object_key, blob_record_id, state, operation_id,
         orphaned_at, updated_at)
      VALUES
        ('r2', 'r2', 'blobs/asset-orphan.bin', 'asset-orphan', 'orphaned', 'mark-1',
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
        ('r2', 'r2', 'blobs/asset-claimed.bin', 'asset-claimed', 'deleting', 'delete-1',
          '2026-07-01T00:00:00.000Z', '2026-07-10T00:00:00.000Z');
    `);
    database.prepare(
      `INSERT INTO run_step_assets (id, run_step_id, asset_id, role, created_at)
       VALUES ('edge-orphan', 'step-1', 'asset-orphan', 'execution', '2026-07-10T00:00:00.000Z')`,
    ).run();
    expect(database.prepare(
      "SELECT state FROM blob_gc_ledger WHERE object_key = 'blobs/asset-orphan.bin'",
    ).get()).toBeUndefined();
    expect(() => database.prepare(
      `INSERT INTO run_step_assets (id, run_step_id, asset_id, role, created_at)
       VALUES ('edge-claimed', 'step-1', 'asset-claimed', 'state_observation',
         '2026-07-10T00:00:00.000Z')`,
    ).run()).toThrow(/blob locator is unavailable/);
    database.close();
  });
  it("bounds explicit Run attachment deletion without weakening Run trash or shared retention", () => {
    const database = migratedDatabase();
    seedSourceGraph(database);
    for (const id of ["active", "recent", "expired", "shared", "trash"]) {
      addAsset(database, `asset-run-${id}`);
    }
    database.exec(`
      INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, sequence_no,
         run_group_id, template_name_snapshot, template_type_snapshot,
         template_version_snapshot, status, created_at, deleted_at, deleted_by)
      VALUES
        ('run-trash', 'sample-1', 'family-1', 'template-1', 2, 'group-trash',
         'Process', 'process', 1, 'complete',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'), 'user@example.com');

      INSERT INTO run_steps
        (id, run_id, position, title, status, created_at, updated_at)
      VALUES
        ('step-trash', 'run-trash', 1000, 'Deleted Run step', 'done',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'));

      INSERT INTO run_step_assets
        (id, run_step_id, asset_id, role, created_at, deleted_at)
      VALUES
        ('run-active-edge', 'step-1', 'asset-run-active', 'execution',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days'), NULL),
        ('run-recent-edge', 'step-1', 'asset-run-recent', 'execution',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-23 hours')),
        ('run-expired-edge', 'step-1', 'asset-run-expired', 'execution',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours')),
        ('run-shared-edge', 'step-1', 'asset-run-shared', 'state_observation',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours')),
        ('run-trash-edge', 'step-trash', 'asset-run-trash', 'execution',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days'), NULL);

      INSERT INTO state_representation_assets (state_hash, asset_id, position)
      VALUES ('state-1', 'asset-run-shared', 0);
    `);

    expect(database.prepare(`
      SELECT retention_reason, retain_until
      FROM blob_retention_edges WHERE object_key = 'blobs/asset-run-active.bin'
    `).get()).toEqual({ retention_reason: "run_step_asset", retain_until: null });
    const recent = database.prepare(`
      SELECT retention_reason, retain_until
      FROM blob_retention_edges WHERE object_key = 'blobs/asset-run-recent.bin'
    `).get() as { retention_reason: string; retain_until: string };
    expect(recent.retention_reason).toBe("deleted_run_step_asset_grace");
    expect(Date.parse(recent.retain_until)).toBeGreaterThan(Date.now());
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM blob_retention_edges WHERE object_key = 'blobs/asset-run-expired.bin'
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT retention_reason
      FROM blob_retention_edges WHERE object_key = 'blobs/asset-run-shared.bin'
      ORDER BY retention_reason
    `).all()).toEqual([{ retention_reason: "state_representation" }]);
    expect(database.prepare(`
      SELECT retention_reason, retain_until
      FROM blob_retention_edges WHERE object_key = 'blobs/asset-run-trash.bin'
    `).get()).toEqual({ retention_reason: "run_step_asset", retain_until: null });
    database.close();
  });
  it("keeps whole-Comment Trash durable and reclaims an ordinary Run-attachment orphan on restore", () => {
    const database = migratedDatabase();
    seedSourceGraph(database);
    addAsset(database, "asset-run-reactivate");
    addAsset(database, "asset-run-claimed");
    database.exec(`
      INSERT INTO run_step_assets
        (id, run_step_id, asset_id, role, created_at, deleted_at)
      VALUES
        ('run-reactivate-edge', 'step-1', 'asset-run-reactivate', 'execution',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours')),
        ('run-claimed-edge', 'step-1', 'asset-run-claimed', 'state_observation',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours'));
      INSERT INTO blob_gc_ledger
        (store_kind, provider, object_key, blob_record_id, state,
         operation_id, orphaned_at, deletion_started_at, updated_at)
      VALUES
        ('r2', 'r2', 'blobs/asset-run-reactivate.bin', 'asset-run-reactivate',
         'orphaned', 'orphan-reactivate',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour'), NULL,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')),
        ('r2', 'r2', 'blobs/asset-run-claimed.bin', 'asset-run-claimed',
         'deleting', 'delete-claimed',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute'));

      INSERT INTO managed_storage_objects
        (id, provider, object_key, original_name, mime_type, byte_size,
         sha256, status, created_at)
      VALUES ('managed-comment-trash', 'switchdrive', 'comments/trash.dat',
        'trash.dat', 'application/octet-stream', 4, '${"9".repeat(64)}',
        'ready', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'));
      INSERT INTO comment_submissions
        (id, context_kind, sample_id, body, status, created_at, updated_at,
         deleted_at, deleted_by)
      VALUES ('comment-trash', 'sample', 'sample-1', 'Trashed comment', 'ready',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'), 'user@example.com');
      INSERT INTO comment_submission_items
        (id, submission_id, kind, status, position, filename, mime_type,
         byte_size, sha256, storage_object_id, created_at, updated_at)
      VALUES ('comment-trash-item', 'comment-trash', 'attachment', 'ready', 0,
        'trash.dat', 'application/octet-stream', 4, '${"9".repeat(64)}',
        'managed-comment-trash',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'));
    `);

    database.prepare(`
      UPDATE run_step_assets SET deleted_at = NULL
      WHERE id = 'run-reactivate-edge'
    `).run();
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM blob_gc_ledger
      WHERE object_key = 'blobs/asset-run-reactivate.bin'
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT retention_reason FROM blob_retention_edges
      WHERE object_key = 'blobs/asset-run-reactivate.bin'
    `).get()).toEqual({ retention_reason: "run_step_asset" });

    expect(() => database.prepare(`
      UPDATE run_step_assets SET deleted_at = NULL
      WHERE id = 'run-claimed-edge'
    `).run()).toThrow(/blob locator is unavailable/);
    expect(database.prepare(`
      SELECT deleted_at IS NOT NULL AS deleted
      FROM run_step_assets WHERE id = 'run-claimed-edge'
    `).get()).toEqual({ deleted: 1 });

    expect(database.prepare(`
      SELECT retention_reason, retain_until FROM blob_retention_edges
      WHERE store_kind = 'managed' AND object_key = 'comments/trash.dat'
    `).get()).toEqual({ retention_reason: "ready_comment_item", retain_until: null });
    database.close();
  });
  it("reclaims a deleted Comment child orphan on restore and rejects a claimed locator", () => {
    const database = migratedDatabase();
    seedSourceGraph(database);
    database.exec(`
      INSERT INTO managed_storage_objects
        (id, provider, object_key, original_name, mime_type, byte_size,
         sha256, status, created_at)
      VALUES
        ('managed-comment-restore', 'switchdrive', 'comments/restore.dat',
         'restore.dat', 'application/octet-stream', 4, '${"a".repeat(64)}',
         'ready', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days')),
        ('managed-comment-claimed', 'switchdrive', 'comments/claimed.dat',
         'claimed.dat', 'application/octet-stream', 4, '${"b".repeat(64)}',
         'ready', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'));

      INSERT INTO comment_submissions
        (id, context_kind, sample_id, body, status, created_at, updated_at)
      VALUES
        ('comment-restore', 'sample', 'sample-1', 'Restore child', 'ready',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days')),
        ('comment-claimed', 'sample', 'sample-1', 'Claimed child', 'ready',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days'));

      INSERT INTO comment_submission_items
        (id, submission_id, kind, status, position, filename, mime_type,
         byte_size, sha256, storage_object_id, created_at, updated_at,
         deleted_at, deleted_by)
      VALUES
        ('comment-restore-item', 'comment-restore', 'attachment', 'ready', 0,
         'restore.dat', 'application/octet-stream', 4, '${"a".repeat(64)}',
         'managed-comment-restore',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours'), 'user@example.com'),
        ('comment-claimed-item', 'comment-claimed', 'attachment', 'ready', 0,
         'claimed.dat', 'application/octet-stream', 4, '${"b".repeat(64)}',
         'managed-comment-claimed',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours'), 'user@example.com');

      INSERT INTO blob_gc_ledger
        (store_kind, provider, object_key, blob_record_id, state,
         operation_id, orphaned_at, deletion_started_at, updated_at)
      VALUES
        ('managed', 'switchdrive', 'comments/restore.dat',
         'managed-comment-restore', 'orphaned', 'orphan-comment-restore',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour'), NULL,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')),
        ('managed', 'switchdrive', 'comments/claimed.dat',
         'managed-comment-claimed', 'deleting', 'delete-comment-claimed',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 days'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute'));
    `);

    database.prepare(`
      UPDATE comment_submission_items SET deleted_at = NULL, deleted_by = NULL
      WHERE id = 'comment-restore-item'
    `).run();
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM blob_gc_ledger
      WHERE object_key = 'comments/restore.dat'
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT retention_reason, retain_until FROM blob_retention_edges
      WHERE store_kind = 'managed' AND object_key = 'comments/restore.dat'
    `).get()).toEqual({ retention_reason: "ready_comment_item", retain_until: null });

    expect(() => database.prepare(`
      UPDATE comment_submission_items SET deleted_at = NULL, deleted_by = NULL
      WHERE id = 'comment-claimed-item'
    `).run()).toThrow(/blob locator is unavailable/);
    expect(database.prepare(`
      SELECT deleted_at IS NOT NULL AS deleted
      FROM comment_submission_items WHERE id = 'comment-claimed-item'
    `).get()).toEqual({ deleted: 1 });
    database.close();
  });
});
