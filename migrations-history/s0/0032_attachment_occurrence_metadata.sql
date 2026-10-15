PRAGMA foreign_keys = ON;

-- Slice C separates contextual attachment presentation from physical blob
-- registration provenance. Physical assets keep their historical original_name,
-- mime_type, byte_size, hash, locator, and integrity state. Direct Run-step
-- occurrences gain their own presentation metadata, while byte size remains an
-- invariant of the referenced immutable byte sequence.
ALTER TABLE run_step_assets ADD COLUMN filename TEXT;
ALTER TABLE run_step_assets ADD COLUMN mime_type TEXT;
ALTER TABLE run_step_assets ADD COLUMN byte_size INTEGER;

-- Existing occurrences predate contextual metadata. Preserve their exact IDs and
-- initialize presentation from the registration provenance that was previously
-- the only available source.
UPDATE run_step_assets
SET filename = (
      SELECT a.original_name FROM assets a WHERE a.id = run_step_assets.asset_id
    ),
    mime_type = (
      SELECT a.mime_type FROM assets a WHERE a.id = run_step_assets.asset_id
    ),
    byte_size = (
      SELECT a.byte_size FROM assets a WHERE a.id = run_step_assets.asset_id
    );

-- Migration 0028 made superseded Run occurrences immutable before Slice C
-- added filename/MIME/size. Rebuild both guards so schema evolution cannot
-- create mutable fields on an audit tombstone.
DROP TRIGGER run_step_assets_guard_supersession_create;
DROP TRIGGER run_step_assets_lock_superseded_occurrence;

CREATE TRIGGER run_step_assets_guard_supersession_create
BEFORE UPDATE OF
  superseded_by_occurrence_id,
  superseded_at,
  superseded_by,
  supersession_operation_id
ON run_step_assets
WHEN OLD.superseded_by_occurrence_id IS NULL
  AND (
    NEW.superseded_by_occurrence_id IS NOT NULL
    OR NEW.superseded_at IS NOT NULL
    OR NEW.superseded_by IS NOT NULL
    OR NEW.supersession_operation_id IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid run step asset supersession')
  WHERE NEW.superseded_by_occurrence_id IS NULL
    OR NEW.superseded_at IS NULL
    OR length(NEW.superseded_at) = 0
    OR NEW.superseded_by IS NOT 'system:fabublox-import-recovery'
    OR NEW.supersession_operation_id IS NULL
    OR length(NEW.supersession_operation_id) = 0
    OR NEW.deleted_at IS NULL
    OR NEW.deleted_by IS NULL
    OR NEW.id IS NOT OLD.id
    OR NEW.run_step_id IS NOT OLD.run_step_id
    OR NEW.asset_id IS NOT OLD.asset_id
    OR NEW.role IS NOT OLD.role
    OR NEW.position IS NOT OLD.position
    OR NEW.actor_email IS NOT OLD.actor_email
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.filename IS NOT OLD.filename
    OR NEW.mime_type IS NOT OLD.mime_type
    OR NEW.byte_size IS NOT OLD.byte_size
    OR NEW.last_mutation_id IS NOT NEW.supersession_operation_id
    OR NOT EXISTS (
      SELECT 1
      FROM assets legacy
      JOIN imports failed_owner ON failed_owner.id = legacy.import_id
      JOIN run_step_assets successor
        ON successor.id = NEW.superseded_by_occurrence_id
      JOIN assets canonical ON canonical.id = successor.asset_id
      LEFT JOIN imports canonical_owner ON canonical_owner.id = canonical.import_id
      WHERE legacy.id = OLD.asset_id
        AND failed_owner.status = 'failed'
        AND failed_owner.recovery_operation_id =
            NEW.supersession_operation_id
        AND legacy.sha256 IS NOT NULL
        AND successor.id <> OLD.id
        AND successor.run_step_id = OLD.run_step_id
        AND successor.role IS OLD.role
        AND successor.superseded_by_occurrence_id IS NULL
        AND canonical.sha256 = legacy.sha256
        AND canonical.byte_size = legacy.byte_size
        AND canonical.status = 'ready'
        AND (
          canonical.import_id IS NULL
          OR canonical_owner.status = 'ready'
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = canonical.r2_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = canonical.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
    );
END;

CREATE TRIGGER run_step_assets_lock_superseded_occurrence
BEFORE UPDATE ON run_step_assets
WHEN OLD.superseded_by_occurrence_id IS NOT NULL
  AND (
    NEW.id IS NOT OLD.id
    OR NEW.run_step_id IS NOT OLD.run_step_id
    OR NEW.asset_id IS NOT OLD.asset_id
    OR NEW.role IS NOT OLD.role
    OR NEW.position IS NOT OLD.position
    OR NEW.actor_email IS NOT OLD.actor_email
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.filename IS NOT OLD.filename
    OR NEW.mime_type IS NOT OLD.mime_type
    OR NEW.byte_size IS NOT OLD.byte_size
    OR NEW.deleted_at IS NOT OLD.deleted_at
    OR NEW.deleted_by IS NOT OLD.deleted_by
    OR NEW.last_mutation_id IS NOT OLD.last_mutation_id
    OR NEW.superseded_by_occurrence_id
       IS NOT OLD.superseded_by_occurrence_id
    OR NEW.superseded_at IS NOT OLD.superseded_at
    OR NEW.superseded_by IS NOT OLD.superseded_by
    OR NEW.supersession_operation_id
       IS NOT OLD.supersession_operation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'superseded run step asset occurrence is immutable');
END;

-- Legacy/internal writers may omit presentation metadata during the transition.
-- Fill only missing fields from physical registration provenance. New domain
-- writers can supply a different contextual filename or MIME while keeping the
-- same immutable bytes.
CREATE TRIGGER run_step_assets_fill_occurrence_metadata
AFTER INSERT ON run_step_assets
WHEN NEW.filename IS NULL OR NEW.mime_type IS NULL OR NEW.byte_size IS NULL
BEGIN
  UPDATE run_step_assets
  SET filename = COALESCE(
        NEW.filename,
        (SELECT a.original_name FROM assets a WHERE a.id = NEW.asset_id)
      ),
      mime_type = COALESCE(
        NEW.mime_type,
        (SELECT a.mime_type FROM assets a WHERE a.id = NEW.asset_id)
      ),
      byte_size = COALESCE(
        NEW.byte_size,
        (SELECT a.byte_size FROM assets a WHERE a.id = NEW.asset_id)
      )
  WHERE id = NEW.id;
END;

CREATE TRIGGER run_step_assets_occurrence_metadata_insert_guard
BEFORE INSERT ON run_step_assets
BEGIN
  SELECT RAISE(ABORT, 'run step attachment filename is invalid')
  WHERE NEW.filename IS NOT NULL AND (
    length(trim(NEW.filename)) NOT BETWEEN 1 AND 255
    OR instr(NEW.filename, char(0)) > 0
  );
  SELECT RAISE(ABORT, 'run step attachment MIME type is invalid')
  WHERE NEW.mime_type IS NOT NULL AND (
    length(NEW.mime_type) NOT BETWEEN 3 AND 200
    OR trim(NEW.mime_type) <> NEW.mime_type
    OR instr(NEW.mime_type, char(0)) > 0
    OR NEW.mime_type GLOB '*[^ -~]*'
    OR instr(
      trim(CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END),
      '/'
    ) <= 1
    OR instr(
      trim(CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END),
      '/'
    ) >= length(trim(CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END))
    OR instr(
      substr(
        trim(CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END),
        instr(trim(CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END), '/') + 1
      ),
      '/'
    ) > 0
    OR trim(CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END) GLOB '*[^A-Za-z0-9!#$%&''*+.^_`|~/-]*'
  );
  SELECT RAISE(ABORT, 'run step attachment byte size does not match blob')
  WHERE NEW.byte_size IS NOT NULL AND (
    typeof(NEW.byte_size) <> 'integer'
    OR NEW.byte_size < 0
    OR NEW.byte_size > 9007199254740991
    OR NEW.byte_size <> COALESCE(
      (SELECT a.byte_size FROM assets a WHERE a.id = NEW.asset_id),
      -1
    )
  );
END;

-- This guard is deliberately scoped to occurrence-presentation updates. Existing
-- blob-integrity triggers remain authoritative for asset_id rebinding, including
-- quarantine/deleting/deleted rejection and their established error precedence.
CREATE TRIGGER run_step_assets_occurrence_metadata_update_guard
BEFORE UPDATE OF filename, mime_type, byte_size ON run_step_assets
BEGIN
  SELECT RAISE(ABORT, 'run step attachment filename is invalid')
  WHERE NEW.filename IS NULL
    OR length(trim(NEW.filename)) NOT BETWEEN 1 AND 255
    OR instr(NEW.filename, char(0)) > 0;
  SELECT RAISE(ABORT, 'run step attachment MIME type is invalid')
  WHERE NEW.mime_type IS NULL
    OR length(NEW.mime_type) NOT BETWEEN 3 AND 200
    OR trim(NEW.mime_type) <> NEW.mime_type
    OR instr(NEW.mime_type, char(0)) > 0
    OR NEW.mime_type GLOB '*[^ -~]*'
    OR instr(
      trim(CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END),
      '/'
    ) <= 1
    OR instr(
      trim(CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END),
      '/'
    ) >= length(trim(CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END))
    OR instr(
      substr(
        trim(CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END),
        instr(trim(CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END), '/') + 1
      ),
      '/'
    ) > 0
    OR trim(CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END) GLOB '*[^A-Za-z0-9!#$%&''*+.^_`|~/-]*';
  SELECT RAISE(ABORT, 'run step attachment byte size does not match blob')
  WHERE NEW.byte_size IS NULL
    OR typeof(NEW.byte_size) <> 'integer'
    OR NEW.byte_size < 0
    OR NEW.byte_size > 9007199254740991
    OR NEW.byte_size <> COALESCE(
      (SELECT a.byte_size FROM assets a WHERE a.id = NEW.asset_id),
      -1
    );
END;

-- asset_id rebinding is still owned by the earlier blob-integrity guards. Once
-- those BEFORE triggers accept a new live locator, synchronize only the physical
-- size fact to the new immutable bytes; contextual filename/MIME intentionally
-- remain occurrence-owned presentation.
CREATE TRIGGER run_step_assets_sync_byte_size_after_asset_rebind
AFTER UPDATE OF asset_id ON run_step_assets
WHEN OLD.asset_id <> NEW.asset_id
BEGIN
  UPDATE run_step_assets
  SET byte_size = (
    SELECT a.byte_size FROM assets a WHERE a.id = NEW.asset_id
  )
  WHERE id = NEW.id;
END;

-- Phase 3A2 intentionally treated filename/MIME/size as intrinsic physical
-- metadata. Slice C supersedes that model: Project attachment occurrences own
-- contextual filename/MIME, while the immutable byte size must still match the
-- referenced physical blob. Locator availability/integrity guards from earlier
-- migrations remain unchanged.
DROP TRIGGER project_content_attachments_require_authoritative_metadata;

CREATE TRIGGER project_attachment_occurrence_mime_insert_guard
BEFORE INSERT ON project_content_attachments
BEGIN
  SELECT RAISE(ABORT, 'project attachment MIME type is invalid')
  WHERE NEW.mime_type IS NULL
    OR length(NEW.mime_type) NOT BETWEEN 3 AND 200
    OR trim(NEW.mime_type) <> NEW.mime_type
    OR instr(NEW.mime_type, char(0)) > 0
    OR NEW.mime_type GLOB '*[^ -~]*'
    OR instr(
      trim(CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END),
      '/'
    ) <= 1
    OR instr(
      trim(CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END),
      '/'
    ) >= length(trim(CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END))
    OR instr(
      substr(
        trim(CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END),
        instr(trim(CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END), '/') + 1
      ),
      '/'
    ) > 0
    OR trim(CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END) GLOB '*[^A-Za-z0-9!#$%&''*+.^_`|~/-]*';
END;

CREATE TRIGGER project_attachment_occurrence_mime_update_guard
BEFORE UPDATE OF mime_type ON project_content_attachments
BEGIN
  SELECT RAISE(ABORT, 'project attachment MIME type is invalid')
  WHERE NEW.mime_type IS NULL
    OR length(NEW.mime_type) NOT BETWEEN 3 AND 200
    OR trim(NEW.mime_type) <> NEW.mime_type
    OR instr(NEW.mime_type, char(0)) > 0
    OR NEW.mime_type GLOB '*[^ -~]*'
    OR instr(
      trim(CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END),
      '/'
    ) <= 1
    OR instr(
      trim(CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END),
      '/'
    ) >= length(trim(CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END))
    OR instr(
      substr(
        trim(CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END),
        instr(trim(CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END), '/') + 1
      ),
      '/'
    ) > 0
    OR trim(CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END) GLOB '*[^A-Za-z0-9!#$%&''*+.^_`|~/-]*';
END;

CREATE TRIGGER project_attachment_occurrence_byte_size_guard
BEFORE INSERT ON project_content_attachments
BEGIN
  SELECT RAISE(ABORT, 'project attachment byte size does not match blob')
  WHERE (
    NEW.asset_id IS NOT NULL
    AND NEW.byte_size <> COALESCE(
      (SELECT a.byte_size FROM assets a WHERE a.id = NEW.asset_id),
      -1
    )
  ) OR (
    NEW.storage_object_id IS NOT NULL
    AND NEW.byte_size <> COALESCE(
      (SELECT mso.byte_size FROM managed_storage_objects mso
       WHERE mso.id = NEW.storage_object_id),
      -1
    )
  );
END;
