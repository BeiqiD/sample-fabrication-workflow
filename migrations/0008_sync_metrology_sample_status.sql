-- Standalone metrology is active work on a sample even though it does not
-- change the fabrication structure. Completing either kind of run stores the
-- sample only after every standalone process and metrology run has finished.

UPDATE samples
SET status = 'active',
    updated_by = COALESCE(
      (
        SELECT active.created_by
        FROM runs active
        WHERE active.sample_id = samples.id
          AND active.status = 'active'
          AND active.run_kind = 'metrology'
        ORDER BY active.created_at DESC, active.id DESC
        LIMIT 1
      ),
      updated_by
    ),
    updated_at = CASE
      WHEN (
        SELECT active.created_at
        FROM runs active
        WHERE active.sample_id = samples.id
          AND active.status = 'active'
          AND active.run_kind = 'metrology'
        ORDER BY active.created_at DESC, active.id DESC
        LIMIT 1
      ) > updated_at
      THEN (
        SELECT active.created_at
        FROM runs active
        WHERE active.sample_id = samples.id
          AND active.status = 'active'
          AND active.run_kind = 'metrology'
        ORDER BY active.created_at DESC, active.id DESC
        LIMIT 1
      )
      ELSE updated_at
    END
WHERE status = 'stored'
  AND EXISTS (
    SELECT 1
    FROM runs active
    WHERE active.sample_id = samples.id
      AND active.status = 'active'
      AND active.run_kind = 'metrology'
  );

DROP TRIGGER runs_activate_sample_after_insert;
DROP TRIGGER runs_activate_sample_after_reopen;
DROP TRIGGER runs_store_sample_after_completion;

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
      SELECT 1
      FROM runs active
      WHERE active.sample_id = NEW.sample_id
        AND active.status = 'active'
    );
END;
