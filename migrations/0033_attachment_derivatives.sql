PRAGMA foreign_keys = ON;

-- Slice D1 introduces a domain-neutral registry for rebuildable browser previews.
-- Source identity is content-addressed (SHA-256 + byte size), so one preview can
-- be reused regardless of whether source bytes currently live in R2 or managed
-- storage and regardless of which domain occurrence references them.
--
-- This registry is presentation cache only. It never certifies scientific
-- provenance and never retains the source blob. Only derived preview bytes gain
-- the bounded cache edge below.
CREATE TABLE attachment_derivatives (
  id TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL,
  source_byte_size INTEGER NOT NULL,
  derivative_kind TEXT NOT NULL CHECK (derivative_kind = 'browser_preview'),
  generator_version TEXT NOT NULL,
  derived_asset_id TEXT REFERENCES assets(id),
  status TEXT NOT NULL CHECK (status IN ('ready', 'failed')),
  error_code TEXT,
  retain_until TEXT,
  actor_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    length(source_sha256) = 64
    AND instr(source_sha256, char(0)) = 0
    AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    typeof(source_byte_size) = 'integer'
    AND source_byte_size > 0
    AND source_byte_size <= 9007199254740991
  ),
  CHECK (
    length(generator_version) BETWEEN 1 AND 128
    AND instr(generator_version, char(0)) = 0
  ),
  CHECK (
    (status = 'ready'
      AND derived_asset_id IS NOT NULL
      AND error_code IS NULL
      AND retain_until IS NOT NULL
      AND datetime(retain_until) IS NOT NULL)
    OR
    (status = 'failed'
      AND derived_asset_id IS NULL
      AND error_code IS NOT NULL
      AND length(error_code) BETWEEN 1 AND 500
      AND instr(error_code, char(0)) = 0
      AND retain_until IS NULL)
  )
);

CREATE UNIQUE INDEX attachment_derivatives_identity_idx
ON attachment_derivatives(
  source_sha256,
  source_byte_size,
  derivative_kind,
  generator_version
);

CREATE INDEX attachment_derivatives_asset_idx
ON attachment_derivatives(derived_asset_id)
WHERE derived_asset_id IS NOT NULL;

CREATE INDEX attachment_derivatives_retention_idx
ON attachment_derivatives(status, retain_until);

-- Source identity and generator contract are immutable. A failed derivative may
-- later become ready and a ready cache lease may be extended, but callers may
-- not silently reinterpret one identity as another.
CREATE TRIGGER attachment_derivatives_lock_identity
BEFORE UPDATE OF
  source_sha256,
  source_byte_size,
  derivative_kind,
  generator_version
ON attachment_derivatives
BEGIN
  SELECT RAISE(ABORT, 'attachment derivative identity is immutable');
END;

-- Once a healthy ready winner exists, another candidate cannot replace it.
-- Replacement is allowed only after the current derived asset is no longer a
-- usable browser-preview locator (failed, unsafe, deleting/deleted, or
-- quarantined).
CREATE TRIGGER attachment_derivatives_lock_healthy_winner
BEFORE UPDATE OF derived_asset_id ON attachment_derivatives
WHEN OLD.status = 'ready'
  AND NEW.derived_asset_id IS NOT OLD.derived_asset_id
BEGIN
  SELECT RAISE(ABORT, 'healthy attachment derivative winner is immutable')
  WHERE EXISTS (
    SELECT 1
    FROM assets current_asset
    WHERE current_asset.id = OLD.derived_asset_id
      AND current_asset.status = 'ready'
      AND lower(current_asset.mime_type) IN (
        'image/avif', 'image/bmp', 'image/gif',
        'image/jpeg', 'image/png', 'image/webp'
      )
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

CREATE TRIGGER attachment_derivatives_keep_ready
BEFORE UPDATE OF status ON attachment_derivatives
WHEN OLD.status = 'ready' AND NEW.status <> 'ready'
BEGIN
  SELECT RAISE(ABORT, 'ready attachment derivative cannot be demoted');
END;

-- A ready derivative can bind only a live, non-quarantined browser-safe R2
-- image. BEFORE triggers are pure guards: a losing candidate must never clear
-- its own orphan ledger as a side effect.
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
    SELECT 1 FROM assets a
    WHERE a.id = NEW.derived_asset_id
      AND lower(a.mime_type) IN (
        'image/avif', 'image/bmp', 'image/gif',
        'image/jpeg', 'image/png', 'image/webp'
      )
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
    SELECT 1 FROM assets a
    WHERE a.id = NEW.derived_asset_id
      AND lower(a.mime_type) IN (
        'image/avif', 'image/bmp', 'image/gif',
        'image/jpeg', 'image/png', 'image/webp'
      )
  );
END;

-- Only a ready registry winner with a future lease may revive an unclaimed
-- orphan. An expired row remains valid metadata but contributes no retention
-- edge until a resolver renews its lease.
CREATE TRIGGER attachment_derivatives_release_orphan_after_insert
AFTER INSERT ON attachment_derivatives
WHEN NEW.status = 'ready'
  AND NEW.retain_until IS NOT NULL
  AND datetime(NEW.retain_until) > datetime('now')
BEGIN
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (
      SELECT r2_key FROM assets WHERE id = NEW.derived_asset_id
    );
END;

CREATE TRIGGER attachment_derivatives_release_orphan_after_binding_update
AFTER UPDATE OF status, derived_asset_id ON attachment_derivatives
WHEN NEW.status = 'ready'
  AND NEW.retain_until IS NOT NULL
  AND datetime(NEW.retain_until) > datetime('now')
BEGIN
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (
      SELECT r2_key FROM assets WHERE id = NEW.derived_asset_id
    );
END;

CREATE TRIGGER attachment_derivatives_release_orphan_after_lease_touch
AFTER UPDATE OF retain_until ON attachment_derivatives
WHEN NEW.status = 'ready'
  AND NEW.retain_until IS NOT NULL
  AND datetime(NEW.retain_until) > datetime('now')
BEGIN
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (
      SELECT r2_key FROM assets WHERE id = NEW.derived_asset_id
    );
END;

-- Existing Comment preview/original pairs become the first producer adapter.
-- The candidate projection includes only locators that are safe to adopt. This
-- makes migration backfill fail-soft: one invalid, quarantined, or GC-claimed
-- pair cannot abort the schema migration.
CREATE VIEW attachment_derivative_comment_candidates AS
SELECT
  cs.id AS submission_id,
  image.id AS preview_item_id,
  original.id AS original_item_id,
  mso.sha256 AS source_sha256,
  mso.byte_size AS source_byte_size,
  CASE
    WHEN lower(trim(CASE
      WHEN instr(mso.mime_type, ';') > 0
        THEN substr(mso.mime_type, 1, instr(mso.mime_type, ';') - 1)
      ELSE mso.mime_type
    END)) IN ('image/tiff', 'image/x-tiff')
      OR lower(mso.original_name) GLOB '*.tif'
      OR lower(mso.original_name) GLOB '*.tiff'
      THEN 'comment-tiff-webp-1600-q45-v1'
    ELSE 'comment-raster-webp-1600-q45-v1'
  END AS generator_version,
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
JOIN assets preview
  ON preview.id = image.asset_id
 AND preview.status = 'ready'
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
  AND (
    lower(mso.original_name) GLOB '*.tif'
    OR lower(mso.original_name) GLOB '*.tiff'
    OR lower(trim(CASE
      WHEN instr(mso.mime_type, ';') > 0
        THEN substr(mso.mime_type, 1, instr(mso.mime_type, ';') - 1)
      ELSE mso.mime_type
    END)) LIKE 'image/%'
  )
  AND lower(preview.mime_type) IN (
    'image/avif', 'image/bmp', 'image/gif',
    'image/jpeg', 'image/png', 'image/webp'
  )
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
  );

-- Backfill already-complete safe preview/original pairs. The migration starts
-- with an empty registry, so no winner reconciliation is needed here.
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

-- Future Comment item readiness/restoration adopts the pair. A healthy existing
-- winner is preserved; failed/stale/unsafe entries may adopt the new live
-- preview. Comment ownership and delete/restore dependencies remain unchanged.
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
          FROM assets current_asset
          WHERE current_asset.id = attachment_derivatives.derived_asset_id
            AND current_asset.status = 'ready'
            AND lower(current_asset.mime_type) IN (
              'image/avif', 'image/bmp', 'image/gif',
              'image/jpeg', 'image/png', 'image/webp'
            )
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

-- Derivative bytes are cacheable/rebuildable. A lease contributes a retention
-- edge only while its bound asset is still a usable browser-preview locator;
-- stale/unsafe/quarantined cache rows remain audit metadata but must not block GC.
-- Source blobs are NEVER retained by this registry.
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
JOIN assets a
  ON a.id = ad.derived_asset_id
 AND a.status = 'ready'
 AND lower(a.mime_type) IN (
   'image/avif', 'image/bmp', 'image/gif',
   'image/jpeg', 'image/png', 'image/webp'
 )
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

DROP VIEW blob_retention_edges;

-- workerd limits a compound SELECT to five terms. Keep the public surface at
-- exactly five leaf views; callers continue to query one authoritative view.
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
