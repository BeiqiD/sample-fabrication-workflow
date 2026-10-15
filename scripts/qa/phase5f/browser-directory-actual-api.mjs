// Finite actual-API Chromium qualification on a fresh private local artifact.
// This helper never installs dependencies, starts a service, or changes source.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, lstat, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const BODY_OBSERVATION_TIMEOUT_MS = 5000;
const CONTEXT_SHUTDOWN_TIMEOUT_MS = 10000;
async function bounded(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => { const error = new Error(`${label} exceeded ${timeoutMs}ms`); error.code = 'PHASE5F_OBSERVATION_DEADLINE'; reject(error); }, timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function requireMutationResponseCaptures(record) {
  const missing = record.api.filter(item => item.bodyObservationRequired && item.observationStatus !== 'completed');
  assert.equal(missing.length, 0, `Required mutation/preview response captures unfinished: ${missing.map(item => `${item.method} ${item.path}`).join(', ')}`);
}

const tempAlias = resolve(tmpdir()), tempRoot = await realpath(tempAlias);
function within(root, path) { const part = relative(root, path); return part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); }
async function privateDirectory(value) {
  let path = resolve(value); if (within(tempAlias, path)) path = resolve(tempRoot, relative(tempAlias, path));
  assert(within(tempRoot, path), 'Use a private directory below the OS temporary root.');
  let cursor = tempRoot;
  for (const part of relative(tempRoot, path).split(sep)) { cursor = resolve(cursor, part); const info = await lstat(cursor); assert(info.isDirectory() && !info.isSymbolicLink()); }
  const info = await lstat(path); if (process.getuid) { assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o077, 0, 'Fixture roots must be private.'); }
  return path;
}
async function ownedFile(root, name) {
  assert(typeof name === 'string' && !isAbsolute(name) && within(root, resolve(root, name)), 'File must remain within the isolated root.');
  let cursor = root; const path = resolve(root, name);
  for (const part of relative(root, path).split(sep)) { cursor = resolve(cursor, part); assert(!(await lstat(cursor)).isSymbolicLink(), 'Fixture files must not use symlinks.'); }
  assert((await lstat(path)).isFile()); return path;
}
async function json(root, name) { return JSON.parse(await readFile(await ownedFile(root, name), 'utf8')); }
async function noPriorFile(path) { try { await lstat(path); assert.fail(`Refusing earlier receipt/session: ${path}`); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
async function writeOnce(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
const [baseValue, fixtureValue, copyValue] = process.argv.slice(2);
assert(baseValue && fixtureValue && copyValue && process.argv.length === 5,
  'Usage: node browser-directory-actual-api.mjs LOOPBACK_URL FIXTURE_DIRECTORY ISOLATED_COPY');
const fixtureDirectory = await privateDirectory(fixtureValue), isolatedSourceRoot = await privateDirectory(copyValue);
assert(fixtureDirectory !== isolatedSourceRoot && !within(fixtureDirectory, isolatedSourceRoot) && !within(isolatedSourceRoot, fixtureDirectory), 'Keep copied state and receipt roots separate.');
const fixturePath = await ownedFile(fixtureDirectory, 'process-fixture.json'), fixture = await json(fixtureDirectory, 'process-fixture.json');
const isolationPath = await ownedFile(isolatedSourceRoot, 'isolation-receipt.json'), isolation = await json(isolatedSourceRoot, 'isolation-receipt.json');
const isolationHash = sha(await readFile(isolationPath)), fixtureHash = sha(await readFile(fixturePath));
assert.equal(isolation.copiedState, false); assert.equal(isolation.sourceCopyRoot, isolatedSourceRoot);
assert.equal(fixture.sourceCopyRoot, isolatedSourceRoot); assert.equal(fixture.fixtureDirectory, fixtureDirectory);
assert.equal(fixture.sourceHead, isolation.sourceHead); assert.equal(fixture.isolationReceiptSha256, isolationHash); assert.equal(fixture.loopbackPort, 4219);
assert.equal(sha(await readFile(await ownedFile(fixtureDirectory, 'process-fixture.sql'))), fixture.sqlSha256);
for (const map of [isolation.trackedFiles, isolation.copiedArtifactFiles]) {
  assert(map && Object.keys(map).length);
  for (const [name, hash] of Object.entries(map)) assert.equal(sha(await readFile(await ownedFile(isolatedSourceRoot, name))), hash, `Copied byte mismatch: ${name}`);
}
const harnessSha256 = sha(await readFile(new URL(import.meta.url)));
const explicitReviewedHarnessSha256 = process.env.PHASE5F_REVIEWED_HARNESS_SHA256 || null;
if (explicitReviewedHarnessSha256) assert(/^[a-f0-9]{64}$/.test(explicitReviewedHarnessSha256));
assert.equal(harnessSha256, explicitReviewedHarnessSha256 || isolation.trackedFiles['scripts/qa/phase5f/browser-directory-actual-api.mjs'], 'Execute the committed helper or explicitly frozen reviewed supplemental helper byte identity.');
assert((await lstat(resolve(isolatedSourceRoot, 'node_modules'))).isSymbolicLink());
assert.equal(await realpath(resolve(isolatedSourceRoot, 'node_modules')), isolation.nodeModulesRoot);
const requestedBase = new URL(baseValue);
assert(requestedBase.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(requestedBase.hostname)
  && !requestedBase.username && !requestedBase.password && requestedBase.pathname === '/' && !requestedBase.search && !requestedBase.hash
  && requestedBase.port === '4219', 'Only the fixed isolated loopback URL is permitted.');
const base = new URL('http://127.0.0.1:4219/');
const serverPath = await ownedFile(fixtureDirectory, 'isolated-server-receipt.json'), server = await json(fixtureDirectory, 'isolated-server-receipt.json');
const session = await json(fixtureDirectory, 'isolated-server-session.json');
const identities = { sourceRoot: isolation.sourceRoot, sourceCopyRoot: isolatedSourceRoot, fixtureDirectory, sourceHead: isolation.sourceHead, isolationReceiptSha256: isolationHash, fixtureManifestSha256: fixtureHash };
for (const item of [server, session]) for (const [key, value] of Object.entries(identities)) assert.equal(item[key], value);
assert.equal(server.status, 'ready'); assert.equal(server.host, '127.0.0.1'); assert.equal(server.port, 4219);
assert.equal(server.authMode, 'disabled'); assert.equal(server.d1DatabaseId, '00000000-0000-4000-8000-000000000000');
assert.equal(new URL(server.baseUrl).origin, base.origin);
assert.equal(server.namespace.kind, 'local-r2'); assert.equal(server.namespace.bucketName, server.r2BucketName);
assert.equal(server.workerSha256, isolation.activeBuild.scriptSha256); assert.equal(server.activeBuildConfigSha256, isolation.activeBuild.configSha256);
assert.equal(server.configSha256, sha(await readFile(await ownedFile(isolatedSourceRoot, '.wrangler/deploy.jsonc'))));
assert.equal(server.sessionId, session.sessionId); assert.equal(server.sessionPid, session.sessionPid);
assert(Number.isSafeInteger(server.sessionPid) && server.sessionPid > 0);
const serverHash = sha(await readFile(serverPath)), sessionHash = sha(await readFile(await ownedFile(fixtureDirectory, 'isolated-server-session.json')));
async function liveSession() {
  await noPriorFile(resolve(fixtureDirectory, 'isolated-server-stop-receipt.json'));
  assert.equal(sha(await readFile(await ownedFile(fixtureDirectory, 'isolated-server-receipt.json'))), serverHash);
  assert.equal(sha(await readFile(await ownedFile(fixtureDirectory, 'isolated-server-session.json'))), sessionHash);
  process.kill(server.sessionPid, 0);
}
await liveSession();
const seedPath = await ownedFile(fixtureDirectory, 'actual-api-fixture-receipt.json'), seed = await json(fixtureDirectory, 'actual-api-fixture-receipt.json');
for (const [key, value] of Object.entries(identities)) assert.equal(seed[key], value);
assert.equal(seed.serverReceiptSha256, serverHash); assert.equal(seed.serverSessionId, server.sessionId);
assert(seed.status === 'prepared' && seed.baseUrl === base.origin && seed.prefix === fixture.prefix);
assert(seed.cases.length === 6 && new Set(seed.cases.map(item => item.key)).size === 6);
assert(seed.cases.every(item => [720, 721, 1200].includes(item.width) && ['light', 'dark'].includes(item.theme) && item.actualPlanPreviewQualified));
const directorySeedPath = await ownedFile(fixtureDirectory, 'directory-api-fixture-receipt.json');
const directorySeedBytes = await readFile(directorySeedPath), directorySeed = JSON.parse(directorySeedBytes);
for (const [key, value] of Object.entries({ sourceRoot: isolation.sourceRoot, sourceCopyRoot: isolatedSourceRoot,
  fixtureDirectory, sourceHead: isolation.sourceHead, isolationReceiptSha256: isolationHash, fixtureManifestSha256: fixtureHash })) {
  assert.equal(directorySeed[key], value);
}
assert.equal(directorySeed.status, 'prepared'); assert.equal(directorySeed.serverSessionId, server.sessionId);
assert.equal(directorySeed.originalSeedReceiptSha256, sha(await readFile(seedPath)));
assert.equal(directorySeed.serverReceiptSha256, serverHash); assert.equal(directorySeed.prefix, fixture.prefix);
assert.equal(directorySeed.samples.length, 51); assert.equal(new Set(directorySeed.samples.map(item => item.sampleId)).size, 51);
assert.equal(directorySeed.helperSha256, isolation.trackedFiles['scripts/qa/phase5f/seed-directory-actual-api.mjs']);
const reportPath = resolve(fixtureDirectory, 'directory-api-browser-report.json'), summaryPath = resolve(fixtureDirectory, 'directory-api-browser-summary.json');
const progressPath = resolve(fixtureDirectory, 'directory-api-browser-progress.ndjson'), browserSessionPath = resolve(fixtureDirectory, 'directory-api-browser-session.json');
const output = resolve(fixtureDirectory, 'directory-browser-artifacts');
for (const path of [reportPath, summaryPath, progressPath, browserSessionPath, output]) await noPriorFile(path);
async function actualApi(path) {
  await liveSession();
  const response = await fetch(new URL(`/api${path}`, base), { redirect: 'error', signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, `Actual API GET ${path}`);
  return response.json();
}
// Check both random sentinel versions before the first browser action, including
// actions that could write. Localhost alone is insufficient isolation evidence.
for (const [id, version] of [[fixture.ids.v1, 1], [fixture.ids.v2, 2]]) {
  const { template } = await actualApi(`/templates/${id}`);
  assert.equal(template.id, id); assert.equal(template.version, version);
  assert.equal(template.name, fixture.familyName); assert.equal(template.initialStateHash, fixture.initialStateHash);
  assert.deepEqual(template.initialSubstrateStep, fixture.initialSubstrateStep);
  assert.equal(template.initialSubstrateStep.stepNumber, '0'); assert.equal(template.initialSubstrateStep.name, 'Substrate Stack');
}
const { productionWorkerArtifact } = await import(pathToFileURL(resolve(isolatedSourceRoot, 'scripts/production-worker-artifact.mjs')));
const artifact = await productionWorkerArtifact(isolatedSourceRoot);
const assetsDirectory = resolve(artifact.assets.directory, 'assets');
const assetNames = (await readdir(assetsDirectory)).sort();
const projectChunkNames = assetNames.filter(name => /^ProjectPage-[^.]+\.js$/.test(name));
assert.equal(projectChunkNames.length, 1, 'Exactly one built ProjectPage route chunk is required.');
const projectChunk = projectChunkNames[0];
const projectChunkBytes = await readFile(resolve(assetsDirectory, projectChunk));
const servedChunk = await fetch(new URL(`/assets/${projectChunk}`, base), { redirect: 'error', signal: AbortSignal.timeout(20000) });
assert.equal(servedChunk.status, 200);
assert.equal(sha(Buffer.from(await servedChunk.arrayBuffer())), sha(projectChunkBytes),
  'Served route bytes must match the selected built artifact.');
const hashes = {};
for (const name of assetNames) hashes[name] = sha(await readFile(resolve(assetsDirectory, name)));
const runtimeRequire = createRequire(resolve(isolatedSourceRoot, 'package.json'));
// No installation or repository dependency edits. Resolve a repo-provided module
// when present, otherwise require an explicit already installed runtime path.
let playwright;
try { playwright = runtimeRequire('playwright'); }
catch {
  assert(process.env.PLAYWRIGHT_MODULE_PATH, 'Set PLAYWRIGHT_MODULE_PATH to the installed Playwright module.');
  const modulePath = resolve(process.env.PLAYWRIGHT_MODULE_PATH);
  playwright = runtimeRequire(modulePath);
}
let browser;
const selectedCase = process.env.PHASE5F_CASE_ID || null;
const matrixCases = [390, 1280].flatMap(width => ['light', 'dark'].map(theme => ({ width, theme, key: `${width}-${theme}` })));
const createCases = [matrixCases[1], matrixCases[2]];
const expectedCaseIds = [...matrixCases.map(item => `directories-${item.key}`), ...createCases.map(item => `create-lost-ack-${item.key}`)];
if (selectedCase) assert(expectedCaseIds.includes(selectedCase), 'Unknown explicit case ID.');
const report = { version: 1, scope: 'Actual Worker directory pagination/read-only retry, emulated responsive/theme and exact Project creation replay. Synthetic isolated data; no remote Access, real providers, physical devices/IME or whole-roadmap completion.',
  ...identities, baseUrl: base.origin, prefix: fixture.prefix, serverSessionId: server.sessionId, serverReceiptSha256: serverHash,
  harnessSha256, explicitReviewedHarnessSha256, observationPolicy: { bodyTimeoutMs: BODY_OBSERVATION_TIMEOUT_MS, contextShutdownTimeoutMs: CONTEXT_SHUTDOWN_TIMEOUT_MS, requiredMutationAndPreviewBodiesFailClosed: true, unfinishedIncidentalGetBodiesRetained: true },
  seedHelperSha256: sha(await readFile(new URL('./seed-actual-api.mjs', import.meta.url))),
  generatorHelperSha256: sha(await readFile(new URL('./generate-process-fixture.mjs', import.meta.url))),
  isolationHelperSha256: sha(await readFile(new URL('./prepare-isolated-copy.py', import.meta.url))),
  isolationReceiptSha256: sha(await readFile(resolve(isolatedSourceRoot, 'isolation-receipt.json'))),
  fixtureManifestSha256: sha(await readFile(resolve(fixtureDirectory, 'process-fixture.json'))),
  fixtureSqlSha256: sha(await readFile(resolve(fixtureDirectory, 'process-fixture.sql'))),
  seedReceiptSha256: sha(await readFile(resolve(fixtureDirectory, 'actual-api-fixture-receipt.json'))),
  directorySeedReceiptSha256: sha(directorySeedBytes), directorySeedHelperSha256: directorySeed.helperSha256,
  migrationConfigSha256: sha(await readFile(resolve(isolatedSourceRoot, '.wrangler/deploy.jsonc'))),
  deploymentRedirectSha256: sha(await readFile(resolve(isolatedSourceRoot, '.wrangler/deploy/config.json'))),
  startedAt: new Date().toISOString(), selectedCase, expectedCaseIds,
  artifact: { workerSha256: sha(await readFile(artifact.scriptPath)), assetSha256: hashes,
    projectChunk, projectChunkSha256: sha(projectChunkBytes), servedProjectChunkMatched: true }, cases: [] };
const completed = new Set();
await writeOnce(browserSessionPath, { version: 1, ...identities, browserSessionId: randomUUID(), sessionPid: process.pid, serverSessionId: server.sessionId, startedAt: report.startedAt });
await mkdir(output, { mode: 0o700 });
await writeFile(progressPath, '', { flag: 'wx', mode: 0o600 });
async function saveReport() { await writeFile(progressPath, JSON.stringify({ at: new Date().toISOString(), cases: report.cases.map(({ id, status, error }) => ({ id, status, ...(error ? { error: error.split('\n')[0] } : {}) })) }) + '\n', { flag: 'a', mode: 0o600 }); }
async function visible(locator) { await locator.waitFor({ state: 'visible', timeout: 20000 }); }
async function absent(locator) { await locator.waitFor({ state: 'hidden', timeout: 20000 }); }
async function enabled(locator) {
  await visible(locator);
  await locator.page().waitForFunction(element => !element.disabled, await locator.elementHandle(), { timeout: 20000 });
}
async function noDocumentOverflow(page, evidence, surface, expectedTheme) {
  const dimensions = await page.evaluate(() => ({ client: document.documentElement.clientWidth,
    rootScroll: document.documentElement.scrollWidth, bodyScroll: document.body.scrollWidth,
    theme: document.documentElement.dataset.theme }));
  evidence.push({ surface, ...dimensions });
  assert.equal(dimensions.theme, expectedTheme, `${surface} must use the declared theme`);
  assert(dimensions.rootScroll <= dimensions.client + 2 && dimensions.bodyScroll <= dimensions.client + 2,
    `${surface} overflow escaped into the document`);
}
async function executeCase(id, matrix, action, { controlledChunkFault = false } = {}) {
  if (selectedCase && selectedCase !== id) return;
  await liveSession();
  assert(!completed.has(id)); completed.add(id);
  const record = { id, width: matrix.width, theme: matrix.theme, startedAt: new Date().toISOString(),
    api: [], unexpectedOrigins: [], pageErrors: [], assertions: [], status: 'running' };
  report.cases.push(record); await saveReport();
  const context = await browser.newContext({ viewport: { width: matrix.width, height: 900 },
    colorScheme: matrix.theme, isMobile: matrix.width === 390, hasTouch: matrix.width === 390, serviceWorkers: 'block' });
  await context.addInitScript(theme => localStorage.setItem('sample-workflow-theme', theme), matrix.theme);
  await context.route('**/*', async route => {
    const target = new URL(route.request().url());
    if (['http:', 'https:'].includes(target.protocol) && target.origin !== base.origin) {
      record.unexpectedOrigins.push(target.origin); await route.abort('blockedbyclient'); return;
    }
    await route.continue();
  });
  const page = await context.newPage(), observations = [];
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => record.pageErrors.push(error.message));
  page.on('response', response => {
    const target = new URL(response.url());
    if (target.origin !== base.origin || !target.pathname.startsWith('/api/')) return;
    const item = { path: target.pathname + target.search, method: response.request().method(), status: response.status(), bodyObservationRequired: !['GET', 'HEAD'].includes(response.request().method()), observationStatus: 'pending' };
    record.api.push(item);
    const observation = (async () => {
      const request = response.request();
      try { item.request = request.postDataJSON(); } catch { item.request = null; }
      if (response.headers()['content-type']?.includes('application/json')) {
        try { const body = await bounded(response.body(), BODY_OBSERVATION_TIMEOUT_MS, `Response body ${item.method} ${item.path}`); item.observationStatus = 'completed'; item.responseSha256 = sha(body); const value = JSON.parse(body); item.preview = { ...(typeof value.canConfirm === 'boolean' ? { canConfirm: value.canConfirm, blockingReason: value.blockingReason } : {}), ...(typeof value.compatible === 'boolean' ? { compatible: value.compatible } : {}), ...(value.substrateTransition ? { substrateCanConfirm: value.substrateTransition.canConfirm, substrateBlockingReason: value.substrateTransition.blockingReason } : {}) }; }
        catch (error) { item.responseUnavailable = true; item.observationStatus = error.code === 'PHASE5F_OBSERVATION_DEADLINE' ? 'unfinished' : 'unavailable'; item.observationError = error.message; }
      } else { item.observationStatus = 'not-json'; }
    })(); observations.push(observation);
  });
  try {
    await action(page, record);
    await Promise.all(observations);
    requireMutationResponseCaptures(record);
    assert.equal(record.unexpectedOrigins.length, 0, 'No external server traffic is part of this fixture.');
    if (!controlledChunkFault) assert.equal(record.pageErrors.length, 0, record.pageErrors.join('\n'));
    await page.screenshot({ path: resolve(output, `${id}.png`), fullPage: true, timeout: 20000 });
    record.status = 'passed';
  } catch (error) {
    record.status = 'failed'; record.error = error.stack || error.message;
    await Promise.all(observations);
    await page.screenshot({ path: resolve(output, `${id}-failed.png`), fullPage: true, timeout: 20000 }).catch(() => {});
  } finally {
    let shutdownError;
    try { await bounded(context.close(), CONTEXT_SHUTDOWN_TIMEOUT_MS, 'Browser context shutdown'); record.contextClosed = true; }
    catch (error) { shutdownError = error; record.status = 'failed'; record.contextCloseError = error.message; record.error ||= error.stack || error.message; }
    await Promise.all(observations);
    try { requireMutationResponseCaptures(record); } catch (error) { record.status = 'failed'; record.captureError = error.message; record.error ||= error.stack || error.message; }
    record.observationSummary = { completed: record.api.filter(item => item.observationStatus === 'completed').length, unfinished: record.api.filter(item => item.observationStatus === 'unfinished').length, unavailable: record.api.filter(item => item.observationStatus === 'unavailable').length, requiredUnfinished: record.api.filter(item => item.bodyObservationRequired && item.observationStatus !== 'completed').length };
    record.completedAt = new Date().toISOString(); await saveReport();
    console.log(JSON.stringify({ id, status: record.status, error: record.error?.split('\n')[0] ?? null }));
    if (shutdownError) throw shutdownError;
    if (record.status !== 'passed') throw new Error(record.error || `Browser case ${id} failed.`);
  }
}
function requireDirectoryScope(page, expectedPage) {
  const params = new URL(page.url()).searchParams;
  assert.equal(params.get('q'), directorySeed.directoryPrefix); assert.equal(params.get('location'), directorySeed.directoryLocation);
  assert.equal(params.get('status'), 'stored'); assert.equal(params.get('sort'), 'code-asc');
  assert.equal(params.get('page') || '1', String(expectedPage));
}
async function keyboardClick(locator) { await enabled(locator); await locator.focus();
  assert(await locator.evaluate(element => document.activeElement === element)); await locator.press('Enter'); }
async function readFaultOnce(page, path, record) {
  let count = 0;
  const pattern = url => url.origin === base.origin && url.pathname === path;
  const handler = async route => {
    if (route.request().method() !== 'GET' || count) { await route.continue(); return; }
    count++;
    const actual = await route.fetch({ maxRedirects: 0, timeout: 20000 });
    assert.equal(actual.status(), 200, `Genuine underlying read ${path}`);
    const bytes = await actual.body();
    record.assertions.push({ readFault: path, genuineStatusBeforeControlledFault: actual.status(), genuineResponseSha256: sha(bytes) });
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Controlled one-shot read interruption' }) });
  };
  await page.route(pattern, handler);
  return async () => { assert.equal(count, 1); await page.unroute(pattern, handler); };
}
try {
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  for (const matrix of matrixCases) await executeCase(`directories-${matrix.key}`, matrix, async (page, record) => {
    const writes = []; page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')
      && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push({ path: new URL(request.url()).pathname, method: request.method() }); });
    const params = new URLSearchParams({ q: directorySeed.directoryPrefix, page: '2', location: directorySeed.directoryLocation,
      status: 'stored', sort: 'code-asc' });
    const clearSampleFault = await readFaultOnce(page, '/api/samples', record);
    await page.goto(new URL(`/samples?${params}`, base).href);
    await visible(page.getByRole('heading', { name: 'Samples', exact: true }));
    await visible(page.getByRole('alert')); assert.equal(await page.locator('.sample-directory-row').count(), 0);
    requireDirectoryScope(page, 2); await keyboardClick(page.getByRole('button', { name: 'Retry samples', exact: true }));
    const samplePages = page.getByRole('navigation', { name: 'Sample pages' });
    await visible(samplePages.getByText('Page 2 of 2', { exact: true })); await clearSampleFault();
    requireDirectoryScope(page, 2); assert.equal(await page.locator('.sample-directory-row').count(), 1);
    const search = page.getByRole('searchbox', { name: 'Search', exact: true });
    if (matrix.width === 390) assert(!(await search.evaluate(element => document.activeElement === element)), 'Touch viewport must not steal initial keyboard focus');
    await noDocumentOverflow(page, record.assertions, 'samples-page-2', matrix.theme);
    const tail = directorySeed.samples[50], destination = page.locator('.sample-directory-row');
    await destination.focus(); await destination.press('Enter');
    await visible(page.getByRole('heading', { name: tail.title, exact: true }));
    await noDocumentOverflow(page, record.assertions, 'sample-source', matrix.theme);
    await page.goBack(); await visible(page.getByRole('navigation', { name: 'Sample pages' }).getByText('Page 2 of 2', { exact: true }));
    requireDirectoryScope(page, 2);
    await keyboardClick(page.getByRole('navigation', { name: 'Sample pages' }).getByRole('button', { name: 'Previous', exact: true }));
    await visible(page.getByRole('navigation', { name: 'Sample pages' }).getByText('Page 1 of 2', { exact: true }));
    requireDirectoryScope(page, 1); assert.equal(await page.locator('.sample-directory-row').count(), 50);
    await keyboardClick(page.getByRole('navigation', { name: 'Sample pages' }).getByRole('button', { name: 'Next', exact: true }));
    await visible(page.getByRole('navigation', { name: 'Sample pages' }).getByText('Page 2 of 2', { exact: true })); requireDirectoryScope(page, 2);
    const clearTemplateFault = await readFaultOnce(page, '/api/template-families', record);
    await page.goto(new URL(`/templates?q=${encodeURIComponent(fixture.familyName)}`, base).href);
    await visible(page.getByRole('button', { name: 'Retry process templates', exact: true }));
    await keyboardClick(page.getByRole('button', { name: 'Retry process templates', exact: true }));
    await visible(page.getByRole('link', { name: `Open ${fixture.familyName} version 2`, exact: true })); await clearTemplateFault();
    assert.equal(new URL(page.url()).searchParams.get('q'), fixture.familyName);
    await noDocumentOverflow(page, record.assertions, 'templates-read-retry', matrix.theme);
    const clearProjectFault = await readFaultOnce(page, '/api/projects', record);
    await page.goto(new URL('/projects', base).href);
    await keyboardClick(page.getByRole('button', { name: 'Retry loading Projects', exact: true }));
    await visible(page.getByRole('list', { name: 'Active Projects', exact: true })); await clearProjectFault();
    await noDocumentOverflow(page, record.assertions, 'projects-read-retry', matrix.theme);
    for (const [path, heading] of [['/settings/storage', 'Storage'], ['/settings/data', 'Data'],
      ['/settings/data/system', 'System backup and recovery'], ['/export', 'Export content']]) {
      await page.goto(new URL(path, base).href); await visible(page.getByRole('heading', { name: heading, exact: true }));
      if (path === '/settings/storage') await enabled(page.getByRole('button', { name: 'Refresh', exact: true }));
      if (path === '/settings/data') {
        const executor = await actualApi('/packages/executor'); assert.equal(executor.canManage, false);
        await visible(page.getByRole('heading', { name: 'Independent executor', exact: true }));
        await visible(page.getByText(!executor.supported ? 'Package jobs are unavailable on this runtime.'
          : !executor.enabled ? 'Execution is paused.' : executor.stale ? 'Execution is enabled, but no recent heartbeat was recorded.' : 'Execution is enabled.', { exact: true }));
        record.assertions.push({ ordinaryPackageReadStatusMatchesActualExecutor: true, administratorControlsAvailable: false });
      }
      if (path === '/settings/data/system') {
        await visible(page.getByRole('heading', { name: 'Administrator access required', exact: true }));
        assert.equal(await page.getByRole('button', { name: /Enable.*executor/ }).count(), 0);
      }
      await noDocumentOverflow(page, record.assertions, path, matrix.theme);
    }
    assert.equal(writes.length, 0, 'Directory/navigation/status recovery only reads; it must not replay a mutation');
    record.assertions.push({ realSamples: 51, page1Rows: 50, page2Rows: 1, preservedScope: true,
      keyboardRetryAndSourceNavigation: true, touchViewportEmulated: matrix.width === 390, automaticMutations: writes });
  });
  for (const matrix of createCases) await executeCase(`create-lost-ack-${matrix.key}`, matrix, async (page, record) => {
    const before = await actualApi('/projects'), attempts = []; let accepted;
    const title = `5F exact creation replay ${matrix.key} ${fixture.prefix}`;
    const pattern = url => url.origin === base.origin && url.pathname === '/api/projects';
    const handler = async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      const input = route.request().postDataJSON(); attempts.push(input);
      const expectedSubject = route.request().headers()['x-sfw-project-creation-subject']; assert(/^[a-f0-9]{64}$/.test(expectedSubject));
      record.assertions.push({ expectedSubjectPresent: true, expectedSubjectSha256: sha(expectedSubject) });
      const actual = await route.fetch({ maxRedirects: 0, timeout: 20000 });
      const bytes = await actual.body(), value = JSON.parse(bytes.toString());
      if (attempts.length === 1) {
        assert.equal(actual.status(), 201); assert.equal(value.project.id, input.id); assert.equal(value.project.title, input.title);
        accepted = value.project;
        record.assertions.push({ originalAcceptedStatus: 201, originalInput: input, originalReceiptSha256: sha(bytes), lostReplyControlledAfterActualCommit: true });
        await route.abort('failed');
      } else {
        assert.equal(actual.status(), 200); assert.equal(value.replayed, true); assert.deepEqual(input, attempts[0]);
        record.assertions.push({ exactReplayStatus: 200, replayed: true, replayReceiptSha256: sha(bytes) });
        await route.fulfill({ response: actual });
      }
    };
    await page.route(pattern, handler);
    await page.goto(new URL('/projects', base).href); await visible(page.getByRole('list', { name: 'Active Projects' }));
    await keyboardClick(page.getByRole('button', { name: 'New Project', exact: true }));
    const form = page.getByRole('form', { name: 'Create Project', exact: true });
    await form.getByLabel('Project title', { exact: true }).fill(title);
    await keyboardClick(form.getByRole('button', { name: 'Create Project', exact: true }));
    await visible(form.getByRole('alert')); assert.equal(attempts.length, 1);
    assert(await form.getByLabel('Project title', { exact: true }).evaluate(element => element.readOnly));
    await keyboardClick(form.getByRole('button', { name: 'Cancel', exact: true })); await absent(form);
    const stored = await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('project-directory-create-intent:'))
      .map(key => JSON.parse(sessionStorage.getItem(key))));
    assert.deepEqual(stored, [attempts[0]]);
    await page.goto(new URL('/samples', base).href); await visible(page.getByRole('heading', { name: 'Samples', exact: true }));
    await page.goto(new URL('/projects', base).href); await visible(form);
    assert.equal(await form.getByLabel('Project title', { exact: true }).inputValue(), title); assert.equal(attempts.length, 1);
    await noDocumentOverflow(page, record.assertions, 'retained-creation-review', matrix.theme);
    const [replayResponse] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects'
      && response.request().method() === 'POST' && response.status() === 200), keyboardClick(form.getByRole('button', { name: 'Retry Project creation', exact: true }))]);
    const replay = await replayResponse.json(); assert.equal(replay.replayed, true);
    await visible(page.getByRole('heading', { name: title, exact: true })); assert.equal(attempts.length, 2);
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('project-directory-create-intent:')).length), 0);
    const after = await actualApi('/projects'), additions = after.projects.filter(item => !before.projects.some(old => old.id === item.id));
    assert.equal(additions.length, 1); assert.equal(additions[0].id, accepted.id);
    for (const old of before.projects) assert.deepEqual(after.projects.find(item => item.id === old.id), old);
    const snapshot = await actualApi(`/projects/${accepted.id}`);
    assert.equal(snapshot.project.revision, 1); assert.equal(snapshot.items.length, 0); assert.equal(snapshot.contents.length, 0);
    await noDocumentOverflow(page, record.assertions, 'accepted-created-project', matrix.theme);
    record.assertions.push({ acceptedProjectId: accepted.id, acceptedProjectCount: 1, postTransports: 2,
      exactInputReplay: true, existingProjectsUnchanged: true, restoredAcrossDocumentNavigation: true, browserProjectGets: record.api.filter(item => item.method === 'GET' && item.path === '/api/projects').length });
  });
} catch (error) {
  report.error = error.stack || error.message; process.exitCode = 1;
} finally {
  if (browser) { try { await bounded(browser.close(), CONTEXT_SHUTDOWN_TIMEOUT_MS, 'Browser shutdown'); report.browserClosed = true; }
    catch (error) { report.error ||= error.stack || error.message; report.cleanupError = error.message; process.exitCode = 1; } }
  const requested = selectedCase ? [selectedCase] : expectedCaseIds;
  report.requestedCaseIds = requested; report.passedCount = report.cases.filter(item => item.status === 'passed').length;
  report.unrunCaseIds = requested.filter(id => !report.cases.some(item => item.id === id));
  report.failedCount = report.cases.filter(item => item.status !== 'passed').length; report.completedAt = new Date().toISOString();
  report.status = !report.error && report.failedCount === 0 && report.cases.length === requested.length ? 'passed' : 'failed';
  report.completeFiniteMatrix = !selectedCase && report.status === 'passed'; await saveReport(); await writeOnce(reportPath, report);
  const summary = { ...identities, version: 1, scope: report.scope, status: report.status, completeFiniteMatrix: report.completeFiniteMatrix,
    selectedCase, passedCount: report.passedCount, failedCount: report.failedCount, requestedCaseIds: requested,
    unrunCaseIds: report.unrunCaseIds,
    harnessSha256, browserClosed: report.browserClosed, directorySeedReceiptSha256: report.directorySeedReceiptSha256,
    reportSha256: sha(await readFile(reportPath)), cases: report.cases.map(({ id, status, assertions, error, contextClosed, observationSummary }) =>
      ({ id, status, assertions, error, contextClosed, observationSummary })), ...(report.error ? { error: report.error } : {}) };
  await writeOnce(summaryPath, summary);
  console.log(JSON.stringify({ status: report.status, passed: report.passedCount, failed: report.failedCount,
    completeFiniteMatrix: report.completeFiniteMatrix, reportPath })); if (report.status !== 'passed') process.exitCode = 1;
}
