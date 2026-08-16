PRAGMA foreign_keys = ON;

-- Registration now stages metadata before provider writes. Promotion from the
-- non-public staging state must obey the same live-SHA boundary that INSERT
-- already enforces, including the private reservation held by a pending import.

DROP TRIGGER assets_reject_live_sha_duplicate;
DROP TRIGGER assets_reject_live_sha_duplicate_update;

-- Standalone registrations may have multiple non-public candidates while
-- concurrent requests are in flight. Only one candidate may become ready.
-- Import-owned candidates retain their stronger private hash reservation.
CREATE TRIGGER assets_reject_live_sha_duplicate
BEFORE INSERT ON assets
WHEN NEW.sha256 IS NOT NULL AND (
  (
    NEW.import_id IS NULL AND NEW.status = 'ready'
    AND EXISTS (
      SELECT 1 FROM assets a
      WHERE a.sha256 = NEW.sha256 AND a.status = 'ready'
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
  ) OR (
    NEW.import_id IS NOT NULL AND NEW.status IN ('pending', 'ready')
    AND EXISTS (
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
  )
)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live asset sha256 already registered');
END;

CREATE TRIGGER assets_reject_live_sha_duplicate_update
BEFORE UPDATE OF sha256, status, r2_key, import_id ON assets
WHEN NEW.sha256 IS NOT NULL AND (
  (
    NEW.import_id IS NULL AND NEW.status = 'ready'
    AND EXISTS (
      SELECT 1 FROM assets a
      WHERE a.id <> OLD.id AND a.sha256 = NEW.sha256
        AND a.status = 'ready'
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
  ) OR (
    NEW.import_id IS NOT NULL AND NEW.status IN ('pending', 'ready')
    AND EXISTS (
      SELECT 1 FROM assets a
      WHERE a.id <> OLD.id AND a.sha256 = NEW.sha256
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
  )
)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live asset sha256 already registered');
END;

CREATE TRIGGER assets_reject_pending_import_sha_publication_insert
BEFORE INSERT ON assets
WHEN NEW.import_id IS NULL
  AND NEW.status IN ('pending', 'ready')
  AND NEW.sha256 IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM assets staged
    JOIN imports owner ON owner.id = staged.import_id
    WHERE staged.sha256 = NEW.sha256
      AND staged.status IN ('pending', 'ready')
      AND owner.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = staged.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = staged.r2_key
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'matching asset is owned by a pending import');
END;

CREATE TRIGGER assets_reject_pending_import_sha_publication_update
BEFORE UPDATE OF status, sha256, import_id ON assets
WHEN NEW.import_id IS NULL
  AND NEW.status IN ('pending', 'ready')
  AND NEW.sha256 IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM assets staged
    JOIN imports owner ON owner.id = staged.import_id
    WHERE staged.id <> OLD.id
      AND staged.sha256 = NEW.sha256
      AND staged.status IN ('pending', 'ready')
      AND owner.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = staged.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = staged.r2_key
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'matching asset is owned by a pending import');
END;

-- Recovery may discover that a legacy failed locator contains bytes already
-- represented by a healthy canonical asset. Stable occurrence identities must
-- then be rebound without reopening ordinary mutation of unpublished templates
-- or immutable Project attachment metadata. These exceptions are deliberately
-- limited to an exact same-SHA, same-size winner after a durable recovery claim.

DROP TRIGGER template_versions_guard_unpublished_update;

CREATE TRIGGER template_versions_guard_unpublished_update
BEFORE UPDATE ON template_versions
WHEN EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = OLD.id AND i.status = 'pending'
)
AND NOT (
  OLD.id IS NEW.id
  AND OLD.recipe_family_id IS NEW.recipe_family_id
  AND OLD.name IS NEW.name
  AND OLD.template_type IS NEW.template_type
  AND OLD.version IS NEW.version
  AND OLD.manifest_hash IS NEW.manifest_hash
  AND OLD.initial_state_hash IS NEW.initial_state_hash
  AND OLD.source_filename IS NEW.source_filename
  AND OLD.source_asset_key IS NOT NEW.source_asset_key
  AND OLD.content_json IS NEW.content_json
  AND OLD.created_by IS NEW.created_by
  AND OLD.created_at IS NEW.created_at
  AND OLD.locked_at IS NEW.locked_at
  AND OLD.locked_by IS NEW.locked_by
  AND OLD.archived_at IS NEW.archived_at
  AND OLD.archived_by IS NEW.archived_by
  AND OLD.template_kind IS NEW.template_kind
  AND OLD.metrology_notes IS NEW.metrology_notes
  AND OLD.deleted_at IS NEW.deleted_at
  AND OLD.deleted_by IS NEW.deleted_by
  AND EXISTS (
    SELECT 1
    FROM assets legacy
    JOIN imports failed_owner ON failed_owner.id = legacy.import_id
    JOIN assets canonical ON canonical.r2_key = NEW.source_asset_key
    LEFT JOIN imports canonical_owner ON canonical_owner.id = canonical.import_id
    WHERE legacy.r2_key = OLD.source_asset_key
      AND failed_owner.status = 'failed'
      AND failed_owner.recovery_operation_id IS NOT NULL
      AND legacy.sha256 IS NOT NULL
      AND canonical.sha256 = legacy.sha256
      AND canonical.byte_size = legacy.byte_size
      AND canonical.status = 'ready'
      AND (
        canonical.import_id IS NULL
        OR canonical_owner.status = 'ready'
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = canonical.r2_key
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = canonical.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

DROP TRIGGER metrology_template_references_guard_publication_update;

CREATE TRIGGER metrology_template_references_guard_publication_update
BEFORE UPDATE OF template_version_id, asset_id ON metrology_template_references
BEGIN
  SELECT RAISE(ABORT, 'template version is not published')
  WHERE EXISTS (
    SELECT 1 FROM imports i
    WHERE i.template_version_id = NEW.template_version_id AND i.status <> 'ready'
  )
  AND NOT (
    OLD.id IS NEW.id
    AND OLD.template_version_id IS NEW.template_version_id
    AND OLD.asset_id IS NOT NEW.asset_id
    AND OLD.display_name IS NEW.display_name
    AND OLD.position IS NEW.position
    AND OLD.actor_email IS NEW.actor_email
    AND OLD.created_at IS NEW.created_at
    AND OLD.deleted_at IS NEW.deleted_at
    AND OLD.deleted_by IS NEW.deleted_by
    AND EXISTS (
      SELECT 1
      FROM assets legacy
      JOIN imports failed_owner ON failed_owner.id = legacy.import_id
      JOIN assets canonical ON canonical.id = NEW.asset_id
      LEFT JOIN imports canonical_owner ON canonical_owner.id = canonical.import_id
      WHERE legacy.id = OLD.asset_id
        AND failed_owner.status = 'failed'
        AND failed_owner.recovery_operation_id IS NOT NULL
        AND legacy.sha256 IS NOT NULL
        AND canonical.sha256 = legacy.sha256
        AND canonical.byte_size = legacy.byte_size
        AND canonical.status = 'ready'
        AND (
          canonical.import_id IS NULL
          OR canonical_owner.status = 'ready'
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = canonical.r2_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = canonical.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
    )
  );

  SELECT RAISE(ABORT, 'asset owning import is not ready') WHERE NOT EXISTS (
    SELECT 1
    FROM assets a
    LEFT JOIN imports i ON i.id = a.import_id
    WHERE a.id = NEW.asset_id AND a.status = 'ready'
      AND (a.import_id IS NULL OR i.status = 'ready')
  );
END;

DROP TRIGGER project_content_attachments_reject_update;

CREATE TRIGGER project_content_attachments_reject_update
BEFORE UPDATE ON project_content_attachments
WHEN NOT (
  OLD.project_content_id IS NEW.project_content_id
  AND OLD.asset_id IS NOT NEW.asset_id
  AND OLD.asset_id IS NOT NULL
  AND NEW.asset_id IS NOT NULL
  AND OLD.storage_object_id IS NULL
  AND NEW.storage_object_id IS NULL
  AND OLD.original_name IS NEW.original_name
  AND OLD.mime_type IS NEW.mime_type
  AND OLD.byte_size IS NEW.byte_size
  AND OLD.created_by IS NEW.created_by
  AND OLD.created_at IS NEW.created_at
  AND OLD.creation_operation_id IS NEW.creation_operation_id
  AND EXISTS (
    SELECT 1
    FROM assets legacy
    JOIN imports failed_owner ON failed_owner.id = legacy.import_id
    JOIN assets canonical ON canonical.id = NEW.asset_id
    LEFT JOIN imports canonical_owner ON canonical_owner.id = canonical.import_id
    WHERE legacy.id = OLD.asset_id
      AND failed_owner.status = 'failed'
      AND failed_owner.recovery_operation_id IS NOT NULL
      AND legacy.sha256 IS NOT NULL
      AND canonical.sha256 = legacy.sha256
      AND canonical.byte_size = legacy.byte_size
      AND canonical.status = 'ready'
      AND (
        canonical.import_id IS NULL
        OR canonical_owner.status = 'ready'
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = canonical.r2_key
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = canonical.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined')
  WHERE (
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

  SELECT RAISE(ABORT, 'blob locator is unavailable')
  WHERE NEW.asset_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM assets a
      LEFT JOIN imports i ON i.id = a.import_id
      WHERE a.id = NEW.asset_id
        AND a.status = 'ready'
        AND (a.import_id IS NULL OR i.status = 'ready')
    );

  SELECT RAISE(ABORT, 'blob locator is unavailable')
  WHERE (
    NEW.asset_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM assets a
      JOIN blob_gc_ledger bg
        ON bg.store_kind = 'r2' AND bg.provider = 'r2'
       AND bg.object_key = a.r2_key
       AND bg.state IN ('deleting', 'deleted')
      WHERE a.id = NEW.asset_id
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
       AND bg.state IN ('deleting', 'deleted')
      WHERE mso.id = NEW.storage_object_id
    )
  );

  SELECT RAISE(ABORT, 'project attachment intrinsic metadata is immutable');
END;
-- Stable occurrence identities are never physically merged. If recovery finds
-- an existing occurrence for the healthy canonical asset, the legacy
-- occurrence remains as an immutable, soft-deleted supersession tombstone.
-- Ordinary soft deletion still retains bytes; only this exact, audited
-- same-content supersession transfers byte retention to the surviving
-- occurrence.
ALTER TABLE run_step_assets
ADD COLUMN superseded_by_occurrence_id TEXT REFERENCES run_step_assets(id);

ALTER TABLE run_step_assets
ADD COLUMN superseded_at TEXT;

ALTER TABLE run_step_assets
ADD COLUMN superseded_by TEXT;

ALTER TABLE run_step_assets
ADD COLUMN supersession_operation_id TEXT;

ALTER TABLE metrology_template_references
ADD COLUMN superseded_by_occurrence_id TEXT
REFERENCES metrology_template_references(id);

ALTER TABLE metrology_template_references
ADD COLUMN superseded_at TEXT;

ALTER TABLE metrology_template_references
ADD COLUMN superseded_by TEXT;

ALTER TABLE metrology_template_references
ADD COLUMN supersession_operation_id TEXT;

CREATE INDEX run_step_assets_supersession_idx
ON run_step_assets(superseded_by_occurrence_id)
WHERE superseded_by_occurrence_id IS NOT NULL;

CREATE INDEX metrology_template_references_supersession_idx
ON metrology_template_references(superseded_by_occurrence_id)
WHERE superseded_by_occurrence_id IS NOT NULL;

CREATE TRIGGER run_step_assets_reject_superseded_insert
BEFORE INSERT ON run_step_assets
WHEN NEW.superseded_by_occurrence_id IS NOT NULL
  OR NEW.superseded_at IS NOT NULL
  OR NEW.superseded_by IS NOT NULL
  OR NEW.supersession_operation_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'run step asset supersession is recovery-only');
END;

CREATE TRIGGER run_step_assets_guard_supersession_create
BEFORE UPDATE OF
  superseded_by_occurrence_id,
  superseded_at,
  superseded_by,
  supersession_operation_id
ON run_step_assets
WHEN OLD.superseded_by_occurrence_id IS NULL
  AND (
    NEW.superseded_by_occurrence_id IS NOT NULL
    OR NEW.superseded_at IS NOT NULL
    OR NEW.superseded_by IS NOT NULL
    OR NEW.supersession_operation_id IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid run step asset supersession')
  WHERE NEW.superseded_by_occurrence_id IS NULL
    OR NEW.superseded_at IS NULL
    OR length(NEW.superseded_at) = 0
    OR NEW.superseded_by IS NOT 'system:fabublox-import-recovery'
    OR NEW.supersession_operation_id IS NULL
    OR length(NEW.supersession_operation_id) = 0
    OR NEW.deleted_at IS NULL
    OR NEW.deleted_by IS NULL
    OR NEW.id IS NOT OLD.id
    OR NEW.run_step_id IS NOT OLD.run_step_id
    OR NEW.asset_id IS NOT OLD.asset_id
    OR NEW.role IS NOT OLD.role
    OR NEW.position IS NOT OLD.position
    OR NEW.actor_email IS NOT OLD.actor_email
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.last_mutation_id IS NOT NEW.supersession_operation_id
    OR NOT EXISTS (
      SELECT 1
      FROM assets legacy
      JOIN imports failed_owner ON failed_owner.id = legacy.import_id
      JOIN run_step_assets successor
        ON successor.id = NEW.superseded_by_occurrence_id
      JOIN assets canonical ON canonical.id = successor.asset_id
      LEFT JOIN imports canonical_owner ON canonical_owner.id = canonical.import_id
      WHERE legacy.id = OLD.asset_id
        AND failed_owner.status = 'failed'
        AND failed_owner.recovery_operation_id =
            NEW.supersession_operation_id
        AND legacy.sha256 IS NOT NULL
        AND successor.id <> OLD.id
        AND successor.run_step_id = OLD.run_step_id
        AND successor.role IS OLD.role
        AND successor.superseded_by_occurrence_id IS NULL
        AND canonical.sha256 = legacy.sha256
        AND canonical.byte_size = legacy.byte_size
        AND canonical.status = 'ready'
        AND (
          canonical.import_id IS NULL
          OR canonical_owner.status = 'ready'
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = canonical.r2_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = canonical.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
    );
END;

CREATE TRIGGER run_step_assets_lock_superseded_occurrence
BEFORE UPDATE ON run_step_assets
WHEN OLD.superseded_by_occurrence_id IS NOT NULL
  AND (
    NEW.id IS NOT OLD.id
    OR NEW.run_step_id IS NOT OLD.run_step_id
    OR NEW.asset_id IS NOT OLD.asset_id
    OR NEW.role IS NOT OLD.role
    OR NEW.position IS NOT OLD.position
    OR NEW.actor_email IS NOT OLD.actor_email
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.deleted_at IS NOT OLD.deleted_at
    OR NEW.deleted_by IS NOT OLD.deleted_by
    OR NEW.last_mutation_id IS NOT OLD.last_mutation_id
    OR NEW.superseded_by_occurrence_id
       IS NOT OLD.superseded_by_occurrence_id
    OR NEW.superseded_at IS NOT OLD.superseded_at
    OR NEW.superseded_by IS NOT OLD.superseded_by
    OR NEW.supersession_operation_id
       IS NOT OLD.supersession_operation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'superseded run step asset occurrence is immutable');
END;

CREATE TRIGGER run_step_assets_restore_successor_after_supersession
AFTER UPDATE OF superseded_by_occurrence_id ON run_step_assets
WHEN OLD.superseded_by_occurrence_id IS NULL
  AND NEW.superseded_by_occurrence_id IS NOT NULL
  AND OLD.deleted_at IS NULL
BEGIN
  UPDATE run_step_assets
  SET deleted_at = NULL,
      deleted_by = NULL,
      last_mutation_id = NEW.supersession_operation_id
  WHERE id = NEW.superseded_by_occurrence_id
    AND superseded_by_occurrence_id IS NULL;
END;

CREATE TRIGGER metrology_template_references_reject_superseded_insert
BEFORE INSERT ON metrology_template_references
WHEN NEW.superseded_by_occurrence_id IS NOT NULL
  OR NEW.superseded_at IS NOT NULL
  OR NEW.superseded_by IS NOT NULL
  OR NEW.supersession_operation_id IS NOT NULL
BEGIN
  SELECT RAISE(
    ABORT,
    'metrology reference supersession is recovery-only'
  );
END;

CREATE TRIGGER metrology_template_references_guard_supersession_create
BEFORE UPDATE OF
  superseded_by_occurrence_id,
  superseded_at,
  superseded_by,
  supersession_operation_id
ON metrology_template_references
WHEN OLD.superseded_by_occurrence_id IS NULL
  AND (
    NEW.superseded_by_occurrence_id IS NOT NULL
    OR NEW.superseded_at IS NOT NULL
    OR NEW.superseded_by IS NOT NULL
    OR NEW.supersession_operation_id IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid metrology reference supersession')
  WHERE NEW.superseded_by_occurrence_id IS NULL
    OR NEW.superseded_at IS NULL
    OR length(NEW.superseded_at) = 0
    OR NEW.superseded_by IS NOT 'system:fabublox-import-recovery'
    OR NEW.supersession_operation_id IS NULL
    OR length(NEW.supersession_operation_id) = 0
    OR NEW.deleted_at IS NULL
    OR NEW.deleted_by IS NULL
    OR NEW.id IS NOT OLD.id
    OR NEW.template_version_id IS NOT OLD.template_version_id
    OR NEW.asset_id IS NOT OLD.asset_id
    OR NEW.display_name IS NOT OLD.display_name
    OR NEW.position IS NOT OLD.position
    OR NEW.actor_email IS NOT OLD.actor_email
    OR NEW.created_at IS NOT OLD.created_at
    OR NOT EXISTS (
      SELECT 1
      FROM assets legacy
      JOIN imports failed_owner ON failed_owner.id = legacy.import_id
      JOIN metrology_template_references successor
        ON successor.id = NEW.superseded_by_occurrence_id
      JOIN assets canonical ON canonical.id = successor.asset_id
      LEFT JOIN imports canonical_owner ON canonical_owner.id = canonical.import_id
      WHERE legacy.id = OLD.asset_id
        AND failed_owner.status = 'failed'
        AND failed_owner.recovery_operation_id =
            NEW.supersession_operation_id
        AND legacy.sha256 IS NOT NULL
        AND successor.id <> OLD.id
        AND successor.template_version_id = OLD.template_version_id
        AND successor.superseded_by_occurrence_id IS NULL
        AND canonical.sha256 = legacy.sha256
        AND canonical.byte_size = legacy.byte_size
        AND canonical.status = 'ready'
        AND (
          canonical.import_id IS NULL
          OR canonical_owner.status = 'ready'
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = canonical.r2_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = canonical.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
    );
END;

CREATE TRIGGER metrology_template_references_lock_superseded_occurrence
BEFORE UPDATE ON metrology_template_references
WHEN OLD.superseded_by_occurrence_id IS NOT NULL
  AND (
    NEW.id IS NOT OLD.id
    OR NEW.template_version_id IS NOT OLD.template_version_id
    OR NEW.asset_id IS NOT OLD.asset_id
    OR NEW.display_name IS NOT OLD.display_name
    OR NEW.position IS NOT OLD.position
    OR NEW.actor_email IS NOT OLD.actor_email
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.deleted_at IS NOT OLD.deleted_at
    OR NEW.deleted_by IS NOT OLD.deleted_by
    OR NEW.superseded_by_occurrence_id
       IS NOT OLD.superseded_by_occurrence_id
    OR NEW.superseded_at IS NOT OLD.superseded_at
    OR NEW.superseded_by IS NOT OLD.superseded_by
    OR NEW.supersession_operation_id
       IS NOT OLD.supersession_operation_id
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'superseded metrology reference occurrence is immutable'
  );
END;

CREATE TRIGGER metrology_template_references_restore_successor_after_supersession
AFTER UPDATE OF superseded_by_occurrence_id ON metrology_template_references
WHEN OLD.superseded_by_occurrence_id IS NULL
  AND NEW.superseded_by_occurrence_id IS NOT NULL
  AND OLD.deleted_at IS NULL
BEGIN
  UPDATE metrology_template_references
  SET deleted_at = NULL,
      deleted_by = NULL
  WHERE id = NEW.superseded_by_occurrence_id
    AND superseded_by_occurrence_id IS NULL;
END;

-- Supersession is not ordinary soft deletion: the immutable legacy row stays in
-- export and reference history, while the byte-retention edge moves to the
-- independently existing, same-content successor occurrence.
DROP VIEW fabublox_recovery_public_asset_edges;
DROP VIEW fabublox_recovery_public_asset_edges_external;
DROP VIEW fabublox_recovery_public_asset_edges_template;
DROP VIEW fabublox_recovery_import_asset_edges;
DROP VIEW fabublox_import_asset_dependencies;
DROP VIEW fabublox_import_asset_dependencies_template;
DROP VIEW blob_retention_edges;
DROP VIEW blob_retention_edges_r2_occurrences;

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
WHERE rsa.superseded_by_occurrence_id IS NULL

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
SELECT * FROM blob_retention_edges_project_attachments;

CREATE VIEW fabublox_recovery_public_asset_edges_external AS
SELECT
  bre.blob_record_id AS asset_id,
  bre.source_type AS consumer_type,
  bre.source_id AS consumer_id
FROM blob_retention_edges bre
WHERE bre.store_kind = 'r2' AND bre.provider = 'r2'
  AND bre.blob_record_id IS NOT NULL
  AND bre.source_type NOT IN ('state_representation', 'template_version', 'import');

CREATE VIEW fabublox_import_asset_dependencies_template AS
SELECT
  i.id AS import_id,
  sra.asset_id,
  'template_initial_state' AS dependency_type,
  tv.id AS dependency_id
FROM imports i
JOIN template_versions tv ON tv.id = i.template_version_id
JOIN state_representation_assets sra
  ON sra.state_hash = tv.initial_state_hash
WHERE i.template_version_id IS NOT NULL
  AND tv.initial_state_hash IS NOT NULL

UNION ALL
SELECT
  i.id,
  sra.asset_id,
  'template_step_expected_state',
  ts.id
FROM imports i
JOIN template_steps ts ON ts.template_version_id = i.template_version_id
JOIN state_representation_assets sra
  ON sra.state_hash = ts.expected_state_hash
WHERE i.template_version_id IS NOT NULL
  AND ts.expected_state_hash IS NOT NULL

UNION ALL
SELECT
  i.id,
  mtr.asset_id,
  'metrology_template_reference',
  mtr.id
FROM imports i
JOIN metrology_template_references mtr
  ON mtr.template_version_id = i.template_version_id
WHERE i.template_version_id IS NOT NULL
  AND mtr.superseded_by_occurrence_id IS NULL

UNION ALL
SELECT
  i.id,
  a.id,
  'template_source',
  tv.id
FROM imports i
JOIN template_versions tv ON tv.id = i.template_version_id
LEFT JOIN assets a ON a.r2_key = tv.source_asset_key
WHERE i.template_version_id IS NOT NULL
  AND NULLIF(TRIM(tv.source_asset_key), '') IS NOT NULL;

CREATE VIEW fabublox_import_asset_dependencies AS
SELECT * FROM fabublox_import_asset_dependencies_template
UNION ALL
SELECT * FROM fabublox_import_asset_dependencies_provenance;

CREATE VIEW fabublox_recovery_import_asset_edges AS
SELECT DISTINCT
  dependency.asset_id,
  i.id AS import_id,
  i.status AS import_status,
  i.created_at AS import_created_at
FROM fabublox_import_asset_dependencies dependency
JOIN imports i ON i.id = dependency.import_id
WHERE dependency.asset_id IS NOT NULL
  AND i.status IN ('pending', 'failed')
  AND i.finalization_id IS NULL
  AND (i.status = 'pending' OR i.recovery_operation_id IS NULL);

CREATE VIEW fabublox_recovery_public_asset_edges_template AS
SELECT
  sra.asset_id,
  'state_verification_expected_state' AS consumer_type,
  sv.id AS consumer_id
FROM state_representation_assets sra
JOIN state_verifications sv ON sv.expected_state_hash = sra.state_hash

UNION ALL
SELECT
  mtr.asset_id,
  'published_metrology_template_reference',
  mtr.id
FROM metrology_template_references mtr
WHERE mtr.superseded_by_occurrence_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM imports owner
    WHERE owner.template_version_id = mtr.template_version_id
      AND owner.status <> 'ready'
  )

UNION ALL
SELECT
  a.id,
  'published_template_source',
  tv.id
FROM template_versions tv
JOIN assets a ON a.r2_key = tv.source_asset_key
WHERE tv.source_asset_key IS NOT NULL AND tv.source_asset_key <> ''
  AND NOT EXISTS (
    SELECT 1 FROM imports owner
    WHERE owner.template_version_id = tv.id AND owner.status <> 'ready'
  )

UNION ALL
SELECT
  a.id,
  'ready_import_provenance',
  i.id
FROM imports i
JOIN assets a
  ON a.r2_key = i.workbook_asset_key OR a.r2_key = i.manifest_asset_key
WHERE i.status = 'ready';

CREATE VIEW fabublox_recovery_public_asset_edges AS
SELECT * FROM fabublox_recovery_public_asset_edges_external
UNION ALL
SELECT * FROM fabublox_recovery_public_asset_edges_state
UNION ALL
SELECT * FROM fabublox_recovery_public_asset_edges_template;
