-- Durable ordinary/Project upload receipts. These are bounded replay records,
-- not File authority, asset foreign keys, or additional byte-retention roots.
CREATE TABLE r2_upload_requests (
  id TEXT PRIMARY KEY NOT NULL,
  actor_email TEXT NOT NULL CHECK (typeof(actor_email) = 'text' AND length(actor_email) BETWEEN 1 AND 256 AND instr(actor_email, char(0)) = 0),
  client_request_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  ingress TEXT NOT NULL CHECK (ingress IN ('ordinary_image', 'project_attachment')),
  purpose TEXT NOT NULL CHECK ((ingress = 'ordinary_image' AND purpose = 'embedded_content') OR (ingress = 'project_attachment' AND purpose = 'research_source')),
  request_sha256 TEXT NOT NULL CHECK (typeof(request_sha256) = 'text' AND length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*' AND instr(request_sha256, char(0)) = 0),
  request_input_json TEXT NOT NULL CHECK (typeof(request_input_json) = 'text' AND length(CAST(request_input_json AS BLOB)) <= 8192 AND CASE WHEN json_valid(request_input_json) THEN json_type(request_input_json) = 'object' ELSE 0 END),
  request_scope TEXT NOT NULL CHECK (request_scope = 'system'),
  storage_profile_id TEXT NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
  storage_profile_revision INTEGER NOT NULL CHECK (typeof(storage_profile_revision) = 'integer' AND storage_profile_revision = 1),
  storage_policy_revision INTEGER NOT NULL CHECK (typeof(storage_policy_revision) = 'integer' AND storage_policy_revision = 1),
  candidate_asset_id TEXT NOT NULL UNIQUE,
  candidate_object_key TEXT NOT NULL UNIQUE CHECK (typeof(candidate_object_key) = 'text' AND length(candidate_object_key) BETWEEN 1 AND 4096 AND instr(candidate_object_key, char(0)) = 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  accepted_result_json TEXT CHECK (accepted_result_json IS NULL OR (typeof(accepted_result_json) = 'text' AND length(CAST(accepted_result_json AS BLOB)) <= 8192 AND CASE WHEN json_valid(accepted_result_json) THEN json_type(accepted_result_json) = 'object' ELSE 0 END)),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  completed_at TEXT CHECK (completed_at IS NULL OR (completed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) AND completed_at >= created_at)),
  expires_at TEXT NOT NULL CHECK (expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1 day')),
  UNIQUE (actor_email, client_request_id),
  CHECK ((status = 'pending' AND completed_at IS NULL AND accepted_result_json IS NULL)
    OR (status = 'failed' AND completed_at IS NOT NULL AND accepted_result_json IS NULL)
    OR (status = 'ready' AND completed_at IS NOT NULL AND completed_at < expires_at AND accepted_result_json IS NOT NULL))
);

CREATE TRIGGER r2_upload_requests_insert_guard BEFORE INSERT ON r2_upload_requests
BEGIN
  -- Protect INSERT OR REPLACE even when recursive delete triggers are disabled.
  SELECT CASE WHEN EXISTS (SELECT 1 FROM r2_upload_requests old WHERE old.id = NEW.id
    OR (old.actor_email = NEW.actor_email AND old.client_request_id = NEW.client_request_id)
    OR old.operation_id = NEW.operation_id OR old.candidate_asset_id = NEW.candidate_asset_id
    OR old.candidate_object_key = NEW.candidate_object_key)
    THEN RAISE(ABORT, 'Accepted upload identity is immutable') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM (SELECT NEW.id AS value UNION ALL SELECT NEW.client_request_id
      UNION ALL SELECT NEW.operation_id UNION ALL SELECT NEW.candidate_asset_id)
    WHERE typeof(value) <> 'text' OR length(value) <> 36 OR value <> lower(value) OR instr(value, char(0)) <> 0
      OR substr(value, 9, 1) <> '-' OR substr(value, 14, 1) <> '-'
      OR substr(value, 19, 1) <> '-' OR substr(value, 24, 1) <> '-'
      OR length(replace(value, '-', '')) <> 32 OR replace(value, '-', '') GLOB '*[^0-9a-f]*'
      OR substr(value, 15, 1) <> '4' OR substr(value, 20, 1) NOT GLOB '[89ab]'
  ) THEN RAISE(ABORT, 'Invalid upload request identity') END;
  SELECT CASE WHEN NEW.status <> 'pending' OR NEW.completed_at IS NOT NULL OR NEW.accepted_result_json IS NOT NULL
    THEN RAISE(ABORT, 'Accepted uploads must begin pending') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM storage_profiles p WHERE p.id = NEW.storage_profile_id
    AND p.adapter_type = 'r2' AND p.configuration_revision = NEW.storage_profile_revision
    AND p.configuration_source = 'bootstrap' AND p.credential_reference IS NULL AND p.state = 'historical')
    THEN RAISE(ABORT, 'Upload acceptance profile mismatch') END;
  SELECT CASE WHEN NOT json_valid(NEW.request_input_json)
    THEN RAISE(ABORT, 'Invalid upload request input') END;
  SELECT CASE WHEN json_type(NEW.request_input_json) IS NOT 'object'
    OR (SELECT count(*) FROM json_each(NEW.request_input_json)) <> 5
    OR json_extract(NEW.request_input_json, '$.schema') IS NOT 'r2-upload-request/1'
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
    OR json_extract(NEW.request_input_json, '$.file.byteSize') NOT BETWEEN 0 AND 10485760
    OR json_type(NEW.request_input_json, '$.file.sha256') IS NOT 'text'
    OR length(json_extract(NEW.request_input_json, '$.file.sha256')) <> 64
    OR json_extract(NEW.request_input_json, '$.file.sha256') GLOB '*[^0-9a-f]*'
    OR instr(json_extract(NEW.request_input_json, '$.file.sha256'), char(0)) <> 0
    OR (NEW.ingress = 'ordinary_image' AND lower(substr(json_extract(NEW.request_input_json, '$.file.mimeType'), 1, 6)) <> 'image/')
    THEN RAISE(ABORT, 'Upload request input does not match acceptance') END;
END;

CREATE TRIGGER r2_upload_requests_update_guard BEFORE UPDATE ON r2_upload_requests
BEGIN
  SELECT CASE WHEN OLD.status <> 'pending'
    OR NEW.id IS NOT OLD.id OR NEW.actor_email IS NOT OLD.actor_email
    OR NEW.client_request_id IS NOT OLD.client_request_id OR NEW.operation_id IS NOT OLD.operation_id
    OR NEW.ingress IS NOT OLD.ingress OR NEW.purpose IS NOT OLD.purpose
    OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.request_input_json IS NOT OLD.request_input_json
    OR NEW.request_scope IS NOT OLD.request_scope OR NEW.storage_profile_id IS NOT OLD.storage_profile_id
    OR NEW.storage_profile_revision IS NOT OLD.storage_profile_revision OR NEW.storage_policy_revision IS NOT OLD.storage_policy_revision
    OR NEW.candidate_asset_id IS NOT OLD.candidate_asset_id OR NEW.candidate_object_key IS NOT OLD.candidate_object_key
    OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
    OR NEW.status NOT IN ('ready', 'failed')
    THEN RAISE(ABORT, 'Accepted upload identity or result is immutable') END;
END;

CREATE TRIGGER r2_upload_requests_publication_guard BEFORE UPDATE ON r2_upload_requests
WHEN NEW.status = 'ready'
BEGIN
  SELECT CASE WHEN NEW.accepted_result_json IS NULL OR NOT json_valid(NEW.accepted_result_json)
    THEN RAISE(ABORT, 'Invalid accepted upload result') END;
  SELECT CASE WHEN json_type(NEW.accepted_result_json) IS NOT 'object'
    OR (SELECT count(*) FROM json_each(NEW.accepted_result_json)) <> 3
    OR json_type(NEW.accepted_result_json, '$.id') IS NOT 'text'
    OR length(json_extract(NEW.accepted_result_json, '$.id')) NOT BETWEEN 1 AND 256
    OR instr(json_extract(NEW.accepted_result_json, '$.id'), char(0)) <> 0
    OR json_type(NEW.accepted_result_json, '$.key') IS NOT 'text'
    OR length(json_extract(NEW.accepted_result_json, '$.key')) NOT BETWEEN 1 AND 4096
    OR instr(json_extract(NEW.accepted_result_json, '$.key'), char(0)) <> 0
    OR (json_type(NEW.accepted_result_json, '$.deduplicated') IS NOT 'true'
      AND json_type(NEW.accepted_result_json, '$.deduplicated') IS NOT 'false')
    OR NOT EXISTS (
      SELECT 1 FROM assets a LEFT JOIN imports i ON i.id = a.import_id
      WHERE a.id = json_extract(NEW.accepted_result_json, '$.id')
        AND a.r2_key = json_extract(NEW.accepted_result_json, '$.key') AND a.status = 'ready'
        AND a.sha256 = json_extract(NEW.request_input_json, '$.file.sha256')
        AND a.byte_size = json_extract(NEW.request_input_json, '$.file.byteSize')
        AND (a.import_id IS NULL OR i.status = 'ready')
        AND (json_extract(NEW.accepted_result_json, '$.deduplicated') = 1
          OR (a.id = NEW.candidate_asset_id AND a.r2_key = NEW.candidate_object_key))
        AND NOT EXISTS (SELECT 1 FROM blob_gc_ledger bg WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = a.r2_key AND bg.state IN ('deleting', 'deleted'))
        AND NOT EXISTS (SELECT 1 FROM blob_integrity_quarantine biq WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = a.r2_key)
    ) THEN RAISE(ABORT, 'Accepted upload result does not match publication') END;
END;

CREATE TRIGGER r2_upload_requests_delete_guard BEFORE DELETE ON r2_upload_requests
BEGIN
  SELECT RAISE(ABORT, 'Accepted upload identity cannot be deleted');
END;
