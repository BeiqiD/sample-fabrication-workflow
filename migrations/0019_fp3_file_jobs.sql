-- Durable File relocation. Execution enablement is installation-local and is
-- disabled on creation/restoration. No scheduler or provider is enabled here.
CREATE TABLE file_job_runtime_guard (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
  enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
  incarnation TEXT,
  last_heartbeat_at TEXT,
  CHECK(enabled=0 OR (incarnation IS NOT NULL AND length(incarnation) BETWEEN 1 AND 128))
) WITHOUT ROWID;
INSERT INTO file_job_runtime_guard(singleton,enabled) VALUES(1,0);

CREATE TABLE file_migration_jobs (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  request_id TEXT NOT NULL UNIQUE CHECK(length(request_id) BETWEEN 1 AND 128),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 254),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  target_profile_id TEXT NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
  target_configuration_revision INTEGER NOT NULL CHECK(target_configuration_revision>=1),
  target_namespace TEXT NOT NULL,
  accepted_at TEXT NOT NULL CHECK(datetime(accepted_at) IS NOT NULL),
  state TEXT NOT NULL CHECK(state IN('queued','running','paused','cancel_requested','completed','cancelled')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  owner_token TEXT,
  runtime_incarnation TEXT,
  lease_expires_at TEXT,
  admin_checked_at TEXT,
  updated_at TEXT NOT NULL CHECK(datetime(updated_at) IS NOT NULL),
  reason TEXT,
  CHECK(state<>'running' OR (owner_token IS NOT NULL AND runtime_incarnation IS NOT NULL AND datetime(lease_expires_at) IS NOT NULL))
) WITHOUT ROWID;
CREATE INDEX file_migration_jobs_work ON file_migration_jobs(state,updated_at,id);

-- A restored historical cleanup request carries audit history, not execution
-- authority. Only an explicit request in this installation incarnation grants
-- cleanup; this local table is empty on recovery and is never serialized.
CREATE TABLE file_job_cleanup_grants (
  job_id TEXT PRIMARY KEY NOT NULL REFERENCES file_migration_jobs(id) ON DELETE RESTRICT,
  runtime_incarnation TEXT NOT NULL CHECK(length(runtime_incarnation) BETWEEN 1 AND 128),
  requested_at TEXT NOT NULL CHECK(datetime(requested_at) IS NOT NULL),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 254)
) WITHOUT ROWID;

CREATE TABLE file_migration_items (
  job_id TEXT NOT NULL REFERENCES file_migration_jobs(id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK(purpose IN('research_source','embedded_content','derived_preview','provenance','job_output')),
  source_location_id TEXT NOT NULL REFERENCES file_location_publications(location_id) ON DELETE RESTRICT,
  source_profile_id TEXT NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
  source_configuration_revision INTEGER NOT NULL,
  source_namespace TEXT NOT NULL,
  source_object_key TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 0 AND 104857600),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  hold_operation_id TEXT NOT NULL UNIQUE CHECK(length(hold_operation_id) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN('pending','copying','moved','stale','failed','cancelled')),
  destination_location_id TEXT REFERENCES file_location_publications(location_id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL,
  reason TEXT,
  cleanup_requested_at TEXT,
  cleanup_actor TEXT,
  cleanup_not_before TEXT,
  cleanup_released_at TEXT,
  PRIMARY KEY(job_id,file_id),
  CHECK(state<>'moved' OR (destination_location_id IS NOT NULL AND cleanup_not_before IS NOT NULL))
) WITHOUT ROWID;

CREATE TABLE file_migration_attempts (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  job_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  location_id TEXT NOT NULL UNIQUE REFERENCES file_locations(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL UNIQUE,
  owner_token TEXT NOT NULL,
  generation INTEGER NOT NULL,
  runtime_incarnation TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('staged','write_started','unknown','verified','published','failed','cancelled')),
  created_at TEXT NOT NULL,
  write_started_at TEXT,
  io_settled_at TEXT,
  verified_byte_size INTEGER,
  verified_sha256 TEXT,
  verified_at TEXT,
  verified_owner_token TEXT,
  verified_generation INTEGER,
  verified_runtime_incarnation TEXT,
  updated_at TEXT NOT NULL,
  reason TEXT,
  FOREIGN KEY(job_id,file_id) REFERENCES file_migration_items(job_id,file_id) ON DELETE RESTRICT,
  CHECK(state NOT IN('verified','published') OR (io_settled_at IS NOT NULL AND verified_at IS NOT NULL
    AND verified_byte_size IS NOT NULL AND verified_sha256 IS NOT NULL AND verified_owner_token IS NOT NULL
    AND verified_generation IS NOT NULL AND verified_runtime_incarnation IS NOT NULL))
) WITHOUT ROWID;
CREATE INDEX file_migration_attempts_item ON file_migration_attempts(job_id,file_id,created_at,id);

CREATE TRIGGER file_migration_jobs_target BEFORE INSERT ON file_migration_jobs BEGIN
  SELECT RAISE(ABORT,'File job target identity is not registered') WHERE NOT EXISTS(
    SELECT 1 FROM storage_profiles p WHERE p.id=NEW.target_profile_id
      AND p.configuration_revision=NEW.target_configuration_revision AND p.namespace_identity=NEW.target_namespace);
END;

-- A pending multi-item Comment can finish after an already accepted item's
-- immutable File has moved. Its original accepted placement remains proof of
-- that upload; current usability and content are checked independently.
DROP TRIGGER file_authority_comment_parent_ready_guard;
CREATE TRIGGER file_authority_comment_parent_ready_guard BEFORE UPDATE ON comment_submission_acceptances
WHEN NEW.status='ready' AND (SELECT mode FROM file_authority_control WHERE singleton=1)='active'
BEGIN
  SELECT RAISE(ABORT,'Active Comment completion requires all exact File bindings') WHERE EXISTS (
    SELECT 1 FROM comment_submission_items i WHERE i.submission_id=NEW.submission_id AND i.status='ready' AND i.kind<>'link' AND (
      NOT EXISTS(SELECT 1 FROM comment_item_acceptances r JOIN file_acceptance_candidates c
        ON c.acceptance_kind='comment_item' AND c.acceptance_id=r.item_id AND c.item_id='' AND c.state='ready'
        AND c.purpose=r.purpose AND c.storage_profile_id=r.storage_profile_id
        AND c.expected_byte_size=r.expected_byte_size AND c.expected_sha256=r.expected_sha256
        JOIN file_usable_publications f ON f.file_id=c.result_file_id AND f.purpose=r.purpose AND f.access_scope='system'
          AND f.verified_byte_size=r.expected_byte_size AND f.verified_sha256=r.expected_sha256
        JOIN file_location_publications l ON l.location_id=c.result_location_id AND l.file_id=f.file_id
          AND l.storage_profile_id=r.storage_profile_id AND l.verified_byte_size=r.expected_byte_size AND l.verified_sha256=r.expected_sha256
        WHERE r.item_id=i.id AND r.submission_id=NEW.submission_id AND r.status='ready' AND i.file_id=f.file_id
          AND l.object_key=json_extract(r.accepted_result_json,'$.objectKey'))));
END;

-- Alias recovery keeps the accepted physical placement immutable while reads
-- follow the usable logical File's independently verified current location.
DROP VIEW file_authority_ready_candidate_aliases;
CREATE VIEW file_authority_ready_candidate_aliases AS
SELECT c.*,l.object_key result_object_key,p.adapter_type,
  CASE c.acceptance_kind
    WHEN 'r2_upload' THEN (SELECT r.candidate_asset_id FROM r2_upload_requests r WHERE r.id=c.acceptance_id AND r.status IN('pending','ready'))
    WHEN 'metrology_reference' THEN (SELECT r.candidate_asset_id FROM metrology_reference_upload_requests r WHERE r.id=c.acceptance_id AND r.status IN('pending','ready'))
    WHEN 'import_file' THEN (SELECT target.candidate_asset_id FROM import_file_acceptances target WHERE target.import_id=c.acceptance_id AND target.item_id=c.item_id AND target.status IN('pending','ready'))
    WHEN 'comment_item' THEN (SELECT r.candidate_blob_id FROM comment_item_acceptances r WHERE r.item_id=c.acceptance_id AND r.status IN('pending','ready')) END alias_id
FROM file_acceptance_candidates c JOIN file_usable_publications f ON f.file_id=c.result_file_id
  AND f.purpose=c.purpose AND f.access_scope=c.access_scope
  AND f.verified_byte_size=c.expected_byte_size AND f.verified_sha256=c.expected_sha256
JOIN file_location_publications l ON l.location_id=c.result_location_id AND l.file_id=c.result_file_id
  AND l.storage_profile_id=c.storage_profile_id AND l.verified_byte_size=c.expected_byte_size AND l.verified_sha256=c.expected_sha256
JOIN storage_profiles p ON p.id=c.storage_profile_id
WHERE c.state='ready' AND (c.acceptance_kind<>'import_file' OR EXISTS(
  SELECT 1 FROM imports r WHERE r.id=c.acceptance_id AND r.status IN('pending','ready') AND r.client_request_id IS NOT NULL));
CREATE TRIGGER file_migration_items_snapshot BEFORE INSERT ON file_migration_items BEGIN
  SELECT RAISE(ABORT,'File job selection exceeds its bound') WHERE
    (SELECT count(*) FROM file_migration_items WHERE job_id=NEW.job_id)>=100;
  SELECT RAISE(ABORT,'Frozen migration source differs from verified File identity') WHERE NOT EXISTS(
    SELECT 1 FROM file_location_publications l JOIN files f ON f.id=l.file_id
    JOIN storage_profiles p ON p.id=l.storage_profile_id
    WHERE l.location_id=NEW.source_location_id AND l.file_id=NEW.file_id AND l.storage_profile_id=NEW.source_profile_id
      AND l.object_key=NEW.source_object_key AND p.configuration_revision=NEW.source_configuration_revision
      AND p.namespace_identity=NEW.source_namespace AND f.purpose=NEW.purpose AND f.access_scope='system'
      AND l.verified_byte_size=NEW.byte_size AND l.verified_sha256=NEW.sha256);
END;
CREATE TRIGGER file_migration_attempts_candidate BEFORE INSERT ON file_migration_attempts BEGIN
  SELECT RAISE(ABORT,'File migration retry bound exceeded') WHERE
    (SELECT count(*) FROM file_migration_attempts WHERE job_id=NEW.job_id AND file_id=NEW.file_id)>=5;
  SELECT RAISE(ABORT,'Migration attempt differs from its registered candidate') WHERE NOT EXISTS(
    SELECT 1 FROM file_locations l JOIN file_migration_jobs j ON j.id=NEW.job_id
    WHERE l.id=NEW.location_id AND l.file_id=NEW.file_id AND l.object_key=NEW.object_key
      AND l.storage_profile_id=j.target_profile_id);
END;

CREATE TRIGGER file_migration_jobs_identity BEFORE UPDATE ON file_migration_jobs BEGIN
  SELECT RAISE(ABORT,'Accepted File job identity is immutable') WHERE
    NEW.id IS NOT OLD.id OR NEW.request_id IS NOT OLD.request_id OR NEW.actor IS NOT OLD.actor
    OR NEW.input_json IS NOT OLD.input_json OR NEW.target_profile_id IS NOT OLD.target_profile_id
    OR NEW.target_configuration_revision IS NOT OLD.target_configuration_revision
    OR NEW.target_namespace IS NOT OLD.target_namespace OR NEW.accepted_at IS NOT OLD.accepted_at
    OR NEW.generation<OLD.generation;
END;
CREATE TRIGGER file_migration_jobs_delete BEFORE DELETE ON file_migration_jobs BEGIN
  SELECT RAISE(ABORT,'File job history cannot be deleted');
END;
CREATE TRIGGER file_migration_items_identity BEFORE UPDATE ON file_migration_items BEGIN
  SELECT RAISE(ABORT,'Frozen File migration selection is immutable') WHERE
    NEW.job_id IS NOT OLD.job_id OR NEW.file_id IS NOT OLD.file_id OR NEW.purpose IS NOT OLD.purpose
    OR NEW.source_location_id IS NOT OLD.source_location_id OR NEW.source_profile_id IS NOT OLD.source_profile_id
    OR NEW.source_configuration_revision IS NOT OLD.source_configuration_revision OR NEW.source_namespace IS NOT OLD.source_namespace
    OR NEW.source_object_key IS NOT OLD.source_object_key OR NEW.byte_size IS NOT OLD.byte_size
    OR NEW.sha256 IS NOT OLD.sha256 OR NEW.hold_operation_id IS NOT OLD.hold_operation_id;
END;
CREATE TRIGGER file_migration_items_delete BEFORE DELETE ON file_migration_items BEGIN
  SELECT RAISE(ABORT,'File migration history cannot be deleted');
END;
CREATE TRIGGER file_migration_attempts_identity BEFORE UPDATE ON file_migration_attempts BEGIN
  SELECT RAISE(ABORT,'File write attempt identity is immutable') WHERE
    NEW.id IS NOT OLD.id OR NEW.job_id IS NOT OLD.job_id OR NEW.file_id IS NOT OLD.file_id
    OR NEW.location_id IS NOT OLD.location_id OR NEW.object_key IS NOT OLD.object_key
    OR NEW.owner_token IS NOT OLD.owner_token OR NEW.generation IS NOT OLD.generation
    OR NEW.runtime_incarnation IS NOT OLD.runtime_incarnation OR NEW.created_at IS NOT OLD.created_at;
END;
CREATE TRIGGER file_migration_attempts_delete BEFORE DELETE ON file_migration_attempts BEGIN
  SELECT RAISE(ABORT,'File write attempt history cannot be deleted');
END;

CREATE VIEW file_migration_live_verified_attempts AS
SELECT a.* FROM file_migration_attempts a
JOIN file_migration_items i ON i.job_id=a.job_id AND i.file_id=a.file_id
JOIN file_migration_jobs j ON j.id=a.job_id
JOIN file_job_runtime_guard g ON g.singleton=1 AND g.enabled=1 AND g.incarnation=j.runtime_incarnation
JOIN file_authority_runtime_guard fg ON fg.singleton=1 AND fg.enabled=1
JOIN file_authority_control fc ON fc.singleton=1 AND fc.mode='active'
WHERE a.state='verified' AND i.state='copying' AND j.state='running'
  AND a.verified_owner_token=j.owner_token AND a.verified_generation=j.generation
  AND a.verified_runtime_incarnation=j.runtime_incarnation
  AND julianday(j.lease_expires_at)>julianday('now')
  AND julianday(j.admin_checked_at)>=julianday('now','-10 seconds')
  AND a.verified_byte_size=i.byte_size AND a.verified_sha256=i.sha256;

-- Only a terminal candidate whose provider write is known settled (or never
-- began) joins the existing physical GC admission. Unknown/inflight writes
-- remain excluded even after a lease or execution incarnation expires.
DROP TRIGGER file_location_gc_orphan_guard;
CREATE TRIGGER file_location_gc_orphan_guard BEFORE INSERT ON file_location_gc_ledger BEGIN
  SELECT RAISE(ABORT,'Location cannot become orphaned while retained or held')
  WHERE NEW.state<>'orphaned' OR NOT (
    EXISTS(SELECT 1 FROM file_location_publications p WHERE p.location_id=NEW.location_id)
    OR EXISTS(SELECT 1 FROM file_acceptance_candidates c WHERE c.candidate_location_id=NEW.location_id AND c.state IN('ready','cancelled'))
    OR EXISTS(SELECT 1 FROM file_migration_attempts a WHERE a.location_id=NEW.location_id AND a.state IN('failed','cancelled')
      AND(a.io_settled_at IS NOT NULL OR a.write_started_at IS NULL)))
    OR EXISTS(SELECT 1 FROM file_publications f WHERE f.active_location_id=NEW.location_id AND f.state='ready')
    OR EXISTS(SELECT 1 FROM file_location_retention_edges e WHERE e.location_id=NEW.location_id
      AND NOT(e.occurrence_type='file_shadow_publication' AND EXISTS(
        SELECT 1 FROM file_shadow_heads h JOIN file_consumer_projection typed
          ON typed.consumer_kind=h.consumer_kind AND typed.consumer_id=h.consumer_id
          AND typed.consumer_sub_id=h.consumer_sub_id AND typed.file_slot=h.file_slot
        JOIN file_publications published ON published.file_id=typed.file_id AND published.state='ready'
        WHERE h.occurrence_id=e.occurrence_id AND typed.file_id=e.file_id AND typed.resolution_state='resolved')))
    OR EXISTS(SELECT 1 FROM legacy_file_mappings m JOIN blob_retention_edges e
      ON e.store_kind=m.store_kind AND e.provider=m.provider AND e.object_key=m.object_key
      WHERE m.location_id=NEW.location_id AND NOT EXISTS(
        SELECT 1 FROM file_retention_edges typed JOIN file_publications published
          ON published.file_id=typed.file_id AND published.state='ready'
        WHERE typed.source_type=e.source_type AND typed.source_id=e.source_id
          AND typed.occurrence_id=e.occurrence_id AND(typed.occurrence_type=e.occurrence_type
            OR(e.occurrence_type='run_step_comment_asset' AND typed.occurrence_type='run_step_comment_file'))))
    OR EXISTS(SELECT 1 FROM file_locations l JOIN storage_profiles p ON p.id=l.storage_profile_id
      JOIN blob_retention_edges e ON e.provider=p.adapter_type AND e.object_key=l.object_key
        AND e.store_kind=(CASE p.adapter_type WHEN 'r2' THEN 'r2' ELSE 'managed' END)
      WHERE l.id=NEW.location_id AND NOT EXISTS(
        SELECT 1 FROM file_retention_edges typed JOIN file_publications published
          ON published.file_id=typed.file_id AND published.state='ready'
        WHERE typed.source_type=e.source_type AND typed.source_id=e.source_id
          AND typed.occurrence_id=e.occurrence_id AND(typed.occurrence_type=e.occurrence_type
            OR(e.occurrence_type='run_step_comment_asset' AND typed.occurrence_type='run_step_comment_file'))))
    OR EXISTS(SELECT 1 FROM file_locations l JOIN file_holds h ON h.file_id=l.file_id
      WHERE l.id=NEW.location_id AND h.released_at IS NULL
        AND(h.expires_at IS NULL OR julianday(h.expires_at)>julianday('now')))
    OR EXISTS(SELECT 1 FROM file_locations l JOIN file_shadow_legacy_holds h
      ON h.storage_profile_id=l.storage_profile_id AND h.object_key=l.object_key
      WHERE l.id=NEW.location_id AND h.released_at IS NULL)
    OR EXISTS(SELECT 1 FROM file_location_holds h WHERE h.location_id=NEW.location_id AND h.released_at IS NULL
      AND(h.expires_at IS NULL OR julianday(h.expires_at)>julianday('now')));
END;

-- Native deletion transitions retain their existing immutable claim/history
-- rules. An exact ready typed occurrence supersedes only its historical key
-- retention; unknown roots and all current pointer/hold protections still win.
DROP TRIGGER file_location_gc_update_guard;
CREATE TRIGGER file_location_gc_update_guard BEFORE UPDATE ON file_location_gc_ledger BEGIN
  SELECT RAISE(ABORT,'Unsafe or invalid location deletion transition')
  WHERE NEW.location_id IS NOT OLD.location_id OR NEW.orphaned_at IS NOT OLD.orphaned_at
    OR NOT (
      (OLD.state='orphaned' AND NEW.state='deleting'
        AND NEW.operation_id IS NOT NULL AND NEW.deletion_started_at IS NOT NULL
        AND NEW.deleted_at IS NULL AND NEW.attempt_count=OLD.attempt_count+1
        AND NEW.last_error IS NULL AND NEW.updated_at IS NEW.deletion_started_at
        AND julianday(NEW.deletion_started_at)>=julianday(OLD.orphaned_at))
      OR(OLD.state='deleting' AND NEW.state='deleting'
        AND NEW.operation_id IS OLD.operation_id AND NEW.deleted_at IS NULL AND(
          (NEW.attempt_count=OLD.attempt_count+1 AND julianday(NEW.deletion_started_at)>julianday(OLD.deletion_started_at)
            AND julianday(NEW.deletion_started_at)>=julianday(OLD.updated_at)
            AND NEW.last_error IS NULL AND NEW.updated_at IS NEW.deletion_started_at)
          OR(NEW.attempt_count=OLD.attempt_count AND NEW.deletion_started_at IS OLD.deletion_started_at
            AND NEW.last_error IS NOT NULL AND julianday(NEW.updated_at)>=julianday(OLD.updated_at))))
      OR(OLD.state='deleting' AND NEW.state='deleted'
        AND NEW.operation_id IS OLD.operation_id AND NEW.deletion_started_at IS OLD.deletion_started_at
        AND NEW.attempt_count=OLD.attempt_count AND NEW.deleted_at IS NOT NULL AND NEW.last_error IS NULL
        AND NEW.updated_at IS NEW.deleted_at AND julianday(NEW.deleted_at)>=julianday(OLD.deletion_started_at)
        AND julianday(NEW.deleted_at)>=julianday(OLD.updated_at)))
    OR(NEW.state IN('deleting','deleted') AND(EXISTS(SELECT 1 FROM file_publications f WHERE f.active_location_id=NEW.location_id AND f.state='ready')
    OR EXISTS(SELECT 1 FROM file_location_retention_edges e WHERE e.location_id=NEW.location_id
      AND NOT(e.occurrence_type='file_shadow_publication' AND EXISTS(
        SELECT 1 FROM file_shadow_heads h JOIN file_consumer_projection typed
          ON typed.consumer_kind=h.consumer_kind AND typed.consumer_id=h.consumer_id
          AND typed.consumer_sub_id=h.consumer_sub_id AND typed.file_slot=h.file_slot
        JOIN file_publications published ON published.file_id=typed.file_id AND published.state='ready'
        WHERE h.occurrence_id=e.occurrence_id AND typed.file_id=e.file_id AND typed.resolution_state='resolved')))
    OR EXISTS(SELECT 1 FROM legacy_file_mappings m JOIN blob_retention_edges e
      ON e.store_kind=m.store_kind AND e.provider=m.provider AND e.object_key=m.object_key
      WHERE m.location_id=NEW.location_id AND NOT EXISTS(
        SELECT 1 FROM file_retention_edges typed JOIN file_publications published
          ON published.file_id=typed.file_id AND published.state='ready'
        WHERE typed.source_type=e.source_type AND typed.source_id=e.source_id
          AND typed.occurrence_id=e.occurrence_id AND(typed.occurrence_type=e.occurrence_type
            OR(e.occurrence_type='run_step_comment_asset' AND typed.occurrence_type='run_step_comment_file'))))
    OR EXISTS(SELECT 1 FROM file_locations l JOIN storage_profiles p ON p.id=l.storage_profile_id
      JOIN blob_retention_edges e ON e.provider=p.adapter_type AND e.object_key=l.object_key
        AND e.store_kind=(CASE p.adapter_type WHEN 'r2' THEN 'r2' ELSE 'managed' END)
      WHERE l.id=NEW.location_id AND NOT EXISTS(
        SELECT 1 FROM file_retention_edges typed JOIN file_publications published
          ON published.file_id=typed.file_id AND published.state='ready'
        WHERE typed.source_type=e.source_type AND typed.source_id=e.source_id
          AND typed.occurrence_id=e.occurrence_id AND(typed.occurrence_type=e.occurrence_type
            OR(e.occurrence_type='run_step_comment_asset' AND typed.occurrence_type='run_step_comment_file'))))
    OR EXISTS(SELECT 1 FROM file_locations l JOIN file_holds h ON h.file_id=l.file_id
      WHERE l.id=NEW.location_id AND h.released_at IS NULL
        AND(h.expires_at IS NULL OR julianday(h.expires_at)>julianday('now')))
    OR EXISTS(SELECT 1 FROM file_locations l JOIN file_shadow_legacy_holds h
      ON h.storage_profile_id=l.storage_profile_id AND h.object_key=l.object_key
      WHERE l.id=NEW.location_id AND h.released_at IS NULL)
    OR EXISTS(SELECT 1 FROM file_location_holds h WHERE h.location_id=NEW.location_id AND h.released_at IS NULL
      AND(h.expires_at IS NULL OR julianday(h.expires_at)>julianday('now')))));
END;


-- Other generations' insertion guards are retained; the same immutable File
-- Reviewed namespace evidence follows the same exact typed-occurrence rule.
-- It continues to retain unclassified roots and all unresolved legacy consumers.

DROP TRIGGER file_authority_location_gc_retention_insert_guard;
CREATE TRIGGER file_authority_location_gc_retention_insert_guard BEFORE INSERT ON file_location_gc_ledger
WHEN(SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND NEW.state IN('orphaned','deleting','deleted')
BEGIN
  SELECT RAISE(ABORT,'Retained legacy namespace fences File location deletion') WHERE EXISTS(
    SELECT 1 FROM file_locations l JOIN file_shadow_retention_namespaces n
      ON n.storage_profile_id=l.storage_profile_id AND n.object_key=l.object_key
    JOIN blob_retention_edges e ON e.store_kind=n.store_kind AND e.provider=n.provider AND e.object_key=n.object_key
    WHERE l.id=NEW.location_id AND NOT EXISTS(
      SELECT 1 FROM file_retention_edges typed JOIN file_publications published
        ON published.file_id=typed.file_id AND published.state='ready'
      WHERE typed.source_type=e.source_type AND typed.source_id=e.source_id
        AND typed.occurrence_id=e.occurrence_id AND(typed.occurrence_type=e.occurrence_type
          OR(e.occurrence_type='run_step_comment_asset' AND typed.occurrence_type='run_step_comment_file'))));
END;

DROP TRIGGER file_authority_location_gc_retention_update_guard;
CREATE TRIGGER file_authority_location_gc_retention_update_guard BEFORE UPDATE ON file_location_gc_ledger
WHEN(SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND NEW.state IN('orphaned','deleting','deleted')
BEGIN
  SELECT RAISE(ABORT,'Retained legacy namespace fences File location deletion') WHERE EXISTS(
    SELECT 1 FROM file_locations l JOIN file_shadow_retention_namespaces n
      ON n.storage_profile_id=l.storage_profile_id AND n.object_key=l.object_key
    JOIN blob_retention_edges e ON e.store_kind=n.store_kind AND e.provider=n.provider AND e.object_key=n.object_key
    WHERE l.id=NEW.location_id AND NOT EXISTS(
      SELECT 1 FROM file_retention_edges typed JOIN file_publications published
        ON published.file_id=typed.file_id AND published.state='ready'
      WHERE typed.source_type=e.source_type AND typed.source_id=e.source_id
        AND typed.occurrence_id=e.occurrence_id AND(typed.occurrence_type=e.occurrence_type
          OR(e.occurrence_type='run_step_comment_asset' AND typed.occurrence_type='run_step_comment_file'))));
END;

-- may now receive an independently verified location from this fenced ledger.
CREATE TRIGGER file_migration_cutover_fence BEFORE UPDATE ON file_publications
WHEN NEW.state='ready' AND NEW.active_location_id IS NOT OLD.active_location_id BEGIN
  SELECT RAISE(ABORT,'File migration cutover requires its current fenced attempt') WHERE NOT EXISTS(
    SELECT 1 FROM file_migration_live_verified_attempts a JOIN file_migration_items i
      ON i.job_id=a.job_id AND i.file_id=a.file_id
    WHERE a.file_id=OLD.file_id AND i.source_location_id=OLD.active_location_id
      AND a.location_id=NEW.active_location_id AND a.verified_sha256=OLD.verified_sha256
      AND a.verified_byte_size=OLD.verified_byte_size);
END;

DROP TRIGGER file_shadow_location_publication_guard;
CREATE TRIGGER file_shadow_location_publication_guard BEFORE INSERT ON file_location_publications
BEGIN
 SELECT RAISE(ABORT,'File publication requires its exact verified executor candidate')
 WHERE NOT (((SELECT mode FROM file_authority_control WHERE singleton=1)='overlap' AND EXISTS(SELECT 1 FROM file_shadow_attempts a JOIN file_shadow_operations o ON o.id=a.operation_id JOIN file_shadow_heads h ON h.occurrence_id=o.occurrence_id AND h.present=1 WHERE o.id=NEW.verification_operation_id AND o.status='pending' AND a.state='verified' AND a.candidate_file_id=NEW.file_id AND a.candidate_location_id=NEW.location_id AND a.candidate_object_key=NEW.object_key AND o.destination_profile_id=NEW.storage_profile_id AND a.verified_byte_size=NEW.verified_byte_size AND a.verified_sha256=NEW.verified_sha256 AND (o.captured_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1) OR EXISTS(SELECT 1 FROM file_shadow_reconciliations r JOIN file_shadow_runtime_guard g ON g.enabled=1 AND g.incarnation=r.runtime_incarnation WHERE r.attempt_id=a.id AND r.verified_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1) AND r.verified_sha256=a.verified_sha256 AND r.verified_byte_size=a.verified_byte_size)) AND ((EXISTS(SELECT 1 FROM file_shadow_runtime_guard g WHERE g.singleton=1 AND g.enabled=1 AND g.incarnation=a.runtime_incarnation) AND julianday(a.lease_expires_at)>julianday('now')) OR EXISTS(SELECT 1 FROM file_shadow_reconciliations r JOIN file_shadow_runtime_guard g ON g.enabled=1 AND g.incarnation=r.runtime_incarnation WHERE r.attempt_id=a.id AND r.verified_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1) AND r.verified_sha256=a.verified_sha256 AND r.verified_byte_size=a.verified_byte_size))))
 OR ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS(SELECT 1 FROM file_authority_pending_candidates c
 WHERE c.state='candidate' AND c.candidate_file_id=NEW.file_id AND c.candidate_location_id=NEW.location_id
 AND c.candidate_object_key=NEW.object_key AND c.storage_profile_id=NEW.storage_profile_id
 AND c.expected_byte_size=NEW.verified_byte_size AND c.expected_sha256=NEW.verified_sha256
 AND c.receipt_operation_id=NEW.verification_operation_id AND NEW.verification_method='full_read_sha256')) OR EXISTS(SELECT 1 FROM file_migration_live_verified_attempts a
 JOIN file_migration_jobs j ON j.id=a.job_id
 JOIN file_migration_items i ON i.job_id=a.job_id AND i.file_id=a.file_id
 WHERE a.id=NEW.verification_operation_id AND a.location_id=NEW.location_id
 AND a.file_id=NEW.file_id AND a.object_key=NEW.object_key
 AND j.target_profile_id=NEW.storage_profile_id AND a.verified_byte_size=NEW.verified_byte_size
 AND a.verified_sha256=NEW.verified_sha256 AND NEW.verification_method='full_read_sha256'
 AND EXISTS(SELECT 1 FROM file_location_holds h WHERE h.location_id=a.location_id
   AND h.operation_id=i.hold_operation_id AND h.hold_kind='transition_destination' AND h.released_at IS NULL)));
END;
