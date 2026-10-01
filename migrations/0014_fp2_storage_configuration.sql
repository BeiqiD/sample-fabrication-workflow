-- FP2 candidate registry only. Native profiles, accepted operations, role
-- defaults and File authority are unchanged. These system tables are excluded
-- from ordinary content archives; protected payloads point back to descriptors.
CREATE TABLE system_storage_profiles (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 256),
  adapter_type TEXT NOT NULL CHECK (adapter_type IN ('s3','webdav','switchdrive')),
  namespace_json TEXT NOT NULL CHECK (json_valid(namespace_json) AND json_type(namespace_json) = 'object'),
  namespace_sha256 TEXT NOT NULL CHECK (length(namespace_sha256) = 64 AND namespace_sha256 NOT GLOB '*[^0-9a-f]*'),
  latest_revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(latest_revision) = 'integer' AND latest_revision >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (adapter_type,namespace_sha256),
  UNIQUE (id,namespace_sha256)
);
CREATE TABLE system_storage_credential_descriptors (
  credential_ref TEXT PRIMARY KEY NOT NULL,
  profile_id TEXT NOT NULL,
  configuration_revision INTEGER NOT NULL CHECK (typeof(configuration_revision) = 'integer' AND configuration_revision > 0),
  namespace_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (profile_id,configuration_revision,credential_ref),
  FOREIGN KEY (profile_id,namespace_sha256) REFERENCES system_storage_profiles(id,namespace_sha256) ON DELETE RESTRICT
);
CREATE TABLE system_storage_credential_payloads (
  credential_ref TEXT PRIMARY KEY NOT NULL REFERENCES system_storage_credential_descriptors(credential_ref) ON DELETE RESTRICT,
  envelope_revision INTEGER NOT NULL CHECK (typeof(envelope_revision) = 'integer' AND envelope_revision > 0),
  envelope_version INTEGER NOT NULL CHECK (envelope_version = 1),
  key_id TEXT NOT NULL CHECK (length(key_id) BETWEEN 1 AND 64),
  nonce TEXT NOT NULL CHECK (length(nonce) = 16),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 25 AND 43716)
);
CREATE TABLE system_storage_configuration_revisions (
  profile_id TEXT NOT NULL REFERENCES system_storage_profiles(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 160),
  namespace_json TEXT NOT NULL CHECK (json_valid(namespace_json) AND json_type(namespace_json) = 'object'),
  credential_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 254),
  PRIMARY KEY (profile_id,revision),
  FOREIGN KEY (profile_id,revision,credential_ref) REFERENCES system_storage_credential_descriptors(profile_id,configuration_revision,credential_ref) ON DELETE RESTRICT
);
CREATE TABLE system_storage_configuration_audit (
  id TEXT PRIMARY KEY NOT NULL,
  profile_id TEXT NOT NULL,
  configuration_revision INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 254),
  operation TEXT NOT NULL CHECK (operation IN ('candidate_create','candidate_revise')),
  outcome TEXT NOT NULL CHECK (outcome = 'saved'),
  created_at TEXT NOT NULL,
  FOREIGN KEY (profile_id,configuration_revision) REFERENCES system_storage_configuration_revisions(profile_id,revision) ON DELETE RESTRICT
);
CREATE TRIGGER system_storage_profiles_insert_guard BEFORE INSERT ON system_storage_profiles BEGIN
  SELECT RAISE(ABORT,'FP2 candidate revision conflict') WHERE NEW.latest_revision <> 0;
END;
CREATE TRIGGER system_storage_profiles_update_guard BEFORE UPDATE ON system_storage_profiles BEGIN
  SELECT RAISE(ABORT,'FP2 profile namespace is immutable')
    WHERE OLD.id IS NOT NEW.id OR OLD.adapter_type IS NOT NEW.adapter_type OR OLD.namespace_json IS NOT NEW.namespace_json
      OR OLD.namespace_sha256 IS NOT NEW.namespace_sha256 OR OLD.created_at IS NOT NEW.created_at;
  SELECT RAISE(ABORT,'FP2 candidate revision conflict')
    WHERE NEW.latest_revision <> OLD.latest_revision + 1
      OR NOT EXISTS (SELECT 1 FROM system_storage_configuration_revisions r WHERE r.profile_id = NEW.id AND r.revision = NEW.latest_revision);
END;
CREATE TRIGGER system_storage_configuration_revision_guard BEFORE INSERT ON system_storage_configuration_revisions BEGIN
  SELECT RAISE(ABORT,'FP2 candidate revision conflict')
    WHERE NOT EXISTS (SELECT 1 FROM system_storage_profiles p WHERE p.id = NEW.profile_id AND p.latest_revision + 1 = NEW.revision);
  SELECT RAISE(ABORT,'FP2 profile namespace is immutable')
    WHERE NOT EXISTS (SELECT 1 FROM system_storage_profiles p WHERE p.id = NEW.profile_id
      AND p.adapter_type IS json_extract(NEW.namespace_json,'$.kind')
      AND json_extract(p.namespace_json,'$.endpoint') IS json_extract(NEW.namespace_json,'$.endpoint')
      AND json_extract(p.namespace_json,'$.root') IS json_extract(NEW.namespace_json,'$.root')
      AND json_extract(p.namespace_json,'$.bucket') IS json_extract(NEW.namespace_json,'$.bucket'));
END;
CREATE TRIGGER system_storage_configuration_revision_head AFTER INSERT ON system_storage_configuration_revisions BEGIN
  UPDATE system_storage_profiles SET latest_revision = NEW.revision WHERE id = NEW.profile_id;
END;
CREATE TRIGGER system_storage_configuration_revisions_immutable BEFORE UPDATE ON system_storage_configuration_revisions BEGIN
  SELECT RAISE(ABORT,'FP2 candidate revisions are immutable');
END;
CREATE TRIGGER system_storage_credential_descriptors_immutable BEFORE UPDATE ON system_storage_credential_descriptors BEGIN
  SELECT RAISE(ABORT,'FP2 credential descriptors are immutable');
END;
CREATE TRIGGER system_storage_credential_payloads_update_guard BEFORE UPDATE ON system_storage_credential_payloads BEGIN
  SELECT RAISE(ABORT,'FP2 credential envelope revision conflict')
    WHERE OLD.credential_ref IS NOT NEW.credential_ref OR NEW.envelope_revision <> OLD.envelope_revision + 1;
END;
CREATE TRIGGER system_storage_configuration_audit_immutable BEFORE UPDATE ON system_storage_configuration_audit BEGIN
  SELECT RAISE(ABORT,'FP2 configuration audit is immutable');
END;
CREATE TRIGGER system_storage_profiles_delete_guard BEFORE DELETE ON system_storage_profiles BEGIN
  SELECT RAISE(ABORT,'FP2 profile identities are retained');
END;
CREATE TRIGGER system_storage_configuration_revisions_delete_guard BEFORE DELETE ON system_storage_configuration_revisions BEGIN
  SELECT RAISE(ABORT,'FP2 candidate revisions are immutable');
END;
CREATE TRIGGER system_storage_credential_descriptors_delete_guard BEFORE DELETE ON system_storage_credential_descriptors BEGIN
  SELECT RAISE(ABORT,'FP2 credential descriptors are retained');
END;
CREATE TRIGGER system_storage_credential_payloads_delete_guard BEFORE DELETE ON system_storage_credential_payloads BEGIN
  SELECT RAISE(ABORT,'FP2 credential payloads are retained');
END;
CREATE TRIGGER system_storage_configuration_audit_delete_guard BEFORE DELETE ON system_storage_configuration_audit BEGIN
  SELECT RAISE(ABORT,'FP2 configuration audit is immutable');
END;
