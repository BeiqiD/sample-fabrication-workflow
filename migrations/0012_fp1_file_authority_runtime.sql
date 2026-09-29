-- Active File writer substrate only. This migration does not activate File
-- authority, enable a profile, or change a storage binding. Legacy/overlap
-- retain their existing publication, SHA reuse and typed-binding behavior.
-- These views join the existing executor receipts; no second ledger is added.

CREATE VIEW file_authority_pending_receipt_items AS
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
UNION ALL
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
WHERE r.client_request_id IS NOT NULL AND r.status='pending' AND r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now');

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
