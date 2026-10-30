-- Expand only the historical R2 alias CHECK. The immutable source cells,
-- signed int64 rowids, indexes and every attached trigger remain identical.
PRAGMA defer_foreign_keys=ON;
PRAGMA legacy_alter_table=ON;
CREATE TABLE assets_recovery_next (
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
CHECK((r2_key IS NOT NULL AND storage_profile_id IS NULL AND storage_profile_revision IS NULL AND object_key IS NULL)
 OR(r2_key IS NULL AND file_id IS NOT NULL AND storage_profile_id IS NOT NULL AND storage_profile_revision=1 AND object_key IS NOT NULL))
);
INSERT INTO assets_recovery_next(rowid,id,import_id,r2_key,original_name,mime_type,byte_size,status,sha256,actor_email,created_at,file_id,storage_profile_id,storage_profile_revision,object_key) SELECT rowid,id,import_id,r2_key,original_name,mime_type,byte_size,status,sha256,actor_email,created_at,file_id,storage_profile_id,storage_profile_revision,object_key FROM assets;
DROP TABLE assets;
ALTER TABLE assets_recovery_next RENAME TO assets;
PRAGMA legacy_alter_table=OFF;
CREATE INDEX assets_file_id_idx ON assets(file_id) WHERE file_id IS NOT NULL;
CREATE INDEX assets_import_idx ON assets(import_id);
CREATE UNIQUE INDEX assets_native_file_alias ON assets(storage_profile_id,object_key) WHERE r2_key IS NULL;
CREATE INDEX assets_sha256_lookup_idx
ON assets(sha256, status)
WHERE sha256 IS NOT NULL;
CREATE INDEX file_shadow_dependency_assets_key_idx ON assets(json_array( CASE WHEN typeof(id)='blob' THEN json_object('$sqliteBlob',hex(id)) ELSE id END ));
CREATE TRIGGER assets_native_delete_guard BEFORE DELETE ON assets WHEN OLD.file_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'Native alias provenance is retained'); END;
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
CREATE TRIGGER assets_native_update_guard BEFORE UPDATE ON assets WHEN OLD.file_id IS NOT NULL OR NEW.file_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'Native File alias identity is immutable') WHERE NEW.rowid IS NOT OLD.rowid OR NEW.id IS NOT OLD.id
 OR NEW.file_id IS NOT OLD.file_id OR NEW.storage_profile_id IS NOT OLD.storage_profile_id OR NEW.storage_profile_revision IS NOT OLD.storage_profile_revision
 OR NEW.object_key IS NOT OLD.object_key OR NEW.r2_key IS NOT OLD.r2_key OR NEW.sha256 IS NOT OLD.sha256 OR NEW.byte_size IS NOT OLD.byte_size
 OR NEW.import_id IS NOT OLD.import_id; END;
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

-- Portable FP5 byte and origin evidence. These rows grant no execution and do
-- not depend on the installation-local jobs, target claims or cleanup grants.
CREATE TABLE recovery_file_evidence (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 128 AND instr(id,char(0))=0),
 backup_id TEXT NOT NULL CHECK(length(backup_id) BETWEEN 1 AND 128 AND instr(backup_id,char(0))=0),
 source_image_sha256 TEXT NOT NULL CHECK(length(source_image_sha256)=64 AND source_image_sha256 NOT GLOB '*[^0-9a-f]*'),
 destination_metadata_sha256 TEXT NOT NULL CHECK(length(destination_metadata_sha256)=64 AND destination_metadata_sha256 NOT GLOB '*[^0-9a-f]*'),
 source_locator_json TEXT NOT NULL CHECK(json_valid(source_locator_json) AND json_type(source_locator_json)='object' AND length(CAST(source_locator_json AS BLOB))<=16384),
 source_file_id TEXT REFERENCES files(id) ON DELETE RESTRICT,
 destination_file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
 location_id TEXT NOT NULL UNIQUE REFERENCES file_location_publications(location_id) ON DELETE RESTRICT,
 profile_id TEXT NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
 profile_revision INTEGER NOT NULL CHECK(typeof(profile_revision)='integer' AND profile_revision=1),
 namespace_identity TEXT NOT NULL CHECK(length(namespace_identity) BETWEEN 1 AND 2048 AND instr(namespace_identity,char(0))=0),
 object_key TEXT NOT NULL CHECK(length(object_key) BETWEEN 1 AND 4096 AND instr(object_key,char(0))=0),
 purpose TEXT NOT NULL CHECK(purpose IN('research_source','embedded_content','derived_preview','provenance','job_output')),
 byte_size INTEGER NOT NULL CHECK(typeof(byte_size)='integer' AND byte_size BETWEEN 0 AND 100663296),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
 verification_operation_id TEXT NOT NULL CHECK(verification_operation_id='fp5:'||id),
 verified_at TEXT NOT NULL CHECK(datetime(verified_at) IS NOT NULL),
 published_at TEXT NOT NULL CHECK(datetime(published_at) IS NOT NULL AND julianday(published_at)>=julianday(verified_at)),
 producer_trust TEXT NOT NULL CHECK((purpose='derived_preview' AND producer_trust='untrusted_import') OR(purpose<>'derived_preview' AND producer_trust='opaque_recovery')),
 created_at TEXT NOT NULL CHECK(datetime(created_at) IS NOT NULL),
 UNIQUE(id,destination_file_id),
 FOREIGN KEY(location_id,destination_file_id) REFERENCES file_location_publications(location_id,file_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE TABLE recovery_file_alias_evidence (
 evidence_id TEXT NOT NULL,
 table_name TEXT NOT NULL CHECK(table_name IN('assets','managed_storage_objects')),
 alias_id TEXT NOT NULL CHECK(length(alias_id) BETWEEN 1 AND 256 AND instr(alias_id,char(0))=0),
 original_json TEXT NOT NULL CHECK(json_valid(original_json) AND json_type(original_json)='object' AND length(CAST(original_json AS BLOB))<=24576),
 destination_file_id TEXT NOT NULL,
 PRIMARY KEY(evidence_id,table_name,alias_id),
 FOREIGN KEY(evidence_id,destination_file_id) REFERENCES recovery_file_evidence(id,destination_file_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE TABLE recovery_file_binding_evidence (
 evidence_id TEXT NOT NULL REFERENCES recovery_file_evidence(id) ON DELETE RESTRICT,
 consumer_kind TEXT NOT NULL CHECK(consumer_kind IN('state_representation_asset','run_step_asset','metrology_template_reference','run_step_comment','state_verification','comment_submission_item','project_content_attachment','attachment_derivative','event','import','template_version')),
 consumer_id TEXT NOT NULL CHECK(length(consumer_id) BETWEEN 1 AND 256 AND instr(consumer_id,char(0))=0),
 consumer_sub_id TEXT NOT NULL CHECK(length(consumer_sub_id)<=256 AND instr(consumer_sub_id,char(0))=0),
 file_slot TEXT NOT NULL CHECK(file_slot IN('primary','evidence','derived','thumbnail','workbook','manifest','source')),
 purpose TEXT NOT NULL CHECK(purpose IN('research_source','embedded_content','derived_preview','provenance','job_output')),
 source_file_id TEXT REFERENCES files(id) ON DELETE RESTRICT,
 row_sha256 TEXT NOT NULL CHECK(length(row_sha256)=64 AND row_sha256 NOT GLOB '*[^0-9a-f]*'),
 preview_origin_json TEXT NOT NULL CHECK(json_valid(preview_origin_json) AND json_type(preview_origin_json)='object' AND length(CAST(preview_origin_json AS BLOB))<=8192),
 PRIMARY KEY(evidence_id,consumer_kind,consumer_id,consumer_sub_id,file_slot)
) WITHOUT ROWID;
CREATE TRIGGER recovery_file_evidence_insert_guard BEFORE INSERT ON recovery_file_evidence BEGIN
 SELECT RAISE(ABORT,'Recovery byte proof must match its complete readback publication') WHERE NOT EXISTS(
  SELECT 1 FROM file_location_publications l JOIN files f ON f.id=l.file_id JOIN storage_profiles p ON p.id=l.storage_profile_id
  WHERE l.location_id=NEW.location_id AND l.file_id=NEW.destination_file_id AND l.storage_profile_id=NEW.profile_id
   AND l.object_key=NEW.object_key AND l.verified_byte_size=NEW.byte_size AND l.verified_sha256=NEW.sha256
   AND l.verification_method='full_read_sha256' AND l.verification_operation_id=NEW.verification_operation_id
   AND l.verified_at=NEW.verified_at AND l.published_at=NEW.published_at AND f.purpose=NEW.purpose
   AND f.access_scope='system' AND(f.expected_byte_size IS NULL OR f.expected_byte_size=NEW.byte_size)
   AND(f.expected_sha256 IS NULL OR f.expected_sha256=NEW.sha256)
   AND p.configuration_revision=NEW.profile_revision AND p.namespace_identity=NEW.namespace_identity);
END;
CREATE TRIGGER recovery_file_evidence_update_guard BEFORE UPDATE ON recovery_file_evidence
 BEGIN SELECT RAISE(ABORT,'Recovery byte proof is immutable'); END;
CREATE TRIGGER recovery_file_evidence_delete_guard BEFORE DELETE ON recovery_file_evidence
 BEGIN SELECT RAISE(ABORT,'Recovery byte proof remains portable provenance'); END;
CREATE TRIGGER recovery_file_alias_evidence_update_guard BEFORE UPDATE ON recovery_file_alias_evidence
 BEGIN SELECT RAISE(ABORT,'Recovery alias origin is immutable'); END;
CREATE TRIGGER recovery_file_alias_evidence_delete_guard BEFORE DELETE ON recovery_file_alias_evidence
 BEGIN SELECT RAISE(ABORT,'Recovery alias origin remains portable provenance'); END;
CREATE TRIGGER recovery_file_binding_evidence_update_guard BEFORE UPDATE ON recovery_file_binding_evidence
 BEGIN SELECT RAISE(ABORT,'Recovery binding origin is immutable'); END;
CREATE TRIGGER recovery_file_binding_evidence_delete_guard BEFORE DELETE ON recovery_file_binding_evidence
 BEGIN SELECT RAISE(ABORT,'Recovery binding origin remains portable provenance'); END;
CREATE TRIGGER assets_recovery_insert_guard BEFORE INSERT ON assets
 WHEN NEW.r2_key IS NOT NULL AND NEW.file_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'Historical typed alias requires exact portable recovery origin') WHERE NOT EXISTS(
  SELECT 1 FROM recovery_file_alias_evidence a JOIN recovery_file_evidence e ON e.id=a.evidence_id
  WHERE a.table_name='assets' AND a.alias_id=NEW.id AND a.destination_file_id=NEW.file_id
   AND e.destination_file_id=NEW.file_id AND NEW.storage_profile_id IS NULL AND NEW.storage_profile_revision IS NULL AND NEW.object_key IS NULL
   AND json_extract(a.original_json,'$.id') IS NEW.id AND json_extract(a.original_json,'$.r2_key') IS NEW.r2_key
   AND json_extract(a.original_json,'$.import_id') IS NEW.import_id AND json_extract(a.original_json,'$.original_name') IS NEW.original_name
   AND json_extract(a.original_json,'$.mime_type') IS NEW.mime_type AND json_extract(a.original_json,'$.byte_size') IS NEW.byte_size
   AND json_extract(a.original_json,'$.sha256') IS NEW.sha256 AND json_extract(a.original_json,'$.actor_email') IS NEW.actor_email
   AND json_extract(a.original_json,'$.created_at') IS NEW.created_at);
END;
-- DROP/recreate can leave obsolete deferred-FK counters in SQLite even when
-- every final reference is valid. Verify the entire resulting graph before
-- clearing that counter; foreign_keys remains ON throughout this migration.
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE json('FP5 migration foreign keys invalid') END;
PRAGMA defer_foreign_keys=OFF;
