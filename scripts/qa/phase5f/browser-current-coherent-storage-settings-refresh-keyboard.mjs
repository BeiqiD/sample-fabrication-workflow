// One genuine Storage settings Refresh keyboard characterization on a NEW isolated installation.
// Current8be changed product requires its original fresh producer; no native write or accepted job.
// Six genuine localR2 setup POSTs; native current-status/capability GETs only, executor disabled.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, realpath, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareGenuineTwoR2MigrationRuntime } from './prepare-genuine-two-r2-migration-runtime.mjs';

const [sourceValue,fixtureValue,producerHead,permit,...extra]=process.argv.slice(2);
assert(sourceValue&&fixtureValue&&producerHead==='8be4e74200096436eaa674a05d44dd772d23fc35'
  &&permit==='--exclusive-go-one-current-coherent-storage-settings-refresh-keyboard'&&!extra.length);
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
assert.equal(Object.keys(isolation.trackedFiles).length,3086);
const consumer=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const currentQaInputScope={producerOrdinaryTrackedCount:3086,allProducerTrackedBytesExact:true,
  executedIsolationHelperSha256:'fba64e958ba1042a7ea406ef9d502ce12829c194c4ec3ea65ee447b3f3105292',
  addedBrowserHelperSha256:sha(await readFile(new URL(import.meta.url)))};
assert.equal(isolation.helperSha256,currentQaInputScope.executedIsolationHelperSha256);
for(const [name,value] of Object.entries(isolation.trackedFiles)){
  assert.equal(sha(await readFile(await file(source,name))),value,name);
  assert.equal(sha(await readFile(await file(consumer,name))),value,name);
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
const {build,stop}=require('esbuild');let checkedSettings;
try{for(const [name,exportName] of [['shared/contracts/current-storage-settings.ts','checkedCurrentStorageSettings']]){
  const contents=await readFile(await file(source,name),'utf8');const compiled=await build({stdin:{contents,loader:'ts',sourcefile:name,resolveDir:resolve(source,name.slice(0,name.lastIndexOf('/')))},bundle:true,
    write:false,platform:'node',format:'esm',target:'es2022',logLevel:'silent'});assert.equal(compiled.outputFiles.length,1);assert.equal(compiled.warnings.length,0);
  const executable=compiled.outputFiles[0].text;assert(!/\bimport\s*(?:\(|[^;]*\bfrom\b)/.test(executable));
  const value=(await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`))[exportName];
  checkedSettings=value;
}}finally{await stop();} // Public stop request only; actual native groups are separately supervised.

const base=new URL('http://127.0.0.1:4219/'),ids=['current-coherent-storage-settings-refresh-keyboard-1280-light'];
const output=resolve(fixtureRoot,'genuine-storage-settings-refresh-keyboard-artifacts'),reportPath=resolve(fixtureRoot,'genuine-storage-settings-refresh-keyboard-report.json'),stopPath=resolve(fixtureRoot,'genuine-storage-settings-refresh-keyboard-stop.json');
for(const path of [output,reportPath,stopPath])await absentFile(path);await mkdir(output,{mode:0o700});
const report={status:'running',sourceCopyRoot:source,fixtureDirectory:fixtureRoot,sourceHead:producerHead,sourceTree:isolation.sourceTree,
  sessionPid:process.pid,helperSha256:sha(await readFile(new URL(import.meta.url))),isolationReceiptSha256:isolationHash,currentQaInputScope,expectedCases:ids,cases:[],readerRequests:[],startedAt:new Date().toISOString(),
  scope:'One genuine Storage settings Refresh keyboard characterization1280light; actual initial and refreshed current-version3 GETs only. Six original localR2 setup POSTs remain explicit; zero nativePOST, permits, jobs, activation, connectivity tests, executor, ZIP/provider or recovery target. Preserve first native focus failure rather than predeclare a defect.'};
let owner,browser,originalBrowserClose,originalStop;const contexts=new Set(),closes=new WeakMap();
const privateValues=new Set(['migration-administrator@two-r2-fixture.invalid','migration-reader@two-r2-fixture.invalid']);
// No native write is admitted in this read-only characterization.
function privateError(error){
  // Report every thrown value without invoking its getters/toJSON/toString.
  // The original ordered failures remain in the AggregateError; this is bounded private evidence only.
  try{
    const data=(value,name)=>{try{return Object.getOwnPropertyDescriptor(value,name)?.value;}catch{return undefined;}};
    const redact=value=>{if(typeof value!=='string')return undefined;for(const item of privateValues)if(typeof item==='string'&&item)value=value.split(item).join('[private fixture input]');return value.slice(0,2048);};
    const describe=(value,depth)=>{
      if(value===null)return{kind:'null',value:null};if(value===undefined)return{kind:'undefined'};
      if(typeof value==='string')return{kind:'string',value:redact(value)};
      if(typeof value==='boolean')return{kind:'boolean',value};if(typeof value==='number')return{kind:'number',value:Number.isFinite(value)?value:'non-finite'};
      if(typeof value!=='object')return{kind:typeof value};
      const item={kind:'object',name:redact(data(value,'name')),message:redact(data(value,'message')),stack:redact(data(value,'stack'))},errors=data(value,'errors');
      if(Array.isArray(errors)){
        const length=data(errors,'length');item.aggregate=true;item.constituentCount=Number.isInteger(length)&&length>=0?length:'unobserved';item.constituents=[];
        if(depth<3&&Number.isInteger(length)&&length>=0){for(let index=0;index<Math.min(length,8);index++){
          const descriptor=Object.getOwnPropertyDescriptor(errors,String(index));item.constituents.push(descriptor&&Object.hasOwn(descriptor,'value')?describe(descriptor.value,depth+1):{kind:'unobserved-constituent-accessor-or-missing'});
        }}item.constituentsLimited=depth>=3||!Number.isInteger(length)||length<0||length>8;
      }
      return item;
    };
    return JSON.stringify(describe(error,0));
  }catch{return '{"kind":"unformattable-original-thrown-value"}';}
}
function throwOrderedFailures(errors,message){if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,message);}
function closeContext(context){let work=closes.get(context);if(!work){work=context.close();closes.set(context,work);}return work;}
function closeBrowser(){return originalBrowserClose??=browser.close();}
function notInterrupted(){assert(!report.interrupted,'Qualification interrupted; later native case remains unrun.');}
function explicitStop(){return originalStop??=(async()=>{report.interrupted='original-stdin-stop';report.status='failed';
  const originalContexts=[...contexts],results=await Promise.allSettled(originalContexts.map(context=>{try{return closeContext(context);}catch(error){return Promise.reject(error);}}));
  report.controlContextsCloseOutcomes=results.map((value,index)=>({index,status:value.status,...(value.status==='rejected'?{error:privateError(value.reason)}:{})}));
  const errors=results.filter(value=>value.status==='rejected').map(value=>value.reason);
  if(browser){try{await closeBrowser();report.controlBrowserCloseOutcome={status:'fulfilled'};}catch(error){report.controlBrowserCloseOutcome={status:'rejected',error:privateError(error)};errors.push(error);}}
  throwOrderedFailures(errors,'Original cached context closes and original cached browser close failed.');})();}
function originalControl(value){if(value!=='stop\n')report.controlInputError=true;void explicitStop().catch(error=>{report.controlStopError=privateError(error);});}
process.stdin.setEncoding('utf8');process.stdin.once('data',originalControl);process.stdin.resume();
async function rows(name){assert(/^[a-zA-Z0-9_]+$/.test(name));const value=await owner.database.prepare(`SELECT * FROM "${name}"`).all();assert.equal(value.success,true);return value.results;}
async function verifyReadOnlyHistory(stage){
  const after=await owner.snapshot(),before=owner.report.browserBaseline;
  assert.equal(after.schemaSha256,before.schemaSha256);assert.deepEqual(after.tables,before.tables);
  const permits=await rows('system_recovery_write_leases');
  assert.equal(sha(permits.map(canonical).sort().join('\n')),sha(owner.originalBaselinePermits.map(canonical).sort().join('\n')));
  const sourceObjects=await owner.sourceBucket.list(),targetObjects=await owner.targetBucket.list();assert(!sourceObjects.truncated&&!targetObjects.truncated);
  assert.equal(sourceObjects.objects.length,1);assert.equal(sourceObjects.objects[0].key,owner.report.sourceFile.objectKey);assert.equal(targetObjects.objects.length,0);
  const original=await owner.sourceBucket.get(owner.report.sourceFile.objectKey);assert(original);const bytes=Buffer.from(await original.arrayBuffer());
  assert.equal(bytes.length,owner.report.sourceFile.byteSize);assert.equal(sha(bytes),owner.report.sourceFile.sha256);
  return{stage,allSchemaAndTypedTableRowsExact:true,old6PermitsExact:true,newReleasedPermits:0,sourceBytesExact:true,targetEmpty:true,executorSteps:0};
}
async function enabled(page,locator){const original=await locator.elementHandle();assert(original);const errors=[];
  try{const settled=await page.waitForFunction(node=>node.isConnected&&!node.matches(':disabled'),original,{timeout:20000});await settled.dispose();}catch(error){errors.push(error);}
  try{await original.dispose();}catch(error){errors.push(error);}throwOrderedFailures(errors,'Original enabled wait and original handle disposal failed.');}
async function originalBody(capture){let timer;try{await Promise.race([capture.work,new Promise((_done,fail)=>{timer=setTimeout(()=>fail(new Error('Original native response exceeds20s.')),20000);})]);}finally{clearTimeout(timer);}assert.equal(capture.item.body,'completed');return capture.bytes;}
async function caseRun(id,width,height,theme){
  notInterrupted();const record={id,width,height,theme,status:'running',requests:[],api:[],assertions:[],pageErrors:[],externalRequests:[],startedAt:new Date().toISOString()};report.cases.push(record);
  let context;const routes=[],bodies=[],waits=[],captures=new WeakMap();
  try{
    context=await browser.newContext({viewport:{width,height},colorScheme:theme,isMobile:width===390,hasTouch:width===390,serviceWorkers:'block'});contexts.add(context);
    await context.addInitScript(value=>localStorage.setItem('sample-workflow-theme',value),theme);
    await context.route('**/*',route=>{const work=Promise.resolve().then(async()=>{
      const request=route.request(),url=new URL(request.url());if(['http:','https:'].includes(url.protocol)&&url.origin!==base.origin){record.externalRequests.push({origin:url.origin});await route.abort('blockedbyclient');return;}
      if(url.origin!==base.origin||!url.pathname.startsWith('/api/')){await route.continue();return;}
      assert.equal(request.method(),'GET','This characterization must never issue a native mutation.');
      assert(['/api/storage/configuration/capability','/api/settings/storage'].includes(url.pathname));
      if(url.pathname==='/api/settings/storage')assert.equal(url.searchParams.get('version'),'3');
      await route.continue({headers:{...request.headers(),'cf-access-jwt-assertion':owner.adminToken}});
    });routes.push(work);work.catch(()=>{});return work;});
    const page=await context.newPage();page.setDefaultTimeout(20000);page.setDefaultNavigationTimeout(20000);page.on('pageerror',error=>record.pageErrors.push(privateError(error)));
    page.on('request',request=>{const url=new URL(request.url());if(url.origin===base.origin&&url.pathname.startsWith('/api/'))record.requests.push({path:url.pathname,method:request.method()});});
    page.on('response',response=>{const url=new URL(response.url());if(url.origin!==base.origin||!url.pathname.startsWith('/api/'))return;
      const item={path:url.pathname,method:response.request().method(),status:response.status(),body:'pending'};record.api.push(item);const capture={item};captures.set(response,capture);
      capture.work=response.body().then(bytes=>{assert(bytes.length<131072);capture.bytes=bytes;item.body='completed';item.sha256=sha(bytes);})
        .catch(error=>{item.body='failed';item.error=privateError(error);});bodies.push(capture.work);
    });
    const wait=path=>{const work=page.waitForResponse(response=>new URL(response.url()).pathname===path&&response.request().method()==='GET');waits.push(work);work.catch(()=>{});return work;};
    const paths=['/api/settings/storage','/api/storage/configuration/capability'];
    const initial=paths.map(wait);await page.goto(new URL('/settings/storage',base).href,{waitUntil:'networkidle',timeout:20000});
    async function completeOriginalReplies(pending){
      const values=[];for(const response of await Promise.all(pending)){assert.equal(response.status(),200);const capture=captures.get(response);assert(capture);values.push(JSON.parse(await originalBody(capture)));}
      const settings=checkedSettings(values[0]);assert.equal(settings.version,3);assert.equal(settings.authority.mode,'active');assert.equal(settings.authority.fileAccess,'enabled');assert.equal(values[1].canManage,true);
      for(const profileId of [owner.report.sourceFile.sourceProfileId,owner.report.sourceFile.targetProfileId]){const profile=settings.profiles.items.find(item=>item.id===profileId);assert(profile);assert.equal(profile.runtimeAccess,'read_write');assert.equal(profile.availability,'available');assert.equal(profile.bindingMatch,'matched');}
      return{version:settings.version,profileCount:settings.profiles.items.length,originalBodiesCompleted:true};
    }
    record.assertions.push({initialCurrentSettings:await completeOriginalReplies(initial)});
    await page.getByRole('heading',{name:'Storage',exact:true}).waitFor({state:'visible',timeout:20000});
    const refresh=page.getByRole('button',{name:'Refresh',exact:true});await enabled(page,refresh);assert(await refresh.isEnabled());
    await refresh.focus();assert(await refresh.evaluate(node=>document.activeElement===node));
    const repeated=paths.map(wait),actionStarted=Date.now();await page.keyboard.press('Enter');
    record.assertions.push({refreshedCurrentSettings:await completeOriginalReplies(repeated)});
    await enabled(page,refresh);assert(await refresh.isEnabled());
    const handle=await refresh.elementHandle();assert(handle);const focusErrors=[];
    try{const settled=await page.waitForFunction(node=>node.isConnected&&document.activeElement===node,handle,{timeout:Math.max(1,20000-(Date.now()-actionStarted))});await settled.dispose();}catch(error){focusErrors.push(error);}
    try{await handle.dispose();}catch(error){focusErrors.push(error);}throwOrderedFailures(focusErrors,'Original focus wait and original handle disposal failed.');
    const focus=await refresh.evaluate(node=>({connected:node.isConnected,active:document.activeElement===node,focusVisible:node.matches(':focus-visible'),disabled:node.disabled}));record.assertions.push({nativeRefreshFocus:focus});assert(focus.connected&&focus.active&&focus.focusVisible&&!focus.disabled);
    const geometry=await page.evaluate(()=>({width:document.documentElement.clientWidth,root:document.documentElement.scrollWidth,body:document.body.scrollWidth,theme:document.documentElement.dataset.theme}));record.assertions.push({geometry});await writeOnce(resolve(output,`${id}.geometry.json`),geometry);assert.equal(geometry.theme,theme);assert(geometry.root<=geometry.width+2&&geometry.body<=geometry.width+2);
    await Promise.all(bodies);assert.equal(record.requests.length,4);assert(record.requests.every(item=>item.method==='GET'));assert.equal(record.api.length,4);assert(record.api.every(item=>item.status===200&&item.body==='completed'));
    assert.equal(record.pageErrors.length,0);assert.equal(record.externalRequests.length,0);record.status='passed';
  }catch(error){record.status='failed';record.error=privateError(error);}
  finally{
    if(context){try{await closeContext(context);record.contextCloseAwaited=true;}catch(error){record.contextCloseError=privateError(error);record.status='failed';}contexts.delete(context);}
    const routeResults=await Promise.allSettled(routes),bodyResults=await Promise.allSettled(bodies),waitResults=await Promise.allSettled(waits);
    record.originalRoutesAwaited={count:routeResults.length,rejected:routeResults.filter(x=>x.status==='rejected').length};record.originalBodiesAwaited={count:bodyResults.length,rejected:bodyResults.filter(x=>x.status==='rejected').length};record.originalWaitsAwaited={count:waitResults.length,rejected:waitResults.filter(x=>x.status==='rejected').length};
    if([...routeResults,...bodyResults,...waitResults].some(x=>x.status==='rejected')||record.api.some(item=>item.body!=='completed'))record.status='failed';
    try{record.originalReadOnlyHistory=await verifyReadOnlyHistory(`settled-${id}`);}catch(error){record.readOnlyHistoryError=privateError(error);record.status='failed';}
    record.completedAt=new Date().toISOString();console.log(JSON.stringify({id,status:record.status,originalContextClosed:record.contextCloseAwaited}));
  }
  if(record.status!=='passed')throw new Error(record.error||record.readOnlyHistoryError||'Original Storage settings Refresh characterization failed after owner settlement.');
}

try{
  owner=await prepareGenuineTwoR2MigrationRuntime({source,artifact,config});privateValues.add(owner.adminToken);privateValues.add(owner.readerToken);report.genuinePreparation=owner.report;assert.equal((await rows('file_migration_jobs')).length,0);assert.equal((await rows('file_migration_items')).length,0);notInterrupted();
  // Actual allowed reader has no inferred administrator/operator migration right.
  for(const [path,status] of [['/api/storage/configuration/capability',200],['/api/settings/storage?version=3',200]]){
    const response=await fetch(new URL(path,base),{headers:{'cf-access-jwt-assertion':owner.readerToken},redirect:'error',signal:AbortSignal.timeout(20000)});
    const bytes=Buffer.from(await response.arrayBuffer());assert(bytes.length<131072);assert.equal(response.status,status);if(path==='/api/storage/configuration/capability')assert.equal(JSON.parse(bytes.toString('utf8')).canManage,false);else assert.equal(checkedSettings(JSON.parse(bytes.toString('utf8'))).version,3);
    report.readerRequests.push({path,method:'GET',status,body:'completed',sha256:sha(bytes)});
  }
  const childTemp=process.env.PHASE5F_FILE_MIGRATION_CHROMIUM_TEMP;assert.equal(childTemp,'/workspace/.ssrf2');
  const tempInfo=await lstat(childTemp);assert(tempInfo.isDirectory()&&!tempInfo.isSymbolicLink());assert.equal(await realpath(childTemp),childTemp);assert.equal(tempInfo.mode&0o777,0o700);assert.equal(tempInfo.uid,process.getuid());
  const tempOwner=await json(await privateRoot(process.env.PHASE5F_FILE_MIGRATION_RUNTIME_ROOT),'chromium-child-temp-owner.json');
  assert.equal(tempOwner.path,childTemp);assert.equal(tempOwner.dev,String(tempInfo.dev));assert.equal(tempOwner.ino,String(tempInfo.ino));assert.equal(tempOwner.freshCreated,true);
  assert.equal(tempOwner.sourceHead,producerHead);assert.equal(tempOwner.sourceCopyRoot,source);assert.equal(tempOwner.fixtureDirectory,fixtureRoot);assert.equal(tempOwner.qaHelperSha256,report.helperSha256);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox'],env:{...process.env,TMPDIR:childTemp,SQLITE_TMPDIR:childTemp}});notInterrupted();
  await caseRun(ids[0],1280,1000,'light');notInterrupted();assert(report.cases.every(item=>item.status==='passed'));report.status='passed';
}catch(error){report.status='failed';report.error=privateError(error);
  let originalFixtureReport;try{if(error!==null&&(typeof error==='object'||typeof error==='function')){
    const descriptor=Object.getOwnPropertyDescriptor(error,'fixtureReport');if(descriptor&&Object.hasOwn(descriptor,'value'))originalFixtureReport=descriptor.value;
  }}catch{} // Optional fixture metadata cannot replace the original recorded failure; Proxy trap effects are not attested absent.
  if(originalFixtureReport)report.genuinePreparation=originalFixtureReport;
}
finally{
  process.stdin.removeListener('data',originalControl);process.stdin.pause();const closure={status:'closing'};
  if(originalStop){try{await originalStop;closure.originalStdinStopAwaited=true;}catch(error){closure.originalStopError=privateError(error);}}
  if(browser){try{await closeBrowser();closure.browserCloseAwaited=true;}catch(error){closure.browserCloseError=privateError(error);}}else closure.noReturnedBrowserHandle=true;
  if(owner){try{report.finalCatalog=await verifyReadOnlyHistory('before-original-Worker-dispose');}catch(error){closure.finalCatalogError=privateError(error);}
    closure.originalPreparationOwnerClosure=await owner.close();if(closure.originalPreparationOwnerClosure.status!=='closed')closure.preparationOwnerCloseError=true;}
  closure.status=Object.keys(closure).some(name=>name.endsWith('Error'))?'failed':'closed';report.ownedClosure=closure;if(closure.status!=='closed')report.status='failed';
  report.unrunCases=ids.filter(id=>!report.cases.some(item=>item.id===id));report.actualCosts={setupPOSTs:owner?.report.requests.filter(item=>item.method==='POST').length??0,
    readerGETs:report.readerRequests.length,nativeGETs:report.cases.reduce((n,item)=>n+item.requests.filter(request=>request.method==='GET').length,0),nativeMetadataPOSTs:report.cases.reduce((n,item)=>n+item.requests.filter(request=>request.method==='POST').length,0),
    maxSetupPOSTs:6,maxNativePOSTs:0,observedAcceptedJobReceipts:0,newExecutorSteps:0};report.completedAt=new Date().toISOString();await writeOnce(stopPath,closure);await writeOnce(reportPath,report);
}
console.log(JSON.stringify({status:report.status,passed:report.cases.filter(item=>item.status==='passed').length,failed:report.cases.filter(item=>item.status==='failed').length,unrun:report.unrunCases.length,reportPath,closure:report.ownedClosure.status}));
if(report.status!=='passed')process.exitCode=1;
