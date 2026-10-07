-- FP5 execution, artifacts and target claims are installation-local metadata.
-- They are excluded from the immutable V23 content archive/schema inventory.
CREATE TABLE system_recovery_runtime (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
 incarnation TEXT NOT NULL CHECK(length(incarnation)=32 AND incarnation NOT GLOB '*[^a-f0-9]*'),
 installation_id TEXT NOT NULL CHECK(length(installation_id)=32 AND installation_id NOT GLOB '*[^a-f0-9]*'),
 last_heartbeat_at TEXT, updated_at TEXT NOT NULL
);
INSERT INTO system_recovery_runtime VALUES(1,0,lower(hex(randomblob(16))),lower(hex(randomblob(16))),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE system_recovery_jobs (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL, actor TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('backup','upload','recovery')),
 state TEXT NOT NULL CHECK(state IN('awaiting_upload','queued','running','preview','paused','completed','cancelled')),
 phase TEXT NOT NULL CHECK(phase IN('snapshot','inventory','measure','write','validate','claim','schema','rows','files','reinstall','verify','ready','done')),
 input_json TEXT NOT NULL CHECK(json_valid(input_json) AND length(CAST(input_json AS BLOB))<=65536),
 accepted_at TEXT NOT NULL, updated_at TEXT NOT NULL, reason TEXT,
 generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
 owner_token TEXT, runtime_incarnation TEXT, lease_expires_at TEXT,
 source_upload_job_id TEXT REFERENCES system_recovery_jobs(id),
 target_id TEXT, target_incarnation TEXT,
 checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR (json_valid(checkpoint_json) AND length(CAST(checkpoint_json AS BLOB))<=65536)),
 source_checkpoint TEXT,
 artifact_key TEXT, archive_byte_size INTEGER CHECK(archive_byte_size IS NULL OR archive_byte_size BETWEEN 22 AND 104857600),
 archive_sha256 TEXT CHECK(archive_sha256 IS NULL OR(length(archive_sha256)=64 AND archive_sha256 NOT GLOB '*[^a-f0-9]*')),
 expires_at TEXT,
 completed_files INTEGER NOT NULL DEFAULT 0 CHECK(completed_files BETWEEN 0 AND 100),
 total_files INTEGER NOT NULL DEFAULT 0 CHECK(total_files BETWEEN 0 AND 100),
 bytes_done INTEGER NOT NULL DEFAULT 0 CHECK(bytes_done BETWEEN 0 AND 104857600),
 bytes_total INTEGER NOT NULL DEFAULT 0 CHECK(bytes_total BETWEEN 0 AND 104857600),
 result_json TEXT CHECK(result_json IS NULL OR(json_valid(result_json) AND length(CAST(result_json AS BLOB))<=65536)),
 CHECK(completed_files<=total_files AND bytes_done<=bytes_total),
 CHECK((owner_token IS NULL AND runtime_incarnation IS NULL AND lease_expires_at IS NULL)
   OR(owner_token IS NOT NULL AND runtime_incarnation IS NOT NULL AND lease_expires_at IS NOT NULL)),
 UNIQUE(actor,request_id)
);
CREATE TABLE system_recovery_requests (
 request_id TEXT NOT NULL, actor TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES system_recovery_jobs(id),
 input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64 AND input_sha256 NOT GLOB '*[^a-f0-9]*'),
 accepted_at TEXT NOT NULL, PRIMARY KEY(actor,request_id)
);
CREATE TABLE system_recovery_metadata_chunks (
 job_id TEXT NOT NULL REFERENCES system_recovery_jobs(id), name TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 127),
 chunk TEXT NOT NULL CHECK(length(CAST(chunk AS BLOB))<=65536),
 PRIMARY KEY(job_id,name,ordinal)
);
CREATE TABLE system_recovery_files (
 job_id TEXT NOT NULL REFERENCES system_recovery_jobs(id), id TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 99),
 outcome TEXT NOT NULL CHECK(outcome IN('pending','packaged','missing','provider_unavailable','metadata_unavailable','download_failed','size_mismatch','hash_mismatch')),
 file_json TEXT NOT NULL CHECK(json_valid(file_json) AND length(CAST(file_json AS BLOB))<=65536),
 PRIMARY KEY(job_id,id), UNIQUE(job_id,ordinal)
);
CREATE TABLE system_recovery_attempts (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES system_recovery_jobs(id),
 generation INTEGER NOT NULL CHECK(generation>=0), runtime_incarnation TEXT NOT NULL, owner_token TEXT NOT NULL,
 object_key TEXT NOT NULL UNIQUE, expected_byte_size INTEGER NOT NULL CHECK(expected_byte_size BETWEEN 22 AND 104857600),
 expected_sha256 TEXT NOT NULL CHECK(length(expected_sha256)=64 AND expected_sha256 NOT GLOB '*[^a-f0-9]*'),
 state TEXT NOT NULL CHECK(state IN('started','settled','verified','failed','unknown','cleaned')),
 created_at TEXT NOT NULL, settled_at TEXT, verified_at TEXT, cleaned_at TEXT,
 CHECK(state NOT IN('settled','verified','failed','cleaned') OR settled_at IS NOT NULL),
 CHECK(state<>'verified' OR verified_at IS NOT NULL),
 CHECK(state<>'cleaned' OR cleaned_at IS NOT NULL)
);
CREATE INDEX system_recovery_attempts_job ON system_recovery_attempts(job_id,generation DESC,created_at DESC,id DESC);
CREATE TABLE system_recovery_target_claim (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), target_id TEXT NOT NULL, job_id TEXT NOT NULL,
 incarnation TEXT NOT NULL, challenge TEXT NOT NULL, schema_sha256 TEXT NOT NULL, image_sha256 TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('claimed','installing','loading','files','verifying','ready','failed')),
 cursor_json TEXT NOT NULL CHECK(json_valid(cursor_json) AND length(CAST(cursor_json AS BLOB))<=65536), verified_at TEXT,
 owner_token TEXT, generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
 runtime_incarnation TEXT, lease_expires_at TEXT
);
CREATE TABLE system_recovery_maintenance (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 state TEXT NOT NULL DEFAULT 'open' CHECK(state IN('open','draining','fenced')),
 generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(generation)='integer' AND generation>=0),
 token TEXT, requested_by TEXT, backup_job_id TEXT,
 checkpoint_sha256 TEXT CHECK(checkpoint_sha256 IS NULL OR(length(checkpoint_sha256)=64 AND checkpoint_sha256 NOT GLOB '*[^a-f0-9]*')),
 started_at TEXT, fenced_at TEXT, updated_at TEXT NOT NULL
);
INSERT INTO system_recovery_maintenance(singleton,state,generation,updated_at) VALUES(1,'open',0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE system_recovery_write_leases (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('http','scheduled')),
 generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=0),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, released_at TEXT
);
CREATE INDEX system_recovery_write_leases_active ON system_recovery_write_leases(released_at,generation);
CREATE TABLE system_recovery_legacy_holds (
 job_id TEXT NOT NULL REFERENCES system_recovery_jobs(id), store_kind TEXT NOT NULL CHECK(store_kind IN('r2','managed')),
 provider TEXT NOT NULL, object_key TEXT NOT NULL, released_at TEXT,
 PRIMARY KEY(job_id,store_kind,provider,object_key)
);
CREATE TRIGGER system_recovery_legacy_holds_claim_guard BEFORE INSERT ON system_recovery_legacy_holds
 WHEN NEW.released_at IS NULL BEGIN
 SELECT RAISE(ABORT,'Recovery source bytes already have an irreversible deletion claim') WHERE
 EXISTS(SELECT 1 FROM blob_gc_ledger g WHERE g.store_kind=NEW.store_kind AND g.provider=NEW.provider AND g.object_key=NEW.object_key AND g.state IN('deleting','deleted'))
 OR EXISTS(SELECT 1 FROM file_shadow_legacy_deletion_claims g WHERE g.store_kind=NEW.store_kind AND g.provider=NEW.provider AND g.object_key=NEW.object_key)
 OR EXISTS(SELECT 1 FROM legacy_file_mappings m JOIN file_location_gc_ledger g ON g.location_id=m.location_id
   WHERE m.store_kind=NEW.store_kind AND m.provider=NEW.provider AND m.object_key=NEW.object_key AND g.state IN('deleting','deleted'));
 END;
CREATE TRIGGER system_recovery_legacy_holds_identity BEFORE UPDATE ON system_recovery_legacy_holds
 WHEN NEW.job_id IS NOT OLD.job_id OR NEW.store_kind IS NOT OLD.store_kind OR NEW.provider IS NOT OLD.provider
 OR NEW.object_key IS NOT OLD.object_key OR(OLD.released_at IS NOT NULL AND NEW.released_at IS NOT OLD.released_at)
 BEGIN SELECT RAISE(ABORT,'Released recovery source identity is immutable'); END;
CREATE TABLE system_recovery_maintenance_requests (
 request_id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN('enter','finalize','release')),
 expected_generation INTEGER NOT NULL CHECK(typeof(expected_generation)='integer' AND expected_generation>=0),
 result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object' AND length(CAST(result_json AS BLOB))<=65536),
 created_at TEXT NOT NULL
);
CREATE TRIGGER system_recovery_runtime_identity BEFORE UPDATE ON system_recovery_runtime
 WHEN NEW.installation_id IS NOT OLD.installation_id OR NEW.singleton IS NOT OLD.singleton
 BEGIN SELECT RAISE(ABORT,'System recovery installation identity is immutable'); END;
CREATE TRIGGER system_recovery_jobs_identity BEFORE UPDATE ON system_recovery_jobs
 WHEN NEW.id IS NOT OLD.id OR NEW.actor IS NOT OLD.actor OR NEW.request_id IS NOT OLD.request_id
 OR NEW.kind IS NOT OLD.kind OR NEW.input_json IS NOT OLD.input_json OR NEW.accepted_at IS NOT OLD.accepted_at
 OR NEW.source_upload_job_id IS NOT OLD.source_upload_job_id OR NEW.target_id IS NOT OLD.target_id
 OR(OLD.kind IN('backup','upload') AND json_extract(NEW.checkpoint_json,'$.artifactNamespace') IS NOT json_extract(OLD.checkpoint_json,'$.artifactNamespace'))
 OR(OLD.target_incarnation IS NOT NULL AND NEW.target_incarnation IS NOT OLD.target_incarnation)
 OR NEW.generation<OLD.generation
 BEGIN SELECT RAISE(ABORT,'System recovery accepted identity is immutable'); END;
CREATE TRIGGER system_recovery_requests_update BEFORE UPDATE ON system_recovery_requests
 BEGIN SELECT RAISE(ABORT,'System recovery request receipt is immutable'); END;
CREATE TRIGGER system_recovery_requests_delete BEFORE DELETE ON system_recovery_requests
 BEGIN SELECT RAISE(ABORT,'System recovery request receipt is immutable'); END;
CREATE TRIGGER system_recovery_attempts_identity BEFORE UPDATE ON system_recovery_attempts
 WHEN NEW.id IS NOT OLD.id OR NEW.job_id IS NOT OLD.job_id OR NEW.generation IS NOT OLD.generation
 OR NEW.runtime_incarnation IS NOT OLD.runtime_incarnation OR NEW.owner_token IS NOT OLD.owner_token
 OR NEW.object_key IS NOT OLD.object_key OR NEW.expected_byte_size IS NOT OLD.expected_byte_size
 OR NEW.expected_sha256 IS NOT OLD.expected_sha256 OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.state IN('verified','failed','cleaned') AND NEW.state NOT IN(OLD.state,'cleaned'))
 OR (NEW.state='cleaned' AND OLD.state NOT IN('verified','failed'))
 BEGIN SELECT RAISE(ABORT,'System recovery attempt evidence is immutable'); END;
CREATE TRIGGER system_recovery_attempts_delete BEFORE DELETE ON system_recovery_attempts
 BEGIN SELECT RAISE(ABORT,'System recovery attempts remain auditable'); END;
CREATE TRIGGER system_recovery_target_claim_identity BEFORE UPDATE ON system_recovery_target_claim
 WHEN NEW.singleton IS NOT OLD.singleton OR NEW.target_id IS NOT OLD.target_id OR NEW.job_id IS NOT OLD.job_id
 OR NEW.incarnation IS NOT OLD.incarnation OR NEW.challenge IS NOT OLD.challenge
 OR NEW.schema_sha256 IS NOT OLD.schema_sha256 OR NEW.image_sha256 IS NOT OLD.image_sha256 OR NEW.generation<OLD.generation
 BEGIN SELECT RAISE(ABORT,'System recovery target identity is immutable'); END;

-- The unserved recovery target retains its exact original physical image as
-- inert provenance. Chunks are never executable SQL or execution capability.
CREATE TABLE system_recovery_target_provenance (
 job_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 127),
 image_sha256 TEXT NOT NULL CHECK(length(image_sha256)=64 AND image_sha256 NOT GLOB '*[^a-f0-9]*'),
 chunk TEXT NOT NULL CHECK(length(CAST(chunk AS BLOB))<=65536),
 created_at TEXT NOT NULL, PRIMARY KEY(job_id,ordinal)
);
CREATE TABLE system_recovery_target_files (
 job_id TEXT NOT NULL, logical_id TEXT NOT NULL, source_blob_id TEXT NOT NULL,
 file_id TEXT NOT NULL, location_id TEXT NOT NULL UNIQUE, profile_id TEXT NOT NULL,
 namespace TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, purpose TEXT NOT NULL,
 byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 0 AND 100663296),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','write_started','unknown','verified','published')),
 owner_token TEXT, generation INTEGER, incarnation TEXT NOT NULL,
 verified_at TEXT, PRIMARY KEY(job_id,logical_id),
 CHECK(state NOT IN('verified','published') OR verified_at IS NOT NULL)
);
CREATE TRIGGER system_recovery_target_provenance_update BEFORE UPDATE ON system_recovery_target_provenance
 BEGIN SELECT RAISE(ABORT,'Original system recovery image is immutable'); END;
CREATE TRIGGER system_recovery_target_provenance_delete BEFORE DELETE ON system_recovery_target_provenance
 BEGIN SELECT RAISE(ABORT,'Original system recovery image remains provenance'); END;
CREATE TRIGGER system_recovery_target_files_identity BEFORE UPDATE ON system_recovery_target_files
 WHEN NEW.job_id IS NOT OLD.job_id OR NEW.logical_id IS NOT OLD.logical_id
 OR NEW.source_blob_id IS NOT OLD.source_blob_id OR NEW.file_id IS NOT OLD.file_id
 OR NEW.location_id IS NOT OLD.location_id OR NEW.profile_id IS NOT OLD.profile_id
 OR NEW.namespace IS NOT OLD.namespace OR NEW.object_key IS NOT OLD.object_key
 OR NEW.purpose IS NOT OLD.purpose OR NEW.byte_size IS NOT OLD.byte_size
 OR NEW.sha256 IS NOT OLD.sha256 OR NEW.incarnation IS NOT OLD.incarnation
 OR (OLD.state='published' AND NEW.state<>'published')
 BEGIN SELECT RAISE(ABORT,'Recovery destination file identity is immutable'); END;
