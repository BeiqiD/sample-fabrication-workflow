#!/usr/bin/env python3
"""Six original default plus six enabled-current and five upgrade/fault Docker cases; root explicit exclusive GO only.
Use mature b623 Popen ownership. Docker container closure is a separate fact.
"""
import argparse, base64, hashlib, json, os, resource, runpy, secrets, signal, subprocess, time, uuid
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
HEAD = '19c8ad0d62ea93ab9e253b96db179e23b7eb2e10'
QA = Path(os.environ['NODE_DOCKER_SIX_QA'])
COMPANIONS = ROOT/'qa-companions'
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--exclusive-go-default-docker-six', action='store_true')
    args = parser.parse_args()
    if not args.exclusive_go_default_docker_six: raise SystemExit('Root exclusive Docker-six GO required')
    assert os.geteuid() == 1000 and sha(HELPER) == HELPER_SHA
    seal = json.loads((PREP/'docker-six-driver-source-seal.json').read_text())
    assert sha(Path(__file__)) == seal['driverSha256'] and sha(PREP/'container-native-api-client.mjs') == seal['clientSha256']
    assert sha(MAP) == seal['contextMapSha256']
    platform=json.loads((ROOT/'platform-source-and-tools.json').read_text())
    assert platform['sourceHead']==HEAD and seal['qaSource']==str(QA)
    for tool in ('docker','python3','git','node','npm'):
        observed=platform['tools'][tool]
        assert Path(__import__('shutil').which(tool)).resolve()==Path(observed['path']) and sha(observed['path'])==observed['sha256']
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
        assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=QA,text=True).strip()==seal['invocationHead']
        assert all((QA/p).is_file() and not (QA/p).is_symlink() and sha(QA/p)==v['sha256']
            and ('100755' if (QA/p).stat().st_mode & 0o111 else '100644')==v['mode'] for p,v in complete['files'].items())
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
    case_ids += ('fresh-trusted-local-profiles-first-ack','explicit-local-file-jobs-optin-boundaries','genuine-native-upload-replay-and-bytes','original-cadence-verified-local-job-move','paused-accepted-job-survives-recreate-and-explicit-resume','disabled-executor-source-and-original-shutdown')
    case_ids += ('populated-original-v25-offline-upgrade-and-current-auth-preservation', 'enabled-volume-marker-mismatch-denied-before-http', 'enabled-installation-pin-mismatch-denied-before-http', 'readonly-state-volume-denied-before-native-runtime', 'degraded-private-secret-preserves-native-local-file-reads')
    receipt = {'status': 'RUNNING', 'sourceHead': HEAD, 'imageBuilds': 0, 'cases': [{'id':name,'status':'UNRUN'} for name in case_ids], 'commands': [],
        'containers': [], 'noHostNetworkNamespaceAssumption': True, 'hostProducerDistinct': True,
        'startedAt':mature['utc'](), 'sourceTree':seal['sourceTree'], 'plannedCases':17,
        'driverSha256':sha(Path(__file__)), 'clientSha256':seal['clientSha256'], 'selectedContextCount':1656}
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
    def command(label, argv, expected=0, timeout=30, private_stdin=None, max_log_bytes=None):
        nonlocal owned, log, current
        assert owned is None, 'Original CLI custody must settle before another command'
        label = str(len(receipt['commands']))+'-'+label
        current = {'id': label, 'argv': argv, 'status': 'RUNNING', 'log': str(OUTPUT/(label+'.log'))}
        assert max_log_bytes is None or type(max_log_bytes) is int and max_log_bytes == 2097152
        if max_log_bytes is not None:
            current.update(logByteLimit=max_log_bytes, timeoutSeconds=timeout)
        def bound_log_file():
            # Bound this owned Docker CLI's regular stdout/stderr file only.
            resource.setrlimit(resource.RLIMIT_FSIZE, (max_log_bytes, max_log_bytes))
        receipt['commands'].append(current); log = Path(current['log']).open('xb'); save()
        blocked = signal.pthread_sigmask(signal.SIG_BLOCK, set(handlers))
        try:
            owned = subprocess.Popen(argv, stdin=subprocess.PIPE if private_stdin is not None else subprocess.DEVNULL,
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True, cwd=CONTEXT, env=docker_environment,
                preexec_fn=bound_log_file if max_log_bytes is not None else None)
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
        qa_npm_cache = Path(docker_environment['TMPDIR'])/'qa-npm-cache'
        qa_npm_cache.mkdir(mode=0o700, exist_ok=False)
        cache_stat = qa_npm_cache.lstat()
        assert qa_npm_cache.resolve() == qa_npm_cache and not qa_npm_cache.is_symlink()
        assert cache_stat.st_uid == 1000 and cache_stat.st_mode & 0o7777 == 0o700
        receipt['privateQaNpmCache'] = {'path':str(qa_npm_cache),'dev':cache_stat.st_dev,'ino':cache_stat.st_ino,'uid':cache_stat.st_uid,'mode':cache_stat.st_mode & 0o7777};save()
        # npm rejects loading one config path as both user and global source.
        # Keep both inputs empty and private, with distinct fresh identities.
        qa_user_config = qa_npm_cache/'empty-user.npmrc'
        qa_global_config = qa_npm_cache/'empty-global.npmrc'
        for qa_config_path in (qa_user_config, qa_global_config):
            fd = os.open(qa_config_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(fd)
        command('qa-locked-dependencies',['npm','ci','--no-audit','--no-fund','--prefix',str(QA),'--cache',str(qa_npm_cache),'--userconfig='+str(qa_user_config),'--globalconfig='+str(qa_global_config),'--strict-ssl=true','--registry=https://registry.npmjs.org'],timeout=180)
        command('qa-companion-types',['node',str(QA/'node_modules/typescript/bin/tsc'),'--noEmit','-p',str(QA/'scripts/qa/node-docker-current-enabled/tsconfig.qa-companions.json')],timeout=90)
        produced=one_json_line(command('qa-companion-build',['node',str(PREP/'bundle-companions.mjs'),'--qa',str(QA),'--source',str(SOURCE),'--output',str(COMPANIONS)],timeout=90))
        assert produced['status']=='PASS' and produced['qaArtifacts']==6 and produced['productExecutableAdditions']==0 and produced['targetHead']==HEAD
        receipt['separateQaCompanionBundles']=1;receipt['separateFrontendBuilds']=0;save()
        prepare_fixture()
        cached = json.loads(command('base-cache', ['docker','image','inspect',BASE]))[0]
        assert cached['Id'] == BASE and cached['Architecture'] == 'amd64'
        receipt['actualBaseCache'] = {'id':cached['Id'], 'architecture':cached['Architecture'], 'repoDigests':cached['RepoDigests']}
        receipt['imageBuildAttempted']=True;save()
        build_argv = ['docker','build','--pull=false','--progress=plain','--iidfile',str(OUTPUT/'image.id'),'--file','Dockerfile','--tag','sample-workflow-node:current87a6-rt6-compat-ci1',str(CONTEXT)]
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
            # Five original same-account clients have already logged in. The
            # genuine runtime permits five attempts per60s, including successes.
            # Wait one fixed61s BEFORE the sixth call; no denied-login retry,
            # throttle mutation or product policy change is permitted.
            time.sleep(61)
            check=main_container('after-negative');api(check,'verify');stop(check);installation_read('final-inspect')
            absent=fixture/'missing-keyring.json';assert not absent.exists()
            missing={'name':'nodeqa-'+nonce+'-missing','id':None,'kind':'missing-bind','closeAttempted':False,'expectedAbsent':True}
            receipt['containers'].append(missing);save()
            command('missing-bind',['docker','create','--name',missing['name'],'--label','sample.qa.owner='+nonce,'--label','sample.qa.source='+HEAD,'--mount',f'type=bind,source={absent},target=/run/secrets/sample/keyring.json',image],expected=1)
            present=command('missing-bind-absence',['docker','ps','--all','--no-trunc','--filter','label=sample.qa.owner='+nonce,'--filter','name='+missing['name'],'--format','{{.ID}}']).strip()
            assert not present and not absent.exists();missing['constructionAbsenceObserved']=True

        case('wrong-installation-private-bind-and-keyring-availability-denials',negatives_case)
        enabled_fixture=fixture/'enabled-local'
        enabled_state=enabled_fixture/'state';enabled_qa=enabled_fixture/'qa';enabled_private=enabled_fixture/'private-qa-state'
        enabled_keyring=enabled_fixture/'keyring.json';enabled_configs={};enabled_volumes=[];enabled_profile_ids=[]
        enabled_origin='http://127.0.0.1:14221';enabled_principal='current_local_runtime_admin';enabled_installation=None;enabled_live=None
        enabled_pins={}
        def enabled_mounts(cfg=None):
            result=[*mount(enabled_state,'/var/lib/sample/state'),*mount(enabled_qa,'/run/qa',True),
                *mount(enabled_private,'/run/qa-state'),*mount(enabled_keyring,'/run/secrets/sample/keyring.json',True)]
            for index,volume in enumerate(enabled_volumes):result += mount(volume['root'],'/var/lib/sample/volumes/'+str(index+1))
            if cfg is not None:result += mount(cfg,'/run/sample/runtime.json',True)
            return result
        def enabled_tool(name,entry,args=(),stdin=None,cfg=None):
            record=create(name,enabled_mounts(cfg),entry,args,interactive=stdin is not None)
            return one_json_line(attach(record,stdin))
        def enabled_main(name,variant):
            record=create(name,enabled_mounts(enabled_configs[variant]),network='host')
            command('start-'+name,['docker','start',record['id']]);return record
        def enabled_api(record,phase,timeout=120):
            payload=json.dumps({'origin':enabled_origin,'username':enabled_principal,'password':password,
                'phase':phase,'profileIds':enabled_profile_ids}).encode()
            value=one_json_line(command('enabled-api-'+record['kind']+'-'+phase,
                ['docker','exec','--interactive',record['id'],'node','/run/qa/container-enabled-api-client.cjs'],
                timeout=timeout,private_stdin=payload))
            assert value['status']=='PASS' and value['phase']==phase
            assert value['originalBodiesSettled'] and value['firstBodyReleaseAcknowledged']
            expected_operations={'file-off':0,'file-only':0,'jobs-inert':0,'upload':1,'move':2,
                'accept-paused':2,'observe-paused':1,'resume-move':1,'disable':1,'keyring-degraded':1}[phase]
            assert value['privateStateOperations']==expected_operations
            assert value['privateStateFirstCloseAcknowledged']==(expected_operations>0)
            return value
        def fresh_enabled_case():
            nonlocal enabled_installation
            enabled_fixture.mkdir(mode=0o700);enabled_state.mkdir(mode=0o700);enabled_qa.mkdir(mode=0o700);enabled_private.mkdir(mode=0o700)
            for name in ('application.sqlite','application.sqlite.writer-lock'):(enabled_state/name).touch(mode=0o600,exist_ok=False)
            enabled_keyring.write_text(json.dumps({'version':1,'currentKeyId':'enabled-qa-key',
                'keys':{'enabled-qa-key':base64.b64encode(secrets.token_bytes(32)).decode()}}));enabled_keyring.chmod(0o400)
            qa_manifest=json.loads((COMPANIONS/'manifest.json').read_text())
            assert qa_manifest['targetSourceHead']==HEAD and qa_manifest['packagedProductExecutableAdditions']==0
            assert sha(COMPANIONS/'source-inputs.json')==qa_manifest['sourceInputsSha256']
            for item in qa_manifest['artifacts']:
                assert item['path'] in ('trusted-local-file-setup.cjs','inspect-local-file-state.cjs','container-enabled-api-client.cjs','prepare-populated-v25.cjs','inspect-upgrade-preservation.cjs','container-upgrade-api-client.cjs')
                assert sha(COMPANIONS/item['path'])==item['sha256']
                q=enabled_qa/item['path'];q.write_bytes((COMPANIONS/item['path']).read_bytes());q.chmod(0o400)
            descriptors=[]
            for index in range(2):
                volume_root=enabled_fixture/('volume-'+str(index+1));volume_root.mkdir(mode=0o700)
                for child in ('objects','staging'):(volume_root/child).mkdir(mode=0o700)
                namespace={'kind':'local-volume','volumeId':str(uuid.uuid4()),'rootId':str(uuid.uuid4()),'namespaceRevision':1}
                profile='storage-profile:local:'+hashlib.sha256(json.dumps(namespace,separators=(',',':')).encode()).hexdigest()
                marker={'format':'local-byte-namespace-v1','namespace':{'volumeId':namespace['volumeId'],'rootId':namespace['rootId'],'profileId':profile,'namespaceRevision':1}}
                path=volume_root/'namespace.json';path.write_text(json.dumps(marker));path.chmod(0o600)
                enabled_volumes.append({'root':volume_root,'marker':path});enabled_profile_ids.append(profile)
                descriptors.append({'id':str(uuid.uuid4()),'root':'/var/lib/sample/volumes/'+str(index+1),
                    'rootBindingId':str(uuid.uuid4()),'namespace':namespace})
            bootstrap=create('enabled-bootstrap',enabled_mounts(),entry='node',arguments=[
                '/opt/sample/server/identity-cli.cjs','bootstrap','--database','/var/lib/sample/state/application.sqlite','--username',enabled_principal],interactive=True)
            attach(bootstrap,(password+'\n').encode())
            enabled_installation=enabled_tool('enabled-initial-installation-inspect','node',[
                '/opt/sample/server/installation-cli.cjs','inspect','--database','/var/lib/sample/state/application.sqlite'])
            assert enabled_installation['checkpointId']=='portable-runtime/v26'
            assert enabled_installation['installationId']!=installation['installationId']
            common_config={'format':'node-loopback-development-v1','dataDirectory':'/var/lib/sample/state',
                'expectedInstallationId':enabled_installation['installationId'],'publicOrigin':enabled_origin,
                'clientDirectory':'/opt/sample/client','storageKeyringPath':'/run/secrets/sample/keyring.json','localVolumes':descriptors}
            for variant,flags in [('omitted',{}),('file-only',{'enableLocalFile':True,'enableLocalJobs':False}),
                ('file-jobs',{'enableLocalFile':True,'enableLocalJobs':True})]:
                cfg=enabled_fixture/(variant+'-runtime.json');cfg.write_text(json.dumps({**common_config,**flags}));cfg.chmod(0o400)
                enabled_configs[variant]=cfg;enabled_pins[str(cfg)]=sha(cfg)
            enabled_pins[str(enabled_keyring)]=sha(enabled_keyring)
            for volume in enabled_volumes:enabled_pins[str(volume['marker'])]=sha(volume['marker'])
            setup=enabled_tool('enabled-trusted-profile-setup','node',['/run/qa/trusted-local-file-setup.cjs'],
                stdin=json.dumps({'configuration':'/run/sample/runtime.json','username':enabled_principal,'password':password}).encode(),cfg=enabled_configs['file-only'])
            assert setup=={'status':'PASS','profileCount':2,'executorEnabled':False,'originalSetupSettled':True,
                'openingFirstCloseAcknowledged':True,'nativeFirstCloseAcknowledged':True,'physicalFirstReleaseAcknowledged':True}
            checked=enabled_tool('enabled-initial-state-inspect','node',['/run/qa/inspect-local-file-state.cjs'],
                stdin=json.dumps({'database':'/var/lib/sample/state/application.sqlite','phase':'initialized'}).encode())
            assert checked['status']=='PASS' and checked['nativeFirstCloseAcknowledged'] and not checked['applicationOrPhysicalCloseClaimed']
            receipt['newIndependentEnabledInstallationObserved']=True;receipt['trustedSetupFirstAcks']=setup
            receipt['newLocalNamespacesIndependent']=True;receipt['enabledPrivatePins']=enabled_pins;save()
        case('fresh-trusted-local-profiles-first-ack',fresh_enabled_case)
        def optin_case():
            nonlocal enabled_live
            record=enabled_main('enabled-flags-omitted','omitted');enabled_api(record,'file-off');stop(record)
            record=enabled_main('enabled-file-only','file-only');enabled_api(record,'file-only');stop(record)
            enabled_live=enabled_main('enabled-file-jobs-a','file-jobs');enabled_api(enabled_live,'jobs-inert')
        case('explicit-local-file-jobs-optin-boundaries',optin_case)
        case('genuine-native-upload-replay-and-bytes',lambda:enabled_api(enabled_live,'upload'))
        def move_case():
            # Setup login + three flag clients + upload used the actual five-attempt window.
            # Wait BEFORE a new sixth login. No 401 retry or bucket/policy mutation.
            time.sleep(61)
            enabled_api(enabled_live,'move',timeout=180)
        case('original-cadence-verified-local-job-move',move_case)
        def paused_restart_case():
            nonlocal enabled_live
            enabled_api(enabled_live,'accept-paused');stop(enabled_live)
            enabled_live=enabled_main('enabled-file-jobs-b','file-jobs')
            enabled_api(enabled_live,'observe-paused',timeout=180)
            enabled_api(enabled_live,'resume-move',timeout=180)
        case('paused-accepted-job-survives-recreate-and-explicit-resume',paused_restart_case)
        def disabled_shutdown_case():
            enabled_api(enabled_live,'disable');stop(enabled_live)
            checked=enabled_tool('enabled-final-state-inspect','node',['/run/qa/inspect-local-file-state.cjs'],
                stdin=json.dumps({'database':'/var/lib/sample/state/application.sqlite','phase':'completed'}).encode())
            assert checked['status']=='PASS' and checked['unreleasedSourceCount']==0 and checked['nativeFirstCloseAcknowledged']
            assert all(sha(path)==expected for path,expected in enabled_pins.items())
            receipt['enabledFinalOriginalStoppedState']=checked;receipt['enabledFinalPrivatePinsExact']=True;save()
        case('disabled-executor-source-and-original-shutdown',disabled_shutdown_case)
        # New independent historical installation; never repair/replace A or B.
        upgrade_fixture=OUTPUT/'upgrade-v25-fixture';upgrade_state=upgrade_fixture/'state';upgrade_qa=upgrade_fixture/'qa'
        upgrade_keyring=upgrade_fixture/'keyring.json';upgrade_config=upgrade_fixture/'runtime.json';upgrade_pins={}
        upgrade_principal='historical_upgrade_admin';upgrade_origin='http://127.0.0.1:14227'
        def upgrade_mounts(cfg=None):
            result=[*mount(upgrade_state,'/var/lib/sample/state'),*mount(upgrade_qa,'/run/qa',True),
                *mount(upgrade_keyring,'/run/secrets/sample/keyring.json',True)]
            if cfg is not None:result += mount(cfg,'/run/sample/runtime.json',True)
            return result
        def populated_upgrade_case():
            upgrade_fixture.mkdir(mode=0o700);upgrade_state.mkdir(mode=0o700);upgrade_qa.mkdir(mode=0o700)
            for name in ('application.sqlite','application.sqlite.writer-lock'):(upgrade_state/name).touch(mode=0o600,exist_ok=False)
            upgrade_keyring.write_text(json.dumps({'version':1,'currentKeyId':'upgrade-qa-key',
                'keys':{'upgrade-qa-key':base64.b64encode(secrets.token_bytes(32)).decode()}}));upgrade_keyring.chmod(0o400)
            manifest=json.loads((COMPANIONS/'manifest.json').read_text())
            for item in manifest['artifacts']:
                assert sha(COMPANIONS/item['path'])==item['sha256']
                if item['path'] in ('prepare-populated-v25.cjs','inspect-upgrade-preservation.cjs','container-upgrade-api-client.cjs'):
                    target=upgrade_qa/item['path'];target.write_bytes((COMPANIONS/item['path']).read_bytes());target.chmod(0o400)
            original=create('upgrade-original-v25-preparation',upgrade_mounts(),entry='node',
                arguments=['/run/qa/prepare-populated-v25.cjs'],network='host',interactive=True)
            raw=command('attach-upgrade-original-v25-preparation',['docker','start','--attach','--interactive',original['id']],
                timeout=120,private_stdin=json.dumps({'username':upgrade_principal,'password':password}).encode())
            terminal=inspect(original);assert not terminal['Running'] and terminal['Pid']==0 and terminal['ExitCode']==0
            original['originalExitObserved']=True
            prepared=one_json_line(raw)
            assert prepared['status']=='PASS' and prepared['checkpoint']=='portable-runtime/v25'
            assert prepared['realHttpMetadataPopulated'] and prepared['noDomainSqlSeed']
            assert prepared['originalBodiesAndWitnessFilesClosed'] and prepared['originalApplicationNativeAndPhysicalFirstAck']
            assert 100<prepared['originalTables']<256
            upgraded=cli('upgrade-stopped-original-v25','node',[
                '/opt/sample/server/installation-cli.cjs','upgrade','--database','/var/lib/sample/state/application.sqlite'],mounts=upgrade_mounts())
            assert upgraded.strip()=='Offline installation upgrade completed.'
            verified=one_json_line(cli('upgrade-original-cell-preservation','node',[
                '/run/qa/inspect-upgrade-preservation.cjs'],mounts=upgrade_mounts()))
            assert verified['status']=='PASS' and verified['originalTables']==prepared['originalTables']
            assert verified['originalV25CellsAndLedgerPrefixPreserved'] and verified['originalInstallationIdentityPreserved']
            assert verified['noDomainWrites'] and verified['privateWitnessFirstCloseAcknowledged'] and verified['originalNativeFirstCloseAcknowledged']
            assert not verified['wholeApplicationPhysicalCloseClaimed']
            installation_c=one_json_line(cli('upgrade-current-installation-inspect','node',[
                '/opt/sample/server/installation-cli.cjs','inspect','--database','/var/lib/sample/state/application.sqlite'],mounts=upgrade_mounts()))
            assert installation_c['checkpointId']=='portable-runtime/v26'
            assert installation_c['installationId'] not in (installation['installationId'],enabled_installation['installationId'])
            upgrade_config.write_text(json.dumps({'format':'node-loopback-development-v1','dataDirectory':'/var/lib/sample/state',
                'expectedInstallationId':installation_c['installationId'],'publicOrigin':upgrade_origin,
                'clientDirectory':'/opt/sample/client','storageKeyringPath':'/run/secrets/sample/keyring.json'}));upgrade_config.chmod(0o400)
            for path in (upgrade_config,upgrade_keyring,upgrade_state/'.qa-original-v25-preservation.json'):upgrade_pins[str(path)]=sha(path)
            live=create('upgrade-current-main',upgrade_mounts(upgrade_config),network='host')
            command('start-upgrade-current-main',['docker','start',live['id']])
            view=one_json_line(command('api-upgrade-current-main-view',['docker','exec','--interactive',live['id'],
                'node','/run/qa/container-upgrade-api-client.cjs'],timeout=120,
                private_stdin=json.dumps({'origin':upgrade_origin,'username':upgrade_principal,'password':password}).encode()))
            assert view['status']=='PASS' and view['originalMetadataAuthenticated'] and view['sampleOriginalView'] and view['projectOriginalView']
            assert view['originalBodiesSettled'] and view['firstBodyReleaseAcknowledged']
            stop(live);receipt['originalPopulatedV25UpgradeFirstAcks']=prepared;receipt['originalV25PreservationStoppedRead']=verified
            receipt['upgradedActualHttpMetadataVerified']=True;receipt['upgradePrivatePins']=upgrade_pins;save()
        case('populated-original-v25-offline-upgrade-and-current-auth-preservation',populated_upgrade_case)
        fault_pins={}
        receipt['newFaultInputPins']=fault_pins;save()
        def startup_denial(name,cfg,mounts):
            before=sha(enabled_state/'application.sqlite')
            record=create(name,mounts,network='host');record['newScenarioExpectedStartupDenial']=True;save()
            command('start-'+name,['docker','start',record['id']])
            value=command('wait-'+name,['docker','wait',record['id']],timeout=90).strip();assert value=='1'
            observed=inspect(record);assert not observed['Running'] and observed['Pid']==0 and observed['ExitCode']==1
            record['originalExitObserved']=True;record['newScenarioClosureScope']='terminal-kernel-only; native-and-physical-graceful-ACK-unclaimed'
            assert sha(enabled_state/'application.sqlite')==before
            receipt.setdefault('newStartupDenialCommittedMainPinsExact',{})[name]=True;save()
        def volume_mismatch_case():
            cfg=enabled_fixture/'mismatched-marker-runtime.json';raw=json.loads(enabled_configs['file-jobs'].read_text())
            twin=enabled_fixture/'mismatched-marker-volume';twin.mkdir(mode=0o700)
            for child in ('objects','staging'):(twin/child).mkdir(mode=0o700)
            actual_namespace={'kind':'local-volume','volumeId':str(uuid.uuid4()),'rootId':str(uuid.uuid4()),'namespaceRevision':1}
            actual_profile='storage-profile:local:'+hashlib.sha256(json.dumps(actual_namespace,separators=(',',':')).encode()).hexdigest()
            marker=twin/'namespace.json';marker.write_text(json.dumps({'format':'local-byte-namespace-v1','namespace':{
                'volumeId':actual_namespace['volumeId'],'rootId':actual_namespace['rootId'],'profileId':actual_profile,'namespaceRevision':1}}));marker.chmod(0o600)
            # Config keeps its authentic B namespace, while the separate physical marker is genuinely different.
            cfg.write_text(json.dumps(raw));cfg.chmod(0o400)
            mounts=enabled_mounts(cfg)
            original_mount=mount(enabled_volumes[0]['root'],'/var/lib/sample/volumes/1')[1]
            replacement_mount=mount(twin,'/var/lib/sample/volumes/1')[1]
            assert mounts.count(original_mount)==1;mounts=[replacement_mount if value==original_mount else value for value in mounts]
            fault_pins[str(cfg)]=sha(cfg);fault_pins[str(marker)]=sha(marker)
            startup_denial('enabled-mismatched-volume-marker',cfg,mounts)
        case('enabled-volume-marker-mismatch-denied-before-http',volume_mismatch_case)
        def installation_mismatch_case():
            cfg=enabled_fixture/'new-wrong-installation-runtime.json';raw=json.loads(enabled_configs['file-jobs'].read_text())
            raw['expectedInstallationId']=str(uuid.uuid4());assert raw['expectedInstallationId']!=enabled_installation['installationId']
            cfg.write_text(json.dumps(raw));cfg.chmod(0o400);fault_pins[str(cfg)]=sha(cfg)
            startup_denial('enabled-new-wrong-installation',cfg,enabled_mounts(cfg))
        case('enabled-installation-pin-mismatch-denied-before-http',installation_mismatch_case)
        def readonly_state_case():
            cfg=enabled_configs['file-jobs'];mounts=enabled_mounts(cfg)
            original_mount=mount(enabled_state,'/var/lib/sample/state')[1];replacement_mount=mount(enabled_state,'/var/lib/sample/state',True)[1]
            assert mounts.count(original_mount)==1;mounts=[replacement_mount if value==original_mount else value for value in mounts]
            startup_denial('enabled-readonly-state',cfg,mounts)
        case('readonly-state-volume-denied-before-native-runtime',readonly_state_case)
        def degraded_secret_case():
            bad=enabled_fixture/'new-malformed-private-keyring.json';bad.write_text('{');bad.chmod(0o400)
            mounts=enabled_mounts(enabled_configs['file-jobs'])
            original_mount=mount(enabled_keyring,'/run/secrets/sample/keyring.json',True)[1]
            replacement_mount=mount(bad,'/run/secrets/sample/keyring.json',True)[1]
            assert mounts.count(original_mount)==1;mounts=[replacement_mount if value==original_mount else value for value in mounts]
            fault_pins[str(bad)]=sha(bad)
            live=create('enabled-degraded-keyring',mounts,network='host');command('start-enabled-degraded-keyring',['docker','start',live['id']])
            enabled_api(live,'keyring-degraded');stop(live)
            receipt['degradedPrivateSecretKeepsActualLocalBytesAvailable']=True
            receipt['newFaultInputPins']=fault_pins;assert all(sha(path)==expected for path,expected in fault_pins.items());save()
        case('degraded-private-secret-preserves-native-local-file-reads',degraded_secret_case)
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
        # Main A was started detached. Read its original daemon log only after
        # the first failure and original normal TERM/wait/stop acknowledgment.
        # This command uses the same owned CLI custody; it never starts/attaches
        # a server, retries a close, follows logs, or overwrites the first failure.
        enabled_a=[record for record in receipt['containers'] if record['kind']=='enabled-file-jobs-a']
        assert len(enabled_a)<=1
        if receipt['status']=='FAIL_STOPPED_FIRST' and enabled_a:
            record=enabled_a[0];observed=record.get('lastState',{})
            stopped=bool(original_closed and record.get('closeAttempted') and record.get('originalExitObserved')
                and observed.get('Running') is False and observed.get('Pid')==0 and observed.get('ExitCode')==0
                and record['id'] not in receipt['containerClosureUnproven'])
            diagnostic={'kind':'enabled-file-jobs-a','containerId':record['id'],'status':'UNAVAILABLE',
                'commandId':None,'tailLines':64,'byteLimit':2097152,'normalStopAcknowledged':stopped,
                'logSha256':None,'logBytes':None,'unavailableReason':'original_stop_unproven'}
            receipt['originalStoppedEnabledServerLog']=diagnostic;save()
            if stopped:
                diagnostic.update(status='RUNNING',unavailableReason=None,
                    commandId=str(len(receipt['commands']))+'-logs-enabled-file-jobs-a');save()
                try:
                    command('logs-enabled-file-jobs-a',['docker','logs','--tail','64',record['id']],
                        timeout=30,max_log_bytes=2097152)
                    captured=current
                    diagnostic.update(status='PASS',logSha256=captured['logSha256'],
                        logBytes=Path(captured['log']).stat().st_size)
                    assert diagnostic['logBytes']<=diagnostic['byteLimit']
                except BaseException:
                    if current and current['id']==diagnostic['commandId'] and current['status']=='RUNNING':
                        current['status']='FAILED_PARTIAL'
                    original_closed=settle_cli()
                    diagnostic.update(status='UNAVAILABLE',unavailableReason='logs_command_unavailable',
                        logSha256=None,logBytes=None)
                save()
        receipt['finalCliGroups']={str(s['processGroup']):snapshot(s['processGroup']) for s in receipt['commands'] if 'processGroup'in s}
        receipt['cliGroupsInactive']=original_closed and all(not active(items) for items in receipt['finalCliGroups'].values())
        try:source_check();receipt['finalSourceAndContextPinsExact']=True
        except BaseException:receipt['finalSourceAndContextPinsExact']=False
        receipt['noDockerSIGKILLOrRemoval']=True;receipt['onlyDockerSignalRequested']='TERM';receipt['containersAndFixturesRetained']=True
        receipt['finalPrivateConfigAndKeyringPinsExact']=('keyringSha256' not in receipt or sha(keyring)==receipt['keyringSha256'] and sha(config)==receipt['configSha256'])
        receipt['imageBuildCompletionUnproven']=bool(receipt.get('imageBuildAttempted') and not receipt.get('originalImageBuildCompletionAcknowledged'))
        if receipt['containerClosureUnproven'] or receipt['imageBuildCompletionUnproven'] or not receipt['cliGroupsInactive'] or not receipt['finalSourceAndContextPinsExact'] or not receipt['finalPrivateConfigAndKeyringPinsExact']:
            receipt['status']='CLOSURE_OR_SOURCE_UNPROVEN'
        if receipt.get('enabledPrivatePins'):
            receipt['enabledFinalPrivatePinsExact']=all(sha(path)==expected for path,expected in receipt['enabledPrivatePins'].items())
            if not receipt['enabledFinalPrivatePinsExact']:receipt['status']='CLOSURE_OR_SOURCE_UNPROVEN'
        for field in ('upgradePrivatePins','newFaultInputPins'):
            if receipt.get(field) and not all(sha(path)==expected for path,expected in receipt[field].items()):
                receipt['status']='CLOSURE_OR_SOURCE_UNPROVEN'
        receipt['finalUpgradeAndFaultPrivatePinsExact']=bool(receipt.get('upgradePrivatePins') and receipt.get('newFaultInputPins')) and all(sha(path)==expected for field in ('upgradePrivatePins','newFaultInputPins') for path,expected in receipt.get(field,{}).items())
        receipt['remainingUnrunCases']=[item['id'] for item in receipt['cases'] if item['status']=='UNRUN']
        receipt['actualCasesPassed']=sum(item['status']=='PASS' for item in receipt['cases']);receipt['endedAt']=mature['utc']()
        save();password=None
        for number,handler in handlers.items():signal.signal(number,handler)
        if receipt['status']=='CLOSURE_OR_SOURCE_UNPROVEN':return 1

if __name__=='__main__':raise SystemExit(main())
