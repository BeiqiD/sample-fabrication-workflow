// Successor gate: actual current default Worker API/native D1/R2, never fixtures
// standing in for archive generation, executor outcomes or target verification.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { startGenuineRecoveryRuntime, sha256 } from './genuine-worker-recovery-runtime.mjs';
import { qualifyGenuineRecoveryBrowser } from './genuine-worker-recovery-browser.mjs';

const source = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const args = process.argv.slice(2);
assert(args.length === 3 && args[0] === '--output' && isAbsolute(args[1]) && ['--probe', '--browser'].includes(args[2]),
  'Usage: node scripts/qa/phase5f/browser-genuine-worker-recovery.mjs --output /tmp/NEW_OUTPUT --probe|--browser');
const output = resolve(args[1]); await mkdir(output, { mode: 0o700 });
const report = { version: 1, scope: 'Genuine local default current24 Worker V3 API setup/execution probe. Manual actual scheduled events; no elapsed cadence, V5, browser, production, provider or deployment qualification.',
  source, output, startedAt: new Date().toISOString(), status: 'running' };
let owner, browser;
async function probe() {
  owner = await startGenuineRecoveryRuntime(source, output, report);
  await owner.setup();
  await owner.request('/api/system-recovery/executor', 'POST', { enabled: true });
  const accepted = await owner.request('/api/system-recovery/jobs', 'POST', { requestId: randomUUID(), kind: 'backup', mode: 'historical' }, 202);
  const backup = await owner.scheduleUntil(accepted.job.id, 'completed');
  assert(backup.output?.available);
  const archive = await owner.request(`/api/system-recovery/jobs/${backup.id}/download`);
  assert(Buffer.isBuffer(archive)); assert.equal(archive.length, backup.output.byteSize); assert.equal(sha256(archive), backup.output.sha256);
  const upload = await owner.request('/api/system-recovery/uploads', 'POST', { requestId: randomUUID(), byteSize: archive.length, sha256: sha256(archive) }, 202);
  await owner.request(`/api/system-recovery/jobs/${upload.job.id}/upload`, 'PUT', archive, 200, { 'content-type': 'application/zip' });
  await owner.scheduleUntil(upload.job.id, 'preview');
  const preview = await owner.request(`/api/system-recovery/jobs/${upload.job.id}/preview`);
  assert.equal(preview.archive.schema, 'system-backup/3'); assert.equal(preview.archive.complete, true); assert(preview.counts.files >= 1); assert(preview.counts.rows >= 1); assert(preview.profiles.length >= 1);
  const recovery = await owner.request('/api/system-recovery/recoveries', 'POST', { requestId: randomUUID(), uploadJobId: upload.job.id,
    expectedTargetId: preview.target.id, mapping: preview.profiles.map(profile => ({ sourceProfileId: profile.id, destinationProfileId: report.sourceFixture.profileId, configurationRevision: 1 })),
    mode: 'historical', acknowledgeLaterChanges: true, acknowledgePartial: false }, 202);
  await owner.scheduleUntil(recovery.job.id, 'completed');
  const publicReport = await owner.request(`/api/system-recovery/jobs/${recovery.job.id}/report`);
  assert.equal(publicReport.schema, 'system-recovery-public-report/1'); assert(publicReport.counts.files >= 1); assert.equal(publicReport.handoff.automaticBindingChange, false);
  assert(Object.values(publicReport.execution).every(value => value === false));
  await owner.verifyRecovery(recovery.job.id, publicReport);
  report.probe = { backupJobId: backup.id, archiveBytes: archive.length, archiveSha256: sha256(archive), uploadJobId: upload.job.id,
    recoveryJobId: recovery.job.id, preview, publicReport };
}
try {
  if (args[2] === '--probe') await probe();
  else {
    assert(process.env.PLAYWRIGHT_MODULE_PATH && process.env.CHROMIUM_PATH, 'Provide existing Playwright and Chromium paths; no browser downloads.');
    const require = createRequire(import.meta.url), { chromium } = require(resolve(process.env.PLAYWRIGHT_MODULE_PATH));
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    report.scope = 'Two genuine local current24 Worker V3 Chromium backup/download/upload/preview/mapping/inert-recovery/report cases with signed Access JWT, native D1/R2 and ordinary HTTP-created nonempty source. Manual actual scheduled events; no elapsed cadence, V5, Node SPA, production/provider or deployment qualification.';
    report.chromiumVersion = browser.version(); report.cases = [];
    for (const scenario of [{ name: 'genuine-worker-recovery-1280-light', width: 1280, theme: 'light' }, { name: 'genuine-worker-recovery-390-dark', width: 390, theme: 'dark' }]) {
      const caseOutput = resolve(output, scenario.name); await mkdir(caseOutput, { mode: 0o700 });
      const value = { ...scenario, output: caseOutput, startedAt: new Date().toISOString(), status: 'running' }; report.cases.push(value);
      owner = await startGenuineRecoveryRuntime(source, caseOutput, value); await owner.setup();
      owner.browserOrigin = await owner.startBrowserAccessProxy();
      const context = await browser.newContext({ viewport: { width: scenario.width, height: 900 }, colorScheme: scenario.theme, acceptDownloads: true });
      await context.addInitScript(theme => localStorage.setItem('sample-workflow-theme', theme), scenario.theme);
      try { await qualifyGenuineRecoveryBrowser(owner, context, value); }
      finally { await context.close(); await owner.close(); owner = undefined; value.finishedAt = new Date().toISOString(); }
    }
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1;
  if (process.env.GITHUB_ACTIONS === 'true') {
    const detail = `${report.cases?.at(-1)?.name ?? args[2]}: ${report.error}`.slice(0, 12000)
      .replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    process.stdout.write(`::error title=Genuine recovery failure::${detail}\n`);
  }
}
finally {
  if (owner) await owner.close();
  if (browser) await browser.close();
  report.browserClosed = !browser || !browser.isConnected();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: report.status, report: resolve(output, 'report.json'), ...(report.error ? { error: report.error } : {}) })}\n`);
}
