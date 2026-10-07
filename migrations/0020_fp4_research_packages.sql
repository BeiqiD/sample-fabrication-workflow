-- Native research packages are additive domain copies. Execution remains under
-- the installation-local, disabled-on-recovery FP3 guard; no scheduler is enabled.
CREATE TABLE research_package_source_identity (
 singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
 installation_id TEXT NOT NULL CHECK(length(installation_id) BETWEEN 1 AND 128)
) WITHOUT ROWID;
INSERT INTO research_package_source_identity VALUES(1,lower(hex(randomblob(16))));

CREATE TABLE research_package_jobs (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
 request_id TEXT NOT NULL UNIQUE CHECK(length(request_id) BETWEEN 1 AND 128),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 254),
 kind TEXT NOT NULL CHECK(kind IN('data_package','report','upload','import')),
 input_json TEXT NOT NULL CHECK(json_valid(input_json) AND length(CAST(input_json AS BLOB))<=32768),
 package_id TEXT NOT NULL CHECK(length(package_id) BETWEEN 1 AND 128),
 source_installation_id TEXT NOT NULL CHECK(length(source_installation_id) BETWEEN 1 AND 128),
 source_upload_job_id TEXT REFERENCES research_package_jobs(id) ON DELETE RESTRICT,
 package_digest TEXT CHECK(package_digest IS NULL OR(length(package_digest)=64 AND package_digest NOT GLOB '*[^0-9a-f]*')),
 destination_scope TEXT NOT NULL DEFAULT 'system' CHECK(destination_scope='system'),
 copy_identity TEXT,
 accepted_at TEXT NOT NULL CHECK(datetime(accepted_at) IS NOT NULL),
 target_policy_json TEXT NOT NULL CHECK(json_valid(target_policy_json)),
 domain_plan_json TEXT CHECK(domain_plan_json IS NULL OR(json_valid(domain_plan_json) AND length(CAST(domain_plan_json AS BLOB))<=1048576)),
 frozen_archive_json TEXT CHECK(frozen_archive_json IS NULL OR(json_valid(frozen_archive_json) AND length(CAST(frozen_archive_json AS BLOB))<=1048576)),
 state TEXT NOT NULL CHECK(state IN('awaiting_upload','queued','running','preview','paused','cancel_requested','completed','cancelled')),
 phase TEXT NOT NULL CHECK(phase IN('snapshot','measure','write','validate','preview','copy','publish','done')),
 generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
 owner_token TEXT,runtime_incarnation TEXT,lease_expires_at TEXT,actor_checked_at TEXT,
 updated_at TEXT NOT NULL CHECK(datetime(updated_at) IS NOT NULL),
 result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),reason TEXT,
 expires_at TEXT CHECK(expires_at IS NULL OR datetime(expires_at) IS NOT NULL),
 CHECK(state<>'running' OR(owner_token IS NOT NULL AND runtime_incarnation IS NOT NULL AND datetime(lease_expires_at) IS NOT NULL)),
 CHECK(kind<>'import' OR(source_upload_job_id IS NOT NULL AND package_digest IS NOT NULL AND copy_identity IS NOT NULL AND domain_plan_json IS NOT NULL))
) WITHOUT ROWID;
CREATE UNIQUE INDEX research_package_copy_identity ON research_package_jobs(package_digest,destination_scope,actor,copy_identity) WHERE kind='import';
CREATE INDEX research_package_job_work ON research_package_jobs(state,updated_at,id);

-- Request aliases keep a normal re-import's lost response resolvable without
-- changing the original copy identity or leaking another actor's requests.
CREATE TABLE research_package_requests (
 actor TEXT NOT NULL,request_id TEXT NOT NULL,input_json TEXT NOT NULL CHECK(json_valid(input_json) AND length(CAST(input_json AS BLOB))<=32768),
 job_id TEXT NOT NULL REFERENCES research_package_jobs(id) ON DELETE RESTRICT,
 accepted_at TEXT NOT NULL CHECK(datetime(accepted_at) IS NOT NULL),reused INTEGER NOT NULL CHECK(reused IN(0,1)),
 PRIMARY KEY(actor,request_id)
) WITHOUT ROWID;
CREATE TRIGGER research_package_requests_update BEFORE UPDATE ON research_package_requests BEGIN SELECT RAISE(ABORT,'Package request receipt is immutable'); END;
CREATE TRIGGER research_package_requests_delete BEFORE DELETE ON research_package_requests BEGIN SELECT RAISE(ABORT,'Package request history is retained'); END;

CREATE TABLE research_package_records (
 job_id TEXT NOT NULL REFERENCES research_package_jobs(id) ON DELETE RESTRICT,
 record_kind TEXT NOT NULL CHECK(length(record_kind) BETWEEN 1 AND 64),
 source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 256),
 record_json TEXT NOT NULL CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB))<=65536),
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 PRIMARY KEY(job_id,record_kind,source_id)
) WITHOUT ROWID;

CREATE TABLE research_package_files (
 job_id TEXT NOT NULL REFERENCES research_package_jobs(id) ON DELETE RESTRICT,
 logical_file_id TEXT NOT NULL CHECK(length(logical_file_id) BETWEEN 1 AND 256),
 entry_kind TEXT NOT NULL CHECK(entry_kind IN('source','payload','artifact')),
 purpose TEXT NOT NULL CHECK(purpose IN('research_source','embedded_content','derived_preview','provenance','job_output')),
 byte_size INTEGER NOT NULL CHECK(typeof(byte_size)='integer' AND byte_size BETWEEN 0 AND 104857600),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 archive_path TEXT NOT NULL CHECK(length(archive_path) BETWEEN 1 AND 1024),
 alias_original_name TEXT,alias_created_at TEXT CHECK(alias_created_at IS NULL OR datetime(alias_created_at) IS NOT NULL),
 media_type TEXT NOT NULL CHECK(length(media_type) BETWEEN 1 AND 256),
 source_file_id TEXT REFERENCES files(id) ON DELETE RESTRICT,
 source_alias_id TEXT,
 source_location_id TEXT REFERENCES file_location_publications(location_id) ON DELETE RESTRICT,
 source_profile_id TEXT REFERENCES storage_profiles(id) ON DELETE RESTRICT,
 source_profile_revision INTEGER,source_namespace TEXT,source_object_key TEXT,
 hold_operation_id TEXT NOT NULL UNIQUE CHECK(length(hold_operation_id) BETWEEN 1 AND 128),
 target_profile_id TEXT REFERENCES storage_profiles(id) ON DELETE RESTRICT,
 target_profile_revision INTEGER,target_namespace TEXT,target_policy_revision INTEGER,
 candidate_file_id TEXT,candidate_asset_id TEXT,
 archive_entry_json TEXT CHECK(archive_entry_json IS NULL OR json_valid(archive_entry_json)),
 reuse_file_id TEXT REFERENCES file_publications(file_id) ON DELETE RESTRICT,
 reuse_location_id TEXT REFERENCES file_location_publications(location_id) ON DELETE RESTRICT,
 reuse_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
 state TEXT NOT NULL CHECK(state IN('pending','copying','verified','published','failed','cancelled')),
 result_file_id TEXT REFERENCES files(id) ON DELETE RESTRICT,
 result_location_id TEXT REFERENCES file_locations(id) ON DELETE RESTRICT,
 updated_at TEXT NOT NULL CHECK(datetime(updated_at) IS NOT NULL),reason TEXT,
 PRIMARY KEY(job_id,logical_file_id),
 UNIQUE(job_id,archive_path),
 CHECK((entry_kind='source' AND source_file_id IS NOT NULL AND source_location_id IS NOT NULL
   AND source_profile_id IS NOT NULL AND source_profile_revision=1 AND source_namespace IS NOT NULL
   AND source_object_key IS NOT NULL AND target_profile_id IS NULL AND candidate_file_id IS NULL)
  OR(entry_kind IN('payload','artifact') AND target_profile_id IS NOT NULL AND target_profile_revision=1
   AND target_namespace IS NOT NULL AND target_policy_revision>=2 AND candidate_file_id IS NOT NULL)),
 CHECK(entry_kind<>'artifact' OR(purpose='job_output' AND logical_file_id='@archive' AND candidate_asset_id IS NULL)),
 CHECK((reuse_file_id IS NULL AND reuse_location_id IS NULL AND reuse_asset_id IS NULL)
  OR(entry_kind='payload' AND purpose<>'derived_preview' AND reuse_file_id IS NOT NULL AND reuse_location_id IS NOT NULL
   AND reuse_asset_id IS NOT NULL AND candidate_file_id=reuse_file_id AND candidate_asset_id=reuse_asset_id
   AND result_file_id=reuse_file_id AND result_location_id=reuse_location_id AND state IN('verified','published')))
) WITHOUT ROWID;

CREATE TABLE research_package_attempts (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
 job_id TEXT NOT NULL,logical_file_id TEXT NOT NULL,
 file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
 location_id TEXT NOT NULL UNIQUE REFERENCES file_locations(id) ON DELETE RESTRICT,
 object_key TEXT NOT NULL UNIQUE,
 owner_token TEXT NOT NULL,generation INTEGER NOT NULL,runtime_incarnation TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('staged','write_started','unknown','verified','published','failed','cancelled')),
 created_at TEXT NOT NULL CHECK(datetime(created_at) IS NOT NULL),
 write_started_at TEXT CHECK(write_started_at IS NULL OR datetime(write_started_at) IS NOT NULL),
 io_settled_at TEXT CHECK(io_settled_at IS NULL OR(datetime(io_settled_at) IS NOT NULL AND write_started_at IS NOT NULL AND julianday(io_settled_at)>=julianday(write_started_at))),
 verified_byte_size INTEGER CHECK(verified_byte_size IS NULL OR verified_byte_size BETWEEN 0 AND 104857600),
 verified_sha256 TEXT CHECK(verified_sha256 IS NULL OR(length(verified_sha256)=64 AND verified_sha256 NOT GLOB '*[^0-9a-f]*')),
 verified_at TEXT CHECK(verified_at IS NULL OR datetime(verified_at) IS NOT NULL),
 verified_owner_token TEXT,verified_generation INTEGER,verified_runtime_incarnation TEXT,
 updated_at TEXT NOT NULL CHECK(datetime(updated_at) IS NOT NULL),reason TEXT,
 FOREIGN KEY(job_id,logical_file_id) REFERENCES research_package_files(job_id,logical_file_id) ON DELETE RESTRICT,
 CHECK(state NOT IN('verified','published') OR(io_settled_at IS NOT NULL AND verified_at IS NOT NULL
   AND verified_byte_size IS NOT NULL AND verified_sha256 IS NOT NULL AND verified_owner_token IS NOT NULL
   AND verified_generation IS NOT NULL AND verified_runtime_incarnation IS NOT NULL))
) WITHOUT ROWID;
CREATE INDEX research_package_projects_title_lookup ON projects(title);
CREATE INDEX research_package_attempt_work ON research_package_attempts(job_id,logical_file_id,created_at,id);

CREATE TABLE research_package_identity_maps (
 job_id TEXT NOT NULL REFERENCES research_package_jobs(id) ON DELETE RESTRICT,
 entity_kind TEXT NOT NULL,source_id TEXT NOT NULL,destination_id TEXT NOT NULL,
 PRIMARY KEY(job_id,entity_kind,source_id),UNIQUE(job_id,entity_kind,destination_id)
) WITHOUT ROWID;

-- A restored receipt is audit history, never a grant to collect its bytes.
CREATE TABLE system_research_package_cleanup_grants (
 job_id TEXT PRIMARY KEY NOT NULL REFERENCES research_package_jobs(id) ON DELETE RESTRICT,
 runtime_incarnation TEXT NOT NULL,requested_at TEXT NOT NULL,actor TEXT NOT NULL,
 mode TEXT NOT NULL DEFAULT 'explicit' CHECK(mode IN('explicit','expiry'))
) WITHOUT ROWID;

CREATE TRIGGER research_package_jobs_identity BEFORE UPDATE ON research_package_jobs BEGIN
 SELECT RAISE(ABORT,'Package accepted identity is immutable') WHERE
 NEW.id IS NOT OLD.id OR NEW.request_id IS NOT OLD.request_id OR NEW.actor IS NOT OLD.actor OR NEW.kind IS NOT OLD.kind
 OR NEW.input_json IS NOT OLD.input_json OR NEW.package_id IS NOT OLD.package_id OR NEW.source_installation_id IS NOT OLD.source_installation_id
 OR NEW.source_upload_job_id IS NOT OLD.source_upload_job_id OR NEW.destination_scope IS NOT OLD.destination_scope
 OR NEW.copy_identity IS NOT OLD.copy_identity OR NEW.accepted_at IS NOT OLD.accepted_at OR NEW.target_policy_json IS NOT OLD.target_policy_json
 OR NEW.domain_plan_json IS NOT OLD.domain_plan_json OR NEW.generation<OLD.generation
 OR(OLD.package_digest IS NOT NULL AND NEW.package_digest IS NOT OLD.package_digest)
 OR(OLD.frozen_archive_json IS NOT NULL AND NEW.frozen_archive_json IS NOT OLD.frozen_archive_json)
 OR(OLD.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json);
END;
CREATE TRIGGER research_package_jobs_delete BEFORE DELETE ON research_package_jobs BEGIN SELECT RAISE(ABORT,'Package history is retained'); END;
CREATE TRIGGER research_package_records_limit BEFORE INSERT ON research_package_records BEGIN
 SELECT RAISE(ABORT,'Package record budget exceeded') WHERE
 (SELECT count(*) FROM research_package_records WHERE job_id=NEW.job_id)>=1200
 OR COALESCE((SELECT sum(length(CAST(record_json AS BLOB))) FROM research_package_records WHERE job_id=NEW.job_id),0)+length(CAST(NEW.record_json AS BLOB))>4194304;
END;
CREATE TRIGGER research_package_records_update BEFORE UPDATE ON research_package_records BEGIN SELECT RAISE(ABORT,'Frozen package records are immutable'); END;
CREATE TRIGGER research_package_records_delete BEFORE DELETE ON research_package_records BEGIN SELECT RAISE(ABORT,'Frozen package records are retained'); END;
CREATE TRIGGER research_package_maps_update BEFORE UPDATE ON research_package_identity_maps BEGIN SELECT RAISE(ABORT,'Package identity maps are immutable'); END;
CREATE TRIGGER research_package_maps_delete BEFORE DELETE ON research_package_identity_maps BEGIN SELECT RAISE(ABORT,'Package identity maps are retained'); END;

CREATE TRIGGER research_package_files_insert BEFORE INSERT ON research_package_files BEGIN
 SELECT RAISE(ABORT,'Package file budget exceeded') WHERE NEW.entry_kind<>'artifact' AND
 ((SELECT count(*) FROM research_package_files WHERE job_id=NEW.job_id AND entry_kind<>'artifact')>=100
 OR COALESCE((SELECT sum(byte_size) FROM research_package_files WHERE job_id=NEW.job_id AND entry_kind<>'artifact'),0)+NEW.byte_size>100663296);
 SELECT RAISE(ABORT,'Package source differs from its verified publication') WHERE NEW.entry_kind='source' AND NOT EXISTS(
 SELECT 1 FROM file_usable_publications f JOIN file_location_publications l ON l.location_id=f.active_location_id
 JOIN storage_profiles p ON p.id=l.storage_profile_id WHERE f.file_id=NEW.source_file_id AND f.purpose=NEW.purpose AND f.access_scope='system'
 AND f.verified_byte_size=NEW.byte_size AND f.verified_sha256=NEW.sha256 AND l.location_id=NEW.source_location_id
 AND l.storage_profile_id=NEW.source_profile_id AND l.object_key=NEW.source_object_key
 AND p.configuration_revision=NEW.source_profile_revision AND p.namespace_identity=NEW.source_namespace);
 SELECT RAISE(ABORT,'Package destination differs from its frozen role policy') WHERE NEW.entry_kind<>'source' AND NOT EXISTS(
 SELECT 1 FROM research_package_jobs j JOIN storage_profiles p ON p.id=NEW.target_profile_id
 JOIN storage_profile_runtime r ON r.storage_profile_id=p.id AND r.state='read_write'
 WHERE j.id=NEW.job_id AND p.configuration_revision=NEW.target_profile_revision AND p.namespace_identity=NEW.target_namespace
 AND json_extract(j.target_policy_json,'$.'||NEW.purpose||'.profileId')=NEW.target_profile_id
 AND json_extract(j.target_policy_json,'$.'||NEW.purpose||'.configurationRevision')=NEW.target_profile_revision
 AND json_extract(j.target_policy_json,'$.'||NEW.purpose||'.namespaceIdentity')=NEW.target_namespace
 AND json_extract(j.target_policy_json,'$.'||NEW.purpose||'.policyRevision')=NEW.target_policy_revision);
 SELECT RAISE(ABORT,'Package reuse requires exact eligible current bytes and alias') WHERE NEW.reuse_file_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM file_usable_publications f JOIN file_location_publications l ON l.location_id=f.active_location_id
 JOIN assets a ON a.id=NEW.reuse_asset_id AND a.status='ready'
 WHERE f.file_id=NEW.reuse_file_id AND f.active_location_id=NEW.reuse_location_id AND f.purpose=NEW.purpose AND f.access_scope='system'
 AND f.verified_byte_size=NEW.byte_size AND f.verified_sha256=NEW.sha256 AND l.storage_profile_id=NEW.target_profile_id
 AND a.byte_size=NEW.byte_size AND(a.sha256 IS NULL OR a.sha256=NEW.sha256)
 AND((a.file_id=f.file_id AND a.r2_key IS NULL AND EXISTS(SELECT 1 FROM file_location_publications original
 WHERE original.file_id=f.file_id AND original.storage_profile_id=a.storage_profile_id AND original.object_key=a.object_key
 AND original.verified_sha256=f.verified_sha256 AND original.verified_byte_size=f.verified_byte_size))
 OR(a.file_id IS NULL AND a.r2_key IS NOT NULL AND EXISTS(SELECT 1 FROM state_representation_assets sa
 JOIN legacy_file_mappings mapped ON mapped.file_id=sa.file_id AND mapped.store_kind='r2' AND mapped.provider='r2' AND mapped.object_key=a.r2_key
 WHERE sa.asset_id=a.id AND sa.file_id=f.file_id))));
 SELECT RAISE(ABORT,'Package initial File state lacks proof') WHERE NEW.reuse_file_id IS NULL AND NEW.state<>'pending';
END;

CREATE TRIGGER research_package_files_identity BEFORE UPDATE ON research_package_files BEGIN
 SELECT RAISE(ABORT,'Frozen package File target is immutable') WHERE
 NEW.job_id IS NOT OLD.job_id OR NEW.logical_file_id IS NOT OLD.logical_file_id OR NEW.entry_kind IS NOT OLD.entry_kind
 OR NEW.purpose IS NOT OLD.purpose OR NEW.byte_size IS NOT OLD.byte_size OR NEW.sha256 IS NOT OLD.sha256
 OR NEW.archive_path IS NOT OLD.archive_path OR NEW.media_type IS NOT OLD.media_type
 OR NEW.alias_original_name IS NOT OLD.alias_original_name OR NEW.alias_created_at IS NOT OLD.alias_created_at
 OR NEW.source_file_id IS NOT OLD.source_file_id OR NEW.source_location_id IS NOT OLD.source_location_id
 OR NEW.source_alias_id IS NOT OLD.source_alias_id
 OR NEW.source_profile_id IS NOT OLD.source_profile_id OR NEW.source_profile_revision IS NOT OLD.source_profile_revision
 OR NEW.source_namespace IS NOT OLD.source_namespace OR NEW.source_object_key IS NOT OLD.source_object_key
 OR NEW.hold_operation_id IS NOT OLD.hold_operation_id OR NEW.target_profile_id IS NOT OLD.target_profile_id
 OR NEW.target_profile_revision IS NOT OLD.target_profile_revision OR NEW.target_namespace IS NOT OLD.target_namespace
 OR NEW.target_policy_revision IS NOT OLD.target_policy_revision OR NEW.candidate_file_id IS NOT OLD.candidate_file_id
 OR NEW.candidate_asset_id IS NOT OLD.candidate_asset_id OR NEW.archive_entry_json IS NOT OLD.archive_entry_json
 OR NEW.reuse_file_id IS NOT OLD.reuse_file_id OR NEW.reuse_location_id IS NOT OLD.reuse_location_id OR NEW.reuse_asset_id IS NOT OLD.reuse_asset_id
 OR(OLD.state='published' AND(NEW.state IS NOT OLD.state OR NEW.result_file_id IS NOT OLD.result_file_id OR NEW.result_location_id IS NOT OLD.result_location_id));
 SELECT RAISE(ABORT,'Package File verification requires its settled owned evidence') WHERE NEW.state IN('verified','published') AND NEW.reuse_file_id IS NULL AND NOT EXISTS(
 SELECT 1 FROM research_package_attempts a WHERE a.job_id=NEW.job_id AND a.logical_file_id=NEW.logical_file_id
 AND a.file_id=NEW.result_file_id AND a.location_id=NEW.result_location_id AND a.state IN('verified','published')
 AND a.io_settled_at IS NOT NULL AND a.verified_byte_size=NEW.byte_size AND a.verified_sha256=NEW.sha256);
END;
CREATE TRIGGER research_package_files_delete BEFORE DELETE ON research_package_files BEGIN SELECT RAISE(ABORT,'Package File history is retained'); END;

CREATE TRIGGER research_package_attempts_insert BEFORE INSERT ON research_package_attempts BEGIN
 SELECT RAISE(ABORT,'Package attempt bound exceeded') WHERE(SELECT count(*) FROM research_package_attempts WHERE job_id=NEW.job_id AND logical_file_id=NEW.logical_file_id)>=5;
 SELECT RAISE(ABORT,'Package candidate is not registered under its current lease') WHERE NEW.state<>'staged' OR NEW.write_started_at IS NOT NULL OR NEW.io_settled_at IS NOT NULL
 OR NEW.verified_byte_size IS NOT NULL OR NEW.verified_sha256 IS NOT NULL OR NEW.verified_at IS NOT NULL
 OR NEW.verified_owner_token IS NOT NULL OR NEW.verified_generation IS NOT NULL OR NEW.verified_runtime_incarnation IS NOT NULL OR NOT EXISTS(
 SELECT 1 FROM research_package_files f JOIN research_package_jobs j ON j.id=f.job_id
 JOIN file_locations l ON l.id=NEW.location_id JOIN files registered ON registered.id=l.file_id
 JOIN file_job_runtime_guard g ON g.singleton=1 AND g.enabled=1 AND g.incarnation=j.runtime_incarnation
 WHERE f.job_id=NEW.job_id AND f.logical_file_id=NEW.logical_file_id AND f.entry_kind<>'source' AND f.reuse_file_id IS NULL
 AND f.state IN('pending','copying','failed')
 AND f.candidate_file_id=NEW.file_id AND l.file_id=NEW.file_id AND l.object_key=NEW.object_key AND l.storage_profile_id=f.target_profile_id
 AND registered.purpose=f.purpose AND registered.access_scope='system' AND registered.expected_byte_size=f.byte_size AND registered.expected_sha256=f.sha256
 AND j.state='running' AND j.owner_token=NEW.owner_token AND j.generation=NEW.generation AND j.runtime_incarnation=NEW.runtime_incarnation
 AND julianday(j.lease_expires_at)>julianday('now'));
END;
CREATE TRIGGER research_package_attempts_update BEFORE UPDATE ON research_package_attempts BEGIN
 SELECT RAISE(ABORT,'Package attempt identity or settled evidence is immutable') WHERE
 NEW.id IS NOT OLD.id OR NEW.job_id IS NOT OLD.job_id OR NEW.logical_file_id IS NOT OLD.logical_file_id
 OR NEW.file_id IS NOT OLD.file_id OR NEW.location_id IS NOT OLD.location_id OR NEW.object_key IS NOT OLD.object_key
 OR NEW.owner_token IS NOT OLD.owner_token OR NEW.generation IS NOT OLD.generation OR NEW.runtime_incarnation IS NOT OLD.runtime_incarnation
 OR NEW.created_at IS NOT OLD.created_at OR(OLD.write_started_at IS NOT NULL AND NEW.write_started_at IS NOT OLD.write_started_at)
 OR(OLD.io_settled_at IS NOT NULL AND NEW.io_settled_at IS NOT OLD.io_settled_at)
 OR(OLD.state='published' AND(NEW.state IS NOT OLD.state OR NEW.verified_byte_size IS NOT OLD.verified_byte_size
 OR NEW.verified_sha256 IS NOT OLD.verified_sha256 OR NEW.verified_at IS NOT OLD.verified_at
 OR NEW.verified_owner_token IS NOT OLD.verified_owner_token OR NEW.verified_generation IS NOT OLD.verified_generation
 OR NEW.verified_runtime_incarnation IS NOT OLD.verified_runtime_incarnation));
 SELECT RAISE(ABORT,'Package attempt transition is unavailable') WHERE
 (NEW.state<>OLD.state AND NOT((OLD.state='staged' AND NEW.state IN('write_started','failed','cancelled'))
 OR(OLD.state IN('write_started','unknown') AND NEW.state IN('unknown','verified','failed','cancelled'))
 OR(OLD.state='verified' AND NEW.state IN('published','cancelled')) OR(OLD.state='failed' AND NEW.state='cancelled')))
 OR(NEW.write_started_at IS NOT OLD.write_started_at AND NOT(OLD.state='staged' AND NEW.state='write_started'
 AND datetime(NEW.write_started_at) IS NOT NULL AND julianday(NEW.write_started_at)>=julianday(OLD.created_at)))
 OR(NEW.io_settled_at IS NOT OLD.io_settled_at AND NOT(OLD.write_started_at IS NOT NULL
 AND datetime(NEW.io_settled_at) IS NOT NULL AND julianday(NEW.io_settled_at)>=julianday(OLD.write_started_at)))
 OR(NEW.state IN('failed','cancelled') AND OLD.write_started_at IS NOT NULL AND NEW.io_settled_at IS NULL);
 SELECT RAISE(ABORT,'Package write requires its original current owner') WHERE NEW.state='write_started' AND OLD.state<>'write_started'
 AND NOT EXISTS(SELECT 1 FROM research_package_jobs j JOIN file_job_runtime_guard g ON g.singleton=1 AND g.enabled=1
 AND g.incarnation=j.runtime_incarnation JOIN file_authority_runtime_guard fg ON fg.singleton=1 AND fg.enabled=1
 JOIN file_authority_control fc ON fc.singleton=1 AND fc.mode='active' WHERE j.id=NEW.job_id AND j.state='running'
 AND j.owner_token=NEW.owner_token AND j.generation=NEW.generation AND j.runtime_incarnation=NEW.runtime_incarnation
 AND julianday(j.lease_expires_at)>julianday('now'));
 SELECT RAISE(ABORT,'Package published attempt lacks exact immutable winner proof') WHERE NEW.state='published' AND NOT EXISTS(
 SELECT 1 FROM file_location_publications l JOIN research_package_files f ON f.job_id=NEW.job_id AND f.logical_file_id=NEW.logical_file_id
 JOIN file_publications published ON published.file_id=l.file_id AND published.state='ready'
 WHERE l.location_id=NEW.location_id AND l.file_id=NEW.file_id AND l.verification_operation_id=NEW.id
 AND l.verified_sha256=NEW.verified_sha256 AND l.verified_byte_size=NEW.verified_byte_size
 AND f.result_file_id=l.file_id AND f.result_location_id=l.location_id);

 SELECT RAISE(ABORT,'Package evidence changes require owned verification') WHERE NEW.state<>'verified' AND(
 NEW.verified_byte_size IS NOT OLD.verified_byte_size OR NEW.verified_sha256 IS NOT OLD.verified_sha256
 OR NEW.verified_at IS NOT OLD.verified_at OR NEW.verified_owner_token IS NOT OLD.verified_owner_token
 OR NEW.verified_generation IS NOT OLD.verified_generation OR NEW.verified_runtime_incarnation IS NOT OLD.verified_runtime_incarnation);
 SELECT RAISE(ABORT,'Package verification requires current owned actor fence') WHERE NEW.state='verified' AND(OLD.state NOT IN('write_started','unknown','verified') OR NEW.write_started_at IS NULL OR NOT EXISTS(
 SELECT 1 FROM research_package_jobs j JOIN research_package_files f ON f.job_id=j.id
 JOIN file_job_runtime_guard g ON g.singleton=1 AND g.enabled=1 AND g.incarnation=j.runtime_incarnation
 JOIN file_authority_runtime_guard fg ON fg.singleton=1 AND fg.enabled=1
 JOIN file_authority_control fc ON fc.singleton=1 AND fc.mode='active'
 WHERE j.id=NEW.job_id AND f.logical_file_id=NEW.logical_file_id AND j.state='running'
 AND j.owner_token=NEW.verified_owner_token AND j.generation=NEW.verified_generation AND j.runtime_incarnation=NEW.verified_runtime_incarnation
 AND julianday(j.lease_expires_at)>julianday('now') AND julianday(j.actor_checked_at)>=julianday('now','-10 seconds')
 AND NEW.io_settled_at IS NOT NULL AND NEW.verified_byte_size=f.byte_size AND NEW.verified_sha256=f.sha256));
END;
CREATE TRIGGER research_package_attempts_delete BEFORE DELETE ON research_package_attempts BEGIN SELECT RAISE(ABORT,'Package write history is retained'); END;

CREATE VIEW research_package_live_verified_attempts AS
SELECT a.*,f.purpose,f.target_profile_id,f.target_profile_revision,f.target_namespace,f.candidate_asset_id,f.media_type,f.archive_path
FROM research_package_attempts a JOIN research_package_files f ON f.job_id=a.job_id AND f.logical_file_id=a.logical_file_id
JOIN research_package_jobs j ON j.id=a.job_id
JOIN file_job_runtime_guard g ON g.singleton=1 AND g.enabled=1 AND g.incarnation=j.runtime_incarnation
JOIN file_authority_runtime_guard fg ON fg.singleton=1 AND fg.enabled=1
JOIN file_authority_control fc ON fc.singleton=1 AND fc.mode='active'
WHERE a.state='verified' AND a.io_settled_at IS NOT NULL AND f.state='verified'
AND a.file_id=f.result_file_id AND a.location_id=f.result_location_id
AND a.verified_byte_size=f.byte_size AND a.verified_sha256=f.sha256
AND j.state='running' AND julianday(j.lease_expires_at)>julianday('now')
AND a.verified_owner_token=j.owner_token AND a.verified_generation=j.generation AND a.verified_runtime_incarnation=j.runtime_incarnation
AND julianday(j.actor_checked_at)>=julianday('now','-10 seconds')
AND EXISTS(SELECT 1 FROM file_location_holds h WHERE h.location_id=a.location_id AND h.operation_id=a.id AND h.released_at IS NULL);

CREATE VIEW research_package_verified_aliases AS
SELECT f.job_id,f.logical_file_id,f.candidate_asset_id,f.result_file_id,f.result_location_id,f.target_profile_id,f.target_profile_revision,
 f.sha256,f.byte_size,l.object_key FROM research_package_files f
JOIN file_usable_publications p ON p.file_id=f.result_file_id AND p.purpose=f.purpose AND p.access_scope='system'
 AND p.verified_byte_size=f.byte_size AND p.verified_sha256=f.sha256
JOIN file_location_publications l ON l.location_id=f.result_location_id AND l.file_id=f.result_file_id AND l.storage_profile_id=f.target_profile_id
 AND l.verified_byte_size=f.byte_size AND l.verified_sha256=f.sha256
JOIN research_package_jobs j ON j.id=f.job_id
WHERE f.entry_kind='payload' AND f.state IN('verified','published') AND f.candidate_asset_id IS NOT NULL
AND(j.state='completed' OR(j.state='running' AND EXISTS(SELECT 1 FROM file_job_runtime_guard g WHERE g.singleton=1 AND g.enabled=1 AND g.incarnation=j.runtime_incarnation)
 AND julianday(j.lease_expires_at)>julianday('now') AND julianday(j.actor_checked_at)>=julianday('now','-10 seconds')));

-- Preserve every historical publication branch; add exact package evidence.
DROP TRIGGER file_shadow_location_publication_guard;
CREATE TRIGGER file_shadow_location_publication_guard BEFORE INSERT ON file_location_publications
BEGIN
 SELECT RAISE(ABORT,'File publication requires its exact verified executor candidate')
 WHERE NOT ((((SELECT mode FROM file_authority_control WHERE singleton=1)='overlap' AND EXISTS(SELECT 1 FROM file_shadow_attempts a JOIN file_shadow_operations o ON o.id=a.operation_id JOIN file_shadow_heads h ON h.occurrence_id=o.occurrence_id AND h.present=1 WHERE o.id=NEW.verification_operation_id AND o.status='pending' AND a.state='verified' AND a.candidate_file_id=NEW.file_id AND a.candidate_location_id=NEW.location_id AND a.candidate_object_key=NEW.object_key AND o.destination_profile_id=NEW.storage_profile_id AND a.verified_byte_size=NEW.verified_byte_size AND a.verified_sha256=NEW.verified_sha256 AND (o.captured_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1) OR EXISTS(SELECT 1 FROM file_shadow_reconciliations r JOIN file_shadow_runtime_guard g ON g.enabled=1 AND g.incarnation=r.runtime_incarnation WHERE r.attempt_id=a.id AND r.verified_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1) AND r.verified_sha256=a.verified_sha256 AND r.verified_byte_size=a.verified_byte_size)) AND ((EXISTS(SELECT 1 FROM file_shadow_runtime_guard g WHERE g.singleton=1 AND g.enabled=1 AND g.incarnation=a.runtime_incarnation) AND julianday(a.lease_expires_at)>julianday('now')) OR EXISTS(SELECT 1 FROM file_shadow_reconciliations r JOIN file_shadow_runtime_guard g ON g.enabled=1 AND g.incarnation=r.runtime_incarnation WHERE r.attempt_id=a.id AND r.verified_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1) AND r.verified_sha256=a.verified_sha256 AND r.verified_byte_size=a.verified_byte_size))))
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
   AND h.operation_id=i.hold_operation_id AND h.hold_kind='transition_destination' AND h.released_at IS NULL))) OR EXISTS(SELECT 1 FROM research_package_live_verified_attempts a
 WHERE a.id=NEW.verification_operation_id AND a.location_id=NEW.location_id AND a.file_id=NEW.file_id
 AND a.object_key=NEW.object_key AND a.target_profile_id=NEW.storage_profile_id
 AND a.verified_byte_size=NEW.verified_byte_size AND a.verified_sha256=NEW.verified_sha256
 AND NEW.verification_method='full_read_sha256'));
END;
DROP TRIGGER file_shadow_file_publication_guard;
CREATE TRIGGER file_shadow_file_publication_guard BEFORE INSERT ON file_publications
BEGIN
 SELECT RAISE(ABORT,'File publication requires its exact verified executor candidate')
 WHERE NOT ((((SELECT mode FROM file_authority_control WHERE singleton=1)='overlap' AND EXISTS(SELECT 1 FROM file_location_publications p JOIN file_shadow_operations o ON o.id=p.verification_operation_id JOIN file_shadow_attempts a ON a.operation_id=o.id AND a.candidate_location_id=p.location_id WHERE p.location_id=NEW.active_location_id AND p.file_id=NEW.file_id AND a.candidate_file_id=NEW.file_id AND a.state='verified' AND o.status='pending' AND NEW.purpose IS o.purpose AND NEW.access_scope IS o.access_scope AND NEW.verified_byte_size=p.verified_byte_size AND NEW.verified_sha256=p.verified_sha256))
 OR ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS(SELECT 1 FROM file_authority_pending_candidates c JOIN file_location_publications l
 ON l.location_id=c.candidate_location_id AND l.file_id=c.candidate_file_id AND l.storage_profile_id=c.storage_profile_id
 AND l.object_key=c.candidate_object_key AND l.verification_operation_id=c.receipt_operation_id
 AND l.verification_method='full_read_sha256' AND l.verified_sha256=c.expected_sha256 AND l.verified_byte_size=c.expected_byte_size
 WHERE c.state='candidate' AND c.candidate_file_id=NEW.file_id AND c.candidate_location_id=NEW.active_location_id
 AND c.purpose=NEW.purpose AND c.access_scope=NEW.access_scope AND c.expected_byte_size=NEW.verified_byte_size
 AND c.expected_sha256=NEW.verified_sha256))) OR EXISTS(SELECT 1 FROM research_package_live_verified_attempts a JOIN file_location_publications l
 ON l.location_id=a.location_id AND l.verification_operation_id=a.id
 WHERE a.file_id=NEW.file_id AND a.location_id=NEW.active_location_id AND a.purpose=NEW.purpose
 AND NEW.access_scope='system' AND a.verified_byte_size=NEW.verified_byte_size AND a.verified_sha256=NEW.verified_sha256));
END;
DROP TRIGGER assets_native_insert_guard;
CREATE TRIGGER assets_native_insert_guard BEFORE INSERT ON assets WHEN NEW.r2_key IS NULL BEGIN
 SELECT RAISE(ABORT,'Native alias requires exact verified File acceptance') WHERE (NOT EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active') OR NEW.status NOT IN('pending','ready') OR NOT EXISTS(
 SELECT 1 FROM file_authority_ready_candidate_aliases c JOIN storage_profiles p ON p.id=c.storage_profile_id AND p.adapter_type='s3'
 WHERE c.result_file_id=NEW.file_id AND c.storage_profile_id=NEW.storage_profile_id AND p.configuration_revision=NEW.storage_profile_revision
 AND c.result_object_key=NEW.object_key AND c.expected_sha256=NEW.sha256 AND c.expected_byte_size=NEW.byte_size
 AND c.alias_id=NEW.id AND ((c.acceptance_kind='import_file' AND NEW.import_id=c.acceptance_id) OR(c.acceptance_kind<>'import_file' AND NEW.import_id IS NULL)))) AND NOT EXISTS(SELECT 1 FROM research_package_verified_aliases c
 JOIN file_authority_control fc ON fc.singleton=1 AND fc.mode='active'
 JOIN file_authority_runtime_guard fg ON fg.singleton=1 AND fg.enabled=1
 WHERE c.candidate_asset_id=NEW.id AND c.result_file_id=NEW.file_id AND c.target_profile_id=NEW.storage_profile_id
 AND c.target_profile_revision=NEW.storage_profile_revision AND c.object_key=NEW.object_key
 AND c.sha256=NEW.sha256 AND c.byte_size=NEW.byte_size AND NEW.status='ready' AND NEW.import_id IS NULL);
 SELECT RAISE(ABORT,'Native alias identity conflict') WHERE EXISTS(SELECT 1 FROM assets WHERE id=NEW.id OR storage_profile_id=NEW.storage_profile_id AND object_key=NEW.object_key);
END;
DROP TRIGGER file_location_gc_orphan_guard;
CREATE TRIGGER file_location_gc_orphan_guard BEFORE INSERT ON file_location_gc_ledger BEGIN
  SELECT RAISE(ABORT,'Location cannot become orphaned while retained or held')
  WHERE NEW.state<>'orphaned' OR NOT (
    EXISTS(SELECT 1 FROM file_location_publications p WHERE p.location_id=NEW.location_id)
    OR EXISTS(SELECT 1 FROM file_acceptance_candidates c WHERE c.candidate_location_id=NEW.location_id AND c.state IN('ready','cancelled'))
    OR EXISTS(SELECT 1 FROM file_migration_attempts a WHERE a.location_id=NEW.location_id AND a.state IN('failed','cancelled')
      AND(a.io_settled_at IS NOT NULL OR a.write_started_at IS NULL))
    OR EXISTS(SELECT 1 FROM research_package_attempts a WHERE a.location_id=NEW.location_id AND a.state IN('failed','cancelled')
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

-- Closed transformed rows are accepted once, before I/O. Historic insertion
-- exceptions require every actual NEW cell to match this frozen row exactly.
CREATE VIEW research_package_live_domain_rows AS
SELECT j.id job_id,json_extract(r.value,'$.table') table_name,json_extract(r.value,'$.id') destination_id,
 json_extract(r.value,'$.data') row_json FROM research_package_jobs j JOIN json_each(j.domain_plan_json,'$.rows') r
JOIN file_job_runtime_guard g ON g.singleton=1 AND g.enabled=1 AND g.incarnation=j.runtime_incarnation
JOIN file_authority_runtime_guard fg ON fg.singleton=1 AND fg.enabled=1
JOIN file_authority_control fc ON fc.singleton=1 AND fc.mode='active'
WHERE j.kind='import' AND j.state='running' AND julianday(j.lease_expires_at)>julianday('now')
AND julianday(j.actor_checked_at)>=julianday('now','-10 seconds');

DROP TRIGGER project_content_attachments_validate_insert;
CREATE TRIGGER project_content_attachments_validate_insert
BEFORE INSERT ON project_content_attachments
BEGIN
  SELECT RAISE(ABORT, 'project attachment requires active attachment content')
  WHERE NOT EXISTS (
    SELECT 1 FROM project_contents pc
    JOIN projects p ON p.id = pc.project_id
    WHERE pc.id = NEW.project_content_id
      AND pc.content_type = 'attachment'
      AND (pc.deleted_at IS NULL OR EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='project_content_attachments' AND imported.destination_id=NEW.project_content_id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('project_content_id',NEW.project_content_id,'asset_id',NEW.asset_id,'storage_object_id',NEW.storage_object_id,'original_name',NEW.original_name,'mime_type',NEW.mime_type,'byte_size',NEW.byte_size,'created_by',NEW.created_by,'created_at',NEW.created_at,'creation_operation_id',NEW.creation_operation_id,'file_id',NEW.file_id)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value)))
      AND (p.deleted_at IS NULL OR EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='project_content_attachments' AND imported.destination_id=NEW.project_content_id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('project_content_id',NEW.project_content_id,'asset_id',NEW.asset_id,'storage_object_id',NEW.storage_object_id,'original_name',NEW.original_name,'mime_type',NEW.mime_type,'byte_size',NEW.byte_size,'created_by',NEW.created_by,'created_at',NEW.created_at,'creation_operation_id',NEW.creation_operation_id,'file_id',NEW.file_id)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value)))
  );
  SELECT RAISE(ABORT, 'project attachment asset is not ready')
  WHERE NEW.asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM assets a
    WHERE a.id = NEW.asset_id AND a.status = 'ready'
  );
  SELECT RAISE(ABORT, 'project attachment managed object is not ready')
  WHERE NEW.storage_object_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM managed_storage_objects mso
    WHERE mso.id = NEW.storage_object_id AND mso.status IN ('ready', 'orphaned')
  );
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.file_id AND fp.purpose='research_source')) AND EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.file_id AND fp.purpose='research_source')) AND EXISTS (
    SELECT 1 FROM managed_storage_objects mso JOIN blob_gc_ledger bg
      ON bg.store_kind = 'managed' AND bg.provider = mso.provider
        AND bg.object_key = mso.object_key
    WHERE mso.id = NEW.storage_object_id AND bg.state IN ('deleting', 'deleted')
  );
  UPDATE managed_storage_objects
  SET status = 'ready', orphaned_at = NULL
  WHERE id = NEW.storage_object_id AND status = 'orphaned';
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'managed' AND state = 'orphaned'
    AND (provider, object_key) = (
      SELECT provider, object_key FROM managed_storage_objects
      WHERE id = NEW.storage_object_id
    );
END;

DROP TRIGGER project_items_validate_insert;
CREATE TRIGGER project_items_validate_insert
BEFORE INSERT ON project_items
BEGIN
  SELECT RAISE(ABORT, 'project item requires an active project')
  WHERE NOT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = NEW.project_id AND (p.deleted_at IS NULL OR EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='project_items' AND imported.destination_id=NEW.id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',NEW.id,'project_id',NEW.project_id,'item_type',NEW.item_type,'project_content_id',NEW.project_content_id,'reference_target_id',NEW.reference_target_id,'created_sequence',NEW.created_sequence,'revision',NEW.revision,'last_mutation_id',NEW.last_mutation_id,'created_by',NEW.created_by,'updated_by',NEW.updated_by,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at,'deleted_by',NEW.deleted_by,'deletion_operation_id',NEW.deletion_operation_id)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value)))
  );
  SELECT RAISE(ABORT, 'project content belongs to another project or is unavailable')
  WHERE NEW.item_type = 'content' AND NOT EXISTS (
    SELECT 1 FROM project_contents pc
    WHERE pc.id = NEW.project_content_id
      AND pc.project_id = NEW.project_id
      AND (pc.deleted_at IS NULL OR EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='project_items' AND imported.destination_id=NEW.id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',NEW.id,'project_id',NEW.project_id,'item_type',NEW.item_type,'project_content_id',NEW.project_content_id,'reference_target_id',NEW.reference_target_id,'created_sequence',NEW.created_sequence,'revision',NEW.revision,'last_mutation_id',NEW.last_mutation_id,'created_by',NEW.created_by,'updated_by',NEW.updated_by,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at,'deleted_by',NEW.deleted_by,'deletion_operation_id',NEW.deletion_operation_id)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value)))
  );
  SELECT RAISE(ABORT, 'reference target is unavailable')
  WHERE NEW.item_type = 'reference' AND NOT EXISTS (
    SELECT 1 FROM reference_targets rt
    WHERE rt.id = NEW.reference_target_id AND (rt.tombstoned_at IS NULL OR EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='project_items' AND imported.destination_id=NEW.id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',NEW.id,'project_id',NEW.project_id,'item_type',NEW.item_type,'project_content_id',NEW.project_content_id,'reference_target_id',NEW.reference_target_id,'created_sequence',NEW.created_sequence,'revision',NEW.revision,'last_mutation_id',NEW.last_mutation_id,'created_by',NEW.created_by,'updated_by',NEW.updated_by,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at,'deleted_by',NEW.deleted_by,'deletion_operation_id',NEW.deletion_operation_id)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value)))
  );
END;

DROP TRIGGER project_map_placements_validate_insert;
CREATE TRIGGER project_map_placements_validate_insert
BEFORE INSERT ON project_map_placements
WHEN NOT EXISTS (
  SELECT 1 FROM project_items pi
  JOIN projects p ON p.id = pi.project_id
  WHERE pi.id = NEW.project_item_id
    AND (pi.deleted_at IS NULL OR EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='project_map_placements' AND imported.destination_id=NEW.id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',NEW.id,'project_item_id',NEW.project_item_id,'x',NEW.x,'y',NEW.y,'width',NEW.width,'height',NEW.height,'z_index',NEW.z_index,'revision',NEW.revision,'last_mutation_id',NEW.last_mutation_id,'created_by',NEW.created_by,'updated_by',NEW.updated_by,'created_at',NEW.created_at,'updated_at',NEW.updated_at)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value)))
    AND (p.deleted_at IS NULL OR EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='project_map_placements' AND imported.destination_id=NEW.id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',NEW.id,'project_item_id',NEW.project_item_id,'x',NEW.x,'y',NEW.y,'width',NEW.width,'height',NEW.height,'z_index',NEW.z_index,'revision',NEW.revision,'last_mutation_id',NEW.last_mutation_id,'created_by',NEW.created_by,'updated_by',NEW.updated_by,'created_at',NEW.created_at,'updated_at',NEW.updated_at)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value)))
)
BEGIN
  SELECT RAISE(ABORT, 'project placement requires an active item');
END;

DROP TRIGGER project_edges_validate_insert;
CREATE TRIGGER project_edges_validate_insert
BEFORE INSERT ON project_edges
BEGIN
  SELECT RAISE(ABORT, 'project edge requires an active project')
  WHERE NOT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = NEW.project_id AND (p.deleted_at IS NULL OR EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='project_edges' AND imported.destination_id=NEW.id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',NEW.id,'project_id',NEW.project_id,'source_item_id',NEW.source_item_id,'target_item_id',NEW.target_item_id,'source_handle',NEW.source_handle,'target_handle',NEW.target_handle,'marker_start',NEW.marker_start,'marker_end',NEW.marker_end,'label',NEW.label,'revision',NEW.revision,'last_mutation_id',NEW.last_mutation_id,'created_by',NEW.created_by,'updated_by',NEW.updated_by,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at,'deleted_by',NEW.deleted_by,'deletion_operation_id',NEW.deletion_operation_id)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value)))
  );
  SELECT RAISE(ABORT, 'project edge endpoints must be active items in the same project')
  WHERE NOT EXISTS (
    SELECT 1
    FROM project_items source
    JOIN project_items target
      ON target.id = NEW.target_item_id
    WHERE source.id = NEW.source_item_id
      AND source.project_id = NEW.project_id
      AND target.project_id = NEW.project_id
      AND (source.deleted_at IS NULL OR EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='project_edges' AND imported.destination_id=NEW.id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',NEW.id,'project_id',NEW.project_id,'source_item_id',NEW.source_item_id,'target_item_id',NEW.target_item_id,'source_handle',NEW.source_handle,'target_handle',NEW.target_handle,'marker_start',NEW.marker_start,'marker_end',NEW.marker_end,'label',NEW.label,'revision',NEW.revision,'last_mutation_id',NEW.last_mutation_id,'created_by',NEW.created_by,'updated_by',NEW.updated_by,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at,'deleted_by',NEW.deleted_by,'deletion_operation_id',NEW.deletion_operation_id)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value)))
      AND (target.deleted_at IS NULL OR EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='project_edges' AND imported.destination_id=NEW.id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',NEW.id,'project_id',NEW.project_id,'source_item_id',NEW.source_item_id,'target_item_id',NEW.target_item_id,'source_handle',NEW.source_handle,'target_handle',NEW.target_handle,'marker_start',NEW.marker_start,'marker_end',NEW.marker_end,'label',NEW.label,'revision',NEW.revision,'last_mutation_id',NEW.last_mutation_id,'created_by',NEW.created_by,'updated_by',NEW.updated_by,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at,'deleted_by',NEW.deleted_by,'deletion_operation_id',NEW.deletion_operation_id)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value)))
  );
END;

DROP TRIGGER runs_reject_archived_template;
CREATE TRIGGER runs_reject_archived_template
BEFORE INSERT ON runs
WHEN (EXISTS (
  SELECT 1 FROM template_versions
  WHERE id = NEW.template_version_id
    AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL)
)) AND NOT EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='runs' AND imported.destination_id=NEW.id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',NEW.id,'sample_id',NEW.sample_id,'recipe_family_id',NEW.recipe_family_id,'template_version_id',NEW.template_version_id,'current_plan_revision_id',NEW.current_plan_revision_id,'predecessor_run_id',NEW.predecessor_run_id,'anchor_step_id',NEW.anchor_step_id,'sequence_no',NEW.sequence_no,'run_group_id',NEW.run_group_id,'template_name_snapshot',NEW.template_name_snapshot,'template_type_snapshot',NEW.template_type_snapshot,'template_version_snapshot',NEW.template_version_snapshot,'status',NEW.status,'created_by',NEW.created_by,'created_at',NEW.created_at,'completed_at',NEW.completed_at,'initial_state_hash',NEW.initial_state_hash,'run_kind',NEW.run_kind,'deleted_at',NEW.deleted_at,'deleted_by',NEW.deleted_by,'last_mutation_id',NEW.last_mutation_id)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value))
BEGIN
  SELECT RAISE(ABORT, 'template version unavailable');
END;

DROP TRIGGER run_plan_revisions_reject_archived_template;
CREATE TRIGGER run_plan_revisions_reject_archived_template
BEFORE INSERT ON run_plan_revisions
WHEN (EXISTS (
  SELECT 1 FROM template_versions
  WHERE id = NEW.template_version_id
    AND (archived_at IS NOT NULL OR deleted_at IS NOT NULL)
)) AND NOT EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='run_plan_revisions' AND imported.destination_id=NEW.id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',NEW.id,'run_id',NEW.run_id,'revision_no',NEW.revision_no,'template_version_id',NEW.template_version_id,'effective_after_step_id',NEW.effective_after_step_id,'reason',NEW.reason,'actor_email',NEW.actor_email,'created_at',NEW.created_at)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value))
BEGIN
  SELECT RAISE(ABORT, 'template version unavailable');
END;

DROP TRIGGER runs_activate_sample_after_insert;
CREATE TRIGGER runs_activate_sample_after_insert
AFTER INSERT ON runs
WHEN (NEW.status = 'active' AND NEW.deleted_at IS NULL) AND NOT EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='runs' AND imported.destination_id=NEW.id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',NEW.id,'sample_id',NEW.sample_id,'recipe_family_id',NEW.recipe_family_id,'template_version_id',NEW.template_version_id,'current_plan_revision_id',NEW.current_plan_revision_id,'predecessor_run_id',NEW.predecessor_run_id,'anchor_step_id',NEW.anchor_step_id,'sequence_no',NEW.sequence_no,'run_group_id',NEW.run_group_id,'template_name_snapshot',NEW.template_name_snapshot,'template_type_snapshot',NEW.template_type_snapshot,'template_version_snapshot',NEW.template_version_snapshot,'status',NEW.status,'created_by',NEW.created_by,'created_at',NEW.created_at,'completed_at',NEW.completed_at,'initial_state_hash',NEW.initial_state_hash,'run_kind',NEW.run_kind,'deleted_at',NEW.deleted_at,'deleted_by',NEW.deleted_by,'last_mutation_id',NEW.last_mutation_id)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value))
BEGIN
  UPDATE samples
  SET status = 'active',
      updated_by = COALESCE(NEW.created_by, updated_by),
      updated_at = CASE
        WHEN NEW.created_at > updated_at THEN NEW.created_at
        ELSE updated_at
      END
  WHERE id = NEW.sample_id AND status != 'active';
END;

DROP TRIGGER run_plan_revisions_lock_template;
CREATE TRIGGER run_plan_revisions_lock_template
AFTER INSERT ON run_plan_revisions
WHEN NOT EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='run_plan_revisions' AND imported.destination_id=NEW.id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',NEW.id,'run_id',NEW.run_id,'revision_no',NEW.revision_no,'template_version_id',NEW.template_version_id,'effective_after_step_id',NEW.effective_after_step_id,'reason',NEW.reason,'actor_email',NEW.actor_email,'created_at',NEW.created_at)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value))
BEGIN
  UPDATE template_versions
  SET locked_at = COALESCE(locked_at, NEW.created_at),
      locked_by = COALESCE(locked_by, NEW.actor_email)
  WHERE id = NEW.template_version_id;
END;

DROP TRIGGER comment_submission_items_file_insert_guard;
CREATE TRIGGER comment_submission_items_file_insert_guard
BEFORE INSERT ON comment_submission_items WHEN NEW.file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Comment item File purpose or readiness mismatch')
  WHERE (NOT EXISTS (
    SELECT 1 FROM file_usable_publications fp WHERE fp.file_id = NEW.file_id
      AND ((NEW.kind = 'attachment' AND fp.purpose = 'research_source')
        OR (NEW.kind = 'comment_image' AND NEW.related_item_id IS NULL AND fp.purpose = 'embedded_content')
        OR (NEW.kind = 'comment_image' AND NEW.related_item_id IS NOT NULL AND fp.purpose = 'derived_preview'))
      AND (NEW.kind <> 'comment_image' OR NEW.related_item_id IS NULL
        OR ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS(SELECT 1 FROM file_authority_ready_candidate_aliases c
 JOIN comment_item_acceptances r ON r.item_id=c.acceptance_id AND r.submission_id=NEW.submission_id AND r.status IN('pending','ready')
 JOIN comment_submission_items original ON original.id=NEW.related_item_id AND original.submission_id=NEW.submission_id
 WHERE c.acceptance_kind='comment_item' AND c.acceptance_id=NEW.id AND c.item_id=''
 AND c.purpose='derived_preview' AND c.result_file_id=NEW.file_id AND original.kind='attachment')) OR EXISTS (
        SELECT 1 FROM file_derivations d
        JOIN comment_submission_items source_item ON source_item.id = NEW.related_item_id
        JOIN file_usable_publications source ON source.file_id = d.source_file_id
        WHERE d.derived_file_id = NEW.file_id AND d.trust_state = 'verified'
          AND source_item.file_id = d.source_file_id
      ))
  )) AND NOT (EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='comment_submission_items' AND imported.destination_id=NEW.id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',NEW.id,'submission_id',NEW.submission_id,'kind',NEW.kind,'status',NEW.status,'position',NEW.position,'filename',NEW.filename,'mime_type',NEW.mime_type,'byte_size',NEW.byte_size,'original_filename',NEW.original_filename,'original_mime_type',NEW.original_mime_type,'original_byte_size',NEW.original_byte_size,'title',NEW.title,'description',NEW.description,'external_url',NEW.external_url,'asset_id',NEW.asset_id,'storage_object_id',NEW.storage_object_id,'sha256',NEW.sha256,'related_item_id',NEW.related_item_id,'error_message',NEW.error_message,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'deleted_at',NEW.deleted_at,'deleted_by',NEW.deleted_by,'file_id',NEW.file_id)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value)) AND EXISTS(SELECT 1 FROM file_usable_publications f JOIN comment_submission_items original ON original.id=NEW.related_item_id AND original.submission_id=NEW.submission_id WHERE f.file_id=NEW.file_id AND f.purpose='derived_preview' AND f.access_scope='system'));
END;

DROP TRIGGER events_thumbnail_file_insert_guard;
CREATE TRIGGER events_thumbnail_file_insert_guard
BEFORE INSERT ON events WHEN NEW.thumbnail_file_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Legacy File authority rejects typed consumer bindings')
  WHERE (SELECT mode FROM file_authority_control WHERE singleton = 1) = 'legacy';
  SELECT RAISE(ABORT, 'Event thumbnail File purpose or readiness mismatch')
  WHERE (NOT EXISTS (SELECT 1 FROM file_usable_publications fp
    JOIN file_derivations d ON d.derived_file_id = fp.file_id AND d.trust_state = 'verified'
    JOIN file_usable_publications source ON source.file_id = d.source_file_id
    WHERE fp.file_id = NEW.thumbnail_file_id AND fp.purpose = 'derived_preview'
      AND NEW.asset_file_id = d.source_file_id)) AND NOT (EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='events' AND imported.destination_id=NEW.id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',NEW.id,'sample_id',NEW.sample_id,'kind',NEW.kind,'body',NEW.body,'asset_key',NEW.asset_key,'metadata_json',NEW.metadata_json,'actor_email',NEW.actor_email,'created_at',NEW.created_at,'asset_file_id',NEW.asset_file_id,'thumbnail_file_id',NEW.thumbnail_file_id)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value)) AND EXISTS(SELECT 1 FROM file_usable_publications f WHERE f.file_id=NEW.thumbnail_file_id AND f.purpose='derived_preview' AND f.access_scope='system'));
END;

-- A single closed-table projection avoids recursive compound-SELECT expansion
-- under native D1 limits while retaining every PK and typed cell proof.
CREATE VIEW research_package_domain_rows_present AS
SELECT planned.job_id,planned.table_name,planned.destination_id
FROM research_package_live_domain_rows planned WHERE
(planned.table_name='comment_submission_items' AND EXISTS(SELECT 1 FROM comment_submission_items actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'submission_id',actual.submission_id,'kind',actual.kind,'status',actual.status,'position',actual.position,'filename',actual.filename,'mime_type',actual.mime_type,'byte_size',actual.byte_size,'original_filename',actual.original_filename,'original_mime_type',actual.original_mime_type,'original_byte_size',actual.original_byte_size,'title',actual.title,'description',actual.description,'external_url',actual.external_url,'asset_id',actual.asset_id,'storage_object_id',actual.storage_object_id,'sha256',actual.sha256,'related_item_id',actual.related_item_id,'error_message',actual.error_message,'created_at',actual.created_at,'updated_at',actual.updated_at,'deleted_at',actual.deleted_at,'deleted_by',actual.deleted_by,'file_id',actual.file_id)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='comment_submission_targets' AND EXISTS(SELECT 1 FROM comment_submission_targets actual WHERE actual.submission_id IS json_extract(planned.row_json,'$.submission_id') AND actual.run_step_id IS json_extract(planned.row_json,'$.run_step_id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('submission_id',actual.submission_id,'sample_id',actual.sample_id,'run_id',actual.run_id,'run_step_id',actual.run_step_id,'expected_updated_at',actual.expected_updated_at)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='comment_submissions' AND EXISTS(SELECT 1 FROM comment_submissions actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'context_kind',actual.context_kind,'sample_id',actual.sample_id,'scope',actual.scope,'body',actual.body,'status',actual.status,'error_message',actual.error_message,'actor_email',actual.actor_email,'created_at',actual.created_at,'updated_at',actual.updated_at,'completed_at',actual.completed_at,'cancelled_at',actual.cancelled_at,'deleted_at',actual.deleted_at,'deleted_by',actual.deleted_by,'last_mutation_id',actual.last_mutation_id,'deletion_operation_id',actual.deletion_operation_id,'retry_until',actual.retry_until,'retry_closed_at',actual.retry_closed_at,'retry_closed_by',actual.retry_closed_by)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='events' AND EXISTS(SELECT 1 FROM events actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'sample_id',actual.sample_id,'kind',actual.kind,'body',actual.body,'asset_key',actual.asset_key,'metadata_json',actual.metadata_json,'actor_email',actual.actor_email,'created_at',actual.created_at,'asset_file_id',actual.asset_file_id,'thumbnail_file_id',actual.thumbnail_file_id)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='imports' AND EXISTS(SELECT 1 FROM imports actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'status',actual.status,'source_filename',actual.source_filename,'source_sha256',actual.source_sha256,'sheet_name',actual.sheet_name,'template_type',actual.template_type,'recipe_family_id',actual.recipe_family_id,'template_version_id',actual.template_version_id,'workbook_asset_key',actual.workbook_asset_key,'manifest_asset_key',actual.manifest_asset_key,'warning_count',actual.warning_count,'error_message',actual.error_message,'actor_email',actual.actor_email,'created_at',actual.created_at,'completed_at',actual.completed_at,'operation_id',actual.operation_id,'lease_expires_at',actual.lease_expires_at,'finalization_id',actual.finalization_id,'recovery_operation_id',actual.recovery_operation_id,'client_request_id',actual.client_request_id,'request_sha256',actual.request_sha256,'request_input_json',actual.request_input_json,'request_scope',actual.request_scope,'storage_profile_id',actual.storage_profile_id,'storage_profile_revision',actual.storage_profile_revision,'storage_policy_revision',actual.storage_policy_revision,'accepted_result_json',actual.accepted_result_json,'workbook_file_id',actual.workbook_file_id,'manifest_file_id',actual.manifest_file_id,'file_targets_protocol',actual.file_targets_protocol,'role_policy_revision',actual.role_policy_revision)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='metrology_template_references' AND EXISTS(SELECT 1 FROM metrology_template_references actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'template_version_id',actual.template_version_id,'asset_id',actual.asset_id,'display_name',actual.display_name,'position',actual.position,'actor_email',actual.actor_email,'created_at',actual.created_at,'deleted_at',actual.deleted_at,'deleted_by',actual.deleted_by,'superseded_by_occurrence_id',actual.superseded_by_occurrence_id,'superseded_at',actual.superseded_at,'superseded_by',actual.superseded_by,'supersession_operation_id',actual.supersession_operation_id,'file_id',actual.file_id)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='project_content_attachments' AND EXISTS(SELECT 1 FROM project_content_attachments actual WHERE actual.project_content_id IS json_extract(planned.row_json,'$.project_content_id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('project_content_id',actual.project_content_id,'asset_id',actual.asset_id,'storage_object_id',actual.storage_object_id,'original_name',actual.original_name,'mime_type',actual.mime_type,'byte_size',actual.byte_size,'created_by',actual.created_by,'created_at',actual.created_at,'creation_operation_id',actual.creation_operation_id,'file_id',actual.file_id)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='project_contents' AND EXISTS(SELECT 1 FROM project_contents actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'project_id',actual.project_id,'content_type',actual.content_type,'markdown_source',actual.markdown_source,'attachment_caption',actual.attachment_caption,'attachment_source_url',actual.attachment_source_url,'format_version',actual.format_version,'revision',actual.revision,'last_mutation_id',actual.last_mutation_id,'created_by',actual.created_by,'updated_by',actual.updated_by,'created_at',actual.created_at,'updated_at',actual.updated_at,'deleted_at',actual.deleted_at,'deleted_by',actual.deleted_by,'deletion_operation_id',actual.deletion_operation_id)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='project_edges' AND EXISTS(SELECT 1 FROM project_edges actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'project_id',actual.project_id,'source_item_id',actual.source_item_id,'target_item_id',actual.target_item_id,'source_handle',actual.source_handle,'target_handle',actual.target_handle,'marker_start',actual.marker_start,'marker_end',actual.marker_end,'label',actual.label,'revision',actual.revision,'last_mutation_id',actual.last_mutation_id,'created_by',actual.created_by,'updated_by',actual.updated_by,'created_at',actual.created_at,'updated_at',actual.updated_at,'deleted_at',actual.deleted_at,'deleted_by',actual.deleted_by,'deletion_operation_id',actual.deletion_operation_id)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='project_items' AND EXISTS(SELECT 1 FROM project_items actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'project_id',actual.project_id,'item_type',actual.item_type,'project_content_id',actual.project_content_id,'reference_target_id',actual.reference_target_id,'created_sequence',actual.created_sequence,'revision',actual.revision,'last_mutation_id',actual.last_mutation_id,'created_by',actual.created_by,'updated_by',actual.updated_by,'created_at',actual.created_at,'updated_at',actual.updated_at,'deleted_at',actual.deleted_at,'deleted_by',actual.deleted_by,'deletion_operation_id',actual.deletion_operation_id)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='project_map_placements' AND EXISTS(SELECT 1 FROM project_map_placements actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'project_item_id',actual.project_item_id,'x',actual.x,'y',actual.y,'width',actual.width,'height',actual.height,'z_index',actual.z_index,'revision',actual.revision,'last_mutation_id',actual.last_mutation_id,'created_by',actual.created_by,'updated_by',actual.updated_by,'created_at',actual.created_at,'updated_at',actual.updated_at)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='projects' AND EXISTS(SELECT 1 FROM projects actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'title',actual.title,'revision',actual.revision,'next_created_sequence',actual.next_created_sequence,'last_mutation_id',actual.last_mutation_id,'created_by',actual.created_by,'updated_by',actual.updated_by,'created_at',actual.created_at,'updated_at',actual.updated_at,'deleted_at',actual.deleted_at,'deleted_by',actual.deleted_by,'deletion_operation_id',actual.deletion_operation_id)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='recipe_change_proposals' AND EXISTS(SELECT 1 FROM recipe_change_proposals actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'recipe_family_id',actual.recipe_family_id,'source_template_version_id',actual.source_template_version_id,'source_verification_id',actual.source_verification_id,'change_type',actual.change_type,'body',actual.body,'status',actual.status,'actor_email',actual.actor_email,'created_at',actual.created_at)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='recipe_families' AND EXISTS(SELECT 1 FROM recipe_families actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'name',actual.name,'template_type',actual.template_type,'created_by',actual.created_by,'created_at',actual.created_at,'archived_at',actual.archived_at,'archived_by',actual.archived_by)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='reference_targets' AND EXISTS(SELECT 1 FROM reference_targets actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'registry_version',actual.registry_version,'target_type',actual.target_type,'target_id',actual.target_id,'first_registered_at',actual.first_registered_at,'last_validated_at',actual.last_validated_at,'tombstoned_at',actual.tombstoned_at,'last_known_contexts_json',actual.last_known_contexts_json)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='run_plan_revisions' AND EXISTS(SELECT 1 FROM run_plan_revisions actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'run_id',actual.run_id,'revision_no',actual.revision_no,'template_version_id',actual.template_version_id,'effective_after_step_id',actual.effective_after_step_id,'reason',actual.reason,'actor_email',actual.actor_email,'created_at',actual.created_at)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='run_step_assets' AND EXISTS(SELECT 1 FROM run_step_assets actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'run_step_id',actual.run_step_id,'asset_id',actual.asset_id,'role',actual.role,'position',actual.position,'actor_email',actual.actor_email,'created_at',actual.created_at,'deleted_at',actual.deleted_at,'deleted_by',actual.deleted_by,'last_mutation_id',actual.last_mutation_id,'superseded_by_occurrence_id',actual.superseded_by_occurrence_id,'superseded_at',actual.superseded_at,'superseded_by',actual.superseded_by,'supersession_operation_id',actual.supersession_operation_id,'filename',actual.filename,'mime_type',actual.mime_type,'byte_size',actual.byte_size,'file_id',actual.file_id)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='run_step_comments' AND EXISTS(SELECT 1 FROM run_step_comments actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'run_step_id',actual.run_step_id,'scope',actual.scope,'operation_group_id',actual.operation_group_id,'asset_id',actual.asset_id,'actor_email',actual.actor_email,'created_at',actual.created_at,'submission_id',actual.submission_id,'updated_at',actual.updated_at,'updated_by',actual.updated_by,'deleted_at',actual.deleted_at,'deleted_by',actual.deleted_by,'asset_deleted_at',actual.asset_deleted_at,'asset_deleted_by',actual.asset_deleted_by,'last_mutation_id',actual.last_mutation_id,'deletion_operation_id',actual.deletion_operation_id,'asset_deletion_operation_id',actual.asset_deletion_operation_id,'legacy_body',actual.legacy_body,'file_id',actual.file_id)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='run_step_plan_links' AND EXISTS(SELECT 1 FROM run_step_plan_links actual WHERE actual.run_plan_revision_id IS json_extract(planned.row_json,'$.run_plan_revision_id') AND actual.template_step_id IS json_extract(planned.row_json,'$.template_step_id') AND actual.run_step_id IS json_extract(planned.row_json,'$.run_step_id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('run_plan_revision_id',actual.run_plan_revision_id,'template_step_id',actual.template_step_id,'run_step_id',actual.run_step_id,'relation',actual.relation,'created_at',actual.created_at)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='run_steps' AND EXISTS(SELECT 1 FROM run_steps actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'run_id',actual.run_id,'previous_step_id',actual.previous_step_id,'position',actual.position,'origin',actual.origin,'plan_status',actual.plan_status,'template_step_id',actual.template_step_id,'logical_step_key',actual.logical_step_key,'definition_hash',actual.definition_hash,'expected_state_hash',actual.expected_state_hash,'title',actual.title,'status',actual.status,'notes',actual.notes,'tool_name',actual.tool_name,'parameters_text',actual.parameters_text,'comments_text',actual.comments_text,'deviation_note',actual.deviation_note,'actualized_at',actual.actualized_at,'created_at',actual.created_at,'updated_by',actual.updated_by,'last_mutation_id',actual.last_mutation_id,'updated_at',actual.updated_at,'entry_kind',actual.entry_kind,'deleted_at',actual.deleted_at,'deleted_by',actual.deleted_by)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='runs' AND EXISTS(SELECT 1 FROM runs actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'sample_id',actual.sample_id,'recipe_family_id',actual.recipe_family_id,'template_version_id',actual.template_version_id,'current_plan_revision_id',actual.current_plan_revision_id,'predecessor_run_id',actual.predecessor_run_id,'anchor_step_id',actual.anchor_step_id,'sequence_no',actual.sequence_no,'run_group_id',actual.run_group_id,'template_name_snapshot',actual.template_name_snapshot,'template_type_snapshot',actual.template_type_snapshot,'template_version_snapshot',actual.template_version_snapshot,'status',actual.status,'created_by',actual.created_by,'created_at',actual.created_at,'completed_at',actual.completed_at,'initial_state_hash',actual.initial_state_hash,'run_kind',actual.run_kind,'deleted_at',actual.deleted_at,'deleted_by',actual.deleted_by,'last_mutation_id',actual.last_mutation_id)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='samples' AND EXISTS(SELECT 1 FROM samples actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'code',actual.code,'title',actual.title,'description',actual.description,'status',actual.status,'location',actual.location,'parent_id',actual.parent_id,'pinned',actual.pinned,'created_by',actual.created_by,'updated_by',actual.updated_by,'last_mutation_id',actual.last_mutation_id,'created_at',actual.created_at,'updated_at',actual.updated_at,'inherited_state_hash',actual.inherited_state_hash,'deleted_at',actual.deleted_at,'deleted_by',actual.deleted_by)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='state_representation_assets' AND EXISTS(SELECT 1 FROM state_representation_assets actual WHERE actual.state_hash IS json_extract(planned.row_json,'$.state_hash') AND actual.asset_id IS json_extract(planned.row_json,'$.asset_id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('state_hash',actual.state_hash,'asset_id',actual.asset_id,'position',actual.position,'file_id',actual.file_id)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='state_representations' AND EXISTS(SELECT 1 FROM state_representations actual WHERE actual.hash IS json_extract(planned.row_json,'$.hash') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('hash',actual.hash,'hash_scheme',actual.hash_scheme,'representation_type',actual.representation_type,'logical_state_key',actual.logical_state_key,'content_json',actual.content_json,'created_at',actual.created_at)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='state_verification_steps' AND EXISTS(SELECT 1 FROM state_verification_steps actual WHERE actual.verification_id IS json_extract(planned.row_json,'$.verification_id') AND actual.run_step_id IS json_extract(planned.row_json,'$.run_step_id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('verification_id',actual.verification_id,'run_step_id',actual.run_step_id,'ordinal',actual.ordinal)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='state_verifications' AND EXISTS(SELECT 1 FROM state_verifications actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'sample_id',actual.sample_id,'after_run_step_id',actual.after_run_step_id,'previous_verification_id',actual.previous_verification_id,'run_plan_revision_id',actual.run_plan_revision_id,'expected_state_hash',actual.expected_state_hash,'result',actual.result,'evidence_asset_id',actual.evidence_asset_id,'note',actual.note,'status',actual.status,'actor_email',actual.actor_email,'created_at',actual.created_at,'evidence_file_id',actual.evidence_file_id)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='step_definitions' AND EXISTS(SELECT 1 FROM step_definitions actual WHERE actual.hash IS json_extract(planned.row_json,'$.hash') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('hash',actual.hash,'hash_scheme',actual.hash_scheme,'name',actual.name,'tool_name',actual.tool_name,'parameters_text',actual.parameters_text,'comments_text',actual.comments_text,'canonical_json',actual.canonical_json,'created_at',actual.created_at)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='template_steps' AND EXISTS(SELECT 1 FROM template_steps actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'template_version_id',actual.template_version_id,'logical_step_key',actual.logical_step_key,'position',actual.position,'source_row',actual.source_row,'step_number',actual.step_number,'section_name',actual.section_name,'definition_hash',actual.definition_hash,'expected_state_hash',actual.expected_state_hash,'raw_json',actual.raw_json)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)))
OR (planned.table_name='template_versions' AND EXISTS(SELECT 1 FROM template_versions actual WHERE actual.id IS json_extract(planned.row_json,'$.id') AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',actual.id,'recipe_family_id',actual.recipe_family_id,'name',actual.name,'template_type',actual.template_type,'version',actual.version,'manifest_hash',actual.manifest_hash,'initial_state_hash',actual.initial_state_hash,'source_filename',actual.source_filename,'source_asset_key',actual.source_asset_key,'content_json',actual.content_json,'created_by',actual.created_by,'created_at',actual.created_at,'locked_at',actual.locked_at,'locked_by',actual.locked_by,'archived_at',actual.archived_at,'archived_by',actual.archived_by,'template_kind',actual.template_kind,'metrology_notes',actual.metrology_notes,'deleted_at',actual.deleted_at,'deleted_by',actual.deleted_by,'source_file_id',actual.source_file_id)) cell WHERE json_extract(planned.row_json,'$.'||cell.key) IS NOT cell.value)));

-- Copied SourceImport is frozen provenance, not a replayable FabuBlox receipt.
DROP TRIGGER imports_active_receipt_insert_guard;
CREATE TRIGGER imports_active_receipt_insert_guard BEFORE INSERT ON imports
WHEN(SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND NEW.status='ready'
BEGIN SELECT RAISE(ABORT,'Active import must complete its accepted File candidates') WHERE NOT(EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='imports' AND imported.destination_id=NEW.id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',NEW.id,'status',NEW.status,'source_filename',NEW.source_filename,'source_sha256',NEW.source_sha256,'sheet_name',NEW.sheet_name,'template_type',NEW.template_type,'recipe_family_id',NEW.recipe_family_id,'template_version_id',NEW.template_version_id,'workbook_asset_key',NEW.workbook_asset_key,'manifest_asset_key',NEW.manifest_asset_key,'warning_count',NEW.warning_count,'error_message',NEW.error_message,'actor_email',NEW.actor_email,'created_at',NEW.created_at,'completed_at',NEW.completed_at,'operation_id',NEW.operation_id,'lease_expires_at',NEW.lease_expires_at,'finalization_id',NEW.finalization_id,'recovery_operation_id',NEW.recovery_operation_id,'client_request_id',NEW.client_request_id,'request_sha256',NEW.request_sha256,'request_input_json',NEW.request_input_json,'request_scope',NEW.request_scope,'storage_profile_id',NEW.storage_profile_id,'storage_profile_revision',NEW.storage_profile_revision,'storage_policy_revision',NEW.storage_policy_revision,'accepted_result_json',NEW.accepted_result_json,'workbook_file_id',NEW.workbook_file_id,'manifest_file_id',NEW.manifest_file_id,'file_targets_protocol',NEW.file_targets_protocol,'role_policy_revision',NEW.role_policy_revision)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value))); END;

DROP TRIGGER run_step_assets_reject_superseded_insert;
CREATE TRIGGER run_step_assets_reject_superseded_insert BEFORE INSERT ON run_step_assets
WHEN(NEW.superseded_by_occurrence_id IS NOT NULL OR NEW.superseded_at IS NOT NULL OR NEW.superseded_by IS NOT NULL OR NEW.supersession_operation_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'run step asset supersession is recovery-only') WHERE NOT(EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='run_step_assets' AND imported.destination_id=NEW.id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',NEW.id,'run_step_id',NEW.run_step_id,'asset_id',NEW.asset_id,'role',NEW.role,'position',NEW.position,'actor_email',NEW.actor_email,'created_at',NEW.created_at,'deleted_at',NEW.deleted_at,'deleted_by',NEW.deleted_by,'last_mutation_id',NEW.last_mutation_id,'superseded_by_occurrence_id',NEW.superseded_by_occurrence_id,'superseded_at',NEW.superseded_at,'superseded_by',NEW.superseded_by,'supersession_operation_id',NEW.supersession_operation_id,'filename',NEW.filename,'mime_type',NEW.mime_type,'byte_size',NEW.byte_size,'file_id',NEW.file_id)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value))); END;

DROP TRIGGER metrology_template_references_reject_superseded_insert;
CREATE TRIGGER metrology_template_references_reject_superseded_insert BEFORE INSERT ON metrology_template_references
WHEN(NEW.superseded_by_occurrence_id IS NOT NULL OR NEW.superseded_at IS NOT NULL OR NEW.superseded_by IS NOT NULL OR NEW.supersession_operation_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'metrology reference supersession is recovery-only') WHERE NOT(EXISTS(SELECT 1 FROM research_package_live_domain_rows imported WHERE imported.table_name='metrology_template_references' AND imported.destination_id=NEW.id AND NOT EXISTS(SELECT 1 FROM json_each(json_object('id',NEW.id,'template_version_id',NEW.template_version_id,'asset_id',NEW.asset_id,'display_name',NEW.display_name,'position',NEW.position,'actor_email',NEW.actor_email,'created_at',NEW.created_at,'deleted_at',NEW.deleted_at,'deleted_by',NEW.deleted_by,'superseded_by_occurrence_id',NEW.superseded_by_occurrence_id,'superseded_at',NEW.superseded_at,'superseded_by',NEW.superseded_by,'supersession_operation_id',NEW.supersession_operation_id,'file_id',NEW.file_id)) cell WHERE json_extract(imported.row_json,'$.'||cell.key) IS NOT cell.value))); END;

CREATE TRIGGER research_package_jobs_publication BEFORE UPDATE ON research_package_jobs WHEN NEW.state='completed' AND OLD.state<>'completed' BEGIN
 SELECT RAISE(ABORT,'Package result requires its current verified publication transaction') WHERE OLD.state<>'running'
 OR NOT EXISTS(SELECT 1 FROM file_job_runtime_guard g JOIN file_authority_runtime_guard fg ON fg.singleton=g.singleton AND fg.enabled=1
 JOIN file_authority_control fc ON fc.singleton=g.singleton AND fc.mode='active' WHERE g.singleton=1 AND g.enabled=1 AND g.incarnation=OLD.runtime_incarnation)
 OR COALESCE(julianday(OLD.lease_expires_at),0)<=julianday('now') OR COALESCE(julianday(OLD.actor_checked_at),0)<julianday('now','-10 seconds')
 OR EXISTS(SELECT 1 FROM research_package_files f WHERE f.job_id=OLD.id AND f.entry_kind<>'source' AND(f.state<>'published' OR NOT EXISTS(
 SELECT 1 FROM file_usable_publications published JOIN file_location_publications l ON l.location_id=f.result_location_id
 WHERE published.file_id=f.result_file_id AND published.purpose=f.purpose AND published.access_scope='system'
 AND published.verified_byte_size=f.byte_size AND published.verified_sha256=f.sha256 AND l.file_id=f.result_file_id
 AND l.storage_profile_id=f.target_profile_id AND l.verified_byte_size=f.byte_size AND l.verified_sha256=f.sha256)))
 OR(OLD.kind='import' AND EXISTS(SELECT 1 FROM research_package_live_domain_rows expected WHERE expected.job_id=OLD.id AND NOT EXISTS(
 SELECT 1 FROM research_package_domain_rows_present actual WHERE actual.job_id=expected.job_id AND actual.table_name=expected.table_name AND actual.destination_id=expected.destination_id)))
 OR(OLD.kind='import' AND(SELECT count(*) FROM research_package_identity_maps WHERE job_id=OLD.id)<>json_array_length(OLD.domain_plan_json,'$.identities'));
END;
CREATE TRIGGER research_package_source_identity_update BEFORE UPDATE ON research_package_source_identity BEGIN SELECT RAISE(ABORT,'Source installation identity is immutable'); END;
CREATE TRIGGER research_package_source_identity_delete BEFORE DELETE ON research_package_source_identity BEGIN SELECT RAISE(ABORT,'Source installation identity is retained'); END;
