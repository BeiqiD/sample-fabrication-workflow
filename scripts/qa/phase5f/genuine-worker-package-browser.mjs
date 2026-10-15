import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { checkedResearchExportInput, checkedResearchImportInput, checkedResearchPackagePreview,
  checkedResearchRequestReceipt, checkedResearchUploadInput } from '../../../shared/contracts/research-package-api.ts';
import { sha256 } from './genuine-worker-recovery-runtime.mjs';
import { packageBase } from './genuine-worker-package-runtime.mjs';

const execute = promisify(execFile), button = (page, name) => page.getByRole('button', { name, exact: true });
async function enabled(locator) { await locator.waitFor(); await locator.page().waitForFunction(element => !element.disabled, await locator.elementHandle()); return locator; }
async function keyboard(page, locator) { await enabled(locator); await locator.focus(); await page.keyboard.press('Enter'); }
const article = (page, jobId) => page.locator('.research-package-job').filter({ has: page.getByText(jobId, { exact: true }) });
async function responseAfter(page, path, method, action, expected = 200) {
  const wait = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
  void wait.catch(() => {}); await action(); const response = await wait; assert.equal(response.status(), expected, `${method} ${path}`); return response;
}
async function capture(page, owner, name) {
  await page.evaluate(() => scrollTo(0, 0));
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth, theme: document.documentElement.dataset.theme }));
  assert(geometry.width <= geometry.viewport + 1, `Package horizontal overflow: ${JSON.stringify(geometry)}`);
  await page.screenshot({ path: resolve(owner.output, `${name}.png`), fullPage: true }); return { geometry, screenshot: `${name}.png` };
}
async function checkpoint(page, key) { return page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), key); }
async function readReceipt(owner, input, kind) {
  const receipt = checkedResearchRequestReceipt(await owner.request(`${packageBase}/requests/${input.requestId}`));
  assert.equal(receipt.requestId, input.requestId); assert.equal(receipt.job.kind, kind);
  if (!receipt.reused) assert.equal(receipt.job.requestId, input.requestId);
  return receipt;
}
async function acceptedClient(page, receipt, input) {
  await article(page, receipt.job.id).waitFor();
  await page.waitForFunction(() => sessionStorage.getItem('research-package-operation') === null);
  const checkpoints = await checkpoint(page, 'research-package-receipts');
  assert(checkpoints.some(row => row.requestId === receipt.requestId && row.jobId === receipt.job.id && row.reused === receipt.reused));
  const history = await checkpoint(page, 'research-package-earlier-requests');
  const earlier = history.find(row => row.intent.input.requestId === input.requestId); assert(earlier);
  assert.deepEqual(earlier.intent.input, input); assert.equal(earlier.receipt.job.id, receipt.job.id); assert.equal(earlier.receipt.requestId, input.requestId);
  if (receipt.job.kind === 'upload') {
    const saved = await checkpoint(page, 'research-package-upload'); assert.equal(saved.jobId, receipt.job.id); assert.equal(saved.input.requestId, receipt.requestId); return;
  }
  await page.getByText(receipt.reused ? 'An existing saved import was returned. This request did not create another research copy.'
    : 'Operation saved. You may leave this page; the independent executor owns its progress.', { exact: true }).waitFor();
}
async function acceptAfter(page, owner, path, kind, action) {
  const response = await responseAfter(page, path, 'POST', action, 202), raw = response.request().postDataJSON();
  const input = kind === 'upload' ? checkedResearchUploadInput(raw) : kind === 'import' ? checkedResearchImportInput(raw) : checkedResearchExportInput(raw);
  const receipt = await readReceipt(owner, input, kind); await acceptedClient(page, receipt, input); return { input, receipt };
}
async function refresh(page) { await keyboard(page, button(page, 'Refresh status')); await enabled(button(page, 'Refresh status')); }
async function archiveReadback(path, bytes, fixture, bootstrap) {
  // Independent standard ZIP reader: actual download only, no format/output fixture.
  const code = `import sys,json,zipfile,hashlib\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n assert all(x.compress_type==zipfile.ZIP_STORED for x in z.infolist())\n m=json.loads(z.read('manifest.json')); r=json.loads(z.read('records.json'))\n assert hashlib.sha256(z.read('records.json')).hexdigest()==m['recordsSha256']\n print(json.dumps({'manifest':m,'records':r,'entries':[{'path':x.filename,'byteSize':x.file_size,'sha256':hashlib.sha256(z.read(x)).hexdigest()} for x in z.infolist()]}))`;
  const result = await execute('python3', ['-c', code, path], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }), archive = JSON.parse(result.stdout);
  assert.equal(archive.manifest.schema, 'research-package/1'); assert.equal(archive.records.schema, 'research-records/1');
  assert.equal(archive.manifest.completeness, 'complete'); assert.equal(archive.manifest.kind, 'data_package');
  assert.deepEqual(archive.manifest.roots, fixture.roots); assert.equal(archive.manifest.files.length, 1);
  assert.equal(archive.manifest.counts.files, 1); assert.equal(archive.manifest.counts.bytes, fixture.byteSize);
  assert.equal(archive.manifest.counts.records, archive.records.records.length); assert(archive.records.records.length >= 10);
  assert(archive.records.records.every(row => ![bootstrap.sampleId, bootstrap.submissionId, bootstrap.itemId].includes(row.sourceId)));
  const file = archive.manifest.files[0]; assert.equal(file.sha256, fixture.sha256); assert.equal(file.byteSize, fixture.byteSize);
  assert.equal(archive.entries.find(row => row.path === file.path)?.sha256, fixture.sha256);
  assert.deepEqual(archive.entries.map(row => row.path).sort(), ['manifest.json', 'records.json', 'report/index.html', 'report/report.md', file.path].sort());
  return { ...archive, byteSize: bytes.length, sha256: sha256(bytes) };
}
async function lostImport(page, owner, value) {
  owner.armLostImportAck();
  const response = await responseAfter(page, `${packageBase}/imports`, 'POST', () => keyboard(page, button(page, 'Import research copy')), 202);
  const input = checkedResearchImportInput(response.request().postDataJSON());
  await enabled(page.getByRole('button', { name: 'Check original package request', exact: true }));
  assert.deepEqual(await checkpoint(page, 'research-package-operation'), { action: 'import', input });
  assert.equal(await checkpoint(page, 'research-package-operation-rejection'), null);
  assert.equal(await page.getByRole('button', { name: 'Review a new package request', exact: true }).count(), 0);
  assert(await button(page, 'Import research copy').isDisabled());
  const receipt = await readReceipt(owner, input, 'import'); assert.equal(receipt.reused, false);
  const native = await owner.rows('SELECT id,request_id,actor,input_json,accepted_at FROM research_package_jobs WHERE id=?', [receipt.job.id]);
  assert.equal(native.length, 1); assert.deepEqual(JSON.parse(native[0].input_json), input); assert.equal(native[0].actor, owner.actor);
  assert.equal(value.edge.lostAcknowledgements.length, 1); assert.equal(value.edge.lostAcknowledgements[0].jobId, receipt.job.id);
  const check = page.getByRole('button', { name: 'Check original package request', exact: true }); await check.focus();
  assert(await check.evaluate(element => element === document.activeElement && getComputedStyle(element).outlineStyle !== 'none'));
  value.pendingScreenshot = await capture(page, owner, 'actual-committed-import-ack-lost');
  const wait = page.waitForResponse(response => new URL(response.url()).pathname === `${packageBase}/requests/${input.requestId}` && response.request().method() === 'GET');
  void wait.catch(() => {}); await page.reload(); assert.equal((await wait).status(), 200); await acceptedClient(page, receipt, input);
  assert.deepEqual(await owner.rows('SELECT id,request_id,actor,input_json,accepted_at FROM research_package_jobs WHERE id=?', [receipt.job.id]), native);
  assert.equal(value.edge.requests.filter(row => row.method === 'POST' && row.path === `${packageBase}/imports`).length, 1);
  value.ackRecovery = { input, jobId: receipt.job.id, actualNativeCommitBeforeTransportLoss: true, reloadOnlyOriginalGet: true,
    nativeIdentityInputAndAcceptedAtUnchanged: true, oneImportPost: true, unknownCheckpointRetainedUntilCheckedReceipt: true };
  return { input, receipt };
}
async function readonlyNavigation(page, owner, value, job, copied) {
  const before = value.edge.requests.filter(row => row.method !== 'GET').length, graph = await owner.graphFingerprint();
  await keyboard(page, article(page, job.id).getByRole('link', { name: 'Open imported sample', exact: true }));
  assert.equal(new URL(page.url()).pathname, `/samples/${copied.freshSampleId}`);
  await page.getByRole('heading', { name: value.sourceFixture.sampleTitle, exact: true, level: 1 }).waitFor();
  await page.goto(`${owner.browserOrigin}/settings/data`); await article(page, job.id).getByText('Research copy published.', { exact: true }).waitFor();
  await keyboard(page, article(page, job.id).getByRole('link', { name: 'Open imported project', exact: true }));
  assert.equal(new URL(page.url()).pathname, `/projects/${copied.freshProjectId}`);
  await page.locator('header[aria-label="Project workspace controls"]').getByRole('heading', { level: 1 }).waitFor();
  if (value.width >= 1000) await keyboard(page, page.getByRole('group', { name: 'Project view', exact: true }).getByRole('button', { name: 'Reading', exact: true }));
  const reading = page.getByRole('region', { name: 'Project Reading', exact: true }); await reading.waitFor();
  await reading.getByRole('heading', { name: 'Genuine Package research', exact: true }).waitFor();
  await reading.getByRole('heading', { name: value.sourceFixture.sampleTitle, exact: true }).waitFor();
  assert.equal(await reading.getByRole('link', { name: 'Open source', exact: true }).getAttribute('href'), `/samples/${copied.freshSampleId}`);
  const image = reading.getByRole('img', { name: 'Exact original research PNG', exact: true }); await image.scrollIntoViewIfNeeded();
  await page.waitForFunction(element => element.complete && element.naturalWidth === 1 && element.naturalHeight === 1, await image.elementHandle());
  assert.equal(new URL(await image.getAttribute('src'), owner.browserOrigin).pathname, `/api/projects/${copied.freshProjectId}/contents/${copied.copiedAttachmentContentId}/file`);
  await page.goto(`${owner.browserOrigin}/settings/data`); await article(page, job.id).getByText('Research copy published.', { exact: true }).waitFor();
  await keyboard(page, page.locator('.research-package-navigation').getByRole('link', { name: 'Storage settings', exact: true }));
  await page.getByRole('heading', { name: 'Storage', exact: true, level: 1 }).waitFor();
  await page.goto(`${owner.browserOrigin}/settings/storage/migrations`); await page.getByRole('heading', { name: 'File migrations', exact: true, level: 1 }).waitFor();
  await page.goto(`${owner.browserOrigin}/settings/data`); await article(page, job.id).getByText('Research copy published.', { exact: true }).waitFor();
  await refresh(page); assert.equal(value.edge.requests.filter(row => row.method !== 'GET').length, before);
  assert.deepEqual(await owner.graphFingerprint(), graph);
  value.readonlyContinuity = { importedSampleOpened: copied.freshSampleId, importedProjectOpened: copied.freshProjectId,
    importedProjectReadingMarkdownAndRemappedReferenceVisible: true, importedPngDecodedAtCopiedPublicUrl: true,
    storageAndMigrationVisited: true, originalImportReopened: job.id, mutationCount: 0, graphUnchanged: true };
}
export async function qualifyGenuinePackageBrowser(owner, context, value) {
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  value.pageErrors = []; value.consoleErrors = []; value.browserApi = [];
  page.on('pageerror', error => value.pageErrors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') value.consoleErrors.push({ text: message.text(), path: new URL(message.location().url || owner.browserOrigin).pathname }); });
  page.on('response', response => { const request = response.request(), path = new URL(response.url()).pathname;
    if (path.startsWith('/api/')) value.browserApi.push({ method: request.method(), path, status: response.status() }); });
  await page.route('**/*', async route => { assert.equal(new URL(route.request().url()).origin, owner.browserOrigin); await route.continue(); });
  try {
    await page.goto(`${owner.browserOrigin}/settings/data`); await page.getByRole('heading', { name: 'Data', exact: true, level: 1 }).waitFor();
    await page.getByLabel('Sample and Project roots', { exact: true }).fill(value.sourceFixture.roots.map(root => `${root.kind}:${root.id}`).join('\n'));
    const preview = button(page, 'Preview export'); await responseAfter(page, `${packageBase}/plans`, 'POST', () => keyboard(page, preview));
    await enabled(button(page, 'Start data package export')); assert(await preview.evaluate(element => element === document.activeElement));
    const exported = await acceptAfter(page, owner, `${packageBase}/jobs`, 'data_package', () => keyboard(page, button(page, 'Start data package export')));
    const finishedExport = await owner.scheduleUntil(exported.receipt.job.id); assert(finishedExport.output?.available); await refresh(page);
    const exportArticle = article(page, finishedExport.id); await exportArticle.getByText('Export source research.', { exact: true }).waitFor();
    assert.equal(await exportArticle.getByText('Research copy published.', { exact: true }).count(), 0);
    assert.equal(await exportArticle.getByRole('link', { name: /^Open imported / }).count(), 0);
    for (const root of value.sourceFixture.roots) assert.equal(await exportArticle.getByRole('link', { name: `Open source ${root.kind}`, exact: true }).getAttribute('href'), `/${root.kind === 'sample' ? 'samples' : 'projects'}/${root.id}`);
    value.exportSourceScopeTruthful = true;
    const download = page.waitForEvent('download'); void download.catch(() => {});
    await keyboard(page, article(page, finishedExport.id).getByRole('link', { name: 'Download data package', exact: true }));
    const downloaded = await download; assert.equal(await downloaded.failure(), null);
    const path = resolve(owner.output, 'actual-downloaded-research-package.zip'); await downloaded.saveAs(path); const bytes = await readFile(path);
    assert.equal(bytes.length, finishedExport.output.byteSize); assert.equal(sha256(bytes), finishedExport.output.sha256);
    const archive = await archiveReadback(path, bytes, value.sourceFixture, value.bootstrap);
    await page.getByLabel('Native package ZIP', { exact: true }).setInputFiles(path);
    const uploadWait = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/upload') && response.request().method() === 'PUT'); void uploadWait.catch(() => {});
    const uploaded = await acceptAfter(page, owner, `${packageBase}/uploads`, 'upload', () => keyboard(page, button(page, 'Upload and validate package')));
    assert.equal((await uploadWait).status(), 200); await page.getByText('Package uploaded. Validation is saved independently of this page.', { exact: true }).waitFor();
    assert.equal(uploaded.input.sha256, archive.sha256); assert.equal(uploaded.input.byteSize, archive.byteSize);
    await owner.scheduleUntil(uploaded.receipt.job.id, 'preview'); await refresh(page);
    await enabled(button(page, 'Import research copy'));
    const suffix = await page.getByLabel('Imported name suffix', { exact: true }).inputValue();
    const importPreview = checkedResearchPackagePreview(await owner.request(`${packageBase}/jobs/${uploaded.receipt.job.id}/preview?suffix=${encodeURIComponent(suffix)}`));
    assert.equal(importPreview.complete, true); assert.equal(importPreview.counts.files, 1); assert.equal(importPreview.capabilities.dataPackage.available, true);
    assert.deepEqual(importPreview.counts, archive.manifest.counts); assert.equal(importPreview.existingImportJobId, null);
    assert.deepEqual(importPreview.source, { installationId: archive.manifest.sourceInstallationId, packageId: archive.manifest.packageId, payloadSha256: archive.sha256 });
    assert.equal(importPreview.rolePolicyRevision, value.sourceFixture.rolePolicyRevision); assert(importPreview.targets.every(target => target.profileId === value.sourceFixture.profileId && target.available));
    assert(importPreview.naming?.conflicts.length >= 2); value.previewScreenshot = await capture(page, owner, 'actual-package-copy-preview');
    const imported = value.loseImportAck ? await lostImport(page, owner, value) : await acceptAfter(page, owner, `${packageBase}/imports`, 'import', () => keyboard(page, button(page, 'Import research copy')));
    assert.equal(imported.input.naming.suffix, suffix); assert.equal(imported.input.expectedRolePolicyRevision, importPreview.rolePolicyRevision);
    const acceptedScope = checkedResearchPackagePreview(await owner.request(`${packageBase}/jobs/${imported.receipt.job.id}/preview`));
    assert.deepEqual(acceptedScope.naming, importPreview.naming); assert.deepEqual(acceptedScope.targets, importPreview.targets);
    assert.equal(acceptedScope.rolePolicyRevision, importPreview.rolePolicyRevision); assert.deepEqual(acceptedScope.source, importPreview.source);
    value.acceptedScope = acceptedScope;
    const completed = await owner.scheduleUntil(imported.receipt.job.id); assert(completed.result?.roots.length === 2); await refresh(page);
    await article(page, completed.id).getByText('Research copy published.', { exact: true }).waitFor();
    const copied = await owner.verifyCopy(completed.id, archive);
    await keyboard(page, article(page, completed.id).getByRole('button', { name: 'View accepted scope', exact: true }));
    await page.getByRole('heading', { name: 'Accepted import scope', exact: true }).waitFor();
    await page.getByText(`Accepted destination policy revision: ${value.sourceFixture.rolePolicyRevision}.`, { exact: true }).waitFor();
    await readonlyNavigation(page, owner, value, completed, copied);
    if (!value.loseImportAck) {
      const graph = await owner.graphFingerprint(), jobsBefore = await owner.rows("SELECT id,request_id,input_json,accepted_at FROM research_package_jobs WHERE kind='import' ORDER BY id");
      await enabled(button(page, 'Open existing import'));
      const reused = await acceptAfter(page, owner, `${packageBase}/imports`, 'import', () => keyboard(page, button(page, 'Open existing import')));
      assert.equal(reused.receipt.reused, true); assert.equal(reused.receipt.job.id, completed.id); assert.equal(reused.receipt.job.requestId, imported.input.requestId);
      assert.notEqual(reused.input.requestId, imported.input.requestId);
      assert.deepEqual(await owner.graphFingerprint(), graph);
      assert.deepEqual(await owner.rows("SELECT id,request_id,input_json,accepted_at FROM research_package_jobs WHERE kind='import' ORDER BY id"), jobsBefore);
      value.existingImportReuse = { input: reused.input, receipt: reused.receipt, noNewImportJobOrGraph: true, graphSha256: graph.sha256 };
    }
    await enabled(button(page, 'Refresh status')); value.finalScreenshot = await capture(page, owner, 'actual-published-package-copy');
    assert.equal(value.finalScreenshot.geometry.theme, value.theme); assert.deepEqual(value.pageErrors, []); assert.deepEqual(value.edge.errors, []);
    const expectedConsole = value.consoleErrors.filter(row => value.loseImportAck && row.path === `${packageBase}/imports` && /ERR_CONTENT_LENGTH_MISMATCH/.test(row.text));
    assert.deepEqual(value.consoleErrors.filter(row => !expectedConsole.includes(row)), []); value.expectedTransportConsole = expectedConsole;
    const mutations = value.edge.requests.filter(row => row.method !== 'GET');
    assert.deepEqual(mutations.map(row => [row.method, row.path]), [['POST', `${packageBase}/plans`], ['POST', `${packageBase}/jobs`], ['POST', `${packageBase}/uploads`],
      ['PUT', `${packageBase}/jobs/${uploaded.receipt.job.id}/upload`], ['POST', `${packageBase}/imports`], ...(!value.loseImportAck ? [['POST', `${packageBase}/imports`]] : [])]);
    assert.equal((await owner.rows("SELECT id FROM research_package_jobs WHERE kind='import'")).length, 1);
    value.browserMutations = mutations; value.result = { exported, uploaded, imported, completed, archive, importPreview }; value.status = 'passed';
  } catch (error) { await page.screenshot({ path: resolve(owner.output, 'browser-failure.png'), fullPage: true }); throw error; }
}
