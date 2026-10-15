-- Accepted FabuBlox requests share the existing imports execution ledger.
-- Historical imports keep NULL acceptance columns. The four FP1a registry
-- tables and all legacy byte ownership and retention rules remain unchanged.
ALTER TABLE imports ADD COLUMN client_request_id TEXT
  CHECK (client_request_id IS NULL OR (
    typeof(client_request_id) = 'text' AND length(client_request_id) = 36
    AND client_request_id = lower(client_request_id)
    AND substr(client_request_id, 9, 1) = '-' AND substr(client_request_id, 14, 1) = '-'
    AND substr(client_request_id, 19, 1) = '-' AND substr(client_request_id, 24, 1) = '-'
    AND length(replace(client_request_id, '-', '')) = 32
    AND replace(client_request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    AND substr(client_request_id, 15, 1) GLOB '[1-8]'
    AND substr(client_request_id, 20, 1) GLOB '[89ab]'
  ));
ALTER TABLE imports ADD COLUMN request_sha256 TEXT
  CHECK (request_sha256 IS NULL OR (typeof(request_sha256) = 'text'
    AND length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE imports ADD COLUMN request_input_json TEXT
  CHECK (request_input_json IS NULL OR (typeof(request_input_json) = 'text'
    AND length(CAST(request_input_json AS BLOB)) <= 131072
    AND CASE WHEN json_valid(request_input_json) THEN json_type(request_input_json) = 'object' ELSE 0 END ));
ALTER TABLE imports ADD COLUMN request_scope TEXT CHECK (request_scope IS NULL OR request_scope = 'system');
ALTER TABLE imports ADD COLUMN storage_profile_id TEXT REFERENCES storage_profiles(id) ON DELETE RESTRICT;
ALTER TABLE imports ADD COLUMN storage_profile_revision INTEGER
  CHECK (storage_profile_revision IS NULL OR (typeof(storage_profile_revision) = 'integer' AND storage_profile_revision = 1));
ALTER TABLE imports ADD COLUMN storage_policy_revision INTEGER
  CHECK (storage_policy_revision IS NULL OR (typeof(storage_policy_revision) = 'integer' AND storage_policy_revision = 1));
ALTER TABLE imports ADD COLUMN accepted_result_json TEXT
  CHECK (accepted_result_json IS NULL OR (typeof(accepted_result_json) = 'text'
    AND length(CAST(accepted_result_json AS BLOB)) <= 4096
    AND CASE WHEN json_valid(accepted_result_json) THEN json_type(accepted_result_json) = 'object' ELSE 0 END ));

CREATE UNIQUE INDEX imports_accepted_request_idx ON imports(actor_email, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE TRIGGER imports_acceptance_insert_guard BEFORE INSERT ON imports
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM imports old WHERE old.client_request_id IS NOT NULL
      AND (old.id = NEW.id OR (old.actor_email = NEW.actor_email AND old.client_request_id = NEW.client_request_id))
  ) THEN RAISE(ABORT, 'Accepted import identity is immutable') END ;
  SELECT CASE WHEN NOT (
    (NEW.client_request_id IS NULL AND NEW.request_sha256 IS NULL AND NEW.request_input_json IS NULL
      AND NEW.request_scope IS NULL AND NEW.storage_profile_id IS NULL AND NEW.storage_profile_revision IS NULL
      AND NEW.storage_policy_revision IS NULL AND NEW.accepted_result_json IS NULL)
    OR (NEW.client_request_id IS NOT NULL AND NEW.request_sha256 IS NOT NULL AND NEW.request_input_json IS NOT NULL
      AND NEW.request_scope IS NOT NULL AND NEW.storage_profile_id IS NOT NULL AND NEW.storage_profile_revision IS NOT NULL
      AND NEW.storage_policy_revision IS NOT NULL AND typeof(NEW.actor_email) = 'text' AND length(NEW.actor_email) BETWEEN 1 AND 256
      AND instr(NEW.actor_email, char(0)) = 0 AND typeof(NEW.operation_id) = 'text' AND length(NEW.operation_id) BETWEEN 1 AND 256
      AND instr(NEW.operation_id, char(0)) = 0)
  ) THEN RAISE(ABORT, 'Import acceptance fields must be complete') END ;
  SELECT CASE WHEN NEW.client_request_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM storage_profiles p WHERE p.id = NEW.storage_profile_id
      AND p.adapter_type = 'r2' AND p.configuration_revision = NEW.storage_profile_revision
  ) THEN RAISE(ABORT, 'Import acceptance profile mismatch') END ;
  SELECT CASE WHEN NEW.client_request_id IS NOT NULL AND NEW.status <> 'pending'
    THEN RAISE(ABORT, 'Accepted imports must begin pending') END ;
  SELECT CASE WHEN NEW.accepted_result_json IS NOT NULL
    THEN RAISE(ABORT, 'Import result requires guarded publication') END ;
END;

CREATE TRIGGER imports_acceptance_update_guard BEFORE UPDATE ON imports
BEGIN
  SELECT CASE WHEN OLD.client_request_id IS NULL AND (
    NEW.client_request_id IS NOT NULL OR NEW.request_sha256 IS NOT NULL OR NEW.request_input_json IS NOT NULL
    OR NEW.request_scope IS NOT NULL OR NEW.storage_profile_id IS NOT NULL OR NEW.storage_profile_revision IS NOT NULL
    OR NEW.storage_policy_revision IS NOT NULL OR NEW.accepted_result_json IS NOT NULL
  ) THEN RAISE(ABORT, 'Legacy imports cannot acquire accepted identity') END ;
  SELECT CASE WHEN OLD.client_request_id IS NOT NULL AND (
    NEW.id IS NOT OLD.id OR NEW.client_request_id IS NOT OLD.client_request_id
    OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.request_input_json IS NOT OLD.request_input_json
    OR NEW.request_scope IS NOT OLD.request_scope OR NEW.storage_profile_id IS NOT OLD.storage_profile_id
    OR NEW.storage_profile_revision IS NOT OLD.storage_profile_revision OR NEW.storage_policy_revision IS NOT OLD.storage_policy_revision
    OR NEW.actor_email IS NOT OLD.actor_email OR NEW.operation_id IS NOT OLD.operation_id
  ) THEN RAISE(ABORT, 'Accepted import identity is immutable') END ;
  SELECT CASE WHEN OLD.accepted_result_json IS NOT NULL AND (
    NEW.accepted_result_json IS NOT OLD.accepted_result_json OR NEW.status IS NOT OLD.status
  ) THEN RAISE(ABORT, 'Accepted import result is immutable') END ;
  SELECT CASE WHEN OLD.client_request_id IS NOT NULL AND OLD.status = 'failed' AND NEW.status <> 'failed'
    THEN RAISE(ABORT, 'Failed accepted imports cannot restart') END ;
  SELECT CASE WHEN NEW.client_request_id IS NOT NULL AND (
    (NEW.status = 'ready' AND NEW.accepted_result_json IS NULL)
    OR (NEW.status <> 'ready' AND NEW.accepted_result_json IS NOT NULL)
  ) THEN RAISE(ABORT, 'Accepted import result must match publication state') END ;
END;

CREATE TRIGGER imports_acceptance_publication_guard BEFORE UPDATE OF accepted_result_json ON imports
WHEN OLD.accepted_result_json IS NULL AND NEW.accepted_result_json IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT json_valid(NEW.accepted_result_json)
    THEN RAISE(ABORT, 'Invalid accepted import result') END ;
  SELECT CASE WHEN NEW.status <> 'ready' OR NEW.finalization_id IS NULL OR NEW.completed_at IS NULL
    OR NEW.lease_expires_at IS NOT NULL OR OLD.status <> 'pending'
    OR json_type(NEW.accepted_result_json) <> 'object'
    OR (SELECT count(*) FROM json_each(NEW.accepted_result_json)) <> 3
    OR json_type(NEW.accepted_result_json, '$.id') IS NOT 'text'
    OR json_extract(NEW.accepted_result_json, '$.id') IS NOT NEW.id
    OR json_type(NEW.accepted_result_json, '$.templateVersionId') IS NOT 'text'
    OR json_extract(NEW.accepted_result_json, '$.templateVersionId') IS NOT NEW.template_version_id
    OR json_type(NEW.accepted_result_json, '$.version') IS NOT 'integer'
    OR json_extract(NEW.accepted_result_json, '$.version') NOT BETWEEN 1 AND 9007199254740991
    OR NOT EXISTS (
      SELECT 1 FROM template_versions tv WHERE tv.id = NEW.template_version_id
        AND tv.version = json_extract(NEW.accepted_result_json, '$.version')
        AND tv.recipe_family_id = NEW.recipe_family_id
    ) THEN RAISE(ABORT, 'Accepted import result does not match publication') END ;
END;

CREATE TRIGGER imports_acceptance_delete_guard BEFORE DELETE ON imports
WHEN OLD.client_request_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Accepted import identity cannot be deleted');
END;
