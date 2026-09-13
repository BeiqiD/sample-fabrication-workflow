-- FP1a: dormant identity/legacy observation registry, not a storage cutover.
-- Existing locators and their lifecycle remain authoritative. No new byte writer,
-- verified File publication, default change, or credential migration is enabled.
-- These deliberate state restrictions require a reviewed forward migration when
-- consumer conversion, retention, byte verification and new-file export ship.

CREATE TABLE storage_profiles (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 256 AND instr(id, char(0)) = 0),
  adapter_type TEXT NOT NULL CHECK (adapter_type IN ('r2', 'switchdrive')),
  namespace_identity TEXT NOT NULL CHECK (length(namespace_identity) BETWEEN 1 AND 2048 AND instr(namespace_identity, char(0)) = 0),
  configuration_source TEXT NOT NULL CHECK (configuration_source IN ('bootstrap', 'environment')),
  credential_reference TEXT CHECK (credential_reference IS NULL OR credential_reference = 'environment:SWITCHDRIVE'),
  configuration_revision INTEGER NOT NULL CHECK (typeof(configuration_revision) = 'integer' AND configuration_revision = 1),
  state TEXT NOT NULL CHECK (state = 'historical'),
  created_at TEXT NOT NULL,
  UNIQUE (adapter_type, namespace_identity),
  CHECK ((adapter_type = 'r2' AND configuration_source = 'bootstrap' AND credential_reference IS NULL)
    OR (adapter_type = 'switchdrive' AND configuration_source = 'environment' AND credential_reference IS 'environment:SWITCHDRIVE'))
);

CREATE TABLE files (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 256 AND instr(id, char(0)) = 0),
  purpose TEXT CHECK (purpose IS NULL OR purpose IN ('research_source', 'embedded_content', 'derived_preview', 'provenance', 'job_output')),
  access_scope TEXT NOT NULL CHECK (access_scope = 'system'),
  expected_byte_size INTEGER CHECK (expected_byte_size IS NULL OR (typeof(expected_byte_size) = 'integer' AND expected_byte_size BETWEEN 0 AND 9007199254740991)),
  expected_sha256 TEXT CHECK (expected_sha256 IS NULL OR (length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*' AND instr(expected_sha256, char(0)) = 0)),
  verified_sha256 TEXT CHECK (verified_sha256 IS NULL),
  state TEXT NOT NULL CHECK (state = 'unresolved'),
  active_location_id TEXT CHECK (active_location_id IS NULL),
  created_at TEXT NOT NULL
);

CREATE TABLE file_locations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 256 AND instr(id, char(0)) = 0),
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  storage_profile_id TEXT NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 4096 AND instr(object_key, char(0)) = 0),
  state TEXT NOT NULL CHECK (state = 'unresolved'),
  created_at TEXT NOT NULL,
  UNIQUE (storage_profile_id, object_key),
  UNIQUE (id, file_id, object_key)
);

CREATE TABLE legacy_file_mappings (
  store_kind TEXT NOT NULL CHECK (store_kind IN ('r2', 'managed')),
  provider TEXT NOT NULL CHECK ((store_kind = 'r2' AND provider = 'r2') OR (store_kind = 'managed' AND provider = 'switchdrive')),
  object_key TEXT NOT NULL,
  file_id TEXT NOT NULL UNIQUE REFERENCES files(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL UNIQUE,
  classification TEXT NOT NULL CHECK (classification IN ('classified', 'ambiguous', 'unclassified')),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (store_kind, provider, object_key),
  FOREIGN KEY (location_id, file_id, object_key) REFERENCES file_locations(id, file_id, object_key) ON DELETE RESTRICT
);

CREATE INDEX file_locations_file_idx ON file_locations(file_id);

CREATE TRIGGER storage_profiles_immutable
BEFORE UPDATE ON storage_profiles BEGIN
  SELECT RAISE(ABORT, 'FP1 overlap profiles are immutable; namespace changes require a new identity');
END;

CREATE TRIGGER files_immutable
BEFORE UPDATE ON files BEGIN
  SELECT RAISE(ABORT, 'FP1 overlap file observations are immutable');
END;

CREATE TRIGGER file_locations_immutable
BEFORE UPDATE ON file_locations BEGIN
  SELECT RAISE(ABORT, 'FP1 overlap location observations are immutable');
END;

CREATE TRIGGER legacy_file_mappings_immutable
BEFORE UPDATE ON legacy_file_mappings BEGIN
  SELECT RAISE(ABORT, 'FP1 overlap mappings are immutable');
END;

CREATE TRIGGER legacy_file_mappings_profile_guard
BEFORE INSERT ON legacy_file_mappings BEGIN
  SELECT RAISE(ABORT, 'Legacy mapping profile or purpose mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM file_locations l
    JOIN storage_profiles p ON p.id = l.storage_profile_id
    JOIN files f ON f.id = l.file_id
    WHERE l.id = NEW.location_id AND l.file_id = NEW.file_id AND l.object_key = NEW.object_key
      AND p.adapter_type = NEW.provider
      AND ((NEW.classification = 'classified' AND f.purpose IS NOT NULL)
        OR (NEW.classification <> 'classified' AND f.purpose IS NULL))
  );
END;

CREATE TRIGGER storage_profiles_insert_identity_guard
BEFORE INSERT ON storage_profiles BEGIN
  SELECT RAISE(IGNORE) WHERE EXISTS (SELECT 1 FROM storage_profiles WHERE id IS NEW.id AND adapter_type IS NEW.adapter_type AND namespace_identity IS NEW.namespace_identity AND configuration_source IS NEW.configuration_source AND credential_reference IS NEW.credential_reference AND configuration_revision IS NEW.configuration_revision AND state IS NEW.state AND created_at IS NEW.created_at);
  SELECT RAISE(ABORT, 'FP1 immutable identity conflict')
  WHERE EXISTS (SELECT 1 FROM storage_profiles WHERE id = NEW.id OR (adapter_type = NEW.adapter_type AND namespace_identity = NEW.namespace_identity));
END;

CREATE TRIGGER storage_profiles_delete_guard
BEFORE DELETE ON storage_profiles BEGIN
  SELECT RAISE(ABORT, 'FP1 overlap observations cannot be deleted');
END;

CREATE TRIGGER files_insert_identity_guard
BEFORE INSERT ON files BEGIN
  SELECT RAISE(IGNORE) WHERE EXISTS (SELECT 1 FROM files WHERE id IS NEW.id AND purpose IS NEW.purpose AND access_scope IS NEW.access_scope AND expected_byte_size IS NEW.expected_byte_size AND expected_sha256 IS NEW.expected_sha256 AND verified_sha256 IS NEW.verified_sha256 AND state IS NEW.state AND active_location_id IS NEW.active_location_id AND created_at IS NEW.created_at);
  SELECT RAISE(ABORT, 'FP1 immutable identity conflict')
  WHERE EXISTS (SELECT 1 FROM files WHERE id = NEW.id);
END;

CREATE TRIGGER files_delete_guard
BEFORE DELETE ON files BEGIN
  SELECT RAISE(ABORT, 'FP1 overlap observations cannot be deleted');
END;

CREATE TRIGGER file_locations_insert_identity_guard
BEFORE INSERT ON file_locations BEGIN
  SELECT RAISE(IGNORE) WHERE EXISTS (SELECT 1 FROM file_locations WHERE id IS NEW.id AND file_id IS NEW.file_id AND storage_profile_id IS NEW.storage_profile_id AND object_key IS NEW.object_key AND state IS NEW.state AND created_at IS NEW.created_at);
  SELECT RAISE(ABORT, 'FP1 immutable identity conflict')
  WHERE EXISTS (SELECT 1 FROM file_locations WHERE id = NEW.id OR (storage_profile_id = NEW.storage_profile_id AND object_key = NEW.object_key));
END;

CREATE TRIGGER file_locations_delete_guard
BEFORE DELETE ON file_locations BEGIN
  SELECT RAISE(ABORT, 'FP1 overlap observations cannot be deleted');
END;

CREATE TRIGGER legacy_file_mappings_insert_identity_guard
BEFORE INSERT ON legacy_file_mappings BEGIN
  SELECT RAISE(IGNORE) WHERE EXISTS (SELECT 1 FROM legacy_file_mappings WHERE store_kind IS NEW.store_kind AND provider IS NEW.provider AND object_key IS NEW.object_key AND file_id IS NEW.file_id AND location_id IS NEW.location_id AND classification IS NEW.classification AND evidence_json IS NEW.evidence_json AND observed_at IS NEW.observed_at);
  SELECT RAISE(ABORT, 'FP1 immutable identity conflict')
  WHERE EXISTS (SELECT 1 FROM legacy_file_mappings WHERE (store_kind = NEW.store_kind AND provider = NEW.provider AND object_key = NEW.object_key) OR file_id = NEW.file_id OR location_id = NEW.location_id);
END;

CREATE TRIGGER legacy_file_mappings_delete_guard
BEFORE DELETE ON legacy_file_mappings BEGIN
  SELECT RAISE(ABORT, 'FP1 overlap observations cannot be deleted');
END;
