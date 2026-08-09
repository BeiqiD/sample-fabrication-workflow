PRAGMA foreign_keys = ON;

-- Phase 3A2 removes/restores an item and its owned content in one D1 batch.
-- A zero-row conditional UPDATE does not itself abort a batch, so the final
-- item transition is the database-owned commit guard: it is rejected unless
-- every connected edge and owned-content transition has already succeeded in
-- the same transaction.

CREATE TRIGGER project_contents_require_active_project_update
BEFORE UPDATE ON project_contents
WHEN NOT EXISTS (
  SELECT 1 FROM projects p
  WHERE p.id = NEW.project_id AND p.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'project content update requires an active project');
END;

CREATE TRIGGER project_items_require_active_project_update
BEFORE UPDATE ON project_items
WHEN NOT EXISTS (
  SELECT 1 FROM projects p
  WHERE p.id = NEW.project_id AND p.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'project item update requires an active project');
END;

-- Safe-integer exhaustion is an exceptional maintenance boundary. An edge
-- connected to an exhausted item/content row cannot be deleted first as part of
-- item removal, because the later lifecycle row would be unable to advance and
-- a zero-row UPDATE would otherwise permit a partial batch commit.
CREATE TRIGGER project_edges_require_endpoint_lifecycle_capacity
BEFORE UPDATE OF deleted_at ON project_edges
WHEN OLD.deleted_at IS NULL
  AND NEW.deleted_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM project_items pi
    LEFT JOIN project_contents pc ON pc.id = pi.project_content_id
    WHERE pi.id IN (OLD.source_item_id, OLD.target_item_id)
      AND (
        pi.revision >= 9007199254740991
        OR pc.revision >= 9007199254740991
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'project edge deletion requires endpoint lifecycle capacity');
END;

-- Owned content must not enter deletion when its owning occurrence cannot
-- advance in the same transaction.
CREATE TRIGGER project_contents_require_owner_lifecycle_capacity
BEFORE UPDATE OF deleted_at ON project_contents
WHEN OLD.deleted_at IS NULL
  AND NEW.deleted_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM project_items pi
    WHERE pi.project_content_id = OLD.id
      AND pi.project_id = OLD.project_id
      AND pi.deleted_at IS NULL
      AND pi.revision >= 9007199254740991
  )
BEGIN
  SELECT RAISE(ABORT, 'project content deletion requires owner lifecycle capacity');
END;

CREATE TRIGGER project_items_require_deleted_edges
BEFORE UPDATE OF deleted_at ON project_items
WHEN OLD.deleted_at IS NULL
  AND NEW.deleted_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM project_edges pe
    WHERE pe.project_id = OLD.project_id
      AND pe.deleted_at IS NULL
      AND (pe.source_item_id = OLD.id OR pe.target_item_id = OLD.id)
  )
BEGIN
  SELECT RAISE(ABORT, 'project item deletion requires connected edges to be deleted');
END;

CREATE TRIGGER project_items_require_deleted_owned_content
BEFORE UPDATE OF deleted_at, deletion_operation_id ON project_items
WHEN OLD.deleted_at IS NULL
  AND NEW.deleted_at IS NOT NULL
  AND OLD.project_content_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM project_contents pc
    WHERE pc.id = OLD.project_content_id
      AND pc.project_id = OLD.project_id
      AND pc.deleted_at IS NOT NULL
      AND pc.deletion_operation_id = NEW.deletion_operation_id
      AND pc.last_mutation_id = NEW.last_mutation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'project item deletion requires owned content deletion');
END;

CREATE TRIGGER project_items_require_restored_owned_content
BEFORE UPDATE OF deleted_at ON project_items
WHEN OLD.deleted_at IS NOT NULL
  AND NEW.deleted_at IS NULL
  AND OLD.project_content_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM project_contents pc
    WHERE pc.id = OLD.project_content_id
      AND pc.project_id = OLD.project_id
      AND pc.deleted_at IS NULL
      AND pc.last_mutation_id = NEW.last_mutation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'project item restore requires owned content restore');
END;

CREATE TRIGGER project_items_require_available_reference_restore
BEFORE UPDATE OF deleted_at ON project_items
WHEN OLD.deleted_at IS NOT NULL
  AND NEW.deleted_at IS NULL
  AND OLD.item_type = 'reference'
  AND NOT EXISTS (
    SELECT 1 FROM reference_targets rt
    WHERE rt.id = OLD.reference_target_id AND rt.tombstoned_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'project reference restore requires an available target');
END;
