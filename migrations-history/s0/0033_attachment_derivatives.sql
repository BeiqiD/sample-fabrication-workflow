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

-- Client-uploaded Comment previews remain occurrence-owned assets. Filename,
-- MIME, size, and reciprocal item relationships do not prove that preview bytes
-- were generated from the paired source. Only a trusted server producer may
-- register a shared derivative after reading verified source bytes.

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
