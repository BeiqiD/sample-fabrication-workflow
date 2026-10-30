// Two additive native-Chromium idle Cancel/Escape/Close controls on a fresh private local artifact.
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
  'Usage: node browser-metrology-cancel-focus-actual-api.mjs LOOPBACK_URL FIXTURE_DIRECTORY ISOLATED_COPY');
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
assert.equal(harnessSha256, isolation.trackedFiles['scripts/qa/phase5f/browser-metrology-cancel-focus-actual-api.mjs'], 'Run the exact committed supplemental helper.');
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
for (const item of [server, session]) {
  for (const [key, value] of Object.entries(identities)) assert.equal(item[key], value);
  assert.equal(item.sourceTree, isolation.sourceTree);
}
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
assert.equal(seed.helperSha256, isolation.trackedFiles['scripts/qa/phase5f/seed-actual-api.mjs']);
assert.deepEqual(seed.ids, fixture.ids);
assert(seed.status === 'prepared' && seed.baseUrl === base.origin && seed.prefix === fixture.prefix);
assert(seed.cases.length === 6 && new Set(seed.cases.map(item => item.key)).size === 6);
assert(seed.cases.every(item => [720, 721, 1200].includes(item.width) && ['light', 'dark'].includes(item.theme) && item.actualPlanPreviewQualified));
assert.equal(seed.trace.length, 84, 'Use the mature genuine API fixture only.');
assert.equal(seed.mixed.length, 8); assert(seed.metrology?.templateId);
const reportPath = resolve(fixtureDirectory, 'metrology-cancel-focus-browser-report.json'), summaryPath = resolve(fixtureDirectory, 'metrology-cancel-focus-browser-summary.json');
const progressPath = resolve(fixtureDirectory, 'metrology-cancel-focus-browser-progress.ndjson'), browserSessionPath = resolve(fixtureDirectory, 'metrology-cancel-focus-browser-session.json');
const output = resolve(fixtureDirectory, 'metrology-cancel-focus-browser-artifacts');
for (const path of [reportPath, summaryPath, progressPath, browserSessionPath, output]) await noPriorFile(path);
const actualApiReads = [];
async function actualApi(path) {
  await liveSession();
  const response = await fetch(new URL(`/api${path}`, base), { redirect: 'error', signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, `Actual API GET ${path}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  actualApiReads.push({ path, method: 'GET', status: response.status, responseSha256: sha(bytes) });
  return JSON.parse(bytes.toString());
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
for (const routeName of ['ProcessingWorkspacePage']) {
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
  { width: 390, theme: 'dark', key: '390-dark', seedIndex: 1 },
  { width: 1280, theme: 'light', key: '1280-light', seedIndex: 2 },
];
const expectedCaseIds = matrixCases.map(item => `metrology-cancel-focus-${item.key}`);
assert(!process.env.PHASE5F_CASE_ID && !process.env.PHASE5F_REVIEWED_HARNESS_SHA256,
  'Run the complete committed two-case supplement without case/hash overrides.');
const report = { version: 1,
  scope: 'Two additive native-Chromium keyboard idle embedded-create Cancel and drawer Escape/Close controls at emulated390 dark/1280 light. Search receives focus after actual form unmount/remount, preserves the query and original Processing owner; native Tab remains trapped and Escape/Close return to the same original connected Step Add after the Metrology menu action unmounts, without UI writes. Genuine mature84 API setup, AUTH_MODE=disabled local synthetic D1/R2. No pending/accepted-write, authenticated administrator, remote Access/provider, physical keyboard/device/IME or whole-roadmap acceptance.',
  ...identities, sourceTree: isolation.sourceTree, baseUrl: base.origin, prefix: fixture.prefix,
  serverSessionId: server.sessionId, serverReceiptSha256: serverHash, harnessSha256,
  observationPolicy: { actionTimeoutMs: 20000, bodyTimeoutMs: BODY_OBSERVATION_TIMEOUT_MS, contextShutdownTimeoutMs: CONTEXT_SHUTDOWN_TIMEOUT_MS, requiredMutationAndPreviewBodiesFailClosed: true, unfinishedIncidentalGetBodiesRetained: true },
  seedHelperSha256: sha(await readFile(new URL('./seed-actual-api.mjs', import.meta.url))),
  generatorHelperSha256: sha(await readFile(new URL('./generate-process-fixture.mjs', import.meta.url))),
  isolationHelperSha256: sha(await readFile(new URL('./prepare-isolated-copy.py', import.meta.url))),
  isolationReceiptSha256: isolationHash, fixtureManifestSha256: fixtureHash,
  fixtureSqlSha256: sha(await readFile(resolve(fixtureDirectory, 'process-fixture.sql'))),
  seedReceiptSha256: sha(await readFile(seedPath)), genuineSeedRequests: seed.trace.length,
  migrationConfigSha256: sha(await readFile(resolve(isolatedSourceRoot, '.wrangler/deploy.jsonc'))),
  deploymentRedirectSha256: sha(await readFile(resolve(isolatedSourceRoot, '.wrangler/deploy/config.json'))),
  startedAt: new Date().toISOString(), expectedCaseIds, actualApiReads,
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
    api: [], browserWrites: [], unexpectedOrigins: [], pageErrors: [], assertions: [], status: 'running' };
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
    page.on('request', request => { const url = new URL(request.url());
      if (url.origin === base.origin && url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()))
        record.browserWrites.push({ path: url.pathname, method: request.method() }); });
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
    assert.equal(record.browserWrites.length, 0, 'The complete browser case must remain read-only.');
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
    try { requireMutationResponseCaptures(record); assert.equal(record.browserWrites.length, 0, 'Late browser mutation must fail the read-only case.'); } catch (error) { record.status = 'failed'; record.captureError = error.message; record.error ||= error.stack || error.message; }
    record.observationSummary = { completed: record.api.filter(item => item.observationStatus === 'completed').length, unfinished: record.api.filter(item => item.observationStatus === 'unfinished').length, unavailable: record.api.filter(item => item.observationStatus === 'unavailable').length, requiredUnfinished: record.api.filter(item => item.bodyObservationRequired && item.observationStatus !== 'completed').length };
    record.completedAt = new Date().toISOString(); await saveReport();
    console.log(JSON.stringify({ id, status: record.status, error: record.error?.split('\n')[0] ?? null }));
    if (shutdownError) throw shutdownError;
    if (record.status !== 'passed') throw new Error(record.error || `Browser case ${id} failed.`);
  }
}
async function keyboardClick(locator) { await enabled(locator); await locator.focus();
  assert(await locator.evaluate(element => document.activeElement === element)); await locator.press('Enter'); }
function drawer(page) { return page.getByRole('dialog', { name: 'Add metrology', exact: true }); }
async function focused(locator) {
  await visible(locator);
  await locator.page().waitForFunction(element => document.activeElement === element,
    await locator.elementHandle(), { timeout: 20000 });
  assert(await locator.evaluate(element => document.activeElement === element));
}
async function accessibleSearch(page, record) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const matches = nodes.filter(node => !node.ignored && node.role?.value === 'textbox' && node.name?.value === 'Search templates');
    assert.equal(matches.length, 1, 'One genuine named Chromium Search textbox is required.');
    record.assertions.push({ chromiumSearchName: matches[0].name.value, accessibleTextboxCount: matches.length });
  } finally { await cdp.detach(); }
}
try {
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  report.browserVersion = browser.version();
  for (const matrix of matrixCases) await executeCase(`metrology-cancel-focus-${matrix.key}`, matrix, async (page, record) => {
    const owner = seed.mixed[matrix.seedIndex];
    assert(owner.sampleId && owner.runId && owner.firstStepId && owner.initialPlanRevisionId);
    const samplePath = `/samples/${owner.sampleId}?view=processing`;
    const templatePath = `/templates/${seed.metrology.templateId}`;
    const before = await actualApi(samplePath), templateBefore = await actualApi(templatePath);
    const run = before.runs.find(item => item.id === owner.runId);
    assert.equal(run.currentPlanRevisionId, owner.initialPlanRevisionId);
    assert(run.steps.some(item => item.id === owner.firstStepId));
    record.owner = { sampleId: owner.sampleId, runId: owner.runId, firstStepId: owner.firstStepId,
      currentPlanRevisionId: run.currentPlanRevisionId, code: before.code, title: before.title };
    const originalUrl = new URL(`/processing/${owner.sampleId}?run=${encodeURIComponent(owner.runId)}`, base).href;
    await page.goto(originalUrl); await visible(page.getByRole('heading', { name: before.title, exact: true }));
    const stepAdd = page.getByRole('button', { name: 'Add after this entry', exact: true }).first();
    await enabled(stepAdd); const originalStepAdd = await stepAdd.elementHandle();
    await keyboardClick(stepAdd);
    const metrologyAction = page.getByRole('button', { name: 'Metrology', exact: true });
    await enabled(metrologyAction); const originalMetrologyAction = await metrologyAction.elementHandle();
    await keyboardClick(metrologyAction);
    assert(!(await originalMetrologyAction.evaluate(element => element.isConnected)), 'The focused original Metrology menu action must actually unmount.');
    const dialog = drawer(page); await visible(dialog); const originalDialog = await dialog.elementHandle();
    const search = dialog.getByRole('textbox', { name: 'Search templates', exact: true });
    await focused(search); await accessibleSearch(page, record);
    const choice = dialog.locator('.metrology-picker-list button').filter({ has: page.getByText(`5F synthetic SEM ${fixture.prefix}`, { exact: true }) });
    await visible(choice); await enabled(choice);
    const query = fixture.prefix;
    await Promise.all([page.waitForResponse(response => { const url = new URL(response.url());
      return url.origin === base.origin && url.pathname === '/api/metrology-templates'
        && url.searchParams.get('q') === query && response.request().method() === 'GET' && response.status() === 200; }, { timeout: 20000 }), search.fill(query)]);
    await visible(choice); await enabled(choice);
    assert.equal(await search.inputValue(), query); await focused(search);
    const originalSearch = await search.elementHandle();
    await noDocumentOverflow(page, record.assertions, 'original-picker-query', matrix.theme);
    await keyboardClick(dialog.getByRole('button', { name: 'Create new metrology template', exact: true }));
    const title = dialog.getByLabel('Template title', { exact: true }); await focused(title);
    assert(!(await originalSearch.evaluate(element => element.isConnected)), 'Create form must actually unmount the original Search.');
    await title.fill(`${fixture.prefix} unsaved keyboard draft 中文`);
    const tabOrder = [dialog.getByLabel(/^Tool/), dialog.getByLabel(/^Parameters/), dialog.getByLabel(/^Comments/),
      dialog.getByRole('button', { name: 'Cancel', exact: true })];
    for (const target of tabOrder) { await page.keyboard.press('Tab'); await focused(target); }
    const cancel = tabOrder.at(-1); assert(await cancel.isEnabled());
    await page.keyboard.press('Enter');
    await absent(title); await focused(search);
    assert.equal(await search.inputValue(), query, 'Actual newly mounted Search must retain the original query.');
    assert(await dialog.evaluate((element, original) => element === original, originalDialog), 'Cancel retains the same original drawer owner.');
    await visible(choice); await enabled(choice); await accessibleSearch(page, record);
    assert.equal(page.url(), originalUrl, 'Cancel must retain the exact Processing sample/run route.');
    await page.screenshot({ path: resolve(output, `${record.id}-restored-search.png`), fullPage: true, timeout: 20000 });
    // Exercise the existing native modal Tab boundaries without submitting a write.
    const create = dialog.getByRole('button', { name: 'Create new metrology template', exact: true });
    const close = dialog.getByRole('button', { name: 'Close', exact: true });
    await create.focus(); await focused(create); await page.keyboard.press('Tab'); await focused(close);
    await page.keyboard.press('Shift+Tab'); await focused(create);
    await noDocumentOverflow(page, record.assertions, 'cancel-restored-picker', matrix.theme);
    await search.focus(); await focused(search); await page.keyboard.press('Escape'); await absent(dialog);
    assert(!(await originalDialog.evaluate(element => element.isConnected)), 'Escape must actually unmount the original drawer.');
    assert(await originalStepAdd.evaluate(element => element.isConnected), 'The original same-Step Add must survive Escape.');
    assert(await stepAdd.evaluate((element, original) => element === original, originalStepAdd), 'Escape must retain the exact original Step Add element.');
    await focused(stepAdd); assert.equal(page.url(), originalUrl);
    // A genuine second opening uses the same original Step and a new drawer.
    // Native Close must return to that persistent control too, without writes.
    await keyboardClick(stepAdd);
    const reopenedAction = page.getByRole('button', { name: 'Metrology', exact: true });
    await Promise.all([page.waitForResponse(response => { const url = new URL(response.url());
      return url.origin === base.origin && url.pathname === '/api/metrology-templates'
        && response.request().method() === 'GET' && response.status() === 200; }, { timeout: 20000 }), keyboardClick(reopenedAction)]);
    await visible(dialog); const reopenedDialog = await dialog.elementHandle();
    assert(await dialog.evaluate((element, original) => element !== original, originalDialog), 'Close control uses a genuinely newly mounted drawer.');
    await focused(search); await accessibleSearch(page, record);
    await keyboardClick(dialog.getByRole('button', { name: 'Close', exact: true }));
    await absent(dialog); assert(!(await reopenedDialog.evaluate(element => element.isConnected)));
    assert(await originalStepAdd.evaluate(element => element.isConnected));
    assert(await stepAdd.evaluate((element, original) => element === original, originalStepAdd), 'Close must retain the exact original Step Add element.');
    await focused(stepAdd); assert.equal(page.url(), originalUrl);
    await noDocumentOverflow(page, record.assertions, 'idle-close-restored-original-step', matrix.theme);
    await page.screenshot({ path: resolve(output, `${record.id}-restored-step-add.png`), fullPage: true, timeout: 20000 });
    const after = await actualApi(samplePath), templateAfter = await actualApi(templatePath);
    assert.deepEqual(after, before, 'Readonly Cancel must preserve every actual Processing readback field.');
    assert.deepEqual(templateAfter, templateBefore, 'Unsaved draft must preserve the actual original Metrology template.');
    assert.equal(record.browserWrites.length, 0, 'Idle create/Cancel/Tab/Escape/Close must not dispatch any mutation.');
    record.assertions.push({ nativeEnterOpensMenuAndCreate: true, createActuallyUnmountsSearch: true,
      nativeFourTabMovesReachCancel: true, nativeEnterCancels: true, actualNewSearchReceivesFocus: true,
      queryPreserved: query, sameOriginalDrawer: true, exactSampleRunRoutePreserved: true,
      nativeModalTabAndShiftTabWrapped: true, originalFocusedMetrologyActionUnmounts: true, idleEscapeDismisses: true,
      idleEscapeReturnsSameOriginalStepAdd: true, genuineSecondDrawerRead: true, nativeCloseReturnsSameOriginalStepAdd: true,
      actualProcessingReadbackUnchanged: true, actualTemplateReadbackUnchanged: true, browserMutationRequests: record.browserWrites.length,
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
    harnessSha256, browserClosed: report.browserClosed, genuineSeedRequests: report.genuineSeedRequests, actualApiReads: report.actualApiReads,
    reportSha256: sha(await readFile(reportPath)), cases: report.cases.map(({ id, status, assertions, error, contextClosed, observationSummary }) =>
      ({ id, status, assertions, error, contextClosed, observationSummary })), ...(report.error ? { error: report.error } : {}) };
  await writeOnce(summaryPath, summary);
  console.log(JSON.stringify({ status: report.status, passed: report.passedCount, failed: report.failedCount,
    completeFiniteMatrix: report.completeFiniteMatrix, reportPath })); if (report.status !== 'passed') process.exitCode = 1;
}
