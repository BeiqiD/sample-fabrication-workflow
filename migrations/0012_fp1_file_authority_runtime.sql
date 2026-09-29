-- Active File writer substrate only. This migration does not activate File
-- authority, enable a profile, or change a storage binding. Legacy/overlap
-- retain their existing publication, SHA reuse and typed-binding behavior.
-- These views join the existing executor receipts; no second ledger is added.

-- Keep each compound leaf within D1's five-term limit.
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
FROM imports r WHERE r.client_request_id IS NOT NULL AND r.status='pending' AND r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
UNION ALL
SELECT 'import_file',r.id,'manifest',r.operation_id,json_extract(r.request_input_json,'$.manifest.purpose'),
  r.request_scope,r.storage_profile_id,r.storage_profile_revision,json_extract(r.request_input_json,'$.manifest.byteSize'),
  json_extract(r.request_input_json,'$.manifest.sha256'),NULL,NULL
FROM imports r WHERE r.client_request_id IS NOT NULL AND r.status='pending' AND r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
UNION ALL
SELECT 'import_file',r.id,'image:'||json_extract(i.value,'$.localId'),r.operation_id,json_extract(i.value,'$.purpose'),
  r.request_scope,r.storage_profile_id,r.storage_profile_revision,json_extract(i.value,'$.byteSize'),json_extract(i.value,'$.sha256'),NULL,NULL
FROM imports r JOIN json_each(r.request_input_json,'$.images') i
WHERE r.client_request_id IS NOT NULL AND r.status='pending' AND r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

CREATE VIEW file_authority_pending_candidates AS
SELECT c.*,r.operation_id receipt_operation_id,r.alias_id receipt_alias_id,p.adapter_type
FROM file_acceptance_candidates c JOIN file_authority_pending_receipt_items r
  ON r.acceptance_kind=c.acceptance_kind AND r.acceptance_id=c.acceptance_id AND r.item_id=c.item_id
  AND r.purpose=c.purpose AND r.access_scope=c.access_scope AND r.storage_profile_id=c.storage_profile_id
  AND r.expected_byte_size=c.expected_byte_size AND r.expected_sha256=c.expected_sha256
  AND (r.candidate_object_key IS NULL OR r.candidate_object_key=c.candidate_object_key)
JOIN storage_profiles p ON p.id=c.storage_profile_id AND p.configuration_revision=r.storage_profile_revision
JOIN storage_profile_runtime runtime ON runtime.storage_profile_id=p.id AND runtime.state='read_write';

CREATE VIEW file_authority_usable_candidate_results AS
SELECT c.*,l.object_key result_object_key
FROM file_authority_pending_candidates c JOIN file_usable_publications f ON f.file_id=c.result_file_id
  AND f.active_location_id=c.result_location_id AND f.purpose=c.purpose AND f.access_scope=c.access_scope
  AND f.verified_byte_size=c.expected_byte_size AND f.verified_sha256=c.expected_sha256
JOIN file_location_publications l ON l.location_id=c.result_location_id AND l.file_id=c.result_file_id
  AND l.storage_profile_id=c.storage_profile_id AND l.verified_byte_size=c.expected_byte_size AND l.verified_sha256=c.expected_sha256
WHERE c.state='ready';

-- Alias guards also run from the existing import-ready AFTER trigger, after
-- the receipt ceased to be pending. Their authority is the immutable ready
-- candidate and its usable result, never a global content hash lookup.
CREATE VIEW file_authority_ready_candidate_aliases AS
SELECT c.*,l.object_key result_object_key,p.adapter_type,
  CASE c.acceptance_kind
    WHEN 'r2_upload' THEN (SELECT r.candidate_asset_id FROM r2_upload_requests r WHERE r.id=c.acceptance_id AND r.status IN('pending','ready'))
    WHEN 'metrology_reference' THEN (SELECT r.candidate_asset_id FROM metrology_reference_upload_requests r WHERE r.id=c.acceptance_id AND r.status IN('pending','ready'))
    WHEN 'comment_item' THEN (SELECT r.candidate_blob_id FROM comment_item_acceptances r WHERE r.item_id=c.acceptance_id AND r.status IN('pending','ready')) END alias_id
FROM file_acceptance_candidates c JOIN file_usable_publications f ON f.file_id=c.result_file_id
  AND f.active_location_id=c.result_location_id AND f.purpose=c.purpose AND f.access_scope=c.access_scope
  AND f.verified_byte_size=c.expected_byte_size AND f.verified_sha256=c.expected_sha256
JOIN file_location_publications l ON l.location_id=c.result_location_id AND l.file_id=c.result_file_id
  AND l.storage_profile_id=c.storage_profile_id AND l.verified_byte_size=c.expected_byte_size AND l.verified_sha256=c.expected_sha256
JOIN storage_profiles p ON p.id=c.storage_profile_id
WHERE c.state='ready' AND (c.acceptance_kind<>'import_file' OR EXISTS(
  SELECT 1 FROM imports r WHERE r.id=c.acceptance_id AND r.status IN('pending','ready') AND r.client_request_id IS NOT NULL));

-- Existing immutable-result and legacy-format guards remain installed. These
-- additional guards require the File result before accepting a ready receipt.
CREATE TRIGGER file_authority_r2_receipt_ready_guard BEFORE UPDATE ON r2_upload_requests
WHEN NEW.status='ready' AND (SELECT mode FROM file_authority_control WHERE singleton=1)='active'
BEGIN
  SELECT RAISE(ABORT,'Active upload requires its exact ready File candidate') WHERE NOT EXISTS (
    SELECT 1 FROM file_authority_usable_candidate_results c JOIN assets a
      ON a.id=json_extract(NEW.accepted_result_json,'$.id') AND a.r2_key=c.result_object_key
      AND a.r2_key=json_extract(NEW.accepted_result_json,'$.key') AND a.sha256=c.expected_sha256 AND a.byte_size=c.expected_byte_size
    WHERE c.acceptance_kind='r2_upload' AND c.acceptance_id=NEW.id AND c.item_id='' AND c.receipt_operation_id=NEW.operation_id);
END;

CREATE TRIGGER file_authority_metrology_receipt_ready_guard BEFORE UPDATE ON metrology_reference_upload_requests
WHEN NEW.status='ready' AND (SELECT mode FROM file_authority_control WHERE singleton=1)='active'
BEGIN
  SELECT RAISE(ABORT,'Active metrology receipt requires its exact ready File candidate') WHERE NOT EXISTS (
    SELECT 1 FROM file_authority_usable_candidate_results c JOIN metrology_template_references m
      ON m.id=json_extract(NEW.accepted_result_json,'$.reference.id') AND m.template_version_id=NEW.template_version_id
      AND m.file_id=c.result_file_id AND m.asset_id=json_extract(NEW.accepted_result_json,'$.assetId')
    JOIN assets a ON a.id=m.asset_id AND a.r2_key=c.result_object_key
      AND a.r2_key=json_extract(NEW.accepted_result_json,'$.reference.assetKey') AND a.sha256=c.expected_sha256 AND a.byte_size=c.expected_byte_size
    WHERE c.acceptance_kind='metrology_reference' AND c.acceptance_id=NEW.id AND c.item_id='' AND c.receipt_operation_id=NEW.operation_id);
END;

CREATE TRIGGER file_authority_comment_receipt_ready_guard BEFORE UPDATE ON comment_item_acceptances
WHEN NEW.status='ready' AND (SELECT mode FROM file_authority_control WHERE singleton=1)='active'
BEGIN
  SELECT RAISE(ABORT,'Active Comment item requires its exact ready File candidate') WHERE NOT EXISTS (
    SELECT 1 FROM file_authority_usable_candidate_results c JOIN comment_submission_items i
      ON i.id=NEW.item_id AND i.submission_id=NEW.submission_id AND i.file_id=c.result_file_id AND i.status='ready'
    WHERE c.acceptance_kind='comment_item' AND c.acceptance_id=NEW.item_id AND c.item_id=''
      AND c.result_object_key=json_extract(NEW.accepted_result_json,'$.objectKey'));
END;

-- Parent completion happens after item receipts became ready, so this check
-- reads their immutable results directly rather than the pending-only views.
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

CREATE TRIGGER file_authority_import_receipt_ready_guard BEFORE UPDATE ON imports
WHEN NEW.status='ready' AND OLD.status<>'ready' AND (SELECT mode FROM file_authority_control WHERE singleton=1)='active'
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
DROP TRIGGER file_shadow_location_publication_guard;
CREATE TRIGGER file_shadow_location_publication_guard BEFORE INSERT ON file_location_publications
BEGIN
 SELECT RAISE(ABORT,'File publication requires its exact verified executor candidate')
 WHERE NOT (((SELECT mode FROM file_authority_control WHERE singleton=1)='overlap' AND EXISTS(SELECT 1 FROM file_shadow_attempts a JOIN file_shadow_operations o ON o.id=a.operation_id JOIN file_shadow_heads h ON h.occurrence_id=o.occurrence_id AND h.present=1 WHERE o.id=NEW.verification_operation_id AND o.status='pending' AND a.state='verified' AND a.candidate_file_id=NEW.file_id AND a.candidate_location_id=NEW.location_id AND a.candidate_object_key=NEW.object_key AND o.destination_profile_id=NEW.storage_profile_id AND a.verified_byte_size=NEW.verified_byte_size AND a.verified_sha256=NEW.verified_sha256 AND (o.captured_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1) OR EXISTS(SELECT 1 FROM file_shadow_reconciliations r JOIN file_shadow_runtime_guard g ON g.enabled=1 AND g.incarnation=r.runtime_incarnation WHERE r.attempt_id=a.id AND r.verified_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1) AND r.verified_sha256=a.verified_sha256 AND r.verified_byte_size=a.verified_byte_size)) AND ((EXISTS(SELECT 1 FROM file_shadow_runtime_guard g WHERE g.singleton=1 AND g.enabled=1 AND g.incarnation=a.runtime_incarnation) AND julianday(a.lease_expires_at)>julianday('now')) OR EXISTS(SELECT 1 FROM file_shadow_reconciliations r JOIN file_shadow_runtime_guard g ON g.enabled=1 AND g.incarnation=r.runtime_incarnation WHERE r.attempt_id=a.id AND r.verified_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1) AND r.verified_sha256=a.verified_sha256 AND r.verified_byte_size=a.verified_byte_size))))
 OR ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS(SELECT 1 FROM file_authority_pending_candidates c
 WHERE c.state='candidate' AND c.candidate_file_id=NEW.file_id AND c.candidate_location_id=NEW.location_id
 AND c.candidate_object_key=NEW.object_key AND c.storage_profile_id=NEW.storage_profile_id
 AND c.expected_byte_size=NEW.verified_byte_size AND c.expected_sha256=NEW.verified_sha256
 AND c.receipt_operation_id=NEW.verification_operation_id AND NEW.verification_method='full_read_sha256')));
END;


DROP TRIGGER file_shadow_file_publication_guard;
CREATE TRIGGER file_shadow_file_publication_guard BEFORE INSERT ON file_publications
BEGIN
 SELECT RAISE(ABORT,'File publication requires its exact verified executor candidate')
 WHERE NOT (((SELECT mode FROM file_authority_control WHERE singleton=1)='overlap' AND EXISTS(SELECT 1 FROM file_location_publications p JOIN file_shadow_operations o ON o.id=p.verification_operation_id JOIN file_shadow_attempts a ON a.operation_id=o.id AND a.candidate_location_id=p.location_id WHERE p.location_id=NEW.active_location_id AND p.file_id=NEW.file_id AND a.candidate_file_id=NEW.file_id AND a.state='verified' AND o.status='pending' AND NEW.purpose IS o.purpose AND NEW.access_scope IS o.access_scope AND NEW.verified_byte_size=p.verified_byte_size AND NEW.verified_sha256=p.verified_sha256))
 OR ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS(SELECT 1 FROM file_authority_pending_candidates c JOIN file_location_publications l
 ON l.location_id=c.candidate_location_id AND l.file_id=c.candidate_file_id AND l.storage_profile_id=c.storage_profile_id
 AND l.object_key=c.candidate_object_key AND l.verification_operation_id=c.receipt_operation_id
 AND l.verification_method='full_read_sha256' AND l.verified_sha256=c.expected_sha256 AND l.verified_byte_size=c.expected_byte_size
 WHERE c.state='candidate' AND c.candidate_file_id=NEW.file_id AND c.candidate_location_id=NEW.active_location_id
 AND c.purpose=NEW.purpose AND c.access_scope=NEW.access_scope AND c.expected_byte_size=NEW.verified_byte_size
 AND c.expected_sha256=NEW.verified_sha256)));
END;


DROP TRIGGER assets_reject_live_sha_duplicate;
CREATE TRIGGER assets_reject_live_sha_duplicate
BEFORE INSERT ON assets
WHEN (NEW.sha256 IS NOT NULL AND (
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
   OR (c.acceptance_kind<>'import_file' AND NEW.import_id IS NULL AND c.alias_id=NEW.id))))
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live asset sha256 already registered');
END;


DROP TRIGGER assets_reject_live_sha_duplicate_update;
CREATE TRIGGER assets_reject_live_sha_duplicate_update
BEFORE UPDATE OF sha256, status, r2_key, import_id ON assets
WHEN (NEW.sha256 IS NOT NULL AND (
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
   OR (c.acceptance_kind<>'import_file' AND NEW.import_id IS NULL AND c.alias_id=NEW.id))))
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live asset sha256 already registered');
END;


DROP TRIGGER assets_reject_pending_import_sha_publication_insert;
CREATE TRIGGER assets_reject_pending_import_sha_publication_insert
BEFORE INSERT ON assets
WHEN (NEW.import_id IS NULL
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
   OR (c.acceptance_kind<>'import_file' AND NEW.import_id IS NULL AND c.alias_id=NEW.id))))
BEGIN
  SELECT RAISE(ABORT, 'matching asset is owned by a pending import');
END;


DROP TRIGGER assets_reject_pending_import_sha_publication_update;
CREATE TRIGGER assets_reject_pending_import_sha_publication_update
BEFORE UPDATE OF status, sha256, import_id ON assets
WHEN (NEW.import_id IS NULL
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
   OR (c.acceptance_kind<>'import_file' AND NEW.import_id IS NULL AND c.alias_id=NEW.id))))
BEGIN
  SELECT RAISE(ABORT, 'matching asset is owned by a pending import');
END;


DROP TRIGGER managed_storage_objects_reject_live_content_duplicate_insert;
CREATE TRIGGER managed_storage_objects_reject_live_content_duplicate_insert
BEFORE INSERT ON managed_storage_objects
WHEN (NEW.status = 'ready' AND EXISTS (
  SELECT 1 FROM managed_storage_objects mso
  WHERE mso.provider = NEW.provider
    AND mso.sha256 = NEW.sha256
    AND mso.byte_size = NEW.byte_size
    AND mso.status = 'ready'
    AND NOT EXISTS (
      SELECT 1 FROM blob_gc_ledger bg
      WHERE bg.store_kind = 'managed' AND bg.provider = mso.provider
        AND bg.object_key = mso.object_key
        AND bg.state IN ('deleting', 'deleted')
    )
    AND NOT EXISTS (
      SELECT 1 FROM blob_integrity_quarantine biq
      WHERE biq.store_kind = 'managed' AND biq.provider = mso.provider
        AND biq.object_key = mso.object_key
    )
)
) AND NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS(SELECT 1 FROM file_authority_ready_candidate_aliases c
 WHERE c.acceptance_kind='comment_item' AND c.adapter_type='switchdrive' AND NEW.provider='switchdrive'
 AND c.alias_id=NEW.id AND c.result_object_key=NEW.object_key AND c.expected_sha256=NEW.sha256
 AND c.expected_byte_size=NEW.byte_size AND NEW.status='ready'))
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live managed storage content already registered');
END;


DROP TRIGGER managed_storage_objects_reject_live_content_duplicate_update;
CREATE TRIGGER managed_storage_objects_reject_live_content_duplicate_update
BEFORE UPDATE OF provider, sha256, byte_size, status, object_key ON managed_storage_objects
WHEN (NEW.status = 'ready' AND EXISTS (
  SELECT 1 FROM managed_storage_objects mso
  WHERE mso.id <> NEW.id
    AND mso.provider = NEW.provider
    AND mso.sha256 = NEW.sha256
    AND mso.byte_size = NEW.byte_size
    AND mso.status = 'ready'
    AND NOT EXISTS (
      SELECT 1 FROM blob_gc_ledger bg
      WHERE bg.store_kind = 'managed' AND bg.provider = mso.provider
        AND bg.object_key = mso.object_key
        AND bg.state IN ('deleting', 'deleted')
    )
    AND NOT EXISTS (
      SELECT 1 FROM blob_integrity_quarantine biq
      WHERE biq.store_kind = 'managed' AND biq.provider = mso.provider
        AND biq.object_key = mso.object_key
    )
)
) AND NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS(SELECT 1 FROM file_authority_ready_candidate_aliases c
 WHERE c.acceptance_kind='comment_item' AND c.adapter_type='switchdrive' AND NEW.provider='switchdrive'
 AND c.alias_id=NEW.id AND c.result_object_key=NEW.object_key AND c.expected_sha256=NEW.sha256
 AND c.expected_byte_size=NEW.byte_size AND NEW.status='ready'))
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live managed storage content already registered');
END;


DROP TRIGGER comment_submission_items_file_insert_guard;
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
  );
END;


DROP TRIGGER comment_submission_items_file_update_guard;
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
  );
END;


CREATE TRIGGER state_representation_assets_active_file_required_insert BEFORE INSERT ON state_representation_assets
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.file_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER state_representation_assets_active_file_required_update BEFORE UPDATE ON state_representation_assets
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.file_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER run_step_assets_active_file_required_insert BEFORE INSERT ON run_step_assets
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.asset_id IS NOT NULL AND NEW.file_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER run_step_assets_active_file_required_update BEFORE UPDATE ON run_step_assets
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.asset_id IS NOT NULL AND NEW.file_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER metrology_template_references_active_file_required_insert BEFORE INSERT ON metrology_template_references
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.file_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER metrology_template_references_active_file_required_update BEFORE UPDATE ON metrology_template_references
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.file_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER run_step_comments_active_file_required_insert BEFORE INSERT ON run_step_comments
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.asset_id IS NOT NULL AND NEW.file_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER run_step_comments_active_file_required_update BEFORE UPDATE ON run_step_comments
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.asset_id IS NOT NULL AND NEW.file_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER state_verifications_active_file_required_insert BEFORE INSERT ON state_verifications
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.evidence_asset_id IS NOT NULL AND NEW.evidence_file_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER state_verifications_active_file_required_update BEFORE UPDATE ON state_verifications
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.evidence_asset_id IS NOT NULL AND NEW.evidence_file_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER comment_submission_items_active_file_required_insert BEFORE INSERT ON comment_submission_items
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.status='ready' AND NEW.kind<>'link' AND NEW.file_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER comment_submission_items_active_file_required_update BEFORE UPDATE ON comment_submission_items
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.status='ready' AND NEW.kind<>'link' AND NEW.file_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER project_content_attachments_active_file_required_insert BEFORE INSERT ON project_content_attachments
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.file_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER project_content_attachments_active_file_required_update BEFORE UPDATE ON project_content_attachments
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.file_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER attachment_derivatives_active_file_required_insert BEFORE INSERT ON attachment_derivatives
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.status='ready' AND NEW.derived_asset_id IS NOT NULL AND NEW.derived_file_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER attachment_derivatives_active_file_required_update BEFORE UPDATE ON attachment_derivatives
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.status='ready' AND NEW.derived_asset_id IS NOT NULL AND NEW.derived_file_id IS NULL)
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER events_active_file_required_insert BEFORE INSERT ON events
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND ((NULLIF(trim(NEW.asset_key),'') IS NOT NULL AND NEW.asset_file_id IS NULL) OR (json_valid(NEW.metadata_json) AND json_type(NEW.metadata_json,'$.thumbnailKey')='text' AND NULLIF(trim(json_extract(NEW.metadata_json,'$.thumbnailKey')),'') IS NOT NULL AND NEW.thumbnail_file_id IS NULL))
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER events_active_file_required_update BEFORE UPDATE ON events
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND ((NULLIF(trim(NEW.asset_key),'') IS NOT NULL AND NEW.asset_file_id IS NULL) OR (json_valid(NEW.metadata_json) AND json_type(NEW.metadata_json,'$.thumbnailKey')='text' AND NULLIF(trim(json_extract(NEW.metadata_json,'$.thumbnailKey')),'') IS NOT NULL AND NEW.thumbnail_file_id IS NULL))
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER imports_active_file_required_insert BEFORE INSERT ON imports
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.status='ready' AND ((NULLIF(trim(NEW.workbook_asset_key),'') IS NOT NULL AND NEW.workbook_file_id IS NULL) OR (NULLIF(trim(NEW.manifest_asset_key),'') IS NOT NULL AND NEW.manifest_file_id IS NULL)))
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER imports_active_file_required_update BEFORE UPDATE ON imports
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NEW.status='ready' AND ((NULLIF(trim(NEW.workbook_asset_key),'') IS NOT NULL AND NEW.workbook_file_id IS NULL) OR (NULLIF(trim(NEW.manifest_asset_key),'') IS NOT NULL AND NEW.manifest_file_id IS NULL)))
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER template_versions_active_file_required_insert BEFORE INSERT ON template_versions
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NULLIF(trim(NEW.source_asset_key),'') IS NOT NULL AND NEW.source_file_id IS NULL AND NOT EXISTS(SELECT 1 FROM imports owner WHERE owner.template_version_id=NEW.id AND owner.status='pending'))
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER template_versions_active_file_required_update BEFORE UPDATE ON template_versions
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND (NULLIF(trim(NEW.source_asset_key),'') IS NOT NULL AND NEW.source_file_id IS NULL AND NOT EXISTS(SELECT 1 FROM imports owner WHERE owner.template_version_id=NEW.id AND owner.status='pending'))
BEGIN SELECT RAISE(ABORT,'Active consumer requires a typed File binding'); END;


CREATE TRIGGER imports_active_receipt_insert_guard BEFORE INSERT ON imports
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND NEW.status='ready'
BEGIN SELECT RAISE(ABORT,'Active import must complete its accepted File candidates'); END;


CREATE TRIGGER file_authority_legacy_gc_insert_guard BEFORE INSERT ON blob_gc_ledger
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND NEW.state IN('deleting','deleted')
BEGIN SELECT RAISE(ABORT,'Active File authority rejects legacy locator deletion'); END;


CREATE TRIGGER file_authority_legacy_gc_update_guard BEFORE UPDATE ON blob_gc_ledger
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND NEW.state IN('deleting','deleted')
BEGIN SELECT RAISE(ABORT,'Active File authority rejects legacy locator deletion'); END;


CREATE TRIGGER file_authority_location_gc_retention_insert_guard BEFORE INSERT ON file_location_gc_ledger
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND NEW.state IN('orphaned','deleting','deleted')
BEGIN
 SELECT RAISE(ABORT,'Retained legacy namespace fences File location deletion') WHERE EXISTS(
  SELECT 1 FROM file_locations l JOIN file_shadow_retention_namespaces n
    ON n.storage_profile_id=l.storage_profile_id AND n.object_key=l.object_key
  JOIN blob_retention_edges e ON e.store_kind=n.store_kind AND e.provider=n.provider AND e.object_key=n.object_key
  WHERE l.id=NEW.location_id);
END;


CREATE TRIGGER file_authority_location_gc_retention_update_guard BEFORE UPDATE ON file_location_gc_ledger
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND NEW.state IN('orphaned','deleting','deleted')
BEGIN
 SELECT RAISE(ABORT,'Retained legacy namespace fences File location deletion') WHERE EXISTS(
  SELECT 1 FROM file_locations l JOIN file_shadow_retention_namespaces n
    ON n.storage_profile_id=l.storage_profile_id AND n.object_key=l.object_key
  JOIN blob_retention_edges e ON e.store_kind=n.store_kind AND e.provider=n.provider AND e.object_key=n.object_key
  WHERE l.id=NEW.location_id);
END;


-- Preserve overlap typed-column isolation while enabling the 0007 typed
-- purpose/readiness/fill-once guards to govern active business writes.

DROP TRIGGER file_shadow_state_representation_asset_primary_insert_typed_guard;
CREATE TRIGGER file_shadow_state_representation_asset_primary_insert_typed_guard BEFORE INSERT ON state_representation_assets BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_state_representation_asset_primary_update_typed_guard;
CREATE TRIGGER file_shadow_state_representation_asset_primary_update_typed_guard BEFORE UPDATE OF file_id ON state_representation_assets BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_run_step_asset_primary_insert_typed_guard;
CREATE TRIGGER file_shadow_run_step_asset_primary_insert_typed_guard BEFORE INSERT ON run_step_assets BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_run_step_asset_primary_update_typed_guard;
CREATE TRIGGER file_shadow_run_step_asset_primary_update_typed_guard BEFORE UPDATE OF file_id ON run_step_assets BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_metrology_template_reference_primary_insert_typed_guard;
CREATE TRIGGER file_shadow_metrology_template_reference_primary_insert_typed_guard BEFORE INSERT ON metrology_template_references BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_metrology_template_reference_primary_update_typed_guard;
CREATE TRIGGER file_shadow_metrology_template_reference_primary_update_typed_guard BEFORE UPDATE OF file_id ON metrology_template_references BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_run_step_comment_primary_insert_typed_guard;
CREATE TRIGGER file_shadow_run_step_comment_primary_insert_typed_guard BEFORE INSERT ON run_step_comments BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_run_step_comment_primary_update_typed_guard;
CREATE TRIGGER file_shadow_run_step_comment_primary_update_typed_guard BEFORE UPDATE OF file_id ON run_step_comments BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_state_verification_evidence_insert_typed_guard;
CREATE TRIGGER file_shadow_state_verification_evidence_insert_typed_guard BEFORE INSERT ON state_verifications BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.evidence_file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_state_verification_evidence_update_typed_guard;
CREATE TRIGGER file_shadow_state_verification_evidence_update_typed_guard BEFORE UPDATE OF evidence_file_id ON state_verifications BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.evidence_file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_comment_submission_item_primary_insert_typed_guard;
CREATE TRIGGER file_shadow_comment_submission_item_primary_insert_typed_guard BEFORE INSERT ON comment_submission_items BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_comment_submission_item_primary_update_typed_guard;
CREATE TRIGGER file_shadow_comment_submission_item_primary_update_typed_guard BEFORE UPDATE OF file_id ON comment_submission_items BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_project_content_attachment_primary_insert_typed_guard;
CREATE TRIGGER file_shadow_project_content_attachment_primary_insert_typed_guard BEFORE INSERT ON project_content_attachments BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_project_content_attachment_primary_update_typed_guard;
CREATE TRIGGER file_shadow_project_content_attachment_primary_update_typed_guard BEFORE UPDATE OF file_id ON project_content_attachments BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_attachment_derivative_derived_insert_typed_guard;
CREATE TRIGGER file_shadow_attachment_derivative_derived_insert_typed_guard BEFORE INSERT ON attachment_derivatives BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.derived_file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_attachment_derivative_derived_update_typed_guard;
CREATE TRIGGER file_shadow_attachment_derivative_derived_update_typed_guard BEFORE UPDATE OF derived_file_id ON attachment_derivatives BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.derived_file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_event_primary_insert_typed_guard;
CREATE TRIGGER file_shadow_event_primary_insert_typed_guard BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.asset_file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_event_primary_update_typed_guard;
CREATE TRIGGER file_shadow_event_primary_update_typed_guard BEFORE UPDATE OF asset_file_id ON events BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.asset_file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_event_thumbnail_insert_typed_guard;
CREATE TRIGGER file_shadow_event_thumbnail_insert_typed_guard BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.thumbnail_file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_event_thumbnail_update_typed_guard;
CREATE TRIGGER file_shadow_event_thumbnail_update_typed_guard BEFORE UPDATE OF thumbnail_file_id ON events BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.thumbnail_file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_import_workbook_insert_typed_guard;
CREATE TRIGGER file_shadow_import_workbook_insert_typed_guard BEFORE INSERT ON imports BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.workbook_file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_import_workbook_update_typed_guard;
CREATE TRIGGER file_shadow_import_workbook_update_typed_guard BEFORE UPDATE OF workbook_file_id ON imports BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.workbook_file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_import_manifest_insert_typed_guard;
CREATE TRIGGER file_shadow_import_manifest_insert_typed_guard BEFORE INSERT ON imports BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.manifest_file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_import_manifest_update_typed_guard;
CREATE TRIGGER file_shadow_import_manifest_update_typed_guard BEFORE UPDATE OF manifest_file_id ON imports BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.manifest_file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_template_version_source_insert_typed_guard;
CREATE TRIGGER file_shadow_template_version_source_insert_typed_guard BEFORE INSERT ON template_versions BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.source_file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

DROP TRIGGER file_shadow_template_version_source_update_typed_guard;
CREATE TRIGGER file_shadow_template_version_source_update_typed_guard BEFORE UPDATE OF source_file_id ON template_versions BEGIN SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.source_file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active'); END;

CREATE TRIGGER file_authority_runtime_generation_complete BEFORE DELETE ON file_authority_control BEGIN SELECT RAISE(ABORT,'V18 File authority runtime gate cannot be deleted'); END;

-- Local execution permission is never recovered from an archive. The immutable
-- shadow checkpoint is the canonical activation receipt; no new file identity
-- or verification claim is created by the authority switch.
CREATE TABLE file_authority_runtime_guard (
 singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
 incarnation TEXT CHECK(incarnation IS NULL OR (length(incarnation) BETWEEN 1 AND 256 AND instr(incarnation,char(0))=0)),
 enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
 enabled_by TEXT CHECK(enabled_by IS NULL OR (length(enabled_by) BETWEEN 1 AND 320 AND instr(enabled_by,char(0))=0)),
 updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL),
 CHECK(enabled=0 OR (incarnation IS NOT NULL AND enabled_by IS NOT NULL))
) WITHOUT ROWID;
INSERT INTO file_authority_runtime_guard VALUES(1,NULL,0,NULL,'2026-09-29T00:00:00.000Z');
CREATE TRIGGER file_authority_runtime_insert_guard BEFORE INSERT ON file_authority_runtime_guard BEGIN
 SELECT RAISE(ABORT,'File runtime admission is a local singleton'); END;
CREATE TRIGGER file_authority_runtime_delete_guard BEFORE DELETE ON file_authority_runtime_guard BEGIN
 SELECT RAISE(ABORT,'File runtime admission cannot be deleted'); END;
CREATE TRIGGER file_authority_runtime_update_guard BEFORE UPDATE ON file_authority_runtime_guard BEGIN
 SELECT RAISE(ABORT,'File execution requires a fresh explicitly enabled local incarnation')
 WHERE NEW.singleton<>OLD.singleton OR (NEW.enabled=1 AND (OLD.enabled=1 OR (NEW.incarnation IS OLD.incarnation AND NOT EXISTS(
   SELECT 1 FROM file_shadow_checkpoints cp JOIN file_authority_control a ON a.updated_at=cp.captured_at AND a.mode='active'
    WHERE cp.id=NEW.incarnation AND cp.captured_at=OLD.updated_at AND cp.captured_at=NEW.updated_at))
   OR NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')))
   OR (NEW.enabled=0 AND NEW.incarnation IS NOT OLD.incarnation AND NOT EXISTS(
    SELECT 1 FROM file_shadow_checkpoints cp JOIN file_shadow_control c ON c.epoch=cp.captured_epoch
     JOIN file_authority_control a ON a.singleton=c.singleton AND a.mode='overlap'
     JOIN file_shadow_runtime_guard r ON r.singleton=a.singleton AND r.enabled=0
    WHERE cp.id=NEW.incarnation AND cp.captured_at=NEW.updated_at AND cp.captured_by=NEW.enabled_by
     AND cp.current_count=cp.resolved_count AND cp.pending_count=0 AND cp.unresolved_count=0));
END;

CREATE VIEW file_authority_activation_bindings AS
 SELECT h.consumer_kind,h.consumer_id,h.consumer_sub_id,h.file_slot,h.source_rowid,h.occurrence_id,
 d.file_id,d.location_id,o.purpose
 FROM file_shadow_heads h JOIN file_shadow_decisions d ON d.occurrence_id=h.occurrence_id AND d.decision='resolved'
 JOIN file_shadow_operations o ON o.id=d.operation_id AND o.status='resolved'
 JOIN file_usable_publications f ON f.file_id=d.file_id AND f.active_location_id=d.location_id
   AND f.purpose=o.purpose AND f.access_scope=o.access_scope WHERE h.present=1;

DROP TRIGGER file_authority_control_update_guard;
CREATE TRIGGER file_authority_control_update_guard BEFORE UPDATE ON file_authority_control BEGIN
 SELECT RAISE(ABORT,'File authority requires explicit shadow enablement or a fresh complete activation checkpoint')
 WHERE NOT(NEW.singleton IS OLD.singleton AND NEW.revision IS OLD.revision AND
 ((OLD.mode='legacy' AND NEW.mode='overlap' AND EXISTS(SELECT 1 FROM file_shadow_enablements e
    WHERE e.singleton=1 AND e.expected_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1)
      AND NEW.updated_at IS e.enabled_at AND NEW.activated_at IS e.enabled_at))
  OR (OLD.mode='overlap' AND NEW.mode='active' AND NEW.activated_at IS OLD.activated_at
    AND EXISTS(SELECT 1 FROM file_authority_runtime_guard r JOIN file_shadow_checkpoints cp ON cp.id=r.incarnation
      WHERE r.singleton=1 AND r.enabled=0 AND r.updated_at=NEW.updated_at AND cp.captured_at=NEW.updated_at)
    AND NOT EXISTS(SELECT 1 FROM file_consumer_projection c LEFT JOIN file_authority_activation_bindings b
      ON b.consumer_kind=c.consumer_kind AND b.consumer_id=c.consumer_id AND b.consumer_sub_id=c.consumer_sub_id AND b.file_slot=c.file_slot
      WHERE c.file_id IS NULL OR c.file_id IS NOT b.file_id OR (c.expected_purpose IS NOT NULL AND c.expected_purpose IS NOT b.purpose))
    AND EXISTS(SELECT 1 FROM file_shadow_checkpoints c WHERE c.captured_at=NEW.updated_at
      AND c.captured_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1)
      AND c.current_count=c.resolved_count AND c.unresolved_count=0 AND c.pending_count=0
      AND c.current_count=(SELECT count(*) FROM file_shadow_heads WHERE present=1)
      AND c.current_count=(SELECT count(*) FROM file_authority_activation_bindings))
    AND (SELECT enabled FROM file_shadow_runtime_guard WHERE singleton=1)=0
    AND NOT EXISTS(SELECT 1 FROM file_shadow_attempts WHERE state IN('staged','write_started','unknown','verified'))
    AND NOT EXISTS(SELECT 1 FROM r2_upload_requests WHERE status='pending')
    AND NOT EXISTS(SELECT 1 FROM metrology_reference_upload_requests WHERE status='pending')
    AND NOT EXISTS(SELECT 1 FROM comment_submission_acceptances WHERE status='pending')
    AND NOT EXISTS(SELECT 1 FROM comment_item_acceptances WHERE status='pending')
    AND NOT EXISTS(SELECT 1 FROM imports WHERE status='pending')
    AND NOT EXISTS(SELECT 1 FROM imports i WHERE i.operation_id IS NOT NULL AND i.finalization_id IS NULL
      AND i.status='failed' AND i.recovery_operation_id IS NULL AND (i.template_version_id IS NOT NULL
       OR i.workbook_asset_key IS NOT NULL OR i.manifest_asset_key IS NOT NULL OR EXISTS(SELECT 1 FROM assets a WHERE a.import_id=i.id)))
    AND NOT EXISTS(SELECT 1 FROM r2_upload_requests r WHERE r.status='ready'
      AND r.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NOT EXISTS(
       SELECT 1 FROM file_authority_activation_bindings b JOIN file_shadow_occurrences occurrence ON occurrence.id=b.occurrence_id
       JOIN file_usable_publications f ON f.file_id=b.file_id JOIN assets a
        ON a.id=json_extract(r.accepted_result_json,'$.id') AND a.r2_key=json_extract(r.accepted_result_json,'$.key')
       WHERE occurrence.legacy_store_kind='r2' AND occurrence.legacy_object_key=a.r2_key
        AND f.purpose=r.purpose AND f.access_scope=r.request_scope
        AND f.verified_byte_size=json_extract(r.request_input_json,'$.file.byteSize')
        AND f.verified_sha256=json_extract(r.request_input_json,'$.file.sha256')
        AND a.byte_size=f.verified_byte_size AND a.sha256=f.verified_sha256))
    AND NOT EXISTS(SELECT 1 FROM comment_submissions WHERE status IN('draft','uploading','failed') AND retry_closed_at IS NULL AND deleted_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM file_acceptance_candidates WHERE state='candidate')
    AND NOT EXISTS(SELECT 1 FROM blob_gc_ledger WHERE state='deleting')
    AND NOT EXISTS(SELECT 1 FROM file_location_gc_ledger WHERE state='deleting')
 )));
END;

CREATE TRIGGER file_authority_activate AFTER UPDATE OF mode ON file_authority_control WHEN OLD.mode='overlap' AND NEW.mode='active'
 AND EXISTS(SELECT 1 FROM file_shadow_checkpoints WHERE captured_at=NEW.updated_at) BEGIN
 UPDATE file_authority_runtime_guard SET enabled=1,
  incarnation=(SELECT id FROM file_shadow_checkpoints WHERE captured_at=NEW.updated_at ORDER BY id LIMIT 1),
  enabled_by=(SELECT captured_by FROM file_shadow_checkpoints WHERE captured_at=NEW.updated_at ORDER BY id LIMIT 1),updated_at=NEW.updated_at WHERE singleton=1;
END;

CREATE TRIGGER file_authority_publication_execution_guard BEFORE INSERT ON file_location_publications
WHEN (SELECT mode FROM file_authority_control WHERE singleton=1)='active' BEGIN
 SELECT RAISE(ABORT,'File execution is paused on this installation')
 WHERE NOT EXISTS(SELECT 1 FROM file_authority_runtime_guard WHERE singleton=1 AND enabled=1);
END;
CREATE TRIGGER file_authority_gc_execution_guard BEFORE UPDATE ON file_location_gc_ledger
WHEN NEW.state='deleting' AND (SELECT mode FROM file_authority_control WHERE singleton=1)='active' BEGIN
 SELECT RAISE(ABORT,'File execution is paused on this installation')
 WHERE NOT EXISTS(SELECT 1 FROM file_authority_runtime_guard WHERE singleton=1 AND enabled=1);
END;

-- Active business copies keep their immutable legacy locator as evidence.
-- Physical availability comes from the exact typed File; business publication
-- and occurrence metadata checks below remain in force in every mode.


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
      AND pc.deleted_at IS NULL
      AND p.deleted_at IS NULL
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

DROP TRIGGER project_content_attachments_guard_integrity_insert;
CREATE TRIGGER project_content_attachments_guard_integrity_insert
BEFORE INSERT ON project_content_attachments
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined')
  WHERE NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.file_id AND fp.purpose='research_source')) AND NEW.asset_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
  SELECT RAISE(ABORT, 'blob locator is quarantined')
  WHERE NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.file_id AND fp.purpose='research_source')) AND NEW.storage_object_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM managed_storage_objects mso JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'managed' AND biq.provider = mso.provider
        AND biq.object_key = mso.object_key
    WHERE mso.id = NEW.storage_object_id
  );
  SELECT RAISE(ABORT, 'blob locator is unavailable')
  WHERE NEW.asset_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM assets a
    LEFT JOIN imports i ON i.id = a.import_id
    WHERE a.id = NEW.asset_id
      AND (
        a.status <> 'ready'
        OR (a.import_id IS NOT NULL AND (i.id IS NULL OR i.status <> 'ready'))
      )
  );
END;

DROP TRIGGER state_representation_assets_guard_blob_insert;
CREATE TRIGGER state_representation_assets_guard_blob_insert
BEFORE INSERT ON state_representation_assets
WHEN NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.file_id AND fp.purpose='embedded_content'))
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
END;

DROP TRIGGER state_representation_assets_guard_integrity_insert;
CREATE TRIGGER state_representation_assets_guard_integrity_insert
BEFORE INSERT ON state_representation_assets
WHEN NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.file_id AND fp.purpose='embedded_content'))
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

DROP TRIGGER run_step_assets_guard_blob_insert;
CREATE TRIGGER run_step_assets_guard_blob_insert
BEFORE INSERT ON run_step_assets
WHEN NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.file_id AND fp.purpose='embedded_content'))
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
END;

DROP TRIGGER run_step_assets_guard_integrity_insert;
CREATE TRIGGER run_step_assets_guard_integrity_insert
BEFORE INSERT ON run_step_assets
WHEN NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.file_id AND fp.purpose='embedded_content'))
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;


DROP TRIGGER run_step_comments_guard_blob_insert;
CREATE TRIGGER run_step_comments_guard_blob_insert
BEFORE INSERT ON run_step_comments
WHEN NEW.asset_id IS NOT NULL
  AND NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.file_id AND fp.purpose='embedded_content'))
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.asset_id);
END;

DROP TRIGGER run_step_comments_guard_integrity_insert;
CREATE TRIGGER run_step_comments_guard_integrity_insert
BEFORE INSERT ON run_step_comments
WHEN NEW.asset_id IS NOT NULL
  AND NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.file_id AND fp.purpose='embedded_content'))
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

DROP TRIGGER state_verifications_guard_blob_insert;
CREATE TRIGGER state_verifications_guard_blob_insert
BEFORE INSERT ON state_verifications
WHEN NEW.evidence_asset_id IS NOT NULL
  AND NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.evidence_file_id AND fp.purpose='embedded_content'))
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2' AND bg.object_key = a.r2_key
    WHERE a.id = NEW.evidence_asset_id AND bg.state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND state = 'orphaned'
    AND object_key = (SELECT r2_key FROM assets WHERE id = NEW.evidence_asset_id);
END;

DROP TRIGGER state_verifications_guard_integrity_insert;
CREATE TRIGGER state_verifications_guard_integrity_insert
BEFORE INSERT ON state_verifications
WHEN NEW.evidence_asset_id IS NOT NULL
  AND NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.evidence_file_id AND fp.purpose='embedded_content'))
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM assets a JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2' AND biq.object_key = a.r2_key
    WHERE a.id = NEW.evidence_asset_id
  );
END;

DROP TRIGGER events_guard_asset_key_insert;
CREATE TRIGGER events_guard_asset_key_insert
BEFORE INSERT ON events
WHEN NEW.asset_key IS NOT NULL AND NEW.asset_key <> ''
  AND NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.asset_file_id AND fp.purpose='embedded_content'))
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.asset_key
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.asset_key
    AND state = 'orphaned';
END;

DROP TRIGGER events_guard_asset_key_integrity_insert;
CREATE TRIGGER events_guard_asset_key_integrity_insert
BEFORE INSERT ON events
WHEN NEW.asset_key IS NOT NULL AND NEW.asset_key <> ''
  AND NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.asset_file_id AND fp.purpose='embedded_content'))
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2' AND object_key = NEW.asset_key
  );
END;

DROP TRIGGER events_guard_thumbnail_insert;
CREATE TRIGGER events_guard_thumbnail_insert
BEFORE INSERT ON events
WHEN NULLIF(TRIM( CASE WHEN json_valid(NEW.metadata_json)
  THEN json_extract(NEW.metadata_json, '$.thumbnailKey') END ), '') IS NOT NULL
  AND NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.thumbnail_file_id AND fp.purpose='derived_preview'))
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1 FROM blob_gc_ledger
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key = json_extract(NEW.metadata_json, '$.thumbnailKey')
      AND state IN ('deleting', 'deleted')
  );
  DELETE FROM blob_gc_ledger
  WHERE store_kind = 'r2' AND provider = 'r2'
    AND object_key = json_extract(NEW.metadata_json, '$.thumbnailKey')
    AND state = 'orphaned';
END;

DROP TRIGGER events_guard_thumbnail_integrity_insert;
CREATE TRIGGER events_guard_thumbnail_integrity_insert
BEFORE INSERT ON events
WHEN NULLIF(TRIM( CASE WHEN json_valid(NEW.metadata_json)
  THEN json_extract(NEW.metadata_json, '$.thumbnailKey') END ), '') IS NOT NULL
  AND NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.thumbnail_file_id AND fp.purpose='derived_preview'))
BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1 FROM blob_integrity_quarantine
    WHERE store_kind = 'r2' AND provider = 'r2'
      AND object_key = json_extract(NEW.metadata_json, '$.thumbnailKey')
  );
END;

DROP TRIGGER run_step_assets_guard_attachment_restore;
CREATE TRIGGER run_step_assets_guard_attachment_restore
BEFORE UPDATE OF deleted_at ON run_step_assets
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
  AND OLD.superseded_by_occurrence_id IS NULL
  AND NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.file_id AND fp.purpose='embedded_content'))
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE EXISTS (
    SELECT 1
    FROM assets a
    JOIN blob_gc_ledger bg
      ON bg.store_kind = 'r2' AND bg.provider = 'r2'
     AND bg.object_key = a.r2_key
    WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
  );
  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE EXISTS (
    SELECT 1
    FROM assets a
    JOIN blob_integrity_quarantine biq
      ON biq.store_kind = 'r2' AND biq.provider = 'r2'
     AND biq.object_key = a.r2_key
    WHERE a.id = NEW.asset_id
  );
END;

DROP TRIGGER comment_submission_items_guard_attachment_restore;
CREATE TRIGGER comment_submission_items_guard_attachment_restore
BEFORE UPDATE OF deleted_at ON comment_submission_items
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
  AND NOT ((SELECT mode FROM file_authority_control WHERE singleton=1)='active' AND EXISTS (SELECT 1 FROM file_usable_publications fp WHERE fp.file_id=NEW.file_id AND ((NEW.kind='attachment' AND fp.purpose='research_source') OR (NEW.kind='comment_image' AND NEW.related_item_id IS NULL AND fp.purpose='embedded_content') OR (NEW.kind='comment_image' AND NEW.related_item_id IS NOT NULL AND fp.purpose='derived_preview'))))
BEGIN
  SELECT RAISE(ABORT, 'blob locator is unavailable') WHERE (
    NEW.asset_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM assets a
      JOIN blob_gc_ledger bg
        ON bg.store_kind = 'r2' AND bg.provider = 'r2'
       AND bg.object_key = a.r2_key
      WHERE a.id = NEW.asset_id AND bg.state IN ('deleting', 'deleted')
    )
  ) OR (
    NEW.storage_object_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM managed_storage_objects mso
      JOIN blob_gc_ledger bg
        ON bg.store_kind = 'managed'
       AND bg.provider = mso.provider
       AND bg.object_key = mso.object_key
      WHERE mso.id = NEW.storage_object_id
        AND bg.state IN ('deleting', 'deleted')
    )
  );

  SELECT RAISE(ABORT, 'blob locator is quarantined') WHERE (
    NEW.asset_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM assets a
      JOIN blob_integrity_quarantine biq
        ON biq.store_kind = 'r2' AND biq.provider = 'r2'
       AND biq.object_key = a.r2_key
      WHERE a.id = NEW.asset_id
    )
  ) OR (
    NEW.storage_object_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM managed_storage_objects mso
      JOIN blob_integrity_quarantine biq
        ON biq.store_kind = 'managed'
       AND biq.provider = mso.provider
       AND biq.object_key = mso.object_key
      WHERE mso.id = NEW.storage_object_id
    )
  );
END;

-- Typed-only activation writes do not change the frozen legacy occurrence
-- snapshot. Limit capture to its original columns, including hidden-rowid
-- aliases, so D1 need not compile the full shadow graph thirteen times during
-- one authority UPDATE. Every original source mutation still captures normally.
DROP TRIGGER file_shadow_capture_attachment_derivatives_update;
CREATE TRIGGER file_shadow_capture_attachment_derivatives_update AFTER UPDATE OF "id","source_sha256","source_byte_size","derivative_kind","generator_version","derived_asset_id","status","error_code","retain_until","actor_email","created_at","updated_at","rowid","_rowid_","oid" ON attachment_derivatives BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1;  INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),s.consumer_kind,s.consumer_id,s.consumer_sub_id,s.file_slot,COALESCE(h.generation,0)+1,1,s.source_rowid,s.source_json,s.legacy_store_kind,s.legacy_provider,s.legacy_object_key,s.expected_purpose,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (WITH current_sources AS MATERIALIZED (SELECT * FROM file_shadow_sources) SELECT * FROM current_sources) s LEFT JOIN file_shadow_heads h ON h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot WHERE (1=1) AND (h.occurrence_id IS NULL OR h.present<>1 OR h.source_rowid IS NOT s.source_rowid OR h.source_json IS NOT s.source_json OR ((s.consumer_kind='attachment_derivative' AND s.file_slot='derived' AND s.consumer_id IS NEW.id AND (NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid))));
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

DROP TRIGGER file_shadow_capture_comment_submission_items_update;
CREATE TRIGGER file_shadow_capture_comment_submission_items_update AFTER UPDATE OF "id","submission_id","kind","status","position","filename","mime_type","byte_size","original_filename","original_mime_type","original_byte_size","title","description","external_url","asset_id","storage_object_id","sha256","related_item_id","error_message","created_at","updated_at","deleted_at","deleted_by","rowid","_rowid_","oid" ON comment_submission_items BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1; INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT 'comment_submission_items',json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ),COALESCE((SELECT MAX(v.revision) FROM file_shadow_dependency_versions v WHERE v.dependency_kind='comment_submission_items' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )),0)+1,1,json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'submission_id', CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END ,'kind', CASE WHEN typeof(x.kind)='blob' THEN json_object('$sqliteBlob',hex(x.kind)) ELSE x.kind END ,'status', CASE WHEN typeof(x.status)='blob' THEN json_object('$sqliteBlob',hex(x.status)) ELSE x.status END ,'asset_id', CASE WHEN typeof(x.asset_id)='blob' THEN json_object('$sqliteBlob',hex(x.asset_id)) ELSE x.asset_id END ,'storage_object_id', CASE WHEN typeof(x.storage_object_id)='blob' THEN json_object('$sqliteBlob',hex(x.storage_object_id)) ELSE x.storage_object_id END ,'sha256', CASE WHEN typeof(x.sha256)='blob' THEN json_object('$sqliteBlob',hex(x.sha256)) ELSE x.sha256 END ,'byte_size', CASE WHEN typeof(x.byte_size)='blob' THEN json_object('$sqliteBlob',hex(x.byte_size)) ELSE x.byte_size END ,'related_item_id', CASE WHEN typeof(x.related_item_id)='blob' THEN json_object('$sqliteBlob',hex(x.related_item_id)) ELSE x.related_item_id END ,'updated_at', CASE WHEN typeof(x.updated_at)='blob' THEN json_object('$sqliteBlob',hex(x.updated_at)) ELSE x.updated_at END ,'deleted_at', CASE WHEN typeof(x.deleted_at)='blob' THEN json_object('$sqliteBlob',hex(x.deleted_at)) ELSE x.deleted_at END )
  FROM comment_submission_items x WHERE NOT EXISTS(SELECT 1 FROM file_shadow_dependency_versions v WHERE v.dependency_kind='comment_submission_items' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ) AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key) AND v.present=1 AND v.snapshot_json IS json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'submission_id', CASE WHEN typeof(x.submission_id)='blob' THEN json_object('$sqliteBlob',hex(x.submission_id)) ELSE x.submission_id END ,'kind', CASE WHEN typeof(x.kind)='blob' THEN json_object('$sqliteBlob',hex(x.kind)) ELSE x.kind END ,'status', CASE WHEN typeof(x.status)='blob' THEN json_object('$sqliteBlob',hex(x.status)) ELSE x.status END ,'asset_id', CASE WHEN typeof(x.asset_id)='blob' THEN json_object('$sqliteBlob',hex(x.asset_id)) ELSE x.asset_id END ,'storage_object_id', CASE WHEN typeof(x.storage_object_id)='blob' THEN json_object('$sqliteBlob',hex(x.storage_object_id)) ELSE x.storage_object_id END ,'sha256', CASE WHEN typeof(x.sha256)='blob' THEN json_object('$sqliteBlob',hex(x.sha256)) ELSE x.sha256 END ,'byte_size', CASE WHEN typeof(x.byte_size)='blob' THEN json_object('$sqliteBlob',hex(x.byte_size)) ELSE x.byte_size END ,'related_item_id', CASE WHEN typeof(x.related_item_id)='blob' THEN json_object('$sqliteBlob',hex(x.related_item_id)) ELSE x.related_item_id END ,'updated_at', CASE WHEN typeof(x.updated_at)='blob' THEN json_object('$sqliteBlob',hex(x.updated_at)) ELSE x.updated_at END ,'deleted_at', CASE WHEN typeof(x.deleted_at)='blob' THEN json_object('$sqliteBlob',hex(x.deleted_at)) ELSE x.deleted_at END ));
  INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT v.dependency_kind,v.dependency_key,v.revision+1,0,'null' FROM file_shadow_dependency_versions v
  WHERE v.dependency_kind='comment_submission_items' AND v.present=1 AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key)
  AND NOT EXISTS(SELECT 1 FROM comment_submission_items x WHERE json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )=v.dependency_key); INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),s.consumer_kind,s.consumer_id,s.consumer_sub_id,s.file_slot,COALESCE(h.generation,0)+1,1,s.source_rowid,s.source_json,s.legacy_store_kind,s.legacy_provider,s.legacy_object_key,s.expected_purpose,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (WITH current_sources AS MATERIALIZED (SELECT * FROM file_shadow_sources) SELECT * FROM current_sources) s LEFT JOIN file_shadow_heads h ON h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot WHERE (1=1) AND (h.occurrence_id IS NULL OR h.present<>1 OR h.source_rowid IS NOT s.source_rowid OR h.source_json IS NOT s.source_json OR ((s.consumer_kind='comment_submission_item' AND s.file_slot='primary' AND s.consumer_id IS NEW.id AND (NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid))));
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

DROP TRIGGER file_shadow_capture_events_update;
CREATE TRIGGER file_shadow_capture_events_update AFTER UPDATE OF "id","sample_id","kind","body","asset_key","metadata_json","actor_email","created_at","rowid","_rowid_","oid" ON events BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1;  INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),s.consumer_kind,s.consumer_id,s.consumer_sub_id,s.file_slot,COALESCE(h.generation,0)+1,1,s.source_rowid,s.source_json,s.legacy_store_kind,s.legacy_provider,s.legacy_object_key,s.expected_purpose,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (WITH current_sources AS MATERIALIZED (SELECT * FROM file_shadow_sources) SELECT * FROM current_sources) s LEFT JOIN file_shadow_heads h ON h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot WHERE (1=1) AND (h.occurrence_id IS NULL OR h.present<>1 OR h.source_rowid IS NOT s.source_rowid OR h.source_json IS NOT s.source_json OR ((s.consumer_kind='event' AND s.file_slot='primary' AND s.consumer_id IS NEW.id AND (NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid)) OR (s.consumer_kind='event' AND s.file_slot='thumbnail' AND s.consumer_id IS NEW.id AND (NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid))));
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

DROP TRIGGER file_shadow_capture_imports_update;
CREATE TRIGGER file_shadow_capture_imports_update AFTER UPDATE OF "id","status","source_filename","source_sha256","sheet_name","template_type","recipe_family_id","template_version_id","workbook_asset_key","manifest_asset_key","warning_count","error_message","actor_email","created_at","completed_at","operation_id","lease_expires_at","finalization_id","recovery_operation_id","client_request_id","request_sha256","request_input_json","request_scope","storage_profile_id","storage_profile_revision","storage_policy_revision","accepted_result_json","rowid","_rowid_","oid" ON imports BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1; INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT 'imports',json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ),COALESCE((SELECT MAX(v.revision) FROM file_shadow_dependency_versions v WHERE v.dependency_kind='imports' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )),0)+1,1,json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'status', CASE WHEN typeof(x.status)='blob' THEN json_object('$sqliteBlob',hex(x.status)) ELSE x.status END ,'operation_id', CASE WHEN typeof(x.operation_id)='blob' THEN json_object('$sqliteBlob',hex(x.operation_id)) ELSE x.operation_id END ,'lease_expires_at', CASE WHEN typeof(x.lease_expires_at)='blob' THEN json_object('$sqliteBlob',hex(x.lease_expires_at)) ELSE x.lease_expires_at END ,'recovery_operation_id', CASE WHEN typeof(x.recovery_operation_id)='blob' THEN json_object('$sqliteBlob',hex(x.recovery_operation_id)) ELSE x.recovery_operation_id END ,'completed_at', CASE WHEN typeof(x.completed_at)='blob' THEN json_object('$sqliteBlob',hex(x.completed_at)) ELSE x.completed_at END ,'storage_profile_id', CASE WHEN typeof(x.storage_profile_id)='blob' THEN json_object('$sqliteBlob',hex(x.storage_profile_id)) ELSE x.storage_profile_id END ,'storage_profile_revision', CASE WHEN typeof(x.storage_profile_revision)='blob' THEN json_object('$sqliteBlob',hex(x.storage_profile_revision)) ELSE x.storage_profile_revision END ,'request_sha256', CASE WHEN typeof(x.request_sha256)='blob' THEN json_object('$sqliteBlob',hex(x.request_sha256)) ELSE x.request_sha256 END ,'request_scope', CASE WHEN typeof(x.request_scope)='blob' THEN json_object('$sqliteBlob',hex(x.request_scope)) ELSE x.request_scope END ,'accepted_result_json', CASE WHEN typeof(x.accepted_result_json)='blob' THEN json_object('$sqliteBlob',hex(x.accepted_result_json)) ELSE x.accepted_result_json END )
  FROM imports x WHERE NOT EXISTS(SELECT 1 FROM file_shadow_dependency_versions v WHERE v.dependency_kind='imports' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ) AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key) AND v.present=1 AND v.snapshot_json IS json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'status', CASE WHEN typeof(x.status)='blob' THEN json_object('$sqliteBlob',hex(x.status)) ELSE x.status END ,'operation_id', CASE WHEN typeof(x.operation_id)='blob' THEN json_object('$sqliteBlob',hex(x.operation_id)) ELSE x.operation_id END ,'lease_expires_at', CASE WHEN typeof(x.lease_expires_at)='blob' THEN json_object('$sqliteBlob',hex(x.lease_expires_at)) ELSE x.lease_expires_at END ,'recovery_operation_id', CASE WHEN typeof(x.recovery_operation_id)='blob' THEN json_object('$sqliteBlob',hex(x.recovery_operation_id)) ELSE x.recovery_operation_id END ,'completed_at', CASE WHEN typeof(x.completed_at)='blob' THEN json_object('$sqliteBlob',hex(x.completed_at)) ELSE x.completed_at END ,'storage_profile_id', CASE WHEN typeof(x.storage_profile_id)='blob' THEN json_object('$sqliteBlob',hex(x.storage_profile_id)) ELSE x.storage_profile_id END ,'storage_profile_revision', CASE WHEN typeof(x.storage_profile_revision)='blob' THEN json_object('$sqliteBlob',hex(x.storage_profile_revision)) ELSE x.storage_profile_revision END ,'request_sha256', CASE WHEN typeof(x.request_sha256)='blob' THEN json_object('$sqliteBlob',hex(x.request_sha256)) ELSE x.request_sha256 END ,'request_scope', CASE WHEN typeof(x.request_scope)='blob' THEN json_object('$sqliteBlob',hex(x.request_scope)) ELSE x.request_scope END ,'accepted_result_json', CASE WHEN typeof(x.accepted_result_json)='blob' THEN json_object('$sqliteBlob',hex(x.accepted_result_json)) ELSE x.accepted_result_json END ));
  INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT v.dependency_kind,v.dependency_key,v.revision+1,0,'null' FROM file_shadow_dependency_versions v
  WHERE v.dependency_kind='imports' AND v.present=1 AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key)
  AND NOT EXISTS(SELECT 1 FROM imports x WHERE json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )=v.dependency_key); INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),s.consumer_kind,s.consumer_id,s.consumer_sub_id,s.file_slot,COALESCE(h.generation,0)+1,1,s.source_rowid,s.source_json,s.legacy_store_kind,s.legacy_provider,s.legacy_object_key,s.expected_purpose,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (WITH current_sources AS MATERIALIZED (SELECT * FROM file_shadow_sources) SELECT * FROM current_sources) s LEFT JOIN file_shadow_heads h ON h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot WHERE (1=1) AND (h.occurrence_id IS NULL OR h.present<>1 OR h.source_rowid IS NOT s.source_rowid OR h.source_json IS NOT s.source_json OR ((s.consumer_kind='import' AND s.file_slot='workbook' AND s.consumer_id IS NEW.id AND (NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid)) OR (s.consumer_kind='import' AND s.file_slot='manifest' AND s.consumer_id IS NEW.id AND (NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid))));
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

DROP TRIGGER file_shadow_capture_metrology_template_references_update;
CREATE TRIGGER file_shadow_capture_metrology_template_references_update AFTER UPDATE OF "id","template_version_id","asset_id","display_name","position","actor_email","created_at","deleted_at","deleted_by","superseded_by_occurrence_id","superseded_at","superseded_by","supersession_operation_id","rowid","_rowid_","oid" ON metrology_template_references BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1;  INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),s.consumer_kind,s.consumer_id,s.consumer_sub_id,s.file_slot,COALESCE(h.generation,0)+1,1,s.source_rowid,s.source_json,s.legacy_store_kind,s.legacy_provider,s.legacy_object_key,s.expected_purpose,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (WITH current_sources AS MATERIALIZED (SELECT * FROM file_shadow_sources) SELECT * FROM current_sources) s LEFT JOIN file_shadow_heads h ON h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot WHERE (1=1) AND (h.occurrence_id IS NULL OR h.present<>1 OR h.source_rowid IS NOT s.source_rowid OR h.source_json IS NOT s.source_json OR ((s.consumer_kind='metrology_template_reference' AND s.file_slot='primary' AND s.consumer_id IS NEW.id AND (NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid))));
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

DROP TRIGGER file_shadow_capture_project_content_attachments_update;
CREATE TRIGGER file_shadow_capture_project_content_attachments_update AFTER UPDATE OF "project_content_id","asset_id","storage_object_id","original_name","mime_type","byte_size","created_by","created_at","creation_operation_id","rowid","_rowid_","oid" ON project_content_attachments BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1;  INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),s.consumer_kind,s.consumer_id,s.consumer_sub_id,s.file_slot,COALESCE(h.generation,0)+1,1,s.source_rowid,s.source_json,s.legacy_store_kind,s.legacy_provider,s.legacy_object_key,s.expected_purpose,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (WITH current_sources AS MATERIALIZED (SELECT * FROM file_shadow_sources) SELECT * FROM current_sources) s LEFT JOIN file_shadow_heads h ON h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot WHERE (1=1) AND (h.occurrence_id IS NULL OR h.present<>1 OR h.source_rowid IS NOT s.source_rowid OR h.source_json IS NOT s.source_json OR ((s.consumer_kind='project_content_attachment' AND s.file_slot='primary' AND s.consumer_id IS NEW.project_content_id AND (NEW.project_content_id IS NOT OLD.project_content_id OR NEW.rowid IS NOT OLD.rowid))));
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

DROP TRIGGER file_shadow_capture_run_step_assets_update;
CREATE TRIGGER file_shadow_capture_run_step_assets_update AFTER UPDATE OF "id","run_step_id","asset_id","role","position","actor_email","created_at","deleted_at","deleted_by","last_mutation_id","superseded_by_occurrence_id","superseded_at","superseded_by","supersession_operation_id","filename","mime_type","byte_size","rowid","_rowid_","oid" ON run_step_assets BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1;  INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),s.consumer_kind,s.consumer_id,s.consumer_sub_id,s.file_slot,COALESCE(h.generation,0)+1,1,s.source_rowid,s.source_json,s.legacy_store_kind,s.legacy_provider,s.legacy_object_key,s.expected_purpose,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (WITH current_sources AS MATERIALIZED (SELECT * FROM file_shadow_sources) SELECT * FROM current_sources) s LEFT JOIN file_shadow_heads h ON h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot WHERE (1=1) AND (h.occurrence_id IS NULL OR h.present<>1 OR h.source_rowid IS NOT s.source_rowid OR h.source_json IS NOT s.source_json OR ((s.consumer_kind='run_step_asset' AND s.file_slot='primary' AND s.consumer_id IS NEW.id AND (NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid))));
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

DROP TRIGGER file_shadow_capture_run_step_comments_update;
CREATE TRIGGER file_shadow_capture_run_step_comments_update AFTER UPDATE OF "id","run_step_id","scope","operation_group_id","asset_id","actor_email","created_at","submission_id","updated_at","updated_by","deleted_at","deleted_by","asset_deleted_at","asset_deleted_by","last_mutation_id","deletion_operation_id","asset_deletion_operation_id","legacy_body","rowid","_rowid_","oid" ON run_step_comments BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1;  INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),s.consumer_kind,s.consumer_id,s.consumer_sub_id,s.file_slot,COALESCE(h.generation,0)+1,1,s.source_rowid,s.source_json,s.legacy_store_kind,s.legacy_provider,s.legacy_object_key,s.expected_purpose,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (WITH current_sources AS MATERIALIZED (SELECT * FROM file_shadow_sources) SELECT * FROM current_sources) s LEFT JOIN file_shadow_heads h ON h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot WHERE (1=1) AND (h.occurrence_id IS NULL OR h.present<>1 OR h.source_rowid IS NOT s.source_rowid OR h.source_json IS NOT s.source_json OR ((s.consumer_kind='run_step_comment' AND s.file_slot='primary' AND s.consumer_id IS NEW.id AND (NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid))));
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

DROP TRIGGER file_shadow_capture_state_representation_assets_update;
CREATE TRIGGER file_shadow_capture_state_representation_assets_update AFTER UPDATE OF "state_hash","asset_id","position","rowid","_rowid_","oid" ON state_representation_assets BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1;  INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),s.consumer_kind,s.consumer_id,s.consumer_sub_id,s.file_slot,COALESCE(h.generation,0)+1,1,s.source_rowid,s.source_json,s.legacy_store_kind,s.legacy_provider,s.legacy_object_key,s.expected_purpose,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (WITH current_sources AS MATERIALIZED (SELECT * FROM file_shadow_sources) SELECT * FROM current_sources) s LEFT JOIN file_shadow_heads h ON h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot WHERE (1=1) AND (h.occurrence_id IS NULL OR h.present<>1 OR h.source_rowid IS NOT s.source_rowid OR h.source_json IS NOT s.source_json OR ((s.consumer_kind='state_representation_asset' AND s.file_slot='primary' AND s.consumer_id IS NEW.state_hash AND s.consumer_sub_id IS NEW.asset_id AND (NEW.state_hash IS NOT OLD.state_hash OR NEW.rowid IS NOT OLD.rowid OR NEW.asset_id IS NOT OLD.asset_id))));
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

DROP TRIGGER file_shadow_capture_state_verifications_update;
CREATE TRIGGER file_shadow_capture_state_verifications_update AFTER UPDATE OF "id","sample_id","after_run_step_id","previous_verification_id","run_plan_revision_id","expected_state_hash","result","evidence_asset_id","note","status","actor_email","created_at","rowid","_rowid_","oid" ON state_verifications BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1;  INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),s.consumer_kind,s.consumer_id,s.consumer_sub_id,s.file_slot,COALESCE(h.generation,0)+1,1,s.source_rowid,s.source_json,s.legacy_store_kind,s.legacy_provider,s.legacy_object_key,s.expected_purpose,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (WITH current_sources AS MATERIALIZED (SELECT * FROM file_shadow_sources) SELECT * FROM current_sources) s LEFT JOIN file_shadow_heads h ON h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot WHERE (1=1) AND (h.occurrence_id IS NULL OR h.present<>1 OR h.source_rowid IS NOT s.source_rowid OR h.source_json IS NOT s.source_json OR ((s.consumer_kind='state_verification' AND s.file_slot='evidence' AND s.consumer_id IS NEW.id AND (NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid))));
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

DROP TRIGGER file_shadow_capture_template_versions_update;
CREATE TRIGGER file_shadow_capture_template_versions_update AFTER UPDATE OF "id","recipe_family_id","name","template_type","version","manifest_hash","initial_state_hash","source_filename","source_asset_key","content_json","created_by","created_at","locked_at","locked_by","archived_at","archived_by","template_kind","metrology_notes","deleted_at","deleted_by","rowid","_rowid_","oid" ON template_versions BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1; INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT 'template_versions',json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ),COALESCE((SELECT MAX(v.revision) FROM file_shadow_dependency_versions v WHERE v.dependency_kind='template_versions' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )),0)+1,1,json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'template_kind', CASE WHEN typeof(x.template_kind)='blob' THEN json_object('$sqliteBlob',hex(x.template_kind)) ELSE x.template_kind END ,'source_asset_key', CASE WHEN typeof(x.source_asset_key)='blob' THEN json_object('$sqliteBlob',hex(x.source_asset_key)) ELSE x.source_asset_key END ,'archived_at', CASE WHEN typeof(x.archived_at)='blob' THEN json_object('$sqliteBlob',hex(x.archived_at)) ELSE x.archived_at END ,'deleted_at', CASE WHEN typeof(x.deleted_at)='blob' THEN json_object('$sqliteBlob',hex(x.deleted_at)) ELSE x.deleted_at END ,'locked_at', CASE WHEN typeof(x.locked_at)='blob' THEN json_object('$sqliteBlob',hex(x.locked_at)) ELSE x.locked_at END )
  FROM template_versions x WHERE NOT EXISTS(SELECT 1 FROM file_shadow_dependency_versions v WHERE v.dependency_kind='template_versions' AND v.dependency_key=json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ) AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key) AND v.present=1 AND v.snapshot_json IS json_object('id', CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END ,'template_kind', CASE WHEN typeof(x.template_kind)='blob' THEN json_object('$sqliteBlob',hex(x.template_kind)) ELSE x.template_kind END ,'source_asset_key', CASE WHEN typeof(x.source_asset_key)='blob' THEN json_object('$sqliteBlob',hex(x.source_asset_key)) ELSE x.source_asset_key END ,'archived_at', CASE WHEN typeof(x.archived_at)='blob' THEN json_object('$sqliteBlob',hex(x.archived_at)) ELSE x.archived_at END ,'deleted_at', CASE WHEN typeof(x.deleted_at)='blob' THEN json_object('$sqliteBlob',hex(x.deleted_at)) ELSE x.deleted_at END ,'locked_at', CASE WHEN typeof(x.locked_at)='blob' THEN json_object('$sqliteBlob',hex(x.locked_at)) ELSE x.locked_at END ));
  INSERT INTO file_shadow_dependency_versions(dependency_kind,dependency_key,revision,present,snapshot_json)
  SELECT v.dependency_kind,v.dependency_key,v.revision+1,0,'null' FROM file_shadow_dependency_versions v
  WHERE v.dependency_kind='template_versions' AND v.present=1 AND v.revision=(SELECT MAX(w.revision) FROM file_shadow_dependency_versions w WHERE w.dependency_kind=v.dependency_kind AND w.dependency_key=v.dependency_key)
  AND NOT EXISTS(SELECT 1 FROM template_versions x WHERE json_array( CASE WHEN typeof(x.id)='blob' THEN json_object('$sqliteBlob',hex(x.id)) ELSE x.id END )=v.dependency_key); INSERT INTO file_shadow_occurrences(id,consumer_kind,consumer_id,consumer_sub_id,file_slot,generation,present,source_rowid,source_json,legacy_store_kind,legacy_provider,legacy_object_key,expected_purpose,observed_epoch,observed_at)
    SELECT 'shadow:'||lower(hex(randomblob(16))),s.consumer_kind,s.consumer_id,s.consumer_sub_id,s.file_slot,COALESCE(h.generation,0)+1,1,s.source_rowid,s.source_json,s.legacy_store_kind,s.legacy_provider,s.legacy_object_key,s.expected_purpose,(SELECT epoch FROM file_shadow_control WHERE singleton=1),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM (WITH current_sources AS MATERIALIZED (SELECT * FROM file_shadow_sources) SELECT * FROM current_sources) s LEFT JOIN file_shadow_heads h ON h.consumer_kind IS s.consumer_kind AND h.consumer_id IS s.consumer_id AND h.consumer_sub_id IS s.consumer_sub_id AND h.file_slot IS s.file_slot WHERE (1=1) AND (h.occurrence_id IS NULL OR h.present<>1 OR h.source_rowid IS NOT s.source_rowid OR h.source_json IS NOT s.source_json OR ((s.consumer_kind='template_version' AND s.file_slot='source' AND s.consumer_id IS NEW.id AND (NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid))));
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


-- Evaluate the coherent checkpoint graph once. Re-expanding all source and
-- availability views for each scalar count exceeds native D1 statement memory.
DROP TRIGGER file_shadow_checkpoints_admission_guard;
CREATE TRIGGER file_shadow_checkpoints_admission_guard BEFORE INSERT ON file_shadow_checkpoints BEGIN
 SELECT RAISE(ABORT,'Catch-up checkpoint requires a current complete source graph') WHERE NOT (
  WITH sources AS MATERIALIZED (SELECT * FROM file_shadow_sources),
  current_summary AS MATERIALIZED (
   SELECT count(*) current_count,
    COALESCE(sum(d.decision='resolved' AND p.file_id IS NOT NULL AND p.active_location_id=d.location_id),0) resolved_count,
    COALESCE(sum(d.decision='admitted_unresolved'),0) unresolved_count
   FROM file_shadow_heads h LEFT JOIN file_shadow_decisions d ON d.occurrence_id=h.occurrence_id
   LEFT JOIN file_usable_publications p ON p.file_id=d.file_id WHERE h.present=1)
  SELECT (SELECT mode FROM file_authority_control WHERE singleton=1)='overlap'
   AND NEW.captured_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1)
   AND NEW.current_count=s.current_count AND NEW.resolved_count=s.resolved_count AND NEW.unresolved_count=s.unresolved_count
   AND NEW.pending_count=s.current_count-s.resolved_count-s.unresolved_count
   AND NOT EXISTS(SELECT 1 FROM file_shadow_heads h WHERE h.present=1 AND NOT EXISTS(SELECT 1 FROM sources source
    WHERE source.consumer_kind IS h.consumer_kind AND source.consumer_id IS h.consumer_id AND source.consumer_sub_id IS h.consumer_sub_id
     AND source.file_slot IS h.file_slot AND source.source_json IS h.source_json AND source.source_rowid IS h.source_rowid))
   AND NOT EXISTS(SELECT 1 FROM sources source WHERE NOT EXISTS(SELECT 1 FROM file_shadow_heads h
    WHERE h.present=1 AND source.consumer_kind IS h.consumer_kind AND source.consumer_id IS h.consumer_id
     AND source.consumer_sub_id IS h.consumer_sub_id AND source.file_slot IS h.file_slot))
   FROM current_summary s
 );
END;

-- Activation stages only exact current shadow bindings while legacy authority
-- still applies. Its final control update requires every binding usable. The
-- endpoint executes checkpoint, staging, bindings and switch in ONE D1 batch.
DROP TRIGGER file_shadow_state_representation_asset_primary_update_typed_guard;
CREATE TRIGGER file_shadow_state_representation_asset_primary_update_typed_guard BEFORE UPDATE OF file_id ON state_representation_assets BEGIN
 SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
 AND NOT (OLD.file_id IS NULL AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard r ON r.singleton=a.singleton
  JOIN file_shadow_checkpoints cp ON cp.id=r.incarnation JOIN file_shadow_control c ON c.epoch=cp.captured_epoch
  JOIN file_authority_activation_bindings b ON b.consumer_kind='state_representation_asset' AND b.consumer_id=NEW.state_hash
   AND b.consumer_sub_id=NEW.asset_id AND b.file_slot='primary' AND b.file_id=NEW.file_id AND b.source_rowid=NEW.rowid
  WHERE a.mode='overlap' AND r.enabled=0 AND r.updated_at=cp.captured_at AND cp.current_count=cp.resolved_count AND cp.pending_count=0 AND cp.unresolved_count=0));
END;

DROP TRIGGER file_shadow_run_step_asset_primary_update_typed_guard;
CREATE TRIGGER file_shadow_run_step_asset_primary_update_typed_guard BEFORE UPDATE OF file_id ON run_step_assets BEGIN
 SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
 AND NOT (OLD.file_id IS NULL AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard r ON r.singleton=a.singleton
  JOIN file_shadow_checkpoints cp ON cp.id=r.incarnation JOIN file_shadow_control c ON c.epoch=cp.captured_epoch
  JOIN file_authority_activation_bindings b ON b.consumer_kind='run_step_asset' AND b.consumer_id=NEW.id
   AND b.consumer_sub_id='' AND b.file_slot='primary' AND b.file_id=NEW.file_id AND b.source_rowid=NEW.rowid
  WHERE a.mode='overlap' AND r.enabled=0 AND r.updated_at=cp.captured_at AND cp.current_count=cp.resolved_count AND cp.pending_count=0 AND cp.unresolved_count=0));
END;

DROP TRIGGER file_shadow_metrology_template_reference_primary_update_typed_guard;
CREATE TRIGGER file_shadow_metrology_template_reference_primary_update_typed_guard BEFORE UPDATE OF file_id ON metrology_template_references BEGIN
 SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
 AND NOT (OLD.file_id IS NULL AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard r ON r.singleton=a.singleton
  JOIN file_shadow_checkpoints cp ON cp.id=r.incarnation JOIN file_shadow_control c ON c.epoch=cp.captured_epoch
  JOIN file_authority_activation_bindings b ON b.consumer_kind='metrology_template_reference' AND b.consumer_id=NEW.id
   AND b.consumer_sub_id='' AND b.file_slot='primary' AND b.file_id=NEW.file_id AND b.source_rowid=NEW.rowid
  WHERE a.mode='overlap' AND r.enabled=0 AND r.updated_at=cp.captured_at AND cp.current_count=cp.resolved_count AND cp.pending_count=0 AND cp.unresolved_count=0));
END;

DROP TRIGGER file_shadow_run_step_comment_primary_update_typed_guard;
CREATE TRIGGER file_shadow_run_step_comment_primary_update_typed_guard BEFORE UPDATE OF file_id ON run_step_comments BEGIN
 SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
 AND NOT (OLD.file_id IS NULL AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard r ON r.singleton=a.singleton
  JOIN file_shadow_checkpoints cp ON cp.id=r.incarnation JOIN file_shadow_control c ON c.epoch=cp.captured_epoch
  JOIN file_authority_activation_bindings b ON b.consumer_kind='run_step_comment' AND b.consumer_id=NEW.id
   AND b.consumer_sub_id='' AND b.file_slot='primary' AND b.file_id=NEW.file_id AND b.source_rowid=NEW.rowid
  WHERE a.mode='overlap' AND r.enabled=0 AND r.updated_at=cp.captured_at AND cp.current_count=cp.resolved_count AND cp.pending_count=0 AND cp.unresolved_count=0));
END;

DROP TRIGGER file_shadow_state_verification_evidence_update_typed_guard;
CREATE TRIGGER file_shadow_state_verification_evidence_update_typed_guard BEFORE UPDATE OF evidence_file_id ON state_verifications BEGIN
 SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.evidence_file_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
 AND NOT (OLD.evidence_file_id IS NULL AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard r ON r.singleton=a.singleton
  JOIN file_shadow_checkpoints cp ON cp.id=r.incarnation JOIN file_shadow_control c ON c.epoch=cp.captured_epoch
  JOIN file_authority_activation_bindings b ON b.consumer_kind='state_verification' AND b.consumer_id=NEW.id
   AND b.consumer_sub_id='' AND b.file_slot='evidence' AND b.file_id=NEW.evidence_file_id AND b.source_rowid=NEW.rowid
  WHERE a.mode='overlap' AND r.enabled=0 AND r.updated_at=cp.captured_at AND cp.current_count=cp.resolved_count AND cp.pending_count=0 AND cp.unresolved_count=0));
END;

DROP TRIGGER file_shadow_comment_submission_item_primary_update_typed_guard;
CREATE TRIGGER file_shadow_comment_submission_item_primary_update_typed_guard BEFORE UPDATE OF file_id ON comment_submission_items BEGIN
 SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
 AND NOT (OLD.file_id IS NULL AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard r ON r.singleton=a.singleton
  JOIN file_shadow_checkpoints cp ON cp.id=r.incarnation JOIN file_shadow_control c ON c.epoch=cp.captured_epoch
  JOIN file_authority_activation_bindings b ON b.consumer_kind='comment_submission_item' AND b.consumer_id=NEW.id
   AND b.consumer_sub_id='' AND b.file_slot='primary' AND b.file_id=NEW.file_id AND b.source_rowid=NEW.rowid
  WHERE a.mode='overlap' AND r.enabled=0 AND r.updated_at=cp.captured_at AND cp.current_count=cp.resolved_count AND cp.pending_count=0 AND cp.unresolved_count=0));
END;

DROP TRIGGER file_shadow_project_content_attachment_primary_update_typed_guard;
CREATE TRIGGER file_shadow_project_content_attachment_primary_update_typed_guard BEFORE UPDATE OF file_id ON project_content_attachments BEGIN
 SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.file_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
 AND NOT (OLD.file_id IS NULL AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard r ON r.singleton=a.singleton
  JOIN file_shadow_checkpoints cp ON cp.id=r.incarnation JOIN file_shadow_control c ON c.epoch=cp.captured_epoch
  JOIN file_authority_activation_bindings b ON b.consumer_kind='project_content_attachment' AND b.consumer_id=NEW.project_content_id
   AND b.consumer_sub_id='' AND b.file_slot='primary' AND b.file_id=NEW.file_id AND b.source_rowid=NEW.rowid
  WHERE a.mode='overlap' AND r.enabled=0 AND r.updated_at=cp.captured_at AND cp.current_count=cp.resolved_count AND cp.pending_count=0 AND cp.unresolved_count=0));
END;

DROP TRIGGER file_shadow_attachment_derivative_derived_update_typed_guard;
CREATE TRIGGER file_shadow_attachment_derivative_derived_update_typed_guard BEFORE UPDATE OF derived_file_id ON attachment_derivatives BEGIN
 SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.derived_file_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
 AND NOT (OLD.derived_file_id IS NULL AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard r ON r.singleton=a.singleton
  JOIN file_shadow_checkpoints cp ON cp.id=r.incarnation JOIN file_shadow_control c ON c.epoch=cp.captured_epoch
  JOIN file_authority_activation_bindings b ON b.consumer_kind='attachment_derivative' AND b.consumer_id=NEW.id
   AND b.consumer_sub_id='' AND b.file_slot='derived' AND b.file_id=NEW.derived_file_id AND b.source_rowid=NEW.rowid
  WHERE a.mode='overlap' AND r.enabled=0 AND r.updated_at=cp.captured_at AND cp.current_count=cp.resolved_count AND cp.pending_count=0 AND cp.unresolved_count=0));
END;

DROP TRIGGER file_shadow_event_primary_update_typed_guard;
CREATE TRIGGER file_shadow_event_primary_update_typed_guard BEFORE UPDATE OF asset_file_id ON events BEGIN
 SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.asset_file_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
 AND NOT (OLD.asset_file_id IS NULL AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard r ON r.singleton=a.singleton
  JOIN file_shadow_checkpoints cp ON cp.id=r.incarnation JOIN file_shadow_control c ON c.epoch=cp.captured_epoch
  JOIN file_authority_activation_bindings b ON b.consumer_kind='event' AND b.consumer_id=NEW.id
   AND b.consumer_sub_id='' AND b.file_slot='primary' AND b.file_id=NEW.asset_file_id AND b.source_rowid=NEW.rowid
  WHERE a.mode='overlap' AND r.enabled=0 AND r.updated_at=cp.captured_at AND cp.current_count=cp.resolved_count AND cp.pending_count=0 AND cp.unresolved_count=0));
END;

DROP TRIGGER file_shadow_event_thumbnail_update_typed_guard;
CREATE TRIGGER file_shadow_event_thumbnail_update_typed_guard BEFORE UPDATE OF thumbnail_file_id ON events BEGIN
 SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.thumbnail_file_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
 AND NOT (OLD.thumbnail_file_id IS NULL AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard r ON r.singleton=a.singleton
  JOIN file_shadow_checkpoints cp ON cp.id=r.incarnation JOIN file_shadow_control c ON c.epoch=cp.captured_epoch
  JOIN file_authority_activation_bindings b ON b.consumer_kind='event' AND b.consumer_id=NEW.id
   AND b.consumer_sub_id='' AND b.file_slot='thumbnail' AND b.file_id=NEW.thumbnail_file_id AND b.source_rowid=NEW.rowid
  WHERE a.mode='overlap' AND r.enabled=0 AND r.updated_at=cp.captured_at AND cp.current_count=cp.resolved_count AND cp.pending_count=0 AND cp.unresolved_count=0));
END;

DROP TRIGGER file_shadow_import_workbook_update_typed_guard;
CREATE TRIGGER file_shadow_import_workbook_update_typed_guard BEFORE UPDATE OF workbook_file_id ON imports BEGIN
 SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.workbook_file_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
 AND NOT (OLD.workbook_file_id IS NULL AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard r ON r.singleton=a.singleton
  JOIN file_shadow_checkpoints cp ON cp.id=r.incarnation JOIN file_shadow_control c ON c.epoch=cp.captured_epoch
  JOIN file_authority_activation_bindings b ON b.consumer_kind='import' AND b.consumer_id=NEW.id
   AND b.consumer_sub_id='' AND b.file_slot='workbook' AND b.file_id=NEW.workbook_file_id AND b.source_rowid=NEW.rowid
  WHERE a.mode='overlap' AND r.enabled=0 AND r.updated_at=cp.captured_at AND cp.current_count=cp.resolved_count AND cp.pending_count=0 AND cp.unresolved_count=0));
END;

DROP TRIGGER file_shadow_import_manifest_update_typed_guard;
CREATE TRIGGER file_shadow_import_manifest_update_typed_guard BEFORE UPDATE OF manifest_file_id ON imports BEGIN
 SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.manifest_file_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
 AND NOT (OLD.manifest_file_id IS NULL AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard r ON r.singleton=a.singleton
  JOIN file_shadow_checkpoints cp ON cp.id=r.incarnation JOIN file_shadow_control c ON c.epoch=cp.captured_epoch
  JOIN file_authority_activation_bindings b ON b.consumer_kind='import' AND b.consumer_id=NEW.id
   AND b.consumer_sub_id='' AND b.file_slot='manifest' AND b.file_id=NEW.manifest_file_id AND b.source_rowid=NEW.rowid
  WHERE a.mode='overlap' AND r.enabled=0 AND r.updated_at=cp.captured_at AND cp.current_count=cp.resolved_count AND cp.pending_count=0 AND cp.unresolved_count=0));
END;

DROP TRIGGER file_shadow_template_version_source_update_typed_guard;
CREATE TRIGGER file_shadow_template_version_source_update_typed_guard BEFORE UPDATE OF source_file_id ON template_versions BEGIN
 SELECT RAISE(ABORT,'Shadow overlap cannot activate typed business File columns') WHERE NEW.source_file_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
 AND NOT (OLD.source_file_id IS NULL AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard r ON r.singleton=a.singleton
  JOIN file_shadow_checkpoints cp ON cp.id=r.incarnation JOIN file_shadow_control c ON c.epoch=cp.captured_epoch
  JOIN file_authority_activation_bindings b ON b.consumer_kind='template_version' AND b.consumer_id=NEW.id
   AND b.consumer_sub_id='' AND b.file_slot='source' AND b.file_id=NEW.source_file_id AND b.source_rowid=NEW.rowid
  WHERE a.mode='overlap' AND r.enabled=0 AND r.updated_at=cp.captured_at AND cp.current_count=cp.resolved_count AND cp.pending_count=0 AND cp.unresolved_count=0));
END;



-- Active tombstone retention. Explicit event/evidence detachment keeps immutable
-- typed identity but releases the same byte edges that clearing legacy locators
-- released. Ancestor Trash and durable legacy Comment/Project/metrology history
-- remain unchanged; Run and canonical Comment item grace still apply separately.

DROP VIEW file_direct_retention_edges;
CREATE VIEW file_direct_retention_edges AS
SELECT e.asset_file_id AS file_id, 'sample' AS source_type, e.sample_id AS source_id,
  'event' AS occurrence_type, e.id AS occurrence_id, 'event_asset' AS retention_reason, NULL AS retain_until
FROM events e WHERE e.asset_file_id IS NOT NULL
  AND NOT (EXISTS (SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
    AND COALESCE(CASE WHEN json_valid(e.metadata_json) THEN
      (json_type(e.metadata_json,'$.assetDeletedAt')='text' AND length(json_extract(e.metadata_json,'$.assetDeletedAt'))>0)
      OR (json_type(e.metadata_json,'$.deletedAt')='text' AND length(json_extract(e.metadata_json,'$.deletedAt'))>0)
      ELSE 0 END,0))

UNION ALL
SELECT e.thumbnail_file_id, 'sample', e.sample_id, 'event_thumbnail', e.id || ':thumbnail',
  'sample_record_thumbnail', NULL
FROM events e WHERE e.thumbnail_file_id IS NOT NULL
  AND NOT (EXISTS (SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')
    AND COALESCE(CASE WHEN json_valid(e.metadata_json) THEN
      (json_type(e.metadata_json,'$.assetDeletedAt')='text' AND length(json_extract(e.metadata_json,'$.assetDeletedAt'))>0)
      OR (json_type(e.metadata_json,'$.deletedAt')='text' AND length(json_extract(e.metadata_json,'$.deletedAt'))>0)
      ELSE 0 END,0))

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
    AND detached_event.asset_key=(SELECT a.r2_key FROM assets a WHERE a.id=sv.evidence_asset_id)
    AND CASE WHEN json_valid(detached_event.metadata_json) THEN
      json_extract(detached_event.metadata_json,'$.verificationId')=sv.id
      AND json_type(detached_event.metadata_json,'$.assetDeletionOperationId')='text'
      AND length(json_extract(detached_event.metadata_json,'$.assetDeletionOperationId'))>0
      AND CASE WHEN json_valid(detached_event.metadata_json) THEN ((json_type(detached_event.metadata_json,'$.assetDeletedAt')='text' AND length(json_extract(detached_event.metadata_json,'$.assetDeletedAt'))>0)) ELSE 0 END
      ELSE 0 END));

DROP VIEW blob_retention_edges;
CREATE VIEW blob_retention_edges AS
SELECT edge.* FROM (
SELECT * FROM blob_retention_edges_legacy_v14
UNION ALL
SELECT * FROM file_shadow_legacy_retention_edges
) edge
WHERE NOT (EXISTS (SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active') AND edge.store_kind='r2' AND edge.provider='r2' AND (
  (edge.occurrence_type IN ('event','event_thumbnail') AND EXISTS (
    SELECT 1 FROM events detached_event
    WHERE ((edge.occurrence_type='event' AND edge.occurrence_id=detached_event.id
        AND detached_event.asset_file_id IS NOT NULL AND edge.object_key=detached_event.asset_key)
      OR (edge.occurrence_type='event_thumbnail' AND edge.occurrence_id=detached_event.id||':thumbnail'
        AND detached_event.thumbnail_file_id IS NOT NULL
        AND CASE WHEN json_valid(detached_event.metadata_json) THEN
          edge.object_key=json_extract(detached_event.metadata_json,'$.thumbnailKey') ELSE 0 END))
      AND CASE WHEN json_valid(detached_event.metadata_json) THEN ((json_type(detached_event.metadata_json,'$.assetDeletedAt')='text' AND length(json_extract(detached_event.metadata_json,'$.assetDeletedAt'))>0) OR (json_type(detached_event.metadata_json,'$.deletedAt')='text' AND length(json_extract(detached_event.metadata_json,'$.deletedAt'))>0)) ELSE 0 END
  )) OR (edge.occurrence_type='state_verification_evidence' AND EXISTS (
    SELECT 1 FROM state_verifications sv JOIN assets a ON a.id=sv.evidence_asset_id
    WHERE sv.id=edge.occurrence_id AND sv.evidence_file_id IS NOT NULL AND a.r2_key=edge.object_key
      AND EXISTS (SELECT 1 FROM events detached_event
  WHERE detached_event.kind='verification' AND detached_event.sample_id=sv.sample_id
    AND detached_event.asset_file_id=sv.evidence_file_id
    AND detached_event.asset_key=(SELECT a.r2_key FROM assets a WHERE a.id=sv.evidence_asset_id)
    AND CASE WHEN json_valid(detached_event.metadata_json) THEN
      json_extract(detached_event.metadata_json,'$.verificationId')=sv.id
      AND json_type(detached_event.metadata_json,'$.assetDeletionOperationId')='text'
      AND length(json_extract(detached_event.metadata_json,'$.assetDeletionOperationId'))>0
      AND CASE WHEN json_valid(detached_event.metadata_json) THEN ((json_type(detached_event.metadata_json,'$.assetDeletedAt')='text' AND length(json_extract(detached_event.metadata_json,'$.assetDeletedAt'))>0)) ELSE 0 END
      ELSE 0 END)
  ))
));
