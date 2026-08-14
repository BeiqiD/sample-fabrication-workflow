PRAGMA foreign_keys = ON;

-- Publication checks are used on every read path. These indexes keep the
-- correlated owning-import predicates cheap and deterministic.
CREATE INDEX imports_template_publication_idx
ON imports(template_version_id, status)
WHERE template_version_id IS NOT NULL;

-- A FabuBlox template may exist while metadata is staged, but it is immutable
-- and cannot participate in public relationships until its import is ready.
CREATE TRIGGER template_versions_guard_unpublished_update
BEFORE UPDATE ON template_versions
WHEN EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = OLD.id AND i.status = 'pending'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER template_steps_guard_unpublished_update
BEFORE UPDATE ON template_steps
WHEN EXISTS (
  SELECT 1
  FROM template_versions tv
  JOIN imports i ON i.template_version_id = tv.id
  WHERE tv.id = OLD.template_version_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER runs_guard_unpublished_template_insert
BEFORE INSERT ON runs
WHEN EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = NEW.template_version_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER runs_guard_unpublished_template_update
BEFORE UPDATE OF template_version_id ON runs
WHEN EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = NEW.template_version_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER run_plan_revisions_guard_unpublished_template_insert
BEFORE INSERT ON run_plan_revisions
WHEN EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = NEW.template_version_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER run_plan_revisions_guard_unpublished_template_update
BEFORE UPDATE OF template_version_id ON run_plan_revisions
WHEN EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = NEW.template_version_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER recipe_change_proposals_guard_unpublished_template_insert
BEFORE INSERT ON recipe_change_proposals
WHEN EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = NEW.source_template_version_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER recipe_change_proposals_guard_unpublished_template_update
BEFORE UPDATE OF source_template_version_id ON recipe_change_proposals
WHEN EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = NEW.source_template_version_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER reference_targets_guard_unpublished_recipe_insert
BEFORE INSERT ON reference_targets
WHEN NEW.target_type = 'recipe_revision' AND EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = NEW.target_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

-- Every R2 relationship must bind a ready asset whose owning import is also
-- ready. FabuBlox creates state-image relationships only in the finalization
-- transaction, after the import update activates its pending assets.
CREATE TRIGGER state_representation_assets_guard_publication_insert
BEFORE INSERT ON state_representation_assets
WHEN NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER state_representation_assets_guard_publication_update
BEFORE UPDATE OF asset_id ON state_representation_assets
WHEN NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER run_step_assets_guard_publication_insert
BEFORE INSERT ON run_step_assets
WHEN NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER run_step_assets_guard_publication_update
BEFORE UPDATE OF asset_id ON run_step_assets
WHEN NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
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

CREATE TRIGGER state_verifications_guard_publication_insert
BEFORE INSERT ON state_verifications
WHEN NEW.evidence_asset_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.evidence_asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER state_verifications_guard_publication_update
BEFORE UPDATE OF evidence_asset_id ON state_verifications
WHEN NEW.evidence_asset_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.id = NEW.evidence_asset_id AND a.status = 'ready'
    AND (a.import_id IS NULL OR i.status = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER comment_submission_items_guard_asset_publication_insert
BEFORE INSERT ON comment_submission_items
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

CREATE TRIGGER comment_submission_items_guard_asset_publication_update
BEFORE UPDATE OF asset_id ON comment_submission_items
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

CREATE TRIGGER metrology_template_references_guard_publication_insert
BEFORE INSERT ON metrology_template_references
BEGIN
  SELECT RAISE(ABORT, 'template version is not published') WHERE EXISTS (
    SELECT 1 FROM imports i
    WHERE i.template_version_id = NEW.template_version_id AND i.status <> 'ready'
  );
  SELECT RAISE(ABORT, 'asset owning import is not ready') WHERE NOT EXISTS (
    SELECT 1
    FROM assets a
    LEFT JOIN imports i ON i.id = a.import_id
    WHERE a.id = NEW.asset_id AND a.status = 'ready'
      AND (a.import_id IS NULL OR i.status = 'ready')
  );
END;

CREATE TRIGGER metrology_template_references_guard_publication_update
BEFORE UPDATE OF template_version_id, asset_id ON metrology_template_references
BEGIN
  SELECT RAISE(ABORT, 'template version is not published') WHERE EXISTS (
    SELECT 1 FROM imports i
    WHERE i.template_version_id = NEW.template_version_id AND i.status <> 'ready'
  );
  SELECT RAISE(ABORT, 'asset owning import is not ready') WHERE NOT EXISTS (
    SELECT 1
    FROM assets a
    LEFT JOIN imports i ON i.id = a.import_id
    WHERE a.id = NEW.asset_id AND a.status = 'ready'
      AND (a.import_id IS NULL OR i.status = 'ready')
  );
END;
