PRAGMA foreign_keys = ON;

-- Retryability is application state, not an age inference private to cleanup.
ALTER TABLE comment_submissions ADD COLUMN retry_until TEXT;
ALTER TABLE comment_submissions ADD COLUMN retry_closed_at TEXT;
ALTER TABLE comment_submissions ADD COLUMN retry_closed_by TEXT;

UPDATE comment_submissions
SET retry_until = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+7 days')
WHERE status IN ('draft', 'uploading', 'failed');

UPDATE comment_submissions
SET retry_closed_at = COALESCE(completed_at, cancelled_at, updated_at),
    retry_closed_by = 'migration:0016'
WHERE status IN ('ready', 'cancelled');

CREATE INDEX comment_submissions_retry_idx
ON comment_submissions(retry_closed_at, retry_until, status);

-- Upload readiness remains on assets/managed_storage_objects. This ledger is
-- the cross-provider authority for garbage-collection work.
CREATE TABLE blob_gc_ledger (
  store_kind TEXT NOT NULL CHECK (store_kind IN ('r2', 'managed')),
  provider TEXT NOT NULL,
  object_key TEXT NOT NULL,
  blob_record_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('orphaned', 'deleting', 'deleted')),
  operation_id TEXT,
  orphaned_at TEXT,
  deletion_started_at TEXT,
  deleted_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store_kind, provider, object_key)
);

CREATE INDEX blob_gc_ledger_state_idx
ON blob_gc_ledger(state, orphaned_at, updated_at);

CREATE INDEX blob_gc_ledger_record_idx
ON blob_gc_ledger(store_kind, blob_record_id);

-- Preserve GC state produced before the shared ledger existed.
INSERT INTO blob_gc_ledger (
  store_kind, provider, object_key, blob_record_id, state, operation_id,
  orphaned_at, deleted_at, updated_at
)
SELECT
  'managed', provider, object_key, id, status, 'migration:0016',
  CASE WHEN status = 'orphaned' THEN COALESCE(orphaned_at, created_at) END,
  CASE WHEN status = 'deleted' THEN COALESCE(orphaned_at, created_at) END,
  COALESCE(orphaned_at, created_at)
FROM managed_storage_objects
WHERE status IN ('orphaned', 'deleted');

-- Cloudflare workerd sets SQLITE_LIMIT_COMPOUND_SELECT to 5. Keep each leaf
-- view at five SELECT terms or fewer, then expose one stable public view over
-- those leaves. Callers continue to use blob_retention_edges as the single
-- authoritative reachability surface.
CREATE VIEW blob_retention_edges_r2_occurrences AS
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
JOIN assets a ON a.id = sv.evidence_asset_id;

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
  'ready_comment_item' AS retention_reason,
  NULL AS retain_until
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
  AND (
    cs.status IN ('draft', 'uploading')
    OR (cs.status = 'failed' AND cs.retry_closed_at IS NULL)
  )

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
  AND (
    cs.status IN ('draft', 'uploading')
    OR (cs.status = 'failed' AND cs.retry_closed_at IS NULL)
  );

CREATE VIEW blob_retention_edges_direct_keys AS
SELECT
  'r2' AS store_kind,
  'r2' AS provider,
  e.asset_key AS object_key,
  a.id AS blob_record_id,
  'sample' AS source_type,
  e.sample_id AS source_id,
  'event' AS occurrence_type,
  e.id AS occurrence_id,
  'legacy_event_asset' AS retention_reason,
  NULL AS retain_until
FROM events e
LEFT JOIN assets a ON a.r2_key = e.asset_key
WHERE e.asset_key IS NOT NULL AND e.asset_key <> ''

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

CREATE VIEW blob_retention_edges AS
SELECT * FROM blob_retention_edges_r2_occurrences
UNION ALL
SELECT * FROM blob_retention_edges_comment_items
UNION ALL
SELECT * FROM blob_retention_edges_direct_keys;

-- A pre-migration Cancel could have marked a managed object orphaned while an
-- unfinished/retryable submission still referenced it. The new shared surface
-- is authoritative and repairs that compatibility state before cleanup runs.
UPDATE managed_storage_objects
SET status = 'ready', orphaned_at = NULL
WHERE status = 'orphaned'
  AND EXISTS (
    SELECT 1 FROM blob_retention_edges bre
    WHERE bre.store_kind = 'managed'
      AND bre.provider = managed_storage_objects.provider
      AND bre.object_key = managed_storage_objects.object_key
  );

DELETE FROM blob_gc_ledger
WHERE state = 'orphaned'
  AND EXISTS (
    SELECT 1 FROM blob_retention_edges bre
    WHERE bre.store_kind = blob_gc_ledger.store_kind
      AND bre.provider = blob_gc_ledger.provider
      AND bre.object_key = blob_gc_ledger.object_key
  );

-- Index every reverse lookup used by the retention view.
CREATE INDEX state_representation_assets_asset_idx
ON state_representation_assets(asset_id);

CREATE INDEX run_step_assets_asset_idx
ON run_step_assets(asset_id);

CREATE INDEX metrology_template_references_asset_idx
ON metrology_template_references(asset_id);

CREATE INDEX state_verifications_evidence_asset_idx
ON state_verifications(evidence_asset_id)
WHERE evidence_asset_id IS NOT NULL;

CREATE INDEX events_asset_key_idx
ON events(asset_key)
WHERE asset_key IS NOT NULL;

CREATE INDEX imports_workbook_asset_key_idx
ON imports(workbook_asset_key)
WHERE workbook_asset_key IS NOT NULL;

CREATE INDEX imports_manifest_asset_key_idx
ON imports(manifest_asset_key)
WHERE manifest_asset_key IS NOT NULL;

CREATE INDEX template_versions_source_asset_key_idx
ON template_versions(source_asset_key)
WHERE source_asset_key IS NOT NULL;

-- A collected R2 record keeps its original hash metadata. Replace the global
-- unique index with a live-locator constraint so identical bytes can be
-- registered again after an earlier locator enters deleting/deleted state.
DROP INDEX assets_sha256_unique_idx;

CREATE INDEX assets_sha256_lookup_idx
ON assets(sha256, status)
WHERE sha256 IS NOT NULL;

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
  SELECT RAISE(ABORT, 'live asset sha256 already registered');
END;

-- Relationship writes are the authoritative edge-creation boundary. They
-- cannot bind a claimed/deleted locator and atomically release orphan state.
CREATE TRIGGER state_representation_assets_guard_blob_insert
BEFORE INSERT ON state_representation_assets
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
END;

CREATE TRIGGER run_step_assets_guard_blob_insert
BEFORE INSERT ON run_step_assets
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
END;

CREATE TRIGGER metrology_template_references_guard_blob_insert
BEFORE INSERT ON metrology_template_references
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
END;

CREATE TRIGGER run_step_comments_guard_blob_insert
BEFORE INSERT ON run_step_comments
WHEN NEW.asset_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
END;

CREATE TRIGGER state_verifications_guard_blob_insert
BEFORE INSERT ON state_verifications
WHEN NEW.evidence_asset_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.evidence_asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.evidence_asset_id);
END;

CREATE TRIGGER comment_submission_items_guard_asset_insert
BEFORE INSERT ON comment_submission_items
WHEN NEW.asset_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
END;

CREATE TRIGGER comment_submission_items_guard_asset_update
BEFORE UPDATE OF asset_id ON comment_submission_items
WHEN NEW.asset_id IS NOT NULL AND (OLD.asset_id IS NULL OR OLD.asset_id <> NEW.asset_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
END;

CREATE TRIGGER comment_submission_items_guard_managed_insert
BEFORE INSERT ON comment_submission_items
WHEN NEW.storage_object_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM managed_storage_objects mso JOIN blob_gc_ledger bg
      ON bg.store_kind = 'managed' AND bg.provider = mso.provider
        AND bg.object_key = mso.object_key
    WHERE mso.id = NEW.storage_object_id AND bg.state IN ('deleting', 'deleted')
  );
  UPDATE managed_storage_objects
  SET status = 'ready', orphaned_at = NULL
  WHERE id = NEW.storage_object_id AND status = 'orphaned';
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'managed' AND state = 'orphaned'
    AND (provider, object_key) = (
      SELECT provider, object_key FROM managed_storage_objects
      WHERE id = NEW.storage_object_id
    );
END;

CREATE TRIGGER comment_submission_items_guard_managed_update
BEFORE UPDATE OF storage_object_id ON comment_submission_items
WHEN NEW.storage_object_id IS NOT NULL
  AND (OLD.storage_object_id IS NULL OR OLD.storage_object_id <> NEW.storage_object_id)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM managed_storage_objects mso JOIN blob_gc_ledger bg
      ON bg.store_kind = 'managed' AND bg.provider = mso.provider
        AND bg.object_key = mso.object_key
    WHERE mso.id = NEW.storage_object_id AND bg.state IN ('deleting', 'deleted')
  );
  UPDATE managed_storage_objects
  SET status = 'ready', orphaned_at = NULL
  WHERE id = NEW.storage_object_id AND status = 'orphaned';
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'managed' AND state = 'orphaned'
    AND (provider, object_key) = (
      SELECT provider, object_key FROM managed_storage_objects
      WHERE id = NEW.storage_object_id
    );
END;

-- Compatibility direct-key relationships also release or reject an R2 claim.
CREATE TRIGGER events_guard_asset_key_insert
BEFORE INSERT ON events
WHEN NEW.asset_key IS NOT NULL AND NEW.asset_key <> ''
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.asset_key
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.asset_key
    AND state = 'orphaned';
END;

CREATE TRIGGER events_guard_asset_key_update
BEFORE UPDATE OF asset_key ON events
WHEN NEW.asset_key IS NOT NULL AND NEW.asset_key <> ''
  AND (OLD.asset_key IS NULL OR OLD.asset_key <> NEW.asset_key)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.asset_key
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.asset_key
    AND state = 'orphaned';
END;

CREATE TRIGGER imports_guard_asset_keys_update
BEFORE UPDATE OF workbook_asset_key, manifest_asset_key ON imports
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key IN (NEW.workbook_asset_key, NEW.manifest_asset_key)
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key IN (NEW.workbook_asset_key, NEW.manifest_asset_key);
END;

CREATE TRIGGER imports_guard_asset_keys_insert
BEFORE INSERT ON imports
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key IN (NEW.workbook_asset_key, NEW.manifest_asset_key)
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key IN (NEW.workbook_asset_key, NEW.manifest_asset_key);
END;

CREATE TRIGGER template_versions_guard_source_asset_insert
BEFORE INSERT ON template_versions
WHEN NEW.source_asset_key IS NOT NULL AND NEW.source_asset_key <> ''
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key = NEW.source_asset_key
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2'
    AND object_key = NEW.source_asset_key AND state = 'orphaned';
END;

CREATE TRIGGER template_versions_guard_source_asset_update
BEFORE UPDATE OF source_asset_key ON template_versions
WHEN NEW.source_asset_key IS NOT NULL AND NEW.source_asset_key <> ''
  AND (OLD.source_asset_key IS NULL OR OLD.source_asset_key <> NEW.source_asset_key)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key = NEW.source_asset_key
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2'
    AND object_key = NEW.source_asset_key AND state = 'orphaned';
END;

-- Accidental physical deletion of stable source and occurrence identities is
-- disabled until a privileged, blocker-aware, tombstone-producing planner is
-- implemented in a later phase.
CREATE TRIGGER samples_block_physical_delete
BEFORE DELETE ON samples BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for samples');
END;

CREATE TRIGGER runs_block_physical_delete
BEFORE DELETE ON runs BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for runs');
END;

CREATE TRIGGER run_steps_block_physical_delete
BEFORE DELETE ON run_steps BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for run_steps');
END;

CREATE TRIGGER comment_submissions_block_physical_delete
BEFORE DELETE ON comment_submissions BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for comment_submissions');
END;

CREATE TRIGGER run_step_comments_block_physical_delete
BEFORE DELETE ON run_step_comments BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for run_step_comments');
END;

CREATE TRIGGER comment_submission_items_block_physical_delete
BEFORE DELETE ON comment_submission_items BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for comment_submission_items');
END;

CREATE TRIGGER run_step_assets_block_physical_delete
BEFORE DELETE ON run_step_assets BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for run_step_assets');
END;

CREATE TRIGGER metrology_template_references_block_physical_delete
BEFORE DELETE ON metrology_template_references BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for metrology_template_references');
END;

CREATE TRIGGER template_versions_block_physical_delete
BEFORE DELETE ON template_versions BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for template_versions');
END;
