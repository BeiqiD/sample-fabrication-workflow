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
assert.equal(sha(await readFile(new URL(import.meta.url))), isolation.trackedFiles['scripts/qa/phase5f/browser-actual-api.mjs'], 'Execute the copied/committed helper byte identity.');
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
  const response = await fetch(new URL(`/api${path}`, base), { redirect: 'error' });
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
const servedChunk = await fetch(new URL(`/assets/${projectChunk}`, base), { redirect: 'error' });
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
const expectedCaseIds = seed.cases.flatMap(item => [`start-${item.key}`, `plan-${item.key}`, `surfaces-${item.key}`]);
expectedCaseIds.push('chunk-404-explicit-reload', 'chunk-503-explicit-reload');
if (selectedCase) assert(expectedCaseIds.includes(selectedCase), 'Unknown explicit case ID.');
const report = { version: 1, scope: 'Actual local API + current built UI; synthetic isolated data. No remote Access, provider, device, or whole-roadmap completion claim.',
  ...identities, baseUrl: base.origin, prefix: fixture.prefix, serverSessionId: server.sessionId, serverReceiptSha256: serverHash,
  harnessSha256: sha(await readFile(new URL(import.meta.url))),
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
    const item = { path: target.pathname + target.search, method: response.request().method(), status: response.status() };
    record.api.push(item);
    const observation = (async () => {
      const request = response.request();
      try { item.request = request.postDataJSON(); } catch { item.request = null; }
      if (response.headers()['content-type']?.includes('application/json')) {
        try { const body = await response.body(); item.responseSha256 = sha(body); const value = JSON.parse(body); item.preview = { ...(typeof value.canConfirm === 'boolean' ? { canConfirm: value.canConfirm, blockingReason: value.blockingReason } : {}), ...(typeof value.compatible === 'boolean' ? { compatible: value.compatible } : {}), ...(value.substrateTransition ? { substrateCanConfirm: value.substrateTransition.canConfirm, substrateBlockingReason: value.substrateTransition.blockingReason } : {}) }; }
        catch { item.responseUnavailable = true; }
      }
    })(); observations.push(observation);
  });
  try {
    await action(page, record);
    await Promise.all(observations);
    assert.equal(record.unexpectedOrigins.length, 0, 'No external server traffic is part of this fixture.');
    if (!controlledChunkFault) assert.equal(record.pageErrors.length, 0, record.pageErrors.join('\n'));
    await page.screenshot({ path: resolve(output, `${id}.png`), fullPage: true });
    record.status = 'passed';
  } catch (error) {
    record.status = 'failed'; record.error = error.stack || error.message;
    await Promise.all(observations);
    await page.screenshot({ path: resolve(output, `${id}-failed.png`), fullPage: true }).catch(() => {});
  } finally {
    record.completedAt = new Date().toISOString(); await context.close(); await saveReport();
    console.log(JSON.stringify({ id, status: record.status, error: record.error?.split('\n')[0] ?? null }));
  }
}
const incoming = page => page.getByRole('dialog', { name: 'Choose the incoming process template', exact: true });
const comparison = page => page.getByRole('dialog', { name: 'Does this structure handoff match what you expect?', exact: true });
async function comparisonKeyboard(page, record) {
  const dialog = comparison(page), cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  await visible(dialog);
  await page.waitForFunction(element => document.activeElement === element, await cancel.elementHandle());
  for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    assert(await dialog.evaluate(element => element.contains(document.activeElement)), 'Modal keyboard focus escaped');
  }
  // Cancelling a review must return to the same unsaved template choice; no
  // accepted API write occurs until the final explicit confirmation below.
  await page.keyboard.press('Escape'); await absent(dialog); await visible(incoming(page));
  const compare = incoming(page).getByRole('button', { name: 'Compare structures', exact: true });
  await enabled(compare); await compare.click(); await visible(comparison(page));
  await noDocumentOverflow(page, record.assertions, 'structure-comparison', record.theme);
  record.assertions.push({ keyboardFocusContained: true, escapeReturnedToIncomingChoice: true });
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
try {
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
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
      await incoming(page).getByRole('button', { name: 'Compare structures', exact: true }).click();
      await comparisonKeyboard(page, record);
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
      await enabled(compare); await compare.click(); await comparisonKeyboard(page, record);
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
      const protectedRead = await fetch(new URL('/api/system-recovery/jobs', base), { redirect: 'error' });
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
  if (browser) { try { await browser.close(); } catch (error) { report.error ||= error.stack || error.message; process.exitCode = 1; } }
  const requested = selectedCase ? [selectedCase] : expectedCaseIds;
  report.requestedCaseIds = requested;
  report.passedCount = report.cases.filter(item => item.status === 'passed').length;
  report.failedCount = report.cases.filter(item => item.status !== 'passed').length;
  report.completedAt = new Date().toISOString();
  report.status = !report.error && report.failedCount === 0 && report.cases.length === requested.length ? 'passed' : 'failed';
  report.completeFiniteMatrix = !selectedCase && report.status === 'passed';
  await saveReport();
  await writeOnce(reportPath, report);
  const summary = { ...identities, version: 1, scope: report.scope, status: report.status, completeFiniteMatrix: report.completeFiniteMatrix, selectedCase, startedAt: report.startedAt, completedAt: report.completedAt, passedCount: report.passedCount, failedCount: report.failedCount, requestedCaseIds: report.requestedCaseIds, harnessSha256: report.harnessSha256, serverSessionId: server.sessionId, serverReceiptSha256: serverHash, seedReceiptSha256: report.seedReceiptSha256, fixtureSqlSha256: report.fixtureSqlSha256, migrationConfigSha256: report.migrationConfigSha256, deploymentRedirectSha256: report.deploymentRedirectSha256, artifact: report.artifact, reportSha256: sha(await readFile(reportPath)), cases: report.cases.map(({ id, width, theme, status, error, assertions, api, pageErrors, unexpectedOrigins }) => ({ id, width, theme, status, error, assertions, api: api.map(({ path, method, status, responseSha256, preview }) => ({ path, method, status, responseSha256, preview })), pageErrors, unexpectedOrigins })), ...(report.error ? { error: report.error } : {}) };
  await writeOnce(summaryPath, summary);
  console.log(JSON.stringify({ status: report.status, passed: report.passedCount, failed: report.failedCount,
    completeFiniteMatrix: report.completeFiniteMatrix, reportPath }));
  if (report.status !== 'passed') process.exitCode = 1;
}
