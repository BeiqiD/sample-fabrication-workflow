PRAGMA foreign_keys = ON;

-- Durable external references use one sparse polymorphic registry. The registry
-- stores stable identity and validation metadata only; current titles, bodies,
-- previews, and source paths remain authoritative in their source tables.
CREATE TABLE reference_targets (
  id TEXT PRIMARY KEY,
  registry_version INTEGER NOT NULL DEFAULT 1 CHECK (registry_version = 1),
  target_type TEXT NOT NULL CHECK (target_type IN (
    'sample',
    'run',
    'run_step',
    'comment',
    'comment_occurrence',
    'comment_attachment',
    'execution_image',
    'metrology_reference',
    'recipe_revision'
  )),
  target_id TEXT NOT NULL CHECK (length(target_id) > 0),
  first_registered_at TEXT NOT NULL,
  last_validated_at TEXT NOT NULL,
  tombstoned_at TEXT,
  last_known_contexts_json TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(last_known_contexts_json)
      AND json_type(last_known_contexts_json) = 'array'
    ),
  UNIQUE(target_type, target_id)
);

CREATE INDEX reference_targets_type_validated_idx
ON reference_targets(target_type, last_validated_at);

CREATE INDEX reference_targets_tombstoned_idx
ON reference_targets(tombstoned_at)
WHERE tombstoned_at IS NOT NULL;

-- A registry row is itself a stable identity. Validation metadata and the
-- future tombstone state may change, but neither its registry ID nor the source
-- identity it represents may ever be retargeted in place.
CREATE TRIGGER reference_targets_reject_identity_update
BEFORE UPDATE ON reference_targets
WHEN OLD.id IS NOT NEW.id
  OR OLD.registry_version IS NOT NEW.registry_version
  OR OLD.target_type IS NOT NEW.target_type
  OR OLD.target_id IS NOT NEW.target_id
  OR OLD.first_registered_at IS NOT NEW.first_registered_at
BEGIN
  SELECT RAISE(ABORT, 'reference target identity is immutable');
END;

-- Permanent deletion remains disabled. A later privileged planner must create a
-- tombstone and pass final backlink/concurrency checks before this protection
-- can be reconsidered.
CREATE TRIGGER reference_targets_reject_physical_delete
BEFORE DELETE ON reference_targets
BEGIN
  SELECT RAISE(ABORT, 'reference target physical deletion is disabled');
END;
