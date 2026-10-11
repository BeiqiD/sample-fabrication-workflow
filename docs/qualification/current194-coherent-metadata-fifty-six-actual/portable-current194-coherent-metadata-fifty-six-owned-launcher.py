#!/usr/bin/env python3
"""Exactly the reviewed nine Worker commands; source-only until explicit GO.
The original Gate b623 custody helpers and fixture hooks own all cleanup.
"""
from pathlib import Path
import argparse, hashlib, json, os, runpy, signal, stat, subprocess, time

PLAN = Path('/tmp/portable-current194-coherent-metadata-fifty-six-executable-source-plan.json')
PLAN_SHA = '2c5bcf173f1240f5efe4745c0f1677dab8e92873504451fb230cffb0d4d28e0a'
PEER = Path('/tmp/portable-current194-coherent25-independent-complete-extraction-and56-source-selection-peer.json')
PEER_SHA = '664fac369d9db631a573912af97c548d130900b2e9c80948fea4689b355d9af5'
HELPER = Path('/tmp/portable-rt3-local-upload-gate-qualification-runner-source-only-attempt4.py')
HELPER_SHA = 'b623484a36325020644d64479cc41939c20a984a07a1ba585e4be1a17e812889'
HEAD = 'ccc7478f6045b38421f4e35def3360d7a031dd88'
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--run', action='store_true'); args = parser.parse_args()
    assert args.run and os.environ.get('NODE_CURRENT194_COHERENT_METADATA_EXCLUSIVE_GO') == HEAD, 'Explicit parent exclusive GO required'
    assert sha(PLAN) == PLAN_SHA and sha(PEER) == PEER_SHA and sha(HELPER) == HELPER_SHA
    plan = json.loads(PLAN.read_text()); peer = json.loads(PEER.read_text())
    root = Path(plan['sourceRoot']); out = Path(plan['outputDirectory'])
    frozen = Path(plan['sourceFreezePath']); assert sha(frozen) == plan['sourceFreezeSha256']
    pins = json.loads(frozen.read_text())['sourcePins']; assert len(pins) == 1932
    pinned_git = {p['path']: (p['mode'], p['blob']) for p in pins}
    assert peer['status'] == 'SOURCE_CLEAR_ONLY_56_ALL_UNRUN' and peer['source']['head'] == HEAD
    assert plan['expectedTotalCases'] == 56 and [s['expectedSelectedCases'] for s in plan['stages']] == [11, 3, 3, 3, 1, 3, 14, 17, 1]
    compiler = plan['alreadyActualCompiler']; assert sha(compiler['receiptPath']) == compiler['receiptSha256']
    actual_compiler = json.loads(Path(compiler['receiptPath']).read_text())
    assert actual_compiler['status'] == 'PASS' and actual_compiler['exitCode'] == 0
    helper = runpy.run_path(str(HELPER))  # Defines functions only; its main is never invoked.
    utc, snapshot, active, close_owned, Interrupted = [helper[k] for k in
        ('utc', 'group_snapshot', 'active', 'close_owned_process', 'QualificationInterrupted')]

    def source_check():
        git = lambda *argv: subprocess.check_output(['git', *argv], cwd=root, text=True).strip()
        assert git('rev-parse', 'HEAD') == HEAD and git('rev-parse', 'HEAD^{tree}') == plan['sourceTree']
        assert not git('status', '--porcelain=v1', '--untracked-files=no')
        for p in pins:
            file = root / p['path']; assert sha(file) == p['sha256'], p['path']
            assert bool(file.stat().st_mode & stat.S_IXUSR) == (p['mode'] == '100755'), p['path']
        assert (root / 'node_modules').resolve() == Path(plan['existingDependencyAlias'])
        assert sha(plan['node']['path']) == plan['node']['sha256']
        for p in plan['dependencyEntrypointPins']: assert sha(root / p['path']) == p['sha256'], p['path']
        # The original compiler executed on its recorded earlier code head. Every
        # one of its committed code/config inputs remains exact; docs are newer.
        for row in subprocess.check_output(['git', 'ls-tree', '-r', '-z', actual_compiler['sourceHead']], cwd=root).split(b'\0'):
            if not row: continue
            fields, name = row.split(b'\t', 1); mode, kind, blob = fields.decode().split()
            assert kind == 'blob' and pinned_git.get(name.decode()) == (mode, blob), name.decode()

    source_check()
    out.mkdir(mode=0o700, exist_ok=False)  # Unique original evidence reserved before any child launch.
    steps = [{**s, 'status': 'UNRUN'} for s in plan['stages']]
    receipt = {'kind': 'current194-coherent-metadata-fifty-six-owned-actual/1', 'status': 'RESERVED_BEFORE_EFFECTS',
        'sourceHead': HEAD, 'sourceTree': plan['sourceTree'], 'sourceFreezeSha256': sha(frozen),
        'planSha256': PLAN_SHA, 'runnerSha256': sha(__file__), 'independentPeerSha256': PEER_SHA,
        'sourcePinsVerifiedBefore': True, 'alreadyActualCompiler': compiler,
        'defaultBudgetsUnchanged': True, 'expectedSelectedCases': 56, 'steps': steps,
        'scope': 'Original Worker SQLite compatibility/provider doubles; no actual workerd, installed operational File/Request authority or native lease ACK claim.'}
    save = lambda: (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    (out / 'exact-commands.json').write_text(json.dumps([s['argv'] for s in steps], indent=2) + '\n')
    save(); deadline = time.monotonic() + 600
    handlers = {n: signal.getsignal(n) for n in (signal.SIGINT, signal.SIGTERM)}
    def interrupt(n, _frame): raise Interrupted(n)
    for n in handlers: signal.signal(n, interrupt)
    owned = log = current = None
    close_attempted = False; close_result = close_error = None
    def original_close():
        nonlocal close_attempted, close_result, close_error
        if not close_attempted:
            close_attempted = True
            try: close_result = close_owned(owned, current)
            except BaseException as error: close_error = error
        if close_error is not None: raise close_error
        return close_result
    try:
        receipt['status'] = 'RUNNING'; save()
        for current in steps:
            source_check(); close_attempted = False; close_result = close_error = None
            current.update({'status': 'RUNNING', 'startedAt': utc(), 'logPath': str(out / (current['name'] + '.log'))})
            save(); print('START ' + current['name'], flush=True); start = time.monotonic()
            log = Path(current['logPath']).open('xb')
            blocked = signal.pthread_sigmask(signal.SIG_BLOCK, set(handlers))
            try:
                owned = subprocess.Popen(current['argv'], cwd=root, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                current['pid'] = current['processGroup'] = owned.pid
            finally: signal.pthread_sigmask(signal.SIG_SETMASK, blocked)
            save(); code = owned.wait(timeout=max(.001, deadline - time.monotonic())); log.flush()
            current.update({'exitCode': code, 'actualOriginalChildWaited': True,
                'durationSeconds': round(time.monotonic() - start, 3), 'logSha256': sha(current['logPath']),
                'completionGroupSnapshot': snapshot(owned.pid)})
            current['normalCompletionHadActiveChildren'] = bool(active(current['completionGroupSnapshot']))
            closure = original_close()
            if not closure: raise RuntimeError('Original owned child closure remains unproven')
            raw = out / (current['name'] + '.json'); current['rawJsonPath'] = str(raw)
            try:
                report = json.loads(raw.read_text()); current['rawJsonSha256'] = sha(raw)
                assert [f['name'] for f in report['testResults']] == [str(root / current['file'])]
                assertions = [a for f in report['testResults'] for a in f['assertionResults']]
                paths = lambda a: a['ancestorTitles'] + [a['title']]
                expected = current['expectedTitlePaths']
                selected = [a for a in assertions if paths(a) in expected]
                unselected = [a for a in assertions if paths(a) not in expected]
                current.update({'actualSelectedTotal': len(selected),
                    'actualSelectedPassed': sum(a['status'] == 'passed' for a in selected),
                    'actualSelectedFailed': sum(a['status'] == 'failed' for a in selected),
                    'actualSelectedUnrun': sum(a['status'] not in ('passed', 'failed') for a in selected),
                    'actualSelectedAssertions': [{'titlePath': paths(a), 'status': a['status']} for a in selected],
                    'originalUnselectedAssertions': [{'titlePath': paths(a), 'status': a['status']} for a in unselected],
                    'originalReporterCounts': {k: report.get(k) for k in ('numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests')}})
                assert sorted(paths(a) for a in selected) == sorted(expected)
                assert len(selected) == current['expectedSelectedCases'] and all(a['status'] == 'passed' for a in selected)
                assert all(a['status'] not in ('passed', 'failed') for a in unselected), 'Unexpected unselected case execution'
                assert report['success'] is True
            except Exception as error: current['qualificationError'] = type(error).__name__ + ': ' + str(error)
            good = code == 0 and closure and not current['normalCompletionHadActiveChildren'] and 'qualificationError' not in current
            current['status'] = 'PASS' if good else 'FAILED_STOPPED_FIRST'
            source_check(); save(); print('END ' + current['name'] + ' ' + current['status'], flush=True)
            log.close(); log = owned = None
            if not good: receipt['status'] = 'FAILED_STOPPED_FIRST'; return 1
        receipt['status'] = 'PASS'; return 0
    except subprocess.TimeoutExpired as error:
        receipt['status'] = 'ORIGINAL_OUTER_600S_EXPIRED'; receipt['outerExpiry'] = str(error)
        if current: current['status'] = 'ORIGINAL_OUTER_600S_EXPIRED'
        return 1
    except (Interrupted, KeyboardInterrupt) as error:
        receipt['status'] = 'INTERRUPTED_PARTIAL'; receipt['interruption'] = str(error)
        if current: current['status'] = 'INTERRUPTED_PARTIAL'
        return 128 + getattr(error, 'number', signal.SIGINT)
    except Exception as error:
        receipt['status'] = 'PREFLIGHT_OR_LAUNCHER_FAILURE'; receipt['error'] = type(error).__name__ + ': ' + str(error)
        return 1
    finally:
        for n in handlers: signal.signal(n, signal.SIG_IGN)
        if owned is not None and current is not None:
            try:
                if not original_close(): receipt['status'] = 'ORIGINAL_OWNER_CLOSURE_UNPROVEN'
                current['actualOriginalChildWaited'] = owned.returncode is not None
                current['exitCode'] = owned.returncode
            except BaseException as error:
                receipt['status'] = 'ORIGINAL_OWNER_CLOSURE_UNPROVEN'; current['closureError'] = type(error).__name__ + ': ' + str(error)
        if log is not None:
            log.flush(); log.close()
            if current: current['logSha256'] = sha(current['logPath'])
        receipt['finalOwnedGroups'] = {str(s['processGroup']): snapshot(s['processGroup']) for s in steps if 'processGroup' in s}
        receipt['noActiveOrUnknownOwnedGroups'] = all(not active(s) for s in receipt['finalOwnedGroups'].values())
        try: source_check(); receipt['sourcePinsVerifiedBeforeAfter'] = True
        except Exception as error:
            receipt['sourcePinsVerifiedBeforeAfter'] = False; receipt['sourceError'] = type(error).__name__ + ': ' + str(error)
            receipt['status'] = 'FINAL_SOURCE_PINS_UNPROVEN'
        if not receipt['noActiveOrUnknownOwnedGroups']: receipt['status'] = 'ORIGINAL_OWNER_CLOSURE_UNPROVEN'
        receipt['laterStagesUnrun'] = [s['name'] for s in steps if s['status'] == 'UNRUN']
        receipt['actualSelectedPassed'] = sum(s.get('actualSelectedPassed', 0) for s in steps)
        receipt['actualSelectedFailed'] = sum(s.get('actualSelectedFailed', 0) for s in steps)
        receipt['allExpectedSelectedNotPassedOrFailed'] = 56 - receipt['actualSelectedPassed'] - receipt['actualSelectedFailed']
        receipt['originalCleanupScope'] = 'Original selected fixture hooks and cached direct-child cleanup; kernel group state/FD observations retained. Signals/termination alone do not prove business rollback or original fixture finally completion.'
        receipt['endedAt'] = utc(); save()
        for n, handler in handlers.items(): signal.signal(n, handler)
        print(json.dumps({'status': receipt['status'], 'selectedPassed': receipt['actualSelectedPassed'],
            'selectedFailed': receipt['actualSelectedFailed'], 'selectedUnrun': receipt['allExpectedSelectedNotPassedOrFailed'],
            'ownedGroupsClosed': receipt['noActiveOrUnknownOwnedGroups'], 'receipt': str(out / 'receipt.json'),
            'receiptSha256': sha(out / 'receipt.json')}), flush=True)
        if receipt['status'] in ('ORIGINAL_OWNER_CLOSURE_UNPROVEN', 'FINAL_SOURCE_PINS_UNPROVEN'): return 1

if __name__ == '__main__': raise SystemExit(main())
