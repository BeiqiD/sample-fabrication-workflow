PRAGMA foreign_keys = ON;

-- Phase 3A2 removes/restores an item and its owned content in one D1 batch.
-- A zero-row conditional UPDATE does not itself abort a batch, so the final
-- item transition is the database-owned commit guard: it is rejected unless
-- every connected edge and owned-content transition has already succeeded in
-- the same transaction.

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
