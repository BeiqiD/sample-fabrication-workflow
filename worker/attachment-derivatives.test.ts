import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_DERIVATIVE_LEASE_MS,
  BROWSER_PREVIEW_DERIVATIVE_KIND,
  COMMENT_RASTER_PREVIEW_GENERATOR_VERSION,
  COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
  recordAttachmentDerivativeFailure,
  registerReadyAttachmentDerivative,
  resolveAttachmentDerivative,
  resolveManagedAttachmentBrowserPreview,
  resolveR2AttachmentBrowserPreview,
} from "./attachment-derivatives";
import { PROJECT_EXPORT_TABLE_QUERIES } from "./project-foundation-routes";
import {
  referenceTestDatabase,
  SqliteD1Database,
} from "./reference-test-support";

const ACTOR = "local-development";
const NOW = new Date(Date.now());

type ExportedDerivativeRow = {
  id: string;
  source_sha256: string;
  source_byte_size: number;
  derivative_kind: "browser_preview";
  generator_version: string;
  derived_asset_id: string;
  status: "ready";
  error_code: null;
  retain_until: string;
  actor_email: string | null;
  created_at: string;
  updated_at: string;
};

function dbAdapter(database: ReturnType<typeof referenceTestDatabase>) {
  return new SqliteD1Database(database) as unknown as D1Database;
}

function insertAsset(
  database: ReturnType<typeof referenceTestDatabase>,
  id: string,
  key: string,
  sha256: string,
  byteSize = 4,
  mimeType = "image/webp",
) {
  database.prepare(`
    INSERT INTO assets (
      id, r2_key, original_name, mime_type, byte_size,
      status, actor_email, created_at, sha256
    ) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)
  `).run(id, key, `${id}.webp`, mimeType, byteSize, ACTOR, NOW.toISOString(), sha256);
}

function markR2Orphan(
  database: ReturnType<typeof referenceTestDatabase>,
  assetId: string,
  key: string,
  operationId: string,
) {
  database.prepare(`
    INSERT INTO blob_gc_ledger (
      store_kind, provider, object_key, blob_record_id,
      state, operation_id, orphaned_at, updated_at
    ) VALUES ('r2', 'r2', ?, ?, 'orphaned', ?, ?, ?)
  `).run(key, assetId, operationId, NOW.toISOString(), NOW.toISOString());
}


describe("shared attachment derivatives", () => {
  it("keeps one healthy winner, preserves a losing orphan, and renews an expired lease", async () => {
    const database = referenceTestDatabase();
    const db = dbAdapter(database);
    insertAsset(database, "preview-a", "derivatives/a.webp", "a".repeat(64));
    insertAsset(database, "preview-b", "derivatives/b.webp", "b".repeat(64));
    markR2Orphan(database, "preview-a", "derivatives/a.webp", "orphan-a");
    const sourceSha = "c".repeat(64);

    const first = await registerReadyAttachmentDerivative(db, {
      sourceSha256: sourceSha,
      sourceByteSize: 1234,
      generatorVersion: COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
      derivedAssetId: "preview-a",
      actorEmail: ACTOR,
    }, NOW);
    expect(first).toMatchObject({
      derivedAssetId: "preview-a",
      derivativeKind: BROWSER_PREVIEW_DERIVATIVE_KIND,
    });
    expect(Date.parse(first.retainUntil) - NOW.getTime()).toBe(ATTACHMENT_DERIVATIVE_LEASE_MS);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM blob_gc_ledger WHERE object_key = 'derivatives/a.webp'`).get())
      .toEqual({ count: 0 });

    markR2Orphan(database, "preview-b", "derivatives/b.webp", "orphan-b");
    const later = new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000);
    const second = await registerReadyAttachmentDerivative(db, {
      sourceSha256: sourceSha,
      sourceByteSize: 1234,
      generatorVersion: COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
      derivedAssetId: "preview-b",
      actorEmail: ACTOR,
    }, later);
    expect(second.derivedAssetId).toBe("preview-a");
    expect(database.prepare(`SELECT state FROM blob_gc_ledger WHERE object_key = 'derivatives/b.webp'`).get())
      .toEqual({ state: "orphaned" });

    const expiredRetainUntil = new Date(
      NOW.getTime() - ATTACHMENT_DERIVATIVE_LEASE_MS,
    ).toISOString();
    database.prepare(`
      UPDATE attachment_derivatives
      SET retain_until = ?
      WHERE source_sha256 = ?
    `).run(expiredRetainUntil, sourceSha);
    markR2Orphan(database, "preview-a", "derivatives/a.webp", "orphan-a-reuse");
    expect(database.prepare(`SELECT COUNT(*) AS count FROM blob_retention_edges WHERE source_type = 'attachment_derivative'`).get())
      .toEqual({ count: 0 });
    const reused = await resolveAttachmentDerivative(db, {
      sourceSha256: sourceSha,
      sourceByteSize: 1234,
      generatorVersion: COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
    }, later);
    expect(reused?.derivedAssetId).toBe("preview-a");
    expect(Date.parse(reused!.retainUntil)).toBeGreaterThan(later.getTime());
    expect(database.prepare(`SELECT COUNT(*) AS count FROM blob_gc_ledger WHERE object_key = 'derivatives/a.webp'`).get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("replaces a ready winner after its MIME stops being browser-safe", async () => {
    const database = referenceTestDatabase();
    const db = dbAdapter(database);
    insertAsset(database, "stale-preview", "derivatives/stale.webp", "a1".repeat(32));
    insertAsset(database, "replacement-preview", "derivatives/replacement.webp", "b1".repeat(32));
    const sourceSha = "c1".repeat(32);

    expect((await registerReadyAttachmentDerivative(db, {
      sourceSha256: sourceSha,
      sourceByteSize: 512,
      generatorVersion: COMMENT_RASTER_PREVIEW_GENERATOR_VERSION,
      derivedAssetId: "stale-preview",
      actorEmail: ACTOR,
    }, NOW)).derivedAssetId).toBe("stale-preview");

    database.prepare(`UPDATE assets SET mime_type = 'image/svg+xml' WHERE id = 'stale-preview'`).run();
    markR2Orphan(
      database,
      "replacement-preview",
      "derivatives/replacement.webp",
      "replacement-orphan",
    );

    const recovered = await registerReadyAttachmentDerivative(db, {
      sourceSha256: sourceSha,
      sourceByteSize: 512,
      generatorVersion: COMMENT_RASTER_PREVIEW_GENERATOR_VERSION,
      derivedAssetId: "replacement-preview",
      actorEmail: ACTOR,
    }, NOW);
    expect(recovered.derivedAssetId).toBe("replacement-preview");
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM blob_gc_ledger
      WHERE object_key = 'derivatives/replacement.webp'
    `).get()).toEqual({ count: 0 });
    database.close();
  });

  it("keeps failure separate from source retention and allows recovery", async () => {
    const database = referenceTestDatabase();
    const db = dbAdapter(database);
    insertAsset(database, "preview-recovery", "derivatives/recovery.webp", "d".repeat(64));
    const sourceSha = "e".repeat(64);
    await recordAttachmentDerivativeFailure(db, {
      sourceSha256: sourceSha,
      sourceByteSize: 222,
      generatorVersion: COMMENT_RASTER_PREVIEW_GENERATOR_VERSION,
      errorCode: "decode_failed",
      actorEmail: ACTOR,
    }, NOW);
    expect(database.prepare(`SELECT status, derived_asset_id, retain_until FROM attachment_derivatives WHERE source_sha256 = ?`).get(sourceSha))
      .toEqual({ status: "failed", derived_asset_id: null, retain_until: null });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM blob_retention_edges WHERE source_type = 'attachment_derivative'`).get())
      .toEqual({ count: 0 });
    expect((await registerReadyAttachmentDerivative(db, {
      sourceSha256: sourceSha,
      sourceByteSize: 222,
      generatorVersion: COMMENT_RASTER_PREVIEW_GENERATOR_VERSION,
      derivedAssetId: "preview-recovery",
      actorEmail: ACTOR,
    }, NOW)).derivedAssetId).toBe("preview-recovery");
    database.close();
  });

  it("round-trips trusted derivative identity through complete export rows", async () => {
    const sourceDatabase = referenceTestDatabase();
    const sourceDb = dbAdapter(sourceDatabase);
    const sourceSha = "ef".repeat(32);
    insertAsset(
      sourceDatabase,
      "exported-preview",
      "derivatives/exported-preview.webp",
      "ab".repeat(32),
    );
    await registerReadyAttachmentDerivative(sourceDb, {
      sourceSha256: sourceSha,
      sourceByteSize: 4096,
      generatorVersion: COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
      derivedAssetId: "exported-preview",
      actorEmail: ACTOR,
    }, NOW);

    const exported = sourceDatabase.prepare(
      PROJECT_EXPORT_TABLE_QUERIES.attachment_derivatives,
    ).get() as ExportedDerivativeRow;
    expect(exported).toMatchObject({
      source_sha256: sourceSha,
      source_byte_size: 4096,
      derivative_kind: BROWSER_PREVIEW_DERIVATIVE_KIND,
      generator_version: COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
      derived_asset_id: "exported-preview",
      status: "ready",
    });

    const restoredDatabase = referenceTestDatabase();
    insertAsset(
      restoredDatabase,
      "exported-preview",
      "derivatives/exported-preview.webp",
      "ab".repeat(32),
    );
    restoredDatabase.prepare(`
      INSERT INTO attachment_derivatives (
        id, source_sha256, source_byte_size, derivative_kind,
        generator_version, derived_asset_id, status, error_code,
        retain_until, actor_email, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      exported.id,
      exported.source_sha256,
      exported.source_byte_size,
      exported.derivative_kind,
      exported.generator_version,
      exported.derived_asset_id,
      exported.status,
      exported.error_code,
      exported.retain_until,
      exported.actor_email,
      exported.created_at,
      exported.updated_at,
    );
    expect(restoredDatabase.prepare(
      PROJECT_EXPORT_TABLE_QUERIES.attachment_derivatives,
    ).get()).toEqual(exported);
    await expect(resolveAttachmentDerivative(dbAdapter(restoredDatabase), {
      sourceSha256: sourceSha,
      sourceByteSize: 4096,
      generatorVersion: COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
    }, NOW)).resolves.toMatchObject({
      id: exported.id,
      derivedAssetId: "exported-preview",
    });
    sourceDatabase.close();
    restoredDatabase.close();
  });

  it("resolves safe R2 originals and managed TIFF previews through one service", async () => {
    const database = referenceTestDatabase();
    const db = dbAdapter(database);
    insertAsset(database, "safe-source", "source/safe.png", "2".repeat(64), 8, "image/png");
    insertAsset(database, "shared-preview", "derivatives/shared.webp", "3".repeat(64));
    database.prepare(`
      INSERT INTO managed_storage_objects (
        id, provider, object_key, original_name, mime_type, byte_size,
        sha256, status, actor_email, created_at
      ) VALUES ('managed-tiff-source', 'switchdrive', 'source/raw.tif',
        'raw.tif', 'image/tiff', 1024, ?, 'ready', ?, ?)
    `).run("4".repeat(64), ACTOR, NOW.toISOString());
    await registerReadyAttachmentDerivative(db, {
      sourceSha256: "4".repeat(64),
      sourceByteSize: 1024,
      generatorVersion: COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
      derivedAssetId: "shared-preview",
      actorEmail: ACTOR,
    }, NOW);
    expect(await resolveR2AttachmentBrowserPreview(db, "safe-source", NOW)).toMatchObject({
      source: "original", assetId: "safe-source", derivativeId: null,
    });
    expect(await resolveManagedAttachmentBrowserPreview(db, "managed-tiff-source", NOW)).toMatchObject({
      source: "derivative", assetId: "shared-preview",
      generatorVersion: COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
    });

    database.close();
  });

  it("rejects non-browser-safe, quarantined, and invalid-lease derived assets", async () => {
    const database = referenceTestDatabase();
    const db = dbAdapter(database);
    insertAsset(database, "unsafe-preview", "derivatives/unsafe.svg", "6".repeat(64), 4, "image/svg+xml");
    await expect(registerReadyAttachmentDerivative(db, {
      sourceSha256: "7".repeat(64), sourceByteSize: 42,
      generatorVersion: COMMENT_RASTER_PREVIEW_GENERATOR_VERSION,
      derivedAssetId: "unsafe-preview", actorEmail: ACTOR,
    }, NOW)).rejects.toThrow("browser-safe");

    insertAsset(database, "quarantined-preview", "derivatives/quarantined.webp", "8".repeat(64));
    database.prepare(`
      INSERT INTO blob_integrity_quarantine (
        store_kind, provider, object_key, blob_record_id,
        reason, expected_byte_size, observed_byte_size,
        operation_id, detected_at, last_checked_at
      ) VALUES ('r2', 'r2', 'derivatives/quarantined.webp', 'quarantined-preview',
        'size_mismatch', 4, 5, 'quarantine-test', ?, ?)
    `).run(NOW.toISOString(), NOW.toISOString());
    await expect(registerReadyAttachmentDerivative(db, {
      sourceSha256: "9".repeat(64), sourceByteSize: 42,
      generatorVersion: COMMENT_RASTER_PREVIEW_GENERATOR_VERSION,
      derivedAssetId: "quarantined-preview", actorEmail: ACTOR,
    }, NOW)).rejects.toThrow("quarantined");

    insertAsset(database, "lease-preview", "derivatives/lease.webp", "a2".repeat(32));
    expect(() => database.prepare(`
      INSERT INTO attachment_derivatives (
        id, source_sha256, source_byte_size, derivative_kind,
        generator_version, derived_asset_id, status, error_code,
        retain_until, actor_email, created_at, updated_at
      ) VALUES (
        'invalid-lease-derivative', ?, 42, 'browser_preview', ?,
        'lease-preview', 'ready', NULL, 'not-a-date', ?, ?, ?
      )
    `).run(
      "b2".repeat(32),
      COMMENT_RASTER_PREVIEW_GENERATOR_VERSION,
      ACTOR,
      NOW.toISOString(),
      NOW.toISOString(),
    )).toThrow();
    database.close();
  });
});
