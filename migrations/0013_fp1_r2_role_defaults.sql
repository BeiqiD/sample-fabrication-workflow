-- Explicit FP1 policy transition for new active Comment originals. Existing
-- receipts/profile identities and legacy/overlap behavior remain frozen. Defaults
-- are initialized once by the first active binary acceptance, never by Settings.
ALTER TABLE comment_submission_acceptances ADD COLUMN storage_role_policy_revision INTEGER NOT NULL DEFAULT 1
  CHECK(typeof(storage_role_policy_revision)='integer' AND storage_role_policy_revision IN(1,2));

CREATE TABLE storage_role_defaults (
  role TEXT PRIMARY KEY NOT NULL CHECK(role IN('internal','originals')),
  storage_profile_id TEXT NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
  storage_profile_revision INTEGER NOT NULL CHECK(typeof(storage_profile_revision)='integer' AND storage_profile_revision=1),
  policy_revision INTEGER NOT NULL CHECK(typeof(policy_revision)='integer' AND policy_revision=2),
  created_at TEXT NOT NULL CHECK(created_at IS strftime('%Y-%m-%dT%H:%M:%fZ',created_at))
) WITHOUT ROWID;

CREATE TRIGGER storage_role_defaults_insert_guard BEFORE INSERT ON storage_role_defaults BEGIN
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
CREATE TRIGGER storage_role_defaults_update_guard BEFORE UPDATE ON storage_role_defaults BEGIN
  SELECT RAISE(ABORT,'FP1 role defaults are initialized once');
END;
CREATE TRIGGER storage_role_defaults_delete_guard BEFORE DELETE ON storage_role_defaults BEGIN
  SELECT RAISE(ABORT,'FP1 role defaults cannot be deleted');
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


DROP TRIGGER comment_item_acceptances_insert_guard;
CREATE TRIGGER comment_item_acceptances_insert_guard BEFORE INSERT ON comment_item_acceptances
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

DROP TRIGGER comment_item_acceptances_publication_guard;
CREATE TRIGGER comment_item_acceptances_publication_guard BEFORE UPDATE ON comment_item_acceptances WHEN NEW.status = 'ready'
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
      AND (((csi.kind = 'comment_image' OR (csi.kind='attachment' AND EXISTS(SELECT 1 FROM comment_submission_acceptances ca WHERE ca.submission_id=NEW.submission_id AND ca.storage_role_policy_revision=2))) AND json_extract(NEW.accepted_result_json, '$.storeKind') = 'r2' AND json_extract(NEW.accepted_result_json, '$.provider') = 'r2'
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

-- Terminal installed-generation marker used by current export routing.
CREATE TRIGGER file_r2_role_defaults_generation_complete BEFORE INSERT ON storage_role_defaults BEGIN
  SELECT 1;
END;
