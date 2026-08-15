import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BlobReuseProviderUnavailableError,
  findReusableManagedObject,
  findReusableR2Asset,
} from "./blob-lifecycle/reuse";
import {
  REFERENCE_FIXTURE_IDS,
  referenceTestDatabase,
  seedReferenceGraph,
  SqliteD1Database,
} from "./reference-test-support";
import type { Env } from "./types";

const NOW = "2026-08-14T18:00:00.000Z";
const SHA = "a".repeat(64);

type TestDatabase = ReturnType<typeof referenceTestDatabase>;

function insertAsset(database: TestDatabase, input: { id: string; key: string; size?: number }) {
  database.prepare(`
    INSERT INTO assets (
      id, r2_key, original_name, mime_type, byte_size,
      status, actor_email, created_at, sha256
    ) VALUES (?, ?, 'file.bin', 'application/octet-stream', ?,
      'ready', 'user@example.com', ?, ?)
  `).run(input.id, input.key, input.size ?? 4, NOW, SHA);
}

function r2Environment(database: TestDatabase, head: (key: string) => Promise<unknown>) {
  return {
    DB: new SqliteD1Database(database) as unknown as D1Database,
    ASSETS: { head } as unknown as R2Bucket,
    AUTH_MODE: "disabled",
  } satisfies Env;
}

afterEach(() => vi.unstubAllGlobals());

describe("provider-verified blob reuse", () => {
  it("reuses an R2 locator only after a matching HEAD result", async () => {
    const database = referenceTestDatabase();
    insertAsset(database, { id: "asset-live", key: "objects/live.bin" });
    const head = vi.fn(async () => ({
      size: 4,
      httpEtag: '\"etag\"',
      writeHttpMetadata(headers: Headers) {
        headers.set("content-type", "application/octet-stream");
      },
    }));

    await expect(findReusableR2Asset(r2Environment(database, head), SHA))
      .resolves.toMatchObject({ id: "asset-live", r2_key: "objects/live.bin" });
    expect(head).toHaveBeenCalledWith("objects/live.bin");
    expect(database.prepare("SELECT COUNT(*) AS count FROM blob_integrity_quarantine").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("quarantines a definitely missing R2 locator and permits a fresh registration", async () => {
    const database = referenceTestDatabase();
    insertAsset(database, { id: "asset-missing", key: "objects/missing.bin" });
    await expect(findReusableR2Asset(r2Environment(database, async () => null), SHA))
      .resolves.toBeNull();
    expect(database.prepare(`
      SELECT reason, expected_byte_size, observed_byte_size
      FROM blob_integrity_quarantine
    `).get()).toEqual({
      reason: "missing",
      expected_byte_size: 4,
      observed_byte_size: null,
    });
    expect(database.prepare("SELECT status FROM assets WHERE id = 'asset-missing'").get())
      .toEqual({ status: "ready" });
    expect(() => insertAsset(database, { id: "asset-replacement", key: "objects/replacement.bin" }))
      .not.toThrow();
    database.close();
  });

  it("quarantines a definite size mismatch", async () => {
    const database = referenceTestDatabase();
    insertAsset(database, { id: "asset-mismatch", key: "objects/mismatch.bin" });
    await expect(findReusableR2Asset(r2Environment(database, async () => ({
      size: 7,
      httpEtag: null,
      writeHttpMetadata() {},
    })), SHA)).resolves.toBeNull();
    expect(database.prepare(`
      SELECT reason, expected_byte_size, observed_byte_size
      FROM blob_integrity_quarantine
    `).get()).toEqual({
      reason: "size_mismatch",
      expected_byte_size: 4,
      observed_byte_size: 7,
    });
    database.close();
  });

  it("keeps metadata untouched when R2 is temporarily unavailable", async () => {
    const database = referenceTestDatabase();
    insertAsset(database, { id: "asset-unavailable", key: "objects/unavailable.bin" });
    const env = r2Environment(database, async () => {
      throw new Error("temporary outage");
    });
    await expect(findReusableR2Asset(env, SHA)).rejects.toBeInstanceOf(
      BlobReuseProviderUnavailableError,
    );
    expect(database.prepare("SELECT COUNT(*) AS count FROM blob_integrity_quarantine").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("keeps a pending asset staged while its FabuBlox import is pending", async () => {
    const database = referenceTestDatabase();
    database.prepare(`
      INSERT INTO imports (
        id, status, source_filename, source_sha256, sheet_name,
        template_type, warning_count, workbook_asset_key,
        manifest_asset_key, created_at
      ) VALUES (
        'import-pending-reuse', 'pending', 'pending.xlsx', ?, 'Process',
        'process', 0, 'imports/pending/source.xlsx',
        'imports/pending/source.xlsx', ?
      )
    `).run(SHA, NOW);
    database.prepare(`
      INSERT INTO assets (
        id, import_id, r2_key, original_name, mime_type, byte_size,
        status, actor_email, created_at, sha256
      ) VALUES (
        'asset-pending-reuse', 'import-pending-reuse', 'imports/pending/source.xlsx',
        'pending.xlsx', 'application/octet-stream', 4,
        'pending', 'user@example.com', ?, ?
      )
    `).run(NOW, SHA);
    const head = vi.fn(async () => ({
      size: 4,
      httpEtag: '"pending"',
      writeHttpMetadata() {},
    }));
    const env = r2Environment(database, head);

    await expect(findReusableR2Asset(env, SHA))
      .rejects.toThrow(/pending FabuBlox import/);
    expect(head).not.toHaveBeenCalled();
    expect(database.prepare(`
      SELECT status FROM assets WHERE id = 'asset-pending-reuse'
    `).get()).toEqual({ status: 'pending' });

    database.prepare(`
      UPDATE imports
      SET operation_id = 'operation-pending-reuse',
          lease_expires_at = '2026-08-15T18:00:00.000Z'
      WHERE id = 'import-pending-reuse'
    `).run();
    database.prepare(`
      UPDATE imports
      SET status = 'ready', finalization_id = 'finalize-pending-reuse', completed_at = ?
      WHERE id = 'import-pending-reuse'
    `).run(NOW);
    expect(database.prepare(`
      SELECT status FROM assets WHERE id = 'asset-pending-reuse'
    `).get()).toEqual({ status: 'ready' });
    await expect(findReusableR2Asset(env, SHA)).resolves.toMatchObject({
      id: 'asset-pending-reuse',
      r2_key: 'imports/pending/source.xlsx',
    });
    expect(head).toHaveBeenCalledWith('imports/pending/source.xlsx');
    database.close();
  });

  it("verifies managed objects and releases their hash after quarantine", async () => {
    const database = referenceTestDatabase();
    database.prepare(`
      INSERT INTO managed_storage_objects (
        id, provider, object_key, original_name, mime_type, byte_size,
        sha256, status, actor_email, created_at
      ) VALUES (
        'managed-missing', 'switchdrive', 'objects/missing.bin', 'file.bin',
        'application/octet-stream', 4, ?, 'ready', 'user@example.com', ?
      )
    `).run(SHA, NOW);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const env = {
      DB: new SqliteD1Database(database) as unknown as D1Database,
      ASSETS: {} as R2Bucket,
      AUTH_MODE: "disabled",
      MANAGED_STORAGE_PROVIDER: "switchdrive",
      SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/user%40example.ch",
      SWITCHDRIVE_USERNAME: "user@example.ch",
      SWITCHDRIVE_APP_PASSWORD: "app-password",
    } satisfies Env;

    await expect(findReusableManagedObject(env, "switchdrive", SHA, 4)).resolves.toBeNull();
    expect(database.prepare(`
      SELECT reason FROM blob_integrity_quarantine WHERE store_kind = 'managed'
    `).get()).toEqual({ reason: "missing" });
    expect(() => database.prepare(`
      INSERT INTO managed_storage_objects (
        id, provider, object_key, original_name, mime_type, byte_size,
        sha256, status, actor_email, created_at
      ) VALUES (
        'managed-replacement', 'switchdrive', 'objects/replacement.bin', 'file.bin',
        'application/octet-stream', 4, ?, 'ready', 'user@example.com', ?
      )
    `).run(SHA, NOW)).not.toThrow();
    database.close();
  });

  it("blocks new relationships to quarantined locators", () => {
    const database = referenceTestDatabase();
    insertAsset(database, { id: "asset-quarantined", key: "objects/quarantined.bin" });
    database.prepare(`
      INSERT INTO blob_integrity_quarantine (
        store_kind, provider, object_key, blob_record_id, reason,
        expected_byte_size, observed_byte_size, operation_id,
        detected_at, last_checked_at
      ) VALUES ('r2', 'r2', 'objects/quarantined.bin', 'asset-quarantined',
        'missing', 4, NULL, 'operation-quarantine', ?, ?)
    `).run(NOW, NOW);
    database.prepare(`
      INSERT INTO state_representations (
        hash, hash_scheme, representation_type, content_json, created_at
      ) VALUES ('state-quarantine', 'v1', 'image_set', '{}', ?)
    `).run(NOW);
    expect(() => database.prepare(`
      INSERT INTO state_representation_assets (state_hash, asset_id, position)
      VALUES ('state-quarantine', 'asset-quarantined', 0)
    `).run()).toThrow("blob locator is quarantined");
    database.close();
  });

  it("rejects INSERT and UPDATE binding of quarantined Sample thumbnails", () => {
    const database = referenceTestDatabase();
    database.exec(`
      INSERT INTO samples (id, code, title, created_at, updated_at)
      VALUES ('sample-thumbnail-integrity', 'THUMB', 'Thumbnail integrity', '${NOW}', '${NOW}');
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at
      ) VALUES
        ('asset-thumbnail-primary', 'records/primary-safe.bin', 'primary.bin',
          'application/octet-stream', 4, 'ready',
          '3333333333333333333333333333333333333333333333333333333333333333', '${NOW}'),
        ('asset-thumbnail-safe', 'records/thumbnail-safe.bin', 'safe.bin',
          'application/octet-stream', 4, 'ready',
          '4444444444444444444444444444444444444444444444444444444444444444', '${NOW}'),
        ('asset-thumbnail-quarantined', 'records/thumbnail-quarantined.bin', 'blocked.bin',
          'application/octet-stream', 4, 'ready',
          '5555555555555555555555555555555555555555555555555555555555555555', '${NOW}');
      INSERT INTO blob_integrity_quarantine (
        store_kind, provider, object_key, blob_record_id, reason,
        expected_byte_size, observed_byte_size, operation_id,
        detected_at, last_checked_at
      ) VALUES (
        'r2', 'r2', 'records/thumbnail-quarantined.bin',
        'asset-thumbnail-quarantined', 'size_mismatch', 4, 9,
        'operation-thumbnail-integrity', '${NOW}', '${NOW}'
      );
    `);

    expect(() => database.prepare(`
      INSERT INTO events (
        id, sample_id, kind, asset_key, metadata_json, created_at
      ) VALUES (
        'event-thumbnail-blocked-insert', 'sample-thumbnail-integrity', 'image',
        'records/primary-safe.bin', ?, ?
      )
    `).run(JSON.stringify({
      action: 'sample_record',
      thumbnailKey: 'records/thumbnail-quarantined.bin',
    }), NOW)).toThrow('blob locator is quarantined');

    database.prepare(`
      INSERT INTO events (
        id, sample_id, kind, asset_key, metadata_json, created_at
      ) VALUES (
        'event-thumbnail-safe', 'sample-thumbnail-integrity', 'image',
        'records/primary-safe.bin', ?, ?
      )
    `).run(JSON.stringify({
      action: 'sample_record',
      thumbnailKey: 'records/thumbnail-safe.bin',
    }), NOW);
    expect(() => database.prepare(`
      UPDATE events SET metadata_json = ? WHERE id = 'event-thumbnail-safe'
    `).run(JSON.stringify({
      action: 'sample_record',
      thumbnailKey: 'records/thumbnail-quarantined.bin',
    }))).toThrow('blob locator is quarantined');
    expect(database.prepare(`
      SELECT json_extract(metadata_json, '$.thumbnailKey') AS thumbnail_key
      FROM events WHERE id = 'event-thumbnail-safe'
    `).get()).toEqual({ thumbnail_key: 'records/thumbnail-safe.bin' });

    const triggerNames = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name IN (
        'events_guard_thumbnail_integrity_insert',
        'events_guard_thumbnail_integrity_update'
      ) ORDER BY name
    `).all().map((row) => (row as { name: string }).name);
    expect(triggerNames).toEqual([
      'events_guard_thumbnail_integrity_insert',
      'events_guard_thumbnail_integrity_update',
    ]);
    database.close();
  });

  it("rejects UPDATE rebinding for every quarantined relationship locator", () => {
    const database = referenceTestDatabase();
    seedReferenceGraph(database);
    database.exec(`
      INSERT INTO assets (
        id, r2_key, original_name, mime_type, byte_size, status, sha256, created_at
      ) VALUES
        ('asset-update-safe', 'objects/update-safe.bin', 'safe.bin',
          'application/octet-stream', 4, 'ready',
          'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '${NOW}'),
        ('asset-update-blocked', 'objects/update-blocked.bin', 'blocked.bin',
          'application/octet-stream', 4, 'ready',
          'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', '${NOW}');
      INSERT INTO managed_storage_objects (
        id, provider, object_key, original_name, mime_type, byte_size,
        sha256, status, actor_email, created_at
      ) VALUES
        ('managed-update-safe', 'switchdrive', 'objects/managed-safe.bin', 'safe.bin',
          'application/octet-stream', 4,
          '1111111111111111111111111111111111111111111111111111111111111111',
          'ready', 'user@example.com', '${NOW}'),
        ('managed-update-blocked', 'switchdrive', 'objects/managed-blocked.bin', 'blocked.bin',
          'application/octet-stream', 4,
          '2222222222222222222222222222222222222222222222222222222222222222',
          'ready', 'user@example.com', '${NOW}');
      INSERT INTO blob_integrity_quarantine (
        store_kind, provider, object_key, blob_record_id, reason,
        expected_byte_size, observed_byte_size, operation_id,
        detected_at, last_checked_at
      ) VALUES
        ('r2', 'r2', 'objects/update-blocked.bin', 'asset-update-blocked',
          'missing', 4, NULL, 'operation-update-r2', '${NOW}', '${NOW}'),
        ('managed', 'switchdrive', 'objects/managed-blocked.bin', 'managed-update-blocked',
          'missing', 4, NULL, 'operation-update-managed', '${NOW}', '${NOW}');
      INSERT INTO state_representations (
        hash, hash_scheme, representation_type, content_json, created_at
      ) VALUES ('state-update-guard', 'v1', 'image_set', '{}', '${NOW}');
      INSERT INTO state_representation_assets (state_hash, asset_id, position)
      VALUES ('state-update-guard', 'asset-update-safe', 0);
      INSERT INTO state_verifications (
        id, sample_id, after_run_step_id, result, evidence_asset_id, created_at
      ) VALUES (
        'verification-update-guard', '${REFERENCE_FIXTURE_IDS.sampleA}',
        '${REFERENCE_FIXTURE_IDS.stepA}', 'matched', 'asset-update-safe', '${NOW}'
      );
      INSERT INTO comment_submission_items (
        id, submission_id, kind, status, position, filename, mime_type,
        byte_size, storage_object_id, created_at, updated_at
      ) VALUES (
        'managed-update-item', '${REFERENCE_FIXTURE_IDS.comment}', 'attachment',
        'ready', 1, 'safe.bin', 'application/octet-stream', 4,
        'managed-update-safe', '${NOW}', '${NOW}'
      );
      INSERT INTO projects (
        id, title, last_mutation_id, created_by, updated_by, created_at, updated_at
      ) VALUES (
        'project-update-guard', 'Update guard', 'operation-project-update',
        'user@example.com', 'user@example.com', '${NOW}', '${NOW}'
      );
      INSERT INTO project_contents (
        id, project_id, content_type, attachment_caption, last_mutation_id,
        created_by, updated_by, created_at, updated_at
      ) VALUES
        ('content-update-asset', 'project-update-guard', 'attachment', NULL,
          'operation-content-asset', 'user@example.com', 'user@example.com', '${NOW}', '${NOW}'),
        ('content-update-managed', 'project-update-guard', 'attachment', NULL,
          'operation-content-managed', 'user@example.com', 'user@example.com', '${NOW}', '${NOW}');
      INSERT INTO project_content_attachments (
        project_content_id, asset_id, original_name, mime_type, byte_size,
        created_by, created_at, creation_operation_id
      ) VALUES (
        'content-update-asset', 'asset-update-safe', 'safe.bin',
        'application/octet-stream', 4, 'user@example.com', '${NOW}',
        'operation-attachment-asset'
      );
      INSERT INTO project_content_attachments (
        project_content_id, storage_object_id, original_name, mime_type, byte_size,
        created_by, created_at, creation_operation_id
      ) VALUES (
        'content-update-managed', 'managed-update-safe', 'safe.bin',
        'application/octet-stream', 4, 'user@example.com', '${NOW}',
        'operation-attachment-managed'
      );
    `);

    const updates = [
      () => database.prepare(`
        UPDATE state_representation_assets SET asset_id = 'asset-update-blocked'
        WHERE state_hash = 'state-update-guard'
      `).run(),
      () => database.prepare(`
        UPDATE run_step_assets SET asset_id = 'asset-update-blocked'
        WHERE id = ?
      `).run(REFERENCE_FIXTURE_IDS.executionImage),
      () => database.prepare(`
        UPDATE metrology_template_references SET asset_id = 'asset-update-blocked'
        WHERE id = ?
      `).run(REFERENCE_FIXTURE_IDS.metrologyReference),
      () => database.prepare(`
        UPDATE run_step_comments SET asset_id = 'asset-update-blocked'
        WHERE id = ?
      `).run(REFERENCE_FIXTURE_IDS.commentOccurrenceA),
      () => database.prepare(`
        UPDATE state_verifications SET evidence_asset_id = 'asset-update-blocked'
        WHERE id = 'verification-update-guard'
      `).run(),
      () => database.prepare(`
        UPDATE comment_submission_items SET asset_id = 'asset-update-blocked'
        WHERE id = ?
      `).run(REFERENCE_FIXTURE_IDS.commentAttachment),
      () => database.prepare(`
        UPDATE comment_submission_items SET storage_object_id = 'managed-update-blocked'
        WHERE id = 'managed-update-item'
      `).run(),
      () => database.prepare(`
        UPDATE project_content_attachments SET asset_id = 'asset-update-blocked'
        WHERE project_content_id = 'content-update-asset'
      `).run(),
      () => database.prepare(`
        UPDATE project_content_attachments SET storage_object_id = 'managed-update-blocked'
        WHERE project_content_id = 'content-update-managed'
      `).run(),
    ];
    for (const update of updates) {
      expect(update).toThrow("blob locator is quarantined");
    }

    const triggerNames = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name IN (
        'state_representation_assets_guard_integrity_update',
        'run_step_assets_guard_integrity_update',
        'metrology_template_references_guard_integrity_update',
        'run_step_comments_guard_integrity_update',
        'state_verifications_guard_integrity_update',
        'comment_submission_items_guard_asset_integrity_update',
        'comment_submission_items_guard_managed_integrity_update',
        'project_content_attachments_guard_asset_integrity_update',
        'project_content_attachments_guard_managed_integrity_update'
      ) ORDER BY name
    `).all().map((row) => (row as { name: string }).name);
    expect(triggerNames).toHaveLength(9);
    database.close();
  });

});
