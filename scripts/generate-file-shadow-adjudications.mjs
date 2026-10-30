import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const old = readFileSync(new URL('migrations/0008_fp1_shadow_runtime.sql', root), 'utf8');
const j = (path, v='NEW.request_json') => `json_extract(${v},'$.${path}')`;
const jt = (path, v='NEW.request_json') => `json_type(${v},'$.${path}')`;
const text = (v,n=256) => `(typeof(${v})='text' AND length(${v}) BETWEEN 1 AND ${n} AND instr(${v},char(0))=0)`;
const sha = v => `(typeof(${v})='text' AND length(${v})=64 AND ${v} NOT GLOB '*[^0-9a-f]*' AND instr(${v},char(0))=0)`;
const uuid = v => `(${text(v,36)} AND length(${v})=36 AND ${v} GLOB '????????-????-4???-[89ab]???-????????????' AND replace(${v},'-','') NOT GLOB '*[^0-9a-f]*' AND length(replace(${v},'-',''))=32)`;
const json = (v,max) => `(typeof(${v})='text' AND length(CAST(${v} AS BLOB)) BETWEEN 1 AND ${max} AND json_valid(${v}) AND json_type(${v})='object')`;
const time = v => `(${text(v,200)} AND julianday(${v}) IS NOT NULL)`;
const narrator = v => `(${text(v,4000)} AND length(trim(${v}))>0 AND length(CAST(${v} AS BLOB))<=16000)`;
const shape = (path,names) => `(${path ? jt(path)+"='object' AND " : ''}(SELECT count(*) FROM json_each(NEW.request_json${path?",'$."+path+"'":''}))=${names.length} AND (SELECT count(*) FROM json_each(NEW.request_json${path?",'$."+path+"'":''}) WHERE key IN(${names.map(s=>`'${s}'`).join(',')}))=${names.length})`;
const requestCheck = identity => [
 shape('', ['requestId','key','occurrenceId','generation','sourceSha256','sourceLocator','expectedBaselineSha256','expectedEpoch','expectedIncarnation','sourceProfile','purpose','purposeStatement','namespaceStatement','evidenceReference','supersedesId']),
 `${uuid(j('requestId'))} AND ${j('requestId')} IS ${identity}`,
 shape('key',['consumerKind','consumerId','consumerSubId','fileSlot']),
 `${j('key.consumerKind')} IS 'project_content_attachment' AND ${j('key.fileSlot')} IS 'primary' AND ${jt('key.consumerId')} IS 'text' AND ${jt('key.consumerSubId')} IS 'text' AND length(CAST(${j('key')} AS BLOB))<=65536`,
 text(j('occurrenceId')),`${jt('generation')} IS 'integer' AND ${j('generation')} BETWEEN 1 AND 9007199254740991`,sha(j('sourceSha256')),
 shape('sourceLocator',['storeKind','provider','objectKey']), `${j('sourceLocator.storeKind')} IS 'r2' AND ${j('sourceLocator.provider')} IS 'r2' AND ${text(j('sourceLocator.objectKey'),4096)} AND length(trim(${j('sourceLocator.objectKey')}))>0 AND length(CAST(${j('sourceLocator.objectKey')} AS BLOB))<=4096`,
 sha(j('expectedBaselineSha256')),`${jt('expectedEpoch')} IS 'integer' AND ${j('expectedEpoch')} BETWEEN 0 AND 9007199254740991`, `(${jt('expectedIncarnation')} IS 'null' OR ${uuid(j('expectedIncarnation'))})`,
 shape('sourceProfile',['profileId','configurationRevision']),`${text(j('sourceProfile.profileId'))} AND ${jt('sourceProfile.configurationRevision')} IS 'integer' AND ${j('sourceProfile.configurationRevision')} IS 1`,
 `${j('purpose')} IS 'research_source'`,...['purposeStatement','namespaceStatement','evidenceReference'].map(p=>narrator(j(p))),
 `(${jt('supersedesId')} IS 'null' OR (${uuid(j('supersedesId'))} AND ${j('supersedesId')} IS NOT ${j('requestId')}))`,
].join('\n    AND ');
const immutable = (table,id) => `CREATE TRIGGER ${table}_replace_guard BEFORE INSERT ON ${table} BEGIN
  SELECT RAISE(ABORT,'Historical adjudication history is immutable') WHERE EXISTS(SELECT 1 FROM ${table} WHERE ${id}=NEW.${id}${table === 'file_shadow_adjudication_revocations' ? ' OR adjudication_id=NEW.adjudication_id' : ''});
END;
CREATE TRIGGER ${table}_update_guard BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Historical adjudication history is immutable'); END;
CREATE TRIGGER ${table}_delete_guard BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Historical adjudication history is immutable'); END;`;
const unsafe = (where) => `EXISTS(SELECT 1 FROM file_shadow_operations o WHERE ${where} AND (o.status<>'cancelled'
    OR EXISTS(SELECT 1 FROM file_shadow_attempts a WHERE a.operation_id=o.id AND (a.write_started_at IS NOT NULL OR a.verified_at IS NOT NULL OR a.state NOT IN('failed','cancelled')))
    OR EXISTS(SELECT 1 FROM file_shadow_decisions d WHERE d.operation_id=o.id)))`;
const paused = `EXISTS(SELECT 1 FROM file_authority_control c JOIN file_shadow_runtime_guard r ON r.singleton=c.singleton WHERE c.singleton=1 AND c.mode='overlap' AND r.enabled=0)`;
const hasHistorical = `SELECT 1 FROM file_shadow_active_adjudications a JOIN file_shadow_heads h ON h.occurrence_id=a.occurrence_id AND h.present=1 AND h.source_json=a.source_json
    WHERE a.occurrence_id=NEW.occurrence_id
    AND NEW.purpose='research_source' AND NEW.source_store_kind='r2' AND NEW.source_provider='r2'
    AND NEW.source_object_key=json_extract(a.request_json,'$.sourceLocator.objectKey')
    AND NEW.source_profile_id=json_extract(a.request_json,'$.sourceProfile.profileId') AND NEW.source_profile_revision=json_extract(a.request_json,'$.sourceProfile.configurationRevision')
    AND NEW.source_expected_byte_size=a.source_expected_byte_size AND NEW.source_expected_sha256=a.source_expected_sha256
    AND EXISTS(SELECT 1 FROM storage_profiles p JOIN storage_profile_runtime r ON r.storage_profile_id=p.id WHERE p.id=NEW.source_profile_id AND p.adapter_type='r2' AND p.configuration_revision=NEW.source_profile_revision AND r.state IN('read_only','read_write'))`;
let sql = `-- Generated by scripts/generate-file-shadow-adjudications.mjs. Review both files.
-- V17 adds occurrence-scoped operator adjudications; V15/V16 remain frozen.
-- No record is a byte root, a recovered upload receipt, or a provider operation.
CREATE TABLE file_shadow_adjudications (
  id TEXT NOT NULL PRIMARY KEY CHECK ${uuid('id')},
  occurrence_id TEXT NOT NULL REFERENCES file_shadow_occurrences(id) ON DELETE RESTRICT,
  supersedes_id TEXT UNIQUE REFERENCES file_shadow_adjudications(id) ON DELETE RESTRICT,
  request_json TEXT NOT NULL CHECK ${json('request_json',81920)},
  request_sha256 TEXT NOT NULL CHECK ${sha('request_sha256')},
  source_json TEXT NOT NULL CHECK ${json('source_json',524288)},
  baseline_json TEXT NOT NULL CHECK ${json('baseline_json',524288)},
  source_expected_byte_size INTEGER NOT NULL CHECK(typeof(source_expected_byte_size)='integer' AND source_expected_byte_size BETWEEN 0 AND 104857600),
  source_expected_sha256 TEXT NOT NULL CHECK ${sha('source_expected_sha256')},
  created_by TEXT NOT NULL CHECK ${text('created_by')},
  created_at TEXT NOT NULL CHECK ${time('created_at')}
) WITHOUT ROWID;
CREATE UNIQUE INDEX file_shadow_adjudications_one_root ON file_shadow_adjudications(occurrence_id) WHERE supersedes_id IS NULL;
CREATE TABLE file_shadow_adjudication_withdrawals (
  request_id TEXT NOT NULL PRIMARY KEY CHECK ${uuid('request_id')},
  request_json TEXT NOT NULL CHECK ${json('request_json',81920)},
  request_sha256 TEXT NOT NULL CHECK ${sha('request_sha256')},
  created_by TEXT NOT NULL CHECK ${text('created_by')},
  created_at TEXT NOT NULL CHECK ${time('created_at')}
) WITHOUT ROWID;
CREATE TABLE file_shadow_adjudication_revocations (
  id TEXT NOT NULL PRIMARY KEY CHECK ${uuid('id')},
  adjudication_id TEXT NOT NULL UNIQUE REFERENCES file_shadow_adjudications(id) ON DELETE RESTRICT,
  request_json TEXT NOT NULL CHECK ${json('request_json',24576)},
  request_sha256 TEXT NOT NULL CHECK ${sha('request_sha256')},
  created_by TEXT NOT NULL CHECK ${text('created_by')},
  created_at TEXT NOT NULL CHECK ${time('created_at')}
) WITHOUT ROWID;
CREATE TABLE file_shadow_operation_adjudications (
  operation_id TEXT NOT NULL PRIMARY KEY REFERENCES file_shadow_operations(id) ON DELETE RESTRICT,
  adjudication_id TEXT NOT NULL REFERENCES file_shadow_adjudications(id) ON DELETE RESTRICT,
  adjudication_request_sha256 TEXT NOT NULL CHECK ${sha('adjudication_request_sha256')}
) WITHOUT ROWID;
CREATE VIEW file_shadow_active_adjudications AS SELECT a.* FROM file_shadow_adjudications a
  WHERE NOT EXISTS(SELECT 1 FROM file_shadow_adjudication_revocations r WHERE r.adjudication_id=a.id);

${immutable('file_shadow_adjudications','id')}
${immutable('file_shadow_adjudication_withdrawals','request_id')}
${immutable('file_shadow_adjudication_revocations','id')}
${immutable('file_shadow_operation_adjudications','operation_id')}

CREATE TRIGGER file_shadow_adjudications_insert_guard BEFORE INSERT ON file_shadow_adjudications BEGIN
  SELECT RAISE(ABORT,'Invalid historical adjudication request') WHERE (${requestCheck('NEW.id')}) IS NOT 1;
  SELECT RAISE(ABORT,'Adjudication request was withdrawn') WHERE EXISTS(SELECT 1 FROM file_shadow_adjudication_withdrawals WHERE request_id=NEW.id);
  SELECT RAISE(ABORT,'Adjudication requires the exact paused primary baseline') WHERE NOT ${paused}
    OR ${j('expectedEpoch')} IS NOT (SELECT epoch FROM file_shadow_control WHERE singleton=1)
    OR ${j('expectedIncarnation')} IS NOT (SELECT incarnation FROM file_shadow_runtime_guard WHERE singleton=1)
    OR NEW.occurrence_id IS NOT ${j('occurrenceId')} OR NEW.supersedes_id IS NOT ${j('supersedesId')}
    OR NOT EXISTS(SELECT 1 FROM file_shadow_heads h JOIN file_shadow_occurrences o ON o.id=h.occurrence_id
      JOIN project_content_attachments x ON x.rowid=h.source_rowid AND x.project_content_id=h.consumer_id
      JOIN project_contents c ON c.id=x.project_content_id JOIN projects p ON p.id=c.project_id
      JOIN assets a ON a.id=x.asset_id
      WHERE h.occurrence_id=NEW.occurrence_id AND h.present=1 AND h.source_json=NEW.source_json
      AND h.consumer_kind=${j('key.consumerKind')} AND h.consumer_id=${j('key.consumerId')}
      AND h.consumer_sub_id=${j('key.consumerSubId')} AND h.file_slot=${j('key.fileSlot')}
      AND h.generation=${j('generation')} AND o.source_json=NEW.source_json
      AND o.legacy_store_kind='r2' AND o.legacy_provider='r2' AND o.legacy_object_key=${j('sourceLocator.objectKey')}
      AND x.storage_object_id IS NULL AND x.file_id IS NULL AND a.status='ready' AND a.import_id IS NULL
      AND a.r2_key=o.legacy_object_key AND a.sha256=NEW.source_expected_sha256 AND a.byte_size=NEW.source_expected_byte_size
      AND (x.byte_size IS NULL OR x.byte_size=a.byte_size)
      AND (SELECT count(*) FROM assets ar WHERE ar.r2_key=a.r2_key)=1)
    OR NOT EXISTS(SELECT 1 FROM storage_profiles p JOIN storage_profile_runtime r ON r.storage_profile_id=p.id
      WHERE p.id=${j('sourceProfile.profileId')} AND p.configuration_revision=${j('sourceProfile.configurationRevision')}
      AND p.adapter_type='r2' AND r.state IN('read_only','read_write'))
    OR EXISTS(SELECT 1 FROM file_shadow_decisions d WHERE d.occurrence_id=NEW.occurrence_id)
    OR ${unsafe('o.occurrence_id=NEW.occurrence_id')};
  -- Never override existing receipts, mappings, derivation, or lifecycle evidence.
  SELECT RAISE(ABORT,'Historical adjudication cannot override existing evidence') WHERE
    EXISTS(SELECT 1 FROM legacy_file_mappings WHERE store_kind='r2' AND provider='r2' AND object_key=${j('sourceLocator.objectKey')})
    OR EXISTS(SELECT 1 FROM r2_upload_requests WHERE candidate_object_key=${j('sourceLocator.objectKey')}
      OR CASE WHEN json_valid(accepted_result_json) THEN json_extract(accepted_result_json,'$.key') END=${j('sourceLocator.objectKey')})
    OR EXISTS(SELECT 1 FROM metrology_reference_upload_requests WHERE candidate_object_key=${j('sourceLocator.objectKey')}
      OR CASE WHEN json_valid(accepted_result_json) THEN json_extract(accepted_result_json,'$.reference.assetKey') END=${j('sourceLocator.objectKey')})
    OR EXISTS(SELECT 1 FROM comment_item_acceptances WHERE candidate_object_key=${j('sourceLocator.objectKey')}
      OR CASE WHEN json_valid(accepted_result_json) THEN json_extract(accepted_result_json,'$.objectKey') END=${j('sourceLocator.objectKey')})
    OR EXISTS(SELECT 1 FROM imports WHERE client_request_id IS NOT NULL AND (workbook_asset_key=${j('sourceLocator.objectKey')} OR manifest_asset_key=${j('sourceLocator.objectKey')}))
    OR EXISTS(SELECT 1 FROM attachment_derivatives d JOIN assets a ON a.id=d.derived_asset_id WHERE a.r2_key=${j('sourceLocator.objectKey')})
    OR EXISTS(SELECT 1 FROM blob_gc_ledger WHERE store_kind='r2' AND provider='r2' AND object_key=${j('sourceLocator.objectKey')})
    OR EXISTS(SELECT 1 FROM blob_integrity_quarantine WHERE store_kind='r2' AND provider='r2' AND object_key=${j('sourceLocator.objectKey')})
    OR EXISTS(SELECT 1 FROM file_shadow_legacy_deletion_claims WHERE store_kind='r2' AND provider='r2' AND object_key=${j('sourceLocator.objectKey')});
  SELECT RAISE(ABORT,'Historical adjudication baseline identity mismatch') WHERE
    json_extract(NEW.baseline_json,'$.baselineSha256') IS NOT ${j('expectedBaselineSha256')}
    OR json_extract(NEW.baseline_json,'$.epoch') IS NOT ${j('expectedEpoch')}
    OR json_extract(NEW.baseline_json,'$.head.occurrence_id') IS NOT NEW.occurrence_id
    OR json_extract(NEW.baseline_json,'$.head.generation') IS NOT ${j('generation')}
    OR json_extract(NEW.baseline_json,'$.head.source_sha256') IS NOT ${j('sourceSha256')}
    OR json_extract(NEW.baseline_json,'$.runtime.enabled') IS NOT 0
    OR json_extract(NEW.baseline_json,'$.runtime.incarnation') IS NOT ${j('expectedIncarnation')};
  SELECT RAISE(ABORT,'Historical adjudication correction must extend its revoked chain') WHERE
    EXISTS(SELECT 1 FROM file_shadow_active_adjudications WHERE occurrence_id=NEW.occurrence_id)
    OR (NEW.supersedes_id IS NULL AND EXISTS(SELECT 1 FROM file_shadow_adjudications WHERE occurrence_id=NEW.occurrence_id))
    OR (NEW.supersedes_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM file_shadow_adjudications a
      JOIN file_shadow_adjudication_revocations r ON r.adjudication_id=a.id
      WHERE a.id=NEW.supersedes_id AND a.occurrence_id=NEW.occurrence_id AND julianday(NEW.created_at)>=julianday(r.created_at)
      AND NOT EXISTS(SELECT 1 FROM file_shadow_adjudications successor WHERE successor.supersedes_id=a.id)));
END;
CREATE TRIGGER file_shadow_adjudications_epoch AFTER INSERT ON file_shadow_adjudications BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1; END;

CREATE TRIGGER file_shadow_adjudication_withdrawals_insert_guard BEFORE INSERT ON file_shadow_adjudication_withdrawals BEGIN
  SELECT RAISE(ABORT,'Invalid historical adjudication withdrawal') WHERE (${requestCheck('NEW.request_id')}) IS NOT 1;
  SELECT RAISE(ABORT,'Historical adjudication already accepted') WHERE EXISTS(SELECT 1 FROM file_shadow_adjudications WHERE id=NEW.request_id);
END;
CREATE TRIGGER file_shadow_adjudication_revocations_insert_guard BEFORE INSERT ON file_shadow_adjudication_revocations BEGIN
  SELECT RAISE(ABORT,'Invalid historical adjudication revocation') WHERE (
    ${shape('',['requestId','adjudicationId','adjudicationRequestSha256','reason'])}
    AND ${uuid(j('requestId'))} AND ${j('requestId')} IS NEW.id
    AND ${uuid(j('adjudicationId'))} AND ${j('adjudicationId')} IS NEW.adjudication_id
    AND ${sha(j('adjudicationRequestSha256'))} AND ${narrator(j('reason'))}
  ) IS NOT 1;
  SELECT RAISE(ABORT,'Historical adjudication revocation requires paused settled work') WHERE NOT ${paused}
    OR NOT EXISTS(SELECT 1 FROM file_shadow_adjudications a WHERE a.id=NEW.adjudication_id AND a.request_sha256=${j('adjudicationRequestSha256')} AND julianday(NEW.created_at)>=julianday(a.created_at))
    OR ${unsafe('EXISTS(SELECT 1 FROM file_shadow_operation_adjudications b WHERE b.operation_id=o.id AND b.adjudication_id=NEW.adjudication_id)')};
END;
CREATE TRIGGER file_shadow_adjudication_revocations_epoch AFTER INSERT ON file_shadow_adjudication_revocations BEGIN UPDATE file_shadow_control SET epoch=epoch+1 WHERE singleton=1; END;

-- Copy admission is occurrence-scoped. Do not widen locator-global evidence.
DROP TRIGGER file_shadow_operations_insert_guard;
CREATE TRIGGER file_shadow_operations_insert_guard BEFORE INSERT ON file_shadow_operations BEGIN
  SELECT RAISE(ABORT,'Shadow operation requires a current frozen source generation and exact namespace') WHERE
    NOT EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='overlap') OR NEW.status<>'pending'
    OR EXISTS(SELECT 1 FROM file_shadow_decisions d WHERE d.occurrence_id=NEW.occurrence_id)
    OR NEW.captured_epoch<>(SELECT epoch FROM file_shadow_control WHERE singleton=1)
    OR NOT EXISTS(SELECT 1 FROM file_shadow_heads h JOIN file_shadow_occurrences o ON o.id=h.occurrence_id
      WHERE o.id=NEW.occurrence_id AND h.present=1 AND o.legacy_store_kind IS NEW.source_store_kind
      AND o.legacy_provider IS NEW.source_provider AND o.legacy_object_key IS NEW.source_object_key)
    OR (NEW.source_profile_id IS NOT NULL AND NOT (
      (EXISTS(SELECT 1 FROM file_shadow_namespace_evidence e WHERE e.store_kind IS NEW.source_store_kind AND e.provider IS NEW.source_provider
        AND e.object_key IS NEW.source_object_key AND e.storage_profile_id IS NEW.source_profile_id AND e.configuration_revision IS NEW.source_profile_revision)
       AND NOT EXISTS(SELECT 1 FROM file_shadow_namespace_evidence e WHERE e.store_kind IS NEW.source_store_kind AND e.provider IS NEW.source_provider
        AND e.object_key IS NEW.source_object_key AND (e.storage_profile_id IS NOT NEW.source_profile_id OR e.configuration_revision IS NOT NEW.source_profile_revision)))
      OR EXISTS(${hasHistorical})
    ));
  -- An existing overlay cannot be bypassed with a NULL source profile or purpose.
  SELECT RAISE(ABORT,'Shadow operation contradicts its occurrence adjudication') WHERE
    EXISTS(SELECT 1 FROM file_shadow_active_adjudications a JOIN file_shadow_heads h ON h.occurrence_id=a.occurrence_id AND h.present=1 AND h.source_json=a.source_json WHERE a.occurrence_id=NEW.occurrence_id)
    AND NOT EXISTS(${hasHistorical});
END;
CREATE TRIGGER file_shadow_operations_capture_adjudication AFTER INSERT ON file_shadow_operations BEGIN
  INSERT INTO file_shadow_operation_adjudications(operation_id,adjudication_id,adjudication_request_sha256)
    SELECT NEW.id,a.id,a.request_sha256 FROM file_shadow_active_adjudications a
    JOIN file_shadow_heads h ON h.occurrence_id=a.occurrence_id AND h.present=1 AND h.source_json=a.source_json
    WHERE a.occurrence_id=NEW.occurrence_id;
END;
CREATE TRIGGER file_shadow_operation_adjudications_insert_guard BEFORE INSERT ON file_shadow_operation_adjudications BEGIN
  SELECT RAISE(ABORT,'Shadow operation adjudication binding mismatch') WHERE NOT EXISTS(
    SELECT 1 FROM file_shadow_operations o JOIN file_shadow_active_adjudications a ON a.id=NEW.adjudication_id
    JOIN file_shadow_heads h ON h.occurrence_id=a.occurrence_id AND h.present=1 AND h.source_json=a.source_json
    WHERE o.id=NEW.operation_id AND o.status='pending' AND o.occurrence_id=a.occurrence_id AND a.request_sha256=NEW.adjudication_request_sha256
    AND o.captured_epoch=(SELECT epoch FROM file_shadow_control WHERE singleton=1)
    AND o.purpose='research_source' AND o.source_store_kind='r2' AND o.source_provider='r2'
    AND o.source_object_key=json_extract(a.request_json,'$.sourceLocator.objectKey')
    AND o.source_profile_id=json_extract(a.request_json,'$.sourceProfile.profileId')
    AND o.source_profile_revision=json_extract(a.request_json,'$.sourceProfile.configurationRevision')
    AND o.source_expected_sha256=a.source_expected_sha256 AND o.source_expected_byte_size=a.source_expected_byte_size);
END;

-- Historical statements only connect EXISTING roots to physical aliases. Their
-- own presence never creates retention. Revocation cannot release an old hold.
CREATE VIEW file_shadow_retention_namespaces AS SELECT * FROM file_shadow_namespace_evidence
  UNION SELECT 'r2','r2',json_extract(request_json,'$.sourceLocator.objectKey'),
    json_extract(request_json,'$.sourceProfile.profileId'),json_extract(request_json,'$.sourceProfile.configurationRevision')
  FROM file_shadow_adjudications;
`;
for (const name of ['file_shadow_legacy_retention_edges','file_shadow_location_hold_legacy_guard']) {
 const kind=name.endsWith('_guard')?'TRIGGER':'VIEW';
 const expression=new RegExp(`CREATE ${kind} ${name}\\b[\\s\\S]*?${kind==='TRIGGER'?'END;':';'}`);
 const original=old.match(expression)?.[0]; if(!original) throw Error(name);
 sql+=`\nDROP ${kind} ${name};\n${original.replaceAll('file_shadow_namespace_evidence','file_shadow_retention_namespaces')}\n`;
}
sql+=`\nCREATE TRIGGER file_shadow_adjudication_generation_complete BEFORE DELETE ON file_shadow_runtime_guard BEGIN SELECT RAISE(ABORT,'V17 adjudication runtime gate cannot be deleted'); END;\n`;
writeFileSync(new URL('migrations/0010_fp1_shadow_adjudications.sql',root),sql);
console.log(fileURLToPath(new URL('migrations/0010_fp1_shadow_adjudications.sql',root)));
