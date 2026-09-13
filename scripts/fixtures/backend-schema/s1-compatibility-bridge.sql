-- INACTIVE QUALIFICATION CANDIDATE: never scan this directory as active migrations.
-- Source schema: current 37-file chain at 2a2e69d. Execute only as one transaction.
-- Serving-version retirement, v8 recovery and reviewed migration execution are prerequisites.
CREATE TABLE compatibility_stage_b_assertion (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO compatibility_stage_b_assertion
SELECT CASE WHEN (SELECT COUNT(*) FROM pragma_table_xinfo('run_step_comments')) = 18
  AND NOT EXISTS (SELECT 1 FROM pragma_table_xinfo('run_step_comments') WHERE name = 'legacy_body')
  AND EXISTS (SELECT 1 FROM pragma_table_xinfo('samples') WHERE name = 'process_revision')
THEN 1 ELSE 0 END;

DROP VIEW fabublox_recovery_public_asset_edges;

DROP VIEW fabublox_recovery_public_asset_edges_external;

DROP VIEW blob_retention_edges;

DROP VIEW blob_retention_edges_r2_occurrences;

CREATE TABLE compatibility_run_step_comments_s1 (
  id TEXT PRIMARY KEY,
  run_step_id TEXT NOT NULL REFERENCES run_steps(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('common', 'individual')),
  operation_group_id TEXT,
  body TEXT NOT NULL DEFAULT '',
  asset_id TEXT REFERENCES assets(id),
  actor_email TEXT,
  created_at TEXT NOT NULL
, submission_id TEXT REFERENCES comment_submissions(id), updated_at TEXT, updated_by TEXT, deleted_at TEXT, deleted_by TEXT, asset_deleted_at TEXT, asset_deleted_by TEXT, last_mutation_id TEXT, deletion_operation_id TEXT, asset_deletion_operation_id TEXT, legacy_body TEXT
);

-- qualification checkpoint: before-copy
INSERT INTO compatibility_run_step_comments_s1 ("id", "run_step_id", "scope", "operation_group_id", "body", "asset_id", "actor_email", "created_at", "submission_id", "updated_at", "updated_by", "deleted_at", "deleted_by", "asset_deleted_at", "asset_deleted_by", "last_mutation_id", "deletion_operation_id", "asset_deletion_operation_id", legacy_body)
SELECT "id", "run_step_id", "scope", "operation_group_id", "body", "asset_id", "actor_email", "created_at", "submission_id", "updated_at", "updated_by", "deleted_at", "deleted_by", "asset_deleted_at", "asset_deleted_by", "last_mutation_id", "deletion_operation_id", "asset_deletion_operation_id", CASE WHEN submission_id IS NULL THEN body ELSE NULL END
FROM run_step_comments;
-- qualification checkpoint: after-copy
INSERT INTO compatibility_stage_b_assertion
SELECT CASE WHEN NOT EXISTS (SELECT "id", "run_step_id", "scope", "operation_group_id", "body", "asset_id", "actor_email", "created_at", "submission_id", "updated_at", "updated_by", "deleted_at", "deleted_by", "asset_deleted_at", "asset_deleted_by", "last_mutation_id", "deletion_operation_id", "asset_deletion_operation_id" FROM run_step_comments EXCEPT SELECT "id", "run_step_id", "scope", "operation_group_id", "body", "asset_id", "actor_email", "created_at", "submission_id", "updated_at", "updated_by", "deleted_at", "deleted_by", "asset_deleted_at", "asset_deleted_by", "last_mutation_id", "deletion_operation_id", "asset_deletion_operation_id" FROM compatibility_run_step_comments_s1)
  AND NOT EXISTS (SELECT "id", "run_step_id", "scope", "operation_group_id", "body", "asset_id", "actor_email", "created_at", "submission_id", "updated_at", "updated_by", "deleted_at", "deleted_by", "asset_deleted_at", "asset_deleted_by", "last_mutation_id", "deletion_operation_id", "asset_deletion_operation_id" FROM compatibility_run_step_comments_s1 EXCEPT SELECT "id", "run_step_id", "scope", "operation_group_id", "body", "asset_id", "actor_email", "created_at", "submission_id", "updated_at", "updated_by", "deleted_at", "deleted_by", "asset_deleted_at", "asset_deleted_by", "last_mutation_id", "deletion_operation_id", "asset_deletion_operation_id" FROM run_step_comments)
THEN 1 ELSE 0 END;
DROP TABLE run_step_comments;
ALTER TABLE compatibility_run_step_comments_s1 RENAME TO run_step_comments;
-- qualification checkpoint: after-swap

CREATE INDEX run_step_comments_step_created_idx
ON run_step_comments(run_step_id, created_at, id);

CREATE INDEX run_step_comments_operation_group_idx
ON run_step_comments(operation_group_id) WHERE operation_group_id IS NOT NULL;

CREATE INDEX run_step_comments_asset_idx
ON run_step_comments(asset_id) WHERE asset_id IS NOT NULL;

CREATE INDEX run_step_comments_submission_idx
ON run_step_comments(submission_id) WHERE submission_id IS NOT NULL;

CREATE INDEX run_step_comments_visible_step_created_idx
ON run_step_comments(run_step_id, created_at, id)
WHERE deleted_at IS NULL;

CREATE INDEX run_step_comments_visible_asset_idx
ON run_step_comments(asset_id)
WHERE asset_id IS NOT NULL AND asset_deleted_at IS NULL;

CREATE INDEX run_step_comments_deletion_operation_idx
ON run_step_comments(submission_id, deletion_operation_id)
WHERE deleted_at IS NOT NULL AND deletion_operation_id IS NOT NULL;

CREATE INDEX run_step_comments_asset_deletion_operation_idx
ON run_step_comments(operation_group_id, asset_deletion_operation_id)
WHERE asset_deleted_at IS NOT NULL AND asset_deletion_operation_id IS NOT NULL;

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

CREATE TRIGGER run_step_comments_block_physical_delete
BEFORE DELETE ON run_step_comments BEGIN
  SELECT RAISE(ABORT, 'physical deletion disabled for run_step_comments');
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

CREATE TRIGGER run_step_comments_guard_publication_insert
BEFORE INSERT ON run_step_comments
WHEN NEW.asset_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER run_step_comments_guard_publication_update
BEFORE UPDATE OF asset_id ON run_step_comments
WHEN NEW.asset_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

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
  CASE WHEN rsa.deleted_at IS NULL
    THEN 'run_step_asset'
    ELSE 'deleted_run_step_asset_grace'
  END,
  CASE WHEN rsa.deleted_at IS NULL
    THEN NULL
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', rsa.deleted_at, '+1 day')
  END
FROM run_step_assets rsa
JOIN assets a ON a.id = rsa.asset_id
WHERE rsa.superseded_by_occurrence_id IS NULL
  AND (
    rsa.deleted_at IS NULL
    OR datetime(rsa.deleted_at, '+1 day') > datetime('now')
  )

UNION ALL
SELECT
  'r2', 'r2', a.r2_key, a.id,
  'template_version', mtr.template_version_id,
  'metrology_template_reference', mtr.id,
  'metrology_template_reference', NULL
FROM metrology_template_references mtr
JOIN assets a ON a.id = mtr.asset_id
WHERE mtr.superseded_by_occurrence_id IS NULL

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

CREATE VIEW fabublox_recovery_public_asset_edges_external AS
SELECT
  bre.blob_record_id AS asset_id,
  bre.source_type AS consumer_type,
  bre.source_id AS consumer_id
FROM blob_retention_edges bre
WHERE bre.store_kind = 'r2' AND bre.provider = 'r2'
  AND bre.blob_record_id IS NOT NULL
  AND bre.source_type NOT IN ('state_representation', 'template_version', 'import');

CREATE VIEW fabublox_recovery_public_asset_edges AS
SELECT * FROM fabublox_recovery_public_asset_edges_external
UNION ALL
SELECT * FROM fabublox_recovery_public_asset_edges_state
UNION ALL
SELECT * FROM fabublox_recovery_public_asset_edges_template;

-- qualification checkpoint: after-recreate
-- A/E legacy INSERTs supply body only. B supplies both; C supplies legacy_body.
-- Canonical and explicitly supplied legacy text are never copied or overwritten.
CREATE TRIGGER run_step_comments_bridge_legacy_insert
AFTER INSERT ON run_step_comments
WHEN NEW.submission_id IS NULL AND NEW.legacy_body IS NULL
BEGIN
  UPDATE run_step_comments SET legacy_body = NEW.body WHERE id = NEW.id;
END;
DROP TABLE compatibility_stage_b_assertion;
