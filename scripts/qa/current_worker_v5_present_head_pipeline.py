"""Explicit present-head sibling stages; definitions register no effects/acceptance."""
import hashlib, io, json, re, zipfile
from pathlib import Path

PRODUCER = 'worker-v5-present-head-bound-producer'
PAYLOAD = 'worker-v5-present-head-bound-payload'
CASES = {
 PRODUCER: ('server/operations/current-v28-present-head-bound-backup.qualification.ts', [
  'captures one genuine public Run Step LOCAL binding with its naturally issued present head through stopped V28 upgrade and complete V5 capture']),
 PAYLOAD: ('scripts/qa/worker-v5-present-head-bound-local-r2-payload-native.qualification.ts', [
  'publishes one genuine present-head bound LOCAL File to native R2 with two exact metadata events while preserving original typed history and consumer rows']),
}
CONFIGS = {PRODUCER:'current-v28-present-head-bound-backup.vitest.config.mts',
 PAYLOAD:'worker-v5-present-head-bound-local-r2-payload-native.vitest.config.mts'}
BUDGETS = {PRODUCER:180, PAYLOAD:180}
CASE_BUDGETS = {PRODUCER:[120000], PAYLOAD:[120000]}
INPUT_NAME = 'worker-v5-present-head-bound-inputs.json'
PREFIX = 'WORKER_V5_NATIVE_PRESENT_HEAD_BOUND'
SCOPE = ('One genuine public original V26 Run Step LOCAL consumer/head, whole original close, stopped V28 upgrade and current '
 'compiled complete strict V5 capture; separate fresh inert native D1/R2 constructor with two actual destination profile/runtime '
 'history events and final generation+2. Both original same-head stages must PASS/close before the pair is counted. '
 'No public V28 File route, live same-app recovery, elapsed cadence, activation or all-provider claim.')

def original_controller():
 # Runtime import of the actual already loaded controller. No reconstructed
 # receipt, alternative caller closure or new process/native owner is issued.
 import current_worker_v5_pipeline
 return current_worker_v5_pipeline

def configure(stage, env, run_root, fixture, head, source_tree):
 original = original_controller(); original.distribution(run_root,head,source_tree)
 if stage == PRODUCER:
  path = run_root / INPUT_NAME; assert not path.exists()
  env['CURRENT_V28_PRESENT_HEAD_BOUND_BACKUP_RECEIPT'] = str(path)
 else:
  assert stage == PAYLOAD
  receipt = original.original_receipt(run_root,PRODUCER,head,source_tree); producer = receipt['currentProducer']
  raw = original.read_private(producer['inputsPath'])
  assert hashlib.sha256(raw).hexdigest() == producer['inputsSha256'] and len(raw) == producer['inputsBytes']
  archive = Path(producer['archive']); assert archive.is_relative_to(fixture)
  archive_bytes = original.read_private(archive,8*1024*1024)
  assert hashlib.sha256(archive_bytes).hexdigest() == producer['archiveSha256'] and len(archive_bytes) == producer['archiveBytes']
  facts = archive_facts(archive_bytes,json.loads(raw))
  assert all(producer[key] == facts[key] for key in facts)
  env.update({PREFIX+'_ARCHIVE':str(archive), PREFIX+'_SHA256':producer['archiveSha256'],
   PREFIX+'_PRODUCER_RECEIPT':str(run_root/PRODUCER/'receipt.json'), PREFIX+'_PRODUCER_INPUTS':producer['inputsPath'],
   PREFIX+'_PRODUCER_HEAD':head})

def archive_facts(archive_bytes, proof):
 """Observe metadata of the exact original producer's strict-admitted archive.
 This is not a replacement archive admission API or a source permission grant.
 The genuine Node case has already passed its frozen whole-V5 validator; these
 independent closed checks derive counts/links from those same private bytes.
 """
 def pairs(entries):
  result = {}
  for key,value in entries:
   assert key not in result; result[key] = value
  return result
 def constant(_value): raise ValueError('Present-head metadata must contain finite JSON')
 def document(raw): return json.loads(raw.decode('utf8'),object_pairs_hook=pairs,parse_constant=constant)
 assert 0 < len(archive_bytes) <= 8*1024*1024
 with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
  entries = archive.infolist(); names = [entry.filename for entry in entries]
  assert len(names) == len(set(names)) == 5
  assert all(not entry.is_dir() and entry.compress_type == zipfile.ZIP_STORED
   and not entry.flag_bits & 1 and 0 < entry.file_size <= 4*1024*1024 for entry in entries)
  raw = {entry.filename:archive.read(entry) for entry in entries} # Original CRCs checked, no external files/FDs opened.
  manifest = document(raw['manifest.json']); records_raw = raw['records.json']; records = document(records_raw)
  assert manifest['schema'] == 'system-backup/5' and manifest['kind'] == 'system_backup'
  assert manifest['contentSchemaVersion'] == 28 and manifest['completeness'] == 'complete'
  assert records['schema'] == 'system-backup-records/5' and records['image']['version'] == 5
  assert records['image']['checkpointId'] == 'portable-runtime/v28'
  assert records['origin'] == {'format':'native','schemaVersion':28,'capturePolicy':'quiesced-writers-and-bytes/1'}
  assert records['sourceMigrationLedger']['kind'] == 'node-reviewed-migrations/1'
  assert records['sourceMigrationLedger']['installationId'] == manifest['sourceInstallationId'] == proof['sourceInstallationId']
  assert records['sourceMigrationLedger']['checkpointId'] == 'portable-runtime/v28'
  assert hashlib.sha256(records_raw).hexdigest() == manifest['recordsSha256']
  assert len(manifest['files']) == 1; file = manifest['files'][0]
  assert file['outcome'] == 'packaged' and file['fileIds'] == [proof['fileId']] and file['purposes'] == ['embedded_content']
  assert file['source']['provider'] == 'local' and file['source']['storeKind'] == 'file'
  assert file['source']['byteAuthority'] == 'file_location' and file['source']['fileId'] == proof['fileId']
  assert file['source']['purpose'] == 'embedded_content' and file['bindings'] == file['source']['consumerBindings']
  assert len(file['bindings']) == 2 and file['byteSize'] == proof['payloadBytes'] > 0
  assert file['sha256'] == proof['payloadSha256'] and re.fullmatch('[0-9a-f]{64}',file['sha256'])
  payload_path = file['path']; assert isinstance(payload_path,str) and '\\' not in payload_path
  assert not payload_path.startswith('/') and all(part not in ('','.','..') for part in payload_path.split('/'))
  assert set(names) == {'manifest.json','records.json','report/index.html','report/report.md',payload_path}
  assert len(raw[payload_path]) == file['byteSize'] and hashlib.sha256(raw[payload_path]).hexdigest() == file['sha256']
  assert all(manifest['counts'][key] == value for key,value in
   {'sources':1,'packagedFiles':1,'unavailableFiles':0,'bytes':file['byteSize']}.items())
 content = records['content']['tables']; heads = [row for row in content['file_shadow_heads'] if row['present'] == 1]
 assert len(heads) == 1; head = heads[0]
 assert head['consumer_kind'] == 'run_step_asset' and head['consumer_id'] == proof['consumerId']
 assert head['consumer_sub_id'] == '' and head['file_slot'] == 'primary'
 assert head['generation'] == proof['headGeneration'] >= 1 and head['occurrence_id'] == proof['headOccurrenceId']
 binding = {'consumerKind':'run_step_asset','consumerId':head['consumer_id'],'consumerSubId':'','fileSlot':'primary',
  'fileId':proof['fileId'],'purpose':None}
 event_binding = {'consumerKind':'event','consumerId':proof['eventId'],'consumerSubId':'','fileSlot':'primary',
  'fileId':proof['fileId'],'purpose':'embedded_content'}
 def ordered_bindings(rows): return sorted(rows,key=lambda row:json.dumps(row,sort_keys=True,separators=(',',':')))
 assert ordered_bindings(file['bindings']) == ordered_bindings([binding,event_binding])
 assert file['bindings'] == proof['nativeConsumerBindings']
 projection = [row for row in content['file_consumer_projection'] if row['file_id'] == proof['fileId']]
 assert len(projection) == 2
 actual_bindings = [{'consumerKind':row['consumer_kind'],'consumerId':row['consumer_id'],'consumerSubId':row['consumer_sub_id'],
  'fileSlot':row['file_slot'],'fileId':row['file_id'],'purpose':row['expected_purpose']} for row in projection]
 assert ordered_bindings(actual_bindings) == ordered_bindings([binding,event_binding])
 events = [row for row in content['events'] if row['asset_file_id'] == proof['fileId']]
 assert len(events) == 1 and events[0]['id'] == proof['eventId'] and events[0]['sample_id'] == proof['sampleId']
 assert events[0]['kind'] == 'image' and events[0]['asset_key'] is None
 assert document(events[0]['metadata_json'].encode('utf8')) == {'runId':proof['runId'],'stepId':proof['stepId'],
  'runStepAssetId':proof['consumerId'],'assetId':proof['assetId']}
 consumers = [row for row in content['run_step_assets'] if row['id'] == head['consumer_id']]
 assert len(consumers) == 1 and consumers[0]['file_id'] == proof['fileId'] and consumers[0]['asset_id'] == proof['assetId']
 assert consumers[0]['run_step_id'] == proof['stepId'] and consumers[0]['role'] == 'execution'
 assert consumers[0]['deleted_at'] is None and consumers[0]['superseded_by_occurrence_id'] is None
 occurrences = [row for row in content['file_shadow_occurrences'] if row['id'] == head['occurrence_id']]
 assert len(occurrences) == 1; occurrence = occurrences[0]
 assert all(occurrence[key] == head[key] for key in
  ('consumer_kind','consumer_id','consumer_sub_id','file_slot','generation','present','source_rowid','source_json','observed_epoch'))
 assert occurrence['legacy_store_kind'] is occurrence['legacy_provider'] is occurrence['legacy_object_key'] is None
 assert occurrence['expected_purpose'] == 'embedded_content'
 assert not any(row['occurrence_id'] == head['occurrence_id'] for row in content['file_shadow_closures'])
 source = document(head['source_json'].encode('utf8'))
 assert source['_dependencies']['profileRevision'] == proof['sourceProfileRevision']
 typed = records['image']['tables']['file_shadow_heads']; columns = typed['columns']
 assert len(columns) == len(set(columns)); selected = []
 for row in typed['rows']:
  assert len(row['cells']) == len(columns)
  cells = dict(zip(columns,row['cells'])); present = cells['present']
  if present == {'type':'integer','value':'1'}: selected.append(cells)
 assert len(selected) == 1
 for key in ('consumer_kind','consumer_id','consumer_sub_id','file_slot','occurrence_id','source_json'):
  assert selected[0][key] == {'type':'text','value':head[key]}
 for key in ('generation','present','source_rowid','observed_epoch'):
  assert selected[0][key] == {'type':'integer','value':str(head[key])}
 return {'sourceFileCount':len(manifest['files']),'presentHeads':len(heads),'nativeBoundPresentHead':binding in file['bindings'],
  'strictOriginalProducerArchiveBound':True,'sourceRecordsSha256':hashlib.sha256(records_raw).hexdigest()}

def finish(stage, record, run_root, fixture):
 original = original_controller(); head, source_tree = record['head'],record['tree']
 assert original.tree(head) == source_tree
 actual = record['actualResults']
 assert actual['pass'] is True and actual['exactOriginalSelection'] is True
 assert actual['actualTotal'] == actual['actualPassed'] == 1 and actual['actualFailed'] == actual['actualPending'] == 0
 assert record['ownedClosureProven'] is True and record['actualExitCode'] == 0 and record['noFixtureRemoval'] is True
 assert isinstance(record['closureFinalSnapshot'],list) and not any(row['activeOrOwnershipUnproven'] for row in record['closureFinalSnapshot'])
 assert not record.get('outerExpired') and not any(key in record for key in ('firstFailure','originalCloseError','floorOrPrivateIdentityFailure'))
 assert record['qualificationSourceSha256'] == hashlib.sha256((original.ROOT / CASES[stage][0]).read_bytes()).hexdigest()
 if stage == PRODUCER:
  path = run_root / INPUT_NAME; raw = original.read_private(path); proof = json.loads(raw)
  assert proof['schema'] == 'current-genuine-present-head-bound-node-run-step-v5-producer/1' and proof['runtime'] == '24.19.0'
  assert all(proof[key] is True for key in ('genuineOriginalV26PublicProducer','stoppedV28UpgradeAfterOriginalClose',
   'currentVerifiedCompiledStoppedCapture','noBusinessSqlSeed','naturallyIssuedHead','oldTypedRowsAndRowidsUnchanged',
   'sourceUnchanged','originalCloseAcknowledged'))
  assert proof['distribution'] == str(original.ROOT / 'dist-node/distribution') and proof['presentHeads'] == 1
  for key in ('headGeneration','sourceProfileRevision','payloadBytes'):
   assert isinstance(proof[key],int) and not isinstance(proof[key],bool) and 0 <= proof[key] <= 9007199254740991
  assert proof['headGeneration'] >= 1 and proof['payloadBytes'] > 0
  assert isinstance(proof['eventId'],str) and proof['eventId']
  archive = Path(proof['archive']); assert archive.is_relative_to(fixture)
  archive_bytes = original.read_private(archive,8*1024*1024); archive_sha = hashlib.sha256(archive_bytes).hexdigest()
  assert re.fullmatch('[0-9a-f]{64}',proof['archiveSha256']) and archive_sha == proof['archiveSha256']
  built = original.distribution(run_root,head,source_tree); facts = archive_facts(archive_bytes,proof)
  assert original.read_private(path) == raw and original.read_private(archive,8*1024*1024) == archive_bytes
  assert original.tree(head) == source_tree
  # Original caller has already ACKed its child and actual single-case PASS.
  # It will save this record only after final original source/floor/owner checks;
  # consumers still require that persisted final PASS, never RUNNING metadata.
  record['currentProducer'] = {'inputsPath':str(path),'inputsSha256':hashlib.sha256(raw).hexdigest(),'inputsBytes':len(raw),
   'archive':str(archive),'archiveSha256':archive_sha,'archiveBytes':len(archive_bytes),
   'distribution':built['distribution'],'distributionManifestSha256':built['distributionManifestSha256'],
   'distributionSourceInputsSha256':built['distributionSourceInputsSha256'],**facts}
 else:
  assert stage == PAYLOAD
  producer = original.original_receipt(run_root,PRODUCER,head,source_tree)
  paths = sorted(fixture.glob('.native-v5-target-*/closed-native-file-consistency.json'))
  fresh = [path for path in paths if str(path) not in record['workerV5ProofPathsBefore']]; assert len(fresh) == 1
  raw_closed = original.read_private(fresh[0]); closed = json.loads(raw_closed)
  assert closed['schema'] == 'closed-original-native-d1-readonly-consistency/1'
  assert all(closed[key] is True for key in ('originalNativeDisposed','wholeQuickCheck','foreignKeys',
   'durableMainAndWalUnchanged','physicalPathsAndInodesUnchanged'))
  raw = original.read_private(fresh[0].parent / 'original-native-response.json'); value = json.loads(raw); shadow = value['proof']['shadow']
  assert value['format'] == 'v5' and value['sourceFileCount'] == value['mappingCount'] == 1
  assert value['archiveSha256'] == producer['currentProducer']['archiveSha256'] and value['calls'] == {'put':1,'delete':0}
  assert all(value[key] is True for key in ('sourceUnchanged','freshIdentity','mappingExact','missingMappingRejected'))
  assert value['proof']['originalBoundConsumers'] == 2
  assert all(value['proof'][key] is True for key in ('naturallyIssuedPresentHead','oldRowsExact','oldRowidsExact','appendsClosed',
   'emptyLocal','inertDefaults','foreignKeys','tableIntegrity','canonicalConsumerEvidenceExact'))
  assert shadow['presentHeads'] == 1 and shadow['metadataEvents'] == shadow['addedOccurrences'] == shadow['addedClosures'] == 2
  assert all(shadow[key] is True for key in ('eachEventAdvancesOneGeneration','exactOriginalSuccessorChain',
   'immutableOccurrenceFieldsPreserved','sourceJsonOnlyProfileRevisionTokenChanged','independentFinalHeadIntegrity'))
  for key in ('generation','profileRevision','epoch'):
   assert isinstance(shadow[key+'Before'],int) and not isinstance(shadow[key+'Before'],bool)
   assert shadow[key+'After'] == shadow[key+'Before'] + 2
  record['actualClosedNativeProofs'] = [{'originalProofSha256':hashlib.sha256(raw_closed).hexdigest(),
   'originalProofBytes':len(raw_closed),'originalNativeDisposed':True,'wholeQuickCheck':True,'foreignKeys':True,
   'durableMainAndWalUnchanged':True,'physicalPathsAndInodesUnchanged':True}]
  record['actualPresentHeadV5'] = {'originalProofSha256':hashlib.sha256(raw).hexdigest(),'originalProofBytes':len(raw),
   'sourceFileCount':1,'presentHeads':1,'metadataEvents':2,'addedOccurrences':2,'addedClosures':2,
   'eachEventAdvancesOneGeneration':True,'exactOriginalTypedHistoryAndRowids':True,'canonicalConsumerPreserved':True,
   'sourceUnchanged':True,'originalNativeDisposed':True,'wholeQuickCheck':True,'foreignKeys':True,
   'automaticActivation':False,'elapsedCadenceQualified':False}

def public_receipt(record, summary):
 stage = record['stage']; assert stage in CASES
 value = {'schema':'current-worker-v5-original-owned-ci/1','stage':stage,'head':record['head'],'tree':record['tree'],
  'status':record['status'],'scope':SCOPE,'outerSeconds':record['outerSeconds'],'caseTimeoutsMs':CASE_BUDGETS[stage],
  'minimumBeforeChild':record['minimumBeforeChild'],'minimumAfterChild':536870912,
  'originalChildWaitObservationPresent':'originalChildWaited' in record,'originalChildWaited':record.get('originalChildWaited') is True,
  'originalCloseObservationPresent':'ownedClosureProven' in record,'ownedClosureProven':record.get('ownedClosureProven') is True,
  'exitCode':record.get('exitCode'),'outerExpired':record.get('outerExpired') is True,'noFixtureRemoval':True,
  'selectedFile':CASES[stage][0],'selectedTitles':CASES[stage][1],'qualificationSourceSha256':record['qualificationSourceSha256'],
  'presentHeadBoundPairQualified':False,'qualifiedPresentHeadBoundCases':0}
 snapshot = record.get('finalGroupSnapshot'); value['finalGroupObservationPresent'] = isinstance(snapshot,list)
 value['finalActiveOrUnprovenOwners'] = sum(row['activeOrOwnershipUnproven'] is True for row in snapshot) if isinstance(snapshot,list) else None
 if 'actualResults' in record:
  value['actualResults'] = {key:record['actualResults'][key] for key in
   ('actualTotal','actualPassed','actualFailed','actualPending','reporterSuccess','exactOriginalSelection','pass')}
 closed_pass = record['status'] == 'PASS' and record.get('originalChildWaited') is True and record.get('ownedClosureProven') is True
 closed_pass = closed_pass and record.get('exitCode') == 0 and value['finalActiveOrUnprovenOwners'] == 0
 closed_pass = closed_pass and not value['outerExpired'] and not any(key in record for key in
  ('firstFailure','originalCloseError','floorOrPrivateIdentityFailure','publicDiagnosticFailureKind'))
 if closed_pass and stage == PRODUCER and 'currentProducer' in record:
  value['currentProducer'] = {key:record['currentProducer'][key] for key in ('inputsSha256','inputsBytes','archiveSha256','archiveBytes',
   'distributionManifestSha256','distributionSourceInputsSha256','sourceFileCount','presentHeads','nativeBoundPresentHead',
   'strictOriginalProducerArchiveBound','sourceRecordsSha256')}
 if closed_pass and stage == PAYLOAD and 'actualPresentHeadV5' in record and record.get('actualResults',{}).get('pass') is True:
  value['actualClosedNativeProofs'] = record['actualClosedNativeProofs']; value['actualPresentHeadV5'] = record['actualPresentHeadV5']
  value['presentHeadBoundPairQualified'] = True; value['qualifiedPresentHeadBoundCases'] = 2
 for key in ('firstFailure','originalCloseError','rawCensusFailure','floorOrPrivateIdentityFailure','publicDiagnosticFailureKind'):
  if key in record:
   error = record[key]; kind = error.get('kind') if isinstance(error,dict) else error.split(':',1)[0] if isinstance(error,str) else ''
   value[key+'Kind'] = kind if re.fullmatch('[A-Za-z][A-Za-z0-9_]{0,80}',kind or '') else 'ErrorKindUnavailable'
 for key in ('originalFailedTitles','failureSummaryUnavailable'):
  if key in summary: value[key] = summary[key]
 if 'originalNativeFailureDiagnostics' in summary:
  value['originalNativeFailureDiagnostics'] = [{'stream':stream,**{key:item[key] for key in
   ('tailBytesRead','tailWindowBytes','diagnostic','readFailureKind') if key in item}}
   for stream,item in zip(('stdout','stderr'),summary['originalNativeFailureDiagnostics'])]
 return value
