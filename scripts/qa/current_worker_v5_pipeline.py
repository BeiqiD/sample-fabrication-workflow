"""Additive cold/native V5 CI lane; imported definitions perform no effects."""
import hashlib, json, os, re, stat, subprocess
from pathlib import Path
import current_worker_v5_present_head_pipeline as present_head

ROOT = Path(__file__).resolve().parents[2]
BRANCH = 'refs/heads/codex/node-worker-v5-inert-roundtrip'
BASE = 'd47d297fffc92b6a9325f94115eaba7e7a5565c7'
TOOLS = ('worker-v5-types', 'worker-v5-build')
CASES = {
 'worker-v5-zero': ('server/operations/current-v28-post-restore-source-preparation.qualification.ts', [
  'captures all actual typed data before any business POST and restores through the current fixed CLI into a fresh inert destination']),
 'worker-v5-nonempty': ('server/operations/current-v28-nonempty-backup-restore.qualification.ts', [
  'preserves one real ordinary HTTP upload through stopped upgrade, compiled complete capture and compiled inert restore without destination File authority']),
 'worker-v5-constructor': ('scripts/qa/worker-v5-fresh-target-native.qualification.ts', [
  'constructs an exact fresh inert native D1 V28 target from the original complete zero-File Node V5 archive',
  'constructs an exact fresh inert native D1 V28 target and explicit R2 plan from the original genuine nonempty LOCAL Node V5 archive']),
 'worker-v5-payload': ('scripts/qa/worker-v5-local-r2-payload-native.qualification.ts', [
  'publishes original genuine LOCAL Node V5 bytes to native R2 while preserving exact inert D1 V28 File history',
  'retains the original committed native R2 PUT rejection and unknown V5 attempt without replay or deletion']),
 'worker-v5-held': ('scripts/qa/worker-v5-held-r2-node-roundtrip.qualification.ts', [
  'captures the original held native R2 V28 V5 archive and restores exact recovery evidence into a fresh coherent Node distribution']),
 'worker-v5-public-historical': ('scripts/qa/worker-v5-public-historical-native.qualification.ts', [
  'restores the original zero-File V5 archive through genuine Access public FP5 upload, jobs and inert report',
  'restores the original nonempty V5 through genuine Access public FP5 and recaptures held native R2 through a real backup job into fresh current Node']),
 'worker-v5-original-issue-negative': ('scripts/qa/worker-v5-original-issue-negative.qualification.ts', [
  'refuses the genuine public V5 artifact PUT after actual administrator revocation during the original native namespace ACK',
  'refuses the genuine held V5 R2 GET after actual administrator revocation during the original native profile ACK',
  'retains the genuine held V5 body across its real 60s deadline and refuses new issue after the original native ACK arrives late']),
 'worker-v5-bound-producer': ('server/operations/current-v28-bound-comment-backup.qualification.ts', [
  'captures one real bound LOCAL Comment attachment with its naturally issued present head and exact immutable typed history']),
 'worker-v5-bound-payload': ('scripts/qa/worker-v5-bound-local-r2-payload-native.qualification.ts', [
  'publishes one original genuine bound LOCAL Comment File to native R2 while preserving exact consumer cells, rowids and its two-event present-head successor history']),
}
CONFIGS = dict(zip(CASES, (
 'current-v28-post-restore-source-preparation.vitest.config.mts', 'current-v28-nonempty-backup-restore.vitest.config.mts',
 'worker-v5-fresh-target-native.vitest.config.mts', 'worker-v5-local-r2-payload-native.vitest.config.mts',
 'worker-v5-held-r2-node-roundtrip.vitest.config.mts', 'worker-v5-public-historical-native.vitest.config.mts',
 'worker-v5-original-issue-negative.vitest.config.mts', 'current-v28-bound-comment-backup.vitest.config.mts',
 'worker-v5-bound-local-r2-payload-native.vitest.config.mts')))
CASES.update(present_head.CASES)
CONFIGS.update(present_head.CONFIGS)
STAGES = (*TOOLS, *CASES)
ORDER = ('types', *TOOLS, *CASES)
PRODUCERS = {'worker-v5-zero': 'ZERO', 'worker-v5-nonempty': 'NONEMPTY', 'worker-v5-bound-producer': 'BOUND'}
INPUT_NAMES = {'worker-v5-zero': 'worker-v5-zero-inputs.json', 'worker-v5-nonempty': 'worker-v5-nonempty-inputs.json',
 'worker-v5-bound-producer': 'worker-v5-bound-inputs.json'}
BUDGETS = {'worker-v5-types': 300, 'worker-v5-build': 300, 'worker-v5-constructor': 240,
 'worker-v5-payload': 300, 'worker-v5-bound-producer': 120, 'worker-v5-public-historical': 300, 'worker-v5-original-issue-negative': 480}
CASE_BUDGETS = {'worker-v5-zero': [20000], 'worker-v5-nonempty': [20000],
 'worker-v5-constructor': [60000,120000], 'worker-v5-payload': [120000,120000],
 'worker-v5-held': [120000], 'worker-v5-public-historical': [120000,120000], 'worker-v5-original-issue-negative': [120000,120000,180000], 'worker-v5-bound-producer': [60000], 'worker-v5-bound-payload': [120000]}
BUDGETS.update(present_head.BUDGETS)
CASE_BUDGETS.update(present_head.CASE_BUDGETS)
SCOPE = ('Fresh current committed producers and fixed distribution; zero/nonempty Node V5 to native D1 V28 constructor; '
 'unbound LOCAL to R2 and original committed PUT-ACK unknown retention; real held R2 V5 to fresh inert current Node; '
 'one native-bound canonical Comment File with its natural present head and exact two-event profile/runtime successors. Cold candidate APIs only; no public Recovery routing, '
 'combined live application, elapsed cadence, arbitrary nonzero-head transfer, all-provider parity or activation qualification.')

PUBLIC_HISTORICAL_SCOPE = ('Genuine authenticated Access public FP5 V5 zero/nonempty upload/validation/original job/ready report; fresh inert native D1/R2; actual public held R2 backup job and fresh compiled current Node restore. Original scheduled dispatch only; no elapsed cadence, planned-window, durable backup-cleanup, all-provider or automatic cutover qualification.')

ORIGINAL_ISSUE_NEGATIVE_SCOPE = ('Original authenticated production Worker/D1/R2 issue negatives: live deployment administrator revocation during exact original native namespace/profile acknowledgements and real 60s deadline with original held R2 reader. No fake clock or permission callback; raw and logical close observations remain distinct and original SDK exception/quarantine is retained. No planned-window, durable cleanup or elapsed cadence qualification.')

def tree(head):
 env = dict(os.environ, GIT_OPTIONAL_LOCKS='0')
 assert subprocess.check_output(['git','rev-parse','HEAD'], cwd=ROOT, env=env, timeout=10).decode().strip() == head
 result = subprocess.check_output(['git','rev-parse','HEAD^{tree}'], cwd=ROOT, env=env, timeout=10).decode().strip()
 assert re.fullmatch('[0-9a-f]{40}', result)
 subprocess.check_call(['git','diff','--quiet','HEAD','--'], cwd=ROOT, env=env, timeout=10)
 return result

def read_private(path, maximum=1048576):
 path = Path(path); before = path.lstat()
 assert path.resolve() == path and stat.S_ISREG(before.st_mode) and not path.is_symlink()
 assert before.st_uid == os.geteuid() and stat.S_IMODE(before.st_mode) == 0o600 and before.st_nlink == 1
 assert 0 < before.st_size <= maximum
 raw = path.read_bytes(); after = path.lstat()
 assert (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns) == (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)
 assert len(raw) == before.st_size
 return raw

def original_receipt(run_root, previous, head, source_tree):
 value = json.loads(read_private(run_root / previous / 'receipt.json'))
 assert value['kind'] == 'current-v28-post-restore-original-owned-stage/1' and value['stage'] == previous
 assert value['head'] == head and value['tree'] == source_tree and value['status'] == 'PASS'
 assert value['exitCode'] == 0 and value['originalChildWaited'] and value['ownedClosureProven'] and value['noFixtureRemoval']
 assert not value.get('outerExpired') and not any(key in value for key in ('firstFailure','originalCloseError','floorOrPrivateIdentityFailure'))
 assert isinstance(value['finalGroupSnapshot'],list) and all(row['activeOrOwnershipUnproven'] is False for row in value['finalGroupSnapshot'])
 if previous in CASES:
  actual = value['actualResults']; assert actual['pass'] and actual['exactOriginalSelection']
  assert actual['actualTotal'] == actual['actualPassed'] == len(CASES[previous][1]) and actual['actualFailed'] == actual['actualPending'] == 0
 return value

def distribution(run_root, head, source_tree):
 value = original_receipt(run_root, 'worker-v5-build', head, source_tree)['actualOwnedTools']
 assert value['checkpoint'] == 'portable-runtime/v28' and value['distributionVersion'] == 3
 path = Path(value['distribution']); assert path == ROOT / 'dist-node/distribution' and path.resolve() == path
 assert hashlib.sha256((path / 'manifest.json').read_bytes()).hexdigest() == value['distributionManifestSha256']
 assert hashlib.sha256((path / 'source-inputs.json').read_bytes()).hexdigest() == value['distributionSourceInputsSha256']
 return value

def configure(stage, env, run_root, fixture, head, source_tree):
 for previous in ORDER[:ORDER.index(stage)]: original_receipt(run_root, previous, head, source_tree)
 env.update(WORKER_V5_CURRENT_PRODUCER_HEAD=head, WORKER_V5_CURRENT_PRODUCER_TREE=source_tree,
  WORKER_V5_NATIVE_FIXTURE_PARENT=str(fixture), WORKER_V5_COHERENT_NODE_DISTRIBUTION=str(ROOT / 'dist-node/distribution'))
 if stage in present_head.CASES: return present_head.configure(stage,env,run_root,fixture,head,source_tree)
 if stage in TOOLS:
  path = run_root / (stage + '-tools.json'); assert not path.exists(); env['WORKER_V5_OWNED_TOOL_RECEIPT'] = str(path)
 elif stage in PRODUCERS:
  distribution(run_root,head,source_tree)
  path = run_root / INPUT_NAMES[stage]; assert not path.exists()
  env[{'worker-v5-zero':'CURRENT_V28_POST_RESTORE_PREPARATION_RECEIPT',
   'worker-v5-nonempty':'CURRENT_V28_NONEMPTY_BACKUP_RECEIPT',
   'worker-v5-bound-producer':'CURRENT_V28_BOUND_COMMENT_BACKUP_RECEIPT'}[stage]] = str(path)
 else:
  distribution(run_root,head,source_tree)
  for producer_stage, kind in PRODUCERS.items():
   if kind == 'BOUND' and stage != 'worker-v5-bound-payload': continue
   producer = original_receipt(run_root,producer_stage,head,source_tree)['currentProducer']
   raw = read_private(producer['inputsPath']); assert hashlib.sha256(raw).hexdigest() == producer['inputsSha256']
   archive = Path(producer['archive']); assert archive.is_relative_to(fixture)
   archive_bytes = read_private(archive,8*1024*1024)
   assert hashlib.sha256(archive_bytes).hexdigest() == producer['archiveSha256'] and len(archive_bytes) == producer['archiveBytes']
   prefix = 'WORKER_V5_NATIVE_BOUND' if kind == 'BOUND' else 'WORKER_V5_' + kind
   env.update({prefix+'_ARCHIVE':str(archive),prefix+'_SHA256':producer['archiveSha256'],
    prefix+'_PRODUCER_RECEIPT':str(run_root/producer_stage/'receipt.json'),prefix+'_PRODUCER_INPUTS':producer['inputsPath']})
  if stage == 'worker-v5-bound-payload': env['WORKER_V5_NATIVE_BOUND_PRODUCER_HEAD'] = head

def command(stage, node, raw):
 if stage in TOOLS: return [str(node),str(ROOT / 'scripts/qa/current-worker-v5-owned-build.mjs'),stage]
 return [str(node),str(ROOT / 'node_modules/vitest/vitest.mjs'),'run','--config',CONFIGS[stage],
  '--reporter=verbose','--reporter=json','--outputFile.json='+str(raw)]

def finish(stage, record, run_root, fixture):
 head, source_tree = record['head'],record['tree']; assert tree(head) == source_tree
 if stage in present_head.CASES: return present_head.finish(stage,record,run_root,fixture)
 if stage in TOOLS:
  raw = read_private(run_root / (stage+'-tools.json')); value = json.loads(raw)
  assert value['schema'] == 'current-worker-v5-original-owned-tools/1' and value['stage'] == stage
  assert len(value['originalChildren']) == (6 if stage == 'worker-v5-types' else 4)
  assert all(row['code'] == 0 and row['signal'] is None and row['originalCloseAcknowledged'] is True for row in value['originalChildren'])
  record['actualOwnedTools'] = value; record['originalOwnedToolsProofSha256'] = hashlib.sha256(raw).hexdigest()
 elif stage in PRODUCERS:
  path = run_root / INPUT_NAMES[stage]; raw = read_private(path); proof = json.loads(raw)
  kind = PRODUCERS[stage]
  if kind == 'ZERO':
   assert proof['kind'] == 'current-v28-genuine-zero-File-source-and-CLI-restore/1' and proof['sourceFileCount'] == 0
   assert proof['completeness'] == 'complete' and proof['archiveFormat'] == 'v5' and proof['sourceCheckpoint'] == 'portable-runtime/v28'
  elif kind == 'NONEMPTY':
   assert proof['kind'] == 'current-genuine-one-File-v28-v5-inert-restore/1' and proof['sourceFileCount'] == 1
   assert proof['payloadBytes'] == 68 and proof['executionEnabled'] is False and proof['nativeBindingsRestored'] is False
   assert proof['maintenanceState'] == 'fenced' and proof['destinationProfileBound'] is False and proof['originalReadPathsRetained'] is True
  else:
   assert proof['schema'] == 'current-genuine-bound-node-comment-v5-producer/1' and proof['runtime'] == '24.19.0'
   assert all(proof[key] is True for key in ('genuineOriginalCommentProducer','currentVerifiedCompiledStoppedCapture','noBusinessSqlSeed',
    'oldTypedRowsAndRowidsUnchanged','noManufacturedLegacyHeads','naturallyIssuedCommentHead','immutableSourceShadowChainExact','sourceUnchanged','originalCloseAcknowledged'))
   assert len(proof['nativeConsumerBindings']) > 0 and proof['payloadBytes'] > 0
   assert proof['presentHeads'] == 1 and isinstance(proof['headGeneration'],int) and proof['headGeneration'] == 14
   assert isinstance(proof['headOccurrenceId'],str) and proof['headOccurrenceId']
  archive = Path(proof['archive']); assert archive.is_relative_to(fixture)
  archive_bytes = read_private(archive,8*1024*1024); archive_sha = hashlib.sha256(archive_bytes).hexdigest()
  assert re.fullmatch('[0-9a-f]{64}',proof['archiveSha256']) and archive_sha == proof['archiveSha256']
  built = distribution(run_root,head,source_tree)
  record['currentProducer'] = {'inputsPath':str(path),'inputsSha256':hashlib.sha256(raw).hexdigest(),'inputsBytes':len(raw),
   'archive':str(archive),'archiveSha256':archive_sha,'archiveBytes':len(archive_bytes),
   'distribution':built['distribution'],'distributionManifestSha256':built['distributionManifestSha256'],
   'distributionSourceInputsSha256':built['distributionSourceInputsSha256'],'sourceFileCount':0 if kind == 'ZERO' else 1,
   'nativeBoundCommentPresentHead':kind == 'BOUND'}
 else:
  paths = sorted(fixture.glob('.native-v5-target-*/closed-native-file-consistency.json'))
  fresh = [path for path in paths if str(path) not in record['workerV5ProofPathsBefore']]
  assert len(fresh) == len(CASES[stage][1]); proofs = []
  for path in fresh:
   raw = read_private(path); value = json.loads(raw)
   assert value['schema'] == 'closed-original-native-d1-readonly-consistency/1'
   assert all(value[key] is True for key in ('originalNativeDisposed','wholeQuickCheck','foreignKeys','durableMainAndWalUnchanged','physicalPathsAndInodesUnchanged'))
   proofs.append({'originalProofSha256':hashlib.sha256(raw).hexdigest(),'originalProofBytes':len(raw),
    'originalNativeDisposed':True,'wholeQuickCheck':True,'foreignKeys':True,'durableMainAndWalUnchanged':True,'physicalPathsAndInodesUnchanged':True})
  record['actualClosedNativeProofs'] = proofs
  if stage == 'worker-v5-public-historical':
   originals = []
   for path in fresh:
    raw = read_private(path.parent / 'original-public-v5-historical-receipt.json'); value = json.loads(raw)
    assert value['schema'] == 'genuine-access-public-v5-historical-native/1' and value['files'] in (0,1)
    assert value['cadenceSeconds'] == 120 and value['maxStepMs'] == 60000 and value['elapsedCadenceQualified'] is False
    assert all(value[key] is True for key in ('authenticatedActualProductionHandler','actualDurablePublicUploadAndRecovery',
     'exactOriginalTypedCellsAndRowids','closedAppendCensus','accountsDisabled','groupDefaultDisabled','executionDefaultsDisabled',
     'originalPairFirstCloseAcknowledged','originalNativeDisposed')) and value['automaticCutover'] is False
    assert value['sourceFullIntegrity'] == value['targetFullIntegrity'] == 'ok'
    capture = value['captureProof']
    if value['files'] == 1:
     assert capture['realAcceptedBackupJob'] and capture['archiveFormat'] == 'v5' and capture['payloads'] == 1 and capture['payloadBytes'] == 68
     assert capture['exactTypedRowsAndRowids'] and capture['holdsRetainedUntilDurableCleanupProof'] and capture['compiledCurrentNodeRestore']
     assert capture['coherentDistributionManifestSha256'] == distribution(run_root,head,source_tree)['distributionManifestSha256']
    else: assert capture is None
    originals.append({'originalProofSha256':hashlib.sha256(raw).hexdigest(),'originalProofBytes':len(raw),'files':value['files'],
     'authenticatedActualProductionHandler':True,'actualDurablePublicUploadAndRecovery':True,'exactOriginalTypedCellsAndRowids':True,
     'closedAppendCensus':True,'originalPairFirstCloseAcknowledged':True,'originalNativeDisposed':True,
     'sourceFullIntegrity':'ok','targetFullIntegrity':'ok','actualPublicHeldR2ToCurrentNode':value['files'] == 1,
     'cadenceSeconds':120,'maxStepMs':60000,'elapsedCadenceQualified':False,'automaticCutover':False})
   assert sorted(value['files'] for value in originals) == [0,1]
   record['actualPublicHistoricalV5'] = originals
  if stage == 'worker-v5-original-issue-negative':
   originals = []
   expected = {'namespace-actor','profile-actor','held-original-ack'}
   for path in fresh:
    raw = read_private(path.parent / 'original-v5-issue-negative-receipt.json'); value = json.loads(raw)
    assert value['schema'] == 'genuine-worker-v5-original-issue-negative/1' and value['kind'] in expected
    assert value['actualKernelDeadlineMs'] == 60000 and value['cadenceSeconds'] == 120
    assert value['elapsedCadenceQualified'] is value['fakeClock'] is value['permissionCallbackMock'] is value['newExecutor'] is False
    assert value['registeredLogicalFirstClosePositive'] is False
    assert all(value[key] is True for key in ('actualProductionHandlerAndAccess','actualNativeAckReturnedUnchanged',
     'originalInvocationSettled','noLaterProviderIssue','noExtraPut','noPublication','originalFixtureFirstCloseAcknowledged','originalNativeDisposed'))
    assert value['sourceFullIntegrity'] == value['targetFullIntegrity'] == 'ok' and value['originalAvailableLocationInventory'] == 2
    assert value['exactOriginalProtectedLocalAndCanonicalR2HoldIdsRetained'] is (value['kind'] != 'namespace-actor')
    trace = value['nativeObservation']; gate = trace['gate']
    assert gate['kind'] == value['kind'] and gate['entered'] and gate['originalAcknowledged'] and gate['released']
    assert trace['nativePut'] == trace['nativeDelete'] == 0
    if value['kind'] == 'held-original-ack':
     assert value['originalScheduledOutcome'] == 'exception' and value['originalHttpStatus'] is None
     assert value['registeredLogicalFirstCloseOutcome'] == 'original-sdk-exception-quarantined'
     assert value['actualLiveAdministratorPolicyRevoked'] is False and value['holdsRetained'] is True
     assert gate['returnedAt'] - gate['enteredAt'] >= 61000
     assert trace['nativeGet'] == trace['readers'] == trace['originalCancelCalls'] == trace['originalCancelAcknowledged'] == 1
     assert trace['originalReaderClosedAcknowledged'] == 1 and trace['originalCancelRejected'] == trace['originalReaderClosedRejected'] == 0
    else:
     assert value['actualLiveAdministratorPolicyRevoked'] is trace['actorRevoked'] is True
     assert value['registeredLogicalFirstCloseOutcome'] == 'not-independently-observed'
     if value['kind'] == 'namespace-actor': assert value['originalHttpStatus'] == 409 and value['originalScheduledOutcome'] is None
     else: assert value['originalScheduledOutcome'] == 'ok' and trace['nativeGet'] == trace['readers'] == 0 and value['holdsRetained'] is True
    originals.append({'kind':value['kind'],'originalProofSha256':hashlib.sha256(raw).hexdigest(),'originalProofBytes':len(raw),
     'actualKernelDeadlineMs':60000,'cadenceSeconds':120,'originalScheduledOutcome':value['originalScheduledOutcome'],
     'originalHttpStatus':value['originalHttpStatus'],'originalFixtureFirstCloseAcknowledged':True,'originalNativeDisposed':True,
     'registeredLogicalFirstClosePositive':False,'registeredLogicalFirstCloseOutcome':value['registeredLogicalFirstCloseOutcome'],
     'noLaterProviderIssue':True,'noExtraPut':True,'noPublication':True,'holdsRetained':value['holdsRetained'],
     'rawOriginalReaderCancelAcknowledged':trace['originalCancelAcknowledged'],
     'originalReturnedAckElapsedMs':gate['returnedAt']-gate['enteredAt']})
   assert {value['kind'] for value in originals} == expected and len(originals) == 3
   record['actualOriginalIssueNegatives'] = originals
  if stage == 'worker-v5-held':
   original = fresh[0].parent / 'original-node-restore-receipt.json'; raw = read_private(original); value = json.loads(raw)
   assert value['archiveFormat'] == 'v5' and value['actualBytes'] == 68
   assert all(value[key] is True for key in ('restoredOriginalLocalEvidence','canonicalFileIdsPreserved','exactTypedRows'))
   assert value['coherentDistributionManifestSha256'] == distribution(run_root,head,source_tree)['distributionManifestSha256']
   record['actualHeldNodeRestore'] = {'originalProofSha256':hashlib.sha256(raw).hexdigest(),'originalProofBytes':len(raw),
    'archiveFormat':'v5','actualBytes':68,'exactTypedRows':True,'restoredOriginalLocalEvidence':True,'canonicalFileIdsPreserved':True,
    'coherentDistributionManifestSha256':value['coherentDistributionManifestSha256'],'automaticActivation':False}

def public_receipt(record, summary):
 if record['stage'] in present_head.CASES: return present_head.public_receipt(record,summary)
 stage = record['stage']; value = {'schema':'current-worker-v5-original-owned-ci/1','stage':stage,'head':record['head'],
  'tree':record['tree'],'status':record['status'],'scope':ORIGINAL_ISSUE_NEGATIVE_SCOPE if stage=='worker-v5-original-issue-negative' else PUBLIC_HISTORICAL_SCOPE if stage=='worker-v5-public-historical' else SCOPE,'outerSeconds':record['outerSeconds'],
  'caseTimeoutsMs':CASE_BUDGETS.get(stage),'minimumBeforeChild':record['minimumBeforeChild'],'minimumAfterChild':536870912,
  'originalChildWaitObservationPresent':'originalChildWaited' in record,'originalChildWaited':record.get('originalChildWaited') is True,
  'originalCloseObservationPresent':'ownedClosureProven' in record,'ownedClosureProven':record.get('ownedClosureProven') is True,
  'exitCode':record.get('exitCode'),'outerExpired':record.get('outerExpired') is True,'noFixtureRemoval':True}
 snapshot = record.get('finalGroupSnapshot'); value['finalGroupObservationPresent'] = isinstance(snapshot,list)
 value['finalActiveOrUnprovenOwners'] = sum(row['activeOrOwnershipUnproven'] is True for row in snapshot) if isinstance(snapshot,list) else None
 if stage in CASES:
  value.update(selectedFile=CASES[stage][0],selectedTitles=CASES[stage][1],qualificationSourceSha256=record['qualificationSourceSha256'])
 if 'actualResults' in record:
  value['actualResults'] = {key:record['actualResults'][key] for key in ('actualTotal','actualPassed','actualFailed','actualPending','reporterSuccess','exactOriginalSelection','pass')}
 for key in ('actualClosedNativeProofs','actualHeldNodeRestore','actualPublicHistoricalV5','actualOriginalIssueNegatives','originalOwnedToolsProofSha256'):
  if key in record: value[key] = record[key]
 if 'currentProducer' in record:
  value['currentProducer'] = {key:record['currentProducer'][key] for key in ('inputsSha256','inputsBytes','archiveSha256','archiveBytes',
   'distributionManifestSha256','distributionSourceInputsSha256','sourceFileCount','nativeBoundCommentPresentHead')}
 if 'actualOwnedTools' in record:
  tools = record['actualOwnedTools']; value['actualOwnedTools'] = {key:tools[key] for key in ('schema','stage','originalChildren',
   'distributionManifestSha256','distributionSourceInputsSha256','distributionVersion','distributionFiles','checkpoint') if key in tools}
 for key in ('firstFailure','originalCloseError','rawCensusFailure','floorOrPrivateIdentityFailure','publicDiagnosticFailureKind'):
  if key in record:
   error = record[key]; kind = error.get('kind') if isinstance(error,dict) else error.split(':',1)[0] if isinstance(error,str) else ''
   value[key+'Kind'] = kind if re.fullmatch('[A-Za-z][A-Za-z0-9_]{0,80}',kind or '') else 'ErrorKindUnavailable'
 for key in ('originalFailedTitles','failureSummaryUnavailable'):
  if key in summary: value[key] = summary[key]
 if 'originalNativeFailureDiagnostics' in summary:
  value['originalNativeFailureDiagnostics'] = [{'stream':stream,**{key:item[key] for key in ('tailBytesRead','tailWindowBytes','diagnostic','readFailureKind') if key in item}}
   for stream,item in zip(('stdout','stderr'),summary['originalNativeFailureDiagnostics'])]
 return value
