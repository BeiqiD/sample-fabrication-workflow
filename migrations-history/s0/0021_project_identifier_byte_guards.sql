PRAGMA foreign_keys = ON;

-- SQLite rowid tables do not make a non-integer TEXT PRIMARY KEY implicitly
-- NOT NULL, and SQLite text functions stop at embedded NUL bytes. The alphabet
-- guards in 0020 reject ordinary unsafe characters; these supplemental guards
-- make every Project-owned route identity and operation identity non-null ASCII
-- text as required by shared/project-api.ts.

CREATE TRIGGER projects_require_identifier_bytes_insert
BEFORE INSERT ON projects
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      typeof(NEW.deletion_operation_id) <> 'text'
      OR length(CAST(NEW.deletion_operation_id AS BLOB)) <> length(NEW.deletion_operation_id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER projects_require_identifier_bytes_update
BEFORE UPDATE ON projects
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      typeof(NEW.deletion_operation_id) <> 'text'
      OR length(CAST(NEW.deletion_operation_id AS BLOB)) <> length(NEW.deletion_operation_id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_contents_require_identifier_bytes_insert
BEFORE INSERT ON project_contents
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.project_id) <> 'text'
  OR length(CAST(NEW.project_id AS BLOB)) <> length(NEW.project_id)
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      typeof(NEW.deletion_operation_id) <> 'text'
      OR length(CAST(NEW.deletion_operation_id AS BLOB)) <> length(NEW.deletion_operation_id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project content identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_contents_require_identifier_bytes_update
BEFORE UPDATE ON project_contents
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.project_id) <> 'text'
  OR length(CAST(NEW.project_id AS BLOB)) <> length(NEW.project_id)
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      typeof(NEW.deletion_operation_id) <> 'text'
      OR length(CAST(NEW.deletion_operation_id AS BLOB)) <> length(NEW.deletion_operation_id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project content identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_content_attachments_require_identifier_bytes_insert
BEFORE INSERT ON project_content_attachments
WHEN NEW.project_content_id IS NULL
  OR typeof(NEW.project_content_id) <> 'text'
  OR length(CAST(NEW.project_content_id AS BLOB)) <> length(NEW.project_content_id)
  OR typeof(NEW.creation_operation_id) <> 'text'
  OR length(CAST(NEW.creation_operation_id AS BLOB)) <> length(NEW.creation_operation_id)
BEGIN
  SELECT RAISE(ABORT, 'project attachment identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_items_require_identifier_bytes_insert
BEFORE INSERT ON project_items
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.project_id) <> 'text'
  OR length(CAST(NEW.project_id AS BLOB)) <> length(NEW.project_id)
  OR (
    NEW.project_content_id IS NOT NULL
    AND (
      typeof(NEW.project_content_id) <> 'text'
      OR length(CAST(NEW.project_content_id AS BLOB)) <> length(NEW.project_content_id)
    )
  )
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      typeof(NEW.deletion_operation_id) <> 'text'
      OR length(CAST(NEW.deletion_operation_id AS BLOB)) <> length(NEW.deletion_operation_id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project item identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_items_require_identifier_bytes_update
BEFORE UPDATE ON project_items
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.project_id) <> 'text'
  OR length(CAST(NEW.project_id AS BLOB)) <> length(NEW.project_id)
  OR (
    NEW.project_content_id IS NOT NULL
    AND (
      typeof(NEW.project_content_id) <> 'text'
      OR length(CAST(NEW.project_content_id AS BLOB)) <> length(NEW.project_content_id)
    )
  )
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      typeof(NEW.deletion_operation_id) <> 'text'
      OR length(CAST(NEW.deletion_operation_id AS BLOB)) <> length(NEW.deletion_operation_id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project item identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_map_placements_require_identifier_bytes_insert
BEFORE INSERT ON project_map_placements
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.project_item_id) <> 'text'
  OR length(CAST(NEW.project_item_id AS BLOB)) <> length(NEW.project_item_id)
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
BEGIN
  SELECT RAISE(ABORT, 'project placement identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_map_placements_require_identifier_bytes_update
BEFORE UPDATE ON project_map_placements
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.project_item_id) <> 'text'
  OR length(CAST(NEW.project_item_id AS BLOB)) <> length(NEW.project_item_id)
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
BEGIN
  SELECT RAISE(ABORT, 'project placement identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_edges_require_identifier_bytes_insert
BEFORE INSERT ON project_edges
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.project_id) <> 'text'
  OR length(CAST(NEW.project_id AS BLOB)) <> length(NEW.project_id)
  OR typeof(NEW.source_item_id) <> 'text'
  OR length(CAST(NEW.source_item_id AS BLOB)) <> length(NEW.source_item_id)
  OR typeof(NEW.target_item_id) <> 'text'
  OR length(CAST(NEW.target_item_id AS BLOB)) <> length(NEW.target_item_id)
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      typeof(NEW.deletion_operation_id) <> 'text'
      OR length(CAST(NEW.deletion_operation_id AS BLOB)) <> length(NEW.deletion_operation_id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project edge identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_edges_require_identifier_bytes_update
BEFORE UPDATE ON project_edges
WHEN NEW.id IS NULL
  OR typeof(NEW.id) <> 'text'
  OR length(CAST(NEW.id AS BLOB)) <> length(NEW.id)
  OR typeof(NEW.project_id) <> 'text'
  OR length(CAST(NEW.project_id AS BLOB)) <> length(NEW.project_id)
  OR typeof(NEW.source_item_id) <> 'text'
  OR length(CAST(NEW.source_item_id AS BLOB)) <> length(NEW.source_item_id)
  OR typeof(NEW.target_item_id) <> 'text'
  OR length(CAST(NEW.target_item_id AS BLOB)) <> length(NEW.target_item_id)
  OR typeof(NEW.last_mutation_id) <> 'text'
  OR length(CAST(NEW.last_mutation_id AS BLOB)) <> length(NEW.last_mutation_id)
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      typeof(NEW.deletion_operation_id) <> 'text'
      OR length(CAST(NEW.deletion_operation_id AS BLOB)) <> length(NEW.deletion_operation_id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project edge identifiers and operation IDs must be API-safe');
END;
