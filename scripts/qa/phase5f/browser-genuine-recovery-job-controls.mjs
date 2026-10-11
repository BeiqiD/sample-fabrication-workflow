// Two genuine administrator historical-backup job control cases.
// One shared executor enable/disable surrounds two distinct accepted metadata jobs.
// Never invoke scheduled execution, an execution step, ZIP, target or provider work.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { lstat, mkdir, readFile, realpath, readdir, statfs, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [sourceValue, fixtureValue, producerHead, producerCount, permit, ...extra] = process.argv.slice(2);
assert(sourceValue && fixtureValue && permit === '--exclusive-go-two-genuine-recovery-job-controls' && /^[a-f0-9]{40}$/.test(producerHead) && /^[1-9][0-9]{0,3}$/.test(producerCount) && !extra.length,
  'Usage: node browser-genuine-recovery-job-controls.mjs ISOLATED_COPY FIXTURE_DIRECTORY REVIEWED_PRODUCER_HEAD REVIEWED_TRACKED_COUNT --exclusive-go-two-genuine-recovery-job-controls');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const base = new URL('http://127.0.0.1:4219/');
const alias = resolve(tmpdir()), temporary = await realpath(alias);
const within = (root, value) => { const part = relative(root, value); return part && !part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part); };
async function privateRoot(value) {
  assert(!value.split(/[\\/]/).includes('..'));
  let path = resolve(value);
  if (within(alias, path)) path = resolve(temporary, relative(alias, path));
  assert(within(temporary, path));
  let current = temporary;
  for (const part of relative(temporary, path).split(sep)) {
    current = resolve(current, part); const info = await lstat(current);
    assert(info.isDirectory() && !info.isSymbolicLink());
  }
  const info = await lstat(path); assert.equal(info.mode & 0o777, 0o700);
  if (process.getuid) assert.equal(info.uid, process.getuid());
  assert.equal(await realpath(path), path); return path;
}
const source = await privateRoot(sourceValue), fixtureRoot = await privateRoot(fixtureValue);
assert(source !== fixtureRoot && !within(source, fixtureRoot) && !within(fixtureRoot, source));
async function file(root, name) {
  assert(name && !isAbsolute(name) && !name.split(/[\\/]/).includes('..'));
  const path = resolve(root, name); assert(within(root, path));
  let current = root;
  for (const part of relative(root, path).split(sep)) { current = resolve(current, part); assert(!(await lstat(current)).isSymbolicLink()); }
  assert((await lstat(path)).isFile()); return path;
}
async function json(root, name) { return JSON.parse(await readFile(await file(root, name), 'utf8')); }
async function missing(path) {
  try { await lstat(path); assert.fail('Preserve prior qualification; use a new fixture.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function writeOnce(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
async function refused(port) {
  await new Promise((done, fail) => {
    const socket = createConnection({ host: '127.0.0.1', port }); socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); fail(new Error('Owned loopback port remains open.')); });
    socket.once('timeout', () => { socket.destroy(); fail(new Error('Loopback closure is unknown.')); });
    socket.once('error', error => { socket.destroy(); if (error.code === 'ECONNREFUSED') done(); else fail(error); });
  });
}
const isolation = await json(source, 'isolation-receipt.json');
const fixture = await json(fixtureRoot, 'process-fixture.json');
assert.equal(isolation.copiedState, false); assert.equal(isolation.sourceCopyRoot, source);
assert.equal(fixture.sourceCopyRoot, source); assert.equal(fixture.fixtureDirectory, fixtureRoot);
assert.equal(fixture.sourceHead, isolation.sourceHead); assert.equal(fixture.loopbackPort, 4219);
const isolationHash = sha(await readFile(await file(source, 'isolation-receipt.json')));
assert.equal(fixture.isolationReceiptSha256, isolationHash);
assert.equal(sha(await readFile(await file(fixtureRoot, 'process-fixture.sql'))), fixture.sqlSha256);
for (const inventory of [isolation.trackedFiles, isolation.copiedArtifactFiles]) {
  assert(inventory && Object.keys(inventory).length);
  for (const [name, digest] of Object.entries(inventory)) assert.equal(sha(await readFile(await file(source, name))), digest, `Copied input changed: ${name}`);
}
assert(process.stdin.isTTY, 'Use the original interactive TTY control channel; refuse before any owned server/browser startup.');
const helperSha256 = sha(await readFile(new URL(import.meta.url)));
// The sealed future finite plan supplies the reviewed coherent producer tuple.
// Check every original copied producer input and every non-helper consumer input.
// The sole reviewed QA helper delta does not relabel the historical build or
// manufacture a helper-owned self-pinned producer HEAD.
assert.equal(isolation.sourceHead, producerHead);
assert.equal(Object.keys(isolation.trackedFiles).length, Number(producerCount));
const consumer = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const ownedQaHelper = 'scripts/qa/phase5f/browser-genuine-recovery-job-controls.mjs';
for (const [name, digest] of Object.entries(isolation.trackedFiles))
  if (name !== ownedQaHelper) assert.equal(sha(await readFile(await file(consumer, name))), digest, `Consumer producer input changed: ${name}`);
assert.equal(Object.keys(isolation.trackedFiles).filter(name => name !== ownedQaHelper).length, Number(producerCount) - 1);
// The original producer/copy helper remains captured unchanged above. Only this
// reviewed QA helper differs; all frontend, Worker and other producer inputs stay exact.
assert((await lstat(resolve(source, 'node_modules'))).isSymbolicLink());
assert.equal(await realpath(resolve(source, 'node_modules')), isolation.nodeModulesRoot);
const config = await json(source, '.wrangler/deploy.jsonc');
assert.equal(config.vars.AUTH_MODE, 'disabled'); assert.equal(config.account_id, undefined);
assert.equal(config.d1_databases.length, 1); assert.equal(config.d1_databases[0].binding, 'DB');
assert.equal(config.d1_databases[0].database_id, '00000000-0000-4000-8000-000000000000');
for (const key of ['remote', 'preview_database_id']) assert.equal(config.d1_databases[0][key], undefined);
assert.equal(config.r2_buckets.length, 1); assert.equal(config.r2_buckets[0].binding, 'ASSETS');
for (const key of ['remote', 'jurisdiction', 'preview_bucket_name']) assert.equal(config.r2_buckets[0][key], undefined);
const namespace = JSON.parse(config.vars.R2_BOOTSTRAP_NAMESPACE), installation = await json(source, '.wrangler/local-installation.json');
assert.deepEqual(namespace, { kind: 'local-r2', installationId: installation.installationId, bucketName: config.r2_buckets[0].bucket_name });
// The ordinary setup is historical to these two cases, and retains its own
// disabled authentication scope. It is never relabeled authenticated setup.
const priorServer = await json(fixtureRoot, 'isolated-server-receipt.json');
const priorStop = await json(fixtureRoot, 'isolated-server-stop-receipt.json');
const seed = await json(fixtureRoot, 'actual-api-fixture-receipt.json');
const physical = await json(fixtureRoot, 'physical-sqlite-before-api.json');
for (const receipt of [priorServer, priorStop, seed]) {
  assert.equal(receipt.sourceHead, isolation.sourceHead); assert.equal(receipt.sourceCopyRoot, source);
  assert.equal(receipt.fixtureDirectory, fixtureRoot); assert.equal(receipt.isolationReceiptSha256, isolationHash);
}
assert.equal(priorServer.authMode, 'disabled'); assert.equal(priorStop.status, 'stopped');
assert.equal(priorStop.disposalAwaited, true); assert.equal(priorStop.portClosed, true);
assert.equal(priorStop.sessionId, priorServer.sessionId); assert.equal(seed.serverSessionId, priorServer.sessionId);
assert.equal(seed.status, 'prepared'); assert.equal(seed.trace.length, 84);
assert(seed.trace.every(item => item.outcome === 'response_accepted'));
assert.equal(physical.status, 'passed'); assert.equal(physical.sourceHead, isolation.sourceHead);
assert.equal(physical.isolationReceiptSha256, isolationHash);
assert(Object.values(physical.results).length && Object.values(physical.results).every(item => item.quickCheck.length === 1
  && item.quickCheck[0][0] === 'ok' && item.foreignKeyCheck.length === 0));
assert.equal(priorStop.startupReceiptSha256, sha(await readFile(await file(fixtureRoot, 'isolated-server-receipt.json'))));
try { process.kill(priorServer.sessionPid, 0); assert.fail('Await the original seed Worker process exit.'); }
catch (error) { if (error.code !== 'ESRCH') throw error; }
await refused(4219);
// This witness names the actual coherent CF Worker+frontend producer, not the
// independent Node local-auth target or an older Recovery presentation build.
const freshBuild = await json(fixtureRoot, 'enabled-storage-draft-build-input-witness.json');
assert.equal(freshBuild.status, 'passed'); assert.deepEqual(freshBuild.command, ['npm', 'run', 'build']);
assert.equal(freshBuild.actualExitCode, 0); assert.equal(freshBuild.directChildReaped, true);
assert.equal(freshBuild.sourceHead, isolation.sourceHead);
assert.equal(freshBuild.sourceTree, isolation.sourceTree);
assert.equal(freshBuild.sourceRoot, isolation.sourceRoot);
assert.equal(freshBuild.trackedInputInventorySha256, sha(JSON.stringify(isolation.trackedFiles)));
assert.equal(freshBuild.workerSha256, isolation.activeBuild.scriptSha256);
assert.equal(freshBuild.activeBuildConfigSha256, isolation.activeBuild.configSha256);
assert.equal(freshBuild.copiedArtifactInventorySha256, sha(JSON.stringify(isolation.copiedArtifactFiles)));
assert(/^[a-f0-9]{64}$/.test(freshBuild.originalCommandReceiptSha256));
const { productionWorkerArtifact } = await import(pathToFileURL(await file(source, 'scripts/production-worker-artifact.mjs')));
const artifact = await productionWorkerArtifact(source);
assert.equal(artifact.scriptPath, await file(source, isolation.activeBuild.scriptPath));
assert.equal(sha(await readFile(artifact.scriptPath)), isolation.activeBuild.scriptSha256);
const require = createRequire(resolve(source, 'package.json'));
const { Miniflare, Log, LogLevel } = require('miniflare');
const { generateKeyPair, exportJWK, SignJWT } = await import(pathToFileURL(require.resolve('jose')));
const moduleValue = process.env.PLAYWRIGHT_MODULE_PATH;
assert(moduleValue && process.env.CHROMIUM_PATH, 'Use explicitly installed Playwright and Chromium; no downloads.');
const { chromium } = require(resolve(moduleValue));

const expectedCases = ['historical-backup-controls-1280-light', 'historical-backup-controls-390-dark'];
const output = resolve(fixtureRoot, 'genuine-recovery-job-controls-browser-artifacts-original-native-byte-proof-attempt5');
const reportPath = resolve(fixtureRoot, 'genuine-recovery-job-controls-browser-report-original-native-byte-proof-attempt5.json');
const stopPath = resolve(fixtureRoot, 'genuine-recovery-job-controls-runtime-stop-original-native-byte-proof-attempt5.json');
const progressPath = resolve(fixtureRoot, 'genuine-recovery-job-controls-browser-progress-original-native-byte-proof-attempt5.ndjson');
for (const path of [output, reportPath, stopPath, progressPath]) await missing(path);
await mkdir(output, { mode: 0o700 }); await writeFile(progressPath, '', { flag: 'wx', mode: 0o600 });
const report = { version:1, scope:'Two genuine signed-administrator metadata job-control cases on an isolated current24/mature84 fixture. Shared executor enable200/disable200, each historical preview200/backup202/pause200/resume200/cancel200. Maximum10 original mutation requests. No scheduled/executeStep invocation, ZIP, artifact write, recovery target, provider, rich recovery report, deployment/device or whole5F acceptance.',
  sourceRoot:isolation.sourceRoot,sourceCopyRoot:source,sourceHead:isolation.sourceHead,sourceTree:isolation.sourceTree,
  fixtureDirectory:fixtureRoot,isolationReceiptSha256:isolationHash,helperSha256,protectedProducerInputsExact:true,
  causalProducerInputScope:{originalCopiedProducerInputsExact:true,nonHelperConsumerInputsExact:Number(producerCount)-1,
    ownedQaHelper,originalProducerHelperSha256:isolation.trackedFiles[ownedQaHelper],qaConsumerRoot:consumer},
  seedReceiptSha256:sha(await readFile(await file(fixtureRoot,'actual-api-fixture-receipt.json'))),
  freshBuildReceiptSha256:sha(await readFile(await file(fixtureRoot,'enabled-storage-draft-build-input-witness.json'))),
  sessionId:randomUUID(),sessionPid:process.pid,expectedCases,cases:[],auxiliaryRequests:[],mutationJournal:[],jwksRequests:[],
  startedAt:new Date().toISOString(),status:'running' };
let jwksServer,runtime,browser,database,originalDatabaseSnapshot;
let originalBrowserClose,originalWorkerDispose,originalJwksClose;
const activeContexts=new Set(),originalContextCloses=new WeakMap();
function notInterrupted() { assert(!report.interrupted, 'Qualification was interrupted; later cases remain unrun.'); }
function closeContext(context) {
  let original = originalContextCloses.get(context);
  if (!original) { original = context.close(); originalContextCloses.set(context, original); }
  return original;
}
function closeBrowser() { return originalBrowserClose ??= browser.close(); }
function disposeWorker() { return originalWorkerDispose ??= runtime.dispose(); }
function closeJwks() { return originalJwksClose ??= new Promise((done, fail) => jwksServer.close(error => error ? fail(error) : done())); }
// Miniflare's installed SIGTERM hook calls process.exit(143), so signals are
// external interruption evidence, never an awaited normal finally mechanism.
// Only an explicit stop on this helper's original inherited TTY starts this
// ordered cancellation. Keep D1 alive until original application rows/catalog are verified.
// Compile exact genuine contracts/hash/namespace modules with the installed
// locked esbuild; no hand-authored copy of validators or hash algorithms.
// Its public stop promise observes the stop request, not native child exit.
const {build,stop}=require('esbuild');
const originalModuleSources=new Map(),compiledModules=new Map();
try {
  for(const name of ['shared/contracts/system-recovery.ts','shared/domain/content-addressing.ts','worker/files/r2-profile-bindings.ts']) {
    const contents=await readFile(await file(source,name),'utf8');originalModuleSources.set(name,contents);
    const compiled=await build({stdin:{contents,loader:'ts',sourcefile:name},write:false,platform:'node',format:'esm',target:'es2022',logLevel:'silent'});
    assert.equal(compiled.outputFiles.length,1);assert.equal(compiled.warnings.length,0);
    const executable=compiled.outputFiles[0].text;assert(!/\bimport\s*(?:\(|[^;]*\bfrom\b)/.test(executable));
    compiledModules.set(name,{executable,module:await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`)});
  }
} finally {await stop();}
const {checkedSystemRecoveryCapabilities,checkedSystemRecoveryBackupPreview,checkedSystemRecoveryMaintenanceStatus,
  checkedSystemRecoveryBackupInput,checkedSystemRecoveryReceipt,checkedSystemRecoveryJobStatus,checkedSystemRecoveryJobControl}=compiledModules.get('shared/contracts/system-recovery.ts').module;
const {stableJson}=compiledModules.get('shared/domain/content-addressing.ts').module;
const {canonicalR2ProfileNamespace}=compiledModules.get('worker/files/r2-profile-bindings.ts').module;
report.genuineModuleCompilation=[...compiledModules].map(([path,item])=>({path,sourceSha256:sha(originalModuleSources.get(path)),executableSha256:sha(item.executable)}));
const namespaceIdentity=canonicalR2ProfileNamespace(config.vars.R2_BOOTSTRAP_NAMESPACE);
const expectedCheckpoint={artifactNamespace:{bindingName:'ASSETS',namespaceIdentity,sha256:sha(stableJson({bindingName:'ASSETS',namespaceIdentity}))}};
let originalControlStop;
function stopFromOriginalControl() {
  return originalControlStop ??= (async () => {
    report.interrupted ??= 'original-stdin-stop'; report.status = 'failed';
    report.originalStdinStopReceived = report.controlInputError === undefined;
    try { await Promise.all([...activeContexts].map(closeContext)); }
    finally { if (browser) await closeBrowser(); }
  })();
}
function originalControlInput(value) {
  if (value !== 'stop\n') {
    report.controlInputError = 'Only the original explicit stop command is permitted.';
  }
  void stopFromOriginalControl().catch(error => {
    report.controlStopError = privateError(error);
  });
}
process.stdin.setEncoding('utf8');
process.stdin.once('data', originalControlInput);
process.stdin.resume();

let issuer,issuerPort,signingKey,readerToken,adminToken;
const reader='researcher@recovery-preview.invalid',admin='administrator@recovery-preview.invalid',audience=`recovery-preview-${randomUUID()}`;
const canonical=value=>JSON.stringify(value,(_key,item)=>item instanceof ArrayBuffer
  ? {bytes:Buffer.from(item).toString('hex')} : ArrayBuffer.isView(item) ? {bytes:Buffer.from(item.buffer,item.byteOffset,item.byteLength).toString('hex')} : item);
const privateValues=new Set([reader,admin]);
function privateError(error) {
  let value=String(error.stack||error.message||error);
  for(const item of privateValues) if(item)value=value.split(item).join('[private fixture input]');
  return value;
}
async function snapshot() {
  const schema = (await database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results;
  assert(schema.length > 0 && schema.length < 3000);
  const tables = schema.filter(item => item.type === 'table' && !item.name.startsWith('_cf_'));
  const rows = {};
  for (const table of tables) {
    assert(/^[a-zA-Z0-9_]+$/.test(table.name));
    const values = (await database.prepare(`SELECT * FROM "${table.name}"`).all()).results;
    assert(values.length < 10000); rows[table.name] = { count: values.length, sha256: sha(values.map(canonical).sort().join('\n')) };
  }
  return { schemaSha256: sha(canonical(schema)), tables: rows };
}
async function visible(locator) { await locator.waitFor({ state: 'visible', timeout: 20000 }); }
async function absent(locator) { await locator.waitFor({ state: 'hidden', timeout: 20000 }); }
async function geometry(page, record, surface, theme) {
  const value = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const safeClasses = new Set(['page', 'storage-settings-page', 'page-heading', 'button', 'primary', 'card', 'storage-settings-section',
      'storage-profile-list', 'storage-profile-heading', 'storage-candidate-checks', 'storage-candidate-readiness', 'storage-credential-encryption',
      'storage-candidate-form', 'storage-candidate-fields', 'storage-candidate-credentials', 'storage-candidate-actions', 'storage-candidate-checkbox',
      'storage-readiness-details', 'storage-check-stages', 'storage-settings-observation', 'muted', 'error-banner', 'lead',
      'system-recovery-page', 'system-recovery-navigation', 'system-recovery-report', 'system-recovery-table', 'warning-card']);
    const safeIds = new Set(['storage-candidates-title', 'storage-editor-title', 'storage-expected-owner-help']);
    const safeRoles = new Set(['alert', 'status', 'button', 'heading', 'region', 'group', 'list', 'listitem']);
    const number = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
    const elements = [...document.querySelectorAll('body *')];
    const offenders = [];
    for (const element of elements.slice(0, 3000)) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || (rect.left >= -2 && rect.right <= width + 2)) continue;
      const role = element.getAttribute('role');
      offenders.push({ tag: element.tagName.toLowerCase(), classes: [...element.classList].filter(token => safeClasses.has(token)).slice(0, 8),
        id: safeIds.has(element.id) ? element.id : null, role: safeRoles.has(role) ? role : null,
        rect: { left: number(rect.left), right: number(rect.right), top: number(rect.top), bottom: number(rect.bottom), width: number(rect.width), height: number(rect.height) },
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth });
    }
    return { width, viewport: { width: innerWidth, height: innerHeight }, root: document.documentElement.scrollWidth,
      body: document.body.scrollWidth, theme: document.documentElement.dataset.theme, inspectedElements: Math.min(elements.length, 3000),
      totalElements: elements.length, offendingElements: offenders.slice(0, 24), remainingOffenderCount: Math.max(0, offenders.length - 24) };
  });
  // Persist bounded numeric geometry before the original assertion. Never record
  // text, form values, URLs, arbitrary attributes, DOM markup or a failed screenshot.
  record.assertions.push({ surface, geometry: value });
  assert.match(record.id, /^[a-z0-9-]+$/); assert.match(surface, /^[a-z0-9-]+$/);
  await writeFile(resolve(output, `${record.id}.${surface}.geometry.json`), canonical({ surface, geometry: value }) + '\n', { flag: 'wx', mode: 0o600 });
  assert.equal(value.theme, theme); assert(value.root <= value.width + 2 && value.body <= value.width + 2);
}

// The initial view and action results can render a native control before
// readPhase/busy clears. Wait on that exact connected node under the existing
// 20s budget, then retain each original enabled/focus assertion.
async function nativeEnabled(page,locator) {
  const original=await locator.elementHandle();assert(original);
  try {
    const settled=await page.waitForFunction(node=>node.isConnected&&!node.matches(':disabled'),original,{timeout:20000});
    await settled.dispose();
  } finally {await original.dispose();}
}

const sharedWork=[],intents=new Map(),priorFinalJobs=new Map();
let originalEnable,originalDisable,originalRuntimeRow;
const rowsOf=name=>database.prepare(`SELECT * FROM "${name}"`).all().then(value=>value.results);
function registerMutation(kind,path,input,caseId=null) {
  assert(report.mutationJournal.length<10,'At most10 original mutation requests are permitted.');
  const entry={ordinal:report.mutationJournal.length+1,kind,path,method:'POST',caseId,
    inputSha256:sha(stableJson(input)),startedAt:new Date().toISOString(),outcome:'registered'};
  report.mutationJournal.push(entry);return entry;
}
async function boundedOriginal(work,label) {
  let timer;
  try {return await Promise.race([work,new Promise((_done,fail)=>{timer=setTimeout(()=>fail(new Error(`${label} exceeds the original20s budget.`)),20000);})]);}
  finally {clearTimeout(timer);}
}
function configureOnce(enabled) {
  const prior=enabled?originalEnable:originalDisable;if(prior)return prior;
  const input={enabled},entry=registerMutation(enabled?'shared-enable':'shared-disable','/api/system-recovery/executor',input);
  // Register the original work before its microtask invokes the genuine fetch.
  // A failed/interrupted enable is not retried; its retained disable is still
  // issued once after original browser/interception work has settled.
  const work=Promise.resolve().then(async()=>{
    entry.outcome='issued';
    const response=await fetch(new URL(entry.path,base),{method:'POST',headers:{'content-type':'application/json','cf-access-jwt-assertion':adminToken},
      body:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(20000)});
    entry.backendStatus=response.status;
    const bytes=Buffer.from(await response.arrayBuffer());assert(bytes.length<131072);
    entry.originalBackendBody='completed';entry.responseSha256=sha(bytes);entry.completedAt=new Date().toISOString();
    assert.equal(response.status,200);const capability=checkedSystemRecoveryCapabilities(JSON.parse(bytes.toString('utf8')));
    assert.equal(capability.supported,true);assert.equal(capability.canManage,true);assert.equal(capability.enabled,enabled);
    assert.equal(capability.reason,enabled?null:'executor_disabled');assert.equal(capability.lastHeartbeatAt,null);
    assert.deepEqual(capability.target,{configured:false,id:null,mode:'fresh'});assert.deepEqual(capability.maintenance,{state:'open',checkpoint:null});
    entry.outcome='response_accepted';return capability;
  }).catch(error=>{entry.outcome='failed';entry.error=privateError(error);throw error;});
  sharedWork.push(work);work.catch(()=>{});
  if(enabled)originalEnable=work;else originalDisable=work;return work;
}
function publicJob(value,state,requestId,jobId) {
  const job=checkedSystemRecoveryJobStatus(value);assert.equal(job.kind,'backup');assert.equal(job.state,state);
  assert.equal(job.phase,'snapshot');assert.equal(job.requestId,requestId);if(jobId)assert.equal(job.id,jobId);
  assert.deepEqual(job.progress,{completedFiles:0,totalFiles:0,bytesDone:0,bytesTotal:0});
  assert.equal(job.output,null);assert.equal(job.result,null);assert.equal(job.reason,state==='paused'?'paused_by_administrator':null);
  return job;
}
async function verifyHistory(stage,fullyPassed=false) {
  const after=await snapshot();assert.equal(after.schemaSha256,originalDatabaseSnapshot.schemaSha256);
  const changed=new Set(['system_recovery_jobs','system_recovery_requests','system_recovery_runtime']);
  assert.deepEqual(Object.keys(after.tables).sort(),Object.keys(originalDatabaseSnapshot.tables).sort());
  for(const [name,value] of Object.entries(originalDatabaseSnapshot.tables))if(!changed.has(name))
    assert.deepEqual(after.tables[name],value,`Unexpected application rows changed: ${name}`);
  const runtimeRows=await rowsOf('system_recovery_runtime');assert.equal(runtimeRows.length,1);
  const row=runtimeRows[0];assert.deepEqual(Object.keys(row).sort(),Object.keys(originalRuntimeRow).sort());
  for(const key of Object.keys(originalRuntimeRow))if(!['enabled','incarnation','updated_at'].includes(key))assert.equal(row[key],originalRuntimeRow[key],`Unexpected runtime field: ${key}`);
  assert.match(row.incarnation,/^[a-f0-9]{32}$/);assert(Number.isFinite(Date.parse(row.updated_at)));
  const shared=report.mutationJournal.filter(item=>item.kind.startsWith('shared-'));
  const lastConfirmed=[...shared].reverse().find(item=>item.outcome==='response_accepted');
  if(lastConfirmed&&shared.at(-1)===lastConfirmed)assert.equal(row.enabled,lastConfirmed.kind==='shared-enable'?1:0);
  else assert([0,1].includes(row.enabled)); // Failed original response retains uncertainty, never a PASS.
  if(!shared.length)assert.deepEqual(row,originalRuntimeRow);
  else assert(shared.some(item=>Date.parse(row.updated_at)>=Date.parse(item.startedAt)&&Date.parse(row.updated_at)<=Date.parse(item.completedAt??new Date().toISOString())));
  const jobs=await rowsOf('system_recovery_jobs'),requests=await rowsOf('system_recovery_requests');
  assert(jobs.length<=2);assert.equal(requests.length,jobs.length);assert.equal(after.tables.system_recovery_write_leases.count,63);
  for(const [requestId,intent] of intents)if(intent.entry.outcome==='response_accepted') {
    const retained=jobs.filter(item=>item.request_id===requestId);assert.equal(retained.length,1,'An original accepted backup must remain saved.');
    assert.equal(retained[0].id,intent.entry.jobId);assert.equal(retained[0].accepted_at,intent.acceptedAt);
  }
  if(fullyPassed)assert.equal(jobs.length,intents.size);
  const expectedKeys=['id','request_id','actor','kind','state','phase','input_json','accepted_at','updated_at','reason','generation','owner_token','runtime_incarnation','lease_expires_at',
    'source_upload_job_id','target_id','target_incarnation','checkpoint_json','source_checkpoint','artifact_key','archive_byte_size','archive_sha256','expires_at',
    'completed_files','total_files','bytes_done','bytes_total','result_json'].sort();
  const lineages=[];
  for(const job of jobs) {
    assert.deepEqual(Object.keys(job).sort(),expectedKeys);const intent=intents.get(job.request_id);assert(intent,'Only an original registered browser request may create a job.');
    assert(job.actor===admin,'Accepted job must retain the genuine signed administrator.');assert.equal(job.kind,'backup');assert.equal(job.phase,'snapshot');
    assert.equal(job.input_json,stableJson(intent.input));assert.equal(job.checkpoint_json,stableJson(expectedCheckpoint));
    for(const key of ['owner_token','runtime_incarnation','lease_expires_at','source_upload_job_id','target_id','target_incarnation','source_checkpoint','artifact_key','archive_byte_size','archive_sha256','expires_at','result_json'])assert.equal(job[key],null,`Executor/target/artifact work is outside this scope: ${key}`);
    for(const key of ['completed_files','total_files','bytes_done','bytes_total'])assert.equal(job[key],0);
    assert(Number.isFinite(Date.parse(job.accepted_at))&&Number.isFinite(Date.parse(job.updated_at))&&Date.parse(job.updated_at)>=Date.parse(job.accepted_at));
    assert(Date.parse(job.accepted_at)>=Date.parse(intent.entry.startedAt));
    const controls=report.mutationJournal.filter(item=>item.caseId===intent.caseId&&item.kind==='control');
    const actionOrder=['pause','resume','cancel'];assert(controls.length<=3);
    controls.forEach((item,index)=>{assert.equal(item.action,actionOrder[index]);assert.equal(item.jobId,job.id);});
    const confirmed=controls.findIndex(item=>item.outcome!=='response_accepted');
    const minimum=confirmed===-1?controls.length:confirmed;
    const possible=[];
    for(let prefix=minimum;prefix<=controls.length;prefix++) {
      const state=['queued','paused','queued','cancelled'][prefix],reason=prefix===1?'paused_by_administrator':null;
      possible.push({state,generation:prefix,reason});
      // Mandatory genuine disable pauses only still-queued work. This is an
      // exact source transition, not an allowance for arbitrary job changes.
      if(originalDisable&&state==='queued')possible.push({state:'paused',generation:prefix+1,reason:'executor_reconfigured'});
    }
    assert(possible.some(value=>value.state===job.state&&value.generation===job.generation&&value.reason===job.reason),'Original registered controls/disable must explain the exact accepted state.');
    const request=requests.filter(value=>value.job_id===job.id);assert.equal(request.length,1);
    assert.deepEqual(Object.keys(request[0]).sort(),['request_id','actor','job_id','input_sha256','accepted_at'].sort());
    assert(request[0].actor===admin);assert.equal(request[0].request_id,job.request_id);assert.equal(request[0].input_sha256,sha(stableJson(intent.input)));assert.equal(request[0].accepted_at,job.accepted_at);
    const old=priorFinalJobs.get(job.id);if(old){assert.equal(sha(canonical(job)),old.jobSha256);assert.equal(sha(canonical(request[0])),old.requestSha256);}
    if(fullyPassed){assert.equal(job.state,'cancelled');assert.equal(job.generation,3);assert.equal(job.reason,null);}
    lineages.push({jobId:job.id,requestId:job.request_id,actorMatchesCurrentSignedSubject:true,actorSha256:sha(job.actor),
      inputSha256:request[0].input_sha256,checkpointSha256:sha(job.checkpoint_json),state:job.state,generation:job.generation,reason:job.reason,
      jobSha256:sha(canonical(job)),requestSha256:sha(canonical(request[0])),noExecutionOrTargetOrArtifactWork:true});
  }
  assert.equal(new Set(jobs.map(item=>item.request_id)).size,jobs.length);
  assert.deepEqual((await database.prepare('PRAGMA foreign_key_check').all()).results,[]);
  const evidence={stage,schemaExact:true,onlyThreeExplicitMetadataTablesMayDiffer:true,allOtherApplicationTablesExact:true,
    original63WritePermitsExact:true,addedPermits:0,acceptedJobs:jobs.length,requestRows:requests.length,runtimeEnabled:row.enabled,
    runtimeIncarnationSha256:sha(row.incarnation),runtimeRowSha256:sha(canonical(row)),lineages};
  report.historyEvidence??=[];report.historyEvidence.push(evidence);return evidence;
}
async function actualReaderGet(path,expectedStatus) {
  notInterrupted();
  const response=await fetch(new URL(path,base),{method:'GET',headers:{'cf-access-jwt-assertion':readerToken},redirect:'error',signal:AbortSignal.timeout(20000)});
  const bytes=Buffer.from(await response.arrayBuffer());assert(bytes.length<131072);
  const item={path,method:'GET',status:response.status,body:'completed',responseSha256:sha(bytes)};report.auxiliaryRequests.push(item);
  assert.equal(response.status,expectedStatus);return JSON.parse(bytes.toString('utf8'));
}
// Record only closed protocol fields, never authentication or arbitrary text.
function safeBodyHeaders(headers) {
  const type=headers['content-type'],encoding=headers['content-encoding'],length=headers['content-length'],transfer=headers['transfer-encoding'];
  return {contentType:type===undefined?null:/^application\/json(?:;\s*charset=utf-8)?$/i.test(type)?type.toLowerCase():'other',
    contentEncoding:encoding===undefined?null:/^(?:gzip|br|deflate|identity)$/i.test(encoding)?encoding.toLowerCase():'other',
    contentLength:length===undefined?null:/^[0-9]{1,9}$/.test(length)?Number(length):'other',
    transferEncoding:transfer===undefined?null:/^(?:chunked|identity)$/i.test(transfer)?transfer.toLowerCase():'other'};
}
async function originalResponseBody(capture) {
  await boundedOriginal(capture.observation,'Original API body');assert.equal(capture.item.body,'completed');return capture.bytes;
}
async function caseRun(id,width,theme) {
  notInterrupted();
  const record={id,width,theme,mode:'historical',status:'running',assertions:[],browserRequests:[],api:[],backendResponses:[],pageErrors:[],externalRequests:[],startedAt:new Date().toISOString()};
  report.cases.push(record);await writeFile(progressPath,canonical({id,status:'running'})+'\n',{flag:'a'});
  let context,page,nextMutation=0;
  const bodies=[],routeWork=[],responseWaits=[],captures=new WeakMap(),nativeMutations=new WeakMap();
  const originalRequestTerminals=new WeakMap();record.originalRequestTerminals=[];const originalStartedMono=performance.now();
  let originalApplicationRequestOrdinal=0;
  try {
    context=await browser.newContext({viewport:{width,height:900},colorScheme:theme,isMobile:width===390,hasTouch:width===390,serviceWorkers:'block'});activeContexts.add(context);
    await context.route('**/*',route=>{
      const work=Promise.resolve().then(async()=>{
        const request=route.request(),url=new URL(request.url());
        if(['http:','https:'].includes(url.protocol)&&url.origin!==base.origin){record.externalRequests.push({origin:url.origin});await route.abort('blockedbyclient');return;}
        if(url.origin!==base.origin||!url.pathname.startsWith('/api/')){await route.continue();return;}
        const headers={...request.headers(),'cf-access-jwt-assertion':adminToken};
        if(request.method()==='GET'){
          assert(['/api/system-recovery/capabilities','/api/system-recovery/jobs','/api/system-recovery/maintenance','/api/system-recovery/backup-preview'].includes(url.pathname),'Only the original page status/poll/preview GETs are allowed.');
          await route.continue({headers});return;
        }
        assert.equal(request.method(),'POST');assert(nextMutation<4,'No replay or additional mutation may be forwarded.');
        const raw=request.postDataJSON();let input,entry;
        if(nextMutation===0){
          assert.equal(url.pathname,'/api/system-recovery/jobs');input=checkedSystemRecoveryBackupInput(raw);assert.equal(input.kind,'backup');assert.equal(input.mode,'historical');
          assert.match(input.requestId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);assert(!intents.has(input.requestId));
          entry=registerMutation('backup',url.pathname,input,id);entry.requestId=input.requestId;record.requestId=input.requestId;
          intents.set(input.requestId,{input,caseId:id,entry});
        } else {
          assert(record.jobId);assert.equal(url.pathname,`/api/system-recovery/jobs/${record.jobId}/control`);
          const action=checkedSystemRecoveryJobControl(raw);assert.equal(action,['pause','resume','cancel'][nextMutation-1]);input={action};
          entry=registerMutation('control',url.pathname,input,id);entry.jobId=record.jobId;entry.action=action;
        }
        nextMutation++;nativeMutations.set(request,entry);entry.outcome='issued';
        // Forward exactly this genuine native intent once. Retain its original
        // backend response/body and callback through context cancellation.
        // Fulfill only the original status/headers/bytes; no invented DTO.
        const original=await route.fetch({headers,maxRedirects:0,maxRetries:0,timeout:20000});entry.backendStatus=original.status();
        const bytes=await original.body();assert(bytes.length<131072);entry.originalBackendBody='completed';entry.responseSha256=sha(bytes);
        record.backendResponses.push({path:url.pathname,status:original.status(),body:'completed',responseSha256:sha(bytes),mutationOrdinal:entry.ordinal,originalBackendHeaders:safeBodyHeaders(original.headers())});
        assert.equal(original.status(),entry.kind==='backup'?202:200);
        if(entry.kind==='backup'){
          const receipt=checkedSystemRecoveryReceipt(JSON.parse(bytes.toString('utf8')));assert.equal(receipt.requestId,record.requestId);assert.equal(receipt.reused,false);
          const job=publicJob(receipt.job,'queued',record.requestId);record.jobId=job.id;entry.jobId=job.id;
          intents.get(record.requestId).acceptedAt=job.acceptedAt;entry.publicJobSha256=sha(stableJson(job));
        } else publicJob(JSON.parse(bytes.toString('utf8')),{pause:'paused',resume:'queued',cancel:'cancelled'}[entry.action],record.requestId,record.jobId);
        entry.outcome='response_accepted';entry.completedAt=new Date().toISOString();
        await route.fulfill({status:original.status(),headers:original.headers(),body:bytes});entry.nativeDelivery='fulfilled';
      });
      routeWork.push(work);work.catch(()=>{});return work;
    });
    await context.addInitScript(() => {
      const originalFetch=window.fetch,observations=[],signalOwners=new WeakMap();let nextSignalOwner=0;
      Object.defineProperty(window,'__phase5fRecoveryControlCallerSignalObservations',{value:observations});
      const category=signal=>{if(!signal.aborted)return null;const reason=signal.reason;
        return reason instanceof DOMException?(reason.name==='AbortError'?'AbortError':reason.name==='TimeoutError'?'TimeoutError':'other-dom-exception')
          :reason instanceof Error?'error':reason==null?'none':'other-private-reason';};
      const applicationBodies=[],bodyWork=[],copies=new WeakMap(),inputs=new WeakMap(),completions=new WeakMap(),originalResponses=new WeakMap(),originalReaders=new WeakMap();
      const complete=info=>{const owner=completions.get(info);if(owner&&!owner.settled){owner.settled=true;owner.resolve();}};
      const observe=(promise,info,fulfilled,rejected)=>{
        const work={state:'pending'};bodyWork.push(work);
        work.promise=Promise.prototype.then.call(promise,value=>{
          try{fulfilled(value);}catch{info.observerErrors++;}finally{work.state='settled';}
        },error=>{try{rejected(error);}catch{info.observerErrors++;}finally{work.state='settled';}});
      };
      const failureCategory=error=>error instanceof DOMException?'dom-exception':error instanceof Error?'error':'other-private-error';
      const installOriginalBody=(response,info)=>{
        originalResponses.set(info,response);info.fetchOutcome='fulfilled';info.status=response.status;
        const body=response.body;info.bodyPresent=!!body;if(!body)return;
        const originalGetReader=body.getReader;
        body.getReader=function(...args){
          let reader;
          try{reader=Reflect.apply(originalGetReader,this,args);}
          catch(error){if(this===body){info.getReaderThrows++;info.lastErrorCategory=failureCategory(error);}throw error;}
          if(this!==body)return reader;
          try{
            originalReaders.set(info,reader);info.getReaderCalls++;info.getReaderArguments=args.length;
            const originalRead=reader.read,originalCancel=reader.cancel,originalRelease=reader.releaseLock;
            reader.read=function(...readArgs){
              let promise;
              try{promise=Reflect.apply(originalRead,this,readArgs);}
              catch(error){if(this===reader){info.readThrows++;info.lastErrorCategory=failureCategory(error);}throw error;}
              if(this===reader){try{
                const ordinal=++info.readCalls;
                observe(promise,info,next=>{
                  info.readSettled++;const length=next.value instanceof Uint8Array?next.value.byteLength:0;
                  if(info.readResults.length<64)info.readResults.push({ordinal,arguments:readArgs.length,done:next.done===true,byteLength:length});
                  else info.resultsLimited=true;
                  if(next.done===true)info.observedEOF=true;
                  else{
                    info.yieldedBytes+=length;const parts=copies.get(info),remaining=131072-info.copiedBytes;
                    const take=parts.length<64?Math.min(length,Math.max(0,remaining)):0;
                    if(take){parts.push(new Uint8Array(next.value.subarray(0,take)));info.copiedBytes+=take;}
                    if(take!==length)info.copyLimited=true;
                  }
                },error=>{info.readSettled++;info.readRejected++;info.lastErrorCategory=failureCategory(error);});
              }catch{info.observerErrors++;}}
              return promise;
            };
            reader.cancel=function(...cancelArgs){
              let promise;
              try{promise=Reflect.apply(originalCancel,this,cancelArgs);}
              catch(error){if(this===reader){info.cancelThrows++;info.lastErrorCategory=failureCategory(error);}throw error;}
              if(this===reader){try{info.cancelCalls++;info.cancelArguments=cancelArgs.length;
                observe(promise,info,()=>{info.cancelSettled++;},error=>{info.cancelSettled++;info.cancelRejected++;info.lastErrorCategory=failureCategory(error);});
              }catch{info.observerErrors++;}}
              return promise;
            };
            reader.releaseLock=function(...releaseArgs){
              let value;
              try{value=Reflect.apply(originalRelease,this,releaseArgs);}
              catch(error){if(this===reader){info.releaseThrows++;info.lastErrorCategory=failureCategory(error);}throw error;}
              if(this===reader){try{info.releaseCalls++;info.releaseArguments=releaseArgs.length;info.releaseReturnedUndefined=value===undefined;complete(info);}catch{info.observerErrors++;}}
              return value;
            };
          }catch{info.observerErrors++;}
          return reader;
        };
      };
      // This proof uses only bytes yielded by the application's exact original
      // Response/reader/read Promises. It does not invoke another body read.
      Object.defineProperty(window,'__phase5fRecoveryOriginalApplicationBytes',{value:async ordinal=>{
        const info=applicationBodies.find(item=>item.fetchOrdinal===ordinal);if(!info)throw new Error('Original application fetch owner unavailable.');
        await completions.get(info).promise;
        const frozen=Object.freeze({...info,readResults:Object.freeze(info.readResults.map(result=>Object.freeze({...result})))});
        const response=originalResponses.get(info),reader=originalReaders.get(info),input=inputs.get(info);
        const bytes=new Uint8Array(frozen.copiedBytes);let offset=0;
        for(const part of copies.get(info)){bytes.set(part,offset);offset+=part.byteLength;}
        const inputBytes=input===null?null:new Uint8Array(input);
        const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',value))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
        const responseSha256=await digest(bytes),requestBodySha256=inputBytes===null?null:await digest(inputBytes);
        return {metadata:frozen,originalResponseAndReaderIdentityBound:!!response&&!!reader&&response.status===frozen.status,
          requestBodySha256,responseSha256,bytes:Array.from(bytes)};
      }});
      Object.defineProperty(window,'__phase5fRecoveryControlApplicationBodySnapshot',{value:async()=>{
        // Observe only work attached to original native Promises. No new read,
        // body clone or request is used; only bounded already-yielded bytes hash.
        const awaitedBoundary=bodyWork.slice();
        await Promise.allSettled(awaitedBoundary.map(work=>work.promise));
        // Freeze one synchronous metadata/byte cut before any digest await.
        // Later original reads cannot upgrade this captured prefix or its hash.
        const observerBoundary=Object.freeze({registeredInAwaitedBoundary:awaitedBoundary.length,
          settledInAwaitedBoundary:awaitedBoundary.filter(work=>work.state==='settled').length,
          registeredAtMetadataCut:bodyWork.length,settledAtMetadataCut:bodyWork.filter(work=>work.state==='settled').length});
        const responseCount=applicationBodies.length;
        const snapshots=applicationBodies.slice(0,6).map(info=>{
          const frozen=Object.freeze({...info,readResults:Object.freeze(info.readResults.map(result=>Object.freeze({...result})))});
          const bytes=new Uint8Array(frozen.copiedBytes);let offset=0;
          for(const part of copies.get(info)){bytes.set(part,offset);offset+=part.byteLength;}
          return {frozen,bytes};
        });
        const responses=await Promise.all(snapshots.map(async({frozen,bytes})=>{
          const digest=await crypto.subtle.digest('SHA-256',bytes);
          const hash=[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
          return {...frozen,alreadyYieldedBoundedBytesSha256:hash,
            hashScope:frozen.observedEOF&&!frozen.copyLimited&&frozen.copiedBytes===frozen.yieldedBytes&&frozen.observerErrors===0
              ?'complete-original-application-consumed-stream':'captured-original-yielded-prefix'};
        }));
        return {responses,responseCount,observerBoundary,originalPromiseObservers:observerBoundary.registeredAtMetadataCut,
          originalPromiseObserversSettled:observerBoundary.settledAtMetadataCut};
      }});
      // Observe only the original caller Signal. The native call retains its
      // exact arguments, this and original returned Promise; no response clone.
      window.fetch=function(...args){
        let applicationBody;
        try {
          const [input,init]=args;
          const url=new URL(input instanceof Request?input.url:input instanceof URL?input.href:String(input),location.href);
          const method=String(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
          const originalInitialization=method==='GET'&&['/api/system-recovery/capabilities','/api/system-recovery/maintenance'].includes(url.pathname);
          const originalControl=method==='POST'&&(url.pathname==='/api/system-recovery/jobs'||/^\/api\/system-recovery\/jobs\/[a-f0-9-]{36}\/control$/.test(url.pathname));
          if(url.origin===location.origin&&(originalInitialization||originalControl)&&observations.length<6) {
            const signal=init?.signal??(input instanceof Request?input.signal:null);
            if(signal&&!signalOwners.has(signal))signalOwners.set(signal,++nextSignalOwner);
            const item={ordinal:observations.length+1,path:url.pathname,method,signalPresent:!!signal,
              originalSignalOwner:signal?signalOwners.get(signal):null,scope:originalInitialization?'initialization':'control',
              signalAbortedAtCall:signal?.aborted??null,abortEventObserved:false,reasonCategory:signal?category(signal):null};
            observations.push(item);
            {
              applicationBody={fetchOrdinal:item.ordinal,path:url.pathname,method,originalSignalOwner:item.originalSignalOwner,scope:item.scope,fetchOutcome:'pending',status:null,bodyPresent:null,getReaderCalls:0,getReaderThrows:0,
                readCalls:0,readSettled:0,readRejected:0,readThrows:0,readResults:[],resultsLimited:false,observedEOF:false,yieldedBytes:0,copiedBytes:0,copyLimited:false,
                cancelCalls:0,cancelSettled:0,cancelRejected:0,cancelThrows:0,releaseCalls:0,releaseThrows:0,observerErrors:0,lastErrorCategory:null};
              applicationBodies.push(applicationBody);copies.set(applicationBody,[]);
              const originalInput=init?.body;let inputBytes=null;
              if(method==='POST'){
                if(typeof originalInput!=='string')applicationBody.requestInputCaptureError=true;
                else{inputBytes=new TextEncoder().encode(originalInput);if(inputBytes.length>=131072)applicationBody.requestInputCaptureError=true;}
              }
              inputs.set(applicationBody,inputBytes);
              let resolve;const promise=new Promise(done=>{resolve=done;});completions.set(applicationBody,{promise,resolve,settled:false});
            }
            if(signal)signal.addEventListener('abort',()=>{try {item.abortEventObserved=true;item.abortObservedAt=new Date().toISOString();item.reasonCategory=category(signal);}
              catch {item.observationError='signal_event_observation_unavailable';}},{once:true});
          }
        } catch {observations.push({observationError:'caller_signal_observation_unavailable'});}
        const originalPromise=Reflect.apply(originalFetch,this,args);
        if(applicationBody){try{observe(originalPromise,applicationBody,response=>installOriginalBody(response,applicationBody),
          error=>{applicationBody.fetchOutcome='rejected';applicationBody.lastErrorCategory=failureCategory(error);complete(applicationBody);});
        }catch{applicationBody.observerErrors++;}}
        return originalPromise;
      };
    });
    page=await context.newPage();page.setDefaultTimeout(20000);page.setDefaultNavigationTimeout(20000);
    page.on('pageerror',error=>record.pageErrors.push(privateError(error)));
    page.on('request',request=>{const url=new URL(request.url());if(url.origin===base.origin&&url.pathname.startsWith('/api/')){
      record.browserRequests.push({path:url.pathname,method:request.method()});
      const observation={ordinal:record.originalRequestTerminals.length+1,path:url.pathname,method:request.method(),event:'unobserved',
        issuedElapsedMs:Math.round((performance.now()-originalStartedMono)*1000)/1000};
      originalRequestTerminals.set(request,observation);record.originalRequestTerminals.push(observation);
      if((request.method()==='GET'&&['/api/system-recovery/capabilities','/api/system-recovery/maintenance'].includes(url.pathname))
        ||(request.method()==='POST'&&(url.pathname==='/api/system-recovery/jobs'||/^\/api\/system-recovery\/jobs\/[a-f0-9-]{36}\/control$/.test(url.pathname))))
        observation.originalApplicationFetchOrdinal=++originalApplicationRequestOrdinal;
    }});
    // Passive events bind the exact original Request, without another await,
    // body read or acceptance condition. Missing correlation remains diagnostic.
    const terminal=(request,event)=>{const observation=originalRequestTerminals.get(request);if(!observation)return;
      observation.event=event;observation.terminalElapsedMs=Math.round((performance.now()-originalStartedMono)*1000)/1000;
      const error=request.failure()?.errorText;observation.failure=error?(/^net::ERR_[A-Z_]{1,80}$/.test(error)?error:'other-native-failure'):null;};
    page.on('requestfinished',request=>terminal(request,'requestfinished'));
    page.on('requestfailed',request=>terminal(request,'requestfailed'));
    page.on('response',response=>{
      const url=new URL(response.url());if(url.origin!==base.origin||!url.pathname.startsWith('/api/'))return;
      const entry=nativeMutations.get(response.request());
      const item={path:url.pathname,method:response.request().method(),status:response.status(),body:'pending',mutationOrdinal:entry?.ordinal??null};
      item.originalRequestTerminal=originalRequestTerminals.get(response.request());item.originalRequestCorrelationObserved=Boolean(item.originalRequestTerminal);
      item.nativeProvisionalHeaders=safeBodyHeaders(response.headers());record.api.push(item);
      const capture={item};captures.set(response,capture);
      // CDP is still attempted on the exact original native Response. For the
      // six instrumented original fetches its outcome is separate evidence;
      // primary native proof is the original application-consumed byte stream.
      const applicationOrdinal=item.originalRequestTerminal?.originalApplicationFetchOrdinal;
      const original=response.body();const cdpObservation=original.then(bytes=>{
        if(applicationOrdinal)item.cdpObservedBytes=bytes.length;assert(bytes.length<131072);
        if(applicationOrdinal){item.cdpBody='completed';item.cdpResponseSha256=sha(bytes);}
        else{capture.bytes=bytes;item.body='completed';item.responseSha256=sha(bytes);}
      }).catch(error=>{
        if(applicationOrdinal){item.cdpBody='failed';item.cdpError=privateError(error);}
        else{item.body='failed';item.error=privateError(error);}
      });bodies.push(cdpObservation);
      if(applicationOrdinal){
        const expectedRequestBody=response.request().postDataBuffer();
        const expectedRequestSha256=expectedRequestBody===null?null:sha(expectedRequestBody);
        const proof=Promise.resolve().then(()=>page.evaluate(ordinal=>window.__phase5fRecoveryOriginalApplicationBytes(ordinal),applicationOrdinal)).then(value=>{
          const info=value.metadata;assert.equal(info.fetchOrdinal,applicationOrdinal);assert.equal(info.path,item.path);assert.equal(info.method,item.method);
          assert.equal(value.requestBodySha256,expectedRequestSha256);assert.equal(info.requestInputCaptureError,undefined);
          assert.equal(info.fetchOutcome,'fulfilled');assert.equal(info.status,item.status);assert.equal(value.originalResponseAndReaderIdentityBound,true);
          assert.equal(info.getReaderCalls,1);assert.equal(info.getReaderArguments,0);assert.equal(info.getReaderThrows,0);
          assert(info.readCalls>=1);assert.equal(info.readSettled,info.readCalls);assert.equal(info.readRejected,0);assert.equal(info.readThrows,0);
          assert.equal(info.observedEOF,true);assert.equal(info.copyLimited,false);assert.equal(info.resultsLimited,false);
          assert.equal(info.cancelCalls,0);assert.equal(info.cancelThrows,0);assert.equal(info.releaseCalls,1);assert.equal(info.releaseThrows,0);
          assert.equal(info.releaseArguments,0);assert.equal(info.releaseReturnedUndefined,true);assert.equal(info.observerErrors,0);
          assert.equal(info.copiedBytes,info.yieldedBytes);assert(info.copiedBytes<131072);assert.equal(value.bytes.length,info.copiedBytes);
          assert(info.readResults.every(result=>result.arguments===0));assert.equal(info.readResults.at(-1).done,true);
          const bytes=Buffer.from(value.bytes);assert.equal(sha(bytes),value.responseSha256);
          if(item.method==='POST'){assert(entry);assert.equal(item.status,entry.backendStatus);assert.equal(value.responseSha256,entry.responseSha256);item.genuineOriginalBackendBodyMatches=true;}
          capture.bytes=bytes;item.body='completed';item.responseSha256=value.responseSha256;
          item.primaryNativeBodyProof={kind:'exact-original-application-Response-reader-read-Promises',fetchOrdinal:applicationOrdinal,
            originalNativeRequestOrdinal:item.originalRequestTerminal.ordinal,requestBodySha256:value.requestBodySha256,
            bytes:bytes.length,observedEOF:true,responseSha256:value.responseSha256,originalResponseAndReaderIdentityBound:true};
        }).catch(error=>{item.body='failed';item.error=privateError(error);});
        capture.observation=proof;bodies.push(proof);
      }else capture.observation=cdpObservation;
    });
    const waitResponse=(path,method='GET')=>{
      const original=page.waitForResponse(response=>new URL(response.url()).pathname===path&&response.request().method()===method);
      responseWaits.push(original);original.catch(()=>{});return original;
    };
    const initial=['/api/system-recovery/capabilities','/api/system-recovery/jobs','/api/system-recovery/maintenance'].map(path=>waitResponse(path));
    await page.goto(new URL('/settings/data/system',base).href,{waitUntil:'networkidle',timeout:20000});
    const values=[];for(const response of await Promise.all(initial)){assert.equal(response.status(),200);const capture=captures.get(response);assert(capture);values.push(JSON.parse(await originalResponseBody(capture)));}
    const capability=checkedSystemRecoveryCapabilities(values[0]),maintenance=checkedSystemRecoveryMaintenanceStatus(values[2]);
    assert.equal(capability.canManage,true);assert.equal(capability.supported,true);assert.equal(capability.enabled,true);assert.equal(capability.reason,null);assert.equal(capability.lastHeartbeatAt,null);
    assert.deepEqual(capability.target,{configured:false,id:null,mode:'fresh'});assert.deepEqual(capability.maintenance,{state:'open',checkpoint:null});assert.equal(maintenance.state,'open');assert.equal(maintenance.activeWriters,0);
    assert.deepEqual(Object.keys(values[1]),['jobs']);assert.equal(values[1].jobs.length,priorFinalJobs.size);
    for(const item of values[1].jobs){const job=checkedSystemRecoveryJobStatus(item);assert(priorFinalJobs.has(job.id));assert.equal(job.state,'cancelled');}
    const section=page.getByRole('heading',{name:'Create a system backup',exact:true}).locator('..');await section.getByLabel('System backup mode').selectOption('historical');
    const preview=section.getByRole('button',{name:'Preview system backup',exact:true});await visible(preview);await nativeEnabled(page,preview);assert(await preview.isEnabled());
    let wait=waitResponse('/api/system-recovery/backup-preview');await preview.focus();assert(await preview.evaluate(node=>document.activeElement===node));await page.keyboard.press('Enter');
    let response=await wait;assert.equal(response.status(),200);let capture=captures.get(response);assert(capture);
    const value=checkedSystemRecoveryBackupPreview(JSON.parse(await originalResponseBody(capture)));
    assert.equal(value.available,true);assert.deepEqual(value.reasons,[]);assert.deepEqual(value.maintenance,{state:'open',checkpoint:null});assert.equal(value.includesProtectedSettings,true);assert.equal(value.credentialsRequireKeyring,true);
    await visible(section.getByText('Source maintenance: open. The bounded backup can be accepted.',{exact:true}));
    const accept=section.getByRole('button',{name:'Start durable system backup',exact:true});await visible(accept);await nativeEnabled(page,accept);assert(await accept.isEnabled());
    const nativePreviewFocus=await preview.evaluate(node=>({active:document.activeElement===node,focusVisible:node.matches(':focus-visible'),disabled:node.disabled}));
    record.assertions.push({nativePreviewReturnFocus:nativePreviewFocus});assert.equal(nativePreviewFocus.active,true);
    wait=waitResponse('/api/system-recovery/jobs','POST');await accept.focus();assert(await accept.evaluate(node=>document.activeElement===node));await page.keyboard.press('Enter');
    response=await wait;assert.equal(response.status(),202);capture=captures.get(response);assert(capture);
    const receipt=checkedSystemRecoveryReceipt(JSON.parse(await originalResponseBody(capture)));assert.equal(receipt.reused,false);publicJob(receipt.job,'queued',record.requestId,record.jobId);
    const article=page.locator('article.system-recovery-job').filter({has:page.getByText(record.jobId,{exact:true})});
    await visible(article);assert.equal(await article.count(),1);await visible(article.getByRole('heading',{name:'System backup',exact:true}));
    const labels=['Pause','Resume','Cancel'],states=['paused','queued','cancelled'];
    for(let index=0;index<labels.length;index++) {
      const button=article.getByRole('button',{name:labels[index],exact:true});await visible(button);await nativeEnabled(page,button);assert(await button.isEnabled());
      const originalNode=await button.elementHandle();assert(originalNode);
      wait=waitResponse(`/api/system-recovery/jobs/${record.jobId}/control`,'POST');await button.focus();assert(await button.evaluate(node=>document.activeElement===node));
      const originalActionStartedMono=performance.now();await page.keyboard.press('Enter');
      response=await wait;assert.equal(response.status(),200);capture=captures.get(response);assert(capture);publicJob(JSON.parse(await originalResponseBody(capture)),states[index],record.requestId,record.jobId);
      const next=article.getByRole('button',{name:index===0?'Resume':index===1?'Pause':'Clean up job artifacts',exact:true});await visible(next);
      await nativeEnabled(page,next);
      assert(await next.isEnabled());
      const focus=await originalNode.evaluate(node=>({originalTriggerConnected:node.isConnected,originalTriggerDisabled:node.disabled,
        originalTriggerFocused:document.activeElement===node,bodyFocused:document.activeElement===document.body,
        activeTag:document.activeElement?.tagName.toLowerCase()??null}));
      // Explicit current-product intent keeps focus in this same keyed job.
      // Cancel returns to its always-present state/status, never artifact cleanup.
      const focusTarget=index<2?next:article.locator('p[role="status"]').filter({has:page.getByText(record.jobId,{exact:true})});
      await visible(focusTarget);assert.equal(await focusTarget.count(),1);
      // Enabled DOM can precede the product's passive focus effect. Observe the
      // same original native node within the remaining original20s action budget.
      const originalFocusTarget=await focusTarget.elementHandle();assert(originalFocusTarget);
      let targetFocus,focusSettled;
      try {
        const remaining=20000-(performance.now()-originalActionStartedMono);
        assert(remaining>0,'Original control focus exceeds the original20s action budget.');
        focusSettled=await page.waitForFunction(node=>node.isConnected&&document.activeElement===node,originalFocusTarget,{timeout:remaining});
        targetFocus=await originalFocusTarget.evaluate(node=>({active:document.activeElement===node,connected:node.isConnected,
          focusVisible:node.matches(':focus-visible'),tag:node.tagName.toLowerCase(),role:node.getAttribute('role')}));
      } finally {try {if(focusSettled)await focusSettled.dispose();}finally {await originalFocusTarget.dispose();}}
      record.assertions.push({action:labels[index].toLowerCase(),genuineControl200:true,state:states[index],nativeFocus:focus,
        sameJobReturnFocus:targetFocus,target:index===0?'resume':index===1?'pause':'cancelled-job-status'});
      if(focus.originalTriggerConnected&&!focus.originalTriggerDisabled)assert.equal(focus.originalTriggerFocused,true);
      assert.equal(targetFocus.connected,true);assert.equal(targetFocus.active,true);
      if(index===2){assert.equal(targetFocus.tag,'p');assert.equal(targetFocus.role,'status');}
      await originalNode.dispose();await geometry(page,record,`job-${labels[index].toLowerCase()}`,theme);
    }
    await absent(article.getByRole('button',{name:'Pause',exact:true}));await absent(article.getByRole('button',{name:'Resume',exact:true}));await absent(article.getByRole('button',{name:'Cancel',exact:true}));
    await absent(page.getByRole('heading',{name:'Recovery report',exact:true}));await absent(article.getByRole('button',{name:'View recovery report',exact:true}));await absent(article.getByRole('link',{name:'Download system backup',exact:true}));
    await Promise.all(bodies);assert(record.api.every(item=>item.body==='completed'&&[200,202].includes(item.status)));
    // If CDP supplies bytes, they must agree with the primary original native
    // application stream; a real oversized/mismatched body is never waived.
    assert(record.api.every(item=>item.cdpObservedBytes===undefined||(item.cdpObservedBytes<131072&&item.cdpBody==='completed'&&item.cdpResponseSha256===item.responseSha256)));
    assert.equal(record.browserRequests.filter(item=>item.method==='POST').length,4);assert.equal(nextMutation,4);
    assert.equal(record.pageErrors.length,0);assert.equal(record.externalRequests.length,0);
    const evidence=await verifyHistory(`after-${id}`,true);const own=evidence.lineages.find(item=>item.jobId===record.jobId);assert(own);
    priorFinalJobs.set(record.jobId,{jobSha256:own.jobSha256,requestSha256:own.requestSha256});
    record.assertions.push({originalPreview200:true,originalBackup202:true,pauseResumeCancel200:true,acceptedRequestAndJobIdRetained:true,
      actualMutations:4,generation:3,state:'cancelled',noRichReportOrInventedCounts:true,noExecutionStepOrArtifactOrTargetWork:true});record.status='passed';
  } catch(error){
    record.status='failed';record.error=privateError(error);
    record.originalRequestTerminalsAtFailure=record.originalRequestTerminals.map(item=>({...item}));
    // One retained passive snapshot precedes original cleanup. Its wait uses
    // only the remaining original20s; it never replaces strict native bodies.
    const observation=(page?page.evaluate(async()=>{
      const signals=window.__phase5fRecoveryControlCallerSignalObservations;
      const applicationControls=typeof window.__phase5fRecoveryControlApplicationBodySnapshot==='function'
        ?await window.__phase5fRecoveryControlApplicationBodySnapshot():null;
      const visible=node=>!!node&&node.getBoundingClientRect().width>0&&node.getBoundingClientRect().height>0;
      const fixedButton=label=>[...document.querySelectorAll('.system-recovery-page button')].find(node=>node.textContent?.trim()===label);
      return {currentRouteIsRecovery:location.pathname==='/settings/data/system',recoveryPageVisible:visible(document.querySelector('.system-recovery-page')),
        routeErrorBoundaryVisible:visible(document.querySelector('[role="alert"][aria-labelledby="route-error-title"]')),
        routeLoadingVisible:visible(document.querySelector('.route-loading')),
        currentBackupPreviewVisible:visible(fixedButton('Preview system backup')),
        currentRecoveryReadRetryVisible:visible(fixedButton('Retry reading recovery status')),
        originalControlCallerSignals:Array.isArray(signals)?signals.slice(0,6):null,
        originalControlCallerSignalCount:Array.isArray(signals)?signals.length:null,applicationControls};
    }):Promise.reject(new Error('Original page unavailable for passive snapshot.'))).then(value=>{record.originalControlPreCloseSnapshot=value;})
      .catch(error=>{record.passiveSnapshotError=privateError(error);throw error;});
    record.passiveSnapshotCount=1;bodies.push(observation);observation.catch(()=>{});
    let timer;
    try{await Promise.race([observation,new Promise((_done,fail)=>{timer=setTimeout(()=>fail(new Error('Passive original snapshot exceeds remaining original20s.')),
      Math.max(1,20000-(Date.now()-Date.parse(record.startedAt))));})]);}
    catch(error){record.passiveSnapshotWaitError=privateError(error);}finally{clearTimeout(timer);}
  }
  finally {
    if(context){try{await closeContext(context);record.contextClosed=true;}catch(error){record.contextCloseError=privateError(error);record.status='failed';}activeContexts.delete(context);}
    const routes=await Promise.allSettled(routeWork),bodyOutcomes=await Promise.allSettled(bodies),waits=await Promise.allSettled(responseWaits);
    record.originalRouteWorkAwaited={count:routes.length,rejected:routes.filter(item=>item.status==='rejected').length};
    record.originalBodiesAwaited={count:bodyOutcomes.length,rejected:bodyOutcomes.filter(item=>item.status==='rejected').length};
    record.originalResponseWaitsAwaited={count:waits.length,rejected:waits.filter(item=>item.status==='rejected').length};
    if(routes.some(item=>item.status==='rejected')||bodyOutcomes.some(item=>item.status==='rejected')||waits.some(item=>item.status==='rejected')||record.api.some(item=>item.body!=='completed'))record.status='failed';
    if(database&&originalDatabaseSnapshot){try{await verifyHistory(`settled-${id}`,record.status==='passed');record.originalAcceptedHistoryVerified=true;}catch(error){record.historyError=privateError(error);record.status='failed';}}
    record.completedAt=new Date().toISOString();await writeFile(progressPath,canonical({id,status:record.status,contextClosed:record.contextClosed})+'\n',{flag:'a'});
  }
  if(record.status!=='passed')throw new Error(record.error||record.contextCloseError||record.historyError||'Original job control case failed after owner settlement.');
}


try {
  const keys=await generateKeyPair('RS256');signingKey=keys.privateKey;notInterrupted();
  const publicKey={...await exportJWK(keys.publicKey),kid:'recovery-preview-fixture-key',alg:'RS256',use:'sig'};
  const publicBytes=Buffer.from(JSON.stringify({keys:[publicKey]}));
  jwksServer=createServer((request,response)=>{report.jwksRequests.push({method:request.method,path:request.url,at:new Date().toISOString()});
    if(request.method!=='GET'||request.url!=='/cdn-cgi/access/certs'){response.writeHead(404).end();return;}
    response.writeHead(200,{'content-type':'application/json','cache-control':'no-store','content-length':publicBytes.length});response.end(publicBytes);});
  await new Promise((done,fail)=>{jwksServer.once('error',fail);jwksServer.listen(0,'127.0.0.1',done);});
  issuerPort=jwksServer.address().port;issuer=`http://127.0.0.1:${issuerPort}`;
  report.jwksOwner={host:'127.0.0.1',port:issuerPort,publicJwksSha256:sha(publicBytes),scope:'Fresh private local issuer; explicit signed system-administrator account plus ordinary allowed reader; no resource/group grant inference'};
  const token=actor=>new SignJWT({email:actor}).setProtectedHeader({alg:'RS256',kid:'recovery-preview-fixture-key'}).setIssuer(issuer).setAudience(audience)
    .setSubject(`fixture:${actor}`).setIssuedAt().setExpirationTime('5m').sign(signingKey);
  readerToken=await token(reader);adminToken=await token(admin);privateValues.add(readerToken);privateValues.add(adminToken);
  const vars={...config.vars,AUTH_MODE:'access',ACCESS_TEAM_DOMAIN:issuer,ACCESS_AUD:audience,ALLOWED_EMAILS:`${admin},${reader}`,SYSTEM_ADMIN_EMAILS:admin};
  for(const key of ['RECOVERY_TARGET_ID','STORAGE_CREDENTIALS_KEYRING'])assert.equal(vars[key],undefined);
  runtime=new Miniflare({...artifact,rootPath:source,modulesRoot:source,modules:true,host:'127.0.0.1',port:4219,bindings:vars,
    d1Databases:{DB:config.d1_databases[0].database_id},d1Persist:resolve(source,'.wrangler/state/v3/d1'),
    r2Buckets:{ASSETS:config.r2_buckets[0].bucket_name},r2Persist:resolve(source,'.wrangler/state/v3/r2'),log:new Log(LogLevel.ERROR),
    outboundService:async request=>{assert.equal(request.url,`${issuer}/cdn-cgi/access/certs`);assert.equal(request.method,'GET');
      const response=await fetch(request.url,{redirect:'error',signal:AbortSignal.timeout(5000)});return new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});}});
  assert.equal(new URL((await runtime.ready).href).origin,base.origin);notInterrupted();database=await runtime.getD1Database('DB');
  const names=(await readdir(resolve(source,'migrations'))).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort();assert.equal(names.length,24);assert.equal(names.at(-1).slice(0,4),'0024');
  assert.deepEqual((await database.prepare('SELECT name FROM d1_migrations ORDER BY name').all()).results.map(item=>item.name),names);

  originalDatabaseSnapshot=await snapshot();report.databaseBefore=originalDatabaseSnapshot;
  assert.equal(originalDatabaseSnapshot.tables.system_recovery_write_leases.count,63,'Fresh current24/mature84 keeps its original63 permits.');
  for(const [name,item] of Object.entries(originalDatabaseSnapshot.tables))
    if(name.startsWith('system_recovery_')&&!['system_recovery_runtime','system_recovery_maintenance','system_recovery_write_leases'].includes(name))
      assert.equal(item.count,0,`Refuse existing recovery history before changing executor configuration: ${name}`);
  const runtimeRows=await rowsOf('system_recovery_runtime');assert.equal(runtimeRows.length,1);originalRuntimeRow=runtimeRows[0];
  assert.equal(originalRuntimeRow.singleton,1);assert.equal(originalRuntimeRow.enabled,0);assert.equal(originalRuntimeRow.last_heartbeat_at,null);
  assert.deepEqual(Object.keys(originalRuntimeRow).sort(),['singleton','enabled','incarnation','installation_id','last_heartbeat_at','updated_at'].sort());
  assert.match(originalRuntimeRow.incarnation,/^[a-f0-9]{32}$/);assert.match(originalRuntimeRow.installation_id,/^[a-f0-9]{32}$/);
  const readerAccess=checkedSystemRecoveryCapabilities(await actualReaderGet('/api/system-recovery/capabilities',200));
  assert.equal(readerAccess.canManage,false);assert.equal(readerAccess.reason,'administrator_required');
  await actualReaderGet('/api/system-recovery/backup-preview',403);
  report.readerControls={signedAllowedReaderCapabilities200:true,systemAdminFalse:true,backupPreview403:true};
  await boundedOriginal(configureOnce(true),'Original shared enable');notInterrupted();
  // Parent tmpdir still owns the original COPY/FIXTURE validation and Playwright
  // profile directory. Only Chromium's child tmpdir is shortened for its native
  // SingletonSocket; this does not change the browser actions or product input.
  const chromiumTemp=process.env.PHASE5F_CHROMIUM_PRIVATE_TEMP;
  assert.equal(chromiumTemp,'/workspace/.rcf6tmp');
  const chromiumTempOwner=await json(await privateRoot(process.env.PHASE5F_JOB_CONTROL_RUNTIME_ROOT),'chromium-child-temp-owner.json');
  const tempInfo=await lstat(chromiumTemp,{bigint:true});
  assert(tempInfo.isDirectory()&&!tempInfo.isSymbolicLink());assert.equal(await realpath(chromiumTemp),chromiumTemp);
  assert.equal(tempInfo.mode&0o777n,0o700n);assert.equal(tempInfo.uid,BigInt(process.getuid()));
  assert.equal(tempInfo.dev.toString(),chromiumTempOwner.dev);assert.equal(tempInfo.ino.toString(),chromiumTempOwner.ino);
  assert.equal(chromiumTempOwner.path,chromiumTemp);assert.equal(chromiumTempOwner.uid,process.getuid());
  assert.equal(chromiumTempOwner.mode,'0700');assert.equal(chromiumTempOwner.freshCreated,true);
  assert.equal(chromiumTempOwner.sourceHead,producerHead);assert.equal(chromiumTempOwner.sourceCopyRoot,source);
  assert.equal(chromiumTempOwner.fixtureDirectory,fixtureRoot);assert.equal(chromiumTempOwner.qaHelperSha256,helperSha256);
  const tempSpace=await statfs(chromiumTemp,{bigint:true});assert(tempSpace.bavail*tempSpace.bsize>0n);
  report.chromiumChildTemporary={path:chromiumTemp,dev:tempInfo.dev.toString(),ino:tempInfo.ino.toString(),
    uid:process.getuid(),mode:'0700',freshOwnerWitnessVerified:true,availableBytes:(tempSpace.bavail*tempSpace.bsize).toString(),
    parentTemporaryRootUnchanged:true,parentPlaywrightProfileRootUnchanged:true,childTmpdirOnly:true};
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox'],
    env:{...process.env,TMPDIR:chromiumTemp,SQLITE_TMPDIR:chromiumTemp}});notInterrupted();
  await caseRun(expectedCases[0],1280,'light');await caseRun(expectedCases[1],390,'dark');
  assert.deepEqual(report.cases.map(item=>item.id),expectedCases);assert(report.cases.every(item=>item.status==='passed'&&item.contextClosed));
  notInterrupted();report.status='passed';
} catch(error){report.status='failed';report.error=privateError(error);}
finally {
  process.stdin.removeListener('data',originalControlInput);process.stdin.pause();
  const cleanup={sessionId:report.sessionId,startedAt:new Date().toISOString(),status:'closing'};
  if(originalControlStop){try{await originalControlStop;cleanup.originalControlStopAwaited=true;}catch(error){cleanup.originalControlStopError=privateError(error);}}
  if(browser){try{await closeBrowser();cleanup.browserCloseAwaited=true;}catch(error){cleanup.browserCloseError=privateError(error);}}
  else cleanup.noBrowserCreated=true; // Launch failure remains failed; never invent a browser.close observation.
  // A context closes before its retained route.fetch callback is awaited in
  // case finally. Only after all original case/backend work has settled may
  // the single original shared disable run. Retain partial accepted history.
  const enableOutcomes=await Promise.allSettled(sharedWork);cleanup.originalSharedWorkBeforeDisableAwaited=enableOutcomes.length;
  if(originalEnable){try{await boundedOriginal(configureOnce(false),'Original shared disable');cleanup.originalDisableAwaited=true;}catch(error){cleanup.originalDisableError=privateError(error);}}
  const sharedOutcomes=await Promise.allSettled(sharedWork);cleanup.originalSharedWorkAwaited={count:sharedOutcomes.length,rejected:sharedOutcomes.filter(item=>item.status==='rejected').length};
  if(database&&originalDatabaseSnapshot&&originalRuntimeRow){
    try{
      report.databaseAfter=await snapshot();await verifyHistory('after-original-shared-disable',report.status==='passed');
      cleanup.originalApplicationCatalogRowsPermitsAndAcceptedHistoryVerified=true;
      if(originalEnable){const rows=await rowsOf('system_recovery_runtime');assert.equal(rows[0].enabled,0);cleanup.executorDisabledReadBack=true;}
    }catch(error){cleanup.historyVerificationError=privateError(error);}
  }
  if(runtime){try{await disposeWorker();cleanup.workerDisposeAwaited=true;await refused(4219);cleanup.workerPortRefused=true;}catch(error){cleanup.workerCloseError=privateError(error);}}
  if(jwksServer){try{await closeJwks();cleanup.jwksCloseAwaited=true;if(issuerPort){await refused(issuerPort);cleanup.jwksPortRefused=true;}}catch(error){cleanup.jwksCloseError=privateError(error);}}
  cleanup.status=Object.keys(cleanup).some(key=>key.endsWith('Error'))?'failed':'closed';cleanup.completedAt=new Date().toISOString();report.ownedClosure=cleanup;
  if(cleanup.status!=='closed')report.status='failed';
  report.actualApiCosts={auxiliaryGets:report.auxiliaryRequests.length,
    browserGets:report.cases.reduce((total,item)=>total+item.browserRequests.filter(row=>row.method==='GET').length,0),
    browserMutationIntents:report.cases.reduce((total,item)=>total+item.browserRequests.filter(row=>row.method!=='GET').length,0),
    originalServerMutationRequestsIssued:report.mutationJournal.filter(item=>item.outcome!=='registered').length,
    sharedMutationRequests:report.mutationJournal.filter(item=>item.kind.startsWith('shared-')).length,
    originalMutationRequestsMaximum:10,acceptedMetadataMutationResponses:report.mutationJournal.filter(item=>item.outcome==='response_accepted').length,productionPollingMayAddReadOnlyGets:true,
    originalRouteFetchForwardsOneNativeIntentOnce:true,scheduledOrStepInvocationsByHelper:0,zipOrProviderOrTargetOperationsByHelper:0};
  report.unrunCases=expectedCases.filter(id=>!report.cases.some(item=>item.id===id));report.completedAt=new Date().toISOString();
  await writeOnce(stopPath,cleanup);await writeOnce(reportPath,report);
}
console.log(JSON.stringify({status:report.status,reportPath,actualCases:report.cases.length,
  passed:report.cases.filter(item=>item.status==='passed').length,failed:report.cases.filter(item=>item.status==='failed').length,
  unrun:report.unrunCases.length,closure:report.ownedClosure.status}));
if(report.status!=='passed')process.exitCode=1;
