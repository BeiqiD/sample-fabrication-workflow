// Actual built SPA + native module Worker + signed local Worker/D1/R2 APIs.
// The driver observes native Worker events and invokes real UI controls at an
// owned phase boundary. It never substitutes a worker, response, manifest or provider.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGenuinePackageRuntime } from './genuine-worker-package-runtime.mjs';
import { sha256 } from './genuine-worker-recovery-runtime.mjs';

const source = resolve(fileURLToPath(new URL('../../../', import.meta.url))), args = process.argv.slice(2);
assert(args.length === 2 && args[0] === '--output' && isAbsolute(args[1]),
  'Usage: node scripts/qa/phase5f/browser-full-content-export.mjs --output /tmp/NEW_OUTPUT');
assert(process.env.PLAYWRIGHT_MODULE_PATH && process.env.CHROMIUM_PATH, 'Use existing Playwright and Chromium paths; no downloads.');
const output = resolve(args[1]); await mkdir(output, { mode: 0o700 });
const report = { version: 1, source, output, startedAt: new Date().toISOString(), status: 'running', cases: [],
  helperSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
  scope: 'Local built Worker/SPA with 25 real migrations and all-public Sample/Project/PNG setup. Desktop cancels at the actual compression worker message; mobile enters Content archive through the real Settings overview and nested navigation, then navigates through the real Samples NavLink at an actual attachment-reading message. Both use the original native module Worker URL and retry to an independently verified V26 ZIP. No response/manifest/provider substitution, production access, natural scheduling, remote provider or peak-memory qualification. Native temporary downloads are removed when the browser context closes; no ZIP is copied into the output artifacts. Reports/screenshots contain no database, signing keys or private archives.' };
let owner, browser;

function observeWorkers(mode) {
  const NativeWorker = window.Worker, nativeCreateUrl = URL.createObjectURL, nativeRevokeUrl = URL.revokeObjectURL;
  const audit = { workers: [], objectUrls: [], revokedUrls: [], mode, armed: true, driverErrors: [] };
  window.__fullExportAudit = audit;
  URL.createObjectURL = function (...args) { const value = nativeCreateUrl.apply(this, args); audit.objectUrls.push(value); return value; };
  URL.revokeObjectURL = function (value) { audit.revokedUrls.push(value); return nativeRevokeUrl.call(this, value); };
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      const row = { url: new URL(String(url), location.href).href, type: options?.type, stages: [], terminated: false, faultTriggered: false };
      this.__exportAudit = row; audit.workers.push(row);
      this.addEventListener('message', event => {
        if (event.data?.type !== 'progress') return;
        const stage = event.data.progress.stage; if (row.stages.at(-1) !== stage) row.stages.push(stage);
        if (!audit.armed || (mode === 'cancel' ? stage !== 'compressing' : stage !== 'reading')) return;
        audit.armed = false; row.faultTriggered = true;
        const control = mode === 'cancel'
          ? [...document.querySelectorAll('button')].find(element => element.textContent.trim() === 'Cancel export')
          : document.querySelector('nav[aria-label="Primary navigation"] a[href="/samples"]');
        if (!control || control.disabled) { audit.driverErrors.push(`Missing enabled ${mode} UI control`); return; }
        control.click();
      });
    }
    terminate() { this.__exportAudit.terminated = true; return super.terminate(); }
  };
}

async function readback(bytes, manifest, fixture) {
  const code = `import sys,json,zipfile,hashlib,io
source=json.loads(sys.stdin.buffer.readline()); raw=sys.stdin.buffer.read()
with zipfile.ZipFile(io.BytesIO(raw)) as z:
 assert z.testzip() is None
 m=json.loads(z.read('export-manifest.json')); warnings=json.loads(z.read('export-warnings.json'))
 assert m['schemaVersion']==26 and m['archiveWriter']==1
 assert len(m['blobs'])==len(source['manifest']['blobs'])
 expected={'export-manifest.json','export-warnings.json'}
 for name,meta in m['tables'].items():
  data=z.read(meta['path']); expected.add(meta['path'])
  assert json.loads(data)==source['manifest']['tables'][name]
  assert len(data)==meta['byteSize'] and hashlib.sha256(data).hexdigest()==meta['sha256']
  assert len(json.loads(data))==meta['rowCount']
 for name,meta in m['artifacts'].items():
  data=z.read(meta['path']); expected.add(meta['path'])
  assert json.loads(data)==source['manifest']['artifacts'][name]['value']
  assert len(data)==meta['byteSize'] and hashlib.sha256(data).hexdigest()==meta['sha256']
 packaged=0; png=0; failed=[]
 for entry,original in zip(m['blobs'],source['manifest']['blobs']):
  assert entry['locatorId']==original['locatorId'] and 'downloadUrl' not in entry
  if entry['outcome']!='packaged':
   assert entry['path'] is None; failed.append(entry); continue
  expected.add(entry['path']); data=z.read(entry['path']); digest=hashlib.sha256(data).hexdigest(); packaged+=1
  assert entry['expectedByteSize'] is None or len(data)==entry['expectedByteSize']
  assert entry['expectedSha256'] is None or digest==entry['expectedSha256'].lower()
  if digest==source['fixture']['sha256']:
   assert len(data)==source['fixture']['byteSize']; png+=1
 assert png>=1
 assert len(warnings)==len(failed)
 for entry in failed:
  assert any(w['locatorId']==entry['locatorId'] and w['code']==entry['outcome'] for w in warnings)
 assert {x.filename for x in z.infolist() if not x.is_dir()}==expected
 print(json.dumps({'schemaVersion':m['schemaVersion'],'tablesCompared':len(m['tables']),'artifactsCompared':len(m['artifacts']),
  'packagedAssets':packaged,'exactFixturePngCopies':png,'warningCodes':[w['code'] for w in warnings],
  'tableRowsExact':True,'allDeclaredHashesAndCrcVerified':True,'closedZipInventory':True}))`;
  return await new Promise((accept, fail) => {
    const child = spawn('python3', ['-c', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); fail(new Error('Independent ZIP readback exceeded 20 seconds')); }, 20000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('close', status => { clearTimeout(timer); if (status !== 0) fail(new Error(`Independent ZIP readback failed: ${stderr}`)); else { try { accept(JSON.parse(stdout)); } catch (error) { fail(error); } } });
    child.stdin.on('error', error => { clearTimeout(timer); fail(error); });
    child.stdin.write(`${JSON.stringify({ manifest, fixture })}\n`); child.stdin.end(bytes);
  });
}

async function openContentArchive(page) {
  await page.getByRole('navigation', { name: 'Primary navigation', exact: true })
    .getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true, level: 1 }).waitFor();
  const navigation = page.getByRole('navigation', { name: 'Settings navigation', exact: true });
  const disclosure = navigation.getByRole('button', { name: /^Settings navigation/ });
  if (await disclosure.isVisible() && await disclosure.getAttribute('aria-expanded') !== 'true') {
    await disclosure.click();
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
  }
  await navigation.getByRole('link', { name: 'Content archive', exact: true }).click();
  await page.waitForURL('**/export');
  await page.getByRole('heading', { name: 'Content archive', exact: true, level: 1 }).waitFor();
}

async function qualify(context, value) {
  await context.addInitScript(theme => localStorage.setItem('sample-workflow-theme', theme), value.theme);
  await context.addInitScript(observeWorkers, value.mode);
  const page = await context.newPage(); page.setDefaultTimeout(25000);
  const downloads = [], nativeWorkers = [], nativeClosures = [], manifests = [], responseReads = [];
  value.pageErrors = []; value.api = [];
  page.on('pageerror', error => value.pageErrors.push(String(error)));
  page.on('download', download => downloads.push(download));
  page.on('worker', worker => { const row = { url: worker.url(), closed: false }; nativeWorkers.push(row);
    nativeClosures.push(new Promise(accept => { worker.on('close', () => { row.closed = true; accept(); }); })); });
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/')) value.api.push({ method: response.request().method(), path, status: response.status() });
    if (path === '/api/exports/all') responseReads.push(response.json().then(manifest => manifests.push(manifest)));
  });
  try {
    // Load the navigation target first so the owned unmount action is not
    // delayed by an unrelated first download of the Samples route module.
    await page.goto(`${owner.browserOrigin}${value.mode === 'unmount' ? '/samples' : '/export'}`);
    if (value.mode === 'unmount') {
      await page.getByRole('heading', { name: 'Samples', exact: true, level: 1 }).waitFor();
      await openContentArchive(page);
    }
    await page.getByRole('heading', { name: 'Content archive', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), value.theme);
    const graphBefore = await owner.graphFingerprint();
    await page.getByRole('button', { name: 'Download full ZIP', exact: true }).click();
    if (value.mode === 'cancel') await page.getByText('Export cancelled. You can start another export.', { exact: true }).waitFor();
    else { await page.waitForURL('**/samples'); await page.getByRole('heading', { name: 'Samples', exact: true, level: 1 }).waitFor(); }
    await page.waitForFunction(() => window.__fullExportAudit.workers[0]?.terminated);
    const first = await page.evaluate(() => structuredClone(window.__fullExportAudit));
    assert.equal(first.workers.length, 1); assert.equal(first.workers[0].type, 'module'); assert.equal(first.workers[0].faultTriggered, true);
    assert.equal(first.workers[0].terminated, true); assert.deepEqual(first.driverErrors, []); assert.deepEqual(first.objectUrls, []); assert.equal(downloads.length, 0);
    assert.match(new URL(first.workers[0].url).pathname, /\/assets\/full-export\.worker-[\w-]+\.js$/);
    // Wait for Chromium's own worker-close event before retry; a wrapper flag
    // alone does not prove the old worker stopped or its queued messages drained.
    await Promise.race([nativeClosures[0], new Promise((_, reject) => { setTimeout(() => reject(new Error('Original native worker did not close')), 25000).unref(); })]);
    assert.equal(nativeWorkers[0].url, first.workers[0].url); assert.equal(nativeWorkers[0].closed, true);
    if (value.mode === 'unmount') {
      await openContentArchive(page);
    }
    assert.equal(await page.getByRole('link', { name: 'Download prepared ZIP', exact: true }).count(), 0);
    await page.screenshot({ path: resolve(value.output, 'cancelled.png'), fullPage: true });
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download full ZIP', exact: true }).click();
    const download = await downloadPromise, chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    const bytes = Buffer.concat(chunks); assert.equal(await download.failure(), null);
    await page.getByRole('link', { name: 'Download prepared ZIP', exact: true }).waitFor();
    await Promise.all(responseReads);
    const audit = await page.evaluate(() => structuredClone(window.__fullExportAudit));
    assert.equal(downloads.length, 1); assert.equal(audit.workers.length, 2); assert(audit.workers.every(row => row.terminated));
    assert.equal(audit.objectUrls.length, 1); assert.deepEqual(audit.driverErrors, []);
    assert.equal(manifests.length, 2); assert(manifests.every(manifest => manifest.schemaVersion === 26));
    await Promise.race([Promise.all(nativeClosures), new Promise((_, reject) => { setTimeout(() => reject(new Error('Completed native worker did not close')), 25000).unref(); })]);
    assert(nativeWorkers.every(worker => worker.closed));
    const verified = await readback(bytes, manifests.at(-1), report.sourceFixture);
    assert.deepEqual(await owner.graphFingerprint(), graphBefore); assert.deepEqual(value.pageErrors, []);
    assert(value.api.every(row => row.method === 'GET' && row.status === 200));
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
    assert(geometry.width <= geometry.viewport + 1);
    await page.screenshot({ path: resolve(value.output, 'archive-ready.png'), fullPage: true });
    value.workerAudit = audit; value.nativeWorkers = nativeWorkers;
    value.archiveReadback = { ...verified, byteSize: bytes.length, sha256: sha256(bytes), privateArchiveCopiedToOutput: false };
    value.sourceGraphUnchanged = true; value.geometry = geometry; value.status = 'passed';
  } finally { await page.close(); }
}

try {
  const require = createRequire(import.meta.url), { chromium } = require(resolve(process.env.PLAYWRIGHT_MODULE_PATH));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  report.chromiumVersion = browser.version();
  owner = await startGenuinePackageRuntime(source, output, report);
  const assets = resolve(report.build.clientDirectory, 'assets'), names = (await readdir(assets)).filter(name => /^full-export\.worker-[\w-]+\.js$/.test(name));
  assert.equal(names.length, 1); report.build.fullExportWorker = { filename: names[0], sha256: sha256(await readFile(resolve(assets, names[0]))) };
  const pages = (await readdir(assets)).filter(name => /^ExportPage-[\w-]+\.js$/.test(name)); assert.equal(pages.length, 1);
  report.build.exportPage = { filename: pages[0], sha256: sha256(await readFile(resolve(assets, pages[0]))) };
  report.sourceInputs = {};
  for (const path of ['src/lib/exportAll.ts', 'src/lib/full-export-archive.ts', 'src/lib/full-export-safety.ts',
    'src/lib/full-export-worker-client.ts', 'src/lib/api.ts', 'src/workers/full-export.worker.ts', 'src/pages/ExportPage.tsx']) {
    report.sourceInputs[path] = sha256(await readFile(resolve(source, path)));
  }
  await owner.setup();
  owner.browserOrigin = await owner.startBrowserAccessProxy();
  for (const scenario of [{ name: 'desktop-compression-cancel', width: 1280, theme: 'light', mode: 'cancel' },
    { name: 'mobile-unmount-cancel', width: 390, theme: 'dark', mode: 'unmount' }]) {
    const value = { ...scenario, output: resolve(output, scenario.name), status: 'running' }; report.cases.push(value);
    await mkdir(value.output, { mode: 0o700 });
    const context = await browser.newContext({ viewport: { width: value.width, height: 900 }, colorScheme: value.theme, acceptDownloads: true });
    try { await qualify(context, value); } finally { await context.close(); }
  }
  assert.deepEqual(report.edge.errors, []); report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1;
  if (report.cases.at(-1)?.status === 'running') report.cases.at(-1).status = 'failed';
  if (process.env.GITHUB_ACTIONS === 'true') {
    const tail = (report.cases.at(-1)?.api ?? report.api ?? []).slice(-5).map(({ method, path, status }) => ({ method, path, status }));
    const diagnostic = `${report.cases.at(-1)?.name ?? 'public source setup'}: ${report.error}\nLast API responses: ${JSON.stringify(tail)}`;
    process.stdout.write(`::error title=Built full ZIP qualification::${diagnostic.slice(0, 12000).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}\n`);
  }
} finally {
  if (owner) await owner.close(); if (browser) await browser.close();
  report.browserClosed = !browser || !browser.isConnected(); report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: report.status, report: resolve(output, 'report.json'), ...(report.error ? { error: report.error } : {}) })}\n`);
}
