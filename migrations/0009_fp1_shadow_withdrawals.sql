-- An immutable refusal to accept an exact shadow conversion request.
-- This is independent of consumer existence, runtime enablement and providers.
-- Keep 0008/V15 frozen. V16 exports/restores these records before writers resume.
CREATE TABLE file_shadow_withdrawals (
  operation_id TEXT NOT NULL PRIMARY KEY CHECK (
    typeof(operation_id)='text' AND length(operation_id)=36
    AND operation_id GLOB '????????-????-4???-[89ab]???-????????????'
    AND replace(operation_id,'-','') NOT GLOB '*[^0-9a-f]*'
    AND length(replace(operation_id,'-',''))=32 AND instr(operation_id,char(0))=0
  ),
  request_json TEXT NOT NULL CHECK (
    typeof(request_json)='text' AND length(CAST(request_json AS BLOB)) BETWEEN 1 AND 81920
    AND json_valid(request_json) AND json_type(request_json)='object'
  ),
  request_sha256 TEXT NOT NULL CHECK (
    typeof(request_sha256)='text' AND length(request_sha256)=64
    AND request_sha256 NOT GLOB '*[^0-9a-f]*' AND instr(request_sha256,char(0))=0
  ),
  created_by TEXT NOT NULL CHECK (
    typeof(created_by)='text' AND length(created_by) BETWEEN 1 AND 256 AND instr(created_by,char(0))=0
  ),
  created_at TEXT NOT NULL CHECK (
    typeof(created_at)='text' AND length(created_at) BETWEEN 1 AND 200
    AND instr(created_at,char(0))=0 AND julianday(created_at) IS NOT NULL
  )
) WITHOUT ROWID;

CREATE TRIGGER file_shadow_withdrawals_insert_guard BEFORE INSERT ON file_shadow_withdrawals BEGIN
  -- Existing receipts are never overwritten, including by INSERT OR REPLACE.
  SELECT RAISE(ABORT,'Shadow request identity already has an outcome')
    WHERE EXISTS(SELECT 1 FROM file_shadow_operations WHERE id=NEW.operation_id)
       OR EXISTS(SELECT 1 FROM file_shadow_withdrawals WHERE operation_id=NEW.operation_id);
  -- Digest and canonical serialization are independently checked by the service
  -- and archive validator; SQLite enforces the exact structural request shape.
  SELECT RAISE(ABORT,'Invalid shadow withdrawal request') WHERE NOT (
    (SELECT count(*) FROM json_each(NEW.request_json))=5
    AND (SELECT count(*) FROM json_each(NEW.request_json)
      WHERE key IN('operationId','key','expectedBaselineSha256','destinationProfile','runtimeIncarnation'))=5
    AND json_type(NEW.request_json,'$.operationId') IS 'text'
    AND json_extract(NEW.request_json,'$.operationId') IS NEW.operation_id
    AND json_type(NEW.request_json,'$.key') IS 'object'
    AND (SELECT count(*) FROM json_each(NEW.request_json,'$.key'))=4
    AND (SELECT count(*) FROM json_each(NEW.request_json,'$.key')
      WHERE key IN('consumerKind','consumerId','consumerSubId','fileSlot') AND type='text')=4
    AND json_type(NEW.request_json,'$.key.consumerKind') IS 'text'
    AND json_type(NEW.request_json,'$.key.consumerId') IS 'text'
    AND json_type(NEW.request_json,'$.key.consumerSubId') IS 'text'
    AND json_type(NEW.request_json,'$.key.fileSlot') IS 'text'
    AND length(CAST(json_extract(NEW.request_json,'$.key') AS BLOB))<=65536
    AND json_type(NEW.request_json,'$.expectedBaselineSha256') IS 'text'
    AND length(json_extract(NEW.request_json,'$.expectedBaselineSha256'))=64
    AND json_extract(NEW.request_json,'$.expectedBaselineSha256') NOT GLOB '*[^0-9a-f]*'
    AND instr(json_extract(NEW.request_json,'$.expectedBaselineSha256'),char(0))=0
    AND json_type(NEW.request_json,'$.destinationProfile') IS 'object'
    AND (SELECT count(*) FROM json_each(NEW.request_json,'$.destinationProfile'))=2
    AND json_type(NEW.request_json,'$.destinationProfile.profileId') IS 'text'
    AND length(json_extract(NEW.request_json,'$.destinationProfile.profileId')) BETWEEN 1 AND 256
    AND instr(json_extract(NEW.request_json,'$.destinationProfile.profileId'),char(0))=0
    AND json_type(NEW.request_json,'$.destinationProfile.configurationRevision') IS 'integer'
    AND json_extract(NEW.request_json,'$.destinationProfile.configurationRevision') IS 1
    AND json_type(NEW.request_json,'$.runtimeIncarnation') IS 'text'
    AND length(json_extract(NEW.request_json,'$.runtimeIncarnation'))=36
    AND json_extract(NEW.request_json,'$.runtimeIncarnation') GLOB '????????-????-4???-[89ab]???-????????????'
    AND replace(json_extract(NEW.request_json,'$.runtimeIncarnation'),'-','') NOT GLOB '*[^0-9a-f]*'
    AND length(replace(json_extract(NEW.request_json,'$.runtimeIncarnation'),'-',''))=32
    AND instr(json_extract(NEW.request_json,'$.runtimeIncarnation'),char(0))=0
  );
END;

CREATE TRIGGER file_shadow_withdrawals_update_guard BEFORE UPDATE ON file_shadow_withdrawals BEGIN
  SELECT RAISE(ABORT,'Shadow withdrawal is immutable');
END;
CREATE TRIGGER file_shadow_withdrawals_delete_guard BEFORE DELETE ON file_shadow_withdrawals BEGIN
  SELECT RAISE(ABORT,'Shadow withdrawal is immutable');
END;
CREATE TRIGGER file_shadow_operations_withdrawal_guard BEFORE INSERT ON file_shadow_operations BEGIN
  -- Protect against already-running old Workers as well as the new service.
  SELECT RAISE(ABORT,'Shadow request was withdrawn before acceptance')
    WHERE EXISTS(SELECT 1 FROM file_shadow_withdrawals WHERE operation_id=NEW.id);
END;
