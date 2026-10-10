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
  'Usage: node browser-template-pagination-actual-api.mjs LOOPBACK_URL FIXTURE_DIRECTORY ISOLATED_COPY');
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
assert.equal(harnessSha256, isolation.trackedFiles['scripts/qa/phase5f/browser-template-pagination-actual-api.mjs'], 'Run the exact committed supplemental helper.');
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
const templateSeedPath = await ownedFile(fixtureDirectory, 'template-pagination-fixture-receipt.json');
const templateSeedBytes = await readFile(templateSeedPath), templateSeed = JSON.parse(templateSeedBytes);
for (const [key, value] of Object.entries(identities)) assert.equal(templateSeed[key], value);
assert.equal(templateSeed.status, 'prepared'); assert.equal(templateSeed.serverSessionId, server.sessionId);
assert.equal(templateSeed.originalSeedReceiptSha256, sha(await readFile(seedPath)));
assert.equal(templateSeed.serverReceiptSha256, serverHash); assert.equal(templateSeed.prefix, fixture.prefix);
assert.equal(templateSeed.helperSha256, isolation.trackedFiles['scripts/qa/phase5f/seed-template-pagination-actual-api.mjs']);
assert.equal(templateSeed.trace.length, 102);
assert.equal(templateSeed.process.length, 21); assert.equal(templateSeed.metrology.length, 26);
assert.equal(new Set([...templateSeed.process, ...templateSeed.metrology].map(item => item.recipeFamilyId)).size, 47);
assert.equal(new Set([...templateSeed.process, ...templateSeed.metrology].map(item => item.templateId)).size, 47);
assert.equal(templateSeed.directoryPrefix, `${fixture.prefix}-template-pages`);
for (const item of templateSeed.process) {
  assert.equal(sha(await readFile(await ownedFile(fixtureDirectory, item.workbookFile))), item.workbookSha256);
  assert.equal(sha(await readFile(await ownedFile(fixtureDirectory, item.manifestFile))), item.manifestSha256);
}
const reportPath = resolve(fixtureDirectory, 'template-pagination-browser-report.json'), summaryPath = resolve(fixtureDirectory, 'template-pagination-browser-summary.json');
const progressPath = resolve(fixtureDirectory, 'template-pagination-browser-progress.ndjson'), browserSessionPath = resolve(fixtureDirectory, 'template-pagination-browser-session.json');
const output = resolve(fixtureDirectory, 'template-pagination-browser-artifacts');
for (const path of [reportPath, summaryPath, progressPath, browserSessionPath, output]) await noPriorFile(path);
async function actualApi(path) {
  await liveSession();
  const response = await fetch(new URL(`/api${path}`, base), { redirect: 'error', signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, `Actual API GET ${path}`);
  return response.json();
}
// Check both random sentinel versions before the first read-only browser action.
// Localhost alone is insufficient isolation evidence.
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
const servedRouteChunks = [];
for (const routeName of ['TemplatesPage', 'TemplatePage', 'MetrologyTemplatePage']) {
  const chunkNames = assetNames.filter(name => name.startsWith(`${routeName}-`) && name.endsWith('.js'));
  assert.equal(chunkNames.length, 1, `Exactly one built ${routeName} chunk is required.`);
  const chunk = chunkNames[0], bytes = await readFile(resolve(assetsDirectory, chunk));
  const response = await fetch(new URL(`/assets/${chunk}`, base), { redirect: 'error', signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200); assert.equal(sha(Buffer.from(await response.arrayBuffer())), sha(bytes));
  servedRouteChunks.push({ routeName, chunk, sha256: sha(bytes), servedMatched: true });
}
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
const matrixCases = [
  { domain: 'process', width: 390, theme: 'dark', key: 'process-390-dark' },
  { domain: 'process', width: 1280, theme: 'light', key: 'process-1280-light' },
  { domain: 'metrology', width: 390, theme: 'light', key: 'metrology-390-light' },
  { domain: 'metrology', width: 1280, theme: 'dark', key: 'metrology-1280-dark' },
];
const expectedCaseIds = matrixCases.map(item => `template-pages-${item.key}`);
assert(!process.env.PHASE5F_CASE_ID && !process.env.PHASE5F_REVIEWED_HARNESS_SHA256,
  'This new finite four-case qualification requires the complete committed helper, without case/hash overrides.');
const report = { version: 1, scope: 'Four additive actual Worker Templates cases with 21 distinct process families/default 20+1 and 26 distinct metrology families/default 25+1. Read-only keyboard pagination/retry/search/browser Back with emulated390/1280 light/dark. Synthetic AUTH_MODE=disabled local D1/R2 fixture; no remote Access, providers, physical devices/IME or whole-roadmap completion.',
  ...identities, baseUrl: base.origin, prefix: fixture.prefix, directoryPrefix: templateSeed.directoryPrefix,
  serverSessionId: server.sessionId, serverReceiptSha256: serverHash, harnessSha256,
  observationPolicy: { actionTimeoutMs: 20000, bodyTimeoutMs: BODY_OBSERVATION_TIMEOUT_MS, contextShutdownTimeoutMs: CONTEXT_SHUTDOWN_TIMEOUT_MS, requiredMutationAndPreviewBodiesFailClosed: true, unfinishedIncidentalGetBodiesRetained: true },
  seedHelperSha256: sha(await readFile(new URL('./seed-actual-api.mjs', import.meta.url))),
  generatorHelperSha256: sha(await readFile(new URL('./generate-process-fixture.mjs', import.meta.url))),
  isolationHelperSha256: sha(await readFile(new URL('./prepare-isolated-copy.py', import.meta.url))),
  isolationReceiptSha256: isolationHash, fixtureManifestSha256: fixtureHash,
  fixtureSqlSha256: sha(await readFile(resolve(fixtureDirectory, 'process-fixture.sql'))),
  seedReceiptSha256: sha(await readFile(seedPath)), templateSeedReceiptSha256: sha(templateSeedBytes), templateSeedHelperSha256: templateSeed.helperSha256,
  migrationConfigSha256: sha(await readFile(resolve(isolatedSourceRoot, '.wrangler/deploy.jsonc'))),
  deploymentRedirectSha256: sha(await readFile(resolve(isolatedSourceRoot, '.wrangler/deploy/config.json'))),
  startedAt: new Date().toISOString(), expectedCaseIds,
  artifact: { workerSha256: sha(await readFile(artifact.scriptPath)), assetSha256: hashes, servedRouteChunks }, cases: [] };
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
async function executeCase(id, matrix, action) {
  await liveSession();
  assert(!completed.has(id)); completed.add(id);
  const record = { id, domain: matrix.domain, width: matrix.width, theme: matrix.theme, startedAt: new Date().toISOString(),
    api: [], unexpectedOrigins: [], pageErrors: [], assertions: [], status: 'running' };
  report.cases.push(record); await saveReport();
  let context, page; const observations = [];
  try {
    context = await browser.newContext({ viewport: { width: matrix.width, height: 900 },
      colorScheme: matrix.theme, isMobile: matrix.width === 390, hasTouch: matrix.width === 390, serviceWorkers: 'block' });
    await context.addInitScript(theme => localStorage.setItem('sample-workflow-theme', theme), matrix.theme);
    await context.route('**/*', async route => {
      const target = new URL(route.request().url());
      if (['http:', 'https:'].includes(target.protocol) && target.origin !== base.origin) {
        record.unexpectedOrigins.push(target.origin); await route.abort('blockedbyclient'); return;
      }
      await route.continue();
    });
    page = await context.newPage();
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
          try { const body = await bounded(response.body(), BODY_OBSERVATION_TIMEOUT_MS, `Response body ${item.method} ${item.path}`); item.observationStatus = 'completed'; item.responseSha256 = sha(body); const value = JSON.parse(body); if (value.pagination) { item.pagination = value.pagination; item.directoryIds = value.families?.map(item => item.recipeFamilyId) || value.templates?.map(item => item.id) || []; } item.preview = { ...(typeof value.canConfirm === 'boolean' ? { canConfirm: value.canConfirm, blockingReason: value.blockingReason } : {}), ...(typeof value.compatible === 'boolean' ? { compatible: value.compatible } : {}), ...(value.substrateTransition ? { substrateCanConfirm: value.substrateTransition.canConfirm, substrateBlockingReason: value.substrateTransition.blockingReason } : {}) }; }
          catch (error) { item.responseUnavailable = true; item.observationStatus = error.code === 'PHASE5F_OBSERVATION_DEADLINE' ? 'unfinished' : 'unavailable'; item.observationError = error.message; }
        } else { item.observationStatus = 'not-json'; }
      })(); observations.push(observation);
    });
    await action(page, record);
    await Promise.all(observations);
    requireMutationResponseCaptures(record);
    assert.equal(record.unexpectedOrigins.length, 0, 'No external server traffic is part of this fixture.');
    assert.equal(record.pageErrors.length, 0, record.pageErrors.join('\n'));
    await page.screenshot({ path: resolve(output, `${id}.png`), fullPage: true, timeout: 20000 });
    record.status = 'passed';
  } catch (error) {
    record.status = 'failed'; record.error = error.stack || error.message;
    await Promise.all(observations);
    if (page) await page.screenshot({ path: resolve(output, `${id}-failed.png`), fullPage: true, timeout: 20000 }).catch(() => {});
  } finally {
    let shutdownError;
    try { if (context) { await bounded(context.close(), CONTEXT_SHUTDOWN_TIMEOUT_MS, 'Browser context shutdown'); record.contextClosed = true; } else record.contextNotCreated = true; }
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
function requireTemplateScope(page, query, processPage, metrologyPage) {
  const params = new URL(page.url()).searchParams;
  assert.equal(params.get('q'), query); assert.equal(params.get('processPage') || '1', String(processPage));
  assert.equal(params.get('metrologyPage') || '1', String(metrologyPage));
}
const domains = {
  process: { label: 'Process template pages', section: '.process-templates-section', row: '.template-family-card',
    link: '.template-version-link', route: '/templates/', readPath: '/api/template-families', retry: 'Retry process templates', pageSize: 20, total: 21 },
  metrology: { label: 'Metrology template pages', section: '.metrology-templates-section', row: '.metrology-template-row',
    link: '.metrology-template-link', route: '/templates/metrology/', readPath: '/api/metrology-templates', retry: 'Retry metrology templates', pageSize: 25, total: 26 },
};
async function requireRows(page, domain, owners) {
  const config = domains[domain], section = page.locator(config.section);
  assert.equal(await section.locator(config.row).count(), owners.length, `${domain} original row cardinality`);
  const actual = await section.locator(config.link).evaluateAll(elements => elements.map(element => ({
    href: element.getAttribute('href'), name: element.getAttribute('aria-label') })));
  const expected = owners.map(item => ({ href: `${config.route}${item.templateId}`,
    name: domain === 'process' ? `Open ${item.name} version 1` : `Open ${item.name} metrology template` }));
  assert.deepEqual(actual, expected, `${domain} must restore exact original ordered identities and names`);
  return actual;
}
async function requireDefaultPages(page) {
  for (const domain of ['process', 'metrology']) {
    const nav = page.getByRole('navigation', { name: domains[domain].label, exact: true });
    await visible(nav.getByText('Page 1 of 2', { exact: true }));
    assert(await nav.getByRole('button', { name: 'Previous', exact: true }).isDisabled());
    assert(!(await nav.getByRole('button', { name: 'Next', exact: true }).isDisabled()));
    await requireRows(page, domain, templateSeed[domain].slice(0, domains[domain].pageSize));
  }
}
try {
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  report.browserVersion = browser.version();
  for (const matrix of matrixCases) await executeCase(`template-pages-${matrix.key}`, matrix, async (page, record) => {
    const writes = []; page.on('request', request => { const url = new URL(request.url());
      if (url.origin === base.origin && url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()))
        writes.push({ path: url.pathname, method: request.method() }); });
    const domain = matrix.domain, config = domains[domain], other = domain === 'process' ? 'metrology' : 'process';
    const owners = templateSeed[domain], otherOwners = templateSeed[other].slice(0, domains[other].pageSize);
    const prefix = templateSeed.directoryPrefix;
    await page.goto(new URL(`/templates?q=${encodeURIComponent(prefix)}`, base).href);
    await visible(page.getByRole('heading', { name: 'Templates', exact: true }));
    await requireDefaultPages(page); requireTemplateScope(page, prefix, 1, 1);
    const search = page.getByRole('searchbox', { name: 'Search templates', exact: true });
    await visible(search);
    if (matrix.width === 390) assert(!(await search.evaluate(element => document.activeElement === element)), 'Touch viewport must not steal initial keyboard focus');
    await noDocumentOverflow(page, record.assertions, 'templates-original-first-pages', matrix.theme);
    const nav = page.getByRole('navigation', { name: config.label, exact: true });
    const clearFault = await readFaultOnce(page, config.readPath, record);
    await keyboardClick(nav.getByRole('button', { name: 'Next', exact: true }));
    const retry = page.getByRole('button', { name: config.retry, exact: true });
    await visible(retry); requireTemplateScope(page, prefix, domain === 'process' ? 2 : 1, domain === 'metrology' ? 2 : 1);
    await requireRows(page, other, otherOwners);
    await keyboardClick(retry);
    await visible(nav.getByText('Page 2 of 2', { exact: true })); await clearFault();
    assert(await nav.getByRole('button', { name: 'Next', exact: true }).isDisabled());
    const tail = owners.at(-1); await requireRows(page, domain, [tail]); await requireRows(page, other, otherOwners);
    requireTemplateScope(page, prefix, domain === 'process' ? 2 : 1, domain === 'metrology' ? 2 : 1);
    await noDocumentOverflow(page, record.assertions, 'templates-recovered-last-page', matrix.theme);
    await keyboardClick(nav.getByRole('button', { name: 'Previous', exact: true }));
    await visible(nav.getByText('Page 1 of 2', { exact: true }));
    await requireRows(page, domain, owners.slice(0, config.pageSize)); await requireRows(page, other, otherOwners);
    requireTemplateScope(page, prefix, 1, 1);
    await keyboardClick(nav.getByRole('button', { name: 'Next', exact: true }));
    await visible(nav.getByText('Page 2 of 2', { exact: true })); await requireRows(page, domain, [tail]);
    const sourceLink = page.getByRole('link', { name: domain === 'process' ? `Open ${tail.name} version 1` : `Open ${tail.name} metrology template`, exact: true });
    await keyboardClick(sourceLink);
    await visible(page.getByRole('heading', { name: tail.name, exact: true }));
    assert.equal(new URL(page.url()).pathname, `${config.route}${tail.templateId}`);
    await noDocumentOverflow(page, record.assertions, 'original-template-source', matrix.theme);
    await page.goBack(); await visible(nav.getByText('Page 2 of 2', { exact: true }));
    await requireRows(page, domain, [tail]); await requireRows(page, other, otherOwners);
    requireTemplateScope(page, prefix, domain === 'process' ? 2 : 1, domain === 'metrology' ? 2 : 1);
    await search.focus(); assert(await search.evaluate(element => document.activeElement === element));
    const absentQuery = `${prefix} absent`;
    await search.fill(absentQuery); await page.waitForURL(url => url.searchParams.get('q') === absentQuery);
    await visible(page.getByText('No matching process templates.', { exact: true }));
    await visible(page.getByText('No matching metrology templates.', { exact: true }));
    requireTemplateScope(page, absentQuery, 1, 1);
    await requireRows(page, 'process', []); await requireRows(page, 'metrology', []);
    assert(await search.evaluate(element => document.activeElement === element), 'Debounced search retains native input focus');
    await search.fill(prefix); await page.waitForURL(url => url.searchParams.get('q') === prefix);
    await requireDefaultPages(page); requireTemplateScope(page, prefix, 1, 1);
    assert(await search.evaluate(element => document.activeElement === element), 'Restoring the original query retains native input focus');
    await noDocumentOverflow(page, record.assertions, 'templates-restored-query-first-pages', matrix.theme);
    assert.equal(writes.length, 0, 'Pagination/retry/search/source navigation must not dispatch mutations.');
    record.assertions.push({ distinctProcessFamilies: 21, processDefaultSize: 20, processFirstRows: 20, processLastRows: 1,
      distinctMetrologyFamilies: 26, metrologyDefaultSize: 25, metrologyFirstRows: 25, metrologyLastRows: 1,
      targetDomain: domain, genuineDefaultSizesCheckedBySeeder: true, independentDomainPagePreserved: true,
      restoredExactOriginalFirstPage: true, actualUnderlyingRead200BeforeControlled503: true, nativeKeyboardRetry: true,
      nativeSourceLinkAndBrowserHistoryBack: true, nativeSearchAccessibilityName: 'Search templates',
      queryChangeResetsBothPages: true, searchFocusRetained: true, browserMutationRequests: writes.length,
      apiReadResponsesObserved: record.api.length });
  });
} catch (error) {
  report.error = error.stack || error.message; process.exitCode = 1;
} finally {
  if (browser) { try { await bounded(browser.close(), CONTEXT_SHUTDOWN_TIMEOUT_MS, 'Browser shutdown'); report.browserClosed = true; }
    catch (error) { report.error ||= error.stack || error.message; report.cleanupError = error.message; process.exitCode = 1; } }
  const requested = expectedCaseIds;
  report.requestedCaseIds = requested; report.passedCount = report.cases.filter(item => item.status === 'passed').length;
  report.unrunCaseIds = requested.filter(id => !report.cases.some(item => item.id === id));
  report.failedCount = report.cases.filter(item => item.status !== 'passed').length; report.completedAt = new Date().toISOString();
  report.status = !report.error && report.failedCount === 0 && report.cases.length === requested.length ? 'passed' : 'failed';
  report.completeFiniteMatrix = report.status === 'passed'; await saveReport(); await writeOnce(reportPath, report);
  const summary = { ...identities, version: 1, scope: report.scope, status: report.status, completeFiniteMatrix: report.completeFiniteMatrix,
    passedCount: report.passedCount, failedCount: report.failedCount, requestedCaseIds: requested,
    unrunCaseIds: report.unrunCaseIds,
    harnessSha256, browserClosed: report.browserClosed, templateSeedReceiptSha256: report.templateSeedReceiptSha256,
    reportSha256: sha(await readFile(reportPath)), cases: report.cases.map(({ id, status, assertions, error, contextClosed, observationSummary }) =>
      ({ id, status, assertions, error, contextClosed, observationSummary })), ...(report.error ? { error: report.error } : {}) };
  await writeOnce(summaryPath, summary);
  console.log(JSON.stringify({ status: report.status, passed: report.passedCount, failed: report.failedCount,
    completeFiniteMatrix: report.completeFiniteMatrix, reportPath })); if (report.status !== 'passed') process.exitCode = 1;
}
