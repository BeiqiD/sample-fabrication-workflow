// Bounded Chromium presentation/interaction qualification against explicit HTTP
// fixtures. Node V28 deliberately does not serve this SPA; this local QA server
// does not add that production capability or qualify backend execution.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveBytes, createSupportedRecoveryFixture } from './browser-supported-recovery-fixture.mjs';

const source = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const options = process.argv.slice(2);
assert(options.length === 4 && options[0] === '--client' && options[2] === '--output',
  'Usage: node scripts/qa/phase5f/browser-supported-recovery.mjs --client dist-node/client --output /tmp/NEW_OUTPUT_DIRECTORY');
const client = resolve(source, options[1]), output = resolve(options[3]);
const outputRelative = relative(source, output);
assert(isAbsolute(options[3]) && (outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative)),
  'Keep generated browser evidence outside the source checkout.');
assert((await stat(resolve(client, 'index.html'))).isFile(), 'Run npm run build:node-client first.');
await mkdir(output, { mode: 0o700 });
const require = createRequire(import.meta.url);
assert(process.env.PLAYWRIGHT_MODULE_PATH && process.env.CHROMIUM_PATH,
  'Provide existing PLAYWRIGHT_MODULE_PATH and CHROMIUM_PATH; this helper never downloads browsers.');
const { chromium } = require(resolve(process.env.PLAYWRIGHT_MODULE_PATH));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { version: 1, scope: 'Actual built shared client in local Chromium with explicit checked HTTP fixtures. Browser form, hashing, request policy, session reconciliation, keyboard/focus, theme and responsive evidence only. Node host/SPA admission, authentication security, executor, archive semantics, target writes, handoff activation and production are not qualified.',
  source, client, output, nodeVersion: process.version, observedSourceInputSha256: Object.fromEntries(await Promise.all([
    'src/pages/SystemRecoveryPage.tsx', 'src/lib/system-recovery-client.ts', 'shared/contracts/system-recovery.ts',
  ].map(async path => [path, sha256(await readFile(resolve(source, path)))]))),
  servedAssetSha256: {}, startedAt: new Date().toISOString(), cases: [], status: 'running' };
let fixture, browser, server;
const serverErrors = [];
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const enabled = async locator => {
  await locator.waitFor(); await locator.page().waitForFunction(element => !element.disabled, await locator.elementHandle()); return locator;
};
async function keyboard(page, locator) { await enabled(locator); await locator.focus(); await page.keyboard.press('Enter'); }
const button = (page, name) => page.getByRole('button', { name, exact: true });
async function geometry(page) {
  const value = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth,
    theme: document.documentElement.dataset.theme,
    focused: document.activeElement === document.body ? 'body' : document.activeElement?.textContent?.trim().slice(0, 128) }));
  assert(value.width <= value.viewport + 1, `Horizontal page overflow: ${JSON.stringify(value)}`); return value;
}
async function upload(page) {
  await page.getByLabel('System recovery ZIP').setInputFiles({ name: 'explicit-browser-fixture.zip', mimeType: 'application/zip', buffer: archiveBytes });
  await keyboard(page, button(page, 'Upload and validate recovery archive'));
  await page.getByText('Archive bytes accepted.', { exact: false }).waitFor();
  await keyboard(page, button(page, 'Refresh recovery report'));
  await page.getByRole('heading', { name: 'Recovery report', exact: true }).waitFor();
  await page.getByLabel('I understand that this recovers the archive recovery point and does not include later source changes.').check();
}
async function backupOnly(page, value) {
  value.maintenanceGenerations = [fixture.snapshot().maintenance.generation];
  assert.equal(value.maintenanceGenerations[0], 0);
  await keyboard(page, button(page, 'Preview system backup'));
  assert(await button(page, 'Start durable system backup').isDisabled());
  await keyboard(page, button(page, 'Stop new source writes'));
  await page.getByText('The source write window is draining.', { exact: false }).waitFor();
  value.maintenanceGenerations.push(fixture.snapshot().maintenance.generation);
  const draining = fixture.snapshot().maintenance;
  await keyboard(page, button(page, 'Confirm drained source fence'));
  await page.getByText('The source write fence was confirmed.', { exact: false }).waitFor();
  const fenced = fixture.snapshot().maintenance;
  value.maintenanceGenerations.push(fenced.generation);
  assert.deepEqual(value.maintenanceGenerations, [0, 1, 1]);
  assert.equal(fenced.checkpoint, draining.checkpoint); assert.equal(fenced.backupJobId, draining.backupJobId);
  const preview = button(page, 'Preview system backup');
  await keyboard(page, preview); await enabled(button(page, 'Start durable system backup'));
  assert(await preview.evaluate(element => element === document.activeElement), 'Deferred preview must restore keyboard focus.');
  value.previewFocus = await preview.evaluate(element => ({ focused: element === document.activeElement,
    outlineStyle: getComputedStyle(element).outlineStyle, outlineWidth: getComputedStyle(element).outlineWidth, boxShadow: getComputedStyle(element).boxShadow }));
  assert(value.previewFocus.outlineStyle !== 'none' && value.previewFocus.outlineWidth !== '0px' || value.previewFocus.boxShadow !== 'none', 'Keyboard focus must remain visible.');
  await keyboard(page, button(page, 'Start durable system backup'));
  await page.getByText('Operation saved.', { exact: false }).waitFor();
  const mutations = fixture.journal.filter(item => item.method === 'POST');
  assert.deepEqual(mutations.map(item => item.path), ['/api/system-recovery/maintenance', '/api/system-recovery/maintenance', '/api/system-recovery/jobs']);
  assert.equal(mutations[2].input.mode, 'historical');
  assert.equal(fixture.snapshot().target, false);
}
async function mapping(page, runtime) {
  await upload(page);
  const stage = button(page, 'Stage isolated recovery');
  if (runtime === 'node') {
    assert.equal(await page.getByLabel('Destination for source-r2', { exact: true }).count(), 0);
    await page.getByText('source-r2', { exact: true }).first().waitFor();
  } else {
    assert(await stage.isDisabled(), 'Worker must require its explicit profile mapping.');
    await page.getByLabel('Destination for source-r2', { exact: true }).fill('destination-r2');
    await page.getByLabel('Revision for source-r2', { exact: true }).fill('7');
  }
  await keyboard(page, stage); await page.getByText('Operation saved.', { exact: false }).waitFor();
  const recovery = page.locator('.system-recovery-job').filter({ has: page.getByRole('heading', { name: 'Isolated system recovery', exact: true }) });
  await recovery.waitFor();
  assert.equal(await recovery.getByRole('button', { name: 'Clean up job artifacts', exact: true }).count(), runtime === 'node' ? 0 : 1);
  const submitted = fixture.journal.filter(item => item.path === '/api/system-recovery/recoveries' && item.method === 'POST');
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0].input.mapping, runtime === 'node' ? [] : [{ sourceProfileId: 'source-r2', destinationProfileId: 'destination-r2', configurationRevision: 7 }]);
}
async function sourceResume(page, value) {
  await backupOnly(page, value);
  await keyboard(page, button(page, 'Refresh recovery status'));
  await page.getByText('Frozen source checkpoint:', { exact: false }).waitFor();
  await keyboard(page, button(page, 'Disable system recovery executor'));
  await keyboard(page, button(page, 'Release source maintenance window'));
  await page.getByText('The source maintenance window was released.', { exact: false }).waitFor();
  const release = fixture.journal.filter(item => item.path === '/api/system-recovery/maintenance' && item.input?.action === 'release');
  assert.equal(release.length, 1);
  value.maintenanceGenerations.push(fixture.snapshot().maintenance.generation);
  assert.deepEqual(value.maintenanceGenerations, [0, 1, 1, 2]);
  assert.equal(release[0].input.expectedGeneration, 1);
  await keyboard(page, button(page, 'Resume source writes after backup'));
  await enabled(button(page, 'Check or retry original source resume request'));
  const original = await page.evaluate(() => JSON.parse(sessionStorage.getItem('system-recovery-source-resume')));
  assert.equal(original.releaseRequestId, release[0].input.requestId); assert.equal(original.expectedGeneration, 2); assert.equal(original.backupJobId, 'backup-original');
  await page.reload();
  await page.getByText('Original source writes are enabled.', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('system-recovery-source-resume')), null);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('system-recovery-source-release')), null);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('system-recovery-source-backup')), null);
  const posts = fixture.journal.filter(item => item.path === '/api/system-recovery/source-resume' && item.method === 'POST');
  assert.equal(posts.length, 1); assert.deepEqual(posts[0].input, original); assert.equal(posts[0].ackBodyTruncated, true);
  assert.equal(fixture.journal.filter(item => item.path === `/api/system-recovery/source-resume/requests/${original.requestId}` && item.method === 'GET').length, 1);
  value.originalSourceResumeInput = original;
}
async function revokedAccess(page) {
  await upload(page); fixture.revoke();
  const mutationsBefore = fixture.journal.filter(item => item.method !== 'GET').length;
  await keyboard(page, button(page, 'Refresh recovery status'));
  await page.getByRole('heading', { name: 'Administrator access required', exact: true }).waitFor();
  assert(fixture.journal.some(item => item.path === '/api/system-recovery/capabilities' && item.responseStatus === 403));
  assert.equal(await page.getByRole('heading', { name: 'Recovery report', exact: true }).count(), 0);
  assert.equal(await button(page, 'Stage isolated recovery').count(), 0);
  assert.equal(fixture.journal.filter(item => item.method !== 'GET').length, mutationsBefore);
}
try {
  server = createServer((request, response) => {
    void (async () => {
      if (await fixture.handle(request, response)) return;
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      const path = pathname.startsWith('/assets/') ? resolve(client, `.${pathname}`) : resolve(client, 'index.html');
      assert(!relative(client, path).startsWith(`..${sep}`));
      const bytes = await readFile(path); report.servedAssetSha256[relative(client, path)] = sha256(bytes);
      response.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' }); response.end(bytes);
    })().catch(error => { serverErrors.push(error.stack ?? String(error)); if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  report.chromiumVersion = browser.version();
  for (const scenario of [
    { name: 'node-no-target-backup-1280-light', runtime: 'node', target: false, width: 1280, theme: 'light', run: backupOnly },
    { name: 'node-no-target-backup-390-dark', runtime: 'node', target: false, width: 390, theme: 'dark', run: backupOnly },
    { name: 'node-inert-mapping-1280-light', runtime: 'node', target: true, width: 1280, theme: 'light', run: page => mapping(page, 'node') },
    { name: 'node-inert-mapping-390-dark', runtime: 'node', target: true, width: 390, theme: 'dark', run: page => mapping(page, 'node') },
    { name: 'worker-explicit-mapping-1280-light', runtime: 'worker', target: true, width: 1280, theme: 'light', run: page => mapping(page, 'worker') },
    { name: 'node-source-resume-lost-ack-390-dark', runtime: 'node', target: false, loseResumeAck: true, width: 390, theme: 'dark', run: sourceResume, expectedConsole: /net::ERR_CONTENT_LENGTH_MISMATCH/ },
    { name: 'administrator-revoked-1280-light', runtime: 'node', target: true, width: 1280, theme: 'light', run: revokedAccess, expectedConsole: /403 \(Forbidden\)/ },
  ]) {
    fixture = createSupportedRecoveryFixture(scenario);
    const value = { name: scenario.name, runtime: scenario.runtime, target: scenario.target, status: 'running', errors: [], consoleErrors: [] };
    report.cases.push(value);
    const context = await browser.newContext({ viewport: { width: scenario.width, height: 900 }, colorScheme: scenario.theme });
    await context.addInitScript(theme => localStorage.setItem('sample-workflow-theme', theme), scenario.theme);
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => value.errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') value.consoleErrors.push(message.text()); });
    try {
      await page.goto(`${origin}/settings/data/system`);
      await page.getByRole('heading', { name: 'System backup and recovery', exact: true }).waitFor();
      await enabled(button(page, 'Preview system backup'));
      await scenario.run(page, value);
      value.geometry = await geometry(page); assert.equal(value.geometry.theme, scenario.theme);
      value.screenshot = `${scenario.name}.png`; await page.screenshot({ path: resolve(output, value.screenshot) });
      value.fullPageScreenshot = `${scenario.name}.full.png`;
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: resolve(output, value.fullPageScreenshot), fullPage: true });
      assert.deepEqual(value.errors, []);
      if (scenario.expectedConsole) {
        value.controlledNetworkErrors = value.consoleErrors.filter(message => scenario.expectedConsole.test(message));
        value.consoleErrors = value.consoleErrors.filter(message => !scenario.expectedConsole.test(message));
        assert(value.controlledNetworkErrors.length <= 1, 'Only the deliberate negative HTTP/transport response may appear in the console.');
      }
      assert.deepEqual(value.consoleErrors, []);
      assert(!fixture.journal.some(item => item.unexpected)); assert.deepEqual(serverErrors, []);
      value.journal = fixture.journal; value.fixtureFinalState = fixture.snapshot(); value.status = 'passed';
    } catch (error) {
      value.status = 'failed'; value.journal = fixture.journal; value.fixtureFinalState = fixture.snapshot();
      value.failureScreenshot = `${scenario.name}-failure.png`;
      await page.screenshot({ path: resolve(output, value.failureScreenshot), fullPage: true });
      throw error;
    } finally { await context.close(); }
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  if (browser) await browser.close();
  if (server?.listening) await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
  report.serverErrors = serverErrors; report.finishedAt = new Date().toISOString(); report.runtimeClosed = true;
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: report.status, cases: report.cases.map(({ name, status }) => ({ name, status })), report: resolve(output, 'report.json'), ...(report.error ? { error: report.error } : {}) })}\n`);
}
