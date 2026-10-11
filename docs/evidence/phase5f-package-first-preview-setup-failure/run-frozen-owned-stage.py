"""Run one pinned Package2 finite13 stage; reuse actual f88 product output.
Worker stdin ownership is retained by this recorder until an explicit stop.
"""
import datetime,hashlib,json,os,signal,subprocess,sys,time
from pathlib import Path
SOURCE_ROOT=Path('/tmp/phase5f-storage-candidate-section-wrap-source-attempt10')
RUNTIME=Path('/tmp/phase5f-package-two-genuine-preview-runtime-attempt1')
PLAN=Path('/tmp/phase5f-package-two-genuine-preview-finite-source-review-attempt1/finite-genuine-package-preview-two-plan.json')
PLAN_SHA='01f2fb9a5bb7a0a11b2216811ced7b8efff3241a5b044d469645981c0b080c6d'
assert sys.argv[1:2]==['--exclusive-go-exact-f503848-package-preview-two-stage'] and len(sys.argv)==3
assert hashlib.sha256(PLAN.read_bytes()).hexdigest()==PLAN_SHA
plan=json.loads(PLAN.read_bytes());stage=sys.argv[2]
step=next(x for x in plan['commands'] if x['stage']==stage)
assert 'argv' in step
ROOT=Path(step['cwd'])
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def write(name, value):
    with (RUNTIME / name).open("x") as file:
        json.dump(value, file, indent=2)
        file.write("\n")

def group_members(group):
    members = []
    for process in Path("/proc").iterdir():
        if not process.name.isdecimal():
            continue
        try:
            stat = (process / "stat").read_text()
            fields = stat[stat.rfind(")") + 2 :].split()
            if int(fields[2]) != group:
                continue
            member = {"pid": int(process.name), "state": fields[0],
                      "ppid": int(fields[1]), "processGroup": int(fields[2])}
            if fields[0] in {"Z", "X"}:
                member["kernelResourcesExited"] = True
            try:
                member["openFdCount"] = len(list((process / "fd").iterdir()))
            except PermissionError:
                # Preserve the genuine kernel state already read above.
                # Inaccessible FD metadata is not an observed zero FD count.
                member["fdInspection"] = "PermissionError"
            members.append(member)
        except FileNotFoundError:
            continue
        except (PermissionError, ProcessLookupError):
            members.append({"pid": int(process.name), "state": "UNREADABLE_PROCESS_STAT"})
    return members

def active_members(members):
    return [member for member in members if member["state"] not in {"Z", "X"} or member.get("openFdCount", 0)]

def close_owned_group(group):
    before = group_members(group)
    actions = []
    # Cleanup only the newly launched owned process group, never other owners.
    if active_members(before):
        for sig in [signal.SIGTERM, signal.SIGKILL]:
            try:
                os.killpg(group, sig)
                actions.append(signal.Signals(sig).name)
            except ProcessLookupError:
                break
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and active_members(group_members(group)):
                time.sleep(0.1)
            if not active_members(group_members(group)):
                break
    after = group_members(group)
    return {"before": before, "after": after, "ownedCleanupSignals": actions,
            "noActiveOwnedProcessOrFd": not active_members(after),
            "unexpectedLingeringOwner": bool(active_members(before))}

class RunnerInterrupted(BaseException):
    pass

def interrupt_handler(signum, _frame):
    raise RunnerInterrupted("received " + signal.Signals(signum).name)

def close_and_reap(process):
    # A second SIGTERM/SIGINT cannot bypass cleanup of this owned child.
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    for sig in previous:
        signal.signal(sig, signal.SIG_IGN)
    try:
        closure = close_owned_group(process.pid)
        try:
            code = process.wait(timeout=5)
            closure["directChildExitCode"] = code
            closure["directChildReaped"] = True
        except subprocess.TimeoutExpired:
            closure["directChildExitCode"] = None
            closure["directChildReaped"] = False
        closure["afterDirectChildReap"] = group_members(process.pid)
        closure["noActiveOwnedProcessOrFd"] = not active_members(closure["afterDirectChildReap"])
        return closure
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)

def run_owned(step, registered_items, diagnostic_timeout=None):
    item = {**step, "startedAt": utc(), "status": "RUNNING", "log": str(RUNTIME / (step["stage"] + ".log"))}
    # Capture ownership metadata before launch/return so interruption cannot
    # erase a completed or partially launched stage from the final receipt.
    registered_items.append(item)
    error = None
    process = None
    try:
        with Path(item["log"]).open("xb") as file:
            launch_signals = []
            previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
            for sig in previous:
                signal.signal(sig, lambda signum, _frame: launch_signals.append(signum))
            try:
                process = subprocess.Popen(step["argv"], cwd=ROOT, stdout=file, stderr=subprocess.STDOUT,
                                           env=os.environ.copy(), start_new_session=True)
                item["pid"] = item["processGroup"] = process.pid
                stat_text = Path(f"/proc/{process.pid}/stat").read_text()
                item["originalStartTicks"] = stat_text[stat_text.rfind(")") + 2:].split()[19]
            finally:
                for sig, handler in previous.items():
                    signal.signal(sig, handler)
            if launch_signals:
                raise RunnerInterrupted("received during launch: " + ", ".join(signal.Signals(sig).name for sig in launch_signals))
            print(json.dumps({"stage": step["stage"], "ownedPid": process.pid, "ownedProcessGroup": process.pid, "originalStartTicks": item["originalStartTicks"]}), flush=True)
            item["exitCode"] = process.wait(timeout=diagnostic_timeout)
    except BaseException as caught:
        error = caught
        item["runnerError"] = {"kind": type(caught).__name__, "message": str(caught), "at": utc()}
    finally:
        if process is not None:
            item["ownedClosure"] = close_and_reap(process)
            item.setdefault("exitCode", item["ownedClosure"]["directChildExitCode"])
        item["endedAt"] = utc()
        log = Path(item["log"])
        if log.is_file():
            item["logSha256"] = sha(log)
        closure = item.get("ownedClosure", {})
        failed = bool(error or item.get("exitCode") != 0 or closure.get("unexpectedLingeringOwner")
                      or not closure.get("noActiveOwnedProcessOrFd") or not closure.get("directChildReaped"))
        item["status"] = "INTERRUPTED" if isinstance(error, (RunnerInterrupted, KeyboardInterrupt)) else "FAILED" if failed else "PASS"
    return item, error

def verify_source():
    assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=SOURCE_ROOT,text=True).strip()==plan['sourceHead']
    assert subprocess.check_output(['git','rev-parse','HEAD^{tree}'],cwd=SOURCE_ROOT,text=True).strip()==plan['sourceTree']
    assert not subprocess.check_output(['git','status','--porcelain'],cwd=SOURCE_ROOT,text=True).strip()
    rows=subprocess.check_output(['git','ls-tree','-r','HEAD'],cwd=SOURCE_ROOT,text=True).splitlines()
    assert len(rows)==1792
    for line in rows:
        mode,name=line.split('\t');b=(SOURCE_ROOT/name).read_bytes()
        assert hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()==mode.split()[-1],name
    for p,h in [('package.json',plan['installedDependencies']['package']),('package-lock.json',plan['installedDependencies']['lock']),('node_modules/.package-lock.json',plan['installedDependencies']['hiddenLock'])]:assert sha(SOURCE_ROOT/p)==h
    assert str((SOURCE_ROOT/'node_modules').resolve())==plan['installedDependencies']['root']
verify_source()
if not RUNTIME.exists():
    assert stage=='qualified-f88-producer-preflight' and (SOURCE_ROOT/'dist').is_dir()
    RUNTIME.mkdir(mode=0o700)
    write('frozen-approved-plan.json',plan)
assert (RUNTIME.stat().st_mode&0o777)==0o700
for key,value in step.get('env',{}).items():os.environ[key]=value
signal.signal(signal.SIGTERM,interrupt_handler);signal.signal(signal.SIGINT,interrupt_handler)
items=[];post_error=None
if stage!='owned-built-worker':
    item,error=run_owned(step,items)
else:
    assert sys.stdin.isatty(), 'Use the reviewed interactive tty=True launcher; refuse before spawning Worker on closed/plain-pipe stdin'
    item={**step,'startedAt':utc(),'status':'RUNNING','log':str(RUNTIME/(stage+'.log'))};items.append(item)
    process=None;error=None
    try:
        with Path(item['log']).open('xb') as log:
            process=subprocess.Popen(step['argv'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,stdin=subprocess.PIPE,text=True,start_new_session=True)
            item['pid']=item['processGroup']=process.pid
            stat_text=Path(f'/proc/{process.pid}/stat').read_text();item['originalStartTicks']=stat_text[stat_text.rfind(')')+2:].split()[19]
            print(json.dumps({'stage':stage,'ownedPid':process.pid,'ownedProcessGroup':process.pid,'originalStartTicks':item['originalStartTicks']}),flush=True)
            control=sys.stdin.readline()
            assert control=='stop\n','Only explicit original owned stdin stop is permitted'
            process.stdin.write('stop\n');process.stdin.flush();item['originalStdinStopSent']=True
            item['exitCode']=process.wait()
    except BaseException as caught:
        error=caught;item['runnerError']={'kind':type(caught).__name__,'message':str(caught),'at':utc()}
    finally:
        if process is not None:
            if process.poll() is None and not item.get('originalStdinStopSent'):
                try:process.stdin.write('stop\n');process.stdin.flush();item['originalStdinStopSent']=True;item['exitCode']=process.wait(timeout=15)
                except BaseException as caught:item['mandatoryStdinStopError']=repr(caught)
            item['ownedClosure']=close_and_reap(process);item.setdefault('exitCode',item['ownedClosure']['directChildExitCode'])
        item['endedAt']=utc();item['logSha256']=sha(Path(item['log']))
        closure=item.get('ownedClosure',{})
        failed=bool(error or item.get('exitCode')!=0 or closure.get('unexpectedLingeringOwner') or not closure.get('noActiveOwnedProcessOrFd') or not closure.get('directChildReaped'))
        item['status']='FAILED' if failed else 'PASS'
try:verify_source()
except BaseException as caught:post_error=repr(caught);item['sourcePostCheckError']=post_error;item['status']='FAILED'
write(stage+'-command.json',item)
if stage=='one-fresh-final-QA-source-build' and item['status']=='PASS':
    paths=sorted((SOURCE_ROOT/'dist').rglob('*'));artifacts={str(p.relative_to(SOURCE_ROOT)):sha(p) for p in paths if p.is_file()}
    assert artifacts
    write('fresh-build-artifact-manifest.json',{'sourceHead':plan['sourceHead'],'sourceTree':plan['sourceTree'],'fileCount':len(artifacts),'files':artifacts})
print(json.dumps(item),flush=True)
print(Path(item['log']).read_text(errors='replace')[-3000:],flush=True)
sys.exit(0 if item['status']=='PASS' else 1)
