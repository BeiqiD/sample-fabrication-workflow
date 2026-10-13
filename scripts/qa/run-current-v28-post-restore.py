#!/usr/bin/env python3
"""Current V28 preparation1/operators2 and maintenance3; retain every failed fixture."""
import argparse, hashlib, importlib.util, json, os, re, shutil, signal, stat, subprocess, sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
BASE = '4ef7a9d59c4c5e8b10e2fa060bf20c7b16b37878'
BRANCH = 'refs/heads/codex/node-v28-post-restore-operators'
MAINTENANCE_BRANCH = 'refs/heads/codex/node-v28-restored-maintenance-release'
HEALTH_BRANCH = 'refs/heads/codex/node-v28-operational-health-ready'
CAPTURE_BRANCH = 'refs/heads/codex/node-v28-public-local-backup-capture'
NONEMPTY_BRANCH = 'refs/heads/codex/node-v28-nonempty-backup-restore'
PACKAGE_BRANCH = 'refs/heads/codex/node-research-package-http'
PACKAGE_PROCESS_BRANCH = 'refs/heads/codex/node-package-process'
RECOVERY_BRANCH = 'refs/heads/codex/node-online-recovery'
RECOVERY_BASE = 'ba1c92daa454d5d6b33f5723eff4268f9175ca31'
INTEGRITY_BRANCH = 'refs/heads/codex/node-package-integrity-control'
INTEGRITY_BASE = '0bc6b12a1d0f89a86155fabaa6ffde0c2d9032ec'
PUBLIC_PACKAGE_PAIR_BRANCH = 'refs/heads/codex/node-r2-package-pair'
PUBLIC_PACKAGE_PAIR_BASE = 'ba1c92daa454d5d6b33f5723eff4268f9175ca31'
PACKAGE_PROCESS_BASE = '4776095f4351c2d108f485600bd43933d7dc69c6'
PACKAGE_BASE = 'f55faa56baa2781457d6d6a8f06127fd38db00d6'
NONEMPTY_BASE = 'ab4f6cfa9721a5bf7fdcd8e7940a916ea8d520cf'
R2_PAIR_BRANCH = 'refs/heads/codex/portable-v26-r2-node-backup-one'
R2_PAIR_BASE = '33be3642ed8e72efba8269a4ea718b37b0eafd44'
MAINTENANCE_BASE = 'ebc19cf3f61b12625bc2a36086667376b41b9255'
NATIVE_STAGES = ('preparation', 'operators', 'maintenance', 'main', 'nonempty', 'r2pair', 'package-http', 'package-process', 'recovery-first', 'public-package-pair', 'package-corruption', 'package-verified-restart')
TIMED_CASE_STAGES = (*(stage for stage in NATIVE_STAGES if stage not in ('package-http', 'package-process', 'recovery-first', 'public-package-pair', 'package-corruption', 'package-verified-restart')), 'maintenance-parser', 'config-unit', 'capture-parser', 'recovery-config')
FLOOR, NATIVE_BEFORE = 536870912, 603979776
HELP = {'help-main': ('main.mjs', 'Usage: node main.mjs --config '),
 'help-identity': ('identity-cli.cjs', 'Usage: local-identity '),
 'help-installation': ('installation-cli.cjs', 'Usage: local-installation upgrade '),
 'help-restore': ('restore-v28-cli.cjs', 'Usage: offline-v28 restore ')}
CASES = {
 'package-verified-restart': ('server/packages/verified-copy-restart.qualification.ts', [
  'stops after automatic verified copy, restarts on the original120s cadence and publishes the same File and typed graph exactly once']),
 'package-corruption': ('server/packages/final-payload-corruption.qualification.ts', [
  'refuses a CRC-valid final corrupted payload through ordinary Node session and CSRF without publishing an imported graph',
  'refuses a CRC-valid final corrupted payload through genuine R2 Access without publishing an imported graph']),
 'public-package-pair': ('server/packages/public-r2-node-pair.qualification.ts', [
  'imports a genuine native R2 exported15-File Package through ordinary Node session and CSRF HTTP',
  'imports a genuine native Node exported15-File Package through fresh R2 Access and public HTTP']),
 'recovery-parser': ('server/node-runtime-command.test.ts', [
  'retains the existing absent-selector command and numeric owner pin',
  'accepts only the three named V28 surfaces in the existing unordered pair syntax',
  'rejects unknown or repeated flags, implicit generation names and incomplete commands',
]),
 'recovery-config': ('server/node-runtime-config-recovery-v28.test.ts', [
  'keeps Recovery disabled and unbound when omitted without creating a database or artifact layout',
  'does not turn a private artifact descriptor or an explicit false flag into Recovery opt-in',
  'requires the Recovery selector for true opt-in and refuses reuse under every existing surface',
  'rejects open descriptor fields, malformed opt-ins and File/Job selections before runtime admission',
  'refuses artifact roots that overlap configuration, data, client, keyring or declared local volumes',
  'keeps canonical private artifact roots and their original inode/configuration pins live',
  'selects the fixed restored filename only with explicit Recovery and the unchanged inert report pin',
  'cannot turn a copied token into a factory-issued Recovery configuration owner',
]),
 'recovery-first': ('server/recovery/current-v28-online-recovery.qualification.ts', [
  'creates an authenticated source fence, retains an unknown original publication, completes strict nonempty V5 and validates its public reupload without a target',
]),
 'package-process': ('server/packages/process-cadence.qualification.ts', [
  'persists a one-File queued export across graceful process restart, runs only automatic120s slots and releases cancelled source holds after execution']),
 'package-http': ('server/packages/request-http.qualification.ts', [
  'keeps Package HTTP unavailable when localJobs opt-in is omitted',
  'requires original CSRF and admits ordinary actor history without startup execution',
  'copies all15 verified Files through HTTP, publishes one typed graph and downloads its captured native ZIP']),
 'r2pair': ('server/recovery/current-v26-r2-node-pair.qualification.ts', [
  'backs up one real ordinary R2 HTTP upload through the original scheduled recovery job and restores exact V3 content into a fresh inert Node target']),
 'nonempty': ('server/operations/current-v28-nonempty-backup-restore.qualification.ts', [
  'preserves one real ordinary HTTP upload through stopped upgrade, compiled complete capture and compiled inert restore without destination File authority']),
 'parser': ('server/operations/v28-post-restore-command.test.ts', [
  'keeps absent-profile identity commands V26 and accepts only explicit V28 restore/reset',
  'requires explicit Group profile, role, creation flag and control CAS without caller authority inputs',
  'rejects secret, upgrade, recovery and resource-grant options before any owner can be acquired']),
 'capture-parser': ('server/operations/v28-maintenance-capture-command.test.ts', [
  'issues only the original branded stopped capture token for an explicit V28 selector',
  'refuses implicit or duplicate profiles and authority or executable overrides before opening a source',
  'preserves original canonical configuration/archive/installation/root validation and rejects fabricated tokens before I/O']),
 'preparation': ('server/operations/current-v28-post-restore-source-preparation.qualification.ts', [
  'captures all actual typed data before any business POST and restores through the current fixed CLI into a fresh inert destination']),
 'operators': ('server/operations/current-v28-post-restore-operators.qualification.ts', [
  'requires explicit V28 and stopped ownership to restore one disabled principal while maintenance and runtime authority remain inert',
  'enrolls only the selected actual principal and enables Group through explicit revision CAS without releasing maintenance or granting domains']),
 'maintenance-parser': ('server/operations/restored-v28-maintenance-release-command.test.ts', [
  'issues only one frozen exact release selection with an optional real root UID',
  'refuses implicit profiles, arbitrary databases, request actors and unsafe generations before I/O',
  'refuses copied and fabricated command bags before opening a target or granting authority']),
 'maintenance': ('server/operations/current-restored-v28-maintenance-release.qualification.ts', [
  'refuses a real competing writer, wrong installation/principal and stale generation without changing the fenced target',
  'commits one original release receipt, reconciles the same ID after open and rejects changed input without activating any other owner',
  'retains a genuine commit ACK failure and reconciles its original durable receipt on a second fresh restored target without replaying the write']),
}

CASES.update({'config-unit': ('server/node-runtime-config-restored-v28.test.ts', ['keeps the original v1 filename and rejects a restored filename field in v1', 'requires an explicit V28 selector and only selects the fixed restored filename', 'keeps restored format fields and loader options closed without path fallback', 'binds the fixed original report to the selected installation and V28 checkpoint', 'rejects configuration and report identity changes through both assertions', 'retains private mode, canonical report path and explicit root UID fences', 'never accepts a copied configuration token as a factory-issued owner']), 'main': ('server/operations/current-restored-v28-main.qualification.ts', ['serves scoped health and readiness for genuine local sessions without granting ordinary accounts domains, then closes before restored writer reacquisition'])})

def save(path, value):
 path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')

def source():
 assert os.environ.get('GITHUB_EVENT_NAME') == 'push' and os.environ.get('GITHUB_REF') in (BRANCH, MAINTENANCE_BRANCH, HEALTH_BRANCH, CAPTURE_BRANCH, NONEMPTY_BRANCH, R2_PAIR_BRANCH, PACKAGE_BRANCH, PACKAGE_PROCESS_BRANCH, RECOVERY_BRANCH, PUBLIC_PACKAGE_PAIR_BRANCH, INTEGRITY_BRANCH)
 head = os.environ['GITHUB_SHA']; assert re.fullmatch('[0-9a-f]{40}', head)
 env = dict(os.environ, GIT_OPTIONAL_LOCKS='0')
 assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, env=env).decode().strip() == head
 base = INTEGRITY_BASE if os.environ['GITHUB_REF'] == INTEGRITY_BRANCH else PUBLIC_PACKAGE_PAIR_BASE if os.environ['GITHUB_REF'] == PUBLIC_PACKAGE_PAIR_BRANCH else RECOVERY_BASE if os.environ['GITHUB_REF'] == RECOVERY_BRANCH else PACKAGE_PROCESS_BASE if os.environ['GITHUB_REF'] == PACKAGE_PROCESS_BRANCH else PACKAGE_BASE if os.environ['GITHUB_REF'] == PACKAGE_BRANCH else R2_PAIR_BASE if os.environ['GITHUB_REF'] == R2_PAIR_BRANCH else NONEMPTY_BASE if os.environ['GITHUB_REF'] == NONEMPTY_BRANCH else MAINTENANCE_BASE if os.environ['GITHUB_REF'] in (MAINTENANCE_BRANCH, HEALTH_BRANCH, CAPTURE_BRANCH) else BASE
 subprocess.check_call(['git', 'merge-base', '--is-ancestor', base, head], cwd=ROOT, env=env)
 return head

def private(path):
 st = path.lstat()
 assert path.resolve() == path and stat.S_ISDIR(st.st_mode) and not path.is_symlink()
 assert st.st_uid == os.geteuid() and stat.S_IMODE(st.st_mode) == 0o700
 return {'path': str(path), 'dev': st.st_dev, 'ino': st.st_ino, 'uid': st.st_uid, 'mode': '0o700'}

def inherited_custody():
 # This tracked module's top level only defines constants/functions. Its main
 # is guarded by __name__; no old source gate, parser, owner or command runs.
 spec = importlib.util.spec_from_file_location('v28_profile_owned_process', ROOT / 'scripts/qa/run-current-v28-runtime-profile-startup.py')
 module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
 return module

def census(stage, path):
 value = json.loads(path.read_bytes())
 rows = [item for file in value['testResults'] for item in file['assertionResults']]
 expected_file, titles = CASES[stage]
 result = {'actualTotal': len(rows), 'actualPassed': sum(row['status'] == 'passed' for row in rows),
  'actualFailed': sum(row['status'] == 'failed' for row in rows),
  'actualPending': sum(row['status'] not in ('passed', 'failed') for row in rows),
  'reporterSuccess': value.get('success'), 'titles': [row['title'] for row in rows]}
 result['exactOriginalSelection'] = [str(Path(file['name']).resolve()) for file in value['testResults']] == [str(ROOT / expected_file)] and sorted(result['titles']) == sorted(titles)
 result['pass'] = result['exactOriginalSelection'] and value.get('success') is True and result['actualPassed'] == len(titles) and result['actualFailed'] == result['actualPending'] == value.get('numPendingTests') == 0
 return result

def package_integrity_proofs(stage, fixture):
 # Read only the original fresh private leaves after original owner close and
 # exact census. Their full checkpoint/key data stays private; archive this
 # bounded hash/count/close projection in the existing stage receipt instead.
 if stage == 'package-corruption':
  paths = sorted([*fixture.glob('*/case-*/final-payload-corruption-receipt.json'),
   *fixture.glob('*/final-payload-corruption-receipt.json')])
  assert len(paths) == 2
 else:
  paths = sorted(fixture.glob('*/case-*/verified-copy-restart-process-receipt.json'))
  assert len(paths) == 1
 proofs = []
 for path in paths:
  private(path.parent)
  descriptor = path.lstat()
  assert path.resolve() == path and path.is_relative_to(fixture) and stat.S_ISREG(descriptor.st_mode) and not path.is_symlink()
  assert descriptor.st_uid == os.geteuid() and stat.S_IMODE(descriptor.st_mode) == 0o600 and descriptor.st_size <= 1048576
  raw = path.read_bytes(); value = json.loads(raw)
  proof = {'originalLeafSha256': hashlib.sha256(raw).hexdigest(), 'originalLeafBytes': len(raw), 'originalFirstCloseAcknowledged': True}
  if stage == 'package-corruption':
   assert value['schema'] == 'genuine-final-package-payload-corruption-refusal/1' and value['provider'] in ('local', 'r2')
   assert all(value[key] is True for key in ('validCrcAndOuterSha256', 'originalMetadataUnchanged', 'otherFourteenPayloadsVerified',
    'finalPayloadMismatchOnly', 'originalPublicUploadAcceptedAndVerified', 'originalPublicValidationPaused', 'originalPublicPreviewAndImportDenied',
    'canonicalRowsUnchanged', 'pausedOriginalArchiveRetained', 'originalFirstCloseAcknowledged'))
   assert value['publishedPayloadFiles'] == value['importedIdentityRows'] == value['importedRecordRows'] == 0
   assert value['retainedRawArchivePublicationDelta'] == 1 and value['failureBoundary'] == 'full_archive_validation_before_preview_or_payload_copy'
   assert value['lateCopyOrGraphPublicationFaultQualified'] is False and value['scheduledCadenceQualified'] is False
   assert value['declaredPayloadSha256'] != value['actualPayloadSha256']
   if value['provider'] == 'local': assert value['genuineNodeSessionCsrf'] and value['invalidCsrfDenied']
   else:
    assert value['genuineR2Access'] and value['actualNativeR2ArchiveBytesVerified']
    closed = value['closedD1Consistency']
    assert closed['schema'] == 'genuine-closed-original-d1-consistency/1' and closed['originalRuntimeDisposeAndListenerRefusalAcknowledged'] is True
    assert closed['databaseSha256Before'] == closed['databaseSha256After']
    assert closed['closedFileFullIntegrityCheck'] == 'ok' and closed['nativeForeignKeyCheckRows'] == closed['closedFileForeignKeyCheckRows'] == 0
   proof.update(provider=value['provider'], publishedPayloadFiles=0, importedIdentityRows=0, importedRecordRows=0,
    retainedRawArchivePublicationDelta=1, validCrcAndOuterSha256=True, finalPayloadMismatchOnly=True, canonicalRowsUnchanged=True)
  else:
   assert value['schema'] == 'genuine-compiled-node-package-verified-copy-restart/1'
   assert value['productionCadenceMs'] == 120000 and value['maximumSlots'] == 8 and value['caseMs'] == 1000000 and value['outerStageSeconds'] == 1050
   assert value['originalAutomaticSlots'] == 7 and isinstance(value['ordinaryPayloadBytes'], int) and value['ordinaryPayloadBytes'] > 0
   assert all(value[key] is True for key in ('originalFirstClosesAcknowledged', 'originalFixtureClosesAcknowledged', 'allSelectedBusinessRowsCreatedThroughHttp',
    'noManualDispatch', 'noFakeClock', 'noCadenceOverride', 'noInjectionHook', 'sameRequestSameJob', 'originalAttemptFileLocationKeyUnchanged', 'originalGraphPublishedOnce'))
   assert value['unknownWriteOrLostCommitAckQualified'] is False and value['deploymentPerformed'] is False
   children = value['originalChildren']; assert len(children) == len({row['pid'] for row in children}) == 3
   assert [row['name'] for row in children] == ['producer-original-main', 'verified-copy-original-main', 'restarted-original-main']
   assert all(row['code'] == 0 and row['signal'] is None and row['originalCloseAcknowledged'] is True for row in children)
   checkpoint, final = value['checkpoint'], value['finalProof']
   assert value['verifiedBeforeClose']['state'] == 'queued' and value['verifiedBeforeClose']['phase'] == 'copy' and value['verifiedBeforeClose']['result'] is None
   assert value['verifiedBeforeClose']['progress']['completedFiles'] == value['verifiedBeforeClose']['progress']['totalFiles'] == 1
   assert checkpoint['job']['result_json'] is None and checkpoint['copied']['file']['state'] == 'verified'
   assert final['job']['state'] == 'completed' and final['copied']['file']['state'] == 'published'
   assert checkpoint['copied']['attempt'] == final['copied']['attempt'] and checkpoint['copied']['location'] == final['copied']['location']
   assert len(checkpoint['scheduled']) == 2 and len(final['scheduled']) == 5 and len(final['aliases']) == len(final['captures']) == 1
   proof.update(productionCadenceMs=120000, originalAutomaticSlots=7, maximumSlots=8, verifiedPayloadFiles=1, publishedAliases=1,
    originalChildren=children, isolatedDatabaseAndByteRoots=2, distinctInstallationIdsClaimed=False, originalAttemptFileLocationKeyUnchanged=True,
    originalGraphPublishedOnce=True, originalFixtureClosesAcknowledged=True, nativeReexportOriginalPayloadBytes=value['ordinaryPayloadBytes'])
  proofs.append(proof)
 if stage == 'package-corruption': assert sorted(proof['provider'] for proof in proofs) == ['local', 'r2']
 return proofs

def public_package_pair_proofs(fixture):
 # Only this new stage reads these fresh receipts, after original child close,
 # zero exit and the exact original two-case census. No fixture is removed.
 paths = sorted(fixture.glob('public-r2-node-package-*/*.json'))
 assert len(paths) == 2
 catalog_text = (ROOT / 'shared/contracts/portable-runtime-v26-recovery-catalog.ts').read_text()
 offset = catalog_text.index('export const PORTABLE_RUNTIME_RECOVERY_TABLES:')
 catalog, _ = json.JSONDecoder().raw_decode(catalog_text[catalog_text.index(' = ', offset) + 3:])
 required_tables = sorted(['sqlite_schema', *(row['name'] for row in catalog)])
 expected = {'r2_to_node': ('r2-to-node.json', 'r2', 'local'), 'node_to_r2': ('node-to-r2.json', 'local', 'r2')}
 proofs = {}
 for path in paths:
  private(path.parent)
  descriptor = path.lstat()
  assert path.resolve() == path and path.is_relative_to(fixture) and stat.S_ISREG(descriptor.st_mode) and not path.is_symlink()
  assert descriptor.st_uid == os.geteuid() and stat.S_IMODE(descriptor.st_mode) == 0o600 and descriptor.st_size <= 1048576
  raw = path.read_bytes(); value = json.loads(raw)
  direction = value['direction']; assert direction in expected and direction not in proofs
  filename, source_provider, target_provider = expected[direction]
  assert path.name == filename and value['schema'] == 'genuine-current-public-r2-node-package-pair/1'
  assert value['files'] == 15 and value['sourceProvider'] == source_provider and value['destinationProvider'] == target_provider
  assert all(value[key] is True for key in ('actualNativeR2BytesVerified', 'exactOriginalStorePayloadsVerified',
   'originalArchiveImportedWithoutRetagging', 'genuineNodeSessionAndCsrf', 'invalidCsrfDenied',
   'exactTypedGraphAndIdentityReceipts', 'originalFirstCloseAcknowledged'))
  assert value['scheduledCadence120SecondsQualified'] is False
  for key in ('nativeSourceArchiveSha256', 'copiedNativeArchiveSha256'):
   assert isinstance(value[key], str) and re.fullmatch('[0-9a-f]{64}', value[key])
  assert isinstance(value['sourceInstallationId'], str) and isinstance(value['targetInstallationId'], str)
  assert value['sourceInstallationId'] and value['targetInstallationId'] and value['sourceInstallationId'] != value['targetInstallationId']
  assert len(value['sourceRoots']) == len(value['targetRoots']) == 2
  actual = {}
  for side, provider in (('source', source_provider), ('target', target_provider)):
   files, captures = value[side + 'Files'], value[side + 'Captures']
   assert len(files) == len(captures) == 15
   file_ids = [row['result_file_id'] for row in files]
   logical_ids = [row['logical_file_id'] for row in files]
   capture_ids = [row['logical_file_id'] for row in captures]
   assert all(isinstance(item, str) and item for item in [*file_ids, *logical_ids, *capture_ids])
   assert len(set(file_ids)) == len(set(logical_ids)) == len(set(capture_ids)) == 15
   assert sorted(row['source_file_id'] for row in captures) == sorted(file_ids)
   for row in files:
    assert row['actual_provider'] == provider and row['purpose'] == row['published_purpose']
    assert row['target_profile_id'] == row['active_profile_id'] and isinstance(row['active_profile_id'], str) and row['active_profile_id']
    assert isinstance(row['sha256'], str) and re.fullmatch('[0-9a-f]{64}', row['sha256']) and row['sha256'] == row['verified_sha256']
    assert isinstance(row['byte_size'], int) and not isinstance(row['byte_size'], bool) and row['byte_size'] >= 0 and row['byte_size'] == row['verified_byte_size']
   actual[side] = {'files': files, 'captures': captures, 'publishedFileCount': len(file_ids), 'distinctPublishedFileCount': len(set(file_ids)),
    'capturedFileCount': len(captures), 'distinctCapturedFileCount': len(set(capture_ids))}
  source_files = {row['result_file_id']: row for row in actual['source']['files']}
  target_files = {row['logical_file_id']: row for row in actual['target']['files']}
  assert set(target_files) == {row['logical_file_id'] for row in actual['source']['captures']}
  for capture in actual['source']['captures']:
   original, copied = source_files[capture['source_file_id']], target_files[capture['logical_file_id']]
   assert original['result_file_id'] != copied['result_file_id']
   assert (original['purpose'], original['sha256'], original['byte_size']) == (copied['purpose'], copied['sha256'], copied['byte_size'])
  source_root, target_root = Path(value['sourceFixture']), Path(value['destinationFixture'])
  assert source_root != target_root and source_root.is_relative_to(fixture) and target_root.is_relative_to(fixture)
  private(source_root); private(target_root)
  native_root = source_root if source_provider == 'r2' else target_root
  closed = value['closedD1Consistency']
  assert closed['schema'] == 'genuine-closed-original-d1-consistency/1'
  assert closed['originalRuntimeDisposeAndListenerRefusalAcknowledged'] is True
  assert closed['nativeForeignKeyCheckRows'] == closed['closedFileForeignKeyCheckRows'] == 0 and closed['closedFileFullIntegrityCheck'] == 'ok'
  assert closed['nativeCheckedTables'] in (required_tables, sorted([*required_tables, 'd1_migrations']))
  assert len(closed['nativeCheckedTables']) == len(set(closed['nativeCheckedTables']))
  for key in ('observedSchemaSha256', 'databaseSha256Before', 'databaseSha256After'):
   assert isinstance(closed[key], str) and re.fullmatch('[0-9a-f]{64}', closed[key])
  assert closed['databaseSha256Before'] == closed['databaseSha256After']
  database = Path(closed['originalDatabaseFile'])
  assert database.resolve() == database and database.is_relative_to(native_root / 'd1') and database.name != 'metadata.sqlite'
  database_stat = database.lstat(); assert stat.S_ISREG(database_stat.st_mode) and not database.is_symlink()
  digest = hashlib.sha256()
  with database.open('rb') as original_file:
   for chunk in iter(lambda: original_file.read(65536), b''): digest.update(chunk)
  after_stat = database.lstat()
  assert (after_stat.st_dev, after_stat.st_ino, after_stat.st_uid, after_stat.st_mode, after_stat.st_size, after_stat.st_mtime_ns, after_stat.st_ctime_ns) == (database_stat.st_dev, database_stat.st_ino, database_stat.st_uid, database_stat.st_mode, database_stat.st_size, database_stat.st_mtime_ns, database_stat.st_ctime_ns)
  assert digest.hexdigest() == closed['databaseSha256After']
  proofs[direction] = {'direction': direction, 'receiptPath': str(path), 'receiptSha256': hashlib.sha256(raw).hexdigest(),
   'sourceProvider': source_provider, 'destinationProvider': target_provider,
   'sourcePublishedFileCount': actual['source']['publishedFileCount'], 'sourceDistinctFileCount': actual['source']['distinctPublishedFileCount'],
   'targetPublishedFileCount': actual['target']['publishedFileCount'], 'targetDistinctFileCount': actual['target']['distinctPublishedFileCount'],
   'sourceCaptureCount': actual['source']['capturedFileCount'], 'targetCaptureCount': actual['target']['capturedFileCount'],
   'sourceArchiveSha256': value['nativeSourceArchiveSha256'], 'destinationArchiveSha256': value['copiedNativeArchiveSha256'],
   'originalFirstCloseAcknowledged': True, 'originalClosedD1File': str(database), 'originalClosedD1FileSha256': digest.hexdigest(),
   'nativeCheckedTableCount': len(closed['nativeCheckedTables']), 'originalClosedD1FullIntegrityCheck': 'ok',
   'genuineOrdinarySessionCsrfAndAccess': True, 'exactCapturedPayloadIdentityShaSizePurpose': True, 'scheduledCadenceQualified': False}
 assert set(proofs) == set(expected)
 return {'directions': [proofs[key] for key in ('r2_to_node', 'node_to_r2')], 'originalDirectionReceipts': 2,
  'payloadFilesPerDirection': 15, 'publicationCountsReadFromOriginalArrays': True, 'originalFirstClosesAcknowledged': True}

def original_diagnostic_lines(message):
 # Allow only diagnostic text with closed scalar/status values and source paths.
 # Arbitrary error text, object/array dumps, code frames and secrets stay private.
 scalar = r"(?:-?\d+(?:\.\d+)?|true|false|null|undefined|NaN|'(?:awaiting_upload|queued|running|preview|completed|failed|cancelled|paused|disabled|idle)'|\[ Array\(\d+\) \]|\[ Object \])"
 assertion = re.compile(r'AssertionError: expected ' + scalar + r' (?:not )?to (?:be|equal|deeply equal|have a length of|be greater than|be less than) ' + scalar + r'(?: but got ' + scalar + r')?(?: // (?:Object.is|deep) equality)?')
 scalar_diff = re.compile(r'\s*(?:[-+]\s+|Expected:?\s+|Received:?\s+)' + scalar)
 source_path = r'(?:(?:file://)?' + re.escape(str(ROOT)) + r'/|(?:server|shared|worker|scripts|test|node_modules)/)[A-Za-z0-9_./@+-]+\.(?:[cm]?[jt]sx?|py):\d+(?::\d+)?'
 location = re.compile(r'\s*(?:at (?:[A-Za-z0-9_.$<> ]+\()?|❯ )' + source_path + r'\)?')
 timeout = re.compile(r'Error: (?:Test|Hook) timed out in \d+ms\.?')
 package_phase = re.compile(r'PACKAGE_PHASE_V1 (?:import_accept|import_drain|publish_graph|export_accept|export_drain|download|validate) (?:start|end) ms=\d{1,9}|PACKAGE_PHASE_V1 (?:import_drain|export_drain) (?:state|step_start|step) ms=\d{1,9} i=(?:[0-9]|[12][0-9]|3[0-5]) state=(?:awaiting_upload|queued|running|preview|completed|failed|cancel_requested|cancelled|paused|other) step=(?:none|idle|disabled|paused|cleaned|preview|measured|file_verified|completed|moved|unsupported|other)')
 registration, substantive, phases = [], [], []; is_registration = False
 for line in re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', message).splitlines():
  if package_phase.fullmatch(line):
   phases.append(line)
  elif line == 'Error: STACK_TRACE_ERROR':
   is_registration = True; registration.append(line)
  elif assertion.fullmatch(line) or scalar_diff.fullmatch(line) or timeout.fullmatch(line) or line == 'Error: Bounded original Package dispatcher did not reach its checkpoint':
   is_registration = False; substantive.append(line)
  elif re.match(r'^(?:[A-Za-z]*Error|AssertionError):', line):
   is_registration = False
   substantive.append(line.split(':', 1)[0] + ': [text withheld; original private result retained]')
  elif location.fullmatch(line):
   (registration if is_registration else substantive).append(line)
 # Preserve only the last16 closed-grammar public phase facts within the
 # existing diagnostic byte caps; parsing/printing stays after original close.
 substantive.extend(phases[-16:])
 return '\n'.join(registration), '\n'.join(substantive)

def bounded_original_diagnostic(index, text, remaining):
 encoded = text.encode('utf-8'); diagnostic = encoded[:8192].decode('utf-8', errors='ignore')
 entry = {'index': index, 'diagnosticText': diagnostic, 'truncated': len(encoded) > 8192}
 # Bound serialized bytes as well as original UTF-8 bytes, including escaping.
 while len(json.dumps(entry).encode('utf-8')) > remaining and diagnostic:
  diagnostic = diagnostic[:len(diagnostic) // 2]
  entry.update(diagnosticText=diagnostic, truncated=True)
 size = len(json.dumps(entry).encode('utf-8'))
 return (entry, remaining - size) if size <= remaining else (None, remaining)

def original_failed_diagnostics(stage, results):
 # All reads/printing occur after the original cached first close, wait/census.
 # At most the original case count and32 messages; max16KiB serialized entries.
 remaining = 16384; slots = 32; failed = []
 for file in results.get('testResults', []):
  for row in file.get('assertionResults', []):
   if row.get('status') != 'failed' or len(failed) >= len(CASES[stage][1]): continue
   messages = row.get('failureMessages', [])
   if not isinstance(messages, list): messages = []
   title = row.get('title')
   item = {'title': title if title in CASES[stage][1] else '[unselected title withheld]',
    'failureMessageCount': len(messages), 'registrationStacks': [], 'substantiveMessages': []}
   inspected = 0
   for index, message in enumerate(messages):
    if not slots or remaining < 160: break
    slots -= 1; inspected += 1
    if not isinstance(message, str): continue
    registration, substantive = original_diagnostic_lines(message)
    for key, text in (('registrationStacks', registration), ('substantiveMessages', substantive)):
     if not text: continue
     entry, remaining = bounded_original_diagnostic(index, text, remaining)
     if entry is not None: item[key].append(entry)
   item['messagesNotInspected'] = len(messages) - inspected
   failed.append(item)
 return failed

def original_native_failure_diagnostics(out):
 # Vitest JSON may select a registration stack over the substantive message.
 # Read only the last16KiB of each already-closed original native log. Each
 # allowlisted stdout/stderr diagnostic entry has a4KiB serialized byte cap.
 result = []
 for name in ('original.log', 'original.stderr.log'):
  path = out / name
  try:
   with path.open('rb') as log:
    log.seek(0, os.SEEK_END); size = log.tell(); log.seek(max(0, size - 16384))
    tail = log.read(16384)
   registration, substantive = original_diagnostic_lines(tail.decode('utf-8', errors='replace'))
   entry, unused = bounded_original_diagnostic(name, substantive + ('\n' if substantive and registration else '') + registration, 4096)
   result.append({'path': str(path), 'tailBytesRead': len(tail), 'tailWindowBytes': 16384, 'diagnostic': entry})
  except OSError as error: result.append({'path': str(path), 'readFailureKind': type(error).__name__})
 return result

def run(stage, out, run_root):
 head = source()
 if os.environ['GITHUB_REF'] == INTEGRITY_BRANCH: assert stage in ('types', 'package-corruption', 'package-verified-restart')
 if stage in ('package-corruption', 'package-verified-restart'): assert os.environ['GITHUB_REF'] == INTEGRITY_BRANCH
 if os.environ['GITHUB_REF'] == PUBLIC_PACKAGE_PAIR_BRANCH: assert stage in ('types', 'public-package-pair')
 if stage == 'public-package-pair': assert os.environ['GITHUB_REF'] == PUBLIC_PACKAGE_PAIR_BRANCH
 if os.environ['GITHUB_REF'] == RECOVERY_BRANCH: assert stage in ('types', 'recovery-parser', 'recovery-config', 'recovery-first', *HELP)
 if stage in ('recovery-parser', 'recovery-config', 'recovery-first'): assert os.environ['GITHUB_REF'] == RECOVERY_BRANCH
 if stage == 'package-http': assert os.environ['GITHUB_REF'] == PACKAGE_BRANCH
 if stage == 'package-process': assert os.environ['GITHUB_REF'] == PACKAGE_PROCESS_BRANCH
 if stage in ('maintenance-parser', 'maintenance', 'config-unit', 'main'): assert os.environ['GITHUB_REF'] in (MAINTENANCE_BRANCH, HEALTH_BRANCH, CAPTURE_BRANCH, NONEMPTY_BRANCH, R2_PAIR_BRANCH)
 if stage == 'capture-parser': assert os.environ['GITHUB_REF'] in (CAPTURE_BRANCH, NONEMPTY_BRANCH, R2_PAIR_BRANCH)
 if stage == 'nonempty': assert os.environ['GITHUB_REF'] in (NONEMPTY_BRANCH, R2_PAIR_BRANCH)
 if stage == 'r2pair': assert os.environ['GITHUB_REF'] == R2_PAIR_BRANCH
 assert not out.exists(); out.mkdir(mode=0o700)
 private(out); private(run_root)
 tmp, fixture = run_root / 'private-tmp', run_root / 'private-fixture'
 for path in (tmp, fixture):
  if not path.exists(): path.mkdir(mode=0o700)
 before = [private(path) for path in (tmp, fixture)]
 minimum = NATIVE_BEFORE if stage in NATIVE_STAGES else FLOOR
 assert all(shutil.disk_usage(path).free >= minimum for path in (tmp, fixture))
 node = Path(shutil.which('node')).resolve(strict=True)
 assert subprocess.check_output([str(node), '--version']).decode().strip() == 'v24.19.0'
 env = dict(os.environ, TMPDIR=str(tmp), SQLITE_TMPDIR=str(tmp),
  CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT=str(fixture), NODE_PROTOTYPE_FILESYSTEM_ROOT_OWNER_UID=str(Path('/').lstat().st_uid),
  NODE_OFFLINE_V28_DISTRIBUTION=str(ROOT / 'dist-node/distribution'),
  CURRENT_V28_POST_RESTORE_PREPARATION_RECEIPT=str(run_root / 'preparation-inputs.json'), NO_COLOR='1', FORCE_COLOR='0')
 if stage in ('package-http', 'package-process', 'public-package-pair', 'package-corruption', 'package-verified-restart'): env['NODE_PROTOTYPE_FIXTURE_PARENT'] = str(fixture)
 if stage in ('public-package-pair', 'package-corruption', 'package-verified-restart'):
  prior = json.loads((run_root / 'types/receipt.json').read_bytes())
  assert prior['status'] == 'PASS' and prior['stage'] == 'types' and prior['head'] == head
  assert prior['originalChildWaited'] and prior['exitCode'] == 0 and prior['noFixtureRemoval']
  assert not list(fixture.glob('public-r2-node-package-*/*.json'))
 if stage == 'package-verified-restart':
  prior = json.loads((run_root / 'package-corruption/receipt.json').read_bytes())
  assert prior['status'] == 'PASS' and prior['stage'] == 'package-corruption' and prior['head'] == head
  assert prior['originalChildWaited'] and prior['exitCode'] == 0 and prior['noFixtureRemoval']
  assert prior['actualResults']['pass'] and prior['actualResults']['actualPassed'] == prior['actualResults']['actualTotal'] == 2
  assert not list(fixture.glob('*/case-*/verified-copy-restart-process-receipt.json'))
 if stage == 'recovery-first':
  # These are exact same-head original closed children, not inherited results.
  for previous, count in [('types', None), ('recovery-parser', 3), ('recovery-config', 8), *((help_stage, None) for help_stage in HELP)]:
   prior = json.loads((run_root / previous / 'receipt.json').read_bytes())
   assert prior['status'] == 'PASS' and prior['stage'] == previous and prior['head'] == head
   assert prior['originalChildWaited'] and prior['exitCode'] == 0 and prior['noFixtureRemoval']
   if count is not None:
    assert prior['actualResults']['pass'] and prior['actualResults']['actualPassed'] == prior['actualResults']['actualTotal'] == count
   if previous in HELP: assert prior['actualHelp']['helpPrefixMatched'] and prior['actualHelp']['stderrEmpty']
  env['CURRENT_V28_ONLINE_RECOVERY_RECEIPT'] = str(run_root / 'recovery-first-inputs.json')
 if stage == 'nonempty':
  # This case creates its OWN new V26 upload source and inert V28 target. The
  # earlier zero-File target is only a completed same-head pipeline prerequisite.
  main = json.loads((run_root / 'main/receipt.json').read_bytes())
  assert main['status'] == 'PASS' and main['stage'] == 'main' and main['head'] == head
  assert main['actualResults']['pass'] and main['actualResults']['actualPassed'] == main['actualResults']['actualTotal'] == 1
  assert main['originalChildWaited'] and main['exitCode'] == 0 and main['noFixtureRemoval']
  env['CURRENT_V28_NONEMPTY_BACKUP_RECEIPT'] = str(run_root / 'nonempty-inputs.json')
 if stage == 'r2pair':
  # The complete same-head24-test chain is required before this separate new
  # source. Its Node endpoint is the current programmatic V3/V26 restorer API.
  prior = json.loads((run_root / 'nonempty/receipt.json').read_bytes())
  assert prior['status'] == 'PASS' and prior['stage'] == 'nonempty' and prior['head'] == head
  assert prior['actualResults']['pass'] and prior['actualResults']['actualPassed'] == prior['actualResults']['actualTotal'] == 1
  assert prior['originalChildWaited'] and prior['exitCode'] == 0 and prior['noFixtureRemoval'] and prior['sourceFileBackupQualified']
  env['CURRENT_V26_R2_NODE_PAIR_RECEIPT'] = str(run_root / 'r2pair-inputs.json')
 if stage in ('operators', 'maintenance-parser', 'maintenance', 'main'):
  prior = json.loads((run_root / 'preparation/receipt.json').read_bytes()); assert prior['status'] == 'PASS'
  if stage in ('maintenance-parser', 'maintenance', 'main'):
   operators = json.loads((run_root / 'operators/receipt.json').read_bytes())
   assert operators['status'] == 'PASS' and operators['stage'] == 'operators' and operators['head'] == head
   assert operators['actualResults']['pass'] and operators['actualResults']['actualPassed'] == operators['actualResults']['actualTotal'] == 2
   assert operators['originalChildWaited'] and operators['exitCode'] == 0 and operators['noFixtureRemoval']
   if stage == 'main':
    maintenance = json.loads((run_root / 'maintenance/receipt.json').read_bytes())
    assert maintenance['status'] == 'PASS' and maintenance['stage'] == 'maintenance' and maintenance['head'] == head
    assert maintenance['actualResults']['pass'] and maintenance['actualResults']['actualPassed'] == maintenance['actualResults']['actualTotal'] == 3
    assert maintenance['originalChildWaited'] and maintenance['exitCode'] == 0 and maintenance['noFixtureRemoval']
  inputs = json.loads((run_root / 'preparation-inputs.json').read_bytes())
  assert inputs['kind'] == 'current-v28-genuine-zero-File-source-and-CLI-restore/1' and inputs['completeness'] == 'complete' and inputs['sourceFileCount'] == 0
  selected = inputs['environment']
  assert set(selected) == {'CURRENT_V28_POST_RESTORE_DATABASE', 'CURRENT_V28_POST_RESTORE_PRINCIPAL', 'CURRENT_V28_POST_RESTORE_REPORT_SHA256'}
  assert all(isinstance(value, str) and '\0' not in value for value in selected.values())
  target = Path(selected['CURRENT_V28_POST_RESTORE_DATABASE'])
  assert target.resolve() == target and target.is_relative_to(fixture)
  assert re.fullmatch('local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', selected['CURRENT_V28_POST_RESTORE_PRINCIPAL'])
  assert re.fullmatch('[0-9a-f]{64}', selected['CURRENT_V28_POST_RESTORE_REPORT_SHA256'])
  report = Path(selected['CURRENT_V28_POST_RESTORE_DATABASE']).parent / 'recovery-report.json'
  assert hashlib.sha256(report.read_bytes()).hexdigest() == selected['CURRENT_V28_POST_RESTORE_REPORT_SHA256']
  env.update(selected)
 raw = out / 'original-results.json'
 if stage in HELP: argv = [str(node), str(ROOT / 'dist-node/distribution/server' / HELP[stage][0]), '--help']
 elif stage == 'types': argv = [shutil.which('npm'), 'run', 'typecheck:server']
 elif stage in ('parser', 'maintenance-parser', 'config-unit', 'capture-parser', 'recovery-parser', 'recovery-config'):
  argv = [str(node), str(ROOT / 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.ts', CASES[stage][0],
   '--maxWorkers', '1', '--no-file-parallelism', '--reporter=verbose', '--reporter=json', '--outputFile.json=' + str(raw)]
  if stage in ('maintenance-parser', 'config-unit', 'capture-parser', 'recovery-config'): argv += ['--testTimeout', '20000', '--hookTimeout', '20000']
 else: argv = [str(node), str(ROOT / 'node_modules/vitest/vitest.mjs'), 'run', '--config',
  {'preparation': 'current-v28-post-restore-source-preparation.vitest.config.mts',
   'operators': 'current-v28-post-restore-operators.vitest.config.mts',
   'maintenance': 'current-restored-v28-maintenance-release.vitest.config.mts',
   'main': 'current-restored-v28-main.vitest.config.mts',
   'nonempty': 'current-v28-nonempty-backup-restore.vitest.config.mts',
   'r2pair': 'current-v26-r2-node-pair.vitest.config.mts',
   'package-http': 'node-package-http-qualification.vitest.config.mts',
   'package-process': 'node-package-process-qualification.vitest.config.mts',
   'public-package-pair': 'node-public-r2-package-pair.vitest.config.mts',
   'package-corruption': 'node-package-payload-corruption-qualification.vitest.config.mts',
   'package-verified-restart': 'node-package-verified-copy-restart-qualification.vitest.config.mts',
   'recovery-first': 'current-node-v28-recovery-first.vitest.config.mts'}[stage],
  '--reporter=verbose', '--reporter=json', '--outputFile.json=' + str(raw)]
 budget = 1050 if stage in ('package-process', 'package-verified-restart') else 20 if stage in HELP else 60 if stage == 'types' else 90 if stage == 'capture-parser' else 180
 custody = inherited_custody(); child = None; close_attempted = False; close_result = None; close_error = None
 record = {'kind': 'current-v28-post-restore-original-owned-stage/1', 'stage': stage, 'head': head, 'command': argv,
  'status': 'RESERVED_BEFORE_EFFECTS', 'outerSeconds': budget, 'caseMs': 5000 if stage in ('package-http', 'package-process') else 20000 if stage in TIMED_CASE_STAGES else None,
  'hookMs': 10000 if stage in ('package-http', 'package-process') else 20000 if stage in TIMED_CASE_STAGES else None, 'minimumBeforeChild': minimum,
  'filesystemRootOwnerUid': Path('/').lstat().st_uid, 'noFixtureRemoval': True, 'sourceFileBackupQualified': False}
 if stage == 'r2pair': record['r2NodePairQualified'] = False
 if stage == 'package-corruption': record.update(caseMs=60000, hookMs=20000, defaultCaseMs=60000, originalCases=2,
  scope='Two genuine public Node/R2 CRC-valid final payload SHA refusal cases; raw ingress retained, no imported graph/payload publication; no process restart or full recovery claim.')
 if stage == 'package-verified-restart': record.update(packageVerifiedRestartQualified=False, caseMs=1000000, hookMs=10000, defaultCaseMs=5000,
  caseTimeoutOverrides=[{'title': CASES[stage][1][0], 'caseMs': 1000000}], originalTemplateBeforeAllMs=20000, originalCases=1,
  productionCadenceMs=120000, originalKernelDeadlineMs=60000, maximumElapsedSlots=8, isolatedDatabaseAndByteRoots=2,
  scope='One original compiled-main automatic120s verified one-File copy; graceful close before typed graph; same config/new PID and same request/job recovery; exact unchanged original attempt/File/location/key and graph once; seven automatic slots in eight-slot bound; isolated fixture DB/byte roots from same admitted template, no distinct installation-ID claim; no manual dispatch, fake clock, cadence override or unknown remote-write/commit-ACK fault claim.')
 if stage == 'public-package-pair': record.update(publicPackagePairQualified=False, caseMs=60000, hookMs=20000, defaultCaseMs=60000, originalCases=2,
  scope='Genuine public R2/D1 Access and ordinary Node SQLite session/CSRF; both nonempty15File native Package directions; exact graph/File bytes and closed original D1 consistency; finite independent original emitters only, no elapsed120s cadence, corruption fault or stopped-before-graph restart claim.')
 # Original d723 default5s failure retained full work through strict15payload validation at12.265s.
 # Only the final case overrides20s; the stage argv/default5s, hook10s and outer180s remain.
 if stage == 'package-http': record.update(defaultCaseMs=5000,
  caseTimeoutOverrides=[{'title': CASES[stage][1][-1], 'caseMs': 20000}], originalTemplateBeforeAllMs=20000,
  scope='Current V26 original mounted Package HTTP/session/CSRF + independent original dispatcher + nonempty15File local copy/export/download only; no compiled-main, cross-runtime/R2, elapsed120s cadence, recovery activation or prior qualification carry.')
 if stage == 'package-process': record.update(defaultCaseMs=5000,
  caseTimeoutOverrides=[{'title': CASES[stage][1][0], 'caseMs': 1000000}], originalTemplateBeforeAllMs=20000,
  productionCadenceMs=120000, maximumElapsedSlots=8,
  scope='Fixed current compiled V26 main child; real local session/CSRF; one HTTP File and Sample record; queued graceful restart/cancellation; original automatic120s slots; exact one-payload ZIP; no manual dispatch, fake clock, cadence override, R2 pair, unknown write fault or online Recovery claim.')
 if stage == 'recovery-parser': record.update(caseMs=5000, hookMs=10000)
 if stage == 'recovery-first': record.update(caseMs=20000, hookMs=20000, defaultCaseMs=20000,
  caseTimeoutOverrides=[{'title': CASES[stage][1][0], 'caseMs': 120000}], originalTemplateBeforeAllMs=20000,
  originalKernelDeadlineMs=60000, recoveryOnlyQualified=False,
  scope='Fixed current v28-recovery compiled-main HTTP/login/admin/CSRF; retained-binding genuine one-File source; explicit source fence; separate fresh trusted one-shot shared kernel; original held postpublication ACK unknown cleanup refusal and exact-key verification; strict V5 download/public reupload/target-unavailable preview; no elapsed120s Recovery cadence, same-app business writer drain, admitted target restore/handoff or automatic activation.')
 def original_close():
  nonlocal close_attempted, close_result, close_error
  if not close_attempted:
   close_attempted = True
   try: close_result = custody.close_owned_process(child, record)
   except BaseException as error: close_error = error
  if close_error is not None: raise close_error
  return close_result
 handlers = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)}
 for number in handlers: signal.signal(number, custody.interrupted)
 okay = False; save(out / 'receipt.json', record)
 try:
  with (out / 'original.log').open('xb') as log, (out / 'original.stderr.log').open('xb') as stderr:
   blocked = signal.pthread_sigmask(signal.SIG_BLOCK, set(handlers))
   try:
    child = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=log, stderr=stderr, start_new_session=True)
    record.update(pid=child.pid, processGroup=child.pid, status='RUNNING')
   finally: signal.pthread_sigmask(signal.SIG_SETMASK, blocked)
   save(out / 'receipt.json', record)
   try: code = child.wait(timeout=budget)
   except subprocess.TimeoutExpired:
    record['outerExpired'] = True
    raise
   record['normalCompletionSnapshot'] = custody.group_snapshot(child.pid)
   assert not custody.active(record['normalCompletionSnapshot'])
   assert original_close() and code == 0
  if stage in CASES:
   record['actualResults'] = census(stage, raw); assert record['actualResults']['pass']
  if stage == 'public-package-pair': record['actualPublicPackagePair'] = public_package_pair_proofs(fixture)
  if stage in ('package-corruption', 'package-verified-restart'): record['actualPackageIntegrity'] = package_integrity_proofs(stage, fixture)
  if stage == 'recovery-first':
   proof = json.loads((run_root / 'recovery-first-inputs.json').read_bytes())
   assert proof['kind'] == 'current-node-v28-recovery-only-cli-kernel/1' and proof['sourceFileCount'] == 1
   assert isinstance(proof['payloadBytes'], int) and not isinstance(proof['payloadBytes'], bool) and proof['payloadBytes'] > 0
   for key in ('payloadSha256', 'archiveSha256'):
    assert isinstance(proof[key], str) and re.fullmatch('[0-9a-f]{64}', proof[key])
   assert all(proof[key] is True for key in ('packagedCliHttp', 'sharedTrustedOneShotDispatch', 'originalPublicationUnknownCleanupRefused'))
   assert proof['originalKernelDeadlineMs'] == 60000
   assert all(proof[key] is False for key in ('targetAvailable', 'canRecover', 'canCutover', 'recoveryCadenceQualified',
    'sourceBusinessWritersMounted', 'fullSameAppRecoveryQualified', 'automaticActivation', 'sourceExecutorsEnabled'))
   record['actualRecoveryOnly'] = {'sourceFileCount': 1, 'payloadBytes': proof['payloadBytes'],
    'payloadSha256': proof['payloadSha256'], 'archiveSha256': proof['archiveSha256'],
    'compiledMainHttp': True, 'freshTrustedOneShotKernel': True, 'originalKernelDeadlineMs': 60000,
    'unknownPublicationCleanupRefused': True, 'targetRestoreQualified': False, 'recoveryCadenceQualified': False,
    'sameAppBusinessWriterDrainQualified': False, 'automaticActivation': False}
  if stage == 'nonempty':
   proof = json.loads((run_root / 'nonempty-inputs.json').read_bytes())
   assert proof['kind'] == 'current-genuine-one-File-v28-v5-inert-restore/1' and proof['sourceFileCount'] == 1
   assert isinstance(proof['payloadBytes'], int) and not isinstance(proof['payloadBytes'], bool) and proof['payloadBytes'] > 0
   for key in ('payloadSha256', 'archiveSha256', 'recoveryReportSha256'):
    assert isinstance(proof[key], str) and re.fullmatch('[0-9a-f]{64}', proof[key])
   assert proof['sourceInstallationId'] != proof['destinationInstallationId']
   assert proof['executionEnabled'] is False and proof['nativeBindingsRestored'] is False and proof['destinationProfileBound'] is False
   assert proof['maintenanceState'] == 'fenced' and proof['originalReadPathsRetained'] is True
   record['actualNonemptyInertRestore'] = {'sourceFileCount': 1, 'payloadBytes': proof['payloadBytes'],
    'payloadSha256': proof['payloadSha256'], 'archiveSha256': proof['archiveSha256'],
    'recoveryReportSha256': proof['recoveryReportSha256'], 'destinationExecutionEnabled': False, 'destinationProfileBound': False}
  if stage == 'r2pair':
   proof = json.loads((run_root / 'r2pair-inputs.json').read_bytes())
   assert proof['kind'] == 'current-genuine-v26-d1-r2-node-inert-pair/1'
   assert proof['sourceCheckpoint'] == 'portable-runtime/v26' and proof['archiveFormat'] == 'v3' and proof['sourceProvider'] == 'r2'
   assert all(proof[key] is True for key in ('actualR2SourceBytesVerified', 'originalScheduledJobCompleted', 'actualR2ArchiveBytesVerified'))
   assert isinstance(proof['payloadBytes'], int) and not isinstance(proof['payloadBytes'], bool) and proof['payloadBytes'] > 0
   for key in ('payloadSha256', 'archiveSha256'):
    assert isinstance(proof[key], str) and re.fullmatch('[0-9a-f]{64}', proof[key])
   assert isinstance(proof['destinationInstallationId'], str) and re.fullmatch('[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', proof['destinationInstallationId'])
   assert proof['executionEnabled'] is False and proof['nativeBindingsRestored'] is False and proof['reverseNodeLocalToD1Qualified'] is False
   assert proof['maintenanceState'] == 'fenced' and proof['originalReadPathsRetained'] is True
   record['actualR2NodeInertPair'] = {'sourceCheckpoint': 'portable-runtime/v26', 'archiveFormat': 'v3', 'sourceProvider': 'r2',
    'payloadBytes': proof['payloadBytes'], 'payloadSha256': proof['payloadSha256'], 'archiveSha256': proof['archiveSha256'],
    'destinationInstallationId': proof['destinationInstallationId'], 'actualR2SourceAndArchiveBytesVerified': True,
    'nodeRestoreEntry': 'existing-programmatic-V3-Node-V26-restorer', 'reverseNodeLocalToD1Qualified': False, 'executionEnabled': False}
  if stage in HELP:
   text = (out / 'original.log').read_bytes(); errors = (out / 'original.stderr.log').read_bytes()
   assert len(text) + len(errors) <= 16384
   record['actualHelp'] = {'entry': HELP[stage][0], 'exitCode': code, 'helpPrefixMatched': text.decode().startswith(HELP[stage][1]), 'stderrEmpty': not errors}
   assert record['actualHelp']['helpPrefixMatched'] and record['actualHelp']['stderrEmpty']
  assert source() == head
  okay = True
 except BaseException as error:
  record['firstFailure'] = {'kind': type(error).__name__, 'message': str(error)}
 finally:
  for number in handlers: signal.signal(number, signal.SIG_IGN)
  try:
   if child is not None:
    try: okay = bool(original_close()) and okay
    except BaseException as error:
     okay = False; record['originalCloseError'] = {'kind': type(error).__name__, 'message': str(error)}
    record.update(originalChildWaited=child.returncode is not None, exitCode=child.returncode,
     finalGroupSnapshot=custody.group_snapshot(child.pid))
    okay = okay and child.returncode == 0 and not custody.active(record['finalGroupSnapshot'])
   if stage in CASES and raw.exists() and 'actualResults' not in record:
    try: record['actualResults'] = census(stage, raw)
    except BaseException as error: record['rawCensusFailure'] = type(error).__name__ + ': ' + str(error)
   try:
    assert [private(path) for path in (tmp, fixture)] == before
    assert all(shutil.disk_usage(path).free >= FLOOR for path in (tmp, fixture))
   except BaseException as error: okay = False; record['floorOrPrivateIdentityFailure'] = type(error).__name__ + ': ' + str(error)
   if stage == 'nonempty': record['sourceFileBackupQualified'] = bool(okay)
   if stage == 'r2pair': record['r2NodePairQualified'] = bool(okay)
   if stage == 'recovery-first': record['recoveryOnlyQualified'] = bool(okay)
   if stage == 'public-package-pair': record['publicPackagePairQualified'] = bool(okay)
   if stage == 'package-verified-restart': record['packageVerifiedRestartQualified'] = bool(okay)
   record['status'] = 'PASS' if okay else 'FAILED_OR_UNRESOLVED'
   save(out / 'receipt.json', record)
  finally:
   for number, handler in handlers.items(): signal.signal(number, handler)
 summary = {'stage': stage, 'status': record['status'], 'receipt': str(out / 'receipt.json')}
 for key in ('actualResults', 'actualHelp', 'actualPublicPackagePair', 'actualPackageIntegrity', 'firstFailure', 'rawCensusFailure', 'originalCloseError', 'floorOrPrivateIdentityFailure'):
  if key in record: summary[key] = record[key]
 if not okay and raw.exists() and stage in CASES and close_result is True and record.get('originalChildWaited') is True and 'actualResults' in record and not custody.active(record['finalGroupSnapshot']):
  try:
   results = json.loads(raw.read_bytes())
   summary['originalFailedTitles'] = original_failed_diagnostics(stage, results)
   summary['originalNativeFailureDiagnostics'] = original_native_failure_diagnostics(out)
  except (ValueError, KeyError, IndexError) as error: summary['failureSummaryUnavailable'] = type(error).__name__
 print(json.dumps(summary), flush=True)
 return 0 if okay else 1

if __name__ == '__main__':
 parser = argparse.ArgumentParser(); parser.add_argument('--stage', choices=('types', 'parser', 'capture-parser', 'preparation', 'operators', 'maintenance-parser', 'maintenance', 'config-unit', 'main', 'nonempty', 'r2pair', 'package-http', 'package-process', 'public-package-pair', 'package-corruption', 'package-verified-restart', 'recovery-parser', 'recovery-config', 'recovery-first', *HELP), required=True)
 parser.add_argument('--run-root', type=Path, required=True); args = parser.parse_args()
 raise SystemExit(run(args.stage, args.run_root / args.stage, args.run_root))
