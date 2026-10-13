#!/usr/bin/env python3
"""Branch-only current V28 preparation1/operators2; retain every failed fixture."""
import argparse, hashlib, importlib.util, json, os, re, shutil, signal, stat, subprocess, sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
BASE = '4ef7a9d59c4c5e8b10e2fa060bf20c7b16b37878'
BRANCH = 'refs/heads/codex/node-v28-post-restore-operators'
FLOOR, NATIVE_BEFORE = 536870912, 603979776
HELP = {'help-main': ('main.mjs', 'Usage: node main.mjs --config '),
 'help-identity': ('identity-cli.cjs', 'Usage: local-identity '),
 'help-installation': ('installation-cli.cjs', 'Usage: local-installation upgrade '),
 'help-restore': ('restore-v28-cli.cjs', 'Usage: offline-v28 restore ')}
CASES = {
 'parser': ('server/operations/v28-post-restore-command.test.ts', [
  'keeps absent-profile identity commands V26 and accepts only explicit V28 restore/reset',
  'requires explicit Group profile, role, creation flag and control CAS without caller authority inputs',
  'rejects secret, upgrade, recovery and resource-grant options before any owner can be acquired']),
 'preparation': ('server/operations/current-v28-post-restore-source-preparation.qualification.ts', [
  'captures all actual typed data before any business POST and restores through the current fixed CLI into a fresh inert destination']),
 'operators': ('server/operations/current-v28-post-restore-operators.qualification.ts', [
  'requires explicit V28 and stopped ownership to restore one disabled principal while maintenance and runtime authority remain inert',
  'enrolls only the selected actual principal and enables Group through explicit revision CAS without releasing maintenance or granting domains']),
}

def save(path, value):
 path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')

def source():
 assert os.environ.get('GITHUB_EVENT_NAME') == 'push' and os.environ.get('GITHUB_REF') == BRANCH
 head = os.environ['GITHUB_SHA']; assert re.fullmatch('[0-9a-f]{40}', head)
 env = dict(os.environ, GIT_OPTIONAL_LOCKS='0')
 assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, env=env).decode().strip() == head
 subprocess.check_call(['git', 'merge-base', '--is-ancestor', BASE, head], cwd=ROOT, env=env)
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
 head = source(); assert not out.exists(); out.mkdir(mode=0o700)
 private(out); private(run_root)
 tmp, fixture = run_root / 'private-tmp', run_root / 'private-fixture'
 for path in (tmp, fixture):
  if not path.exists(): path.mkdir(mode=0o700)
 before = [private(path) for path in (tmp, fixture)]
 minimum = NATIVE_BEFORE if stage in ('preparation', 'operators') else FLOOR
 assert all(shutil.disk_usage(path).free >= minimum for path in (tmp, fixture))
 node = Path(shutil.which('node')).resolve(strict=True)
 assert subprocess.check_output([str(node), '--version']).decode().strip() == 'v24.19.0'
 env = dict(os.environ, TMPDIR=str(tmp), SQLITE_TMPDIR=str(tmp),
  CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT=str(fixture), NODE_PROTOTYPE_FILESYSTEM_ROOT_OWNER_UID=str(Path('/').lstat().st_uid),
  NODE_OFFLINE_V28_DISTRIBUTION=str(ROOT / 'dist-node/distribution'),
  CURRENT_V28_POST_RESTORE_PREPARATION_RECEIPT=str(run_root / 'preparation-inputs.json'), NO_COLOR='1', FORCE_COLOR='0')
 if stage == 'operators':
  prior = json.loads((run_root / 'preparation/receipt.json').read_bytes()); assert prior['status'] == 'PASS'
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
 elif stage == 'parser': argv = [str(node), str(ROOT / 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.ts', CASES[stage][0],
  '--maxWorkers', '1', '--no-file-parallelism', '--reporter=verbose', '--reporter=json', '--outputFile.json=' + str(raw)]
 else: argv = [str(node), str(ROOT / 'node_modules/vitest/vitest.mjs'), 'run', '--config',
  'current-v28-post-restore-source-preparation.vitest.config.mts' if stage == 'preparation' else 'current-v28-post-restore-operators.vitest.config.mts',
  '--reporter=verbose', '--reporter=json', '--outputFile.json=' + str(raw)]
 budget = 20 if stage in HELP else 60 if stage == 'types' else 180
 custody = inherited_custody(); child = None; close_attempted = False; close_result = None; close_error = None
 record = {'kind': 'current-v28-post-restore-original-owned-stage/1', 'stage': stage, 'head': head, 'command': argv,
  'status': 'RESERVED_BEFORE_EFFECTS', 'outerSeconds': budget, 'caseMs': 20000 if stage in ('preparation', 'operators') else None,
  'hookMs': 20000 if stage in ('preparation', 'operators') else None, 'minimumBeforeChild': minimum,
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
 parser = argparse.ArgumentParser(); parser.add_argument('--stage', choices=('types', 'parser', 'preparation', 'operators', *HELP), required=True)
 parser.add_argument('--run-root', type=Path, required=True); args = parser.parse_args()
 raise SystemExit(run(args.stage, args.run_root / args.stage, args.run_root))
