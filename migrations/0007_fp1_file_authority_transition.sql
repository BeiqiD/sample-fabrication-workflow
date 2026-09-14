-- FP1 authority expand boundary. This migration installs the complete typed
-- consumer and lifecycle substrate, but the current Worker remains in legacy
-- mode. No historical locator is backfilled, no byte is inferred to be
-- verified, and no File relationship becomes authoritative in this release.

CREATE TABLE file_authority_control (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  mode TEXT NOT NULL CHECK (mode IN ('legacy', 'overlap', 'active')),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision = 1),
  updated_at TEXT NOT NULL CHECK (typeof(updated_at) = 'text' AND length(updated_at) BETWEEN 1 AND 200 AND instr(updated_at, char(0)) = 0 AND datetime(updated_at) IS NOT NULL),
  activated_at TEXT CHECK (activated_at IS NULL OR (typeof(activated_at) = 'text' AND length(activated_at) BETWEEN 1 AND 200 AND instr(activated_at, char(0)) = 0 AND datetime(activated_at) IS NOT NULL)),
  CHECK ((mode = 'legacy' AND activated_at IS NULL) OR (mode <> 'legacy' AND activated_at IS NOT NULL))
) WITHOUT ROWID;

INSERT INTO file_authority_control (singleton, mode, revision, updated_at, activated_at)
VALUES (1, 'legacy', 1, '2026-09-14T00:00:00.000Z', NULL);

CREATE TRIGGER file_authority_control_insert_guard
BEFORE INSERT ON file_authority_control BEGIN
  SELECT RAISE(ABORT, 'File authority control is a migration-owned singleton');
END;

CREATE TRIGGER file_authority_control_update_guard
BEFORE UPDATE ON file_authority_control BEGIN
  SELECT RAISE(ABORT, 'File authority mode changes require a reviewed forward migration');
END;

CREATE TRIGGER file_authority_control_delete_guard
BEFORE DELETE ON file_authority_control BEGIN
  SELECT RAISE(ABORT, 'File authority control cannot be deleted');
END;

CREATE TABLE storage_profile_runtime (
  storage_profile_id TEXT PRIMARY KEY NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('read_only', 'read_write', 'retired')),
  -- This mirrors storage_profiles.created_at, whose historical contract is
  -- only TEXT NOT NULL. Expand must not reject an already-valid source row.
  registered_at TEXT NOT NULL,
  activated_at TEXT CHECK (activated_at IS NULL OR (typeof(activated_at) = 'text' AND length(activated_at) BETWEEN 1 AND 200 AND instr(activated_at, char(0)) = 0 AND datetime(activated_at) IS NOT NULL)),
  retired_at TEXT CHECK (retired_at IS NULL OR (typeof(retired_at) = 'text' AND length(retired_at) BETWEEN 1 AND 200 AND instr(retired_at, char(0)) = 0 AND datetime(retired_at) IS NOT NULL)),
  CHECK ((state = 'read_only' AND activated_at IS NULL AND retired_at IS NULL)
    OR (state = 'read_write' AND activated_at IS NOT NULL AND retired_at IS NULL)
    OR (state = 'retired' AND retired_at IS NOT NULL))
) WITHOUT ROWID;

INSERT INTO storage_profile_runtime (storage_profile_id, state, registered_at, activated_at, retired_at)
SELECT id, 'read_only', created_at, NULL, NULL FROM storage_profiles;

CREATE TRIGGER storage_profile_runtime_seed
AFTER INSERT ON storage_profiles BEGIN
  INSERT INTO storage_profile_runtime (storage_profile_id, state, registered_at, activated_at, retired_at)
  VALUES (NEW.id, 'read_only', NEW.created_at, NULL, NULL);
END;

CREATE TRIGGER storage_profile_runtime_insert_guard
BEFORE INSERT ON storage_profile_runtime BEGIN
  SELECT RAISE(ABORT, 'Storage profile runtime rows are created with profile identities')
  WHERE NOT EXISTS (SELECT 1 FROM storage_profiles WHERE id = NEW.storage_profile_id)
    OR EXISTS (SELECT 1 FROM storage_profile_runtime WHERE storage_profile_id = NEW.storage_profile_id)
    OR NEW.state <> 'read_only' OR NEW.activated_at IS NOT NULL OR NEW.retired_at IS NOT NULL
    OR NEW.registered_at IS NOT (SELECT created_at FROM storage_profiles WHERE id = NEW.storage_profile_id);
END;

CREATE TRIGGER storage_profile_runtime_legacy_update_guard
BEFORE UPDATE ON storage_profile_runtime BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority cannot change profile runtime state');
END;

CREATE TRIGGER storage_profile_runtime_delete_guard
BEFORE DELETE ON storage_profile_runtime BEGIN
  SELECT RAISE(ABORT, 'Storage profile runtime history cannot be deleted');
END;

-- Typed business relationships are nullable during expand so every explicit
-- INSERT emitted by the preceding Worker continues to work unchanged.
ALTER TABLE state_representation_assets ADD COLUMN file_id TEXT REFERENCES files(id) ON DELETE RESTRICT;
ALTER TABLE run_step_assets ADD COLUMN file_id TEXT REFERENCES files(id) ON DELETE RESTRICT;
ALTER TABLE metrology_template_references ADD COLUMN file_id TEXT REFERENCES files(id) ON DELETE RESTRICT;
ALTER TABLE run_step_comments ADD COLUMN file_id TEXT REFERENCES files(id) ON DELETE RESTRICT;
ALTER TABLE state_verifications ADD COLUMN evidence_file_id TEXT REFERENCES files(id) ON DELETE RESTRICT;
ALTER TABLE comment_submission_items ADD COLUMN file_id TEXT REFERENCES files(id) ON DELETE RESTRICT;
ALTER TABLE project_content_attachments ADD COLUMN file_id TEXT REFERENCES files(id) ON DELETE RESTRICT;
ALTER TABLE attachment_derivatives ADD COLUMN derived_file_id TEXT REFERENCES files(id) ON DELETE RESTRICT;
ALTER TABLE events ADD COLUMN asset_file_id TEXT REFERENCES files(id) ON DELETE RESTRICT;
ALTER TABLE events ADD COLUMN thumbnail_file_id TEXT REFERENCES files(id) ON DELETE RESTRICT;
ALTER TABLE imports ADD COLUMN workbook_file_id TEXT REFERENCES files(id) ON DELETE RESTRICT;
ALTER TABLE imports ADD COLUMN manifest_file_id TEXT REFERENCES files(id) ON DELETE RESTRICT;
ALTER TABLE template_versions ADD COLUMN source_file_id TEXT REFERENCES files(id) ON DELETE RESTRICT;

CREATE INDEX state_representation_assets_file_idx ON state_representation_assets(file_id);
CREATE INDEX run_step_assets_file_idx ON run_step_assets(file_id);
CREATE INDEX metrology_template_references_file_idx ON metrology_template_references(file_id);
CREATE INDEX run_step_comments_file_idx ON run_step_comments(file_id);
CREATE INDEX state_verifications_evidence_file_idx ON state_verifications(evidence_file_id);
CREATE INDEX comment_submission_items_file_idx ON comment_submission_items(file_id);
CREATE INDEX project_content_attachments_file_idx ON project_content_attachments(file_id);
CREATE INDEX attachment_derivatives_file_idx ON attachment_derivatives(derived_file_id);
CREATE INDEX events_asset_file_idx ON events(asset_file_id);
CREATE INDEX events_thumbnail_file_idx ON events(thumbnail_file_id);
CREATE INDEX imports_workbook_file_idx ON imports(workbook_file_id);
CREATE INDEX imports_manifest_file_idx ON imports(manifest_file_id);
CREATE INDEX template_versions_source_file_idx ON template_versions(source_file_id);
CREATE UNIQUE INDEX file_locations_authority_identity_idx
ON file_locations(id, file_id, storage_profile_id, object_key);

CREATE TABLE file_location_publications (
  location_id TEXT PRIMARY KEY NOT NULL REFERENCES file_locations(id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  storage_profile_id TEXT NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 4096 AND instr(object_key, char(0)) = 0),
  verified_byte_size INTEGER NOT NULL CHECK (typeof(verified_byte_size) = 'integer' AND verified_byte_size BETWEEN 0 AND 9007199254740991),
  verified_sha256 TEXT NOT NULL CHECK (typeof(verified_sha256) = 'text' AND length(verified_sha256) = 64 AND verified_sha256 NOT GLOB '*[^0-9a-f]*' AND instr(verified_sha256, char(0)) = 0),
  verification_method TEXT NOT NULL CHECK (verification_method = 'full_read_sha256'),
  verification_operation_id TEXT NOT NULL CHECK (length(verification_operation_id) BETWEEN 1 AND 256 AND instr(verification_operation_id, char(0)) = 0),
  verified_at TEXT NOT NULL CHECK (typeof(verified_at) = 'text' AND length(verified_at) BETWEEN 1 AND 200 AND instr(verified_at, char(0)) = 0 AND datetime(verified_at) IS NOT NULL),
  published_at TEXT NOT NULL CHECK (typeof(published_at) = 'text' AND length(published_at) BETWEEN 1 AND 200 AND instr(published_at, char(0)) = 0 AND datetime(published_at) IS NOT NULL),
  UNIQUE (location_id, file_id),
  UNIQUE (storage_profile_id, object_key),
  FOREIGN KEY (location_id, file_id, storage_profile_id, object_key)
    REFERENCES file_locations(id, file_id, storage_profile_id, object_key) ON DELETE RESTRICT,
  CHECK (julianday(published_at) >= julianday(verified_at))
) WITHOUT ROWID;

CREATE TABLE file_publications (
  file_id TEXT PRIMARY KEY NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (purpose IN ('research_source', 'embedded_content', 'derived_preview', 'provenance', 'job_output')),
  access_scope TEXT NOT NULL CHECK (access_scope = 'system'),
  verified_byte_size INTEGER NOT NULL CHECK (typeof(verified_byte_size) = 'integer' AND verified_byte_size BETWEEN 0 AND 9007199254740991),
  verified_sha256 TEXT NOT NULL CHECK (typeof(verified_sha256) = 'text' AND length(verified_sha256) = 64 AND verified_sha256 NOT GLOB '*[^0-9a-f]*' AND instr(verified_sha256, char(0)) = 0),
  active_location_id TEXT REFERENCES file_location_publications(location_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('ready', 'retired')),
  published_at TEXT NOT NULL CHECK (typeof(published_at) = 'text' AND length(published_at) BETWEEN 1 AND 200 AND instr(published_at, char(0)) = 0 AND datetime(published_at) IS NOT NULL),
  retired_at TEXT CHECK (retired_at IS NULL OR (typeof(retired_at) = 'text' AND length(retired_at) BETWEEN 1 AND 200 AND instr(retired_at, char(0)) = 0 AND datetime(retired_at) IS NOT NULL)),
  UNIQUE (active_location_id),
  FOREIGN KEY (active_location_id, file_id) REFERENCES file_location_publications(location_id, file_id) ON DELETE RESTRICT,
  CHECK ((state = 'ready' AND active_location_id IS NOT NULL AND retired_at IS NULL)
    OR (state = 'retired' AND active_location_id IS NULL AND retired_at IS NOT NULL
      AND julianday(retired_at) >= julianday(published_at)))
) WITHOUT ROWID;

CREATE TABLE file_holds (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 256 AND instr(id, char(0)) = 0),
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  hold_kind TEXT NOT NULL CHECK (hold_kind IN ('registration', 'accepted_operation', 'transition_source', 'transition_destination', 'export', 'read', 'cleanup', 'recovery', 'operator')),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256 AND instr(operation_id, char(0)) = 0),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000 AND instr(reason, char(0)) = 0),
  acquired_at TEXT NOT NULL CHECK (typeof(acquired_at) = 'text' AND length(acquired_at) BETWEEN 1 AND 200 AND instr(acquired_at, char(0)) = 0 AND datetime(acquired_at) IS NOT NULL),
  expires_at TEXT CHECK (expires_at IS NULL OR (typeof(expires_at) = 'text' AND length(expires_at) BETWEEN 1 AND 200 AND instr(expires_at, char(0)) = 0 AND datetime(expires_at) IS NOT NULL)),
  released_at TEXT CHECK (released_at IS NULL OR (typeof(released_at) = 'text' AND length(released_at) BETWEEN 1 AND 200 AND instr(released_at, char(0)) = 0 AND datetime(released_at) IS NOT NULL)),
  UNIQUE (file_id, operation_id),
  CHECK (expires_at IS NULL OR (datetime(expires_at) IS NOT NULL AND datetime(expires_at) > datetime(acquired_at))),
  CHECK (released_at IS NULL OR (datetime(released_at) IS NOT NULL AND datetime(released_at) >= datetime(acquired_at)))
) WITHOUT ROWID;

CREATE TABLE file_location_holds (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 256 AND instr(id, char(0)) = 0),
  location_id TEXT NOT NULL REFERENCES file_locations(id) ON DELETE RESTRICT,
  hold_kind TEXT NOT NULL CHECK (hold_kind IN ('registration', 'accepted_operation', 'transition_source', 'transition_destination', 'export', 'read', 'cleanup', 'recovery', 'operator')),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256 AND instr(operation_id, char(0)) = 0),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000 AND instr(reason, char(0)) = 0),
  acquired_at TEXT NOT NULL CHECK (typeof(acquired_at) = 'text' AND length(acquired_at) BETWEEN 1 AND 200 AND instr(acquired_at, char(0)) = 0 AND datetime(acquired_at) IS NOT NULL),
  expires_at TEXT CHECK (expires_at IS NULL OR (typeof(expires_at) = 'text' AND length(expires_at) BETWEEN 1 AND 200 AND instr(expires_at, char(0)) = 0 AND datetime(expires_at) IS NOT NULL)),
  released_at TEXT CHECK (released_at IS NULL OR (typeof(released_at) = 'text' AND length(released_at) BETWEEN 1 AND 200 AND instr(released_at, char(0)) = 0 AND datetime(released_at) IS NOT NULL)),
  UNIQUE (location_id, operation_id),
  CHECK (expires_at IS NULL OR (datetime(expires_at) IS NOT NULL AND datetime(expires_at) > datetime(acquired_at))),
  CHECK (released_at IS NULL OR (datetime(released_at) IS NOT NULL AND datetime(released_at) >= datetime(acquired_at)))
) WITHOUT ROWID;

CREATE TABLE file_location_gc_ledger (
  location_id TEXT PRIMARY KEY NOT NULL REFERENCES file_locations(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('orphaned', 'deleting', 'deleted')),
  operation_id TEXT CHECK (operation_id IS NULL OR (length(operation_id) BETWEEN 1 AND 256 AND instr(operation_id, char(0)) = 0)),
  orphaned_at TEXT NOT NULL CHECK (typeof(orphaned_at) = 'text' AND length(orphaned_at) BETWEEN 1 AND 200 AND instr(orphaned_at, char(0)) = 0 AND datetime(orphaned_at) IS NOT NULL),
  deletion_started_at TEXT CHECK (deletion_started_at IS NULL OR (typeof(deletion_started_at) = 'text' AND length(deletion_started_at) BETWEEN 1 AND 200 AND instr(deletion_started_at, char(0)) = 0 AND datetime(deletion_started_at) IS NOT NULL)),
  deleted_at TEXT CHECK (deleted_at IS NULL OR (typeof(deleted_at) = 'text' AND length(deleted_at) BETWEEN 1 AND 200 AND instr(deleted_at, char(0)) = 0 AND datetime(deleted_at) IS NOT NULL)),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
  last_error TEXT CHECK (last_error IS NULL OR (length(last_error) BETWEEN 1 AND 4000 AND instr(last_error, char(0)) = 0)),
  updated_at TEXT NOT NULL CHECK (typeof(updated_at) = 'text' AND length(updated_at) BETWEEN 1 AND 200 AND instr(updated_at, char(0)) = 0 AND datetime(updated_at) IS NOT NULL),
  CHECK ((state = 'orphaned' AND operation_id IS NULL AND deletion_started_at IS NULL AND deleted_at IS NULL
      AND attempt_count = 0 AND last_error IS NULL AND updated_at = orphaned_at)
    OR (state = 'deleting' AND operation_id IS NOT NULL AND datetime(deletion_started_at) IS NOT NULL
      AND deleted_at IS NULL AND attempt_count > 0 AND datetime(updated_at) >= datetime(deletion_started_at))
    OR (state = 'deleted' AND operation_id IS NOT NULL AND datetime(deletion_started_at) IS NOT NULL
      AND datetime(deleted_at) IS NOT NULL AND attempt_count > 0 AND last_error IS NULL
      AND updated_at = deleted_at AND datetime(deleted_at) >= datetime(deletion_started_at)))
) WITHOUT ROWID;

CREATE TABLE file_location_integrity_quarantine (
  location_id TEXT PRIMARY KEY NOT NULL REFERENCES file_locations(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('missing', 'size_mismatch', 'hash_mismatch', 'external_modification')),
  expected_byte_size INTEGER NOT NULL CHECK (typeof(expected_byte_size) = 'integer' AND expected_byte_size BETWEEN 0 AND 9007199254740991),
  observed_byte_size INTEGER CHECK (observed_byte_size IS NULL OR (typeof(observed_byte_size) = 'integer' AND observed_byte_size BETWEEN 0 AND 9007199254740991)),
  expected_sha256 TEXT NOT NULL CHECK (typeof(expected_sha256) = 'text' AND length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*' AND instr(expected_sha256, char(0)) = 0),
  observed_sha256 TEXT CHECK (observed_sha256 IS NULL OR (typeof(observed_sha256) = 'text' AND length(observed_sha256) = 64 AND observed_sha256 NOT GLOB '*[^0-9a-f]*' AND instr(observed_sha256, char(0)) = 0)),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256 AND instr(operation_id, char(0)) = 0),
  detected_at TEXT NOT NULL CHECK (typeof(detected_at) = 'text' AND length(detected_at) BETWEEN 1 AND 200 AND instr(detected_at, char(0)) = 0 AND datetime(detected_at) IS NOT NULL),
  last_checked_at TEXT NOT NULL CHECK (typeof(last_checked_at) = 'text' AND length(last_checked_at) BETWEEN 1 AND 200 AND instr(last_checked_at, char(0)) = 0 AND datetime(last_checked_at) IS NOT NULL AND julianday(last_checked_at) >= julianday(detected_at)),
  CHECK ((reason = 'missing' AND observed_byte_size IS NULL AND observed_sha256 IS NULL)
    OR (reason = 'size_mismatch' AND observed_byte_size IS NOT NULL
      AND observed_byte_size <> expected_byte_size AND observed_sha256 IS NULL)
    OR (reason = 'hash_mismatch' AND observed_byte_size = expected_byte_size
      AND observed_sha256 IS NOT NULL AND observed_sha256 <> expected_sha256)
    OR (reason = 'external_modification' AND observed_byte_size IS NOT NULL AND (
      observed_byte_size <> expected_byte_size
      OR (observed_byte_size = expected_byte_size AND observed_sha256 IS NOT NULL
        AND observed_sha256 <> expected_sha256))))
) WITHOUT ROWID;

CREATE TABLE file_derivations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 256 AND instr(id, char(0)) = 0),
  source_file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  derived_file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  generator TEXT NOT NULL CHECK (length(generator) BETWEEN 1 AND 256 AND instr(generator, char(0)) = 0),
  generator_version TEXT NOT NULL CHECK (length(generator_version) BETWEEN 1 AND 256 AND instr(generator_version, char(0)) = 0),
  parameters_sha256 TEXT NOT NULL CHECK (typeof(parameters_sha256) = 'text' AND length(parameters_sha256) = 64 AND parameters_sha256 NOT GLOB '*[^0-9a-f]*' AND instr(parameters_sha256, char(0)) = 0),
  trust_state TEXT NOT NULL CHECK (trust_state IN ('unverified', 'verified')),
  source_verified_sha256 TEXT,
  derived_verified_sha256 TEXT,
  verification_operation_id TEXT,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object' AND length(CAST(evidence_json AS BLOB)) <= 16384),
  created_at TEXT NOT NULL CHECK (typeof(created_at) = 'text' AND length(created_at) BETWEEN 1 AND 200 AND instr(created_at, char(0)) = 0 AND datetime(created_at) IS NOT NULL),
  UNIQUE (source_file_id, derived_file_id, generator, generator_version, parameters_sha256),
  CHECK (source_file_id <> derived_file_id),
  CHECK ((trust_state = 'unverified' AND source_verified_sha256 IS NULL AND derived_verified_sha256 IS NULL AND verification_operation_id IS NULL)
    OR (trust_state = 'verified' AND typeof(source_verified_sha256) = 'text'
      AND length(source_verified_sha256) = 64 AND source_verified_sha256 NOT GLOB '*[^0-9a-f]*'
      AND instr(source_verified_sha256, char(0)) = 0 AND typeof(derived_verified_sha256) = 'text'
      AND length(derived_verified_sha256) = 64 AND derived_verified_sha256 NOT GLOB '*[^0-9a-f]*'
      AND instr(derived_verified_sha256, char(0)) = 0 AND verification_operation_id IS NOT NULL
      AND length(verification_operation_id) BETWEEN 1 AND 256 AND instr(verification_operation_id, char(0)) = 0))
) WITHOUT ROWID;

CREATE TABLE file_consumer_migration_decisions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 256 AND instr(id, char(0)) = 0),
  consumer_kind TEXT NOT NULL CHECK (consumer_kind IN ('state_representation_asset', 'run_step_asset', 'metrology_template_reference', 'run_step_comment', 'state_verification', 'comment_submission_item', 'project_content_attachment', 'attachment_derivative', 'event', 'import', 'template_version')),
  -- These fields copy pre-existing identifiers and locator evidence exactly.
  -- The S2 schema did not bound or reject NUL in every source column, so the
  -- decision ledger must be able to admit an otherwise valid pathological row.
  consumer_id TEXT NOT NULL,
  consumer_sub_id TEXT NOT NULL DEFAULT '',
  file_slot TEXT NOT NULL CHECK (file_slot IN ('primary', 'evidence', 'derived', 'thumbnail', 'workbook', 'manifest', 'source')),
  decision TEXT NOT NULL CHECK (decision IN ('resolved', 'admitted_unresolved')),
  file_id TEXT REFERENCES files(id) ON DELETE RESTRICT,
  reason TEXT CHECK (reason IS NULL OR instr(reason, char(0)) = 0),
  source_row_sha256 TEXT NOT NULL CHECK (typeof(source_row_sha256) = 'text' AND length(source_row_sha256) = 64 AND source_row_sha256 NOT GLOB '*[^0-9a-f]*' AND instr(source_row_sha256, char(0)) = 0),
  legacy_store_kind TEXT NOT NULL CHECK (legacy_store_kind IN ('r2', 'managed')),
  legacy_provider TEXT NOT NULL CHECK ((legacy_store_kind = 'r2' AND legacy_provider = 'r2')
    OR legacy_store_kind = 'managed'),
  legacy_object_key TEXT NOT NULL,
  legacy_location_id TEXT REFERENCES file_locations(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256 AND instr(operation_id, char(0)) = 0),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object' AND length(CAST(evidence_json AS BLOB)) <= 16384),
  decided_by TEXT NOT NULL CHECK (length(decided_by) BETWEEN 1 AND 320 AND instr(decided_by, char(0)) = 0),
  decided_at TEXT NOT NULL CHECK (typeof(decided_at) = 'text' AND length(decided_at) BETWEEN 1 AND 200 AND instr(decided_at, char(0)) = 0 AND datetime(decided_at) IS NOT NULL),
  UNIQUE (consumer_kind, consumer_id, consumer_sub_id, file_slot),
  CHECK ((decision = 'resolved' AND file_id IS NOT NULL AND reason IS NULL)
    OR (decision = 'admitted_unresolved' AND file_id IS NULL AND reason IS NOT NULL AND length(reason) BETWEEN 1 AND 1000))
) WITHOUT ROWID;

-- Sidecar rows preserve the immutable FP1f-j receipt shapes. Import entries
-- use one row per workbook, manifest, or image item instead of treating an
-- accepted batch as proof that all files share one identity or purpose.
CREATE TABLE file_acceptance_candidates (
  acceptance_kind TEXT NOT NULL CHECK (acceptance_kind IN ('import_file', 'r2_upload', 'metrology_reference', 'comment_item')),
  acceptance_id TEXT NOT NULL CHECK (length(acceptance_id) BETWEEN 1 AND 256 AND instr(acceptance_id, char(0)) = 0),
  item_id TEXT NOT NULL DEFAULT '' CHECK (length(item_id) <= 4096 AND instr(item_id, char(0)) = 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('research_source', 'embedded_content', 'derived_preview', 'provenance', 'job_output')),
  access_scope TEXT NOT NULL CHECK (access_scope = 'system'),
  storage_profile_id TEXT NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
  expected_byte_size INTEGER NOT NULL CHECK (typeof(expected_byte_size) = 'integer' AND expected_byte_size BETWEEN 0 AND 9007199254740991),
  expected_sha256 TEXT NOT NULL CHECK (typeof(expected_sha256) = 'text' AND length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*' AND instr(expected_sha256, char(0)) = 0),
  candidate_file_id TEXT NOT NULL UNIQUE REFERENCES files(id) ON DELETE RESTRICT,
  candidate_location_id TEXT NOT NULL UNIQUE REFERENCES file_locations(id) ON DELETE RESTRICT,
  candidate_object_key TEXT NOT NULL CHECK (length(candidate_object_key) BETWEEN 1 AND 4096 AND instr(candidate_object_key, char(0)) = 0),
  state TEXT NOT NULL CHECK (state IN ('candidate', 'ready', 'cancelled')),
  result_file_id TEXT REFERENCES files(id) ON DELETE RESTRICT,
  result_location_id TEXT REFERENCES file_locations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (typeof(created_at) = 'text' AND length(created_at) BETWEEN 1 AND 200 AND instr(created_at, char(0)) = 0 AND datetime(created_at) IS NOT NULL),
  completed_at TEXT CHECK (completed_at IS NULL OR (typeof(completed_at) = 'text' AND length(completed_at) BETWEEN 1 AND 200 AND instr(completed_at, char(0)) = 0 AND datetime(completed_at) IS NOT NULL AND julianday(completed_at) >= julianday(created_at))),
  PRIMARY KEY (acceptance_kind, acceptance_id, item_id),
  CHECK ((acceptance_kind = 'import_file' AND item_id <> '') OR (acceptance_kind <> 'import_file' AND item_id = '')),
  CHECK ((state = 'candidate' AND result_file_id IS NULL AND result_location_id IS NULL AND completed_at IS NULL)
    OR (state = 'ready' AND result_file_id IS NOT NULL AND result_location_id IS NOT NULL AND completed_at IS NOT NULL)
    OR (state = 'cancelled' AND result_file_id IS NULL AND result_location_id IS NULL AND completed_at IS NOT NULL))
) WITHOUT ROWID;

-- The projection is intentionally diagnostic in legacy mode: it exposes every
-- typed slot and its untouched locator evidence while retaining the real
-- foreign key on the business table. Compound leaves stay below D1 limits.
CREATE VIEW file_consumer_relational_projection AS
SELECT 'state_representation_asset' AS consumer_kind, sra.state_hash AS consumer_id,
  sra.asset_id AS consumer_sub_id, 'primary' AS file_slot, sra.file_id,
  'embedded_content' AS expected_purpose, a.r2_key AS legacy_r2_object_key,
  NULL AS legacy_managed_provider, NULL AS legacy_managed_object_key,
  CASE WHEN sra.file_id IS NOT NULL THEN 'resolved'
    WHEN d.decision = 'admitted_unresolved' THEN 'admitted_unresolved' ELSE 'legacy_pending' END AS resolution_state,
  d.id AS decision_id
FROM state_representation_assets sra
LEFT JOIN assets a ON a.id = sra.asset_id
LEFT JOIN file_consumer_migration_decisions d ON d.consumer_kind = 'state_representation_asset'
  AND d.consumer_id = sra.state_hash AND d.consumer_sub_id = sra.asset_id AND d.file_slot = 'primary'

UNION ALL
SELECT 'run_step_asset', rsa.id, '', 'primary', rsa.file_id,
  NULL, a.r2_key, NULL, NULL,
  CASE WHEN rsa.file_id IS NOT NULL THEN 'resolved'
    WHEN d.decision = 'admitted_unresolved' THEN 'admitted_unresolved' ELSE 'legacy_pending' END , d.id
FROM run_step_assets rsa
LEFT JOIN assets a ON a.id = rsa.asset_id
LEFT JOIN file_consumer_migration_decisions d ON d.consumer_kind = 'run_step_asset'
  AND d.consumer_id = rsa.id AND d.consumer_sub_id = '' AND d.file_slot = 'primary'

UNION ALL
SELECT 'metrology_template_reference', mtr.id, '', 'primary', mtr.file_id,
  NULL, a.r2_key, NULL, NULL,
  CASE WHEN mtr.file_id IS NOT NULL THEN 'resolved'
    WHEN d.decision = 'admitted_unresolved' THEN 'admitted_unresolved' ELSE 'legacy_pending' END , d.id
FROM metrology_template_references mtr
LEFT JOIN assets a ON a.id = mtr.asset_id
LEFT JOIN file_consumer_migration_decisions d ON d.consumer_kind = 'metrology_template_reference'
  AND d.consumer_id = mtr.id AND d.consumer_sub_id = '' AND d.file_slot = 'primary'

UNION ALL
SELECT 'run_step_comment', rsc.id, '', 'primary', rsc.file_id,
  'embedded_content', a.r2_key, NULL, NULL,
  CASE WHEN rsc.file_id IS NOT NULL THEN 'resolved'
    WHEN d.decision = 'admitted_unresolved' THEN 'admitted_unresolved' ELSE 'legacy_pending' END , d.id
FROM run_step_comments rsc
LEFT JOIN assets a ON a.id = rsc.asset_id
LEFT JOIN file_consumer_migration_decisions d ON d.consumer_kind = 'run_step_comment'
  AND d.consumer_id = rsc.id AND d.consumer_sub_id = '' AND d.file_slot = 'primary'
WHERE rsc.asset_id IS NOT NULL OR rsc.file_id IS NOT NULL

UNION ALL
SELECT 'state_verification', sv.id, '', 'evidence', sv.evidence_file_id,
  'embedded_content', a.r2_key, NULL, NULL,
  CASE WHEN sv.evidence_file_id IS NOT NULL THEN 'resolved'
    WHEN d.decision = 'admitted_unresolved' THEN 'admitted_unresolved' ELSE 'legacy_pending' END , d.id
FROM state_verifications sv
LEFT JOIN assets a ON a.id = sv.evidence_asset_id
LEFT JOIN file_consumer_migration_decisions d ON d.consumer_kind = 'state_verification'
  AND d.consumer_id = sv.id AND d.consumer_sub_id = '' AND d.file_slot = 'evidence'
WHERE sv.evidence_asset_id IS NOT NULL OR sv.evidence_file_id IS NOT NULL;

CREATE VIEW file_consumer_content_projection AS
SELECT 'comment_submission_item' AS consumer_kind, csi.id AS consumer_id, '' AS consumer_sub_id,
  'primary' AS file_slot, csi.file_id,
  CASE WHEN csi.kind = 'attachment' THEN 'research_source'
    WHEN csi.kind = 'comment_image' AND csi.related_item_id IS NOT NULL THEN 'derived_preview'
    ELSE 'embedded_content' END AS expected_purpose,
  a.r2_key AS legacy_r2_object_key, mso.provider AS legacy_managed_provider,
  mso.object_key AS legacy_managed_object_key,
  CASE WHEN csi.file_id IS NOT NULL THEN 'resolved'
    WHEN d.decision = 'admitted_unresolved' THEN 'admitted_unresolved' ELSE 'legacy_pending' END AS resolution_state,
  d.id AS decision_id
FROM comment_submission_items csi
LEFT JOIN assets a ON a.id = csi.asset_id
LEFT JOIN managed_storage_objects mso ON mso.id = csi.storage_object_id
LEFT JOIN file_consumer_migration_decisions d ON d.consumer_kind = 'comment_submission_item'
  AND d.consumer_id = csi.id AND d.consumer_sub_id = '' AND d.file_slot = 'primary'
WHERE csi.asset_id IS NOT NULL OR csi.storage_object_id IS NOT NULL OR csi.file_id IS NOT NULL

UNION ALL
SELECT 'project_content_attachment', pca.project_content_id, '', 'primary', pca.file_id,
  NULL, a.r2_key, mso.provider, mso.object_key,
  CASE WHEN pca.file_id IS NOT NULL THEN 'resolved'
    WHEN d.decision = 'admitted_unresolved' THEN 'admitted_unresolved' ELSE 'legacy_pending' END , d.id
FROM project_content_attachments pca
LEFT JOIN assets a ON a.id = pca.asset_id
LEFT JOIN managed_storage_objects mso ON mso.id = pca.storage_object_id
LEFT JOIN file_consumer_migration_decisions d ON d.consumer_kind = 'project_content_attachment'
  AND d.consumer_id = pca.project_content_id AND d.consumer_sub_id = '' AND d.file_slot = 'primary'

UNION ALL
SELECT 'attachment_derivative', ad.id, '', 'derived', ad.derived_file_id,
  'derived_preview', a.r2_key, NULL, NULL,
  CASE WHEN ad.derived_file_id IS NOT NULL THEN 'resolved'
    WHEN d.decision = 'admitted_unresolved' THEN 'admitted_unresolved' ELSE 'legacy_pending' END , d.id
FROM attachment_derivatives ad
LEFT JOIN assets a ON a.id = ad.derived_asset_id
LEFT JOIN file_consumer_migration_decisions d ON d.consumer_kind = 'attachment_derivative'
  AND d.consumer_id = ad.id AND d.consumer_sub_id = '' AND d.file_slot = 'derived'
WHERE ad.derived_asset_id IS NOT NULL OR ad.derived_file_id IS NOT NULL;

CREATE VIEW file_consumer_direct_projection AS
SELECT 'event' AS consumer_kind, e.id AS consumer_id, '' AS consumer_sub_id,
  'primary' AS file_slot, e.asset_file_id AS file_id, 'embedded_content' AS expected_purpose,
  e.asset_key AS legacy_r2_object_key, NULL AS legacy_managed_provider,
  NULL AS legacy_managed_object_key,
  CASE WHEN e.asset_file_id IS NOT NULL THEN 'resolved'
    WHEN d.decision = 'admitted_unresolved' THEN 'admitted_unresolved' ELSE 'legacy_pending' END AS resolution_state,
  d.id AS decision_id
FROM events e
LEFT JOIN file_consumer_migration_decisions d ON d.consumer_kind = 'event'
  AND d.consumer_id = e.id AND d.consumer_sub_id = '' AND d.file_slot = 'primary'
WHERE NULLIF(trim(e.asset_key), '') IS NOT NULL OR e.asset_file_id IS NOT NULL

UNION ALL
SELECT 'event', e.id, '', 'thumbnail', e.thumbnail_file_id, 'derived_preview',
  CASE WHEN json_valid(e.metadata_json) THEN json_extract(e.metadata_json, '$.thumbnailKey') END , NULL, NULL,
  CASE WHEN e.thumbnail_file_id IS NOT NULL THEN 'resolved'
    WHEN d.decision = 'admitted_unresolved' THEN 'admitted_unresolved' ELSE 'legacy_pending' END , d.id
FROM events e
LEFT JOIN file_consumer_migration_decisions d ON d.consumer_kind = 'event'
  AND d.consumer_id = e.id AND d.consumer_sub_id = '' AND d.file_slot = 'thumbnail'
WHERE (json_valid(e.metadata_json) AND json_type(e.metadata_json, '$.thumbnailKey') = 'text'
    AND NULLIF(trim(json_extract(e.metadata_json, '$.thumbnailKey')), '') IS NOT NULL)
  OR e.thumbnail_file_id IS NOT NULL

UNION ALL
SELECT 'import', i.id, '', 'workbook', i.workbook_file_id, 'provenance',
  i.workbook_asset_key, NULL, NULL,
  CASE WHEN i.workbook_file_id IS NOT NULL THEN 'resolved'
    WHEN d.decision = 'admitted_unresolved' THEN 'admitted_unresolved' ELSE 'legacy_pending' END , d.id
FROM imports i
LEFT JOIN file_consumer_migration_decisions d ON d.consumer_kind = 'import'
  AND d.consumer_id = i.id AND d.consumer_sub_id = '' AND d.file_slot = 'workbook'
WHERE NULLIF(trim(i.workbook_asset_key), '') IS NOT NULL OR i.workbook_file_id IS NOT NULL

UNION ALL
SELECT 'import', i.id, '', 'manifest', i.manifest_file_id, 'provenance',
  i.manifest_asset_key, NULL, NULL,
  CASE WHEN i.manifest_file_id IS NOT NULL THEN 'resolved'
    WHEN d.decision = 'admitted_unresolved' THEN 'admitted_unresolved' ELSE 'legacy_pending' END , d.id
FROM imports i
LEFT JOIN file_consumer_migration_decisions d ON d.consumer_kind = 'import'
  AND d.consumer_id = i.id AND d.consumer_sub_id = '' AND d.file_slot = 'manifest'
WHERE NULLIF(trim(i.manifest_asset_key), '') IS NOT NULL OR i.manifest_file_id IS NOT NULL

UNION ALL
SELECT 'template_version', tv.id, '', 'source', tv.source_file_id, 'provenance',
  tv.source_asset_key, NULL, NULL,
  CASE WHEN tv.source_file_id IS NOT NULL THEN 'resolved'
    WHEN d.decision = 'admitted_unresolved' THEN 'admitted_unresolved' ELSE 'legacy_pending' END , d.id
FROM template_versions tv
LEFT JOIN file_consumer_migration_decisions d ON d.consumer_kind = 'template_version'
  AND d.consumer_id = tv.id AND d.consumer_sub_id = '' AND d.file_slot = 'source'
WHERE NULLIF(trim(tv.source_asset_key), '') IS NOT NULL OR tv.source_file_id IS NOT NULL;

CREATE VIEW file_consumer_projection AS
SELECT * FROM file_consumer_relational_projection
UNION ALL
SELECT * FROM file_consumer_content_projection
UNION ALL
SELECT * FROM file_consumer_direct_projection;

CREATE VIEW file_relational_retention_edges AS
SELECT sra.file_id, 'state_representation' AS source_type, sra.state_hash AS source_id,
  'state_representation_asset' AS occurrence_type, sra.state_hash || ':' || sra.asset_id AS occurrence_id,
  'state_representation' AS retention_reason, NULL AS retain_until
FROM state_representation_assets sra WHERE sra.file_id IS NOT NULL

UNION ALL
SELECT rsa.file_id, 'run_step', rsa.run_step_id, 'run_step_asset', rsa.id,
  CASE WHEN rsa.deleted_at IS NULL THEN 'run_step_asset' ELSE 'deleted_run_step_asset_grace' END ,
  CASE WHEN rsa.deleted_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', rsa.deleted_at, '+1 day') END
FROM run_step_assets rsa
WHERE rsa.file_id IS NOT NULL AND rsa.superseded_by_occurrence_id IS NULL
  AND (rsa.deleted_at IS NULL OR datetime(rsa.deleted_at, '+1 day') > datetime('now'))

UNION ALL
SELECT mtr.file_id, 'template_version', mtr.template_version_id, 'metrology_template_reference', mtr.id,
  'metrology_template_reference', NULL
FROM metrology_template_references mtr
WHERE mtr.file_id IS NOT NULL AND mtr.superseded_by_occurrence_id IS NULL

UNION ALL
SELECT rsc.file_id, 'run_step_comment', rsc.id, 'run_step_comment_file', rsc.id,
  'legacy_comment_file', NULL
FROM run_step_comments rsc WHERE rsc.file_id IS NOT NULL

UNION ALL
SELECT sv.evidence_file_id, 'state_verification', sv.id, 'state_verification_evidence', sv.id,
  'verification_evidence', NULL
FROM state_verifications sv WHERE sv.evidence_file_id IS NOT NULL;

CREATE VIEW file_content_retention_edges AS
SELECT csi.file_id, 'comment_submission' AS source_type, cs.id AS source_id,
  'comment_submission_item' AS occurrence_type, csi.id AS occurrence_id,
  CASE WHEN csi.deleted_at IS NULL THEN 'ready_comment_item' ELSE 'deleted_comment_item_grace' END AS retention_reason,
  CASE WHEN csi.deleted_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', csi.deleted_at, '+1 day') END AS retain_until
FROM comment_submission_items csi JOIN comment_submissions cs ON cs.id = csi.submission_id
WHERE csi.file_id IS NOT NULL AND cs.status = 'ready' AND csi.status = 'ready'
  AND (csi.deleted_at IS NULL OR datetime(csi.deleted_at, '+1 day') > datetime('now'))

UNION ALL
SELECT csi.file_id, 'comment_submission', cs.id, 'comment_submission_item', csi.id,
  CASE WHEN cs.status = 'failed' THEN 'retryable_comment_item' ELSE 'unfinished_comment_item' END , cs.retry_until
FROM comment_submission_items csi JOIN comment_submissions cs ON cs.id = csi.submission_id
WHERE csi.file_id IS NOT NULL AND csi.status <> 'cancelled' AND csi.deleted_at IS NULL
  AND cs.retry_closed_at IS NULL AND cs.status IN ('draft', 'uploading', 'failed')

UNION ALL
SELECT pca.file_id, 'project_content', pca.project_content_id, 'project_content_attachment',
  pca.project_content_id, 'project_attachment', NULL
FROM project_content_attachments pca WHERE pca.file_id IS NOT NULL

UNION ALL
SELECT ad.derived_file_id, 'attachment_derivative', ad.id, 'attachment_derivative', ad.id,
  'derivative_cache', ad.retain_until
FROM attachment_derivatives ad
WHERE ad.derived_file_id IS NOT NULL AND ad.status = 'ready' AND ad.retain_until IS NOT NULL
  AND datetime(ad.retain_until) > datetime('now');

CREATE VIEW file_direct_retention_edges AS
SELECT e.asset_file_id AS file_id, 'sample' AS source_type, e.sample_id AS source_id,
  'event' AS occurrence_type, e.id AS occurrence_id, 'event_asset' AS retention_reason, NULL AS retain_until
FROM events e WHERE e.asset_file_id IS NOT NULL

UNION ALL
SELECT e.thumbnail_file_id, 'sample', e.sample_id, 'event_thumbnail', e.id || ':thumbnail',
  'sample_record_thumbnail', NULL
FROM events e WHERE e.thumbnail_file_id IS NOT NULL

UNION ALL
SELECT i.workbook_file_id, 'import', i.id, 'import_workbook', i.id || ':workbook',
  'import_provenance', NULL
FROM imports i WHERE i.workbook_file_id IS NOT NULL

UNION ALL
SELECT i.manifest_file_id, 'import', i.id, 'import_manifest', i.id || ':manifest',
  'import_provenance', NULL
FROM imports i WHERE i.manifest_file_id IS NOT NULL

UNION ALL
SELECT tv.source_file_id, 'template_version', tv.id, 'template_source', tv.id || ':source',
  'template_provenance', NULL
FROM template_versions tv WHERE tv.source_file_id IS NOT NULL;

CREATE VIEW file_retention_edges AS
SELECT * FROM file_relational_retention_edges
UNION ALL
SELECT * FROM file_content_retention_edges
UNION ALL
SELECT * FROM file_direct_retention_edges;

CREATE VIEW file_location_retention_edges AS
SELECT fp.active_location_id AS location_id, fre.file_id, fre.source_type, fre.source_id,
  fre.occurrence_type, fre.occurrence_id, fre.retention_reason, fre.retain_until
FROM file_retention_edges fre
JOIN file_publications fp ON fp.file_id = fre.file_id AND fp.state = 'ready'

UNION ALL
SELECT fl.id, fl.file_id, 'file' AS source_type, fl.file_id AS source_id,
  'file_hold' AS occurrence_type, h.id AS occurrence_id, h.hold_kind AS retention_reason, h.expires_at
FROM file_holds h
JOIN file_publications fp ON fp.file_id = h.file_id AND fp.state = 'ready'
JOIN file_locations fl ON fl.id = fp.active_location_id
WHERE h.released_at IS NULL AND (h.expires_at IS NULL OR datetime(h.expires_at) > datetime('now'))

UNION ALL
SELECT c.candidate_location_id, c.candidate_file_id, 'file_acceptance_candidate',
  c.acceptance_kind || ':' || c.acceptance_id || ':' || c.item_id,
  'candidate_registration', c.acceptance_kind || ':' || c.acceptance_id || ':' || c.item_id,
  'acceptance_in_flight', NULL
FROM file_acceptance_candidates c
WHERE c.state = 'candidate'

UNION ALL
SELECT h.location_id, fl.file_id, 'file_location', h.location_id,
  'file_location_hold', h.id, h.hold_kind, h.expires_at
FROM file_location_holds h JOIN file_locations fl ON fl.id = h.location_id
WHERE h.released_at IS NULL AND (h.expires_at IS NULL OR datetime(h.expires_at) > datetime('now'));

CREATE VIEW file_location_availability AS
SELECT flp.location_id, flp.file_id, flp.storage_profile_id, flp.object_key,
  flp.verified_byte_size, flp.verified_sha256,
  CASE WHEN ngc.state = 'deleted' OR lgc.state = 'deleted' THEN 'deleted'
    WHEN ngc.state = 'deleting' OR lgc.state = 'deleting' THEN 'deleting'
    WHEN ngc.state = 'orphaned' OR lgc.state = 'orphaned' THEN 'orphaned'
    WHEN nq.location_id IS NOT NULL OR lq.object_key IS NOT NULL THEN 'quarantined'
    WHEN spr.state = 'retired' THEN 'profile_retired'
    ELSE 'available' END AS availability,
  fp.file_id IS NOT NULL AS is_active_location
FROM file_location_publications flp
JOIN file_locations fl ON fl.id = flp.location_id
JOIN storage_profile_runtime spr ON spr.storage_profile_id = flp.storage_profile_id
LEFT JOIN file_publications fp ON fp.active_location_id = flp.location_id AND fp.state = 'ready'
LEFT JOIN file_location_gc_ledger ngc ON ngc.location_id = flp.location_id
LEFT JOIN file_location_integrity_quarantine nq ON nq.location_id = flp.location_id
LEFT JOIN legacy_file_mappings lm ON lm.location_id = flp.location_id
LEFT JOIN blob_gc_ledger lgc ON lgc.store_kind = lm.store_kind
  AND lgc.provider = lm.provider AND lgc.object_key = lm.object_key
LEFT JOIN blob_integrity_quarantine lq ON lq.store_kind = lm.store_kind
  AND lq.provider = lm.provider AND lq.object_key = lm.object_key;

CREATE VIEW file_usable_publications AS
SELECT fp.file_id, fp.purpose, fp.access_scope, fp.verified_byte_size,
  fp.verified_sha256, fp.active_location_id, fp.state, fp.published_at, fp.retired_at
FROM file_publications fp
JOIN file_location_availability fla ON fla.location_id = fp.active_location_id
WHERE fp.state = 'ready' AND fla.availability = 'available' AND fla.is_active_location = 1;

CREATE TRIGGER file_location_publications_legacy_guard
BEFORE INSERT ON file_location_publications BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority cannot publish locations')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
END;

CREATE TRIGGER file_location_publications_replace_guard
BEFORE INSERT ON file_location_publications BEGIN
  SELECT RAISE(ABORT, 'Verified location publication identity already exists')
  WHERE EXISTS (SELECT 1 FROM file_location_publications
    WHERE location_id = NEW.location_id
      OR (storage_profile_id = NEW.storage_profile_id AND object_key = NEW.object_key));
END;

CREATE TRIGGER file_location_publications_identity_guard
BEFORE INSERT ON file_location_publications BEGIN
  SELECT RAISE(ABORT, 'Verified location publication does not match immutable File evidence')
  WHERE EXISTS (
    SELECT 1 FROM file_acceptance_candidates c
    WHERE (c.state = 'cancelled'
        OR (c.state = 'ready' AND c.result_location_id IS NOT c.candidate_location_id))
      AND (c.candidate_location_id = NEW.location_id OR c.candidate_file_id = NEW.file_id)
  ) OR NOT EXISTS (
    SELECT 1 FROM file_locations fl
    JOIN files f ON f.id = fl.file_id
    JOIN storage_profile_runtime spr ON spr.storage_profile_id = fl.storage_profile_id
    WHERE fl.id = NEW.location_id AND fl.file_id = NEW.file_id
      AND fl.storage_profile_id = NEW.storage_profile_id AND fl.object_key = NEW.object_key
      AND f.purpose IS NOT NULL AND f.expected_byte_size IS NEW.verified_byte_size
      AND f.expected_sha256 IS NEW.verified_sha256 AND spr.state <> 'retired'
      AND NOT EXISTS (
        SELECT 1 FROM file_location_gc_ledger ngc WHERE ngc.location_id = fl.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM file_location_integrity_quarantine nq WHERE nq.location_id = fl.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM legacy_file_mappings lm
        JOIN blob_gc_ledger bg ON bg.store_kind = lm.store_kind
          AND bg.provider = lm.provider AND bg.object_key = lm.object_key
        WHERE lm.location_id = fl.id AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1 FROM legacy_file_mappings lm
        JOIN blob_integrity_quarantine biq ON biq.store_kind = lm.store_kind
          AND biq.provider = lm.provider AND biq.object_key = lm.object_key
        WHERE lm.location_id = fl.id
      )
  );
END;

CREATE TRIGGER file_location_publications_update_guard
BEFORE UPDATE ON file_location_publications BEGIN
  SELECT RAISE(ABORT, 'Verified location publication is immutable');
END;

CREATE TRIGGER file_location_publications_delete_guard
BEFORE DELETE ON file_location_publications BEGIN
  SELECT RAISE(ABORT, 'Verified location publication cannot be deleted');
END;

CREATE TRIGGER file_publications_legacy_insert_guard
BEFORE INSERT ON file_publications BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority cannot publish Files')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
END;

CREATE TRIGGER file_publications_replace_guard
BEFORE INSERT ON file_publications BEGIN
  SELECT RAISE(ABORT, 'File publication identity already exists')
  WHERE EXISTS (SELECT 1 FROM file_publications
    WHERE file_id = NEW.file_id
      OR (NEW.active_location_id IS NOT NULL AND active_location_id = NEW.active_location_id));
END;

CREATE TRIGGER file_publications_ready_insert_guard
BEFORE INSERT ON file_publications BEGIN
  SELECT RAISE(ABORT, 'Ready File requires its one owned full-read verified active location')
  WHERE NEW.state <> 'ready' OR EXISTS (
    SELECT 1 FROM file_acceptance_candidates c
    WHERE c.candidate_file_id = NEW.file_id
      AND (c.state = 'cancelled'
        OR (c.state = 'ready' AND c.result_file_id IS NOT c.candidate_file_id))
  ) OR NOT EXISTS (
    SELECT 1 FROM files f
    JOIN file_location_publications flp ON flp.location_id = NEW.active_location_id AND flp.file_id = f.id
    JOIN storage_profile_runtime spr ON spr.storage_profile_id = flp.storage_profile_id
    JOIN file_location_availability fla ON fla.location_id = flp.location_id
    WHERE f.id = NEW.file_id AND f.purpose IS NEW.purpose AND f.access_scope IS NEW.access_scope
      AND f.expected_byte_size IS NEW.verified_byte_size AND f.expected_sha256 IS NEW.verified_sha256
      AND flp.verified_byte_size IS NEW.verified_byte_size AND flp.verified_sha256 IS NEW.verified_sha256
      AND flp.verification_method = 'full_read_sha256' AND spr.state <> 'retired'
      AND julianday(NEW.published_at) >= julianday(flp.published_at)
      AND fla.availability = 'available'
      AND NOT EXISTS (SELECT 1 FROM file_location_integrity_quarantine q WHERE q.location_id = flp.location_id)
      AND NOT EXISTS (SELECT 1 FROM file_location_gc_ledger g WHERE g.location_id = flp.location_id AND g.state IN ('deleting', 'deleted'))
  );
END;

CREATE TRIGGER file_publications_legacy_update_guard
BEFORE UPDATE ON file_publications BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority cannot change File publications')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
END;

CREATE TRIGGER file_publications_update_guard
BEFORE UPDATE ON file_publications BEGIN
  SELECT RAISE(ABORT, 'Published File identity is immutable')
  WHERE NEW.file_id IS NOT OLD.file_id OR NEW.purpose IS NOT OLD.purpose
    OR NEW.access_scope IS NOT OLD.access_scope OR NEW.verified_byte_size IS NOT OLD.verified_byte_size
    OR NEW.verified_sha256 IS NOT OLD.verified_sha256 OR NEW.published_at IS NOT OLD.published_at
    OR OLD.state = 'retired' OR NEW.state NOT IN ('ready', 'retired')
    OR (NEW.active_location_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM file_publications conflict
      WHERE conflict.file_id <> OLD.file_id AND conflict.active_location_id = NEW.active_location_id
    ))
    OR (NEW.state = 'retired' AND (
      (SELECT mode FROM file_authority_control WHERE singleton = 1) <> 'active'
      OR NEW.active_location_id IS NOT NULL OR NEW.retired_at IS NULL
      OR EXISTS (SELECT 1 FROM file_retention_edges e WHERE e.file_id = OLD.file_id)
      OR EXISTS (SELECT 1 FROM file_holds h WHERE h.file_id = OLD.file_id AND h.released_at IS NULL
        AND (h.expires_at IS NULL OR datetime(h.expires_at) > datetime('now')))
    ))
    OR (NEW.state = 'ready' AND NEW.active_location_id IS NOT OLD.active_location_id
      AND NOT EXISTS (
        SELECT 1 FROM file_location_holds source
        JOIN file_location_holds destination ON destination.operation_id = source.operation_id
        WHERE source.location_id = OLD.active_location_id AND source.hold_kind = 'transition_source'
          AND destination.location_id = NEW.active_location_id AND destination.hold_kind = 'transition_destination'
          AND source.released_at IS NULL AND destination.released_at IS NULL
          AND (source.expires_at IS NULL OR datetime(source.expires_at) > datetime('now'))
          AND (destination.expires_at IS NULL OR datetime(destination.expires_at) > datetime('now'))
      ))
    OR (NEW.state = 'ready' AND NOT EXISTS (
      SELECT 1 FROM file_location_publications flp
      JOIN storage_profile_runtime spr ON spr.storage_profile_id = flp.storage_profile_id
      JOIN file_location_availability fla ON fla.location_id = flp.location_id
      WHERE flp.location_id = NEW.active_location_id AND flp.file_id = NEW.file_id
        AND flp.verified_byte_size IS NEW.verified_byte_size AND flp.verified_sha256 IS NEW.verified_sha256
        AND spr.state <> 'retired' AND fla.availability = 'available'
        AND NOT EXISTS (SELECT 1 FROM file_location_integrity_quarantine q WHERE q.location_id = flp.location_id)
        AND NOT EXISTS (SELECT 1 FROM file_location_gc_ledger g WHERE g.location_id = flp.location_id AND g.state IN ('deleting', 'deleted'))
    ));
END;

CREATE TRIGGER file_publications_delete_guard
BEFORE DELETE ON file_publications BEGIN
  SELECT RAISE(ABORT, 'Published File identity cannot be deleted');
END;

CREATE TRIGGER file_derivations_legacy_guard
BEFORE INSERT ON file_derivations BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority cannot record derivations')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
END;

CREATE TRIGGER file_derivations_replace_guard
BEFORE INSERT ON file_derivations BEGIN
  SELECT RAISE(ABORT, 'Derivation evidence identity already exists')
  WHERE EXISTS (SELECT 1 FROM file_derivations
    WHERE id = NEW.id OR (source_file_id = NEW.source_file_id
      AND derived_file_id = NEW.derived_file_id AND generator = NEW.generator
      AND generator_version = NEW.generator_version AND parameters_sha256 = NEW.parameters_sha256));
END;

CREATE TRIGGER file_derivations_trust_guard
BEFORE INSERT ON file_derivations BEGIN
  SELECT RAISE(ABORT, 'Trusted derivation requires exact ready source and output publications')
  WHERE NEW.trust_state = 'verified' AND NOT EXISTS (
    SELECT 1 FROM file_usable_publications source
    JOIN file_usable_publications output ON output.file_id = NEW.derived_file_id
    WHERE source.file_id = NEW.source_file_id
      AND source.verified_sha256 IS NEW.source_verified_sha256
      AND output.verified_sha256 IS NEW.derived_verified_sha256
      AND output.purpose IN ('derived_preview', 'job_output')
      AND NOT EXISTS (SELECT 1 FROM file_location_integrity_quarantine q WHERE q.location_id IN (source.active_location_id, output.active_location_id))
  );
END;

CREATE TRIGGER file_derivations_unverified_guard
BEFORE INSERT ON file_derivations BEGIN
  SELECT RAISE(ABORT, 'Unverified derivation cannot claim a reusable output')
  WHERE NEW.trust_state = 'unverified' AND NOT EXISTS (
    SELECT 1 FROM files output
    WHERE output.id = NEW.derived_file_id AND output.purpose IN ('derived_preview', 'job_output')
  );
END;

CREATE TRIGGER file_derivations_update_guard
BEFORE UPDATE ON file_derivations BEGIN
  SELECT RAISE(ABORT, 'Derivation evidence is immutable');
END;

CREATE TRIGGER file_derivations_delete_guard
BEFORE DELETE ON file_derivations BEGIN
  SELECT RAISE(ABORT, 'Derivation evidence cannot be deleted');
END;

CREATE TRIGGER file_holds_legacy_guard
BEFORE INSERT ON file_holds BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority cannot acquire File holds')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
END;

CREATE TRIGGER file_holds_replace_guard
BEFORE INSERT ON file_holds BEGIN
  SELECT RAISE(ABORT, 'File hold identity already exists')
  WHERE EXISTS (SELECT 1 FROM file_holds
    WHERE id = NEW.id OR (file_id = NEW.file_id AND operation_id = NEW.operation_id));
END;

CREATE TRIGGER file_holds_safety_guard
BEFORE INSERT ON file_holds BEGIN
  SELECT RAISE(ABORT, 'Cannot acquire a File hold after location deletion begins')
  WHERE EXISTS (
    SELECT 1 FROM file_publications fp JOIN file_location_gc_ledger gc ON gc.location_id = fp.active_location_id
    WHERE fp.file_id = NEW.file_id AND fp.state = 'ready' AND gc.state IN ('deleting', 'deleted')
  );
END;

CREATE TRIGGER file_holds_legacy_update_guard
BEFORE UPDATE ON file_holds BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority cannot release File holds')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
END;

CREATE TRIGGER file_holds_update_guard
BEFORE UPDATE ON file_holds BEGIN
  SELECT RAISE(ABORT, 'File hold identity is immutable')
  WHERE NEW.id IS NOT OLD.id OR NEW.file_id IS NOT OLD.file_id OR NEW.hold_kind IS NOT OLD.hold_kind
    OR NEW.operation_id IS NOT OLD.operation_id OR NEW.reason IS NOT OLD.reason
    OR NEW.acquired_at IS NOT OLD.acquired_at OR NEW.expires_at IS NOT OLD.expires_at
    OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL;
END;

CREATE TRIGGER file_holds_delete_guard
BEFORE DELETE ON file_holds BEGIN
  SELECT RAISE(ABORT, 'File hold history cannot be deleted');
END;

CREATE TRIGGER file_location_holds_legacy_guard
BEFORE INSERT ON file_location_holds BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority cannot acquire location holds')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
END;

CREATE TRIGGER file_location_holds_replace_guard
BEFORE INSERT ON file_location_holds BEGIN
  SELECT RAISE(ABORT, 'Location hold identity already exists')
  WHERE EXISTS (SELECT 1 FROM file_location_holds
    WHERE id = NEW.id OR (location_id = NEW.location_id AND operation_id = NEW.operation_id));
END;

CREATE TRIGGER file_location_holds_safety_guard
BEFORE INSERT ON file_location_holds BEGIN
  SELECT RAISE(ABORT, 'Cannot acquire a location hold after deletion begins')
  WHERE EXISTS (SELECT 1 FROM file_location_gc_ledger gc
    WHERE gc.location_id = NEW.location_id AND gc.state IN ('deleting', 'deleted'));
END;

CREATE TRIGGER file_location_holds_legacy_update_guard
BEFORE UPDATE ON file_location_holds BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority cannot release location holds')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
END;

CREATE TRIGGER file_location_holds_update_guard
BEFORE UPDATE ON file_location_holds BEGIN
  SELECT RAISE(ABORT, 'Location hold identity is immutable')
  WHERE NEW.id IS NOT OLD.id OR NEW.location_id IS NOT OLD.location_id OR NEW.hold_kind IS NOT OLD.hold_kind
    OR NEW.operation_id IS NOT OLD.operation_id OR NEW.reason IS NOT OLD.reason
    OR NEW.acquired_at IS NOT OLD.acquired_at OR NEW.expires_at IS NOT OLD.expires_at
    OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL;
END;

CREATE TRIGGER file_location_holds_delete_guard
BEFORE DELETE ON file_location_holds BEGIN
  SELECT RAISE(ABORT, 'Location hold history cannot be deleted');
END;

CREATE TRIGGER file_location_gc_legacy_insert_guard
BEFORE INSERT ON file_location_gc_ledger BEGIN
  SELECT RAISE(ABORT, 'Only active File authority can claim location deletion')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) <> 'active';
END;

CREATE TRIGGER file_location_gc_replace_guard
BEFORE INSERT ON file_location_gc_ledger BEGIN
  SELECT RAISE(ABORT, 'Location deletion history already exists')
  WHERE EXISTS (SELECT 1 FROM file_location_gc_ledger WHERE location_id = NEW.location_id);
END;

CREATE TRIGGER file_location_gc_orphan_guard
BEFORE INSERT ON file_location_gc_ledger BEGIN
  SELECT RAISE(ABORT, 'Location cannot become orphaned while retained or held')
  WHERE NEW.state <> 'orphaned'
    OR NOT (
      EXISTS (SELECT 1 FROM file_location_publications flp WHERE flp.location_id = NEW.location_id)
      OR EXISTS (SELECT 1 FROM file_acceptance_candidates c
        WHERE c.candidate_location_id = NEW.location_id AND c.state IN ('ready', 'cancelled'))
    )
    OR EXISTS (SELECT 1 FROM file_publications fp WHERE fp.active_location_id = NEW.location_id AND fp.state = 'ready')
    OR EXISTS (SELECT 1 FROM file_location_retention_edges e WHERE e.location_id = NEW.location_id)
    OR EXISTS (
      SELECT 1 FROM legacy_file_mappings lm
      JOIN blob_retention_edges e ON e.store_kind = lm.store_kind
        AND e.provider = lm.provider AND e.object_key = lm.object_key
      WHERE lm.location_id = NEW.location_id
    )
    OR EXISTS (SELECT 1 FROM file_location_holds h WHERE h.location_id = NEW.location_id AND h.released_at IS NULL
      AND (h.expires_at IS NULL OR datetime(h.expires_at) > datetime('now')));
END;

CREATE TRIGGER file_location_gc_legacy_update_guard
BEFORE UPDATE ON file_location_gc_ledger BEGIN
  SELECT RAISE(ABORT, 'Only active File authority can advance location deletion')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) <> 'active';
END;

CREATE TRIGGER file_location_gc_update_guard
BEFORE UPDATE ON file_location_gc_ledger BEGIN
  SELECT RAISE(ABORT, 'Unsafe or invalid location deletion transition')
  WHERE NEW.location_id IS NOT OLD.location_id OR NEW.orphaned_at IS NOT OLD.orphaned_at
    OR NOT (
      (OLD.state = 'orphaned' AND NEW.state = 'deleting'
        AND NEW.operation_id IS NOT NULL AND NEW.deletion_started_at IS NOT NULL
        AND NEW.deleted_at IS NULL AND NEW.attempt_count = OLD.attempt_count + 1
        AND NEW.last_error IS NULL AND NEW.updated_at IS NEW.deletion_started_at
        AND julianday(NEW.deletion_started_at) >= julianday(OLD.orphaned_at))
      OR (OLD.state = 'deleting' AND NEW.state = 'deleting'
        AND NEW.operation_id IS OLD.operation_id AND NEW.deleted_at IS NULL
        AND (
          (NEW.attempt_count = OLD.attempt_count + 1
            AND julianday(NEW.deletion_started_at) > julianday(OLD.deletion_started_at)
            AND julianday(NEW.deletion_started_at) >= julianday(OLD.updated_at)
            AND NEW.last_error IS NULL AND NEW.updated_at IS NEW.deletion_started_at)
          OR (NEW.attempt_count = OLD.attempt_count
            AND NEW.deletion_started_at IS OLD.deletion_started_at
            AND NEW.last_error IS NOT NULL
            AND julianday(NEW.updated_at) >= julianday(OLD.updated_at))
        ))
      OR (OLD.state = 'deleting' AND NEW.state = 'deleted'
        AND NEW.operation_id IS OLD.operation_id
        AND NEW.deletion_started_at IS OLD.deletion_started_at
        AND NEW.attempt_count = OLD.attempt_count AND NEW.deleted_at IS NOT NULL
        AND NEW.last_error IS NULL AND NEW.updated_at IS NEW.deleted_at
        AND julianday(NEW.deleted_at) >= julianday(OLD.deletion_started_at)
        AND julianday(NEW.deleted_at) >= julianday(OLD.updated_at))
    )
    OR (NEW.state IN ('deleting', 'deleted') AND (
      EXISTS (SELECT 1 FROM file_publications fp WHERE fp.active_location_id = NEW.location_id AND fp.state = 'ready')
      OR EXISTS (SELECT 1 FROM file_location_retention_edges e WHERE e.location_id = NEW.location_id)
      OR EXISTS (
        SELECT 1 FROM legacy_file_mappings lm
        JOIN blob_retention_edges e ON e.store_kind = lm.store_kind
          AND e.provider = lm.provider AND e.object_key = lm.object_key
        WHERE lm.location_id = NEW.location_id
      )
      OR EXISTS (SELECT 1 FROM file_location_holds h WHERE h.location_id = NEW.location_id AND h.released_at IS NULL
        AND (h.expires_at IS NULL OR datetime(h.expires_at) > datetime('now')))
    ));
END;

CREATE TRIGGER file_location_gc_delete_guard
BEFORE DELETE ON file_location_gc_ledger BEGIN
  SELECT RAISE(ABORT, 'Location deletion history cannot be deleted');
END;

CREATE TRIGGER file_location_quarantine_legacy_guard
BEFORE INSERT ON file_location_integrity_quarantine BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority cannot quarantine File locations')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
END;

CREATE TRIGGER file_location_quarantine_replace_guard
BEFORE INSERT ON file_location_integrity_quarantine BEGIN
  SELECT RAISE(ABORT, 'Location quarantine history already exists')
  WHERE EXISTS (SELECT 1 FROM file_location_integrity_quarantine WHERE location_id = NEW.location_id);
END;

CREATE TRIGGER file_location_quarantine_evidence_guard
BEFORE INSERT ON file_location_integrity_quarantine BEGIN
  SELECT RAISE(ABORT, 'Integrity quarantine must match verified location evidence')
  WHERE NOT (
    EXISTS (
      SELECT 1 FROM file_location_publications flp
      WHERE flp.location_id = NEW.location_id
        AND flp.verified_byte_size IS NEW.expected_byte_size
        AND flp.verified_sha256 IS NEW.expected_sha256
    )
    OR EXISTS (
      SELECT 1 FROM file_acceptance_candidates c
      WHERE c.candidate_location_id = NEW.location_id
        AND c.expected_byte_size IS NEW.expected_byte_size
        AND c.expected_sha256 IS NEW.expected_sha256
        AND c.state IN ('candidate', 'ready', 'cancelled')
    )
  ) OR EXISTS (
    SELECT 1 FROM file_location_gc_ledger gc
    WHERE gc.location_id = NEW.location_id AND gc.state IN ('deleting', 'deleted')
  );
END;

CREATE TRIGGER file_location_quarantine_update_guard
BEFORE UPDATE ON file_location_integrity_quarantine BEGIN
  SELECT RAISE(ABORT, 'Integrity quarantine evidence is immutable');
END;

CREATE TRIGGER file_location_quarantine_delete_guard
BEFORE DELETE ON file_location_integrity_quarantine BEGIN
  SELECT RAISE(ABORT, 'Integrity quarantine clearance requires reviewed forward evidence');
END;

CREATE TRIGGER file_consumer_decisions_legacy_guard
BEFORE INSERT ON file_consumer_migration_decisions BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority cannot admit consumer decisions')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
END;

CREATE TRIGGER file_consumer_decisions_replace_guard
BEFORE INSERT ON file_consumer_migration_decisions BEGIN
  SELECT RAISE(ABORT, 'Consumer migration decision identity already exists')
  WHERE EXISTS (SELECT 1 FROM file_consumer_migration_decisions
    WHERE id = NEW.id OR (consumer_kind = NEW.consumer_kind AND consumer_id = NEW.consumer_id
      AND consumer_sub_id = NEW.consumer_sub_id AND file_slot = NEW.file_slot));
END;

CREATE TRIGGER file_consumer_decisions_slot_guard
BEFORE INSERT ON file_consumer_migration_decisions BEGIN
  SELECT RAISE(ABORT, 'Consumer decision uses an invalid typed slot')
  WHERE NOT (
    (NEW.consumer_kind IN ('state_representation_asset', 'run_step_asset', 'metrology_template_reference', 'run_step_comment', 'comment_submission_item', 'project_content_attachment') AND NEW.file_slot = 'primary')
    OR (NEW.consumer_kind = 'state_verification' AND NEW.file_slot = 'evidence')
    OR (NEW.consumer_kind = 'attachment_derivative' AND NEW.file_slot = 'derived')
    OR (NEW.consumer_kind = 'event' AND NEW.file_slot IN ('primary', 'thumbnail'))
    OR (NEW.consumer_kind = 'import' AND NEW.file_slot IN ('workbook', 'manifest'))
    OR (NEW.consumer_kind = 'template_version' AND NEW.file_slot = 'source')
  );
END;

-- BEFORE INSERT reports -1 for an automatically assigned rowid, so the
-- replacement guards below can safely distinguish explicit positive/zero
-- rowids only if no authority anchor can ever be attached to rowid -1.
CREATE TRIGGER file_consumer_decisions_rowid_guard
BEFORE INSERT ON file_consumer_migration_decisions BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor an immutable File decision')
  WHERE (NEW.consumer_kind = 'state_representation_asset' AND EXISTS (
      SELECT 1 FROM state_representation_assets c
      WHERE c.rowid = -1 AND c.state_hash = NEW.consumer_id AND c.asset_id = NEW.consumer_sub_id))
    OR (NEW.consumer_kind = 'run_step_asset' AND EXISTS (
      SELECT 1 FROM run_step_assets c WHERE c.rowid = -1 AND c.id = NEW.consumer_id))
    OR (NEW.consumer_kind = 'metrology_template_reference' AND EXISTS (
      SELECT 1 FROM metrology_template_references c WHERE c.rowid = -1 AND c.id = NEW.consumer_id))
    OR (NEW.consumer_kind = 'run_step_comment' AND EXISTS (
      SELECT 1 FROM run_step_comments c WHERE c.rowid = -1 AND c.id = NEW.consumer_id))
    OR (NEW.consumer_kind = 'state_verification' AND EXISTS (
      SELECT 1 FROM state_verifications c WHERE c.rowid = -1 AND c.id = NEW.consumer_id))
    OR (NEW.consumer_kind = 'comment_submission_item' AND EXISTS (
      SELECT 1 FROM comment_submission_items c WHERE c.rowid = -1 AND c.id = NEW.consumer_id))
    OR (NEW.consumer_kind = 'project_content_attachment' AND EXISTS (
      SELECT 1 FROM project_content_attachments c
      WHERE c.rowid = -1 AND c.project_content_id = NEW.consumer_id))
    OR (NEW.consumer_kind = 'attachment_derivative' AND EXISTS (
      SELECT 1 FROM attachment_derivatives c WHERE c.rowid = -1 AND c.id = NEW.consumer_id))
    OR (NEW.consumer_kind = 'event' AND EXISTS (
      SELECT 1 FROM events c WHERE c.rowid = -1 AND c.id = NEW.consumer_id))
    OR (NEW.consumer_kind = 'import' AND EXISTS (
      SELECT 1 FROM imports c WHERE c.rowid = -1 AND c.id = NEW.consumer_id))
    OR (NEW.consumer_kind = 'template_version' AND EXISTS (
      SELECT 1 FROM template_versions c WHERE c.rowid = -1 AND c.id = NEW.consumer_id));
END;

CREATE TRIGGER file_consumer_decisions_owner_guard
BEFORE INSERT ON file_consumer_migration_decisions BEGIN
  SELECT RAISE(ABORT, 'Consumer decision does not match typed ownership or frozen locator')
  WHERE NOT EXISTS (
    SELECT 1 FROM file_consumer_projection p
    WHERE p.consumer_kind = NEW.consumer_kind AND p.consumer_id = NEW.consumer_id
      AND p.consumer_sub_id = NEW.consumer_sub_id AND p.file_slot = NEW.file_slot
      AND ((NEW.decision = 'resolved' AND p.file_id IS NEW.file_id)
        OR (NEW.decision = 'admitted_unresolved' AND p.file_id IS NULL))
      AND ((NEW.legacy_store_kind = 'r2' AND p.legacy_r2_object_key IS NEW.legacy_object_key
          AND NEW.legacy_provider = 'r2')
        OR (NEW.legacy_store_kind = 'managed' AND p.legacy_managed_provider IS NEW.legacy_provider
          AND p.legacy_managed_object_key IS NEW.legacy_object_key))
      AND (NEW.legacy_location_id IS NULL OR EXISTS (
        SELECT 1 FROM legacy_file_mappings lm
        WHERE lm.location_id = NEW.legacy_location_id
          AND lm.store_kind = NEW.legacy_store_kind
          AND lm.provider = NEW.legacy_provider
          AND lm.object_key = NEW.legacy_object_key
      ))
      AND (NEW.decision <> 'resolved' OR EXISTS (
        SELECT 1 FROM file_usable_publications fp WHERE fp.file_id = NEW.file_id
      ))
  );
END;

CREATE TRIGGER file_consumer_decisions_update_guard
BEFORE UPDATE ON file_consumer_migration_decisions BEGIN
  SELECT RAISE(ABORT, 'Consumer migration decisions are immutable');
END;

CREATE TRIGGER file_consumer_decisions_delete_guard
BEFORE DELETE ON file_consumer_migration_decisions BEGIN
  SELECT RAISE(ABORT, 'Consumer migration decisions cannot be deleted');
END;

CREATE TRIGGER file_acceptance_candidates_legacy_guard
BEFORE INSERT ON file_acceptance_candidates BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority cannot create acceptance candidates')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
END;

CREATE TRIGGER file_acceptance_candidates_replace_guard
BEFORE INSERT ON file_acceptance_candidates BEGIN
  SELECT RAISE(ABORT, 'Acceptance candidate identity already exists')
  WHERE EXISTS (SELECT 1 FROM file_acceptance_candidates
    WHERE (acceptance_kind = NEW.acceptance_kind AND acceptance_id = NEW.acceptance_id AND item_id = NEW.item_id)
      OR candidate_file_id = NEW.candidate_file_id OR candidate_location_id = NEW.candidate_location_id);
END;

CREATE TRIGGER file_acceptance_candidates_identity_guard
BEFORE INSERT ON file_acceptance_candidates BEGIN
  SELECT RAISE(ABORT, 'Acceptance candidate does not match immutable File and location identity')
  WHERE NEW.state <> 'candidate' OR NOT EXISTS (
    SELECT 1 FROM files f JOIN file_locations fl ON fl.file_id = f.id
    WHERE f.id = NEW.candidate_file_id AND fl.id = NEW.candidate_location_id
      AND f.purpose IS NEW.purpose AND f.access_scope IS NEW.access_scope
      AND f.expected_byte_size IS NEW.expected_byte_size AND f.expected_sha256 IS NEW.expected_sha256
      AND fl.storage_profile_id IS NEW.storage_profile_id AND fl.object_key IS NEW.candidate_object_key
  ) OR EXISTS (
    SELECT 1 FROM file_location_publications WHERE location_id = NEW.candidate_location_id
  ) OR EXISTS (
    SELECT 1 FROM file_publications WHERE file_id = NEW.candidate_file_id
  ) OR EXISTS (
    SELECT 1 FROM file_location_gc_ledger WHERE location_id = NEW.candidate_location_id
  ) OR EXISTS (
    SELECT 1 FROM file_location_integrity_quarantine WHERE location_id = NEW.candidate_location_id
  );
END;

CREATE TRIGGER file_acceptance_candidates_receipt_guard
BEFORE INSERT ON file_acceptance_candidates BEGIN
  SELECT RAISE(ABORT, 'Acceptance candidate does not match its durable receipt item')
  WHERE NOT (
    (NEW.acceptance_kind = 'r2_upload' AND EXISTS (
      SELECT 1 FROM r2_upload_requests r
      WHERE r.id = NEW.acceptance_id AND NEW.item_id = ''
        AND r.status = 'pending'
        AND r.purpose IS NEW.purpose AND r.request_scope IS NEW.access_scope
        AND r.storage_profile_id IS NEW.storage_profile_id
        AND json_extract(r.request_input_json, '$.file.byteSize') IS NEW.expected_byte_size
        AND json_extract(r.request_input_json, '$.file.sha256') IS NEW.expected_sha256
        AND r.candidate_object_key IS NEW.candidate_object_key
    ))
    OR (NEW.acceptance_kind = 'metrology_reference' AND EXISTS (
      SELECT 1 FROM metrology_reference_upload_requests r
      WHERE r.id = NEW.acceptance_id AND NEW.item_id = ''
        AND r.status = 'pending'
        AND r.purpose IS NEW.purpose AND r.request_scope IS NEW.access_scope
        AND r.storage_profile_id IS NEW.storage_profile_id
        AND json_extract(r.request_input_json, '$.file.byteSize') IS NEW.expected_byte_size
        AND json_extract(r.request_input_json, '$.file.sha256') IS NEW.expected_sha256
        AND r.candidate_object_key IS NEW.candidate_object_key
    ))
    OR (NEW.acceptance_kind = 'comment_item' AND EXISTS (
      SELECT 1 FROM comment_item_acceptances r
      WHERE r.item_id = NEW.acceptance_id AND NEW.item_id = ''
        AND r.status = 'pending'
        AND r.purpose IS NEW.purpose AND r.storage_profile_id IS NEW.storage_profile_id
        AND r.expected_byte_size IS NEW.expected_byte_size AND r.expected_sha256 IS NEW.expected_sha256
        AND r.candidate_object_key IS NEW.candidate_object_key
    ))
    OR (NEW.acceptance_kind = 'import_file' AND EXISTS (
      SELECT 1 FROM imports i
      WHERE i.id = NEW.acceptance_id AND i.client_request_id IS NOT NULL
        AND i.status = 'pending'
        AND i.request_scope IS NEW.access_scope AND i.storage_profile_id IS NEW.storage_profile_id
        AND (
          (NEW.item_id = 'workbook' AND json_extract(i.request_input_json, '$.workbook.purpose') IS NEW.purpose
            AND json_extract(i.request_input_json, '$.workbook.byteSize') IS NEW.expected_byte_size
            AND json_extract(i.request_input_json, '$.workbook.sha256') IS NEW.expected_sha256)
          OR (NEW.item_id = 'manifest' AND json_extract(i.request_input_json, '$.manifest.purpose') IS NEW.purpose
            AND json_extract(i.request_input_json, '$.manifest.byteSize') IS NEW.expected_byte_size
            AND json_extract(i.request_input_json, '$.manifest.sha256') IS NEW.expected_sha256)
          OR (substr(NEW.item_id, 1, 6) = 'image:' AND EXISTS (
            SELECT 1 FROM json_each(i.request_input_json, '$.images') item
            WHERE json_extract(item.value, '$.localId') IS substr(NEW.item_id, 7)
              AND json_extract(item.value, '$.purpose') IS NEW.purpose
              AND json_extract(item.value, '$.byteSize') IS NEW.expected_byte_size
              AND json_extract(item.value, '$.sha256') IS NEW.expected_sha256
          ))
        )
    ))
  );
END;

CREATE TRIGGER file_acceptance_candidates_legacy_update_guard
BEFORE UPDATE ON file_acceptance_candidates BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority cannot publish acceptance candidates')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
END;

CREATE TRIGGER file_acceptance_candidates_update_guard
BEFORE UPDATE ON file_acceptance_candidates BEGIN
  SELECT RAISE(ABORT, 'Acceptance candidate identity or result transition is invalid')
  WHERE OLD.state <> 'candidate' OR NEW.state NOT IN ('ready', 'cancelled')
    OR NEW.acceptance_kind IS NOT OLD.acceptance_kind OR NEW.acceptance_id IS NOT OLD.acceptance_id
    OR NEW.item_id IS NOT OLD.item_id OR NEW.purpose IS NOT OLD.purpose
    OR NEW.access_scope IS NOT OLD.access_scope OR NEW.storage_profile_id IS NOT OLD.storage_profile_id
    OR NEW.expected_byte_size IS NOT OLD.expected_byte_size OR NEW.expected_sha256 IS NOT OLD.expected_sha256
    OR NEW.candidate_file_id IS NOT OLD.candidate_file_id OR NEW.candidate_location_id IS NOT OLD.candidate_location_id
    OR NEW.candidate_object_key IS NOT OLD.candidate_object_key OR NEW.created_at IS NOT OLD.created_at
    OR (NEW.state = 'ready' AND NEW.result_file_id IS NOT OLD.candidate_file_id
      AND EXISTS (SELECT 1 FROM file_publications WHERE file_id = OLD.candidate_file_id))
    OR (NEW.state = 'ready' AND (
      NOT EXISTS (
        SELECT 1 FROM file_location_publications candidate
        JOIN file_location_availability available ON available.location_id = candidate.location_id
        WHERE candidate.location_id = OLD.candidate_location_id
          AND candidate.file_id = OLD.candidate_file_id
          AND candidate.storage_profile_id = OLD.storage_profile_id
          AND candidate.object_key = OLD.candidate_object_key
          AND candidate.verified_byte_size IS OLD.expected_byte_size
          AND candidate.verified_sha256 IS OLD.expected_sha256
          AND available.availability = 'available'
      )
      OR NOT EXISTS (
        SELECT 1 FROM file_usable_publications fp
        JOIN file_location_publications flp ON flp.location_id = NEW.result_location_id
        WHERE fp.file_id = NEW.result_file_id
          AND fp.purpose IS NEW.purpose AND fp.access_scope IS NEW.access_scope
          AND fp.verified_byte_size IS NEW.expected_byte_size AND fp.verified_sha256 IS NEW.expected_sha256
          AND fp.active_location_id IS NEW.result_location_id AND flp.storage_profile_id IS NEW.storage_profile_id
      )
    ))
    OR (NEW.state = 'cancelled' AND (
      EXISTS (SELECT 1 FROM file_publications WHERE file_id = OLD.candidate_file_id)
    ));
END;

CREATE TRIGGER file_acceptance_candidates_delete_guard
BEFORE DELETE ON file_acceptance_candidates BEGIN
  SELECT RAISE(ABORT, 'Acceptance candidate history cannot be deleted');
END;

CREATE TRIGGER state_representation_assets_file_insert_guard
BEFORE INSERT ON state_representation_assets WHEN NEW.file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'State representation File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.file_id AND fp.purpose = 'embedded_content');
END;

CREATE TRIGGER state_representation_assets_file_update_guard
BEFORE UPDATE OF file_id ON state_representation_assets WHEN NEW.file_id IS NOT NULL OR OLD.file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding')
  WHERE NEW.file_id IS NOT NULL AND NEW.rowid = -1;
  SELECT RAISE(ABORT, 'Typed File binding is fill-once')
  WHERE OLD.file_id IS NOT NULL AND NEW.file_id IS NOT OLD.file_id;
  SELECT RAISE(ABORT, 'Admitted-unresolved consumer cannot later gain a typed File binding')
  WHERE OLD.file_id IS NULL AND NEW.file_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'state_representation_asset' AND d.consumer_id = NEW.state_hash
      AND d.consumer_sub_id = NEW.asset_id AND d.file_slot = 'primary' AND d.decision = 'admitted_unresolved');
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'State representation File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.file_id AND fp.purpose = 'embedded_content');
END;

CREATE TRIGGER run_step_assets_file_insert_guard
BEFORE INSERT ON run_step_assets WHEN NEW.file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Run-step File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.file_id AND fp.purpose = 'embedded_content');
END;

CREATE TRIGGER run_step_assets_file_update_guard
BEFORE UPDATE OF file_id ON run_step_assets WHEN NEW.file_id IS NOT NULL OR OLD.file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding')
  WHERE NEW.file_id IS NOT NULL AND NEW.rowid = -1;
  SELECT RAISE(ABORT, 'Typed File binding is fill-once')
  WHERE OLD.file_id IS NOT NULL AND NEW.file_id IS NOT OLD.file_id;
  SELECT RAISE(ABORT, 'Admitted-unresolved consumer cannot later gain a typed File binding')
  WHERE OLD.file_id IS NULL AND NEW.file_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'run_step_asset' AND d.consumer_id = NEW.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'primary' AND d.decision = 'admitted_unresolved');
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Run-step File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.file_id AND fp.purpose = 'embedded_content');
END;

CREATE TRIGGER metrology_template_references_file_insert_guard
BEFORE INSERT ON metrology_template_references WHEN NEW.file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Metrology reference File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.file_id AND fp.purpose = 'research_source');
END;

CREATE TRIGGER metrology_template_references_file_update_guard
BEFORE UPDATE OF file_id ON metrology_template_references WHEN NEW.file_id IS NOT NULL OR OLD.file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding')
  WHERE NEW.file_id IS NOT NULL AND NEW.rowid = -1;
  SELECT RAISE(ABORT, 'Typed File binding is fill-once')
  WHERE OLD.file_id IS NOT NULL AND NEW.file_id IS NOT OLD.file_id;
  SELECT RAISE(ABORT, 'Admitted-unresolved consumer cannot later gain a typed File binding')
  WHERE OLD.file_id IS NULL AND NEW.file_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'metrology_template_reference' AND d.consumer_id = NEW.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'primary' AND d.decision = 'admitted_unresolved');
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Metrology reference File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.file_id AND fp.purpose = 'research_source');
END;

CREATE TRIGGER run_step_comments_file_insert_guard
BEFORE INSERT ON run_step_comments WHEN NEW.file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Comment File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.file_id AND fp.purpose = 'embedded_content');
END;

CREATE TRIGGER run_step_comments_file_update_guard
BEFORE UPDATE OF file_id ON run_step_comments WHEN NEW.file_id IS NOT NULL OR OLD.file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding')
  WHERE NEW.file_id IS NOT NULL AND NEW.rowid = -1;
  SELECT RAISE(ABORT, 'Typed File binding is fill-once')
  WHERE OLD.file_id IS NOT NULL AND NEW.file_id IS NOT OLD.file_id;
  SELECT RAISE(ABORT, 'Admitted-unresolved consumer cannot later gain a typed File binding')
  WHERE OLD.file_id IS NULL AND NEW.file_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'run_step_comment' AND d.consumer_id = NEW.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'primary' AND d.decision = 'admitted_unresolved');
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Comment File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.file_id AND fp.purpose = 'embedded_content');
END;

CREATE TRIGGER state_verifications_file_insert_guard
BEFORE INSERT ON state_verifications WHEN NEW.evidence_file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Verification evidence File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.evidence_file_id AND fp.purpose = 'embedded_content');
END;

CREATE TRIGGER state_verifications_file_update_guard
BEFORE UPDATE OF evidence_file_id ON state_verifications WHEN NEW.evidence_file_id IS NOT NULL OR OLD.evidence_file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding')
  WHERE NEW.evidence_file_id IS NOT NULL AND NEW.rowid = -1;
  SELECT RAISE(ABORT, 'Typed File binding is fill-once')
  WHERE OLD.evidence_file_id IS NOT NULL AND NEW.evidence_file_id IS NOT OLD.evidence_file_id;
  SELECT RAISE(ABORT, 'Admitted-unresolved consumer cannot later gain a typed File binding')
  WHERE OLD.evidence_file_id IS NULL AND NEW.evidence_file_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'state_verification' AND d.consumer_id = NEW.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'evidence' AND d.decision = 'admitted_unresolved');
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Verification evidence File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.evidence_file_id AND fp.purpose = 'embedded_content');
END;

CREATE TRIGGER comment_submission_items_file_insert_guard
BEFORE INSERT ON comment_submission_items WHEN NEW.file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Comment item File purpose or readiness mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM file_usable_publications fp WHERE fp.file_id = NEW.file_id
      AND ((NEW.kind = 'attachment' AND fp.purpose = 'research_source')
        OR (NEW.kind = 'comment_image' AND NEW.related_item_id IS NULL AND fp.purpose = 'embedded_content')
        OR (NEW.kind = 'comment_image' AND NEW.related_item_id IS NOT NULL AND fp.purpose = 'derived_preview'))
      AND (NEW.kind <> 'comment_image' OR NEW.related_item_id IS NULL OR EXISTS (
        SELECT 1 FROM file_derivations d
        JOIN comment_submission_items source_item ON source_item.id = NEW.related_item_id
        JOIN file_usable_publications source ON source.file_id = d.source_file_id
        WHERE d.derived_file_id = NEW.file_id AND d.trust_state = 'verified'
          AND source_item.file_id = d.source_file_id
      ))
  );
END;

CREATE TRIGGER comment_submission_items_file_update_guard
BEFORE UPDATE OF file_id ON comment_submission_items WHEN NEW.file_id IS NOT NULL OR OLD.file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding')
  WHERE NEW.file_id IS NOT NULL AND NEW.rowid = -1;
  SELECT RAISE(ABORT, 'Typed File binding is fill-once')
  WHERE OLD.file_id IS NOT NULL AND NEW.file_id IS NOT OLD.file_id;
  SELECT RAISE(ABORT, 'Admitted-unresolved consumer cannot later gain a typed File binding')
  WHERE OLD.file_id IS NULL AND NEW.file_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'comment_submission_item' AND d.consumer_id = NEW.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'primary' AND d.decision = 'admitted_unresolved');
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Comment item File purpose or readiness mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM file_usable_publications fp WHERE fp.file_id = NEW.file_id
      AND ((NEW.kind = 'attachment' AND fp.purpose = 'research_source')
        OR (NEW.kind = 'comment_image' AND NEW.related_item_id IS NULL AND fp.purpose = 'embedded_content')
        OR (NEW.kind = 'comment_image' AND NEW.related_item_id IS NOT NULL AND fp.purpose = 'derived_preview'))
      AND (NEW.kind <> 'comment_image' OR NEW.related_item_id IS NULL OR EXISTS (
        SELECT 1 FROM file_derivations d
        JOIN comment_submission_items source_item ON source_item.id = NEW.related_item_id
        JOIN file_usable_publications source ON source.file_id = d.source_file_id
        WHERE d.derived_file_id = NEW.file_id AND d.trust_state = 'verified'
          AND source_item.file_id = d.source_file_id
      ))
  );
END;

CREATE TRIGGER project_content_attachments_file_insert_guard
BEFORE INSERT ON project_content_attachments WHEN NEW.file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Project attachment File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.file_id AND fp.purpose = 'research_source');
END;

CREATE TRIGGER project_content_attachments_file_update_guard
BEFORE UPDATE OF file_id ON project_content_attachments WHEN NEW.file_id IS NOT NULL OR OLD.file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding')
  WHERE NEW.file_id IS NOT NULL AND NEW.rowid = -1;
  SELECT RAISE(ABORT, 'Typed File binding is fill-once')
  WHERE OLD.file_id IS NOT NULL AND NEW.file_id IS NOT OLD.file_id;
  SELECT RAISE(ABORT, 'Admitted-unresolved consumer cannot later gain a typed File binding')
  WHERE OLD.file_id IS NULL AND NEW.file_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'project_content_attachment' AND d.consumer_id = NEW.project_content_id
      AND d.consumer_sub_id = '' AND d.file_slot = 'primary' AND d.decision = 'admitted_unresolved');
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Project attachment File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.file_id AND fp.purpose = 'research_source');
END;

CREATE TRIGGER attachment_derivatives_file_insert_guard
BEFORE INSERT ON attachment_derivatives WHEN NEW.derived_file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Attachment derivative File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    JOIN file_derivations d ON d.derived_file_id = fp.file_id AND d.trust_state = 'verified'
    JOIN file_usable_publications source ON source.file_id = d.source_file_id
    WHERE fp.file_id = NEW.derived_file_id AND fp.purpose = 'derived_preview'
      AND d.generator = NEW.derivative_kind AND d.generator_version IS NEW.generator_version
      AND d.source_verified_sha256 = NEW.source_sha256
      AND source.verified_byte_size = NEW.source_byte_size);
END;

CREATE TRIGGER attachment_derivatives_file_update_guard
BEFORE UPDATE OF derived_file_id ON attachment_derivatives WHEN NEW.derived_file_id IS NOT NULL OR OLD.derived_file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding')
  WHERE NEW.derived_file_id IS NOT NULL AND NEW.rowid = -1;
  SELECT RAISE(ABORT, 'Typed File binding is fill-once')
  WHERE OLD.derived_file_id IS NOT NULL AND NEW.derived_file_id IS NOT OLD.derived_file_id;
  SELECT RAISE(ABORT, 'Admitted-unresolved consumer cannot later gain a typed File binding')
  WHERE OLD.derived_file_id IS NULL AND NEW.derived_file_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'attachment_derivative' AND d.consumer_id = NEW.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'derived' AND d.decision = 'admitted_unresolved');
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Attachment derivative File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    JOIN file_derivations d ON d.derived_file_id = fp.file_id AND d.trust_state = 'verified'
    JOIN file_usable_publications source ON source.file_id = d.source_file_id
    WHERE fp.file_id = NEW.derived_file_id AND fp.purpose = 'derived_preview'
      AND d.generator = NEW.derivative_kind AND d.generator_version IS NEW.generator_version
      AND d.source_verified_sha256 = NEW.source_sha256
      AND source.verified_byte_size = NEW.source_byte_size);
END;

CREATE TRIGGER events_asset_file_insert_guard
BEFORE INSERT ON events WHEN NEW.asset_file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Event asset File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.asset_file_id AND fp.purpose = 'embedded_content');
END;

CREATE TRIGGER events_asset_file_update_guard
BEFORE UPDATE OF asset_file_id ON events WHEN NEW.asset_file_id IS NOT NULL OR OLD.asset_file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding')
  WHERE NEW.asset_file_id IS NOT NULL AND NEW.rowid = -1;
  SELECT RAISE(ABORT, 'Typed File binding is fill-once')
  WHERE OLD.asset_file_id IS NOT NULL AND NEW.asset_file_id IS NOT OLD.asset_file_id;
  SELECT RAISE(ABORT, 'Admitted-unresolved consumer cannot later gain a typed File binding')
  WHERE OLD.asset_file_id IS NULL AND NEW.asset_file_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'event' AND d.consumer_id = NEW.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'primary' AND d.decision = 'admitted_unresolved');
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Event asset File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.asset_file_id AND fp.purpose = 'embedded_content');
END;

CREATE TRIGGER events_thumbnail_file_insert_guard
BEFORE INSERT ON events WHEN NEW.thumbnail_file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Event thumbnail File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    JOIN file_derivations d ON d.derived_file_id = fp.file_id AND d.trust_state = 'verified'
    JOIN file_usable_publications source ON source.file_id = d.source_file_id
    WHERE fp.file_id = NEW.thumbnail_file_id AND fp.purpose = 'derived_preview'
      AND NEW.asset_file_id = d.source_file_id);
END;

CREATE TRIGGER events_thumbnail_file_update_guard
BEFORE UPDATE OF thumbnail_file_id ON events WHEN NEW.thumbnail_file_id IS NOT NULL OR OLD.thumbnail_file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding')
  WHERE NEW.thumbnail_file_id IS NOT NULL AND NEW.rowid = -1;
  SELECT RAISE(ABORT, 'Typed File binding is fill-once')
  WHERE OLD.thumbnail_file_id IS NOT NULL AND NEW.thumbnail_file_id IS NOT OLD.thumbnail_file_id;
  SELECT RAISE(ABORT, 'Admitted-unresolved consumer cannot later gain a typed File binding')
  WHERE OLD.thumbnail_file_id IS NULL AND NEW.thumbnail_file_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'event' AND d.consumer_id = NEW.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'thumbnail' AND d.decision = 'admitted_unresolved');
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Event thumbnail File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    JOIN file_derivations d ON d.derived_file_id = fp.file_id AND d.trust_state = 'verified'
    JOIN file_usable_publications source ON source.file_id = d.source_file_id
    WHERE fp.file_id = NEW.thumbnail_file_id AND fp.purpose = 'derived_preview'
      AND NEW.asset_file_id = d.source_file_id);
END;

CREATE TRIGGER imports_workbook_file_insert_guard
BEFORE INSERT ON imports WHEN NEW.workbook_file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Import workbook File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.workbook_file_id AND fp.purpose = 'provenance');
END;

CREATE TRIGGER imports_workbook_file_update_guard
BEFORE UPDATE OF workbook_file_id ON imports WHEN NEW.workbook_file_id IS NOT NULL OR OLD.workbook_file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding')
  WHERE NEW.workbook_file_id IS NOT NULL AND NEW.rowid = -1;
  SELECT RAISE(ABORT, 'Typed File binding is fill-once')
  WHERE OLD.workbook_file_id IS NOT NULL AND NEW.workbook_file_id IS NOT OLD.workbook_file_id;
  SELECT RAISE(ABORT, 'Admitted-unresolved consumer cannot later gain a typed File binding')
  WHERE OLD.workbook_file_id IS NULL AND NEW.workbook_file_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'import' AND d.consumer_id = NEW.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'workbook' AND d.decision = 'admitted_unresolved');
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Import workbook File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.workbook_file_id AND fp.purpose = 'provenance');
END;

CREATE TRIGGER imports_manifest_file_insert_guard
BEFORE INSERT ON imports WHEN NEW.manifest_file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Import manifest File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.manifest_file_id AND fp.purpose = 'provenance');
END;

CREATE TRIGGER imports_manifest_file_update_guard
BEFORE UPDATE OF manifest_file_id ON imports WHEN NEW.manifest_file_id IS NOT NULL OR OLD.manifest_file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding')
  WHERE NEW.manifest_file_id IS NOT NULL AND NEW.rowid = -1;
  SELECT RAISE(ABORT, 'Typed File binding is fill-once')
  WHERE OLD.manifest_file_id IS NOT NULL AND NEW.manifest_file_id IS NOT OLD.manifest_file_id;
  SELECT RAISE(ABORT, 'Admitted-unresolved consumer cannot later gain a typed File binding')
  WHERE OLD.manifest_file_id IS NULL AND NEW.manifest_file_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'import' AND d.consumer_id = NEW.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'manifest' AND d.decision = 'admitted_unresolved');
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Import manifest File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.manifest_file_id AND fp.purpose = 'provenance');
END;

CREATE TRIGGER template_versions_source_file_insert_guard
BEFORE INSERT ON template_versions WHEN NEW.source_file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Template source File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.source_file_id AND fp.purpose = 'provenance');
END;

CREATE TRIGGER template_versions_source_file_update_guard
BEFORE UPDATE OF source_file_id ON template_versions WHEN NEW.source_file_id IS NOT NULL OR OLD.source_file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding')
  WHERE NEW.source_file_id IS NOT NULL AND NEW.rowid = -1;
  SELECT RAISE(ABORT, 'Typed File binding is fill-once')
  WHERE OLD.source_file_id IS NOT NULL AND NEW.source_file_id IS NOT OLD.source_file_id;
  SELECT RAISE(ABORT, 'Admitted-unresolved consumer cannot later gain a typed File binding')
  WHERE OLD.source_file_id IS NULL AND NEW.source_file_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'template_version' AND d.consumer_id = NEW.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'source' AND d.decision = 'admitted_unresolved');
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Template source File purpose or readiness mismatch')
  WHERE NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    WHERE fp.file_id = NEW.source_file_id AND fp.purpose = 'provenance');
END;

-- A normal BEFORE INSERT exposes NEW.rowid as -1 until SQLite allocates the
-- real value. Check after allocation so an explicit rowid=-1 can never become
-- a typed authority anchor; the transaction still rolls back atomically.
CREATE TRIGGER state_representation_assets_file_rowid_guard
AFTER INSERT ON state_representation_assets WHEN NEW.file_id IS NOT NULL AND NEW.rowid = -1 BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding');
END;

CREATE TRIGGER run_step_assets_file_rowid_guard
AFTER INSERT ON run_step_assets WHEN NEW.file_id IS NOT NULL AND NEW.rowid = -1 BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding');
END;

CREATE TRIGGER metrology_template_references_file_rowid_guard
AFTER INSERT ON metrology_template_references WHEN NEW.file_id IS NOT NULL AND NEW.rowid = -1 BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding');
END;

CREATE TRIGGER run_step_comments_file_rowid_guard
AFTER INSERT ON run_step_comments WHEN NEW.file_id IS NOT NULL AND NEW.rowid = -1 BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding');
END;

CREATE TRIGGER state_verifications_file_rowid_guard
AFTER INSERT ON state_verifications WHEN NEW.evidence_file_id IS NOT NULL AND NEW.rowid = -1 BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding');
END;

CREATE TRIGGER comment_submission_items_file_rowid_guard
AFTER INSERT ON comment_submission_items WHEN NEW.file_id IS NOT NULL AND NEW.rowid = -1 BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding');
END;

CREATE TRIGGER project_content_attachments_file_rowid_guard
AFTER INSERT ON project_content_attachments WHEN NEW.file_id IS NOT NULL AND NEW.rowid = -1 BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding');
END;

CREATE TRIGGER attachment_derivatives_file_rowid_guard
AFTER INSERT ON attachment_derivatives WHEN NEW.derived_file_id IS NOT NULL AND NEW.rowid = -1 BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding');
END;

CREATE TRIGGER events_file_rowid_guard
AFTER INSERT ON events WHEN (NEW.asset_file_id IS NOT NULL OR NEW.thumbnail_file_id IS NOT NULL) AND NEW.rowid = -1 BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding');
END;

CREATE TRIGGER imports_file_rowid_guard
AFTER INSERT ON imports WHEN (NEW.workbook_file_id IS NOT NULL OR NEW.manifest_file_id IS NOT NULL) AND NEW.rowid = -1 BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding');
END;

CREATE TRIGGER template_versions_file_rowid_guard
AFTER INSERT ON template_versions WHEN NEW.source_file_id IS NOT NULL AND NEW.rowid = -1 BEGIN
  SELECT RAISE(ABORT, 'Consumer rowid -1 cannot anchor a typed File binding');
END;

-- Once a typed binding or terminal migration decision exists, its consumer
-- identity, legacy locator, and purpose-defining context are frozen. This keeps
-- the overlap projection and immutable decision evidence from drifting apart.
CREATE TRIGGER state_representation_assets_file_locator_guard
BEFORE UPDATE ON state_representation_assets BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer locator is immutable')
  WHERE (OLD.file_id IS NOT NULL OR NEW.file_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'state_representation_asset' AND d.consumer_id = OLD.state_hash
        AND d.consumer_sub_id = OLD.asset_id AND d.file_slot = 'primary'))
    AND (NEW.rowid IS NOT OLD.rowid OR NEW.state_hash IS NOT OLD.state_hash OR NEW.asset_id IS NOT OLD.asset_id);
END;

CREATE TRIGGER run_step_assets_file_locator_guard
BEFORE UPDATE ON run_step_assets BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer locator is immutable')
  WHERE (OLD.file_id IS NOT NULL OR NEW.file_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'run_step_asset' AND d.consumer_id = OLD.id
        AND d.consumer_sub_id = '' AND d.file_slot = 'primary'))
    AND (NEW.rowid IS NOT OLD.rowid OR NEW.id IS NOT OLD.id OR NEW.asset_id IS NOT OLD.asset_id);
END;

CREATE TRIGGER metrology_template_references_file_locator_guard
BEFORE UPDATE ON metrology_template_references BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer locator is immutable')
  WHERE (OLD.file_id IS NOT NULL OR NEW.file_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'metrology_template_reference' AND d.consumer_id = OLD.id
        AND d.consumer_sub_id = '' AND d.file_slot = 'primary'))
    AND (NEW.rowid IS NOT OLD.rowid OR NEW.id IS NOT OLD.id OR NEW.asset_id IS NOT OLD.asset_id);
END;

CREATE TRIGGER run_step_comments_file_locator_guard
BEFORE UPDATE ON run_step_comments BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer locator is immutable')
  WHERE (OLD.file_id IS NOT NULL OR NEW.file_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'run_step_comment' AND d.consumer_id = OLD.id
        AND d.consumer_sub_id = '' AND d.file_slot = 'primary'))
    AND (NEW.rowid IS NOT OLD.rowid OR NEW.id IS NOT OLD.id OR NEW.asset_id IS NOT OLD.asset_id);
END;

CREATE TRIGGER state_verifications_file_locator_guard
BEFORE UPDATE ON state_verifications BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer locator is immutable')
  WHERE (OLD.evidence_file_id IS NOT NULL OR NEW.evidence_file_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'state_verification' AND d.consumer_id = OLD.id
        AND d.consumer_sub_id = '' AND d.file_slot = 'evidence'))
    AND (NEW.rowid IS NOT OLD.rowid OR NEW.id IS NOT OLD.id OR NEW.evidence_asset_id IS NOT OLD.evidence_asset_id);
END;

CREATE TRIGGER comment_submission_items_file_locator_guard
BEFORE UPDATE ON comment_submission_items BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer locator is immutable')
  WHERE (OLD.file_id IS NOT NULL OR NEW.file_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'comment_submission_item' AND d.consumer_id = OLD.id
        AND d.consumer_sub_id = '' AND d.file_slot = 'primary'))
    AND (NEW.rowid IS NOT OLD.rowid OR NEW.id IS NOT OLD.id OR NEW.asset_id IS NOT OLD.asset_id
      OR NEW.storage_object_id IS NOT OLD.storage_object_id OR NEW.kind IS NOT OLD.kind
      OR NEW.related_item_id IS NOT OLD.related_item_id);
END;

CREATE TRIGGER project_content_attachments_file_locator_guard
BEFORE UPDATE ON project_content_attachments BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer locator is immutable')
  WHERE (OLD.file_id IS NOT NULL OR NEW.file_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'project_content_attachment' AND d.consumer_id = OLD.project_content_id
        AND d.consumer_sub_id = '' AND d.file_slot = 'primary'))
    AND (NEW.rowid IS NOT OLD.rowid OR NEW.project_content_id IS NOT OLD.project_content_id
      OR NEW.asset_id IS NOT OLD.asset_id OR NEW.storage_object_id IS NOT OLD.storage_object_id);
END;

CREATE TRIGGER attachment_derivatives_file_locator_guard
BEFORE UPDATE ON attachment_derivatives BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer locator is immutable')
  WHERE (OLD.derived_file_id IS NOT NULL OR NEW.derived_file_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'attachment_derivative' AND d.consumer_id = OLD.id
        AND d.consumer_sub_id = '' AND d.file_slot = 'derived'))
    AND (NEW.rowid IS NOT OLD.rowid OR NEW.id IS NOT OLD.id OR NEW.derived_asset_id IS NOT OLD.derived_asset_id
      OR NEW.source_sha256 IS NOT OLD.source_sha256 OR NEW.source_byte_size IS NOT OLD.source_byte_size
      OR NEW.derivative_kind IS NOT OLD.derivative_kind OR NEW.generator_version IS NOT OLD.generator_version);
END;

CREATE TRIGGER events_file_locator_guard
BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer locator is immutable')
  WHERE (
      (OLD.asset_file_id IS NOT NULL OR NEW.asset_file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'event' AND d.consumer_id = OLD.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'primary'))
      AND (NEW.rowid IS NOT OLD.rowid OR NEW.id IS NOT OLD.id OR NEW.asset_key IS NOT OLD.asset_key)
    ) OR (
      (OLD.thumbnail_file_id IS NOT NULL OR NEW.thumbnail_file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'event' AND d.consumer_id = OLD.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'thumbnail'))
      AND (NEW.rowid IS NOT OLD.rowid OR NEW.id IS NOT OLD.id OR NEW.asset_file_id IS NOT OLD.asset_file_id
        OR (CASE WHEN json_valid(NEW.metadata_json) THEN json_extract(NEW.metadata_json, '$.thumbnailKey') END)
          IS NOT (CASE WHEN json_valid(OLD.metadata_json) THEN json_extract(OLD.metadata_json, '$.thumbnailKey') END))
    );
END;

CREATE TRIGGER imports_file_locator_guard
BEFORE UPDATE ON imports BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer locator is immutable')
  WHERE (
      (OLD.workbook_file_id IS NOT NULL OR NEW.workbook_file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'import' AND d.consumer_id = OLD.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'workbook'))
      AND (NEW.rowid IS NOT OLD.rowid OR NEW.id IS NOT OLD.id OR NEW.workbook_asset_key IS NOT OLD.workbook_asset_key)
    ) OR (
      (OLD.manifest_file_id IS NOT NULL OR NEW.manifest_file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'import' AND d.consumer_id = OLD.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'manifest'))
      AND (NEW.rowid IS NOT OLD.rowid OR NEW.id IS NOT OLD.id OR NEW.manifest_asset_key IS NOT OLD.manifest_asset_key)
    );
END;

CREATE TRIGGER template_versions_file_locator_guard
BEFORE UPDATE ON template_versions BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer locator is immutable')
  WHERE (OLD.source_file_id IS NOT NULL OR NEW.source_file_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'template_version' AND d.consumer_id = OLD.id
        AND d.consumer_sub_id = '' AND d.file_slot = 'source'))
    AND (NEW.rowid IS NOT OLD.rowid OR NEW.id IS NOT OLD.id OR NEW.source_asset_key IS NOT OLD.source_asset_key);
END;

-- UPDATE OR REPLACE has the same implicit-delete behavior as INSERT OR
-- REPLACE. Fence every conflicting destination row before SQLite can remove
-- its typed binding or orphan its terminal migration decision.
CREATE TRIGGER state_representation_assets_file_update_conflict_guard
BEFORE UPDATE ON state_representation_assets BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer conflicts with replacement update')
  WHERE EXISTS (SELECT 1 FROM state_representation_assets target
    WHERE target.rowid <> OLD.rowid
      AND ((target.state_hash = NEW.state_hash AND target.asset_id = NEW.asset_id) OR target.rowid = NEW.rowid)
      AND (target.file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'state_representation_asset' AND d.consumer_id = target.state_hash
          AND d.consumer_sub_id = target.asset_id AND d.file_slot = 'primary')));
END;

CREATE TRIGGER run_step_assets_file_update_conflict_guard
BEFORE UPDATE ON run_step_assets BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer conflicts with replacement update')
  WHERE EXISTS (SELECT 1 FROM run_step_assets target
    WHERE target.rowid <> OLD.rowid
      AND (target.id = NEW.id OR target.rowid = NEW.rowid OR (target.run_step_id = NEW.run_step_id
        AND target.asset_id = NEW.asset_id AND target.role = NEW.role))
      AND (target.file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'run_step_asset' AND d.consumer_id = target.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'primary')));
END;

CREATE TRIGGER metrology_template_references_file_update_conflict_guard
BEFORE UPDATE ON metrology_template_references BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer conflicts with replacement update')
  WHERE EXISTS (SELECT 1 FROM metrology_template_references target
    WHERE target.rowid <> OLD.rowid
      AND (target.id = NEW.id OR target.rowid = NEW.rowid
        OR (target.template_version_id = NEW.template_version_id AND target.asset_id = NEW.asset_id))
      AND (target.file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'metrology_template_reference' AND d.consumer_id = target.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'primary')));
END;

CREATE TRIGGER run_step_comments_file_update_conflict_guard
BEFORE UPDATE ON run_step_comments BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer conflicts with replacement update')
  WHERE EXISTS (SELECT 1 FROM run_step_comments target
    WHERE target.rowid <> OLD.rowid AND (target.id = NEW.id OR target.rowid = NEW.rowid)
      AND (target.file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'run_step_comment' AND d.consumer_id = target.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'primary')));
END;

CREATE TRIGGER state_verifications_file_update_conflict_guard
BEFORE UPDATE ON state_verifications BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer conflicts with replacement update')
  WHERE EXISTS (SELECT 1 FROM state_verifications target
    WHERE target.rowid <> OLD.rowid AND (target.id = NEW.id OR target.rowid = NEW.rowid)
      AND (target.evidence_file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'state_verification' AND d.consumer_id = target.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'evidence')));
END;

CREATE TRIGGER comment_submission_items_file_update_conflict_guard
BEFORE UPDATE ON comment_submission_items BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer conflicts with replacement update')
  WHERE EXISTS (SELECT 1 FROM comment_submission_items target
    WHERE target.rowid <> OLD.rowid
      AND (target.id = NEW.id OR target.rowid = NEW.rowid
        OR (target.submission_id = NEW.submission_id AND target.position = NEW.position))
      AND (target.file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'comment_submission_item' AND d.consumer_id = target.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'primary')));
END;

CREATE TRIGGER project_content_attachments_file_update_conflict_guard
BEFORE UPDATE ON project_content_attachments BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer conflicts with replacement update')
  WHERE EXISTS (SELECT 1 FROM project_content_attachments target
    WHERE target.rowid <> OLD.rowid
      AND (target.project_content_id = NEW.project_content_id OR target.rowid = NEW.rowid)
      AND (target.file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'project_content_attachment' AND d.consumer_id = target.project_content_id
          AND d.consumer_sub_id = '' AND d.file_slot = 'primary')));
END;

CREATE TRIGGER attachment_derivatives_file_update_conflict_guard
BEFORE UPDATE ON attachment_derivatives BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer conflicts with replacement update')
  WHERE EXISTS (SELECT 1 FROM attachment_derivatives target
    WHERE target.rowid <> OLD.rowid
      AND (target.id = NEW.id OR target.rowid = NEW.rowid OR (target.source_sha256 = NEW.source_sha256
        AND target.source_byte_size = NEW.source_byte_size AND target.derivative_kind = NEW.derivative_kind
        AND target.generator_version = NEW.generator_version))
      AND (target.derived_file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'attachment_derivative' AND d.consumer_id = target.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'derived')));
END;

CREATE TRIGGER events_file_update_conflict_guard
BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer conflicts with replacement update')
  WHERE EXISTS (SELECT 1 FROM events target
    WHERE target.rowid <> OLD.rowid AND (target.id = NEW.id OR target.rowid = NEW.rowid)
      AND (target.asset_file_id IS NOT NULL OR target.thumbnail_file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'event' AND d.consumer_id = target.id AND d.consumer_sub_id = '')));
END;

CREATE TRIGGER imports_file_update_conflict_guard
BEFORE UPDATE ON imports BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer conflicts with replacement update')
  WHERE EXISTS (SELECT 1 FROM imports target
    WHERE target.rowid <> OLD.rowid
      AND (target.id = NEW.id OR target.rowid = NEW.rowid
        OR (NEW.client_request_id IS NOT NULL AND target.actor_email = NEW.actor_email
          AND target.client_request_id = NEW.client_request_id)
        OR (NEW.operation_id IS NOT NULL AND target.operation_id = NEW.operation_id)
        OR (NEW.finalization_id IS NOT NULL AND target.finalization_id = NEW.finalization_id))
      AND (target.workbook_file_id IS NOT NULL OR target.manifest_file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'import' AND d.consumer_id = target.id AND d.consumer_sub_id = '')));
END;

CREATE TRIGGER template_versions_file_update_conflict_guard
BEFORE UPDATE ON template_versions BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer conflicts with replacement update')
  WHERE EXISTS (SELECT 1 FROM template_versions target
    WHERE target.rowid <> OLD.rowid
      AND (target.id = NEW.id OR target.rowid = NEW.rowid
        OR (target.recipe_family_id = NEW.recipe_family_id AND target.version = NEW.version)
        OR (target.name = NEW.name AND target.template_type = NEW.template_type AND target.version = NEW.version))
      AND (target.source_file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'template_version' AND d.consumer_id = target.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'source')));
END;

CREATE TRIGGER state_representation_assets_file_delete_guard
BEFORE DELETE ON state_representation_assets BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer cannot be physically deleted')
  WHERE OLD.file_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'state_representation_asset' AND d.consumer_id = OLD.state_hash
      AND d.consumer_sub_id = OLD.asset_id AND d.file_slot = 'primary');
END;

CREATE TRIGGER run_step_assets_file_delete_guard
BEFORE DELETE ON run_step_assets BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer cannot be physically deleted')
  WHERE OLD.file_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'run_step_asset' AND d.consumer_id = OLD.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'primary');
END;

CREATE TRIGGER metrology_template_references_file_delete_guard
BEFORE DELETE ON metrology_template_references BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer cannot be physically deleted')
  WHERE OLD.file_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'metrology_template_reference' AND d.consumer_id = OLD.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'primary');
END;

CREATE TRIGGER run_step_comments_file_delete_guard
BEFORE DELETE ON run_step_comments BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer cannot be physically deleted')
  WHERE OLD.file_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'run_step_comment' AND d.consumer_id = OLD.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'primary');
END;

CREATE TRIGGER state_verifications_file_delete_guard
BEFORE DELETE ON state_verifications BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer cannot be physically deleted')
  WHERE OLD.evidence_file_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'state_verification' AND d.consumer_id = OLD.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'evidence');
END;

CREATE TRIGGER comment_submission_items_file_delete_guard
BEFORE DELETE ON comment_submission_items BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer cannot be physically deleted')
  WHERE OLD.file_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'comment_submission_item' AND d.consumer_id = OLD.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'primary');
END;

CREATE TRIGGER project_content_attachments_file_delete_guard
BEFORE DELETE ON project_content_attachments BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer cannot be physically deleted')
  WHERE OLD.file_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'project_content_attachment' AND d.consumer_id = OLD.project_content_id
      AND d.consumer_sub_id = '' AND d.file_slot = 'primary');
END;

CREATE TRIGGER attachment_derivatives_file_delete_guard
BEFORE DELETE ON attachment_derivatives BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer cannot be physically deleted')
  WHERE OLD.derived_file_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'attachment_derivative' AND d.consumer_id = OLD.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'derived');
END;

CREATE TRIGGER events_file_delete_guard
BEFORE DELETE ON events BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer cannot be physically deleted')
  WHERE OLD.asset_file_id IS NOT NULL OR OLD.thumbnail_file_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'event' AND d.consumer_id = OLD.id AND d.consumer_sub_id = '');
END;

CREATE TRIGGER imports_file_delete_guard
BEFORE DELETE ON imports BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer cannot be physically deleted')
  WHERE OLD.workbook_file_id IS NOT NULL OR OLD.manifest_file_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'import' AND d.consumer_id = OLD.id AND d.consumer_sub_id = '');
END;

CREATE TRIGGER template_versions_file_delete_guard
BEFORE DELETE ON template_versions BEGIN
  SELECT RAISE(ABORT, 'Resolved File consumer cannot be physically deleted')
  WHERE OLD.source_file_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM file_consumer_migration_decisions d
    WHERE d.consumer_kind = 'template_version' AND d.consumer_id = OLD.id
      AND d.consumer_sub_id = '' AND d.file_slot = 'source');
END;

-- SQLite's INSERT OR REPLACE performs its implicit delete without firing
-- DELETE triggers when recursive_triggers is disabled (the D1 default). Keep
-- old all-NULL replacement behavior compatible, but require typed backfill to
-- use the reviewed fill-once UPDATE path and never let replacement clear it.
CREATE TRIGGER state_representation_assets_file_replace_guard
BEFORE INSERT ON state_representation_assets BEGIN
  SELECT RAISE(ABORT, 'Typed File binding cannot use replacement writes')
  WHERE EXISTS (SELECT 1 FROM state_representation_assets old
    WHERE ((old.state_hash = NEW.state_hash AND old.asset_id = NEW.asset_id)
        OR (NEW.rowid <> -1 AND old.rowid = NEW.rowid))
      AND (old.file_id IS NOT NULL OR NEW.file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'state_representation_asset' AND d.consumer_id = old.state_hash
          AND d.consumer_sub_id = old.asset_id AND d.file_slot = 'primary')))
    OR EXISTS (SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'state_representation_asset' AND d.consumer_id = NEW.state_hash
        AND d.consumer_sub_id = NEW.asset_id AND d.file_slot = 'primary');
END;

CREATE TRIGGER run_step_assets_file_replace_guard
BEFORE INSERT ON run_step_assets BEGIN
  SELECT RAISE(ABORT, 'Typed File binding cannot use replacement writes')
  WHERE EXISTS (SELECT 1 FROM run_step_assets old
    WHERE (old.id = NEW.id OR (NEW.rowid <> -1 AND old.rowid = NEW.rowid)
      OR (old.run_step_id = NEW.run_step_id
      AND old.asset_id = NEW.asset_id AND old.role = NEW.role))
      AND (old.file_id IS NOT NULL OR NEW.file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'run_step_asset' AND d.consumer_id = old.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'primary')))
    OR EXISTS (SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'run_step_asset' AND d.consumer_id = NEW.id
        AND d.consumer_sub_id = '' AND d.file_slot = 'primary');
END;

CREATE TRIGGER metrology_template_references_file_replace_guard
BEFORE INSERT ON metrology_template_references BEGIN
  SELECT RAISE(ABORT, 'Typed File binding cannot use replacement writes')
  WHERE EXISTS (SELECT 1 FROM metrology_template_references old
    WHERE (old.id = NEW.id OR (NEW.rowid <> -1 AND old.rowid = NEW.rowid)
      OR (old.template_version_id = NEW.template_version_id AND old.asset_id = NEW.asset_id))
      AND (old.file_id IS NOT NULL OR NEW.file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'metrology_template_reference' AND d.consumer_id = old.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'primary')))
    OR EXISTS (SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'metrology_template_reference' AND d.consumer_id = NEW.id
        AND d.consumer_sub_id = '' AND d.file_slot = 'primary');
END;

CREATE TRIGGER run_step_comments_file_replace_guard
BEFORE INSERT ON run_step_comments BEGIN
  SELECT RAISE(ABORT, 'Typed File binding cannot use replacement writes')
  WHERE EXISTS (SELECT 1 FROM run_step_comments old
    WHERE (old.id = NEW.id OR (NEW.rowid <> -1 AND old.rowid = NEW.rowid))
      AND (old.file_id IS NOT NULL OR NEW.file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'run_step_comment' AND d.consumer_id = old.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'primary')))
    OR EXISTS (SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'run_step_comment' AND d.consumer_id = NEW.id
        AND d.consumer_sub_id = '' AND d.file_slot = 'primary');
END;

CREATE TRIGGER state_verifications_file_replace_guard
BEFORE INSERT ON state_verifications BEGIN
  SELECT RAISE(ABORT, 'Typed File binding cannot use replacement writes')
  WHERE EXISTS (SELECT 1 FROM state_verifications old
    WHERE (old.id = NEW.id OR (NEW.rowid <> -1 AND old.rowid = NEW.rowid))
      AND (old.evidence_file_id IS NOT NULL OR NEW.evidence_file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'state_verification' AND d.consumer_id = old.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'evidence')))
    OR EXISTS (SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'state_verification' AND d.consumer_id = NEW.id
        AND d.consumer_sub_id = '' AND d.file_slot = 'evidence');
END;

CREATE TRIGGER comment_submission_items_file_replace_guard
BEFORE INSERT ON comment_submission_items BEGIN
  SELECT RAISE(ABORT, 'Typed File binding cannot use replacement writes')
  WHERE EXISTS (SELECT 1 FROM comment_submission_items old
    WHERE (old.id = NEW.id OR (NEW.rowid <> -1 AND old.rowid = NEW.rowid)
      OR (old.submission_id = NEW.submission_id AND old.position = NEW.position))
      AND (old.file_id IS NOT NULL OR NEW.file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'comment_submission_item' AND d.consumer_id = old.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'primary')))
    OR EXISTS (SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'comment_submission_item' AND d.consumer_id = NEW.id
        AND d.consumer_sub_id = '' AND d.file_slot = 'primary');
END;

CREATE TRIGGER project_content_attachments_file_replace_guard
BEFORE INSERT ON project_content_attachments BEGIN
  SELECT RAISE(ABORT, 'Typed File binding cannot use replacement writes')
  WHERE EXISTS (SELECT 1 FROM project_content_attachments old
    WHERE (old.project_content_id = NEW.project_content_id
        OR (NEW.rowid <> -1 AND old.rowid = NEW.rowid))
      AND (old.file_id IS NOT NULL OR NEW.file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'project_content_attachment'
          AND d.consumer_id = old.project_content_id AND d.consumer_sub_id = '' AND d.file_slot = 'primary')))
    OR EXISTS (SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'project_content_attachment' AND d.consumer_id = NEW.project_content_id
        AND d.consumer_sub_id = '' AND d.file_slot = 'primary');
END;

CREATE TRIGGER attachment_derivatives_file_replace_guard
BEFORE INSERT ON attachment_derivatives BEGIN
  SELECT RAISE(ABORT, 'Typed File binding cannot use replacement writes')
  WHERE EXISTS (SELECT 1 FROM attachment_derivatives old
    WHERE (old.id = NEW.id OR (NEW.rowid <> -1 AND old.rowid = NEW.rowid)
      OR (old.source_sha256 = NEW.source_sha256
      AND old.source_byte_size = NEW.source_byte_size AND old.derivative_kind = NEW.derivative_kind
      AND old.generator_version = NEW.generator_version))
      AND (old.derived_file_id IS NOT NULL OR NEW.derived_file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'attachment_derivative' AND d.consumer_id = old.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'derived')))
    OR EXISTS (SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'attachment_derivative' AND d.consumer_id = NEW.id
        AND d.consumer_sub_id = '' AND d.file_slot = 'derived');
END;

CREATE TRIGGER events_file_replace_guard
BEFORE INSERT ON events BEGIN
  SELECT RAISE(ABORT, 'Typed File binding cannot use replacement writes')
  WHERE EXISTS (SELECT 1 FROM events old
    WHERE (old.id = NEW.id OR (NEW.rowid <> -1 AND old.rowid = NEW.rowid))
    AND (old.asset_file_id IS NOT NULL OR old.thumbnail_file_id IS NOT NULL
      OR NEW.asset_file_id IS NOT NULL OR NEW.thumbnail_file_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'event' AND d.consumer_id = old.id AND d.consumer_sub_id = '')))
    OR EXISTS (SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'event' AND d.consumer_id = NEW.id AND d.consumer_sub_id = '');
END;

CREATE TRIGGER imports_file_replace_guard
BEFORE INSERT ON imports BEGIN
  SELECT RAISE(ABORT, 'Typed File binding cannot use replacement writes')
  WHERE EXISTS (SELECT 1 FROM imports old
    WHERE (old.id = NEW.id OR (NEW.rowid <> -1 AND old.rowid = NEW.rowid)
      OR (NEW.client_request_id IS NOT NULL AND old.actor_email = NEW.actor_email
        AND old.client_request_id = NEW.client_request_id)
      OR (NEW.operation_id IS NOT NULL AND old.operation_id = NEW.operation_id)
      OR (NEW.finalization_id IS NOT NULL AND old.finalization_id = NEW.finalization_id))
      AND (old.workbook_file_id IS NOT NULL OR old.manifest_file_id IS NOT NULL
        OR NEW.workbook_file_id IS NOT NULL OR NEW.manifest_file_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM file_consumer_migration_decisions d
          WHERE d.consumer_kind = 'import' AND d.consumer_id = old.id AND d.consumer_sub_id = '')))
    OR EXISTS (SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'import' AND d.consumer_id = NEW.id AND d.consumer_sub_id = '');
END;

-- Two historical whole-row recovery guards predate the typed columns. Rebuild
-- them so their original recovery-only mutations remain exact while a separate
-- NULL -> verified File fill can pass through the typed guards above.
DROP TRIGGER project_content_attachments_reject_update;
CREATE TRIGGER project_content_attachments_reject_update
BEFORE UPDATE ON project_content_attachments
WHEN NOT (
  (
    OLD.project_content_id IS NEW.project_content_id
    AND OLD.asset_id IS NOT NEW.asset_id
    AND OLD.asset_id IS NOT NULL
    AND NEW.asset_id IS NOT NULL
    AND OLD.storage_object_id IS NULL
    AND NEW.storage_object_id IS NULL
    AND OLD.original_name IS NEW.original_name
    AND OLD.mime_type IS NEW.mime_type
    AND OLD.byte_size IS NEW.byte_size
    AND OLD.created_by IS NEW.created_by
    AND OLD.created_at IS NEW.created_at
    AND OLD.creation_operation_id IS NEW.creation_operation_id
    AND OLD.file_id IS NEW.file_id
    AND EXISTS (
      SELECT 1
      FROM assets legacy
      JOIN imports failed_owner ON failed_owner.id = legacy.import_id
      JOIN assets canonical ON canonical.id = NEW.asset_id
      LEFT JOIN imports canonical_owner ON canonical_owner.id = canonical.import_id
      WHERE legacy.id = OLD.asset_id
        AND failed_owner.status = 'failed'
        AND failed_owner.recovery_operation_id IS NOT NULL
        AND legacy.sha256 IS NOT NULL
        AND canonical.sha256 = legacy.sha256
        AND canonical.byte_size = legacy.byte_size
        AND canonical.status = 'ready'
        AND (canonical.import_id IS NULL OR canonical_owner.status = 'ready')
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
    )
  )
  OR (
    OLD.project_content_id IS NEW.project_content_id
    AND OLD.asset_id IS NEW.asset_id
    AND OLD.storage_object_id IS NEW.storage_object_id
    AND OLD.original_name IS NEW.original_name
    AND OLD.mime_type IS NEW.mime_type
    AND OLD.byte_size IS NEW.byte_size
    AND OLD.created_by IS NEW.created_by
    AND OLD.created_at IS NEW.created_at
    AND OLD.creation_operation_id IS NEW.creation_operation_id
    AND OLD.file_id IS NULL
    AND NEW.file_id IS NOT NULL
  )
)
BEGIN
  -- Rebuilding this whole-row guard makes it newer than the historical MIME
  -- guard. Preserve that guard's precise rejection contract without depending
  -- on SQLite's trigger execution order.
  SELECT RAISE(ABORT, 'project attachment MIME type is invalid')
  WHERE NEW.mime_type IS NULL
    OR length(NEW.mime_type) NOT BETWEEN 3 AND 200
    OR trim(NEW.mime_type) <> NEW.mime_type
    OR instr(NEW.mime_type, char(0)) > 0
    OR NEW.mime_type GLOB '*[^ -~]*'
    OR instr(
      trim( CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END ),
      '/'
    ) <= 1
    OR instr(
      trim( CASE
        WHEN instr(NEW.mime_type, ';') > 0
          THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
        ELSE NEW.mime_type
      END ),
      '/'
    ) >= length(trim( CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END ))
    OR instr(
      substr(
        trim( CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END ),
        instr(trim( CASE
          WHEN instr(NEW.mime_type, ';') > 0
            THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
          ELSE NEW.mime_type
        END ), '/') + 1
      ),
      '/'
    ) > 0
    OR trim( CASE
      WHEN instr(NEW.mime_type, ';') > 0
        THEN substr(NEW.mime_type, 1, instr(NEW.mime_type, ';') - 1)
      ELSE NEW.mime_type
    END ) GLOB '*[^A-Za-z0-9!#$%&''*+.^_`|~/-]*';

  SELECT RAISE(ABORT, 'blob locator is quarantined')
  WHERE (
    NEW.asset_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM assets a
      JOIN blob_integrity_quarantine biq
        ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
      WHERE a.id = NEW.asset_id
    )
  ) OR (
    NEW.storage_object_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM managed_storage_objects mso
      JOIN blob_integrity_quarantine biq
        ON biq.store_kind = 'managed' AND biq.provider = mso.provider
       AND biq.object_key = mso.object_key
      WHERE mso.id = NEW.storage_object_id
    )
  );

  SELECT RAISE(ABORT, 'blob locator is unavailable')
  WHERE NEW.asset_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM assets a
      LEFT JOIN imports i ON i.id = a.import_id
      WHERE a.id = NEW.asset_id AND a.status = 'ready'
        AND (a.import_id IS NULL OR i.status = 'ready')
    );

  SELECT RAISE(ABORT, 'blob locator is unavailable')
  WHERE (
    NEW.asset_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM assets a
      JOIN blob_gc_ledger bg
        ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
       AND bg.state IN ('deleting', 'deleted')
      WHERE a.id = NEW.asset_id
    )
  ) OR (
    NEW.storage_object_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM managed_storage_objects mso
      JOIN blob_gc_ledger bg
        ON bg.store_kind = 'managed' AND bg.provider = mso.provider
       AND bg.object_key = mso.object_key AND bg.state IN ('deleting', 'deleted')
      WHERE mso.id = NEW.storage_object_id
    )
  );

  SELECT RAISE(ABORT, 'project attachment intrinsic metadata is immutable');
END;

DROP TRIGGER template_versions_guard_unpublished_update;
CREATE TRIGGER template_versions_guard_unpublished_update
BEFORE UPDATE ON template_versions
WHEN EXISTS (
  SELECT 1 FROM imports i
  WHERE i.template_version_id = OLD.id AND i.status = 'pending'
)
AND NOT (
  (
    OLD.id IS NEW.id
    AND OLD.recipe_family_id IS NEW.recipe_family_id
    AND OLD.name IS NEW.name
    AND OLD.template_type IS NEW.template_type
    AND OLD.version IS NEW.version
    AND OLD.manifest_hash IS NEW.manifest_hash
    AND OLD.initial_state_hash IS NEW.initial_state_hash
    AND OLD.source_filename IS NEW.source_filename
    AND OLD.source_asset_key IS NOT NEW.source_asset_key
    AND OLD.content_json IS NEW.content_json
    AND OLD.created_by IS NEW.created_by
    AND OLD.created_at IS NEW.created_at
    AND OLD.locked_at IS NEW.locked_at
    AND OLD.locked_by IS NEW.locked_by
    AND OLD.archived_at IS NEW.archived_at
    AND OLD.archived_by IS NEW.archived_by
    AND OLD.template_kind IS NEW.template_kind
    AND OLD.metrology_notes IS NEW.metrology_notes
    AND OLD.deleted_at IS NEW.deleted_at
    AND OLD.deleted_by IS NEW.deleted_by
    AND OLD.source_file_id IS NEW.source_file_id
    AND EXISTS (
      SELECT 1
      FROM assets legacy
      JOIN imports failed_owner ON failed_owner.id = legacy.import_id
      JOIN assets canonical ON canonical.r2_key = NEW.source_asset_key
      LEFT JOIN imports canonical_owner ON canonical_owner.id = canonical.import_id
      WHERE legacy.r2_key = OLD.source_asset_key
        AND failed_owner.status = 'failed'
        AND failed_owner.recovery_operation_id IS NOT NULL
        AND legacy.sha256 IS NOT NULL
        AND canonical.sha256 = legacy.sha256
        AND canonical.byte_size = legacy.byte_size
        AND canonical.status = 'ready'
        AND (canonical.import_id IS NULL OR canonical_owner.status = 'ready')
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
    )
  )
  OR (
    OLD.id IS NEW.id
    AND OLD.recipe_family_id IS NEW.recipe_family_id
    AND OLD.name IS NEW.name
    AND OLD.template_type IS NEW.template_type
    AND OLD.version IS NEW.version
    AND OLD.manifest_hash IS NEW.manifest_hash
    AND OLD.initial_state_hash IS NEW.initial_state_hash
    AND OLD.source_filename IS NEW.source_filename
    AND OLD.source_asset_key IS NEW.source_asset_key
    AND OLD.content_json IS NEW.content_json
    AND OLD.created_by IS NEW.created_by
    AND OLD.created_at IS NEW.created_at
    AND OLD.locked_at IS NEW.locked_at
    AND OLD.locked_by IS NEW.locked_by
    AND OLD.archived_at IS NEW.archived_at
    AND OLD.archived_by IS NEW.archived_by
    AND OLD.template_kind IS NEW.template_kind
    AND OLD.metrology_notes IS NEW.metrology_notes
    AND OLD.deleted_at IS NEW.deleted_at
    AND OLD.deleted_by IS NEW.deleted_by
    AND OLD.source_file_id IS NULL
    AND NEW.source_file_id IS NOT NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'template version is not published');
END;

-- Keep the V14 physical-generation completion marker as the final statement.
-- A statement-by-statement observer cannot classify a partially applied 0007 as
-- complete merely because the authority tables and typed columns already exist.
CREATE TRIGGER template_versions_file_replace_guard
BEFORE INSERT ON template_versions BEGIN
  SELECT RAISE(ABORT, 'Typed File binding cannot use replacement writes')
  WHERE EXISTS (SELECT 1 FROM template_versions old
    WHERE (old.id = NEW.id OR (NEW.rowid <> -1 AND old.rowid = NEW.rowid)
      OR (old.recipe_family_id = NEW.recipe_family_id AND old.version = NEW.version)
      OR (old.name = NEW.name AND old.template_type = NEW.template_type AND old.version = NEW.version))
      AND (old.source_file_id IS NOT NULL OR NEW.source_file_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM file_consumer_migration_decisions d
        WHERE d.consumer_kind = 'template_version' AND d.consumer_id = old.id
          AND d.consumer_sub_id = '' AND d.file_slot = 'source')))
    OR EXISTS (SELECT 1 FROM file_consumer_migration_decisions d
      WHERE d.consumer_kind = 'template_version' AND d.consumer_id = NEW.id
        AND d.consumer_sub_id = '' AND d.file_slot = 'source');
END;
