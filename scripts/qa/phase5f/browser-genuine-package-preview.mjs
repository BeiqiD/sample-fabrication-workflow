// Two genuine research-package preview presentation cases; no package jobs.
// One original plans POST per case adds one real released HTTP admission permit.
// Use only the separately witnessed exact fresh Package focus producer and actual84 seed.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { lstat, mkdir, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [sourceValue, fixtureValue, permit, ...extra] = process.argv.slice(2);
assert(sourceValue && fixtureValue && permit === '--exclusive-go-two-genuine-package-previews' && !extra.length,
  'Usage: node browser-genuine-package-preview.mjs ISOLATED_COPY FIXTURE_DIRECTORY --exclusive-go-two-genuine-package-previews');
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
assert.equal(isolation.sourceHead, 'ffff956c68e64e20b91b773d3bcb064642a37410');
assert.equal(Object.keys(isolation.trackedFiles).length, 1879);
const consumer = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const producerHelper = 'scripts/qa/phase5f/browser-genuine-package-preview.mjs';
assert.equal(isolation.trackedFiles[producerHelper], '17d8e5638d1e87afab9c8c9c2a95b3ee9bfd6839db9a3d83b326b050d47b1800');
for (const [name, digest] of Object.entries(isolation.trackedFiles))
  if (name !== producerHelper) assert.equal(sha(await readFile(await file(consumer, name))), digest, `Consumer production input changed: ${name}`);
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
// The actual fresh ffff Package focus build is the causal producer. Its copied
// QA helper has the separately pinned prior bytes; every other1878 producer
// input is exact in this consumer. Old f88 artifacts do not qualify the focus repair.
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

const expectedCases = ['data-package-real-scope-1280-light', 'offline-report-real-scope-390-dark'];
const output = resolve(fixtureRoot, 'genuine-package-preview-browser-artifacts');
const reportPath = resolve(fixtureRoot, 'genuine-package-preview-browser-report.json');
const stopPath = resolve(fixtureRoot, 'genuine-package-preview-runtime-stop.json');
const progressPath = resolve(fixtureRoot, 'genuine-package-preview-browser-progress.ndjson');
for (const path of [output, reportPath, stopPath, progressPath]) await missing(path);
await mkdir(output, { mode: 0o700 }); await writeFile(progressPath, '', { flag: 'wx', mode: 0o600 });
const report = { version: 1, scope: 'Two actual local genuine signed research-access package-preview presentation cases. No accepted package jobs/ZIP/import/recovery/provider/device or whole5F acceptance.',
  sourceRoot:isolation.sourceRoot, sourceCopyRoot:source, sourceHead:isolation.sourceHead, sourceTree:isolation.sourceTree,
  fixtureDirectory:fixtureRoot, isolationReceiptSha256:isolationHash, helperSha256,
  protected1878ConsumerInputsExact:true, seedReceiptSha256:sha(await readFile(await file(fixtureRoot,'actual-api-fixture-receipt.json'))),
  freshBuildReceiptSha256:sha(await readFile(await file(fixtureRoot,'enabled-storage-draft-build-input-witness.json'))),
  sessionId:randomUUID(), sessionPid:process.pid, expectedCases, cases:[], auxiliaryRequests:[], jwksRequests:[],
  startedAt:new Date().toISOString(),status:'running' };
let jwksServer,runtime,browser,database,originalDatabaseSnapshot,originalLeaseRows;
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
// ordered cancellation. Keep D1 alive until accepted draft history is read.
// Compile the exact genuine contract bytes with the existing locked esbuild,
// as the mature genuine fixtures do. Its type-only import has no runtime owner.
// Retain/await the original compiler service stop before starting any servers.
const {build,stop}=require('esbuild');
const contract=await readFile(await file(source,'shared/contracts/research-package-api.ts'),'utf8');
let compiled;
try {compiled=await build({stdin:{contents:contract,loader:'ts',sourcefile:'shared/contracts/research-package-api.ts'},write:false,platform:'node',format:'esm',target:'es2022',logLevel:'silent'});}
finally {await stop();}
assert.equal(compiled.outputFiles.length,1);assert.equal(compiled.warnings.length,0);
const executable=compiled.outputFiles[0].text;assert(!/\bimport\s*(?:\(|[^;]*\bfrom\b)/.test(executable));
const {checkedResearchPackagePreview,checkedResearchExportPlanInput,checkedResearchExecutorStatus}=await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);
report.contractSourceSha256=sha(contract);report.contractExecutableSha256=sha(executable);
// Read the existing renderer's closed reason map. Its real source is pinned
// with every other1878 producer input, so fallback wording stays identical.
const pageSource=await readFile(await file(source,'src/pages/ResearchPackagesPage.tsx'),'utf8');
const mapSource=pageSource.match(/const reasonLabels: Record<string, string> = \{([\s\S]*?)\n\};/);assert(mapSource);
const reasonLabels=Object.fromEntries([...mapSource[1].matchAll(/([a-z_]+): "([^"\n]*)"/g)].map(match=>[match[1],match[2]]));
assert(Object.keys(reasonLabels).length>10);
const reasonText=value=>reasonLabels[value]||value.replaceAll('_',' ');

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

let issuer,issuerPort,signingKey,readerToken;
const reader='researcher@package-preview.invalid',audience=`package-preview-${randomUUID()}`;
const canonical=value=>JSON.stringify(value,(_key,item)=>item instanceof ArrayBuffer
  ? {bytes:Buffer.from(item).toString('hex')} : ArrayBuffer.isView(item) ? {bytes:Buffer.from(item.buffer,item.byteOffset,item.byteLength).toString('hex')} : item);
const privateValues=new Set([reader]),originalPreviewAttempts=[];
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
      'research-packages-page', 'research-package-preview', 'research-package-table', 'warning-card']);
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

async function verifyPreviewAdmission(snapshotAfter) {
  assert.equal(snapshotAfter.schemaSha256,originalDatabaseSnapshot.schemaSha256);
  assert.deepEqual(Object.keys(snapshotAfter.tables),Object.keys(originalDatabaseSnapshot.tables));
  for(const [name,value] of Object.entries(originalDatabaseSnapshot.tables))
    if(name!=='system_recovery_write_leases')assert.deepEqual(snapshotAfter.tables[name],value,`Preview changed unrelated rows: ${name}`);
  const leases=(await database.prepare('SELECT * FROM system_recovery_write_leases').all()).results;
  const retained=leases.filter(row=>originalLeaseRows.some(before=>before.id===row.id));
  assert.deepEqual(retained.map(canonical).sort(),originalLeaseRows.map(canonical).sort());
  assert.deepEqual({count:retained.length,sha256:sha(retained.map(canonical).sort().join('\n'))},originalDatabaseSnapshot.tables.system_recovery_write_leases);
  const remaining=leases.filter(row=>!originalLeaseRows.some(before=>before.id===row.id));
  assert.equal(new Set(leases.map(row=>row.id)).size,leases.length);
  assert.equal(remaining.length,originalPreviewAttempts.length);
  const maintenance=await database.prepare('SELECT state,generation FROM system_recovery_maintenance WHERE singleton=1').first();assert.equal(maintenance.state,'open');
  const permits=[];
  for(const [ordinal,attempt] of originalPreviewAttempts.entries()) {
    assert.equal(attempt.status,200);assert(attempt.completedAt,'Original plans response must settle before permit qualification.');
    const matches=remaining.filter(row=>row.owner===reader&&row.kind==='http'&&row.generation===maintenance.generation
      &&typeof row.released_at==='string'&&Date.parse(attempt.startedAt)<=Date.parse(row.created_at)
      &&Date.parse(row.created_at)<=Date.parse(row.released_at)&&Date.parse(row.released_at)<=Date.parse(attempt.completedAt));
    assert.equal(matches.length,1,'Exactly one unique released current-actor/current-generation permit in this original preview POST window.');
    const row=matches[0];assert.equal(Date.parse(row.expires_at)-Date.parse(row.created_at),300000);remaining.splice(remaining.indexOf(row),1);
    permits.push({originalPostOrdinal:ordinal+1,status:200,permitIdSha256:sha(row.id),rowSha256:sha(canonical(row)),
      authenticatedActorMatches:true,kind:row.kind,currentGenerationMatches:true,generation:row.generation,
      startedAt:attempt.startedAt,completedAt:attempt.completedAt,createdAt:row.created_at,expiresAt:row.expires_at,releasedAt:row.released_at});
  }
  assert.equal(remaining.length,0);
  report.sourceWritePermitHistory={originalCount:retained.length,originalRowsSha256:originalDatabaseSnapshot.tables.system_recovery_write_leases.sha256,
    originalRowsExact:true,addedCount:permits.length,permits,allOtherRowsAndCatalogExact:true};
  assert.deepEqual((await database.prepare('PRAGMA foreign_key_check').all()).results,[]);
}
async function originalResponseBody(response,observation) {
  let timer;
  try { await Promise.race([observation,new Promise((_done,fail)=>{timer=setTimeout(()=>fail(new Error('Original API body exceeds the existing20s budget.')),20000);})]); }
  finally { clearTimeout(timer); }
  assert.equal(response.item.body,'completed');return response.bytes;
}
async function caseRun(id,width,theme,kind,roots) {
  notInterrupted();
  const record={id,width,theme,status:'running',assertions:[],browserRequests:[],api:[],pageErrors:[],externalRequests:[],startedAt:new Date().toISOString()};
  report.cases.push(record);await writeFile(progressPath,canonical({id,status:'running'})+'\n',{flag:'a'});
  const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme,isMobile:width===390,hasTouch:width===390,serviceWorkers:'block'});activeContexts.add(context);
  const bodies=[],routeWork=[],captures=new WeakMap(),attempts=new WeakMap();
  try {
    await context.route('**/*',route=>{
      const work=(async()=>{const request=route.request(),url=new URL(request.url());
        if(['http:','https:'].includes(url.protocol)&&url.origin!==base.origin) {record.externalRequests.push({origin:url.origin});await route.abort('blockedbyclient');return;}
        if(url.origin===base.origin&&url.pathname.startsWith('/api/')) {
          if(['POST','PUT','PATCH','DELETE'].includes(request.method())) {
            assert.equal(request.method(),'POST');assert.equal(url.pathname,'/api/packages/plans');
            assert.deepEqual(checkedResearchExportPlanInput(request.postDataJSON()),{kind,roots});
            assert(!record.originalPostStarted,'Exactly one original plans POST; no oracle or replay.');record.originalPostStarted=true;
            const attempt={channel:'browser',startedAt:new Date().toISOString()};originalPreviewAttempts.push(attempt);attempts.set(request,attempt);
          }
          await route.continue({headers:{...request.headers(),'cf-access-jwt-assertion':readerToken}});
        } else await route.continue();})();routeWork.push(work);work.catch(()=>{});return work;
    });
    await context.addInitScript(value=>localStorage.setItem('sample-workflow-theme',value),theme);
    const page=await context.newPage();page.setDefaultTimeout(20000);
    page.on('pageerror',error=>record.pageErrors.push(privateError(error)));
    page.on('request',request=>{const url=new URL(request.url());if(url.origin===base.origin&&url.pathname.startsWith('/api/'))record.browserRequests.push({path:url.pathname,method:request.method()});});
    page.on('response',response=>{
      const url=new URL(response.url());if(url.origin!==base.origin||!url.pathname.startsWith('/api/'))return;
      const item={path:url.pathname,method:response.request().method(),status:response.status(),body:'pending'};record.api.push(item);
      const capture={item};captures.set(response,capture);
      const body=response.body();capture.observation=body.then(bytes=>{
        assert(bytes.length<131072);capture.bytes=bytes;item.body='completed';item.responseSha256=sha(bytes);
        const attempt=attempts.get(response.request());if(attempt){attempt.status=response.status();attempt.completedAt=new Date().toISOString();}
      }).catch(error=>{item.body='failed';item.error=privateError(error);});bodies.push(capture.observation);
    });
    const jobs=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/packages/jobs'&&response.request().method()==='GET');
    const executor=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/packages/executor'&&response.request().method()==='GET');
    await page.goto(new URL('/settings/data',base).href,{waitUntil:'networkidle',timeout:20000});
    const originalJobs=await jobs,originalExecutor=await executor;
    assert.equal(originalJobs.status(),200);assert.equal(originalExecutor.status(),200);
    await originalResponseBody(captures.get(originalJobs),captures.get(originalJobs).observation);
    const status=checkedResearchExecutorStatus(JSON.parse(await originalResponseBody(captures.get(originalExecutor),captures.get(originalExecutor).observation)));
    assert.equal(status.supported,true);assert.equal(status.enabled,false);assert.equal(status.canManage,false);
    await visible(page.getByText('Execution is paused.',{exact:true}));
    await page.getByLabel('Export format').selectOption(kind);
    await page.getByLabel('Sample and Project roots',{exact:true}).fill(roots.map(root=>`${root.kind}:${root.id}`).join('\n'));
    const preview=page.getByRole('button',{name:'Preview export',exact:true});await visible(preview);
    const original=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/packages/plans'&&response.request().method()==='POST');
    await preview.focus();assert(await preview.evaluate(node=>document.activeElement===node));await page.keyboard.press('Enter');
    const response=await original;assert.equal(response.status(),200);const capture=captures.get(response);assert(capture);
    const value=checkedResearchPackagePreview(JSON.parse(await originalResponseBody(capture,capture.observation)));
    assert.equal(value.kind,kind);assert.deepEqual(value.roots,roots);assert(value.counts.records>=roots.length);
    assert.equal(value.source,null);assert.equal(value.naming,null);assert.equal(value.archiveBytes,null);assert.equal(value.metadataBytes,0);assert.deepEqual(value.targets,[]);
    const included=value.dependencies.filter(item=>item.outcome==='included');
    for(const [type,id] of [['sample',seed.mixed[0].sampleId],['run',seed.mixed[0].runId],['runStep',seed.mixed[0].firstStepId]])
      assert(included.some(item=>item.targetType===type&&item.id===id),`Genuine selected research context: ${type}`);
    const section=page.getByRole('heading',{name:'Export selected research',exact:true}).locator('..');
    const presentation=section.locator('.research-package-preview');await visible(presentation);
    const size=bytes=>`${(bytes/1024/1024).toFixed(2)} MiB`;
    await visible(presentation.getByRole('status').filter({hasText:`${value.complete?'Complete':'Incomplete'} scope: ${value.counts.records} records, ${value.counts.files} files, ${size(value.counts.bytes)} of file content.`}));
    await visible(presentation.getByText(`The final ZIP size has not been measured. Metadata: ${size(value.metadataBytes)}. The complete ZIP must fit within 100 MiB, including all entries and ZIP headers.`,{exact:true}));
    const lis=presentation.locator('li');assert.equal(await lis.count(),value.dependencies.length+value.warnings.length);
    for(const entry of value.dependencies) {
      const row=lis.filter({has:page.getByText(entry.id,{exact:true})});assert.equal(await row.count(),1);
      if(entry.label)await visible(row.getByText(entry.label,{exact:true}));
      if(entry.reason)assert((await row.innerText()).includes(reasonText(entry.reason)));
    }
    for(const warning of value.warnings)await visible(presentation.getByText(reasonText(warning),{exact:true}));
    const capability=kind==='report'?value.capabilities.report:value.capabilities.dataPackage;
    assert.equal(capability.available,false);assert(capability.reasons.includes('file_authority_unavailable'));
    for(const reason of capability.reasons)await visible(section.locator(':scope > ul').getByText(reasonText(reason),{exact:true}));
    assert(await section.getByRole('button',{name:`Start ${kind==='report'?'report':'data package'} export`,exact:true}).isDisabled());
    record.assertions.push({originalResponseSha256:capture.item.responseSha256,originalPost200:true,counts:value.counts,complete:value.complete,
      realIncludedContextTypes:['sample','run','runStep'],selectedProjectRootChecked:true,dependencies:value.dependencies.length,warnings:value.warnings,
      archiveBytes:value.archiveBytes,metadataBytes:value.metadataBytes,targets:0,source:null,naming:null,
      disabledCapabilityReasons:capability.reasons,executorPaused:true,executorCanManage:false,noAcceptedJobs:true});
    await geometry(page,record,'genuine-package-preview',theme);
    const nativeFocus=await preview.evaluate(node=>({active:document.activeElement===node,body:document.activeElement===document.body,focusVisible:node.matches(':focus-visible'),disabled:node.disabled}));
    record.assertions.push({nativePreviewReturnFocus:nativeFocus});assert.equal(nativeFocus.active,true,'Keyboard preview should retain native action focus after its pending form becomes available.');
    await Promise.all(bodies);assert(record.api.every(item=>item.body==='completed'&&item.status===200));
    await closeContext(context);record.contextClosed=true;await Promise.all(routeWork);await Promise.all(bodies);
    assert.equal(record.pageErrors.length,0);assert.equal(record.externalRequests.length,0);
    assert.deepEqual(record.browserRequests.filter(item=>['POST','PUT','PATCH','DELETE'].includes(item.method)),[{path:'/api/packages/plans',method:'POST'}]);
    record.status='passed';
  } catch(error) {record.status='failed';record.error=privateError(error);}
  finally {
    try {await closeContext(context);record.contextClosed=true;}catch(error){record.contextCloseError=privateError(error);record.status='failed';}
    activeContexts.delete(context);
    const routes=await Promise.allSettled(routeWork);const bodyOutcomes=await Promise.allSettled(bodies);
    record.originalRouteWorkAwaited=routes.length;record.originalBodiesAwaited=bodyOutcomes.length;
    if(routes.some(item=>item.status==='rejected')){record.routeSettlementError=true;record.status='failed';}
    if(bodyOutcomes.some(item=>item.status==='rejected')||record.api.some(item=>item.body!=='completed')){record.bodySettlementError=true;record.status='failed';}
    record.completedAt=new Date().toISOString();await writeFile(progressPath,canonical({id,status:record.status,contextClosed:record.contextClosed})+'\n',{flag:'a'});
  }
  if(record.status!=='passed')throw new Error(record.error||record.contextCloseError||'Original package preview case failed after owner settlement.');
}

try {
  const keys=await generateKeyPair('RS256');signingKey=keys.privateKey;notInterrupted();
  const publicKey={...await exportJWK(keys.publicKey),kid:'package-preview-fixture-key',alg:'RS256',use:'sig'};
  const publicBytes=Buffer.from(JSON.stringify({keys:[publicKey]}));
  jwksServer=createServer((request,response)=>{report.jwksRequests.push({method:request.method,path:request.url,at:new Date().toISOString()});
    if(request.method!=='GET'||request.url!=='/cdn-cgi/access/certs'){response.writeHead(404).end();return;}
    response.writeHead(200,{'content-type':'application/json','cache-control':'no-store','content-length':publicBytes.length});response.end(publicBytes);});
  await new Promise((done,fail)=>{jwksServer.once('error',fail);jwksServer.listen(0,'127.0.0.1',done);});
  issuerPort=jwksServer.address().port;issuer=`http://127.0.0.1:${issuerPort}`;
  report.jwksOwner={host:'127.0.0.1',port:issuerPort,publicJwksSha256:sha(publicBytes),scope:'Fresh private local issuer; ordinary allowed research account, no system-admin grant'};
  readerToken=await new SignJWT({email:reader}).setProtectedHeader({alg:'RS256',kid:'package-preview-fixture-key'}).setIssuer(issuer).setAudience(audience)
    .setSubject(`fixture:${reader}`).setIssuedAt().setExpirationTime('5m').sign(signingKey);privateValues.add(readerToken);
  const vars={...config.vars,AUTH_MODE:'access',ACCESS_TEAM_DOMAIN:issuer,ACCESS_AUD:audience,ALLOWED_EMAILS:reader,SYSTEM_ADMIN_EMAILS:''};
  runtime=new Miniflare({...artifact,rootPath:source,modulesRoot:source,modules:true,host:'127.0.0.1',port:4219,bindings:vars,
    d1Databases:{DB:config.d1_databases[0].database_id},d1Persist:resolve(source,'.wrangler/state/v3/d1'),
    r2Buckets:{ASSETS:config.r2_buckets[0].bucket_name},r2Persist:resolve(source,'.wrangler/state/v3/r2'),log:new Log(LogLevel.ERROR),
    outboundService:async request=>{assert.equal(request.url,`${issuer}/cdn-cgi/access/certs`);assert.equal(request.method,'GET');
      const response=await fetch(request.url,{redirect:'error',signal:AbortSignal.timeout(5000)});return new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});}});
  assert.equal(new URL((await runtime.ready).href).origin,base.origin);notInterrupted();database=await runtime.getD1Database('DB');
  const names=(await readdir(resolve(source,'migrations'))).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort();assert.equal(names.length,24);assert.equal(names.at(-1).slice(0,4),'0024');
  assert.deepEqual((await database.prepare('SELECT name FROM d1_migrations ORDER BY name').all()).results.map(item=>item.name),names);
  originalDatabaseSnapshot=await snapshot();report.databaseBefore=originalDatabaseSnapshot;
  originalLeaseRows=(await database.prepare('SELECT * FROM system_recovery_write_leases').all()).results;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox']});notInterrupted();
  const roots=[{kind:'sample',id:seed.mixed[0].sampleId},{kind:'project',id:seed.project.projectId}];
  await caseRun(expectedCases[0],1280,'light','data_package',roots);
  await caseRun(expectedCases[1],390,'dark','report',roots);
  assert.deepEqual(report.cases.map(item=>item.id),expectedCases);assert(report.cases.every(item=>item.status==='passed'&&item.contextClosed));
  assert.equal(originalPreviewAttempts.length,2);report.databaseAfter=await snapshot();await verifyPreviewAdmission(report.databaseAfter);notInterrupted();report.status='passed';
} catch(error) {report.status='failed';report.error=privateError(error);}
finally {
  // Original owners are retained and awaited. A failed disposal is preserved;
  // this helper never signals an unowned process or invents graceful closure.
  process.stdin.removeListener('data', originalControlInput); process.stdin.pause();
  const cleanup = { sessionId: report.sessionId, startedAt: new Date().toISOString(), status: 'closing' };
  if (originalControlStop) {
    try { await originalControlStop; cleanup.originalControlStopAwaited = true; }
    catch (error) { cleanup.originalControlStopError = privateError(error); }
  }
  if (browser) { try { await closeBrowser(); cleanup.browserCloseAwaited = true; } catch (error) { cleanup.browserCloseError = privateError(error); } }
  if (database && originalDatabaseSnapshot) { try { report.databaseAfter=await snapshot(); await verifyPreviewAdmission(report.databaseAfter); cleanup.originalCatalogUnrelatedRowsAndOriginalPermitsVerified=true; } catch(error) { cleanup.acceptedHistoryVerificationError=privateError(error); } }
  if (runtime) { try { await disposeWorker(); cleanup.workerDisposeAwaited = true; await refused(4219); cleanup.workerPortRefused = true; } catch (error) { cleanup.workerCloseError = privateError(error); } }
  if (jwksServer) { try { await closeJwks(); cleanup.jwksCloseAwaited = true;
    if (issuerPort) { await refused(issuerPort); cleanup.jwksPortRefused = true; } } catch (error) { cleanup.jwksCloseError = privateError(error); } }
  cleanup.status = Object.keys(cleanup).some(key => key.endsWith('Error')) ? 'failed' : 'closed';
  cleanup.completedAt = new Date().toISOString(); report.ownedClosure = cleanup;
  if (cleanup.status !== 'closed') report.status = 'failed';
  report.unrunCases = expectedCases.filter(id => !report.cases.some(item => item.id === id)); report.completedAt = new Date().toISOString();
  await writeOnce(stopPath, cleanup); await writeOnce(reportPath, report);
}
console.log(JSON.stringify({ status: report.status, reportPath, actualCases: report.cases.length, passed: report.cases.filter(item => item.status === 'passed').length,
  failed: report.cases.filter(item => item.status === 'failed').length, unrun: report.unrunCases.length, closure: report.ownedClosure.status }));
if (report.status !== 'passed') process.exitCode = 1;
