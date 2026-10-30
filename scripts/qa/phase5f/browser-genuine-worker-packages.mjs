// Genuine signed local Worker/D1/R2 Package export, copy and lost-ACK gate.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGenuinePackageRuntime } from './genuine-worker-package-runtime.mjs';
import { qualifyGenuinePackageBrowser } from './genuine-worker-package-browser.mjs';

const source = resolve(fileURLToPath(new URL('../../../', import.meta.url))), args = process.argv.slice(2);
assert(args.length === 2 && args[0] === '--output' && isAbsolute(args[1]), 'Usage: node scripts/qa/phase5f/browser-genuine-worker-packages.mjs --output /tmp/NEW_OUTPUT');
assert(process.env.PLAYWRIGHT_MODULE_PATH && process.env.CHROMIUM_PATH, 'Supply installed Playwright/Chromium paths; no browser downloads.');
const output = resolve(args[1]); await mkdir(output, { mode: 0o700 });
const report = { version: 1, source, output, startedAt: new Date().toISOString(), status: 'running', cases: [],
  scope: 'Two genuine current24 local Worker Chromium Package cases: public Sample+Project/Markdown/remapped Sample reference/one PNG exported through UI to actual STORE ZIP, uploaded/validated and copied to fresh business/File identities; desktop ordinary existing-import reuse without new graph and mobile actual committed import202 ACK transport loss with reload originalGET/no duplicatePOST. All-public separate unexported bootstrap graph retained; no business/profile/job/result SQL fixtures. Actual manual scheduled handlers only; no elapsed cadence, remote provider, Node SPA, production/deployment, full catalog or release qualification.' };
let owner, browser;
try {
  const require = createRequire(import.meta.url), { chromium } = require(resolve(process.env.PLAYWRIGHT_MODULE_PATH));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }); report.chromiumVersion = browser.version();
  for (const scenario of [{ name: 'actual-package-copy-reuse-1280-light', width: 1280, theme: 'light', loseImportAck: false },
    { name: 'actual-package-import-lost-ack-390-dark', width: 390, theme: 'dark', loseImportAck: true }]) {
    const caseOutput = resolve(output, scenario.name); await mkdir(caseOutput, { mode: 0o700 });
    const value = { ...scenario, output: caseOutput, startedAt: new Date().toISOString(), status: 'running' }; report.cases.push(value);
    owner = await startGenuinePackageRuntime(source, caseOutput, value); await owner.setup(); owner.browserOrigin = await owner.startBrowserAccessProxy();
    const context = await browser.newContext({ viewport: { width: scenario.width, height: 900 }, colorScheme: scenario.theme, acceptDownloads: true });
    await context.addInitScript(theme => localStorage.setItem('sample-workflow-theme', theme), scenario.theme);
    try { await qualifyGenuinePackageBrowser(owner, context, value); }
    finally { await context.close(); await owner.close(); owner = undefined; value.finishedAt = new Date().toISOString(); }
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1;
  if (report.cases.at(-1)?.status === 'running') report.cases.at(-1).status = 'failed';
  if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::error title=Genuine Package failure::${`${report.cases.at(-1)?.name ?? 'setup'}: ${report.error}`.slice(0, 12000).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}\n`);
} finally {
  if (owner) await owner.close(); if (browser) await browser.close(); report.browserClosed = !browser || !browser.isConnected(); report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: report.status, report: resolve(output, 'report.json'), ...(report.error ? { error: report.error } : {}) })}\n`);
}
