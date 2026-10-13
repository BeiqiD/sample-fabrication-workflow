"""Prepare one exact published source/context; no application or Docker execution."""
import argparse, hashlib, json, os, shutil, stat, subprocess, sys
from pathlib import Path

HEAD = '37ae8d08c10382a18b4923884bc4f7f51869b92f'
TREE = '0211bae2f7ed33ffb56dab80396b01580dfdb1db'
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', required=True); p.add_argument('--source', required=True)
    p.add_argument('--invocation-head', required=True)
    args = p.parse_args()
    assert os.geteuid() == os.getegid() == 1000
    root, source = Path(args.root), Path(args.source)
    assets = Path(__file__).resolve().parent
    qa_checkout = assets.parents[2]
    assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=qa_checkout,text=True,timeout=30).strip() == args.invocation_head
    assert root.is_absolute() and root.resolve() == root and not root.is_symlink()
    assert root.lstat().st_uid == 1000 and stat.S_IMODE(root.stat().st_mode) == 0o700
    assert not list(root.iterdir()) and source.resolve() == source and source.stat().st_uid == 1000
    assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True,timeout=30).strip() == HEAD
    assert subprocess.check_output(['git','rev-parse','HEAD^{tree}'],cwd=source,text=True,timeout=30).strip() == TREE
    pins = json.loads((assets/'source-freeze.json').read_text())
    context_map = json.loads((assets/'context-map.json').read_text())
    assert len(pins['files']) == 3628 and len(context_map['files']) == 1656
    inventory = json.loads((assets/'asset-pins.json').read_text())
    for name, expected in inventory.items():
        q = assets/name
        assert q.is_file() and not q.is_symlink() and sha(q) == expected
    for name, expected in pins['files'].items():
        q = source/name
        assert q.is_file() and not q.is_symlink() and sha(q) == expected['sha256']
        assert ('100755' if q.stat().st_mode & 0o111 else '100644') == expected['mode']
        qa_source=qa_checkout/name
        assert qa_source.is_file() and not qa_source.is_symlink() and sha(qa_source)==expected['sha256']
        assert ('100755' if qa_source.stat().st_mode & 0o111 else '100644') == expected['mode']
    inventory_check={str(p.relative_to(assets)) for p in assets.rglob('*') if p.is_file()}
    assert inventory_check==set(inventory)|{'asset-pins.json'}, 'Every current sibling asset must have its actual downstream pin'
    prepared, context = root/'prepared', root/'context'
    prepared.mkdir(mode=0o700); context.mkdir(mode=0o700)
    for name in inventory:
        q = prepared/name; q.parent.mkdir(parents=True, exist_ok=True)
        q.write_bytes((assets/name).read_bytes()); q.chmod(0o644)
    for name, expected in context_map['files'].items():
        q = context/name; q.parent.mkdir(parents=True, exist_ok=True)
        original = assets/'recipes'/name if name in ('Dockerfile','.dockerignore') else source/name
        assert sha(original) == expected['sha256']
        q.write_bytes(original.read_bytes()); q.chmod(int(expected['mode'][-3:],8))
    for name in ('private-docker-config','private-client-tmp'):
        (prepared/name).mkdir(mode=0o700)
    observations = {}
    for key, name in [('DOCKER_CONFIG','private-docker-config'),('TMPDIR','private-client-tmp')]:
        q = prepared/name; s = q.lstat()
        observations[key] = {'dev':s.st_dev,'ino':s.st_ino,'uid':1000,'mode':'0700'}
    c = context.stat()
    seal = {'driverSha256':sha(prepared/'run-default-and-enabled-docker.py'),
        'networkDriverSha256':sha(prepared/'run-ci-network-prerequisite.py'),
        'clientSha256':sha(prepared/'container-native-api-client.mjs'),
        'contextMapSha256':sha(prepared/'context-map.json'),'sourceTree':TREE,
        'sourceFreeze':str(prepared/'source-freeze.json'),
        'sourceFreezeSha256':sha(prepared/'source-freeze.json'),
        'contextRootObservation':{'dev':c.st_dev,'ino':c.st_ino,'uid':1000,'mode':'0700'},
        'privateClientEnvironment':observations,
        'registryProbeQualification':None,'qaSource':str(qa_checkout),'invocationHead':args.invocation_head}
    (prepared/'docker-six-driver-source-seal.json').write_text(json.dumps(seal,indent=2)+'\n')
    tools = {name:{'path':str(Path(shutil.which(name)).resolve()),'sha256':sha(Path(shutil.which(name)).resolve())}
        for name in ('docker','python3','git','node','npm')}
    record = {'status':'SOURCE_PREPARED','invocationHead':args.invocation_head,
        'sourceHead':HEAD,'sourceTree':TREE,'trackedSourceFiles':3628,'contextFiles':1656,
        'allSourceAndContextBytesVerified':True,'uid':os.geteuid(),'gid':os.getegid(),
        'root':str(root),'source':str(source),'tools':tools,'compilerBuildOrApplicationInvocations':0,
        'assetPinsSha256':sha(assets/'asset-pins.json')}
    (root/'platform-source-and-tools.json').write_text(json.dumps(record,indent=2)+'\n')
    for q in [prepared/'docker-six-driver-source-seal.json',root/'platform-source-and-tools.json']:
        q.chmod(0o600)
    print(json.dumps({'status':'SOURCE_PREPARED','sourceHead':HEAD,'invocationHead':args.invocation_head}))

if __name__ == '__main__': main()
