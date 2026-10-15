-- Administrator-only isolated S3 capability evidence. These two system tables
-- and their owned objects are outside the frozen V19 portable content schema.
-- Credential snapshots are protected payloads: neither audit nor DTO exposes
-- namespace addresses, object keys, ciphertext, key identifiers or credentials.
CREATE TABLE system_storage_candidate_checks (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  profile_id TEXT NOT NULL,
  configuration_revision INTEGER NOT NULL CHECK (typeof(configuration_revision) = 'integer' AND configuration_revision > 0),
  credential_ref TEXT NOT NULL,
  envelope_revision INTEGER NOT NULL CHECK (typeof(envelope_revision) = 'integer' AND envelope_revision > 0),
  namespace_json TEXT NOT NULL CHECK (json_valid(namespace_json) AND json_type(namespace_json) = 'object'),
  namespace_sha256 TEXT NOT NULL CHECK (length(namespace_sha256) = 64 AND namespace_sha256 NOT GLOB '*[^0-9a-f]*'),
  configuration_sha256 TEXT NOT NULL CHECK (length(configuration_sha256) = 64 AND configuration_sha256 NOT GLOB '*[^0-9a-f]*'),
  envelope_version INTEGER NOT NULL CHECK (envelope_version = 1),
  key_id TEXT NOT NULL CHECK (length(key_id) BETWEEN 1 AND 64),
  nonce TEXT NOT NULL CHECK (length(nonce) = 16),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 25 AND 43716),
  probe_key TEXT NOT NULL CHECK (length(probe_key) BETWEEN 50 AND 1024 AND substr(probe_key,1,50) = '__fp2_checks/' || id || '/'),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  payload_size INTEGER NOT NULL CHECK (typeof(payload_size) = 'integer' AND payload_size BETWEEN 1 AND 65536),
  requested_by TEXT NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 254),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  execution_kind TEXT NOT NULL CHECK (execution_kind IN ('check','cleanup')),
  execution_token TEXT NOT NULL CHECK (length(execution_token) BETWEEN 1 AND 256),
  execution_deadline TEXT NOT NULL CHECK (julianday(execution_deadline) IS NOT NULL),
  execution_actor TEXT NOT NULL CHECK (length(execution_actor) BETWEEN 1 AND 254),
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','interrupted')),
  write_outcome TEXT NOT NULL CHECK (write_outcome IN ('pending','unknown','acknowledged')),
  read_outcome TEXT NOT NULL CHECK (read_outcome IN ('pending','verified','failed')),
  metadata_outcome TEXT NOT NULL CHECK (metadata_outcome IN ('pending','verified','failed')),
  delete_outcome TEXT NOT NULL CHECK (delete_outcome IN ('pending','acknowledged','failed')),
  cleanup_outcome TEXT NOT NULL CHECK (cleanup_outcome IN ('pending','running','required','confirmed_absent','absence_observed')),
  result_code TEXT CHECK (result_code IN ('credential_unavailable','provider_unavailable','read_verification_failed','metadata_verification_failed','cleanup_unconfirmed','execution_interrupted')),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL AND updated_at >= created_at),
  completed_at TEXT CHECK (completed_at IS NULL OR julianday(completed_at) IS NOT NULL AND completed_at >= created_at AND completed_at <= updated_at),
  UNIQUE (profile_id,probe_key),
  FOREIGN KEY (profile_id,configuration_revision) REFERENCES system_storage_configuration_revisions(profile_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id,configuration_revision,credential_ref) REFERENCES system_storage_credential_descriptors(profile_id,configuration_revision,credential_ref) ON DELETE RESTRICT,
  CHECK ((status = 'running') = (completed_at IS NULL)),
  CHECK (cleanup_outcome <> 'running' OR execution_kind = 'cleanup' AND status <> 'running'),
  CHECK (cleanup_outcome <> 'confirmed_absent' OR write_outcome <> 'unknown'),
  CHECK (status <> 'succeeded' OR write_outcome = 'acknowledged' AND read_outcome = 'verified'
    AND metadata_outcome = 'verified' AND delete_outcome = 'acknowledged' AND cleanup_outcome = 'confirmed_absent' AND result_code IS NULL)
);
CREATE INDEX system_storage_candidate_checks_profile_recent ON system_storage_candidate_checks(profile_id,created_at DESC,id);
CREATE UNIQUE INDEX system_storage_candidate_checks_profile_active ON system_storage_candidate_checks(profile_id) WHERE status = 'running' OR cleanup_outcome = 'running';
CREATE TABLE system_storage_candidate_check_audit (
  id INTEGER PRIMARY KEY,
  check_id TEXT NOT NULL REFERENCES system_storage_candidate_checks(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('accepted','state_updated','cleanup_started')),
  execution_token TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 254),
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','interrupted')),
  write_outcome TEXT NOT NULL CHECK (write_outcome IN ('pending','unknown','acknowledged')),
  read_outcome TEXT NOT NULL CHECK (read_outcome IN ('pending','verified','failed')),
  metadata_outcome TEXT NOT NULL CHECK (metadata_outcome IN ('pending','verified','failed')),
  delete_outcome TEXT NOT NULL CHECK (delete_outcome IN ('pending','acknowledged','failed')),
  cleanup_outcome TEXT NOT NULL CHECK (cleanup_outcome IN ('pending','running','required','confirmed_absent','absence_observed')),
  result_code TEXT CHECK (result_code IN ('credential_unavailable','provider_unavailable','read_verification_failed','metadata_verification_failed','cleanup_unconfirmed','execution_interrupted')),
  created_at TEXT NOT NULL
);
CREATE TRIGGER system_storage_candidate_checks_insert_guard BEFORE INSERT ON system_storage_candidate_checks BEGIN
  SELECT RAISE(ABORT,'FP2 storage check acceptance conflict') WHERE NOT EXISTS (
    SELECT 1 FROM system_storage_profiles p
    JOIN system_storage_configuration_revisions r ON r.profile_id = p.id AND r.revision = p.latest_revision
    JOIN system_storage_credential_payloads e ON e.credential_ref = r.credential_ref
    WHERE p.id = NEW.profile_id AND p.adapter_type = 's3' AND r.revision = NEW.configuration_revision
      AND r.credential_ref = NEW.credential_ref AND r.namespace_json = NEW.namespace_json AND p.namespace_sha256 = NEW.namespace_sha256
      AND e.envelope_revision = NEW.envelope_revision AND e.envelope_version = NEW.envelope_version
      AND e.key_id = NEW.key_id AND e.nonce = NEW.nonce AND e.ciphertext = NEW.ciphertext
  );
  SELECT RAISE(ABORT,'FP2 storage check initial state invalid')
    WHERE NEW.status <> 'running' OR NEW.execution_kind <> 'check' OR NEW.write_outcome <> 'pending'
      OR NEW.read_outcome <> 'pending' OR NEW.metadata_outcome <> 'pending' OR NEW.delete_outcome <> 'pending'
      OR NEW.cleanup_outcome <> 'pending' OR NEW.result_code IS NOT NULL OR NEW.completed_at IS NOT NULL
      OR NEW.created_at IS NOT NEW.updated_at OR NEW.requested_by IS NOT NEW.execution_actor
      OR NEW.execution_deadline <= NEW.updated_at
      OR unixepoch(NEW.execution_deadline) - unixepoch(NEW.updated_at) > 120;
END;
CREATE TRIGGER system_storage_candidate_checks_update_guard BEFORE UPDATE ON system_storage_candidate_checks BEGIN
  SELECT RAISE(ABORT,'FP2 storage check identity is immutable')
    WHERE OLD.id IS NOT NEW.id OR OLD.profile_id IS NOT NEW.profile_id OR OLD.configuration_revision IS NOT NEW.configuration_revision
      OR OLD.credential_ref IS NOT NEW.credential_ref OR OLD.envelope_revision IS NOT NEW.envelope_revision
      OR OLD.namespace_json IS NOT NEW.namespace_json OR OLD.namespace_sha256 IS NOT NEW.namespace_sha256
      OR OLD.configuration_sha256 IS NOT NEW.configuration_sha256 OR OLD.envelope_version IS NOT NEW.envelope_version
      OR OLD.key_id IS NOT NEW.key_id OR OLD.nonce IS NOT NEW.nonce OR OLD.ciphertext IS NOT NEW.ciphertext
      OR OLD.probe_key IS NOT NEW.probe_key OR OLD.payload_sha256 IS NOT NEW.payload_sha256 OR OLD.payload_size IS NOT NEW.payload_size
      OR OLD.requested_by IS NOT NEW.requested_by OR OLD.created_at IS NOT NEW.created_at OR NEW.updated_at < OLD.updated_at;
  SELECT RAISE(ABORT,'FP2 storage check execution conflict')
    WHERE OLD.execution_token IS NOT NEW.execution_token AND (
      OLD.status NOT IN ('failed','interrupted') OR OLD.cleanup_outcome IN ('running','confirmed_absent')
      OR NEW.execution_kind <> 'cleanup' OR NEW.cleanup_outcome <> 'running' OR NEW.status IS NOT OLD.status
      OR NEW.execution_deadline <= NEW.updated_at OR unixepoch(NEW.execution_deadline) - unixepoch(NEW.updated_at) > 120
    );
  SELECT RAISE(ABORT,'FP2 storage check execution conflict')
    WHERE OLD.execution_token IS NEW.execution_token AND (
      OLD.execution_kind IS NOT NEW.execution_kind OR OLD.execution_deadline IS NOT NEW.execution_deadline OR OLD.execution_actor IS NOT NEW.execution_actor
      OR OLD.status <> 'running' AND OLD.cleanup_outcome <> 'running'
      OR NEW.updated_at >= OLD.execution_deadline AND NOT (
        NEW.result_code = 'execution_interrupted' AND (
          OLD.status = 'running' AND NEW.status = 'interrupted'
          OR OLD.cleanup_outcome = 'running' AND NEW.status = OLD.status AND NEW.cleanup_outcome = 'required'
        )
      )
    );
  SELECT RAISE(ABORT,'FP2 storage check terminal evidence is immutable')
    WHERE OLD.status <> 'running' AND (NEW.status IS NOT OLD.status OR OLD.write_outcome IS NOT NEW.write_outcome
      OR OLD.read_outcome IS NOT NEW.read_outcome OR OLD.metadata_outcome IS NOT NEW.metadata_outcome OR OLD.completed_at IS NOT NEW.completed_at);
  SELECT RAISE(ABORT,'FP2 storage check outcome conflict')
    WHERE OLD.status = 'running' AND (
      OLD.write_outcome = 'pending' AND NEW.write_outcome NOT IN ('pending','unknown')
      OR OLD.write_outcome = 'unknown' AND NEW.write_outcome NOT IN ('unknown','acknowledged')
      OR OLD.write_outcome = 'acknowledged' AND NEW.write_outcome <> 'acknowledged'
      OR OLD.read_outcome <> 'pending' AND OLD.read_outcome IS NOT NEW.read_outcome
      OR OLD.metadata_outcome <> 'pending' AND OLD.metadata_outcome IS NOT NEW.metadata_outcome
    );
END;
CREATE TRIGGER system_storage_candidate_checks_delete_guard BEFORE DELETE ON system_storage_candidate_checks BEGIN
  SELECT RAISE(ABORT,'FP2 storage check evidence is retained');
END;
CREATE TRIGGER system_storage_candidate_check_audit_update_guard BEFORE UPDATE ON system_storage_candidate_check_audit BEGIN
  SELECT RAISE(ABORT,'FP2 storage check audit is immutable');
END;
CREATE TRIGGER system_storage_candidate_check_audit_delete_guard BEFORE DELETE ON system_storage_candidate_check_audit BEGIN
  SELECT RAISE(ABORT,'FP2 storage check audit is immutable');
END;
CREATE TRIGGER system_storage_candidate_checks_insert_audit AFTER INSERT ON system_storage_candidate_checks BEGIN
  INSERT INTO system_storage_candidate_check_audit
    (check_id,operation,execution_token,actor,status,write_outcome,read_outcome,metadata_outcome,delete_outcome,cleanup_outcome,result_code,created_at)
    VALUES (NEW.id,'accepted',NEW.execution_token,NEW.execution_actor,NEW.status,NEW.write_outcome,NEW.read_outcome,NEW.metadata_outcome,NEW.delete_outcome,NEW.cleanup_outcome,NEW.result_code,NEW.updated_at);
END;
CREATE TRIGGER system_storage_candidate_checks_update_audit AFTER UPDATE ON system_storage_candidate_checks BEGIN
  INSERT INTO system_storage_candidate_check_audit
    (check_id,operation,execution_token,actor,status,write_outcome,read_outcome,metadata_outcome,delete_outcome,cleanup_outcome,result_code,created_at)
    SELECT NEW.id,'cleanup_started',NEW.execution_token,NEW.execution_actor,NEW.status,NEW.write_outcome,NEW.read_outcome,NEW.metadata_outcome,NEW.delete_outcome,NEW.cleanup_outcome,NEW.result_code,NEW.updated_at
      WHERE OLD.execution_token IS NOT NEW.execution_token;
  INSERT INTO system_storage_candidate_check_audit
    (check_id,operation,execution_token,actor,status,write_outcome,read_outcome,metadata_outcome,delete_outcome,cleanup_outcome,result_code,created_at)
    SELECT NEW.id,'state_updated',NEW.execution_token,NEW.execution_actor,NEW.status,NEW.write_outcome,NEW.read_outcome,NEW.metadata_outcome,NEW.delete_outcome,NEW.cleanup_outcome,NEW.result_code,NEW.updated_at
      WHERE OLD.execution_token IS NEW.execution_token;
END;
