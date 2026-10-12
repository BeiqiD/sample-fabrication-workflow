"""Carry the original actual8be CF118 to one independent genuine Preview200/accept202 natural-focus browser characterization.
No runtime invocation is authorized by source. Root explicit exclusive GO only.
All historical paused lineages and prior artifact provenance remain untouched.
"""
import hashlib,json,os,pathlib,re,stat,subprocess,sys
SOURCE=pathlib.Path('/tmp/phase5f-package-file-refresh-start-focus-currentcb19-private-attempt1/source')
CONSUMER=pathlib.Path('/tmp/phase5f-package-file-current2d07-native-five-qa-private-attempt1/source')
COPY=pathlib.Path('/tmp/phase5f-file-current2d07-start202-focus-native-private-attempt1/copy')
FIXTURE=pathlib.Path('/tmp/phase5f-file-current2d07-start202-focus-native-private-attempt1/fixture')
CURRENT_RUNTIME=pathlib.Path('/tmp/phase5f-file-current2d07-start202-focus-native-private-attempt1/runtime')
ORIGINAL_RUNTIME=pathlib.Path('/tmp/phase5f-package-file-refresh-start-focus-currentcb19-private-attempt1/build-runtime')
SHORT_TEMP=pathlib.Path('/workspace/.sfst2')
PLAN=pathlib.Path('/tmp/phase5f-file-current2d07-start202-ordered-reader-finalpins-source-preparation-attempt1/finite-one-original-closed-file-ordered-reader-finalpins-plan.json')
HEAD='2d07b57c4e79403099261528ae8988c0072d28c6'
TREE='bf96bbcadd4c4d8a0ada525f639cf768d2d4eb90'
CONSUMER_HEAD='c316fe89ce79cd9d4d40627763bbe7ed029debbe'
CONSUMER_TREE='ba49c84bc748dd70469b9b1462029d8af30b770a'
DOMAIN='file'
assert sys.argv[1:2]==['--current02d-coherent-saved-job'] and len(sys.argv)==3
stage=sys.argv[2];assert stage in {'producer-preflight','witness','final-pins'}
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def digest(value):return hashlib.sha256(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def saved(path,value):
    with path.open('x') as file:os.chmod(path,0o600);json.dump(value,file,indent=2);file.write('\n')
plan=json.loads(PLAN.read_bytes());HELPER=pathlib.Path(plan['nativeHelperPath']).relative_to(CONSUMER).as_posix();HELPER_SHA=plan['ownedExtraQaLeaves'][HELPER]
for root,head,tree,count in [(SOURCE,HEAD,TREE,3181),(CONSUMER,CONSUMER_HEAD,CONSUMER_TREE,3186)]:
    assert subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()==head
    assert subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD^{tree}'],text=True).strip()==tree
    assert not subprocess.check_output(['git','-C',str(root),'status','--porcelain'])
    rows=subprocess.check_output(['git','-C',str(root),'ls-tree','-r','HEAD'],text=True).splitlines();assert len(rows)==count
    for row in rows:
        info,name=row.split('\t');data=(root/name).read_bytes()
        assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==info.split()[-1],name
        if root==SOURCE:assert (CONSUMER/name).read_bytes()==data,name
for name,value in plan['ownedExtraQaLeaves'].items():assert sha(CONSUMER/name)==value,name
assert len(plan['ownedExtraQaLeaves'])==5
assert not set(plan['ownedExtraQaLeaves'])&set(subprocess.check_output(['git','-C',str(SOURCE),'ls-files'],text=True).splitlines())
for field in ['actualFreshCurrentBuild','actualBuildManifest','currentAffectedApp59Formal','nativeSourceHandoff','nativeSourceFreeze']:
    proof=pathlib.Path(plan[field]['path']);assert sha(proof)==plan[field]['sha256']
command=ORIGINAL_RUNTIME/'one-fresh-final-QA-source-build-command.json';actual=json.loads(command.read_bytes())
assert actual['status']=='PASS' and actual['argv']==['npm','run','build'] and actual['cwd']==str(SOURCE)
assert actual['exitCode']==0 and actual['ownedClosure']['directChildReaped'] and actual['ownedClosure']['noActiveOwnedProcessOrFd']
assert sha(pathlib.Path(actual['log']))==actual['logSha256'] and not pathlib.Path('/proc',str(actual['pid'])).exists()
manifest=json.loads((ORIGINAL_RUNTIME/'fresh-build-artifact-manifest.json').read_bytes())
assert manifest['sourceHead']==HEAD and manifest['sourceTree']==TREE and manifest['fileCount']==len(manifest['files'])==118
for name,value in manifest['files'].items():assert sha(SOURCE/name)==value,name
assert os.environ['TMPDIR']==str(COPY.parent) and os.environ['SQLITE_TMPDIR']==str(COPY.parent)
assert stat.S_IMODE(CURRENT_RUNTIME.stat().st_mode)==0o700 and not CURRENT_RUNTIME.is_symlink()
if stage=='producer-preflight':
    assert not COPY.exists() and not COPY.is_symlink() and not FIXTURE.exists() and not FIXTURE.is_symlink()
    assert not SHORT_TEMP.exists() and not SHORT_TEMP.is_symlink()
    saved(CURRENT_RUNTIME/'current02d-build-new-pure24-native-causal-carry.json',{'status':'PASS','domain':DOMAIN,
      'producerHead':HEAD,'producerTree':TREE,'qaConsumerHead':CONSUMER_HEAD,'qaConsumerTree':CONSUMER_TREE,
      'originalBuildCommandReceiptSha256':sha(command),'originalBuildLogSha256':actual['logSha256'],
      'originalProducerCount':3181,'all3181ProducerInputsOnConsumerExact':True,'extraNativeQaInputs':plan['ownedExtraQaLeaves'],
      'actualOriginalArtifacts':118,'newBuilds':0,'freshIndependentPure24FixtureRequired':True,'disabledSeedRequests':0,
      'setupPOSTMaximum':6,'originalNativeMetadataPOSTMaximum':2,'maximumTotalPOSTs':8,
      'oldPausedLineagesNotOpenedOrChanged':True})
    print(json.dumps({'stage':stage,'status':'PASS','domain':DOMAIN,'newBuilds':0,'newFixtureStillRequired':True}));sys.exit(0)
isolation=json.loads((COPY/'isolation-receipt.json').read_bytes())
assert isolation['sourceHead']==HEAD and isolation['sourceTree']==TREE and isolation['sourceRoot']==str(SOURCE)
assert isolation['sourceCopyRoot']==str(COPY) and isolation['copiedState'] is False
assert len(isolation['trackedFiles'])==3181 and len(isolation['copiedArtifactFiles'])==121
assert isolation['helperSha256']==plan['copiedOrdinaryPrepareHelperSha256']
for inventory in [isolation['trackedFiles'],isolation['copiedArtifactFiles']]:
    for name,value in inventory.items():assert sha(COPY/name)==value,name
for name,value in manifest['files'].items():assert isolation['copiedArtifactFiles'][name]==value,name
for name in ['actual-api-fixture-receipt.json','isolated-server-session.json','isolated-server-receipt.json','isolated-server-stop-receipt.json']:
    assert not (FIXTURE/name).exists() and not (FIXTURE/name).is_symlink(),name
if stage=='witness':
    before=json.loads((FIXTURE/'physical-sqlite-before-api.json').read_bytes())
    assert before['status']=='passed' and len(before['results'])==2 and before['sourceHead']==HEAD
    assert before['isolationReceiptSha256']==sha(COPY/'isolation-receipt.json')
    assert all(value['quickCheck']==[['ok']] and not value['foreignKeyCheck'] for value in before['results'].values())
    assert len([name for name in before['results'] if '/r2/' in name])==0
    value={'status':'passed','command':['npm','run','build'],'actualExitCode':0,'directChildReaped':True,'sourceHead':HEAD,'sourceTree':TREE,
      'sourceRoot':str(SOURCE),'sourceCopyRoot':str(COPY),'trackedInputInventorySha256':digest(isolation['trackedFiles']),
      'workerSha256':isolation['activeBuild']['scriptSha256'],'activeBuildConfigSha256':isolation['activeBuild']['configSha256'],
      'copiedArtifactInventorySha256':digest(isolation['copiedArtifactFiles']),'originalCommandReceiptSha256':sha(command),
      'originalBuildLogSha256':actual['logSha256'],'freshDistFileCount':118,'copiedArtifactFileCount':121,
      'scope':'Actual original2d07 ONECF118 source3181/QA3186 all3181 ordinary bytes exact plus5 reviewed Refresh and Start202 QA; current2d07 App59 actualPASS is separate affected scope. This independent Start202 namespace records one Preview200 and accept202 only; no control/executor/replay. Independent new pure24/sentinels beforeAPI; no historicala7 artifacts/pausedjobs borrowed, no additionalbuild/84seed/old63permits or seedWorker lifecycle.'}
    saved(FIXTURE/'enabled-storage-draft-build-input-witness.json',value)
    assert not SHORT_TEMP.exists() and not SHORT_TEMP.is_symlink()
    assert SHORT_TEMP.parent==pathlib.Path('/workspace') and not SHORT_TEMP.parent.is_symlink() and SHORT_TEMP.parent.resolve()==SHORT_TEMP.parent
    space=os.statvfs(SHORT_TEMP.parent);assert space.f_bavail*space.f_frsize>0
    SHORT_TEMP.mkdir(mode=0o700);info=SHORT_TEMP.lstat()
    assert stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode)==0o700 and info.st_uid==os.getuid()
    assert not SHORT_TEMP.is_symlink() and SHORT_TEMP.resolve()==SHORT_TEMP
    saved(CURRENT_RUNTIME/'chromium-child-temp-owner.json',{'path':str(SHORT_TEMP),'mode':'0700','uid':os.getuid(),
      'dev':str(info.st_dev),'ino':str(info.st_ino),'freshCreated':True,'sourceHead':HEAD,'sourceCopyRoot':str(COPY),
      'fixtureDirectory':str(FIXTURE),'qaHelperSha256':HELPER_SHA,'freeBytes':str(space.f_bavail*space.f_frsize),
      'scope':'Original Chromiumchildonly temporary leaf; parent TMPDIR/COPY/FIXTURE ownership unchanged.'})
else:
    owner_path=CURRENT_RUNTIME/(plan['nativeStage']+'-command.json');owner=json.loads(owner_path.read_bytes())
    assert owner['ownedClosure']['directChildReaped'] and owner['ownedClosure']['noActiveOwnedProcessOrFd']
    assert not owner['ownedClosure']['unexpectedLingeringOwner'] and not owner['ownedClosure']['ownedCleanupSignals']
    assert owner['exitCode'] in [0,1] and not pathlib.Path('/proc',str(owner['pid'])).exists()
    physical=json.loads((FIXTURE/('physical-sqlite-after-current-'+DOMAIN+'-status-refresh-keyboard.json')).read_bytes())
    assert physical['status']=='passed' and physical['originalStateBytesUnchanged'] and physical['originalNativeCommandSha256']==sha(owner_path)
    stem='genuine-'+DOMAIN+'-start202-natural-focus';report_path=FIXTURE/(stem+'-report.json')
    native={'status':'unqualified-no-report','originalCommandStatus':owner['status']}
    if report_path.exists():
        report=json.loads(report_path.read_bytes());closure=report['ownedClosure']
        assert report['sourceHead']==HEAD and report['sourceTree']==TREE and report['sourceCopyRoot']==str(COPY) and report['fixtureDirectory']==str(FIXTURE)
        assert report['sessionPid']==owner['pid'] and report['helperSha256']==HELPER_SHA and report['isolationReceiptSha256']==sha(COPY/'isolation-receipt.json')
        assert json.loads((FIXTURE/(stem+'-stop.json')).read_bytes())==closure
        assert report['currentQaInputScope']=={'producerOrdinaryTrackedCount':3181,'allProducerTrackedBytesExact':True,
          'executedIsolationHelperSha256':plan['copiedOrdinaryPrepareHelperSha256'],'addedBrowserHelperSha256':HELPER_SHA}
        native={'status':report['status'],'reportSha256':sha(report_path),'ownedClosure':closure,'actualCosts':report['actualCosts'],'unrunCases':report['unrunCases']}
        prepared=report.get('genuinePreparation')
        if prepared:
            native['genuinePreparationStatus']=prepared['status']
            assert prepared['derivedRuntimeNamespace']['originalCopiedConfigChanged'] is False
            assert prepared['derivedRuntimeNamespace']['installationId']!=json.loads(json.loads((COPY/'.wrangler/deploy.jsonc').read_bytes())['vars']['R2_BOOTSTRAP_NAMESPACE'])['installationId']
            native['originalPreparationOwnerClosure']=prepared.get('ownedClosure')
            if prepared['status']=='prepared':
                assert prepared['setupWritePermitEvidence']['count']==6 and prepared['setupWritePermitEvidence']['allReleased']
                assert prepared['sourceFile']['sourceBucketRealBytesMatched'] and prepared['sourceFile']['targetBucketEmpty'] and physical['genuineUploadPhysicalPNGMatched']
        if report['status']=='passed':
            assert owner['status']=='PASS' and owner['exitCode']==0 and closure['status']=='closed' and closure['browserCloseAwaited']
            assert not closure.get('noReturnedBrowserHandle',False) and not report['unrunCases'] and len(report['cases'])==1
            assert prepared['status']=='prepared';pclosed=closure['originalPreparationOwnerClosure']
            assert pclosed['status']=='closed' and pclosed['workerDisposeAwaited'] and pclosed['workerPortRefused'] and pclosed['jwksCloseAwaited'] and pclosed['jwksPortRefused']
            assert pclosed['originalRequestsAwaited']['rejected']==0 and pclosed['originalOutboundWorkAwaited']['rejected']==0
            costs=report['actualCosts'];expected_setup=6 if DOMAIN=='file' else 7
            assert costs['setupPOSTs']==expected_setup and costs['readerGETs']==2 and costs['nativeMetadataPOSTs']==2
            assert costs['maxSetupPOSTs']==expected_setup and costs['maxNativePOSTs']==2 and costs['observedAcceptedJobReceipts']==1 and costs['newExecutorSteps']==0
            assert costs['setupPOSTs']+costs['nativeMetadataPOSTs']==plan['expectedCosts']['maximumTotalPOSTs']
            if DOMAIN=='package':
                assert costs['ordinaryResearchPreparationPOSTs']==1
                sample=report['ordinarySamplePreparation'];assert sample['state']=='accepted' and sample['status']==201 and sample['body']=='completed'
                assert re.fullmatch(r'[a-f0-9]{64}',sample['responseSha256']) and sample['exactSampleShadowEffects']['epochDelta']==2 and sample['exactSampleShadowEffects']['allEarlierDependencyRowsExact']
            assert len(report['readerRequests'])==2 and [(item['path'],item['method'],item['status']) for item in report['readerRequests']]==[('/api/storage/configuration/capability','GET',200),('/api/files/migrations','GET',403)] and all(item['body']=='completed' and re.fullmatch(r'[a-f0-9]{64}',item['sha256']) for item in report['readerRequests'])
            for audit in [report['finalCatalog'],*[case['originalCatalogAndSourceBytes'] for case in report['cases']],*[case['acceptedJobHistory'] for case in report['cases']]]:
                assert audit['old6PermitsExact'] and audit['oldHoldsExact'] and audit['newReleasedPermits']==(2 if DOMAIN=='file' else 3)
                assert audit['jobState']=='queued' and audit['jobGeneration']==0 and audit['executorDisabled'] and audit['sourceBytesExact'] and audit['targetEmpty']
                if DOMAIN=='file':assert audit['onlyExactOneJobOneItemOneHoldAndReleasedPermitsChanged'] and audit['migrationAttempts']==0
                else:assert audit['onlyExactPackageJobRequestTwoCapturedRecordsAndReleasedPermitsChanged'] and audit['packageFiles']==0 and audit['packageAttempts']==0
            for case in report['cases']:
                assert case['status']=='passed' and case['contextCloseAwaited'] and case['id']==plan['cases'][0]
                assert case['width']==1280 and case['height']==1000 and case['theme']=='light'
                for key in ['originalRoutesAwaited','originalBodiesAwaited','originalWaitsAwaited']:assert case[key]['rejected']==0
                assert len(case['api'])==len(case['requests'])==costs['nativeGETs']+2
                assert len([r for r in case['requests'] if r['method']=='POST'])==2
                assert all(item['body']=='completed' and re.fullmatch(r'[a-f0-9]{64}',item['sha256']) for item in case['api'])
                posts=[item for item in case['api'] if item['method']=='POST'];assert [item['status'] for item in posts]==[200,202] and all(item['exactOriginalBackendMatches'] for item in posts)
                assert all(item['status']==200 for item in case['api'] if item['method']=='GET')
                assert [entry['action'] for entry in case['backendResponses']]==['preview','accept']
                assert all(entry['state']=='accepted' and entry['body']=='completed' and entry['nativeDelivery']=='fulfilled' for entry in case['backendResponses'])
                initial=next(item for item in case['assertions'] if 'originalAccept202' in item)
                assert initial['originalAccept202'] and initial['startRemoved'] and initial['initialJobState']=='queued'
                focus=initial['settledNaturalFocus'];assert focus['connected'] and focus['active'] and focus['focusVisible'] and not focus['disabled']
                preview=next(item['nativePreviewFocus'] for item in case['assertions'] if 'nativePreviewFocus' in item)
                assert preview['active'] and preview['focusVisible'] and not preview['disabled']
                geometry=next(item['geometry'] for item in case['assertions'] if 'geometry' in item)
                assert geometry['width']==1280 and geometry['theme']=='light' and geometry['root']<=1282 and geometry['body']<=1282
                assert all(not case[key] for key in ['pageErrors','externalRequests'])
    else:
        assert owner['status']=='FAILED' and owner['exitCode']==1 and physical.get('nativeReportObserved') is False
        native['scope']='No application lifecycle report; physical/directchild cleanup only, no normalfinally or nativecase qualification.'
    saved(pathlib.Path('/tmp/phase5f-file-current2d07-start202-ordered-reader-finalpins-private-attempt1/runtime/final-current2d07-file-start202-ordered-reader-source-pins.json'),{'status':'PASS','domain':DOMAIN,'producerHead':HEAD,'qaConsumerHead':CONSUMER_HEAD,
      'all3181ProducerAndCopiedInputsExact':True,'all3181OrdinaryQaInputsExact':True,'fiveOwnedCurrentPackageFileFocusQaInputs':plan['ownedExtraQaLeaves'],'all3186QaInputsBytePinned':True,'actualOriginalArtifacts':118,'copiedArtifacts':121,
      'newBuilds':0,'disabledSeedRequests':0,'nativeQualification':native,'originalChildWaitReapAndGroup':owner['ownedClosure'],
      'physicalStatus':physical['status'],'physicalActualSQLiteGroups':len(physical['results']),'oldAcceptedNamespacesSeparateAndUntouched':True})
print(json.dumps({'stage':stage,'status':'PASS','domain':DOMAIN,'producerHead':HEAD,'qaConsumerHead':CONSUMER_HEAD,'newBuilds':0,'disabledSeedRequests':0}))
