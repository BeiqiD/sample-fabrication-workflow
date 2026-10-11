"""Bind only the actual new Package focus build to its new isolated fixture.
Source-only carrier; no compiler/build/SQLite/socket/browser starts here.
"""
import hashlib,json,os,pathlib,subprocess,sys
SOURCE=pathlib.Path('/tmp/phase5f-package-preview-focus-current1943-source-attempt3')
COPY=pathlib.Path('/tmp/phase5f-package-preview-focus-fresh-build-copy-attempt3')
FIXTURE=pathlib.Path('/tmp/phase5f-package-preview-focus-fresh-build-fixture-attempt3')
RUNTIME=pathlib.Path('/tmp/phase5f-package-preview-focus-fresh-build-runtime-attempt3')
CONSUMER=pathlib.Path('/tmp/phase5f-package-preview-focus-fresh-producer-consumer-source-attempt3')
HEAD='ffff956c68e64e20b91b773d3bcb064642a37410'
TREE='6717c62026f486e241de222ae6d206e30a51ce96'
CONSUMER_HEAD='638fd7407a38fc24983b6014558ccaf1e80aae9e'
CONSUMER_TREE='8476845653757f328ae5c86d8b5010ad114a47e9'
HELPER='scripts/qa/phase5f/browser-genuine-package-preview.mjs'
HELPER_SHA='9e37a20d0f9a594086dc4e581958af2ce47d6fdb3ca3ebbb0a8b03eac7075ac9'
assert sys.argv[1:2]==['--fresh-package-focus-producer-for-two'] and len(sys.argv)==3
stage=sys.argv[2];assert stage in {'witness','final-pins'}
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def saved(path,value):
    with path.open('x') as file:os.chmod(path,0o600);json.dump(value,file,indent=2);file.write('\n')
for root,head,tree in [(SOURCE,HEAD,TREE),(CONSUMER,CONSUMER_HEAD,CONSUMER_TREE)]:
    assert subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()==head
    assert subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD^{tree}'],text=True).strip()==tree
    assert not subprocess.check_output(['git','-C',str(root),'status','--porcelain'])
    rows=subprocess.check_output(['git','-C',str(root),'ls-tree','-r','HEAD'],text=True).splitlines();assert len(rows)==1879
    for row in rows:
        info,name=row.split('\t');data=(root/name).read_bytes()
        assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==info.split()[-1],name
        if root==SOURCE and name!=HELPER:assert (CONSUMER/name).read_bytes()==data,name
assert sha(SOURCE/HELPER)=='17d8e5638d1e87afab9c8c9c2a95b3ee9bfd6839db9a3d83b326b050d47b1800'
assert sha(CONSUMER/HELPER)==HELPER_SHA
command=RUNTIME/'one-fresh-final-QA-source-build-command.json';actual=json.loads(command.read_bytes())
assert actual['status']=='PASS' and actual['argv']==['npm','run','build'] and actual['cwd']==str(SOURCE)
assert actual['exitCode']==0 and actual['ownedClosure']['directChildReaped'] and actual['ownedClosure']['noActiveOwnedProcessOrFd']
assert sha(pathlib.Path(actual['log']))==actual['logSha256']
assert not pathlib.Path('/proc',str(actual['pid'])).exists()
manifest=json.loads((RUNTIME/'fresh-build-artifact-manifest.json').read_bytes());assert manifest['sourceHead']==HEAD and manifest['sourceTree']==TREE
assert manifest['fileCount']==118 and len(manifest['files'])==118
for name,value in manifest['files'].items():assert sha(SOURCE/name)==value,name
isolation=json.loads((COPY/'isolation-receipt.json').read_bytes())
assert isolation['sourceHead']==HEAD and isolation['sourceTree']==TREE and isolation['sourceRoot']==str(SOURCE)
assert isolation['sourceCopyRoot']==str(COPY) and isolation['copiedState'] is False
assert len(isolation['trackedFiles'])==1879 and len(isolation['copiedArtifactFiles'])==121
for inventory in [isolation['trackedFiles'],isolation['copiedArtifactFiles']]:
    for name,value in inventory.items():assert sha(COPY/name)==value,name
for name,value in manifest['files'].items():assert isolation['copiedArtifactFiles'][name]==value,name
if stage=='witness':
    seed=json.loads((FIXTURE/'actual-api-fixture-receipt.json').read_bytes());assert seed['status']=='prepared' and len(seed['trace'])==84 and all(item['outcome']=='response_accepted' for item in seed['trace'])
    assert seed['sourceHead']==HEAD and seed['sourceCopyRoot']==str(COPY) and seed['fixtureDirectory']==str(FIXTURE)
    stop=json.loads((FIXTURE/'isolated-server-stop-receipt.json').read_bytes());assert stop['status']=='stopped' and stop['disposalAwaited'] and stop['portClosed']
    started=json.loads((FIXTURE/'isolated-server-receipt.json').read_bytes());assert started['sessionId']==stop['sessionId']==seed['serverSessionId']
    assert stop['startupReceiptSha256']==sha(FIXTURE/'isolated-server-receipt.json')
    assert not pathlib.Path('/proc',str(started['sessionPid'])).exists()
    owner=json.loads((RUNTIME/'owned-built-worker-command.json').read_bytes());assert owner['status']=='PASS' and owner['exitCode']==0 and owner['ownedClosure']['directChildReaped'] and owner['pid']==started['sessionPid']
    value={'status':'passed','command':['npm','run','build'],'actualExitCode':0,'directChildReaped':True,'sourceHead':HEAD,'sourceTree':TREE,
      'sourceRoot':str(SOURCE),'sourceCopyRoot':str(COPY),'trackedInputInventorySha256':digest(isolation['trackedFiles']),
      'workerSha256':isolation['activeBuild']['scriptSha256'],'activeBuildConfigSha256':isolation['activeBuild']['configSha256'],
      'copiedArtifactInventorySha256':digest(isolation['copiedArtifactFiles']),'originalCommandReceiptSha256':sha(command),
      'originalBuildLogSha256':actual['logSha256'],'freshDistFileCount':118,'copiedArtifactFileCount':121,
      'scope':'ONE actual samehead ffff Package focus product build, original build child exit0/reap and exact1879 source+118 artifacts. New isolated24/84 namespace/config are bound independently. QAconsumer current differs only one pinned helper;1878 other source bytes exact. No old f88 artifact carry.'}
    saved(FIXTURE/'enabled-storage-draft-build-input-witness.json',value)
else:
    report=json.loads((FIXTURE/'genuine-package-preview-browser-report.json').read_bytes())
    assert report['ownedClosure']['status']=='closed' and report['ownedClosure']['workerDisposeAwaited'] and report['ownedClosure']['workerPortRefused']
    assert report['ownedClosure']['browserCloseAwaited'] and report['ownedClosure']['jwksCloseAwaited'] and report['ownedClosure']['jwksPortRefused']
    assert report['sourceHead']==HEAD and report['sourceCopyRoot']==str(COPY) and report['fixtureDirectory']==str(FIXTURE)
    assert report['sourceWritePermitHistory']['originalRowsExact'] and report['sourceWritePermitHistory']['allOtherRowsAndCatalogExact'] and report['ownedClosure']['originalCatalogUnrelatedRowsAndOriginalPermitsVerified']
    assert report['helperSha256']==HELPER_SHA
    saved(RUNTIME/'final-fresh-package-focus-source-and-two-copy-pins.json',{'status':'PASS','actualProducerHead':HEAD,
      'all1879OriginalWorkingAndCopiedInputsExact':True,'all118OriginalOutputAnd121CopiedArtifactHashesExact':True,
      'originalBuildCommandReceiptSha256':sha(command),'newBrowserStatus':report['status'],'qaConsumerHead':CONSUMER_HEAD,
      'qaConsumerTree':CONSUMER_TREE,'retainedOriginalLeaseRowsExact':True,'allOtherPackageRowsAndCatalogPreserved':True,
      'newBrowserNormalClosure':report['ownedClosure'],'newBuilds':1})
print(json.dumps({'stage':stage,'status':'PASS','sourceHead':HEAD,'newBuilds':1,'sqliteConnections':0}))
