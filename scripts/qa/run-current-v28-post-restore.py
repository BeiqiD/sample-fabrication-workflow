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
NONEMPTY_BASE = 'ab4f6cfa9721a5bf7fdcd8e7940a916ea8d520cf'
MAINTENANCE_BASE = 'ebc19cf3f61b12625bc2a36086667376b41b9255'
NATIVE_STAGES = ('preparation', 'operators', 'maintenance', 'main', 'nonempty')
TIMED_CASE_STAGES = (*NATIVE_STAGES, 'maintenance-parser', 'config-unit', 'capture-parser')
FLOOR, NATIVE_BEFORE = 536870912, 603979776
HELP = {'help-main': ('main.mjs', 'Usage: node main.mjs --config '),
 'help-identity': ('identity-cli.cjs', 'Usage: local-identity '),
 'help-installation': ('installation-cli.cjs', 'Usage: local-installation upgrade '),
 'help-restore': ('restore-v28-cli.cjs', 'Usage: offline-v28 restore ')}
CASES = {
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
 assert os.environ.get('GITHUB_EVENT_NAME') == 'push' and os.environ.get('GITHUB_REF') in (BRANCH, MAINTENANCE_BRANCH, HEALTH_BRANCH, CAPTURE_BRANCH, NONEMPTY_BRANCH)
 head = os.environ['GITHUB_SHA']; assert re.fullmatch('[0-9a-f]{40}', head)
 env = dict(os.environ, GIT_OPTIONAL_LOCKS='0')
 assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, env=env).decode().strip() == head
 base = NONEMPTY_BASE if os.environ['GITHUB_REF'] == NONEMPTY_BRANCH else MAINTENANCE_BASE if os.environ['GITHUB_REF'] in (MAINTENANCE_BRANCH, HEALTH_BRANCH, CAPTURE_BRANCH) else BASE
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

def run(stage, out, run_root):
 head = source()
 if stage in ('maintenance-parser', 'maintenance', 'config-unit', 'main'): assert os.environ['GITHUB_REF'] in (MAINTENANCE_BRANCH, HEALTH_BRANCH, CAPTURE_BRANCH, NONEMPTY_BRANCH)
 if stage == 'capture-parser': assert os.environ['GITHUB_REF'] in (CAPTURE_BRANCH, NONEMPTY_BRANCH)
 if stage == 'nonempty': assert os.environ['GITHUB_REF'] == NONEMPTY_BRANCH
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
 if stage == 'nonempty':
  # This case creates its OWN new V26 upload source and inert V28 target. The
  # earlier zero-File target is only a completed same-head pipeline prerequisite.
  main = json.loads((run_root / 'main/receipt.json').read_bytes())
  assert main['status'] == 'PASS' and main['stage'] == 'main' and main['head'] == head
  assert main['actualResults']['pass'] and main['actualResults']['actualPassed'] == main['actualResults']['actualTotal'] == 1
  assert main['originalChildWaited'] and main['exitCode'] == 0 and main['noFixtureRemoval']
  env['CURRENT_V28_NONEMPTY_BACKUP_RECEIPT'] = str(run_root / 'nonempty-inputs.json')
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
 elif stage in ('parser', 'maintenance-parser', 'config-unit', 'capture-parser'):
  argv = [str(node), str(ROOT / 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.ts', CASES[stage][0],
   '--maxWorkers', '1', '--no-file-parallelism', '--reporter=verbose', '--reporter=json', '--outputFile.json=' + str(raw)]
  if stage in ('maintenance-parser', 'config-unit', 'capture-parser'): argv += ['--testTimeout', '20000', '--hookTimeout', '20000']
 else: argv = [str(node), str(ROOT / 'node_modules/vitest/vitest.mjs'), 'run', '--config',
  {'preparation': 'current-v28-post-restore-source-preparation.vitest.config.mts',
   'operators': 'current-v28-post-restore-operators.vitest.config.mts',
   'maintenance': 'current-restored-v28-maintenance-release.vitest.config.mts',
   'main': 'current-restored-v28-main.vitest.config.mts',
   'nonempty': 'current-v28-nonempty-backup-restore.vitest.config.mts'}[stage],
  '--reporter=verbose', '--reporter=json', '--outputFile.json=' + str(raw)]
 budget = 20 if stage in HELP else 60 if stage == 'types' else 90 if stage == 'capture-parser' else 180
 custody = inherited_custody(); child = None; close_attempted = False; close_result = None; close_error = None
 record = {'kind': 'current-v28-post-restore-original-owned-stage/1', 'stage': stage, 'head': head, 'command': argv,
  'status': 'RESERVED_BEFORE_EFFECTS', 'outerSeconds': budget, 'caseMs': 20000 if stage in TIMED_CASE_STAGES else None,
  'hookMs': 20000 if stage in TIMED_CASE_STAGES else None, 'minimumBeforeChild': minimum,
  'filesystemRootOwnerUid': Path('/').lstat().st_uid, 'noFixtureRemoval': True, 'sourceFileBackupQualified': False}
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
   record['status'] = 'PASS' if okay else 'FAILED_OR_UNRESOLVED'
   save(out / 'receipt.json', record)
  finally:
   for number, handler in handlers.items(): signal.signal(number, handler)
 summary = {'stage': stage, 'status': record['status'], 'receipt': str(out / 'receipt.json')}
 for key in ('actualResults', 'actualHelp', 'firstFailure', 'rawCensusFailure', 'originalCloseError', 'floorOrPrivateIdentityFailure'):
  if key in record: summary[key] = record[key]
 if not okay and raw.exists():
  try:
   results = json.loads(raw.read_bytes())
   summary['originalFailedTitles'] = [{'title': row.get('title'), 'firstMessage': str(row.get('failureMessages', [''])[0])[:1024]}
    for file in results.get('testResults', []) for row in file.get('assertionResults', []) if row.get('status') == 'failed']
  except (ValueError, KeyError, IndexError) as error: summary['failureSummaryUnavailable'] = type(error).__name__
 print(json.dumps(summary), flush=True)
 return 0 if okay else 1

if __name__ == '__main__':
 parser = argparse.ArgumentParser(); parser.add_argument('--stage', choices=('types', 'parser', 'capture-parser', 'preparation', 'operators', 'maintenance-parser', 'maintenance', 'config-unit', 'main', 'nonempty', *HELP), required=True)
 parser.add_argument('--run-root', type=Path, required=True); args = parser.parse_args()
 raise SystemExit(run(args.stage, args.run_root / args.stage, args.run_root))
