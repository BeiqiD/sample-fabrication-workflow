PRAGMA foreign_keys = ON;

CREATE TRIGGER samples_location_history
AFTER UPDATE OF location ON samples
WHEN OLD.location IS NOT NEW.location
BEGIN
  INSERT INTO events (id, sample_id, kind, body, metadata_json, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.id, 'location',
    'Location changed from ' || COALESCE(OLD.location, '—') || ' to ' || COALESCE(NEW.location, '—'),
    json_object('field', 'location', 'previous', OLD.location, 'current', NEW.location),
    NEW.updated_at
  );
END;

CREATE TRIGGER samples_status_history
AFTER UPDATE OF status ON samples
WHEN OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO events (id, sample_id, kind, body, metadata_json, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.id, 'status',
    'Status changed from ' || OLD.status || ' to ' || NEW.status,
    json_object('field', 'status', 'previous', OLD.status, 'current', NEW.status),
    NEW.updated_at
  );
END;

CREATE TRIGGER samples_pinned_history
AFTER UPDATE OF pinned ON samples
WHEN OLD.pinned IS NOT NEW.pinned
BEGIN
  INSERT INTO events (id, sample_id, kind, body, metadata_json, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.id, 'status',
    CASE WHEN NEW.pinned = 1 THEN 'Sample pinned' ELSE 'Sample unpinned' END,
    json_object('field', 'pinned', 'previous', OLD.pinned = 1, 'current', NEW.pinned = 1),
    NEW.updated_at
  );
END;
