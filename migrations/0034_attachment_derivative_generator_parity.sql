PRAGMA foreign_keys = ON;

-- 0033 introduced the shared derivative registry, but its SQL-side generator
-- classifier did not exactly match the runtime classifier. Normalize filename
-- and base MIME here with an explicit whitespace contract and ASCII-only case
-- fold, then rebuild the 0033 backfill before this feature is deployed. The
-- pre-0034 runtime cannot write attachment_derivatives, so the rows present here
-- are migration-created cache metadata, not user/domain state.
--
-- Browser-safe derived asset MIME uses the same base-MIME rule as media
-- responses: strip parameters, trim the explicit classification whitespace set,
-- ASCII-fold, then compare the canonical raster type. Keep that rule in one SQL
-- view so registration guards, winner checks, adoption, runtime lookup, and
-- retention all agree for values such as `image/webp; charset=binary`.
DROP TRIGGER comment_submission_items_adopt_derivative_after_update;
DROP VIEW attachment_derivative_comment_candidates;
DROP TRIGGER attachment_derivatives_lock_healthy_winner;
DROP TRIGGER attachment_derivatives_guard_ready_insert;
DROP TRIGGER attachment_derivatives_guard_ready_update;
DROP VIEW blob_retention_edges;
DROP VIEW blob_retention_edges_attachment_derivatives;

CREATE VIEW attachment_derivative_browser_safe_assets AS
WITH classification_whitespace(value) AS (
  SELECT
    char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
    || char(160) || char(5760)
    || char(8192) || char(8193) || char(8194) || char(8195) || char(8196)
    || char(8197) || char(8198) || char(8199) || char(8200) || char(8201)
    || char(8202) || char(8232) || char(8233) || char(8239) || char(8287)
    || char(12288) || char(65279)
),
trimmed_assets AS (
  SELECT
    a.id,
    a.r2_key,
    a.original_name,
    a.mime_type,
    a.byte_size,
    a.sha256,
    trim(CASE
      WHEN instr(a.mime_type, ';') > 0
        THEN substr(a.mime_type, 1, instr(a.mime_type, ';') - 1)
      ELSE a.mime_type
    END, classification_whitespace.value) AS trimmed_mime_type
  FROM assets a
  CROSS JOIN classification_whitespace
  WHERE a.status = 'ready'
    AND instr(a.mime_type, char(0)) = 0
),
normalized_assets AS (
  SELECT
    id,
    r2_key,
    original_name,
    mime_type,
    byte_size,
    sha256,
    replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(trimmed_mime_type, 'A', 'a'), 'B', 'b'), 'C', 'c'), 'D', 'd'), 'E', 'e'), 'F', 'f'), 'G', 'g'), 'H', 'h'), 'I', 'i'), 'J', 'j'), 'K', 'k'), 'L', 'l'), 'M', 'm'), 'N', 'n'), 'O', 'o'), 'P', 'p'), 'Q', 'q'), 'R', 'r'), 'S', 's'), 'T', 't'), 'U', 'u'), 'V', 'v'), 'W', 'w'), 'X', 'x'), 'Y', 'y'), 'Z', 'z') AS normalized_mime_type
  FROM trimmed_assets
)
SELECT
  id,
  r2_key,
  original_name,
  mime_type,
  byte_size,
  sha256,
  normalized_mime_type
FROM normalized_assets
WHERE normalized_mime_type IN (
  'image/avif', 'image/bmp', 'image/gif',
  'image/jpeg', 'image/png', 'image/webp'
);

CREATE TRIGGER attachment_derivatives_lock_healthy_winner
BEFORE UPDATE OF derived_asset_id ON attachment_derivatives
WHEN OLD.status = 'ready'
  AND NEW.derived_asset_id IS NOT OLD.derived_asset_id
BEGIN
  SELECT RAISE(ABORT, 'healthy attachment derivative winner is immutable')
  WHERE EXISTS (
    SELECT 1
    FROM attachment_derivative_browser_safe_assets current_asset
    WHERE current_asset.id = OLD.derived_asset_id
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = current_asset.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = current_asset.r2_key
      )
  );
END;

CREATE TRIGGER attachment_derivatives_guard_ready_insert
BEFORE INSERT ON attachment_derivatives
WHEN NEW.status = 'ready'
BEGIN
  SELECT RAISE(ABORT, 'attachment derivative asset is unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM assets a
    WHERE a.id = NEW.derived_asset_id AND a.status = 'ready'
  ) OR EXISTS (
    SELECT 1
    FROM assets a
    JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2'
     AND bg.object_key = a.r2_key
    WHERE a.id = NEW.derived_asset_id
      AND bg.state IN ('deleting', 'deleted')
  );

  SELECT RAISE(ABORT, 'attachment derivative asset is quarantined')
  WHERE EXISTS (
    SELECT 1
    FROM assets a
    JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2'
     AND biq.object_key = a.r2_key
    WHERE a.id = NEW.derived_asset_id
  );

  SELECT RAISE(ABORT, 'attachment derivative asset is not browser-safe')
  WHERE NOT EXISTS (
    SELECT 1 FROM attachment_derivative_browser_safe_assets a
    WHERE a.id = NEW.derived_asset_id
  );
END;

CREATE TRIGGER attachment_derivatives_guard_ready_update
BEFORE UPDATE OF status, derived_asset_id, retain_until ON attachment_derivatives
WHEN NEW.status = 'ready'
BEGIN
  SELECT RAISE(ABORT, 'attachment derivative asset is unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM assets a
    WHERE a.id = NEW.derived_asset_id AND a.status = 'ready'
  ) OR EXISTS (
    SELECT 1
    FROM assets a
    JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2'
     AND bg.object_key = a.r2_key
    WHERE a.id = NEW.derived_asset_id
      AND bg.state IN ('deleting', 'deleted')
  );

  SELECT RAISE(ABORT, 'attachment derivative asset is quarantined')
  WHERE EXISTS (
    SELECT 1
    FROM assets a
    JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2'
     AND biq.object_key = a.r2_key
    WHERE a.id = NEW.derived_asset_id
  );

  SELECT RAISE(ABORT, 'attachment derivative asset is not browser-safe')
  WHERE NOT EXISTS (
    SELECT 1 FROM attachment_derivative_browser_safe_assets a
    WHERE a.id = NEW.derived_asset_id
  );
END;

CREATE VIEW attachment_derivative_comment_candidates AS
WITH classification_whitespace(value) AS (
  -- Exact ECMAScript WhiteSpace + LineTerminator set used by String.trim():
  -- HTAB, LF, VT, FF, CR, SPACE, NBSP, OGHAM SPACE MARK, U+2000..U+200A,
  -- LINE/PARAGRAPH SEPARATOR, NNBSP, MMSP, IDEOGRAPHIC SPACE, BOM.
  SELECT
    char(9) || char(10) || char(11) || char(12) || char(13) || char(32)
    || char(160) || char(5760)
    || char(8192) || char(8193) || char(8194) || char(8195) || char(8196)
    || char(8197) || char(8198) || char(8199) || char(8200) || char(8201)
    || char(8202) || char(8232) || char(8233) || char(8239) || char(8287)
    || char(12288) || char(65279)
),
trimmed_candidates AS (
  SELECT
    cs.id AS submission_id,
    image.id AS preview_item_id,
    original.id AS original_item_id,
    mso.sha256 AS source_sha256,
    mso.byte_size AS source_byte_size,
    trim(mso.original_name, classification_whitespace.value) AS trimmed_filename,
    trim(CASE
      WHEN instr(mso.mime_type, ';') > 0
        THEN substr(mso.mime_type, 1, instr(mso.mime_type, ';') - 1)
      ELSE mso.mime_type
    END, classification_whitespace.value) AS trimmed_mime_type,
    image.asset_id AS derived_asset_id,
    cs.actor_email AS actor_email
  FROM comment_submission_items image
  JOIN comment_submission_items original
    ON original.submission_id = image.submission_id
   AND image.kind = 'comment_image'
   AND original.kind = 'attachment'
   AND image.related_item_id = original.id
   AND original.related_item_id = image.id
  JOIN comment_submissions cs
    ON cs.id = image.submission_id
  JOIN managed_storage_objects mso
    ON mso.id = original.storage_object_id
   AND mso.status = 'ready'
  JOIN attachment_derivative_browser_safe_assets preview
    ON preview.id = image.asset_id
  CROSS JOIN classification_whitespace
  WHERE image.status = 'ready'
    AND original.status = 'ready'
    AND image.deleted_at IS NULL
    AND original.deleted_at IS NULL
    AND cs.deleted_at IS NULL
    AND cs.status <> 'cancelled'
    AND length(mso.sha256) = 64
    AND instr(mso.sha256, char(0)) = 0
    AND mso.sha256 NOT GLOB '*[^0-9a-f]*'
    AND typeof(mso.byte_size) = 'integer'
    AND mso.byte_size > 0
    AND mso.byte_size <= 9007199254740991
    AND instr(mso.original_name, char(0)) = 0
    AND instr(mso.mime_type, char(0)) = 0
    AND NOT EXISTS (
      SELECT 1 FROM blob_gc_ledger bg
      WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
        AND bg.object_key = preview.r2_key
        AND bg.state IN ('deleting', 'deleted')
    )
    AND NOT EXISTS (
      SELECT 1 FROM blob_integrity_quarantine biq
      WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
        AND biq.object_key = preview.r2_key
    )
    AND NOT EXISTS (
      SELECT 1 FROM blob_gc_ledger bg
      WHERE bg.store_kind = 'managed'
        AND bg.provider = mso.provider
        AND bg.object_key = mso.object_key
        AND bg.state IN ('deleting', 'deleted')
    )
    AND NOT EXISTS (
      SELECT 1 FROM blob_integrity_quarantine biq
      WHERE biq.store_kind = 'managed'
        AND biq.provider = mso.provider
        AND biq.object_key = mso.object_key
    )
),
normalized_candidates AS (
  SELECT
    submission_id,
    preview_item_id,
    original_item_id,
    source_sha256,
    source_byte_size,
    replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(trimmed_filename, 'A', 'a'), 'B', 'b'), 'C', 'c'), 'D', 'd'), 'E', 'e'), 'F', 'f'), 'G', 'g'), 'H', 'h'), 'I', 'i'), 'J', 'j'), 'K', 'k'), 'L', 'l'), 'M', 'm'), 'N', 'n'), 'O', 'o'), 'P', 'p'), 'Q', 'q'), 'R', 'r'), 'S', 's'), 'T', 't'), 'U', 'u'), 'V', 'v'), 'W', 'w'), 'X', 'x'), 'Y', 'y'), 'Z', 'z') AS normalized_filename,
    replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(trimmed_mime_type, 'A', 'a'), 'B', 'b'), 'C', 'c'), 'D', 'd'), 'E', 'e'), 'F', 'f'), 'G', 'g'), 'H', 'h'), 'I', 'i'), 'J', 'j'), 'K', 'k'), 'L', 'l'), 'M', 'm'), 'N', 'n'), 'O', 'o'), 'P', 'p'), 'Q', 'q'), 'R', 'r'), 'S', 's'), 'T', 't'), 'U', 'u'), 'V', 'v'), 'W', 'w'), 'X', 'x'), 'Y', 'y'), 'Z', 'z') AS normalized_mime_type,
    derived_asset_id,
    actor_email
  FROM trimmed_candidates
)
SELECT
  submission_id,
  preview_item_id,
  original_item_id,
  source_sha256,
  source_byte_size,
  CASE
    WHEN normalized_mime_type IN ('image/tiff', 'image/x-tiff')
      OR normalized_filename GLOB '*.tif'
      OR normalized_filename GLOB '*.tiff'
      THEN 'comment-tiff-webp-1600-q45-v1'
    ELSE 'comment-raster-webp-1600-q45-v1'
  END AS generator_version,
  derived_asset_id,
  actor_email
FROM normalized_candidates
WHERE
  normalized_mime_type IN ('image/tiff', 'image/x-tiff')
  OR normalized_filename GLOB '*.tif'
  OR normalized_filename GLOB '*.tiff'
  OR (
    length(normalized_mime_type) BETWEEN 7 AND 200
    AND substr(normalized_mime_type, 1, 6) = 'image/'
    AND length(substr(normalized_mime_type, 7)) > 0
    AND substr(normalized_mime_type, 7)
      NOT GLOB '*[^a-z0-9!#$%&''*+.^_`|~-]*'
  );

-- 0033 and 0034 ship together, before any deployed runtime knows how to write
-- this cache table. Rebuild the migration-created rows instead of trying to
-- infer which old generator identity should survive.
DELETE FROM attachment_derivatives;

INSERT OR IGNORE INTO attachment_derivatives (
  id,
  source_sha256,
  source_byte_size,
  derivative_kind,
  generator_version,
  derived_asset_id,
  status,
  error_code,
  retain_until,
  actor_email,
  created_at,
  updated_at
)
SELECT
  lower(hex(randomblob(16))),
  candidate.source_sha256,
  candidate.source_byte_size,
  'browser_preview',
  candidate.generator_version,
  candidate.derived_asset_id,
  'ready',
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days'),
  candidate.actor_email,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM attachment_derivative_comment_candidates candidate;

CREATE TRIGGER comment_submission_items_adopt_derivative_after_update
AFTER UPDATE OF
  status,
  asset_id,
  storage_object_id,
  related_item_id,
  deleted_at
ON comment_submission_items
BEGIN
  INSERT INTO attachment_derivatives (
    id,
    source_sha256,
    source_byte_size,
    derivative_kind,
    generator_version,
    derived_asset_id,
    status,
    error_code,
    retain_until,
    actor_email,
    created_at,
    updated_at
  )
  SELECT
    lower(hex(randomblob(16))),
    candidate.source_sha256,
    candidate.source_byte_size,
    'browser_preview',
    candidate.generator_version,
    candidate.derived_asset_id,
    'ready',
    NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days'),
    candidate.actor_email,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM attachment_derivative_comment_candidates candidate
  WHERE candidate.submission_id = NEW.submission_id
    AND (candidate.preview_item_id = NEW.id OR candidate.original_item_id = NEW.id)
  ON CONFLICT(
    source_sha256,
    source_byte_size,
    derivative_kind,
    generator_version
  ) DO UPDATE SET
    status = 'ready',
    derived_asset_id = CASE
      WHEN attachment_derivatives.status = 'failed'
        OR NOT EXISTS (
          SELECT 1
          FROM attachment_derivative_browser_safe_assets current_asset
          WHERE current_asset.id = attachment_derivatives.derived_asset_id
            AND NOT EXISTS (
              SELECT 1 FROM blob_gc_ledger bg
              WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
                AND bg.object_key = current_asset.r2_key
                AND bg.state IN ('deleting', 'deleted')
            )
            AND NOT EXISTS (
              SELECT 1 FROM blob_integrity_quarantine biq
              WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
                AND biq.object_key = current_asset.r2_key
            )
        )
        THEN excluded.derived_asset_id
      ELSE attachment_derivatives.derived_asset_id
    END,
    error_code = NULL,
    retain_until = CASE
      WHEN attachment_derivatives.retain_until IS NULL
        OR datetime(attachment_derivatives.retain_until) < datetime(excluded.retain_until)
        THEN excluded.retain_until
      ELSE attachment_derivatives.retain_until
    END,
    actor_email = COALESCE(attachment_derivatives.actor_email, excluded.actor_email),
    updated_at = excluded.updated_at;
END;

CREATE VIEW blob_retention_edges_attachment_derivatives AS
SELECT
  'r2' AS store_kind,
  'r2' AS provider,
  a.r2_key AS object_key,
  a.id AS blob_record_id,
  'attachment_derivative' AS source_type,
  ad.id AS source_id,
  'attachment_derivative' AS occurrence_type,
  ad.id AS occurrence_id,
  'derivative_cache' AS retention_reason,
  ad.retain_until AS retain_until
FROM attachment_derivatives ad
JOIN attachment_derivative_browser_safe_assets a
  ON a.id = ad.derived_asset_id
WHERE ad.status = 'ready'
  AND ad.retain_until IS NOT NULL
  AND datetime(ad.retain_until) > datetime('now')
  AND NOT EXISTS (
    SELECT 1 FROM blob_gc_ledger bg
    WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
      AND bg.object_key = a.r2_key
      AND bg.state IN ('deleting', 'deleted')
  )
  AND NOT EXISTS (
    SELECT 1 FROM blob_integrity_quarantine biq
    WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
      AND biq.object_key = a.r2_key
  );

CREATE VIEW blob_retention_edges AS
SELECT * FROM blob_retention_edges_r2_occurrences
UNION ALL
SELECT * FROM blob_retention_edges_comment_items
UNION ALL
SELECT * FROM blob_retention_edges_direct_keys
UNION ALL
SELECT * FROM blob_retention_edges_project_attachments
UNION ALL
SELECT * FROM blob_retention_edges_attachment_derivatives;
