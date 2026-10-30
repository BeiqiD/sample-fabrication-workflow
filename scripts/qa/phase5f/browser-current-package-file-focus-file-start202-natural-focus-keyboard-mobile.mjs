// Source-only accept202 natural focus characterization; no Pause/Resume/Cancel is invoked.
// One genuine Saved jobs keyboard acceptance on a NEW independent isolated installation.
// Producer is current coherent Saved/Package focus source; original paused failure history is never reopened.
// Six genuine setup POSTs + only two native metadata POSTs (Preview200, accept202); executor stays disabled.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, realpath, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareGenuineTwoR2MigrationRuntime } from './prepare-genuine-two-r2-migration-runtime.mjs';

const [sourceValue,fixtureValue,producerHead,permit,...extra]=process.argv.slice(2);
assert(sourceValue&&fixtureValue&&producerHead==='2d07b57c4e79403099261528ae8988c0072d28c6'
  &&permit==='--exclusive-go-one-current-file-start202-natural-focus'&&!extra.length);
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
assert.equal(Object.keys(isolation.trackedFiles).length,3181);
const consumer=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const currentQaInputScope={producerOrdinaryTrackedCount:3181,allProducerTrackedBytesExact:true,
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
const {build,stop}=require('esbuild');let checkedInput,checkedSettings,checkedJob;
try{for(const [name,exportName] of [['shared/contracts/file-jobs.ts','checkedAcceptFileMigration'],['shared/contracts/current-storage-settings.ts','checkedCurrentStorageSettings'],['shared/contracts/file-jobs.ts','checkedFileJobStatus']]){
  const contents=await readFile(await file(source,name),'utf8');const compiled=await build({stdin:{contents,loader:'ts',sourcefile:name,resolveDir:resolve(source,name.slice(0,name.lastIndexOf('/')))},bundle:true,
    write:false,platform:'node',format:'esm',target:'es2022',logLevel:'silent'});assert.equal(compiled.outputFiles.length,1);assert.equal(compiled.warnings.length,0);
  const executable=compiled.outputFiles[0].text;assert(!/\bimport\s*(?:\(|[^;]*\bfrom\b)/.test(executable));
  const value=(await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`))[exportName];
  if(exportName==='checkedAcceptFileMigration')checkedInput=value;else if(exportName==='checkedCurrentStorageSettings')checkedSettings=value;else checkedJob=value;
}}finally{await stop();} // Public stop request only; actual native groups are separately supervised.

const base=new URL('http://127.0.0.1:4219/'),ids=['current-file-start202-natural-focus-390-dark'];
const output=resolve(fixtureRoot,'genuine-file-start202-natural-focus-artifacts'),reportPath=resolve(fixtureRoot,'genuine-file-start202-natural-focus-report.json'),stopPath=resolve(fixtureRoot,'genuine-file-start202-natural-focus-stop.json');
for(const path of [output,reportPath,stopPath])await absentFile(path);await mkdir(output,{mode:0o700});
const report={status:'running',sourceCopyRoot:source,fixtureDirectory:fixtureRoot,sourceHead:producerHead,sourceTree:isolation.sourceTree,
  sessionPid:process.pid,helperSha256:sha(await readFile(new URL(import.meta.url))),isolationReceiptSha256:isolationHash,currentQaInputScope,expectedCases:ids,cases:[],readerRequests:[],startedAt:new Date().toISOString(),
  scope:'One genuine current coherent Saved jobs keyboard metadata acceptance; independent fresh current24/pure template sentinels and exact two localR2 capabilities. Actual Preview200/accept202 only; natural focus of the newly enabled same-job Pause control is observed before any helper focus or control. Original executor guard stays disabled; zero executor step/attempt/copy/GC/ZIP/provider/recovery target. First failure preserves exact queued acceptance history; no control request is attempted, no rollback or cleanup mutation.'};
let owner,browser,originalBrowserClose,originalStop;const contexts=new Set(),closes=new WeakMap();
const privateValues=new Set(['migration-administrator@two-r2-fixture.invalid','migration-reader@two-r2-fixture.invalid']);
let baselineHolds,acceptedInput;const acceptedWrites=[];
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
function validatedJob(value,input){
  assert.deepEqual(Object.keys(value).sort(),['id','actor','state','target','acceptedAt','updatedAt','reason','moved','remaining','failed','cleanupPending'].sort());
  const job=checkedJob(value);assert.equal(sha(job.actor),owner.report.actorSha256);assert.deepEqual(job.target,input.target);
  assert(Number.isFinite(Date.parse(job.acceptedAt))&&Number.isFinite(Date.parse(job.updatedAt)));
  assert.equal(job.moved,0);assert.equal(job.failed,0);assert.equal(job.cleanupPending,0);assert.equal(job.remaining,job.state==='cancelled'?0:1);
  return job;
}
function safeJob(job){const {actor,...safe}=job;return safe;}
async function verifyAcceptedHistory(stage){
  const after=await owner.snapshot(),before=owner.report.browserBaseline;assert.equal(after.schemaSha256,before.schemaSha256);
  const changed=new Set(['system_recovery_write_leases','file_migration_jobs','file_migration_items','file_location_holds']);
  for(const [name,value] of Object.entries(before.tables))if(!changed.has(name))assert.deepEqual(after.tables[name],value,name);
  const permits=await rows('system_recovery_write_leases'),known=new Set(owner.originalBaselinePermits.map(item=>item.id));
  assert.equal(sha(permits.filter(item=>known.has(item.id)).map(canonical).sort().join('\n')),sha(owner.originalBaselinePermits.map(canonical).sort().join('\n')));
  const added=permits.filter(item=>!known.has(item.id));assert.equal(added.length,acceptedWrites.length);
  for(const entry of acceptedWrites){const permit=added.find(item=>item.id===entry.exactOriginalReleasedPermit.id);assert(permit);
    assert.equal(sha(canonical(permit)),entry.exactOriginalReleasedPermit.sha256);assert.equal(permit.kind,'http');assert.equal(sha(permit.owner),owner.report.actorSha256);
    assert.equal(permit.generation,owner.report.maintenanceGeneration);assert(permit.released_at);assert.equal(Date.parse(permit.expires_at)-Date.parse(permit.created_at),300000);}
  const jobs=await rows('file_migration_jobs'),items=await rows('file_migration_items'),holds=await rows('file_location_holds');
  const old=new Set(baselineHolds.map(item=>item.id));assert.equal(sha(holds.filter(item=>old.has(item.id)).map(canonical).sort().join('\n')),sha(baselineHolds.map(canonical).sort().join('\n')));
  const jobWrites=acceptedWrites.filter(item=>item.action!=='preview'),latest=jobWrites.at(-1);let state=null,generation=null;
  if(!latest){assert.equal(jobs.length,0);assert.equal(items.length,0);assert.equal(holds.length,baselineHolds.length);}
  else{assert.equal(jobs.length,1);assert.equal(items.length,1);assert.equal(holds.length,baselineHolds.length+1);
    const job=jobs[0],item=items[0],hold=holds.find(value=>!old.has(value.id)),sourceFile=owner.report.sourceFile;assert(hold);
    assert.equal(job.id,latest.job.id);assert.equal(job.request_id,acceptedInput.requestId);assert.equal(sha(job.actor),owner.report.actorSha256);
    assert.equal(job.input_json,JSON.stringify(acceptedInput));assert.equal(job.target_profile_id,sourceFile.targetProfileId);assert.equal(job.target_configuration_revision,1);
    assert.equal(job.target_namespace,owner.report.derivedRuntimeNamespace.namespaces.target);assert.equal(job.state,latest.job.state);
    assert.equal(job.generation,jobWrites.length-1);for(const name of ['owner_token','runtime_incarnation','lease_expires_at','admin_checked_at'])assert.equal(job[name],null);
    assert.equal(job.accepted_at,jobWrites[0].job.acceptedAt);assert.equal(job.updated_at,latest.job.updatedAt);assert.equal(job.reason,latest.job.reason);
    assert.equal(item.job_id,job.id);assert.equal(item.file_id,sourceFile.fileId);assert.equal(item.purpose,'research_source');assert.equal(item.source_location_id,sourceFile.locationId);
    assert.equal(item.source_profile_id,sourceFile.sourceProfileId);assert.equal(item.source_configuration_revision,1);assert.equal(item.source_namespace,owner.report.derivedRuntimeNamespace.namespaces.source);
    assert.equal(item.source_object_key,sourceFile.objectKey);assert.equal(item.byte_size,sourceFile.byteSize);assert.equal(item.sha256,sourceFile.sha256);
    assert.equal(item.state,job.state==='cancelled'?'cancelled':'pending');assert.equal(item.destination_location_id,null);assert.equal(item.reason,null);
    for(const name of ['cleanup_requested_at','cleanup_actor','cleanup_not_before','cleanup_released_at'])assert.equal(item[name],null);
    assert.equal(item.updated_at,job.state==='cancelled'?job.updated_at:job.accepted_at);assert(item.hold_operation_id.startsWith(`fp3:${job.id}:`));
    assert.equal(hold.location_id,sourceFile.locationId);assert.equal(hold.operation_id,item.hold_operation_id);assert.equal(hold.hold_kind,'transition_source');
    assert.equal(hold.reason,'Accepted File migration source');assert.equal(hold.acquired_at,job.accepted_at);assert.equal(hold.released_at,job.state==='cancelled'?job.updated_at:null);
    state=job.state;generation=job.generation;}
  const sourceObjects=await owner.sourceBucket.list(),targetObjects=await owner.targetBucket.list();assert(!sourceObjects.truncated&&!targetObjects.truncated);
  assert.equal(sourceObjects.objects.length,1);assert.equal(sourceObjects.objects[0].key,owner.report.sourceFile.objectKey);assert.equal(targetObjects.objects.length,0);
  const original=await owner.sourceBucket.get(owner.report.sourceFile.objectKey);assert(original);const bytes=Buffer.from(await original.arrayBuffer());
  assert.equal(bytes.length,owner.report.sourceFile.byteSize);assert.equal(sha(bytes),owner.report.sourceFile.sha256);
  return {stage,onlyExactOneJobOneItemOneHoldAndReleasedPermitsChanged:true,old6PermitsExact:true,oldHoldsExact:true,newReleasedPermits:added.length,
    jobState:state,jobGeneration:generation,migrationAttempts:0,executorDisabled:true,sourceBytesExact:true,targetEmpty:true,
    addedRowsSha256:sha(canonical({jobs:jobs.map(value=>({...value,actor:sha(value.actor)})),items,holds:holds.filter(value=>!old.has(value.id)),permits:added.map(value=>({...value,owner:sha(value.owner)}))}))};
}
async function enabled(page,locator){const original=await locator.elementHandle();assert(original);const errors=[];
  try{const settled=await page.waitForFunction(node=>node.isConnected&&!node.matches(':disabled'),original,{timeout:20000});await settled.dispose();}catch(error){errors.push(error);}
  try{await original.dispose();}catch(error){errors.push(error);}throwOrderedFailures(errors,'Original enabled wait and original handle disposal failed.');}
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
      assert.equal(request.method(),'POST');assert(record.backendResponses.length<2,'At most two original native metadataPOSTs: Preview and accept.');
      const sourceFile=owner.report.sourceFile;let action,input;
      if(url.pathname==='/api/files/migrations/plans'){assert.equal(record.backendResponses.length,0);action='preview';input=checkedInput(request.postDataJSON());record.input=input;}
      else if(url.pathname==='/api/files/migrations'){assert.equal(record.backendResponses.length,1);action='accept';input=checkedInput(request.postDataJSON());acceptedInput=input;
        assert.deepEqual(input.fileIds,record.input.fileIds);assert.deepEqual(input.target,record.input.target);assert.notEqual(input.requestId,record.input.requestId);}
      else assert.fail('Acceptance-only characterization must never submit a job control.');
      assert.deepEqual(input.fileIds,[sourceFile.fileId]);assert.deepEqual(input.target,{profileId:sourceFile.targetProfileId,configurationRevision:1});
      assert.match(input.requestId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      const entry={action,path:url.pathname,method:'POST',startedAt:new Date().toISOString(),state:'issued'};nativePost.set(request,entry);record.backendResponses.push(entry);
      const before=await rows('system_recovery_write_leases');
      const response=await route.fetch({headers,maxRedirects:0,maxRetries:0,timeout:20000});const bytes=await response.body();assert(bytes.length<131072);assert.equal(response.status(),action==='accept'?202:200);
      const value=JSON.parse(bytes.toString('utf8'));
      if(action==='preview')plan(value,input);else{const job=validatedJob(value,input),expectedState=action==='pause'?'paused':action==='cancel'?'cancelled':'queued';assert.equal(job.state,expectedState);
        assert.equal(job.reason,action==='pause'?'operator_paused':action==='cancel'?'operator_cancelled':null);const prior=acceptedWrites.find(item=>item.action==='accept');if(prior)assert.equal(job.id,prior.job.id);entry.job=safeJob(job);}
      entry.status=response.status();entry.body='completed';entry.responseSha256=sha(bytes);entry.completedAt=new Date().toISOString();
      const after=await rows('system_recovery_write_leases'),known=new Set(before.map(item=>item.id)),added=after.filter(item=>!known.has(item.id));assert.equal(added.length,1);
      assert.equal(sha(after.filter(item=>known.has(item.id)).map(canonical).sort().join('\n')),sha(before.map(canonical).sort().join('\n')));
      const permit=added[0];assert.equal(sha(permit.owner),owner.report.actorSha256);assert.equal(permit.kind,'http');assert.equal(permit.generation,owner.report.maintenanceGeneration);assert(permit.released_at);
      assert.equal(Date.parse(permit.expires_at)-Date.parse(permit.created_at),300000);assert(Date.parse(permit.created_at)>=Date.parse(entry.startedAt)&&Date.parse(permit.released_at)<=Date.parse(entry.completedAt));
      entry.exactOriginalReleasedPermit={id:permit.id,sha256:sha(canonical(permit)),allEarlierRowsExact:true,requestWindowMatched:true};entry.state='accepted';acceptedWrites.push(entry);
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
    record.assertions.push({genuineOriginalPlan200:true,nativePreviewFocus:focus});assert.equal(focus.active,true);assert.equal(focus.focusVisible,true);
    const start=section.getByRole('button',{name:'Start migration',exact:true});await enabled(page,start);const acceptWait=wait('/api/files/migrations','POST');
    await start.focus();assert(await start.evaluate(node=>document.activeElement===node));const acceptStartedAt=Date.now();await page.keyboard.press('Enter');
    const acceptedResponse=await acceptWait;assert.equal(acceptedResponse.status(),202);const acceptedCapture=captures.get(acceptedResponse);assert(acceptedCapture);
    const acceptedJob=validatedJob(JSON.parse(await originalBody(acceptedCapture)),acceptedInput);assert.equal(acceptedJob.state,'queued');
    const jobSection=page.getByRole('heading',{name:'Saved jobs',exact:true}).locator('..');
    const jobRow=jobSection.getByRole('heading',{name:acceptedJob.id,exact:true}).locator('..');await jobRow.waitFor({state:'visible',timeout:20000});
    // Observe the original accepted request's successor without moving focus or issuing a control.
    const pause=jobRow.getByRole('button',{name:'Pause job',exact:true});await enabled(page,pause);assert(await pause.isEnabled());
    const observed=await pause.evaluate(node=>({connected:node.isConnected,active:document.activeElement===node,body:document.activeElement===document.body,tag:node.tagName,focusVisible:node.matches(':focus-visible'),disabled:node.disabled}));
    const startRemoved=await start.count()===0;const assertion={originalAccept202:true,acceptedJobId:acceptedJob.id,initialJobState:acceptedJob.state,startRemoved,immediateNaturalFocus:observed};record.assertions.push(assertion);assert(startRemoved);
    const originalTarget=await pause.elementHandle();assert(originalTarget);const focusErrors=[];
    try{const remaining=20000-(Date.now()-acceptStartedAt);assert(remaining>0,'Original acceptance focus budget is exhausted.');
      const settled=await page.waitForFunction(node=>node.isConnected&&document.activeElement===node&&!node.matches(':disabled'),originalTarget,{timeout:remaining});await settled.dispose();
      assertion.settledNaturalFocus=await pause.evaluate(node=>({connected:node.isConnected,active:document.activeElement===node,focusVisible:node.matches(':focus-visible'),disabled:node.disabled}));
      assert(assertion.settledNaturalFocus.connected&&assertion.settledNaturalFocus.active&&assertion.settledNaturalFocus.focusVisible&&!assertion.settledNaturalFocus.disabled);
    }catch(error){focusErrors.push(error);}
    try{await originalTarget.dispose();}catch(error){focusErrors.push(error);}throwOrderedFailures(focusErrors,'Original acceptance focus wait and original handle disposal failed.');
    record.acceptedJobHistory=await verifyAcceptedHistory('settled-original-accept202-natural-focus');
    assert.equal(acceptedWrites.length,2);assert.equal(acceptedWrites.at(-1).action,'accept');
    assert.equal(record.acceptedJobHistory.jobState,'queued');assert.equal(record.acceptedJobHistory.jobGeneration,0);
    const geometry=await page.evaluate(()=>({width:document.documentElement.clientWidth,root:document.documentElement.scrollWidth,body:document.body.scrollWidth,theme:document.documentElement.dataset.theme}));
    record.assertions.push({geometry});await writeOnce(resolve(output,`${id}.geometry.json`),geometry);assert.equal(geometry.theme,theme);assert(geometry.root<=geometry.width+2&&geometry.body<=geometry.width+2);
    await Promise.all(bodies);assert(record.api.every(item=>item.body==='completed'&&[200,202].includes(item.status)));assert.equal(record.requests.filter(item=>item.method==='POST').length,2);
    assert.equal(record.pageErrors.length,0);assert.equal(record.externalRequests.length,0);record.status='passed';
  }catch(error){record.status='failed';record.error=privateError(error);}
  finally{
    if(context){try{await closeContext(context);record.contextCloseAwaited=true;}catch(error){record.contextCloseError=privateError(error);record.status='failed';}contexts.delete(context);}
    const routeResults=await Promise.allSettled(routes),bodyResults=await Promise.allSettled(bodies),waitResults=await Promise.allSettled(waits);
    record.originalRoutesAwaited={count:routeResults.length,rejected:routeResults.filter(x=>x.status==='rejected').length};record.originalBodiesAwaited={count:bodyResults.length,rejected:bodyResults.filter(x=>x.status==='rejected').length};record.originalWaitsAwaited={count:waitResults.length,rejected:waitResults.filter(x=>x.status==='rejected').length};
    if([...routeResults,...bodyResults,...waitResults].some(x=>x.status==='rejected')||record.api.some(item=>item.body!=='completed'))record.status='failed';
    try{record.originalCatalogAndSourceBytes=await verifyAcceptedHistory(`settled-${id}`);}catch(error){record.acceptedHistoryError=privateError(error);record.status='failed';}
    record.completedAt=new Date().toISOString();console.log(JSON.stringify({id,status:record.status,originalContextClosed:record.contextCloseAwaited}));
  }
  if(record.status!=='passed')throw new Error(record.error||record.acceptedHistoryError||'Original current Saved jobs keyboard case failed after owner settlement.');
}

try{
  owner=await prepareGenuineTwoR2MigrationRuntime({source,artifact,config});privateValues.add(owner.adminToken);privateValues.add(owner.readerToken);report.genuinePreparation=owner.report;baselineHolds=await rows('file_location_holds');assert.equal((await rows('file_migration_jobs')).length,0);assert.equal((await rows('file_migration_items')).length,0);notInterrupted();
  // Actual allowed reader has no inferred administrator/operator migration right.
  for(const [path,status] of [['/api/storage/configuration/capability',200],['/api/files/migrations',403]]){
    const response=await fetch(new URL(path,base),{headers:{'cf-access-jwt-assertion':owner.readerToken},redirect:'error',signal:AbortSignal.timeout(20000)});
    const bytes=Buffer.from(await response.arrayBuffer());assert(bytes.length<131072);assert.equal(response.status,status);if(status===200)assert.equal(JSON.parse(bytes.toString('utf8')).canManage,false);
    report.readerRequests.push({path,method:'GET',status,body:'completed',sha256:sha(bytes)});
  }
  const childTemp=process.env.PHASE5F_FILE_MIGRATION_CHROMIUM_TEMP;assert.equal(childTemp,'/workspace/.sfstm1');
  const tempInfo=await lstat(childTemp);assert(tempInfo.isDirectory()&&!tempInfo.isSymbolicLink());assert.equal(await realpath(childTemp),childTemp);assert.equal(tempInfo.mode&0o777,0o700);assert.equal(tempInfo.uid,process.getuid());
  const tempOwner=await json(await privateRoot(process.env.PHASE5F_FILE_MIGRATION_RUNTIME_ROOT),'chromium-child-temp-owner.json');
  assert.equal(tempOwner.path,childTemp);assert.equal(tempOwner.dev,String(tempInfo.dev));assert.equal(tempOwner.ino,String(tempInfo.ino));assert.equal(tempOwner.freshCreated,true);
  assert.equal(tempOwner.sourceHead,producerHead);assert.equal(tempOwner.sourceCopyRoot,source);assert.equal(tempOwner.fixtureDirectory,fixtureRoot);assert.equal(tempOwner.qaHelperSha256,report.helperSha256);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox'],env:{...process.env,TMPDIR:childTemp,SQLITE_TMPDIR:childTemp}});notInterrupted();
  await caseRun(ids[0],390,844,'dark');notInterrupted();assert(report.cases.every(item=>item.status==='passed'));report.status='passed';
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
  if(owner){try{report.finalCatalog=await verifyAcceptedHistory('before-original-Worker-dispose');}catch(error){closure.finalCatalogError=privateError(error);}
    closure.originalPreparationOwnerClosure=await owner.close();if(closure.originalPreparationOwnerClosure.status!=='closed')closure.preparationOwnerCloseError=true;}
  closure.status=Object.keys(closure).some(name=>name.endsWith('Error'))?'failed':'closed';report.ownedClosure=closure;if(closure.status!=='closed')report.status='failed';
  report.unrunCases=ids.filter(id=>!report.cases.some(item=>item.id===id));report.actualCosts={setupPOSTs:owner?.report.requests.filter(item=>item.method==='POST').length??0,
    readerGETs:report.readerRequests.length,nativeGETs:report.cases.reduce((n,item)=>n+item.requests.filter(request=>request.method==='GET').length,0),nativeMetadataPOSTs:report.cases.reduce((n,item)=>n+item.requests.filter(request=>request.method==='POST').length,0),
    maxSetupPOSTs:6,maxNativePOSTs:2,observedAcceptedJobReceipts:acceptedWrites.some(item=>item.action==='accept')?1:0,newExecutorSteps:0};report.completedAt=new Date().toISOString();await writeOnce(stopPath,closure);await writeOnce(reportPath,report);
}
console.log(JSON.stringify({status:report.status,passed:report.cases.filter(item=>item.status==='passed').length,failed:report.cases.filter(item=>item.status==='failed').length,unrun:report.unrunCases.length,reportPath,closure:report.ownedClosure.status}));
if(report.status!=='passed')process.exitCode=1;
