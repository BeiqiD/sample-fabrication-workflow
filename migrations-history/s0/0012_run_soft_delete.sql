-- Ordinary run deletion is recoverable. Deleted runs retain their complete
-- execution graph but no longer participate in live-run uniqueness or sample
-- lifecycle rollups.

DROP INDEX runs_one_active_process_per_sample_idx;
DROP INDEX runs_single_successor_idx;

CREATE UNIQUE INDEX runs_one_active_process_per_sample_idx
ON runs(sample_id)
WHERE status = 'active' AND run_kind = 'process' AND deleted_at IS NULL;

CREATE UNIQUE INDEX runs_single_successor_idx
ON runs(predecessor_run_id)
WHERE predecessor_run_id IS NOT NULL AND deleted_at IS NULL;

DROP TRIGGER runs_activate_sample_after_insert;
DROP TRIGGER runs_activate_sample_after_reopen;
DROP TRIGGER runs_store_sample_after_completion;
DROP TRIGGER run_step_status_rollup;

CREATE TRIGGER runs_activate_sample_after_insert
AFTER INSERT ON runs
WHEN NEW.status = 'active' AND NEW.deleted_at IS NULL
BEGIN
  UPDATE samples
  SET status = 'active',
      updated_by = COALESCE(NEW.created_by, updated_by),
      updated_at = CASE
        WHEN NEW.created_at > updated_at THEN NEW.created_at
        ELSE updated_at
      END
  WHERE id = NEW.sample_id AND status != 'active';
END;

CREATE TRIGGER runs_activate_sample_after_reopen
AFTER UPDATE OF status, deleted_at ON runs
WHEN NEW.status = 'active' AND NEW.deleted_at IS NULL
  AND (OLD.status != 'active' OR OLD.deleted_at IS NOT NULL)
BEGIN
  UPDATE samples
  SET status = 'active',
      updated_by = COALESCE(
        (
          SELECT actor_email
          FROM run_plan_revisions
          WHERE run_id = NEW.id
          ORDER BY revision_no DESC
          LIMIT 1
        ),
        (
          SELECT updated_by
          FROM run_steps
          WHERE run_id = NEW.id
          ORDER BY updated_at DESC, id DESC
          LIMIT 1
        ),
        NEW.created_by,
        updated_by
      ),
      updated_at = CASE
        WHEN COALESCE(
          (
            SELECT created_at
            FROM run_plan_revisions
            WHERE run_id = NEW.id
            ORDER BY revision_no DESC
            LIMIT 1
          ),
          (
            SELECT updated_at
            FROM run_steps
            WHERE run_id = NEW.id
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
          ),
          NEW.created_at
        ) > updated_at
        THEN COALESCE(
          (
            SELECT created_at
            FROM run_plan_revisions
            WHERE run_id = NEW.id
            ORDER BY revision_no DESC
            LIMIT 1
          ),
          (
            SELECT updated_at
            FROM run_steps
            WHERE run_id = NEW.id
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
          ),
          NEW.created_at
        )
        ELSE updated_at
      END
  WHERE id = NEW.sample_id AND status != 'active';
END;

CREATE TRIGGER runs_store_sample_after_completion
AFTER UPDATE OF status ON runs
WHEN OLD.status = 'active' AND NEW.status = 'complete' AND NEW.deleted_at IS NULL
BEGIN
  UPDATE samples
  SET status = 'stored',
      updated_by = COALESCE(
        (
          SELECT updated_by
          FROM run_steps
          WHERE run_id = NEW.id
          ORDER BY updated_at DESC, id DESC
          LIMIT 1
        ),
        updated_by
      ),
      updated_at = CASE
        WHEN NEW.completed_at IS NOT NULL AND NEW.completed_at > updated_at
        THEN NEW.completed_at
        ELSE updated_at
      END
  WHERE id = NEW.sample_id
    AND status = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM runs active
      WHERE active.sample_id = NEW.sample_id
        AND active.status = 'active'
        AND active.deleted_at IS NULL
    );
END;

CREATE TRIGGER run_step_status_rollup
AFTER UPDATE OF status ON run_steps
WHEN OLD.status IS NOT NEW.status
BEGIN
  UPDATE runs
  SET status = CASE
        WHEN NOT EXISTS (
          SELECT 1
          FROM run_steps pending
          WHERE pending.run_id = NEW.run_id
            AND pending.plan_status = 'current'
            AND pending.deleted_at IS NULL
            AND pending.status NOT IN ('done', 'skipped')
            AND pending.entry_kind = CASE
              WHEN runs.run_kind = 'metrology' THEN 'metrology'
              ELSE 'fabrication'
            END
        ) THEN 'complete'
        ELSE 'active'
      END,
      completed_at = CASE
        WHEN NOT EXISTS (
          SELECT 1
          FROM run_steps pending
          WHERE pending.run_id = NEW.run_id
            AND pending.plan_status = 'current'
            AND pending.deleted_at IS NULL
            AND pending.status NOT IN ('done', 'skipped')
            AND pending.entry_kind = CASE
              WHEN runs.run_kind = 'metrology' THEN 'metrology'
              ELSE 'fabrication'
            END
        ) THEN NEW.updated_at
        ELSE NULL
      END
  WHERE id = NEW.run_id
    AND deleted_at IS NULL
    AND status NOT IN ('cancelled', 'superseded');
END;
