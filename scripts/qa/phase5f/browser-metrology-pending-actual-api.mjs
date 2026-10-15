// Optional actual API/browser acceptance: two bounded Metrology pending cases.
// Run exclusively against the pipeline's fresh isolated production-artifact server.
// Accepted writes remain in that private installation; no reset, delete or replay.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [baseValue, fixtureValue, isolatedValue, outputValue, ...extra] = process.argv.slice(2);
assert(baseValue && fixtureValue && isolatedValue && outputValue && extra.length === 0,
  'Usage: node browser-metrology-pending-actual-api.mjs LOOPBACK_URL FIXTURE_DIRECTORY ISOLATED_SOURCE_ROOT NEW_PRIVATE_OUTPUT');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const declaredTemp = resolve(tmpdir()), canonicalTemp = await realpath(declaredTemp);
function within(root, target) {
  const child = relative(root, target);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
function temporaryPath(value) {
  const supplied = resolve(value);
  // The OS temp root itself may be a canonical alias (for example /tmp on macOS).
  // A symlink anywhere below that root is never accepted.
  const root = within(declaredTemp, supplied) ? declaredTemp : canonicalTemp;
  assert(within(root, supplied), 'Inputs and output must be children of the OS temporary directory.');
  return resolve(canonicalTemp, relative(root, supplied));
}
async function checkedPath(root, target, type) {
  assert(within(root, target), 'A fixture path escaped its declared root.');
  let cursor = root, info;
  for (const component of relative(root, target).split(sep)) {
    cursor = resolve(cursor, component);
    info = await lstat(cursor);
    assert(!info.isSymbolicLink(), `Child symlinks are not permitted: ${cursor}`);
    if (cursor !== target) assert(info.isDirectory(), `Expected a directory: ${cursor}`);
  }
  assert(type === 'directory' ? info.isDirectory() : info.isFile(), `Expected ${type}: ${target}`);
  return info;
}
async function privateDirectory(value) {
  const directory = temporaryPath(value);
  const info = await checkedPath(canonicalTemp, directory, 'directory');
  assert.equal(info.mode & 0o777, 0o700, `A private 0700 directory is required: ${directory}`);
  if (process.getuid) assert.equal(info.uid, process.getuid(), 'Private fixture must belong to the current user.');
  return directory;
}
async function privateFile(root, name) {
  const path = resolve(root, name);
  await checkedPath(root, path, 'file');
  return readFile(path);
}
const fixtureDirectory = await privateDirectory(fixtureValue), isolatedRoot = await privateDirectory(isolatedValue);
assert.notEqual(fixtureDirectory, isolatedRoot, 'Fixture and copied source directories must be distinct.');
assert(!within(isolatedRoot, fixtureDirectory) && !within(fixtureDirectory, isolatedRoot), 'Fixture and copied source roots must not overlap.');
const output = temporaryPath(outputValue), outputParent = dirname(output);
assert(output !== isolatedRoot && !within(isolatedRoot, output), 'Acceptance output must not write into the copied source tree.');
if (outputParent !== canonicalTemp) await checkedPath(canonicalTemp, outputParent, 'directory');
// Exclusive mkdir also refuses previous attempts, including failures and symlinks.
await mkdir(output, { mode: 0o700 });
await privateDirectory(output);
const attemptId = randomUUID(), startedAt = new Date().toISOString();
const reportPath = resolve(output, 'metrology-browser-report.json');
const summaryPath = resolve(output, 'metrology-browser-summary.json');
const journalPath = resolve(output, 'metrology-browser-progress.ndjson');
await writeFile(resolve(output, 'metrology-browser-session.json'), JSON.stringify({ version: 1, attemptId,
  status: 'reserved', startedAt, harnessSha256: sha(await readFile(new URL(import.meta.url))) }, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 });
await writeFile(journalPath, '', { flag: 'wx', mode: 0o600 });
const report = { version: 2, attemptId, status: 'preparing', startedAt,
  expectedCaseIds: ['create-add-refresh-pending', 'direct-add-refresh-pending'],
  harnessSha256: sha(await readFile(new URL(import.meta.url))),
  scope: 'Two bounded actual local API/browser Metrology pending cases and the search textbox accessible name. Fresh synthetic owners; accepted writes retained. No whole accessibility, remote Access, provider, physical-device, stale-session or whole-roadmap qualification.',
  actualApi: [], cases: [], faults: [] };
async function save() {
  // Progress is append-only and contains counts/identities rather than raw bodies.
  // The detailed local report and portable summary are written once, at the end.
  await appendFile(journalPath, JSON.stringify({ at: new Date().toISOString(), attemptId, status: report.status,
    actualApiRequests: report.actualApi.length,
    cases: report.cases.map(item => ({ id: item.id, status: item.status,
      heldPhases: item.actualHeldReceipts.map(receipt => receipt.phase) })), faultCount: report.faults.length }) + '\n');
}
let fixture, seed, isolation, base, browser, serverReceiptSha256;
async function serverSession() {
  const bytes = await privateFile(fixtureDirectory, 'isolated-server-receipt.json');
  if (serverReceiptSha256) assert.equal(sha(bytes), serverReceiptSha256, 'Server readiness receipt changed during this attempt.');
  const server = JSON.parse(bytes);
  assert.equal(server.status, 'ready'); assert.equal(server.copiedState, false);
  assert.equal(server.sourceCopyRoot, isolatedRoot); assert.equal(server.fixtureDirectory, fixtureDirectory);
  assert.equal(server.sourceRoot, isolation.sourceRoot);
  assert.equal(server.sourceHead, isolation.sourceHead); assert.equal(server.sourceTree, isolation.sourceTree);
  assert.equal(server.isolationReceiptSha256, report.isolationReceiptSha256);
  assert.equal(server.fixtureManifestSha256, report.fixtureManifestSha256);
  assert.equal(server.workerSha256, report.artifact.workerSha256);
  assert.equal(server.host, '127.0.0.1'); assert.equal(server.port, 4219); assert.equal(server.authMode, 'disabled');
  assert.equal(new URL(server.baseUrl).origin, base.origin);
  assert(typeof server.sessionId === 'string' && server.sessionId.length > 0);
  assert(Number.isSafeInteger(server.sessionPid) && server.sessionPid > 0);
  const session = JSON.parse(await privateFile(fixtureDirectory, 'isolated-server-session.json'));
  assert.equal(session.sessionId, server.sessionId); assert.equal(session.sessionPid, server.sessionPid);
  if (report.serverLifecycleSessionSha256) {
    assert.equal(sha(await privateFile(fixtureDirectory, 'isolated-server-session.json')), report.serverLifecycleSessionSha256,
      'Server lifecycle session receipt changed during this attempt.');
  }
  process.kill(server.sessionPid, 0);
  const stopPath = resolve(fixtureDirectory, 'isolated-server-stop-receipt.json');
  try { await lstat(stopPath); assert.fail('This fixture has a server stop receipt; start a fresh fixture.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (report.serverSessionId) assert.equal(server.sessionId, report.serverSessionId);
  if (report.serverSessionPid) assert.equal(server.sessionPid, report.serverSessionPid);
  return { server, bytes };
}
async function actualApi(path, method = 'GET', body, expected = 200) {
  await serverSession();
  const response = await fetch(new URL(`/api${path}`, base), { method, redirect: 'error',
    signal: AbortSignal.timeout(25000), headers: { origin: base.origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const bytes = Buffer.from(await response.arrayBuffer());
  report.actualApi.push({ path, method, status: response.status, request: body ?? null,
    requestSha256: body === undefined ? null : sha(JSON.stringify(body)),
    responseSha256: sha(bytes), completedAt: new Date().toISOString() });
  await save();
  assert.equal(response.status, expected, `Actual API ${method} ${path}`);
  return JSON.parse(bytes.toString());
}
async function prepare() {
  const fixtureBytes = await privateFile(fixtureDirectory, 'process-fixture.json');
  const seedBytes = await privateFile(fixtureDirectory, 'actual-api-fixture-receipt.json');
  const isolationBytes = await privateFile(isolatedRoot, 'isolation-receipt.json');
  fixture = JSON.parse(fixtureBytes); seed = JSON.parse(seedBytes); isolation = JSON.parse(isolationBytes);
  base = new URL(baseValue);
  assert(base.protocol === 'http:' && base.hostname === '127.0.0.1' && !base.username && !base.password
    && base.pathname === '/' && !base.search && !base.hash && base.port === '4219' && fixture.loopbackPort === 4219,
  'Only the exact isolated http://127.0.0.1:4219 loopback service is permitted.');
  assert.equal(isolation.copiedState, false, 'Use a fresh synthetic installation, not an existing-state copy.');
  assert.equal(isolation.sourceCopyRoot, isolatedRoot); assert.notEqual(isolation.sourceRoot, isolatedRoot);
  assert.match(isolation.sourceHead, /^[0-9a-f]{40,64}$/); assert.match(isolation.sourceTree, /^[0-9a-f]{40,64}$/);
  assert.equal(fixture.sourceCopyRoot, isolatedRoot); assert.equal(fixture.sourceHead, isolation.sourceHead);
  assert.equal(fixture.isolationReceiptSha256, sha(isolationBytes));
  assert.match(fixture.prefix, /^phase5f-[0-9a-f]{8}-[0-9a-f]{3}$/);
  assert.deepEqual(fixture.ids, { family: `${fixture.prefix}-family`, v1: `${fixture.prefix}-v1`, v2: `${fixture.prefix}-v2` });
  assert.match(fixture.initialStateHash, /^[0-9a-f]{64}$/);
  assert.equal(fixture.sqlSha256, sha(await privateFile(fixtureDirectory, 'process-fixture.sql')));
  assert(seed.status === 'prepared' && seed.prefix === fixture.prefix && seed.baseUrl === base.origin);
  assert.deepEqual(seed.ids, fixture.ids); assert.equal(seed.familyName, fixture.familyName);
  assert(Array.isArray(seed.mixed) && Array.isArray(seed.cases));
  Object.assign(report, { sourceHead: isolation.sourceHead, sourceTree: isolation.sourceTree,
    sourceCopyRoot: isolatedRoot, fixtureDirectory, fixturePrefix: fixture.prefix, baseUrl: base.origin,
    isolationReceiptSha256: sha(isolationBytes), fixtureManifestSha256: sha(fixtureBytes), seedReceiptSha256: sha(seedBytes),
    fixtureSqlSha256: fixture.sqlSha256, sourceSha256: {}, configSha256: {} });
  const sourcePaths = ['src/App.tsx', 'src/components/MultiSampleRunGrid.tsx', 'src/components/MetrologyTemplateForm.tsx',
    'src/lib/use-modal-dialog.ts', 'src/pages/ProcessingWorkspacePage.tsx', 'src/lib/api.ts', 'src/styles.css',
    'worker/execution/routes.ts', 'worker/process-definition/routes.ts', 'scripts/production-worker-artifact.mjs',
    'scripts/qa/phase5f/browser-metrology-pending-actual-api.mjs'];
  for (const name of sourcePaths) {
    const digest = sha(await privateFile(isolatedRoot, name));
    assert.equal(digest, isolation.trackedFiles[name], `Copied source changed: ${name}`);
    report.sourceSha256[name] = digest;
  }
  assert.equal(report.harnessSha256, report.sourceSha256['scripts/qa/phase5f/browser-metrology-pending-actual-api.mjs'],
    'The running helper must match the copied committed source.');
  for (const name of ['.wrangler/deploy.jsonc', '.wrangler/deploy/config.json', '.wrangler/local-installation.json']) {
    report.configSha256[name] = sha(await privateFile(isolatedRoot, name));
  }
  const redirect = JSON.parse(await privateFile(isolatedRoot, '.wrangler/deploy/config.json'));
  const builtConfigPath = resolve(isolatedRoot, '.wrangler/deploy', redirect.configPath);
  assert(within(resolve(isolatedRoot, 'dist'), builtConfigPath));
  const builtConfigRelative = relative(isolatedRoot, builtConfigPath);
  report.configSha256[builtConfigRelative] = sha(await privateFile(isolatedRoot, builtConfigRelative));
  const { productionWorkerArtifact } = await import(pathToFileURL(resolve(isolatedRoot, 'scripts/production-worker-artifact.mjs')));
  const artifact = await productionWorkerArtifact(isolatedRoot);
  await checkedPath(isolatedRoot, artifact.scriptPath, 'file');
  await checkedPath(isolatedRoot, artifact.assets.directory, 'directory');
  const assetDirectory = resolve(artifact.assets.directory, 'assets'), assetSha256 = {};
  await checkedPath(isolatedRoot, assetDirectory, 'directory');
  const names = (await readdir(assetDirectory)).sort();
  for (const name of names) assetSha256[name] = sha(await privateFile(assetDirectory, name));
  const chunks = names.filter(name => /^ProcessingWorkspacePage-[^.]+\.js$/.test(name));
  assert.equal(chunks.length, 1, 'One exact built Processing route chunk is required.');
  report.artifact = { workerSha256: sha(await privateFile(isolatedRoot, relative(isolatedRoot, artifact.scriptPath))),
    assetSha256, processingChunk: chunks[0] };
  const { server, bytes } = await serverSession();
  serverReceiptSha256 = sha(bytes); report.serverReceiptSha256 = serverReceiptSha256;
  report.serverSessionId = server.sessionId; report.serverSessionPid = server.sessionPid;
  report.serverLifecycleSessionSha256 = sha(await privateFile(fixtureDirectory, 'isolated-server-session.json'));
  assert.equal(seed.sourceRoot, isolation.sourceRoot); assert.equal(seed.sourceCopyRoot, isolatedRoot);
  assert.equal(seed.sourceHead, isolation.sourceHead); assert.equal(seed.fixtureDirectory, fixtureDirectory);
  assert.equal(seed.isolationReceiptSha256, report.isolationReceiptSha256);
  assert.equal(seed.fixtureManifestSha256, report.fixtureManifestSha256);
  assert.equal(seed.serverReceiptSha256, serverReceiptSha256); assert.equal(seed.serverSessionId, server.sessionId);
  // Both random sentinel versions and their real Step 0 must match before writes.
  assert.equal(fixture.initialSubstrateStep?.stepNumber, '0');
  assert.equal(fixture.initialSubstrateStep?.name, 'Substrate Stack');
  for (const [id, version] of [[fixture.ids.v1, 1], [fixture.ids.v2, 2]]) {
    const { template } = await actualApi(`/templates/${id}`);
    assert.equal(template.id, id); assert.equal(template.version, version);
    assert.equal(template.name, fixture.familyName); assert.equal(template.initialStateHash, fixture.initialStateHash);
    assert.equal(template.initialSubstrateStep?.stepNumber, '0');
    assert.equal(template.initialSubstrateStep?.name, 'Substrate Stack');
    assert.deepEqual(template.initialStateImageKeys, []);
    assert.deepEqual(template.initialSubstrateStep, fixture.initialSubstrateStep);
  }
  report.actualStepZeroSentinelsMatched = true;
  const served = await fetch(new URL(`/assets/${chunks[0]}`, base), { redirect: 'error', signal: AbortSignal.timeout(25000) });
  assert.equal(served.status, 200);
  assert.equal(sha(Buffer.from(await served.arrayBuffer())), assetSha256[chunks[0]],
    'Served UI chunk differs from the selected source artifact.');
  report.artifact.servedProcessingChunkMatched = true;
  const runtimeRequire = createRequire(resolve(isolatedRoot, 'package.json'));
  let playwright;
  try { playwright = runtimeRequire('playwright'); }
  catch {
    assert(process.env.PLAYWRIGHT_MODULE_PATH, 'Set PLAYWRIGHT_MODULE_PATH to an already installed Playwright module.');
    playwright = runtimeRequire(resolve(process.env.PLAYWRIGHT_MODULE_PATH));
  }
  browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  report.status = 'running'; await save();
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  promise.catch(() => {}); // Unused phase gates must not create unhandled rejections.
  return { promise, resolve, reject };
}
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 25000);
  })]); } finally { clearTimeout(timer); }
}
function hold(name, path, method, expectedStatus) {
  return { name, path, method, expectedStatus, accepted: deferred(), release: deferred(), delivered: deferred(), calls: 0, receipt: null };
}
const suffix = randomUUID().slice(0, 8);
async function freshOwner(label) {
  const created = await actualApi('/samples', 'POST', { code: `${fixture.prefix}-${suffix}-${label}`,
    title: `5F actual Metrology ${label} ${suffix}`, description: 'Fresh isolated Metrology pending acceptance owner; never a base20owner.',
    status: 'stored', location: 'Synthetic Metrology rack' }, 201);
  assert(!seed.mixed.some(owner => owner.sampleId === created.id)
    && !seed.cases.some(item => item.start.sampleId === created.id || item.plan.sampleId === created.id));
  const preview = await actualApi(`/samples/${created.id}/runs/preview`, 'POST', { templateVersionId: fixture.ids.v1 });
  assert.equal(preview.canConfirm, true); assert.equal(preview.blockingReason, null);
  const started = await actualApi(`/samples/${created.id}/runs`, 'POST', { templateVersionId: fixture.ids.v1,
    substrateConfirmation: { confirmed: true, expectedSampleUpdatedAt: preview.sampleUpdatedAt,
      expectedPreviousStateHash: preview.sampleCurrentState.hash, expectedTemplateStructureKey: preview.comparisonTarget.key,
      expectedTemplateStateHash: preview.comparisonTarget.stateHash, expectedLatestRunId: preview.expectedLatestRunId } }, 201);
  const detail = await actualApi(`/samples/${created.id}`), run = detail.runs.find(item => item.id === started.id);
  assert.equal(detail.runs.length, 1); assert.equal(run.templateVersionId, fixture.ids.v1);
  assert(run.currentPlanRevisionId); assert.equal(run.steps.length, 2);
  assert(run.steps.every(step => step.entryKind === 'fabrication'));
  return { sampleId: created.id, code: detail.code, title: detail.title, runId: run.id,
    afterStepId: run.steps[0].id, originalFabricationStepIds: run.steps.map(step => step.id), currentPlanRevisionId: run.currentPlanRevisionId };
}
const drawer = page => page.getByRole('dialog', { name: 'Add metrology', exact: true });
async function realClickDisabled(page, locator) {
  assert(await locator.isDisabled());
  await locator.scrollIntoViewIfNeeded(); const box = await locator.boundingBox(); assert(box);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
async function outerDismissalsRemainBlocked(page, record, phase) {
  const dialog = drawer(page); assert(await dialog.isVisible());
  await page.keyboard.press('Escape'); assert(await dialog.isVisible());
  await realClickDisabled(page, dialog.getByRole('button', { name: 'Close', exact: true }));
  assert(await dialog.isVisible());
  // At this 1200px viewport the 520px drawer occupies the right side. A real
  // pointer click at x=4 hits the full-screen backdrop outside its content.
  const dialogBox = await dialog.boundingBox(); assert(dialogBox && dialogBox.x > 4);
  await page.mouse.click(4, 400); assert(await dialog.isVisible());
  record.assertions.push({ phase, realEscapeBlocked: true, realDisabledCloseBlocked: true, realBackdropBlocked: true });
}
async function createBusy(page, record, phase, draft) {
  const dialog = drawer(page);
  const inputs = [['Template title', draft.name], [/^Tool/, draft.toolName], [/^Parameters/, draft.parametersText], [/^Comments/, draft.commentsText]];
  for (const [label, value] of inputs) {
    const field = dialog.getByLabel(label); assert(await field.isDisabled()); assert.equal(await field.inputValue(), value);
  }
  assert.equal(await dialog.getByRole('textbox', { name: 'Search templates', exact: true }).count(), 0);
  assert.equal(await dialog.locator('.metrology-picker-list button').count(), 0);
  assert.equal(await dialog.getByRole('button', { name: 'Create new metrology template', exact: true }).count(), 0);
  await realClickDisabled(page, dialog.getByRole('button', { name: 'Cancel', exact: true }));
  await realClickDisabled(page, dialog.getByRole('button', { name: 'Saving…', exact: true }));
  await outerDismissalsRemainBlocked(page, record, phase);
  record.assertions.push({ phase, submittedDraftRetained: true, formFieldsDisabled: true,
    duplicateSubmitAndCancelDisabled: true, pickerSearchAndSelectionUnavailableInCreateForm: true });
}
async function pickerBusy(page, record, phase) {
  const dialog = drawer(page);
  assert(await dialog.getByRole('textbox', { name: 'Search templates', exact: true }).isDisabled());
  const buttons = dialog.locator('.metrology-picker-list button'); assert(await buttons.count() > 0);
  assert(await buttons.evaluateAll(elements => elements.every(element => element.disabled)));
  await realClickDisabled(page, buttons.first());
  await realClickDisabled(page, dialog.getByRole('button', { name: 'Create new metrology template', exact: true }));
  await outerDismissalsRemainBlocked(page, record, phase);
  record.assertions.push({ phase, pickerSearchDisabled: true, allTemplateChoicesDisabled: true, createActionDisabled: true });
}
async function openPicker(page, owner, record) {
  await serverSession();
  await page.goto(new URL(`/processing/${owner.sampleId}?run=${encodeURIComponent(owner.runId)}`, base).href);
  await page.getByRole('heading', { name: owner.title, exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Add after this entry', exact: true }).first().click();
  await page.getByRole('button', { name: 'Metrology', exact: true }).click();
  await drawer(page).waitFor({ state: 'visible' });
  const search = drawer(page).getByRole('textbox', { name: 'Search templates', exact: true });
  await search.waitFor({ state: 'visible' }); assert(await search.isEnabled());
  // Check Chromium's accessibility tree as well as Playwright's role/name locator.
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const matches = nodes.filter(node => !node.ignored && node.role?.value === 'textbox' && node.name?.value === 'Search templates');
    assert.equal(matches.length, 1, 'The visible picker needs one named accessibility-tree textbox.');
    record.assertions.push({ searchTextboxAccessibleName: matches[0].name.value, chromiumAccessibleTextboxCount: matches.length });
  } finally { await cdp.detach(); }
  await drawer(page).locator('.metrology-picker-list button').first().waitFor({ state: 'visible' });
}
async function executeCase(id, owner, action) {
  const record = { id, owner, status: 'running', startedAt: new Date().toISOString(), viewport: { width: 1200, height: 900 },
    theme: 'dark', requests: [], responses: [], actualHeldReceipts: [], requestFailures: [], pageErrors: [], unexpectedOrigins: [], assertions: [] };
  report.cases.push(record); await save();
  const context = await browser.newContext({ viewport: record.viewport, colorScheme: 'dark', serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('sample-workflow-theme', 'dark'));
  await context.route('**/*', async route => {
    const target = new URL(route.request().url());
    if (['http:', 'https:'].includes(target.protocol) && target.origin !== base.origin) {
      record.unexpectedOrigins.push(target.origin); await route.abort('blockedbyclient'); return;
    }
    await route.continue();
  });
  const page = await context.newPage(), observations = [], requestRecords = new WeakMap();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => record.pageErrors.push(error.message));
  page.on('request', request => {
    const target = new URL(request.url());
    if (target.origin !== base.origin || !target.pathname.startsWith('/api/')) return;
    let body = null; try { body = request.postDataJSON(); } catch {}
    const item = { id: record.requests.length + 1, path: target.pathname + target.search, method: request.method(), body };
    requestRecords.set(request, item); record.requests.push(item);
  });
  page.on('requestfailed', request => record.requestFailures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
  page.on('response', response => {
    const request = requestRecords.get(response.request()); if (!request) return;
    const item = { requestId: request.id, path: request.path, method: request.method, status: response.status() };
    record.responses.push(item);
    observations.push((async () => { try { item.responseSha256 = sha(await response.body()); } catch { item.responseUnavailable = true; } })());
  });
  const create = hold('create', '/api/metrology-templates', 'POST', 201);
  const add = hold('add', `/api/samples/${owner.sampleId}/runs/${owner.runId}/metrology`, 'POST', 201);
  const refresh = hold('refresh', `/api/samples/${owner.sampleId}`, 'GET', 200);
  const gates = { create, add, refresh, refreshArmed: false }, handlerTasks = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    // Let the context's deny-external interceptor handle any foreign API URL;
    // page.route takes precedence, so it must not route.fetch that URL itself.
    if (url.origin !== base.origin) { await route.fallback(); return; }
    const gate = [create, add, refresh].find(candidate => candidate.calls === 0 && request.method() === candidate.method
      && url.pathname === candidate.path && (candidate !== refresh || gates.refreshArmed && url.searchParams.get('view') === 'processing'));
    // Recheck before every same-origin API forwarding, including held real writes.
    try { await serverSession(); }
    catch (error) {
      record.sessionFenceErrors = [...(record.sessionFenceErrors ?? []), { message: error.message, at: new Date().toISOString() }];
      if (gate) gate.accepted.reject(error);
      await route.abort('blockedbyclient').catch(() => {}); return;
    }
    if (!gate) { await route.fallback(); return; }
    gate.calls++;
    const task = (async () => {
      try {
        const response = await route.fetch({ maxRedirects: 0, timeout: 20000 }), bytes = await response.body();
        const body = JSON.parse(bytes.toString());
        gate.receipt = { phase: gate.name, path: url.pathname + url.search, method: request.method(), status: response.status(),
          request: request.postDataJSON(), responseSha256: sha(bytes), body, acceptedAt: new Date().toISOString() };
        record.actualHeldReceipts.push(gate.receipt); await save();
        assert.equal(response.status(), gate.expectedStatus, `Held actual ${gate.name} HTTP response`);
        gate.accepted.resolve(gate.receipt);
        await gate.release.promise;
        await route.fulfill({ response });
        gate.delivered.resolve();
      } catch (error) {
        gate.accepted.reject(error); gate.delivered.resolve();
        record.routeDeliveryError = [...(record.routeDeliveryError ?? []), { phase: gate.name, message: error.message }];
        await route.abort('failed').catch(() => {});
      }
    })(); handlerTasks.push(task); await task;
  });
  try {
    await action(page, record, gates);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), record.theme);
    assert.equal(record.unexpectedOrigins.length, 0); assert.equal(record.pageErrors.length, 0);
    assert.equal(record.requestFailures.length, 0); assert.equal(record.routeDeliveryError?.length ?? 0, 0);
    assert.equal(record.sessionFenceErrors?.length ?? 0, 0);
    await Promise.all(observations);
    await page.screenshot({ path: resolve(output, `${id}.png`), fullPage: true });
    record.status = 'passed';
  } catch (error) {
    record.status = 'failed'; record.error = error.stack || error.message;
    await page.screenshot({ path: resolve(output, `${id}-failed.png`), fullPage: true }).catch(() => {});
  } finally {
    // Closing the browsing owner first cannot initiate a continuation. Actual
    // already accepted templates/entries stay retained; no delete/reset/replay.
    try { await context.close(); }
    catch (error) { record.contextCloseError = error.message; }
    for (const gate of [create, add, refresh]) gate.release.resolve();
    const settled = [...await Promise.allSettled(handlerTasks), ...await Promise.allSettled(observations)];
    const lateFailure = record.contextCloseError || record.routeDeliveryError?.length || record.sessionFenceErrors?.length
      || record.requestFailures.length || record.pageErrors.length || record.unexpectedOrigins.length
      || settled.some(item => item.status === 'rejected');
    if (record.status === 'passed' && lateFailure) {
      record.status = 'failed'; record.error = 'Late route, browser, session-fence or cleanup failure; detailed local counters retained.';
    }
    record.completedAt = new Date().toISOString(); await save();
    console.log(JSON.stringify({ id, status: record.status, error: record.error?.split('\n')[0] ?? null }));
  }
  return record;
}
async function finalReadback(owner, record, templateId, expectedTitle) {
  const detail = await actualApi(`/samples/${owner.sampleId}`), run = detail.runs.find(item => item.id === owner.runId);
  assert.equal(detail.runs.length, 1); assert.equal(run.templateVersionId, fixture.ids.v1);
  assert.equal(run.currentPlanRevisionId, owner.currentPlanRevisionId);
  assert.deepEqual(run.steps.filter(step => step.entryKind === 'fabrication').map(step => step.id), owner.originalFabricationStepIds);
  const metrology = run.steps.filter(step => step.entryKind === 'metrology'); assert.equal(metrology.length, 1);
  const accepted = record.actualHeldReceipts.find(item => item.phase === 'add');
  assert.equal(metrology[0].id, accepted.body.id); assert.equal(metrology[0].title, expectedTitle);
  assert.equal(run.steps.findIndex(step => step.id === metrology[0].id), run.steps.findIndex(step => step.id === owner.afterStepId) + 1);
  const event = detail.events.find(item => item.metadata?.action === 'metrology_added' && item.metadata.stepId === metrology[0].id);
  assert(event); assert.equal(event.metadata.templateVersionId, templateId); assert.equal(event.metadata.afterStepId, owner.afterStepId);
  record.assertions.push({ finalActualReadback: true, exactAcceptedEntryId: metrology[0].id, metrologyEntryCount: 1,
    originalSampleAndRunRetained: true, originalInsertionPointRetained: true, originalFabricationAndPlanRetained: true });
}
let createdTemplate;
try {
  await prepare();
  const createOwner = await freshOwner('CREATE');
  const draft = { name: `5F pending Raman ${fixture.prefix} ${suffix}`, toolName: 'Synthetic real API Raman', parametersText: '532 nm · 中文', commentsText: 'Actual create/add/refresh response holds; no mocked acceptance.' };
  const first = await executeCase('create-add-refresh-pending', createOwner, async (page, record, gates) => {
    await openPicker(page, createOwner, record);
    await drawer(page).getByRole('button', { name: 'Create new metrology template', exact: true }).click();
    for (const [label, value] of [['Template title', draft.name], [/^Tool/, draft.toolName], [/^Parameters/, draft.parametersText], [/^Comments/, draft.commentsText]]) {
      await drawer(page).getByLabel(label).fill(value);
    }
    await drawer(page).getByRole('button', { name: 'Save and add', exact: true }).click();
    const create = await bounded(gates.create.accepted.promise, 'actual accepted template');
    assert.deepEqual(create.request, draft); assert(create.body.id); assert.equal(create.body.version, 1);
    createdTemplate = { id: create.body.id, name: draft.name };
    await createBusy(page, record, 'create', draft);
    assert.equal(record.requests.filter(item => item.method === 'POST' && item.path === gates.create.path).length, 1);
    assert.equal(record.requests.filter(item => item.method === 'POST' && item.path === gates.add.path).length, 0);
    gates.create.release.resolve();
    const add = await bounded(gates.add.accepted.promise, 'actual accepted entry');
    assert.deepEqual(add.request, { templateVersionId: create.body.id, afterStepId: createOwner.afterStepId });
    await createBusy(page, record, 'add', draft);
    gates.refreshArmed = true; gates.add.release.resolve();
    const refreshed = await bounded(gates.refresh.accepted.promise, 'actual processing refresh');
    assert(refreshed.body.runs.find(run => run.id === createOwner.runId)?.steps.some(step => step.id === add.body.id));
    await createBusy(page, record, 'refresh', draft);
    gates.refresh.release.resolve();
    await drawer(page).waitFor({ state: 'hidden' });
    assert.equal(record.requests.filter(item => item.method === 'POST' && item.path === gates.create.path).length, 1);
    assert.equal(record.requests.filter(item => item.method === 'POST' && item.path === gates.add.path).length, 1);
    assert.deepEqual(record.actualHeldReceipts.map(item => item.phase), ['create', 'add', 'refresh']);
    await finalReadback(createOwner, record, create.body.id, draft.name);
  });
  if (first.status === 'passed') {
    const directOwner = await freshOwner('DIRECT');
    await executeCase('direct-add-refresh-pending', directOwner, async (page, record, gates) => {
      await openPicker(page, directOwner, record);
      const choice = drawer(page).locator('.metrology-picker-list button').filter({ has: page.getByText(createdTemplate.name, { exact: true }) });
      await choice.waitFor({ state: 'visible' }); await choice.click();
      const add = await bounded(gates.add.accepted.promise, 'actual direct entry');
      assert.deepEqual(add.request, { templateVersionId: createdTemplate.id, afterStepId: directOwner.afterStepId });
      await pickerBusy(page, record, 'add');
      gates.refreshArmed = true; gates.add.release.resolve();
      const refreshed = await bounded(gates.refresh.accepted.promise, 'actual direct refresh');
      assert(refreshed.body.runs.find(run => run.id === directOwner.runId)?.steps.some(step => step.id === add.body.id));
      await pickerBusy(page, record, 'refresh');
      gates.refresh.release.resolve(); await drawer(page).waitFor({ state: 'hidden' });
      assert.equal(record.requests.filter(item => item.method === 'POST' && item.path === gates.create.path).length, 0);
      assert.equal(record.requests.filter(item => item.method === 'POST' && item.path === gates.add.path).length, 1);
      assert.deepEqual(record.actualHeldReceipts.map(item => item.phase), ['add', 'refresh']);
      await finalReadback(directOwner, record, createdTemplate.id, createdTemplate.name);
    });
  }
} catch (error) {
  report.faults.push({ message: error.stack || error.message, at: new Date().toISOString() });
} finally {
  if (browser) {
    try { await browser.close(); }
    catch (error) { report.faults.push({ phase: 'browser-close', message: error.message, at: new Date().toISOString() }); }
  }
  report.passedCount = report.cases.filter(item => item.status === 'passed').length;
  report.failedCount = report.cases.filter(item => item.status !== 'passed').length;
  report.status = report.faults.length === 0 && report.failedCount === 0 && report.cases.length === report.expectedCaseIds.length ? 'passed' : 'failed';
  report.completeFiniteMatrix = report.status === 'passed'; report.completedAt = new Date().toISOString();
  await save();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const summary = { version: report.version, attemptId, status: report.status, sourceHead: report.sourceHead, sourceTree: report.sourceTree,
    baseUrl: report.baseUrl, fixturePrefix: report.fixturePrefix, sourceCopyRoot: report.sourceCopyRoot,
    scope: report.scope, startedAt: report.startedAt, completedAt: report.completedAt,
    expectedCaseIds: report.expectedCaseIds, passedCount: report.passedCount, failedCount: report.failedCount,
    completeFiniteMatrix: report.completeFiniteMatrix, reportSha256: sha(await readFile(reportPath)),
    harnessSha256: report.harnessSha256, sourceSha256: report.sourceSha256, configSha256: report.configSha256,
    isolationReceiptSha256: report.isolationReceiptSha256, fixtureManifestSha256: report.fixtureManifestSha256,
    fixtureSqlSha256: report.fixtureSqlSha256, seedReceiptSha256: report.seedReceiptSha256,
    serverReceiptSha256: report.serverReceiptSha256, serverLifecycleSessionSha256: report.serverLifecycleSessionSha256, serverSessionId: report.serverSessionId, serverSessionPid: report.serverSessionPid,
    artifact: report.artifact, actualStepZeroSentinelsMatched: report.actualStepZeroSentinelsMatched,
    actualApiRequests: report.actualApi.length,
    cases: report.cases.map(item => ({ id: item.id, status: item.status, viewport: item.viewport, theme: item.theme,
      owner: { sampleId: item.owner.sampleId, runId: item.owner.runId, afterStepId: item.owner.afterStepId, currentPlanRevisionId: item.owner.currentPlanRevisionId },
      assertions: item.assertions, apiRequestCount: item.requests.length, apiResponseCount: item.responses.length,
      actualHeldReceipts: item.actualHeldReceipts.map(receipt => ({ phase: receipt.phase, path: receipt.path, method: receipt.method,
        status: receipt.status, responseSha256: receipt.responseSha256, acceptedAt: receipt.acceptedAt })),
      requestFailureCount: item.requestFailures.length, pageErrorCount: item.pageErrors.length, unexpectedOriginCount: item.unexpectedOrigins.length,
      routeDeliveryErrorCount: item.routeDeliveryError?.length ?? 0, sessionFenceErrorCount: item.sessionFenceErrors?.length ?? 0,
      contextCloseError: item.contextCloseError ?? null,
      error: item.error ? item.error.split('\n')[0] : null })),
    faults: report.faults.map(item => ({ phase: item.phase ?? 'run', message: item.message.split('\n')[0], at: item.at })) };
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, passed: report.passedCount, failed: report.failedCount,
    completeFiniteMatrix: report.completeFiniteMatrix, reportPath, summaryPath }));
  if (report.status !== 'passed') process.exitCode = 1;
}
