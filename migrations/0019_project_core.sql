PRAGMA foreign_keys = ON;

-- Phase 3A1 installs the normalized Project persistence kernel. Runtime write
-- routes remain intentionally disabled until the Phase 3A2 authoritative
-- mutation service is ready. The schema nevertheless owns identity, lifecycle,
-- optimistic revision, ordering, blob-retention, and graph-shape invariants.

CREATE TABLE projects (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  next_created_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_created_sequence >= 1),
  last_mutation_id TEXT NOT NULL CHECK (length(last_mutation_id) BETWEEN 1 AND 256),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 320),
  updated_by TEXT NOT NULL CHECK (length(trim(updated_by)) BETWEEN 1 AND 320),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  deleted_at TEXT,
  deleted_by TEXT,
  deletion_operation_id TEXT,
  CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL AND deletion_operation_id IS NULL)
    OR (
      deleted_at IS NOT NULL
      AND length(deleted_at) > 0
      AND deleted_by IS NOT NULL
      AND length(trim(deleted_by)) BETWEEN 1 AND 320
      AND deletion_operation_id IS NOT NULL
      AND length(deletion_operation_id) BETWEEN 1 AND 256
    )
  )
);

CREATE TABLE project_contents (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  content_type TEXT NOT NULL CHECK (content_type IN ('markdown', 'attachment')),
  markdown_source TEXT,
  format_version INTEGER NOT NULL DEFAULT 1 CHECK (format_version >= 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_mutation_id TEXT NOT NULL CHECK (length(last_mutation_id) BETWEEN 1 AND 256),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 320),
  updated_by TEXT NOT NULL CHECK (length(trim(updated_by)) BETWEEN 1 AND 320),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  deleted_at TEXT,
  deleted_by TEXT,
  deletion_operation_id TEXT,
  CHECK (
    (content_type = 'markdown' AND markdown_source IS NOT NULL)
    OR (content_type = 'attachment' AND markdown_source IS NULL)
  ),
  CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL AND deletion_operation_id IS NULL)
    OR (
      deleted_at IS NOT NULL
      AND length(deleted_at) > 0
      AND deleted_by IS NOT NULL
      AND length(trim(deleted_by)) BETWEEN 1 AND 320
      AND deletion_operation_id IS NOT NULL
      AND length(deletion_operation_id) BETWEEN 1 AND 256
    )
  )
);

-- Attachment metadata is a one-to-one subtype of project_contents. The content
-- ID is the stable attachment identity; no second occurrence ID is introduced.
CREATE TABLE project_content_attachments (
  project_content_id TEXT PRIMARY KEY
    REFERENCES project_contents(id) ON DELETE RESTRICT,
  asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  storage_object_id TEXT REFERENCES managed_storage_objects(id) ON DELETE RESTRICT,
  original_name TEXT NOT NULL CHECK (length(trim(original_name)) BETWEEN 1 AND 255),
  mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) BETWEEN 1 AND 200),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 320),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  creation_operation_id TEXT NOT NULL CHECK (length(creation_operation_id) BETWEEN 1 AND 256),
  CHECK ((asset_id IS NOT NULL) <> (storage_object_id IS NOT NULL))
);

CREATE TABLE project_items (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  item_type TEXT NOT NULL CHECK (item_type IN ('content', 'reference')),
  project_content_id TEXT UNIQUE REFERENCES project_contents(id) ON DELETE RESTRICT,
  reference_target_id TEXT REFERENCES reference_targets(id) ON DELETE RESTRICT,
  created_sequence INTEGER NOT NULL CHECK (created_sequence >= 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_mutation_id TEXT NOT NULL CHECK (length(last_mutation_id) BETWEEN 1 AND 256),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 320),
  updated_by TEXT NOT NULL CHECK (length(trim(updated_by)) BETWEEN 1 AND 320),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  deleted_at TEXT,
  deleted_by TEXT,
  deletion_operation_id TEXT,
  CHECK (
    (item_type = 'content' AND project_content_id IS NOT NULL AND reference_target_id IS NULL)
    OR (item_type = 'reference' AND project_content_id IS NULL AND reference_target_id IS NOT NULL)
  ),
  CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL AND deletion_operation_id IS NULL)
    OR (
      deleted_at IS NOT NULL
      AND length(deleted_at) > 0
      AND deleted_by IS NOT NULL
      AND length(trim(deleted_by)) BETWEEN 1 AND 320
      AND deletion_operation_id IS NOT NULL
      AND length(deletion_operation_id) BETWEEN 1 AND 256
    )
  ),
  UNIQUE(project_id, created_sequence)
);

CREATE TABLE project_map_placements (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  project_item_id TEXT NOT NULL UNIQUE REFERENCES project_items(id) ON DELETE RESTRICT,
  x REAL NOT NULL CHECK (typeof(x) IN ('integer', 'real')),
  y REAL NOT NULL CHECK (typeof(y) IN ('integer', 'real')),
  width REAL NOT NULL CHECK (typeof(width) IN ('integer', 'real') AND width > 0),
  height REAL NOT NULL CHECK (typeof(height) IN ('integer', 'real') AND height > 0),
  z_index INTEGER NOT NULL DEFAULT 0 CHECK (typeof(z_index) = 'integer'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_mutation_id TEXT NOT NULL CHECK (length(last_mutation_id) BETWEEN 1 AND 256),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 320),
  updated_by TEXT NOT NULL CHECK (length(trim(updated_by)) BETWEEN 1 AND 320),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0)
);

CREATE TABLE project_edges (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_item_id TEXT NOT NULL REFERENCES project_items(id) ON DELETE RESTRICT,
  target_item_id TEXT NOT NULL REFERENCES project_items(id) ON DELETE RESTRICT,
  source_handle TEXT NOT NULL CHECK (source_handle IN ('top', 'right', 'bottom', 'left')),
  target_handle TEXT NOT NULL CHECK (target_handle IN ('top', 'right', 'bottom', 'left')),
  marker_start TEXT NOT NULL DEFAULT 'none' CHECK (marker_start IN ('none', 'arrow')),
  marker_end TEXT NOT NULL DEFAULT 'none' CHECK (marker_end IN ('none', 'arrow')),
  label TEXT CHECK (label IS NULL OR length(label) <= 200),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_mutation_id TEXT NOT NULL CHECK (length(last_mutation_id) BETWEEN 1 AND 256),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) BETWEEN 1 AND 320),
  updated_by TEXT NOT NULL CHECK (length(trim(updated_by)) BETWEEN 1 AND 320),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  deleted_at TEXT,
  deleted_by TEXT,
  deletion_operation_id TEXT,
  CHECK (source_item_id <> target_item_id),
  CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL AND deletion_operation_id IS NULL)
    OR (
      deleted_at IS NOT NULL
      AND length(deleted_at) > 0
      AND deleted_by IS NOT NULL
      AND length(trim(deleted_by)) BETWEEN 1 AND 320
      AND deletion_operation_id IS NOT NULL
      AND length(deletion_operation_id) BETWEEN 1 AND 256
    )
  )
);

CREATE INDEX projects_visible_updated_idx
ON projects(deleted_at, updated_at DESC, id);

CREATE INDEX project_contents_project_visible_idx
ON project_contents(project_id, deleted_at, created_at, id);

CREATE INDEX project_content_attachments_asset_idx
ON project_content_attachments(asset_id)
WHERE asset_id IS NOT NULL;

CREATE INDEX project_content_attachments_storage_idx
ON project_content_attachments(storage_object_id)
WHERE storage_object_id IS NOT NULL;

CREATE INDEX project_items_project_reading_idx
ON project_items(project_id, created_sequence, id)
WHERE deleted_at IS NULL;

CREATE INDEX project_items_reference_backlink_idx
ON project_items(reference_target_id, project_id, id)
WHERE reference_target_id IS NOT NULL;

CREATE INDEX project_edges_project_visible_idx
ON project_edges(project_id, deleted_at, created_at, id);

CREATE INDEX project_edges_source_visible_idx
ON project_edges(source_item_id, deleted_at, id);

CREATE INDEX project_edges_target_visible_idx
ON project_edges(target_item_id, deleted_at, id);

CREATE UNIQUE INDEX project_edges_active_identity_idx
ON project_edges(
  project_id,
  source_item_id,
  target_item_id,
  source_handle,
  target_handle,
  marker_start,
  marker_end,
  COALESCE(label, '')
)
WHERE deleted_at IS NULL;

-- Stable identities and creation metadata cannot be retargeted in place.
CREATE TRIGGER projects_reject_identity_update
BEFORE UPDATE ON projects
WHEN OLD.id IS NOT NEW.id
  OR OLD.created_by IS NOT NEW.created_by
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'project identity is immutable');
END;

CREATE TRIGGER project_contents_reject_identity_update
BEFORE UPDATE ON project_contents
WHEN OLD.id IS NOT NEW.id
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.content_type IS NOT NEW.content_type
  OR OLD.created_by IS NOT NEW.created_by
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'project content identity is immutable');
END;

CREATE TRIGGER project_content_attachments_reject_update
BEFORE UPDATE ON project_content_attachments
BEGIN
  SELECT RAISE(ABORT, 'project attachment identity is immutable');
END;

CREATE TRIGGER project_items_reject_identity_update
BEFORE UPDATE ON project_items
WHEN OLD.id IS NOT NEW.id
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.item_type IS NOT NEW.item_type
  OR OLD.project_content_id IS NOT NEW.project_content_id
  OR OLD.reference_target_id IS NOT NEW.reference_target_id
  OR OLD.created_sequence IS NOT NEW.created_sequence
  OR OLD.created_by IS NOT NEW.created_by
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'project item identity is immutable');
END;

CREATE TRIGGER project_map_placements_reject_identity_update
BEFORE UPDATE ON project_map_placements
WHEN OLD.id IS NOT NEW.id
  OR OLD.project_item_id IS NOT NEW.project_item_id
  OR OLD.created_by IS NOT NEW.created_by
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'project placement identity is immutable');
END;

CREATE TRIGGER project_edges_reject_identity_update
BEFORE UPDATE ON project_edges
WHEN OLD.id IS NOT NEW.id
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.source_item_id IS NOT NEW.source_item_id
  OR OLD.target_item_id IS NOT NEW.target_item_id
  OR OLD.source_handle IS NOT NEW.source_handle
  OR OLD.target_handle IS NOT NEW.target_handle
  OR OLD.created_by IS NOT NEW.created_by
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'project edge identity is immutable');
END;

-- Every semantic update advances exactly one row revision and carries a fresh
-- idempotency key. Phase 3A2 will enforce the corresponding expectedRevision
-- comparison at the authoritative service boundary.
CREATE TRIGGER projects_require_revisioned_update
BEFORE UPDATE ON projects
WHEN OLD.title IS NOT NEW.title
  OR OLD.next_created_sequence IS NOT NEW.next_created_sequence
  OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.deleted_by IS NOT NEW.deleted_by
  OR OLD.deletion_operation_id IS NOT NEW.deletion_operation_id
BEGIN
  SELECT RAISE(ABORT, 'project update requires the next revision')
  WHERE NEW.revision <> OLD.revision + 1;
  SELECT RAISE(ABORT, 'project update requires a fresh mutation id')
  WHERE NEW.last_mutation_id IS OLD.last_mutation_id;
  SELECT RAISE(ABORT, 'project sequence cannot move backwards')
  WHERE NEW.next_created_sequence < OLD.next_created_sequence;
END;

CREATE TRIGGER project_contents_require_revisioned_update
BEFORE UPDATE ON project_contents
WHEN OLD.markdown_source IS NOT NEW.markdown_source
  OR OLD.format_version IS NOT NEW.format_version
  OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.deleted_by IS NOT NEW.deleted_by
  OR OLD.deletion_operation_id IS NOT NEW.deletion_operation_id
BEGIN
  SELECT RAISE(ABORT, 'project content update requires the next revision')
  WHERE NEW.revision <> OLD.revision + 1;
  SELECT RAISE(ABORT, 'project content update requires a fresh mutation id')
  WHERE NEW.last_mutation_id IS OLD.last_mutation_id;
END;

CREATE TRIGGER project_items_require_revisioned_update
BEFORE UPDATE ON project_items
WHEN OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.deleted_by IS NOT NEW.deleted_by
  OR OLD.deletion_operation_id IS NOT NEW.deletion_operation_id
BEGIN
  SELECT RAISE(ABORT, 'project item update requires the next revision')
  WHERE NEW.revision <> OLD.revision + 1;
  SELECT RAISE(ABORT, 'project item update requires a fresh mutation id')
  WHERE NEW.last_mutation_id IS OLD.last_mutation_id;
END;

CREATE TRIGGER project_map_placements_require_revisioned_update
BEFORE UPDATE ON project_map_placements
WHEN OLD.x IS NOT NEW.x
  OR OLD.y IS NOT NEW.y
  OR OLD.width IS NOT NEW.width
  OR OLD.height IS NOT NEW.height
  OR OLD.z_index IS NOT NEW.z_index
BEGIN
  SELECT RAISE(ABORT, 'project placement update requires the next revision')
  WHERE NEW.revision <> OLD.revision + 1;
  SELECT RAISE(ABORT, 'project placement update requires a fresh mutation id')
  WHERE NEW.last_mutation_id IS OLD.last_mutation_id;
END;

CREATE TRIGGER project_edges_require_revisioned_update
BEFORE UPDATE ON project_edges
WHEN OLD.marker_start IS NOT NEW.marker_start
  OR OLD.marker_end IS NOT NEW.marker_end
  OR OLD.label IS NOT NEW.label
  OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.deleted_by IS NOT NEW.deleted_by
  OR OLD.deletion_operation_id IS NOT NEW.deletion_operation_id
BEGIN
  SELECT RAISE(ABORT, 'project edge update requires the next revision')
  WHERE NEW.revision <> OLD.revision + 1;
  SELECT RAISE(ABORT, 'project edge update requires a fresh mutation id')
  WHERE NEW.last_mutation_id IS OLD.last_mutation_id;
END;

-- Cross-table ownership and lifecycle checks prevent malformed graph rows even
-- if a future caller bypasses the TypeScript validators.
CREATE TRIGGER project_contents_require_active_project
BEFORE INSERT ON project_contents
WHEN NOT EXISTS (
  SELECT 1 FROM projects p
  WHERE p.id = NEW.project_id AND p.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'project content requires an active project');
END;

CREATE TRIGGER project_content_attachments_validate_insert
BEFORE INSERT ON project_content_attachments
BEGIN
  SELECT RAISE(ABORT, 'project attachment requires active attachment content')
  WHERE NOT EXISTS (
    SELECT 1 FROM project_contents pc
    JOIN projects p ON p.id = pc.project_id
    WHERE pc.id = NEW.project_content_id
      AND pc.content_type = 'attachment'
      AND pc.deleted_at IS NULL
      AND p.deleted_at IS NULL
  );
  SELECT RAISE(ABORT, 'project attachment asset is not ready')
  WHERE NEW.asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM assets a
    WHERE a.id = NEW.asset_id AND a.status = 'ready'
  );
  SELECT RAISE(ABORT, 'project attachment managed object is not ready')
  WHERE NEW.storage_object_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM managed_storage_objects mso
    WHERE mso.id = NEW.storage_object_id AND mso.status IN ('ready', 'orphaned')
  );
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM managed_storage_objects mso JOIN blob_gc_ledger bg
      ON bg.store_kind = 'managed' AND bg.provider = mso.provider
        AND bg.object_key = mso.object_key
    WHERE mso.id = NEW.storage_object_id AND bg.state IN ('deleting', 'deleted')
  );
  UPDATE managed_storage_objects
  SET status = 'ready', orphaned_at = NULL
  WHERE id = NEW.storage_object_id AND status = 'orphaned';
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'managed' AND state = 'orphaned'
    AND (provider, object_key) = (
      SELECT provider, object_key FROM managed_storage_objects
      WHERE id = NEW.storage_object_id
    );
END;

CREATE TRIGGER project_items_validate_insert
BEFORE INSERT ON project_items
BEGIN
  SELECT RAISE(ABORT, 'project item requires an active project')
  WHERE NOT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = NEW.project_id AND p.deleted_at IS NULL
  );
  SELECT RAISE(ABORT, 'project content belongs to another project or is unavailable')
  WHERE NEW.item_type = 'content' AND NOT EXISTS (
    SELECT 1 FROM project_contents pc
    WHERE pc.id = NEW.project_content_id
      AND pc.project_id = NEW.project_id
      AND pc.deleted_at IS NULL
  );
  SELECT RAISE(ABORT, 'reference target is unavailable')
  WHERE NEW.item_type = 'reference' AND NOT EXISTS (
    SELECT 1 FROM reference_targets rt
    WHERE rt.id = NEW.reference_target_id AND rt.tombstoned_at IS NULL
  );
END;

CREATE TRIGGER project_map_placements_validate_insert
BEFORE INSERT ON project_map_placements
WHEN NOT EXISTS (
  SELECT 1 FROM project_items pi
  JOIN projects p ON p.id = pi.project_id
  WHERE pi.id = NEW.project_item_id
    AND pi.deleted_at IS NULL
    AND p.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'project placement requires an active item');
END;

CREATE TRIGGER project_map_placements_validate_update
BEFORE UPDATE ON project_map_placements
WHEN NOT EXISTS (
  SELECT 1 FROM project_items pi
  JOIN projects p ON p.id = pi.project_id
  WHERE pi.id = NEW.project_item_id
    AND pi.deleted_at IS NULL
    AND p.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'project placement requires an active item');
END;

CREATE TRIGGER project_edges_validate_insert
BEFORE INSERT ON project_edges
BEGIN
  SELECT RAISE(ABORT, 'project edge requires an active project')
  WHERE NOT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = NEW.project_id AND p.deleted_at IS NULL
  );
  SELECT RAISE(ABORT, 'project edge endpoints must be active items in the same project')
  WHERE NOT EXISTS (
    SELECT 1
    FROM project_items source
    JOIN project_items target
      ON target.id = NEW.target_item_id
    WHERE source.id = NEW.source_item_id
      AND source.project_id = NEW.project_id
      AND target.project_id = NEW.project_id
      AND source.deleted_at IS NULL
      AND target.deleted_at IS NULL
  );
END;

CREATE TRIGGER project_edges_validate_update
BEFORE UPDATE ON project_edges
WHEN NOT EXISTS (
  SELECT 1
  FROM projects p
  JOIN project_items source ON source.id = NEW.source_item_id
  JOIN project_items target ON target.id = NEW.target_item_id
  WHERE p.id = NEW.project_id
    AND p.deleted_at IS NULL
    AND source.project_id = NEW.project_id
    AND target.project_id = NEW.project_id
    AND source.deleted_at IS NULL
    AND target.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'project edge endpoints must remain active items in the same project');
END;

-- Stable Project records are recoverable. Permanent deletion remains disabled
-- until the privileged planner can coordinate references, blob blockers, and
-- tombstones across the whole graph.
CREATE TRIGGER projects_reject_physical_delete
BEFORE DELETE ON projects
BEGIN
  SELECT RAISE(ABORT, 'project physical deletion is disabled');
END;

CREATE TRIGGER project_contents_reject_physical_delete
BEFORE DELETE ON project_contents
BEGIN
  SELECT RAISE(ABORT, 'project content physical deletion is disabled');
END;

CREATE TRIGGER project_content_attachments_reject_physical_delete
BEFORE DELETE ON project_content_attachments
BEGIN
  SELECT RAISE(ABORT, 'project attachment physical deletion is disabled');
END;

CREATE TRIGGER project_items_reject_physical_delete
BEFORE DELETE ON project_items
BEGIN
  SELECT RAISE(ABORT, 'project item physical deletion is disabled');
END;

CREATE TRIGGER project_map_placements_reject_physical_delete
BEFORE DELETE ON project_map_placements
BEGIN
  SELECT RAISE(ABORT, 'project placement physical deletion is disabled');
END;

CREATE TRIGGER project_edges_reject_physical_delete
BEFORE DELETE ON project_edges
BEGIN
  SELECT RAISE(ABORT, 'project edge physical deletion is disabled');
END;

-- Project attachments are ordinary blob-retention edges. Keep the existing
-- public view stable and stay below workerd's five-term compound-select limit.
DROP VIEW blob_retention_edges;

CREATE VIEW blob_retention_edges_project_attachments AS
SELECT
  'r2' AS store_kind,
  'r2' AS provider,
  a.r2_key AS object_key,
  a.id AS blob_record_id,
  'project_content' AS source_type,
  pca.project_content_id AS source_id,
  'project_content_attachment' AS occurrence_type,
  pca.project_content_id AS occurrence_id,
  'project_attachment' AS retention_reason,
  NULL AS retain_until
FROM project_content_attachments pca
JOIN assets a ON a.id = pca.asset_id

UNION ALL
SELECT
  'managed', mso.provider, mso.object_key, mso.id,
  'project_content', pca.project_content_id,
  'project_content_attachment', pca.project_content_id,
  'project_attachment', NULL
FROM project_content_attachments pca
JOIN managed_storage_objects mso ON mso.id = pca.storage_object_id;

CREATE VIEW blob_retention_edges AS
SELECT * FROM blob_retention_edges_r2_occurrences
UNION ALL
SELECT * FROM blob_retention_edges_comment_items
UNION ALL
SELECT * FROM blob_retention_edges_direct_keys
UNION ALL
SELECT * FROM blob_retention_edges_project_attachments;
