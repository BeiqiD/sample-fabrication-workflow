#!/usr/bin/env python3
"""Current f883 paired Node frontend, fixed4 bundles and original manifest8/parser6/genuineCLI3; no old artifacts or runtime retag. Root explicit exclusive --run GO only.
Reuses the unchanged retained Gate b623 ownership functions; one separately source-reviewed socket-timeout handoff after the original request deadline arm.
"""
from __future__ import annotations
import argparse, hashlib, json, os, re, runpy, signal, subprocess, time
from pathlib import Path

INPUTS = Path('/workspace/current-dev57f-qualified-cli-mounted-job-source-handoffs/finite-current-original-seven-stage-seventeen-peerbound-attempt1/current-seven-stage-source-inputs.json')
INPUTS_SHA256 = '29d33740fde7ef92ce6fc700955c1ed231431b32e0cb6a81d05d73b3a14c315d'
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not args.run:
        raise SystemExit('No invocation without explicit root exclusive runtime GO')
    assert sha(INPUTS) == INPUTS_SHA256
    frozen = json.loads(INPUTS.read_text())
    root, helper_path = Path(frozen['sourceRoot']), Path(frozen['helper'])
    assert sha(helper_path) == frozen['helperSha256']
    # Import defines the retained functions; its __main__/product runner never runs.
    helper = runpy.run_path(str(helper_path))
    utc, group_snapshot, active, close_owned_process, Interrupted = [helper[name] for name in
        ('utc', 'group_snapshot', 'active', 'close_owned_process', 'QualificationInterrupted')]
    plan_path = Path(frozen['plan'])
    assert sha(plan_path) == frozen['planSha256']
    plan = json.loads(plan_path.read_text())
    assert str(args.output) == plan['expectedActualOutput']
    args.output.mkdir(mode=0o700, parents=False, exist_ok=False)
    target = args.output / 'receipt.json'
    steps = [{**command, 'status': 'UNRUN'} for command in plan['commandsInSerialOrder']]
    receipt = {'schema': 'current-fixed-v28-cli-paired-frontend-and-seventeen-actual/1', 'status': 'PREFLIGHT_PENDING',
        'sourceRoot': str(root), 'sourceCommit': frozen['sourceCommit'], 'sourceTree': frozen['sourceTree'],
        'startedAt': utc(), 'steps': steps, 'carriedSameSourceCliStrictPassed': 1,
        'vitestCasesPassed': 0, 'jobCasesPassed': 0, 'manifestCasesPassed': 0,
        'plannedVitestCases': 9, 'plannedClosedParserCases': 6, 'plannedGenuineNativeCliCases': 3, 'plannedJobCases': 0, 'plannedManifestCases': 8,
        'carriedNativeCases': 0, 'carriedJobCases': 0, 'carriedHttpCases': 0,
        'runtimeAuthorized': True, 'noHistoricalRuntimeCarry': True, 'notWholeApplicationAcceptance': True,
        'hostNodeFrontendBuildsPlanned': 1, 'CFBuildOwnedSeparately': True, 'DockerBuildOwnedSeparately': True,
        'oldClientAndBackendArtifactsNotCurrent': True,
        'runnerSha256': sha(Path(__file__)), 'sourceInputFreezeSha256': sha(INPUTS)}
    save = lambda: target.write_text(json.dumps(receipt, indent=2) + '\n')
    def source_check():
        git = lambda *argv: subprocess.check_output(['git', *argv], cwd=root, text=True).strip()
        assert git('rev-parse', 'HEAD') == frozen['sourceCommit']
        assert git('rev-parse', 'HEAD^{tree}') == frozen['sourceTree']
        assert not git('status', '--porcelain=v1', '--untracked-files=no')
        assert {name: sha(root/name) for name in frozen['sourceFiles']} == frozen['sourceFiles']
        assert sha(Path(frozen['completeFreeze'])) == frozen['completeFreezeSha256']
        assert sha(Path(frozen['independentSourcePeer']['path'])) == frozen['independentSourcePeer']['sha256']
        strict = frozen['sameSourceActualCliStrict']
        assert sha(Path(strict['receipt'])) == strict['sha256']
        for p,d in frozen['additionalInputPins'].items(): assert sha(Path(p)) == d,p
        for name, item in frozen['sourceEntries'].items():
            path = root/name
            assert path.is_file() and not path.is_symlink()
            assert ('100755' if path.stat().st_mode & 0o111 else '100644') == item['mode']
        actual_client = receipt.get('actualFreshClientReceipt')
        if actual_client:
            original = Path(actual_client['path'])
            assert sha(original) == actual_client['sha256']
            producer = json.loads(original.read_text())
            assert producer['status'] == 'PASS' and producer['sourceCommit'] == frozen['sourceCommit'] and producer['sourceTree'] == frozen['sourceTree']
            assert all(sha(root/item['path']) == item['sha256'] for item in producer['sourceInputs'])
            assert all(sha(Path(producer['directory'])/item['path']) == item['sha256'] for item in producer['artifacts'])
    initial_fixtures = set(Path('/workspace').glob('.node-*')) | set(root.glob('.node-*')) | set(Path(frozen['fixtureParent']).glob('*'))
    handlers = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)}
    def interrupted(number, _frame):
        raise Interrupted(number)
    for number in handlers:
        signal.signal(number, interrupted)
    owned = current = log = None
    began = None
    env = dict(os.environ)
    # Only nonsecret fixture admission inputs; original producer receives no stale receipt or VITE overrides.
    for key in ('NODE_FRESH_CLIENT_RECEIPT', 'NODE_FRESH_CLIENT_RECEIPT_SHA256'):
        env.pop(key, None)
    env.update({'NO_COLOR': '1', 'FORCE_COLOR': '0',
        'NODE_PROTOTYPE_FILESYSTEM_ROOT_OWNER_UID': str(frozen['filesystemRootOwnerUid']),
        'NODE_PROTOTYPE_FIXTURE_PARENT': frozen['fixtureParent'],
        'NODE_V26_UPGRADE_FIXTURE_PARENT': frozen['fixtureParent'],
        'NODE_JOB_PRINCIPAL_FIXTURE_PARENT': frozen['privateJobFixtureDirectory']['path'],
        'NODE_JOB_PRINCIPAL_FILESYSTEM_ROOT_OWNER_UID': str(frozen['filesystemRootOwnerUid']),
        'TMPDIR': frozen['privateTempDirectory']['path'], 'SQLITE_TMPDIR': frozen['privateTempDirectory']['path']})
    env.update(plan['environment'])
    def collect(code):
        if current is None:
            return
        current.update({'exitCode': code, 'endedAt': utc(),
            'seconds': round(time.monotonic()-began, 3) if began is not None else None})
        if log is not None:
            log.flush()
            current['logSha256'] = sha(Path(current['log']))
    try:
        source_check()
        receipt['sameSourceActualCliCompiler'] = frozen['sameSourceActualCliStrict']
        private_temp = Path(frozen['privateTempDirectory']['path'])
        temp_stat = private_temp.lstat()
        assert private_temp.resolve() == private_temp and private_temp.is_dir() and not private_temp.is_symlink()
        assert temp_stat.st_uid == frozen['processOwnerUid'] and temp_stat.st_mode & 0o777 == 0o700
        assert temp_stat.st_dev == frozen['privateTempDirectory']['dev'] and temp_stat.st_ino == frozen['privateTempDirectory']['ino']
        assert not subprocess.check_output(['git', 'status', '--porcelain=v1', '--untracked-files=normal'], cwd=root)
        assert os.lstat('/').st_uid == frozen['filesystemRootOwnerUid'] and os.geteuid() == frozen['processOwnerUid']
        assert (root/'node_modules').is_symlink() and str((root/'node_modules').resolve()) == frozen['dependencyRealPath']
        assert all(sha(Path(path)) == digest for path, digest in frozen['lockedInputHashes'].items())
        assert not (root/'dist-node/client').exists() and not (root/'dist-node/distribution').exists()
        for key in ('privateFixtureDirectory', 'privateJobFixtureDirectory'):
            path = Path(frozen[key]['path']); observed = path.lstat()
            assert path.resolve() == path and path.is_dir() and not path.is_symlink()
            assert observed.st_uid == frozen['processOwnerUid'] and observed.st_mode & 0o7777 == 0o700
            assert observed.st_dev == frozen[key]['dev'] and observed.st_ino == frozen[key]['ino']
        assert not any(name.startswith('VITE_') for name in env)
        assert not list(root.glob('.env*')), 'Current frontend build must have no ambient dotenv inputs'
        receipt['status'] = 'RUNNING'; receipt['explicitNonsecretEnvironment'] = {key: env[key] for key in
            ('NO_COLOR', 'FORCE_COLOR', 'NODE_PROTOTYPE_FILESYSTEM_ROOT_OWNER_UID', 'NODE_PROTOTYPE_FIXTURE_PARENT',
             'NODE_V26_UPGRADE_FIXTURE_PARENT', 'NODE_JOB_PRINCIPAL_FIXTURE_PARENT',
             'NODE_JOB_PRINCIPAL_FILESYSTEM_ROOT_OWNER_UID', 'TMPDIR', 'SQLITE_TMPDIR')}
        save()
        for step in steps:
            source_check()
            current = step
            current.update({'status': 'RUNNING', 'startedAt': utc(), 'log': str(args.output/(step['id']+'.log'))})
            print('START '+step['id'], flush=True); save()
            began = time.monotonic(); log = Path(current['log']).open('x')
            # Same original-handle capture and supported-signal deferral as Gate b623.
            blocked = signal.pthread_sigmask(signal.SIG_BLOCK, set(handlers))
            try:
                owned = subprocess.Popen(step['argv'], cwd=root, env=env, stdout=log,
                    stderr=subprocess.STDOUT, start_new_session=True)
                current['pid'] = current['processGroup'] = owned.pid
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, blocked)
            save(); code = owned.wait(timeout=step['outerStageBudgetSeconds']); collect(code)
            current['completionGroupSnapshot'] = group_snapshot(owned.pid)
            current['normalCompletionHadActiveChildren'] = bool(active(current['completionGroupSnapshot']))
            closure = close_owned_process(owned, current)
            good = code == 0 and not current['normalCompletionHadActiveChildren'] and closure
            if step['category'] in ('genuine-native-composition-fixture', 'genuine-unmounted-job-native-lease-disk'):
                result_path = Path(step['argv'][-1].split('=', 1)[1])
                if result_path.exists():
                    result = json.loads(result_path.read_text())
                    current['resultSha256'] = sha(result_path)
                    current['actualResults'] = {key: result[key] for key in
                        ('numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'success')}
                    current['actualCaseStatuses'] = [item['status'] for suite in result['testResults'] for item in suite['assertionResults']]
                    good = good and result['success'] is True and result['numTotalTests'] == result['numPassedTests'] == step['expectedCases'] and result['numFailedTests'] == result['numPendingTests'] == 0
                else:
                    good = False; current['resultMissing'] = True
            elif step['category'] == 'default-package-http-and-static-assets':
                text = Path(current['log']).read_text(errors='replace')
                text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
                footers = {reporter: re.findall(r'^'+prefix+r' (tests|pass|fail|cancelled|skipped|todo) (\d+)$', text, re.M)
                    for reporter, prefix in (('tap', '#'), ('spec', 'ℹ'))}
                present = [reporter for reporter, entries in footers.items() if entries]
                entries = footers[present[0]] if len(present) == 1 else []
                coherent = len(entries) == 6 and len({key for key, _ in entries}) == 6
                counts = {key: int(value) for key, value in entries} if coherent else {}
                current['actualReporter'] = present[0] if len(present) == 1 else None
                current['actualNodeTestFooterEvidence'] = footers
                current['actualNodeTestSummary'] = counts
                current['actualNodeTestFooterCoherent'] = coherent
                good = good and coherent and counts == {'tests': step['expectedCases'], 'pass': step['expectedCases'], 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}
            elif step['id'] == 'fresh-host-node-client':
                producer_path = args.output/'fresh-client-producer.json'
                if producer_path.exists():
                    producer = json.loads(producer_path.read_text())
                    current['producerReceiptSha256'] = sha(producer_path)
                    current['nestedOriginalBuildGroups'] = {str(item['processGroupId']): group_snapshot(item['processGroupId']) for item in producer['stages'] if item.get('processGroupId')}
                    good = good and producer['status'] == 'PASS' and producer['sourceCommit'] == frozen['sourceCommit'] and producer['sourceTree'] == frozen['sourceTree'] and all(not active(items) for items in current['nestedOriginalBuildGroups'].values())
                    if good:
                        env['NODE_FRESH_CLIENT_RECEIPT'] = str(producer_path)
                        env['NODE_FRESH_CLIENT_RECEIPT_SHA256'] = sha(producer_path)
                        receipt['actualFreshClientReceipt'] = {'path': str(producer_path), 'sha256': sha(producer_path), 'artifacts': producer['artifacts']}
                else:
                    good = False; current['producerReceiptMissing'] = True
            if good and step['id'] == 'current-node-client-map-verifier':
                client = root/'dist-node/client'
                artifacts = []
                for artifact in sorted(client.rglob('*')):
                    assert not artifact.is_symlink()
                    if artifact.is_file():
                        observed = artifact.stat()
                        assert observed.st_nlink == 1 and observed.st_size <= 16777216
                        artifacts.append({'path':str(artifact.relative_to(client)), 'bytes':observed.st_size, 'sha256':sha(artifact)})
                assert artifacts and len(artifacts) <= 8192 and sum(item['bytes'] for item in artifacts) <= 268435456
                assert any(item['path']=='index.html' for item in artifacts) and any(re.fullmatch(r'assets/ProjectMapSurface-[^/]+\.js', item['path']) for item in artifacts)
                frontend_map = json.loads(Path(plan['currentFrontendDeclaredInputMap']['path']).read_text())
                source_check()
                producer = {'kind':'original-owned-current-node-client-build-map-pair/1', 'status':'PASS',
                    'sourceCommit':frozen['sourceCommit'], 'sourceTree':frozen['sourceTree'], 'directory':str(client),
                    'sourceInputs':frontend_map['inputs'], 'artifacts':artifacts,
                    'stages':[{**item,'status':'PASS'} for item in steps if item['id'] in ('current-node-client-build','current-node-client-map-verifier')],
                    'scope':'One actual current Node build/map pair; no copied artifacts or legacy producer retag. Source inputs conservatively declared, not a bitwise Vite reproducibility claim.'}
                producer_path = args.output/'current-client-build-map-pair.json'
                with producer_path.open('x') as original: json.dump(producer,original,indent=2); original.write('\n')
                receipt['actualFreshClientReceipt'] = {'path':str(producer_path),'sha256':sha(producer_path),'artifacts':artifacts}
            source_check()
            current['status'] = 'PASS' if good else 'FAIL'
            if good:
                if step['category'] == 'strict': receipt['strictPassed'] += 1
                elif step['category'] == 'genuine-native-composition-fixture': receipt['vitestCasesPassed'] += step['expectedCases']
                elif step['category'] == 'genuine-unmounted-job-native-lease-disk': receipt['jobCasesPassed'] += step['expectedCases']
                elif step['category'] == 'default-package-http-and-static-assets': receipt['manifestCasesPassed'] += step['expectedCases']
            print('END '+step['id']+' '+current['status']+' exit='+str(code), flush=True)
            save(); log.close(); log = None; owned = None
            if not good:
                receipt['status'] = 'FAIL_STOPPED_FIRST'; return 1
        receipt['status'] = 'PASS'; return 0
    except subprocess.TimeoutExpired as error:
        receipt['status'] = 'OUTER_STAGE_TIMEOUT_STOPPED'; receipt['outerTimeout'] = str(error)
        if current:
            current['status'] = 'OUTER_STAGE_TIMEOUT'; current['outerStageTimedOut'] = True
            current['originalResourceDrainUnproven'] = True
        return 1
    except (Interrupted, KeyboardInterrupt) as error:
        receipt['status'] = 'ABORTED_PARTIAL'; receipt['interruption'] = str(error)
        receipt['interruptedSignal'] = getattr(error, 'number', signal.SIGINT)
        if current: current['status'] = 'ABORTED_PARTIAL'
        return 128+getattr(error, 'number', signal.SIGINT)
    except Exception as error:
        receipt['status'] = 'PREFLIGHT_OR_RUNNER_FAILURE'; receipt['error'] = type(error).__name__+': '+str(error)
        if current and current['status'] == 'RUNNING': current['status'] = 'FAILED_PARTIAL'
        return 1
    finally:
        for number in handlers: signal.signal(number, signal.SIG_IGN)
        if owned is not None and current is not None:
            try: close_owned_process(owned, current)
            except Exception as error:
                current['ownedClosureProven'] = False; current['closureError'] = type(error).__name__+': '+str(error)
                receipt['status'] = 'OWNED_CLOSURE_UNPROVEN'
            collect(owned.returncode)
            current['forcedTerminationForOwnedCleanup'] = bool(current.get('ownedTermSent') or current.get('ownedKillSent'))
            current['directChildReaped'] = owned.returncode is not None
        if log is not None: log.close()
        receipt['endedAt'] = utc(); receipt['remainingUnrunSteps'] = [step['id'] for step in steps if step['status'] == 'UNRUN']
        groups = {step['processGroup'] for step in steps if 'processGroup' in step}
        groups.update(int(group) for step in steps for group in step.get('nestedOriginalBuildGroups', {}))
        producer_step = next((step for step in steps if step['id'] == 'fresh-host-node-client'), None)
        nested_unproven = False
        if producer_step is not None and producer_step['status'] != 'UNRUN':
            try:
                original_receipt = args.output/'fresh-client-producer.json'
                producer = json.loads(original_receipt.read_text())
                stages = producer['stages']
                assert isinstance(stages, list) and len(stages) <= 2 and producer['status'] in ('PASS', 'FAIL')
                if producer_step.get('producerReceiptSha256'):
                    assert sha(original_receipt) == producer_step['producerReceiptSha256']
                for stage in stages:
                    group = stage.get('processGroupId')
                    assert group is None or type(group) is int and group > 0
                    if group is not None: groups.add(group)
                if producer_step['status'] == 'ABORTED_PARTIAL' and not stages:
                    raise ValueError('Interrupted producer did not publish original nested child identity')
                receipt['finalOriginalProducerReceipt'] = {'path': str(original_receipt),
                    'sha256': sha(original_receipt), 'status': producer['status'], 'stages': stages}
            except Exception as error:
                nested_unproven = True
                receipt['producerNestedOwnershipUnproven'] = type(error).__name__+': '+str(error)
        receipt['finalAllOwnedGroupInventory'] = {str(group): group_snapshot(group) for group in groups}
        receipt['noActiveOrUnknownOwnedGroups'] = not nested_unproven and all(not active(items) for items in receipt['finalAllOwnedGroupInventory'].values())
        receipt['retainedNewFixtureRoots'] = sorted(str(path) for path in
            ((set(Path('/workspace').glob('.node-*')) | set(root.glob('.node-*')) | set(Path(frozen['fixtureParent']).glob('*')))-initial_fixtures))
        receipt['noFixtureForceRemoval'] = True
        receipt['retainedCurrentCliTemporaryDirectories'] = sorted(str(path) for path in Path(frozen['privateTempDirectory']['path']).iterdir() if path.is_dir())
        receipt['actualCurrentFrontendPrerequisitePair'] = [step for step in steps if step['id'] in ('current-node-client-build','current-node-client-map-verifier')]
        receipt['hostNodeFrontendBuildsCompleted'] = sum(step['id']=='current-node-client-build' and step['status']=='PASS' for step in steps)
        try:
            source_check(); receipt['finalSourcePinsMatch'] = True
            manifest = Path(frozen['bundleManifest'])
            if manifest.exists():
                value = json.loads(manifest.read_text())
                assert all(sha(manifest.parent/item['path']) == item['sha256'] for item in value['files'])
                receipt['actualCurrentDistributionManifest'] = {'path': str(manifest), 'sha256': sha(manifest), 'value': value}
        except Exception as error:
            receipt['finalSourceOrArtifactInspectionError'] = type(error).__name__+': '+str(error)
            if receipt['status'] == 'PASS': receipt['status'] = 'FINAL_SOURCE_OR_ARTIFACT_UNPROVEN'
        if not receipt['noActiveOrUnknownOwnedGroups']: receipt['status'] = 'OWNED_CLOSURE_UNPROVEN'
        save()
        for number, handler_value in handlers.items(): signal.signal(number, handler_value)
        if receipt['status'] in ('OWNED_CLOSURE_UNPROVEN', 'FINAL_SOURCE_OR_ARTIFACT_UNPROVEN'):
            return 1

if __name__ == '__main__':
    raise SystemExit(main())
