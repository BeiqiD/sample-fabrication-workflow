PRAGMA foreign_keys = ON;

-- Soft-deleted parents remain physically present, so child mutations need a
-- transaction-local proof that their authoritative source was still writable
-- when the mutation batch began.
ALTER TABLE runs ADD COLUMN last_mutation_id TEXT;
ALTER TABLE comment_submissions ADD COLUMN last_mutation_id TEXT;
ALTER TABLE run_step_comments ADD COLUMN last_mutation_id TEXT;
ALTER TABLE run_step_assets ADD COLUMN last_mutation_id TEXT;

-- Timestamps and actors are audit data, not unique operation identities.
-- Canonical Comment restore must only revive occurrences deleted by the exact
-- same delete operation.
ALTER TABLE comment_submissions ADD COLUMN deletion_operation_id TEXT;
ALTER TABLE run_step_comments ADD COLUMN deletion_operation_id TEXT;
ALTER TABLE run_step_comments ADD COLUMN asset_deletion_operation_id TEXT;

CREATE INDEX run_step_comments_deletion_operation_idx
ON run_step_comments(submission_id, deletion_operation_id)
WHERE deleted_at IS NOT NULL AND deletion_operation_id IS NOT NULL;

CREATE INDEX run_step_comments_asset_deletion_operation_idx
ON run_step_comments(operation_group_id, asset_deletion_operation_id)
WHERE asset_deleted_at IS NOT NULL AND asset_deletion_operation_id IS NOT NULL;
