-- FP2 native namespace registration only. No native S3 I/O, file locations,
-- role selection or writer activation is admitted by this generation.
-- Preserve all historical profile rowids and their existing runtime, claims,
-- references and source dependency histories without firing copy-time triggers.
PRAGMA defer_foreign_keys = ON;
PRAGMA legacy_alter_table = ON;
CREATE TABLE storage_profiles_native_next (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 256 AND instr(id, char(0)) = 0),
  adapter_type TEXT NOT NULL CHECK (adapter_type IN ('r2', 'switchdrive', 's3')),
  namespace_identity TEXT NOT NULL CHECK (length(namespace_identity) BETWEEN 1 AND 2048 AND instr(namespace_identity, char(0)) = 0),
  configuration_source TEXT NOT NULL CHECK (configuration_source IN ('bootstrap', 'environment', 'system')),
  credential_reference TEXT CHECK (credential_reference IS NULL OR credential_reference = 'environment:SWITCHDRIVE'),
  configuration_revision INTEGER NOT NULL CHECK (typeof(configuration_revision) = 'integer' AND configuration_revision = 1),
  state TEXT NOT NULL CHECK (state = 'historical'),
  created_at TEXT NOT NULL,
  UNIQUE (adapter_type, namespace_identity),
  CHECK ((adapter_type = 'r2' AND configuration_source = 'bootstrap' AND credential_reference IS NULL)
    OR (adapter_type = 'switchdrive' AND configuration_source = 'environment' AND credential_reference IS 'environment:SWITCHDRIVE')
    OR (adapter_type = 's3' AND configuration_source = 'system' AND credential_reference IS NULL))
);

INSERT INTO storage_profiles_native_next(rowid,id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at)
SELECT rowid,id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at FROM storage_profiles;
DROP TABLE storage_profiles;
ALTER TABLE storage_profiles_native_next RENAME TO storage_profiles;
PRAGMA legacy_alter_table = OFF;

-- Reinstall the exact pre-existing attached indexes and triggers. Other tables'
-- FK/view/trigger definitions keep their original storage_profiles references.
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
CREATE TRIGGER file_locations_native_admission_guard BEFORE INSERT ON file_locations BEGIN
  SELECT RAISE(ABORT,'Native S3 locations require a later storage generation')
    WHERE EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='s3');
END;
CREATE TRIGGER storage_profile_runtime_native_admission_guard BEFORE UPDATE ON storage_profile_runtime BEGIN
  SELECT RAISE(ABORT,'Native S3 registration remains read-only')
    WHERE EXISTS(SELECT 1 FROM storage_profiles WHERE id=NEW.storage_profile_id AND adapter_type='s3')
      AND (NEW.state<>'read_only' OR NEW.activated_at IS NOT NULL OR NEW.retired_at IS NOT NULL);
END;

-- Portable historical evidence only. No credential reference, ciphertext,
-- endpoint, native binding or foreign key into installation-local system data.
CREATE TABLE storage_profile_admissions (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK(length(operation_id)=36 AND operation_id=lower(operation_id)
    AND substr(operation_id,9,1)='-' AND substr(operation_id,14,1)='-' AND substr(operation_id,19,1)='-' AND substr(operation_id,24,1)='-'
    AND length(replace(operation_id,'-',''))=32 AND replace(operation_id,'-','') NOT GLOB '*[^0-9a-f]*'
    AND substr(operation_id,15,1) GLOB '[1-8]' AND substr(operation_id,20,1) GLOB '[89ab]'),
  native_profile_id TEXT NOT NULL UNIQUE REFERENCES storage_profiles(id) ON DELETE RESTRICT,
  candidate_profile_id TEXT NOT NULL CHECK(length(candidate_profile_id) BETWEEN 1 AND 256 AND instr(candidate_profile_id,char(0))=0),
  candidate_revision INTEGER NOT NULL CHECK(typeof(candidate_revision)='integer' AND candidate_revision BETWEEN 1 AND 9007199254740991),
  envelope_revision INTEGER NOT NULL CHECK(typeof(envelope_revision)='integer' AND envelope_revision BETWEEN 1 AND 9007199254740991),
  check_id TEXT NOT NULL CHECK(length(check_id)=36 AND check_id=lower(check_id)
    AND substr(check_id,9,1)='-' AND substr(check_id,14,1)='-' AND substr(check_id,19,1)='-' AND substr(check_id,24,1)='-'
    AND length(replace(check_id,'-',''))=32 AND replace(check_id,'-','') NOT GLOB '*[^0-9a-f]*'
    AND substr(check_id,15,1) GLOB '[1-8]' AND substr(check_id,20,1) GLOB '[89ab]'),
  configuration_sha256 TEXT NOT NULL CHECK(length(configuration_sha256)=64 AND configuration_sha256 NOT GLOB '*[^0-9a-f]*'),
  namespace_sha256 TEXT NOT NULL CHECK(length(namespace_sha256)=64 AND namespace_sha256 NOT GLOB '*[^0-9a-f]*'),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 254 AND instr(actor,char(0))=0),
  created_at TEXT NOT NULL CHECK(created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',created_at))
) WITHOUT ROWID;
CREATE TRIGGER storage_profile_admissions_insert_guard BEFORE INSERT ON storage_profile_admissions BEGIN
  SELECT RAISE(ABORT,'Native profile admission is immutable')
    WHERE EXISTS(SELECT 1 FROM storage_profile_admissions WHERE operation_id=NEW.operation_id OR native_profile_id=NEW.native_profile_id);
  SELECT RAISE(ABORT,'Native profile admission requires its read-only identity') WHERE NOT EXISTS(
    SELECT 1 FROM storage_profiles p JOIN storage_profile_runtime r ON r.storage_profile_id=p.id
    WHERE p.id=NEW.native_profile_id AND p.id='storage-profile:aws-s3:'||NEW.namespace_sha256
      AND p.adapter_type='s3' AND p.configuration_source='system' AND p.credential_reference IS NULL
      AND p.configuration_revision=1 AND p.state='historical' AND p.created_at=NEW.created_at
      AND r.state='read_only' AND r.activated_at IS NULL AND r.retired_at IS NULL);
END;
CREATE TRIGGER storage_profile_admissions_update_guard BEFORE UPDATE ON storage_profile_admissions BEGIN
  SELECT RAISE(ABORT,'Native profile admission is immutable');
END;
CREATE TRIGGER storage_profile_admissions_delete_guard BEFORE DELETE ON storage_profile_admissions BEGIN
  SELECT RAISE(ABORT,'Native profile admission cannot be deleted');
END;

-- DROP/recreate of a referenced parent leaves SQLite's deferred violation
-- counter nonzero even after identical parent keys have been restored. Before
-- resetting that counter, reject EVERY actual FK violation in this transaction.
-- Never remove this assertion or replace it with an unchecked defer=OFF.
SELECT CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_check)
  THEN json('Native profile migration found a foreign key violation') ELSE 1 END;
PRAGMA defer_foreign_keys = OFF;

CREATE TRIGGER file_native_storage_profiles_generation_complete BEFORE INSERT ON storage_profile_admissions BEGIN
  SELECT 1;
END;
