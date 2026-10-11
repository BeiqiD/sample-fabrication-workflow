from pathlib import Path
import subprocess,json,hashlib,re,posixpath,datetime
root=Path('/workspace/portable-current194-neutral-file-definition-integration-source-attempt1');prior=Path('/workspace/portable-current591-neutral-file-definition-source-only-attempt1')
base='1943f746332596220ed34edb5d4b0ac45d6db40d';current='f5d2f38cb156fb8cf89d81e24f3d817c208aedb6';predecessor='96e416fb00523e154bef6faff560733900c0aa7e';oldbase='591bee968e2fc06a3666f8ed4774fd698bbf3c4b';compilerHead='1b3e1d59480f8a1c09ddb33c2f434ab710607b56'
sha=lambda b:hashlib.sha256(b).hexdigest();fileSha=lambda p:sha(p.read_bytes())
def show(head,p,at=root):return subprocess.check_output(['git','show',head+':'+p],cwd=at)
def tree(head,at=root):
 answer={}
 for part in subprocess.check_output(['git','ls-tree','-rz',head],cwd=at).split(b'\0'):
  if not part:continue
  meta,p=part.split(b'\t',1);mode,kind,blob=meta.decode().split();assert kind=='blob';answer[p.decode()]={'mode':mode,'blob':blob}
 return answer
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==current
assert not subprocess.check_output(['git','status','--porcelain','--untracked-files=all'],cwd=root,text=True).strip()
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=prior,text=True).strip()==predecessor
assert not subprocess.check_output(['git','status','--porcelain','--untracked-files=all'],cwd=prior,text=True).strip()
config='tsconfig.current591-neutral-file-definition-owned-source.json';owned=json.loads((root/config).read_text())['files']+[config];assert len(owned)==19
changed=subprocess.check_output(['git','diff','--name-only',base,current],cwd=root,text=True).splitlines();assert set(changed)==set(owned)
baseTree=tree(base);currentTree=tree(current);oldTree=tree(predecessor,prior);ownedPins={}
for path,entry in currentTree.items():
 p=root/path;assert p.is_file() and not p.is_symlink();assert subprocess.check_output(['git','hash-object','--',path],cwd=root,text=True).strip()==entry['blob']
 mode='100755' if p.stat().st_mode&0o111 else '100644';assert mode==entry['mode'],path
 if path in owned:
  assert entry==oldTree[path],path
  assert p.read_bytes()==show(predecessor,path,prior)==(prior/path).read_bytes(),path
  ownedPins[path]={**entry,'sha256':fileSha(p)}
 else:assert path in baseTree and entry==baseTree[path] and p.read_bytes()==show(base,path),path
assert set(baseTree)-set(currentTree)==set()
assert all(path in currentTree for path in baseTree)
patch=Path('/tmp/portable-current591-neutral-file-definition-owned-source.patch');assert fileSha(patch)=='0a13e163e22ba05ce1bffb7231afdfe8212ce07ea276575a28de14ff9a473986'
mapPath=Path('/tmp/portable-current591-neutral-file-definition-adoption-map.json');assert fileSha(mapPath)=='4f6f8e6ce1450648013a322ef9902fb5eef94741fe13493c8b292b318fb8c019'
peerPath=Path('/tmp/portable-current591-neutral18-worker9-independent-source-peer.json');assert fileSha(peerPath)=='85ac7142a88de69402cac785f99569d47aef7ed92f0a9bb97650704071163cab'
peer=json.loads(peerPath.read_text())
routes='worker/process-definition/routes.ts';original=show(base,routes).decode();assert original==show(oldbase,routes).decode();adopted=(root/routes).read_text();routeProof=[]
imports='''import { d1FileBusinessMetadataDatabase } from "../files/business-metadata-d1";
import { d1TemplateReferenceLifecycleDatabase } from "./reference-lifecycle-d1";
import { requirePublishedTemplateVersionWithDatabase, removeMetrologyReferenceWithDatabase, restoreMetrologyReferenceWithDatabase } from "./reference-lifecycle-service";
import { d1TemplateContentDatabase } from "./template-content-d1";
import { cloneTemplateWithDatabase, createTemplateStepWithDatabase, updateTemplateStepWithDatabase } from "./template-content-service";
'''
assert adopted.startswith(imports);inverse=adopted[len(imports):]
for row in peer['fiveRouteProofs']:
 marker=row['marker'];a=original.index(marker);b=original.index('\n});',a)+4;before=original[a:b];c=adopted.index(marker);d=adopted.index('\n});',c)+4;after=adopted[c:d]
 assert sha(before.encode())==row['before'] and sha(after.encode())==row['after'],marker
 a=inverse.index(marker);b=inverse.index('\n});',a)+4;inverse=inverse[:a]+before+inverse[b:]
 routeProof.append({'marker':marker,'current194OriginalSha256':sha(before.encode()),'exactPredecessorDelegateSha256':sha(after.encode())})
marker='async function requirePublishedTemplateVersion(db: D1Database, id: string) {'
a=original.index(marker);b=original.index('\n}',a)+2;c=inverse.index(marker);d=inverse.index('\n}',c)+2;inverse=inverse[:c]+original[a:b]+inverse[d:]
assert inverse==original
bulk=show(base,'worker/d1-bulk.ts').decode();assert bulk==show(oldbase,'worker/d1-bulk.ts').decode()
rows=(root/'worker/runtime/bulk-rows.ts').read_text();insert=(root/'worker/runtime/bulk-insert.ts').read_text()
chunk=rows[rows.index('export function chunkRows'):].rstrip('\n');a=bulk.index('export function chunkRows');b=bulk.index('\n\nexport function bulkInsertStatements',a);assert chunk==bulk[a:b]
function=insert[insert.index('export function bulkInsertStatementsWithDatabase'):].replace('export function bulkInsertStatementsWithDatabase<Statement>(', 'export function bulkInsertStatements(',1).replace('  db: { prepare(sql: string): { bind(...values: unknown[]): Statement } },','  db: D1Database,',1)
assert function==bulk[bulk.index('export function bulkInsertStatements'):]
maxConstant=rows.splitlines()[0];safeConstant=next(line for line in insert.splitlines() if line.startswith('const SAFE_SQL_IDENTIFIER'))
assert maxConstant=='const MAX_BOUND_PARAMETERS = 100;'
wholeBulk=maxConstant+'\n'+safeConstant+'\n\n'+chunk+'\n\n'+function;assert wholeBulk==bulk
# Recompute all relative references from the 18 explicit compiler roots. No compiler or module is executed.
queue=owned[:-1].copy();seen=set();edges=[];unresolved=[];external=set()
while queue:
 p=queue.pop()
 if p in seen:continue
 seen.add(p);text=(root/p).read_text()
 for spec in re.findall(r'(?:from\s+|import\s*(?:\(\s*)?)["\']([^"\']+)["\']',text):
  if not spec.startswith('.'):
   external.add(spec);continue
  normalized=posixpath.normpath(str(Path(p).parent/spec));candidate=Path(normalized)
  choices=([normalized] if candidate.suffix in ('.ts','.mts','.tsx','.json') else [])+[normalized+ext for ext in ('.ts','.mts','.tsx','.json')]+[str(candidate/'index.ts')]
  target=next((name for name in choices if name in currentTree),None)
  if target is None:unresolved.append({'from':p,'specifier':spec});continue
  edges.append((p,target));queue.append(target)
assert not unresolved
assert len(seen)==peer['relativeClosureModules']==97 and len(edges)==peer['relativeClosureEdges']==313
closurePins={}
for p in sorted(seen):
 assert (root/p).read_bytes()==show(predecessor,p,prior)==show(compilerHead,p,prior),p
 assert currentTree[p]==oldTree[p]==tree(compilerHead,prior)[p],p
 closurePins[p]=fileSha(root/p)
configs={}
for p in [config,'tsconfig.worker.json','package.json','package-lock.json']:
 assert (root/p).read_bytes()==show(predecessor,p,prior)==show(compilerHead,p,prior)
 configs[p]=fileSha(root/p)
changed591To194=subprocess.check_output(['git','diff','--name-only',oldbase,base],cwd=root,text=True).splitlines();assert not set(changed591To194)&seen
compilerPath=Path('/tmp/portable-current591-neutral-file-definition-owned-types-actual.json');assert fileSha(compilerPath)=='61b212542b9dad894a871ade8b41f5fccdca9f60593b2c4bb565a4188aa6e342'
compiler=json.loads(compilerPath.read_text());assert compiler['actualSourceHead']==compilerHead and compiler['status']=='PASS' and compiler['exitCode']==0
planPath=Path('/tmp/portable-current591-neutral-file-definition-original-worker-nine-finite-plan.json');plan=json.loads(planPath.read_text())
canonical=Path('/workspace/sample-fabrication-workflow');assert (root/'node_modules').is_symlink() and (root/'node_modules').resolve()==(prior/'node_modules').resolve()==canonical/'node_modules'
assert not root.stat().st_mode&0o077
for p in ['package.json','package-lock.json']:assert (root/p).read_bytes()==(canonical/p).read_bytes()
for v in plan['sourcePins']:assert fileSha(root/v['path'])==v['sha256'],v['path']
node=Path(plan['node']['path']);assert fileSha(node)==plan['node']['sha256']==compiler['nodeSha256']
for v in plan['dependencyEntrypointPins']:assert fileSha(canonical/v['path'])==v['sha256'],v['path']
assert fileSha(canonical/'node_modules/typescript/bin/tsc')==compiler['typescriptEntrypointSha256']
actualPath=Path('/tmp/portable-current591-neutral-file-definition-nine-owned-actual-attempt1/receipt.json');assert fileSha(actualPath)=='69e1920031ccdb96c5c72d88279f13b7ab90593b878204313c3eda8e7ed6ffac'
actual=json.loads(actualPath.read_text());assert actual['sourceHead']==predecessor and actual['status']=='PASS' and actual['actualSelectedPassed']==9 and actual['actualSelectedFailed']==0
for row in actual['steps']:
 assert row['exitCode']==row['actualExitCode']==0 and row['actualOriginalChildWaited'] and row['ownedClosureProven'] and not row['closureFinalSnapshot']
 assert fileSha(Path(row['logPath']))==row['logSha256'] and fileSha(Path(row['rawJsonPath']))==row['rawJsonSha256']
 assert fileSha(root/row['file'])==row['testFileSha256']
assert not subprocess.check_output(['git','status','--porcelain','--untracked-files=all'],cwd=root,text=True).strip()
proofPath=Path('/tmp/portable-current194-f5d2-neutral18-independent-adoption-source-peer.json')
proof={'kind':'current194-neutral18-independent-adoption-causal-source-peer/1','status':'CLEAR_SOURCE_ONLY','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceRoot':str(root),'sourceHead':current,'sourceTree':subprocess.check_output(['git','rev-parse','HEAD^{tree}'],cwd=root,text=True).strip(),'basisHead':base,'predecessorHead':predecessor,'allCurrentTrackedWorkingBlobsModesExact':True,'currentTrackedFiles':len(currentTree),'owned19ExactPredecessorModesBlobsAndBytes':True,'owned19Pins':ownedPins,'allCurrent194UnownedExact':True,'unownedCount':len(currentTree)-19,'noExtraOwnedPathChanges':True,'originalCurrent194RoutesWholeFileExact591':True,'fiveFullOriginalRoutesAndPredecessorDelegateHashes':routeProof,'wholeRoutesOutsideFiveDelegatesImportsAndPublishedBridgeInverseExact194':True,'bulkWholeOriginal100BindAlgorithmInverseExact194':True,'originalBulkSha256':sha(bulk.encode()),'recursiveRelativeCompiledScope':{'modules':97,'edges':313,'unresolvedRelativeImports':[],'allRelativeSourceModeBlobBytesExactActualCompiler1b3eAndPredecessor96':True,'aggregateModulePinSha256':sha(json.dumps(closurePins,sort_keys=True,separators=(',',':')).encode()),'configAndLockPins':configs,'actualCompilerImportedExternalSpecifiers':sorted(external),'591To194ChangedPathsIntersectCompiled97':[],'unrelatedUiStorageChangesOutsideOwnedWorkerCompilerScope':True},'dependencyBinding':{'currentAliasObservedAfterRootAddition':str(root/'node_modules'),'resolvedTarget':str(canonical/'node_modules'),'samePredecessorAlias':True,'currentRootPrivate0700':True,'canonicalPackageAndLockExact':True,'recorded7DependencyEntrypointsAndNodeBinaryHashesExact':True,'entireInstalledNpmTreeWasNotIndependentlyHashed':True},'historicalCompiler':{'receiptPath':str(compilerPath),'receiptSha256':fileSha(compilerPath),'actualSourceHead':compilerHead,'actualExitCode':0,'compilerScope97ConfigsLockedAndRecordedDependencyClosureEquivalent':True,'toolOriginalPidFdInventoryNotAvailableInOriginalReceipt':True,'newCompilerAtCurrentF5dExecuted':False},'historicalWorkerNine':{'receiptPath':str(actualPath),'receiptSha256':fileSha(actualPath),'actualSourceHead':predecessor,'actualSelectedPassed':9,'actualSelectedFailed':0,'allOriginalLogsAndRawJsonHashVerified':True,'actualSourceAndFixturePinsRemainUnchangedInCurrentAdoption':True,'newRuntimeAtCurrentF5dExecuted':False,'scope':actual['scope']},'inheritedProofReferences':[{'path':str(mapPath),'sha256':fileSha(mapPath)},{'path':str(peerPath),'sha256':fileSha(peerPath)},{'path':str(patch),'sha256':fileSha(patch)}],'reviewerCompilerInvocations':0,'reviewerNativeSocketProviderBuildInvocations':0,'missingCausalClosure':[],'limits':['Source equivalence does not move actual compiler1b3e or runtime96 observations to currentf5d.','Historical Worker9 selected SQLite compatibility/provider-double controls remain their exact original scope; no actualworkerd, installed Node/FileRequest authority, real R2 or physical lease ACK claim.','Locked dependencies and all recorded entrypoint hashes are exact; the original receipts did not pin every installed npm file, so no stronger complete installed-dependency-tree claim is made.','No new public File capability, Group enforcement, LocalVolume alias/provider activation or Node catalog/core adoption.']}
proofPath.write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps({'peerPath':str(proofPath),'peerSha256':fileSha(proofPath),'sourceHead':current,'currentTrackedFiles':len(currentTree),'ownedPaths':19,'unownedExact':len(currentTree)-19,'recursiveModules':97,'relativeEdges':313,'wholeRouteAndBulkInverseExact':True,'actualAliasExact':True,'missingCausalClosure':[],'reviewerEffects':0}))
