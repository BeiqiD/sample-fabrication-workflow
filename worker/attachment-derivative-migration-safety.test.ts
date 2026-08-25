import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { COMMENT_TIFF_PREVIEW_GENERATOR_VERSION } from "./attachment-derivatives";

const NOW = "2026-08-20T12:30:00.000Z";

function databaseBeforeDerivativeMigration() {
  const database = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    if (filename >= "0033_attachment_derivatives.sql") break;
    database.exec(readFileSync(new URL(filename, directory), "utf8"));
  }
  database.exec(readFileSync(new URL("./fixtures/reference-graph.sql", import.meta.url), "utf8"));
  return database;
}

function seedReadyPair(database: DatabaseSync) {
  database.prepare(`
    INSERT INTO assets (
      id, r2_key, original_name, mime_type, byte_size,
      status, actor_email, created_at, sha256
    ) VALUES (
      'migration-preview', 'derivatives/migration-preview.webp',
      'preview.webp', 'image/webp', 4, 'ready', 'local-development', ?, ?
    )
  `).run(NOW, "a2".repeat(32));
  database.prepare(`
    INSERT INTO managed_storage_objects (
      id, provider, object_key, original_name, mime_type, byte_size,
      sha256, status, actor_email, created_at
    ) VALUES (
      'migration-source', 'switchdrive', 'source/migration.tif',
      'migration.tif', 'image/tiff', 1024, ?, 'ready', 'local-development', ?
    )
  `).run("b2".repeat(32), NOW);
  database.prepare(`
    INSERT INTO comment_submissions (
      id, context_kind, sample_id, scope, body, status,
      actor_email, created_at, updated_at, completed_at,
      retry_closed_at, retry_closed_by
    ) VALUES (
      'migration-derivative-submission', 'sample', 'reference-sample-a', NULL,
      'TIFF', 'ready', 'local-development', ?, ?, ?, ?, 'local-development'
    )
  `).run(NOW, NOW, NOW, NOW);
  database.prepare(`
    INSERT INTO comment_submission_items (
      id, submission_id, kind, status, position,
      filename, mime_type, byte_size,
      original_filename, original_mime_type, original_byte_size,
      asset_id, created_at, updated_at
    ) VALUES (
      'migration-preview-item', 'migration-derivative-submission',
      'comment_image', 'ready', 0,
      'migration.webp', 'image/webp', 4,
      'migration.tif', 'image/tiff', 1024,
      'migration-preview', ?, ?
    )
  `).run(NOW, NOW);
  database.prepare(`
    INSERT INTO comment_submission_items (
      id, submission_id, kind, status, position,
      filename, mime_type, byte_size,
      original_filename, original_mime_type, original_byte_size,
      storage_object_id, created_at, updated_at
    ) VALUES (
      'migration-original-item', 'migration-derivative-submission',
      'attachment', 'ready', 1,
      'migration.tif', 'image/tiff', 1024,
      'migration.tif', 'image/tiff', 1024,
      'migration-source', ?, ?
    )
  `).run(NOW, NOW);
  database.prepare(`
    UPDATE comment_submission_items
    SET related_item_id = CASE id
      WHEN 'migration-preview-item' THEN 'migration-original-item'
      WHEN 'migration-original-item' THEN 'migration-preview-item'
    END
    WHERE id IN ('migration-preview-item', 'migration-original-item')
  `).run();
}

function migrationText(...filenames: string[]) {
  return filenames.map((filename) => readFileSync(
    new URL(`../migrations/${filename}`, import.meta.url),
    "utf8",
  )).join("\n");
}

function derivativeMigrationsBeforeCleanup() {
  return migrationText(
    "0033_attachment_derivatives.sql",
    "0034_attachment_derivative_generator_parity.sql",
  );
}

function derivativeTrustBoundaryMigration() {
  return migrationText("0035_attachment_derivative_trust_boundary.sql");
}

function derivativeMigrations() {
  return migrationText(
    "0033_attachment_derivatives.sql",
    "0034_attachment_derivative_generator_parity.sql",
    "0035_attachment_derivative_trust_boundary.sql",
  );
}

function registryCount(database: DatabaseSync) {
  return database.prepare(`SELECT COUNT(*) AS count FROM attachment_derivatives`).get();
}

function adoptionArtifacts(database: DatabaseSync) {
  return database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE name IN (
      'attachment_derivative_comment_candidates',
      'comment_submission_items_adopt_derivative_after_update'
    )
    ORDER BY name
  `).all();
}

describe("attachment derivative migration safety", () => {
  it("does not backfill or auto-adopt client Comment previews", () => {
    const database = databaseBeforeDerivativeMigration();
    seedReadyPair(database);

    database.exec(derivativeMigrations());
    expect(registryCount(database)).toEqual({ count: 0 });
    expect(adoptionArtifacts(database)).toEqual([]);

    database.prepare(`
      UPDATE comment_submission_items SET status = 'ready'
      WHERE id IN ('migration-preview-item', 'migration-original-item')
    `).run();
    expect(registryCount(database)).toEqual({ count: 0 });
    database.close();
  });

  it("cleans adoption artifacts left by an earlier Draft migration revision", () => {
    const database = databaseBeforeDerivativeMigration();
    seedReadyPair(database);
    database.exec(derivativeMigrationsBeforeCleanup());

    database.exec(`
      CREATE VIEW attachment_derivative_comment_candidates AS
      SELECT 'legacy-submission' AS submission_id;

      CREATE TRIGGER comment_submission_items_adopt_derivative_after_update
      AFTER UPDATE OF status ON comment_submission_items
      BEGIN
        SELECT 1;
      END;
    `);
    database.prepare(`
      INSERT INTO attachment_derivatives (
        id, source_sha256, source_byte_size, derivative_kind,
        generator_version, derived_asset_id, status, error_code,
        retain_until, actor_email, created_at, updated_at
      ) VALUES (
        'legacy-client-adoption', ?, 1024, 'browser_preview', ?,
        'migration-preview', 'ready', NULL,
        '2099-01-01T00:00:00.000Z', 'local-development', ?, ?
      )
    `).run("b2".repeat(32), COMMENT_TIFF_PREVIEW_GENERATOR_VERSION, NOW, NOW);
    expect(registryCount(database)).toEqual({ count: 1 });
    expect(adoptionArtifacts(database)).toEqual([
      { name: "attachment_derivative_comment_candidates" },
      { name: "comment_submission_items_adopt_derivative_after_update" },
    ]);

    database.exec(derivativeTrustBoundaryMigration());
    expect(registryCount(database)).toEqual({ count: 0 });
    expect(adoptionArtifacts(database)).toEqual([]);
    database.close();
  });

  it("does not inspect malformed legacy source identity during migration", () => {
    const database = databaseBeforeDerivativeMigration();
    seedReadyPair(database);
    database.prepare(`
      UPDATE managed_storage_objects
      SET sha256 = 'legacy-invalid-sha'
      WHERE id = 'migration-source'
    `).run();

    expect(() => database.exec(derivativeMigrations())).not.toThrow();
    expect(registryCount(database)).toEqual({ count: 0 });
    database.close();
  });

  it("retains only explicitly registered trusted derivative bytes while usable", () => {
    const database = databaseBeforeDerivativeMigration();
    seedReadyPair(database);
    database.exec(derivativeMigrations());

    database.prepare(`
      INSERT INTO attachment_derivatives (
        id, source_sha256, source_byte_size, derivative_kind,
        generator_version, derived_asset_id, status, error_code,
        retain_until, actor_email, created_at, updated_at
      ) VALUES (
        'trusted-migration-derivative', ?, 1024, 'browser_preview',
        ?, 'migration-preview', 'ready', NULL,
        '2099-01-01T00:00:00.000Z', 'local-development', ?, ?
      )
    `).run("b2".repeat(32), COMMENT_TIFF_PREVIEW_GENERATOR_VERSION, NOW, NOW);

    const derivativeEdgeCount = () => database.prepare(`
      SELECT COUNT(*) AS count
      FROM blob_retention_edges
      WHERE source_type = 'attachment_derivative'
        AND object_key = 'derivatives/migration-preview.webp'
    `).get();

    expect(derivativeEdgeCount()).toEqual({ count: 1 });

    database.prepare(`
      UPDATE assets SET mime_type = 'image/svg+xml'
      WHERE id = 'migration-preview'
    `).run();
    expect(derivativeEdgeCount()).toEqual({ count: 0 });

    database.prepare(`
      UPDATE assets SET mime_type = 'image/webp'
      WHERE id = 'migration-preview'
    `).run();
    expect(derivativeEdgeCount()).toEqual({ count: 1 });

    database.prepare(`
      INSERT INTO blob_integrity_quarantine (
        store_kind, provider, object_key, blob_record_id,
        reason, expected_byte_size, observed_byte_size,
        operation_id, detected_at, last_checked_at
      ) VALUES (
        'r2', 'r2', 'derivatives/migration-preview.webp', 'migration-preview',
        'size_mismatch', 4, 5, 'migration-retention-quarantine', ?, ?
      )
    `).run(NOW, NOW);
    expect(derivativeEdgeCount()).toEqual({ count: 0 });
    database.close();
  });
});
