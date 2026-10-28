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
  'Usage: node browser-actual-api.mjs LOOPBACK_URL FIXTURE_DIRECTORY ISOLATED_COPY');
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
assert.equal(harnessSha256, explicitReviewedHarnessSha256 || isolation.trackedFiles['scripts/qa/phase5f/browser-actual-api.mjs'], 'Execute the committed helper or explicitly frozen reviewed supplemental helper byte identity.');
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
const reportPath = resolve(fixtureDirectory, 'actual-api-browser-report.json'), summaryPath = resolve(fixtureDirectory, 'actual-api-browser-summary.json');
const progressPath = resolve(fixtureDirectory, 'actual-api-browser-progress.ndjson'), browserSessionPath = resolve(fixtureDirectory, 'actual-api-browser-session.json');
const output = resolve(fixtureDirectory, 'browser-artifacts');
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
const browserScenario = process.env.PHASE5F_BROWSER_SCENARIO || null;
assert(browserScenario === null || ['eightSamples', 'compareEscape'].includes(browserScenario), 'Unknown explicit browser scenario.');
const eightSamples = browserScenario === 'eightSamples';
const compareEscape = browserScenario === 'compareEscape';
const compareEscapeCaseId = 'compare-escape-1200-light';
const eightSampleCases = [{ id: 'samples-keyboard-1200-light', width: 1200, theme: 'light' },
  { id: 'samples-keyboard-720-dark', width: 720, theme: 'dark' }];
const expectedCaseIds = seed.cases.flatMap(item => [`start-${item.key}`, `plan-${item.key}`, `surfaces-${item.key}`]);
expectedCaseIds.push('chunk-404-explicit-reload', 'chunk-503-explicit-reload');
const largeProjectCaseId = 'project-large-1200-light';
const representativeProjectCaseId = 'project-large-250-400-1200-light';
const nativeLargeProjectCaseId = seed.project.large?.nodeCount === 250 ? representativeProjectCaseId : largeProjectCaseId;
if (seed.project.large) {
  assert.equal(selectedCase, nativeLargeProjectCaseId, 'A large fixture belongs only to its independent selected native case.');
  const representative = nativeLargeProjectCaseId === representativeProjectCaseId;
  assert.equal(seed.project.large.nodeCount, representative ? 250 : 200); assert.equal(seed.project.large.edgeCount, representative ? 400 : 0);
  expectedCaseIds.splice(0, expectedCaseIds.length, nativeLargeProjectCaseId);
}
if (eightSamples) {
  assert(!seed.project.large && !selectedCase, 'Eight-Sample qualification uses the original four-item seed and both independent cases.');
  assert.equal(seed.mixed.length, 8); assert.equal(new Set(seed.mixed.map(owner => owner.sampleId)).size, 8);
  expectedCaseIds.splice(0, expectedCaseIds.length, ...eightSampleCases.map(item => item.id));
}
if (compareEscape) {
  assert(!seed.project.large && !selectedCase, 'Compare/Escape uses the original four-item seed and its independent case.');
  expectedCaseIds.splice(0, expectedCaseIds.length, compareEscapeCaseId);
}
if (selectedCase) assert(expectedCaseIds.includes(selectedCase), 'Unknown explicit case ID.');
const report = { version: 1, scope: seed.project.large?.nodeCount === 250
  ? 'One native current 250-node/400-relation mixed Project case, at 1200/light; original response bytes, controls, reference Details/navigation, in-page Markdown draft cancellation and original attachment bytes. Zero browser domain mutations; no whole matrix, frame-rate, envelope or whole-5F claim.'
  : compareEscape
  ? 'One native Process Compare/Escape focus-return case, at 1200/light. Preview POSTs permitted; zero domain mutations. No full 20-case matrix or whole-5F completion claim.'
  : eightSamples
  ? 'Two native eight-Sample keyboard/idle-overlay cases only, at 1200/light and 720/dark. Original four-item Project fixture; no execution writes, full 20-case matrix, physical-device, or whole-5F completion claim.'
  : 'Actual local API + current built UI; synthetic isolated data. No remote Access, provider, device, or whole-roadmap completion claim.',
  ...(eightSamples || compareEscape ? { browserScenario } : {}),
  ...identities, baseUrl: base.origin, prefix: fixture.prefix, serverSessionId: server.sessionId, serverReceiptSha256: serverHash,
  harnessSha256, explicitReviewedHarnessSha256, observationPolicy: { bodyTimeoutMs: BODY_OBSERVATION_TIMEOUT_MS, contextShutdownTimeoutMs: CONTEXT_SHUTDOWN_TIMEOUT_MS, requiredMutationAndPreviewBodiesFailClosed: true, unfinishedIncidentalGetBodiesRetained: true },
  seedHelperSha256: sha(await readFile(new URL('./seed-actual-api.mjs', import.meta.url))),
  generatorHelperSha256: sha(await readFile(new URL('./generate-process-fixture.mjs', import.meta.url))),
  isolationHelperSha256: sha(await readFile(new URL('./prepare-isolated-copy.py', import.meta.url))),
  isolationReceiptSha256: sha(await readFile(resolve(isolatedSourceRoot, 'isolation-receipt.json'))),
  fixtureManifestSha256: sha(await readFile(resolve(fixtureDirectory, 'process-fixture.json'))),
  fixtureSqlSha256: sha(await readFile(resolve(fixtureDirectory, 'process-fixture.sql'))),
  seedReceiptSha256: sha(await readFile(resolve(fixtureDirectory, 'actual-api-fixture-receipt.json'))),
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
  if ((eightSamples || compareEscape) && !expectedCaseIds.includes(id)) return;
  await liveSession();
  assert(!completed.has(id)); completed.add(id);
  const record = { id, width: matrix.width, theme: matrix.theme, startedAt: new Date().toISOString(),
    api: [], unexpectedOrigins: [], pageErrors: [], assertions: [], status: 'running' };
  report.cases.push(record); await saveReport();
  const context = await browser.newContext({ viewport: { width: matrix.width, height: 900 },
    colorScheme: matrix.theme, serviceWorkers: 'block' });
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
  }
}
const incoming = page => page.getByRole('dialog', { name: 'Choose the incoming process template', exact: true });
const comparison = page => page.getByRole('dialog', { name: 'Does this structure handoff match what you expect?', exact: true });
async function comparisonKeyboard(page, record, originalCompare) {
  const dialog = comparison(page), cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  await visible(dialog);
  await page.waitForFunction(element => document.activeElement === element, await cancel.elementHandle());
  for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    assert(await dialog.evaluate(element => element.contains(document.activeElement)), 'Modal keyboard focus escaped');
  }
  // Cancelling a review must return to the same unsaved template choice; no
  // accepted API write occurs until the final explicit confirmation below.
  assert(await originalCompare.evaluate(element => element.isConnected), 'The original Incoming Compare must survive structure review.');
  await page.keyboard.press('Escape'); await absent(dialog); await visible(incoming(page));
  // Observe the original owner before any explicit reopen or focus action.
  await page.waitForFunction(element => element.isConnected && document.activeElement === element, originalCompare);
  assert(await incoming(page).evaluate((dialog, original) => dialog.contains(original), originalCompare));
  const compare = incoming(page).getByRole('button', { name: 'Compare structures', exact: true });
  assert(await compare.evaluate((element, original) => element === original, originalCompare));
  await enabled(compare); await compare.click(); await visible(comparison(page));
  await noDocumentOverflow(page, record.assertions, 'structure-comparison', record.theme);
  record.assertions.push({ keyboardFocusContained: true, escapeReturnedToIncomingChoice: true, naturalEscapeFocusReturnedToSameConnectedCompare: true });
}
async function openIncoming(page, mode) {
  await enabled(page.getByRole('button', { name: mode === 'start' ? 'Start run' : 'Run actions', exact: true }));
  await page.getByRole('button', { name: mode === 'start' ? 'Start run' : 'Run actions', exact: true }).click();
  await page.getByRole('menuitem', { name: mode === 'start' ? /^Start first process/ : /^Update future plan/ }).click();
  await visible(incoming(page));
}
async function waitAccepted(page, path, button, status) {
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api${path}`
    && response.request().method() === 'POST');
  await enabled(button); await button.click();
  const response = await responsePromise; assert.equal(response.status(), status);
  return response.json();
}

// Native read-only controls for the independent two-case eight-Sample scope.
async function keyboardActivate(page, button) {
  await enabled(button); await button.focus();
  assert(await button.evaluate(element => document.activeElement === element));
  await page.keyboard.press('Enter');
}
async function modalTabCycle(page, dialog) {
  const candidates = await dialog.locator('button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]').elementHandles();
  const tabbables = [];
  for (const handle of candidates) if (await handle.evaluate(element => element.isConnected && !element.matches(':disabled')
    && element.tabIndex >= 0 && !element.closest('[inert], [hidden]') && element.getClientRects().length > 0
    && getComputedStyle(element).visibility === 'visible')) tabbables.push(handle);
  assert(tabbables.length > 0 && tabbables.length <= 12, 'Bound the actual idle overlay keyboard cycle.');
  let index = -1;
  for (let position = 0; position < tabbables.length; position++)
    if (await tabbables[position].evaluate(element => document.activeElement === element)) index = position;
  assert(index >= 0, 'Natural initial focus must belong to the actual overlay.');
  const initialIndex = index;
  for (const [key, direction] of [['Tab', 1], ['Shift+Tab', -1]]) {
    for (let press = 0; press <= tabbables.length; press++) {
      index = (index + direction + tabbables.length) % tabbables.length;
      await page.keyboard.press(key);
      await page.waitForFunction(element => document.activeElement === element, tabbables[index]);
      assert(await dialog.evaluate(element => element.contains(document.activeElement)), 'Idle overlay focus escaped.');
    }
  }
  assert.equal(index, initialIndex);
  return { actualTabbableCount: tabbables.length, nativeTabAndShiftTabBoundaryWraps: true };
}
async function returnedToOriginal(page, original) {
  await page.waitForFunction(element => element.isConnected && document.activeElement === element, original);
  assert(await original.evaluate(element => element.isConnected && !element.disabled));
}
async function settledColumnScroll(scroller) {
  return scroller.evaluate(element => new Promise((resolve, reject) => {
    let previous, frames = 0, frame;
    const timer = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error('Native Sample-column scrolling did not settle within 20s.')); }, 20000);
    const observe = () => {
      if (!element.isConnected) { clearTimeout(timer); reject(new Error('Sample-column scroller was removed.')); return; }
      const left = element.scrollLeft;
      frames = previous !== undefined && Math.abs(left - previous) < 0.01 ? frames + 1 : 0;
      previous = left;
      if (frames >= 4) { clearTimeout(timer); resolve(left); return; }
      frame = requestAnimationFrame(observe);
    };
    frame = requestAnimationFrame(observe);
  }));
}
async function nativeColumnEdge(page, scroller, direction) {
  const button = page.getByRole('button', { name: `Scroll sample columns ${direction}`, exact: true });
  await visible(button);
  const positions = [await settledColumnScroll(scroller)];
  for (let press = 0; press < 16 && await button.isEnabled(); press++) {
    const previous = positions.at(-1);
    await keyboardActivate(page, button);
    await page.waitForFunction(({ element, previous }) => Math.abs(element.scrollLeft - previous) > 1,
      { element: await scroller.elementHandle(), previous });
    const current = await settledColumnScroll(scroller);
    assert(direction === 'right' ? current > previous : current < previous, 'Native column control must move in its declared direction.');
    positions.push(current);
  }
  assert.equal(await button.isEnabled(), false, 'Finite native scrolling must reach the requested edge.');
  return positions;
}
async function idleMetrologyKeyboard(page, record, row, scroller, columnIndex, owner) {
  const trigger = row.locator('.sample-step-cell').nth(columnIndex).getByRole('button', { name: 'Add after this entry', exact: true });
  await enabled(trigger);
  const reach = await trigger.evaluate((element, scroller) => {
    const bounds = element.getBoundingClientRect(), clip = scroller.getBoundingClientRect();
    const recipe = scroller.querySelector('.recipe-column').getBoundingClientRect();
    return { triggerLeft: bounds.left, triggerRight: bounds.right, visibleLeft: Math.max(clip.left, recipe.right), visibleRight: clip.right,
      internalScrollLeft: scroller.scrollLeft };
  }, await scroller.elementHandle());
  assert(reach.triggerLeft >= reach.visibleLeft - 2 && reach.triggerRight <= reach.visibleRight + 2,
    'The actual original trigger must be reachable after native internal scrolling.');
  const original = await trigger.elementHandle(), dismissals = [];
  for (const dismissal of ['Escape', 'Close']) {
    await keyboardActivate(page, trigger);
    await keyboardActivate(page, row.locator('.sample-step-cell').nth(columnIndex).locator('.add-action-panel')
      .getByRole('button', { name: 'Metrology', exact: true }));
    const dialog = page.getByRole('dialog', { name: 'Add metrology', exact: true });
    await visible(dialog);
    const search = dialog.getByRole('textbox', { name: 'Search templates', exact: true });
    await page.waitForFunction(element => document.activeElement === element, await search.elementHandle());
    await visible(dialog.getByRole('button').filter({ has: page.getByText(`5F synthetic SEM ${fixture.prefix}`, { exact: true }) }));
    assert.equal(await dialog.locator('.dialog-kicker').textContent(), owner.code);
    const cycle = await modalTabCycle(page, dialog);
    await noDocumentOverflow(page, record.assertions, `sample-${columnIndex + 1}-idle-metrology-${dismissal}`, record.theme);
    if (dismissal === 'Escape') await page.keyboard.press('Escape');
    else await keyboardActivate(page, dialog.getByRole('button', { name: 'Close', exact: true }));
    await absent(dialog); await returnedToOriginal(page, original);
    dismissals.push({ dismissal, ...cycle, naturalSearchFocus: true, originalConnectedAddTriggerRestored: true });
  }
  record.assertions.push({ sampleId: owner.sampleId, runId: owner.runId, column: columnIndex + 1, reach, idleMetrologyDismissals: dismissals });
}
async function readOnlyProcessDetailsKeyboard(page, record, row, step) {
  const title = step.plannedTitle || step.title;
  const trigger = row.getByRole('button', { name: `View process-step details for ${title}`, exact: true });
  const original = await trigger.elementHandle(), dismissals = [];
  for (const dismissal of ['Escape', 'Close']) {
    await keyboardActivate(page, trigger);
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await visible(dialog);
    const close = dialog.getByRole('button', { name: 'Close process-step details', exact: true });
    await page.waitForFunction(element => document.activeElement === element, await close.elementHandle());
    if (step.plannedParametersText) await visible(dialog.getByText(step.plannedParametersText, { exact: true }));
    if (step.plannedCommentsText) await visible(dialog.getByText(step.plannedCommentsText, { exact: true }));
    const cycle = await modalTabCycle(page, dialog);
    await noDocumentOverflow(page, record.assertions, `shared-process-details-${dismissal}`, record.theme);
    if (dismissal === 'Escape') await page.keyboard.press('Escape');
    else await keyboardActivate(page, close);
    await absent(dialog); await returnedToOriginal(page, original);
    dismissals.push({ dismissal, ...cycle, naturalCloseFocus: true, originalConnectedDetailsTriggerRestored: true });
  }
  record.assertions.push({ sharedReadOnlyProcessStepTitle: title, processDetailsDismissals: dismissals });
}

try {
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  if (compareEscape) await executeCase(compareEscapeCaseId, { width: 1200, theme: 'light' }, async (page, record) => {
    const owner = seed.cases.find(item => item.width === 1200 && item.theme === 'light').start;
    const before = await actualApi(`/samples/${owner.sampleId}`); assert.equal(before.runs.length, 0);
    const previewPath = `/api/samples/${owner.sampleId}/runs/preview`, nativePostRequests = [];
    page.on('request', request => {
      const target = new URL(request.url());
      if (target.origin === base.origin && target.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method()))
        nativePostRequests.push({ path: target.pathname, method: request.method() });
    });
    await page.goto(new URL(`/processing/${owner.sampleId}`, base).href);
    await visible(page.getByRole('heading', { name: before.title, exact: true }));
    await openIncoming(page, 'start');
    const search = incoming(page).getByRole('textbox', { name: 'Search process families', exact: true });
    await page.waitForFunction(element => document.activeElement === element, await search.elementHandle());
    const family = incoming(page).getByRole('button').filter({ has: page.getByText(fixture.familyName, { exact: true }) });
    await visible(family); await family.click();
    const version = incoming(page).getByRole('button').filter({ has: page.getByText('Version 1', { exact: true }) });
    await visible(version); await version.click();
    const compare = incoming(page).getByRole('button', { name: 'Compare structures', exact: true });
    await enabled(compare);
    const originalCompare = await compare.elementHandle(), originalIncoming = await incoming(page).elementHandle();
    // Reach the actual Compare trigger through native Tab; never repair focus
    // with focus(), click(), or a replacement element after Escape.
    for (let press = 0; press < 12 && !(await originalCompare.evaluate(element => document.activeElement === element)); press++)
      await page.keyboard.press('Tab');
    assert(await originalCompare.evaluate(element => document.activeElement === element));
    const cycles = [];
    for (let cycle = 0; cycle < 2; cycle++) {
      const acceptedPreview = page.waitForResponse(response => new URL(response.url()).origin === base.origin
        && new URL(response.url()).pathname === previewPath && response.request().method() === 'POST');
      await page.keyboard.press('Enter');
      const response = await acceptedPreview; assert.equal(response.status(), 200);
      const preview = await bounded(response.json(), BODY_OBSERVATION_TIMEOUT_MS, 'Actual comparison preview JSON');
      assert.equal(preview.canConfirm, true); assert.equal(preview.template.id, fixture.ids.v1);
      const dialog = comparison(page); await visible(dialog);
      const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
      await page.waitForFunction(element => document.activeElement === element, await cancel.elementHandle());
      assert(await originalCompare.evaluate(element => element.isConnected), 'Original Incoming Compare must remain connected during review.');
      assert(await originalIncoming.evaluate(element => element.isConnected && element.parentElement.hidden
        && getComputedStyle(element.parentElement).display === 'none'), 'Incoming must be retained but hidden during review.');
      assert.equal(await page.getByRole('dialog').count(), 1, 'Only comparison may be exposed during review.');
      await noDocumentOverflow(page, record.assertions, `process-comparison-${cycle + 1}`, record.theme);
      await page.keyboard.press('Escape'); await absent(dialog); await visible(incoming(page));
      // This is the decisive natural return observation. Do not focus or click.
      await page.waitForFunction(element => element.isConnected && document.activeElement === element, originalCompare);
      assert(await originalIncoming.evaluate(element => element.isConnected && !element.parentElement.hidden));
      assert.equal(await version.getAttribute('aria-pressed'), 'true');
      cycles.push({ actualPreviewStatus: 200, incomingTemplateVersionId: preview.template.id,
        originalIncomingStayedConnectedAndHidden: true, comparisonNaturalCancelFocus: true,
        escapeNaturallyRestoredSameConnectedCompare: true, selectedIncomingVersionRetained: true });
    }
    await page.keyboard.press('Escape'); await absent(incoming(page));
    await openIncoming(page, 'start');
    const reopenedSearch = incoming(page).getByRole('textbox', { name: 'Search process families', exact: true });
    await page.waitForFunction(element => document.activeElement === element, await reopenedSearch.elementHandle());
    assert.equal(await reopenedSearch.inputValue(), '');
    await page.keyboard.press('Escape'); await absent(incoming(page));
    const after = await actualApi(`/samples/${owner.sampleId}`);
    assert.deepEqual(after, before, 'Compare/Escape must retain the complete original Sample and empty Run history.');
    assert.deepEqual(nativePostRequests, [{ path: previewPath, method: 'POST' }, { path: previewPath, method: 'POST' }],
      'Only the two legitimate previews may use POST; no domain mutation may occur.');
    assert.equal(record.api.filter(item => item.path === previewPath && item.method === 'POST' && item.status === 200).length, 2);
    await noDocumentOverflow(page, record.assertions, 'process-compare-escape-return', record.theme);
    record.assertions.push({ sampleId: owner.sampleId, originalRunCount: 0, unchangedCompleteSampleHistory: true,
      cycles, reopenedTransitionNaturalSearchFocus: true, legitimatePreviewPostCount: 2, nativeDomainMutations: 0,
      scope: 'One 1200/light native Compare/Escape case only; no full twenty-case matrix or whole-5F completion claim.' });
  });
  if (eightSamples) for (const matrix of eightSampleCases) await executeCase(matrix.id, matrix, async (page, record) => {
    const before = await Promise.all(seed.mixed.map(owner => actualApi(`/samples/${owner.sampleId}`)));
    for (const [index, owner] of seed.mixed.entries()) {
      assert.equal(before[index].id, owner.sampleId); assert.equal(before[index].code, owner.code);
      assert.equal(before[index].runs.length, 1);
      const run = before[index].runs.find(run => run.id === owner.runId);
      assert(run && run.currentPlanRevisionId === owner.initialPlanRevisionId);
      assert(run.steps.some(step => step.id === owner.firstStepId));
    }
    const first = seed.mixed[0], firstRun = before[0].runs.find(run => run.id === first.runId);
    const firstStep = firstRun.steps.find(step => step.id === first.firstStepId), nativeExecutionWrites = [];
    page.on('request', request => {
      const target = new URL(request.url());
      if (target.origin === base.origin && (target.pathname.startsWith('/api/samples') || target.pathname.startsWith('/api/metrology-templates'))
        && !['GET', 'HEAD'].includes(request.method())) nativeExecutionWrites.push({ path: target.pathname, method: request.method() });
    });
    await page.goto(new URL(`/processing/${first.sampleId}?run=${encodeURIComponent(first.runId)}`, base).href);
    await visible(page.getByRole('heading', { name: before[0].title, exact: true }));
    for (const owner of seed.mixed.slice(1)) {
      await keyboardActivate(page, page.getByRole('button', { name: '+ Add sample', exact: true }));
      await page.getByPlaceholder('Search matching samples…').fill(owner.code);
      const option = page.locator('#sample-picker-popover').getByRole('button').filter({ has: page.getByText(owner.code, { exact: true }) });
      await keyboardActivate(page, option);
      await page.waitForFunction(code => [...document.querySelectorAll('.visible-sample small')].some(element => element.textContent === code), owner.code);
    }
    const location = new URL(page.url());
    assert.equal(location.pathname, `/processing/${first.sampleId}`); assert.equal(location.searchParams.get('run'), first.runId);
    assert.deepEqual(location.searchParams.get('with').split(','), seed.mixed.slice(1).map(owner => owner.sampleId));
    assert.deepEqual(await page.locator('.visible-sample small').allTextContents(), seed.mixed.map(owner => owner.code));
    assert.equal(await page.getByRole('button', { name: '+ Add sample', exact: true }).isEnabled(), false);
    const scroller = page.locator('.run-grid-scroll'); await visible(scroller);
    await page.waitForFunction(element => element.querySelectorAll('.sample-column-header').length === 8, await scroller.elementHandle());
    assert.deepEqual(await scroller.locator('.sample-column-header small').allTextContents(), seed.mixed.map(owner => owner.code));
    assert(await scroller.evaluate(element => element.scrollWidth > element.clientWidth + 2));
    const row = scroller.locator('.run-grid-row').filter({ has: page.locator(`.recipe-details-trigger[aria-label="View process-step details for ${firstStep.plannedTitle || firstStep.title}"]`) });
    assert.equal(await row.count(), 1); assert.equal(await row.locator('.sample-step-cell').count(), 8);
    const firstEdge = await nativeColumnEdge(page, scroller, 'left');
    await idleMetrologyKeyboard(page, record, row, scroller, 0, first);
    const eighthEdge = await nativeColumnEdge(page, scroller, 'right');
    assert(eighthEdge.length > 1, 'The eighth column must be reached through actual right-scroll controls.');
    await idleMetrologyKeyboard(page, record, row, scroller, 7, seed.mixed[7]);
    const returnedFirstEdge = await nativeColumnEdge(page, scroller, 'left');
    assert(returnedFirstEdge.length > 1, 'The first column must be reached again through actual left-scroll controls.');
    if (matrix.width === 720) await readOnlyProcessDetailsKeyboard(page, record, row, firstStep);
    await noDocumentOverflow(page, record.assertions, 'eight-sample-processing', record.theme);
    const after = await Promise.all(seed.mixed.map(owner => actualApi(`/samples/${owner.sampleId}`)));
    assert.deepEqual(after, before, 'All eight original Sample/Run/Step/history snapshots must remain unchanged.');
    assert.deepEqual(nativeExecutionWrites, [], 'Idle keyboard overlays must send zero execution or metrology-template writes.');
    for (const owner of seed.mixed) assert(record.api.some(item => item.method === 'GET' && item.status === 200
      && item.path.split('?')[0] === `/api/samples/${owner.sampleId}`), 'Each visible Sample must be read by the actual built UI.');
    record.assertions.push({ visibleSampleIds: seed.mixed.map(owner => owner.sampleId), originalRunIds: seed.mixed.map(owner => owner.runId),
      originalFirstStepIds: seed.mixed.map(owner => owner.firstStepId), firstEdge, eighthEdge, returnedFirstEdge,
      actualInternalEightColumnOverflow: true, unchangedEightSampleRunStepHistory: true, nativeExecutionWrites: 0,
      scope: 'Only this native keyboard/idle-overlay case; no execution mutation, full 20-case matrix, device, or whole-5F completion claim.' });
  });
  if (seed.project.large) await executeCase(nativeLargeProjectCaseId, { width: 1200, theme: 'light' }, async (page, record) => {
    const projectPath = `/projects/${seed.project.projectId}`, before = await actualApi(projectPath), pins = seed.project.large;
    const originalSeedGet = seed.trace.findLast(item => item.path === projectPath && item.method === 'GET');
    assert(originalSeedGet && originalSeedGet.status === 200 && originalSeedGet.outcome === 'response_accepted');
    assert(/^[a-f0-9]{64}$/.test(originalSeedGet.responseSha256));
    const nativeProjectBodies = [], nativeProjectCaptures = [];
    record.assertions.push({ originalPreparedProjectBodySha256: originalSeedGet.responseSha256, originalNativeProjectBodies: nativeProjectBodies });
    const captureProjectBody = response => {
      if (new URL(response.url()).origin !== base.origin || new URL(response.url()).pathname !== `/api${projectPath}`
        || response.request().method() !== 'GET') return;
      const item = { status: response.status(), body: 'pending' }; nativeProjectBodies.push(item);
      const work = (async () => {
        try {
          const bytes = Buffer.from(await bounded(response.body(), BODY_OBSERVATION_TIMEOUT_MS, `Original native ${pins.nodeCount}-node Project Response.body`));
          item.body = 'complete'; item.byteSize = bytes.length; item.sha256 = sha(bytes);
          assert.equal(item.status, 200); assert(bytes.length > 0 && bytes.length < 2097152);
          assert.equal(item.sha256, originalSeedGet.responseSha256, 'Original native Project bytes must match the original prepared API body.');
        } catch (error) { item.captureError = error.message; throw error; }
      })();
      nativeProjectCaptures.push(work); void work.catch(() => {});
    };
    page.on('response', captureProjectBody);
    try {
      const nativeProjectWrites = [];
      page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if ((pins.nodeCount === 250 ? path.startsWith('/api/') : path.startsWith('/api/projects') || path === '/api/project-assets')
          && !['GET', 'HEAD'].includes(request.method()))
          nativeProjectWrites.push({ path, method: request.method() });
      });
      assert.equal(before.project.revision, pins.revision);
      assert.deepEqual(before.items.map(item => item.id).sort(), pins.itemIds);
      assert.deepEqual(before.placements.map(item => item.id).sort(), pins.placementIds);
      assert.equal(before.edges.length, pins.edgeCount);
      if (pins.nodeCount === 250) assert.deepEqual(before.edges.map(edge => edge.id).sort(), pins.edgeIds);
      await page.goto(new URL(projectPath, base).href);
      await visible(page.getByRole('heading', { name: `5F mixed Project ${fixture.prefix}`, exact: true }));
      const canvas = page.getByTestId('project-flow-canvas'), viewport = canvas.locator('.react-flow__viewport');
      await visible(canvas);
      await page.waitForFunction(element => element.dataset.projectMapDetail === 'overview', await canvas.elementHandle());
      assert.equal(await canvas.getAttribute('data-project-map-scale'), 'target');
      assert.equal(await canvas.getAttribute('data-project-map-culling'), 'visible-elements');
      assert.equal(await canvas.getAttribute('data-project-map-node-count'), String(pins.nodeCount));
      if (pins.nodeCount === 250) {
        assert.equal(await canvas.getAttribute('data-project-map-edge-count'), '400');
        await page.waitForFunction(element => element.querySelectorAll('.react-flow__node-projectItem').length === 250
          && element.querySelectorAll('.react-flow__edge').length === 400, await canvas.elementHandle());
      }
      const viewportState = () => viewport.evaluate(element => new Promise((resolve, reject) => {
        let previous, stableFrames = 0, frame;
        const timer = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error('Native viewport did not settle within 20s.')); }, 20000);
        const observe = () => {
          if (!element.isConnected) { clearTimeout(timer); reject(new Error('Native viewport was removed before observation completed.')); return; }
          const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
          const value = { x: matrix.e, y: matrix.f, zoom: matrix.a };
          stableFrames = previous && ['x', 'y', 'zoom'].every(key => Math.abs(value[key] - previous[key]) < 0.000001) ? stableFrames + 1 : 0;
          previous = value;
          if (stableFrames >= 3) { clearTimeout(timer); resolve(value); return; }
          frame = requestAnimationFrame(observe);
        };
        frame = requestAnimationFrame(observe);
      }));
      const initialViewport = await viewportState(), zoomIn = canvas.locator('.react-flow__controls-zoomin');
      for (let index = 0; index < 14 && await canvas.getAttribute('data-project-map-detail') !== 'full'; index++) {
        const previous = await viewportState(); await zoomIn.click();
        await page.waitForFunction(({ element, zoom }) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a >= zoom * 1.19,
          { element: await viewport.elementHandle(), zoom: previous.zoom });
      }
      assert.equal(await canvas.getAttribute('data-project-map-detail'), 'full');
      const fullViewport = await viewportState(); assert(fullViewport.zoom > initialViewport.zoom);
      await page.waitForFunction(element => {
        const count = element.querySelectorAll('.react-flow__node-projectItem').length;
        return count > 0 && count < Number(element.dataset.projectMapNodeCount);
      }, await canvas.elementHandle());
      const renderedCount = await canvas.locator('.react-flow__node-projectItem').count();
      assert(renderedCount > 0 && renderedCount < pins.nodeCount, 'Full-detail native zoom must exercise actual visible-element culling.');
      const panPoint = await canvas.evaluate(element => {
        const rect = element.getBoundingClientRect();
        for (let y = rect.top + 30; y < rect.bottom - 80; y += 20) for (let x = rect.left + 30; x < rect.right - 160; x += 20) {
          if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
        }
        return null;
      });
      assert(panPoint, 'A genuine pane point must be available for native panning.');
      await page.mouse.move(panPoint.x, panPoint.y); await page.mouse.down();
      await page.mouse.move(panPoint.x + 100, panPoint.y + 40, { steps: 12 }); await page.mouse.up();
      await page.waitForFunction(({ element, x }) => Math.abs(new DOMMatrixReadOnly(getComputedStyle(element).transform).e - x) > 50,
        { element: await viewport.elementHandle(), x: fullViewport.x });
      const pannedViewport = await viewportState(); assert(Math.abs(pannedViewport.zoom - fullViewport.zoom) < 0.001);
      const visibleNode = await canvas.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        for (const node of element.querySelectorAll('.react-flow__node-projectItem')) {
          const rect = node.getBoundingClientRect(), header = node.querySelector('.project-node-drag-handle')?.getBoundingClientRect();
          if (!header) continue;
          const x = header.left + header.width / 2, y = header.top + header.height / 2;
          if (rect.left > bounds.left + 10 && rect.right < bounds.right - 10 && rect.top > bounds.top + 60 && rect.bottom < bounds.bottom - 10
            && document.elementFromPoint(x, y)?.closest('.react-flow__node') === node) return { id: node.dataset.id, x, y };
        }
        return null;
      });
      assert(visibleNode && pins.itemIds.includes(visibleNode.id), 'Native selection must target an actual visible API-owned node.');
      await page.mouse.click(visibleNode.x, visibleNode.y);
      await page.waitForFunction(id => document.querySelector(`.react-flow__node[data-id="${id}"]`)?.classList.contains('selected'), visibleNode.id);
      const inspectorTrigger = await page.getByRole('button', { name: 'Inspector', exact: true }).elementHandle();
      const mapDetails = page.getByRole('toolbar', { name: 'Selected card actions', exact: true }).getByRole('button', { name: 'Details', exact: true });
      await enabled(mapDetails); await mapDetails.focus(); await page.keyboard.press('Enter');
      const inspector = page.locator('#project-inspector-panel'); await visible(inspector);
      await page.waitForFunction(element => document.activeElement === element, await inspector.elementHandle());
      if (pins.nodeCount === 250) {
        const incident = before.edges.filter(edge => edge.sourceItemId === visibleNode.id || edge.targetItemId === visibleNode.id);
        assert(incident.length > 0); await visible(inspector.getByRole('heading', { name: 'Relationships', exact: true }));
        assert.equal(await inspector.locator('.project-inspector-relationships li').count(), incident.length);
        record.assertions.push({ nativeSelectedItemId: visibleNode.id, actualIncidentRelationshipCount: incident.length });
      }
      await page.keyboard.press('Escape'); await absent(inspector);
      await page.waitForFunction(element => element.isConnected && document.activeElement === element, inspectorTrigger);
      const selectedViewport = await viewportState(); await canvas.locator('.react-flow__controls-zoomout').click();
      await page.waitForFunction(({ element, zoom }) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a <= zoom / 1.19,
        { element: await viewport.elementHandle(), zoom: selectedViewport.zoom });
      const zoomedOutViewport = await viewportState(), fitView = canvas.locator('.react-flow__controls-fitview');
      await fitView.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(element => element.dataset.projectMapDetail === 'overview', await canvas.elementHandle());
      const refittedViewport = await viewportState(); assert(refittedViewport.zoom < zoomedOutViewport.zoom);
      assert(await fitView.evaluate(element => document.activeElement === element));
      const readingControl = page.getByRole('button', { name: 'Reading', exact: true });
      await readingControl.focus(); const originalReadingControl = await readingControl.elementHandle(); await page.keyboard.press('Enter');
      const reading = page.getByRole('region', { name: 'Project Reading', exact: true }); await visible(reading);
      assert(await originalReadingControl.evaluate(element => document.activeElement === element), 'A projection switch must retain its native control focus.');
      assert.deepEqual((await reading.locator('[data-project-item-id]').evaluateAll(elements => elements.map(element => element.dataset.projectItemId))).sort(), pins.itemIds);
      const readingDetails = reading.locator(`[data-project-details-trigger="${visibleNode.id}"]`);
      await readingDetails.scrollIntoViewIfNeeded(); await readingDetails.focus(); const originalReadingDetails = await readingDetails.elementHandle();
      await page.keyboard.press('Enter'); await visible(inspector);
      await page.waitForFunction(element => document.activeElement === element, await inspector.elementHandle());
      await page.keyboard.press('Escape'); await absent(inspector);
      await page.waitForFunction(element => element.isConnected && document.activeElement === element, originalReadingDetails);
      if (pins.nodeCount === 250) {
        const referenceDetails = [];
        for (const [itemId, type, sourceId] of [[pins.originalMixedItemIds[1], 'sample', seed.mixed[0].sampleId],
          [pins.originalMixedItemIds[2], 'run_step', seed.mixed[0].firstStepId]]) {
          const trigger = reading.locator(`[data-project-details-trigger="${itemId}"]`);
          await trigger.scrollIntoViewIfNeeded(); await trigger.focus(); const originalTrigger = await trigger.elementHandle();
          await page.keyboard.press('Enter'); await visible(inspector);
          await page.waitForFunction(element => document.activeElement === element, await inspector.elementHandle());
          const disclosure = inspector.locator('.project-inspector-technical-details');
          if (!(await disclosure.evaluate(element => element.open))) {
            await disclosure.locator('summary').focus(); await page.keyboard.press('Enter');
          }
          await visible(inspector.getByText(`${type}:${sourceId}`, { exact: true }));
          const reference = before.references.find(reference => reference.resolution.target.type === type && reference.resolution.target.id === sourceId);
          assert(reference?.resolution.destination.openSourceUrl);
          assert.equal(await inspector.getByRole('link', { name: 'Open exact source', exact: true }).getAttribute('href'), reference.resolution.destination.openSourceUrl);
          assert.equal(await inspector.locator('.project-inspector-relationships li').count(),
            before.edges.filter(edge => edge.sourceItemId === itemId || edge.targetItemId === itemId).length);
          await page.keyboard.press('Escape'); await absent(inspector);
          await page.waitForFunction(element => element.isConnected && document.activeElement === element, originalTrigger);
          referenceDetails.push({ itemId, sourceType: type, sourceId, originalDetailsTriggerRestored: true });
        }
        // Transfers now belong to Settings. This work-surface case deliberately
        // verifies editing/cancellation and retained content instead of opening
        // the retired Reading ZIP command. Archive encoding remains covered by
        // src/lib/project-readable-export.test.ts; actual Settings downloads and
        // byte/manifest readback live in genuine-worker-package-browser.mjs and
        // browser-full-content-export.mjs, both run by recovery-browser.yml.
        assert.equal(await reading.locator('summary[aria-label="Reading options"]').count(), 0);
        assert.equal(await reading.getByRole('button', { name: /export|report|package/i, includeHidden: true }).count(), 0);
        assert.equal(await reading.getByRole('link', { name: /data package|offline report/i, includeHidden: true }).count(), 0);
        const orderedItems = [...before.items].sort((a, b) => a.createdSequence - b.createdSequence || a.id.localeCompare(b.id));
        const readingItems = reading.locator('[data-project-item-id]');
        assert.deepEqual(await readingItems.evaluateAll(elements => elements.map(element => element.dataset.projectItemId)), orderedItems.map(item => item.id));
        const expectedKinds = orderedItems.map(item => {
          if (item.itemType === 'reference') return 'Reference';
          const content = before.contents.find(content => content.id === item.projectContentId); assert(content);
          return content.contentType === 'markdown' ? 'Project Markdown' : 'Project attachment';
        });
        assert.deepEqual(await readingItems.locator(':scope > header > .meta-badge').allTextContents(), expectedKinds);
        const originalNote = orderedItems.find(item => item.id === pins.originalMixedItemIds[0]); assert(originalNote);
        const originalContent = before.contents.find(content => content.id === originalNote.projectContentId); assert(originalContent?.markdownSource);
        const note = reading.locator(`[data-project-item-id="${originalNote.id}"]`);
        const editNote = note.getByRole('button', { name: 'Edit Markdown', exact: true });
        await editNote.scrollIntoViewIfNeeded(); await editNote.focus(); await page.keyboard.press('Enter');
        const editor = note.getByRole('textbox', { name: 'Reading Markdown editor', exact: true }); await visible(editor);
        assert.equal(await editor.inputValue(), originalContent.markdownSource);
        await editor.fill(`${originalContent.markdownSource}\n\nLocal unsaved browser draft.`);
        const cancelDraft = note.getByRole('button', { name: 'Cancel', exact: true });
        await cancelDraft.focus(); await page.keyboard.press('Enter'); await absent(editor); await enabled(editNote);
        assert(!(await note.innerText()).includes('Local unsaved browser draft.'));
        const readingText = await reading.innerText();
        assert(readingText.includes('5F mixed domain record') && readingText.includes('5F large note 250'));
        const attachmentResponse = await fetch(new URL(`/api/projects/${seed.project.projectId}/contents/${seed.project.attachmentContentId}/file`, base),
          { redirect: 'error', signal: AbortSignal.timeout(BODY_OBSERVATION_TIMEOUT_MS) });
        assert.equal(attachmentResponse.status, 200);
        const attachmentBytes = Buffer.from(await bounded(attachmentResponse.arrayBuffer(), BODY_OBSERVATION_TIMEOUT_MS, 'Original Project attachment bytes'));
        assert.equal(attachmentBytes.length, seed.project.attachmentByteSize); assert.equal(sha(attachmentBytes), seed.project.attachmentSha256);
        record.assertions.push({ actualReferenceDetails: referenceDetails, focusedReading: { itemCount: 250,
          nativeCreationOrderAndKindsPreserved: true, originalMarkdownReadInEditor: true, unsavedDraftCancelled: true,
          duplicateTransferControlsAbsent: true, originalAttachmentSha256: sha(attachmentBytes) },
          separateExportCoverage: { library: 'src/lib/project-readable-export.test.ts',
            nativeSettingsPackage: 'scripts/qa/phase5f/genuine-worker-package-browser.mjs',
            nativeSettingsContentArchive: 'scripts/qa/phase5f/browser-full-content-export.mjs',
            retiredReadingZipBrowserEntry: true, executedByThisCase: false } });
      }
      const image = reading.locator(`img[src*="/contents/${seed.project.attachmentContentId}/file"]`);
      await image.scrollIntoViewIfNeeded(); await visible(image);
      await page.waitForFunction(element => element.complete && element.naturalWidth > 0, await image.elementHandle());
      await noDocumentOverflow(page, record.assertions, `project-${pins.nodeCount}-reading`, 'light');
      const sourceLinks = reading.getByRole('link', { name: 'Open source', exact: true });
      const hrefs = await sourceLinks.evaluateAll(elements => elements.map(element => element.getAttribute('href')));
      assert.equal(hrefs.length, 2); assert(hrefs.some(href => href.startsWith(`/processing/${seed.mixed[0].sampleId}`)));
      const mapControl = page.getByRole('button', { name: 'Map', exact: true }); await mapControl.focus(); await page.keyboard.press('Enter');
      await visible(canvas); assert.equal(await canvas.getAttribute('data-project-map-node-count'), String(pins.nodeCount));
      assert(await mapControl.evaluate(element => document.activeElement === element));
      await readingControl.focus(); await page.keyboard.press('Enter'); await visible(reading);
      assert(await readingControl.evaluate(element => document.activeElement === element));
      const sampleHref = hrefs.find(href => href.startsWith(`/samples/${seed.mixed[0].sampleId}`)); assert(sampleHref);
      const sourceDetail = await actualApi(`/samples/${seed.mixed[0].sampleId}`);
      const sampleLink = reading.locator(`a[href="${sampleHref}"]`); await sampleLink.scrollIntoViewIfNeeded(); await sampleLink.focus();
      await Promise.all([page.waitForURL(url => url.pathname === `/samples/${seed.mixed[0].sampleId}`), page.keyboard.press('Enter')]);
      await visible(page.getByRole('heading', { name: sourceDetail.title, exact: true }));
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await visible(page.getByRole('heading', { name: `5F mixed Project ${fixture.prefix}`, exact: true }));
      await enabled(mapControl); await mapControl.focus(); await page.keyboard.press('Enter');
      await visible(page.getByRole('region', { name: 'Project Map', exact: true }));
      assert(await mapControl.evaluate(element => document.activeElement === element));
      await noDocumentOverflow(page, record.assertions, `project-${pins.nodeCount}-map-after-native-source-back`, 'light');
      assert.deepEqual(await actualApi(projectPath), before, 'Native reading/navigation/pan/zoom must preserve every original Project value.');
      assert.equal(nativeProjectWrites.length, 0, 'No native Project write may be dispatched, including a cancelled or failed request.');
      await Promise.all(nativeProjectCaptures);
      assert(nativeProjectBodies.length > 0, 'At least one original native Project GET body must complete.');
      record.assertions.push({ nodeCount: pins.nodeCount, edgeCount: pins.edgeCount, initialViewport, fullViewport, pannedViewport, zoomedOutViewport, refittedViewport, fullDetailRenderedCount: renderedCount,
        nativeSelectedItemId: visibleNode.id, mapInspectorNaturalFocus: true, mapEscapeReturnedToOriginalInspector: true,
        nativeZoomOutAndKeyboardFitView: true, readingControlFocusRetained: true, readingDetailsNaturalFocusAndOriginalReturn: true, actualPngDecoded: true,
        nativeSourceHrefs: hrefs, keyboardSourceNavigationAndBrowserBack: true, projectSnapshotUnchanged: true, nativeProjectWrites: 0,
        scope: pins.nodeCount === 250 ? '250-node/400-relation native functional controls, original GET bytes, Reference Details/source navigation, in-page draft cancellation and original attachment bytes; no frame-rate, 500/800 envelope, device or whole-5F claim.'
          : '200-node native functional controls; no frame-rate, 500-node envelope, physical-device or whole-5F completion claim.' });
    } finally {
      page.off('response', captureProjectBody);
      await Promise.allSettled(nativeProjectCaptures);
    }
  });
  for (const matrix of seed.cases) {
    await executeCase(`start-${matrix.key}`, matrix, async (page, record) => {
      const owner = matrix.start;
      const before = await actualApi(`/samples/${owner.sampleId}`); assert.equal(before.runs.length, 0);
      await page.goto(new URL(`/processing/${owner.sampleId}`, base).href);
      await visible(page.getByRole('heading', { name: before.title, exact: true }));
      await openIncoming(page, 'start');
      const family = incoming(page).getByRole('button').filter({ has: page.getByText(fixture.familyName, { exact: true }) });
      await visible(family); await family.click();
      const version = incoming(page).getByRole('button').filter({ has: page.getByText('Version 1', { exact: true }) });
      await visible(version); await version.click();
      const compare = incoming(page).getByRole('button', { name: 'Compare structures', exact: true });
      const originalCompare = await compare.elementHandle();
      await compare.click(); await comparisonKeyboard(page, record, originalCompare);
      const started = await waitAccepted(page, `/samples/${owner.sampleId}/runs`,
        comparison(page).getByRole('button', { name: 'Confirm and start run', exact: true }), 201);
      await absent(comparison(page));
      const detail = await actualApi(`/samples/${owner.sampleId}`), run = detail.runs.find(item => item.id === started.id);
      assert.equal(detail.runs.length, 1); assert(run?.currentPlanRevisionId);
      assert.equal(run.templateVersion, 1); assert.equal(run.steps.length, 2);
      record.assertions.push({ acceptedRunId: run.id, currentPlanRevisionId: run.currentPlanRevisionId, fabricationStepCount: 2 });
      const writes = record.api.filter(item => item.method === 'POST' && item.path === `/api/samples/${owner.sampleId}/runs`);
      assert.equal(writes.length, 1, 'Exactly one accepted start write');
    });
    await executeCase(`plan-${matrix.key}`, matrix, async (page, record) => {
      const owner = matrix.plan, before = await actualApi(`/samples/${owner.sampleId}`);
      const oldRun = before.runs.find(item => item.id === owner.runId);
      assert.equal(oldRun.templateVersion, 1); assert.equal(oldRun.currentPlanRevisionId, owner.initialPlanRevisionId);
      await page.goto(new URL(`/processing/${owner.sampleId}?run=${encodeURIComponent(owner.runId)}`, base).href);
      await visible(page.getByRole('heading', { name: before.title, exact: true }));
      await openIncoming(page, 'update');
      const version = incoming(page).getByRole('button').filter({ has: page.getByText('Version 2', { exact: true }) });
      await visible(version); await version.click();
      const compare = incoming(page).getByRole('button', { name: 'Compare structures', exact: true });
      await enabled(compare); const originalCompare = await compare.elementHandle();
      await compare.click(); await comparisonKeyboard(page, record, originalCompare);
      const accepted = await waitAccepted(page, `/samples/${owner.sampleId}/runs/${owner.runId}/plan-update`,
        comparison(page).getByRole('button', { name: 'Confirm and update process', exact: true }), 200);
      await absent(comparison(page));
      const detail = await actualApi(`/samples/${owner.sampleId}`), run = detail.runs.find(item => item.id === owner.runId);
      assert.equal(detail.runs.length, before.runs.length); assert.equal(run.templateVersion, 2);
      assert(run.currentPlanRevisionId && run.currentPlanRevisionId !== owner.initialPlanRevisionId);
      assert.equal(run.planRevisionNumber, 2); assert.equal(run.steps.length, 3);
      record.assertions.push({ acceptedResponseSha256: sha(JSON.stringify(accepted)), runId: owner.runId, previousPlanRevisionId: owner.initialPlanRevisionId,
        currentPlanRevisionId: run.currentPlanRevisionId, planRevisionNumber: 2, fabricationStepCount: 3 });
      const writes = record.api.filter(item => item.method === 'POST' && item.path === `/api/samples/${owner.sampleId}/runs/${owner.runId}/plan-update`);
      assert.equal(writes.length, 1, 'Exactly one accepted plan write');
      assert(record.api.some(item => item.path.endsWith('/plan-update/preview') && item.status === 200),
        'UI must have fetched a successful actual plan preview');
    });
    await executeCase(`surfaces-${matrix.key}`, matrix, async (page, record) => {
      const first = seed.mixed[0], detail = await actualApi(`/samples/${first.sampleId}`);
      await page.goto(new URL('/samples', base).href);
      await visible(page.getByRole('heading', { name: 'Samples', exact: true }));
      await visible(page.getByText(first.code, { exact: true }).first());
      await noDocumentOverflow(page, record.assertions, 'sample-directory', record.theme);
      await page.goto(new URL(`/samples/${first.sampleId}`, base).href);
      await visible(page.getByRole('heading', { name: detail.title, exact: true }));
      await noDocumentOverflow(page, record.assertions, 'sample-overview', record.theme);
      const processLink = page.getByRole('link', { name: 'Continue processing', exact: true });
      if (await processLink.count()) { await processLink.click(); }
      else { await page.goto(new URL(`/processing/${first.sampleId}?run=${encodeURIComponent(first.runId)}`, base).href); }
      await visible(page.getByRole('heading', { name: detail.title, exact: true }));
      for (const extra of seed.mixed.slice(1)) {
        await enabled(page.getByRole('button', { name: '+ Add sample', exact: true }));
        await page.getByRole('button', { name: '+ Add sample', exact: true }).click();
        await page.getByPlaceholder('Search matching samples…').fill(extra.code);
        const option = page.locator('#sample-picker-popover').getByRole('button').filter({ has: page.getByText(extra.code, { exact: true }) });
        await visible(option); await option.click();
        await page.waitForFunction(code => [...document.querySelectorAll('.visible-sample small')].some(element => element.textContent === code), extra.code);
      }
      assert.equal(await page.locator('.visible-sample').count(), 8);
      assert(await page.getByRole('button', { name: '+ Add sample', exact: true }).isDisabled());
      await noDocumentOverflow(page, record.assertions, 'processing-eight-sample-columns', record.theme);
      await page.goto(new URL(`/samples/${first.sampleId}/timeline`, base).href);
      await visible(page.getByRole('heading', { name: detail.title, exact: true }));
      await visible(page.getByText(/5F timeline note:/).first());
      await noDocumentOverflow(page, record.assertions, 'timeline', record.theme);
      await page.goto(new URL(`/templates/metrology/${seed.metrology.templateId}`, base).href);
      await visible(page.getByRole('heading', { name: `5F synthetic SEM ${fixture.prefix}`, exact: true }));
      await noDocumentOverflow(page, record.assertions, 'metrology-template', record.theme);
      await page.goto(new URL(`/projects/${seed.project.projectId}`, base).href);
      await visible(page.getByRole('heading', { name: `5F mixed Project ${fixture.prefix}`, exact: true }));
      if (matrix.width >= 860) {
        await visible(page.getByRole('region', { name: 'Project Map', exact: true }));
        await noDocumentOverflow(page, record.assertions, 'project-map', record.theme);
        await page.getByRole('button', { name: 'Reading', exact: true }).click();
      }
      await visible(page.getByRole('region', { name: 'Project Reading', exact: true }));
      const image = page.locator(`img[src*="/contents/${seed.project.attachmentContentId}/file"]`);
      await visible(image);
      await image.scrollIntoViewIfNeeded();
      await page.waitForFunction(element => element.complete && element.naturalWidth > 0,
        await image.elementHandle(), { timeout: 20000 });
      await noDocumentOverflow(page, record.assertions, 'project-reading-real-file', record.theme);
      const sourceLinks = page.getByRole('link', { name: 'Open source', exact: true });
      assert(await sourceLinks.count() >= 2, 'Sample and RunStep retain native source links');
      const hrefs = await sourceLinks.evaluateAll(elements => elements.map(element => element.getAttribute('href')));
      assert(hrefs.some(href => href.startsWith(`/samples/${first.sampleId}`)));
      assert(hrefs.some(href => href.startsWith(`/processing/${first.sampleId}`)));
      record.assertions.push({ visibleMixedSampleCount: 8, attachmentContentId: seed.project.attachmentContentId,
        attachmentDecoded: true, nativeSourceHrefs: hrefs, theme: matrix.theme,
        projectProjection: matrix.width >= 860 ? 'Map then Reading' : 'Reading' });
      await page.goto(new URL('/settings/storage', base).href);
      await visible(page.getByRole('heading', { name: 'Storage', exact: true }));
      await noDocumentOverflow(page, record.assertions, 'settings-storage', record.theme);
      await page.goto(new URL('/settings/data', base).href);
      await visible(page.getByRole('heading', { name: 'Data', exact: true }));
      await noDocumentOverflow(page, record.assertions, 'settings-data', record.theme);
      await page.goto(new URL('/settings/data/system', base).href);
      await visible(page.getByRole('heading', { name: 'System backup and recovery', exact: true }));
      await visible(page.getByText('Sign in with a verified system administrator account to create backups or recover an installation. Saved operation identifiers remain available for reconciliation after access is restored.', { exact: true }));
      await noDocumentOverflow(page, record.assertions, 'settings-system-admin-denied', record.theme);
      const capability = await actualApi('/system-recovery/capabilities');
      assert.equal(capability.canManage, false, 'AUTH disabled must retain the actual system administrator denial');
      const protectedRead = await fetch(new URL('/api/system-recovery/jobs', base), { redirect: 'error', signal: AbortSignal.timeout(20000) });
      assert.equal(protectedRead.status, 403);
      assert(record.api.some(item => item.path === '/api/system-recovery/capabilities' && item.status === 200));
      record.assertions.push({ systemAdministratorCapability: false, protectedRecoveryReadStatus: 403, remoteAccessQualified: false });
    });
  }
  for (const status of [404, 503]) await executeCase(`chunk-${status}-explicit-reload`, { width: 1200, theme: 'dark' }, async (page, record) => {
    const destination = new URL(`/projects/${seed.project.projectId}?qualification=chunk-${status}#same-location`, base).href;
    let faultCount = 0, documentNavigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) documentNavigations++; });
    const faultPattern = `**/assets/${projectChunk}`;
    const fault = async route => { faultCount++; await route.fulfill({ status, contentType: 'text/javascript', body: '// Controlled single-route-chunk delivery failure.' }); };
    await page.route(faultPattern, fault);
    await page.goto(destination);
    await visible(page.getByRole('heading', { name: 'This page could not be loaded', exact: true }));
    const fallbackTheme = await page.evaluate(() => document.documentElement.dataset.theme);
    assert.equal(fallbackTheme, record.theme);
    assert.equal(page.url(), destination); assert.equal(faultCount, 1);
    await visible(page.getByRole('navigation', { name: 'Primary navigation', exact: true }));
    const navigationsBeforeExplicitAction = documentNavigations;
    // A bounded observer window verifies no reload happened by itself. No
    // unbounded waiting and no claim about offline delivery or remote Access.
    await page.waitForTimeout(750);
    assert.equal(documentNavigations, navigationsBeforeExplicitAction);
    assert.equal(faultCount, 1);
    await page.unroute(faultPattern, fault);
    const reload = page.getByRole('button', { name: 'Reload page', exact: true });
    await reload.focus();
    assert(await reload.evaluate(element => document.activeElement === element));
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.keyboard.press('Enter')]);
    await visible(page.getByRole('heading', { name: `5F mixed Project ${fixture.prefix}`, exact: true }));
    const recoveredTheme = await page.evaluate(() => document.documentElement.dataset.theme);
    assert.equal(recoveredTheme, record.theme);
    assert.equal(page.url(), destination);
    assert.equal(documentNavigations, navigationsBeforeExplicitAction + 1);
    const snapshot = await actualApi(`/projects/${seed.project.projectId}`);
    assert.equal(snapshot.project.id, seed.project.projectId);
    record.assertions.push({ fallbackTheme, recoveredTheme, routeChunkStatus: status, exactChunk: projectChunk, injectedFaultCount: faultCount,
      explicitKeyboardReload: true, currentUrlPreserved: true, automaticReloadsObserved: 0, observationMilliseconds: 750 });
  }, { controlledChunkFault: true });
} catch (error) {
  report.error = error.stack || error.message; process.exitCode = 1;
} finally {
  if (browser) { try { await bounded(browser.close(), CONTEXT_SHUTDOWN_TIMEOUT_MS, 'Browser shutdown'); report.browserClosed = true; } catch (error) { report.error ||= error.stack || error.message; report.cleanupError = error.message; process.exitCode = 1; } }
  const requested = selectedCase ? [selectedCase] : expectedCaseIds;
  report.requestedCaseIds = requested;
  report.passedCount = report.cases.filter(item => item.status === 'passed').length;
  report.failedCount = report.cases.filter(item => item.status !== 'passed').length;
  report.completedAt = new Date().toISOString();
  report.status = !report.error && report.failedCount === 0 && report.cases.length === requested.length ? 'passed' : 'failed';
  report.completeFiniteMatrix = !eightSamples && !compareEscape && !selectedCase && report.status === 'passed';
  await saveReport();
  await writeOnce(reportPath, report);
  const summary = { ...identities, version: 1, scope: report.scope, ...(eightSamples || compareEscape ? { browserScenario } : {}), status: report.status, completeFiniteMatrix: report.completeFiniteMatrix, selectedCase, startedAt: report.startedAt, completedAt: report.completedAt, passedCount: report.passedCount, failedCount: report.failedCount, requestedCaseIds: report.requestedCaseIds, harnessSha256: report.harnessSha256, explicitReviewedHarnessSha256: report.explicitReviewedHarnessSha256, observationPolicy: report.observationPolicy, browserClosed: report.browserClosed, serverSessionId: server.sessionId, serverReceiptSha256: serverHash, seedReceiptSha256: report.seedReceiptSha256, fixtureSqlSha256: report.fixtureSqlSha256, migrationConfigSha256: report.migrationConfigSha256, deploymentRedirectSha256: report.deploymentRedirectSha256, artifact: report.artifact, reportSha256: sha(await readFile(reportPath)), cases: report.cases.map(({ id, width, theme, status, error, assertions, api, pageErrors, unexpectedOrigins, observationSummary, contextClosed }) => ({ id, width, theme, status, error, assertions, observationSummary, contextClosed, api: api.map(({ path, method, status, responseSha256, preview, bodyObservationRequired, observationStatus, observationError }) => ({ path, method, status, responseSha256, preview, bodyObservationRequired, observationStatus, observationError })), pageErrors, unexpectedOrigins })), ...(report.error ? { error: report.error } : {}) };
  await writeOnce(summaryPath, summary);
  console.log(JSON.stringify({ status: report.status, passed: report.passedCount, failed: report.failedCount,
    completeFiniteMatrix: report.completeFiniteMatrix, reportPath }));
  if (report.status !== 'passed') process.exitCode = 1;
}
