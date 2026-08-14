PRAGMA foreign_keys = ON;

-- A content-addressed metadata row is reusable only while its physical object
-- can still be verified at the provider. Definite absence and definite size
-- mismatch are terminal for that locator: preserve metadata and existing
-- relationships for audit/export, but never silently reuse or auto-clear it.
CREATE TABLE blob_integrity_quarantine (
  store_kind TEXT NOT NULL CHECK (store_kind IN ('r2', 'managed')),
  provider TEXT NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 100),
  object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 2048),
  blob_record_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('missing', 'size_mismatch')),
  expected_byte_size INTEGER NOT NULL CHECK (
    typeof(expected_byte_size) = 'integer'
    AND expected_byte_size BETWEEN 0 AND 9007199254740991
  ),
  observed_byte_size INTEGER CHECK (
    observed_byte_size IS NULL OR (
      typeof(observed_byte_size) = 'integer'
      AND observed_byte_size BETWEEN 0 AND 9007199254740991
    )
  ),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
  detected_at TEXT NOT NULL CHECK (length(detected_at) > 0),
  last_checked_at TEXT NOT NULL CHECK (length(last_checked_at) > 0),
  PRIMARY KEY (store_kind, provider, object_key)
);

CREATE INDEX blob_integrity_quarantine_record_idx
ON blob_integrity_quarantine(store_kind, blob_record_id)
WHERE blob_record_id IS NOT NULL;

-- FabuBlox import publication uses an explicit lease and immutable request /
-- finalization identities. A stale pending import can therefore be claimed by
-- scheduled recovery without guessing from age alone.
ALTER TABLE imports ADD COLUMN operation_id TEXT;
ALTER TABLE imports ADD COLUMN lease_expires_at TEXT;
ALTER TABLE imports ADD COLUMN finalization_id TEXT;
ALTER TABLE imports ADD COLUMN recovery_operation_id TEXT;

UPDATE imports
SET operation_id = 'migration:0024:' || id
WHERE operation_id IS NULL;

UPDATE imports
SET lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1 day')
WHERE status = 'pending' AND lease_expires_at IS NULL;

CREATE UNIQUE INDEX imports_operation_id_unique_idx
ON imports(operation_id)
WHERE operation_id IS NOT NULL;

CREATE UNIQUE INDEX imports_finalization_id_unique_idx
ON imports(finalization_id)
WHERE finalization_id IS NOT NULL;

CREATE INDEX imports_pending_lease_idx
ON imports(lease_expires_at, id)
WHERE status = 'pending';

-- A quarantined locator no longer reserves its content hash, allowing the same
-- bytes to be registered again at a fresh physical locator.
DROP TRIGGER assets_reject_live_sha_duplicate;

CREATE TRIGGER assets_reject_live_sha_duplicate
BEFORE INSERT ON assets
WHEN NEW.sha256 IS NOT NULL AND NEW.status IN ('pending', 'ready') AND EXISTS (
  SELECT 1 FROM assets a
  WHERE a.sha256 = NEW.sha256 AND a.status IN ('pending', 'ready')
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
    )
)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live asset sha256 already registered');
END;

CREATE TRIGGER assets_reject_live_sha_duplicate_update
BEFORE UPDATE OF sha256, status, r2_key ON assets
WHEN NEW.sha256 IS NOT NULL AND NEW.status IN ('pending', 'ready') AND EXISTS (
  SELECT 1 FROM assets a
  WHERE a.id <> NEW.id AND a.sha256 = NEW.sha256
    AND a.status IN ('pending', 'ready')
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
    )
)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live asset sha256 already registered');
END;

CREATE TRIGGER imports_require_finalization_identity
BEFORE UPDATE OF status ON imports
WHEN OLD.status = 'pending' AND NEW.status = 'ready'
BEGIN
  SELECT RAISE(ABORT, 'import finalization identity is required')
  WHERE NEW.operation_id IS NULL OR NEW.finalization_id IS NULL
    OR NEW.completed_at IS NULL OR OLD.lease_expires_at IS NULL
    OR OLD.lease_expires_at <= NEW.completed_at;
END;

CREATE TRIGGER imports_activate_pending_assets
AFTER UPDATE OF status ON imports
WHEN OLD.status = 'pending' AND NEW.status = 'ready'
BEGIN
  UPDATE assets
  SET status = 'ready'
  WHERE import_id = NEW.id AND status = 'pending';
END;

DROP INDEX managed_storage_objects_content_idx;

CREATE INDEX managed_storage_objects_content_lookup_idx
ON managed_storage_objects(provider, sha256, byte_size, status);

CREATE TRIGGER managed_storage_objects_reject_live_content_duplicate_insert
BEFORE INSERT ON managed_storage_objects
WHEN NEW.status = 'ready' AND EXISTS (
  SELECT 1 FROM managed_storage_objects mso
  WHERE mso.provider = NEW.provider
    AND mso.sha256 = NEW.sha256
    AND mso.byte_size = NEW.byte_size
    AND mso.status = 'ready'
    AND NOT EXISTS (
      SELECT 1 FROM blob_gc_ledger bg
      WHERE bg.store_kind = 'managed' AND bg.provider = mso.provider
        AND bg.object_key = mso.object_key
        AND bg.state IN ('deleting', 'deleted')
    )
    AND NOT EXISTS (
      SELECT 1 FROM blob_integrity_quarantine biq
      WHERE biq.store_kind = 'managed' AND biq.provider = mso.provider
        AND biq.object_key = mso.object_key
    )
)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live managed storage content already registered');
END;

CREATE TRIGGER managed_storage_objects_reject_live_content_duplicate_update
BEFORE UPDATE OF provider, sha256, byte_size, status, object_key ON managed_storage_objects
WHEN NEW.status = 'ready' AND EXISTS (
  SELECT 1 FROM managed_storage_objects mso
  WHERE mso.id <> NEW.id
    AND mso.provider = NEW.provider
    AND mso.sha256 = NEW.sha256
    AND mso.byte_size = NEW.byte_size
    AND mso.status = 'ready'
    AND NOT EXISTS (
      SELECT 1 FROM blob_gc_ledger bg
      WHERE bg.store_kind = 'managed' AND bg.provider = mso.provider
        AND bg.object_key = mso.object_key
        AND bg.state IN ('deleting', 'deleted')
    )
    AND NOT EXISTS (
      SELECT 1 FROM blob_integrity_quarantine biq
      WHERE biq.store_kind = 'managed' AND biq.provider = mso.provider
        AND biq.object_key = mso.object_key
    )
)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live managed storage content already registered');
END;

-- Existing relationships remain visible for repair and audit. New relationships
-- cannot bind a locator after a definite integrity failure.
CREATE TRIGGER state_representation_assets_guard_integrity_insert
BEFORE INSERT ON state_representation_assets
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER run_step_assets_guard_integrity_insert
BEFORE INSERT ON run_step_assets
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER metrology_template_references_guard_integrity_insert
BEFORE INSERT ON metrology_template_references
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER run_step_comments_guard_integrity_insert
BEFORE INSERT ON run_step_comments
WHEN NEW.asset_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER state_verifications_guard_integrity_insert
BEFORE INSERT ON state_verifications
WHEN NEW.evidence_asset_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.evidence_asset_id
  );
END;

CREATE TRIGGER comment_submission_items_guard_asset_integrity_insert
BEFORE INSERT ON comment_submission_items
WHEN NEW.asset_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER comment_submission_items_guard_asset_integrity_update
BEFORE UPDATE OF asset_id ON comment_submission_items
WHEN NEW.asset_id IS NOT NULL AND (OLD.asset_id IS NULL OR OLD.asset_id <> NEW.asset_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER comment_submission_items_guard_managed_integrity_insert
BEFORE INSERT ON comment_submission_items
WHEN NEW.storage_object_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM managed_storage_objects mso JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'managed' AND biq.provider = mso.provider
        AND biq.object_key = mso.object_key
    WHERE mso.id = NEW.storage_object_id
  );
END;

CREATE TRIGGER comment_submission_items_guard_managed_integrity_update
BEFORE UPDATE OF storage_object_id ON comment_submission_items
WHEN NEW.storage_object_id IS NOT NULL
  AND (OLD.storage_object_id IS NULL OR OLD.storage_object_id <> NEW.storage_object_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM managed_storage_objects mso JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'managed' AND biq.provider = mso.provider
        AND biq.object_key = mso.object_key
    WHERE mso.id = NEW.storage_object_id
  );
END;

CREATE TRIGGER project_content_attachments_guard_integrity_insert
BEFORE INSERT ON project_content_attachments
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined')
  WHERE NEW.asset_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
  SELECT RAISE(ABORT, 'blob locator is quarantined')
  WHERE NEW.storage_object_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM managed_storage_objects mso JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'managed' AND biq.provider = mso.provider
        AND biq.object_key = mso.object_key
    WHERE mso.id = NEW.storage_object_id
  );
  SELECT RAISE(ABORT, 'blob locator is unavailable')
  WHERE NEW.asset_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM assets a
    LEFT JOIN imports i ON i.id = a.import_id
    WHERE a.id = NEW.asset_id
      AND (
        a.status <> 'ready'
        OR (a.import_id IS NOT NULL AND (i.id IS NULL OR i.status <> 'ready'))
      )
  );
END;

CREATE TRIGGER events_guard_asset_key_integrity_insert
BEFORE INSERT ON events
WHEN NEW.asset_key IS NOT NULL AND NEW.asset_key <> ''
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.asset_key
  );
END;

CREATE TRIGGER events_guard_asset_key_integrity_update
BEFORE UPDATE OF asset_key ON events
WHEN NEW.asset_key IS NOT NULL AND NEW.asset_key <> ''
  AND (OLD.asset_key IS NULL OR OLD.asset_key <> NEW.asset_key)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.asset_key
  );
END;

CREATE TRIGGER events_guard_thumbnail_integrity_insert
BEFORE INSERT ON events
WHEN NULLIF(TRIM(CASE WHEN json_valid(NEW.metadata_json)
  THEN json_extract(NEW.metadata_json, '$.thumbnailKey') END), '') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key = json_extract(NEW.metadata_json, '$.thumbnailKey')
  );
END;

CREATE TRIGGER events_guard_thumbnail_integrity_update
BEFORE UPDATE OF metadata_json ON events
WHEN NULLIF(TRIM(CASE WHEN json_valid(NEW.metadata_json)
  THEN json_extract(NEW.metadata_json, '$.thumbnailKey') END), '') IS NOT NULL
  AND CASE WHEN json_valid(OLD.metadata_json)
        THEN json_extract(OLD.metadata_json, '$.thumbnailKey') END
      IS NOT CASE WHEN json_valid(NEW.metadata_json)
        THEN json_extract(NEW.metadata_json, '$.thumbnailKey') END
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key = json_extract(NEW.metadata_json, '$.thumbnailKey')
  );
END;

CREATE TRIGGER imports_guard_asset_keys_integrity_insert
BEFORE INSERT ON imports
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key IN (NEW.workbook_asset_key, NEW.manifest_asset_key)
  );
END;

CREATE TRIGGER imports_guard_asset_keys_integrity_update
BEFORE UPDATE OF workbook_asset_key, manifest_asset_key ON imports
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key IN (NEW.workbook_asset_key, NEW.manifest_asset_key)
  );
END;

CREATE TRIGGER template_versions_guard_source_asset_integrity_insert
BEFORE INSERT ON template_versions
WHEN NEW.source_asset_key IS NOT NULL AND NEW.source_asset_key <> ''
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.source_asset_key
  );
END;

CREATE TRIGGER template_versions_guard_source_asset_integrity_update
BEFORE UPDATE OF source_asset_key ON template_versions
WHEN NEW.source_asset_key IS NOT NULL AND NEW.source_asset_key <> ''
  AND (OLD.source_asset_key IS NULL OR OLD.source_asset_key <> NEW.source_asset_key)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.source_asset_key
  );
END;


CREATE TRIGGER metrology_template_references_guard_integrity_update
BEFORE UPDATE OF asset_id ON metrology_template_references
WHEN OLD.asset_id <> NEW.asset_id
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;


CREATE TRIGGER state_representation_assets_guard_integrity_update
BEFORE UPDATE OF asset_id ON state_representation_assets
WHEN OLD.asset_id <> NEW.asset_id
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER run_step_assets_guard_integrity_update
BEFORE UPDATE OF asset_id ON run_step_assets
WHEN OLD.asset_id <> NEW.asset_id
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER run_step_comments_guard_integrity_update
BEFORE UPDATE OF asset_id ON run_step_comments
WHEN NEW.asset_id IS NOT NULL
  AND (OLD.asset_id IS NULL OR OLD.asset_id <> NEW.asset_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER state_verifications_guard_integrity_update
BEFORE UPDATE OF evidence_asset_id ON state_verifications
WHEN NEW.evidence_asset_id IS NOT NULL
  AND (OLD.evidence_asset_id IS NULL OR OLD.evidence_asset_id <> NEW.evidence_asset_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.evidence_asset_id
  );
END;

CREATE TRIGGER project_content_attachments_guard_asset_integrity_update
BEFORE UPDATE OF asset_id ON project_content_attachments
WHEN NEW.asset_id IS NOT NULL
  AND (OLD.asset_id IS NULL OR OLD.asset_id <> NEW.asset_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

CREATE TRIGGER project_content_attachments_guard_managed_integrity_update
BEFORE UPDATE OF storage_object_id ON project_content_attachments
WHEN NEW.storage_object_id IS NOT NULL
  AND (OLD.storage_object_id IS NULL OR OLD.storage_object_id <> NEW.storage_object_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM managed_storage_objects mso JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'managed' AND biq.provider = mso.provider
        AND biq.object_key = mso.object_key
    WHERE mso.id = NEW.storage_object_id
  );
END;
