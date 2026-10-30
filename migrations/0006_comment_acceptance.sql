-- Durable receipts preserve existing Comment identities and lifecycle tables.
-- Captured candidate locators are historical operations, never retention roots.
CREATE TABLE comment_submission_acceptances (
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
  expires_at TEXT NOT NULL CHECK (expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+7 days')),
  CHECK ((status = 'pending' AND completed_at IS NULL AND accepted_result_json IS NULL)
    OR (status = 'ready' AND completed_at IS NOT NULL AND completed_at < expires_at AND accepted_result_json IS NOT NULL)
    OR (status = 'cancelled' AND completed_at IS NOT NULL AND accepted_result_json IS NULL))
);
CREATE TABLE comment_item_acceptances (
  item_id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL REFERENCES comment_submission_acceptances(submission_id),
  actor_email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('embedded_content', 'derived_preview', 'research_source')),
  expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),
  expected_byte_size INTEGER NOT NULL CHECK (typeof(expected_byte_size) = 'integer' AND expected_byte_size BETWEEN 1 AND 104857600),
  storage_profile_id TEXT NOT NULL REFERENCES storage_profiles(id),
  storage_profile_revision INTEGER NOT NULL CHECK (typeof(storage_profile_revision) = 'integer' AND storage_profile_revision = 1),
  candidate_blob_id TEXT NOT NULL UNIQUE,
  candidate_object_key TEXT NOT NULL UNIQUE CHECK (typeof(candidate_object_key) = 'text' AND length(candidate_object_key) BETWEEN 1 AND 4096 AND instr(candidate_object_key, char(0)) = 0),
  execution_token TEXT UNIQUE,
  started_at TEXT CHECK (started_at IS NULL OR (started_at IS strftime('%Y-%m-%dT%H:%M:%fZ', started_at) AND started_at >= created_at)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'cancelled')),
  accepted_result_json TEXT CHECK (accepted_result_json IS NULL OR (length(CAST(accepted_result_json AS BLOB)) <= 8192 AND CASE WHEN json_valid(accepted_result_json) THEN json_type(accepted_result_json) = 'object' ELSE 0 END )),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  CHECK ((execution_token IS NULL) = (started_at IS NULL)),
  CHECK ((status IN ('pending', 'cancelled') AND accepted_result_json IS NULL)
    OR (status = 'ready' AND execution_token IS NOT NULL AND accepted_result_json IS NOT NULL))
);
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
        AND ((csi.kind = 'comment_image' AND p.adapter_type = 'r2' AND p.configuration_source='bootstrap' AND p.credential_reference IS NULL AND NEW.expected_byte_size <= 5242880
          AND NEW.purpose = CASE WHEN csi.related_item_id IS NULL THEN 'embedded_content' ELSE 'derived_preview' END )
          OR (csi.kind = 'attachment' AND p.adapter_type = 'switchdrive' AND p.configuration_source='environment' AND p.credential_reference IS 'environment:SWITCHDRIVE' AND NEW.purpose = 'research_source')))
    THEN RAISE(ABORT, 'Invalid Comment item acceptance') END ;
END;
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
    OR NOT EXISTS (SELECT 1 FROM comment_submission_items csi WHERE csi.id = NEW.item_id AND csi.submission_id = NEW.submission_id
      AND csi.status = 'ready' AND csi.deleted_at IS NULL AND csi.sha256 = NEW.expected_sha256
      AND ((csi.kind = 'comment_image' AND json_extract(NEW.accepted_result_json, '$.storeKind') = 'r2' AND json_extract(NEW.accepted_result_json, '$.provider') = 'r2'
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
CREATE TRIGGER comment_submission_acceptances_delete_guard BEFORE DELETE ON comment_submission_acceptances BEGIN
  SELECT RAISE(ABORT, 'Accepted Comment identity cannot be deleted');
END;
CREATE TRIGGER comment_item_acceptances_delete_guard BEFORE DELETE ON comment_item_acceptances BEGIN
  SELECT RAISE(ABORT, 'Accepted Comment item identity cannot be deleted');
END;
CREATE TRIGGER comment_accepted_submission_identity_guard BEFORE UPDATE ON comment_submissions
WHEN EXISTS (SELECT 1 FROM comment_submission_acceptances WHERE submission_id = OLD.id)
BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.actor_email IS NOT OLD.actor_email OR NEW.context_kind IS NOT OLD.context_kind
    OR NEW.sample_id IS NOT OLD.sample_id OR NEW.scope IS NOT OLD.scope OR NEW.body IS NOT OLD.body OR NEW.created_at IS NOT OLD.created_at OR NEW.retry_until IS NOT OLD.retry_until
    THEN RAISE(ABORT, 'Accepted Comment draft is immutable') END ;
END;
CREATE TRIGGER comment_accepted_submission_cancel AFTER UPDATE OF status ON comment_submissions WHEN NEW.status = 'cancelled'
BEGIN
  UPDATE comment_submission_acceptances SET status = 'cancelled', completed_at = NEW.cancelled_at WHERE submission_id = NEW.id AND status = 'pending';
  UPDATE comment_item_acceptances SET status = 'cancelled' WHERE submission_id = NEW.id AND status = 'pending';
END;
CREATE TRIGGER comment_accepted_item_cancel AFTER UPDATE OF status ON comment_submission_items WHEN NEW.status = 'cancelled'
BEGIN
  UPDATE comment_item_acceptances SET status = 'cancelled' WHERE item_id = NEW.id AND status = 'pending';
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
          OR (csi.kind = 'comment_image' AND NOT EXISTS (SELECT 1 FROM assets a LEFT JOIN imports i ON i.id = a.import_id
            WHERE a.id = csi.asset_id AND a.id = json_extract(ia.accepted_result_json, '$.blobRecordId') AND a.r2_key = json_extract(ia.accepted_result_json, '$.objectKey')
              AND a.sha256 = ia.expected_sha256 AND a.byte_size = ia.expected_byte_size AND a.status = 'ready' AND (a.import_id IS NULL OR i.status = 'ready')))
          OR (csi.kind = 'attachment' AND NOT EXISTS (SELECT 1 FROM managed_storage_objects m WHERE m.id = csi.storage_object_id
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
CREATE TRIGGER comment_accepted_submission_replace_guard BEFORE INSERT ON comment_submissions
WHEN EXISTS (SELECT 1 FROM comment_submission_acceptances WHERE submission_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'Accepted Comment identity cannot be replaced');
END;
CREATE TRIGGER comment_accepted_item_replace_guard BEFORE INSERT ON comment_submission_items
WHEN EXISTS (SELECT 1 FROM comment_submission_acceptances WHERE submission_id = NEW.submission_id)
  OR EXISTS (SELECT 1 FROM comment_item_acceptances WHERE item_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'Accepted Comment items cannot be replaced or added');
END;
CREATE TRIGGER comment_accepted_target_replace_guard BEFORE INSERT ON comment_submission_targets
WHEN EXISTS (SELECT 1 FROM comment_submission_acceptances WHERE submission_id = NEW.submission_id)
BEGIN
  SELECT RAISE(ABORT, 'Accepted Comment targets cannot be replaced or added');
END;
CREATE TRIGGER comment_accepted_target_update_guard BEFORE UPDATE ON comment_submission_targets
WHEN EXISTS (SELECT 1 FROM comment_submission_acceptances WHERE submission_id = OLD.submission_id)
BEGIN
  SELECT RAISE(ABORT, 'Accepted Comment targets are immutable');
END;
CREATE TRIGGER comment_accepted_target_delete_guard BEFORE DELETE ON comment_submission_targets
WHEN EXISTS (SELECT 1 FROM comment_submission_acceptances WHERE submission_id = OLD.submission_id AND status = 'pending')
BEGIN
  SELECT RAISE(ABORT, 'Accepted Comment targets cannot be deleted');
END;
CREATE TRIGGER comment_accepted_item_identity_guard BEFORE UPDATE ON comment_submission_items
WHEN EXISTS (SELECT 1 FROM comment_submission_acceptances WHERE submission_id = OLD.submission_id)
BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.submission_id IS NOT OLD.submission_id OR NEW.kind IS NOT OLD.kind OR NEW.position IS NOT OLD.position
    OR NEW.filename IS NOT OLD.filename OR NEW.mime_type IS NOT OLD.mime_type OR NEW.byte_size IS NOT OLD.byte_size
    OR NEW.original_filename IS NOT OLD.original_filename OR NEW.original_mime_type IS NOT OLD.original_mime_type OR NEW.original_byte_size IS NOT OLD.original_byte_size
    OR NEW.title IS NOT OLD.title OR NEW.description IS NOT OLD.description OR NEW.external_url IS NOT OLD.external_url OR NEW.related_item_id IS NOT OLD.related_item_id OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.status = 'cancelled' AND NEW.status <> 'cancelled')
    THEN RAISE(ABORT, 'Accepted Comment item intent is immutable') END ;
END;
