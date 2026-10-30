// Current built Worker, actual File creation and native two-R2 migration jobs.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMigrationIntentRuntime } from './genuine-migration-intent-runtime.mjs';
import { qualifyMigrationIntentBrowser } from './genuine-migration-intent-browser.mjs';

const source = resolve(fileURLToPath(new URL('../../../', import.meta.url))), args = process.argv.slice(2);
assert(args.length === 2 && args[0] === '--output' && isAbsolute(args[1]),
  'Usage: node scripts/qa/phase5f/browser-genuine-migration-intent.mjs --output /tmp/NEW_OUTPUT');
assert(process.env.PLAYWRIGHT_MODULE_PATH && process.env.CHROMIUM_PATH, 'Provide existing Playwright and Chromium paths; no browser downloads.');
const output = resolve(args[1]); await mkdir(output, { mode: 0o700 });
const report = { version: 1, source, output, startedAt: new Date().toISOString(), status: 'running', cases: [],
  scope: 'Two genuine local current24 Worker Chromium File migration intent cases: actual other-administrator completed migration causes409+exact404 then explicit replan; actual committed202 ACK lost by transport then exactGET recovery without a secondPOST. Two historical R2 installation-profile metadata fixtures, actual public File/authority/job creation and native D1/two-R2 bytes. Manually issued actual scheduled events; no elapsed cadence, provider, production, Node SPA or deployment qualification.' };
let owner, browser;
try {
  const require = createRequire(import.meta.url), { chromium } = require(resolve(process.env.PLAYWRIGHT_MODULE_PATH));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  report.chromiumVersion = browser.version();
  for (const scenario of [{ name: 'actual-other-admin-409-1280-light', kind: 'rejected-plan', width: 1280, theme: 'light' },
    { name: 'actual-lost-ack-390-dark', kind: 'lost-ack', width: 390, theme: 'dark' }]) {
    const caseOutput = resolve(output, scenario.name); await mkdir(caseOutput, { mode: 0o700 });
    const value = { ...scenario, output: caseOutput, startedAt: new Date().toISOString(), status: 'running' }; report.cases.push(value);
    owner = await startMigrationIntentRuntime(source, caseOutput, value); await owner.setup();
    owner.browserOrigin = await owner.startBrowserAccessProxy();
    const context = await browser.newContext({ viewport: { width: scenario.width, height: 900 }, colorScheme: scenario.theme });
    await context.addInitScript(theme => localStorage.setItem('sample-workflow-theme', theme), scenario.theme);
    try { await qualifyMigrationIntentBrowser(owner, context, value); }
    finally { await context.close(); await owner.close(); owner = undefined; value.finishedAt = new Date().toISOString(); }
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1;
  if (report.cases.at(-1)?.status === 'running') report.cases.at(-1).status = 'failed';
  if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::error title=Genuine migration intent failure::${`${report.cases.at(-1)?.name ?? 'setup'}: ${report.error}`.slice(0, 12000).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}\n`);
} finally {
  if (owner) await owner.close(); if (browser) await browser.close();
  report.browserClosed = !browser || !browser.isConnected(); report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: report.status, report: resolve(output, 'report.json'), ...(report.error ? { error: report.error } : {}) })}\n`);
}
