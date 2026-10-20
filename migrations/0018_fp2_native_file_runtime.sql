-- FP2 complete native File generation, paired with V21 recovery. Historical
-- rows, rowids, claims and observations are copied without capture-time writes.
-- Physical identities and accepted targets remain immutable. Local credentials
-- and tested installation bindings are excluded from portable content.
PRAGMA defer_foreign_keys=ON;

PRAGMA legacy_alter_table=ON;

CREATE TABLE storage_profile_activations(
 operation_id TEXT PRIMARY KEY NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 256),
 storage_profile_id TEXT NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
 configuration_revision INTEGER NOT NULL CHECK(configuration_revision=1),
 action TEXT NOT NULL CHECK(action IN('activate','retire')),
 candidate_profile_id TEXT NOT NULL CHECK(length(candidate_profile_id) BETWEEN 1 AND 256),
 candidate_revision INTEGER NOT NULL CHECK(typeof(candidate_revision)='integer' AND candidate_revision>0),
 envelope_revision INTEGER NOT NULL CHECK(typeof(envelope_revision)='integer' AND envelope_revision>0),
 check_id TEXT NOT NULL CHECK(length(check_id)=36),
 configuration_sha256 TEXT NOT NULL CHECK(length(configuration_sha256)=64 AND configuration_sha256 NOT GLOB '*[^0-9a-f]*'),
 namespace_sha256 TEXT NOT NULL CHECK(length(namespace_sha256)=64 AND namespace_sha256 NOT GLOB '*[^0-9a-f]*'),
 binding_revision INTEGER NOT NULL CHECK(typeof(binding_revision)='integer' AND binding_revision>0),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 254),
 created_at TEXT NOT NULL CHECK(created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',created_at))
);

CREATE INDEX storage_profile_activations_profile_history ON storage_profile_activations(storage_profile_id,created_at,operation_id);

CREATE TRIGGER storage_profile_activations_insert_guard BEFORE INSERT ON storage_profile_activations BEGIN
 SELECT RAISE(ABORT,'Native activation identity conflict') WHERE EXISTS(SELECT 1 FROM storage_profile_activations WHERE operation_id=NEW.operation_id);
 SELECT RAISE(ABORT,'Native activation binding revision is stale') WHERE NEW.action='activate' AND NEW.binding_revision<>
 COALESCE((SELECT max(binding_revision) FROM storage_profile_activations WHERE storage_profile_id=NEW.storage_profile_id AND action='activate'),0)+1;
 SELECT RAISE(ABORT,'Native activation requires its immutable namespace') WHERE NOT EXISTS(SELECT 1 FROM storage_profiles p
 WHERE p.id=NEW.storage_profile_id AND p.adapter_type='s3' AND p.configuration_source='system' AND p.configuration_revision=NEW.configuration_revision
 AND p.id='storage-profile:aws-s3:'||NEW.namespace_sha256 AND p.state='historical' AND p.credential_reference IS NULL);
END;

CREATE TRIGGER storage_profile_activations_update_guard BEFORE UPDATE ON storage_profile_activations BEGIN SELECT RAISE(ABORT,'Native activation history is immutable'); END;

CREATE TRIGGER storage_profile_activations_delete_guard BEFORE DELETE ON storage_profile_activations BEGIN SELECT RAISE(ABORT,'Native activation history is immutable'); END;

CREATE TABLE system_storage_native_bindings(
 storage_profile_id TEXT PRIMARY KEY NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
 candidate_profile_id TEXT NOT NULL REFERENCES system_storage_profiles(id) ON DELETE RESTRICT,
 candidate_revision INTEGER NOT NULL CHECK(typeof(candidate_revision)='integer' AND candidate_revision>0),
 credential_ref TEXT NOT NULL REFERENCES system_storage_credential_descriptors(credential_ref) ON DELETE RESTRICT,
 envelope_revision INTEGER NOT NULL CHECK(typeof(envelope_revision)='integer' AND envelope_revision>0),
 check_id TEXT NOT NULL REFERENCES system_storage_candidate_checks(id) ON DELETE RESTRICT,
 configuration_sha256 TEXT NOT NULL CHECK(length(configuration_sha256)=64 AND configuration_sha256 NOT GLOB '*[^0-9a-f]*'),
 namespace_sha256 TEXT NOT NULL CHECK(length(namespace_sha256)=64 AND namespace_sha256 NOT GLOB '*[^0-9a-f]*'),
 activation_operation_id TEXT NOT NULL REFERENCES storage_profile_activations(operation_id) ON DELETE RESTRICT,
 binding_revision INTEGER NOT NULL CHECK(typeof(binding_revision)='integer' AND binding_revision>0),
 created_at TEXT NOT NULL CHECK(created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',created_at)),
 updated_at TEXT NOT NULL CHECK(updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) AND updated_at>=created_at),
 FOREIGN KEY(candidate_profile_id,candidate_revision) REFERENCES system_storage_configuration_revisions(profile_id,revision) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TRIGGER system_storage_native_bindings_insert_guard BEFORE INSERT ON system_storage_native_bindings BEGIN
 SELECT RAISE(ABORT,'Native binding requires a fresh installation-local identity') WHERE NEW.created_at IS NOT NEW.updated_at
 OR EXISTS(SELECT 1 FROM system_storage_native_bindings WHERE storage_profile_id=NEW.storage_profile_id);
 SELECT RAISE(ABORT,'Native binding requires the exact current tested candidate') WHERE NOT EXISTS(SELECT 1 FROM storage_profiles p
 JOIN storage_profile_activations a ON a.operation_id=NEW.activation_operation_id AND a.action='activate' AND a.storage_profile_id=p.id
 JOIN system_storage_profiles candidate ON candidate.id=NEW.candidate_profile_id AND candidate.adapter_type='s3' AND candidate.latest_revision=NEW.candidate_revision
 JOIN system_storage_configuration_revisions r ON r.profile_id=candidate.id AND r.revision=NEW.candidate_revision AND r.credential_ref=NEW.credential_ref
 JOIN system_storage_credential_payloads e ON e.credential_ref=NEW.credential_ref AND e.envelope_revision=NEW.envelope_revision
 JOIN system_storage_candidate_checks c ON c.id=NEW.check_id AND c.profile_id=candidate.id AND c.configuration_revision=r.revision AND c.credential_ref=r.credential_ref
 WHERE p.id=NEW.storage_profile_id AND p.id='storage-profile:aws-s3:'||NEW.namespace_sha256 AND p.adapter_type='s3'
 AND a.candidate_profile_id=NEW.candidate_profile_id AND a.candidate_revision=NEW.candidate_revision AND a.check_id=NEW.check_id
 AND a.envelope_revision=NEW.envelope_revision AND a.configuration_sha256=NEW.configuration_sha256 AND a.namespace_sha256=NEW.namespace_sha256
 AND a.binding_revision=NEW.binding_revision
 AND a.binding_revision=(SELECT max(binding_revision) FROM storage_profile_activations WHERE storage_profile_id=NEW.storage_profile_id AND action='activate')
 AND json_extract(p.namespace_identity,'$.accountId') IS json_extract(r.namespace_json,'$.expectedBucketOwner')
 AND json_extract(p.namespace_identity,'$.bucketName') IS json_extract(r.namespace_json,'$.bucket')
 AND json_extract(p.namespace_identity,'$.root') IS json_extract(r.namespace_json,'$.root')
 AND c.namespace_json=r.namespace_json AND c.configuration_sha256=NEW.configuration_sha256
 AND c.envelope_revision=e.envelope_revision AND c.envelope_version=e.envelope_version AND c.key_id=e.key_id AND c.nonce=e.nonce AND c.ciphertext=e.ciphertext
 AND c.status='succeeded' AND c.write_outcome='acknowledged' AND c.read_outcome='verified' AND c.metadata_outcome='verified'
 AND c.delete_outcome='acknowledged' AND c.cleanup_outcome='confirmed_absent' AND c.result_code IS NULL); END;

CREATE TRIGGER system_storage_native_bindings_update_guard BEFORE UPDATE ON system_storage_native_bindings BEGIN
 SELECT RAISE(ABORT,'Native binding identity or revision conflict') WHERE NEW.storage_profile_id IS NOT OLD.storage_profile_id
 OR NEW.created_at IS NOT OLD.created_at OR NEW.binding_revision<>OLD.binding_revision+1 OR NEW.updated_at<OLD.updated_at;
 SELECT RAISE(ABORT,'Native binding requires the exact current tested candidate') WHERE NOT EXISTS(SELECT 1 FROM storage_profiles p
 JOIN storage_profile_activations a ON a.operation_id=NEW.activation_operation_id AND a.action='activate' AND a.storage_profile_id=p.id
 JOIN system_storage_profiles candidate ON candidate.id=NEW.candidate_profile_id AND candidate.adapter_type='s3' AND candidate.latest_revision=NEW.candidate_revision
 JOIN system_storage_configuration_revisions r ON r.profile_id=candidate.id AND r.revision=NEW.candidate_revision AND r.credential_ref=NEW.credential_ref
 JOIN system_storage_credential_payloads e ON e.credential_ref=NEW.credential_ref AND e.envelope_revision=NEW.envelope_revision
 JOIN system_storage_candidate_checks c ON c.id=NEW.check_id AND c.profile_id=candidate.id AND c.configuration_revision=r.revision AND c.credential_ref=r.credential_ref
 WHERE p.id=NEW.storage_profile_id AND p.id='storage-profile:aws-s3:'||NEW.namespace_sha256 AND p.adapter_type='s3'
 AND a.candidate_profile_id=NEW.candidate_profile_id AND a.candidate_revision=NEW.candidate_revision AND a.check_id=NEW.check_id
 AND a.envelope_revision=NEW.envelope_revision AND a.configuration_sha256=NEW.configuration_sha256 AND a.namespace_sha256=NEW.namespace_sha256
 AND a.binding_revision=NEW.binding_revision
 AND a.binding_revision=(SELECT max(binding_revision) FROM storage_profile_activations WHERE storage_profile_id=NEW.storage_profile_id AND action='activate')
 AND json_extract(p.namespace_identity,'$.accountId') IS json_extract(r.namespace_json,'$.expectedBucketOwner')
 AND json_extract(p.namespace_identity,'$.bucketName') IS json_extract(r.namespace_json,'$.bucket')
 AND json_extract(p.namespace_identity,'$.root') IS json_extract(r.namespace_json,'$.root')
 AND c.namespace_json=r.namespace_json AND c.configuration_sha256=NEW.configuration_sha256
 AND c.envelope_revision=e.envelope_revision AND c.envelope_version=e.envelope_version AND c.key_id=e.key_id AND c.nonce=e.nonce AND c.ciphertext=e.ciphertext
 AND c.status='succeeded' AND c.write_outcome='acknowledged' AND c.read_outcome='verified' AND c.metadata_outcome='verified'
 AND c.delete_outcome='acknowledged' AND c.cleanup_outcome='confirmed_absent' AND c.result_code IS NULL); END;

CREATE TRIGGER system_storage_native_bindings_delete_guard BEFORE DELETE ON system_storage_native_bindings BEGIN SELECT RAISE(ABORT,'Native binding history must be revoked explicitly'); END;

CREATE TABLE storage_role_policy_revisions(
 policy_revision INTEGER NOT NULL CHECK(typeof(policy_revision)='integer' AND policy_revision>=2),
 role TEXT NOT NULL CHECK(role IN('internal','originals')),
 storage_profile_id TEXT NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
 storage_profile_revision INTEGER NOT NULL CHECK(storage_profile_revision=1),
 operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 256), actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 254),
 created_at TEXT NOT NULL CHECK(created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',created_at)),
 PRIMARY KEY(policy_revision,role), UNIQUE(operation_id,role)
) WITHOUT ROWID;

INSERT INTO storage_role_policy_revisions(policy_revision,role,storage_profile_id,storage_profile_revision,operation_id,actor,created_at)
 SELECT policy_revision,role,storage_profile_id,storage_profile_revision,'storage-role-policy:legacy:2','bootstrap',created_at FROM storage_role_defaults;

CREATE TRIGGER storage_role_policy_revisions_update_guard BEFORE UPDATE ON storage_role_policy_revisions BEGIN SELECT RAISE(ABORT,'Accepted role selection history is immutable'); END;

CREATE TRIGGER storage_role_policy_revisions_delete_guard BEFORE DELETE ON storage_role_policy_revisions BEGIN SELECT RAISE(ABORT,'Accepted role selection history is immutable'); END;

CREATE TRIGGER storage_role_policy_revisions_insert_guard BEFORE INSERT ON storage_role_policy_revisions BEGIN
 SELECT RAISE(ABORT,'Role selection identity conflict') WHERE EXISTS(SELECT 1 FROM storage_role_policy_revisions WHERE policy_revision=NEW.policy_revision AND role=NEW.role);
 SELECT RAISE(ABORT,'Role selection requires active admitted target') WHERE NEW.policy_revision<3 OR NOT EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active')
 OR NOT EXISTS(SELECT 1 FROM storage_profiles p JOIN storage_profile_runtime r ON r.storage_profile_id=p.id
 WHERE p.id=NEW.storage_profile_id AND p.configuration_revision=NEW.storage_profile_revision AND r.state='read_write'
 AND ((p.adapter_type='r2' AND p.configuration_source='bootstrap') OR(p.adapter_type='s3' AND p.configuration_source='system'
 AND EXISTS(SELECT 1 FROM system_storage_native_bindings b WHERE b.storage_profile_id=p.id))));
 SELECT RAISE(ABORT,'Role selection revision is stale') WHERE EXISTS(SELECT 1 FROM storage_role_policy_revisions x WHERE x.policy_revision>NEW.policy_revision);
END;

CREATE TABLE assets_native_next (
  id TEXT PRIMARY KEY,
  import_id TEXT REFERENCES imports(id) ON DELETE SET NULL,
  r2_key TEXT UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  sha256 TEXT,
  actor_email TEXT,
  created_at TEXT NOT NULL
,
file_id TEXT REFERENCES files(id) ON DELETE RESTRICT,
storage_profile_id TEXT REFERENCES storage_profiles(id) ON DELETE RESTRICT,
storage_profile_revision INTEGER CHECK(storage_profile_revision IS NULL OR storage_profile_revision=1),
object_key TEXT CHECK(object_key IS NULL OR length(object_key) BETWEEN 1 AND 4096 AND instr(object_key,char(0))=0),
CHECK((r2_key IS NOT NULL AND file_id IS NULL AND storage_profile_id IS NULL AND storage_profile_revision IS NULL AND object_key IS NULL)
 OR(r2_key IS NULL AND file_id IS NOT NULL AND storage_profile_id IS NOT NULL AND storage_profile_revision=1 AND object_key IS NOT NULL))
);

INSERT INTO assets_native_next(rowid,id,import_id,r2_key,original_name,mime_type,byte_size,status,sha256,actor_email,created_at) SELECT rowid,id,import_id,r2_key,original_name,mime_type,byte_size,status,sha256,actor_email,created_at FROM assets;

DROP TABLE assets;

ALTER TABLE assets_native_next RENAME TO assets;

CREATE INDEX assets_import_idx ON assets(import_id);

CREATE INDEX assets_sha256_lookup_idx
ON assets(sha256, status)
WHERE sha256 IS NOT NULL;

CREATE INDEX file_shadow_dependency_assets_key_idx ON assets(json_array( CASE WHEN typeof(id)='blob' THEN json_object('$sqliteBlob',hex(id)) ELSE id END ));

CREATE TRIGGER assets_reject_live_sha_duplicate
BEFORE INSERT ON assets
WHEN ((NEW.sha256 IS NOT NULL AND (
  (
    NEW.import_id IS NULL AND NEW.status = 'ready'
    AND EXISTS (
      SELECT 1 FROM assets a
      WHERE a.sha256 = NEW.sha256 AND a.status = 'ready'
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
    )
  ) OR (
    NEW.import_id IS NOT NULL AND NEW.status IN ('pending', 'ready')
    AND EXISTS (
      SELECT 1 FROM assets a
      WHERE a.sha256 = NEW.sha256 AND a.status IN ('pending', 'ready')
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
    )
  )
)
) AND NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS(SELECT 1 FROM file_authority_ready_candidate_aliases c
 WHERE c.adapter_type='r2' AND c.result_object_key=NEW.r2_key AND c.expected_sha256=NEW.sha256
 AND c.expected_byte_size=NEW.byte_size AND NEW.status IN('pending','ready')
 AND ((c.acceptance_kind='import_file' AND NEW.import_id=c.acceptance_id)
   OR (c.acceptance_kind<>'import_file' AND NEW.import_id IS NULL AND c.alias_id=NEW.id))))) AND (NEW.r2_key IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live asset sha256 already registered');
END;

CREATE TRIGGER assets_reject_live_sha_duplicate_update
BEFORE UPDATE OF sha256, status, r2_key, import_id ON assets
WHEN ((NEW.sha256 IS NOT NULL AND (
  (
    NEW.import_id IS NULL AND NEW.status = 'ready'
    AND EXISTS (
      SELECT 1 FROM assets a
      WHERE a.id <> OLD.id AND a.sha256 = NEW.sha256
        AND a.status = 'ready'
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
    )
  ) OR (
    NEW.import_id IS NOT NULL AND NEW.status IN ('pending', 'ready')
    AND EXISTS (
      SELECT 1 FROM assets a
      WHERE a.id <> OLD.id AND a.sha256 = NEW.sha256
        AND a.status IN ('pending', 'ready')
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
    )
  )
)
) AND NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS(SELECT 1 FROM file_authority_ready_candidate_aliases c
 WHERE c.adapter_type='r2' AND c.result_object_key=NEW.r2_key AND c.expected_sha256=NEW.sha256
 AND c.expected_byte_size=NEW.byte_size AND NEW.status IN('pending','ready')
 AND ((c.acceptance_kind='import_file' AND NEW.import_id=c.acceptance_id)
   OR (c.acceptance_kind<>'import_file' AND NEW.import_id IS NULL AND c.alias_id=NEW.id))))) AND (NEW.r2_key IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live asset sha256 already registered');
END;

CREATE TRIGGER assets_reject_pending_import_sha_publication_insert
BEFORE INSERT ON assets
WHEN ((NEW.import_id IS NULL
  AND NEW.status IN ('pending', 'ready')
  AND NEW.sha256 IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM assets staged
    JOIN imports owner ON owner.id = staged.import_id
    WHERE staged.sha256 = NEW.sha256
      AND staged.status IN ('pending', 'ready')
      AND owner.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = staged.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = staged.r2_key
      )
  )
) AND NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS(SELECT 1 FROM file_authority_ready_candidate_aliases c
 WHERE c.adapter_type='r2' AND c.result_object_key=NEW.r2_key AND c.expected_sha256=NEW.sha256
 AND c.expected_byte_size=NEW.byte_size AND NEW.status IN('pending','ready')
 AND ((c.acceptance_kind='import_file' AND NEW.import_id=c.acceptance_id)
   OR (c.acceptance_kind<>'import_file' AND NEW.import_id IS NULL AND c.alias_id=NEW.id))))) AND (NEW.r2_key IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'matching asset is owned by a pending import');
END;

CREATE TRIGGER assets_reject_pending_import_sha_publication_update
BEFORE UPDATE OF status, sha256, import_id ON assets
WHEN ((NEW.import_id IS NULL
  AND NEW.status IN ('pending', 'ready')
  AND NEW.sha256 IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM assets staged
    JOIN imports owner ON owner.id = staged.import_id
    WHERE staged.id <> OLD.id
      AND staged.sha256 = NEW.sha256
      AND staged.status IN ('pending', 'ready')
      AND owner.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = staged.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = staged.r2_key
      )
  )
) AND NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS(SELECT 1 FROM file_authority_ready_candidate_aliases c
 WHERE c.adapter_type='r2' AND c.result_object_key=NEW.r2_key AND c.expected_sha256=NEW.sha256
 AND c.expected_byte_size=NEW.byte_size AND NEW.status IN('pending','ready')
 AND ((c.acceptance_kind='import_file' AND NEW.import_id=c.acceptance_id)
   OR (c.acceptance_kind<>'import_file' AND NEW.import_id IS NULL AND c.alias_id=NEW.id))))) AND (NEW.r2_key IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'matching asset is owned by a pending import');
END;

CREATE TRIGGER file_shadow_epoch_assets_delete AFTER DELETE ON assets BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1; INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT 'assets',json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ),COALESCE((SELECT MAX(v.revision) FROM file_shadow_dependency_versions v WHERE v.dependency_kind='assets' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )),0)+1,1,json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'import_id', CASE WHEN typeof(x.import_id)='blob' THEN json_object('$sqliteBlob',hex(x.import_id)) ELSE x.import_id END ,'r2_key', CASE WHEN typeof(x.r2_key)='blob' THEN json_object('$sqliteBlob',hex(x.r2_key)) ELSE x.r2_key END ,'status', CASE WHEN typeof(x.status)='blob' THEN json_object('$sqliteBlob',hex(x.status)) ELSE x.status END ,'sha256', CASE WHEN typeof(x.sha256)='blob' THEN json_object('$sqliteBlob',hex(x.sha256)) ELSE x.sha256 END ,'byte_size', CASE WHEN typeof(x.byte_size)='blob' THEN json_object('$sqliteBlob',hex(x.byte_size)) ELSE x.byte_size END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END )
  FROM assets x WHERE NOT EXISTS(SELECT 1 FROM file_shadow_dependency_versions v WHERE v.dependency_kind='assets' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ) AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key) AND v.present=1 AND v.snapshot_json IS json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'import_id', CASE WHEN typeof(x.import_id)='blob' THEN json_object('$sqliteBlob',hex(x.import_id)) ELSE x.import_id END ,'r2_key', CASE WHEN typeof(x.r2_key)='blob' THEN json_object('$sqliteBlob',hex(x.r2_key)) ELSE x.r2_key END ,'status', CASE WHEN typeof(x.status)='blob' THEN json_object('$sqliteBlob',hex(x.status)) ELSE x.status END ,'sha256', CASE WHEN typeof(x.sha256)='blob' THEN json_object('$sqliteBlob',hex(x.sha256)) ELSE x.sha256 END ,'byte_size', CASE WHEN typeof(x.byte_size)='blob' THEN json_object('$sqliteBlob',hex(x.byte_size)) ELSE x.byte_size END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END ));
  INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT v.dependency_kind,v.dependency_key,v.revision+1,0,'null' FROM file_shadow_dependency_versions v
  WHERE v.dependency_kind='assets' AND v.present=1 AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key)
  AND NOT EXISTS(SELECT 1 FROM assets x WHERE json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )=v.dependency_key); INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),s.consumer_kind,s.consumer_id,s.consumer_sub_id,s.file_slot,COALESCE(h.generation,0)+1,1,s.source_rowid,s.source_json,s.legacy_store_kind,s.legacy_provider,s.legacy_object_key,s.expected_purpose,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (WITH current_sources AS MATERIALIZED (SELECT * FROM file_shadow_sources) SELECT * FROM current_sources) s LEFT JOIN file_shadow_heads h ON h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot WHERE (1=1) AND (h.occurrence_id IS NULL OR h.present<>1 OR h.source_rowid IS NOT s.source_rowid OR h.source_json IS NOT s.source_json OR (0));
    INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),h.consumer_kind,h.consumer_id,h.consumer_sub_id,h.file_slot,h.generation+1,0,NULL,'{}',NULL,NULL,NULL,NULL,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM file_shadow_heads h WHERE h.present=1 AND (1=1) AND NOT EXISTS(SELECT 1 FROM file_shadow_source_keys s WHERE h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot);
    INSERT INTO file_shadow_closures(occurrence_id,successor_occurrence_id,closed_epoch,closed_at)
    SELECT h.occurrence_id,o.id,o.observed_epoch,o.observed_at FROM file_shadow_occurrences o JOIN file_shadow_heads h ON h.consumer_kind IS o.consumer_kind AND h.consumer_id IS o.consumer_id AND h.consumer_sub_id IS o.consumer_sub_id AND h.file_slot IS o.file_slot AND o.generation=h.generation+1
    WHERE o.observed_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1);
    INSERT INTO file_shadow_heads(consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,occurrence_id,present,source_rowid,source_json,observed_epoch)
    SELECT o.consumer_kind,o.consumer_id,o.consumer_sub_id,o.file_slot,o.generation,o.id,o.present,o.source_rowid,o.source_json,o.observed_epoch FROM file_shadow_occurrences o
    WHERE o.observed_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1) AND NOT EXISTS(SELECT 1 FROM file_shadow_closures c WHERE c.occurrence_id=o.id)
    ON CONFLICT(consumer_kind,consumer_id,consumer_sub_id,file_slot) DO UPDATE SET generation=excluded.generation,occurrence_id=excluded.occurrence_id,present=excluded.present,source_rowid=excluded.source_rowid,source_json=excluded.source_json,observed_epoch=excluded.observed_epoch
    WHERE file_shadow_heads.generation<excluded.generation; END;

CREATE TRIGGER file_shadow_epoch_assets_insert AFTER INSERT ON assets BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1; INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT 'assets',json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ),COALESCE((SELECT MAX(v.revision) FROM file_shadow_dependency_versions v WHERE v.dependency_kind='assets' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )),0)+1,1,json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'import_id', CASE WHEN typeof(x.import_id)='blob' THEN json_object('$sqliteBlob',hex(x.import_id)) ELSE x.import_id END ,'r2_key', CASE WHEN typeof(x.r2_key)='blob' THEN json_object('$sqliteBlob',hex(x.r2_key)) ELSE x.r2_key END ,'status', CASE WHEN typeof(x.status)='blob' THEN json_object('$sqliteBlob',hex(x.status)) ELSE x.status END ,'sha256', CASE WHEN typeof(x.sha256)='blob' THEN json_object('$sqliteBlob',hex(x.sha256)) ELSE x.sha256 END ,'byte_size', CASE WHEN typeof(x.byte_size)='blob' THEN json_object('$sqliteBlob',hex(x.byte_size)) ELSE x.byte_size END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END )
  FROM assets x WHERE NOT EXISTS(SELECT 1 FROM file_shadow_dependency_versions v WHERE v.dependency_kind='assets' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ) AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key) AND v.present=1 AND v.snapshot_json IS json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'import_id', CASE WHEN typeof(x.import_id)='blob' THEN json_object('$sqliteBlob',hex(x.import_id)) ELSE x.import_id END ,'r2_key', CASE WHEN typeof(x.r2_key)='blob' THEN json_object('$sqliteBlob',hex(x.r2_key)) ELSE x.r2_key END ,'status', CASE WHEN typeof(x.status)='blob' THEN json_object('$sqliteBlob',hex(x.status)) ELSE x.status END ,'sha256', CASE WHEN typeof(x.sha256)='blob' THEN json_object('$sqliteBlob',hex(x.sha256)) ELSE x.sha256 END ,'byte_size', CASE WHEN typeof(x.byte_size)='blob' THEN json_object('$sqliteBlob',hex(x.byte_size)) ELSE x.byte_size END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END ));
  INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT v.dependency_kind,v.dependency_key,v.revision+1,0,'null' FROM file_shadow_dependency_versions v
  WHERE v.dependency_kind='assets' AND v.present=1 AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key)
  AND NOT EXISTS(SELECT 1 FROM assets x WHERE json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )=v.dependency_key); INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),s.consumer_kind,s.consumer_id,s.consumer_sub_id,s.file_slot,COALESCE(h.generation,0)+1,1,s.source_rowid,s.source_json,s.legacy_store_kind,s.legacy_provider,s.legacy_object_key,s.expected_purpose,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (WITH current_sources AS MATERIALIZED (SELECT * FROM file_shadow_sources) SELECT * FROM current_sources) s LEFT JOIN file_shadow_heads h ON h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot WHERE (1=1) AND (h.occurrence_id IS NULL OR h.present<>1 OR h.source_rowid IS NOT s.source_rowid OR h.source_json IS NOT s.source_json OR (0));
    INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),h.consumer_kind,h.consumer_id,h.consumer_sub_id,h.file_slot,h.generation+1,0,NULL,'{}',NULL,NULL,NULL,NULL,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM file_shadow_heads h WHERE h.present=1 AND (1=1) AND NOT EXISTS(SELECT 1 FROM file_shadow_source_keys s WHERE h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot);
    INSERT INTO file_shadow_closures(occurrence_id,successor_occurrence_id,closed_epoch,closed_at)
    SELECT h.occurrence_id,o.id,o.observed_epoch,o.observed_at FROM file_shadow_occurrences o JOIN file_shadow_heads h ON h.consumer_kind IS o.consumer_kind AND h.consumer_id IS o.consumer_id AND h.consumer_sub_id IS o.consumer_sub_id AND h.file_slot IS o.file_slot AND o.generation=h.generation+1
    WHERE o.observed_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1);
    INSERT INTO file_shadow_heads(consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,occurrence_id,present,source_rowid,source_json,observed_epoch)
    SELECT o.consumer_kind,o.consumer_id,o.consumer_sub_id,o.file_slot,o.generation,o.id,o.present,o.source_rowid,o.source_json,o.observed_epoch FROM file_shadow_occurrences o
    WHERE o.observed_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1) AND NOT EXISTS(SELECT 1 FROM file_shadow_closures c WHERE c.occurrence_id=o.id)
    ON CONFLICT(consumer_kind,consumer_id,consumer_sub_id,file_slot) DO UPDATE SET generation=excluded.generation,occurrence_id=excluded.occurrence_id,present=excluded.present,source_rowid=excluded.source_rowid,source_json=excluded.source_json,observed_epoch=excluded.observed_epoch
    WHERE file_shadow_heads.generation<excluded.generation; END;

CREATE TRIGGER file_shadow_epoch_assets_update AFTER UPDATE ON assets BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1; INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT 'assets',json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ),COALESCE((SELECT MAX(v.revision) FROM file_shadow_dependency_versions v WHERE v.dependency_kind='assets' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )),0)+1,1,json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'import_id', CASE WHEN typeof(x.import_id)='blob' THEN json_object('$sqliteBlob',hex(x.import_id)) ELSE x.import_id END ,'r2_key', CASE WHEN typeof(x.r2_key)='blob' THEN json_object('$sqliteBlob',hex(x.r2_key)) ELSE x.r2_key END ,'status', CASE WHEN typeof(x.status)='blob' THEN json_object('$sqliteBlob',hex(x.status)) ELSE x.status END ,'sha256', CASE WHEN typeof(x.sha256)='blob' THEN json_object('$sqliteBlob',hex(x.sha256)) ELSE x.sha256 END ,'byte_size', CASE WHEN typeof(x.byte_size)='blob' THEN json_object('$sqliteBlob',hex(x.byte_size)) ELSE x.byte_size END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END )
  FROM assets x WHERE NOT EXISTS(SELECT 1 FROM file_shadow_dependency_versions v WHERE v.dependency_kind='assets' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ) AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key) AND v.present=1 AND v.snapshot_json IS json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'import_id', CASE WHEN typeof(x.import_id)='blob' THEN json_object('$sqliteBlob',hex(x.import_id)) ELSE x.import_id END ,'r2_key', CASE WHEN typeof(x.r2_key)='blob' THEN json_object('$sqliteBlob',hex(x.r2_key)) ELSE x.r2_key END ,'status', CASE WHEN typeof(x.status)='blob' THEN json_object('$sqliteBlob',hex(x.status)) ELSE x.status END ,'sha256', CASE WHEN typeof(x.sha256)='blob' THEN json_object('$sqliteBlob',hex(x.sha256)) ELSE x.sha256 END ,'byte_size', CASE WHEN typeof(x.byte_size)='blob' THEN json_object('$sqliteBlob',hex(x.byte_size)) ELSE x.byte_size END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END ));
  INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT v.dependency_kind,v.dependency_key,v.revision+1,0,'null' FROM file_shadow_dependency_versions v
  WHERE v.dependency_kind='assets' AND v.present=1 AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key)
  AND NOT EXISTS(SELECT 1 FROM assets x WHERE json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )=v.dependency_key); INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),s.consumer_kind,s.consumer_id,s.consumer_sub_id,s.file_slot,COALESCE(h.generation,0)+1,1,s.source_rowid,s.source_json,s.legacy_store_kind,s.legacy_provider,s.legacy_object_key,s.expected_purpose,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (WITH current_sources AS MATERIALIZED (SELECT * FROM file_shadow_sources) SELECT * FROM current_sources) s LEFT JOIN file_shadow_heads h ON h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot WHERE (1=1) AND (h.occurrence_id IS NULL OR h.present<>1 OR h.source_rowid IS NOT s.source_rowid OR h.source_json IS NOT s.source_json OR (0));
    INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),h.consumer_kind,h.consumer_id,h.consumer_sub_id,h.file_slot,h.generation+1,0,NULL,'{}',NULL,NULL,NULL,NULL,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM file_shadow_heads h WHERE h.present=1 AND (1=1) AND NOT EXISTS(SELECT 1 FROM file_shadow_source_keys s WHERE h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot);
    INSERT INTO file_shadow_closures(occurrence_id,successor_occurrence_id,closed_epoch,closed_at)
    SELECT h.occurrence_id,o.id,o.observed_epoch,o.observed_at FROM file_shadow_occurrences o JOIN file_shadow_heads h ON h.consumer_kind IS o.consumer_kind AND h.consumer_id IS o.consumer_id AND h.consumer_sub_id IS o.consumer_sub_id AND h.file_slot IS o.file_slot AND o.generation=h.generation+1
    WHERE o.observed_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1);
    INSERT INTO file_shadow_heads(consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,occurrence_id,present,source_rowid,source_json,observed_epoch)
    SELECT o.consumer_kind,o.consumer_id,o.consumer_sub_id,o.file_slot,o.generation,o.id,o.present,o.source_rowid,o.source_json,o.observed_epoch FROM file_shadow_occurrences o
    WHERE o.observed_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1) AND NOT EXISTS(SELECT 1 FROM file_shadow_closures c WHERE c.occurrence_id=o.id)
    ON CONFLICT(consumer_kind,consumer_id,consumer_sub_id,file_slot) DO UPDATE SET generation=excluded.generation,occurrence_id=excluded.occurrence_id,present=excluded.present,source_rowid=excluded.source_rowid,source_json=excluded.source_json,observed_epoch=excluded.observed_epoch
    WHERE file_shadow_heads.generation<excluded.generation; END;

CREATE UNIQUE INDEX assets_native_file_alias ON assets(storage_profile_id,object_key) WHERE r2_key IS NULL;

CREATE INDEX assets_file_id_idx ON assets(file_id) WHERE file_id IS NOT NULL;

CREATE TABLE comment_submission_acceptances_native_next (
  submission_id TEXT PRIMARY KEY NOT NULL,
  actor_email TEXT NOT NULL CHECK (typeof(actor_email) = 'text' AND length(actor_email) BETWEEN 1 AND 256 AND instr(actor_email, char(0)) = 0),
  operation_id TEXT NOT NULL UNIQUE,
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  request_input_json TEXT NOT NULL CHECK (length(CAST(request_input_json AS BLOB)) <= 524288 AND CASE WHEN json_valid(request_input_json) THEN json_type(request_input_json) = 'object' ELSE 0 END ),
  publication_plan_json TEXT NOT NULL CHECK (length(CAST(publication_plan_json AS BLOB)) <= 32768 AND CASE WHEN json_valid(publication_plan_json) THEN json_type(publication_plan_json) = 'object' ELSE 0 END ),
  request_scope TEXT NOT NULL CHECK (request_scope = 'system'),
  storage_policy_revision INTEGER NOT NULL CHECK (typeof(storage_policy_revision) = 'integer' AND storage_policy_revision = 1),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'cancelled')),
  accepted_result_json TEXT CHECK (accepted_result_json IS NULL OR (length(CAST(accepted_result_json AS BLOB)) <= 32768 AND CASE WHEN json_valid(accepted_result_json) THEN json_type(accepted_result_json) = 'object' ELSE 0 END )),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  completed_at TEXT CHECK (completed_at IS NULL OR (completed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) AND completed_at >= created_at)),
  expires_at TEXT NOT NULL CHECK (expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+7 days')), storage_role_policy_revision INTEGER NOT NULL DEFAULT 1
  CHECK(typeof(storage_role_policy_revision)='integer' AND storage_role_policy_revision IN(1,2,3)),
role_selection_revision INTEGER CHECK(role_selection_revision IS NULL OR typeof(role_selection_revision)='integer' AND role_selection_revision>=3),
CHECK((storage_role_policy_revision IN(1,2) AND role_selection_revision IS NULL) OR(storage_role_policy_revision=3 AND role_selection_revision IS NOT NULL)),
  CHECK ((status = 'pending' AND completed_at IS NULL AND accepted_result_json IS NULL)
    OR (status = 'ready' AND completed_at IS NOT NULL AND completed_at < expires_at AND accepted_result_json IS NOT NULL)
    OR (status = 'cancelled' AND completed_at IS NOT NULL AND accepted_result_json IS NULL))
);

INSERT INTO comment_submission_acceptances_native_next(rowid,submission_id,actor_email,operation_id,request_sha256,request_input_json,publication_plan_json,request_scope,storage_policy_revision,status,accepted_result_json,created_at,completed_at,expires_at,storage_role_policy_revision) SELECT rowid,submission_id,actor_email,operation_id,request_sha256,request_input_json,publication_plan_json,request_scope,storage_policy_revision,status,accepted_result_json,created_at,completed_at,expires_at,storage_role_policy_revision FROM comment_submission_acceptances;

DROP TABLE comment_submission_acceptances;

ALTER TABLE comment_submission_acceptances_native_next RENAME TO comment_submission_acceptances;

CREATE INDEX file_shadow_dependency_comment_submission_acceptances_key_idx ON comment_submission_acceptances(json_array( CASE WHEN typeof(submission_id)='blob' THEN json_object('$sqliteBlob',hex(submission_id)) ELSE submission_id END ));

CREATE TRIGGER comment_submission_acceptances_delete_guard BEFORE DELETE ON comment_submission_acceptances BEGIN
  SELECT RAISE(ABORT, 'Accepted Comment identity cannot be deleted');
END;

CREATE TRIGGER comment_submission_acceptances_insert_guard BEFORE INSERT ON comment_submission_acceptances
BEGIN
  SELECT CASE WHEN (SELECT count(DISTINCT key) FROM json_each(NEW.request_input_json))<>5
    OR EXISTS(SELECT 1 FROM json_each(NEW.request_input_json) WHERE key NOT IN('protocol','id','body','context','items'))
    OR json_type(NEW.request_input_json,'$.context') IS NOT 'object'
    OR (SELECT count(*) FROM json_each(NEW.request_input_json,'$.context'))<>3
    OR (SELECT count(DISTINCT key) FROM json_each(NEW.request_input_json,'$.context'))<>3
    OR NOT (json_extract(NEW.request_input_json,'$.context.kind') IS 'sample' OR json_extract(NEW.request_input_json,'$.context.kind') IS 'run_steps')
    OR (json_extract(NEW.request_input_json,'$.context.kind')='sample' AND (
      EXISTS(SELECT 1 FROM json_each(NEW.request_input_json,'$.context') WHERE key NOT IN('kind','sampleId','expectedUpdatedAt'))
      OR json_type(NEW.request_input_json,'$.context.sampleId') IS NOT 'text' OR length(json_extract(NEW.request_input_json,'$.context.sampleId')) NOT BETWEEN 1 AND 200 OR instr(json_extract(NEW.request_input_json,'$.context.sampleId'),char(0))<>0
      OR json_type(NEW.request_input_json,'$.context.expectedUpdatedAt') IS NOT 'text' OR length(json_extract(NEW.request_input_json,'$.context.expectedUpdatedAt')) NOT BETWEEN 1 AND 200 OR instr(json_extract(NEW.request_input_json,'$.context.expectedUpdatedAt'),char(0))<>0
      OR NOT EXISTS(SELECT 1 FROM samples WHERE id=json_extract(NEW.request_input_json,'$.context.sampleId') AND updated_at=json_extract(NEW.request_input_json,'$.context.expectedUpdatedAt') AND deleted_at IS NULL)))
    OR (json_extract(NEW.request_input_json,'$.context.kind')='run_steps' AND (
      EXISTS(SELECT 1 FROM json_each(NEW.request_input_json,'$.context') WHERE key NOT IN('kind','scope','targets'))
      OR NOT(json_extract(NEW.request_input_json,'$.context.scope') IS 'common' OR json_extract(NEW.request_input_json,'$.context.scope') IS 'individual')
      OR json_type(NEW.request_input_json,'$.context.targets') IS NOT 'array' OR json_array_length(NEW.request_input_json,'$.context.targets') NOT BETWEEN 1 AND 12
      OR (json_extract(NEW.request_input_json,'$.context.scope')='individual' AND json_array_length(NEW.request_input_json,'$.context.targets')<>1)
      OR EXISTS(SELECT 1 FROM json_each(NEW.request_input_json,'$.context.targets') target WHERE json_type(target.value) IS NOT 'object'
        OR (SELECT count(*) FROM json_each(target.value))<>4 OR (SELECT count(DISTINCT key) FROM json_each(target.value))<>4
        OR EXISTS(SELECT 1 FROM json_each(target.value) WHERE key NOT IN('sampleId','runId','stepId','expectedUpdatedAt') OR type<>'text' OR length(value) NOT BETWEEN 1 AND 200 OR instr(value,char(0))<>0))
      OR (SELECT count(DISTINCT json_extract(value,'$.stepId')) FROM json_each(NEW.request_input_json,'$.context.targets'))<>json_array_length(NEW.request_input_json,'$.context.targets')))
    OR EXISTS(SELECT 1 FROM json_each(NEW.request_input_json,'$.items') item WHERE json_type(item.value) IS NOT 'object'
      OR (SELECT count(*) FROM json_each(item.value))<>(SELECT count(DISTINCT key) FROM json_each(item.value))
      OR (json_extract(item.value,'$.kind')='comment_image' AND ((SELECT count(*) FROM json_each(item.value)) NOT BETWEEN 9 AND 10
        OR EXISTS(SELECT 1 FROM json_each(item.value) WHERE key NOT IN('id','kind','filename','mimeType','byteSize','originalFilename','originalMimeType','originalByteSize','relatedAttachmentId','sha256'))))
      OR (json_extract(item.value,'$.kind')='attachment' AND ((SELECT count(*) FROM json_each(item.value)) NOT BETWEEN 6 AND 8
        OR EXISTS(SELECT 1 FROM json_each(item.value) WHERE key NOT IN('id','kind','filename','mimeType','byteSize','title','relatedCommentImageId','sha256'))))
      OR (json_extract(item.value,'$.kind')='link' AND ((SELECT count(*) FROM json_each(item.value)) NOT BETWEEN 4 AND 5
        OR EXISTS(SELECT 1 FROM json_each(item.value) WHERE key NOT IN('id','kind','title','url','description')))))
    THEN RAISE(ABORT,'Invalid Comment acceptance input shape') END ;
  SELECT CASE WHEN typeof(NEW.submission_id)<>'text' OR length(NEW.submission_id) NOT BETWEEN 8 AND 80 OR NEW.submission_id GLOB '*[^a-zA-Z0-9_-]*' OR instr(NEW.submission_id,char(0))<>0
    OR typeof(NEW.request_sha256)<>'text' OR instr(NEW.request_sha256,char(0))<>0
    OR EXISTS(SELECT 1 FROM (SELECT NEW.operation_id AS value UNION ALL SELECT json_extract(NEW.publication_plan_json,'$.mutationId')
      UNION ALL SELECT json_extract(NEW.publication_plan_json,'$.operationGroupId') WHERE json_type(NEW.publication_plan_json,'$.operationGroupId')<>'null'
      UNION ALL SELECT json_extract(value,'$.id') FROM json_each(NEW.publication_plan_json,'$.occurrences')
      UNION ALL SELECT json_extract(value,'$.id') FROM json_each(NEW.publication_plan_json,'$.events'))
      WHERE value IS NULL OR typeof(value)<>'text' OR length(value)<>36 OR instr(value,char(0))<>0 OR value<>lower(value)
        OR substr(value,9,1)<>'-' OR substr(value,14,1)<>'-' OR substr(value,19,1)<>'-' OR substr(value,24,1)<>'-'
        OR length(replace(value,'-',''))<>32 OR replace(value,'-','') GLOB '*[^0-9a-f]*' OR substr(value,15,1)<>'4' OR substr(value,20,1) NOT GLOB '[89ab]')
    OR json_type(NEW.request_input_json,'$.body') IS NOT 'text' OR instr(json_extract(NEW.request_input_json,'$.body'),char(0))<>0
    OR (SELECT count(*) FROM json_each(NEW.publication_plan_json))<>5
    OR (SELECT count(DISTINCT key) FROM json_each(NEW.publication_plan_json))<>5
    OR json_type(NEW.publication_plan_json,'$.operationGroupId') IS NULL
    OR json_array_length(NEW.publication_plan_json,'$.events') NOT BETWEEN 1 AND 12
    OR json_array_length(NEW.publication_plan_json,'$.occurrences')<> CASE WHEN json_extract(NEW.request_input_json,'$.context.kind')='run_steps' THEN json_array_length(NEW.request_input_json,'$.context.targets') ELSE 0 END
    OR (json_type(NEW.publication_plan_json,'$.operationGroupId')='null')<>(json_array_length(NEW.publication_plan_json,'$.occurrences')<=1)
    OR EXISTS(SELECT 1 FROM json_each(NEW.publication_plan_json,'$.occurrences') x WHERE (SELECT count(*) FROM json_each(x.value))<>2 OR json_type(x.value,'$.targetIndex') IS NOT 'integer' OR json_extract(x.value,'$.targetIndex')<>x.key)
    OR (SELECT count(DISTINCT json_extract(value,'$.id')) FROM json_each(NEW.publication_plan_json,'$.occurrences'))<>json_array_length(NEW.publication_plan_json,'$.occurrences')
    OR (SELECT count(DISTINCT json_extract(value,'$.id')) FROM json_each(NEW.publication_plan_json,'$.events'))<>json_array_length(NEW.publication_plan_json,'$.events')
    OR (SELECT count(DISTINCT json_extract(value,'$.sampleId')) FROM json_each(NEW.publication_plan_json,'$.events'))<>json_array_length(NEW.publication_plan_json,'$.events')
    OR (SELECT count(DISTINCT value) FROM (SELECT json_extract(value,'$.id') value FROM json_each(NEW.publication_plan_json,'$.occurrences') UNION ALL SELECT json_extract(value,'$.id') FROM json_each(NEW.publication_plan_json,'$.events')))<>json_array_length(NEW.publication_plan_json,'$.occurrences')+json_array_length(NEW.publication_plan_json,'$.events')
    OR (json_extract(NEW.request_input_json,'$.context.kind')='sample' AND (json_array_length(NEW.publication_plan_json,'$.events')<>1 OR json_extract(NEW.publication_plan_json,'$.events[0].sampleId') IS NOT json_extract(NEW.request_input_json,'$.context.sampleId')))
    OR (json_extract(NEW.request_input_json,'$.context.kind')='run_steps' AND (
      json_array_length(NEW.publication_plan_json,'$.events')<>(SELECT count(DISTINCT json_extract(value,'$.sampleId')) FROM json_each(NEW.request_input_json,'$.context.targets'))
      OR EXISTS(SELECT 1 FROM json_each(NEW.publication_plan_json,'$.events') event WHERE NOT EXISTS(SELECT 1 FROM json_each(NEW.request_input_json,'$.context.targets') target WHERE json_extract(target.value,'$.sampleId')=json_extract(event.value,'$.sampleId'))
        OR event.key<>(SELECT count(DISTINCT json_extract(previous.value,'$.sampleId')) FROM json_each(NEW.request_input_json,'$.context.targets') previous WHERE previous.key<(
          SELECT min(target.key) FROM json_each(NEW.request_input_json,'$.context.targets') target WHERE json_extract(target.value,'$.sampleId')=json_extract(event.value,'$.sampleId'))))))
    OR EXISTS(SELECT 1 FROM json_each(NEW.publication_plan_json,'$.events') x WHERE (SELECT count(*) FROM json_each(x.value))<>2
      OR json_type(x.value,'$.sampleId') IS NOT 'text' OR NOT EXISTS(SELECT 1 FROM samples WHERE id=json_extract(x.value,'$.sampleId') AND deleted_at IS NULL))
    THEN RAISE(ABORT,'Invalid Comment acceptance identity or plan') END ;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.request_input_json,'$.items') item
    LEFT JOIN comment_submission_items csi ON csi.id=json_extract(item.value,'$.id') AND csi.submission_id=NEW.submission_id
    WHERE csi.id IS NULL OR csi.position IS NOT item.key OR csi.kind IS NOT json_extract(item.value,'$.kind')
      OR json_type(item.value,'$.id') IS NOT 'text' OR json_type(item.value,'$.kind') IS NOT 'text'
      OR (csi.kind<>'link' AND (json_type(item.value,'$.filename') IS NOT 'text' OR json_type(item.value,'$.mimeType') IS NOT 'text' OR json_type(item.value,'$.byteSize') IS NOT 'integer'))
      OR (csi.kind='comment_image' AND (json_type(item.value,'$.originalFilename') IS NOT 'text' OR json_type(item.value,'$.originalMimeType') IS NOT 'text' OR json_type(item.value,'$.originalByteSize') IS NOT 'integer'))
      OR (csi.kind='link' AND (json_type(item.value,'$.title') IS NOT 'text' OR json_type(item.value,'$.url') IS NOT 'text'))
      OR (json_type(item.value,'$.title') IS NOT NULL AND json_type(item.value,'$.title') IS NOT 'text')
      OR (json_type(item.value,'$.description') IS NOT NULL AND json_type(item.value,'$.description') IS NOT 'text')
      OR (json_type(item.value,'$.relatedAttachmentId') IS NOT NULL AND json_type(item.value,'$.relatedAttachmentId') IS NOT 'text')
      OR (json_type(item.value,'$.relatedCommentImageId') IS NOT NULL AND json_type(item.value,'$.relatedCommentImageId') IS NOT 'text')
      OR csi.filename IS NOT json_extract(item.value,'$.filename') OR csi.mime_type IS NOT json_extract(item.value,'$.mimeType') OR csi.byte_size IS NOT json_extract(item.value,'$.byteSize')
      OR (csi.kind<>'link' AND (json_type(item.value,'$.sha256') IS NOT 'text' OR length(json_extract(item.value,'$.sha256'))<>64
        OR json_extract(item.value,'$.sha256') GLOB '*[^0-9a-f]*' OR instr(json_extract(item.value,'$.sha256'),char(0))<>0))
      OR csi.related_item_id IS NOT CASE WHEN csi.kind='comment_image' THEN json_extract(item.value,'$.relatedAttachmentId') ELSE json_extract(item.value,'$.relatedCommentImageId') END
      OR (csi.kind='comment_image' AND (csi.original_filename IS NOT json_extract(item.value,'$.originalFilename') OR csi.original_mime_type IS NOT json_extract(item.value,'$.originalMimeType') OR csi.original_byte_size IS NOT json_extract(item.value,'$.originalByteSize')))
      OR (csi.kind='attachment' AND (csi.original_filename IS NOT csi.filename OR csi.original_mime_type IS NOT csi.mime_type OR csi.original_byte_size IS NOT csi.byte_size))
      OR (csi.kind='link' AND csi.external_url IS NOT json_extract(item.value,'$.url')))
    OR (json_extract(NEW.request_input_json,'$.context.kind')='sample' AND (SELECT count(*) FROM comment_submission_targets WHERE submission_id=NEW.submission_id)<>0)
    OR (json_extract(NEW.request_input_json,'$.context.kind')='run_steps' AND (
      (SELECT count(*) FROM comment_submission_targets WHERE submission_id=NEW.submission_id)<>json_array_length(NEW.request_input_json,'$.context.targets')
      OR EXISTS(SELECT 1 FROM json_each(NEW.request_input_json,'$.context.targets') target WHERE NOT EXISTS(
        SELECT 1 FROM comment_submission_targets t JOIN samples s ON s.id=t.sample_id JOIN runs r ON r.id=t.run_id AND r.sample_id=t.sample_id
          JOIN run_steps rs ON rs.id=t.run_step_id AND rs.run_id=t.run_id
        WHERE t.submission_id=NEW.submission_id AND t.sample_id=json_extract(target.value,'$.sampleId') AND t.run_id=json_extract(target.value,'$.runId')
          AND t.run_step_id=json_extract(target.value,'$.stepId') AND t.expected_updated_at=json_extract(target.value,'$.expectedUpdatedAt')
          AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL))))
    THEN RAISE(ABORT,'Comment accepted intent does not match canonical rows') END ;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM comment_submission_acceptances WHERE submission_id = NEW.submission_id OR operation_id = NEW.operation_id)
    THEN RAISE(ABORT, 'Accepted Comment identity is immutable') END ;
  SELECT CASE WHEN NEW.status <> 'pending' OR NEW.completed_at IS NOT NULL OR NEW.accepted_result_json IS NOT NULL
    OR json_extract(NEW.request_input_json, '$.protocol') IS NOT 'comment-submission/1'
    OR json_extract(NEW.request_input_json, '$.id') IS NOT NEW.submission_id
    OR (SELECT count(*) FROM json_each(NEW.request_input_json)) <> 5
    OR json_type(NEW.request_input_json, '$.items') IS NOT 'array'
    OR json_array_length(NEW.request_input_json, '$.items') > 24
    OR json_extract(NEW.publication_plan_json, '$.schema') IS NOT 'comment-publication/1'
    OR json_type(NEW.publication_plan_json, '$.occurrences') IS NOT 'array'
    OR json_type(NEW.publication_plan_json, '$.events') IS NOT 'array'
    OR NOT EXISTS (SELECT 1 FROM comment_submissions cs WHERE cs.id = NEW.submission_id AND cs.actor_email = NEW.actor_email
      AND cs.body IS json_extract(NEW.request_input_json, '$.body') AND cs.status = 'uploading'
      AND cs.deleted_at IS NULL AND cs.retry_closed_at IS NULL AND cs.retry_until = NEW.expires_at
      AND cs.context_kind IS json_extract(NEW.request_input_json, '$.context.kind')
      AND cs.sample_id IS json_extract(NEW.request_input_json, '$.context.sampleId')
      AND cs.scope IS json_extract(NEW.request_input_json, '$.context.scope'))
    OR (SELECT count(*) FROM comment_submission_items WHERE submission_id = NEW.submission_id) <> json_array_length(NEW.request_input_json, '$.items')
    THEN RAISE(ABORT, 'Invalid Comment acceptance input') END ;
END;

CREATE TRIGGER comment_submission_acceptances_publication_guard BEFORE UPDATE ON comment_submission_acceptances WHEN NEW.status = 'ready'
BEGIN
  SELECT CASE WHEN NEW.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') OR NEW.accepted_result_json IS NULL
    OR (SELECT count(*) FROM comment_submission_items WHERE submission_id=NEW.submission_id) <> json_array_length(NEW.request_input_json,'$.items')
    OR (SELECT count(*) FROM run_step_comments WHERE submission_id=NEW.submission_id) <> json_array_length(NEW.publication_plan_json,'$.occurrences')
    OR (SELECT count(*) FROM events WHERE json_extract(metadata_json,'$.action')='comment_submission' AND json_extract(metadata_json,'$.submissionId')=NEW.submission_id) <> json_array_length(NEW.publication_plan_json,'$.events')
    OR (SELECT count(*) FROM json_each(NEW.accepted_result_json)) <> 5
    OR json_type(NEW.accepted_result_json,'$.submissionId') IS NOT 'text' OR json_type(NEW.accepted_result_json,'$.completedAt') IS NOT 'text'
    OR EXISTS(SELECT 1 FROM json_each(NEW.accepted_result_json,'$.itemIds') WHERE type<>'text')
    OR EXISTS(SELECT 1 FROM json_each(NEW.accepted_result_json,'$.eventIds') WHERE type<>'text')
    OR EXISTS(SELECT 1 FROM json_each(NEW.accepted_result_json,'$.occurrenceIds') WHERE type<>'text')
    OR json_extract(NEW.accepted_result_json, '$.submissionId') IS NOT NEW.submission_id
    OR json_extract(NEW.accepted_result_json, '$.completedAt') IS NOT NEW.completed_at
    OR json_type(NEW.accepted_result_json, '$.occurrenceIds') IS NOT 'array'
    OR json_type(NEW.accepted_result_json, '$.eventIds') IS NOT 'array'
    OR json_type(NEW.accepted_result_json, '$.itemIds') IS NOT 'array'
    OR json_array_length(NEW.accepted_result_json, '$.occurrenceIds') <> json_array_length(NEW.publication_plan_json, '$.occurrences')
    OR json_array_length(NEW.accepted_result_json, '$.eventIds') <> json_array_length(NEW.publication_plan_json, '$.events')
    OR EXISTS (SELECT 1 FROM json_each(NEW.publication_plan_json, '$.occurrences') p
      WHERE json_extract(NEW.accepted_result_json, '$.occurrenceIds[' || p.key || ']') IS NOT json_extract(p.value, '$.id'))
    OR EXISTS (SELECT 1 FROM json_each(NEW.publication_plan_json, '$.events') p
      WHERE json_extract(NEW.accepted_result_json, '$.eventIds[' || p.key || ']') IS NOT json_extract(p.value, '$.id'))
    OR NOT EXISTS (SELECT 1 FROM comment_submissions cs WHERE cs.id = NEW.submission_id AND cs.status = 'ready' AND cs.deleted_at IS NULL
      AND cs.actor_email = NEW.actor_email AND cs.completed_at = NEW.completed_at AND cs.updated_at = NEW.completed_at
      AND cs.last_mutation_id = json_extract(NEW.publication_plan_json, '$.mutationId')
      AND (length(trim(cs.body)) > 0 OR json_array_length(NEW.accepted_result_json, '$.itemIds') > 0))
    OR EXISTS (SELECT 1 FROM comment_submission_items csi WHERE csi.submission_id = NEW.submission_id AND csi.status NOT IN ('ready', 'cancelled'))
    OR json_array_length(NEW.accepted_result_json, '$.itemIds') <> (SELECT count(*) FROM comment_submission_items WHERE submission_id = NEW.submission_id AND status = 'ready' AND deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM json_each(NEW.accepted_result_json, '$.itemIds') x LEFT JOIN comment_submission_items csi ON csi.id=x.value AND csi.submission_id=NEW.submission_id
      WHERE csi.id IS NULL OR csi.status <> 'ready' OR csi.deleted_at IS NOT NULL OR x.key <> (SELECT count(*) FROM comment_submission_items before WHERE before.submission_id=NEW.submission_id AND before.status='ready' AND before.deleted_at IS NULL AND before.position<csi.position))
    OR EXISTS (SELECT 1 FROM comment_submission_items csi LEFT JOIN comment_item_acceptances ia ON ia.item_id = csi.id
      WHERE csi.submission_id = NEW.submission_id AND csi.kind <> 'link' AND csi.status = 'ready' AND csi.deleted_at IS NULL
        AND (ia.status IS NOT 'ready' OR ia.expected_sha256 IS NOT csi.sha256 OR ia.expected_byte_size IS NOT csi.byte_size
          OR ((csi.kind = 'comment_image' OR (csi.kind='attachment' AND NEW.storage_role_policy_revision=2)) AND NOT EXISTS (SELECT 1 FROM assets a LEFT JOIN imports i ON i.id = a.import_id
            WHERE a.id = csi.asset_id AND a.id = json_extract(ia.accepted_result_json, '$.blobRecordId') AND a.r2_key = json_extract(ia.accepted_result_json, '$.objectKey')
              AND a.sha256 = ia.expected_sha256 AND a.byte_size = ia.expected_byte_size AND a.status = 'ready' AND (a.import_id IS NULL OR i.status = 'ready')))
          OR (csi.kind = 'attachment' AND NEW.storage_role_policy_revision=1 AND NOT EXISTS (SELECT 1 FROM managed_storage_objects m WHERE m.id = csi.storage_object_id
            AND m.id = json_extract(ia.accepted_result_json, '$.blobRecordId') AND m.object_key = json_extract(ia.accepted_result_json, '$.objectKey')
            AND m.sha256 = ia.expected_sha256 AND m.byte_size = ia.expected_byte_size AND m.provider = 'switchdrive' AND m.status = 'ready'))
          OR EXISTS (SELECT 1 FROM blob_gc_ledger bg WHERE bg.store_kind = json_extract(ia.accepted_result_json, '$.storeKind')
            AND bg.provider = json_extract(ia.accepted_result_json, '$.provider') AND bg.object_key = json_extract(ia.accepted_result_json, '$.objectKey') AND bg.state IN ('deleting', 'deleted'))
          OR EXISTS (SELECT 1 FROM blob_integrity_quarantine b WHERE b.store_kind = json_extract(ia.accepted_result_json, '$.storeKind')
            AND b.provider = json_extract(ia.accepted_result_json, '$.provider') AND b.object_key = json_extract(ia.accepted_result_json, '$.objectKey'))))
    OR EXISTS (SELECT 1 FROM comment_submission_items image WHERE image.submission_id = NEW.submission_id AND image.kind = 'comment_image' AND image.status = 'ready' AND image.deleted_at IS NULL
      AND (lower(trim(image.original_filename,char(9)||char(10)||char(11)||char(12)||char(13)||char(32)||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)||char(65279))) LIKE '%.tif' OR lower(trim(image.original_filename,char(9)||char(10)||char(11)||char(12)||char(13)||char(32)||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)||char(65279))) LIKE '%.tiff' OR lower(trim( CASE WHEN instr(image.original_mime_type,';')>0 THEN substr(image.original_mime_type,1,instr(image.original_mime_type,';')-1) ELSE image.original_mime_type END ,char(9)||char(10)||char(11)||char(12)||char(13)||char(32)||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)||char(65279))) IN('image/tiff','image/x-tiff'))
      AND NOT EXISTS (SELECT 1 FROM comment_submission_items original WHERE original.id = image.related_item_id AND original.submission_id = image.submission_id
        AND original.kind = 'attachment' AND original.status = 'ready' AND original.deleted_at IS NULL))
    OR EXISTS (SELECT 1 FROM json_each(NEW.publication_plan_json, '$.occurrences') p
      WHERE NOT EXISTS (SELECT 1 FROM run_step_comments rsc JOIN run_steps rs ON rs.id = rsc.run_step_id
        JOIN runs r ON r.id = rs.run_id JOIN samples s ON s.id = r.sample_id
        WHERE rsc.id = json_extract(p.value, '$.id') AND rsc.submission_id = NEW.submission_id AND rsc.deleted_at IS NULL
          AND rsc.run_step_id = json_extract(NEW.request_input_json, '$.context.targets[' || json_extract(p.value, '$.targetIndex') || '].stepId')
          AND r.id = json_extract(NEW.request_input_json, '$.context.targets[' || json_extract(p.value, '$.targetIndex') || '].runId')
          AND s.id = json_extract(NEW.request_input_json, '$.context.targets[' || json_extract(p.value, '$.targetIndex') || '].sampleId')
          AND rsc.scope = json_extract(NEW.request_input_json, '$.context.scope') AND rsc.operation_group_id IS json_extract(NEW.publication_plan_json, '$.operationGroupId')
          AND rsc.actor_email = NEW.actor_email AND rsc.created_at = NEW.completed_at
          AND rs.updated_at = NEW.completed_at AND rs.updated_by = NEW.actor_email
          AND rs.deleted_at IS NULL AND r.deleted_at IS NULL AND s.deleted_at IS NULL))
    OR EXISTS (SELECT 1 FROM json_each(NEW.publication_plan_json, '$.events') p
      WHERE NOT EXISTS (SELECT 1 FROM events e JOIN samples s ON s.id = e.sample_id
        WHERE e.id = json_extract(p.value, '$.id') AND e.sample_id = json_extract(p.value, '$.sampleId')
          AND e.kind = 'comment' AND e.actor_email = NEW.actor_email AND e.created_at = NEW.completed_at
          AND json_extract(e.metadata_json, '$.action') = 'comment_submission' AND json_extract(e.metadata_json, '$.submissionId') = NEW.submission_id
          AND s.deleted_at IS NULL AND s.updated_at = NEW.completed_at AND s.updated_by = NEW.actor_email))
    THEN RAISE(ABORT, 'Accepted Comment result does not match complete publication') END ;
END;

CREATE TRIGGER comment_submission_acceptances_role_policy_insert_guard BEFORE INSERT ON comment_submission_acceptances BEGIN
  SELECT RAISE(ABORT,'Active binary Comment acceptance requires recorded R2 role policy') WHERE
    EXISTS(SELECT 1 FROM json_each(NEW.request_input_json,'$.items') i WHERE json_extract(i.value,'$.kind')<>'link')
    AND (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND NEW.storage_role_policy_revision<>2;
  SELECT RAISE(ABORT,'R2 role policy requires active admitted defaults') WHERE NEW.storage_role_policy_revision=2 AND (
    NOT EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1
      WHERE a.singleton=1 AND a.mode='active') OR (SELECT count(*) FROM storage_role_defaults)<>2);
END;

CREATE TRIGGER comment_submission_acceptances_role_policy_update_guard BEFORE UPDATE ON comment_submission_acceptances BEGIN
  SELECT RAISE(ABORT,'Accepted Comment role policy is immutable') WHERE NEW.storage_role_policy_revision IS NOT OLD.storage_role_policy_revision;
END;

CREATE TRIGGER comment_submission_acceptances_update_guard BEFORE UPDATE ON comment_submission_acceptances
BEGIN
  SELECT CASE WHEN OLD.status <> 'pending' OR NEW.status NOT IN ('ready', 'cancelled')
    OR NEW.submission_id IS NOT OLD.submission_id OR NEW.actor_email IS NOT OLD.actor_email OR NEW.operation_id IS NOT OLD.operation_id
    OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.request_input_json IS NOT OLD.request_input_json
    OR NEW.publication_plan_json IS NOT OLD.publication_plan_json OR NEW.request_scope IS NOT OLD.request_scope
    OR NEW.storage_policy_revision IS NOT OLD.storage_policy_revision OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
    THEN RAISE(ABORT, 'Accepted Comment identity or result is immutable') END ;
  SELECT CASE WHEN NEW.status = 'cancelled' AND NOT EXISTS (SELECT 1 FROM comment_submissions WHERE id = NEW.submission_id AND status = 'cancelled')
    THEN RAISE(ABORT, 'Comment cancellation must be fenced') END ;
END;

CREATE TRIGGER file_authority_comment_parent_ready_guard BEFORE UPDATE ON comment_submission_acceptances
WHEN NEW.status='ready' AND (SELECT mode FROM file_authority_control WHERE singleton=1)='active'
BEGIN
  SELECT RAISE(ABORT,'Active Comment completion requires all exact File bindings') WHERE EXISTS (
    SELECT 1 FROM comment_submission_items i WHERE i.submission_id=NEW.submission_id AND i.status='ready' AND i.kind<>'link' AND (
      NOT EXISTS(SELECT 1 FROM comment_item_acceptances r JOIN file_acceptance_candidates c
        ON c.acceptance_kind='comment_item' AND c.acceptance_id=r.item_id AND c.item_id='' AND c.state='ready'
        AND c.purpose=r.purpose AND c.storage_profile_id=r.storage_profile_id
        AND c.expected_byte_size=r.expected_byte_size AND c.expected_sha256=r.expected_sha256
        JOIN file_usable_publications f ON f.file_id=c.result_file_id AND f.active_location_id=c.result_location_id
        JOIN file_location_publications l ON l.location_id=c.result_location_id AND l.file_id=f.file_id
        WHERE r.item_id=i.id AND r.submission_id=NEW.submission_id AND r.status='ready' AND i.file_id=f.file_id
          AND l.object_key=json_extract(r.accepted_result_json,'$.objectKey'))));
END;

CREATE TRIGGER file_shadow_epoch_comment_submission_acceptances_delete AFTER DELETE ON comment_submission_acceptances BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1; INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT 'comment_submission_acceptances',json_array( CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END ),COALESCE((SELECT MAX(v.revision) FROM file_shadow_dependency_versions v WHERE v.dependency_kind='comment_submission_acceptances' AND v.dependency_key=json_array( CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END )),0)+1,1,json_object('submission_id', CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END ,'status', CASE WHEN typeof(x.status)='blob' THEN json_object('$sqliteBlob',hex(x.status)) ELSE x.status END ,'request_sha256', CASE WHEN typeof(x.request_sha256)='blob' THEN json_object('$sqliteBlob',hex(x.request_sha256)) ELSE x.request_sha256 END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END ,'completed_at', CASE WHEN typeof(x.completed_at)='blob' THEN json_object('$sqliteBlob',hex(x.completed_at)) ELSE x.completed_at END ,'expires_at', CASE WHEN typeof(x.expires_at)='blob' THEN json_object('$sqliteBlob',hex(x.expires_at)) ELSE x.expires_at END )
  FROM comment_submission_acceptances x WHERE NOT EXISTS(SELECT 1 FROM file_shadow_dependency_versions v WHERE v.dependency_kind='comment_submission_acceptances' AND v.dependency_key=json_array( CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END ) AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key) AND v.present=1 AND v.snapshot_json IS json_object('submission_id', CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END ,'status', CASE WHEN typeof(x.status)='blob' THEN json_object('$sqliteBlob',hex(x.status)) ELSE x.status END ,'request_sha256', CASE WHEN typeof(x.request_sha256)='blob' THEN json_object('$sqliteBlob',hex(x.request_sha256)) ELSE x.request_sha256 END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END ,'completed_at', CASE WHEN typeof(x.completed_at)='blob' THEN json_object('$sqliteBlob',hex(x.completed_at)) ELSE x.completed_at END ,'expires_at', CASE WHEN typeof(x.expires_at)='blob' THEN json_object('$sqliteBlob',hex(x.expires_at)) ELSE x.expires_at END ));
  INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT v.dependency_kind,v.dependency_key,v.revision+1,0,'null' FROM file_shadow_dependency_versions v
  WHERE v.dependency_kind='comment_submission_acceptances' AND v.present=1 AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key)
  AND NOT EXISTS(SELECT 1 FROM comment_submission_acceptances x WHERE json_array( CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END )=v.dependency_key); INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),s.consumer_kind,s.consumer_id,s.consumer_sub_id,s.file_slot,COALESCE(h.generation,0)+1,1,s.source_rowid,s.source_json,s.legacy_store_kind,s.legacy_provider,s.legacy_object_key,s.expected_purpose,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (WITH current_sources AS MATERIALIZED (SELECT * FROM file_shadow_sources) SELECT * FROM current_sources) s LEFT JOIN file_shadow_heads h ON h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot WHERE (1=1) AND (h.occurrence_id IS NULL OR h.present<>1 OR h.source_rowid IS NOT s.source_rowid OR h.source_json IS NOT s.source_json OR (0));
    INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),h.consumer_kind,h.consumer_id,h.consumer_sub_id,h.file_slot,h.generation+1,0,NULL,'{}',NULL,NULL,NULL,NULL,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM file_shadow_heads h WHERE h.present=1 AND (1=1) AND NOT EXISTS(SELECT 1 FROM file_shadow_source_keys s WHERE h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot);
    INSERT INTO file_shadow_closures(occurrence_id,successor_occurrence_id,closed_epoch,closed_at)
    SELECT h.occurrence_id,o.id,o.observed_epoch,o.observed_at FROM file_shadow_occurrences o JOIN file_shadow_heads h ON h.consumer_kind IS o.consumer_kind AND h.consumer_id IS o.consumer_id AND h.consumer_sub_id IS o.consumer_sub_id AND h.file_slot IS o.file_slot AND o.generation=h.generation+1
    WHERE o.observed_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1);
    INSERT INTO file_shadow_heads(consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,occurrence_id,present,source_rowid,source_json,observed_epoch)
    SELECT o.consumer_kind,o.consumer_id,o.consumer_sub_id,o.file_slot,o.generation,o.id,o.present,o.source_rowid,o.source_json,o.observed_epoch FROM file_shadow_occurrences o
    WHERE o.observed_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1) AND NOT EXISTS(SELECT 1 FROM file_shadow_closures c WHERE c.occurrence_id=o.id)
    ON CONFLICT(consumer_kind,consumer_id,consumer_sub_id,file_slot) DO UPDATE SET generation=excluded.generation,occurrence_id=excluded.occurrence_id,present=excluded.present,source_rowid=excluded.source_rowid,source_json=excluded.source_json,observed_epoch=excluded.observed_epoch
    WHERE file_shadow_heads.generation<excluded.generation; END;

CREATE TRIGGER file_shadow_epoch_comment_submission_acceptances_insert AFTER INSERT ON comment_submission_acceptances BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1; INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT 'comment_submission_acceptances',json_array( CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END ),COALESCE((SELECT MAX(v.revision) FROM file_shadow_dependency_versions v WHERE v.dependency_kind='comment_submission_acceptances' AND v.dependency_key=json_array( CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END )),0)+1,1,json_object('submission_id', CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END ,'status', CASE WHEN typeof(x.status)='blob' THEN json_object('$sqliteBlob',hex(x.status)) ELSE x.status END ,'request_sha256', CASE WHEN typeof(x.request_sha256)='blob' THEN json_object('$sqliteBlob',hex(x.request_sha256)) ELSE x.request_sha256 END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END ,'completed_at', CASE WHEN typeof(x.completed_at)='blob' THEN json_object('$sqliteBlob',hex(x.completed_at)) ELSE x.completed_at END ,'expires_at', CASE WHEN typeof(x.expires_at)='blob' THEN json_object('$sqliteBlob',hex(x.expires_at)) ELSE x.expires_at END )
  FROM comment_submission_acceptances x WHERE NOT EXISTS(SELECT 1 FROM file_shadow_dependency_versions v WHERE v.dependency_kind='comment_submission_acceptances' AND v.dependency_key=json_array( CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END ) AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key) AND v.present=1 AND v.snapshot_json IS json_object('submission_id', CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END ,'status', CASE WHEN typeof(x.status)='blob' THEN json_object('$sqliteBlob',hex(x.status)) ELSE x.status END ,'request_sha256', CASE WHEN typeof(x.request_sha256)='blob' THEN json_object('$sqliteBlob',hex(x.request_sha256)) ELSE x.request_sha256 END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END ,'completed_at', CASE WHEN typeof(x.completed_at)='blob' THEN json_object('$sqliteBlob',hex(x.completed_at)) ELSE x.completed_at END ,'expires_at', CASE WHEN typeof(x.expires_at)='blob' THEN json_object('$sqliteBlob',hex(x.expires_at)) ELSE x.expires_at END ));
  INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT v.dependency_kind,v.dependency_key,v.revision+1,0,'null' FROM file_shadow_dependency_versions v
  WHERE v.dependency_kind='comment_submission_acceptances' AND v.present=1 AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key)
  AND NOT EXISTS(SELECT 1 FROM comment_submission_acceptances x WHERE json_array( CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END )=v.dependency_key); INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),s.consumer_kind,s.consumer_id,s.consumer_sub_id,s.file_slot,COALESCE(h.generation,0)+1,1,s.source_rowid,s.source_json,s.legacy_store_kind,s.legacy_provider,s.legacy_object_key,s.expected_purpose,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (WITH current_sources AS MATERIALIZED (SELECT * FROM file_shadow_sources) SELECT * FROM current_sources) s LEFT JOIN file_shadow_heads h ON h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot WHERE (1=1) AND (h.occurrence_id IS NULL OR h.present<>1 OR h.source_rowid IS NOT s.source_rowid OR h.source_json IS NOT s.source_json OR (0));
    INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),h.consumer_kind,h.consumer_id,h.consumer_sub_id,h.file_slot,h.generation+1,0,NULL,'{}',NULL,NULL,NULL,NULL,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM file_shadow_heads h WHERE h.present=1 AND (1=1) AND NOT EXISTS(SELECT 1 FROM file_shadow_source_keys s WHERE h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot);
    INSERT INTO file_shadow_closures(occurrence_id,successor_occurrence_id,closed_epoch,closed_at)
    SELECT h.occurrence_id,o.id,o.observed_epoch,o.observed_at FROM file_shadow_occurrences o JOIN file_shadow_heads h ON h.consumer_kind IS o.consumer_kind AND h.consumer_id IS o.consumer_id AND h.consumer_sub_id IS o.consumer_sub_id AND h.file_slot IS o.file_slot AND o.generation=h.generation+1
    WHERE o.observed_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1);
    INSERT INTO file_shadow_heads(consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,occurrence_id,present,source_rowid,source_json,observed_epoch)
    SELECT o.consumer_kind,o.consumer_id,o.consumer_sub_id,o.file_slot,o.generation,o.id,o.present,o.source_rowid,o.source_json,o.observed_epoch FROM file_shadow_occurrences o
    WHERE o.observed_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1) AND NOT EXISTS(SELECT 1 FROM file_shadow_closures c WHERE c.occurrence_id=o.id)
    ON CONFLICT(consumer_kind,consumer_id,consumer_sub_id,file_slot) DO UPDATE SET generation=excluded.generation,occurrence_id=excluded.occurrence_id,present=excluded.present,source_rowid=excluded.source_rowid,source_json=excluded.source_json,observed_epoch=excluded.observed_epoch
    WHERE file_shadow_heads.generation<excluded.generation; END;

CREATE TRIGGER file_shadow_epoch_comment_submission_acceptances_update AFTER UPDATE ON comment_submission_acceptances BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1; INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT 'comment_submission_acceptances',json_array( CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END ),COALESCE((SELECT MAX(v.revision) FROM file_shadow_dependency_versions v WHERE v.dependency_kind='comment_submission_acceptances' AND v.dependency_key=json_array( CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END )),0)+1,1,json_object('submission_id', CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END ,'status', CASE WHEN typeof(x.status)='blob' THEN json_object('$sqliteBlob',hex(x.status)) ELSE x.status END ,'request_sha256', CASE WHEN typeof(x.request_sha256)='blob' THEN json_object('$sqliteBlob',hex(x.request_sha256)) ELSE x.request_sha256 END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END ,'completed_at', CASE WHEN typeof(x.completed_at)='blob' THEN json_object('$sqliteBlob',hex(x.completed_at)) ELSE x.completed_at END ,'expires_at', CASE WHEN typeof(x.expires_at)='blob' THEN json_object('$sqliteBlob',hex(x.expires_at)) ELSE x.expires_at END )
  FROM comment_submission_acceptances x WHERE NOT EXISTS(SELECT 1 FROM file_shadow_dependency_versions v WHERE v.dependency_kind='comment_submission_acceptances' AND v.dependency_key=json_array( CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END ) AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key) AND v.present=1 AND v.snapshot_json IS json_object('submission_id', CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END ,'status', CASE WHEN typeof(x.status)='blob' THEN json_object('$sqliteBlob',hex(x.status)) ELSE x.status END ,'request_sha256', CASE WHEN typeof(x.request_sha256)='blob' THEN json_object('$sqliteBlob',hex(x.request_sha256)) ELSE x.request_sha256 END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END ,'completed_at', CASE WHEN typeof(x.completed_at)='blob' THEN json_object('$sqliteBlob',hex(x.completed_at)) ELSE x.completed_at END ,'expires_at', CASE WHEN typeof(x.expires_at)='blob' THEN json_object('$sqliteBlob',hex(x.expires_at)) ELSE x.expires_at END ));
  INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT v.dependency_kind,v.dependency_key,v.revision+1,0,'null' FROM file_shadow_dependency_versions v
  WHERE v.dependency_kind='comment_submission_acceptances' AND v.present=1 AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key)
  AND NOT EXISTS(SELECT 1 FROM comment_submission_acceptances x WHERE json_array( CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END )=v.dependency_key); INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),s.consumer_kind,s.consumer_id,s.consumer_sub_id,s.file_slot,COALESCE(h.generation,0)+1,1,s.source_rowid,s.source_json,s.legacy_store_kind,s.legacy_provider,s.legacy_object_key,s.expected_purpose,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (WITH current_sources AS MATERIALIZED (SELECT * FROM file_shadow_sources) SELECT * FROM current_sources) s LEFT JOIN file_shadow_heads h ON h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot WHERE (1=1) AND (h.occurrence_id IS NULL OR h.present<>1 OR h.source_rowid IS NOT s.source_rowid OR h.source_json IS NOT s.source_json OR (0));
    INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),h.consumer_kind,h.consumer_id,h.consumer_sub_id,h.file_slot,h.generation+1,0,NULL,'{}',NULL,NULL,NULL,NULL,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM file_shadow_heads h WHERE h.present=1 AND (1=1) AND NOT EXISTS(SELECT 1 FROM file_shadow_source_keys s WHERE h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot);
    INSERT INTO file_shadow_closures(occurrence_id,successor_occurrence_id,closed_epoch,closed_at)
    SELECT h.occurrence_id,o.id,o.observed_epoch,o.observed_at FROM file_shadow_occurrences o JOIN file_shadow_heads h ON h.consumer_kind IS o.consumer_kind AND h.consumer_id IS o.consumer_id AND h.consumer_sub_id IS o.consumer_sub_id AND h.file_slot IS o.file_slot AND o.generation=h.generation+1
    WHERE o.observed_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1);
    INSERT INTO file_shadow_heads(consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,occurrence_id,present,source_rowid,source_json,observed_epoch)
    SELECT o.consumer_kind,o.consumer_id,o.consumer_sub_id,o.file_slot,o.generation,o.id,o.present,o.source_rowid,o.source_json,o.observed_epoch FROM file_shadow_occurrences o
    WHERE o.observed_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1) AND NOT EXISTS(SELECT 1 FROM file_shadow_closures c WHERE c.occurrence_id=o.id)
    ON CONFLICT(consumer_kind,consumer_id,consumer_sub_id,file_slot) DO UPDATE SET generation=excluded.generation,occurrence_id=excluded.occurrence_id,present=excluded.present,source_rowid=excluded.source_rowid,source_json=excluded.source_json,observed_epoch=excluded.observed_epoch
    WHERE file_shadow_heads.generation<excluded.generation; END;

CREATE TABLE storage_role_defaults_native_next (
  role TEXT PRIMARY KEY NOT NULL CHECK(role IN('internal','originals')),
  storage_profile_id TEXT NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
  storage_profile_revision INTEGER NOT NULL CHECK(typeof(storage_profile_revision)='integer' AND storage_profile_revision=1),
  policy_revision INTEGER NOT NULL CHECK(typeof(policy_revision)='integer' AND policy_revision>=2),
  created_at TEXT NOT NULL CHECK(created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',created_at))
) WITHOUT ROWID;

INSERT INTO storage_role_defaults_native_next(role,storage_profile_id,storage_profile_revision,policy_revision,created_at) SELECT role,storage_profile_id,storage_profile_revision,policy_revision,created_at FROM storage_role_defaults;

DROP TABLE storage_role_defaults;

ALTER TABLE storage_role_defaults_native_next RENAME TO storage_role_defaults;

CREATE TRIGGER file_r2_role_defaults_generation_complete BEFORE INSERT ON storage_role_defaults WHEN (NEW.policy_revision=2)
BEGIN
  SELECT 1;
END;

CREATE TRIGGER storage_role_defaults_delete_guard BEFORE DELETE ON storage_role_defaults BEGIN
  SELECT RAISE(ABORT,'FP1 role defaults cannot be deleted');
END;

CREATE TRIGGER storage_role_defaults_insert_guard BEFORE INSERT ON storage_role_defaults WHEN (NEW.policy_revision=2)
BEGIN
  SELECT RAISE(ABORT,'FP1 role defaults are initialized once') WHERE EXISTS(SELECT 1 FROM storage_role_defaults WHERE role=NEW.role);
  SELECT RAISE(ABORT,'R2 role defaults require active admitted File authority') WHERE NOT EXISTS(
    SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1
    JOIN storage_profiles p ON p.id=NEW.storage_profile_id AND p.adapter_type='r2' AND p.configuration_source='bootstrap'
      AND p.credential_reference IS NULL AND p.configuration_revision=NEW.storage_profile_revision AND p.state='historical'
    JOIN storage_profile_runtime r ON r.storage_profile_id=p.id AND r.state='read_write'
    WHERE a.singleton=1 AND a.mode='active');
  SELECT RAISE(ABORT,'FP1 roles require the same recorded R2 default') WHERE EXISTS(
    SELECT 1 FROM storage_role_defaults d WHERE d.storage_profile_id IS NOT NEW.storage_profile_id
      OR d.storage_profile_revision IS NOT NEW.storage_profile_revision OR d.policy_revision IS NOT NEW.policy_revision OR d.created_at IS NOT NEW.created_at);
END;

CREATE TRIGGER storage_role_defaults_update_guard BEFORE UPDATE ON storage_role_defaults WHEN (NEW.policy_revision=2)
BEGIN
  SELECT RAISE(ABORT,'FP1 role defaults are initialized once');
END;

PRAGMA legacy_alter_table=OFF;

ALTER TABLE imports ADD COLUMN file_targets_protocol INTEGER CHECK(file_targets_protocol IS NULL OR file_targets_protocol=1);

ALTER TABLE imports ADD COLUMN role_policy_revision INTEGER CHECK(role_policy_revision IS NULL OR typeof(role_policy_revision)='integer' AND role_policy_revision>=3);

ALTER TABLE r2_upload_requests ADD COLUMN role_policy_revision INTEGER CHECK(role_policy_revision IS NULL OR typeof(role_policy_revision)='integer' AND role_policy_revision>=3);

ALTER TABLE metrology_reference_upload_requests ADD COLUMN role_policy_revision INTEGER CHECK(role_policy_revision IS NULL OR typeof(role_policy_revision)='integer' AND role_policy_revision>=3);

ALTER TABLE comment_item_acceptances ADD COLUMN role_selection_revision INTEGER CHECK(role_selection_revision IS NULL OR typeof(role_selection_revision)='integer' AND role_selection_revision>=3);

DROP VIEW file_shadow_namespace_evidence;

CREATE VIEW file_shadow_namespace_evidence AS SELECT edge.* FROM(SELECT * FROM file_shadow_namespace_mapping UNION SELECT * FROM file_shadow_namespace_uploads UNION SELECT * FROM file_shadow_namespace_comments UNION SELECT * FROM file_shadow_namespace_imports) edge
 JOIN storage_profiles profile ON profile.id=edge.storage_profile_id AND profile.configuration_revision=edge.configuration_revision
 WHERE(edge.store_kind='r2' AND edge.provider='r2' AND profile.adapter_type='r2')
 OR(edge.store_kind='managed' AND edge.provider='switchdrive' AND profile.adapter_type='switchdrive');

DROP VIEW file_shadow_retention_namespaces;

CREATE VIEW file_shadow_retention_namespaces AS SELECT edge.* FROM(SELECT * FROM file_shadow_namespace_evidence
  UNION SELECT 'r2','r2',json_extract(request_json,'$.sourceLocator.objectKey'),
    json_extract(request_json,'$.sourceProfile.profileId'),json_extract(request_json,'$.sourceProfile.configurationRevision')
  FROM file_shadow_adjudications) edge
 JOIN storage_profiles profile ON profile.id=edge.storage_profile_id AND profile.configuration_revision=edge.configuration_revision
 WHERE(edge.store_kind='r2' AND edge.provider='r2' AND profile.adapter_type='r2')
 OR(edge.store_kind='managed' AND edge.provider='switchdrive' AND profile.adapter_type='switchdrive');

CREATE TABLE import_file_acceptances(
 import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE RESTRICT,
 item_id TEXT NOT NULL CHECK(length(item_id) BETWEEN 1 AND 4096 AND instr(item_id,char(0))=0),
 purpose TEXT NOT NULL CHECK(purpose IN('provenance','embedded_content')),
 storage_profile_id TEXT NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
 storage_profile_revision INTEGER NOT NULL CHECK(storage_profile_revision=1),
 role_policy_revision INTEGER NOT NULL CHECK(typeof(role_policy_revision)='integer' AND role_policy_revision>=3),
 expected_sha256 TEXT NOT NULL CHECK(length(expected_sha256)=64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),
 expected_byte_size INTEGER NOT NULL CHECK(typeof(expected_byte_size)='integer' AND expected_byte_size BETWEEN 0 AND 9007199254740991),
 candidate_asset_id TEXT NOT NULL UNIQUE CHECK(length(candidate_asset_id)=36),
 candidate_object_key TEXT NOT NULL CHECK(length(candidate_object_key) BETWEEN 1 AND 4096 AND instr(candidate_object_key,char(0))=0),
 status TEXT NOT NULL CHECK(status IN('pending','ready','cancelled')),
 result_file_id TEXT REFERENCES files(id) ON DELETE RESTRICT,
 result_location_id TEXT REFERENCES file_locations(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL CHECK(created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',created_at)),
 completed_at TEXT CHECK(completed_at IS NULL OR completed_at IS strftime('%Y-%m-%dT%H:%M:%fZ',completed_at) AND completed_at>=created_at),
 PRIMARY KEY(import_id,item_id), UNIQUE(storage_profile_id,candidate_object_key),
 CHECK((status='pending' AND result_file_id IS NULL AND result_location_id IS NULL AND completed_at IS NULL)
 OR(status='ready' AND result_file_id IS NOT NULL AND result_location_id IS NOT NULL AND completed_at IS NOT NULL)
 OR(status='cancelled' AND result_file_id IS NULL AND result_location_id IS NULL AND completed_at IS NOT NULL))
) WITHOUT ROWID;

CREATE TRIGGER storage_role_defaults_native_insert_guard BEFORE INSERT ON storage_role_defaults WHEN NEW.policy_revision>=3 BEGIN
 SELECT RAISE(ABORT,'Role default requires exact admitted policy history') WHERE NOT EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active') OR NOT EXISTS(
 SELECT 1 FROM storage_role_policy_revisions h JOIN storage_profiles p ON p.id=h.storage_profile_id
 JOIN storage_profile_runtime r ON r.storage_profile_id=p.id AND r.state='read_write'
 WHERE h.policy_revision=NEW.policy_revision AND h.role=NEW.role AND h.storage_profile_id=NEW.storage_profile_id
 AND h.storage_profile_revision=NEW.storage_profile_revision AND h.created_at=NEW.created_at
 AND p.configuration_revision=NEW.storage_profile_revision AND p.adapter_type IN('r2','s3'));
 
END;

CREATE TRIGGER storage_role_defaults_native_update_guard BEFORE UPDATE ON storage_role_defaults WHEN NEW.policy_revision>=3 BEGIN
 SELECT RAISE(ABORT,'Role default requires exact admitted policy history') WHERE NOT EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active') OR NOT EXISTS(
 SELECT 1 FROM storage_role_policy_revisions h JOIN storage_profiles p ON p.id=h.storage_profile_id
 JOIN storage_profile_runtime r ON r.storage_profile_id=p.id AND r.state='read_write'
 WHERE h.policy_revision=NEW.policy_revision AND h.role=NEW.role AND h.storage_profile_id=NEW.storage_profile_id
 AND h.storage_profile_revision=NEW.storage_profile_revision AND h.created_at=NEW.created_at
 AND p.configuration_revision=NEW.storage_profile_revision AND p.adapter_type IN('r2','s3'));
 SELECT RAISE(ABORT,'Role default revision is stale') WHERE NEW.role IS NOT OLD.role OR NEW.policy_revision<=OLD.policy_revision;
END;

DROP TRIGGER storage_profile_runtime_legacy_update_guard;

CREATE TRIGGER storage_profile_runtime_legacy_update_guard BEFORE UPDATE ON storage_profile_runtime WHEN (NOT EXISTS(SELECT 1 FROM storage_profiles p WHERE p.id=NEW.storage_profile_id AND p.adapter_type='s3'))
BEGIN SELECT RAISE(ABORT,'Profile write readiness requires explicit shadow admission') WHERE NOT(EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='overlap')) OR OLD.state<>'read_only' OR NEW.state<>'read_write' OR NEW.storage_profile_id IS NOT OLD.storage_profile_id OR NEW.registered_at IS NOT OLD.registered_at OR NEW.retired_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM file_shadow_profile_enablements e WHERE e.storage_profile_id=NEW.storage_profile_id AND NEW.activated_at IS e.enabled_at); END;

DROP TRIGGER storage_profile_runtime_native_admission_guard;

CREATE TRIGGER storage_profile_runtime_native_admission_guard BEFORE UPDATE ON storage_profile_runtime
 WHEN EXISTS(SELECT 1 FROM storage_profiles p WHERE p.id=NEW.storage_profile_id AND p.adapter_type='s3') BEGIN
 SELECT RAISE(ABORT,'Native runtime identity is immutable') WHERE NEW.storage_profile_id IS NOT OLD.storage_profile_id OR NEW.registered_at IS NOT OLD.registered_at;
 SELECT RAISE(ABORT,'Native runtime activation requires exact tested binding') WHERE NEW.state='read_write' AND (NEW.retired_at IS NOT NULL OR NOT EXISTS(
 SELECT 1 FROM system_storage_native_bindings b JOIN storage_profile_activations a ON a.operation_id=b.activation_operation_id
 WHERE b.storage_profile_id=NEW.storage_profile_id AND a.storage_profile_id=b.storage_profile_id AND a.action='activate' AND a.created_at=NEW.activated_at));
 SELECT RAISE(ABORT,'Native runtime retirement requires explicit audit') WHERE NEW.state='retired' AND NOT EXISTS(
 SELECT 1 FROM storage_profile_activations a WHERE a.storage_profile_id=NEW.storage_profile_id AND a.action='retire' AND a.created_at=NEW.retired_at);
 SELECT RAISE(ABORT,'Native runtime cannot erase lifecycle history') WHERE OLD.state<>'read_only' AND NEW.state='read_only';
END;

DROP TRIGGER file_locations_native_admission_guard;

CREATE TRIGGER file_locations_native_admission_guard BEFORE INSERT ON file_locations BEGIN
 SELECT RAISE(ABORT,'Native location requires admitted writable namespace') WHERE EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='s3') AND NOT EXISTS(
 SELECT 1 FROM storage_profiles p JOIN storage_profile_runtime r ON r.storage_profile_id=p.id AND r.state='read_write'
 JOIN system_storage_native_bindings b ON b.storage_profile_id=p.id WHERE p.id=NEW.storage_profile_id AND p.configuration_source='system'); END;

CREATE TRIGGER assets_native_insert_guard BEFORE INSERT ON assets WHEN NEW.r2_key IS NULL BEGIN
 SELECT RAISE(ABORT,'Native alias requires exact verified File acceptance') WHERE NOT EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active') OR NEW.status NOT IN('pending','ready') OR NOT EXISTS(
 SELECT 1 FROM file_authority_ready_candidate_aliases c JOIN storage_profiles p ON p.id=c.storage_profile_id AND p.adapter_type='s3'
 WHERE c.result_file_id=NEW.file_id AND c.storage_profile_id=NEW.storage_profile_id AND p.configuration_revision=NEW.storage_profile_revision
 AND c.result_object_key=NEW.object_key AND c.expected_sha256=NEW.sha256 AND c.expected_byte_size=NEW.byte_size
 AND c.alias_id=NEW.id AND ((c.acceptance_kind='import_file' AND NEW.import_id=c.acceptance_id) OR(c.acceptance_kind<>'import_file' AND NEW.import_id IS NULL)));
 SELECT RAISE(ABORT,'Native alias identity conflict') WHERE EXISTS(SELECT 1 FROM assets WHERE id=NEW.id OR storage_profile_id=NEW.storage_profile_id AND object_key=NEW.object_key);
END;

CREATE TRIGGER assets_native_update_guard BEFORE UPDATE ON assets WHEN OLD.file_id IS NOT NULL OR NEW.file_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'Native File alias identity is immutable') WHERE NEW.rowid IS NOT OLD.rowid OR NEW.id IS NOT OLD.id
 OR NEW.file_id IS NOT OLD.file_id OR NEW.storage_profile_id IS NOT OLD.storage_profile_id OR NEW.storage_profile_revision IS NOT OLD.storage_profile_revision
 OR NEW.object_key IS NOT OLD.object_key OR NEW.r2_key IS NOT OLD.r2_key OR NEW.sha256 IS NOT OLD.sha256 OR NEW.byte_size IS NOT OLD.byte_size
 OR NEW.import_id IS NOT OLD.import_id; END;

CREATE TRIGGER assets_native_delete_guard BEFORE DELETE ON assets WHEN OLD.file_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'Native alias provenance is retained'); END;

DROP TRIGGER r2_upload_requests_insert_guard;

CREATE TRIGGER r2_upload_requests_insert_guard BEFORE INSERT ON r2_upload_requests
BEGIN
  
  SELECT CASE WHEN EXISTS (SELECT 1 FROM r2_upload_requests old WHERE old.id = NEW.id
    OR (old.actor_email = NEW.actor_email AND old.client_request_id = NEW.client_request_id)
    OR old.operation_id = NEW.operation_id OR old.candidate_asset_id = NEW.candidate_asset_id
    OR old.candidate_object_key = NEW.candidate_object_key)
    THEN RAISE(ABORT, 'Accepted upload identity is immutable') END ;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM (SELECT NEW.id AS value UNION ALL SELECT NEW.client_request_id
      UNION ALL SELECT NEW.operation_id UNION ALL SELECT NEW.candidate_asset_id)
    WHERE typeof(value) <> 'text' OR length(value) <> 36 OR value <> lower(value) OR instr(value, char(0)) <> 0
      OR substr(value, 9, 1) <> '-' OR substr(value, 14, 1) <> '-'
      OR substr(value, 19, 1) <> '-' OR substr(value, 24, 1) <> '-'
      OR length(replace(value, '-', '')) <> 32 OR replace(value, '-', '') GLOB '*[^0-9a-f]*'
      OR substr(value, 15, 1) <> '4' OR substr(value, 20, 1) NOT GLOB '[89ab]'
  ) THEN RAISE(ABORT, 'Invalid upload request identity') END ;
  SELECT CASE WHEN NEW.status <> 'pending' OR NEW.completed_at IS NOT NULL OR NEW.accepted_result_json IS NOT NULL
    THEN RAISE(ABORT, 'Accepted uploads must begin pending') END ;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM storage_profiles p WHERE p.id = NEW.storage_profile_id
    AND (p.adapter_type='r2' OR(p.adapter_type='s3' AND NEW.role_policy_revision IS NOT NULL AND EXISTS(SELECT 1 FROM storage_profile_runtime rt JOIN system_storage_native_bindings b ON b.storage_profile_id=rt.storage_profile_id WHERE rt.storage_profile_id=p.id AND rt.state='read_write'))) AND p.configuration_revision = NEW.storage_profile_revision
    AND ((p.adapter_type='r2' AND p.configuration_source='bootstrap') OR(p.adapter_type='s3' AND p.configuration_source='system')) AND p.credential_reference IS NULL AND p.state = 'historical')
    THEN RAISE(ABORT, 'Upload acceptance profile mismatch') END ;
  SELECT CASE WHEN NOT json_valid(NEW.request_input_json)
    THEN RAISE(ABORT, 'Invalid upload request input') END ;
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
    THEN RAISE(ABORT, 'Upload request input does not match acceptance') END ;
END;

CREATE TRIGGER r2_upload_requests_native_policy_insert_guard BEFORE INSERT ON r2_upload_requests BEGIN
 SELECT RAISE(ABORT,'Native upload requires frozen current role selection') WHERE NEW.role_policy_revision IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active') OR NOT EXISTS(
 SELECT 1 FROM storage_role_defaults d JOIN storage_role_policy_revisions h ON h.policy_revision=d.policy_revision AND h.role=d.role
 WHERE d.role=iif(NEW.purpose IN('research_source','provenance'),'originals','internal') AND d.policy_revision=NEW.role_policy_revision AND d.storage_profile_id=NEW.storage_profile_id AND d.storage_profile_revision=NEW.storage_profile_revision
 AND h.storage_profile_id=d.storage_profile_id AND h.storage_profile_revision=d.storage_profile_revision));
 SELECT RAISE(ABORT,'Native upload must record role selection') WHERE NEW.role_policy_revision IS NULL AND EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='s3'); END;

CREATE TRIGGER r2_upload_requests_native_policy_update_guard BEFORE UPDATE ON r2_upload_requests BEGIN SELECT RAISE(ABORT,'Accepted role selection is immutable') WHERE NEW.role_policy_revision IS NOT OLD.role_policy_revision; END;

DROP TRIGGER r2_upload_requests_publication_guard;

CREATE TRIGGER r2_upload_requests_publication_guard BEFORE UPDATE ON r2_upload_requests
WHEN (NEW.status = 'ready') AND (NOT EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='s3'))
BEGIN
  SELECT CASE WHEN NEW.accepted_result_json IS NULL OR NOT json_valid(NEW.accepted_result_json)
    THEN RAISE(ABORT, 'Invalid accepted upload result') END ;
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
    ) THEN RAISE(ABORT, 'Accepted upload result does not match publication') END ;
END;

DROP TRIGGER metrology_reference_upload_requests_insert_guard;

CREATE TRIGGER metrology_reference_upload_requests_insert_guard BEFORE INSERT ON metrology_reference_upload_requests
BEGIN
  
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
    AND (p.adapter_type='r2' OR(p.adapter_type='s3' AND NEW.role_policy_revision IS NOT NULL AND EXISTS(SELECT 1 FROM storage_profile_runtime rt JOIN system_storage_native_bindings b ON b.storage_profile_id=rt.storage_profile_id WHERE rt.storage_profile_id=p.id AND rt.state='read_write'))) AND p.configuration_revision = NEW.storage_profile_revision
    AND ((p.adapter_type='r2' AND p.configuration_source='bootstrap') OR(p.adapter_type='s3' AND p.configuration_source='system')) AND p.credential_reference IS NULL AND p.state = 'historical')
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

CREATE TRIGGER metrology_reference_upload_requests_native_policy_insert_guard BEFORE INSERT ON metrology_reference_upload_requests BEGIN
 SELECT RAISE(ABORT,'Native upload requires frozen current role selection') WHERE NEW.role_policy_revision IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active') OR NOT EXISTS(
 SELECT 1 FROM storage_role_defaults d JOIN storage_role_policy_revisions h ON h.policy_revision=d.policy_revision AND h.role=d.role
 WHERE d.role=iif(NEW.purpose IN('research_source','provenance'),'originals','internal') AND d.policy_revision=NEW.role_policy_revision AND d.storage_profile_id=NEW.storage_profile_id AND d.storage_profile_revision=NEW.storage_profile_revision
 AND h.storage_profile_id=d.storage_profile_id AND h.storage_profile_revision=d.storage_profile_revision));
 SELECT RAISE(ABORT,'Native upload must record role selection') WHERE NEW.role_policy_revision IS NULL AND EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='s3'); END;

CREATE TRIGGER metrology_reference_upload_requests_native_policy_update_guard BEFORE UPDATE ON metrology_reference_upload_requests BEGIN SELECT RAISE(ABORT,'Accepted role selection is immutable') WHERE NEW.role_policy_revision IS NOT OLD.role_policy_revision; END;

DROP TRIGGER metrology_reference_upload_requests_publication_guard;

CREATE TRIGGER metrology_reference_upload_requests_publication_guard BEFORE UPDATE ON metrology_reference_upload_requests
WHEN (NEW.status = 'ready') AND (NOT EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='s3'))
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

DROP TRIGGER file_authority_r2_receipt_ready_guard;

CREATE TRIGGER file_authority_r2_receipt_ready_guard BEFORE UPDATE ON r2_upload_requests
WHEN (NEW.status='ready' AND (SELECT mode FROM file_authority_control WHERE singleton=1)='active') AND (NOT EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='s3'))
BEGIN
  SELECT RAISE(ABORT,'Active upload requires its exact ready File candidate') WHERE NOT EXISTS (
    SELECT 1 FROM file_authority_usable_candidate_results c JOIN assets a
      ON a.id=json_extract(NEW.accepted_result_json,'$.id') AND a.r2_key=c.result_object_key
      AND a.r2_key=json_extract(NEW.accepted_result_json,'$.key') AND a.sha256=c.expected_sha256 AND a.byte_size=c.expected_byte_size
    WHERE c.acceptance_kind='r2_upload' AND c.acceptance_id=NEW.id AND c.item_id='' AND c.receipt_operation_id=NEW.operation_id);
END;

DROP TRIGGER file_authority_metrology_receipt_ready_guard;

CREATE TRIGGER file_authority_metrology_receipt_ready_guard BEFORE UPDATE ON metrology_reference_upload_requests
WHEN (NEW.status='ready' AND (SELECT mode FROM file_authority_control WHERE singleton=1)='active') AND (NOT EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='s3'))
BEGIN
  SELECT RAISE(ABORT,'Active metrology receipt requires its exact ready File candidate') WHERE NOT EXISTS (
    SELECT 1 FROM file_authority_usable_candidate_results c JOIN metrology_template_references m
      ON m.id=json_extract(NEW.accepted_result_json,'$.reference.id') AND m.template_version_id=NEW.template_version_id
      AND m.file_id=c.result_file_id AND m.asset_id=json_extract(NEW.accepted_result_json,'$.assetId')
    JOIN assets a ON a.id=m.asset_id AND a.r2_key=c.result_object_key
      AND a.r2_key=json_extract(NEW.accepted_result_json,'$.reference.assetKey') AND a.sha256=c.expected_sha256 AND a.byte_size=c.expected_byte_size
    WHERE c.acceptance_kind='metrology_reference' AND c.acceptance_id=NEW.id AND c.item_id='' AND c.receipt_operation_id=NEW.operation_id);
END;

CREATE TRIGGER r2_upload_requests_native_publication_guard BEFORE UPDATE ON r2_upload_requests WHEN NEW.status='ready' AND EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='s3') BEGIN
 SELECT RAISE(ABORT,'Native upload result does not match verified publication') WHERE
 (SELECT count(*) FROM json_each(NEW.accepted_result_json))<>6 OR json_type(NEW.accepted_result_json,'$.key') IS NOT 'null'
 OR json_extract(NEW.accepted_result_json,'$.storageKind') IS NOT 'native' OR json_type(NEW.accepted_result_json,'$.id') IS NOT 'text'
 OR json_type(NEW.accepted_result_json,'$.fileId') IS NOT 'text' OR json_extract(NEW.accepted_result_json,'$.url') IS NOT '/api/file-assets/'||json_extract(NEW.accepted_result_json,'$.id')
 OR json_type(NEW.accepted_result_json,'$.deduplicated') NOT IN('true','false')
 OR NOT EXISTS(SELECT 1 FROM file_authority_usable_candidate_results c JOIN assets a ON a.id=json_extract(NEW.accepted_result_json,'$.id')
 AND a.file_id=c.result_file_id AND a.storage_profile_id=c.storage_profile_id AND a.object_key=c.result_object_key
 AND a.r2_key IS NULL AND a.status='ready' AND a.sha256=c.expected_sha256 AND a.byte_size=c.expected_byte_size
 JOIN storage_profiles p ON p.id=a.storage_profile_id AND p.adapter_type='s3' AND p.configuration_revision=a.storage_profile_revision
 WHERE c.acceptance_kind='r2_upload' AND c.acceptance_id=NEW.id AND c.item_id='' AND c.receipt_operation_id=NEW.operation_id AND a.file_id=json_extract(NEW.accepted_result_json,'$.fileId')); END;

CREATE TRIGGER metrology_reference_upload_requests_native_publication_guard BEFORE UPDATE ON metrology_reference_upload_requests WHEN NEW.status='ready' AND EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='s3') BEGIN
 SELECT RAISE(ABORT,'Native metrology result does not match verified occurrence') WHERE
 (SELECT count(*) FROM json_each(NEW.accepted_result_json))<>3 OR (SELECT count(*) FROM json_each(NEW.accepted_result_json,'$.reference'))<>8
 OR json_type(NEW.accepted_result_json,'$.reference.assetKey') IS NOT 'null' OR json_type(NEW.accepted_result_json,'$.deduplicated') NOT IN('true','false')
 OR json_extract(NEW.accepted_result_json,'$.reference.url') IS NOT '/api/file-assets/'||json_extract(NEW.accepted_result_json,'$.assetId')
 OR NOT EXISTS(SELECT 1 FROM file_authority_usable_candidate_results c JOIN assets a ON a.id=json_extract(NEW.accepted_result_json,'$.assetId')
 AND a.file_id=c.result_file_id AND a.storage_profile_id=c.storage_profile_id AND a.object_key=c.result_object_key
 AND a.r2_key IS NULL AND a.status='ready' AND a.sha256=c.expected_sha256 AND a.byte_size=c.expected_byte_size
 JOIN storage_profiles p ON p.id=a.storage_profile_id AND p.adapter_type='s3' AND p.configuration_revision=a.storage_profile_revision
 WHERE c.acceptance_kind='metrology_reference' AND c.acceptance_id=NEW.id AND c.item_id='' AND c.receipt_operation_id=NEW.operation_id AND a.file_id=json_extract(NEW.accepted_result_json,'$.reference.fileId'))
 OR NOT EXISTS(SELECT 1 FROM metrology_template_references m JOIN assets a ON a.id=m.asset_id JOIN template_versions t ON t.id=m.template_version_id
 WHERE m.id=json_extract(NEW.accepted_result_json,'$.reference.id') AND m.template_version_id=NEW.template_version_id
 AND m.asset_id=json_extract(NEW.accepted_result_json,'$.assetId') AND m.file_id=a.file_id
 AND m.display_name=json_extract(NEW.accepted_result_json,'$.reference.filename') AND m.created_at=json_extract(NEW.accepted_result_json,'$.reference.createdAt')
 AND a.mime_type=json_extract(NEW.accepted_result_json,'$.reference.mimeType') AND a.byte_size=json_extract(NEW.accepted_result_json,'$.reference.byteSize')
 AND m.deleted_at IS NULL AND m.superseded_by_occurrence_id IS NULL AND t.template_kind='metrology' AND t.archived_at IS NULL AND t.deleted_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM imports i WHERE i.template_version_id=t.id AND i.status<>'ready')
 AND(json_extract(NEW.publication_plan_json,'$.action')='create' OR(m.id=json_extract(NEW.publication_plan_json,'$.reference.id')
 AND m.created_at=json_extract(NEW.publication_plan_json,'$.reference.createdAt') AND m.position=json_extract(NEW.publication_plan_json,'$.reference.position')
 AND m.actor_email=json_extract(NEW.publication_plan_json,'$.reference.actorEmail')))); END;

DROP TRIGGER comment_submission_acceptances_role_policy_insert_guard;

CREATE TRIGGER comment_submission_acceptances_role_policy_insert_guard BEFORE INSERT ON comment_submission_acceptances WHEN (NEW.storage_role_policy_revision<>3)
BEGIN
  SELECT RAISE(ABORT,'Active binary Comment acceptance requires recorded R2 role policy') WHERE
    EXISTS(SELECT 1 FROM json_each(NEW.request_input_json,'$.items') i WHERE json_extract(i.value,'$.kind')<>'link')
    AND (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND NEW.storage_role_policy_revision<>2;
  SELECT RAISE(ABORT,'R2 role policy requires active admitted defaults') WHERE NEW.storage_role_policy_revision=2 AND (
    NOT EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1
      WHERE a.singleton=1 AND a.mode='active') OR (SELECT count(*) FROM storage_role_defaults)<>2);
END;

CREATE TRIGGER comment_native_policy_insert_guard BEFORE INSERT ON comment_submission_acceptances WHEN NEW.storage_role_policy_revision=3 BEGIN
 SELECT RAISE(ABORT,'Comment role selection is not current') WHERE NOT EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active') OR(SELECT count(*) FROM storage_role_defaults WHERE policy_revision=NEW.role_selection_revision)<>2
 OR(SELECT count(*) FROM storage_role_policy_revisions WHERE policy_revision=NEW.role_selection_revision)<>2; END;

CREATE TRIGGER comment_native_policy_update_guard BEFORE UPDATE ON comment_submission_acceptances BEGIN SELECT RAISE(ABORT,'Comment role selection is immutable') WHERE NEW.role_selection_revision IS NOT OLD.role_selection_revision; END;

DROP TRIGGER comment_item_acceptances_insert_guard;

CREATE TRIGGER comment_item_acceptances_insert_guard BEFORE INSERT ON comment_item_acceptances
WHEN ((SELECT storage_role_policy_revision FROM comment_submission_acceptances WHERE submission_id=NEW.submission_id)<>3)
BEGIN
  SELECT CASE WHEN typeof(NEW.item_id)<>'text' OR length(NEW.item_id) NOT BETWEEN 8 AND 80 OR NEW.item_id GLOB '*[^a-zA-Z0-9_-]*' OR instr(NEW.item_id,char(0))<>0
    OR typeof(NEW.expected_sha256)<>'text' OR instr(NEW.expected_sha256,char(0))<>0
    OR typeof(NEW.candidate_blob_id)<>'text' OR length(NEW.candidate_blob_id)<>36 OR instr(NEW.candidate_blob_id,char(0))<>0 OR NEW.candidate_blob_id<>lower(NEW.candidate_blob_id)
    OR substr(NEW.candidate_blob_id,9,1)<>'-' OR substr(NEW.candidate_blob_id,14,1)<>'-' OR substr(NEW.candidate_blob_id,19,1)<>'-' OR substr(NEW.candidate_blob_id,24,1)<>'-'
    OR length(replace(NEW.candidate_blob_id,'-',''))<>32 OR replace(NEW.candidate_blob_id,'-','') GLOB '*[^0-9a-f]*' OR substr(NEW.candidate_blob_id,15,1)<>'4' OR substr(NEW.candidate_blob_id,20,1) NOT GLOB '[89ab]'
    THEN RAISE(ABORT,'Invalid Comment item acceptance identity') END ;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM comment_item_acceptances WHERE item_id = NEW.item_id OR candidate_blob_id = NEW.candidate_blob_id OR candidate_object_key = NEW.candidate_object_key)
    THEN RAISE(ABORT, 'Accepted Comment item identity is immutable') END ;
  SELECT CASE WHEN NEW.status <> 'pending' OR NEW.execution_token IS NOT NULL OR NEW.started_at IS NOT NULL OR NEW.accepted_result_json IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM comment_submission_acceptances ca JOIN comment_submission_items csi ON csi.submission_id = ca.submission_id
      JOIN storage_profiles p ON p.id = NEW.storage_profile_id
      JOIN json_each(ca.request_input_json, '$.items') item ON json_extract(item.value, '$.id') = csi.id
      WHERE ca.submission_id = NEW.submission_id AND ca.actor_email = NEW.actor_email AND ca.status = 'pending'
        AND csi.id = NEW.item_id AND csi.status = 'pending' AND csi.deleted_at IS NULL
        AND NEW.expected_sha256 IS json_extract(item.value, '$.sha256') AND NEW.expected_byte_size = csi.byte_size
        AND NEW.created_at = ca.created_at AND p.configuration_revision = NEW.storage_profile_revision AND p.state = 'historical'
        AND (ca.storage_role_policy_revision=1 OR EXISTS(SELECT 1 FROM storage_role_defaults d
          WHERE d.role= CASE WHEN csi.kind='attachment' THEN 'originals' ELSE 'internal' END
            AND d.storage_profile_id=p.id AND d.storage_profile_revision=NEW.storage_profile_revision AND d.policy_revision=2))
        AND ((csi.kind = 'comment_image' AND p.adapter_type = 'r2' AND p.configuration_source='bootstrap' AND p.credential_reference IS NULL AND NEW.expected_byte_size <= 5242880
          AND NEW.purpose = CASE WHEN csi.related_item_id IS NULL THEN 'embedded_content' ELSE 'derived_preview' END )
          OR (csi.kind = 'attachment' AND NEW.purpose = 'research_source' AND (
            (ca.storage_role_policy_revision=1 AND p.adapter_type='switchdrive' AND p.configuration_source='environment' AND p.credential_reference IS 'environment:SWITCHDRIVE')
            OR (ca.storage_role_policy_revision=2 AND p.adapter_type='r2' AND p.configuration_source='bootstrap' AND p.credential_reference IS NULL
              AND EXISTS(SELECT 1 FROM storage_role_defaults d WHERE d.role='originals' AND d.storage_profile_id=p.id AND d.storage_profile_revision=NEW.storage_profile_revision AND d.policy_revision=2))))))
    THEN RAISE(ABORT, 'Invalid Comment item acceptance') END ;
END;

CREATE TRIGGER comment_item_acceptances_native_insert_guard BEFORE INSERT ON comment_item_acceptances
 WHEN (SELECT storage_role_policy_revision FROM comment_submission_acceptances WHERE submission_id=NEW.submission_id)=3 BEGIN
 
  SELECT CASE WHEN typeof(NEW.item_id)<>'text' OR length(NEW.item_id) NOT BETWEEN 8 AND 80 OR NEW.item_id GLOB '*[^a-zA-Z0-9_-]*' OR instr(NEW.item_id,char(0))<>0
    OR typeof(NEW.expected_sha256)<>'text' OR instr(NEW.expected_sha256,char(0))<>0
    OR typeof(NEW.candidate_blob_id)<>'text' OR length(NEW.candidate_blob_id)<>36 OR instr(NEW.candidate_blob_id,char(0))<>0 OR NEW.candidate_blob_id<>lower(NEW.candidate_blob_id)
    OR substr(NEW.candidate_blob_id,9,1)<>'-' OR substr(NEW.candidate_blob_id,14,1)<>'-' OR substr(NEW.candidate_blob_id,19,1)<>'-' OR substr(NEW.candidate_blob_id,24,1)<>'-'
    OR length(replace(NEW.candidate_blob_id,'-',''))<>32 OR replace(NEW.candidate_blob_id,'-','') GLOB '*[^0-9a-f]*' OR substr(NEW.candidate_blob_id,15,1)<>'4' OR substr(NEW.candidate_blob_id,20,1) NOT GLOB '[89ab]'
    THEN RAISE(ABORT,'Invalid Comment item acceptance identity') END ;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM comment_item_acceptances WHERE item_id = NEW.item_id OR candidate_blob_id = NEW.candidate_blob_id OR candidate_object_key = NEW.candidate_object_key)
    THEN RAISE(ABORT, 'Accepted Comment item identity is immutable') END ;

 SELECT RAISE(ABORT,'Native Comment item does not match accepted purpose and target') WHERE NEW.status<>'pending' OR NEW.execution_token IS NOT NULL OR NEW.started_at IS NOT NULL OR NEW.accepted_result_json IS NOT NULL OR NOT EXISTS(
 SELECT 1 FROM comment_submission_acceptances parent JOIN comment_submission_items i ON i.submission_id=parent.submission_id
 JOIN json_each(parent.request_input_json,'$.items') input ON json_extract(input.value,'$.id')=i.id
 JOIN storage_role_policy_revisions h ON h.policy_revision=parent.role_selection_revision AND h.role=iif(i.kind='attachment','originals','internal')
 JOIN storage_profiles p ON p.id=h.storage_profile_id JOIN storage_profile_runtime r ON r.storage_profile_id=p.id AND r.state='read_write'
 WHERE parent.submission_id=NEW.submission_id AND parent.actor_email=NEW.actor_email AND parent.status='pending'
 AND i.id=NEW.item_id AND i.status='pending' AND i.deleted_at IS NULL AND i.kind<>'link'
 AND NEW.role_selection_revision=parent.role_selection_revision AND NEW.storage_profile_id=h.storage_profile_id AND NEW.storage_profile_revision=h.storage_profile_revision
 AND NEW.expected_sha256=json_extract(input.value,'$.sha256') AND NEW.expected_byte_size=i.byte_size AND NEW.created_at=parent.created_at
 AND NEW.purpose=iif(i.kind='attachment','research_source',iif(i.related_item_id IS NULL,'embedded_content','derived_preview'))
 AND(i.kind<>'comment_image' OR NEW.expected_byte_size<=5242880) AND p.adapter_type IN('r2','s3'));
END;

CREATE TRIGGER comment_item_native_policy_update_guard BEFORE UPDATE ON comment_item_acceptances BEGIN SELECT RAISE(ABORT,'Comment item role selection is immutable') WHERE NEW.role_selection_revision IS NOT OLD.role_selection_revision; END;

DROP TRIGGER comment_submission_acceptances_publication_guard;

CREATE TRIGGER comment_submission_acceptances_publication_guard BEFORE UPDATE ON comment_submission_acceptances WHEN NEW.status = 'ready'
BEGIN
  SELECT CASE WHEN NEW.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') OR NEW.accepted_result_json IS NULL
    OR (SELECT count(*) FROM comment_submission_items WHERE submission_id=NEW.submission_id) <> json_array_length(NEW.request_input_json,'$.items')
    OR (SELECT count(*) FROM run_step_comments WHERE submission_id=NEW.submission_id) <> json_array_length(NEW.publication_plan_json,'$.occurrences')
    OR (SELECT count(*) FROM events WHERE json_extract(metadata_json,'$.action')='comment_submission' AND json_extract(metadata_json,'$.submissionId')=NEW.submission_id) <> json_array_length(NEW.publication_plan_json,'$.events')
    OR (SELECT count(*) FROM json_each(NEW.accepted_result_json)) <> 5
    OR json_type(NEW.accepted_result_json,'$.submissionId') IS NOT 'text' OR json_type(NEW.accepted_result_json,'$.completedAt') IS NOT 'text'
    OR EXISTS(SELECT 1 FROM json_each(NEW.accepted_result_json,'$.itemIds') WHERE type<>'text')
    OR EXISTS(SELECT 1 FROM json_each(NEW.accepted_result_json,'$.eventIds') WHERE type<>'text')
    OR EXISTS(SELECT 1 FROM json_each(NEW.accepted_result_json,'$.occurrenceIds') WHERE type<>'text')
    OR json_extract(NEW.accepted_result_json, '$.submissionId') IS NOT NEW.submission_id
    OR json_extract(NEW.accepted_result_json, '$.completedAt') IS NOT NEW.completed_at
    OR json_type(NEW.accepted_result_json, '$.occurrenceIds') IS NOT 'array'
    OR json_type(NEW.accepted_result_json, '$.eventIds') IS NOT 'array'
    OR json_type(NEW.accepted_result_json, '$.itemIds') IS NOT 'array'
    OR json_array_length(NEW.accepted_result_json, '$.occurrenceIds') <> json_array_length(NEW.publication_plan_json, '$.occurrences')
    OR json_array_length(NEW.accepted_result_json, '$.eventIds') <> json_array_length(NEW.publication_plan_json, '$.events')
    OR EXISTS (SELECT 1 FROM json_each(NEW.publication_plan_json, '$.occurrences') p
      WHERE json_extract(NEW.accepted_result_json, '$.occurrenceIds[' || p.key || ']') IS NOT json_extract(p.value, '$.id'))
    OR EXISTS (SELECT 1 FROM json_each(NEW.publication_plan_json, '$.events') p
      WHERE json_extract(NEW.accepted_result_json, '$.eventIds[' || p.key || ']') IS NOT json_extract(p.value, '$.id'))
    OR NOT EXISTS (SELECT 1 FROM comment_submissions cs WHERE cs.id = NEW.submission_id AND cs.status = 'ready' AND cs.deleted_at IS NULL
      AND cs.actor_email = NEW.actor_email AND cs.completed_at = NEW.completed_at AND cs.updated_at = NEW.completed_at
      AND cs.last_mutation_id = json_extract(NEW.publication_plan_json, '$.mutationId')
      AND (length(trim(cs.body)) > 0 OR json_array_length(NEW.accepted_result_json, '$.itemIds') > 0))
    OR EXISTS (SELECT 1 FROM comment_submission_items csi WHERE csi.submission_id = NEW.submission_id AND csi.status NOT IN ('ready', 'cancelled'))
    OR json_array_length(NEW.accepted_result_json, '$.itemIds') <> (SELECT count(*) FROM comment_submission_items WHERE submission_id = NEW.submission_id AND status = 'ready' AND deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM json_each(NEW.accepted_result_json, '$.itemIds') x LEFT JOIN comment_submission_items csi ON csi.id=x.value AND csi.submission_id=NEW.submission_id
      WHERE csi.id IS NULL OR csi.status <> 'ready' OR csi.deleted_at IS NOT NULL OR x.key <> (SELECT count(*) FROM comment_submission_items before WHERE before.submission_id=NEW.submission_id AND before.status='ready' AND before.deleted_at IS NULL AND before.position<csi.position))
    OR EXISTS (SELECT 1 FROM comment_submission_items csi LEFT JOIN comment_item_acceptances ia ON ia.item_id = csi.id
      WHERE csi.submission_id = NEW.submission_id AND csi.kind <> 'link' AND csi.status = 'ready' AND csi.deleted_at IS NULL
        AND (ia.status IS NOT 'ready' OR ia.expected_sha256 IS NOT csi.sha256 OR ia.expected_byte_size IS NOT csi.byte_size
          OR ((csi.kind = 'comment_image' OR (csi.kind='attachment' AND NEW.storage_role_policy_revision IN(2,3))) AND NOT EXISTS (SELECT 1 FROM assets a LEFT JOIN imports i ON i.id = a.import_id
            WHERE a.id = csi.asset_id AND a.id = json_extract(ia.accepted_result_json, '$.blobRecordId') AND (a.r2_key=json_extract(ia.accepted_result_json,'$.objectKey') OR(a.r2_key IS NULL AND a.file_id=csi.file_id AND a.file_id=json_extract(ia.accepted_result_json,'$.fileId') AND a.storage_profile_id=ia.storage_profile_id AND a.object_key=json_extract(ia.accepted_result_json,'$.objectKey')))
              AND a.sha256 = ia.expected_sha256 AND a.byte_size = ia.expected_byte_size AND a.status = 'ready' AND (a.import_id IS NULL OR i.status = 'ready')))
          OR (csi.kind = 'attachment' AND NEW.storage_role_policy_revision=1 AND NOT EXISTS (SELECT 1 FROM managed_storage_objects m WHERE m.id = csi.storage_object_id
            AND m.id = json_extract(ia.accepted_result_json, '$.blobRecordId') AND m.object_key = json_extract(ia.accepted_result_json, '$.objectKey')
            AND m.sha256 = ia.expected_sha256 AND m.byte_size = ia.expected_byte_size AND m.provider = 'switchdrive' AND m.status = 'ready'))
          OR EXISTS (SELECT 1 FROM blob_gc_ledger bg WHERE bg.store_kind = json_extract(ia.accepted_result_json, '$.storeKind')
            AND bg.provider = json_extract(ia.accepted_result_json, '$.provider') AND bg.object_key = json_extract(ia.accepted_result_json, '$.objectKey') AND bg.state IN ('deleting', 'deleted'))
          OR EXISTS (SELECT 1 FROM blob_integrity_quarantine b WHERE b.store_kind = json_extract(ia.accepted_result_json, '$.storeKind')
            AND b.provider = json_extract(ia.accepted_result_json, '$.provider') AND b.object_key = json_extract(ia.accepted_result_json, '$.objectKey'))))
    OR EXISTS (SELECT 1 FROM comment_submission_items image WHERE image.submission_id = NEW.submission_id AND image.kind = 'comment_image' AND image.status = 'ready' AND image.deleted_at IS NULL
      AND (lower(trim(image.original_filename,char(9)||char(10)||char(11)||char(12)||char(13)||char(32)||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)||char(65279))) LIKE '%.tif' OR lower(trim(image.original_filename,char(9)||char(10)||char(11)||char(12)||char(13)||char(32)||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)||char(65279))) LIKE '%.tiff' OR lower(trim( CASE WHEN instr(image.original_mime_type,';')>0 THEN substr(image.original_mime_type,1,instr(image.original_mime_type,';')-1) ELSE image.original_mime_type END ,char(9)||char(10)||char(11)||char(12)||char(13)||char(32)||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)||char(65279))) IN('image/tiff','image/x-tiff'))
      AND NOT EXISTS (SELECT 1 FROM comment_submission_items original WHERE original.id = image.related_item_id AND original.submission_id = image.submission_id
        AND original.kind = 'attachment' AND original.status = 'ready' AND original.deleted_at IS NULL))
    OR EXISTS (SELECT 1 FROM json_each(NEW.publication_plan_json, '$.occurrences') p
      WHERE NOT EXISTS (SELECT 1 FROM run_step_comments rsc JOIN run_steps rs ON rs.id = rsc.run_step_id
        JOIN runs r ON r.id = rs.run_id JOIN samples s ON s.id = r.sample_id
        WHERE rsc.id = json_extract(p.value, '$.id') AND rsc.submission_id = NEW.submission_id AND rsc.deleted_at IS NULL
          AND rsc.run_step_id = json_extract(NEW.request_input_json, '$.context.targets[' || json_extract(p.value, '$.targetIndex') || '].stepId')
          AND r.id = json_extract(NEW.request_input_json, '$.context.targets[' || json_extract(p.value, '$.targetIndex') || '].runId')
          AND s.id = json_extract(NEW.request_input_json, '$.context.targets[' || json_extract(p.value, '$.targetIndex') || '].sampleId')
          AND rsc.scope = json_extract(NEW.request_input_json, '$.context.scope') AND rsc.operation_group_id IS json_extract(NEW.publication_plan_json, '$.operationGroupId')
          AND rsc.actor_email = NEW.actor_email AND rsc.created_at = NEW.completed_at
          AND rs.updated_at = NEW.completed_at AND rs.updated_by = NEW.actor_email
          AND rs.deleted_at IS NULL AND r.deleted_at IS NULL AND s.deleted_at IS NULL))
    OR EXISTS (SELECT 1 FROM json_each(NEW.publication_plan_json, '$.events') p
      WHERE NOT EXISTS (SELECT 1 FROM events e JOIN samples s ON s.id = e.sample_id
        WHERE e.id = json_extract(p.value, '$.id') AND e.sample_id = json_extract(p.value, '$.sampleId')
          AND e.kind = 'comment' AND e.actor_email = NEW.actor_email AND e.created_at = NEW.completed_at
          AND json_extract(e.metadata_json, '$.action') = 'comment_submission' AND json_extract(e.metadata_json, '$.submissionId') = NEW.submission_id
          AND s.deleted_at IS NULL AND s.updated_at = NEW.completed_at AND s.updated_by = NEW.actor_email))
    THEN RAISE(ABORT, 'Accepted Comment result does not match complete publication') END ;
END;

DROP TRIGGER comment_item_acceptances_publication_guard;

CREATE TRIGGER comment_item_acceptances_publication_guard BEFORE UPDATE ON comment_item_acceptances WHEN (NEW.status = 'ready') AND (NOT EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='s3'))
BEGIN
  SELECT CASE WHEN NEW.accepted_result_json IS NULL
    OR json_type(NEW.accepted_result_json,'$.byteSize') IS NOT 'integer'
    OR json_type(NEW.accepted_result_json,'$.storeKind') IS NOT 'text' OR json_type(NEW.accepted_result_json,'$.provider') IS NOT 'text'
    OR json_type(NEW.accepted_result_json,'$.blobRecordId') IS NOT 'text' OR length(json_extract(NEW.accepted_result_json,'$.blobRecordId')) NOT BETWEEN 1 AND 256 OR instr(json_extract(NEW.accepted_result_json,'$.blobRecordId'),char(0))<>0
    OR json_type(NEW.accepted_result_json,'$.objectKey') IS NOT 'text' OR length(json_extract(NEW.accepted_result_json,'$.objectKey')) NOT BETWEEN 1 AND 4096 OR instr(json_extract(NEW.accepted_result_json,'$.objectKey'),char(0))<>0
    OR json_type(NEW.accepted_result_json,'$.sha256') IS NOT 'text' OR length(json_extract(NEW.accepted_result_json,'$.sha256'))<>64 OR instr(json_extract(NEW.accepted_result_json,'$.sha256'),char(0))<>0
    OR json_extract(NEW.accepted_result_json, '$.sha256') IS NOT NEW.expected_sha256
    OR json_extract(NEW.accepted_result_json, '$.byteSize') IS NOT NEW.expected_byte_size
    OR (SELECT count(*) FROM json_each(NEW.accepted_result_json)) <> 7
    OR (json_type(NEW.accepted_result_json, '$.deduplicated') IS NOT 'true' AND json_type(NEW.accepted_result_json, '$.deduplicated') IS NOT 'false')
    OR (json_extract(NEW.accepted_result_json, '$.deduplicated') = 0 AND (json_extract(NEW.accepted_result_json, '$.blobRecordId') IS NOT NEW.candidate_blob_id OR json_extract(NEW.accepted_result_json, '$.objectKey') IS NOT NEW.candidate_object_key))
    OR NOT EXISTS (SELECT 1 FROM comment_submission_items csi JOIN storage_profiles p ON p.id=NEW.storage_profile_id WHERE p.adapter_type=json_extract(NEW.accepted_result_json,'$.provider') AND csi.id = NEW.item_id AND csi.submission_id = NEW.submission_id
      AND csi.status = 'ready' AND csi.deleted_at IS NULL AND csi.sha256 = NEW.expected_sha256
      AND (((csi.kind = 'comment_image' OR (csi.kind='attachment' AND EXISTS(SELECT 1 FROM comment_submission_acceptances ca WHERE ca.submission_id=NEW.submission_id AND ca.storage_role_policy_revision IN(2,3)))) AND json_extract(NEW.accepted_result_json, '$.storeKind') = 'r2' AND json_extract(NEW.accepted_result_json, '$.provider') = 'r2'
        AND EXISTS (SELECT 1 FROM assets a LEFT JOIN imports i ON i.id = a.import_id WHERE a.id = csi.asset_id
          AND a.id = json_extract(NEW.accepted_result_json, '$.blobRecordId') AND a.r2_key = json_extract(NEW.accepted_result_json, '$.objectKey')
          AND a.sha256 = NEW.expected_sha256 AND a.byte_size = NEW.expected_byte_size AND a.status = 'ready' AND (a.import_id IS NULL OR i.status = 'ready')))
        OR (csi.kind = 'attachment' AND json_extract(NEW.accepted_result_json, '$.storeKind') = 'managed' AND json_extract(NEW.accepted_result_json, '$.provider') = 'switchdrive'
          AND EXISTS (SELECT 1 FROM managed_storage_objects m WHERE m.id = csi.storage_object_id AND m.id = json_extract(NEW.accepted_result_json, '$.blobRecordId')
            AND m.object_key = json_extract(NEW.accepted_result_json, '$.objectKey') AND m.provider = 'switchdrive' AND m.status = 'ready'
            AND m.sha256 = NEW.expected_sha256 AND m.byte_size = NEW.expected_byte_size))))
    OR EXISTS (SELECT 1 FROM blob_gc_ledger WHERE store_kind = json_extract(NEW.accepted_result_json, '$.storeKind') AND provider = json_extract(NEW.accepted_result_json, '$.provider') AND object_key = json_extract(NEW.accepted_result_json, '$.objectKey') AND state IN ('deleting', 'deleted'))
    OR EXISTS (SELECT 1 FROM blob_integrity_quarantine WHERE store_kind = json_extract(NEW.accepted_result_json, '$.storeKind') AND provider = json_extract(NEW.accepted_result_json, '$.provider') AND object_key = json_extract(NEW.accepted_result_json, '$.objectKey'))
    THEN RAISE(ABORT, 'Accepted Comment item result does not match publication') END ;
END;

DROP TRIGGER comment_item_acceptances_update_guard;

CREATE TRIGGER comment_item_acceptances_update_guard BEFORE UPDATE ON comment_item_acceptances
BEGIN
  SELECT CASE WHEN NEW.execution_token IS NOT NULL AND (typeof(NEW.execution_token)<>'text' OR length(NEW.execution_token)<>36 OR instr(NEW.execution_token,char(0))<>0 OR NEW.execution_token<>lower(NEW.execution_token)
    OR substr(NEW.execution_token,9,1)<>'-' OR substr(NEW.execution_token,14,1)<>'-' OR substr(NEW.execution_token,19,1)<>'-' OR substr(NEW.execution_token,24,1)<>'-'
    OR length(replace(NEW.execution_token,'-',''))<>32 OR replace(NEW.execution_token,'-','') GLOB '*[^0-9a-f]*' OR substr(NEW.execution_token,15,1)<>'4' OR substr(NEW.execution_token,20,1) NOT GLOB '[89ab]')
    THEN RAISE(ABORT,'Invalid Comment upload execution identity') END ;
  SELECT CASE WHEN OLD.status <> 'pending'
    OR NEW.item_id IS NOT OLD.item_id OR NEW.submission_id IS NOT OLD.submission_id OR NEW.actor_email IS NOT OLD.actor_email
    OR NEW.purpose IS NOT OLD.purpose OR NEW.expected_sha256 IS NOT OLD.expected_sha256 OR NEW.expected_byte_size IS NOT OLD.expected_byte_size
    OR NEW.storage_profile_id IS NOT OLD.storage_profile_id OR NEW.storage_profile_revision IS NOT OLD.storage_profile_revision
    OR NEW.candidate_blob_id IS NOT OLD.candidate_blob_id OR NEW.candidate_object_key IS NOT OLD.candidate_object_key OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.execution_token IS NOT NULL AND (NEW.execution_token IS NOT OLD.execution_token OR NEW.started_at IS NOT OLD.started_at))
    OR (NEW.status = 'pending' AND NOT (OLD.execution_token IS NULL AND NEW.execution_token IS NOT NULL AND NEW.started_at IS NOT NULL))
    OR (NEW.status = 'ready' AND OLD.execution_token IS NULL)
    OR (NEW.status = 'cancelled' AND (NEW.execution_token IS NOT OLD.execution_token OR NEW.started_at IS NOT OLD.started_at))
    THEN RAISE(ABORT, 'Accepted Comment item operation is immutable') END ;
  SELECT CASE WHEN NEW.status = 'cancelled' AND NOT EXISTS(SELECT 1 FROM comment_submission_items csi JOIN comment_submissions cs ON cs.id=csi.submission_id
    WHERE csi.id=NEW.item_id AND csi.submission_id=NEW.submission_id AND (csi.status='cancelled' OR cs.status='cancelled'))
    THEN RAISE(ABORT,'Comment item cancellation must be fenced') END ;
  SELECT CASE WHEN NEW.status <> 'cancelled' AND NOT EXISTS (SELECT 1 FROM comment_submission_acceptances ca JOIN comment_submissions cs ON cs.id = ca.submission_id
    JOIN comment_submission_items csi ON csi.submission_id = cs.id WHERE ca.submission_id = NEW.submission_id AND csi.id = NEW.item_id
      AND ca.status = 'pending' AND cs.status NOT IN ('ready', 'cancelled') AND cs.deleted_at IS NULL AND cs.retry_closed_at IS NULL
      AND csi.status <> 'cancelled' AND csi.deleted_at IS NULL AND NEW.started_at < ca.expires_at
      AND ca.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    THEN RAISE(ABORT, 'Comment upload is fenced') END ;
END;

CREATE TRIGGER comment_item_acceptances_native_publication_guard BEFORE UPDATE ON comment_item_acceptances WHEN NEW.status='ready' AND EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='s3') BEGIN
 SELECT RAISE(ABORT,'Native Comment result does not match exact verified binding') WHERE (SELECT count(*) FROM json_each(NEW.accepted_result_json))<>11
 OR json_extract(NEW.accepted_result_json,'$.schema') IS NOT 'comment-upload/2' OR json_extract(NEW.accepted_result_json,'$.storeKind') IS NOT 'file'
 OR json_extract(NEW.accepted_result_json,'$.provider') IS NOT 's3' OR json_extract(NEW.accepted_result_json,'$.storageProfileId') IS NOT NEW.storage_profile_id
 OR json_extract(NEW.accepted_result_json,'$.storageProfileRevision') IS NOT NEW.storage_profile_revision
 OR json_extract(NEW.accepted_result_json,'$.sha256') IS NOT NEW.expected_sha256 OR json_extract(NEW.accepted_result_json,'$.byteSize') IS NOT NEW.expected_byte_size
 OR json_type(NEW.accepted_result_json,'$.deduplicated') NOT IN('true','false') OR NOT EXISTS(
 SELECT 1 FROM comment_submission_items i JOIN assets a ON a.id=i.asset_id JOIN file_authority_usable_candidate_results c ON c.result_file_id=i.file_id
 WHERE i.id=NEW.item_id AND i.submission_id=NEW.submission_id AND i.status='ready' AND i.deleted_at IS NULL AND i.storage_object_id IS NULL
 AND a.id=json_extract(NEW.accepted_result_json,'$.blobRecordId') AND a.r2_key IS NULL AND a.file_id=i.file_id AND a.file_id=json_extract(NEW.accepted_result_json,'$.fileId')
 AND a.storage_profile_id=NEW.storage_profile_id AND a.object_key=json_extract(NEW.accepted_result_json,'$.objectKey') AND a.status='ready'
 AND a.sha256=NEW.expected_sha256 AND a.byte_size=NEW.expected_byte_size AND c.acceptance_kind='comment_item' AND c.acceptance_id=NEW.item_id
 AND c.result_object_key=a.object_key); END;

DROP TRIGGER imports_acceptance_insert_guard;

CREATE TRIGGER imports_acceptance_insert_guard BEFORE INSERT ON imports
WHEN (NEW.file_targets_protocol IS NULL)
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

DROP TRIGGER imports_require_publishable_assets;

CREATE TRIGGER imports_require_publishable_assets
BEFORE UPDATE OF status ON imports
WHEN (OLD.status = 'pending' AND NEW.status = 'ready') AND (NEW.file_targets_protocol IS NULL)
BEGIN
  
  
  
  SELECT RAISE(ABORT, 'import assets are not publishable')
  WHERE OLD.template_version_id IS NULL
    OR NEW.template_version_id IS NOT OLD.template_version_id;

  
  
  
  SELECT RAISE(ABORT, 'import assets are not publishable')
  WHERE NEW.template_version_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM template_versions tv
      WHERE tv.id = NEW.template_version_id
    );

  
  
  SELECT RAISE(ABORT, 'import assets are not publishable')
  WHERE NEW.workbook_asset_key IS NULL
    OR NULLIF(TRIM(NEW.workbook_asset_key), '') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM assets a
      WHERE a.r2_key = NEW.workbook_asset_key
        AND a.sha256 IS NOT NULL
        AND (
          (a.import_id = NEW.id AND a.status IN ('pending', 'ready'))
          OR (
            a.status = 'ready'
            AND (
              a.import_id IS NULL
              OR EXISTS (
                SELECT 1 FROM imports owner
                WHERE owner.id = a.import_id AND owner.status = 'ready'
              )
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
    );

  SELECT RAISE(ABORT, 'import assets are not publishable')
  WHERE NEW.manifest_asset_key IS NULL
    OR NULLIF(TRIM(NEW.manifest_asset_key), '') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM assets a
      WHERE a.r2_key = NEW.manifest_asset_key
        AND a.sha256 IS NOT NULL
        AND (
          (a.import_id = NEW.id AND a.status IN ('pending', 'ready'))
          OR (
            a.status = 'ready'
            AND (
              a.import_id IS NULL
              OR EXISTS (
                SELECT 1 FROM imports owner
                WHERE owner.id = a.import_id AND owner.status = 'ready'
              )
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
    );

  
  
  
  
  SELECT RAISE(ABORT, 'import assets are not publishable')
  WHERE EXISTS (
    SELECT 1
    FROM fabublox_import_asset_dependencies dependency
    LEFT JOIN assets a ON a.id = dependency.asset_id
    WHERE dependency.import_id = NEW.id
      AND (
        a.id IS NULL
        OR a.sha256 IS NULL
        OR NOT (
          (a.import_id = NEW.id AND a.status IN ('pending', 'ready'))
          OR (
            a.status = 'ready'
            AND (
              a.import_id IS NULL
              OR EXISTS (
                SELECT 1 FROM imports owner
                WHERE owner.id = a.import_id AND owner.status = 'ready'
              )
            )
          )
        )
        OR EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
        OR EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
      )
  );
END;

DROP TRIGGER file_authority_import_receipt_ready_guard;

CREATE TRIGGER file_authority_import_receipt_ready_guard BEFORE UPDATE ON imports
WHEN (NEW.status='ready' AND OLD.status<>'ready' AND (SELECT mode FROM file_authority_control WHERE singleton=1)='active') AND (NEW.file_targets_protocol IS NULL)
BEGIN
  SELECT RAISE(ABORT,'Active import requires every accepted File result') WHERE NEW.client_request_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM file_authority_usable_candidate_results c JOIN template_versions t ON t.id=NEW.template_version_id
      AND t.source_file_id=c.result_file_id AND t.source_asset_key=c.result_object_key
    WHERE c.acceptance_kind='import_file' AND c.acceptance_id=NEW.id AND c.item_id='workbook'
      AND c.result_file_id=NEW.workbook_file_id AND c.result_object_key=NEW.workbook_asset_key AND c.receipt_operation_id=NEW.operation_id
  ) OR NOT EXISTS (
    SELECT 1 FROM file_authority_usable_candidate_results c WHERE c.acceptance_kind='import_file' AND c.acceptance_id=NEW.id
      AND c.item_id='manifest' AND c.result_file_id=NEW.manifest_file_id AND c.result_object_key=NEW.manifest_asset_key
      AND c.receipt_operation_id=NEW.operation_id
  ) OR EXISTS (
    SELECT 1 FROM json_each(NEW.request_input_json,'$.images') image WHERE NOT EXISTS (
      SELECT 1 FROM file_authority_usable_candidate_results c JOIN assets a ON a.r2_key=c.result_object_key
        AND a.sha256=c.expected_sha256 AND a.byte_size=c.expected_byte_size AND a.status IN('pending','ready')
        AND (a.import_id=NEW.id OR a.import_id IS NULL OR EXISTS(SELECT 1 FROM imports other WHERE other.id=a.import_id AND other.status='ready'))
      WHERE c.acceptance_kind='import_file' AND c.acceptance_id=NEW.id AND c.item_id='image:'||json_extract(image.value,'$.localId')
        AND c.receipt_operation_id=NEW.operation_id));
END;

CREATE TRIGGER imports_native_acceptance_insert_guard BEFORE INSERT ON imports WHEN NEW.file_targets_protocol=1 BEGIN
 SELECT RAISE(ABORT,'Native import receipt must begin complete and pending') WHERE NEW.client_request_id IS NULL OR NEW.request_sha256 IS NULL OR NEW.request_input_json IS NULL
 OR NEW.request_scope IS NOT 'system' OR NEW.storage_profile_id IS NOT NULL OR NEW.storage_profile_revision IS NOT NULL OR NEW.storage_policy_revision IS NOT NULL
 OR NEW.role_policy_revision IS NULL OR NEW.status<>'pending' OR NEW.accepted_result_json IS NOT NULL OR NEW.operation_id IS NULL OR NEW.actor_email IS NULL
 OR NOT EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active') OR(SELECT count(*) FROM storage_role_defaults WHERE policy_revision=NEW.role_policy_revision)<>2;
 SELECT RAISE(ABORT,'Accepted import identity conflict') WHERE EXISTS(SELECT 1 FROM imports WHERE id=NEW.id OR actor_email=NEW.actor_email AND client_request_id=NEW.client_request_id);
END;

CREATE TRIGGER imports_native_acceptance_update_guard BEFORE UPDATE ON imports BEGIN SELECT RAISE(ABORT,'Import target protocol and policy are immutable') WHERE NEW.file_targets_protocol IS NOT OLD.file_targets_protocol OR NEW.role_policy_revision IS NOT OLD.role_policy_revision; END;

CREATE TRIGGER import_file_acceptances_insert_guard BEFORE INSERT ON import_file_acceptances BEGIN
 SELECT RAISE(ABORT,'Import file target must match immutable input and role selection') WHERE NEW.status<>'pending' OR NEW.result_file_id IS NOT NULL OR NEW.result_location_id IS NOT NULL OR NEW.completed_at IS NOT NULL OR NOT EXISTS(
 SELECT 1 FROM imports parent JOIN storage_role_policy_revisions h ON h.policy_revision=parent.role_policy_revision AND h.role=iif(NEW.purpose IN('research_source','provenance'),'originals','internal')
 JOIN storage_profiles p ON p.id=h.storage_profile_id JOIN storage_profile_runtime r ON r.storage_profile_id=p.id AND r.state='read_write'
 WHERE parent.id=NEW.import_id AND parent.file_targets_protocol=1 AND parent.status='pending' AND parent.client_request_id IS NOT NULL
 AND NEW.role_policy_revision=parent.role_policy_revision AND NEW.created_at=parent.created_at AND NEW.storage_profile_id=h.storage_profile_id AND NEW.storage_profile_revision=h.storage_profile_revision
 AND((NEW.item_id IN('workbook','manifest') AND NEW.purpose='provenance' AND NEW.expected_sha256=json_extract(parent.request_input_json,'$.'||NEW.item_id||'.sha256')
 AND NEW.expected_byte_size=json_extract(parent.request_input_json,'$.'||NEW.item_id||'.byteSize'))
 OR(substr(NEW.item_id,1,6)='image:' AND NEW.purpose='embedded_content' AND EXISTS(SELECT 1 FROM json_each(parent.request_input_json,'$.images') input
 WHERE json_extract(input.value,'$.localId')=substr(NEW.item_id,7) AND json_extract(input.value,'$.sha256')=NEW.expected_sha256 AND json_extract(input.value,'$.byteSize')=NEW.expected_byte_size))));
 SELECT RAISE(ABORT,'Import file target identity conflict') WHERE EXISTS(SELECT 1 FROM import_file_acceptances WHERE import_id=NEW.import_id AND item_id=NEW.item_id OR candidate_asset_id=NEW.candidate_asset_id OR storage_profile_id=NEW.storage_profile_id AND candidate_object_key=NEW.candidate_object_key); END;

CREATE TRIGGER import_file_acceptances_update_guard BEFORE UPDATE ON import_file_acceptances BEGIN
 SELECT RAISE(ABORT,'Import file target identity is immutable') WHERE OLD.status<>'pending' OR NEW.status NOT IN('ready','cancelled')
 OR NEW.import_id IS NOT OLD.import_id OR NEW.item_id IS NOT OLD.item_id OR NEW.purpose IS NOT OLD.purpose OR NEW.storage_profile_id IS NOT OLD.storage_profile_id
 OR NEW.storage_profile_revision IS NOT OLD.storage_profile_revision OR NEW.role_policy_revision IS NOT OLD.role_policy_revision OR NEW.expected_sha256 IS NOT OLD.expected_sha256
 OR NEW.expected_byte_size IS NOT OLD.expected_byte_size OR NEW.candidate_asset_id IS NOT OLD.candidate_asset_id OR NEW.candidate_object_key IS NOT OLD.candidate_object_key OR NEW.created_at IS NOT OLD.created_at;
 SELECT RAISE(ABORT,'Import file result requires exact verified owned candidate') WHERE NEW.status='ready' AND NOT EXISTS(SELECT 1 FROM file_authority_usable_candidate_results c
 WHERE c.acceptance_kind='import_file' AND c.acceptance_id=NEW.import_id AND c.item_id=NEW.item_id AND c.result_file_id=NEW.result_file_id AND c.result_location_id=NEW.result_location_id
 AND c.purpose=NEW.purpose AND c.storage_profile_id=NEW.storage_profile_id AND c.expected_sha256=NEW.expected_sha256 AND c.expected_byte_size=NEW.expected_byte_size); END;

CREATE TRIGGER import_file_acceptances_delete_guard BEFORE DELETE ON import_file_acceptances BEGIN SELECT RAISE(ABORT,'Accepted import targets cannot be deleted'); END;

DROP VIEW file_authority_pending_receipt_items;

CREATE VIEW file_authority_pending_receipt_items AS
SELECT * FROM (
SELECT 'r2_upload' acceptance_kind,r.id acceptance_id,'' item_id,r.operation_id,
  r.purpose,r.request_scope access_scope,r.storage_profile_id,r.storage_profile_revision,
  json_extract(r.request_input_json,'$.file.byteSize') expected_byte_size,
  json_extract(r.request_input_json,'$.file.sha256') expected_sha256,
  r.candidate_object_key,r.candidate_asset_id alias_id
FROM r2_upload_requests r WHERE r.status='pending' AND r.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
UNION ALL
SELECT 'metrology_reference',r.id,'',r.operation_id,r.purpose,r.request_scope,r.storage_profile_id,r.storage_profile_revision,
  json_extract(r.request_input_json,'$.file.byteSize'),json_extract(r.request_input_json,'$.file.sha256'),r.candidate_object_key,r.candidate_asset_id
FROM metrology_reference_upload_requests r WHERE r.status='pending' AND r.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
UNION ALL
SELECT 'comment_item',r.item_id,'',p.operation_id,r.purpose,p.request_scope,r.storage_profile_id,r.storage_profile_revision,
  r.expected_byte_size,r.expected_sha256,r.candidate_object_key,r.candidate_blob_id
FROM comment_item_acceptances r JOIN comment_submission_acceptances p ON p.submission_id=r.submission_id AND p.actor_email=r.actor_email
JOIN comment_submissions cs ON cs.id=p.submission_id
JOIN comment_submission_items i ON i.id=r.item_id AND i.submission_id=r.submission_id
WHERE r.status='pending' AND p.status='pending' AND r.execution_token IS NOT NULL
  AND p.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND cs.status NOT IN ('ready','cancelled') AND cs.deleted_at IS NULL AND cs.retry_closed_at IS NULL
  AND i.status<>'cancelled' AND i.deleted_at IS NULL
)
UNION ALL
SELECT * FROM (
SELECT 'import_file',r.id,'workbook',r.operation_id,json_extract(r.request_input_json,'$.workbook.purpose'),
  r.request_scope,r.storage_profile_id,r.storage_profile_revision,json_extract(r.request_input_json,'$.workbook.byteSize'),
  json_extract(r.request_input_json,'$.workbook.sha256'),NULL,NULL
FROM imports r WHERE r.client_request_id IS NOT NULL AND r.file_targets_protocol IS NULL AND r.status='pending' AND r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
UNION ALL
SELECT 'import_file',r.id,'manifest',r.operation_id,json_extract(r.request_input_json,'$.manifest.purpose'),
  r.request_scope,r.storage_profile_id,r.storage_profile_revision,json_extract(r.request_input_json,'$.manifest.byteSize'),
  json_extract(r.request_input_json,'$.manifest.sha256'),NULL,NULL
FROM imports r WHERE r.client_request_id IS NOT NULL AND r.file_targets_protocol IS NULL AND r.status='pending' AND r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
UNION ALL
SELECT 'import_file',r.id,'image:'||json_extract(i.value,'$.localId'),r.operation_id,json_extract(i.value,'$.purpose'),
  r.request_scope,r.storage_profile_id,r.storage_profile_revision,json_extract(i.value,'$.byteSize'),json_extract(i.value,'$.sha256'),NULL,NULL
FROM imports r JOIN json_each(r.request_input_json,'$.images') i
WHERE r.client_request_id IS NOT NULL AND r.file_targets_protocol IS NULL AND r.status='pending' AND r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
)
UNION ALL
SELECT 'import_file',parent.id,target.item_id,parent.operation_id,target.purpose,parent.request_scope,target.storage_profile_id,target.storage_profile_revision,
 target.expected_byte_size,target.expected_sha256,target.candidate_object_key,target.candidate_asset_id FROM imports parent JOIN import_file_acceptances target ON target.import_id=parent.id
 WHERE parent.file_targets_protocol=1 AND parent.status='pending' AND parent.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND target.status IN('pending','ready') AND(SELECT count(*) FROM import_file_acceptances complete WHERE complete.import_id=parent.id)=2+json_array_length(parent.request_input_json,'$.images');

DROP VIEW file_authority_ready_candidate_aliases;

CREATE VIEW file_authority_ready_candidate_aliases AS
SELECT c.*,l.object_key result_object_key,p.adapter_type,
  CASE c.acceptance_kind
    WHEN 'r2_upload' THEN (SELECT r.candidate_asset_id FROM r2_upload_requests r WHERE r.id=c.acceptance_id AND r.status IN('pending','ready'))
    WHEN 'metrology_reference' THEN (SELECT r.candidate_asset_id FROM metrology_reference_upload_requests r WHERE r.id=c.acceptance_id AND r.status IN('pending','ready'))
    WHEN 'import_file' THEN (SELECT target.candidate_asset_id FROM import_file_acceptances target WHERE target.import_id=c.acceptance_id AND target.item_id=c.item_id AND target.status IN('pending','ready'))
 WHEN 'comment_item' THEN (SELECT r.candidate_blob_id FROM comment_item_acceptances r WHERE r.item_id=c.acceptance_id AND r.status IN('pending','ready')) END alias_id
FROM file_acceptance_candidates c JOIN file_usable_publications f ON f.file_id=c.result_file_id
  AND f.active_location_id=c.result_location_id AND f.purpose=c.purpose AND f.access_scope=c.access_scope
  AND f.verified_byte_size=c.expected_byte_size AND f.verified_sha256=c.expected_sha256
JOIN file_location_publications l ON l.location_id=c.result_location_id AND l.file_id=c.result_file_id
  AND l.storage_profile_id=c.storage_profile_id AND l.verified_byte_size=c.expected_byte_size AND l.verified_sha256=c.expected_sha256
JOIN storage_profiles p ON p.id=c.storage_profile_id
WHERE c.state='ready' AND (c.acceptance_kind<>'import_file' OR EXISTS(
  SELECT 1 FROM imports r WHERE r.id=c.acceptance_id AND r.status IN('pending','ready') AND r.client_request_id IS NOT NULL));

DROP TRIGGER file_acceptance_candidates_receipt_guard;

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
        AND i.request_scope IS NEW.access_scope AND((i.file_targets_protocol IS NULL AND i.storage_profile_id IS NEW.storage_profile_id)
 OR(i.file_targets_protocol=1 AND EXISTS(SELECT 1 FROM import_file_acceptances target WHERE target.import_id=i.id AND target.item_id=NEW.item_id AND target.status='pending'
 AND target.storage_profile_id=NEW.storage_profile_id AND target.purpose=NEW.purpose AND target.expected_sha256=NEW.expected_sha256 AND target.expected_byte_size=NEW.expected_byte_size AND target.candidate_object_key=NEW.candidate_object_key)))
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

CREATE TRIGGER imports_native_publication_guard BEFORE UPDATE ON imports WHEN NEW.file_targets_protocol=1 AND NEW.status='ready' AND OLD.status<>'ready' BEGIN
 SELECT RAISE(ABORT,'Native import requires every frozen File result') WHERE (SELECT count(*) FROM import_file_acceptances WHERE import_id=NEW.id)<>2+json_array_length(NEW.request_input_json,'$.images')
 OR EXISTS(SELECT 1 FROM import_file_acceptances target WHERE target.import_id=NEW.id AND(target.status<>'ready' OR NOT EXISTS(
 SELECT 1 FROM file_authority_usable_candidate_results c WHERE c.acceptance_kind='import_file' AND c.acceptance_id=NEW.id AND c.item_id=target.item_id AND c.result_file_id=target.result_file_id AND c.result_location_id=target.result_location_id)))
 OR NOT EXISTS(SELECT 1 FROM import_file_acceptances target JOIN template_versions t ON t.id=NEW.template_version_id WHERE target.import_id=NEW.id AND target.item_id='workbook'
 AND target.result_file_id=NEW.workbook_file_id AND t.source_file_id=target.result_file_id)
 OR NOT EXISTS(SELECT 1 FROM import_file_acceptances target WHERE target.import_id=NEW.id AND target.item_id='manifest' AND target.result_file_id=NEW.manifest_file_id)
 OR(NEW.workbook_asset_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM import_file_acceptances target JOIN file_locations l ON l.id=target.result_location_id JOIN storage_profiles p ON p.id=l.storage_profile_id
 WHERE target.import_id=NEW.id AND target.item_id='workbook' AND p.adapter_type='r2' AND l.object_key=NEW.workbook_asset_key))
 OR(NEW.manifest_asset_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM import_file_acceptances target JOIN file_locations l ON l.id=target.result_location_id JOIN storage_profiles p ON p.id=l.storage_profile_id
 WHERE target.import_id=NEW.id AND target.item_id='manifest' AND p.adapter_type='r2' AND l.object_key=NEW.manifest_asset_key)); END;

CREATE TRIGGER imports_native_protocol_insert_guard BEFORE INSERT ON imports BEGIN SELECT RAISE(ABORT,'Import target format requires exact policy fields')
 WHERE(NEW.file_targets_protocol IS NULL AND NEW.role_policy_revision IS NOT NULL) OR(NEW.file_targets_protocol=1 AND NEW.role_policy_revision IS NULL); END;

CREATE TRIGGER comment_item_native_format_insert_guard BEFORE INSERT ON comment_item_acceptances BEGIN SELECT RAISE(ABORT,'Comment item selection format mismatch') WHERE
 ((SELECT storage_role_policy_revision FROM comment_submission_acceptances WHERE submission_id=NEW.submission_id)<>3 AND NEW.role_selection_revision IS NOT NULL); END;

CREATE TRIGGER file_native_runtime_generation_complete BEFORE INSERT ON storage_profile_activations BEGIN
 SELECT RAISE(ABORT,'Native File runtime generation is incomplete') WHERE
 (SELECT count(*) FROM pragma_table_info('assets') WHERE name IN('file_id','storage_profile_id','storage_profile_revision','object_key'))<>4
 OR(SELECT count(*) FROM pragma_table_info('imports') WHERE name IN('file_targets_protocol','role_policy_revision'))<>2
 OR NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='import_file_acceptances')
 OR NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='storage_role_policy_revisions')
 OR NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='system_storage_native_bindings')
 OR(SELECT count(*) FROM sqlite_schema WHERE type='trigger' AND name IN('assets_native_insert_guard','imports_native_publication_guard','comment_item_acceptances_native_publication_guard','system_storage_native_bindings_insert_guard'))<>4;
END;

-- Referenced-parent rebuilds leave SQLite's deferred counter nonzero even
-- after their exact keys are restored. Assert every actual foreign key before
-- clearing that counter; this assertion must precede the reset.
SELECT iif(EXISTS(SELECT 1 FROM pragma_foreign_key_check),
 json('Native File migration found a foreign key violation'),1);

PRAGMA defer_foreign_keys=OFF;

DROP VIEW file_relational_retention_edges;

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
  AND (rsa.deleted_at IS NULL OR julianday(rsa.deleted_at, '+1 day') > julianday('now'))

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
FROM state_verifications sv WHERE sv.evidence_file_id IS NOT NULL
  AND NOT (EXISTS (SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active') AND EXISTS (SELECT 1 FROM events detached_event
  WHERE detached_event.kind='verification' AND detached_event.sample_id=sv.sample_id
    AND detached_event.asset_file_id=sv.evidence_file_id
    AND (detached_event.asset_key=(SELECT a.r2_key FROM assets a WHERE a.id=sv.evidence_asset_id) OR (
 detached_event.asset_key IS NULL AND iif(json_valid(detached_event.metadata_json),EXISTS(
   SELECT 1 FROM assets native_asset WHERE native_asset.id=sv.evidence_asset_id
     AND native_asset.r2_key IS NULL AND native_asset.file_id=sv.evidence_file_id
     AND json_extract(detached_event.metadata_json,'$.assetId')=native_asset.id
 ),0)))
    AND CASE WHEN json_valid(detached_event.metadata_json) THEN
      json_extract(detached_event.metadata_json,'$.verificationId')=sv.id
      AND json_type(detached_event.metadata_json,'$.assetDeletionOperationId')='text'
      AND length(json_extract(detached_event.metadata_json,'$.assetDeletionOperationId'))>0
      AND CASE WHEN json_valid(detached_event.metadata_json) THEN ((json_type(detached_event.metadata_json,'$.assetDeletedAt')='text' AND length(json_extract(detached_event.metadata_json,'$.assetDeletedAt'))>0)) ELSE 0 END
      ELSE 0 END ));
