-- A template version is immutable only while live workflow data still
-- references it. Deleting the last sample/run that uses a version releases it
-- for editing or deletion again. Archived versions remain archived.

UPDATE template_versions
SET locked_at = NULL,
    locked_by = NULL
WHERE archived_at IS NULL
  AND locked_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM runs r
    WHERE r.template_version_id = template_versions.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM run_plan_revisions rpr
    WHERE rpr.template_version_id = template_versions.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM recipe_change_proposals rcp
    WHERE rcp.source_template_version_id = template_versions.id
  );

CREATE TRIGGER runs_release_unreferenced_templates
AFTER DELETE ON runs
BEGIN
  UPDATE template_versions
  SET locked_at = NULL,
      locked_by = NULL
  WHERE archived_at IS NULL
    AND locked_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM runs r
      WHERE r.template_version_id = template_versions.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM run_plan_revisions rpr
      WHERE rpr.template_version_id = template_versions.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM recipe_change_proposals rcp
      WHERE rcp.source_template_version_id = template_versions.id
    );
END;

CREATE TRIGGER run_plan_revisions_release_unreferenced_template
AFTER DELETE ON run_plan_revisions
BEGIN
  UPDATE template_versions
  SET locked_at = NULL,
      locked_by = NULL
  WHERE id = OLD.template_version_id
    AND archived_at IS NULL
    AND locked_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM runs r
      WHERE r.template_version_id = OLD.template_version_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM run_plan_revisions rpr
      WHERE rpr.template_version_id = OLD.template_version_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM recipe_change_proposals rcp
      WHERE rcp.source_template_version_id = OLD.template_version_id
    );
END;

CREATE TRIGGER recipe_change_proposals_release_unreferenced_template
AFTER DELETE ON recipe_change_proposals
BEGIN
  UPDATE template_versions
  SET locked_at = NULL,
      locked_by = NULL
  WHERE id = OLD.source_template_version_id
    AND archived_at IS NULL
    AND locked_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM runs r
      WHERE r.template_version_id = OLD.source_template_version_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM run_plan_revisions rpr
      WHERE rpr.template_version_id = OLD.source_template_version_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM recipe_change_proposals rcp
      WHERE rcp.source_template_version_id = OLD.source_template_version_id
    );
END;
