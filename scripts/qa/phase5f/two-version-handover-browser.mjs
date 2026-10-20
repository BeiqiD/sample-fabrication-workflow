import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readOwnedCheckpoint } from './browser-owned-checkpoints.mjs';

const button = (page, name) => page.getByRole('button', { name, exact: true });
async function enabled(locator) {
  await locator.waitFor(); await locator.page().waitForFunction(element => !element.disabled, await locator.elementHandle()); return locator;
}
async function keyboard(page, locator) { await enabled(locator); await locator.focus(); await page.keyboard.press('Enter'); }
async function screenshot(page, output, name) {
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, theme: document.documentElement.dataset.theme }));
  assert(geometry.documentWidth <= geometry.viewport + 1, `Horizontal overflow: ${JSON.stringify(geometry)}`);
  await page.screenshot({ path: resolve(output, name), fullPage: true }); return geometry;
}
export async function qualifyTwoVersionBrowser(owner, context, value, a, b, queuedCase) {
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  value.browser = { requests: [], responses: [], consoleErrors: [], pageErrors: [], documentRequests: 0 };
  const observed = value.browser;
  page.on('request', request => {
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return;
    observed.requests.push({ method: request.method(), path: url.pathname, query: url.search, type: request.resourceType() });
    if (request.resourceType() === 'document') observed.documentRequests++;
  });
  page.on('response', response => { const url = new URL(response.url());
    observed.responses.push({ path: url.pathname, query: url.search, status: response.status(), contentType: response.headers()['content-type'] ?? null }); });
  page.on('console', message => { if (message.type() === 'error') observed.consoleErrors.push({ text: message.text(), url: message.location().url }); });
  page.on('pageerror', error => observed.pageErrors.push(String(error)));
  let queued;
  try {
    await page.goto(`${owner.origin}/settings/data`);
    await page.getByRole('heading', { name: 'Data', exact: true, level: 1 }).waitFor();
    await page.getByText('Execution is paused.', { exact: true }).waitFor();
    await page.waitForFunction(() => document.documentElement.dataset.theme !== undefined);
    const originalDocument = await page.evaluate(() => window.__twoVersionDocumentWitness);
    assert.equal(typeof originalDocument, 'string');
    assert(observed.requests.some(row => row.path === a.entry));
    assert(value.edge.requests.some(row => row.version === 'A' && row.path === '/settings/data' && row.bodySha256 === a.htmlSha256));
    assert.equal(observed.requests.filter(row => row.path === a.recovery || a.recoveryCss.includes(row.path)).length, 0);
    assert.equal(observed.documentRequests, 1);
    if (queuedCase) {
      await page.getByRole('textbox', { name: 'Sample and Project roots', exact: true }).fill(`sample:${value.sourceFixture.sampleId}`);
      await keyboard(page, button(page, 'Preview export'));
      await enabled(button(page, 'Start data package export'));
      owner.armLostExportAck();
      await keyboard(page, button(page, 'Start data package export'));
      await enabled(button(page, 'Check or retry original request'));
      const pending = await page.evaluate(() => JSON.parse(sessionStorage.getItem('research-package-operation')));
      assert.equal(pending.action, 'export'); assert.equal(value.edge.lostAcknowledgements.length, 1);
      queued = value.edge.lostAcknowledgements[0]; assert.deepEqual(pending.input, queued.input);
      assert.equal(pending.input.kind, 'data_package');
      assert.deepEqual(pending.input.roots, [{ kind: 'sample', id: value.sourceFixture.sampleId }]);
      value.originalQueuedCheckpoint = pending;
    }
    value.beforeHandover = await screenshot(page, owner.output, 'before-handover.png');
    const mutationCount = value.edge.requests.filter(row => !['GET', 'HEAD'].includes(row.method)).length;
    assert.equal(mutationCount, queuedCase ? 2 : 0, 'Only the mobile export preview and one original acceptance may mutate.');
    await owner.switchToB();
    assert.equal(await page.evaluate(() => window.__twoVersionDocumentWitness), originalDocument);
    assert.equal(observed.documentRequests, 1);
    await page.locator('.research-package-navigation').getByRole('link', { name: 'System backup and recovery', exact: true }).click();
    const alert = page.getByRole('alert').filter({ has: page.getByRole('heading', { name: 'This page could not be loaded', exact: true }) });
    await alert.waitFor();
    assert(await alert.evaluate(element => document.activeElement === element), 'The real boundary must focus its own safe alert.');
    await page.getByRole('navigation', { name: 'Primary navigation', exact: true }).waitFor();
    assert(!/\/assets\/|TypeError|Failed to fetch|\.js\b/.test(await alert.innerText()), 'Private module/error details must not enter the product alert.');
    assert.equal(await page.evaluate(() => window.__twoVersionDocumentWitness), originalDocument);
    const retired = value.edge.requests.filter(row => row.version === 'B' && (row.path === a.recovery || a.recoveryCss.includes(row.path)));
    assert(retired.length > 0, 'B must actually receive a retired A route module/dependency request.');
    for (const response of retired) {
      assert(response.status >= 400 || !/javascript|text\/css/i.test(response.contentType ?? ''), 'Actual retired asset must fail delivery or its module MIME.');
    }
    value.retiredAssets = retired;
    const destination = `${owner.origin}/settings/data/system?handover=${queuedCase ? 'queued-original' : 'explicit-reload'}#same-location`;
    await page.evaluate(url => history.replaceState(history.state, '', url), destination);
    value.urlFixture = { method: 'history.replaceState preserves router state; no document/API navigation', destination };
    value.retiredRoute = await screenshot(page, owner.output, 'retired-route.png');
    await page.waitForTimeout(750);
    assert.equal(observed.documentRequests, 1); assert.equal(await page.evaluate(() => window.__twoVersionDocumentWitness), originalDocument);
    assert.equal(value.edge.requests.filter(row => !['GET', 'HEAD'].includes(row.method)).length, mutationCount);
    await keyboard(page, button(page, 'Reload page'));
    await page.getByRole('heading', { name: 'System backup and recovery', exact: true, level: 1 }).waitFor();
    await enabled(button(page, 'Preview system backup'));
    assert.equal(page.url(), destination); assert.equal(observed.documentRequests, 2);
    const reloadedDocument = await page.evaluate(() => window.__twoVersionDocumentWitness);
    assert.notEqual(reloadedDocument, originalDocument); assert(observed.requests.some(row => row.path === b.entry));
    assert(value.edge.requests.some(row => row.version === 'B' && row.path === '/settings/data/system'
      && row.query === new URL(destination).search && row.bodySha256 === b.htmlSha256));
    const capabilities = await owner.request('/api/system-recovery/capabilities');
    assert.equal(capabilities.policy.recoveryMapping, 'explicit-profile');
    value.recoveredRoute = await screenshot(page, owner.output, 'recovered-route.png');
    assert.equal(value.recoveredRoute.theme, value.theme);
    value.recovery = { originalDocument, reloadedDocument, explicitKeyboardReloads: 1, fullUrlPreserved: true,
      automaticDocumentRequestsBeforeReload: 0, actualCurrentRecoveryPolicy: capabilities.policy, zeroBoundaryMutation: true };
    if (queuedCase) {
      const beforePosts = value.edge.requests.filter(row => row.method === 'POST' && row.path === '/api/packages/jobs').length;
      await page.locator('.system-recovery-navigation').getByRole('link', { name: 'Research packages and reports', exact: true }).click();
      await page.getByRole('heading', { name: 'Data', exact: true, level: 1 }).waitFor();
      await page.getByRole('status').filter({ hasText: 'Earlier browser recovery records have no verified account owner' }).waitFor();
      await page.locator('.research-package-job').filter({ has: page.getByText(queued.jobId, { exact: true }) }).waitFor();
      assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('research-package-operation'))), value.originalQueuedCheckpoint,
        'The old client did not prove checkpoint ownership; retain its original bytes without adopting them.');
      assert.equal(await readOwnedCheckpoint(page, 'research-package-operation'), null);
      assert.equal(await page.getByRole('heading', { name: 'Unconfirmed operation', exact: true }).count(), 0);
      assert.equal(await button(page, 'Check original package request').count(), 0);
      assert(value.edge.requests.some(row => row.version === 'B' && row.method === 'GET' && row.path === '/api/packages/jobs' && row.status === 200));
      assert.equal(value.edge.requests.filter(row => row.version === 'B' && row.path === `/api/packages/requests/${encodeURIComponent(queued.requestId)}`).length, 0);
      assert.equal(value.edge.requests.filter(row => row.method === 'POST' && row.path === '/api/packages/jobs').length, beforePosts); assert.equal(beforePosts, 1);
      value.originalJob = await screenshot(page, owner.output, 'original-queued-job.png');
      value.queuedOriginalReconciliation = { requestId: queued.requestId, jobId: queued.jobId, actualOldAcceptedAckLost: true,
        realBAccountScopedJobListRead: true, originalExportPostCount: 1, unownedOriginalCheckpointPreserved: true,
        originalSessionCheckpointAccepted: false, legacyOwnershipWarningVisible: true, noUnownedReceiptRead: true, noMutationReplay: true };
    }
    assert.equal(value.edge.requests.filter(row => !['GET', 'HEAD'].includes(row.method)).length, mutationCount);
    value.independentReadback = await owner.verifyPreserved(queued);
    const oldAssetNames = [a.recovery, ...a.recoveryCss].map(path => path.split('/').at(-1));
    const expected = message => oldAssetNames.some(name => message.includes(name));
    const expectedConsole = error => expected(`${error.text} ${error.url}`)
      || queuedCase && value.edge.lostAcknowledgements.length === 1 && /ERR_CONTENT_LENGTH_MISMATCH/.test(error.text) && error.url === `${owner.origin}/api/packages/jobs`;
    observed.expectedConsoleErrors = observed.consoleErrors.filter(expectedConsole); observed.unexpectedConsoleErrors = observed.consoleErrors.filter(error => !expectedConsole(error));
    observed.expectedPageErrors = observed.pageErrors.filter(expected); observed.unexpectedPageErrors = observed.pageErrors.filter(message => !expected(message));
    assert.deepEqual(observed.unexpectedConsoleErrors, []); assert.deepEqual(observed.unexpectedPageErrors, []); assert.deepEqual(value.edge.errors, []);
  } catch (error) {
    try { await page.screenshot({ path: resolve(owner.output, 'browser-failure.png'), fullPage: true }); value.failureScreenshot = 'browser-failure.png'; } catch (captureError) { value.failureScreenshotError = captureError.message; }
    throw error;
  } finally { await page.close(); }
}
