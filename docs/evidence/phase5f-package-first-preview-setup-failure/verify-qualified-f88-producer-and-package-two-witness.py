"""Only read qualified producer bytes, or bind its actual build to a new fixture.
No compiler/build/Worker/browser starts here. SQLite is handled by the existing
separately scheduled physical checker, never by this carrier.
"""
import hashlib,json,os,pathlib,subprocess,sys
SOURCE=pathlib.Path('/tmp/phase5f-storage-candidate-section-wrap-source-attempt10')
COPY=pathlib.Path('/tmp/phase5f-package-two-genuine-preview-copy-attempt1')
FIXTURE=pathlib.Path('/tmp/phase5f-package-two-genuine-preview-fixture-attempt1')
RUNTIME=pathlib.Path('/tmp/phase5f-package-two-genuine-preview-runtime-attempt1')
PRODUCER=pathlib.Path('/tmp/phase5f-storage-candidate-section-wrap-runtime-attempt10')
CLOSED=PRODUCER/'actual-storage-candidate-section-f88-eight-pass-closed-and-released.json'
HEAD='f88fffea3ba0654b52ca90ee87efdafdb70cd48c'
TREE='df05a78afcdee28f7136a349001464c399531e9c'
CONSUMER=pathlib.Path('/tmp/phase5f-package-two-preview-genuine-context-source-attempt2')
CONSUMER_HEAD='f50384811b2d16fd64847cf10f622719bed0481a'
CONSUMER_TREE='7203dba65e001382fe12c90e81c0353de4aa1f25'
STORAGE_CLOSED=pathlib.Path('/tmp/phase5f-storage-original-two-after-wrap-runtime-attempt11/actual-original-storage-two-after-wrap-pass-closed-and-released.json')
assert sys.argv[1:2]==['--qualified-f88-producer-for-package-two'] and len(sys.argv)==3
stage=sys.argv[2];assert stage in {'producer','witness','final-pins'}
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def saved(path,value):
    with path.open('x') as file:os.chmod(path,0o600);json.dump(value,file,indent=2);file.write('\n')
assert sha(CLOSED)=='51bac259cf336bf9c4e04b26ed88566a884e39e257c1d5e1d6082a09d9ae7727'
assert sha(STORAGE_CLOSED)=='3c4076f1d942261f8e2099520a825840db1ecc74e8bb54fd60b071b5799535cb'
storage=json.loads(STORAGE_CLOSED.read_bytes());assert storage['status']=='PASS' and storage['ownershipStatus']=='CLOSED'
assert storage['browserCases']['passed']==2 and storage['browserCases']['failed']==0 and storage['browserCases']['unrun']==0
for item in storage['rawRecords']:assert sha(pathlib.Path(item['path']))==item['sha256'],item['path']
assert subprocess.check_output(['git','-C',str(CONSUMER),'rev-parse','HEAD'],text=True).strip()==CONSUMER_HEAD
assert subprocess.check_output(['git','-C',str(CONSUMER),'rev-parse','HEAD^{tree}'],text=True).strip()==CONSUMER_TREE
assert not subprocess.check_output(['git','-C',str(CONSUMER),'status','--porcelain'])
consumer_rows=subprocess.check_output(['git','-C',str(CONSUMER),'ls-tree','-r','HEAD'],text=True).splitlines();assert len(consumer_rows)==1793
for row in consumer_rows:
    info,name=row.split('\t');data=(CONSUMER/name).read_bytes()
    assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==info.split()[-1],name
assert sha(CONSUMER/'scripts/qa/phase5f/browser-genuine-package-preview.mjs')=='d62c4822bf0c15f3bf4e00ebb9e09d3ccd6edf0b71d1653655d59ea418d0fb87'
qualified=json.loads(CLOSED.read_bytes());assert qualified['status']=='PASS' and qualified['ownershipStatus']=='CLOSED'
assert qualified['sourceHead']==HEAD and qualified['sourceTree']==TREE and qualified['sourceRoot']==str(SOURCE)
for item in qualified['rawRecords']:assert sha(pathlib.Path(item['path']))==item['sha256'],item['path']
for owner in qualified['owners']:
    assert owner['originalDirectReaped'] and not pathlib.Path('/proc',str(owner['originalDirectPid'])).exists()
assert subprocess.check_output(['git','-C',str(SOURCE),'rev-parse','HEAD'],text=True).strip()==HEAD
assert subprocess.check_output(['git','-C',str(SOURCE),'rev-parse','HEAD^{tree}'],text=True).strip()==TREE
assert not subprocess.check_output(['git','-C',str(SOURCE),'status','--porcelain'])
rows=subprocess.check_output(['git','-C',str(SOURCE),'ls-tree','-r','HEAD'],text=True).splitlines();assert len(rows)==1792
for row in rows:
    info,name=row.split('\t');data=(SOURCE/name).read_bytes()
    assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==info.split()[-1],name
    assert (CONSUMER/name).read_bytes()==data,name
command=PRODUCER/'one-fresh-final-QA-source-build-command.json';actual=json.loads(command.read_bytes())
assert actual['status']=='PASS' and actual['argv']==['npm','run','build'] and actual['cwd']==str(SOURCE)
assert actual['exitCode']==0 and actual['ownedClosure']['directChildReaped'] and actual['ownedClosure']['noActiveOwnedProcessOrFd']
assert sha(pathlib.Path(actual['log']))==actual['logSha256']
manifest=json.loads((PRODUCER/'fresh-build-artifact-manifest.json').read_bytes());assert manifest['sourceHead']==HEAD and manifest['sourceTree']==TREE
assert manifest['fileCount']==118 and len(manifest['files'])==118
for name,value in manifest['files'].items():assert sha(SOURCE/name)==value,name
if stage=='producer':
    assert not COPY.exists() and not FIXTURE.exists()
    saved(RUNTIME/'qualified-f88-producer-before-package-two.json',{'status':'PASS','actualOriginalProducerHead':HEAD,'actualOriginalProducerTree':TREE,
      'originalClosedReceiptSha256':sha(CLOSED),'originalBuildCommandReceiptSha256':sha(command),'freshBuildOutputs':118,
      'all1792OriginalSourceWorkingInputsExact':True,'newBuilds':0,'newFixturesNotStarted':True})
else:
    isolation=json.loads((COPY/'isolation-receipt.json').read_bytes())
    assert isolation['sourceHead']==HEAD and isolation['sourceTree']==TREE and isolation['sourceRoot']==str(SOURCE)
    assert isolation['sourceCopyRoot']==str(COPY) and isolation['copiedState'] is False
    assert len(isolation['trackedFiles'])==1792 and len(isolation['copiedArtifactFiles'])==121
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
          'originalBuildLogSha256':actual['logSha256'],'actualProducerClosedReceiptSha256':sha(CLOSED),'freshDistFileCount':118,'copiedArtifactFileCount':121,
          'scope':'Reuse ONLY actual qualified freshf88 build; new isolated24/84 fixture has its own generated namespace/config hashes. No redundant build or original01/95 product artifact carry.'}
        saved(FIXTURE/'enabled-storage-draft-build-input-witness.json',value)
    else:
        report=json.loads((FIXTURE/'genuine-package-preview-browser-report.json').read_bytes())
        assert report['ownedClosure']['status']=='closed' and report['ownedClosure']['workerDisposeAwaited'] and report['ownedClosure']['workerPortRefused']
        assert report['ownedClosure']['browserCloseAwaited'] and report['ownedClosure']['jwksCloseAwaited'] and report['ownedClosure']['jwksPortRefused']
        assert report['sourceHead']==HEAD and report['sourceCopyRoot']==str(COPY) and report['fixtureDirectory']==str(FIXTURE)
        assert report['sourceWritePermitHistory']['originalRowsExact'] and report['sourceWritePermitHistory']['allOtherRowsAndCatalogExact'] and report['ownedClosure']['originalCatalogUnrelatedRowsAndOriginalPermitsVerified']
        assert report['helperSha256']==sha(CONSUMER/'scripts/qa/phase5f/browser-genuine-package-preview.mjs')
        saved(RUNTIME/'final-qualified-f88-source-and-package-two-copy-pins.json',{'status':'PASS','originalActualProducerHead':HEAD,
          'all1792OriginalWorkingAndCopiedInputsExact':True,'all118OriginalOutputAnd121CopiedArtifactHashesExact':True,
          'originalBuildCommandReceiptSha256':sha(command),'originalProducerClosedReceiptSha256':sha(CLOSED),
          'newBrowserStatus':report['status'],'qaConsumerHead':CONSUMER_HEAD,'qaConsumerTree':CONSUMER_TREE,'retainedOriginalLeaseRowsExact':True,'allOtherPackageRowsAndCatalogPreserved':True,
          'newBrowserNormalClosure':report['ownedClosure'],'noNewBuild':True})
print(json.dumps({'stage':stage,'status':'PASS','sourceHead':HEAD,'newBuilds':0,'sqliteConnections':0}))
