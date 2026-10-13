#!/usr/bin/env python3
"""Finite hosted qualification of the original explicit V28 startup source.

Only the exact dedicated push branch is accepted. The original startup fixtures,
assertions and 20/20 second limits are unchanged. Each original process is waited
and reaped; an interrupted or emergency-closed attempt cannot be a passing run.
Fixture state is retained and never force removed or reused by another attempt.
"""
from __future__ import annotations
import argparse, datetime, hashlib, json, os, re, shutil, signal, stat, subprocess, sys, time
from pathlib import Path

BASE = 'cbe0fd3859e169d652e7684fc2fbbcef6f9acde7'
BRANCH = 'refs/heads/codex/node-v28-main-profiles'
SCRIPT = 'scripts/qa/run-current-v28-runtime-profile-startup.py'
WORKFLOW = '.github/workflows/current-v28-main-profiles.yml'
FLOOR = 536870912
NATIVE_BEFORE = 603979776
NODE_VERSION = 'v24.19.0'
SOURCE_PINS = {
    'server/main.ts': '82d81718881275e9c0527f74f46f17d3233d4b5472085959001766e56d2d11a4',
    'server/node-runtime-command.ts': '99b1ae7969a1afefefc5c2b2d921b1c2c6a89d0413dbde7e45b50f91c3df1a4e',
    'server/node-runtime-profile.ts': '087879da6999f33203f50f2ddb5c1d8af14d88781fd2d26c70c9fc46e4722639',
    'server/node-runtime-command.test.ts': 'f6d0673569eadd94a66d1ff95ca9aa83ece392f0824dd648c93c52bcbd6d8dc0',
    'server/collaboration/current-v28-runtime-profile-startup.qualification.ts': '801a850d8c48d2f7a61c7db5a6c39b70a92c1814339e304ab08af08a0ac0a21b',
    'current-v28-runtime-profile-startup.vitest.config.mts': 'd9e67fdfe057702b3796580ded87c833825645be0797b55d578f6912de51f3f7',
    'docs/NODE_V28_OFFLINE_RESTORE_PACKAGING_SOURCE.md': '91dd2d7a56585ea5bfcaeda0ddc36948cdb04521547019bc74c5457ec865e363',
}
MODIFIED_BASE_PATHS = {'server/main.ts', 'docs/NODE_V28_OFFLINE_RESTORE_PACKAGING_SOURCE.md'}
EXPECTED_TITLES = {
    'parser': [
        'retains the existing absent-selector command and numeric owner pin',
        'accepts only the two named V28 surfaces in the existing unordered pair syntax',
        'rejects unknown or repeated flags, implicit generation names and incomplete commands',
    ],
    'startup': [
        'keeps an absent selector V26-gated and releases the rejected V28 startup parents',
        'starts only the explicit metadata surface and reports its actual unavailable owners',
        'starts the explicit existing Fabu surface without granting general File, Jobs, SPA or recovery',
        'rejects mismatched File selections and all V28 Job opt-ins without automatic provisioning',
    ],
}
CASE_SOURCE = {
    'parser': 'server/node-runtime-command.test.ts',
    'startup': 'server/collaboration/current-v28-runtime-profile-startup.qualification.ts',
}
BUDGET = {'types': 60, 'parser': 180, 'startup': 180}
MAX_ARTIFACT = 16777216
GIT_ENV = dict(os.environ, GIT_OPTIONAL_LOCKS='0')
child = None
owned_record = {}
original_close_attempted = False
original_close_result = None
original_close_error = None

def group_snapshot(group):
 answer=[]
 for process in Path('/proc').iterdir():
  if not process.name.isdigit():continue
  pid=int(process.name)
  try:
   if os.getpgid(pid)!=group:continue
   stat=(process/'stat').read_text();state=stat.rsplit(')',1)[1].split()[0]
   fd_inspection_error=None
   try:fds=sorted(int(p.name) for p in (process/'fd').iterdir())
   except (FileNotFoundError,PermissionError) as error:
    fds=None;fd_inspection_error=type(error).__name__
   # Z/X is actual exited kernel state; it cannot retain runtime FDs.
   # Unreadable /proc FD enumeration is preserved as unknown observation,
   # never reported as observed FD0. Non-exited unknown owners still fail.
   answer.append({'pid':pid,'state':state,'openFileDescriptors':fds,
                  'fdInspectionError':fd_inspection_error,
                  'kernelResourceOwnerExited':state in ('Z','X'),
                  'activeOrOwnershipUnproven':state not in ('Z','X')})
  except (ProcessLookupError,FileNotFoundError,PermissionError):pass
 return sorted(answer,key=lambda item:item['pid'])

def active(snapshot):return [item for item in snapshot if item['activeOrOwnershipUnproven']]

class QualificationInterrupted(BaseException):
 def __init__(self,number):self.number=number;super().__init__(f'Owned qualification interrupted by signal {number}')

def close_owned_process(process,step):
 """Only this subprocess session; no fixture deletion or native-state repair."""
 step['closureInitialSnapshot']=group_snapshot(process.pid)
 if process.poll() is None or active(step['closureInitialSnapshot']):
  try:os.killpg(process.pid,signal.SIGTERM);step['ownedTermSent']=True
  except ProcessLookupError:step['ownedTermSent']=False
  try:process.wait(timeout=5)
  except subprocess.TimeoutExpired:pass
  deadline=time.monotonic()+1
  while active(group_snapshot(process.pid)) and time.monotonic()<deadline:time.sleep(.05)
  if active(group_snapshot(process.pid)):
   try:os.killpg(process.pid,signal.SIGKILL);step['ownedKillSent']=True
   except ProcessLookupError:step['ownedKillSent']=False
 step['actualExitCode']=process.wait(timeout=5)
 deadline=time.monotonic()+2
 while active(group_snapshot(process.pid)) and time.monotonic()<deadline:time.sleep(.05)
 step['closureFinalSnapshot']=group_snapshot(process.pid)
 step['ownedClosureProven']=not active(step['closureFinalSnapshot'])
 return step['ownedClosureProven']

Interrupted = QualificationInterrupted

def interrupted(number,_frame):raise Interrupted(number)

def original_close():
 global original_close_attempted,original_close_result,original_close_error
 if not original_close_attempted:
  original_close_attempted=True
  try:original_close_result=close_owned_process(child,owned_record)
  except BaseException as error:original_close_error=error
 if original_close_error is not None:raise original_close_error
 return original_close_result

def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def save(path, value):
    raw = (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()
    assert len(raw) <= MAX_ARTIFACT
    Path(path).write_bytes(raw)

def git(root, *arguments):
    return subprocess.check_output(['git', '-C', str(root), *arguments], env=GIT_ENV, stderr=subprocess.PIPE, timeout=60)

def trusted_ancestry(path):
    current = path
    root_uid = Path('/').lstat().st_uid
    while True:
        observed = current.lstat()
        assert stat.S_ISDIR(observed.st_mode) and not current.is_symlink() and current.resolve() == current
        assert observed.st_uid in (os.geteuid(), root_uid) and not stat.S_IMODE(observed.st_mode) & 0o022
        if current == current.parent:
            return
        current = current.parent

def identity(path):
    observed = path.lstat()
    assert stat.S_ISDIR(observed.st_mode) and not path.is_symlink() and path.resolve() == path
    assert observed.st_uid == os.geteuid() and stat.S_IMODE(observed.st_mode) == 0o700
    return {'path': str(path), 'dev': observed.st_dev, 'ino': observed.st_ino,
            'uid': observed.st_uid, 'gid': observed.st_gid, 'mode': '0o700'}

def source_check(root):
    assert os.environ.get('GITHUB_EVENT_NAME') == 'push' and os.environ.get('GITHUB_REF') == BRANCH
    head = os.environ['GITHUB_SHA']
    assert re.fullmatch('[0-9a-f]{40}', head)
    assert git(root, 'rev-parse', 'HEAD').decode().strip() == head
    git(root, 'merge-base', '--is-ancestor', BASE, head)
    delta = {}
    fields = git(root, 'diff', '--no-renames', '--name-status', '-z', BASE, head).split(b'\0')
    assert fields[-1] == b'' and (len(fields) - 1) % 2 == 0
    for at in range(0, len(fields) - 1, 2):
        operation, name = fields[at].decode(), fields[at + 1].decode()
        assert name not in delta
        delta[name] = operation
    expected = {name: ('M' if name in MODIFIED_BASE_PATHS else 'A') for name in SOURCE_PINS}
    expected.update({SCRIPT: 'A', WORKFLOW: 'A'})
    assert delta == expected, ('Unexpected product or qualification changes', delta)
    pins = {}
    for name, expected_sha in SOURCE_PINS.items():
        path = root / name
        observed = path.lstat()
        assert stat.S_ISREG(observed.st_mode) and not path.is_symlink()
        assert sha(path) == expected_sha
        pins[name] = {'sha256': expected_sha, 'bytes': observed.st_size}
    for name in (SCRIPT, WORKFLOW):
        path = root / name
        assert path.is_file() and not path.is_symlink()
        assert path.read_bytes() == git(root, 'show', head + ':' + name)
    git(root, 'diff', '--exit-code')
    git(root, 'diff', '--cached', '--exit-code')
    return {'head': head, 'tree': git(root, 'rev-parse', 'HEAD^{tree}').decode().strip(),
            'base': BASE, 'exactNinePathDelta': delta, 'ownedSeven': pins,
            'packageLockSha256': sha(root / 'package-lock.json'), 'runnerSha256': sha(__file__)}

def actual_node():
    selected = shutil.which('node')
    assert selected
    node = Path(selected).resolve(strict=True)
    observed = node.lstat()
    assert stat.S_ISREG(observed.st_mode) and os.access(node, os.X_OK)
    assert subprocess.check_output([str(node), '--version'], timeout=10).decode().strip() == NODE_VERSION
    return node

def artifact_pin(path):
    if not path.exists():
        return None
    observed = path.lstat()
    assert stat.S_ISREG(observed.st_mode) and not path.is_symlink() and observed.st_size <= MAX_ARTIFACT
    return {'path': str(path), 'sha256': sha(path), 'bytes': observed.st_size}

def retained_fixture_metadata(root):
    answer = []
    for path in sorted(root.rglob('*')):
        assert len(answer) < 4096, 'Retained fixture metadata exceeds the bounded record'
        observed = path.lstat()
        answer.append({'path': str(path.relative_to(root)), 'mode': oct(stat.S_IMODE(observed.st_mode)),
                       'uid': observed.st_uid, 'gid': observed.st_gid, 'bytes': observed.st_size,
                       'kind': 'symlink' if stat.S_ISLNK(observed.st_mode) else 'directory' if stat.S_ISDIR(observed.st_mode) else 'regular' if stat.S_ISREG(observed.st_mode) else 'other'})
    return answer

def command(stage, root, node, raw):
    if stage == 'types':
        npm = shutil.which('npm')
        assert npm
        return [npm, 'run', 'typecheck:server']
    vitest = str(root / 'node_modules/vitest/vitest.mjs')
    if stage == 'parser':
        return [str(node), vitest, 'run', '--config', 'vitest.config.ts', CASE_SOURCE[stage],
                '--maxWorkers', '1', '--no-file-parallelism', '--reporter=verbose', '--reporter=json',
                '--outputFile.json=' + str(raw)]
    return [str(node), vitest, 'run', '--config', 'current-v28-runtime-profile-startup.vitest.config.mts',
            '--reporter=verbose', '--reporter=json', '--outputFile.json=' + str(raw)]

def actual_results(stage, root, raw):
    pin = artifact_pin(raw)
    assert pin is not None, 'Original JSON reporter result is unavailable'
    value = json.loads(raw.read_bytes())
    assertions = [a for file in value['testResults'] for a in file['assertionResults']]
    rows = [{'title': a['title'], 'status': a['status'], 'failureMessages': a.get('failureMessages', [])} for a in assertions]
    result = {'raw': pin, 'actualTotal': len(rows), 'actualPassed': sum(a['status'] == 'passed' for a in rows),
              'actualFailed': sum(a['status'] == 'failed' for a in rows),
              'actualPending': sum(a['status'] not in ('passed', 'failed') for a in rows),
              'reporterSuccess': value.get('success'), 'reporterPending': value.get('numPendingTests'),
              'assertions': rows, 'actualFiles': [f['name'] for f in value['testResults']]}
    result['exactOriginalSelection'] = sorted(a['title'] for a in rows) == sorted(EXPECTED_TITLES[stage]) and result['actualFiles'] == [str(root / CASE_SOURCE[stage])]
    result['pass'] = result['exactOriginalSelection'] and value.get('success') is True and result['actualPassed'] == len(EXPECTED_TITLES[stage]) and result['actualFailed'] == result['actualPending'] == value.get('numPendingTests') == 0
    return result

def worker(stage, out):
    global child, owned_record
    root = Path(__file__).resolve().parents[2]
    receipt = {'kind': 'genuine-current-v28-runtime-profile-hosted-owned-stage/1', 'stage': stage,
               'status': 'RESERVED_BEFORE_EFFECTS', 'startedAt': utc(), 'sourceBefore': None,
               'childLaunched': False, 'expectedCases': EXPECTED_TITLES.get(stage), 'actualResults': None,
               'hookMs': 20000 if stage == 'startup' else None, 'caseMs': 20000 if stage == 'startup' else None,
               'outerBudgetSeconds': BUDGET[stage], 'firstFailure': None, 'noFixtureRemoval': True,
               'scope': 'Original types or original parser3/startup4 only; no compiled-main CLI, restored RT6, default V28, or historical qualification carry.'}
    target = out / 'receipt.json'
    handlers = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)}
    for number in handlers:
        signal.signal(number, interrupted)
    private_tmp = out / 'private-tmp'
    fixture = out / 'private-fixture'
    before_tmp = before_fixture = None
    log = out / 'original.log'
    raw = out / 'original-results.json'
    okay = False
    try:
        receipt['sourceBefore'] = source_check(root)
        node = actual_node()
        receipt['node'] = {'path': str(node), 'version': NODE_VERSION, 'sha256': sha(node)}
        trusted_ancestry(out)
        private_tmp.mkdir(mode=0o700)
        fixture.mkdir(mode=0o700)
        before_tmp, before_fixture = identity(private_tmp), identity(fixture)
        minimum = NATIVE_BEFORE if stage == 'startup' else FLOOR
        free = {str(p): shutil.disk_usage(p).free for p in (fixture, private_tmp)}
        receipt.update(privateTemporaryDirectory=before_tmp, privateFixtureDirectory=before_fixture,
                       observedFilesystemRootOwnerUid=Path('/').lstat().st_uid, freeBytesBefore=free,
                       minimumBeforeChild=minimum, fixtureOriginalFloorBytes=FLOOR)
        assert all(value >= minimum for value in free.values()), 'Original dual-filesystem reserve unavailable'
        argv = command(stage, root, node, raw)
        receipt['command'] = argv
        env = dict(os.environ, TMPDIR=str(private_tmp), SQLITE_TMPDIR=str(private_tmp),
                   CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT=str(fixture),
                   NODE_PROTOTYPE_FILESYSTEM_ROOT_OWNER_UID=str(Path('/').lstat().st_uid), NO_COLOR='1', FORCE_COLOR='0')
        save(target, receipt)
        with log.open('xb') as stream:
            blocked = signal.pthread_sigmask(signal.SIG_BLOCK, set(handlers))
            try:
                child = subprocess.Popen(argv, cwd=root, env=env, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
                receipt['childLaunched'] = True
                owned_record.update(pid=child.pid, processGroup=child.pid, command=argv, status='RUNNING')
                try:
                    owned_record['activeStartTicks'] = int(Path('/proc', str(child.pid), 'stat').read_text().rsplit(')', 1)[1].split()[19])
                except (FileNotFoundError, PermissionError, ValueError):
                    owned_record['activeStartTicks'] = 'UNKNOWN_NOT_CAPTURED_WHILE_ACTIVE'
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, blocked)
            save(out / 'original-owner.json', owned_record)
            code = child.wait()
            owned_record['normalCompletionSnapshot'] = group_snapshot(child.pid)
            owned_record['normalCompletionHadActiveChildren'] = bool(active(owned_record['normalCompletionSnapshot']))
            assert original_close(), 'Original process custody remains unproven'
            assert not owned_record['normalCompletionHadActiveChildren'], 'Original normal completion retained active child owners'
            assert code == 0, 'Original command failed with exit ' + str(code)
        if stage != 'types':
            receipt['actualResults'] = actual_results(stage, root, raw)
            assert receipt['actualResults']['pass'], 'Original exact result census failed'
        receipt['sourceAfter'] = source_check(root)
        assert receipt['sourceAfter'] == receipt['sourceBefore'], 'Original current source changed'
        okay = True
    except BaseException as error:
        receipt['firstFailure'] = {'kind': type(error).__name__, 'message': str(error)}
        receipt['status'] = 'FAILED_OR_UNRESOLVED'
    finally:
        for number in handlers:
            signal.signal(number, signal.SIG_IGN)
        try:
            if child is not None:
                try:
                    if not original_close():
                        okay = False
                except BaseException as error:
                    okay = False
                    receipt['originalClosureError'] = type(error).__name__ + ': ' + str(error)
                owned_record.update(actualOriginalChildWaited=child.returncode is not None, exitCode=child.returncode)
                owned_record['finalGroupSnapshot'] = group_snapshot(child.pid)
                receipt['allOwnedKernelGroupsClosed'] = not active(owned_record['finalGroupSnapshot'])
                okay = okay and receipt['allOwnedKernelGroupsClosed'] and child.returncode == 0
                receipt['originalChildCustody'] = owned_record
                save(out / 'original-owner.json', owned_record)
            else:
                receipt['allOwnedKernelGroupsClosed'] = True
            try:
                receipt['log'] = artifact_pin(log)
                receipt['rawResult'] = artifact_pin(raw)
                if stage != 'types' and raw.exists() and receipt['actualResults'] is None:
                    receipt['actualResults'] = actual_results(stage, root, raw)
                if before_tmp is not None:
                    receipt['privateTemporaryDirectoryAfter'] = identity(private_tmp)
                    assert receipt['privateTemporaryDirectoryAfter'] == before_tmp
                if before_fixture is not None:
                    receipt['privateFixtureDirectoryAfter'] = identity(fixture)
                    assert receipt['privateFixtureDirectoryAfter'] == before_fixture
                    receipt['retainedFixtureMetadata'] = retained_fixture_metadata(fixture)
                if private_tmp.exists() and fixture.exists():
                    receipt['freeBytesAfterOriginalClosure'] = {str(p): shutil.disk_usage(p).free for p in (fixture, private_tmp)}
                    assert all(value >= FLOOR for value in receipt['freeBytesAfterOriginalClosure'].values()), 'Original dual 512 MiB floor unavailable after original closure'
            except BaseException as error:
                okay = False
                receipt['evidenceFailure'] = type(error).__name__ + ': ' + str(error)
            receipt.update(status='PASS' if okay else 'FAILED_OR_UNRESOLVED', endedAt=utc())
            save(target, receipt)
        finally:
            for number, handler in handlers.items():
                signal.signal(number, handler)
    if log.exists() and log.stat().st_size <= MAX_ARTIFACT:
        print(log.read_text(errors='replace'), end='', flush=True)
    print(json.dumps({'stage': stage, 'status': receipt['status'], 'receipt': str(target), 'receiptSha256': sha(target)}), flush=True)
    return 0 if okay else 1

def supervise(stage, out):
    root = Path(__file__).resolve().parents[2]
    source = source_check(root)
    assert out.is_absolute() and out.resolve() == out and not out.exists() and not out.is_symlink()
    parent = out.parent
    if not parent.exists():
        assert parent.parent == Path.home().resolve()
        trusted_ancestry(parent.parent)
        parent.mkdir(mode=0o700)
    identity(parent)
    trusted_ancestry(parent)
    out.mkdir(mode=0o700)
    record = {'kind': 'genuine-current-v28-runtime-profile-original-finite-supervision/1', 'stage': stage,
              'source': source, 'status': 'RUNNING', 'startedAt': utc(), 'outerBudgetSeconds': BUDGET[stage],
              'originalRunnerWaitedReaped': False, 'firstFailure': None}
    target = out / 'supervisor.json'
    argv = [sys.executable, '-B', str(Path(__file__).resolve()), '--worker', '--stage', stage, '--output', str(out)]
    record['command'] = argv
    save(target, record)
    original = None
    handlers = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)}
    for number in handlers:
        signal.signal(number, interrupted)
    start = time.monotonic()
    okay = False
    try:
        blocked = signal.pthread_sigmask(signal.SIG_BLOCK, set(handlers))
        try:
            original = subprocess.Popen(argv, start_new_session=True)
            record.update(pid=original.pid, processGroup=original.pid)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, blocked)
        save(target, record)
        deadline = start + BUDGET[stage]
        while True:
            try:
                code = original.wait(timeout=max(.01, min(1, deadline - time.monotonic())))
                break
            except subprocess.TimeoutExpired:
                if time.monotonic() < deadline:
                    continue
                record['outerBudgetExpired'] = True
                record['firstFailure'] = {'kind': 'OriginalOuterBudgetExpired', 'seconds': BUDGET[stage]}
                record['originalRunnerInterruptSent'] = True
                save(target, record)
                try:
                    os.kill(original.pid, signal.SIGINT)
                except ProcessLookupError:
                    record['originalRunnerExitedDuringInterrupt'] = True
                code = original.wait()
                break
        okay = code == 0 and not record.get('outerBudgetExpired')
    except BaseException as error:
        record['firstFailure'] = record['firstFailure'] or {'kind': type(error).__name__, 'message': str(error)}
    finally:
        for number in handlers:
            signal.signal(number, signal.SIG_IGN)
        try:
            if original is not None:
                if original.poll() is None:
                    try:
                        os.kill(original.pid, signal.SIGINT)
                    except ProcessLookupError:
                        record['originalRunnerExitedDuringFinallyInterrupt'] = True
                    record['originalRunnerInterruptSentInFinally'] = True
                record['exitCode'] = original.wait()
                record['originalRunnerWaitedReaped'] = True
                record['finalRunnerGroupSnapshot'] = group_snapshot(original.pid)
                okay = okay and not active(record['finalRunnerGroupSnapshot']) and record['exitCode'] == 0
            receipt_path = out / 'receipt.json'
            record['actualReceipt'] = artifact_pin(receipt_path)
            if record['actualReceipt'] is not None:
                okay = okay and json.loads(receipt_path.read_bytes())['status'] == 'PASS'
            else:
                okay = False
            record.update(status='PASS' if okay else 'FAILED_OR_UNRESOLVED', endedAt=utc(), seconds=round(time.monotonic() - start, 3))
            save(target, record)
        finally:
            for number, handler in handlers.items():
                signal.signal(number, handler)
    return 0 if okay else 1

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', choices=('types', 'parser', 'startup'), required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--worker', action='store_true')
    args = parser.parse_args()
    if args.worker:
        identity(args.output)
        return worker(args.stage, args.output)
    return supervise(args.stage, args.output)

if __name__ == '__main__':
    raise SystemExit(main())
