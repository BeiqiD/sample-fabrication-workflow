-- Sample lifecycle follows the process lifecycle during normal fabrication.
-- Explicit physical terminal states remain authoritative: completing a run
-- must not turn a consumed or lost sample back into stored.

-- Repair samples left active by the previous implementation when their latest
-- run had already completed at the same time or after the sample's last update.
UPDATE samples
SET status = 'stored'
WHERE status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM runs active
    WHERE active.sample_id = samples.id AND active.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM runs latest
    WHERE latest.sample_id = samples.id
      AND latest.status = 'complete'
      AND latest.completed_at IS NOT NULL
      AND latest.completed_at >= samples.updated_at
      AND NOT EXISTS (
        SELECT 1 FROM runs newer
        WHERE newer.sample_id = latest.sample_id
          AND newer.sequence_no > latest.sequence_no
      )
  );

CREATE TRIGGER runs_activate_sample_after_insert
AFTER INSERT ON runs
WHEN NEW.status = 'active'
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
AFTER UPDATE OF status ON runs
WHEN OLD.status != 'active' AND NEW.status = 'active'
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
          NEW.created_at
        )
        ELSE updated_at
      END
  WHERE id = NEW.sample_id AND status != 'active';
END;

CREATE TRIGGER runs_store_sample_after_completion
AFTER UPDATE OF status ON runs
WHEN OLD.status = 'active' AND NEW.status = 'complete'
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
      SELECT 1 FROM runs active
      WHERE active.sample_id = NEW.sample_id AND active.status = 'active'
    );
END;
