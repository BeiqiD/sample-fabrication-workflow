PRAGMA foreign_keys = ON;

-- Project-ready references require source records to keep stable identities
-- after an ordinary delete. This migration is deliberately additive: routes
-- continue to use their existing behavior until each lifecycle is converted
-- and tested in a later change.

ALTER TABLE samples ADD COLUMN deleted_at TEXT;
ALTER TABLE samples ADD COLUMN deleted_by TEXT;

ALTER TABLE runs ADD COLUMN deleted_at TEXT;
ALTER TABLE runs ADD COLUMN deleted_by TEXT;

ALTER TABLE run_steps ADD COLUMN deleted_at TEXT;
ALTER TABLE run_steps ADD COLUMN deleted_by TEXT;

-- A ready comment_submission is the canonical logical comment. A
-- run_step_comments row is its stable occurrence in one execution context.
ALTER TABLE comment_submissions ADD COLUMN deleted_at TEXT;
ALTER TABLE comment_submissions ADD COLUMN deleted_by TEXT;

ALTER TABLE run_step_comments ADD COLUMN updated_at TEXT;
ALTER TABLE run_step_comments ADD COLUMN updated_by TEXT;
ALTER TABLE run_step_comments ADD COLUMN deleted_at TEXT;
ALTER TABLE run_step_comments ADD COLUMN deleted_by TEXT;

-- Attachment occurrence records remain distinct from their content-addressed
-- assets or managed-storage blobs.
ALTER TABLE comment_submission_items ADD COLUMN deleted_at TEXT;
ALTER TABLE comment_submission_items ADD COLUMN deleted_by TEXT;

ALTER TABLE run_step_assets ADD COLUMN deleted_at TEXT;
ALTER TABLE run_step_assets ADD COLUMN deleted_by TEXT;

ALTER TABLE metrology_template_references ADD COLUMN deleted_at TEXT;
ALTER TABLE metrology_template_references ADD COLUMN deleted_by TEXT;

-- Projects reference an immutable recipe revision, not a mutable display name.
ALTER TABLE template_versions ADD COLUMN deleted_at TEXT;
ALTER TABLE template_versions ADD COLUMN deleted_by TEXT;

CREATE INDEX samples_visible_updated_idx
ON samples(updated_at DESC)
WHERE deleted_at IS NULL;

CREATE INDEX runs_visible_sample_sequence_idx
ON runs(sample_id, sequence_no DESC)
WHERE deleted_at IS NULL;

CREATE INDEX run_steps_visible_run_position_idx
ON run_steps(run_id, position)
WHERE deleted_at IS NULL;

CREATE INDEX comment_submissions_visible_updated_idx
ON comment_submissions(updated_at DESC)
WHERE deleted_at IS NULL;

CREATE INDEX run_step_comments_visible_step_created_idx
ON run_step_comments(run_step_id, created_at, id)
WHERE deleted_at IS NULL;

CREATE INDEX comment_submission_items_visible_submission_idx
ON comment_submission_items(submission_id, position)
WHERE deleted_at IS NULL;

CREATE INDEX run_step_assets_visible_step_idx
ON run_step_assets(run_step_id, role, position)
WHERE deleted_at IS NULL;

CREATE INDEX metrology_template_references_visible_template_idx
ON metrology_template_references(template_version_id, position, created_at)
WHERE deleted_at IS NULL;

CREATE INDEX template_versions_visible_kind_name_idx
ON template_versions(template_kind, name, version)
WHERE deleted_at IS NULL;
