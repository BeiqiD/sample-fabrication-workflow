// Two native supported File migration previews, on an independent installation.
// Six genuine setup writes + two preview POSTs. Never accept/execute a migration.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, realpath, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareGenuineTwoR2MigrationRuntime } from './prepare-genuine-two-r2-migration-runtime.mjs';

const [sourceValue,fixtureValue,producerHead,permit,...extra]=process.argv.slice(2);
assert(sourceValue&&fixtureValue&&producerHead==='a7d64919f28477adcd3923809a63d1c1f9cc0561'
  &&permit==='--exclusive-go-two-genuine-local-r2-file-migration-previews'&&!extra.length);
assert(process.stdin.isTTY,'Retain original interactive control before any owner startup.');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,item)=>item instanceof ArrayBuffer?{bytes:Buffer.from(item).toString('hex')}
  :ArrayBuffer.isView(item)?{bytes:Buffer.from(item.buffer,item.byteOffset,item.byteLength).toString('hex')}:item);
const temporary=await realpath(resolve(tmpdir()));
const within=(root,value)=>{const part=relative(root,value);return part&&!part.startsWith(`..${sep}`)&&part!=='..'&&!isAbsolute(part);};
async function privateRoot(value){assert(isAbsolute(value)&&!value.split(/[\\/]/).includes('..'));const path=resolve(value);assert(within(temporary,path));
  let current=temporary;for(const part of relative(temporary,path).split(sep)){current=resolve(current,part);const info=await lstat(current);assert(info.isDirectory()&&!info.isSymbolicLink());}
  const info=await lstat(path);assert.equal(info.mode&0o777,0o700);assert.equal(info.uid,process.getuid());assert.equal(await realpath(path),path);return path;}
const source=await privateRoot(sourceValue),fixtureRoot=await privateRoot(fixtureValue);assert(source!==fixtureRoot&&!within(source,fixtureRoot)&&!within(fixtureRoot,source));
async function file(root,name){assert(name&&!isAbsolute(name)&&!name.split(/[\\/]/).includes('..'));const path=resolve(root,name);assert(within(root,path));
  let current=root;for(const part of relative(root,path).split(sep)){current=resolve(current,part);assert(!(await lstat(current)).isSymbolicLink());}
  assert((await lstat(path)).isFile());return path;}
async function json(root,name){return JSON.parse(await readFile(await file(root,name),'utf8'));}
async function writeOnce(path,value){await writeFile(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
async function absentFile(path){try{await lstat(path);assert.fail('Preserve old outputs; require new isolated fixture.');}catch(error){if(error.code!=='ENOENT')throw error;}}
const isolation=await json(source,'isolation-receipt.json'),fixture=await json(fixtureRoot,'process-fixture.json');
assert.equal(isolation.sourceHead,producerHead);assert.equal(isolation.sourceCopyRoot,source);assert.equal(isolation.copiedState,false);
assert.equal(Object.keys(isolation.trackedFiles).length,2438);
const consumer=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const currentQaInputScope={copiedBrowserSha256:'ab28d1f9a029da6dd4280dff2e72abaa8b2a5311ba37306abaefb40f8ca73044',copiedPhysicalCheckerSha256:'023680c42275a421b7169d38741be870db80ca3d02d4ebc2e282a0aecb408798',executedPhysicalCheckerSha256:'c3b3cf7bb9c28f7163eb399d8054395a5ee99e739e4b8c38691d28938adcb99d',copiedIsolationHelperSha256:'45d6096ade96f69502da95eb929a0a24b49ca2100032e856a4972875b40f0168',executedIsolationHelperSha256:'fba64e958ba1042a7ea406ef9d502ce12829c194c4ec3ea65ee447b3f3105292'};
assert.equal(isolation.helperSha256,currentQaInputScope.executedIsolationHelperSha256);
for(const [name,value] of Object.entries(isolation.trackedFiles)){
  assert.equal(sha(await readFile(await file(source,name))),value,name);
  if(name==='scripts/qa/phase5f/browser-genuine-two-r2-file-migration-preview.mjs')assert.equal(value,currentQaInputScope.copiedBrowserSha256);
  else if(name==='scripts/qa/phase5f/check-genuine-two-r2-migration-state.py'){assert.equal(value,currentQaInputScope.copiedPhysicalCheckerSha256);assert.equal(sha(await readFile(await file(consumer,name))),currentQaInputScope.executedPhysicalCheckerSha256);}
  else if(name==='scripts/qa/phase5f/prepare-isolated-copy.py'){assert.equal(value,currentQaInputScope.copiedIsolationHelperSha256);assert.equal(sha(await readFile(await file(consumer,name))),currentQaInputScope.executedIsolationHelperSha256);}
  else assert.equal(sha(await readFile(await file(consumer,name))),value,name);
}
for(const [name,value] of Object.entries(isolation.copiedArtifactFiles))assert.equal(sha(await readFile(await file(source,name))),value,name);
assert.equal(fixture.sourceCopyRoot,source);assert.equal(fixture.fixtureDirectory,fixtureRoot);assert.equal(fixture.sourceHead,producerHead);
const isolationHash=sha(await readFile(await file(source,'isolation-receipt.json')));assert.equal(fixture.isolationReceiptSha256,isolationHash);
assert.equal(sha(await readFile(await file(fixtureRoot,'process-fixture.sql'))),fixture.sqlSha256);
for(const name of ['actual-api-fixture-receipt.json','isolated-server-session.json','isolated-server-receipt.json','isolated-server-stop-receipt.json'])await absentFile(resolve(fixtureRoot,name));
const physical=await json(fixtureRoot,'physical-sqlite-before-api.json');assert.equal(physical.status,'passed');assert.equal(physical.sourceHead,producerHead);assert.equal(physical.isolationReceiptSha256,isolationHash);
assert.equal(Object.keys(physical.results).length,2);assert(Object.values(physical.results).every(value=>value.quickCheck.length===1&&value.quickCheck[0][0]==='ok'&&!value.foreignKeyCheck.length));
const witness=await json(fixtureRoot,'enabled-storage-draft-build-input-witness.json');assert.equal(witness.status,'passed');assert.deepEqual(witness.command,['npm','run','build']);
assert.equal(witness.actualExitCode,0);assert.equal(witness.directChildReaped,true);assert.equal(witness.sourceHead,producerHead);assert.equal(witness.sourceTree,isolation.sourceTree);
assert.equal(witness.sourceRoot,isolation.sourceRoot);assert.equal(witness.trackedInputInventorySha256,sha(JSON.stringify(isolation.trackedFiles)));
assert.equal(witness.workerSha256,isolation.activeBuild.scriptSha256);assert.equal(witness.activeBuildConfigSha256,isolation.activeBuild.configSha256);
assert.equal(witness.copiedArtifactInventorySha256,sha(JSON.stringify(isolation.copiedArtifactFiles)));assert.match(witness.originalCommandReceiptSha256,/^[a-f0-9]{64}$/);
const config=await json(source,'.wrangler/deploy.jsonc');
const {productionWorkerArtifact}=await import(pathToFileURL(await file(source,'scripts/production-worker-artifact.mjs')));const artifact=await productionWorkerArtifact(source);
assert.equal(artifact.scriptPath,await file(source,isolation.activeBuild.scriptPath));assert.equal(sha(await readFile(artifact.scriptPath)),isolation.activeBuild.scriptSha256);
const require=createRequire(resolve(source,'package.json'));assert.equal(await realpath(resolve(source,'node_modules')),isolation.nodeModulesRoot);
const {chromium}=require(resolve(process.env.PLAYWRIGHT_MODULE_PATH));assert(process.env.CHROMIUM_PATH);
const {build,stop}=require('esbuild');let checkedInput,checkedSettings;
try{for(const [name,exportName] of [['shared/contracts/file-jobs.ts','checkedAcceptFileMigration'],['shared/contracts/current-storage-settings.ts','checkedCurrentStorageSettings']]){
  const contents=await readFile(await file(source,name),'utf8');const compiled=await build({stdin:{contents,loader:'ts',sourcefile:name,resolveDir:resolve(source,name.slice(0,name.lastIndexOf('/')))},bundle:true,
    write:false,platform:'node',format:'esm',target:'es2022',logLevel:'silent'});assert.equal(compiled.outputFiles.length,1);assert.equal(compiled.warnings.length,0);
  const executable=compiled.outputFiles[0].text;assert(!/\bimport\s*(?:\(|[^;]*\bfrom\b)/.test(executable));
  const value=(await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`))[exportName];
  if(exportName==='checkedAcceptFileMigration')checkedInput=value;else checkedSettings=value;
}}finally{await stop();} // Public stop request only; actual native groups are separately supervised.

const base=new URL('http://127.0.0.1:4219/'),ids=['genuine-file-migration-preview-1280-light','genuine-file-migration-preview-390-dark'];
const output=resolve(fixtureRoot,'genuine-two-r2-file-migration-preview-artifacts'),reportPath=resolve(fixtureRoot,'genuine-two-r2-file-migration-preview-report.json'),stopPath=resolve(fixtureRoot,'genuine-two-r2-file-migration-preview-stop.json');
for(const path of [output,reportPath,stopPath])await absentFile(path);await mkdir(output,{mode:0o700});
const report={status:'running',sourceCopyRoot:source,fixtureDirectory:fixtureRoot,sourceHead:producerHead,sourceTree:isolation.sourceTree,
  sessionPid:process.pid,helperSha256:sha(await readFile(new URL(import.meta.url))),isolationReceiptSha256:isolationHash,currentQaInputScope,expectedCases:ids,cases:[],readerRequests:[],startedAt:new Date().toISOString(),
  scope:'Two genuine local-R2 File migration preview metadata actions; fresh current24 plus pure template sentinel. Separate real local binding installation and two actual R2 capabilities, genuine Access verification and distinct operator/admin allowlists. Six setup writes and at most2 preview POSTs, no migration acceptance/executor/transfer/GC/ZIP/provider/recovery target.'};
let owner,browser,originalBrowserClose,originalStop;const contexts=new Set(),closes=new WeakMap();
const privateValues=new Set(['migration-administrator@two-r2-fixture.invalid','migration-reader@two-r2-fixture.invalid']);
function privateError(error){let value=String(error.stack||error.message||error);for(const item of privateValues)if(item)value=value.split(item).join('[private fixture input]');return value;}
function closeContext(context){let work=closes.get(context);if(!work){work=context.close();closes.set(context,work);}return work;}
function closeBrowser(){return originalBrowserClose??=browser.close();}
function notInterrupted(){assert(!report.interrupted,'Qualification interrupted; later native case remains unrun.');}
function explicitStop(){return originalStop??=(async()=>{report.interrupted='original-stdin-stop';report.status='failed';
  try{await Promise.all([...contexts].map(closeContext));}finally{if(browser)await closeBrowser();}})();}
function originalControl(value){if(value!=='stop\n')report.controlInputError=true;void explicitStop().catch(error=>{report.controlStopError=privateError(error);});}
process.stdin.setEncoding('utf8');process.stdin.once('data',originalControl);process.stdin.resume();
async function rows(name){assert(/^[a-zA-Z0-9_]+$/.test(name));const value=await owner.database.prepare(`SELECT * FROM "${name}"`).all();assert.equal(value.success,true);return value.results;}
async function verifyReadOnly(stage,expectedNew){
  const after=await owner.snapshot(),before=owner.report.browserBaseline;assert.equal(after.schemaSha256,before.schemaSha256);
  for(const [name,value] of Object.entries(before.tables))if(name!=='system_recovery_write_leases')assert.deepEqual(after.tables[name],value,name);
  const permits=await rows('system_recovery_write_leases'),known=new Set(owner.originalBaselinePermits.map(item=>item.id));
  assert.equal(sha(permits.filter(item=>known.has(item.id)).map(canonical).sort().join('\n')),sha(owner.originalBaselinePermits.map(canonical).sort().join('\n')));
  const added=permits.filter(item=>!known.has(item.id));assert.equal(added.length,expectedNew);
  for(const permit of added){assert.equal(permit.kind,'http');assert.equal(sha(permit.owner),owner.report.actorSha256);assert.equal(permit.generation,owner.report.maintenanceGeneration);assert(permit.released_at);
    assert.equal(Date.parse(permit.expires_at)-Date.parse(permit.created_at),300000);}
  const sourceObjects=await owner.sourceBucket.list(),targetObjects=await owner.targetBucket.list();assert(!sourceObjects.truncated&&!targetObjects.truncated);
  assert.equal(sourceObjects.objects.length,1);assert.equal(sourceObjects.objects[0].key,owner.report.sourceFile.objectKey);assert.equal(targetObjects.objects.length,0);
  const original=await owner.sourceBucket.get(owner.report.sourceFile.objectKey);assert(original);const bytes=Buffer.from(await original.arrayBuffer());
  assert.equal(bytes.length,owner.report.sourceFile.byteSize);assert.equal(sha(bytes),owner.report.sourceFile.sha256);
  return {stage,allApplicationRowsAndSchemaExactExceptExactReleasedPreviewPermits:true,old6PermitsExact:true,newReleasedPermits:added.length,
    sourceBytesExact:true,targetEmpty:true,newRowsSha256:sha(added.map(canonical).sort().join('\n'))};
}
async function enabled(page,locator){const original=await locator.elementHandle();assert(original);try{const settled=await page.waitForFunction(node=>node.isConnected&&!node.matches(':disabled'),original,{timeout:20000});await settled.dispose();}finally{await original.dispose();}}
async function originalBody(capture){let timer;try{await Promise.race([capture.work,new Promise((_done,fail)=>{timer=setTimeout(()=>fail(new Error('Original native response exceeds20s.')),20000);})]);}finally{clearTimeout(timer);}assert.equal(capture.item.body,'completed');return capture.bytes;}
function plan(value,input){const sourceFile=owner.report.sourceFile;assert.deepEqual(Object.keys(value).sort(),['target','items','bytes','retainedSourceBytes','stagingBytes','transferAndVerificationBytes','maxTransferAndVerificationBytes','maxAttemptsPerFile','bytesVerified'].sort());
  assert.deepEqual(value.target,input.target);assert.equal(value.bytesVerified,false);assert.equal(value.maxAttemptsPerFile,5);
  assert.deepEqual(value.items,[{fileId:sourceFile.fileId,purpose:'research_source',sourceLocationId:sourceFile.locationId,sourceProfileId:sourceFile.sourceProfileId,
    byteSize:sourceFile.byteSize,sha256:sourceFile.sha256,status:'eligible'}]);
  for(const [name,multiplier] of [['bytes',1],['retainedSourceBytes',1],['stagingBytes',5],['transferAndVerificationBytes',3],['maxTransferAndVerificationBytes',15]])assert.equal(value[name],sourceFile.byteSize*multiplier);return value;}
async function caseRun(id,width,height,theme){
  notInterrupted();const record={id,width,height,theme,status:'running',requests:[],api:[],backendResponses:[],assertions:[],pageErrors:[],externalRequests:[],startedAt:new Date().toISOString()};report.cases.push(record);
  let context;const routes=[],bodies=[],waits=[],captures=new WeakMap(),nativePost=new WeakMap();
  try{
    context=await browser.newContext({viewport:{width,height},colorScheme:theme,isMobile:width===390,hasTouch:width===390,serviceWorkers:'block'});contexts.add(context);
    await context.addInitScript(value=>localStorage.setItem('sample-workflow-theme',value),theme);
    await context.route('**/*',route=>{const work=Promise.resolve().then(async()=>{
      const request=route.request(),url=new URL(request.url());if(['http:','https:'].includes(url.protocol)&&url.origin!==base.origin){record.externalRequests.push({origin:url.origin});await route.abort('blockedbyclient');return;}
      if(url.origin!==base.origin||!url.pathname.startsWith('/api/')){await route.continue();return;}
      const headers={...request.headers(),'cf-access-jwt-assertion':owner.adminToken};
      if(request.method()==='GET'){assert(['/api/storage/configuration/capability','/api/settings/storage','/api/files/migrations/files','/api/files/migrations','/api/files/migrations/executor'].includes(url.pathname));await route.continue({headers});return;}
      assert.equal(request.method(),'POST');assert.equal(url.pathname,'/api/files/migrations/plans');assert(!record.input,'Only one native preview may be forwarded per case.');
      const input=checkedInput(request.postDataJSON());assert.deepEqual(input.fileIds,[owner.report.sourceFile.fileId]);
      assert.deepEqual(input.target,{profileId:owner.report.sourceFile.targetProfileId,configurationRevision:1});assert.match(input.requestId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      record.input=input;const entry={path:url.pathname,method:'POST',startedAt:new Date().toISOString(),state:'issued'};nativePost.set(request,entry);record.backendResponses.push(entry);
      const before=await rows('system_recovery_write_leases');
      const response=await route.fetch({headers,maxRedirects:0,maxRetries:0,timeout:20000});const bytes=await response.body();assert(bytes.length<131072);assert.equal(response.status(),200);
      plan(JSON.parse(bytes.toString('utf8')),input);entry.status=200;entry.body='completed';entry.responseSha256=sha(bytes);entry.completedAt=new Date().toISOString();
      const after=await rows('system_recovery_write_leases'),known=new Set(before.map(item=>item.id)),added=after.filter(item=>!known.has(item.id));assert.equal(added.length,1);
      assert.equal(sha(after.filter(item=>known.has(item.id)).map(canonical).sort().join('\n')),sha(before.map(canonical).sort().join('\n')));
      const permit=added[0];assert.equal(sha(permit.owner),owner.report.actorSha256);assert.equal(permit.kind,'http');assert.equal(permit.generation,owner.report.maintenanceGeneration);assert(permit.released_at);
      assert.equal(Date.parse(permit.expires_at)-Date.parse(permit.created_at),300000);assert(Date.parse(permit.created_at)>=Date.parse(entry.startedAt)&&Date.parse(permit.released_at)<=Date.parse(entry.completedAt));
      entry.exactOriginalReleasedPermit={id:permit.id,sha256:sha(canonical(permit)),allEarlierRowsExact:true,requestWindowMatched:true};entry.state='accepted';
      await route.fulfill({status:response.status(),headers:response.headers(),body:bytes});entry.nativeDelivery='fulfilled';
    });routes.push(work);work.catch(()=>{});return work;});
    const page=await context.newPage();page.setDefaultTimeout(20000);page.setDefaultNavigationTimeout(20000);page.on('pageerror',error=>record.pageErrors.push(privateError(error)));
    page.on('request',request=>{const url=new URL(request.url());if(url.origin===base.origin&&url.pathname.startsWith('/api/'))record.requests.push({path:url.pathname,method:request.method()});});
    page.on('response',response=>{const url=new URL(response.url());if(url.origin!==base.origin||!url.pathname.startsWith('/api/'))return;
      const item={path:url.pathname,method:response.request().method(),status:response.status(),body:'pending'};record.api.push(item);const capture={item};captures.set(response,capture);
      capture.work=response.body().then(bytes=>{assert(bytes.length<131072);capture.bytes=bytes;item.body='completed';item.sha256=sha(bytes);
        if(item.method==='POST'){const entry=nativePost.get(response.request());assert(entry);assert.equal(item.sha256,entry.responseSha256);item.exactOriginalBackendMatches=true;}
      }).catch(error=>{item.body='failed';item.error=privateError(error);});bodies.push(capture.work);
    });
    const wait=(path,method='GET')=>{const work=page.waitForResponse(response=>new URL(response.url()).pathname===path&&response.request().method()===method);waits.push(work);work.catch(()=>{});return work;};
    const initialPaths=['/api/storage/configuration/capability','/api/settings/storage','/api/files/migrations/files','/api/files/migrations','/api/files/migrations/executor'];
    const initial=initialPaths.map(path=>wait(path));await page.goto(new URL('/settings/storage/migrations',base).href,{waitUntil:'networkidle',timeout:20000});
    const values=[];for(const response of await Promise.all(initial)){assert.equal(response.status(),200);const capture=captures.get(response);assert(capture);values.push(JSON.parse(await originalBody(capture)));}
    assert.equal(values[0].canManage,true);const settings=checkedSettings(values[1]);assert.equal(settings.version,3);assert.equal(settings.authority.mode,'active');assert.equal(settings.authority.fileAccess,'enabled');
    for(const id of [owner.report.sourceFile.sourceProfileId,owner.report.sourceFile.targetProfileId]){const profile=settings.profiles.items.find(item=>item.id===id);assert(profile);assert.equal(profile.runtimeAccess,'read_write');assert.equal(profile.availability,'available');assert.equal(profile.bindingMatch,'matched');}
    assert.deepEqual(values[2],{items:[{fileId:owner.report.sourceFile.fileId,purpose:'research_source',byteSize:owner.report.sourceFile.byteSize,sha256:owner.report.sourceFile.sha256,
      profileId:owner.report.sourceFile.sourceProfileId,locationId:owner.report.sourceFile.locationId}],nextCursor:null});assert.deepEqual(values[3],{jobs:[]});assert.equal(values[4].enabled,false);
    const section=page.getByRole('heading',{name:'Plan a migration',exact:true}).locator('..');
    await section.getByRole('combobox',{name:'Migration destination',exact:true}).selectOption(owner.report.sourceFile.targetProfileId);
    const checkbox=section.getByRole('checkbox');assert.equal(await checkbox.count(),1);await checkbox.check();
    const preview=section.getByRole('button',{name:'Preview migration',exact:true});await enabled(page,preview);assert(await preview.isEnabled());
    const responseWait=wait('/api/files/migrations/plans','POST');await preview.focus();assert(await preview.evaluate(node=>document.activeElement===node));await page.keyboard.press('Enter');
    const response=await responseWait;assert.equal(response.status(),200);const capture=captures.get(response);assert(capture);const value=plan(JSON.parse(await originalBody(capture)),record.input);
    await section.getByText('This preview reads metadata. The executor verifies every byte before switching a File.',{exact:true}).waitFor({state:'visible',timeout:20000});
    await enabled(page,preview);assert(await preview.isEnabled());const focus=await preview.evaluate(node=>({active:document.activeElement===node,focusVisible:node.matches(':focus-visible'),disabled:node.disabled}));
    record.assertions.push({genuineOriginalPlan200:true,oneEligibleActualFile:value.items.length,bytes:value.bytes,stagingBytes:value.stagingBytes,maxTransferBytes:value.maxTransferAndVerificationBytes,nativePreviewFocus:focus});assert.equal(focus.active,true,'Keyboard preview should retain focus after its pending original action settles.');
    const geometry=await page.evaluate(()=>({width:document.documentElement.clientWidth,root:document.documentElement.scrollWidth,body:document.body.scrollWidth,theme:document.documentElement.dataset.theme}));
    record.assertions.push({geometry});await writeOnce(resolve(output,`${id}.geometry.json`),geometry);assert.equal(geometry.theme,theme);assert(geometry.root<=geometry.width+2&&geometry.body<=geometry.width+2);
    await Promise.all(bodies);assert(record.api.every(item=>item.body==='completed'&&item.status===200));assert.equal(record.requests.filter(item=>item.method==='POST').length,1);
    assert.equal(record.pageErrors.length,0);assert.equal(record.externalRequests.length,0);record.status='passed';
  }catch(error){record.status='failed';record.error=privateError(error);}
  finally{
    if(context){try{await closeContext(context);record.contextCloseAwaited=true;}catch(error){record.contextCloseError=privateError(error);record.status='failed';}contexts.delete(context);}
    const routeResults=await Promise.allSettled(routes),bodyResults=await Promise.allSettled(bodies),waitResults=await Promise.allSettled(waits);
    record.originalRoutesAwaited={count:routeResults.length,rejected:routeResults.filter(x=>x.status==='rejected').length};record.originalBodiesAwaited={count:bodyResults.length,rejected:bodyResults.filter(x=>x.status==='rejected').length};record.originalWaitsAwaited={count:waitResults.length,rejected:waitResults.filter(x=>x.status==='rejected').length};
    if([...routeResults,...bodyResults,...waitResults].some(x=>x.status==='rejected')||record.api.some(item=>item.body!=='completed'))record.status='failed';
    const accepted=report.cases.flatMap(item=>item.backendResponses).filter(item=>item.state==='accepted').length;
    try{record.originalCatalogAndSourceBytes=await verifyReadOnly(`settled-${id}`,accepted);}catch(error){record.readOnlyHistoryError=privateError(error);record.status='failed';}
    record.completedAt=new Date().toISOString();console.log(JSON.stringify({id,status:record.status,originalContextClosed:record.contextCloseAwaited}));
  }
  if(record.status!=='passed')throw new Error(record.error||record.readOnlyHistoryError||'Original native preview failed after owner settlement.');
}

try{
  owner=await prepareGenuineTwoR2MigrationRuntime({source,artifact,config});privateValues.add(owner.adminToken);privateValues.add(owner.readerToken);report.genuinePreparation=owner.report;notInterrupted();
  // Actual allowed reader has no inferred administrator/operator migration right.
  for(const [path,status] of [['/api/storage/configuration/capability',200],['/api/files/migrations',403]]){
    const response=await fetch(new URL(path,base),{headers:{'cf-access-jwt-assertion':owner.readerToken},redirect:'error',signal:AbortSignal.timeout(20000)});
    const bytes=Buffer.from(await response.arrayBuffer());assert(bytes.length<131072);assert.equal(response.status,status);if(status===200)assert.equal(JSON.parse(bytes.toString('utf8')).canManage,false);
    report.readerRequests.push({path,method:'GET',status,body:'completed',sha256:sha(bytes)});
  }
  const childTemp=process.env.PHASE5F_FILE_MIGRATION_CHROMIUM_TEMP;assert.equal(childTemp,'/workspace/.f2r2t5');
  const tempInfo=await lstat(childTemp);assert(tempInfo.isDirectory()&&!tempInfo.isSymbolicLink());assert.equal(await realpath(childTemp),childTemp);assert.equal(tempInfo.mode&0o777,0o700);assert.equal(tempInfo.uid,process.getuid());
  const tempOwner=await json(await privateRoot(process.env.PHASE5F_FILE_MIGRATION_RUNTIME_ROOT),'chromium-child-temp-owner.json');
  assert.equal(tempOwner.path,childTemp);assert.equal(tempOwner.dev,String(tempInfo.dev));assert.equal(tempOwner.ino,String(tempInfo.ino));assert.equal(tempOwner.freshCreated,true);
  assert.equal(tempOwner.sourceHead,producerHead);assert.equal(tempOwner.sourceCopyRoot,source);assert.equal(tempOwner.fixtureDirectory,fixtureRoot);assert.equal(tempOwner.qaHelperSha256,report.helperSha256);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox'],env:{...process.env,TMPDIR:childTemp,SQLITE_TMPDIR:childTemp}});notInterrupted();
  await caseRun(ids[0],1280,1000,'light');await caseRun(ids[1],390,844,'dark');notInterrupted();assert(report.cases.every(item=>item.status==='passed'));report.status='passed';
}catch(error){report.status='failed';report.error=privateError(error);if(error.fixtureReport)report.genuinePreparation=error.fixtureReport;}
finally{
  process.stdin.removeListener('data',originalControl);process.stdin.pause();const closure={status:'closing'};
  if(originalStop){try{await originalStop;closure.originalStdinStopAwaited=true;}catch(error){closure.originalStopError=privateError(error);}}
  if(browser){try{await closeBrowser();closure.browserCloseAwaited=true;}catch(error){closure.browserCloseError=privateError(error);}}else closure.noReturnedBrowserHandle=true;
  if(owner){try{report.finalCatalog=await verifyReadOnly('before-original-Worker-dispose',report.cases.flatMap(item=>item.backendResponses).filter(item=>item.state==='accepted').length);}catch(error){closure.finalCatalogError=privateError(error);}
    closure.originalPreparationOwnerClosure=await owner.close();if(closure.originalPreparationOwnerClosure.status!=='closed')closure.preparationOwnerCloseError=true;}
  closure.status=Object.keys(closure).some(name=>name.endsWith('Error'))?'failed':'closed';report.ownedClosure=closure;if(closure.status!=='closed')report.status='failed';
  report.unrunCases=ids.filter(id=>!report.cases.some(item=>item.id===id));report.actualCosts={setupPOSTs:owner?.report.requests.filter(item=>item.method==='POST').length??0,
    readerGETs:report.readerRequests.length,nativeGETs:report.cases.reduce((n,item)=>n+item.requests.filter(request=>request.method==='GET').length,0),nativePreviewPOSTs:report.cases.reduce((n,item)=>n+item.requests.filter(request=>request.method==='POST').length,0),
    maxSetupPOSTs:6,maxPreviewPOSTs:2,newMigrationJobsOrExecutorSteps:0};report.completedAt=new Date().toISOString();await writeOnce(stopPath,closure);await writeOnce(reportPath,report);
}
console.log(JSON.stringify({status:report.status,passed:report.cases.filter(item=>item.status==='passed').length,failed:report.cases.filter(item=>item.status==='failed').length,unrun:report.unrunCases.length,reportPath,closure:report.ownedClosure.status}));
if(report.status!=='passed')process.exitCode=1;
