import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256 } from './genuine-worker-recovery-runtime.mjs';
import { checkedSystemRecoveryBackupInput, checkedSystemRecoveryUploadInput, checkedSystemRecoveryImportInput,
  checkedSystemRecoveryReceipt } from '../../../shared/contracts/system-recovery.ts';

const base = '/api/system-recovery';
const button = (page, name) => page.getByRole('button', { name, exact: true });
async function enabled(locator) {
  await locator.waitFor(); await locator.page().waitForFunction(element => !element.disabled, await locator.elementHandle()); return locator;
}
async function keyboard(page, locator) { await enabled(locator); await locator.focus(); await page.keyboard.press('Enter'); }
async function capture(page, root, name) {
  const layout = await page.evaluate(() => {
    const geometry = { viewport: innerWidth, width: document.documentElement.scrollWidth, theme: document.documentElement.dataset.theme };
    const selector = element => `${element.tagName.toLowerCase()}${[...element.classList].slice(0, 3).map(value => `.${value}`).join('')}`.slice(0, 140);
    const bounds = element => {
      const rect = element.getBoundingClientRect(), offset = getComputedStyle(element).position === 'fixed' ? 0 : scrollX;
      return { left: Math.round((rect.left + offset) * 10) / 10, right: Math.round((rect.right + offset) * 10) / 10, width: Math.round(rect.width * 10) / 10 };
    };
    const describe = element => {
      const style = getComputedStyle(element);
      return { selector: selector(element), ...bounds(element), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        display: style.display, position: style.position, overflowX: style.overflowX, whiteSpace: style.whiteSpace,
        minWidth: style.minWidth, maxWidth: style.maxWidth, flexShrink: style.flexShrink,
        fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight };
    };
    const clippedInsideViewport = element => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(parent).overflowX)) {
          const rect = bounds(parent);
          if (rect.left >= -1 && rect.right <= innerWidth + 1) return true;
        }
      }
      return false;
    };
    const candidates = [...document.body.querySelectorAll('*')].filter(element => {
      const rect = element.getBoundingClientRect(), box = bounds(element);
      return rect.width > 0 && rect.height > 0 && (box.right > innerWidth + 1 || box.left < -1) && !clippedInsideViewport(element);
    }).sort((left, right) => bounds(left).width - bounds(right).width).slice(0, 6).map(element => ({ ...describe(element),
      ancestors: [element.parentElement, element.parentElement?.parentElement].filter(Boolean).map(describe) }));
    const bodyStyle = getComputedStyle(document.body), canvas = document.createElement('canvas'), context = canvas.getContext('2d');
    context.font = bodyStyle.font;
    return { geometry, documentClientWidth: document.documentElement.clientWidth, scrollX, devicePixelRatio,
      bodyFont: bodyStyle.font, resumeUploadTextWidth: context.measureText('Resume original recovery upload').width,
      candidates, controls: [...document.querySelectorAll('.system-recovery-page button, .system-recovery-page select, .system-recovery-page input[type=file]')]
        .filter(element => !clippedInsideViewport(element)).slice(0, 18).map(describe) };
  });
  const { geometry } = layout;
  assert(geometry.width <= geometry.viewport + 1, `Page horizontal overflow: ${JSON.stringify(layout)}`);
  await page.screenshot({ path: resolve(root, `${name}.png`) });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: resolve(root, `${name}.full.png`), fullPage: true });
  return { geometry, layout, viewport: `${name}.png`, fullPage: `${name}.full.png` };
}
async function responseAfter(page, path, method, operation, expectedStatus = 200) {
  const wait = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
  // A failed action still closes the owning context; consume that wait rejection.
  void wait.catch(() => {});
  await operation(); const response = await wait;
  assert.equal(response.status(), expectedStatus, `${method} ${path}: HTTP ${response.status()}`);
  return response;
}
async function acceptedAfter(page, owner, value, path, kind, operation) {
  const response = await responseAfter(page, path, 'POST', operation, 202);
  const rawInput = response.request().postDataJSON();
  const input = kind === 'backup' ? checkedSystemRecoveryBackupInput(rawInput)
    : kind === 'upload' ? checkedSystemRecoveryUploadInput(rawInput) : checkedSystemRecoveryImportInput(rawInput);
  // The real client validates the original ACK. Exact signed receipt reads
  // supply observer metadata without depending on Chromium's inspector cache.
  const receipt = checkedSystemRecoveryReceipt(await owner.request(`${base}/requests/${encodeURIComponent(input.requestId)}`));
  assert.equal(receipt.requestId, input.requestId); assert.equal(receipt.job.requestId, input.requestId);
  assert.equal(receipt.job.kind, kind); assert.equal(receipt.reused, true);
  await page.locator('.system-recovery-job').filter({ has: page.getByText(receipt.job.id, { exact: true }) }).waitFor();
  await page.waitForFunction(() => sessionStorage.getItem('system-recovery-operation') === null);
  if (kind === 'upload') {
    const checkpoint = await page.evaluate(() => JSON.parse(sessionStorage.getItem('system-recovery-upload')));
    assert.deepEqual(checkpoint, { input, jobId: receipt.job.id });
  } else await page.getByText('Operation saved.', { exact: false }).waitFor();
  (value.originalRequestReceipts ??= []).push({ requestId: input.requestId, jobId: receipt.job.id, kind,
    originalBrowserStatus: response.status(), exactSignedReceiptRead: true, checkedClientJobVisible: true, clientIntentCleared: true });
  return receipt;
}
async function download(page, link, path) {
  const wait = page.waitForEvent('download'); void wait.catch(() => {});
  await keyboard(page, link); const value = await wait;
  assert.equal(await value.failure(), null); await value.saveAs(path); return readFile(path);
}
async function crosspageContinuity(page, owner, value, recoveryId, archiveSha256) {
  const before = value.browserApi.filter(item => item.method !== 'GET').length;
  await page.locator('.system-recovery-navigation').getByRole('link', { name: 'Storage settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Storage', exact: true, level: 1 }).waitFor();
  await page.getByText('Connection not checked', { exact: true }).first().waitFor();
  await page.getByText('Read and write', { exact: true }).waitFor();
  await page.getByText('Available in the current configuration', { exact: true }).waitFor();
  await page.getByText('Upload destination changes are unavailable while file access is paused or historical file authority is active.', { exact: true }).waitFor();
  await page.goto(`${owner.browserOrigin}/settings/storage/migrations`);
  await page.getByRole('heading', { name: 'File migrations', exact: true, level: 1 }).waitFor();
  await page.getByText('Paused.', { exact: true }).waitFor();
  await page.getByText('No published Files are available for migration.', { exact: true }).waitFor();
  await page.getByText('No migrations have been accepted.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Storage settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Storage', exact: true, level: 1 }).waitFor();
  await page.getByRole('link', { name: 'Data packages, reports and import', exact: true }).click();
  await page.getByRole('heading', { name: 'Data', exact: true, level: 1 }).waitFor();
  await page.getByText('Execution is paused.', { exact: true }).waitFor();
  await page.getByText('No package jobs are recorded for your account.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'System backup and recovery', exact: true }).click();
  await page.getByRole('heading', { name: 'System backup and recovery', exact: true, level: 1 }).waitFor();
  const saved = page.locator('.system-recovery-job').filter({ has: page.getByText(recoveryId, { exact: true }) });
  await saved.getByText('verified and ready for cutover review', { exact: false }).waitFor();
  await keyboard(page, saved.getByRole('button', { name: 'View recovery report', exact: true }));
  await page.getByRole('link', { name: 'Download verified recovery report', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Complete backup', exact: true }).waitFor();
  await page.getByText(archiveSha256, { exact: true }).waitFor();
  assert.equal(value.browserApi.filter(item => item.method !== 'GET').length, before);
  value.crosspageContinuity = { sourceAuthorityMode: value.sourceFixture.authorityMode, storageRegisteredR2ReadWrite: true,
    historicalUploadDefaultsDisabled: true, fileMigrationExecutorPaused: true, packageExecutorPaused: true,
    originalRecoveryJobReopened: recoveryId, originalArchiveSha256: archiveSha256, newMutations: 0 };
}
export async function qualifyGenuineRecoveryBrowser(owner, context, value) {
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  value.browserApi = []; value.pageErrors = []; value.consoleErrors = [];
  page.on('pageerror', error => value.pageErrors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') value.consoleErrors.push(message.text()); });
  page.on('response', response => {
    const request = response.request(), path = new URL(response.url()).pathname;
    if (!path.startsWith('/api/')) return;
    value.browserApi.push({ method: request.method(), path, status: response.status(),
      ...(request.headers()['content-type'] === 'application/json' && request.postData() ? { input: request.postDataJSON() } : {}) });
  });
  await page.route('**/*', async route => {
    assert.equal(new URL(route.request().url()).origin, owner.browserOrigin, 'Browser may only contact its owned local forwarding edge.');
    await route.continue();
  });
  try {
    await page.goto(`${owner.browserOrigin}/settings/data/system`);
    await page.getByRole('heading', { name: 'System backup and recovery', exact: true }).waitFor();
    await responseAfter(page, `${base}/executor`, 'POST', () => keyboard(page, button(page, 'Enable system recovery executor')));
    await enabled(button(page, 'Disable system recovery executor'));
    const previewButton = button(page, 'Preview system backup');
    await responseAfter(page, `${base}/backup-preview`, 'GET', () => keyboard(page, previewButton));
    await enabled(button(page, 'Start durable system backup'));
    assert(await previewButton.evaluate(element => element === document.activeElement));
    value.backupPreviewKeyboardFocus = true;
    const backupReceipt = await acceptedAfter(page, owner, value, `${base}/jobs`, 'backup', () => keyboard(page, button(page, 'Start durable system backup')));
    const backup = await owner.scheduleUntil(backupReceipt.job.id, 'completed'); assert(backup.output?.available);
    await keyboard(page, button(page, 'Refresh recovery status'));
    const backupArticle = page.locator('.system-recovery-job').filter({ has: page.getByText(backup.id, { exact: true }) });
    const archivePath = resolve(owner.output, 'actual-downloaded-backup.zip');
    const archive = await download(page, backupArticle.getByRole('link', { name: 'Download system backup', exact: true }), archivePath);
    assert.equal(archive.length, backup.output.byteSize); assert.equal(sha256(archive), backup.output.sha256);
    await page.getByLabel('System recovery ZIP').setInputFiles(archivePath);
    const uploaded = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/upload') && response.request().method() === 'PUT');
    void uploaded.catch(() => {});
    const uploadReceipt = await acceptedAfter(page, owner, value, `${base}/uploads`, 'upload', () => keyboard(page, button(page, 'Upload and validate recovery archive')));
    const uploadResponse = await uploaded; assert(uploadResponse.ok());
    // The real client validates the PUT receipt. Chromium may evict a binary
    // upload's inspector body; do not depend on a second CDP body read.
    await page.getByText('Archive bytes accepted.', { exact: false }).waitFor();
    await owner.scheduleUntil(uploadReceipt.job.id, 'preview');
    await keyboard(page, button(page, 'Refresh recovery status'));
    await page.getByRole('heading', { name: 'Recovery report', exact: true }).waitFor();
    const preview = await owner.request(`${base}/jobs/${uploadReceipt.job.id}/preview`);
    assert.equal(preview.archive.schema, 'system-backup/3'); assert.equal(preview.archive.complete, true);
    assert(preview.counts.files >= 1 && preview.counts.rows >= 1 && preview.profiles.length >= 1); assert.equal(preview.canRecover, true);
    const stage = button(page, 'Stage isolated recovery'); assert(await stage.isDisabled());
    await page.getByLabel('I understand that this recovers the archive recovery point and does not include later source changes.').check();
    assert(await stage.isDisabled(), 'Actual Worker recovery must wait for explicit mappings.');
    for (const profile of preview.profiles) {
      await page.getByLabel(`Destination for ${profile.id}`, { exact: true }).fill(value.sourceFixture.profileId);
      await page.getByLabel(`Revision for ${profile.id}`, { exact: true }).fill('1');
    }
    await enabled(stage); value.mappingScreenshot = await capture(page, owner.output, 'actual-explicit-mapping');
    const recoveryReceipt = await acceptedAfter(page, owner, value, `${base}/recoveries`, 'recovery', () => keyboard(page, stage));
    const recovery = await owner.scheduleUntil(recoveryReceipt.job.id, 'completed'); assert.equal(recovery.result?.ready, true); assert.equal(recovery.result.cutover, false);
    await keyboard(page, button(page, 'Refresh recovery status'));
    const recoveryArticle = page.locator('.system-recovery-job').filter({ has: page.getByText(recovery.id, { exact: true }) });
    await keyboard(page, recoveryArticle.getByRole('button', { name: 'View recovery report', exact: true }));
    const reportPath = resolve(owner.output, 'actual-downloaded-recovery-report.json');
    const reportBytes = await download(page, page.getByRole('link', { name: 'Download verified recovery report', exact: true }), reportPath);
    const publicReport = JSON.parse(reportBytes.toString('utf8'));
    assert.equal(publicReport.schema, 'system-recovery-public-report/1'); assert.equal(publicReport.jobId, recovery.id);
    assert.equal(publicReport.handoff.automaticBindingChange, false); assert(Object.values(publicReport.execution).every(flag => flag === false));
    assert(publicReport.counts.files >= 1 && publicReport.counts.originalRows >= 1); assert.equal(publicReport.targetCheckpoint, recovery.result.checkpoint);
    await owner.verifyRecovery(recovery.id, publicReport);
    await crosspageContinuity(page, owner, value, recovery.id, backup.output.sha256);
    value.finalScreenshot = await capture(page, owner.output, 'actual-verified-recovery-report');
    assert.equal(value.mappingScreenshot.geometry.theme, value.theme); assert.equal(value.finalScreenshot.geometry.theme, value.theme);
    assert.deepEqual(value.pageErrors, []); assert.deepEqual(value.consoleErrors, []);
    const mutations = value.browserApi.filter(item => item.method !== 'GET');
    assert.deepEqual(mutations.map(item => [item.method, item.path]), [
      ['POST', `${base}/executor`], ['POST', `${base}/jobs`], ['POST', `${base}/uploads`],
      ['PUT', `${base}/jobs/${uploadReceipt.job.id}/upload`], ['POST', `${base}/recoveries`],
    ]);
    assert.deepEqual(mutations.at(-1).input.mapping, preview.profiles.map(profile => ({ sourceProfileId: profile.id, destinationProfileId: value.sourceFixture.profileId, configurationRevision: 1 })));
    value.result = { backupJobId: backup.id, uploadJobId: uploadReceipt.job.id, recoveryJobId: recovery.id,
      manifestSchema: preview.archive.schema, nonemptyCounts: preview.counts, downloadedArchive: { filename: 'actual-downloaded-backup.zip', byteSize: archive.length, sha256: sha256(archive) },
      downloadedReport: { filename: 'actual-downloaded-recovery-report.json', sha256: sha256(reportBytes) }, publicReport };
    value.status = 'passed';
  } catch (error) {
    value.failureScreenshot = 'browser-failure.png'; await page.screenshot({ path: resolve(owner.output, value.failureScreenshot), fullPage: true }); throw error;
  }
}
