PRAGMA foreign_keys = ON;

-- The first blob-lifecycle review identified one additional R2 occurrence:
-- sample-record thumbnails stored in events.metadata_json. Rebuild the derived
-- retention surface so thumbnails are retained and explicit retry closure is
-- authoritative for every unfinished submission state.
DROP VIEW blob_retention_edges;

CREATE VIEW blob_retention_edges AS
SELECT
  'r2' AS store_kind,
  'r2' AS provider,
  a.r2_key AS object_key,
  a.id AS blob_record_id,
  'state_representation' AS source_type,
  sra.state_hash AS source_id,
  'state_representation_asset' AS occurrence_type,
  sra.state_hash || ':' || sra.asset_id AS occurrence_id,
  'state_representation' AS retention_reason,
  NULL AS retain_until
FROM state_representation_assets sra
JOIN assets a ON a.id = sra.asset_id

UNION ALL
SELECT
  'r2', 'r2', a.r2_key, a.id,
  'run_step', rsa.run_step_id,
  'run_step_asset', rsa.id,
  'run_step_asset', NULL
FROM run_step_assets rsa
JOIN assets a ON a.id = rsa.asset_id

UNION ALL
SELECT
  'r2', 'r2', a.r2_key, a.id,
  'template_version', mtr.template_version_id,
  'metrology_template_reference', mtr.id,
  'metrology_template_reference', NULL
FROM metrology_template_references mtr
JOIN assets a ON a.id = mtr.asset_id

UNION ALL
SELECT
  'r2', 'r2', a.r2_key, a.id,
  'run_step_comment', rsc.id,
  'run_step_comment_asset', rsc.id,
  'legacy_comment_asset', NULL
FROM run_step_comments rsc
JOIN assets a ON a.id = rsc.asset_id

UNION ALL
SELECT
  'r2', 'r2', a.r2_key, a.id,
  'state_verification', sv.id,
  'state_verification_evidence', sv.id,
  'verification_evidence', NULL
FROM state_verifications sv
JOIN assets a ON a.id = sv.evidence_asset_id

UNION ALL
SELECT
  'r2', 'r2', a.r2_key, a.id,
  'comment_submission', cs.id,
  'comment_submission_item', csi.id,
  'ready_comment_item', NULL
FROM comment_submission_items csi
JOIN comment_submissions cs ON cs.id = csi.submission_id
JOIN assets a ON a.id = csi.asset_id
WHERE cs.status = 'ready' AND csi.status = 'ready'

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
WHERE csi.status <> 'cancelled'
  AND cs.retry_closed_at IS NULL
  AND cs.status IN ('draft', 'uploading', 'failed')

UNION ALL
SELECT
  'managed', mso.provider, mso.object_key, mso.id,
  'comment_submission', cs.id,
  'comment_submission_item', csi.id,
  'ready_comment_item', NULL
FROM comment_submission_items csi
JOIN comment_submissions cs ON cs.id = csi.submission_id
JOIN managed_storage_objects mso ON mso.id = csi.storage_object_id
WHERE cs.status = 'ready' AND csi.status = 'ready'

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
WHERE csi.status <> 'cancelled'
  AND cs.retry_closed_at IS NULL
  AND cs.status IN ('draft', 'uploading', 'failed')

UNION ALL
SELECT
  'r2', 'r2', e.asset_key, a.id,
  'sample', e.sample_id,
  'event', e.id,
  'legacy_event_asset', NULL
FROM events e
LEFT JOIN assets a ON a.r2_key = e.asset_key
WHERE e.asset_key IS NOT NULL AND e.asset_key <> ''

UNION ALL
SELECT
  'r2', 'r2', thumbnails.thumbnail_key, a.id,
  'sample', thumbnails.sample_id,
  'event_thumbnail', thumbnails.id || ':thumbnail',
  'sample_record_thumbnail', NULL
FROM (
  SELECT e.id, e.sample_id, e.asset_key,
         CASE WHEN json_valid(e.metadata_json)
              THEN json_extract(e.metadata_json, '$.thumbnailKey') END AS thumbnail_key
  FROM events e
) thumbnails
LEFT JOIN assets a ON a.r2_key = thumbnails.thumbnail_key
WHERE typeof(thumbnails.thumbnail_key) = 'text'
  AND NULLIF(TRIM(thumbnails.thumbnail_key), '') IS NOT NULL
  AND thumbnails.thumbnail_key IS NOT thumbnails.asset_key

UNION ALL
SELECT
  'r2', 'r2', i.workbook_asset_key, a.id,
  'import', i.id,
  'import_workbook', i.id || ':workbook',
  'import_provenance', NULL
FROM imports i
LEFT JOIN assets a ON a.r2_key = i.workbook_asset_key
WHERE i.workbook_asset_key IS NOT NULL AND i.workbook_asset_key <> ''

UNION ALL
SELECT
  'r2', 'r2', i.manifest_asset_key, a.id,
  'import', i.id,
  'import_manifest', i.id || ':manifest',
  'import_provenance', NULL
FROM imports i
LEFT JOIN assets a ON a.r2_key = i.manifest_asset_key
WHERE i.manifest_asset_key IS NOT NULL AND i.manifest_asset_key <> ''

UNION ALL
SELECT
  'r2', 'r2', tv.source_asset_key, a.id,
  'template_version', tv.id,
  'template_source', tv.id || ':source',
  'template_provenance', NULL
FROM template_versions tv
LEFT JOIN assets a ON a.r2_key = tv.source_asset_key
WHERE tv.source_asset_key IS NOT NULL AND tv.source_asset_key <> '';

CREATE INDEX events_thumbnail_asset_key_idx
ON events(
  CASE WHEN json_valid(metadata_json)
       THEN json_extract(metadata_json, '$.thumbnailKey') END
)
WHERE typeof(
    CASE WHEN json_valid(metadata_json)
         THEN json_extract(metadata_json, '$.thumbnailKey') END
  ) = 'text'
  AND NULLIF(TRIM(
    CASE WHEN json_valid(metadata_json)
         THEN json_extract(metadata_json, '$.thumbnailKey') END
  ), '') IS NOT NULL;

-- A thumbnail is an ordinary retention edge even though its key is stored in
-- event metadata for frontend compatibility. Reject claimed/deleted locators
-- and release an unclaimed orphan in the same statement that creates the edge.
CREATE TRIGGER events_guard_thumbnail_insert
BEFORE INSERT ON events
WHEN NULLIF(TRIM(CASE WHEN json_valid(NEW.metadata_json)
  THEN json_extract(NEW.metadata_json, '$.thumbnailKey') END), '') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key = json_extract(NEW.metadata_json, '$.thumbnailKey')
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2'
    AND object_key = json_extract(NEW.metadata_json, '$.thumbnailKey')
    AND state = 'orphaned';
END;

CREATE TRIGGER events_guard_thumbnail_update
BEFORE UPDATE OF metadata_json ON events
WHEN NULLIF(TRIM(CASE WHEN json_valid(NEW.metadata_json)
  THEN json_extract(NEW.metadata_json, '$.thumbnailKey') END), '') IS NOT NULL
  AND CASE WHEN json_valid(OLD.metadata_json)
        THEN json_extract(OLD.metadata_json, '$.thumbnailKey') END
      IS NOT CASE WHEN json_valid(NEW.metadata_json)
        THEN json_extract(NEW.metadata_json, '$.thumbnailKey') END
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key = json_extract(NEW.metadata_json, '$.thumbnailKey')
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2'
    AND object_key = json_extract(NEW.metadata_json, '$.thumbnailKey')
    AND state = 'orphaned';
END;

-- Existing upload routes recover a concurrent content-addressed insert by
-- recognizing SQLite's UNIQUE error and loading the winning ready row. Keep the
-- custom live-locator constraint compatible with that recovery path.
DROP TRIGGER assets_reject_live_sha_duplicate;

CREATE TRIGGER assets_reject_live_sha_duplicate
BEFORE INSERT ON assets
WHEN NEW.sha256 IS NOT NULL AND EXISTS (
  SELECT 1
  FROM assets a
  WHERE a.sha256 = NEW.sha256 AND a.status = 'ready'
    AND NOT EXISTS (
      SELECT 1 FROM blob_gc_ledger bg
      WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
        AND bg.object_key = a.r2_key
        AND bg.state IN ('deleting', 'deleted')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live asset sha256 already registered');
END;
