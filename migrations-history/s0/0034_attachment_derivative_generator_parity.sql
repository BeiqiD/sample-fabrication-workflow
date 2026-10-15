PRAGMA foreign_keys = ON;

-- 0033 introduced the shared derivative registry. Normalize browser-safe
-- derived-asset MIME here with an explicit whitespace contract and ASCII-only
-- case fold. Earlier Draft revisions also introduced a client-Comment adoption
-- view/trigger; drop those adapters when present and purge any rows they wrote.
--
-- Browser-safe derived asset MIME uses the same base-MIME rule as media
-- responses: strip parameters, trim the explicit classification whitespace set,
-- ASCII-fold, then compare the canonical raster type. Keep that rule in one SQL
-- view so registration guards, winner checks, runtime lookup, and retention all
-- agree for values such as `image/webp; charset=binary`.
DROP TRIGGER IF EXISTS comment_submission_items_adopt_derivative_after_update;
DROP VIEW IF EXISTS attachment_derivative_comment_candidates;
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

-- Rows produced by an earlier Draft Comment-adoption adapter are untrusted
-- cache metadata. Derived assets remain ordinary assets and can be collected by
-- normal reachability after these registry rows are removed.
DELETE FROM attachment_derivatives;

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
