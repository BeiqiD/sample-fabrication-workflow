import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { checkedAcceptFileMigration, checkedFileMigrationRequestAbsent, checkedFileMigrationRequestReceipt } from '../../../shared/contracts/file-jobs.ts';
import { migrationBase } from './genuine-migration-intent-runtime.mjs';

const button = (page, name) => page.getByRole('button', { name, exact: true });
async function enabled(locator) {
  await locator.waitFor(); await locator.page().waitForFunction(element => !element.disabled, await locator.elementHandle()); return locator;
}
async function keyboard(page, locator) { await enabled(locator); await locator.focus(); await page.keyboard.press('Enter'); }
async function responseAfter(page, path, method, operation, status = 200) {
  const wait = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
  void wait.catch(() => {}); await operation(); const response = await wait;
  assert.equal(response.status(), status, `${method} ${path}: HTTP${response.status()}`); return response;
}
async function checkpoint(page) {
  return page.evaluate(() => Object.fromEntries(['file-migration-acceptance', 'file-migration-acceptance-rejection', 'file-migration-earlier-requests']
    .map(key => [key, JSON.parse(sessionStorage.getItem(key) ?? 'null')])));
}
async function capture(page, owner, name) {
  await page.evaluate(() => scrollTo(0, 0));
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth, theme: document.documentElement.dataset.theme }));
  assert(geometry.width <= geometry.viewport + 1, `Migration page horizontal overflow: ${JSON.stringify(geometry)}`);
  await page.screenshot({ path: resolve(owner.output, `${name}.png`), fullPage: true }); return { geometry, screenshot: `${name}.png` };
}
async function selectAndPreview(page, file, destination) {
  await enabled(page.getByLabel('Migration destination', { exact: true }));
  await page.getByLabel('Migration destination', { exact: true }).selectOption(destination);
  await page.locator('.storage-candidate-checkbox').filter({ has: page.getByText(file.file_id, { exact: true }) }).getByRole('checkbox').check();
  const preview = button(page, 'Preview migration');
  await responseAfter(page, `${migrationBase}/plans`, 'POST', () => keyboard(page, preview));
  await enabled(button(page, 'Start migration')); assert(await preview.evaluate(element => element === document.activeElement));
}
async function receipt(owner, input) {
  const value = checkedFileMigrationRequestReceipt(await owner.request(`${migrationBase}/requests/${encodeURIComponent(input.requestId)}`));
  assert.deepEqual(value.input, input); assert.equal(value.requestId, input.requestId); assert.equal(value.job.actor, owner.actor); return value;
}
async function savedVisible(page, jobId) {
  const saved = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Saved jobs', exact: true }) });
  await saved.getByRole('heading', { name: jobId, exact: true }).waitFor();
  await page.waitForFunction(() => sessionStorage.getItem('file-migration-acceptance') === null);
  await page.getByText(`Migration ${jobId} accepted. You can leave this page while the executor continues.`, { exact: true }).waitFor();
}
async function rejectedPlan(owner, page, value) {
  const file = value.sourceFile;
  await selectAndPreview(page, file, file.targetProfileId);
  await owner.request(`${migrationBase}/executor`, 'POST', { enabled: true }, 200, {}, 'competitor');
  const otherInput = { requestId: randomUUID(), fileIds: [file.file_id], target: { profileId: file.targetProfileId, configurationRevision: 1 } };
  const other = await owner.request(migrationBase, 'POST', otherInput, 202, {}, 'competitor');
  assert.equal(other.actor, owner.competitor); assert.notEqual(other.actor, owner.actor);
  await owner.scheduleUntil(other.id, 'competitor'); await owner.verifyFile(file.targetProfileId);
  const rejected = await responseAfter(page, migrationBase, 'POST', () => keyboard(page, button(page, 'Start migration')), 409);
  const original = checkedAcceptFileMigration(rejected.request().postDataJSON());
  await enabled(button(page, 'Review a new migration plan'));
  assert.deepEqual(await owner.rows('SELECT id FROM file_migration_jobs WHERE request_id=?', [original.requestId]), []);
  const absence = checkedFileMigrationRequestAbsent(await owner.request(`${migrationBase}/requests/${original.requestId}`, 'GET', undefined, 404), original.requestId);
  const before = await checkpoint(page);
  assert.deepEqual(before['file-migration-acceptance'], original);
  assert.deepEqual(before['file-migration-acceptance-rejection'], { schema: 'file-migration-rejection/1', input: original });
  assert(await page.getByLabel('Migration destination', { exact: true }).isDisabled());
  value.rejectedScreenshot = await capture(page, owner, 'actual-409-awaiting-explicit-replan');
  const checksBefore = value.browserApi.filter(row => row.path === `${migrationBase}/requests/${original.requestId}`).length;
  await responseAfter(page, `${migrationBase}/requests/${original.requestId}`, 'GET', () => keyboard(page, button(page, 'Review a new migration plan')), 404);
  await enabled(page.getByLabel('Migration destination', { exact: true }));
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Migration destination');
  const after = await checkpoint(page);
  assert.equal(after['file-migration-acceptance'], null); assert.equal(after['file-migration-acceptance-rejection'], null);
  assert.deepEqual(after['file-migration-earlier-requests'], [{ input: original, jobId: null }]);
  assert.equal(await page.getByLabel('Migration destination', { exact: true }).inputValue(), '');
  assert.equal(await page.getByRole('checkbox').isChecked(), false);
  assert.equal(await button(page, 'Start migration').count(), 0);
  assert.equal(value.browserApi.filter(row => row.path === `${migrationBase}/requests/${original.requestId}`).length, checksBefore + 1);
  await page.getByText(`Current profile: ${file.targetProfileId}`, { exact: true }).waitFor();
  await selectAndPreview(page, file, file.sourceProfileId);
  const accepted = await responseAfter(page, migrationBase, 'POST', () => keyboard(page, button(page, 'Start migration')), 202);
  const newInput = checkedAcceptFileMigration(accepted.request().postDataJSON()); assert.notEqual(newInput.requestId, original.requestId);
  const saved = await receipt(owner, newInput); await savedVisible(page, saved.job.id);
  const pause = page.locator('li').filter({ has: page.getByRole('heading', { name: saved.job.id, exact: true }) }).getByRole('button', { name: 'Pause job', exact: true });
  await enabled(pause); await page.waitForFunction(element => document.activeElement === element, await pause.elementHandle());
  await owner.scheduleUntil(saved.job.id); const readback = await owner.verifyFile(file.sourceProfileId);
  assert.equal(readback.jobs.length, 2); assert.deepEqual(readback.jobs.map(job => job.request_id).sort(), [otherInput.requestId, newInput.requestId].sort());
  assert.equal(readback.jobs.find(job => job.id === other.id).actor, owner.competitor);
  const posts = value.browserApi.filter(row => row.method === 'POST' && row.path === migrationBase);
  assert.deepEqual(posts.map(row => [row.input.requestId, row.status]), [[original.requestId, 409], [newInput.requestId, 202]]);
  value.result = { originalRejectedInput: original, otherAdministratorJobId: other.id, rejectedRequestHasNoNativeJob: true,
    exactTypedAbsence: absence, explicitReplanChecksOriginalAgain: true, rejectedCheckpointRetainedInHistory: true, newAcceptedReceipt: saved,
    staleSelectionAndDestinationCleared: true, keyboardFocusReturnedToDestinationThenAcceptedJobPause: true,
    actualForwardAndReverseMigrationCompleted: true, acceptancePosts: posts };
}
async function lostAcknowledgement(owner, page, value) {
  const file = value.sourceFile;
  await owner.request(`${migrationBase}/executor`, 'POST', { enabled: true });
  await selectAndPreview(page, file, file.targetProfileId); owner.armLostAck();
  const response = await responseAfter(page, migrationBase, 'POST', () => keyboard(page, button(page, 'Start migration')), 202);
  const original = checkedAcceptFileMigration(response.request().postDataJSON());
  await enabled(button(page, 'Check original migration request'));
  const before = await checkpoint(page); assert.deepEqual(before['file-migration-acceptance'], original);
  assert.equal(before['file-migration-acceptance-rejection'], null);
  assert.equal(await button(page, 'Review a new migration plan').count(), 0);
  assert(await page.getByLabel('Migration destination', { exact: true }).isDisabled());
  const saved = await receipt(owner, original), native = await owner.rows('SELECT id,request_id,actor,input_json,accepted_at FROM file_migration_jobs WHERE request_id=?', [original.requestId]);
  assert.equal(native.length, 1); assert.equal(native[0].id, saved.job.id); assert.deepEqual(JSON.parse(native[0].input_json), original);
  assert.equal(value.edge.lostAcknowledgements.length, 1); assert.equal(value.edge.lostAcknowledgements[0].jobId, saved.job.id);
  value.pendingScreenshot = await capture(page, owner, 'actual-committed-ack-lost');
  const wait = page.waitForResponse(item => new URL(item.url()).pathname === `${migrationBase}/requests/${original.requestId}` && item.request().method() === 'GET');
  void wait.catch(() => {}); await page.reload(); assert.equal((await wait).status(), 200);
  await savedVisible(page, saved.job.id);
  const after = await checkpoint(page); assert.equal(after['file-migration-acceptance-rejection'], null);
  assert.deepEqual(after['file-migration-earlier-requests'], [{ input: original, jobId: saved.job.id }]);
  assert.deepEqual(await owner.rows('SELECT id,request_id,actor,input_json,accepted_at FROM file_migration_jobs WHERE request_id=?', [original.requestId]), native);
  assert.equal(await button(page, 'Review a new migration plan').count(), 0);
  await owner.scheduleUntil(saved.job.id); const readback = await owner.verifyFile(file.targetProfileId); assert.equal(readback.jobs.length, 1);
  const posts = value.edge.requests.filter(row => row.method === 'POST' && row.path === migrationBase);
  assert.equal(posts.length, 1); assert.deepEqual(posts[0].input, original);
  value.result = { originalInput: original, originalReceipt: saved, lostAckNativeCommitBeforeFault: true,
    pendingPreservedUntilExactReceipt: true, unknownAckNeverOfferedReplan: true, reloadOnlyReconcilesByGet: true,
    originalJobAndAcceptedAtUnchanged: true, originalCheckpointRetainedInHistory: true, acceptancePosts: posts,
    actualMigrationCompleted: true };
}
export async function qualifyMigrationIntentBrowser(owner, context, value) {
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  value.browserApi = []; value.consoleErrors = []; value.pageErrors = [];
  page.on('pageerror', error => value.pageErrors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') value.consoleErrors.push({ text: message.text(), path: new URL(message.location().url || owner.browserOrigin).pathname }); });
  page.on('response', response => {
    const request = response.request(), path = new URL(response.url()).pathname; if (!path.startsWith('/api/')) return;
    value.browserApi.push({ method: request.method(), path, status: response.status(),
      ...(request.headers()['content-type'] === 'application/json' && request.postData() ? { input: request.postDataJSON() } : {}) });
  });
  await page.route('**/*', async route => { assert.equal(new URL(route.request().url()).origin, owner.browserOrigin); await route.continue(); });
  try {
    await page.goto(`${owner.browserOrigin}/settings/storage/migrations`);
    await page.getByRole('heading', { name: 'File migrations', exact: true, level: 1 }).waitFor();
    if (value.kind === 'rejected-plan') await rejectedPlan(owner, page, value); else await lostAcknowledgement(owner, page, value);
    await keyboard(page, button(page, 'Refresh'));
    const savedId = (value.result.newAcceptedReceipt ?? value.result.originalReceipt).job.id;
    const savedJob = page.locator('li').filter({ has: page.getByRole('heading', { name: savedId, exact: true }) });
    await savedJob.getByRole('status').filter({ hasText: /^completed · 1 moved/ }).waitFor();
    await enabled(button(page, 'Refresh'));
    value.finalScreenshot = await capture(page, owner, 'actual-original-request-reconciled');
    assert.equal(value.finalScreenshot.geometry.theme, value.theme); assert.deepEqual(value.pageErrors, []); assert.deepEqual(value.edge.errors, []);
    const mutations = value.edge.requests.filter(row => row.method !== 'GET');
    const expectedMutations = [['POST', `${migrationBase}/plans`], ['POST', migrationBase]];
    assert.deepEqual(mutations.map(row => [row.method, row.path]), value.kind === 'rejected-plan' ? [...expectedMutations, ...expectedMutations] : expectedMutations);
    value.browserMutations = mutations;
    const expectedError = value.kind === 'rejected-plan' ? /(?:status of409|status of 409|status of404|status of 404)/ : /ERR_CONTENT_LENGTH_MISMATCH/;
    value.expectedTransportConsole = value.consoleErrors.filter(row => (row.path === migrationBase || row.path.startsWith(`${migrationBase}/requests/`)) && expectedError.test(row.text));
    assert.deepEqual(value.consoleErrors.filter(row => !value.expectedTransportConsole.includes(row)), []);
    value.status = 'passed';
  } catch (error) { await page.screenshot({ path: resolve(owner.output, 'browser-failure.png'), fullPage: true }); throw error; }
}
