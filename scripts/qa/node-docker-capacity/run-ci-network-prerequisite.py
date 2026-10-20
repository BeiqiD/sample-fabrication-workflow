#!/usr/bin/env python3
"""One real existing-base npm registry probe; source-only until root exclusive GO."""
import argparse,hashlib,ipaddress,json,os,runpy,shutil,signal,subprocess,sys,uuid
from pathlib import Path
ROOT=Path(os.environ['NODE_DOCKER_SIX_ROOT'])
PREP=ROOT/'prepared'
OUTPUT=ROOT/'registry'
CONTEXT=ROOT/'context'
HEAD='f883e64086bee44b353f3840271fa3eaaafdcc7d'
BASE='sha256:622f209f6c16ba5af4d9a337cae6577d096f17174b904cfc6a5b0c81a2679c24'
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--exclusive-go-ci-network-prerequisite',action='store_true');args=parser.parse_args()
    if not args.exclusive_go_ci_network_prerequisite:raise SystemExit('Root exclusive registry-probe GO required')
    platform=json.loads((ROOT/'platform-source-and-tools.json').read_text())
    assert platform['status']=='SOURCE_PREPARED' and platform['sourceHead']==HEAD
    prepared_seal=json.loads((PREP/'docker-six-driver-source-seal.json').read_text())
    seal={'driverSha256':prepared_seal['networkDriverSha256'],'dockerBinary':platform['tools']['docker'],
      'privateClientEnvironment':prepared_seal['privateClientEnvironment']}
    assert sha(Path(__file__))==seal['driverSha256'] and sha(seal['dockerBinary']['path'])==seal['dockerBinary']['sha256']
    assert Path(shutil.which('docker')).resolve()==Path(seal['dockerBinary']['path']).resolve()
    assert Path(sys.executable).resolve()==Path(platform['tools']['python3']['path']) and sha(sys.executable)==platform['tools']['python3']['sha256']
    assert os.geteuid()==1000
    helper=PREP/'original-owned-process.py';assert sha(helper)=='b623484a36325020644d64479cc41939c20a984a07a1ba585e4be1a17e812889'
    assert not OUTPUT.exists();OUTPUT.mkdir(mode=0o700)
    mature=runpy.run_path(str(helper));snapshot,active,close=[mature[n] for n in ('group_snapshot','active','close_owned_process')]
    docker_environment=dict(os.environ);docker_environment.pop('BUILDX_CONFIG',None);docker_environment.update(DOCKER_CONFIG=str(PREP/'private-docker-config'),TMPDIR=str(PREP/'private-client-tmp'))
    for key,v in seal['privateClientEnvironment'].items():
        q=Path(docker_environment[key]);st=q.lstat();assert q.resolve()==q and q.is_dir() and not q.is_symlink() and st.st_uid==1000 and st.st_mode&0o7777==0o700 and st.st_dev==v['dev'] and st.st_ino==v['ino']
    assert not any(k in docker_environment for k in ('HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy','NODE_EXTRA_CA_CERTS','DOCKER_HOST','DOCKER_CONTEXT'))
    receipt={'status':'RUNNING','commands':[],'containers':[],'sourceHead':HEAD,'startedAt':mature['utc'](),'registryProbePassed':False,'appNativeSdkOrBuildInvocations':0,'proxyValuesPrinted':False,'noProxyForwarded':True,'tlsStrict':True,'capacityPrerequisitePassed':False,'basePinExact':False,'invocationHead':platform['invocationHead']}
    save=lambda:(OUTPUT/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    owned=log=None;current=None;nonce=uuid.uuid4().hex;image=BASE
    handlers={s:signal.getsignal(s) for s in (signal.SIGINT,signal.SIGTERM)}
    def interrupt(number,_):raise mature['QualificationInterrupted'](number)
    for number in handlers:signal.signal(number,interrupt)
    common=['--pull=never','--network=none','--read-only','--user=1000:1000','--cap-drop=ALL','--security-opt=no-new-privileges:true','--pids-limit=64','--memory=768m','--cpus=2','--tmpfs=/tmp:rw,size=33554432,mode=0700,uid=1000,gid=1000,noexec,nosuid,nodev']
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
            current['startTicks'] = None
            current['originalStartObservation'] = 'UNKNOWN'
            try:
                process_fields = (Path('/proc')/str(owned.pid)/'stat').read_text().rsplit(')',1)[1].split()
                current['startTicks'] = process_fields[19]
                current['originalStartObservation'] = 'CAPTURED_BEFORE_ORIGINAL_WAIT'
            except (FileNotFoundError, PermissionError, ProcessLookupError, IndexError) as error:
                current['originalStartObservationError'] = type(error).__name__
            save()
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
        value = json.loads(command('inspect', ['docker', 'inspect', '--format', '[{"Id":{{json .Id}},"Config":{"Labels":{{json .Config.Labels}}},"State":{"Running":{{json .State.Running}},"Pid":{{json .State.Pid}},"ExitCode":{{json .State.ExitCode}}}}]', record['id'] or record['name']]))[0]
        assert (record['id'] is None or value['Id'] == record['id']) and value['Config']['Labels']['sample.qa.owner'] == nonce
        assert value['Config']['Labels']['sample.qa.source'] == HEAD
        record['id'] = value['Id']
        record['lastState'] = value['State']; save(); return value['State']

    result=1
    try:
        info=json.loads(command('actual-daemon-capacity',['docker','info','--format','{"DockerRootDir":{{json .DockerRootDir}},"Driver":{{json .Driver}},"ServerVersion":{{json .ServerVersion}},"OSType":{{json .OSType}},"Architecture":{{json .Architecture}}}']))
        assert info['OSType']=='linux' and info['Architecture'] in ('x86_64','amd64')
        daemon_root=Path(info['DockerRootDir']);assert daemon_root.is_absolute() and daemon_root.resolve()==daemon_root and not daemon_root.is_symlink()
        assert daemon_root.stat().st_dev==ROOT.stat().st_dev, 'Capacity must measure the actual same backing filesystem'
        filesystem=os.statvfs(ROOT);free=filesystem.f_bavail*filesystem.f_frsize
        assert free>=8589934592, 'At least8GiB real daemon backing capacity required before pull/build'
        receipt['actualDaemonCapacity']={'info':info,'backingDevice':daemon_root.stat().st_dev,'availableBytes':free,'requiredBytes':8589934592}
        receipt['capacityPrerequisitePassed']=True;save()
        command('one-exact-pinned-base-preload',['docker','pull','--platform','linux/amd64','node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df'],timeout=180)
        cached=json.loads(command('existing-pinned-base',['docker','image','inspect','--format','[{"Id":{{json .Id}},"Architecture":{{json .Architecture}}}]',BASE]))[0]
        assert cached['Id']==BASE and cached['Architecture']=='amd64'
        receipt['basePinExact']=True;save()
        extra=[]
        argv=('/usr/local/lib/node_modules/npm/bin/npm-cli.js','ping','--registry=https://registry.npmjs.org','--fetch-timeout=10000','--fetch-retries=0','--cache=/tmp/npm','--strict-ssl=true','--loglevel=error','--no-update-notifier','--json')
        probe=create('original-host-resolved-registry-probe',extra,entry='node',arguments=argv,network='bridge')
        output=command('original-registry-probe-first-start',['docker','start','--attach',probe['id']],timeout=30)
        response=json.loads(output);assert isinstance(response,dict) and set(response)=={'registry','time','details'} and response['registry']=='https://registry.npmjs.org/' and isinstance(response['time'],int) and not isinstance(response['time'],bool) and 0<=response['time']<=10000 and response['details']=={}
        receipt['originalStrictTlsRegistryResponse']=response
        state=inspect(probe);assert not state['Running'] and state['Pid']==0 and state['ExitCode']==0
        probe['originalExitObserved']=True;receipt['registryProbePassed']=True;receipt['status']='PASS';result=0
    except BaseException as error:
        receipt['status']='FAIL_STOPPED_FIRST';receipt['failureType']=type(error).__name__
        if current and current['status']=='RUNNING':current['status']='FAILED_PARTIAL'
    finally:
        for number in handlers:signal.signal(number,signal.SIG_IGN)
        original_closed=settle_cli();receipt['containerClosureUnproven']=[]
        for record in receipt['containers']:
            if not original_closed:receipt['containerClosureUnproven'].append(record['id'] or record['name']);continue
            try:
                state=inspect(record)
                if state['Running'] or state['Pid']!=0:receipt['containerClosureUnproven'].append(record['id'])
                else:record['terminalOriginalProcessExitObserved']=True
            except BaseException:
                receipt['containerClosureUnproven'].append(record['id'] or record['name']);original_closed=settle_cli()
        receipt['finalCliGroups']={str(c['processGroup']):snapshot(c['processGroup']) for c in receipt['commands'] if 'processGroup' in c}
        receipt['cliGroupsInactive']=original_closed and all(not active(x) for x in receipt['finalCliGroups'].values())
        receipt['noContainerSignalsPruneOrRemoval']=True;receipt['containersRetained']=True;receipt['endedAt']=mature['utc']()
        if receipt['containerClosureUnproven'] or not receipt['cliGroupsInactive']:receipt['status']='CLOSURE_OR_SOURCE_UNPROVEN';result=1
        save()
        if receipt['status']=='PASS' and result==0:
            driver_seal=PREP/'docker-six-driver-source-seal.json';value=json.loads(driver_seal.read_text())
            assert value['registryProbeQualification'] is None
            value['registryProbeQualification']={'path':str(OUTPUT/'receipt.json'),'sha256':sha(OUTPUT/'receipt.json')}
            driver_seal.write_text(json.dumps(value,indent=2)+'\n');driver_seal.chmod(0o600)
        for number,handler in handlers.items():signal.signal(number,handler)
    return result
if __name__=='__main__':raise SystemExit(main())
