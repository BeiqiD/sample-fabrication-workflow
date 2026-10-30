-- RT3 local-volume profiles, paired portable-runtime/v26 only.
-- Historical registration never attaches a disk, activates a provider, selects
-- defaults, enables execution or grants identity/resource authority.
-- The trusted installer owns the enclosing atomic transaction and keeps FK ON.
-- Rebuild follows reviewed0017: preserve every hidden rowid/cell and do not fire
-- copy-time registry/runtime/dependency triggers. No writable_schema/FK OFF.
PRAGMA defer_foreign_keys=ON;
PRAGMA legacy_alter_table=ON;
CREATE TABLE storage_profiles_local_next (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 256 AND instr(id, char(0)) = 0),
  adapter_type TEXT NOT NULL CHECK (adapter_type IN ('r2', 'switchdrive', 's3', 'local')),
  namespace_identity TEXT NOT NULL CHECK (length(namespace_identity) BETWEEN 1 AND 2048 AND instr(namespace_identity, char(0)) = 0),
  configuration_source TEXT NOT NULL CHECK (configuration_source IN ('bootstrap', 'environment', 'system', 'installation')),
  credential_reference TEXT CHECK (credential_reference IS NULL OR credential_reference = 'environment:SWITCHDRIVE'),
  configuration_revision INTEGER NOT NULL CHECK (typeof(configuration_revision) = 'integer' AND configuration_revision = 1),
  state TEXT NOT NULL CHECK (state = 'historical'),
  created_at TEXT NOT NULL,
  UNIQUE (adapter_type, namespace_identity),
  CHECK ((adapter_type = 'r2' AND configuration_source = 'bootstrap' AND credential_reference IS NULL)
    OR (adapter_type = 'switchdrive' AND configuration_source = 'environment' AND credential_reference IS 'environment:SWITCHDRIVE')
    OR (adapter_type = 's3' AND configuration_source = 'system' AND credential_reference IS NULL)
    OR (adapter_type = 'local' AND configuration_source = 'installation' AND credential_reference IS NULL))
);

INSERT INTO storage_profiles_local_next(rowid,id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at)
SELECT rowid,id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at FROM storage_profiles;
DROP TABLE storage_profiles;
ALTER TABLE storage_profiles_local_next RENAME TO storage_profiles;
PRAGMA legacy_alter_table=OFF;

-- Exact ten attached V25 objects, including S3-only identity/rowid/runtime guards.
CREATE INDEX file_shadow_dependency_storage_profiles_key_idx ON storage_profiles(json_array( CASE WHEN typeof(id)='blob' THEN json_object('$sqliteBlob',hex(id)) ELSE id END ));

CREATE TRIGGER file_shadow_epoch_storage_profiles_delete AFTER DELETE ON storage_profiles BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1; INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT 'storage_profiles',json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ),COALESCE((SELECT MAX(v.revision) FROM file_shadow_dependency_versions v WHERE v.dependency_kind='storage_profiles' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )),0)+1,1,json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'adapter_type', CASE WHEN typeof(x.adapter_type)='blob' THEN json_object('$sqliteBlob',hex(x.adapter_type)) ELSE x.adapter_type END ,'namespace_identity', CASE WHEN typeof(x.namespace_identity)='blob' THEN json_object('$sqliteBlob',hex(x.namespace_identity)) ELSE x.namespace_identity END ,'configuration_source', CASE WHEN typeof(x.configuration_source)='blob' THEN json_object('$sqliteBlob',hex(x.configuration_source)) ELSE x.configuration_source END ,'configuration_revision', CASE WHEN typeof(x.configuration_revision)='blob' THEN json_object('$sqliteBlob',hex(x.configuration_revision)) ELSE x.configuration_revision END ,'state', CASE WHEN typeof(x.state)='blob' THEN json_object('$sqliteBlob',hex(x.state)) ELSE x.state END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END )
  FROM storage_profiles x WHERE NOT EXISTS(SELECT 1 FROM file_shadow_dependency_versions v WHERE v.dependency_kind='storage_profiles' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ) AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key) AND v.present=1 AND v.snapshot_json IS json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'adapter_type', CASE WHEN typeof(x.adapter_type)='blob' THEN json_object('$sqliteBlob',hex(x.adapter_type)) ELSE x.adapter_type END ,'namespace_identity', CASE WHEN typeof(x.namespace_identity)='blob' THEN json_object('$sqliteBlob',hex(x.namespace_identity)) ELSE x.namespace_identity END ,'configuration_source', CASE WHEN typeof(x.configuration_source)='blob' THEN json_object('$sqliteBlob',hex(x.configuration_source)) ELSE x.configuration_source END ,'configuration_revision', CASE WHEN typeof(x.configuration_revision)='blob' THEN json_object('$sqliteBlob',hex(x.configuration_revision)) ELSE x.configuration_revision END ,'state', CASE WHEN typeof(x.state)='blob' THEN json_object('$sqliteBlob',hex(x.state)) ELSE x.state END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END ));
  INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT v.dependency_kind,v.dependency_key,v.revision+1,0,'null' FROM file_shadow_dependency_versions v
  WHERE v.dependency_kind='storage_profiles' AND v.present=1 AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key)
  AND NOT EXISTS(SELECT 1 FROM storage_profiles x WHERE json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )=v.dependency_key); INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
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

CREATE TRIGGER file_shadow_epoch_storage_profiles_insert AFTER INSERT ON storage_profiles BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1; INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT 'storage_profiles',json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ),COALESCE((SELECT MAX(v.revision) FROM file_shadow_dependency_versions v WHERE v.dependency_kind='storage_profiles' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )),0)+1,1,json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'adapter_type', CASE WHEN typeof(x.adapter_type)='blob' THEN json_object('$sqliteBlob',hex(x.adapter_type)) ELSE x.adapter_type END ,'namespace_identity', CASE WHEN typeof(x.namespace_identity)='blob' THEN json_object('$sqliteBlob',hex(x.namespace_identity)) ELSE x.namespace_identity END ,'configuration_source', CASE WHEN typeof(x.configuration_source)='blob' THEN json_object('$sqliteBlob',hex(x.configuration_source)) ELSE x.configuration_source END ,'configuration_revision', CASE WHEN typeof(x.configuration_revision)='blob' THEN json_object('$sqliteBlob',hex(x.configuration_revision)) ELSE x.configuration_revision END ,'state', CASE WHEN typeof(x.state)='blob' THEN json_object('$sqliteBlob',hex(x.state)) ELSE x.state END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END )
  FROM storage_profiles x WHERE NOT EXISTS(SELECT 1 FROM file_shadow_dependency_versions v WHERE v.dependency_kind='storage_profiles' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ) AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key) AND v.present=1 AND v.snapshot_json IS json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'adapter_type', CASE WHEN typeof(x.adapter_type)='blob' THEN json_object('$sqliteBlob',hex(x.adapter_type)) ELSE x.adapter_type END ,'namespace_identity', CASE WHEN typeof(x.namespace_identity)='blob' THEN json_object('$sqliteBlob',hex(x.namespace_identity)) ELSE x.namespace_identity END ,'configuration_source', CASE WHEN typeof(x.configuration_source)='blob' THEN json_object('$sqliteBlob',hex(x.configuration_source)) ELSE x.configuration_source END ,'configuration_revision', CASE WHEN typeof(x.configuration_revision)='blob' THEN json_object('$sqliteBlob',hex(x.configuration_revision)) ELSE x.configuration_revision END ,'state', CASE WHEN typeof(x.state)='blob' THEN json_object('$sqliteBlob',hex(x.state)) ELSE x.state END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END ));
  INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT v.dependency_kind,v.dependency_key,v.revision+1,0,'null' FROM file_shadow_dependency_versions v
  WHERE v.dependency_kind='storage_profiles' AND v.present=1 AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key)
  AND NOT EXISTS(SELECT 1 FROM storage_profiles x WHERE json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )=v.dependency_key); INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
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

CREATE TRIGGER file_shadow_epoch_storage_profiles_update AFTER UPDATE ON storage_profiles BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1; INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT 'storage_profiles',json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ),COALESCE((SELECT MAX(v.revision) FROM file_shadow_dependency_versions v WHERE v.dependency_kind='storage_profiles' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )),0)+1,1,json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'adapter_type', CASE WHEN typeof(x.adapter_type)='blob' THEN json_object('$sqliteBlob',hex(x.adapter_type)) ELSE x.adapter_type END ,'namespace_identity', CASE WHEN typeof(x.namespace_identity)='blob' THEN json_object('$sqliteBlob',hex(x.namespace_identity)) ELSE x.namespace_identity END ,'configuration_source', CASE WHEN typeof(x.configuration_source)='blob' THEN json_object('$sqliteBlob',hex(x.configuration_source)) ELSE x.configuration_source END ,'configuration_revision', CASE WHEN typeof(x.configuration_revision)='blob' THEN json_object('$sqliteBlob',hex(x.configuration_revision)) ELSE x.configuration_revision END ,'state', CASE WHEN typeof(x.state)='blob' THEN json_object('$sqliteBlob',hex(x.state)) ELSE x.state END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END )
  FROM storage_profiles x WHERE NOT EXISTS(SELECT 1 FROM file_shadow_dependency_versions v WHERE v.dependency_kind='storage_profiles' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ) AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key) AND v.present=1 AND v.snapshot_json IS json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'adapter_type', CASE WHEN typeof(x.adapter_type)='blob' THEN json_object('$sqliteBlob',hex(x.adapter_type)) ELSE x.adapter_type END ,'namespace_identity', CASE WHEN typeof(x.namespace_identity)='blob' THEN json_object('$sqliteBlob',hex(x.namespace_identity)) ELSE x.namespace_identity END ,'configuration_source', CASE WHEN typeof(x.configuration_source)='blob' THEN json_object('$sqliteBlob',hex(x.configuration_source)) ELSE x.configuration_source END ,'configuration_revision', CASE WHEN typeof(x.configuration_revision)='blob' THEN json_object('$sqliteBlob',hex(x.configuration_revision)) ELSE x.configuration_revision END ,'state', CASE WHEN typeof(x.state)='blob' THEN json_object('$sqliteBlob',hex(x.state)) ELSE x.state END ,'created_at', CASE WHEN typeof(x.created_at)='blob' THEN json_object('$sqliteBlob',hex(x.created_at)) ELSE x.created_at END ));
  INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT v.dependency_kind,v.dependency_key,v.revision+1,0,'null' FROM file_shadow_dependency_versions v
  WHERE v.dependency_kind='storage_profiles' AND v.present=1 AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key)
  AND NOT EXISTS(SELECT 1 FROM storage_profiles x WHERE json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )=v.dependency_key); INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
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

CREATE TRIGGER storage_profile_runtime_seed
AFTER INSERT ON storage_profiles BEGIN
  INSERT INTO storage_profile_runtime (storage_profile_id, state, registered_at, activated_at, retired_at)
  VALUES (NEW.id, 'read_only', NEW.created_at, NULL, NULL);
END;

CREATE TRIGGER storage_profiles_delete_guard
BEFORE DELETE ON storage_profiles BEGIN
  SELECT RAISE(ABORT, 'FP1 overlap observations cannot be deleted');
END;

CREATE TRIGGER storage_profiles_immutable
BEFORE UPDATE ON storage_profiles BEGIN
  SELECT RAISE(ABORT, 'FP1 overlap profiles are immutable; namespace changes require a new identity');
END;

CREATE TRIGGER storage_profiles_insert_identity_guard
BEFORE INSERT ON storage_profiles BEGIN
  SELECT RAISE(IGNORE) WHERE EXISTS (SELECT 1 FROM storage_profiles WHERE id IS NEW.id AND adapter_type IS NEW.adapter_type AND namespace_identity IS NEW.namespace_identity AND configuration_source IS NEW.configuration_source AND credential_reference IS NEW.credential_reference AND configuration_revision IS NEW.configuration_revision AND state IS NEW.state AND created_at IS NEW.created_at);
  SELECT RAISE(ABORT, 'FP1 immutable identity conflict')
  WHERE EXISTS (SELECT 1 FROM storage_profiles WHERE id = NEW.id OR (adapter_type = NEW.adapter_type AND namespace_identity = NEW.namespace_identity));
END;

CREATE TRIGGER storage_profiles_native_identity_guard BEFORE INSERT ON storage_profiles
WHEN NEW.adapter_type='s3' BEGIN
  SELECT RAISE(ABORT,'Invalid native AWS namespace') WHERE
    json_valid(NEW.namespace_identity)<>1
    OR json_type(NEW.namespace_identity) IS NOT 'object'
    OR (SELECT count(*) FROM json_each(NEW.namespace_identity))<>5
    OR json_extract(NEW.namespace_identity,'$.kind') IS NOT 'aws-s3'
    OR json_extract(NEW.namespace_identity,'$.partition') IS NOT 'aws'
    OR json_type(NEW.namespace_identity,'$.accountId') IS NOT 'text'
    OR length(json_extract(NEW.namespace_identity,'$.accountId'))<>12
    OR json_extract(NEW.namespace_identity,'$.accountId') GLOB '*[^0-9]*'
    OR json_type(NEW.namespace_identity,'$.bucketName') IS NOT 'text'
    OR length(json_extract(NEW.namespace_identity,'$.bucketName')) NOT BETWEEN 3 AND 63
    OR json_extract(NEW.namespace_identity,'$.bucketName') GLOB '*[^a-z0-9.-]*'
    OR substr(json_extract(NEW.namespace_identity,'$.bucketName'),1,1) NOT GLOB '[a-z0-9]'
    OR substr(json_extract(NEW.namespace_identity,'$.bucketName'),-1) NOT GLOB '[a-z0-9]'
    OR instr(json_extract(NEW.namespace_identity,'$.bucketName'),'..')<>0
    OR (json_extract(NEW.namespace_identity,'$.bucketName') NOT GLOB '*[^0-9.]*'
      AND length(json_extract(NEW.namespace_identity,'$.bucketName'))-length(replace(json_extract(NEW.namespace_identity,'$.bucketName'),'.',''))=3)
    OR json_extract(NEW.namespace_identity,'$.bucketName') GLOB 'xn--*'
    OR json_extract(NEW.namespace_identity,'$.bucketName') GLOB 'sthree-*'
    OR json_extract(NEW.namespace_identity,'$.bucketName') GLOB 'amzn-s3-demo-*'
    OR json_extract(NEW.namespace_identity,'$.bucketName') GLOB '*-s3alias'
    OR json_extract(NEW.namespace_identity,'$.bucketName') GLOB '*--ol-s3'
    OR json_extract(NEW.namespace_identity,'$.bucketName') GLOB '*.mrap'
    OR json_extract(NEW.namespace_identity,'$.bucketName') GLOB '*--x-s3'
    OR json_extract(NEW.namespace_identity,'$.bucketName') GLOB '*--table-s3'
    OR json_type(NEW.namespace_identity,'$.root') IS NOT 'text'
    OR length(json_extract(NEW.namespace_identity,'$.root'))>1024
    OR instr(json_extract(NEW.namespace_identity,'$.root'),char(0))<>0
    OR json_extract(NEW.namespace_identity,'$.root') GLOB '*['||char(1)||'-'||char(31)||char(127)||']*'
    OR instr(json_extract(NEW.namespace_identity,'$.root'),'\')<>0
    OR (json_extract(NEW.namespace_identity,'$.root')<>'' AND instr('/'||json_extract(NEW.namespace_identity,'$.root')||'/','//')<>0)
    OR instr('/'||json_extract(NEW.namespace_identity,'$.root')||'/','/./')<>0
    OR instr('/'||json_extract(NEW.namespace_identity,'$.root')||'/','/../')<>0
    OR NEW.namespace_identity IS NOT json_object('kind','aws-s3','partition','aws',
      'accountId',json_extract(NEW.namespace_identity,'$.accountId'),'bucketName',json_extract(NEW.namespace_identity,'$.bucketName'),
      'root',json_extract(NEW.namespace_identity,'$.root'))
    OR substr(NEW.id,1,23)<>'storage-profile:aws-s3:' OR length(NEW.id)<>87
    OR substr(NEW.id,24) GLOB '*[^0-9a-f]*';
END;

CREATE TRIGGER storage_profiles_rowid_claim_guard
AFTER INSERT ON storage_profiles BEGIN
  SELECT RAISE(ABORT, 'FP1 immutable registry identity cannot reuse a claimed rowid')
  WHERE EXISTS (
    SELECT 1 FROM file_registry_rowid_claims
    WHERE registry_name = 'storage_profiles' AND claimed_rowid = NEW.rowid
  );
  INSERT INTO file_registry_rowid_claims (registry_name, claimed_rowid)
  VALUES ('storage_profiles', NEW.rowid);
END;

-- RT3 local-volume V26: historical registration is not provider admission.
-- This fragment is authored privately; the complete paired migration is built
-- from exact reviewed V25 objects without running a schema generator/database.

CREATE TABLE local_storage_profile_registrations (
  storage_profile_id TEXT PRIMARY KEY REFERENCES storage_profiles(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id)=36 AND operation_id=lower(operation_id)
    AND substr(operation_id,9,1)='-' AND substr(operation_id,14,1)='-' AND substr(operation_id,19,1)='-' AND substr(operation_id,24,1)='-'
    AND length(replace(operation_id,'-',''))=32 AND replace(operation_id,'-','') NOT GLOB '*[^0-9a-f]*'
    AND substr(operation_id,15,1)='4' AND substr(operation_id,20,1) GLOB '[89ab]'),
  namespace_sha256 TEXT NOT NULL CHECK(length(namespace_sha256)=64 AND namespace_sha256 NOT GLOB '*[^0-9a-f]*'),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 254 AND instr(actor,char(0))=0),
  created_at TEXT NOT NULL CHECK(created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',created_at))
) STRICT, WITHOUT ROWID;

CREATE TABLE local_storage_profile_activations (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=36 AND operation_id=lower(operation_id)
    AND substr(operation_id,9,1)='-' AND substr(operation_id,14,1)='-' AND substr(operation_id,19,1)='-' AND substr(operation_id,24,1)='-'
    AND length(replace(operation_id,'-',''))=32 AND replace(operation_id,'-','') NOT GLOB '*[^0-9a-f]*'
    AND substr(operation_id,15,1)='4' AND substr(operation_id,20,1) GLOB '[89ab]'),
  storage_profile_id TEXT NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
  configuration_revision INTEGER NOT NULL CHECK(configuration_revision=1),
  action TEXT NOT NULL CHECK(action IN('activate','retire')),
  -- Provenance only: excluded destination-local admissions are never an FK.
  admission_operation_id TEXT CHECK(admission_operation_id IS NULL OR(length(admission_operation_id)=36 AND admission_operation_id=lower(admission_operation_id)
    AND substr(admission_operation_id,9,1)='-' AND substr(admission_operation_id,14,1)='-' AND substr(admission_operation_id,19,1)='-' AND substr(admission_operation_id,24,1)='-'
    AND length(replace(admission_operation_id,'-',''))=32 AND replace(admission_operation_id,'-','') NOT GLOB '*[^0-9a-f]*'
    AND substr(admission_operation_id,15,1)='4' AND substr(admission_operation_id,20,1) GLOB '[89ab]')),
  binding_revision INTEGER NOT NULL CHECK(binding_revision BETWEEN 0 AND 9007199254740991),
  namespace_sha256 TEXT NOT NULL CHECK(length(namespace_sha256)=64 AND namespace_sha256 NOT GLOB '*[^0-9a-f]*'),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 254 AND instr(actor,char(0))=0),
  created_at TEXT NOT NULL CHECK(created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',created_at)),
  CHECK(action='retire' OR(admission_operation_id IS NOT NULL AND binding_revision>=1))
) STRICT, WITHOUT ROWID;
CREATE INDEX local_storage_profile_activation_history ON local_storage_profile_activations(storage_profile_id,created_at,operation_id);

CREATE TABLE local_storage_profile_checks (
  id TEXT PRIMARY KEY CHECK(length(id)=36 AND id=lower(id)
    AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-'
    AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'
    AND substr(id,15,1)='4' AND substr(id,20,1) GLOB '[89ab]'),
  storage_profile_id TEXT NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
  configuration_revision INTEGER NOT NULL CHECK(configuration_revision=1),
  installation_id TEXT NOT NULL,
  root_binding_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK(binding_revision BETWEEN 1 AND 9007199254740991),
  namespace_sha256 TEXT NOT NULL CHECK(length(namespace_sha256)=64 AND namespace_sha256 NOT GLOB '*[^0-9a-f]*'),
  binding_fingerprint_sha256 TEXT NOT NULL CHECK(length(binding_fingerprint_sha256)=64 AND binding_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'),
  access TEXT NOT NULL CHECK(access IN('read_only','read_write')),
  state TEXT NOT NULL CHECK(state IN('checking','passed','failed')),
  probe_object_key TEXT NOT NULL CHECK(probe_object_key='local-profile-check/'||id),
  probe_sha256 TEXT NOT NULL CHECK(length(probe_sha256)=64 AND probe_sha256 NOT GLOB '*[^0-9a-f]*'),
  probe_byte_size INTEGER NOT NULL CHECK(probe_byte_size BETWEEN 1 AND 65536),
  stat_verified INTEGER NOT NULL CHECK(stat_verified IN(0,1)),
  read_verified INTEGER NOT NULL CHECK(read_verified IN(0,1)),
  write_verified INTEGER NOT NULL CHECK(write_verified IN(0,1)),
  delete_verified INTEGER NOT NULL CHECK(delete_verified IN(0,1)),
  cleanup_complete INTEGER NOT NULL CHECK(cleanup_complete IN(0,1)),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 254 AND instr(actor,char(0))=0),
  created_at TEXT NOT NULL CHECK(created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',created_at)),
  completed_at TEXT CHECK(completed_at IS NULL OR(completed_at IS strftime('%Y-%m-%dT%H:%M:%fZ',completed_at) AND completed_at>=created_at)),
  CHECK((state='checking' AND completed_at IS NULL AND stat_verified=0 AND read_verified=0 AND write_verified=0 AND delete_verified=0 AND cleanup_complete=0)
    OR(state='passed' AND completed_at IS NOT NULL AND stat_verified=1 AND read_verified=1 AND write_verified=1 AND delete_verified=1 AND cleanup_complete=1)
    OR(state='failed' AND completed_at IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX local_storage_profile_checks_current ON local_storage_profile_checks(storage_profile_id,binding_id,binding_revision,created_at);

CREATE TABLE local_storage_profile_admissions (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=36 AND operation_id=lower(operation_id)
    AND substr(operation_id,9,1)='-' AND substr(operation_id,14,1)='-' AND substr(operation_id,19,1)='-' AND substr(operation_id,24,1)='-'
    AND length(replace(operation_id,'-',''))=32 AND replace(operation_id,'-','') NOT GLOB '*[^0-9a-f]*'
    AND substr(operation_id,15,1)='4' AND substr(operation_id,20,1) GLOB '[89ab]'),
  storage_profile_id TEXT NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
  configuration_revision INTEGER NOT NULL CHECK(configuration_revision=1),
  installation_id TEXT NOT NULL,
  root_binding_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK(binding_revision BETWEEN 1 AND 9007199254740991),
  check_id TEXT NOT NULL REFERENCES local_storage_profile_checks(id) ON DELETE RESTRICT,
  namespace_sha256 TEXT NOT NULL CHECK(length(namespace_sha256)=64 AND namespace_sha256 NOT GLOB '*[^0-9a-f]*'),
  binding_fingerprint_sha256 TEXT NOT NULL CHECK(length(binding_fingerprint_sha256)=64 AND binding_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'),
  access TEXT NOT NULL CHECK(access IN('read_only','read_write')),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 254 AND instr(actor,char(0))=0),
  created_at TEXT NOT NULL CHECK(created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',created_at))
) STRICT, WITHOUT ROWID;
CREATE INDEX local_storage_profile_admissions_binding ON local_storage_profile_admissions(storage_profile_id,binding_id,binding_revision);

CREATE TABLE local_storage_profile_bindings (
  storage_profile_id TEXT PRIMARY KEY REFERENCES storage_profiles(id) ON DELETE RESTRICT,
  installation_id TEXT NOT NULL,
  root_binding_id TEXT NOT NULL,
  binding_id TEXT NOT NULL UNIQUE,
  binding_revision INTEGER NOT NULL CHECK(binding_revision BETWEEN 1 AND 9007199254740991),
  admission_operation_id TEXT NOT NULL REFERENCES local_storage_profile_admissions(operation_id) ON DELETE RESTRICT,
  namespace_sha256 TEXT NOT NULL CHECK(length(namespace_sha256)=64 AND namespace_sha256 NOT GLOB '*[^0-9a-f]*'),
  binding_fingerprint_sha256 TEXT NOT NULL CHECK(length(binding_fingerprint_sha256)=64 AND binding_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'),
  access TEXT NOT NULL CHECK(access IN('read_only','read_write')),
  state TEXT NOT NULL CHECK(state IN('available','detached')),
  created_at TEXT NOT NULL CHECK(created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',created_at)),
  updated_at TEXT NOT NULL CHECK(updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) AND updated_at>=created_at)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER storage_profiles_local_identity_guard BEFORE INSERT ON storage_profiles WHEN NEW.adapter_type='local' BEGIN
  SELECT RAISE(ABORT,'Invalid local volume namespace') WHERE typeof(NEW.namespace_identity)<>'text' OR json_valid(NEW.namespace_identity)<>1
    OR json_type(NEW.namespace_identity) IS NOT 'object' OR(SELECT count(*) FROM json_each(NEW.namespace_identity))<>4
    OR json_extract(NEW.namespace_identity,'$.kind') IS NOT 'local-volume'
    OR json_type(NEW.namespace_identity,'$.volumeId') IS NOT 'text' OR json_type(NEW.namespace_identity,'$.rootId') IS NOT 'text'
    OR json_type(NEW.namespace_identity,'$.namespaceRevision') IS NOT 'integer' OR json_extract(NEW.namespace_identity,'$.namespaceRevision') IS NOT 1
    OR EXISTS(SELECT 1 FROM json_each(NEW.namespace_identity) WHERE key NOT IN('kind','volumeId','rootId','namespaceRevision'))
    OR EXISTS(SELECT 1 FROM json_each(NEW.namespace_identity) WHERE key IN('volumeId','rootId') AND(length(value)<>36 OR value<>lower(value)
      OR substr(value,9,1)<>'-' OR substr(value,14,1)<>'-' OR substr(value,19,1)<>'-' OR substr(value,24,1)<>'-'
      OR length(replace(value,'-',''))<>32 OR replace(value,'-','') GLOB '*[^0-9a-f]*'
      OR substr(value,15,1)<>'4' OR substr(value,20,1) NOT GLOB '[89ab]'))
    OR NEW.namespace_identity IS NOT json_object('kind','local-volume','volumeId',json_extract(NEW.namespace_identity,'$.volumeId'),
      'rootId',json_extract(NEW.namespace_identity,'$.rootId'),'namespaceRevision',1)
    OR substr(NEW.id,1,22)<>'storage-profile:local:' OR length(NEW.id)<>86 OR substr(NEW.id,23) GLOB '*[^0-9a-f]*'
    OR NEW.configuration_source<>'installation' OR NEW.credential_reference IS NOT NULL OR NEW.configuration_revision<>1 OR NEW.state<>'historical'
    OR typeof(NEW.created_at)<>'text' OR NEW.created_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at);
END;

CREATE TRIGGER local_storage_profile_registrations_insert_guard BEFORE INSERT ON local_storage_profile_registrations BEGIN
  SELECT RAISE(ABORT,'Local registration requires its exact historical namespace') WHERE NOT EXISTS(
    SELECT 1 FROM storage_profiles p JOIN storage_profile_runtime r ON r.storage_profile_id=p.id
    WHERE p.id=NEW.storage_profile_id AND p.adapter_type='local' AND p.configuration_source='installation' AND p.credential_reference IS NULL
    AND p.id='storage-profile:local:'||NEW.namespace_sha256 AND p.configuration_revision=1 AND p.state='historical' AND p.created_at=NEW.created_at
    AND r.state='read_only' AND r.registered_at=p.created_at AND r.activated_at IS NULL AND r.retired_at IS NULL);
END;
CREATE TRIGGER local_storage_profile_registrations_update_guard BEFORE UPDATE ON local_storage_profile_registrations BEGIN SELECT RAISE(ABORT,'Local registration history is immutable'); END;
CREATE TRIGGER local_storage_profile_registrations_delete_guard BEFORE DELETE ON local_storage_profile_registrations BEGIN SELECT RAISE(ABORT,'Local registration history is immutable'); END;

CREATE TRIGGER local_storage_profile_checks_insert_guard BEFORE INSERT ON local_storage_profile_checks BEGIN
  SELECT RAISE(ABORT,'Local check must start with owned pending inputs') WHERE NEW.state<>'checking'
    OR NOT EXISTS(SELECT 1 FROM storage_profiles p JOIN local_storage_profile_registrations reg ON reg.storage_profile_id=p.id
      WHERE p.id=NEW.storage_profile_id AND p.adapter_type='local' AND p.configuration_source='installation' AND p.configuration_revision=NEW.configuration_revision
      AND p.id='storage-profile:local:'||NEW.namespace_sha256 AND reg.namespace_sha256=NEW.namespace_sha256)
    OR EXISTS(SELECT 1 FROM local_storage_profile_bindings b WHERE b.storage_profile_id=NEW.storage_profile_id AND b.binding_revision>=NEW.binding_revision)
    OR EXISTS(SELECT 1 FROM local_storage_profile_activations a WHERE a.storage_profile_id=NEW.storage_profile_id AND a.binding_revision>=NEW.binding_revision)
    OR EXISTS(SELECT 1 FROM(SELECT NEW.installation_id value UNION ALL SELECT NEW.root_binding_id UNION ALL SELECT NEW.binding_id)
      WHERE length(value)<>36 OR value<>lower(value) OR substr(value,9,1)<>'-' OR substr(value,14,1)<>'-' OR substr(value,19,1)<>'-' OR substr(value,24,1)<>'-'
      OR length(replace(value,'-',''))<>32 OR replace(value,'-','') GLOB '*[^0-9a-f]*' OR substr(value,15,1)<>'4' OR substr(value,20,1) NOT GLOB '[89ab]');
END;
CREATE TRIGGER local_storage_profile_checks_update_guard BEFORE UPDATE ON local_storage_profile_checks BEGIN
  SELECT RAISE(ABORT,'Local check inputs and terminal results are immutable') WHERE OLD.state<>'checking' OR NEW.state NOT IN('passed','failed')
    OR NEW.id IS NOT OLD.id OR NEW.storage_profile_id IS NOT OLD.storage_profile_id OR NEW.configuration_revision IS NOT OLD.configuration_revision
    OR NEW.installation_id IS NOT OLD.installation_id OR NEW.root_binding_id IS NOT OLD.root_binding_id OR NEW.binding_id IS NOT OLD.binding_id
    OR NEW.binding_revision IS NOT OLD.binding_revision OR NEW.namespace_sha256 IS NOT OLD.namespace_sha256
    OR NEW.binding_fingerprint_sha256 IS NOT OLD.binding_fingerprint_sha256 OR NEW.access IS NOT OLD.access
    OR NEW.probe_object_key IS NOT OLD.probe_object_key OR NEW.probe_sha256 IS NOT OLD.probe_sha256 OR NEW.probe_byte_size IS NOT OLD.probe_byte_size
    OR NEW.actor IS NOT OLD.actor OR NEW.created_at IS NOT OLD.created_at;
END;
CREATE TRIGGER local_storage_profile_checks_delete_guard BEFORE DELETE ON local_storage_profile_checks BEGIN SELECT RAISE(ABORT,'Local check ownership must be retained'); END;

CREATE TRIGGER local_storage_profile_admissions_insert_guard BEFORE INSERT ON local_storage_profile_admissions BEGIN
  SELECT RAISE(ABORT,'Local admission requires the exact completed owned check') WHERE NOT EXISTS(
    SELECT 1 FROM local_storage_profile_checks c JOIN storage_profiles p ON p.id=c.storage_profile_id
    JOIN local_storage_profile_registrations reg ON reg.storage_profile_id=p.id AND reg.namespace_sha256=c.namespace_sha256
    WHERE c.id=NEW.check_id AND c.state='passed' AND c.cleanup_complete=1 AND c.stat_verified=1 AND c.read_verified=1 AND c.write_verified=1 AND c.delete_verified=1
    AND c.storage_profile_id=NEW.storage_profile_id AND c.configuration_revision=NEW.configuration_revision
    AND c.installation_id=NEW.installation_id AND c.root_binding_id=NEW.root_binding_id AND c.binding_id=NEW.binding_id AND c.binding_revision=NEW.binding_revision
    AND c.namespace_sha256=NEW.namespace_sha256 AND c.binding_fingerprint_sha256=NEW.binding_fingerprint_sha256 AND c.access=NEW.access
    AND p.adapter_type='local' AND p.configuration_source='installation' AND p.id='storage-profile:local:'||NEW.namespace_sha256
    AND NEW.created_at>=c.completed_at)
    OR EXISTS(SELECT 1 FROM local_storage_profile_bindings b WHERE b.storage_profile_id=NEW.storage_profile_id AND b.binding_revision>=NEW.binding_revision)
    OR EXISTS(SELECT 1 FROM local_storage_profile_activations a WHERE a.storage_profile_id=NEW.storage_profile_id AND a.binding_revision>=NEW.binding_revision);
END;
CREATE TRIGGER local_storage_profile_admissions_update_guard BEFORE UPDATE ON local_storage_profile_admissions BEGIN SELECT RAISE(ABORT,'Local admission history is immutable'); END;
CREATE TRIGGER local_storage_profile_admissions_delete_guard BEFORE DELETE ON local_storage_profile_admissions BEGIN SELECT RAISE(ABORT,'Local admission history is immutable'); END;

CREATE TRIGGER local_storage_profile_bindings_insert_guard BEFORE INSERT ON local_storage_profile_bindings BEGIN
  SELECT RAISE(ABORT,'Local binding requires its exact current admission') WHERE NEW.state<>'available' OR NEW.created_at IS NOT NEW.updated_at OR NOT EXISTS(
    SELECT 1 FROM local_storage_profile_admissions a WHERE a.operation_id=NEW.admission_operation_id AND a.storage_profile_id=NEW.storage_profile_id
    AND a.installation_id=NEW.installation_id AND a.root_binding_id=NEW.root_binding_id AND a.binding_id=NEW.binding_id AND a.binding_revision=NEW.binding_revision
    AND a.namespace_sha256=NEW.namespace_sha256 AND a.binding_fingerprint_sha256=NEW.binding_fingerprint_sha256 AND a.access=NEW.access AND a.created_at=NEW.created_at)
    OR EXISTS(SELECT 1 FROM local_storage_profile_activations a WHERE a.storage_profile_id=NEW.storage_profile_id AND a.binding_revision>=NEW.binding_revision);
END;
CREATE TRIGGER local_storage_profile_bindings_update_guard BEFORE UPDATE ON local_storage_profile_bindings BEGIN
  SELECT RAISE(ABORT,'Local binding identity and creation are immutable') WHERE NEW.storage_profile_id IS NOT OLD.storage_profile_id
    OR NEW.installation_id IS NOT OLD.installation_id OR NEW.namespace_sha256 IS NOT OLD.namespace_sha256 OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at<OLD.updated_at;
  SELECT RAISE(ABORT,'Local detach cannot retarget its owned binding') WHERE NEW.state='detached' AND(OLD.state<>'available'
    OR NEW.root_binding_id IS NOT OLD.root_binding_id OR NEW.binding_id IS NOT OLD.binding_id OR NEW.binding_revision IS NOT OLD.binding_revision
    OR NEW.admission_operation_id IS NOT OLD.admission_operation_id OR NEW.binding_fingerprint_sha256 IS NOT OLD.binding_fingerprint_sha256 OR NEW.access IS NOT OLD.access);
  SELECT RAISE(ABORT,'Local rebind requires a newer exact admission') WHERE NEW.state='available' AND(NEW.binding_revision<=OLD.binding_revision
    OR NOT EXISTS(SELECT 1 FROM local_storage_profile_admissions a WHERE a.operation_id=NEW.admission_operation_id AND a.storage_profile_id=NEW.storage_profile_id
      AND a.installation_id=NEW.installation_id AND a.root_binding_id=NEW.root_binding_id AND a.binding_id=NEW.binding_id AND a.binding_revision=NEW.binding_revision
      AND a.namespace_sha256=NEW.namespace_sha256 AND a.binding_fingerprint_sha256=NEW.binding_fingerprint_sha256 AND a.access=NEW.access AND a.created_at=NEW.updated_at)
    OR EXISTS(SELECT 1 FROM local_storage_profile_activations a WHERE a.storage_profile_id=NEW.storage_profile_id AND a.binding_revision>=NEW.binding_revision));
END;
CREATE TRIGGER local_storage_profile_bindings_delete_guard BEFORE DELETE ON local_storage_profile_bindings BEGIN SELECT RAISE(ABORT,'Local binding must be explicitly detached'); END;

CREATE TRIGGER local_storage_profile_activations_insert_guard BEFORE INSERT ON local_storage_profile_activations BEGIN
  SELECT RAISE(ABORT,'Local action requires its immutable registered namespace') WHERE NOT EXISTS(
    SELECT 1 FROM storage_profiles p JOIN local_storage_profile_registrations reg ON reg.storage_profile_id=p.id
    WHERE p.id=NEW.storage_profile_id AND p.adapter_type='local' AND p.configuration_source='installation' AND p.configuration_revision=NEW.configuration_revision
    AND p.id='storage-profile:local:'||NEW.namespace_sha256 AND reg.namespace_sha256=NEW.namespace_sha256)
    OR EXISTS(SELECT 1 FROM local_storage_profile_activations a WHERE a.storage_profile_id=NEW.storage_profile_id AND a.created_at>NEW.created_at);
  SELECT RAISE(ABORT,'Local activation requires a newer exact writable admission') WHERE NEW.action='activate' AND(
    NOT EXISTS(SELECT 1 FROM local_storage_profile_bindings b JOIN local_storage_profile_admissions a ON a.operation_id=b.admission_operation_id
      WHERE b.storage_profile_id=NEW.storage_profile_id AND b.state='available' AND b.access='read_write'
      AND b.admission_operation_id=NEW.admission_operation_id AND b.binding_revision=NEW.binding_revision AND b.namespace_sha256=NEW.namespace_sha256
      AND a.access='read_write' AND a.binding_id=b.binding_id AND a.binding_revision=b.binding_revision AND a.created_at<=NEW.created_at)
    OR EXISTS(SELECT 1 FROM local_storage_profile_activations old WHERE old.storage_profile_id=NEW.storage_profile_id AND old.binding_revision>=NEW.binding_revision));
  SELECT RAISE(ABORT,'Local retirement must preserve its current binding provenance') WHERE NEW.action='retire' AND(
    NEW.binding_revision<>COALESCE((SELECT binding_revision FROM local_storage_profile_bindings WHERE storage_profile_id=NEW.storage_profile_id),
      (SELECT max(binding_revision) FROM local_storage_profile_activations WHERE storage_profile_id=NEW.storage_profile_id),0)
    OR NEW.admission_operation_id IS NOT COALESCE((SELECT admission_operation_id FROM local_storage_profile_bindings WHERE storage_profile_id=NEW.storage_profile_id),
      (SELECT admission_operation_id FROM local_storage_profile_activations WHERE storage_profile_id=NEW.storage_profile_id ORDER BY binding_revision DESC,created_at DESC,operation_id DESC LIMIT 1)));
END;
CREATE TRIGGER local_storage_profile_activations_update_guard BEFORE UPDATE ON local_storage_profile_activations BEGIN SELECT RAISE(ABORT,'Local activation history is immutable'); END;
CREATE TRIGGER local_storage_profile_activations_delete_guard BEFORE DELETE ON local_storage_profile_activations BEGIN SELECT RAISE(ABORT,'Local activation history is immutable'); END;

CREATE TRIGGER storage_profile_runtime_local_update_guard BEFORE UPDATE ON storage_profile_runtime
WHEN EXISTS(SELECT 1 FROM storage_profiles p WHERE p.id=NEW.storage_profile_id AND p.adapter_type='local') BEGIN
  SELECT RAISE(ABORT,'Local runtime identity is immutable') WHERE NEW.storage_profile_id IS NOT OLD.storage_profile_id OR NEW.registered_at IS NOT OLD.registered_at;
  SELECT RAISE(ABORT,'Local writer requires its explicit current activation') WHERE NEW.state='read_write' AND(NEW.retired_at IS NOT NULL OR NOT EXISTS(
    SELECT 1 FROM local_storage_profile_bindings b JOIN local_storage_profile_admissions admitted ON admitted.operation_id=b.admission_operation_id
    JOIN local_storage_profile_checks checked ON checked.id=admitted.check_id
    JOIN local_storage_profile_activations a ON a.storage_profile_id=b.storage_profile_id AND a.action='activate'
    WHERE b.storage_profile_id=NEW.storage_profile_id AND b.state='available' AND b.access='read_write'
    AND a.admission_operation_id=b.admission_operation_id AND a.binding_revision=b.binding_revision AND a.namespace_sha256=b.namespace_sha256 AND a.created_at=NEW.activated_at
    AND NOT EXISTS(SELECT 1 FROM local_storage_profile_activations retired WHERE retired.storage_profile_id=a.storage_profile_id
      AND retired.action='retire' AND retired.binding_revision>=a.binding_revision)
    AND admitted.storage_profile_id=b.storage_profile_id AND admitted.installation_id=b.installation_id AND admitted.root_binding_id=b.root_binding_id
    AND admitted.binding_id=b.binding_id AND admitted.binding_revision=b.binding_revision AND admitted.namespace_sha256=b.namespace_sha256
    AND admitted.binding_fingerprint_sha256=b.binding_fingerprint_sha256 AND admitted.access='read_write'
    AND checked.state='passed' AND checked.cleanup_complete=1));
  SELECT RAISE(ABORT,'Local retirement requires explicit audit') WHERE NEW.state='retired' AND(NEW.activated_at IS NOT OLD.activated_at OR NOT EXISTS(
    SELECT 1 FROM local_storage_profile_activations a WHERE a.storage_profile_id=NEW.storage_profile_id AND a.action='retire' AND a.created_at=NEW.retired_at));
  SELECT RAISE(ABORT,'Local runtime cannot erase lifecycle history') WHERE OLD.state<>'read_only' AND NEW.state='read_only'
    OR NEW.state='read_only' AND(NEW.activated_at IS NOT OLD.activated_at OR NEW.retired_at IS NOT OLD.retired_at);
END;

-- Source audit/registered flags alone are deliberately insufficient. The Node
-- composer additionally requires its real current installation/root/lease pins.
CREATE TRIGGER file_locations_local_admission_guard BEFORE INSERT ON file_locations
WHEN EXISTS(SELECT 1 FROM storage_profiles p WHERE p.id=NEW.storage_profile_id AND p.adapter_type='local') BEGIN
  SELECT RAISE(ABORT,'Local location requires its current writable namespace') WHERE NOT EXISTS(
    SELECT 1 FROM storage_profiles p JOIN local_storage_profile_registrations reg ON reg.storage_profile_id=p.id
    JOIN storage_profile_runtime r ON r.storage_profile_id=p.id AND r.state='read_write'
    JOIN local_storage_profile_bindings b ON b.storage_profile_id=p.id AND b.state='available' AND b.access='read_write'
    JOIN local_storage_profile_admissions admitted ON admitted.operation_id=b.admission_operation_id
    JOIN local_storage_profile_checks checked ON checked.id=admitted.check_id
    JOIN local_storage_profile_activations a ON a.storage_profile_id=b.storage_profile_id AND a.action='activate'
    WHERE p.id=NEW.storage_profile_id AND p.adapter_type='local' AND p.configuration_source='installation' AND p.configuration_revision=1
    AND p.id='storage-profile:local:'||reg.namespace_sha256 AND b.namespace_sha256=reg.namespace_sha256
    AND admitted.storage_profile_id=b.storage_profile_id AND admitted.installation_id=b.installation_id AND admitted.root_binding_id=b.root_binding_id
    AND admitted.binding_id=b.binding_id AND admitted.binding_revision=b.binding_revision AND admitted.namespace_sha256=b.namespace_sha256
    AND admitted.binding_fingerprint_sha256=b.binding_fingerprint_sha256 AND admitted.access='read_write' AND checked.state='passed' AND checked.cleanup_complete=1
    AND a.admission_operation_id=b.admission_operation_id AND a.binding_revision=b.binding_revision AND a.namespace_sha256=b.namespace_sha256 AND a.created_at=r.activated_at
    AND NOT EXISTS(SELECT 1 FROM local_storage_profile_activations retired WHERE retired.storage_profile_id=a.storage_profile_id
      AND retired.action='retire' AND retired.binding_revision>=a.binding_revision));
END;


-- Only the explicitly enumerated current provider predicates are replaced.

DROP TRIGGER comment_item_acceptances_publication_guard;
CREATE TRIGGER comment_item_acceptances_publication_guard BEFORE UPDATE ON comment_item_acceptances WHEN (NEW.status = 'ready') AND (EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type IN('r2','switchdrive')))
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

DROP TRIGGER file_authority_metrology_receipt_ready_guard;
CREATE TRIGGER file_authority_metrology_receipt_ready_guard BEFORE UPDATE ON metrology_reference_upload_requests
WHEN (NEW.status='ready' AND (SELECT mode FROM file_authority_control WHERE singleton=1)='active') AND (EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type IN('r2','switchdrive')))
BEGIN
  SELECT RAISE(ABORT,'Active metrology receipt requires its exact ready File candidate') WHERE NOT EXISTS (
    SELECT 1 FROM file_authority_usable_candidate_results c JOIN metrology_template_references m
      ON m.id=json_extract(NEW.accepted_result_json,'$.reference.id') AND m.template_version_id=NEW.template_version_id
      AND m.file_id=c.result_file_id AND m.asset_id=json_extract(NEW.accepted_result_json,'$.assetId')
    JOIN assets a ON a.id=m.asset_id AND a.r2_key=c.result_object_key
      AND a.r2_key=json_extract(NEW.accepted_result_json,'$.reference.assetKey') AND a.sha256=c.expected_sha256 AND a.byte_size=c.expected_byte_size
    WHERE c.acceptance_kind='metrology_reference' AND c.acceptance_id=NEW.id AND c.item_id='' AND c.receipt_operation_id=NEW.operation_id);
END;

DROP TRIGGER file_authority_r2_receipt_ready_guard;
CREATE TRIGGER file_authority_r2_receipt_ready_guard BEFORE UPDATE ON r2_upload_requests
WHEN (NEW.status='ready' AND (SELECT mode FROM file_authority_control WHERE singleton=1)='active') AND (EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type IN('r2','switchdrive')))
BEGIN
  SELECT RAISE(ABORT,'Active upload requires its exact ready File candidate') WHERE NOT EXISTS (
    SELECT 1 FROM file_authority_usable_candidate_results c JOIN assets a
      ON a.id=json_extract(NEW.accepted_result_json,'$.id') AND a.r2_key=c.result_object_key
      AND a.r2_key=json_extract(NEW.accepted_result_json,'$.key') AND a.sha256=c.expected_sha256 AND a.byte_size=c.expected_byte_size
    WHERE c.acceptance_kind='r2_upload' AND c.acceptance_id=NEW.id AND c.item_id='' AND c.receipt_operation_id=NEW.operation_id);
END;

DROP TRIGGER metrology_reference_upload_requests_publication_guard;
CREATE TRIGGER metrology_reference_upload_requests_publication_guard BEFORE UPDATE ON metrology_reference_upload_requests
WHEN (NEW.status = 'ready') AND (EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type IN('r2','switchdrive')))
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

DROP TRIGGER r2_upload_requests_publication_guard;
CREATE TRIGGER r2_upload_requests_publication_guard BEFORE UPDATE ON r2_upload_requests
WHEN (NEW.status = 'ready') AND (EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type IN('r2','switchdrive')))
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

DROP TRIGGER storage_profile_runtime_legacy_update_guard;
CREATE TRIGGER storage_profile_runtime_legacy_update_guard BEFORE UPDATE ON storage_profile_runtime WHEN (EXISTS(SELECT 1 FROM storage_profiles p WHERE p.id=NEW.storage_profile_id AND p.adapter_type IN('r2','switchdrive')))
BEGIN SELECT RAISE(ABORT,'Profile write readiness requires explicit shadow admission') WHERE NOT(EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='overlap')) OR OLD.state<>'read_only' OR NEW.state<>'read_write' OR NEW.storage_profile_id IS NOT OLD.storage_profile_id OR NEW.registered_at IS NOT OLD.registered_at OR NEW.retired_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM file_shadow_profile_enablements e WHERE e.storage_profile_id=NEW.storage_profile_id AND NEW.activated_at IS e.enabled_at); END;

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
      WHERE l.id=NEW.location_id AND p.adapter_type IN('r2','switchdrive') AND NOT EXISTS(
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
      WHERE l.id=NEW.location_id AND p.adapter_type IN('r2','switchdrive') AND NOT EXISTS(
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

DROP TRIGGER storage_role_defaults_native_insert_guard;
CREATE TRIGGER storage_role_defaults_native_insert_guard BEFORE INSERT ON storage_role_defaults WHEN NEW.policy_revision>=3 BEGIN
 SELECT RAISE(ABORT,'Role default requires exact admitted policy history') WHERE NOT EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active') OR NOT EXISTS(
 SELECT 1 FROM storage_role_policy_revisions h JOIN storage_profiles p ON p.id=h.storage_profile_id
 JOIN storage_profile_runtime r ON r.storage_profile_id=p.id AND r.state='read_write'
 WHERE h.policy_revision=NEW.policy_revision AND h.role=NEW.role AND h.storage_profile_id=NEW.storage_profile_id
 AND h.storage_profile_revision=NEW.storage_profile_revision AND h.created_at=NEW.created_at
 AND p.configuration_revision=NEW.storage_profile_revision AND (p.adapter_type IN('r2','s3') OR(p.adapter_type='local' AND EXISTS(SELECT 1 FROM storage_profiles lp JOIN local_storage_profile_registrations lreg ON lreg.storage_profile_id=lp.id
 JOIN storage_profile_runtime lr ON lr.storage_profile_id=lp.id AND lr.state='read_write'
 JOIN local_storage_profile_bindings lb ON lb.storage_profile_id=lp.id AND lb.state='available' AND lb.access='read_write'
 JOIN local_storage_profile_admissions la ON la.operation_id=lb.admission_operation_id
 JOIN local_storage_profile_checks lc ON lc.id=la.check_id
 JOIN local_storage_profile_activations lact ON lact.storage_profile_id=lp.id AND lact.action='activate'
 WHERE lp.id=p.id AND lp.adapter_type='local' AND lp.configuration_source='installation' AND lp.configuration_revision=1
 AND lp.id='storage-profile:local:'||lreg.namespace_sha256 AND lb.namespace_sha256=lreg.namespace_sha256
 AND la.storage_profile_id=lb.storage_profile_id AND la.installation_id=lb.installation_id AND la.root_binding_id=lb.root_binding_id
 AND la.binding_id=lb.binding_id AND la.binding_revision=lb.binding_revision AND la.namespace_sha256=lb.namespace_sha256
 AND la.binding_fingerprint_sha256=lb.binding_fingerprint_sha256 AND la.access='read_write' AND lc.state='passed' AND lc.cleanup_complete=1
 AND lact.admission_operation_id=lb.admission_operation_id AND lact.binding_revision=lb.binding_revision AND lact.namespace_sha256=lb.namespace_sha256 AND lact.created_at=lr.activated_at
 AND NOT EXISTS(SELECT 1 FROM local_storage_profile_activations retired WHERE retired.storage_profile_id=lact.storage_profile_id
 AND retired.action='retire' AND retired.binding_revision>=lact.binding_revision)))));
 
END;

DROP TRIGGER storage_role_defaults_native_update_guard;
CREATE TRIGGER storage_role_defaults_native_update_guard BEFORE UPDATE ON storage_role_defaults WHEN NEW.policy_revision>=3 BEGIN
 SELECT RAISE(ABORT,'Role default requires exact admitted policy history') WHERE NOT EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active') OR NOT EXISTS(
 SELECT 1 FROM storage_role_policy_revisions h JOIN storage_profiles p ON p.id=h.storage_profile_id
 JOIN storage_profile_runtime r ON r.storage_profile_id=p.id AND r.state='read_write'
 WHERE h.policy_revision=NEW.policy_revision AND h.role=NEW.role AND h.storage_profile_id=NEW.storage_profile_id
 AND h.storage_profile_revision=NEW.storage_profile_revision AND h.created_at=NEW.created_at
 AND p.configuration_revision=NEW.storage_profile_revision AND (p.adapter_type IN('r2','s3') OR(p.adapter_type='local' AND EXISTS(SELECT 1 FROM storage_profiles lp JOIN local_storage_profile_registrations lreg ON lreg.storage_profile_id=lp.id
 JOIN storage_profile_runtime lr ON lr.storage_profile_id=lp.id AND lr.state='read_write'
 JOIN local_storage_profile_bindings lb ON lb.storage_profile_id=lp.id AND lb.state='available' AND lb.access='read_write'
 JOIN local_storage_profile_admissions la ON la.operation_id=lb.admission_operation_id
 JOIN local_storage_profile_checks lc ON lc.id=la.check_id
 JOIN local_storage_profile_activations lact ON lact.storage_profile_id=lp.id AND lact.action='activate'
 WHERE lp.id=p.id AND lp.adapter_type='local' AND lp.configuration_source='installation' AND lp.configuration_revision=1
 AND lp.id='storage-profile:local:'||lreg.namespace_sha256 AND lb.namespace_sha256=lreg.namespace_sha256
 AND la.storage_profile_id=lb.storage_profile_id AND la.installation_id=lb.installation_id AND la.root_binding_id=lb.root_binding_id
 AND la.binding_id=lb.binding_id AND la.binding_revision=lb.binding_revision AND la.namespace_sha256=lb.namespace_sha256
 AND la.binding_fingerprint_sha256=lb.binding_fingerprint_sha256 AND la.access='read_write' AND lc.state='passed' AND lc.cleanup_complete=1
 AND lact.admission_operation_id=lb.admission_operation_id AND lact.binding_revision=lb.binding_revision AND lact.namespace_sha256=lb.namespace_sha256 AND lact.created_at=lr.activated_at
 AND NOT EXISTS(SELECT 1 FROM local_storage_profile_activations retired WHERE retired.storage_profile_id=lact.storage_profile_id
 AND retired.action='retire' AND retired.binding_revision>=lact.binding_revision)))));
 SELECT RAISE(ABORT,'Role default revision is stale') WHERE NEW.role IS NOT OLD.role OR NEW.policy_revision<=OLD.policy_revision;
END;

DROP TRIGGER storage_role_policy_revisions_insert_guard;
CREATE TRIGGER storage_role_policy_revisions_insert_guard BEFORE INSERT ON storage_role_policy_revisions BEGIN
 SELECT RAISE(ABORT,'Role selection identity conflict') WHERE EXISTS(SELECT 1 FROM storage_role_policy_revisions WHERE policy_revision=NEW.policy_revision AND role=NEW.role);
 SELECT RAISE(ABORT,'Role selection requires active admitted target') WHERE NEW.policy_revision<3 OR NOT EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active')
 OR NOT EXISTS(SELECT 1 FROM storage_profiles p JOIN storage_profile_runtime r ON r.storage_profile_id=p.id
 WHERE p.id=NEW.storage_profile_id AND p.configuration_revision=NEW.storage_profile_revision AND r.state='read_write'
 AND ((p.adapter_type='r2' AND p.configuration_source='bootstrap') OR(p.adapter_type='s3' AND p.configuration_source='system'
 AND EXISTS(SELECT 1 FROM system_storage_native_bindings b WHERE b.storage_profile_id=p.id)) OR(p.adapter_type='local' AND EXISTS(SELECT 1 FROM storage_profiles lp JOIN local_storage_profile_registrations lreg ON lreg.storage_profile_id=lp.id
 JOIN storage_profile_runtime lr ON lr.storage_profile_id=lp.id AND lr.state='read_write'
 JOIN local_storage_profile_bindings lb ON lb.storage_profile_id=lp.id AND lb.state='available' AND lb.access='read_write'
 JOIN local_storage_profile_admissions la ON la.operation_id=lb.admission_operation_id
 JOIN local_storage_profile_checks lc ON lc.id=la.check_id
 JOIN local_storage_profile_activations lact ON lact.storage_profile_id=lp.id AND lact.action='activate'
 WHERE lp.id=p.id AND lp.adapter_type='local' AND lp.configuration_source='installation' AND lp.configuration_revision=1
 AND lp.id='storage-profile:local:'||lreg.namespace_sha256 AND lb.namespace_sha256=lreg.namespace_sha256
 AND la.storage_profile_id=lb.storage_profile_id AND la.installation_id=lb.installation_id AND la.root_binding_id=lb.root_binding_id
 AND la.binding_id=lb.binding_id AND la.binding_revision=lb.binding_revision AND la.namespace_sha256=lb.namespace_sha256
 AND la.binding_fingerprint_sha256=lb.binding_fingerprint_sha256 AND la.access='read_write' AND lc.state='passed' AND lc.cleanup_complete=1
 AND lact.admission_operation_id=lb.admission_operation_id AND lact.binding_revision=lb.binding_revision AND lact.namespace_sha256=lb.namespace_sha256 AND lact.created_at=lr.activated_at
 AND NOT EXISTS(SELECT 1 FROM local_storage_profile_activations retired WHERE retired.storage_profile_id=lact.storage_profile_id
 AND retired.action='retire' AND retired.binding_revision>=lact.binding_revision)))));
 SELECT RAISE(ABORT,'Role selection revision is stale') WHERE EXISTS(SELECT 1 FROM storage_role_policy_revisions x WHERE x.policy_revision>NEW.policy_revision);
END;

DROP TRIGGER assets_native_insert_guard;
CREATE TRIGGER assets_native_insert_guard BEFORE INSERT ON assets WHEN NEW.r2_key IS NULL BEGIN
 SELECT RAISE(ABORT,'Local operation requires its exact live writable admission') WHERE EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='local') AND NOT EXISTS(SELECT 1 FROM storage_profiles lp JOIN local_storage_profile_registrations lreg ON lreg.storage_profile_id=lp.id
 JOIN storage_profile_runtime lr ON lr.storage_profile_id=lp.id AND lr.state='read_write'
 JOIN local_storage_profile_bindings lb ON lb.storage_profile_id=lp.id AND lb.state='available' AND lb.access='read_write'
 JOIN local_storage_profile_admissions la ON la.operation_id=lb.admission_operation_id
 JOIN local_storage_profile_checks lc ON lc.id=la.check_id
 JOIN local_storage_profile_activations lact ON lact.storage_profile_id=lp.id AND lact.action='activate'
 WHERE lp.id=NEW.storage_profile_id AND lp.adapter_type='local' AND lp.configuration_source='installation' AND lp.configuration_revision=1
 AND lp.id='storage-profile:local:'||lreg.namespace_sha256 AND lb.namespace_sha256=lreg.namespace_sha256
 AND la.storage_profile_id=lb.storage_profile_id AND la.installation_id=lb.installation_id AND la.root_binding_id=lb.root_binding_id
 AND la.binding_id=lb.binding_id AND la.binding_revision=lb.binding_revision AND la.namespace_sha256=lb.namespace_sha256
 AND la.binding_fingerprint_sha256=lb.binding_fingerprint_sha256 AND la.access='read_write' AND lc.state='passed' AND lc.cleanup_complete=1
 AND lact.admission_operation_id=lb.admission_operation_id AND lact.binding_revision=lb.binding_revision AND lact.namespace_sha256=lb.namespace_sha256 AND lact.created_at=lr.activated_at
 AND NOT EXISTS(SELECT 1 FROM local_storage_profile_activations retired WHERE retired.storage_profile_id=lact.storage_profile_id
 AND retired.action='retire' AND retired.binding_revision>=lact.binding_revision));
 SELECT RAISE(ABORT,'Native alias requires exact verified File acceptance') WHERE (NOT EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active') OR NEW.status NOT IN('pending','ready') OR NOT EXISTS(
 SELECT 1 FROM file_authority_ready_candidate_aliases c JOIN storage_profiles p ON p.id=c.storage_profile_id AND p.adapter_type IN('s3','local')
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

DROP TRIGGER comment_item_acceptances_native_insert_guard;
CREATE TRIGGER comment_item_acceptances_native_insert_guard BEFORE INSERT ON comment_item_acceptances
 WHEN (SELECT storage_role_policy_revision FROM comment_submission_acceptances WHERE submission_id=NEW.submission_id)=3 BEGIN
 SELECT RAISE(ABORT,'Local operation requires its exact live writable admission') WHERE EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='local') AND NOT EXISTS(SELECT 1 FROM storage_profiles lp JOIN local_storage_profile_registrations lreg ON lreg.storage_profile_id=lp.id
 JOIN storage_profile_runtime lr ON lr.storage_profile_id=lp.id AND lr.state='read_write'
 JOIN local_storage_profile_bindings lb ON lb.storage_profile_id=lp.id AND lb.state='available' AND lb.access='read_write'
 JOIN local_storage_profile_admissions la ON la.operation_id=lb.admission_operation_id
 JOIN local_storage_profile_checks lc ON lc.id=la.check_id
 JOIN local_storage_profile_activations lact ON lact.storage_profile_id=lp.id AND lact.action='activate'
 WHERE lp.id=NEW.storage_profile_id AND lp.adapter_type='local' AND lp.configuration_source='installation' AND lp.configuration_revision=1
 AND lp.id='storage-profile:local:'||lreg.namespace_sha256 AND lb.namespace_sha256=lreg.namespace_sha256
 AND la.storage_profile_id=lb.storage_profile_id AND la.installation_id=lb.installation_id AND la.root_binding_id=lb.root_binding_id
 AND la.binding_id=lb.binding_id AND la.binding_revision=lb.binding_revision AND la.namespace_sha256=lb.namespace_sha256
 AND la.binding_fingerprint_sha256=lb.binding_fingerprint_sha256 AND la.access='read_write' AND lc.state='passed' AND lc.cleanup_complete=1
 AND lact.admission_operation_id=lb.admission_operation_id AND lact.binding_revision=lb.binding_revision AND lact.namespace_sha256=lb.namespace_sha256 AND lact.created_at=lr.activated_at
 AND NOT EXISTS(SELECT 1 FROM local_storage_profile_activations retired WHERE retired.storage_profile_id=lact.storage_profile_id
 AND retired.action='retire' AND retired.binding_revision>=lact.binding_revision));
 
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
 AND(i.kind<>'comment_image' OR NEW.expected_byte_size<=5242880) AND p.adapter_type IN('r2','s3','local'));
END;

DROP TRIGGER comment_item_acceptances_native_publication_guard;
CREATE TRIGGER comment_item_acceptances_native_publication_guard BEFORE UPDATE ON comment_item_acceptances WHEN NEW.status='ready' AND EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type IN('s3','local')) BEGIN
 SELECT RAISE(ABORT,'Local operation requires its exact live writable admission') WHERE EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='local') AND NOT EXISTS(SELECT 1 FROM storage_profiles lp JOIN local_storage_profile_registrations lreg ON lreg.storage_profile_id=lp.id
 JOIN storage_profile_runtime lr ON lr.storage_profile_id=lp.id AND lr.state='read_write'
 JOIN local_storage_profile_bindings lb ON lb.storage_profile_id=lp.id AND lb.state='available' AND lb.access='read_write'
 JOIN local_storage_profile_admissions la ON la.operation_id=lb.admission_operation_id
 JOIN local_storage_profile_checks lc ON lc.id=la.check_id
 JOIN local_storage_profile_activations lact ON lact.storage_profile_id=lp.id AND lact.action='activate'
 WHERE lp.id=NEW.storage_profile_id AND lp.adapter_type='local' AND lp.configuration_source='installation' AND lp.configuration_revision=1
 AND lp.id='storage-profile:local:'||lreg.namespace_sha256 AND lb.namespace_sha256=lreg.namespace_sha256
 AND la.storage_profile_id=lb.storage_profile_id AND la.installation_id=lb.installation_id AND la.root_binding_id=lb.root_binding_id
 AND la.binding_id=lb.binding_id AND la.binding_revision=lb.binding_revision AND la.namespace_sha256=lb.namespace_sha256
 AND la.binding_fingerprint_sha256=lb.binding_fingerprint_sha256 AND la.access='read_write' AND lc.state='passed' AND lc.cleanup_complete=1
 AND lact.admission_operation_id=lb.admission_operation_id AND lact.binding_revision=lb.binding_revision AND lact.namespace_sha256=lb.namespace_sha256 AND lact.created_at=lr.activated_at
 AND NOT EXISTS(SELECT 1 FROM local_storage_profile_activations retired WHERE retired.storage_profile_id=lact.storage_profile_id
 AND retired.action='retire' AND retired.binding_revision>=lact.binding_revision));
 SELECT RAISE(ABORT,'Native Comment result does not match exact verified binding') WHERE (SELECT count(*) FROM json_each(NEW.accepted_result_json))<>11
 OR NOT EXISTS(SELECT 1 FROM storage_profiles result_profile WHERE result_profile.id=NEW.storage_profile_id AND((result_profile.adapter_type='s3' AND json_extract(NEW.accepted_result_json,'$.schema')='comment-upload/2' AND json_extract(NEW.accepted_result_json,'$.provider')='s3') OR(result_profile.adapter_type='local' AND json_extract(NEW.accepted_result_json,'$.schema')='comment-upload/3' AND json_extract(NEW.accepted_result_json,'$.provider')='local'))) OR json_extract(NEW.accepted_result_json,'$.storeKind') IS NOT 'file'
 OR json_extract(NEW.accepted_result_json,'$.storageProfileId') IS NOT NEW.storage_profile_id
 OR json_extract(NEW.accepted_result_json,'$.storageProfileRevision') IS NOT NEW.storage_profile_revision
 OR json_extract(NEW.accepted_result_json,'$.sha256') IS NOT NEW.expected_sha256 OR json_extract(NEW.accepted_result_json,'$.byteSize') IS NOT NEW.expected_byte_size
 OR json_type(NEW.accepted_result_json,'$.deduplicated') NOT IN('true','false') OR NOT EXISTS(
 SELECT 1 FROM comment_submission_items i JOIN assets a ON a.id=i.asset_id JOIN file_authority_usable_candidate_results c ON c.result_file_id=i.file_id
 WHERE i.id=NEW.item_id AND i.submission_id=NEW.submission_id AND i.status='ready' AND i.deleted_at IS NULL AND i.storage_object_id IS NULL
 AND a.id=json_extract(NEW.accepted_result_json,'$.blobRecordId') AND a.r2_key IS NULL AND a.file_id=i.file_id AND a.file_id=json_extract(NEW.accepted_result_json,'$.fileId')
 AND a.storage_profile_id=NEW.storage_profile_id AND a.object_key=json_extract(NEW.accepted_result_json,'$.objectKey') AND a.status='ready'
 AND a.sha256=NEW.expected_sha256 AND a.byte_size=NEW.expected_byte_size AND c.acceptance_kind='comment_item' AND c.acceptance_id=NEW.item_id
 AND c.result_object_key=a.object_key); END;

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
    AND (p.adapter_type='r2' OR(p.adapter_type='s3' AND NEW.role_policy_revision IS NOT NULL AND EXISTS(SELECT 1 FROM storage_profile_runtime rt JOIN system_storage_native_bindings b ON b.storage_profile_id=rt.storage_profile_id WHERE rt.storage_profile_id=p.id AND rt.state='read_write')) OR(p.adapter_type='local' AND NEW.role_policy_revision IS NOT NULL AND EXISTS(SELECT 1 FROM storage_profiles lp JOIN local_storage_profile_registrations lreg ON lreg.storage_profile_id=lp.id
 JOIN storage_profile_runtime lr ON lr.storage_profile_id=lp.id AND lr.state='read_write'
 JOIN local_storage_profile_bindings lb ON lb.storage_profile_id=lp.id AND lb.state='available' AND lb.access='read_write'
 JOIN local_storage_profile_admissions la ON la.operation_id=lb.admission_operation_id
 JOIN local_storage_profile_checks lc ON lc.id=la.check_id
 JOIN local_storage_profile_activations lact ON lact.storage_profile_id=lp.id AND lact.action='activate'
 WHERE lp.id=p.id AND lp.adapter_type='local' AND lp.configuration_source='installation' AND lp.configuration_revision=1
 AND lp.id='storage-profile:local:'||lreg.namespace_sha256 AND lb.namespace_sha256=lreg.namespace_sha256
 AND la.storage_profile_id=lb.storage_profile_id AND la.installation_id=lb.installation_id AND la.root_binding_id=lb.root_binding_id
 AND la.binding_id=lb.binding_id AND la.binding_revision=lb.binding_revision AND la.namespace_sha256=lb.namespace_sha256
 AND la.binding_fingerprint_sha256=lb.binding_fingerprint_sha256 AND la.access='read_write' AND lc.state='passed' AND lc.cleanup_complete=1
 AND lact.admission_operation_id=lb.admission_operation_id AND lact.binding_revision=lb.binding_revision AND lact.namespace_sha256=lb.namespace_sha256 AND lact.created_at=lr.activated_at
 AND NOT EXISTS(SELECT 1 FROM local_storage_profile_activations retired WHERE retired.storage_profile_id=lact.storage_profile_id
 AND retired.action='retire' AND retired.binding_revision>=lact.binding_revision)))) AND p.configuration_revision = NEW.storage_profile_revision
    AND ((p.adapter_type='r2' AND p.configuration_source='bootstrap') OR(p.adapter_type='s3' AND p.configuration_source='system') OR(p.adapter_type='local' AND p.configuration_source='installation')) AND p.credential_reference IS NULL AND p.state = 'historical')
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
    AND (p.adapter_type='r2' OR(p.adapter_type='s3' AND NEW.role_policy_revision IS NOT NULL AND EXISTS(SELECT 1 FROM storage_profile_runtime rt JOIN system_storage_native_bindings b ON b.storage_profile_id=rt.storage_profile_id WHERE rt.storage_profile_id=p.id AND rt.state='read_write')) OR(p.adapter_type='local' AND NEW.role_policy_revision IS NOT NULL AND EXISTS(SELECT 1 FROM storage_profiles lp JOIN local_storage_profile_registrations lreg ON lreg.storage_profile_id=lp.id
 JOIN storage_profile_runtime lr ON lr.storage_profile_id=lp.id AND lr.state='read_write'
 JOIN local_storage_profile_bindings lb ON lb.storage_profile_id=lp.id AND lb.state='available' AND lb.access='read_write'
 JOIN local_storage_profile_admissions la ON la.operation_id=lb.admission_operation_id
 JOIN local_storage_profile_checks lc ON lc.id=la.check_id
 JOIN local_storage_profile_activations lact ON lact.storage_profile_id=lp.id AND lact.action='activate'
 WHERE lp.id=p.id AND lp.adapter_type='local' AND lp.configuration_source='installation' AND lp.configuration_revision=1
 AND lp.id='storage-profile:local:'||lreg.namespace_sha256 AND lb.namespace_sha256=lreg.namespace_sha256
 AND la.storage_profile_id=lb.storage_profile_id AND la.installation_id=lb.installation_id AND la.root_binding_id=lb.root_binding_id
 AND la.binding_id=lb.binding_id AND la.binding_revision=lb.binding_revision AND la.namespace_sha256=lb.namespace_sha256
 AND la.binding_fingerprint_sha256=lb.binding_fingerprint_sha256 AND la.access='read_write' AND lc.state='passed' AND lc.cleanup_complete=1
 AND lact.admission_operation_id=lb.admission_operation_id AND lact.binding_revision=lb.binding_revision AND lact.namespace_sha256=lb.namespace_sha256 AND lact.created_at=lr.activated_at
 AND NOT EXISTS(SELECT 1 FROM local_storage_profile_activations retired WHERE retired.storage_profile_id=lact.storage_profile_id
 AND retired.action='retire' AND retired.binding_revision>=lact.binding_revision)))) AND p.configuration_revision = NEW.storage_profile_revision
    AND ((p.adapter_type='r2' AND p.configuration_source='bootstrap') OR(p.adapter_type='s3' AND p.configuration_source='system') OR(p.adapter_type='local' AND p.configuration_source='installation')) AND p.credential_reference IS NULL AND p.state = 'historical')
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

DROP TRIGGER metrology_reference_upload_requests_native_policy_insert_guard;
CREATE TRIGGER metrology_reference_upload_requests_native_policy_insert_guard BEFORE INSERT ON metrology_reference_upload_requests BEGIN
 SELECT RAISE(ABORT,'Local operation requires its exact live writable admission') WHERE EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='local') AND NOT EXISTS(SELECT 1 FROM storage_profiles lp JOIN local_storage_profile_registrations lreg ON lreg.storage_profile_id=lp.id
 JOIN storage_profile_runtime lr ON lr.storage_profile_id=lp.id AND lr.state='read_write'
 JOIN local_storage_profile_bindings lb ON lb.storage_profile_id=lp.id AND lb.state='available' AND lb.access='read_write'
 JOIN local_storage_profile_admissions la ON la.operation_id=lb.admission_operation_id
 JOIN local_storage_profile_checks lc ON lc.id=la.check_id
 JOIN local_storage_profile_activations lact ON lact.storage_profile_id=lp.id AND lact.action='activate'
 WHERE lp.id=NEW.storage_profile_id AND lp.adapter_type='local' AND lp.configuration_source='installation' AND lp.configuration_revision=1
 AND lp.id='storage-profile:local:'||lreg.namespace_sha256 AND lb.namespace_sha256=lreg.namespace_sha256
 AND la.storage_profile_id=lb.storage_profile_id AND la.installation_id=lb.installation_id AND la.root_binding_id=lb.root_binding_id
 AND la.binding_id=lb.binding_id AND la.binding_revision=lb.binding_revision AND la.namespace_sha256=lb.namespace_sha256
 AND la.binding_fingerprint_sha256=lb.binding_fingerprint_sha256 AND la.access='read_write' AND lc.state='passed' AND lc.cleanup_complete=1
 AND lact.admission_operation_id=lb.admission_operation_id AND lact.binding_revision=lb.binding_revision AND lact.namespace_sha256=lb.namespace_sha256 AND lact.created_at=lr.activated_at
 AND NOT EXISTS(SELECT 1 FROM local_storage_profile_activations retired WHERE retired.storage_profile_id=lact.storage_profile_id
 AND retired.action='retire' AND retired.binding_revision>=lact.binding_revision));
 SELECT RAISE(ABORT,'Native upload requires frozen current role selection') WHERE NEW.role_policy_revision IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active') OR NOT EXISTS(
 SELECT 1 FROM storage_role_defaults d JOIN storage_role_policy_revisions h ON h.policy_revision=d.policy_revision AND h.role=d.role
 WHERE d.role=iif(NEW.purpose IN('research_source','provenance'),'originals','internal') AND d.policy_revision=NEW.role_policy_revision AND d.storage_profile_id=NEW.storage_profile_id AND d.storage_profile_revision=NEW.storage_profile_revision
 AND h.storage_profile_id=d.storage_profile_id AND h.storage_profile_revision=d.storage_profile_revision));
 SELECT RAISE(ABORT,'Native upload must record role selection') WHERE NEW.role_policy_revision IS NULL AND EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type IN('s3','local')); END;

DROP TRIGGER r2_upload_requests_native_policy_insert_guard;
CREATE TRIGGER r2_upload_requests_native_policy_insert_guard BEFORE INSERT ON r2_upload_requests BEGIN
 SELECT RAISE(ABORT,'Local operation requires its exact live writable admission') WHERE EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='local') AND NOT EXISTS(SELECT 1 FROM storage_profiles lp JOIN local_storage_profile_registrations lreg ON lreg.storage_profile_id=lp.id
 JOIN storage_profile_runtime lr ON lr.storage_profile_id=lp.id AND lr.state='read_write'
 JOIN local_storage_profile_bindings lb ON lb.storage_profile_id=lp.id AND lb.state='available' AND lb.access='read_write'
 JOIN local_storage_profile_admissions la ON la.operation_id=lb.admission_operation_id
 JOIN local_storage_profile_checks lc ON lc.id=la.check_id
 JOIN local_storage_profile_activations lact ON lact.storage_profile_id=lp.id AND lact.action='activate'
 WHERE lp.id=NEW.storage_profile_id AND lp.adapter_type='local' AND lp.configuration_source='installation' AND lp.configuration_revision=1
 AND lp.id='storage-profile:local:'||lreg.namespace_sha256 AND lb.namespace_sha256=lreg.namespace_sha256
 AND la.storage_profile_id=lb.storage_profile_id AND la.installation_id=lb.installation_id AND la.root_binding_id=lb.root_binding_id
 AND la.binding_id=lb.binding_id AND la.binding_revision=lb.binding_revision AND la.namespace_sha256=lb.namespace_sha256
 AND la.binding_fingerprint_sha256=lb.binding_fingerprint_sha256 AND la.access='read_write' AND lc.state='passed' AND lc.cleanup_complete=1
 AND lact.admission_operation_id=lb.admission_operation_id AND lact.binding_revision=lb.binding_revision AND lact.namespace_sha256=lb.namespace_sha256 AND lact.created_at=lr.activated_at
 AND NOT EXISTS(SELECT 1 FROM local_storage_profile_activations retired WHERE retired.storage_profile_id=lact.storage_profile_id
 AND retired.action='retire' AND retired.binding_revision>=lact.binding_revision));
 SELECT RAISE(ABORT,'Native upload requires frozen current role selection') WHERE NEW.role_policy_revision IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active') OR NOT EXISTS(
 SELECT 1 FROM storage_role_defaults d JOIN storage_role_policy_revisions h ON h.policy_revision=d.policy_revision AND h.role=d.role
 WHERE d.role=iif(NEW.purpose IN('research_source','provenance'),'originals','internal') AND d.policy_revision=NEW.role_policy_revision AND d.storage_profile_id=NEW.storage_profile_id AND d.storage_profile_revision=NEW.storage_profile_revision
 AND h.storage_profile_id=d.storage_profile_id AND h.storage_profile_revision=d.storage_profile_revision));
 SELECT RAISE(ABORT,'Native upload must record role selection') WHERE NEW.role_policy_revision IS NULL AND EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type IN('s3','local')); END;

DROP TRIGGER metrology_reference_upload_requests_native_publication_guard;
CREATE TRIGGER metrology_reference_upload_requests_native_publication_guard BEFORE UPDATE ON metrology_reference_upload_requests WHEN NEW.status='ready' AND EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type IN('s3','local')) BEGIN
 SELECT RAISE(ABORT,'Local operation requires its exact live writable admission') WHERE EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='local') AND NOT EXISTS(SELECT 1 FROM storage_profiles lp JOIN local_storage_profile_registrations lreg ON lreg.storage_profile_id=lp.id
 JOIN storage_profile_runtime lr ON lr.storage_profile_id=lp.id AND lr.state='read_write'
 JOIN local_storage_profile_bindings lb ON lb.storage_profile_id=lp.id AND lb.state='available' AND lb.access='read_write'
 JOIN local_storage_profile_admissions la ON la.operation_id=lb.admission_operation_id
 JOIN local_storage_profile_checks lc ON lc.id=la.check_id
 JOIN local_storage_profile_activations lact ON lact.storage_profile_id=lp.id AND lact.action='activate'
 WHERE lp.id=NEW.storage_profile_id AND lp.adapter_type='local' AND lp.configuration_source='installation' AND lp.configuration_revision=1
 AND lp.id='storage-profile:local:'||lreg.namespace_sha256 AND lb.namespace_sha256=lreg.namespace_sha256
 AND la.storage_profile_id=lb.storage_profile_id AND la.installation_id=lb.installation_id AND la.root_binding_id=lb.root_binding_id
 AND la.binding_id=lb.binding_id AND la.binding_revision=lb.binding_revision AND la.namespace_sha256=lb.namespace_sha256
 AND la.binding_fingerprint_sha256=lb.binding_fingerprint_sha256 AND la.access='read_write' AND lc.state='passed' AND lc.cleanup_complete=1
 AND lact.admission_operation_id=lb.admission_operation_id AND lact.binding_revision=lb.binding_revision AND lact.namespace_sha256=lb.namespace_sha256 AND lact.created_at=lr.activated_at
 AND NOT EXISTS(SELECT 1 FROM local_storage_profile_activations retired WHERE retired.storage_profile_id=lact.storage_profile_id
 AND retired.action='retire' AND retired.binding_revision>=lact.binding_revision));
 SELECT RAISE(ABORT,'Native metrology result does not match verified occurrence') WHERE
 (SELECT count(*) FROM json_each(NEW.accepted_result_json))<>3 OR (SELECT count(*) FROM json_each(NEW.accepted_result_json,'$.reference'))<>8
 OR json_type(NEW.accepted_result_json,'$.reference.assetKey') IS NOT 'null' OR json_type(NEW.accepted_result_json,'$.deduplicated') NOT IN('true','false')
 OR json_extract(NEW.accepted_result_json,'$.reference.url') IS NOT '/api/file-assets/'||json_extract(NEW.accepted_result_json,'$.assetId')
 OR NOT EXISTS(SELECT 1 FROM file_authority_usable_candidate_results c JOIN assets a ON a.id=json_extract(NEW.accepted_result_json,'$.assetId')
 AND a.file_id=c.result_file_id AND a.storage_profile_id=c.storage_profile_id AND a.object_key=c.result_object_key
 AND a.r2_key IS NULL AND a.status='ready' AND a.sha256=c.expected_sha256 AND a.byte_size=c.expected_byte_size
 JOIN storage_profiles p ON p.id=a.storage_profile_id AND p.adapter_type IN('s3','local') AND p.configuration_revision=a.storage_profile_revision
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

DROP TRIGGER r2_upload_requests_native_publication_guard;
CREATE TRIGGER r2_upload_requests_native_publication_guard BEFORE UPDATE ON r2_upload_requests WHEN NEW.status='ready' AND EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type IN('s3','local')) BEGIN
 SELECT RAISE(ABORT,'Local operation requires its exact live writable admission') WHERE EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='local') AND NOT EXISTS(SELECT 1 FROM storage_profiles lp JOIN local_storage_profile_registrations lreg ON lreg.storage_profile_id=lp.id
 JOIN storage_profile_runtime lr ON lr.storage_profile_id=lp.id AND lr.state='read_write'
 JOIN local_storage_profile_bindings lb ON lb.storage_profile_id=lp.id AND lb.state='available' AND lb.access='read_write'
 JOIN local_storage_profile_admissions la ON la.operation_id=lb.admission_operation_id
 JOIN local_storage_profile_checks lc ON lc.id=la.check_id
 JOIN local_storage_profile_activations lact ON lact.storage_profile_id=lp.id AND lact.action='activate'
 WHERE lp.id=NEW.storage_profile_id AND lp.adapter_type='local' AND lp.configuration_source='installation' AND lp.configuration_revision=1
 AND lp.id='storage-profile:local:'||lreg.namespace_sha256 AND lb.namespace_sha256=lreg.namespace_sha256
 AND la.storage_profile_id=lb.storage_profile_id AND la.installation_id=lb.installation_id AND la.root_binding_id=lb.root_binding_id
 AND la.binding_id=lb.binding_id AND la.binding_revision=lb.binding_revision AND la.namespace_sha256=lb.namespace_sha256
 AND la.binding_fingerprint_sha256=lb.binding_fingerprint_sha256 AND la.access='read_write' AND lc.state='passed' AND lc.cleanup_complete=1
 AND lact.admission_operation_id=lb.admission_operation_id AND lact.binding_revision=lb.binding_revision AND lact.namespace_sha256=lb.namespace_sha256 AND lact.created_at=lr.activated_at
 AND NOT EXISTS(SELECT 1 FROM local_storage_profile_activations retired WHERE retired.storage_profile_id=lact.storage_profile_id
 AND retired.action='retire' AND retired.binding_revision>=lact.binding_revision));
 SELECT RAISE(ABORT,'Native upload result does not match verified publication') WHERE
 (SELECT count(*) FROM json_each(NEW.accepted_result_json))<>6 OR json_type(NEW.accepted_result_json,'$.key') IS NOT 'null'
 OR json_extract(NEW.accepted_result_json,'$.storageKind') IS NOT 'native' OR json_type(NEW.accepted_result_json,'$.id') IS NOT 'text'
 OR json_type(NEW.accepted_result_json,'$.fileId') IS NOT 'text' OR json_extract(NEW.accepted_result_json,'$.url') IS NOT '/api/file-assets/'||json_extract(NEW.accepted_result_json,'$.id')
 OR json_type(NEW.accepted_result_json,'$.deduplicated') NOT IN('true','false')
 OR NOT EXISTS(SELECT 1 FROM file_authority_usable_candidate_results c JOIN assets a ON a.id=json_extract(NEW.accepted_result_json,'$.id')
 AND a.file_id=c.result_file_id AND a.storage_profile_id=c.storage_profile_id AND a.object_key=c.result_object_key
 AND a.r2_key IS NULL AND a.status='ready' AND a.sha256=c.expected_sha256 AND a.byte_size=c.expected_byte_size
 JOIN storage_profiles p ON p.id=a.storage_profile_id AND p.adapter_type IN('s3','local') AND p.configuration_revision=a.storage_profile_revision
 WHERE c.acceptance_kind='r2_upload' AND c.acceptance_id=NEW.id AND c.item_id='' AND c.receipt_operation_id=NEW.operation_id AND a.file_id=json_extract(NEW.accepted_result_json,'$.fileId')); END;

DROP TRIGGER imports_native_publication_guard;
CREATE TRIGGER imports_native_publication_guard BEFORE UPDATE ON imports WHEN NEW.file_targets_protocol=1 AND NEW.status='ready' AND OLD.status<>'ready' BEGIN
 SELECT RAISE(ABORT,'Local import publication requires each current admitted target') WHERE EXISTS(SELECT 1 FROM import_file_acceptances target JOIN storage_profiles profile ON profile.id=target.storage_profile_id WHERE target.import_id=NEW.id AND profile.adapter_type='local' AND NOT EXISTS(SELECT 1 FROM storage_profiles lp JOIN local_storage_profile_registrations lreg ON lreg.storage_profile_id=lp.id
 JOIN storage_profile_runtime lr ON lr.storage_profile_id=lp.id AND lr.state='read_write'
 JOIN local_storage_profile_bindings lb ON lb.storage_profile_id=lp.id AND lb.state='available' AND lb.access='read_write'
 JOIN local_storage_profile_admissions la ON la.operation_id=lb.admission_operation_id
 JOIN local_storage_profile_checks lc ON lc.id=la.check_id
 JOIN local_storage_profile_activations lact ON lact.storage_profile_id=lp.id AND lact.action='activate'
 WHERE lp.id=profile.id AND lp.adapter_type='local' AND lp.configuration_source='installation' AND lp.configuration_revision=1
 AND lp.id='storage-profile:local:'||lreg.namespace_sha256 AND lb.namespace_sha256=lreg.namespace_sha256
 AND la.storage_profile_id=lb.storage_profile_id AND la.installation_id=lb.installation_id AND la.root_binding_id=lb.root_binding_id
 AND la.binding_id=lb.binding_id AND la.binding_revision=lb.binding_revision AND la.namespace_sha256=lb.namespace_sha256
 AND la.binding_fingerprint_sha256=lb.binding_fingerprint_sha256 AND la.access='read_write' AND lc.state='passed' AND lc.cleanup_complete=1
 AND lact.admission_operation_id=lb.admission_operation_id AND lact.binding_revision=lb.binding_revision AND lact.namespace_sha256=lb.namespace_sha256 AND lact.created_at=lr.activated_at
 AND NOT EXISTS(SELECT 1 FROM local_storage_profile_activations retired WHERE retired.storage_profile_id=lact.storage_profile_id
 AND retired.action='retire' AND retired.binding_revision>=lact.binding_revision)));
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

PRAGMA defer_foreign_keys=OFF;
