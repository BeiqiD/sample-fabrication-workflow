PRAGMA foreign_keys = ON;

-- A Comment attachment is a child item, not the Comment itself. Whole-Comment
-- Trash keeps active child items durable. Explicitly deleting one ready child
-- item replaces only that occurrence's durable edge with a bounded 24-hour
-- restore edge for both R2 and managed-storage bytes.
DROP VIEW blob_retention_edges;
DROP VIEW blob_retention_edges_comment_items;

CREATE VIEW blob_retention_edges_comment_items AS
SELECT
  'r2' AS store_kind,
  'r2' AS provider,
  a.r2_key AS object_key,
  a.id AS blob_record_id,
  'comment_submission' AS source_type,
  cs.id AS source_id,
  'comment_submission_item' AS occurrence_type,
  csi.id AS occurrence_id,
  CASE WHEN csi.deleted_at IS NULL
    THEN 'ready_comment_item'
    ELSE 'deleted_comment_item_grace'
  END AS retention_reason,
  CASE WHEN csi.deleted_at IS NULL
    THEN NULL
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', csi.deleted_at, '+1 day')
  END AS retain_until
FROM comment_submission_items csi
JOIN comment_submissions cs ON cs.id = csi.submission_id
JOIN assets a ON a.id = csi.asset_id
WHERE cs.status = 'ready' AND csi.status = 'ready'
  AND (
    csi.deleted_at IS NULL
    OR datetime(csi.deleted_at, '+1 day') > datetime('now')
  )

UNION ALL
SELECT
  'r2', 'r2', a.r2_key, a.id,
  'comment_submission', cs.id,
  'comment_submission_item', csi.id,
  CASE WHEN cs.status = 'failed' THEN 'retryable_comment_item'
       ELSE 'unfinished_comment_item' END,
  cs.retry_until
FROM comment_submission_items csi
JOIN comment_submissions cs ON cs.id = csi.submission_id
JOIN assets a ON a.id = csi.asset_id
WHERE csi.status <> 'cancelled' AND csi.deleted_at IS NULL
  AND cs.retry_closed_at IS NULL
  AND cs.status IN ('draft', 'uploading', 'failed')

UNION ALL
SELECT
  'managed', mso.provider, mso.object_key, mso.id,
  'comment_submission', cs.id,
  'comment_submission_item', csi.id,
  CASE WHEN csi.deleted_at IS NULL
    THEN 'ready_comment_item'
    ELSE 'deleted_comment_item_grace'
  END,
  CASE WHEN csi.deleted_at IS NULL
    THEN NULL
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', csi.deleted_at, '+1 day')
  END
FROM comment_submission_items csi
JOIN comment_submissions cs ON cs.id = csi.submission_id
JOIN managed_storage_objects mso ON mso.id = csi.storage_object_id
WHERE cs.status = 'ready' AND csi.status = 'ready'
  AND (
    csi.deleted_at IS NULL
    OR datetime(csi.deleted_at, '+1 day') > datetime('now')
  )

UNION ALL
SELECT
  'managed', mso.provider, mso.object_key, mso.id,
  'comment_submission', cs.id,
  'comment_submission_item', csi.id,
  CASE WHEN cs.status = 'failed' THEN 'retryable_comment_item'
       ELSE 'unfinished_comment_item' END,
  cs.retry_until
FROM comment_submission_items csi
JOIN comment_submissions cs ON cs.id = csi.submission_id
JOIN managed_storage_objects mso ON mso.id = csi.storage_object_id
WHERE csi.status <> 'cancelled' AND csi.deleted_at IS NULL
  AND cs.retry_closed_at IS NULL
  AND cs.status IN ('draft', 'uploading', 'failed');

CREATE VIEW blob_retention_edges AS
SELECT * FROM blob_retention_edges_r2_occurrences
UNION ALL
SELECT * FROM blob_retention_edges_comment_items
UNION ALL
SELECT * FROM blob_retention_edges_direct_keys
UNION ALL
SELECT * FROM blob_retention_edges_project_attachments;

-- Re-activating an ordinary direct Run-step occurrence before provider deletion
-- clears a stale orphan claim. Superseded tombstones are immutable and
-- intentionally excluded from this restore path.
CREATE TRIGGER run_step_assets_guard_attachment_restore
BEFORE UPDATE OF deleted_at ON run_step_assets
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
  AND OLD.superseded_by_occurrence_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1
    FROM assets a
    JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2'
     AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1
    FROM assets a
    JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2'
     AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER run_step_assets_release_orphan_after_restore
AFTER UPDATE OF deleted_at ON run_step_assets
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
  AND OLD.superseded_by_occurrence_id IS NULL
BEGIN
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
END;

-- Restoring a Comment child after its guaranteed edge expires remains best-
-- effort until GC claims the locator. Clear an unclaimed orphan atomically;
-- never revive bytes that are deleting, deleted, or quarantined.
CREATE TRIGGER comment_submission_items_guard_attachment_restore
BEFORE UPDATE OF deleted_at ON comment_submission_items
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE (
    NEW.asset_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM assets a
      JOIN blob_gc_ledger bg
        ON bg.store_kind = 'r2' AND bg.provider = 'r2'
       AND bg.object_key = a.r2_key
      WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
    )
  ) OR (
    NEW.storage_object_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM managed_storage_objects mso
      JOIN blob_gc_ledger bg
        ON bg.store_kind = 'managed'
       AND bg.provider = mso.provider
       AND bg.object_key = mso.object_key
      WHERE mso.id = NEW.storage_object_id
        AND bg.state IN ('deleting', 'deleted')
    )
  );

  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE (
    NEW.asset_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM assets a
      JOIN blob_integrity_quarantine biq
        ON biq.store_kind = 'r2' AND biq.provider = 'r2'
       AND biq.object_key = a.r2_key
      WHERE a.id = NEW.asset_id
    )
  ) OR (
    NEW.storage_object_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM managed_storage_objects mso
      JOIN blob_integrity_quarantine biq
        ON biq.store_kind = 'managed'
       AND biq.provider = mso.provider
       AND biq.object_key = mso.object_key
      WHERE mso.id = NEW.storage_object_id
    )
  );
END;

CREATE TRIGGER comment_submission_items_release_orphan_after_restore
AFTER UPDATE OF deleted_at ON comment_submission_items
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  -- Managed GC marks the physical metadata row orphaned when it creates the
  -- ledger entry. Restoring the child occurrence must reverse both halves of
  -- that state transition in the same SQLite statement; otherwise the rebuilt
  -- retention edge would permanently protect an object that download routes
  -- still reject as non-ready.
  UPDATE managed_storage_objects
  SET status = 'ready',
      orphaned_at = NULL
  WHERE id = NEW.storage_object_id
    AND status = 'orphaned';

  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND NEW.asset_id IS NOT NULL
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);

  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'managed' AND state = 'orphaned'
    AND NEW.storage_object_id IS NOT NULL
    AND (provider, object_key) = (
      SELECT provider, object_key
      FROM managed_storage_objects
      WHERE id = NEW.storage_object_id
    );
END;
