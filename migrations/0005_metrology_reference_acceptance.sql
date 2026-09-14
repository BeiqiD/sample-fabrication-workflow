-- Durable metrology reference upload and occurrence publication receipts. These are bounded replay records,
-- not File authority, asset foreign keys, or additional byte-retention roots.
CREATE TABLE metrology_reference_upload_requests (
  id TEXT PRIMARY KEY NOT NULL,
  actor_email TEXT NOT NULL CHECK (typeof(actor_email) = 'text' AND length(actor_email) BETWEEN 1 AND 256 AND instr(actor_email, char(0)) = 0),
  client_request_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  template_version_id TEXT NOT NULL CHECK (typeof(template_version_id) = 'text' AND length(template_version_id) BETWEEN 1 AND 256 AND instr(template_version_id, char(0)) = 0),
  candidate_reference_id TEXT NOT NULL UNIQUE,
  publication_plan_json TEXT NOT NULL CHECK (typeof(publication_plan_json) = 'text' AND length(CAST(publication_plan_json AS BLOB)) <= 8192 AND CASE WHEN json_valid(publication_plan_json) THEN json_type(publication_plan_json) = 'object' ELSE 0 END ),
  ingress TEXT NOT NULL CHECK (ingress = 'metrology_reference'),
  purpose TEXT NOT NULL CHECK (purpose = 'research_source'),
  request_sha256 TEXT NOT NULL CHECK (typeof(request_sha256) = 'text' AND length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*' AND instr(request_sha256, char(0)) = 0),
  request_input_json TEXT NOT NULL CHECK (typeof(request_input_json) = 'text' AND length(CAST(request_input_json AS BLOB)) <= 8192 AND CASE WHEN json_valid(request_input_json) THEN json_type(request_input_json) = 'object' ELSE 0 END ),
  request_scope TEXT NOT NULL CHECK (request_scope = 'system'),
  storage_profile_id TEXT NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
  storage_profile_revision INTEGER NOT NULL CHECK (typeof(storage_profile_revision) = 'integer' AND storage_profile_revision = 1),
  storage_policy_revision INTEGER NOT NULL CHECK (typeof(storage_policy_revision) = 'integer' AND storage_policy_revision = 1),
  candidate_asset_id TEXT NOT NULL UNIQUE,
  candidate_object_key TEXT NOT NULL UNIQUE CHECK (typeof(candidate_object_key) = 'text' AND length(candidate_object_key) BETWEEN 1 AND 4096 AND instr(candidate_object_key, char(0)) = 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  accepted_result_json TEXT CHECK (accepted_result_json IS NULL OR (typeof(accepted_result_json) = 'text' AND length(CAST(accepted_result_json AS BLOB)) <= 8192 AND CASE WHEN json_valid(accepted_result_json) THEN json_type(accepted_result_json) = 'object' ELSE 0 END )),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  completed_at TEXT CHECK (completed_at IS NULL OR (completed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) AND completed_at >= created_at)),
  expires_at TEXT NOT NULL CHECK (expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1 day')),
  UNIQUE (actor_email, client_request_id),
  CHECK ((status = 'pending' AND completed_at IS NULL AND accepted_result_json IS NULL)
    OR (status = 'failed' AND completed_at IS NOT NULL AND accepted_result_json IS NULL)
    OR (status = 'ready' AND completed_at IS NOT NULL AND completed_at < expires_at AND accepted_result_json IS NOT NULL))
);

CREATE TRIGGER metrology_reference_upload_requests_insert_guard BEFORE INSERT ON metrology_reference_upload_requests
BEGIN
  -- Protect INSERT OR REPLACE even when recursive delete triggers are disabled.
  SELECT CASE WHEN EXISTS (SELECT 1 FROM metrology_reference_upload_requests old WHERE old.id = NEW.id
    OR (old.actor_email = NEW.actor_email AND old.client_request_id = NEW.client_request_id)
    OR old.operation_id = NEW.operation_id OR old.candidate_reference_id = NEW.candidate_reference_id OR old.candidate_asset_id = NEW.candidate_asset_id
    OR old.candidate_object_key = NEW.candidate_object_key)
    THEN RAISE(ABORT, 'Accepted upload identity is immutable') END ;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM (SELECT NEW.id AS value UNION ALL SELECT NEW.client_request_id
      UNION ALL SELECT NEW.operation_id UNION ALL SELECT NEW.candidate_asset_id UNION ALL SELECT NEW.candidate_reference_id)
    WHERE typeof(value) <> 'text' OR length(value) <> 36 OR value <> lower(value) OR instr(value, char(0)) <> 0
      OR substr(value, 9, 1) <> '-' OR substr(value, 14, 1) <> '-'
      OR substr(value, 19, 1) <> '-' OR substr(value, 24, 1) <> '-'
      OR length(replace(value, '-', '')) <> 32 OR replace(value, '-', '') GLOB '*[^0-9a-f]*'
      OR substr(value, 15, 1) <> '4' OR substr(value, 20, 1) NOT GLOB '[89ab]'
  ) THEN RAISE(ABORT, 'Invalid upload request identity') END ;
  SELECT CASE WHEN NEW.status <> 'pending' OR NEW.completed_at IS NOT NULL OR NEW.accepted_result_json IS NOT NULL
    THEN RAISE(ABORT, 'Accepted uploads must begin pending') END ;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM storage_profiles p WHERE p.id = NEW.storage_profile_id
    AND p.adapter_type = 'r2' AND p.configuration_revision = NEW.storage_profile_revision
    AND p.configuration_source = 'bootstrap' AND p.credential_reference IS NULL AND p.state = 'historical')
    THEN RAISE(ABORT, 'Upload acceptance profile mismatch') END ;
  SELECT CASE WHEN NOT json_valid(NEW.request_input_json)
    THEN RAISE(ABORT, 'Invalid upload request input') END ;
  SELECT CASE WHEN json_type(NEW.request_input_json) IS NOT 'object'
    OR (SELECT count(*) FROM json_each(NEW.request_input_json)) <> 6
    OR json_extract(NEW.request_input_json, '$.schema') IS NOT 'metrology-reference-upload/1'
    OR json_extract(NEW.request_input_json, '$.templateId') IS NOT NEW.template_version_id
    OR json_extract(NEW.request_input_json, '$.ingress') IS NOT NEW.ingress
    OR json_extract(NEW.request_input_json, '$.purpose') IS NOT NEW.purpose
    OR json_extract(NEW.request_input_json, '$.scope') IS NOT NEW.request_scope
    OR json_type(NEW.request_input_json, '$.file') IS NOT 'object'
    OR (SELECT count(*) FROM json_each(NEW.request_input_json, '$.file')) <> 4
    OR json_type(NEW.request_input_json, '$.file.originalName') IS NOT 'text'
    OR length(json_extract(NEW.request_input_json, '$.file.originalName')) NOT BETWEEN 1 AND 255
    OR length(trim(json_extract(NEW.request_input_json, '$.file.originalName'))) = 0
    OR instr(json_extract(NEW.request_input_json, '$.file.originalName'), char(0)) <> 0
    OR json_type(NEW.request_input_json, '$.file.mimeType') IS NOT 'text'
    OR length(json_extract(NEW.request_input_json, '$.file.mimeType')) NOT BETWEEN 1 AND 200
    OR json_extract(NEW.request_input_json, '$.file.mimeType') IS NOT trim(json_extract(NEW.request_input_json, '$.file.mimeType'))
    OR json_extract(NEW.request_input_json, '$.file.mimeType') GLOB '*[^ -~]*'
    OR instr(json_extract(NEW.request_input_json, '$.file.mimeType'), char(0)) <> 0
    OR json_type(NEW.request_input_json, '$.file.byteSize') IS NOT 'integer'
    OR json_extract(NEW.request_input_json, '$.file.byteSize') NOT BETWEEN 1 AND 26214400
    OR json_type(NEW.request_input_json, '$.file.sha256') IS NOT 'text'
    OR length(json_extract(NEW.request_input_json, '$.file.sha256')) <> 64
    OR json_extract(NEW.request_input_json, '$.file.sha256') GLOB '*[^0-9a-f]*'
    OR instr(json_extract(NEW.request_input_json, '$.file.sha256'), char(0)) <> 0
    THEN RAISE(ABORT, 'Upload request input does not match acceptance') END ;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM template_versions tv WHERE tv.id = NEW.template_version_id
    AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL AND tv.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.template_version_id = tv.id AND i.status <> 'ready'))
    THEN RAISE(ABORT, 'Metrology template is not active') END ;
  SELECT CASE WHEN json_type(NEW.publication_plan_json) IS NOT 'object'
    OR (SELECT count(*) FROM json_each(NEW.publication_plan_json)) <> 3
    OR EXISTS (SELECT 1 FROM json_each(NEW.publication_plan_json) WHERE key NOT IN ('schema', 'action', 'reference'))
    OR json_extract(NEW.publication_plan_json, '$.schema') IS NOT 'metrology-reference-publication/1'
    OR json_type(NEW.publication_plan_json, '$.reference') IS NULL
    OR json_type(NEW.publication_plan_json, '$.action') IS NOT 'text'
    OR json_extract(NEW.publication_plan_json, '$.action') NOT IN ('create', 'reuse', 'restore')
    OR NOT (
      (json_extract(NEW.publication_plan_json, '$.action') = 'create' AND json_type(NEW.publication_plan_json, '$.reference') IS 'null')
      OR (json_extract(NEW.publication_plan_json, '$.action') IN ('reuse', 'restore')
        AND json_type(NEW.publication_plan_json, '$.reference') IS 'object'
        AND (SELECT count(*) FROM json_each(NEW.publication_plan_json, '$.reference')) = 8
        AND (SELECT count(DISTINCT key) FROM json_each(NEW.publication_plan_json, '$.reference')) = 8
        AND json_type(NEW.publication_plan_json, '$.reference.id') = 'text'
        AND length(json_extract(NEW.publication_plan_json, '$.reference.id')) BETWEEN 1 AND 256 AND length(trim(json_extract(NEW.publication_plan_json, '$.reference.id'))) > 0 AND instr(json_extract(NEW.publication_plan_json, '$.reference.id'), char(0)) = 0
        AND json_type(NEW.publication_plan_json, '$.reference.assetId') = 'text'
        AND length(json_extract(NEW.publication_plan_json, '$.reference.assetId')) BETWEEN 1 AND 256 AND length(trim(json_extract(NEW.publication_plan_json, '$.reference.assetId'))) > 0 AND instr(json_extract(NEW.publication_plan_json, '$.reference.assetId'), char(0)) = 0
        AND json_type(NEW.publication_plan_json, '$.reference.filename') = 'text'
        AND length(json_extract(NEW.publication_plan_json, '$.reference.filename')) BETWEEN 1 AND 255 AND length(trim(json_extract(NEW.publication_plan_json, '$.reference.filename'))) > 0 AND instr(json_extract(NEW.publication_plan_json, '$.reference.filename'), char(0)) = 0
        AND (json_type(NEW.publication_plan_json, '$.reference.actorEmail') = 'null'
          OR (json_type(NEW.publication_plan_json, '$.reference.actorEmail') = 'text' AND length(json_extract(NEW.publication_plan_json, '$.reference.actorEmail')) BETWEEN 1 AND 256 AND length(trim(json_extract(NEW.publication_plan_json, '$.reference.actorEmail'))) > 0 AND instr(json_extract(NEW.publication_plan_json, '$.reference.actorEmail'), char(0)) = 0))
        AND (json_type(NEW.publication_plan_json, '$.reference.deletedBy') = 'null'
          OR (json_type(NEW.publication_plan_json, '$.reference.deletedBy') = 'text' AND length(json_extract(NEW.publication_plan_json, '$.reference.deletedBy')) BETWEEN 1 AND 256 AND length(trim(json_extract(NEW.publication_plan_json, '$.reference.deletedBy'))) > 0 AND instr(json_extract(NEW.publication_plan_json, '$.reference.deletedBy'), char(0)) = 0))
        AND json_type(NEW.publication_plan_json, '$.reference.createdAt') = 'text'
        AND json_type(NEW.publication_plan_json, '$.reference.deletedAt') IN ('text', 'null')
        AND json_type(NEW.publication_plan_json, '$.reference.position') = 'integer'
        AND json_extract(NEW.publication_plan_json, '$.reference.position') BETWEEN 0 AND 9007199254740991
        AND json_extract(NEW.publication_plan_json, '$.reference.createdAt') IS strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(NEW.publication_plan_json, '$.reference.createdAt'))
        AND (json_type(NEW.publication_plan_json, '$.reference.deletedAt') = 'null'
          OR json_extract(NEW.publication_plan_json, '$.reference.deletedAt') IS strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(NEW.publication_plan_json, '$.reference.deletedAt')))
        AND NOT EXISTS (SELECT 1 FROM json_each(NEW.publication_plan_json, '$.reference') WHERE key NOT IN ('id', 'assetId', 'filename', 'position', 'actorEmail', 'createdAt', 'deletedAt', 'deletedBy'))
        AND EXISTS (SELECT 1 FROM metrology_template_references mtr JOIN assets a ON a.id = mtr.asset_id
          LEFT JOIN imports i ON i.id = a.import_id
          WHERE mtr.id IS json_extract(NEW.publication_plan_json, '$.reference.id')
            AND mtr.template_version_id = NEW.template_version_id AND mtr.superseded_by_occurrence_id IS NULL
            AND mtr.asset_id IS json_extract(NEW.publication_plan_json, '$.reference.assetId')
            AND mtr.display_name IS json_extract(NEW.publication_plan_json, '$.reference.filename')
            AND mtr.position IS json_extract(NEW.publication_plan_json, '$.reference.position')
            AND mtr.actor_email IS json_extract(NEW.publication_plan_json, '$.reference.actorEmail')
            AND mtr.created_at IS json_extract(NEW.publication_plan_json, '$.reference.createdAt')
            AND mtr.deleted_at IS json_extract(NEW.publication_plan_json, '$.reference.deletedAt')
            AND mtr.deleted_by IS json_extract(NEW.publication_plan_json, '$.reference.deletedBy')
            AND ((json_extract(NEW.publication_plan_json, '$.action') = 'reuse' AND mtr.deleted_at IS NULL)
              OR (json_extract(NEW.publication_plan_json, '$.action') = 'restore' AND mtr.deleted_at IS NOT NULL))
            AND a.status = 'ready' AND a.sha256 = json_extract(NEW.request_input_json, '$.file.sha256')
            AND a.byte_size = json_extract(NEW.request_input_json, '$.file.byteSize') AND (a.import_id IS NULL OR i.status = 'ready')
        ))
    ) THEN RAISE(ABORT, 'Invalid metrology reference publication plan') END ;
END;

CREATE TRIGGER metrology_reference_upload_requests_update_guard BEFORE UPDATE ON metrology_reference_upload_requests
BEGIN
  SELECT CASE WHEN OLD.status <> 'pending'
    OR NEW.id IS NOT OLD.id OR NEW.actor_email IS NOT OLD.actor_email
    OR NEW.client_request_id IS NOT OLD.client_request_id OR NEW.operation_id IS NOT OLD.operation_id
    OR NEW.template_version_id IS NOT OLD.template_version_id OR NEW.candidate_reference_id IS NOT OLD.candidate_reference_id
    OR NEW.publication_plan_json IS NOT OLD.publication_plan_json
    OR NEW.ingress IS NOT OLD.ingress OR NEW.purpose IS NOT OLD.purpose
    OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.request_input_json IS NOT OLD.request_input_json
    OR NEW.request_scope IS NOT OLD.request_scope OR NEW.storage_profile_id IS NOT OLD.storage_profile_id
    OR NEW.storage_profile_revision IS NOT OLD.storage_profile_revision OR NEW.storage_policy_revision IS NOT OLD.storage_policy_revision
    OR NEW.candidate_asset_id IS NOT OLD.candidate_asset_id OR NEW.candidate_object_key IS NOT OLD.candidate_object_key
    OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
    OR NEW.status NOT IN ('ready', 'failed')
    THEN RAISE(ABORT, 'Accepted upload identity or result is immutable') END ;
END;

CREATE TRIGGER metrology_reference_upload_requests_publication_guard BEFORE UPDATE ON metrology_reference_upload_requests
WHEN NEW.status = 'ready'
BEGIN
  SELECT CASE WHEN NEW.accepted_result_json IS NULL OR NOT json_valid(NEW.accepted_result_json)
    THEN RAISE(ABORT, 'Invalid accepted metrology reference result') END ;
  SELECT CASE WHEN json_type(NEW.accepted_result_json) IS NOT 'object'
    OR (SELECT count(*) FROM json_each(NEW.accepted_result_json)) <> 3
    OR json_type(NEW.accepted_result_json, '$.assetId') IS NOT 'text'
    OR (json_type(NEW.accepted_result_json, '$.deduplicated') IS NOT 'true' AND json_type(NEW.accepted_result_json, '$.deduplicated') IS NOT 'false')
    OR json_type(NEW.accepted_result_json, '$.reference') IS NOT 'object'
    OR (SELECT count(*) FROM json_each(NEW.accepted_result_json, '$.reference')) <> 6
    OR json_type(NEW.accepted_result_json, '$.reference.id') IS NOT 'text'
    OR length(json_extract(NEW.accepted_result_json, '$.reference.id')) NOT BETWEEN 1 AND 256 OR length(trim(json_extract(NEW.accepted_result_json, '$.reference.id'))) = 0 OR instr(json_extract(NEW.accepted_result_json, '$.reference.id'), char(0)) <> 0
    OR json_type(NEW.accepted_result_json, '$.reference.filename') IS NOT 'text'
    OR length(json_extract(NEW.accepted_result_json, '$.reference.filename')) NOT BETWEEN 1 AND 255 OR length(trim(json_extract(NEW.accepted_result_json, '$.reference.filename'))) = 0 OR instr(json_extract(NEW.accepted_result_json, '$.reference.filename'), char(0)) <> 0
    OR json_type(NEW.accepted_result_json, '$.reference.mimeType') IS NOT 'text'
    OR length(json_extract(NEW.accepted_result_json, '$.reference.mimeType')) NOT BETWEEN 1 AND 200 OR length(trim(json_extract(NEW.accepted_result_json, '$.reference.mimeType'))) = 0 OR instr(json_extract(NEW.accepted_result_json, '$.reference.mimeType'), char(0)) <> 0
    OR json_type(NEW.accepted_result_json, '$.reference.assetKey') IS NOT 'text'
    OR length(json_extract(NEW.accepted_result_json, '$.reference.assetKey')) NOT BETWEEN 1 AND 4096 OR length(trim(json_extract(NEW.accepted_result_json, '$.reference.assetKey'))) = 0 OR instr(json_extract(NEW.accepted_result_json, '$.reference.assetKey'), char(0)) <> 0
    OR json_type(NEW.accepted_result_json, '$.reference.createdAt') IS NOT 'text'
    OR length(json_extract(NEW.accepted_result_json, '$.reference.createdAt')) NOT BETWEEN 1 AND 24 OR length(trim(json_extract(NEW.accepted_result_json, '$.reference.createdAt'))) = 0 OR instr(json_extract(NEW.accepted_result_json, '$.reference.createdAt'), char(0)) <> 0
    OR length(json_extract(NEW.accepted_result_json, '$.assetId')) NOT BETWEEN 1 AND 256 OR instr(json_extract(NEW.accepted_result_json, '$.assetId'), char(0)) <> 0
    OR json_extract(NEW.accepted_result_json, '$.reference.createdAt') IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(NEW.accepted_result_json, '$.reference.createdAt'))
    OR json_extract(NEW.accepted_result_json, '$.reference.mimeType') IS NOT trim(json_extract(NEW.accepted_result_json, '$.reference.mimeType'))
    OR json_extract(NEW.accepted_result_json, '$.reference.mimeType') GLOB '*[^ -~]*'
    OR json_type(NEW.accepted_result_json, '$.reference.byteSize') IS NOT 'integer'
    OR json_extract(NEW.accepted_result_json, '$.reference.byteSize') NOT BETWEEN 1 AND 26214400
    OR NOT EXISTS (
      SELECT 1 FROM metrology_template_references mtr
      JOIN template_versions tv ON tv.id = mtr.template_version_id
      JOIN assets a ON a.id = mtr.asset_id LEFT JOIN imports i ON i.id = a.import_id
      WHERE mtr.id = json_extract(NEW.accepted_result_json, '$.reference.id')
        AND mtr.template_version_id = NEW.template_version_id
        AND mtr.asset_id = json_extract(NEW.accepted_result_json, '$.assetId')
        AND mtr.display_name IS json_extract(NEW.accepted_result_json, '$.reference.filename')
        AND mtr.created_at IS json_extract(NEW.accepted_result_json, '$.reference.createdAt')
        AND mtr.deleted_at IS NULL AND mtr.superseded_by_occurrence_id IS NULL
        AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL AND tv.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM imports owning WHERE owning.template_version_id = tv.id AND owning.status <> 'ready')
        AND a.r2_key IS json_extract(NEW.accepted_result_json, '$.reference.assetKey')
        AND a.mime_type IS json_extract(NEW.accepted_result_json, '$.reference.mimeType')
        AND a.byte_size IS json_extract(NEW.accepted_result_json, '$.reference.byteSize')
        AND a.status = 'ready' AND a.sha256 = json_extract(NEW.request_input_json, '$.file.sha256')
        AND a.byte_size = json_extract(NEW.request_input_json, '$.file.byteSize')
        AND (a.import_id IS NULL OR i.status = 'ready')
        AND (json_extract(NEW.accepted_result_json, '$.deduplicated') = 1
          OR (a.id = NEW.candidate_asset_id AND a.r2_key = NEW.candidate_object_key))
        AND (json_extract(NEW.publication_plan_json, '$.action') = 'create'
          OR (mtr.id = json_extract(NEW.publication_plan_json, '$.reference.id')
            AND mtr.created_at IS json_extract(NEW.publication_plan_json, '$.reference.createdAt')
            AND mtr.position IS json_extract(NEW.publication_plan_json, '$.reference.position')
            AND mtr.actor_email IS json_extract(NEW.publication_plan_json, '$.reference.actorEmail')
            AND mtr.display_name = CASE WHEN json_extract(NEW.publication_plan_json, '$.action') = 'restore'
              THEN json_extract(NEW.request_input_json, '$.file.originalName')
              ELSE json_extract(NEW.publication_plan_json, '$.reference.filename') END ))
        AND (mtr.id <> NEW.candidate_reference_id
          OR (mtr.display_name = json_extract(NEW.request_input_json, '$.file.originalName')
            AND mtr.actor_email = NEW.actor_email AND mtr.created_at = NEW.created_at))
        AND NOT EXISTS (SELECT 1 FROM blob_gc_ledger bg WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted'))
        AND NOT EXISTS (SELECT 1 FROM blob_integrity_quarantine biq WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = a.r2_key)
    ) THEN RAISE(ABORT, 'Accepted metrology reference result does not match publication') END ;
END;

CREATE TRIGGER metrology_reference_upload_requests_delete_guard BEFORE DELETE ON metrology_reference_upload_requests
BEGIN
  SELECT RAISE(ABORT, 'Accepted upload identity cannot be deleted');
END;
