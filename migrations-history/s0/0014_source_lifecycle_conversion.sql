PRAGMA foreign_keys = ON;

-- A legacy run-step comment stores its image occurrence on the comment row.
-- Keep that relationship recoverable without hiding the comment text itself.
ALTER TABLE run_step_comments ADD COLUMN asset_deleted_at TEXT;
ALTER TABLE run_step_comments ADD COLUMN asset_deleted_by TEXT;

CREATE INDEX run_step_comments_visible_asset_idx
ON run_step_comments(asset_id)
WHERE asset_id IS NOT NULL AND asset_deleted_at IS NULL;

-- Deleted recipe revisions remain valid historical targets, but they cannot be
-- used for a new Run or plan revision until restored.
DROP TRIGGER runs_reject_archived_template;
DROP TRIGGER run_plan_revisions_reject_archived_template;

CREATE TRIGGER runs_reject_archived_template
BEFORE INSERT ON runs
WHEN EXISTS (
  SELECT 1 FROM template_versions
  WHERE id = NEW.template_version_id
    AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'template version unavailable');
END;

CREATE TRIGGER run_plan_revisions_reject_archived_template
BEFORE INSERT ON run_plan_revisions
WHEN EXISTS (
  SELECT 1 FROM template_versions
  WHERE id = NEW.template_version_id
    AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'template version unavailable');
END;
