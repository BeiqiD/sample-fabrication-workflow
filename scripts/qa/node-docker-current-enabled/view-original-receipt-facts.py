"""Read exported original receipt facts without printing payloads or credentials."""
import argparse
import hashlib
import json
import os
import re
import stat
from pathlib import Path

CASES = (
    'image-artifact-nonroot-and-daemon-bind',
    'explicit-fresh-bootstrap-and-stopped-inspection',
    'genuine-internal-loopback-auth-and-supported-metadata',
    'live-writer-exclusion-and-original-graceful-stop',
    'same-image-restart-and-recreate-persistence',
    'wrong-installation-private-bind-and-keyring-availability-denials',
    'fresh-trusted-local-profiles-first-ack',
    'explicit-local-file-jobs-optin-boundaries',
    'genuine-native-upload-replay-and-bytes',
    'original-cadence-verified-local-job-move',
    'paused-accepted-job-survives-recreate-and-explicit-resume',
    'disabled-executor-source-and-original-shutdown',
    'populated-original-v25-offline-upgrade-and-current-auth-preservation',
    'enabled-volume-marker-mismatch-denied-before-http',
    'enabled-installation-pin-mismatch-denied-before-http',
    'readonly-state-volume-denied-before-native-runtime',
    'degraded-private-secret-preserves-native-local-file-reads',
)
HEAD = '8d832ba7af5f1554d61f34fe726ffd8b9de46336'
HEX = re.compile(r'[0-9a-f]{64}')
FAILURE_TYPES = frozenset((
    'AssertionError', 'AttributeError', 'BrokenPipeError', 'BufferError',
    'CalledProcessError', 'ChildProcessError', 'ConnectionAbortedError',
    'ConnectionError', 'ConnectionRefusedError', 'ConnectionResetError',
    'EOFError', 'FileExistsError', 'FileNotFoundError', 'IndexError',
    'InterruptedError', 'IsADirectoryError', 'JSONDecodeError', 'KeyError',
    'KeyboardInterrupt', 'MemoryError', 'NotADirectoryError',
    'NotImplementedError', 'OSError', 'OverflowError', 'PermissionError',
    'ProcessLookupError', 'QualificationInterrupted', 'RecursionError',
    'RuntimeError', 'SubprocessError', 'SystemError', 'SystemExit',
    'TimeoutError', 'TimeoutExpired', 'TypeError', 'UnicodeDecodeError',
    'UnicodeEncodeError', 'UnicodeError', 'ValueError', 'ZeroDivisionError',
))
KINDS = (
    'artifact', 'daemon-bind', 'bootstrap', 'initial-inspect', 'main-a',
    'busy-inspect', 'busy-main', 'after-stop-inspect', 'main-b',
    'after-recreate-inspect', 'wrong-installation', 'bad-keyring',
    'after-negative', 'final-inspect', 'missing-bind',
    'enabled-bootstrap','enabled-initial-installation-inspect','enabled-trusted-profile-setup',
    'enabled-initial-state-inspect','enabled-flags-omitted','enabled-file-only','enabled-file-jobs-a',
    'enabled-file-jobs-b','enabled-final-state-inspect',
    'upgrade-original-v25-preparation','upgrade-stopped-original-v25',
    'upgrade-original-cell-preservation','upgrade-current-installation-inspect','upgrade-current-main',
    'enabled-mismatched-volume-marker','enabled-new-wrong-installation',
    'enabled-readonly-state','enabled-degraded-keyring',
)
COMMANDS = {
    'base-cache', 'default-image-build', 'image-inspect', 'inspect',
    'wait-busy-main', 'wait-wrong-installation', 'restart-same-container',
    'missing-bind', 'missing-bind-absence','qa-locked-dependencies','qa-companion-types','qa-companion-build',
} | {prefix + kind for prefix in ('create-', 'attach-', 'start-', 'term-', 'wait-') for kind in KINDS}
COMMANDS |= {'api-' + kind + '-' + phase for kind in KINDS for phase in ('exercise', 'verify', 'unavailable-keyring')}
ENABLED_PHASES=('file-off','file-only','jobs-inert','upload','move','accept-paused','observe-paused','resume-move','disable','keyring-degraded')
COMMANDS |= {'enabled-api-'+kind+'-'+phase for kind in KINDS for phase in ENABLED_PHASES}
COMMANDS.add('api-upgrade-current-main-view')
API_COMMAND_LABEL = 'api-after-negative-verify'
FIXED_API_ACTIONS = frozenset((
    'stdin', 'GET /api/health readiness', 'GET /api/ready',
    'POST /api/auth/login', 'GET /api/storage/configuration/capability',
    'POST /api/samples', 'GET /api/projects', 'POST /api/projects',
    'GET /api/files/fixture', 'POST /api/file-jobs', 'POST /api/auth/logout',
))

def fixed_api_action(value):
    assert type(value) is str
    if value in FIXED_API_ACTIONS:
        return value
    sample = re.fullmatch(r'(GET|PATCH) /api/samples/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', value)
    assert sample is not None
    return sample.group(1) + ' /api/samples/{uuid}'

def read_original(path, limit):
    before = path.lstat()
    assert stat.S_ISREG(before.st_mode) and before.st_size <= limit
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        assert (opened.st_dev, opened.st_ino, opened.st_size) == (before.st_dev, before.st_ino, before.st_size)
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(limit + 1)
        assert len(data) == before.st_size and len(data) <= limit
        after = os.fstat(fd)
        assert (after.st_size, after.st_mtime_ns, after.st_ctime_ns) == (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
        return data
    finally:
        os.close(fd)

def boolean_fields(source, names):
    result = {}
    for name in names:
        if name in source:
            assert type(source[name]) is bool
            result[name] = source[name]
    return result

def integer_fields(source, names):
    result = {}
    for name in names:
        if name in source:
            value = source[name]
            assert value is None or type(value) is int and -2147483648 <= value <= 9007199254740991
            result[name] = value
    return result

def selected_facts(evidence):
    assert evidence.is_absolute() and evidence.resolve() == evidence and not evidence.is_symlink()
    assert evidence.is_dir()
    manifest_bytes = read_original(evidence / 'export-manifest.json', 131072)
    manifest = json.loads(manifest_bytes)
    pin = manifest['files'].get('actual-six/receipt.json')
    assert isinstance(pin, dict) and HEX.fullmatch(pin['sha256'])
    data = read_original(evidence / 'actual-six' / 'receipt.json', 2097152)
    assert len(data) == pin['bytes'] and hashlib.sha256(data).hexdigest() == pin['sha256']
    original = json.loads(data)
    assert original['sourceHead'] == HEAD
    assert original['status'] in ('RUNNING', 'PASS', 'FAIL_STOPPED_FIRST', 'CLOSURE_OR_SOURCE_UNPROVEN')
    cases = original['cases']
    assert len(cases) == 17 and tuple(row['id'] for row in cases) == CASES
    assert all(row['status'] in ('UNRUN', 'RUNNING', 'PASS', 'FAIL') for row in cases)
    commands = original['commands']
    containers = original['containers']
    assert isinstance(commands, list) and len(commands) <= 256
    assert isinstance(containers, list) and len(containers) <= 64
    output = {
        'diagnosticStatus': 'EXACT_EXPORTED_ORIGINAL_FACTS_ONLY',
        'sourceHead': HEAD,
        'originalReceiptSha256': pin['sha256'],
        'exportManifestSha256': hashlib.sha256(manifest_bytes).hexdigest(),
        'originalReceiptBytes': len(data),
        'originalReceiptStatus': original['status'],
        'cases': [{'id': row['id'], 'status': row['status']} for row in cases],
        'commands': [],
        'containers': [],
    }
    if 'failureType' in original:
        assert original['failureType'] in FAILURE_TYPES
        output['failureType'] = original['failureType']
    output.update(boolean_fields(original, (
        'originalImageBuildCompletionAcknowledged', 'imageBuildCompletionUnproven',
        'cliGroupsInactive', 'finalSourceAndContextPinsExact',
        'finalPrivateConfigAndKeyringPinsExact', 'originalCliClosureUnproven',
        'noDockerSIGKILLOrRemoval','newIndependentEnabledInstallationObserved',
        'newLocalNamespacesIndependent','enabledFinalPrivatePinsExact',
        'upgradedActualHttpMetadataVerified','degradedPrivateSecretKeepsActualLocalBytesAvailable',
        'finalUpgradeAndFaultPrivatePinsExact',
    )))
    output.update(integer_fields(original, ('actualCasesPassed', 'imageBuilds')))
    if 'trustedSetupFirstAcks' in original:
        setup = original['trustedSetupFirstAcks']
        assert type(setup) is dict and setup.get('status') == 'PASS'
        selected = boolean_fields(setup, (
            'executorEnabled', 'originalSetupSettled', 'openingFirstCloseAcknowledged',
            'nativeFirstCloseAcknowledged', 'physicalFirstReleaseAcknowledged',
        ))
        selected.update(integer_fields(setup, ('profileCount',)))
        output['originalTrustedSetupFirstAcks'] = selected
    if 'enabledFinalOriginalStoppedState' in original:
        stopped = original['enabledFinalOriginalStoppedState']
        assert type(stopped) is dict and stopped.get('status') == 'PASS' and stopped.get('phase') == 'completed'
        selected = boolean_fields(stopped, (
            'globalIntegrity', 'foreignKeys', 'nativeFirstCloseAcknowledged', 'applicationOrPhysicalCloseClaimed',
        ))
        selected.update(integer_fields(stopped, ('unreleasedSourceCount',)))
        output['originalEnabledFinalStoppedRead'] = selected
    if 'originalPopulatedV25UpgradeFirstAcks' in original:
        prepared = original['originalPopulatedV25UpgradeFirstAcks']
        assert type(prepared) is dict and prepared.get('status') == 'PASS' and prepared.get('checkpoint') == 'portable-runtime/v25'
        selected = boolean_fields(prepared, (
            'realHttpMetadataPopulated', 'noDomainSqlSeed', 'originalBodiesAndWitnessFilesClosed',
            'originalApplicationNativeAndPhysicalFirstAck',
        ))
        selected.update(integer_fields(prepared, ('originalTables',)))
        output['originalHistoricalV25SetupFirstAcks'] = selected
    if 'originalV25PreservationStoppedRead' in original:
        preserved = original['originalV25PreservationStoppedRead']
        assert type(preserved) is dict and preserved.get('status') == 'PASS'
        selected = boolean_fields(preserved, (
            'originalV25CellsAndLedgerPrefixPreserved', 'originalInstallationIdentityPreserved', 'noDomainWrites',
            'privateWitnessFirstCloseAcknowledged', 'originalNativeFirstCloseAcknowledged', 'wholeApplicationPhysicalCloseClaimed',
        ))
        selected.update(integer_fields(preserved, ('originalTables',)))
        output['originalV25PreservationNativeOnlyRead'] = selected
    if 'newStartupDenialCommittedMainPinsExact' in original:
        denied = original['newStartupDenialCommittedMainPinsExact']
        allowed = ('enabled-mismatched-volume-marker', 'enabled-new-wrong-installation', 'enabled-readonly-state')
        assert type(denied) is dict and set(denied) <= set(allowed)
        output['newStartupDenialCommittedMainPinsExact'] = boolean_fields(denied, allowed)
    for command_index, row in enumerate(commands):
        number, separator, label = row['id'].partition('-')
        assert separator and number == str(command_index) and label in COMMANDS
        assert row['status'] in ('RUNNING', 'PASS', 'FAIL', 'FAILED_PARTIAL')
        item = {'id': row['id'], 'status': row['status']}
        item.update(integer_fields(row, ('pid', 'processGroup', 'exitCode')))
        item.update(boolean_fields(row, ('directChildReaped', 'forcedTerminationForOwnedCleanup', 'ownedClosureProven')))
        output['commands'].append(item)
        # A failed constructor/inspect command has no private stdin. Expose
        # its original bounded diagnostic because artifact downloads can fail.
        if row['status'] == 'FAIL' and (label.startswith('create-') or label == 'inspect'):
            relative = 'actual-six/' + row['id'] + '.log'
            failed_pin = manifest['files'][relative]
            raw = read_original(evidence / relative, 2097152)
            assert len(raw) == failed_pin['bytes'] and hashlib.sha256(raw).hexdigest() == failed_pin['sha256']
            lines = raw.decode('utf8', errors='replace').splitlines()
            output.setdefault('originalFailedDaemonDiagnostics', []).append({
                'command': row['id'], 'logSha256': failed_pin['sha256'],
                'logBytes': len(raw), 'originalFirstLines': [line[:1024] for line in lines[:4]],
                'closureStatusUnchanged': True,
            })
    failed_api = [row for row in commands if row['id'].partition('-')[2] == API_COMMAND_LABEL and row['status'] == 'FAIL']
    assert len(failed_api) <= 1
    if failed_api:
        api_command = failed_api[0]['id']
        # Read only this already-recorded command's exported stdout. A PASS
        # client can include persisted domain values and is never decoded here.
        relative = 'actual-six/' + api_command + '.log'
        pin = manifest['files'][relative]
        assert type(pin['bytes']) is int and HEX.fullmatch(pin['sha256'])
        api_bytes = read_original(evidence / relative, 2097152)
        assert len(api_bytes) == pin['bytes'] and hashlib.sha256(api_bytes).hexdigest() == pin['sha256']
        lines = [line for line in api_bytes.decode('utf-8').splitlines() if line.startswith('{')]
        assert len(lines) == 1
        api = json.loads(lines[0])
        assert type(api) is dict and set(api) == {'status', 'action', 'observations'} and api['status'] == 'FAIL'
        observations = api['observations']
        assert type(observations) is list and len(observations) <= 512
        selected = []
        for observation in observations:
            assert type(observation) is dict and set(observation) == {'action', 'status'}
            status = observation['status']
            assert type(status) is int and 100 <= status <= 599 or status == 'unavailable'
            selected.append({'action': fixed_api_action(observation['action']), 'status': status})
        output['originalApiFailure'] = {
            'commandId': api_command, 'status': 'FAIL',
            'originalLogSha256': pin['sha256'], 'originalLogBytes': len(api_bytes),
            'action': fixed_api_action(api['action']), 'observations': selected,
        }
    identifiers = set()
    nonces = set()
    safe_enabled_actions = frozenset((
        'private-input','GET /api/health readiness','GET /api/ready','POST /api/auth/login','POST /api/auth/logout',
        'GET /api/storage/configuration/capability',
        'GET /api/file-assets/:assetId','POST /api/assets','GET /api/r2-upload-requests/:uuid',
        'GET /api/files/migrations/executor','POST /api/files/migrations/executor',
        'GET /api/files/migrations/files','POST /api/files/migrations/plans','POST /api/files/migrations',
        'GET /api/files/migrations','GET /api/files/migrations/:uuid','GET /api/files/migrations/:uuid/items',
        'POST /api/files/migrations/:uuid/resume',
    ))
    enabled_failures=[]
    for row in commands:
        label=row['id'].partition('-')[2]
        if not label.startswith('enabled-api-') or row['status']!='FAIL':continue
        relative='actual-six/'+row['id']+'.log'
        pin=manifest['files'][relative]
        assert type(pin['bytes']) is int and HEX.fullmatch(pin['sha256'])
        raw=read_original(evidence/relative,2097152)
        assert len(raw)==pin['bytes'] and hashlib.sha256(raw).hexdigest()==pin['sha256']
        lines=[line for line in raw.decode('utf8').splitlines() if line.startswith('{')]
        assert len(lines)==1;value=json.loads(lines[0])
        assert type(value) is dict and set(value)=={'status','action','observedStatus','observations','originalBodiesClosureUnproven'}
        assert value['status']=='FAIL' and value['action'] in safe_enabled_actions
        status=value['observedStatus'];assert status is None or type(status) is int and 100<=status<=599
        assert type(value['originalBodiesClosureUnproven']) is bool
        assert type(value['observations']) is list and len(value['observations'])<=1024
        observations=[]
        for observed in value['observations']:
            assert type(observed) is dict and set(observed)=={'action','status'} and observed['action'] in safe_enabled_actions
            code=observed['status'];assert code=='unavailable' or type(code) is int and 100<=code<=599
            observations.append({'action':observed['action'],'status':code})
        enabled_failures.append({'command':row['id'],'action':value['action'],'observedStatus':status,
            'originalBodiesClosureUnproven':value['originalBodiesClosureUnproven'],'observations':observations,
            'originalStdoutSha256':pin['sha256']})
    output['safeOriginalEnabledApiFailures']=enabled_failures
    upgrade_actions = frozenset(('private-input', 'GET /api/health', 'GET /api/ready',
        'POST /api/auth/login', 'POST /api/auth/logout', 'GET /api/samples', 'GET /api/samples/:uuid', 'GET /api/projects'))
    upgrade_failures = [row for row in commands if row['id'].partition('-')[2] == 'api-upgrade-current-main-view' and row['status'] == 'FAIL']
    assert len(upgrade_failures) <= 1
    if upgrade_failures:
        row = upgrade_failures[0]; relative = 'actual-six/' + row['id'] + '.log'; pinned = manifest['files'][relative]
        assert type(pinned['bytes']) is int and HEX.fullmatch(pinned['sha256'])
        raw = read_original(evidence / relative, 2097152)
        assert len(raw) == pinned['bytes'] and hashlib.sha256(raw).hexdigest() == pinned['sha256']
        lines = [line for line in raw.decode('utf8').splitlines() if line.startswith('{')]
        assert len(lines) == 1; value = json.loads(lines[0])
        assert type(value) is dict and set(value) == {'status','action','observedStatus','originalBodyCloseUnproven','observations'}
        assert value['status'] == 'FAIL' and value['action'] in upgrade_actions
        code = value['observedStatus']; assert code is None or type(code) is int and 100 <= code <= 599
        assert type(value['originalBodyCloseUnproven']) is bool
        assert type(value['observations']) is list and len(value['observations']) <= 128
        observations = []
        for observed in value['observations']:
            assert type(observed) is dict and set(observed) == {'action','status'} and observed['action'] in upgrade_actions
            status = observed['status']; assert type(status) is int and 100 <= status <= 599
            observations.append({'action':observed['action'],'status':status})
        output['safeOriginalUpgradeApiFailure'] = {'command':row['id'],'action':value['action'],'observedStatus':code,
            'originalBodyCloseUnproven':value['originalBodyCloseUnproven'],'observations':observations,'originalStdoutSha256':pinned['sha256']}
    for row in containers:
        assert row['kind'] in KINDS
        suffix = 'missing' if row['kind'] == 'missing-bind' else row['kind']
        name = re.fullmatch(r'nodeqa-([0-9a-f]{32})-' + re.escape(suffix), row['name'])
        assert name is not None
        identifiers.add(row['name'])
        nonces.add(name.group(1))
        item = {'kind': row['kind']}
        if row['id'] is not None:
            assert HEX.fullmatch(row['id'])
            item['id'] = row['id']
            identifiers.add(row['id'])
        item.update(integer_fields(row, ('generation',)))
        item.update(boolean_fields(row, ('closeAttempted', 'originalExitObserved', 'expectedAbsent', 'constructionAbsenceObserved', 'newScenarioExpectedStartupDenial')))
        if 'newScenarioClosureScope' in row:
            assert row['newScenarioClosureScope'] == 'terminal-kernel-only; native-and-physical-graceful-ACK-unclaimed'
            item['newScenarioClosureScope'] = row['newScenarioClosureScope']
        if 'lastState' in row:
            state = row['lastState']
            item['lastState'] = boolean_fields(state, ('Running', 'Paused', 'Restarting', 'OOMKilled', 'Dead'))
            item['lastState'].update(integer_fields(state, ('Pid', 'ExitCode')))
        output['containers'].append(item)
    assert len(nonces) <= 1
    if 'containerClosureUnproven' in original:
        values = original['containerClosureUnproven']
        assert isinstance(values, list) and len(values) <= 64
        assert all(type(value) is str and value in identifiers for value in values)
        output['containerClosureUnproven'] = values
    image = manifest['files'].get('actual-six/image.id')
    if image is not None:
        data = read_original(evidence / 'actual-six' / 'image.id', 128)
        assert hashlib.sha256(data).hexdigest() == image['sha256'] and len(data) == image['bytes']
        image_id = data.decode('ascii').strip()
        assert re.fullmatch(r'sha256:[0-9a-f]{64}', image_id)
        output['originalImageId'] = image_id
    encoded = json.dumps(output, sort_keys=True, separators=(',', ':'))
    assert len(encoded.encode()) <= 131072
    return encoded

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', required=True)
    args = parser.parse_args()
    try:
        print(selected_facts(Path(args.evidence)), flush=True)
        return 0
    except Exception as error:
        print(json.dumps({'diagnosticStatus': 'UNAVAILABLE', 'exceptionType': type(error).__name__}), flush=True)
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
