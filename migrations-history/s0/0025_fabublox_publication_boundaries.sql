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

CREATE TRIGGER run_steps_guard_unpublished_template_step_insert
BEFORE INSERT ON run_steps
WHEN NEW.template_step_id IS NOT NULL AND EXISTS (
  SELECT 1
  FROM template_steps ts
  JOIN imports i ON i.template_version_id = ts.template_version_id
  WHERE ts.id = NEW.template_step_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER run_steps_guard_unpublished_template_step_update
BEFORE UPDATE OF template_step_id ON run_steps
WHEN NEW.template_step_id IS NOT NULL
  AND NEW.template_step_id IS NOT OLD.template_step_id
  AND EXISTS (
    SELECT 1
    FROM template_steps ts
    JOIN imports i ON i.template_version_id = ts.template_version_id
    WHERE ts.id = NEW.template_step_id AND i.status <> 'ready'
  )
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER run_step_plan_links_guard_unpublished_template_step_insert
BEFORE INSERT ON run_step_plan_links
WHEN EXISTS (
  SELECT 1
  FROM template_steps ts
  JOIN imports i ON i.template_version_id = ts.template_version_id
  WHERE ts.id = NEW.template_step_id AND i.status <> 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

CREATE TRIGGER run_step_plan_links_guard_unpublished_template_step_update
BEFORE UPDATE OF template_step_id ON run_step_plan_links
WHEN NEW.template_step_id IS NOT OLD.template_step_id AND EXISTS (
  SELECT 1
  FROM template_steps ts
  JOIN imports i ON i.template_version_id = ts.template_version_id
  WHERE ts.id = NEW.template_step_id AND i.status <> 'ready'
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

-- Direct timeline keys are legacy asset relationships. Preserve compatibility
-- with provider-only keys, but reject a key that resolves to staged or failed
-- asset metadata, including a ready asset whose owning import is not ready.
CREATE TRIGGER events_guard_asset_publication_insert
BEFORE INSERT ON events
WHEN NEW.asset_key IS NOT NULL AND NEW.asset_key <> '' AND EXISTS (
  SELECT 1
  FROM assets a
  LEFT JOIN imports i ON i.id = a.import_id
  WHERE a.r2_key = NEW.asset_key AND (
    a.status <> 'ready'
    OR (a.import_id IS NOT NULL AND (i.id IS NULL OR i.status <> 'ready'))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER events_guard_asset_publication_update
BEFORE UPDATE OF asset_key ON events
WHEN NEW.asset_key IS NOT OLD.asset_key
  AND NEW.asset_key IS NOT NULL AND NEW.asset_key <> '' AND EXISTS (
    SELECT 1
    FROM assets a
    LEFT JOIN imports i ON i.id = a.import_id
    WHERE a.r2_key = NEW.asset_key AND (
      a.status <> 'ready'
      OR (a.import_id IS NOT NULL AND (i.id IS NULL OR i.status <> 'ready'))
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER events_guard_thumbnail_publication_insert
BEFORE INSERT ON events
WHEN json_valid(NEW.metadata_json)
  AND typeof(json_extract(NEW.metadata_json, '$.thumbnailKey')) = 'text'
  AND NULLIF(TRIM(CAST(json_extract(NEW.metadata_json, '$.thumbnailKey') AS TEXT)), '') IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM assets a
    LEFT JOIN imports i ON i.id = a.import_id
    WHERE a.r2_key = CAST(json_extract(NEW.metadata_json, '$.thumbnailKey') AS TEXT)
      AND (
        a.status <> 'ready'
        OR (a.import_id IS NOT NULL AND (i.id IS NULL OR i.status <> 'ready'))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
END;

CREATE TRIGGER events_guard_thumbnail_publication_update
BEFORE UPDATE OF metadata_json ON events
WHEN CAST(CASE WHEN json_valid(NEW.metadata_json)
               THEN json_extract(NEW.metadata_json, '$.thumbnailKey') END AS TEXT)
     IS NOT
     CAST(CASE WHEN json_valid(OLD.metadata_json)
               THEN json_extract(OLD.metadata_json, '$.thumbnailKey') END AS TEXT)
  AND json_valid(NEW.metadata_json)
  AND typeof(json_extract(NEW.metadata_json, '$.thumbnailKey')) = 'text'
  AND NULLIF(TRIM(CAST(json_extract(NEW.metadata_json, '$.thumbnailKey') AS TEXT)), '') IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM assets a
    LEFT JOIN imports i ON i.id = a.import_id
    WHERE a.r2_key = CAST(json_extract(NEW.metadata_json, '$.thumbnailKey') AS TEXT)
      AND (
        a.status <> 'ready'
        OR (a.import_id IS NOT NULL AND (i.id IS NULL OR i.status <> 'ready'))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'asset owning import is not ready');
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
