PRAGMA foreign_keys = ON;

-- Phase 3A2 removes/restores an item and its owned content in one D1 batch.
-- A zero-row conditional UPDATE does not itself abort a batch, so the final
-- item transition is the database-owned commit guard: it is rejected unless
-- every connected edge and owned-content transition has already succeeded in
-- the same transaction.

-- Persisted Project identities and operation IDs use the same route-safe ASCII
-- alphabet as shared/project-api.ts: an alphanumeric first character followed
-- by at most 255 alphanumeric, dot, underscore, tilde, or hyphen characters.
-- Foreign-key columns are checked as well so import/restore paths cannot create
-- a graph whose stable identities are unreachable through the public API.
CREATE TRIGGER projects_require_api_safe_identifiers_insert
BEFORE INSERT ON projects
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      length(NEW.deletion_operation_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.deletion_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.deletion_operation_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER projects_require_api_safe_identifiers_update
BEFORE UPDATE ON projects
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      length(NEW.deletion_operation_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.deletion_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.deletion_operation_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_contents_require_api_safe_identifiers_insert
BEFORE INSERT ON project_contents
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.project_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      length(NEW.deletion_operation_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.deletion_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.deletion_operation_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project content identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_contents_require_api_safe_identifiers_update
BEFORE UPDATE ON project_contents
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.project_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      length(NEW.deletion_operation_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.deletion_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.deletion_operation_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project content identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_content_attachments_require_api_safe_identifiers_insert
BEFORE INSERT ON project_content_attachments
WHEN length(NEW.project_content_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_content_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_content_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.creation_operation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.creation_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.creation_operation_id GLOB '*[^A-Za-z0-9._~-]*'
BEGIN
  SELECT RAISE(ABORT, 'project attachment identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_items_require_api_safe_identifiers_insert
BEFORE INSERT ON project_items
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.project_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.project_content_id IS NOT NULL
    AND (
      length(NEW.project_content_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.project_content_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.project_content_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      length(NEW.deletion_operation_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.deletion_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.deletion_operation_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project item identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_items_require_api_safe_identifiers_update
BEFORE UPDATE ON project_items
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.project_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.project_content_id IS NOT NULL
    AND (
      length(NEW.project_content_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.project_content_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.project_content_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      length(NEW.deletion_operation_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.deletion_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.deletion_operation_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project item identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_map_placements_require_api_safe_identifiers_insert
BEFORE INSERT ON project_map_placements
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.project_item_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_item_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_item_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
BEGIN
  SELECT RAISE(ABORT, 'project placement identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_map_placements_require_api_safe_identifiers_update
BEFORE UPDATE ON project_map_placements
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.project_item_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_item_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_item_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
BEGIN
  SELECT RAISE(ABORT, 'project placement identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_edges_require_api_safe_identifiers_insert
BEFORE INSERT ON project_edges
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.project_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.source_item_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.source_item_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.source_item_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.target_item_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.target_item_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.target_item_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      length(NEW.deletion_operation_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.deletion_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.deletion_operation_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project edge identifiers and operation IDs must be API-safe');
END;

CREATE TRIGGER project_edges_require_api_safe_identifiers_update
BEFORE UPDATE ON project_edges
WHEN length(NEW.id) NOT BETWEEN 1 AND 256
  OR substr(NEW.id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.project_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.project_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.project_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.source_item_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.source_item_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.source_item_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.target_item_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.target_item_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.target_item_id GLOB '*[^A-Za-z0-9._~-]*'
  OR length(NEW.last_mutation_id) NOT BETWEEN 1 AND 256
  OR substr(NEW.last_mutation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR NEW.last_mutation_id GLOB '*[^A-Za-z0-9._~-]*'
  OR (
    NEW.deletion_operation_id IS NOT NULL
    AND (
      length(NEW.deletion_operation_id) NOT BETWEEN 1 AND 256
      OR substr(NEW.deletion_operation_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
      OR NEW.deletion_operation_id GLOB '*[^A-Za-z0-9._~-]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project edge identifiers and operation IDs must be API-safe');
END;

-- The TypeScript request guard performs full URL parsing. SQLite independently
-- owns the persistence-level ceiling and scheme boundary so direct SQL,
-- restore, or import paths cannot bypass them.
CREATE TRIGGER project_contents_require_bounded_payload_insert
BEFORE INSERT ON project_contents
BEGIN
  SELECT RAISE(ABORT, 'project Markdown exceeds maximum length')
  WHERE NEW.markdown_source IS NOT NULL AND length(NEW.markdown_source) > 200000;
  SELECT RAISE(ABORT, 'project attachment source URL must use http or https')
  WHERE NEW.attachment_source_url IS NOT NULL
    AND (
      NEW.attachment_source_url <> trim(NEW.attachment_source_url)
      OR NOT (
        lower(NEW.attachment_source_url) GLOB 'http://?*'
        OR lower(NEW.attachment_source_url) GLOB 'https://?*'
      )
    );
END;

CREATE TRIGGER project_contents_require_bounded_payload_update
BEFORE UPDATE ON project_contents
BEGIN
  SELECT RAISE(ABORT, 'project Markdown exceeds maximum length')
  WHERE NEW.markdown_source IS NOT NULL AND length(NEW.markdown_source) > 200000;
  SELECT RAISE(ABORT, 'project attachment source URL must use http or https')
  WHERE NEW.attachment_source_url IS NOT NULL
    AND (
      NEW.attachment_source_url <> trim(NEW.attachment_source_url)
      OR NOT (
        lower(NEW.attachment_source_url) GLOB 'http://?*'
        OR lower(NEW.attachment_source_url) GLOB 'https://?*'
      )
    );
END;

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

-- The service reads attachment metadata before constructing its D1 batch. Recheck
-- the authoritative record during INSERT so a concurrent or bypassing caller
-- cannot bind stale or client-invented intrinsic file metadata.
CREATE TRIGGER project_content_attachments_require_authoritative_metadata
BEFORE INSERT ON project_content_attachments
WHEN (
  NEW.asset_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM assets a
    WHERE a.id = NEW.asset_id
      AND a.original_name = NEW.original_name
      AND a.mime_type = NEW.mime_type
      AND a.byte_size = NEW.byte_size
  )
) OR (
  NEW.storage_object_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM managed_storage_objects mso
    WHERE mso.id = NEW.storage_object_id
      AND mso.original_name = NEW.original_name
      AND mso.mime_type = NEW.mime_type
      AND mso.byte_size = NEW.byte_size
  )
)
BEGIN
  SELECT RAISE(ABORT, 'project attachment metadata must match its blob record');
END;

-- Endpoint capacity belongs to the authoritative item-removal transaction,
-- not to the independent edge lifecycle. removeProjectItem() therefore guards
-- its connected-edge update with the endpoint item/content capacity it needs,
-- while direct edge deletion remains owned only by project_edges.revision.

-- Owned content must not cross a lifecycle boundary when its owning occurrence
-- cannot advance in the same transaction.
CREATE TRIGGER project_contents_require_owner_delete_capacity
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

CREATE TRIGGER project_contents_require_owner_restore_capacity
BEFORE UPDATE OF deleted_at ON project_contents
WHEN OLD.deleted_at IS NOT NULL
  AND NEW.deleted_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM project_items pi
    WHERE pi.project_content_id = OLD.id
      AND pi.project_id = OLD.project_id
      AND pi.deleted_at IS NOT NULL
      AND pi.revision >= 9007199254740991
  )
BEGIN
  SELECT RAISE(ABORT, 'project content restore requires owner lifecycle capacity');
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
