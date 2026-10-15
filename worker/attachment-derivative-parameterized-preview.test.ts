import { describe, expect, it } from "vitest";
import {
  COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
  registerReadyAttachmentDerivative,
  resolveManagedAttachmentBrowserPreview,
} from "./attachment-derivatives";
import {
  REFERENCE_FIXTURE_IDS,
  referenceTestDatabase,
  seedReferenceGraph,
  SqliteD1Database,
} from "./reference-test-support";

const ACTOR = "local-development";
const NOW = new Date(Date.now());
const PARAMETERIZED_WEBP = "image/webp; charset=binary";

function dbAdapter(database: ReturnType<typeof referenceTestDatabase>) {
  return new SqliteD1Database(database) as unknown as D1Database;
}

function insertParameterizedPreview(
  database: ReturnType<typeof referenceTestDatabase>,
  id: string,
  sha256: string,
) {
  database.prepare(`
    INSERT INTO assets (
      id, r2_key, original_name, mime_type, byte_size,
      status, actor_email, created_at, sha256
    ) VALUES (?, ?, 'preview.webp', ?, 4, 'ready', ?, ?, ?)
  `).run(
    id,
    `derivatives/${id}.webp`,
    PARAMETERIZED_WEBP,
    ACTOR,
    NOW.toISOString(),
    sha256,
  );
}

function insertManagedTiff(
  database: ReturnType<typeof referenceTestDatabase>,
  id: string,
  sha256: string,
  byteSize: number,
) {
  database.prepare(`
    INSERT INTO managed_storage_objects (
      id, provider, object_key, original_name, mime_type, byte_size,
      sha256, status, actor_email, created_at
    ) VALUES (?, 'switchdrive', ?, 'source.tif', 'image/tiff', ?, ?, 'ready', ?, ?)
  `).run(
    id,
    `source/${id}.tif`,
    byteSize,
    sha256,
    ACTOR,
    NOW.toISOString(),
  );
}

describe("parameterized browser-preview MIME", () => {
  it("supports direct registration, resolution, and derivative retention", async () => {
    const database = referenceTestDatabase();
    const db = dbAdapter(database);
    const sourceSha = "a7".repeat(32);
    insertParameterizedPreview(database, "parameterized-preview", "b7".repeat(32));
    insertManagedTiff(database, "parameterized-source", sourceSha, 4096);

    expect(database.prepare(`
      SELECT normalized_mime_type
      FROM attachment_derivative_browser_safe_assets
      WHERE id = 'parameterized-preview'
    `).get()).toEqual({ normalized_mime_type: "image/webp" });

    const registered = await registerReadyAttachmentDerivative(db, {
      sourceSha256: sourceSha,
      sourceByteSize: 4096,
      generatorVersion: COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
      derivedAssetId: "parameterized-preview",
      actorEmail: ACTOR,
    }, NOW);
    expect(registered).toMatchObject({
      derivedAssetId: "parameterized-preview",
      mimeType: PARAMETERIZED_WEBP,
    });

    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM blob_retention_edges
      WHERE source_type = 'attachment_derivative'
        AND blob_record_id = 'parameterized-preview'
    `).get()).toEqual({ count: 1 });

    await expect(resolveManagedAttachmentBrowserPreview(
      db,
      "parameterized-source",
      NOW,
    )).resolves.toMatchObject({
      source: "derivative",
      assetId: "parameterized-preview",
      mimeType: PARAMETERIZED_WEBP,
      generatorVersion: COMMENT_TIFF_PREVIEW_GENERATOR_VERSION,
    });
    database.close();
  });

  it("does not trust a client-supplied Comment preview as a shared derivative", async () => {
    const database = referenceTestDatabase();
    const db = dbAdapter(database);
    seedReferenceGraph(database);
    const sourceSha = "c7".repeat(32);
    insertParameterizedPreview(database, "comment-parameterized-preview", "d7".repeat(32));
    insertManagedTiff(database, "comment-parameterized-source", sourceSha, 2048);

    database.prepare(`
      INSERT INTO comment_submissions (
        id, context_kind, sample_id, scope, body, status,
        actor_email, created_at, updated_at, completed_at,
        retry_closed_at, retry_closed_by
      ) VALUES (
        'parameterized-preview-submission', 'sample', ?, NULL,
        'TIFF', 'ready', ?, ?, ?, ?, ?, ?
      )
    `).run(
      REFERENCE_FIXTURE_IDS.sampleA,
      ACTOR,
      NOW.toISOString(),
      NOW.toISOString(),
      NOW.toISOString(),
      NOW.toISOString(),
      ACTOR,
    );

    database.prepare(`
      INSERT INTO comment_submission_items (
        id, submission_id, kind, status, position,
        filename, mime_type, byte_size,
        original_filename, original_mime_type, original_byte_size,
        created_at, updated_at
      ) VALUES (
        'parameterized-preview-item', 'parameterized-preview-submission',
        'comment_image', 'pending', 0,
        'preview.webp', ?, 4,
        'source.tif', 'image/tiff', 2048,
        ?, ?
      )
    `).run(PARAMETERIZED_WEBP, NOW.toISOString(), NOW.toISOString());

    database.prepare(`
      INSERT INTO comment_submission_items (
        id, submission_id, kind, status, position,
        filename, mime_type, byte_size,
        original_filename, original_mime_type, original_byte_size,
        created_at, updated_at
      ) VALUES (
        'parameterized-original-item', 'parameterized-preview-submission',
        'attachment', 'pending', 1,
        'source.tif', 'image/tiff', 2048,
        'source.tif', 'image/tiff', 2048,
        ?, ?
      )
    `).run(NOW.toISOString(), NOW.toISOString());

    database.prepare(`
      UPDATE comment_submission_items
      SET related_item_id = CASE id
        WHEN 'parameterized-preview-item' THEN 'parameterized-original-item'
        WHEN 'parameterized-original-item' THEN 'parameterized-preview-item'
      END
      WHERE id IN ('parameterized-preview-item', 'parameterized-original-item')
    `).run();

    database.prepare(`
      UPDATE comment_submission_items
      SET status = 'ready', asset_id = 'comment-parameterized-preview'
      WHERE id = 'parameterized-preview-item'
    `).run();
    expect(database.prepare(`SELECT COUNT(*) AS count FROM attachment_derivatives`).get())
      .toEqual({ count: 0 });

    database.prepare(`
      UPDATE comment_submission_items
      SET status = 'ready', storage_object_id = 'comment-parameterized-source'
      WHERE id = 'parameterized-original-item'
    `).run();

    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM attachment_derivatives
      WHERE source_sha256 = ?
    `).get(sourceSha)).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM blob_retention_edges
      WHERE source_type = 'attachment_derivative'
        AND blob_record_id = 'comment-parameterized-preview'
    `).get()).toEqual({ count: 0 });
    await expect(resolveManagedAttachmentBrowserPreview(
      db,
      "comment-parameterized-source",
      NOW,
    )).resolves.toBeNull();
    database.close();
  });
});
