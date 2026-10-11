// Finite local enabled-Access qualification. The application, JWT verifier,
// administrator policy, D1 service and browser responses remain unmodified.
// The unchanged mature seed must finish and its Worker must stop first.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { lstat, mkdir, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [sourceValue, fixtureValue, permit, ...extra] = process.argv.slice(2);
assert(sourceValue && fixtureValue && permit === '--exclusive-go-four-enabled-admin' && !extra.length,
  'Usage: node browser-enabled-admin-actual-api.mjs ISOLATED_COPY FIXTURE_DIRECTORY --exclusive-go-four-enabled-admin');
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
assert.equal(helperSha256, isolation.trackedFiles['scripts/qa/phase5f/browser-enabled-admin-actual-api.mjs']);
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
// The ordinary setup is historical to these four cases, and retains its own
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
// Carry the observed original95 producer only when all other tracked inputs
// and the exact produced Worker/frontend/config/artifact inventory match.
// The QA observer consumer checkpoint is distinct from its actual producer.
const freshBuild = await json(fixtureRoot, 'enabled-admin-fresh-build.json');
assert.equal(freshBuild.status, 'passed'); assert.deepEqual(freshBuild.command, ['npm', 'run', 'build']);
assert.equal(freshBuild.actualExitCode, 0);
assert.equal(freshBuild.sourceHead, '95ad6b88d833c16d6f9e62f4787101c7919b31c5');
assert.equal(freshBuild.sourceTree, 'b2b18885a5b91c05b1272384897e24c8bf58476a');
assert.equal(freshBuild.consumerSourceHead, isolation.sourceHead);
assert.equal(freshBuild.consumerSourceTree, isolation.sourceTree);
assert.equal(freshBuild.consumerSourceRoot, isolation.sourceRoot);
const preservedInputs = { ...isolation.trackedFiles };
delete preservedInputs['scripts/qa/phase5f/browser-enabled-admin-actual-api.mjs'];
assert.deepEqual(freshBuild.inputScope.excludedQaPaths, ['scripts/qa/phase5f/browser-enabled-admin-actual-api.mjs']);
assert.equal(freshBuild.inputScope.purpose, 'original95-actual-producer-single-QA-observer-equivalence-v1');
assert.equal(freshBuild.inputScope.preservedTrackedFileCount, 1706);
assert.equal(Object.keys(preservedInputs).length, 1706);
assert.equal(freshBuild.inputScope.preservedTrackedFileInventorySha256, sha(JSON.stringify(preservedInputs)));
assert(/^[a-f0-9]{64}$/.test(freshBuild.inputScope.sourceEquivalenceReceiptSha256));
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
const expectedCases = ['admin-1280-light', 'admin-390-dark', 'reader-1280-light', 'admin-390-dark-read-retry'];
const output = resolve(fixtureRoot, 'enabled-admin-browser-artifacts');
const reportPath = resolve(fixtureRoot, 'enabled-admin-browser-report.json');
const stopPath = resolve(fixtureRoot, 'enabled-admin-runtime-stop.json');
const progressPath = resolve(fixtureRoot, 'enabled-admin-browser-progress.ndjson');
for (const path of [output, reportPath, stopPath, progressPath]) await missing(path);
await mkdir(output, { mode: 0o700 }); await writeFile(progressPath, '', { flag: 'wx', mode: 0o600 });
const report = { version: 1, scope: 'Four actual local enabled-Access browser cases over fresh synthetic current24 D1/R2. No remote Access, provider, device, recovery or whole-roadmap acceptance.',
  sourceRoot: isolation.sourceRoot, sourceCopyRoot: source, sourceHead: isolation.sourceHead, sourceTree: isolation.sourceTree,
  fixtureDirectory: fixtureRoot, isolationReceiptSha256: isolationHash, helperSha256,
  seedReceiptSha256: sha(await readFile(await file(fixtureRoot, 'actual-api-fixture-receipt.json'))),
  freshBuildReceiptSha256: sha(await readFile(await file(fixtureRoot, 'enabled-admin-fresh-build.json'))),
  sessionId: randomUUID(), sessionPid: process.pid, expectedCases, cases: [], authenticationControls: [], jwksRequests: [],
  startedAt: new Date().toISOString(), status: 'running' };
let jwksServer, runtime, browser, database, originalDatabaseSnapshot, faultRestore;
let originalBrowserClose, originalWorkerDispose, originalJwksClose;
const activeContexts = new Set(), originalContextCloses = new WeakMap();
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
// ordered cancellation. Keep D1 alive until its original fault is restored.
let originalControlStop;
function stopFromOriginalControl() {
  return originalControlStop ??= (async () => {
    report.interrupted ??= 'original-stdin-stop'; report.status = 'failed';
    report.originalStdinStopReceived = report.controlInputError === undefined;
    try { if (faultRestore) await faultRestore(); }
    finally {
      try { await Promise.all([...activeContexts].map(closeContext)); }
      finally { if (browser) await closeBrowser(); }
    }
  })();
}
function originalControlInput(value) {
  if (value !== 'stop\n') {
    report.controlInputError = 'Only the original explicit stop command is permitted.';
  }
  void stopFromOriginalControl().catch(error => {
    report.controlStopError = error.message;
  });
}
process.stdin.setEncoding('utf8');
process.stdin.once('data', originalControlInput);
process.stdin.resume();
let issuer, issuerPort, adminToken, readerToken, signingKey;
const admin = 'administrator@enabled-admin.invalid', reader = 'reader@enabled-admin.invalid';
const audience = `enabled-admin-${randomUUID()}`;
const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const canonical = value => JSON.stringify(value, (_key, item) => item instanceof ArrayBuffer
  ? { bytes: Buffer.from(item).toString('hex') } : ArrayBuffer.isView(item) ? { bytes: Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString('hex') } : item);
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
async function actualRequest(path, token, expected, method = 'GET', body) {
  notInterrupted();
  const response = await fetch(new URL(path, base), { method, headers: { ...(token ? { 'cf-access-jwt-assertion': token } : {}), origin: base.origin,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error', signal: AbortSignal.timeout(20000) });
  const bytes = Buffer.from(await response.arrayBuffer()); assert(bytes.length < 131072);
  assert.equal(response.status, expected, `${method} ${path}`);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  const value = JSON.parse(bytes); return { status: response.status, responseSha256: sha(bytes), value };
}
async function sign(email, options = {}) {
  notInterrupted();
  return new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'enabled-admin-fixture-key' })
    .setIssuer(issuer).setAudience(options.audience || audience).setSubject(`fixture:${email}`)
    .setIssuedAt().setExpirationTime(options.expires ?? '5m').sign(signingKey);
}
async function visible(locator) { await locator.waitFor({ state: 'visible', timeout: 20000 }); }
async function absent(locator) { await locator.waitFor({ state: 'hidden', timeout: 20000 }); }
async function geometry(page, record, surface, theme) {
  const value = await page.evaluate(() => ({ width: document.documentElement.clientWidth, root: document.documentElement.scrollWidth,
    body: document.body.scrollWidth, theme: document.documentElement.dataset.theme }));
  assert.equal(value.theme, theme); assert(value.root <= value.width + 2 && value.body <= value.width + 2);
  record.assertions.push({ surface, geometry: value });
}
async function caseRun(id, width, theme, token, action) {
  notInterrupted();
  const record = { id, width, theme, status: 'running', assertions: [], api: [], pageErrors: [], externalRequests: [], startedAt: new Date().toISOString() };
  report.cases.push(record); await writeFile(progressPath, canonical({ id, status: 'running' }) + '\n', { flag: 'a' });
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, isMobile: width === 390,
    hasTouch: width === 390, serviceWorkers: 'block' });
  activeContexts.add(context);
  const observations = [];
  const originalResponseObservations = new WeakMap();
  let originalUnavailableBodyException;
  const originalRequestTerminals = new WeakMap(), originalTerminalWaiters = new WeakMap();
  try {
    notInterrupted();
    // Header injection is confined to the exact local API origin. JWTs never
    // enter fixture receipts, browser storage, screenshots or external assets.
    await context.route('**/*', async route => {
      const request = route.request(), target = new URL(request.url());
      if (['http:', 'https:'].includes(target.protocol) && target.origin !== base.origin) {
        record.externalRequests.push({ origin: target.origin }); await route.abort('blockedbyclient'); return;
      }
      if (target.origin === base.origin && target.pathname.startsWith('/api/')) {
        await route.continue({ headers: { ...request.headers(), 'cf-access-jwt-assertion': token } });
      } else await route.continue();
    });
    await context.addInitScript(value => localStorage.setItem('sample-workflow-theme', value), theme);
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => record.pageErrors.push(error.message));
    // Arm native terminal observers before navigation. A status-only fetch
    // may finish normally before Refresh, or its unread body may be aborted.
    function observeTerminal(request, type) {
      const event = { type, failure: request.failure(), controlledRefreshStarted: record.controlledRefreshStarted === true };
      const previous = originalRequestTerminals.get(request);
      if (previous) { previous.duplicateTerminalEvent = event; return; }
      originalRequestTerminals.set(request, event);
      originalTerminalWaiters.get(request)?.(event);
    }
    page.on('requestfinished', request => observeTerminal(request, 'requestfinished'));
    page.on('requestfailed', request => observeTerminal(request, 'requestfailed'));
    page.on('response', response => {
      const url = new URL(response.url()); if (url.origin !== base.origin || !url.pathname.startsWith('/api/')) return;
      const item = { path: url.pathname, method: response.request().method(), status: response.status(), body: 'pending' };
      record.api.push(item);
      const original = response.body();
      const observation = original.then(bytes => { assert(bytes.length < 131072); item.body = 'completed'; item.responseSha256 = sha(bytes); })
        .catch(error => { item.body = 'failed'; item.error = error.message; });
      const terminal = new Promise(done => {
        const existing = originalRequestTerminals.get(response.request());
        if (existing) done(existing); else originalTerminalWaiters.set(response.request(), done);
      });
      originalResponseObservations.set(response, { item, observation, terminal }); observations.push(observation);
    });
    await action(page, record, async response => {
      const captured = originalResponseObservations.get(response); assert(captured, 'Require the original response observation.');
      assert.equal(id, 'admin-390-dark-read-retry');
      assert.equal(captured.item.path, '/api/storage/configuration');
      assert.equal(captured.item.method, 'GET'); assert.equal(captured.item.status, 503);
      let timer, terminal;
      try {
        [terminal] = await Promise.race([
          Promise.all([captured.terminal, captured.observation]),
          new Promise((_done, fail) => { timer = setTimeout(() => fail(new Error('Original response terminal/body observation exceeded the existing 20s request budget.')), 20000); }),
        ]);
      } finally { clearTimeout(timer); }
      assert.equal(terminal, originalRequestTerminals.get(response.request()), 'Use the exact original native Request terminal event.');
      assert.equal(terminal.duplicateTerminalEvent, undefined);
      if (terminal.type === 'requestfinished') assert.equal(terminal.failure, null);
      else {
        assert.equal(terminal.type, 'requestfailed');
        assert.equal(terminal.controlledRefreshStarted, true, 'Cancellation must follow the explicit Refresh.');
        assert.deepEqual(terminal.failure, { errorText: 'net::ERR_ABORTED' });
      }
      captured.item.nativeRequestTerminal = terminal;
      if (captured.item.body !== 'completed') {
        assert.equal(captured.item.body, 'failed');
        assert.equal(captured.item.error, 'response.body: Protocol error (Network.getResponseBody): No data found for resource with given identifier');
        assert.equal(captured.item.responseSha256, undefined, 'Unavailable payload has no observed bytes/hash.');
        captured.item.body = terminal.type === 'requestfinished' ? 'unused-error-body-unavailable' : 'cancelled-after-explicit-refresh';
        originalUnavailableBodyException = captured.item;
      }
      record.assertions.push({ original503RequestTerminal: terminal, originalBodyOutcome: captured.item.body,
        originalResponseCaptureTerminalError: captured.item.error, observedResponseSha256: captured.item.responseSha256 });
    });
    await Promise.all(observations);
    assert(record.api.every(item => item.body === 'completed' || (item === originalUnavailableBodyException && ['unused-error-body-unavailable', 'cancelled-after-explicit-refresh'].includes(item.body))), 'Every original API response body must settle before context shutdown.');
    await closeContext(context); record.contextClosed = true;
    await Promise.all(observations);
    assert(record.api.every(item => item.body === 'completed' || (item === originalUnavailableBodyException && ['unused-error-body-unavailable', 'cancelled-after-explicit-refresh'].includes(item.body))), 'Every original API response body must settle.');
    assert.equal(record.pageErrors.length, 0); assert.equal(record.externalRequests.length, 0);
    assert(record.api.every(item => !mutationMethods.has(item.method) || (id.startsWith('reader-') && item.method === 'PUT' && item.status === 403)),
      'These cases never accept a browser mutation.');
    record.status = 'passed';
  } catch (error) { record.status = 'failed'; record.error = error.stack || error.message; throw error; }
  finally {
    if (!record.contextClosed) { try { await closeContext(context); record.contextClosed = true; } catch (error) { record.contextCloseError = error.message; } }
    activeContexts.delete(context);
    await Promise.all(observations); record.completedAt = new Date().toISOString();
    await writeFile(progressPath, canonical({ id, status: record.status, contextClosed: record.contextClosed === true }) + '\n', { flag: 'a' });
  }
}
async function adminRead(page, record, theme) {
  const settings = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings/storage');
  const settingsCapability = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/configuration/capability');
  await page.goto(new URL('/settings/storage', base).href); assert.equal((await settings).status(), 200);
  await visible(page.getByRole('heading', { name: 'Storage', exact: true }));
  assert.deepEqual(await (await settingsCapability).json(), { canManage: true, credentialEditingAvailable: false });
  await geometry(page, record, 'current-storage', theme);
  const capability = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/configuration/capability');
  const read = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/configuration');
  await page.goto(new URL('/settings/storage/configuration', base).href);
  assert.equal((await capability).status(), 200); assert.equal((await read).status(), 200);
  await visible(page.getByRole('heading', { name: 'Saved candidates', exact: true }));
  await visible(page.getByText('No external storage candidates have been saved.', { exact: true }));
  await visible(page.getByText('External credential editing is unavailable.', { exact: false }));
  await absent(page.getByRole('button', { name: 'Save draft', exact: true }));
  await absent(page.getByRole('heading', { name: 'Read only', exact: true }));
  await geometry(page, record, 'administrator-configuration', theme);
  await page.screenshot({ path: resolve(output, `${record.id}.png`), fullPage: true, timeout: 20000 });
  record.assertions.push({ actualAdministrator: true, credentialEditing: 'unavailable', acceptedBrowserMutations: 0 });
}
try {
  const keys = await generateKeyPair('RS256'); signingKey = keys.privateKey;
  notInterrupted();
  const publicKey = { ...await exportJWK(keys.publicKey), kid: 'enabled-admin-fixture-key', alg: 'RS256', use: 'sig' };
  const publicBytes = Buffer.from(JSON.stringify({ keys: [publicKey] }));
  jwksServer = createServer((request, response) => {
    const observation = { method: request.method, path: request.url, at: new Date().toISOString() }; report.jwksRequests.push(observation);
    if (request.method !== 'GET' || request.url !== '/cdn-cgi/access/certs') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': publicBytes.length }); response.end(publicBytes);
  });
  await new Promise((done, fail) => { jwksServer.once('error', fail); jwksServer.listen(0, '127.0.0.1', done); });
  issuerPort = jwksServer.address().port; issuer = `http://127.0.0.1:${issuerPort}`;
  report.jwksOwner = { host: '127.0.0.1', port: issuerPort, publicJwksSha256: sha(publicBytes), issuerScope: 'Fresh private local issuer, no remote Access acceptance' };
  adminToken = await sign(admin); readerToken = await sign(reader);
  const vars = { ...config.vars, AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience,
    ALLOWED_EMAILS: `${admin},${reader}`, SYSTEM_ADMIN_EMAILS: admin };
  // No external keyring/provider activation; saved metadata reads remain 200.
  delete vars.STORAGE_CREDENTIAL_KEYRING;
  runtime = new Miniflare({ ...artifact, rootPath: source, modulesRoot: source, modules: true, host: '127.0.0.1', port: 4219,
    bindings: vars, d1Databases: { DB: config.d1_databases[0].database_id }, d1Persist: resolve(source, '.wrangler/state/v3/d1'),
    r2Buckets: { ASSETS: config.r2_buckets[0].bucket_name }, r2Persist: resolve(source, '.wrangler/state/v3/r2'), log: new Log(LogLevel.ERROR),
    outboundService: async request => {
      assert.equal(request.url, `${issuer}/cdn-cgi/access/certs`, 'Only the owned original JOSE JWKS request may leave the Worker.');
      assert.equal(request.method, 'GET');
      const response = await fetch(request.url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
    } });
  assert.equal(new URL((await runtime.ready).href).origin, base.origin);
  notInterrupted();
  database = await runtime.getD1Database('DB');
  const names = (await readdir(resolve(source, 'migrations'))).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  assert.equal(names.length, 24); assert.equal(names.at(-1).slice(0, 4), '0024');
  assert.deepEqual((await database.prepare('SELECT name FROM d1_migrations ORDER BY name').all()).results.map(item => item.name), names);
  for (const [id, version] of [[fixture.ids.v1, 1], [fixture.ids.v2, 2]]) {
    const row = await database.prepare('SELECT id,version,initial_state_hash FROM template_versions WHERE id=?').bind(id).first();
    assert.deepEqual(row, { id, version, initial_state_hash: fixture.initialStateHash });
  }
  originalDatabaseSnapshot = await snapshot(); report.databaseBefore = originalDatabaseSnapshot;
  assert.equal(originalDatabaseSnapshot.tables.system_storage_configuration_revisions.count, 0);
  const adminCapability = await actualRequest('/api/storage/configuration/capability', adminToken, 200);
  assert.deepEqual(adminCapability.value, { canManage: true, credentialEditingAvailable: false });
  const readerCapability = await actualRequest('/api/storage/configuration/capability', readerToken, 200);
  assert.deepEqual(readerCapability.value, { canManage: false, credentialEditingAvailable: false });
  report.authenticationControls.push({ id: 'genuine-signed-admin', ...adminCapability, value: undefined }, { id: 'genuine-signed-reader', ...readerCapability, value: undefined });
  const forged = adminToken.split('.'); forged[2] = `${forged[2][0] === 'a' ? 'b' : 'a'}${forged[2].slice(1)}`;
  for (const [id, token] of [['missing-jwt', null], ['forged-signature', forged.join('.')], ['expired-jwt', await sign(admin, { expires: Math.floor(Date.now() / 1000) - 60 })],
    ['wrong-audience', await sign(admin, { audience: `wrong-${randomUUID()}` })]]) {
    const result = await actualRequest('/api/storage/configuration/capability', token, 403);
    assert.equal(result.value.error, 'Authentication required'); report.authenticationControls.push({ id, status: result.status, responseSha256: result.responseSha256 });
  }
  assert(report.jwksRequests.some(item => item.method === 'GET' && item.path === '/cdn-cgi/access/certs'));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  notInterrupted();
  await caseRun(expectedCases[0], 1280, 'light', adminToken, (page, record) => adminRead(page, record, 'light'));
  await caseRun(expectedCases[1], 390, 'dark', adminToken, (page, record) => adminRead(page, record, 'dark'));
  await caseRun(expectedCases[2], 1280, 'light', readerToken, async (page, record) => {
    await page.goto(new URL('/settings/storage/configuration', base).href);
    await visible(page.getByRole('heading', { name: 'Read only', exact: true }));
    await absent(page.getByRole('heading', { name: 'Saved candidates', exact: true }));
    await absent(page.getByRole('button', { name: 'Save draft', exact: true }));
    const denied = await page.evaluate(async () => {
      const result = [];
      for (const [path, method] of [['/api/storage/configuration', 'GET'], ['/api/storage/configuration/candidates', 'PUT']]) {
        const response = await fetch(path, { method, ...(method === 'PUT' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
        result.push({ path, method, status: response.status, body: await response.json(), cacheControl: response.headers.get('cache-control') });
      }
      return result;
    });
    assert(denied.every(item => item.status === 403 && item.body.error === 'System administrator access is required.' && /no-store/.test(item.cacheControl)));
    record.assertions.push({ ordinaryVerifiedReader: true, privilegedApiDenied: denied.map(({ path, method, status }) => ({ path, method, status })) });
    await geometry(page, record, 'ordinary-reader-configuration', 'light');
    await page.screenshot({ path: resolve(output, `${record.id}.png`), fullPage: true, timeout: 20000 });
  });
  await caseRun(expectedCases[3], 390, 'dark', adminToken, async (page, record, observeOriginalUnavailableResponse) => {
    // Fault only an empty table in this receipt-owned synthetic D1. Preserve
    // its exact original DDL/attached objects; never alter grants or handlers.
    const table = 'system_storage_configuration_revisions';
    const objects = (await database.prepare('SELECT type,name,sql FROM sqlite_schema WHERE tbl_name=? AND sql IS NOT NULL ORDER BY CASE type WHEN \'table\' THEN 0 WHEN \'index\' THEN 1 ELSE 2 END,name').bind(table).all()).results;
    assert(objects.length && objects[0].type === 'table');
    assert.equal((await database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 0);
    let originalRestoration;
    faultRestore = () => originalRestoration ??= database.batch(objects.map(item => database.prepare(item.sql)));
    await database.prepare(`DROP TABLE ${table}`).run();
    record.assertions.push({ controlledFixtureFault: 'Original empty configuration table temporarily absent', originalDdlSha256: sha(canonical(objects)) });
    const unavailable = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/configuration');
    await page.goto(new URL('/settings/storage/configuration', base).href);
    const originalUnavailable = await unavailable; assert.equal(originalUnavailable.status(), 503);
    await visible(page.getByRole('alert')); await visible(page.getByText('Storage configuration is unavailable. Refresh to try again.', { exact: true }));
    await absent(page.getByRole('heading', { name: 'Saved candidates', exact: true }));
    await faultRestore(); faultRestore = undefined;
    assert.deepEqual(await snapshot(), originalDatabaseSnapshot, 'Exact schema and all typed fixture rows must be restored before retry.');
    const retry = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/configuration');
    const refresh = page.getByRole('button', { name: 'Refresh', exact: true }); await visible(refresh); await refresh.focus();
    record.controlledRefreshStarted = true; await page.keyboard.press('Enter');
    assert.equal((await retry).status(), 200);
    await observeOriginalUnavailableResponse(originalUnavailable);
    await visible(page.getByRole('heading', { name: 'Saved candidates', exact: true }));
    await absent(page.getByRole('alert')); await geometry(page, record, 'administrator-real-service-retry', 'dark');
    await page.screenshot({ path: resolve(output, `${record.id}.png`), fullPage: true, timeout: 20000 });
    record.assertions.push({ actualConfigurationResponses: [503, 200], explicitRetry: 'Focused Refresh + Enter', restoredOriginalSchema: true });
  });
  assert.deepEqual(report.cases.map(item => item.id), expectedCases); assert(report.cases.every(item => item.status === 'passed' && item.contextClosed));
  report.databaseAfter = await snapshot(); assert.deepEqual(report.databaseAfter, originalDatabaseSnapshot);
  assert.deepEqual((await database.prepare('PRAGMA foreign_key_check').all()).results, []);
  notInterrupted(); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack || error.message; }
finally {
  // Original owners are retained and awaited. A failed disposal is preserved;
  // this helper never signals an unowned process or invents graceful closure.
  process.stdin.removeListener('data', originalControlInput); process.stdin.pause();
  const cleanup = { sessionId: report.sessionId, startedAt: new Date().toISOString(), status: 'closing' };
  if (originalControlStop) {
    try { await originalControlStop; cleanup.originalControlStopAwaited = true; }
    catch (error) { cleanup.originalControlStopError = error.message; }
  }
  if (faultRestore) { try { await faultRestore(); cleanup.originalFaultTableRestored = true; } catch (error) { cleanup.faultRestoreError = error.message; } }
  if (browser) { try { await closeBrowser(); cleanup.browserCloseAwaited = true; } catch (error) { cleanup.browserCloseError = error.message; } }
  if (database && originalDatabaseSnapshot) { try { assert.deepEqual(await snapshot(), originalDatabaseSnapshot); cleanup.originalCatalogAndRowsRestored = true; } catch (error) { cleanup.databaseRestorationError = error.message; } }
  if (runtime) { try { await disposeWorker(); cleanup.workerDisposeAwaited = true; await refused(4219); cleanup.workerPortRefused = true; } catch (error) { cleanup.workerCloseError = error.message; } }
  if (jwksServer) { try { await closeJwks(); cleanup.jwksCloseAwaited = true;
    if (issuerPort) { await refused(issuerPort); cleanup.jwksPortRefused = true; } } catch (error) { cleanup.jwksCloseError = error.message; } }
  cleanup.status = Object.keys(cleanup).some(key => key.endsWith('Error')) ? 'failed' : 'closed';
  cleanup.completedAt = new Date().toISOString(); report.ownedClosure = cleanup;
  if (cleanup.status !== 'closed') report.status = 'failed';
  report.unrunCases = expectedCases.filter(id => !report.cases.some(item => item.id === id)); report.completedAt = new Date().toISOString();
  await writeOnce(stopPath, cleanup); await writeOnce(reportPath, report);
}
console.log(JSON.stringify({ status: report.status, reportPath, actualCases: report.cases.length, passed: report.cases.filter(item => item.status === 'passed').length,
  failed: report.cases.filter(item => item.status === 'failed').length, unrun: report.unrunCases.length, closure: report.ownedClosure.status }));
if (report.status !== 'passed') process.exitCode = 1;
