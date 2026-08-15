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
-- A recovery rebind can collide with an occurrence that already points to the
-- healthy canonical asset. Physical deletion remains forbidden except for that
-- exact redundant legacy occurrence after a durable failed-import claim. If
-- the legacy occurrence was visible, keep the canonical occurrence visible.

DROP TRIGGER run_step_assets_block_physical_delete;

CREATE TRIGGER run_step_assets_block_physical_delete
BEFORE DELETE ON run_step_assets
WHEN NOT EXISTS (
  SELECT 1
  FROM assets legacy
  JOIN imports failed_owner ON failed_owner.id = legacy.import_id
  JOIN assets canonical
    ON canonical.id <> legacy.id
   AND canonical.sha256 = legacy.sha256
   AND canonical.byte_size = legacy.byte_size
  LEFT JOIN imports canonical_owner ON canonical_owner.id = canonical.import_id
  JOIN run_step_assets canonical_occurrence
    ON canonical_occurrence.run_step_id = OLD.run_step_id
   AND canonical_occurrence.asset_id = canonical.id
   AND canonical_occurrence.role IS OLD.role
   AND canonical_occurrence.id <> OLD.id
  WHERE legacy.id = OLD.asset_id
    AND failed_owner.status = 'failed'
    AND failed_owner.recovery_operation_id IS NOT NULL
    AND legacy.sha256 IS NOT NULL
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
BEGIN
  SELECT RAISE(ABORT, 'run step asset occurrences cannot be physically deleted');
END;

CREATE TRIGGER run_step_assets_restore_recovery_duplicate_after_delete
AFTER DELETE ON run_step_assets
WHEN OLD.deleted_at IS NULL
BEGIN
  UPDATE run_step_assets
  SET deleted_at = NULL, deleted_by = NULL
  WHERE run_step_id = OLD.run_step_id
    AND role IS OLD.role
    AND asset_id IN (
      SELECT canonical.id
      FROM assets legacy
      JOIN imports failed_owner ON failed_owner.id = legacy.import_id
      JOIN assets canonical
        ON canonical.id <> legacy.id
       AND canonical.sha256 = legacy.sha256
       AND canonical.byte_size = legacy.byte_size
      LEFT JOIN imports canonical_owner ON canonical_owner.id = canonical.import_id
      WHERE legacy.id = OLD.asset_id
        AND failed_owner.status = 'failed'
        AND failed_owner.recovery_operation_id IS NOT NULL
        AND legacy.sha256 IS NOT NULL
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

DROP TRIGGER metrology_template_references_block_physical_delete;

CREATE TRIGGER metrology_template_references_block_physical_delete
BEFORE DELETE ON metrology_template_references
WHEN NOT EXISTS (
  SELECT 1
  FROM assets legacy
  JOIN imports failed_owner ON failed_owner.id = legacy.import_id
  JOIN assets canonical
    ON canonical.id <> legacy.id
   AND canonical.sha256 = legacy.sha256
   AND canonical.byte_size = legacy.byte_size
  LEFT JOIN imports canonical_owner ON canonical_owner.id = canonical.import_id
  JOIN metrology_template_references canonical_occurrence
    ON canonical_occurrence.template_version_id = OLD.template_version_id
   AND canonical_occurrence.asset_id = canonical.id
   AND canonical_occurrence.id <> OLD.id
  WHERE legacy.id = OLD.asset_id
    AND failed_owner.status = 'failed'
    AND failed_owner.recovery_operation_id IS NOT NULL
    AND legacy.sha256 IS NOT NULL
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
BEGIN
  SELECT RAISE(ABORT, 'metrology template references cannot be physically deleted');
END;

CREATE TRIGGER metrology_template_references_restore_recovery_duplicate_after_delete
AFTER DELETE ON metrology_template_references
WHEN OLD.deleted_at IS NULL
BEGIN
  UPDATE metrology_template_references
  SET deleted_at = NULL, deleted_by = NULL
  WHERE template_version_id = OLD.template_version_id
    AND asset_id IN (
      SELECT canonical.id
      FROM assets legacy
      JOIN imports failed_owner ON failed_owner.id = legacy.import_id
      JOIN assets canonical
        ON canonical.id <> legacy.id
       AND canonical.sha256 = legacy.sha256
       AND canonical.byte_size = legacy.byte_size
      LEFT JOIN imports canonical_owner ON canonical_owner.id = canonical.import_id
      WHERE legacy.id = OLD.asset_id
        AND failed_owner.status = 'failed'
        AND failed_owner.recovery_operation_id IS NOT NULL
        AND legacy.sha256 IS NOT NULL
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
