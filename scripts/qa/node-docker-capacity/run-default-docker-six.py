#!/usr/bin/env python3
"""Six genuine reviewed-default Docker cases with explicit current source and offlineV5 bundle; root explicit exclusive GO only.
Use mature b623 Popen ownership. Docker container closure is a separate fact.
"""
import argparse, base64, hashlib, json, os, runpy, secrets, signal, subprocess, time, uuid
from pathlib import Path

ROOT = Path(os.environ['NODE_DOCKER_SIX_ROOT'])
PREP = ROOT/'prepared'
SOURCE = Path(os.environ['NODE_DOCKER_SIX_SOURCE'])
MAP = PREP/'context-map.json'
CONTEXT = ROOT/'context'
OUTPUT = ROOT/'actual-six'
HELPER = PREP/'original-owned-process.py'
HELPER_SHA = 'b623484a36325020644d64479cc41939c20a984a07a1ba585e4be1a17e812889'
BASE = 'sha256:622f209f6c16ba5af4d9a337cae6577d096f17174b904cfc6a5b0c81a2679c24'
HEAD = 'f883e64086bee44b353f3840271fa3eaaafdcc7d'
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--exclusive-go-default-docker-six', action='store_true')
    args = parser.parse_args()
    if not args.exclusive_go_default_docker_six: raise SystemExit('Root exclusive Docker-six GO required')
    assert os.geteuid() == 1000 and sha(HELPER) == HELPER_SHA
    seal = json.loads((PREP/'docker-six-driver-source-seal.json').read_text())
    assert sha(Path(__file__)) == seal['driverSha256'] and sha(PREP/'container-native-api-client.mjs') == seal['clientSha256']
    assert sha(MAP) == seal['contextMapSha256']
    context = json.loads(MAP.read_text()); assert context['sourceHead'] == HEAD
    qualification = seal.get('registryProbeQualification')
    assert isinstance(qualification, dict), 'Actual registry PASS and original closure must be bound before image GO'
    assert sha(qualification['path']) == qualification['sha256']
    registry = json.loads(Path(qualification['path']).read_text())
    assert registry['status'] == 'PASS' and registry['registryProbePassed'] and registry['cliGroupsInactive'] and not registry['containerClosureUnproven']
    assert registry['tlsStrict'] and registry['capacityPrerequisitePassed'] and registry['basePinExact'] and registry['noProxyForwarded']
    assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip() == HEAD
    assert sha(Path(seal['sourceFreeze'])) == seal['sourceFreezeSha256']
    complete = json.loads(Path(seal['sourceFreeze']).read_text())
    def source_check():
        assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=SOURCE,text=True).strip()==HEAD
        context_root=CONTEXT.lstat();assert CONTEXT.resolve()==CONTEXT and context_root.st_uid==1000 and context_root.st_mode&0o7777==0o700
        assert context_root.st_dev==seal['contextRootObservation']['dev'] and context_root.st_ino==seal['contextRootObservation']['ino']
        assert subprocess.check_output(['git','rev-parse','HEAD^{tree}'],cwd=SOURCE,text=True).strip() == seal['sourceTree']
        assert all((SOURCE/p).is_file() and not (SOURCE/p).is_symlink() and sha(SOURCE/p) == v['sha256']
            and ('100755' if (SOURCE/p).stat().st_mode & 0o111 else '100644') == v['mode'] for p,v in complete['files'].items())
        assert all((CONTEXT/p).is_file() and not (CONTEXT/p).is_symlink() and sha(CONTEXT/p) == v['sha256']
            and ('100755' if (CONTEXT/p).stat().st_mode & 0o111 else '100644') == v['mode'] for p,v in context['files'].items())
        assert not any(p.is_symlink() for p in CONTEXT.rglob('*'))
        assert {str(p.relative_to(CONTEXT)) for p in CONTEXT.rglob('*') if p.is_file()} == set(context['files'])
    source_check()
    OUTPUT.mkdir(mode=0o700, exist_ok=False)
    mature = runpy.run_path(str(HELPER)); snapshot, active, close = [mature[n] for n in ('group_snapshot', 'active', 'close_owned_process')]
    case_ids = ('image-artifact-nonroot-and-daemon-bind','explicit-fresh-bootstrap-and-stopped-inspection','genuine-internal-loopback-auth-and-supported-metadata','live-writer-exclusion-and-original-graceful-stop','same-image-restart-and-recreate-persistence','wrong-installation-private-bind-and-keyring-availability-denials')
    receipt = {'status': 'RUNNING', 'sourceHead': HEAD, 'imageBuilds': 0, 'cases': [{'id':name,'status':'UNRUN'} for name in case_ids], 'commands': [],
        'containers': [], 'noHostNetworkNamespaceAssumption': True, 'hostProducerDistinct': True,
        'startedAt':mature['utc'](), 'sourceTree':seal['sourceTree'], 'plannedCases':6,
        'driverSha256':sha(Path(__file__)), 'clientSha256':seal['clientSha256'], 'selectedContextCount':1522}
    save = lambda: (OUTPUT/'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
    docker_environment = dict(os.environ)
    docker_environment.pop('BUILDX_CONFIG', None)
    docker_environment.update(DOCKER_CONFIG=str(PREP/'private-docker-config'), TMPDIR=str(PREP/'private-client-tmp'))
    for key in ('DOCKER_CONFIG', 'TMPDIR'):
        path = Path(docker_environment[key]); observed = path.lstat()
        assert path.resolve() == path and path.is_dir() and not path.is_symlink()
        assert observed.st_uid == 1000 and observed.st_mode & 0o7777 == 0o700
        assert observed.st_dev == seal['privateClientEnvironment'][key]['dev'] and observed.st_ino == seal['privateClientEnvironment'][key]['ino']
    receipt['explicitPrivateClientEnvironment'] = {key:docker_environment[key] for key in ('DOCKER_CONFIG','TMPDIR')}
    assert not any(key in docker_environment for key in ('HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy','NODE_EXTRA_CA_CERTS'))
    receipt['actualRegistryPrerequisite'] = qualification
    receipt['proxyValuesPrinted'] = False
    owned = log = None; current = None; nonce = uuid.uuid4().hex; password = secrets.token_urlsafe(32)
    handlers = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}
    def interrupt(number, _): raise mature['QualificationInterrupted'](number)
    for number in handlers: signal.signal(number, interrupt)
    def settle_cli():
        nonlocal owned, log
        if owned is None: return True
        original = owned
        try: proven = close(original, current)
        except BaseException as error:
            proven = False; current['closureErrorType'] = type(error).__name__
        current.update(exitCode=original.returncode, directChildReaped=original.returncode is not None,
            forcedTerminationForOwnedCleanup=bool(current.get('ownedTermSent') or current.get('ownedKillSent')))
        if log is not None:
            log.flush(); current['logSha256'] = sha(current['log']); log.close(); log = None
        current['ownedClosureProven'] = proven
        if proven: owned = None
        else: receipt['originalCliClosureUnproven'] = True
        save(); return proven
    def one_json_line(text):
        lines = [line for line in text.splitlines() if line.startswith('{')]
        assert len(lines) == 1, 'Exactly one original JSON response required; full raw log retained'
        value = json.loads(lines[0]); assert isinstance(value,dict); return value
    def command(label, argv, expected=0, timeout=30, private_stdin=None):
        nonlocal owned, log, current
        assert owned is None, 'Original CLI custody must settle before another command'
        label = str(len(receipt['commands']))+'-'+label
        current = {'id': label, 'argv': argv, 'status': 'RUNNING', 'log': str(OUTPUT/(label+'.log'))}
        receipt['commands'].append(current); log = Path(current['log']).open('xb'); save()
        blocked = signal.pthread_sigmask(signal.SIG_BLOCK, set(handlers))
        try:
            owned = subprocess.Popen(argv, stdin=subprocess.PIPE if private_stdin is not None else subprocess.DEVNULL,
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True, cwd=CONTEXT, env=docker_environment)
            current['pid'] = current['processGroup'] = owned.pid
        finally: signal.pthread_sigmask(signal.SIG_SETMASK, blocked)
        if private_stdin is not None:
            owned.stdin.write(private_stdin); owned.stdin.close()
        code = owned.wait(timeout=timeout); log.flush()
        current['completionSnapshot'] = snapshot(owned.pid)
        live = bool(active(current['completionSnapshot'])); proven = settle_cli()
        current['status'] = 'PASS' if code == expected and proven and not live and not current['forcedTerminationForOwnedCleanup'] else 'FAIL'
        save()
        assert current['status'] == 'PASS', 'Exact command result/owned closure failed'
        return Path(current['log']).read_text()
    def case(name, run):
        item = next(item for item in receipt['cases'] if item['id']==name); item['status']='RUNNING'; save(); print('START '+name, flush=True)
        run(); item['status'] = 'PASS'; save(); print('END '+name+' PASS', flush=True)
    image = None
    common = ['--pull=never', '--network=none', '--read-only', '--user=1000:1000', '--cap-drop=ALL',
        '--security-opt=no-new-privileges:true', '--pids-limit=64', '--memory=768m', '--cpus=2',
        '--tmpfs=/tmp:rw,size=67108864,mode=0700,uid=1000,gid=1000,noexec,nosuid,nodev']
    def create(name, extra, entry=None, arguments=(), network='none', interactive=False):
        record = {'name': 'nodeqa-'+nonce+'-'+name, 'id': None, 'closeAttempted': False, 'kind': name}
        receipt['containers'].append(record); save() # Name/nonce retained before daemon construction.
        flags = list(common); flags[flags.index('--network=none')] = '--network='+network
        argv = ['docker', 'create', '--name', record['name'], '--label', 'sample.qa.owner='+nonce,
            '--label', 'sample.qa.source='+HEAD, *flags, *extra]
        if interactive: argv += ['--interactive']
        if entry: argv += ['--entrypoint', entry]
        output = command('create-'+name, [*argv, image, *arguments]).strip()
        assert len(output) == 64 and all(c in '0123456789abcdef' for c in output)
        record['id'] = output; save(); return record
    def inspect(record):
        value = json.loads(command('inspect', ['docker', 'inspect', record['id'] or record['name']]))[0]
        assert (record['id'] is None or value['Id'] == record['id']) and value['Config']['Labels']['sample.qa.owner'] == nonce
        assert value['Config']['Labels']['sample.qa.source'] == HEAD
        record['id'] = value['Id']
        record['lastState'] = value['State']; save(); return value['State']
    def attach(record, stdin=None, expected=0):
        text = command('attach-'+record['kind'], ['docker', 'start', '--attach', '--interactive', record['id']], expected=expected, private_stdin=stdin)
        state = inspect(record); assert not state['Running'] and state['Pid'] == 0 and state['ExitCode'] == expected
        record['originalExitObserved'] = True; save(); return text
    def stop(record):
        # First TERM and original wait only; never docker stop's automatic KILL.
        if record['closeAttempted']:
            assert record.get('originalExitObserved') and not inspect(record)['Running']; return
        record['closeAttempted'] = True; save()
        state = inspect(record)
        if state['Running']:
            command('term-'+record['kind'], ['docker', 'kill', '--signal=TERM', record['id']])
            result = command('wait-'+record['kind'], ['docker', 'wait', record['id']], timeout=90).strip()
            assert result == '0', 'Original graceful main first-close ACK failed'
        state = inspect(record); assert not state['Running'] and state['Pid'] == 0 and state['ExitCode'] == 0
        record['originalExitObserved'] = True; save()
    fixture = OUTPUT/'fixture'; state = fixture/'state'; keyring = fixture/'keyring.json'
    config = fixture/'runtime.json'; qa = fixture/'qa'
    def prepare_fixture():
        fixture.mkdir(mode=0o700);state.mkdir(mode=0o700);qa.mkdir(mode=0o700)
        for name in ('application.sqlite', 'application.sqlite.writer-lock'):(state/name).touch(mode=0o600,exist_ok=False)
        keyring.write_text(json.dumps({'version':1,'currentKeyId':'qa-key','keys':{'qa-key':base64.b64encode(secrets.token_bytes(32)).decode()}}));keyring.chmod(0o400)
        (qa/'client.mjs').write_bytes((PREP/'container-native-api-client.mjs').read_bytes());(qa/'client.mjs').chmod(0o400)
    mount = lambda source, target, readonly=False: ['--mount', f'type=bind,source={source},target={target}'+(',readonly' if readonly else '')]
    state_mount = mount(state, '/var/lib/sample/state'); qa_mount = mount(qa, '/run/qa', True)
    origin = 'http://127.0.0.1:14219'; principal = 'container_qualification_admin'; installation = None; persisted = None
    def cli(name, entry, args=(), stdin=None, expected=0, mounts=None):
        record = create(name, state_mount if mounts is None else mounts, entry, args, interactive=stdin is not None)
        return attach(record, stdin, expected)
    def installation_read(name):
        result = one_json_line(cli(name, 'node', ['/opt/sample/server/installation-cli.cjs','inspect','--database','/var/lib/sample/state/application.sqlite']))
        assert set(result) == {'installationId','catalogId','checkpointId'} and result['checkpointId'] == 'portable-runtime/v26'
        if installation: assert result == installation
        return result
    def main_container(name, cfg=config, keys=keyring):
        record = create(name, [*state_mount, *mount(cfg,'/run/sample/runtime.json',True), *mount(keys,'/run/secrets/sample/keyring.json',True), *qa_mount], network='host')
        command('start-'+name, ['docker','start',record['id']]); return record
    def api(record, phase):
        payload = json.dumps({'origin':origin,'username':principal,'password':password,'phase':phase, **({'expected':persisted} if persisted else {})}).encode()
        value = one_json_line(command('api-'+record['kind']+'-'+phase, ['docker','exec','--interactive',record['id'],'node','/run/qa/client.mjs'], timeout=120, private_stdin=payload))
        assert value['status'] == 'PASS'; return value
    try:
        prepare_fixture()
        cached = json.loads(command('base-cache', ['docker','image','inspect',BASE]))[0]
        assert cached['Id'] == BASE and cached['Architecture'] == 'amd64'
        receipt['actualBaseCache'] = {'id':cached['Id'], 'architecture':cached['Architecture'], 'repoDigests':cached['RepoDigests']}
        receipt['imageBuildAttempted']=True;save()
        build_argv = ['docker','build','--pull=false','--progress=plain','--iidfile',str(OUTPUT/'image.id'),'--file','Dockerfile','--tag','sample-workflow-node:restricted-f883e64-ci1',str(CONTEXT)]
        command('default-image-build', build_argv, timeout=600)
        image = (OUTPUT/'image.id').read_text().strip(); assert image.startswith('sha256:') and len(image)==71
        receipt['imageBuilds']=1; receipt['imageId']=image;receipt['originalImageBuildCompletionAcknowledged']=True;save()
        def image_case():
            value=json.loads(command('image-inspect',['docker','image','inspect',image]))[0]; assert value['Id']==image and value['Config']['User']=='1000:1000'
            artifact=one_json_line(cli('artifact','node',['/opt/sample/tools/verify-node-distribution.mjs','/opt/sample','--runtime'],mounts=[]))
            assert artifact['nodeVersion']=='24.19.0' and artifact['capabilityScope']=='restricted-development'
            assert artifact['installationCheckpoint']['id']=='portable-runtime/v26' and artifact['installationCheckpoint']['migrationCount']==24
            receipt['actualImageDistributionReceipt']=artifact
            output=cli('daemon-bind','node',['--input-type=module','-e',"import{statSync}from'node:fs';const base='/var/lib/sample/state';const a=statSync(base);const b=statSync('/');const files=['application.sqlite','application.sqlite.writer-lock'].map(name=>{const s=statSync(base+'/'+name);if(s.uid!==1000||(s.mode&4095)!==384||s.nlink!==1||s.size!==0)process.exit(1);return{name,ino:s.ino,uid:s.uid,mode:s.mode&4095,nlink:s.nlink,size:s.size};});if(a.uid!==1000||(a.mode&4095)!==448||b.uid!==0)process.exit(1);console.log(JSON.stringify({ino:a.ino,uid:a.uid,mode:a.mode&4095,rootUid:b.uid,node:process.version,files}));"])
            receipt['actualDaemonBindObservation']=one_json_line(output)
            observation=receipt['actualDaemonBindObservation'];assert observation['node']=='v24.19.0' and observation['ino']==state.stat().st_ino
            assert all(item['ino']==(state/item['name']).stat().st_ino for item in observation['files'])
            receipt['daemonFixtureUidAndPrivateModeObserved']=True
        case('image-artifact-nonroot-and-daemon-bind',image_case)
        def bootstrap_case():
            nonlocal installation
            cli('bootstrap','node',['/opt/sample/server/identity-cli.cjs','bootstrap','--database','/var/lib/sample/state/application.sqlite','--username',principal],stdin=(password+'\n').encode())
            installation=installation_read('initial-inspect'); receipt['installation']=installation
            config.write_text(json.dumps({'format':'node-loopback-development-v1','dataDirectory':'/var/lib/sample/state','expectedInstallationId':installation['installationId'],'publicOrigin':origin,'clientDirectory':'/opt/sample/client','storageKeyringPath':'/run/secrets/sample/keyring.json'}));config.chmod(0o400)
            receipt['keyringSha256']=sha(keyring); receipt['configSha256']=sha(config)
        case('explicit-fresh-bootstrap-and-stopped-inspection',bootstrap_case)
        first=None
        def auth_case():
            nonlocal first,persisted
            first=main_container('main-a'); persisted=api(first,'exercise')['persisted']; receipt['persistedApiViews']=persisted
            receipt['httpScope']='Actual container-native loopback only; external Codex/daemon namespace reachability unproved.'
        case('genuine-internal-loopback-auth-and-supported-metadata',auth_case)
        def busy_case():
            denied_inspection=cli('busy-inspect','node',['/opt/sample/server/installation-cli.cjs','inspect','--database','/var/lib/sample/state/application.sqlite'],expected=1)
            assert not any(line.startswith('{') for line in denied_inspection.splitlines()), 'Denied inspection must not publish a receipt'
            contender=main_container('busy-main'); command('wait-busy-main',['docker','wait',contender['id']]); assert inspect(contender)['ExitCode']==1
            api(first,'verify'); stop(first); installation_read('after-stop-inspect')
        case('live-writer-exclusion-and-original-graceful-stop',busy_case)
        def restart_case():
            before=inspect(first); assert first['originalExitObserved'] and not before['Running'] and before['Pid']==0 and before['ExitCode']==0
            first.setdefault('priorAcknowledgedLifetimes',[]).append(before)
            first['generation']=first.get('generation',1)+1; first['closeAttempted']=False; first['originalExitObserved']=False
            command('restart-same-container',['docker','start',first['id']]); api(first,'verify'); stop(first)
            recreated=main_container('main-b'); api(recreated,'verify'); stop(recreated); installation_read('after-recreate-inspect')
            assert sha(keyring)==receipt['keyringSha256'] and sha(config)==receipt['configSha256']
        case('same-image-restart-and-recreate-persistence',restart_case)
        def negatives_case():
            wrong=fixture/'wrong-runtime.json';wrong.write_text(config.read_text().replace(installation['installationId'],str(uuid.uuid4())));wrong.chmod(0o400)
            denied=main_container('wrong-installation',cfg=wrong);command('wait-wrong-installation',['docker','wait',denied['id']]);assert inspect(denied)['ExitCode']==1
            bad=fixture/'unavailable-keyring.json';bad.write_text('{"version":99}');bad.chmod(0o400)
            unavailable=main_container('bad-keyring',keys=bad);api(unavailable,'unavailable-keyring');stop(unavailable)
            # Lazy keyring availability fences credentials; it does not deny unrelated main readiness.
            check=main_container('after-negative');api(check,'verify');stop(check);installation_read('final-inspect')
            absent=fixture/'missing-keyring.json';assert not absent.exists()
            missing={'name':'nodeqa-'+nonce+'-missing','id':None,'kind':'missing-bind','closeAttempted':False,'expectedAbsent':True}
            receipt['containers'].append(missing);save()
            command('missing-bind',['docker','create','--name',missing['name'],'--label','sample.qa.owner='+nonce,'--label','sample.qa.source='+HEAD,'--mount',f'type=bind,source={absent},target=/run/secrets/sample/keyring.json',image],expected=1)
            present=command('missing-bind-absence',['docker','ps','--all','--no-trunc','--filter','label=sample.qa.owner='+nonce,'--filter','name='+missing['name'],'--format','{{.ID}}']).strip()
            assert not present and not absent.exists();missing['constructionAbsenceObserved']=True

        case('wrong-installation-private-bind-and-keyring-availability-denials',negatives_case)
        receipt['status']='PASS';return 0
    except BaseException as error:
        receipt['status']='FAIL_STOPPED_FIRST';receipt['failureType']=type(error).__name__
        for item in receipt['cases']:
            if item['status']=='RUNNING':item['status']='FAIL'
        if current and current['status']=='RUNNING':current['status']='FAILED_PARTIAL'
        return 1
    finally:
        for number in handlers: signal.signal(number,signal.SIG_IGN)
        original_closed=settle_cli()
        receipt['containerClosureUnproven']=[]
        # Original daemon owners are separate from the CLI. Never overwrite a live CLI handle.
        for record in receipt['containers']:
            if not original_closed:
                receipt['containerClosureUnproven'].append(record['id'] or record['name']);continue
            try:
                if record.get('expectedAbsent') and record.get('constructionAbsenceObserved'):continue
                observed=inspect(record)
                if observed['Running']:stop(record);observed=inspect(record)
                if observed['Running'] or observed['Pid']!=0:receipt['containerClosureUnproven'].append(record['id'])
            except BaseException:
                receipt['containerClosureUnproven'].append(record['id'] or record['name'])
                original_closed=settle_cli()
        receipt['finalCliGroups']={str(s['processGroup']):snapshot(s['processGroup']) for s in receipt['commands'] if 'processGroup'in s}
        receipt['cliGroupsInactive']=original_closed and all(not active(items) for items in receipt['finalCliGroups'].values())
        try:source_check();receipt['finalSourceAndContextPinsExact']=True
        except BaseException:receipt['finalSourceAndContextPinsExact']=False
        receipt['noDockerSIGKILLOrRemoval']=True;receipt['onlyDockerSignalRequested']='TERM';receipt['containersAndFixturesRetained']=True
        receipt['finalPrivateConfigAndKeyringPinsExact']=('keyringSha256' not in receipt or sha(keyring)==receipt['keyringSha256'] and sha(config)==receipt['configSha256'])
        receipt['imageBuildCompletionUnproven']=bool(receipt.get('imageBuildAttempted') and not receipt.get('originalImageBuildCompletionAcknowledged'))
        if receipt['containerClosureUnproven'] or receipt['imageBuildCompletionUnproven'] or not receipt['cliGroupsInactive'] or not receipt['finalSourceAndContextPinsExact'] or not receipt['finalPrivateConfigAndKeyringPinsExact']:
            receipt['status']='CLOSURE_OR_SOURCE_UNPROVEN'
        receipt['remainingUnrunCases']=[item['id'] for item in receipt['cases'] if item['status']=='UNRUN']
        receipt['actualCasesPassed']=sum(item['status']=='PASS' for item in receipt['cases']);receipt['endedAt']=mature['utc']()
        save();password=None
        for number,handler in handlers.items():signal.signal(number,handler)
        if receipt['status']=='CLOSURE_OR_SOURCE_UNPROVEN':return 1

if __name__=='__main__':raise SystemExit(main())
