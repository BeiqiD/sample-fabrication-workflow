import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  attachmentPreviewGeneratorVersion,
  COMMENT_RASTER_PREVIEW_GENERATOR_VERSION,
  COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
} from "./attachment-derivatives";

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

function derivativeMigrations() {
  return [
    "0033_attachment_derivatives.sql",
    "0034_attachment_derivative_generator_parity.sql",
  ].map((filename) => readFileSync(
    new URL(`../migrations/${filename}`, import.meta.url),
    "utf8",
  )).join("\n");
}

describe("attachment derivative migration safety", () => {
  it("skips quarantined candidates instead of aborting migration backfill", () => {
    const database = databaseBeforeDerivativeMigration();
    seedReadyPair(database);
    database.prepare(`
      INSERT INTO blob_integrity_quarantine (
        store_kind, provider, object_key, blob_record_id,
        reason, expected_byte_size, observed_byte_size,
        operation_id, detected_at, last_checked_at
      ) VALUES (
        'r2', 'r2', 'derivatives/migration-preview.webp', 'migration-preview',
        'size_mismatch', 4, 5, 'migration-preview-quarantine', ?, ?
      )
    `).run(NOW, NOW);
    database.prepare(`
      INSERT INTO blob_integrity_quarantine (
        store_kind, provider, object_key, blob_record_id,
        reason, expected_byte_size, observed_byte_size,
        operation_id, detected_at, last_checked_at
      ) VALUES (
        'managed', 'switchdrive', 'source/migration.tif', 'migration-source',
        'size_mismatch', 1024, 1025, 'migration-source-quarantine', ?, ?
      )
    `).run(NOW, NOW);

    expect(() => database.exec(derivativeMigrations())).not.toThrow();
    expect(database.prepare(`SELECT COUNT(*) AS count FROM attachment_derivatives`).get())
      .toEqual({ count: 0 });

    database.prepare(`
      DELETE FROM blob_integrity_quarantine
      WHERE store_kind = 'r2' AND object_key = 'derivatives/migration-preview.webp'
    `).run();
    database.prepare(`
      UPDATE comment_submission_items SET status = 'ready'
      WHERE id = 'migration-preview-item'
    `).run();
    expect(database.prepare(`SELECT COUNT(*) AS count FROM attachment_derivatives`).get())
      .toEqual({ count: 0 });

    database.prepare(`
      DELETE FROM blob_integrity_quarantine
      WHERE store_kind = 'managed' AND object_key = 'source/migration.tif'
    `).run();
    database.prepare(`
      UPDATE comment_submission_items SET status = 'ready'
      WHERE id = 'migration-original-item'
    `).run();
    expect(database.prepare(`
      SELECT source_sha256, derived_asset_id, status FROM attachment_derivatives
    `).get()).toEqual({
      source_sha256: "b2".repeat(32),
      derived_asset_id: "migration-preview",
      status: "ready",
    });
    database.close();
  });

  it("skips malformed legacy source identity instead of aborting migration", () => {
    const database = databaseBeforeDerivativeMigration();
    seedReadyPair(database);
    database.prepare(`
      UPDATE managed_storage_objects
      SET sha256 = 'legacy-invalid-sha'
      WHERE id = 'migration-source'
    `).run();

    expect(() => database.exec(derivativeMigrations())).not.toThrow();
    expect(database.prepare(`SELECT COUNT(*) AS count FROM attachment_derivatives`).get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("retains derived bytes only while the registered preview stays usable", () => {
    const database = databaseBeforeDerivativeMigration();
    seedReadyPair(database);
    database.exec(derivativeMigrations());

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

  it("keeps SQL and runtime generator identity normalization in parity", () => {
    const cases = [
      {
        filename: "scan.bin",
        mimeType: "image/tiff; charset=binary",
        expected: COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
      },
      {
        filename: "scan.tif ",
        mimeType: "image/png",
        expected: COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
      },
      {
        filename: "scan.tif\t",
        mimeType: "image/png",
        expected: COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
      },
      {
        filename: "scan.tif\u00A0",
        mimeType: "image/png",
        expected: COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
      },
      {
        filename: "SCAN.TIFF",
        mimeType: "IMAGE/TIFF; CHARSET=BINARY",
        expected: COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
      },
      {
        filename: "scan.bin",
        mimeType: "\timage/tiff\t; charset=binary",
        expected: COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
      },
      {
        filename: "scan.bin",
        mimeType: "\u00A0IMAGE/TIFF\u00A0; charset=binary",
        expected: COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
      },
      {
        filename: "scan.png",
        mimeType: "\u2003IMAGE/PNG\u2003; charset=binary",
        expected: COMMENT_RASTER_PREVIEW_GENERATOR_VERSION,
      },
      {
        filename: "scan.png",
        mimeType: " IMAGE/PNG ; charset=binary ",
        expected: COMMENT_RASTER_PREVIEW_GENERATOR_VERSION,
      },
      {
        filename: "\u0000scan.tif",
        mimeType: "image/png",
        expected: null,
      },
      {
        filename: "scan.bin",
        mimeType: "image/tiff\u0000; charset=binary",
        expected: null,
      },
      {
        filename: "scan.bin",
        mimeType: "image/pn\u212A",
        expected: null,
      },
      {
        filename: "scan.bin",
        mimeType: "image/not valid",
        expected: null,
      },
      {
        filename: "scan.bin",
        mimeType: "image/\tpng",
        expected: null,
      },
      {
        filename: "scan.bin",
        mimeType: "not-a-mime",
        expected: null,
      },
    ] as const;

    for (const testCase of cases) {
      const database = databaseBeforeDerivativeMigration();
      seedReadyPair(database);
      database.prepare(`
        UPDATE managed_storage_objects
        SET original_name = ?, mime_type = ?
        WHERE id = 'migration-source'
      `).run(testCase.filename, testCase.mimeType);

      database.exec(derivativeMigrations());
      const sqlGenerator = (database.prepare(`
        SELECT generator_version
        FROM attachment_derivative_comment_candidates
        LIMIT 1
      `).get() as { generator_version?: string } | undefined)?.generator_version ?? null;
      const registeredGenerator = (database.prepare(`
        SELECT generator_version
        FROM attachment_derivatives
        LIMIT 1
      `).get() as { generator_version?: string } | undefined)?.generator_version ?? null;
      const runtimeGenerator = attachmentPreviewGeneratorVersion(
        testCase.filename,
        testCase.mimeType,
      );

      expect({ sqlGenerator, registeredGenerator, runtimeGenerator }).toEqual({
        sqlGenerator: testCase.expected,
        registeredGenerator: testCase.expected,
        runtimeGenerator: testCase.expected,
      });
      database.close();
    }
  });
});
