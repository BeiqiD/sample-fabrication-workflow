PRAGMA foreign_keys = ON;

ALTER TABLE samples ADD COLUMN created_by TEXT;
ALTER TABLE samples ADD COLUMN updated_by TEXT;
ALTER TABLE samples ADD COLUMN last_mutation_id TEXT;
ALTER TABLE events ADD COLUMN actor_email TEXT;
ALTER TABLE template_versions ADD COLUMN created_by TEXT;
ALTER TABLE runs ADD COLUMN created_by TEXT;
ALTER TABLE run_steps ADD COLUMN updated_by TEXT;
ALTER TABLE run_steps ADD COLUMN last_mutation_id TEXT;
ALTER TABLE imports ADD COLUMN actor_email TEXT;
ALTER TABLE assets ADD COLUMN actor_email TEXT;

DROP TRIGGER samples_location_history;
DROP TRIGGER samples_status_history;
DROP TRIGGER samples_pinned_history;

CREATE TRIGGER samples_location_history
AFTER UPDATE OF location ON samples
WHEN OLD.location IS NOT NEW.location
BEGIN
  INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.id, 'location',
    'Location changed from ' || COALESCE(OLD.location, '—') || ' to ' || COALESCE(NEW.location, '—'),
    json_object('field', 'location', 'previous', OLD.location, 'current', NEW.location),
    NEW.updated_by, NEW.updated_at
  );
END;

CREATE TRIGGER samples_status_history
AFTER UPDATE OF status ON samples
WHEN OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.id, 'status',
    'Status changed from ' || OLD.status || ' to ' || NEW.status,
    json_object('field', 'status', 'previous', OLD.status, 'current', NEW.status),
    NEW.updated_by, NEW.updated_at
  );
END;

CREATE TRIGGER samples_pinned_history
AFTER UPDATE OF pinned ON samples
WHEN OLD.pinned IS NOT NEW.pinned
BEGIN
  INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.id, 'status',
    CASE WHEN NEW.pinned = 1 THEN 'Sample pinned' ELSE 'Sample unpinned' END,
    json_object('field', 'pinned', 'previous', OLD.pinned = 1, 'current', NEW.pinned = 1),
    NEW.updated_by, NEW.updated_at
  );
END;

CREATE TRIGGER run_step_status_rollup
AFTER UPDATE OF status ON run_steps
WHEN OLD.status IS NOT NEW.status
BEGIN
  UPDATE runs
  SET status = CASE
        WHEN NOT EXISTS (SELECT 1 FROM run_steps WHERE run_id = NEW.run_id AND status NOT IN ('done', 'skipped')) THEN 'complete'
        ELSE 'active'
      END,
      completed_at = CASE
        WHEN NOT EXISTS (SELECT 1 FROM run_steps WHERE run_id = NEW.run_id AND status NOT IN ('done', 'skipped')) THEN NEW.updated_at
        ELSE NULL
      END
  WHERE id = NEW.run_id AND status != 'cancelled';
END;
