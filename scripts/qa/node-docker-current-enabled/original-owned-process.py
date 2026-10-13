#!/usr/bin/env python3
"""Finite genuine local-upload lifetime qualification. --run requires exclusive parent GO.
Source pins are immutable. No retries, case filters, deadline edits or generators.
"""
from __future__ import annotations
import argparse, datetime, hashlib, json, os, re, signal, subprocess, time
from pathlib import Path
ROOT = Path("/tmp/portable-rt3-local-upload-gate-source-only-attempt7")
MANIFEST = Path("/tmp/portable-rt3-local-upload-gate-source-only-attempt7-manifest.json")
PLAN = Path("/tmp/portable-rt3-local-upload-gate-runtime-plan-source-only-attempt7.json")
PREREQUISITES = Path("/tmp/portable-rt3-local-upload-gate-genuine-auth-prerequisites-attempt3-manifest.json")
PINS = {
 "/tmp/portable-rt3-upload-gate7-independent-consumer-barrier-source-addendum.json": "3f2b7b30804c9fe491aa6e9f3f052c2c328be252a4674de7ff2891d20efba500",
 "/tmp/portable-rt3-local-upload-gate-actual-attempt2/receipt.json": "deaac8412cca14a859a9d116e330f7b34caa1bf79c67324a03f78d37372681ff",
 "/tmp/portable-rt3-local-upload-gate-actual-attempt2/actual-counts-and-closure-supplement.json": "e61fd4a33c9fbf88b70b159be4b2dbdd9d7f4b959490be37fad84298e26cbc72",
 "/tmp/portable-rt3-local-upload-gate-actual-attempt2/new-genuine-local-upload-gate-twenty.log": "bfe9c7969fe2bb3b3baa7ff0de558b3ceeb72c13184f9a7178b44b85c5ec4565",
 "/tmp/portable-rt3-upload-gate5-independent-bracket-source-peer.json": "087c06f4ec07595912401485a805dd080b73f0192d8dbb96a68ebdafe6968ffe",
 "/tmp/portable-rt3-upload-gate6-independent-template-drain-source-addendum.json": "1e55fffaa0eb6cdff5b3111b43facb96a3f7504d72e265364f34eb8b2b35bb5a",
 "/tmp/portable-rt3-upload-gate4-independent-captured-owner-source-peer.json": "3fd704d1543f3cf405595e820f7647ccba088cc5c3b7a667e4a80209311b0092",
 "/tmp/portable-rt3-local-upload-gate-actual-attempt1/receipt.json": "5d699c3230f480b7b7b4e7e0245930a3196d1cba692444964cdad63f1533e69f",
 "/tmp/portable-rt3-local-upload-gate-actual-attempt1/new-genuine-local-upload-gate-thirteen.log": "dc688dbef3da2af75d9d9868bd469bc637da09766d980870330579acd2ab5942",
 "/tmp/portable-rt3-upload-gate3-root-genuine-owner-source-peer.json": "76de83be583242f2777ae87c82c1092b20100fe9ab1a3dd7ffec7f898a5b8b30",
 "/tmp/portable-rt3-upload-gate3-independent-owner-lifetime-source-peer.json": "7af77aa3d1f436a8869f1868e3d26da67717287ecbf01082abc1aa4165784956",
 "/tmp/portable-group-principal-1c8f058-actual-attempt2/receipt.json": "6ff52f7695d05b815adb12ecfd41321069e4bf8b7aa50fb9e2938e1a436a3084",
 str(MANIFEST): "51aadb30de22bbc374205b91aad451bab70fc8d00d70c24dcb93ff9759686bf6",
 str(PLAN): "8a984aced6a45e45e818ca5f209c241fa855af28109eeb5368cd44120c13fa10",
 str(PREREQUISITES): "cb7ebd551d47c1ae1584453f87a4cd26c916c6cb908a7f71e866b2e470d4de4b",
 "/tmp/portable-rt3-local-file-admin-qualified-attempt1/docs/RT3_LOCAL_FILE_ADMIN_QUALIFIED_RECEIPTS.json": "79df4109668c2dcc89b4c8f870fc09494374d4ac49f11e3ce47be71a7bbfa7f2",
 "/tmp/portable-group-principal-e76-source-only-attempt1/docs/GENUINE_REQUEST_PRINCIPAL_SOURCE_FREEZE.json": "5796b16f48a611701a1e10e165bdabeecebc3d7ca93538275a1af6b9bff5e1cd",
}
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def inventory(root):
 return {str(p.relative_to(root)):sha(p) for p in root.rglob('*') if p.is_file() and not p.is_symlink() and 'node_modules' not in p.parts}
def preflight():
 checked={}
 for name,pin in PINS.items():
  actual=sha(Path(name)); assert actual==pin, f"Pinned proof changed: {name}"; checked[name]=actual
 m=json.loads(MANIFEST.read_text()); p=json.loads(PLAN.read_text())
 identity_actual=json.loads(Path('/tmp/portable-group-principal-1c8f058-actual-attempt2/receipt.json').read_text())
 assert identity_actual['status']=='PASS' and identity_actual['newCaseCount']==12 and not identity_actual['unrunStages']
 assert identity_actual['cleanupEvidence']['processGroupsHaveNoActiveOrUnknownOwners'] is True
 assert all(not group['active'] and not group['unknownKnownMembers'] for group in identity_actual['ownedGroups'])
 for stage in identity_actual['stages']:
  assert stage['status']=='PASS' and stage['exitCode']==0 and stage['directChildReaped'] is True
  assert stage['groupClosure']=='NO_ACTIVE_OWNER'
  assert sha(Path(stage['log']['path']))==stage['log']['sha256'], 'Original identity qualification log changed'
 actual_twelve=next(stage for stage in identity_actual['stages'] if stage['name']=='new-twelve')
 assert actual_twelve['actualResults']=={'numTotalTests':12,'numPassedTests':12,'numFailedTests':0,'numPendingTests':0,'success':True}
 assert sha(Path(actual_twelve['result']['path']))==actual_twelve['result']['sha256']
 actual_results=json.loads(Path(actual_twelve['result']['path']).read_text())
 assert actual_results['numTotalTests']==actual_results['numPassedTests']==12 and actual_results['numFailedTests']==actual_results['numPendingTests']==0
 for name,pin in m['sourceOnlySharedPrerequisitesExcludedFromOwnedFour'].items():
  assert sha(Path('/tmp/portable-group-principal-e76-source-only-attempt1')/name)==pin, 'Qualified genuine owner source differs'
 for name,pin in {**m['ownedFive'], **m['sourceOnlySharedPrerequisitesExcludedFromOwnedFour'], **m['sealedV26Outputs']}.items():
  actual=sha(ROOT/name); assert actual==pin, f"Source changed: {name}"; checked[name]=actual
 assert sha(ROOT/'server/sqlite.ts')==m['core755']
 assert sha(ROOT/'migrations/0024_rt3_local_volume_profiles.sql')==m['raw0024']
 assert sha(ROOT/'worker/files/storage-profile-opening.ts')==m['opener27c']
 files=inventory(ROOT); digest=hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 assert digest==m['sourceInventorySha256'] and len(files)==m['sourceFiles'], 'Full immutable source inventory changed'
 assert p['sourceRoot']==m['sourceRoot']==str(ROOT)
 assert p['manifest']==p['manifestPath']==str(MANIFEST) and p['manifestSha256']==sha(MANIFEST)
 prior=json.loads(Path('/tmp/portable-rt3-local-upload-gate-actual-attempt1/receipt.json').read_text())
 assert prior['status']=='FAIL_STOPPED_FIRST' and prior['strictPassed']==2 and prior['actualPassedCases']==0
 assert prior['plannedRuntimeCases']==13 and prior['remainingCreatedGateFixtureRoots']==[]
 assert all(not members for members in prior['finalAllOwnedGroupInventory'].values())
 for step in prior['steps']:
  assert step['ownedClosureProven'] is True and sha(Path(step['log']))==step['logSha256']
 assert prior['steps'][-1]['actualTestSummary']=='Tests  1 failed (13)'
 second=json.loads(Path('/tmp/portable-rt3-local-upload-gate-actual-attempt2/receipt.json').read_text())
 assert second['status']=='FAIL_STOPPED_FIRST' and second['strictPassed']==2
 assert second['steps'][-1]['actualTestSummary']=='Tests  1 failed | 2 passed (20)'
 assert second['remainingCreatedGateFixtureRoots']==[] and all(not values for values in second['finalAllOwnedGroupInventory'].values())
 for step in second['steps']:
  assert step['ownedClosureProven'] is True and sha(Path(step['log']))==step['logSha256']
 supplement=json.loads(Path('/tmp/portable-rt3-local-upload-gate-actual-attempt2/actual-counts-and-closure-supplement.json').read_text())
 assert (supplement['actualRuntimePassed'],supplement['actualRuntimeFailed'],supplement['declaredRuntimeUnrunAfterBail'])==(2,1,17)
 assert p['plannedCases']==m['plannedNewCases']==20
 assert p['runtimeCases']==m['casesExecuted']==0 and p['newStrictExecuted']==m['typesExecuted']==0
 assert p['defaultCaseBudgetMs']==m['testBudgetMs']==5000 and p['existingPrewarmHookMs']==m['prewarmHookMs']==20000
 assert p['filters'] is None and p['retries']==0 and p['stopFirstFailure'] is True
 assert p['environment']=={'NODE_PROTOTYPE_FIXTURE_PARENT':'/workspace','NO_COLOR':'1','FORCE_COLOR':'0'}
 assert p['strictArgv']==[
  ['./node_modules/.bin/tsc','--noEmit','-p','tsconfig.server.json'],
  ['./node_modules/.bin/tsc','--noEmit','-p','tsconfig.rt3-local-upload-gate-tests.json']]
 assert p['steps']==[{'name':'new-genuine-local-upload-gate-twenty','cases':20,'argv':[
  './node_modules/.bin/vitest','run','--config','vitest.config.ts','server/storage/local-upload-execution.test.ts',
  '--maxWorkers=1','--fileParallelism=false','--bail=1']}]
 parent=Path('/workspace'); current=parent
 root_owner_uid=os.lstat('/').st_uid; process_owner_uid=os.geteuid()
 while True:
  state=os.lstat(current); at_root=current==current.parent
  trusted_owner=state.st_uid==root_owner_uid if at_root else state.st_uid in (process_owner_uid,0)
  assert current.is_dir() and not current.is_symlink() and trusted_owner and not state.st_mode & 0o022, f'Untrusted fixture ancestry: {current}'
  if at_root:break
  current=current.parent
 modules=Path(p['dependencies']); assert modules.exists()
 if (ROOT/'node_modules').exists():assert (ROOT/'node_modules').is_symlink() and (ROOT/'node_modules').resolve()==modules.resolve()
 return {'checkedPins':checked,'sourceFiles':len(files),'sourceInventorySha256':digest,'trustedFixtureParent':str(parent),'fixtureRootOwnerUid':root_owner_uid,'fixtureProcessOwnerUid':process_owner_uid,'dependencies':str(modules),'runnerSha256':sha(Path(__file__)),'qualifiedGenuineIdentityPrerequisiteCases':12,'identityQualificationIsNotGateCarry':True,'typesExecuted':0,'casesExecuted':0}
def utc() -> str:
 return datetime.datetime.now(datetime.timezone.utc).isoformat()

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

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--run',action='store_true');parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
 args.output.mkdir(mode=0o700,parents=False,exist_ok=False)
 receipt={'kind':'rt3-genuine-local-upload-gate-actual-finite-qualification/1','status':'PREFLIGHT_PENDING','sourceRoot':str(ROOT),'startedAt':utc(),'runtimeAuthorized':args.run,'defaultBudgetsUnchanged':True,'steps':[],'strictPassed':0,'actualPassedCases':0,'ownedOnlyInterruptionCleanup':True,'plannedRuntimeCases':20,'carriedStrictChecks':[],'carriedRuntimeCases':[],'baseMetadata29NotGateQualification':True}
 target=args.output/'receipt.json'
 def save():target.write_text(json.dumps(receipt,indent=2)+'\n')
 initial=set(Path('/workspace').glob('.rt3-local-upload-gate-*'))
 original_handlers={number:signal.getsignal(number) for number in (signal.SIGINT,signal.SIGTERM)}
 def interrupted(number,_frame):raise QualificationInterrupted(number)
 for number in original_handlers:signal.signal(number,interrupted)
 owned=None;current=None;log=None;start=None
 def collect_current(code=None):
  if current is None:return
  current.update({'exitCode':code,'seconds':round(time.monotonic()-start,3) if start is not None else None,'endedAt':utc()})
  if log is not None:
   log.flush()
   current['logSha256']=sha(Path(current['log']))
   plain=re.sub(r'\x1b\[[0-9;]*m','',Path(current['log']).read_text())
   line=re.search(r'^\s*Tests\s+.*$',plain,re.M)
   if line:current['actualTestSummary']=line.group(0).strip()
   passed=re.search(r'Tests\s+(\d+) passed\s+\((\d+)\)',plain)
   if passed:
    current['actualPassedCases']=int(passed.group(1));current['actualTotalCases']=int(passed.group(2))
   current['expectedCountMatched']=bool(passed and int(passed.group(1))==int(passed.group(2))==current['cases']) if current['cases'] is not None else None
 try:
  receipt['preflight']=preflight();receipt['status']='PREFLIGHT_PASS';save();print('SOURCE PREFLIGHT PASS; no runtime executed',flush=True)
  if not args.run:return 0
  plan=json.loads(PLAN.read_text());modules=Path(plan['dependencies'])
  if not (ROOT/'node_modules').exists():(ROOT/'node_modules').symlink_to(modules,target_is_directory=True)
  env={**os.environ,**plan['environment']}
  receipt['steps']=[{'name':f'strict-{i+1}','argv':argv,'cases':None,'status':'UNRUN'} for i,argv in enumerate(plan['strictArgv'])]+[{**spec,'status':'UNRUN'} for spec in plan['steps']]
  receipt['environment']=plan['environment'];receipt['status']='RUNNING';save()
  for step in receipt['steps']:
   current=step;current.update({'status':'RUNNING','startedAt':utc(),'log':str(args.output/(step['name']+'.log'))});save()
   print('START '+step['name'],flush=True);start=time.monotonic();log=Path(current['log']).open('x')
   # Assign the original process handle before an interrupt can be delivered.
   blocked=signal.pthread_sigmask(signal.SIG_BLOCK,set(original_handlers))
   try:
    owned=subprocess.Popen(step['argv'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    current['pid']=owned.pid;current['processGroup']=owned.pid
   finally:signal.pthread_sigmask(signal.SIG_SETMASK,blocked)
   save();code=owned.wait();collect_current(code)
   current['completionGroupSnapshot']=group_snapshot(owned.pid)
   current['normalCompletionHadActiveChildren']=bool(active(current['completionGroupSnapshot']))
   closure=close_owned_process(owned,current)
   good=code==0 and not current['normalCompletionHadActiveChildren'] and closure and (step['cases'] is None or current.get('expectedCountMatched',False))
   current['status']='PASS' if good else 'FAIL'
   if good:
    if step['cases'] is None:receipt['strictPassed']+=1
    else:receipt['actualPassedCases']+=current['actualPassedCases']
   print(f"END {step['name']} {current['status']} exit={code} seconds={current['seconds']}",flush=True);save();log.close();log=None;owned=None
   if not good:receipt['status']='FAIL_STOPPED_FIRST';return 1
  receipt['status']='PASS';return 0
 except (QualificationInterrupted,KeyboardInterrupt) as error:
  receipt['status']='ABORTED_PARTIAL';receipt['interruption']=str(error)
  receipt['interruptedSignal']=getattr(error,'number',signal.SIGINT)
  if current:current['status']='ABORTED_PARTIAL'
  return 128+receipt['interruptedSignal']
 except Exception as error:
  receipt['status']='PREFLIGHT_OR_RUNNER_FAILURE';receipt['error']=f'{type(error).__name__}: {error}'
  if current and current['status']=='RUNNING':current['status']='FAILED_PARTIAL'
  print(receipt['error'],flush=True);return 1
 finally:
  # Preserve one owned original. Repeated signals cannot skip its actual wait.
  for number in original_handlers:signal.signal(number,signal.SIG_IGN)
  if owned is not None and current is not None:
   try:close_owned_process(owned,current)
   except Exception as error:
    current['ownedClosureProven']=False;current['closureError']=f'{type(error).__name__}: {error}'
    receipt['status']='OWNED_CLOSURE_UNPROVEN'
   collect_current(owned.returncode)
  if log is not None:log.close()
  receipt['endedAt']=utc();receipt['remainingUnrunSteps']=[s['name'] for s in receipt['steps'] if s['status']=='UNRUN']
  receipt['remainingCreatedGateFixtureRoots']=sorted(str(p) for p in set(Path('/workspace').glob('.rt3-local-upload-gate-*'))-initial)
  receipt['noFixtureForceRemoval']=True
  receipt['finalOwnedGroupSnapshot']=group_snapshot(owned.pid) if owned is not None else []
  receipt['finalAllOwnedGroupInventory']={str(step['processGroup']):group_snapshot(step['processGroup']) for step in receipt['steps'] if 'processGroup' in step}
  save()
  for number,handler in original_handlers.items():signal.signal(number,handler)
if __name__=='__main__':raise SystemExit(main())
