-- A connection keeps its stable identity and provenance when users reconnect
-- either endpoint. Existing active-project, same-project, active-endpoint,
-- revision, handle, self-edge, and duplicate-edge guards continue to apply.
DROP TRIGGER project_edges_reject_identity_update;

CREATE TRIGGER project_edges_reject_identity_update
BEFORE UPDATE ON project_edges
WHEN OLD.id IS NOT NEW.id
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.created_by IS NOT NEW.created_by
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'project edge identity is immutable');
END;

-- Endpoint changes are semantic changes too, including moving only a handle.
-- They require exactly one new revision and a fresh mutation identity.
DROP TRIGGER project_edges_require_revisioned_update;

CREATE TRIGGER project_edges_require_revisioned_update
BEFORE UPDATE ON project_edges
WHEN OLD.revision IS NOT NEW.revision
  OR OLD.last_mutation_id IS NOT NEW.last_mutation_id
  OR OLD.source_item_id IS NOT NEW.source_item_id
  OR OLD.target_item_id IS NOT NEW.target_item_id
  OR OLD.source_handle IS NOT NEW.source_handle
  OR OLD.target_handle IS NOT NEW.target_handle
  OR OLD.marker_start IS NOT NEW.marker_start
  OR OLD.marker_end IS NOT NEW.marker_end
  OR OLD.label IS NOT NEW.label
  OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.deleted_by IS NOT NEW.deleted_by
  OR OLD.deletion_operation_id IS NOT NEW.deletion_operation_id
BEGIN
  SELECT RAISE(ABORT, 'project edge revision metadata requires a semantic update')
  WHERE NOT (
    OLD.source_item_id IS NOT NEW.source_item_id
    OR OLD.target_item_id IS NOT NEW.target_item_id
    OR OLD.source_handle IS NOT NEW.source_handle
    OR OLD.target_handle IS NOT NEW.target_handle
    OR OLD.marker_start IS NOT NEW.marker_start
    OR OLD.marker_end IS NOT NEW.marker_end
    OR OLD.label IS NOT NEW.label
    OR OLD.deleted_at IS NOT NEW.deleted_at
    OR OLD.deleted_by IS NOT NEW.deleted_by
    OR OLD.deletion_operation_id IS NOT NEW.deletion_operation_id
  );
  SELECT RAISE(ABORT, 'project edge update requires the next revision')
  WHERE NEW.revision <> OLD.revision + 1;
  SELECT RAISE(ABORT, 'project edge update requires a fresh mutation id')
  WHERE NEW.last_mutation_id IS OLD.last_mutation_id;
END;
