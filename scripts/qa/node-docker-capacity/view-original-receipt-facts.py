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
)
HEAD = 'f883e64086bee44b353f3840271fa3eaaafdcc7d'
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
)
COMMANDS = {
    'base-cache', 'default-image-build', 'image-inspect', 'inspect',
    'wait-busy-main', 'wait-wrong-installation', 'restart-same-container',
    'missing-bind', 'missing-bind-absence',
} | {prefix + kind for prefix in ('create-', 'attach-', 'start-', 'term-', 'wait-') for kind in KINDS}
COMMANDS |= {'api-' + kind + '-' + phase for kind in KINDS for phase in ('exercise', 'verify', 'unavailable-keyring')}

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
    assert len(cases) == 6 and tuple(row['id'] for row in cases) == CASES
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
        'noDockerSIGKILLOrRemoval',
    )))
    output.update(integer_fields(original, ('actualCasesPassed', 'imageBuilds')))
    for command_index, row in enumerate(commands):
        number, separator, label = row['id'].partition('-')
        assert separator and number == str(command_index) and label in COMMANDS
        assert row['status'] in ('RUNNING', 'PASS', 'FAIL', 'FAILED_PARTIAL')
        item = {'id': row['id'], 'status': row['status']}
        item.update(integer_fields(row, ('pid', 'processGroup', 'exitCode')))
        item.update(boolean_fields(row, ('directChildReaped', 'forcedTerminationForOwnedCleanup', 'ownedClosureProven')))
        output['commands'].append(item)
    identifiers = set()
    nonces = set()
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
        item.update(boolean_fields(row, ('closeAttempted', 'originalExitObserved', 'expectedAbsent', 'constructionAbsenceObserved')))
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
