// Two actual built versions, stable local edge and sequential original owners.
// No deployed resources, route.fulfill, fake chunks or browser-triggered executor.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { inspectVersion, compatibleVersions, startTwoVersionRuntime } from './two-version-handover-runtime.mjs';
import { qualifyTwoVersionBrowser } from './two-version-handover-browser.mjs';

const source = resolve(fileURLToPath(new URL('../../../', import.meta.url))), args = process.argv.slice(2);
assert(args.length === 4 && args[0] === '--source-a' && isAbsolute(args[1]) && args[2] === '--output' && isAbsolute(args[3]),
  'Usage: node scripts/qa/phase5f/browser-two-version-handover.mjs --source-a /absolute/BUILT_VERSION_A --output /absolute/NEW_OUTPUT');
const output = resolve(args[3]); await mkdir(output, { mode: 0o700 });
const report = { version: 1, status: 'running', nodeVersion: process.version, startedAt: new Date().toISOString(),
  scope: 'Two actual built Worker/client versions, stable local signed Access edge and sequential original runtimes over unchanged local D1/R2. Real retired lazy-route asset failure, explicit keyboard reload and original queued request reconciliation. No production, physical device, arbitrary dirty draft, provider, Package execution, elapsed cadence or full release qualification.', cases: [] };
let owner, browser;
try {
  const a = await inspectVersion(resolve(args[1]), true), b = await inspectVersion(source);
  report.versions = { A: a.info, B: b.info }; report.compatibility = await compatibleVersions(a, b);
  assert(process.env.PLAYWRIGHT_MODULE_PATH && process.env.CHROMIUM_PATH, 'Use an existing Playwright Core and Chrome; no browser downloads.');
  const require = createRequire(import.meta.url), { chromium } = require(resolve(process.env.PLAYWRIGHT_MODULE_PATH));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  report.chromiumVersion = browser.version();
  for (const scenario of [{ name: 'two-version-handover-1280-light', width: 1280, theme: 'light', queued: false },
    { name: 'two-version-handover-390-dark', width: 390, theme: 'dark', queued: true }]) {
    const caseOutput = resolve(output, scenario.name); await mkdir(caseOutput, { mode: 0o700 });
    const value = { ...scenario, status: 'running', startedAt: new Date().toISOString() }; report.cases.push(value);
    owner = await startTwoVersionRuntime(a, b, caseOutput, value); owner.output = caseOutput; value.sourceFixture = await owner.setup();
    const context = await browser.newContext({ viewport: { width: scenario.width, height: 900 }, colorScheme: scenario.theme });
    await context.addInitScript(theme => { localStorage.setItem('sample-workflow-theme', theme); window.__twoVersionDocumentWitness = crypto.randomUUID(); }, scenario.theme);
    try { await qualifyTwoVersionBrowser(owner, context, value, a.info, b.info, scenario.queued); value.status = 'passed'; }
    catch (error) { value.status = 'failed'; value.error = error.stack ?? String(error); throw error; }
    finally { await context.close(); await owner.close(); owner = undefined; value.finishedAt = new Date().toISOString(); }
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1;
  if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::error title=Two-version handover failure::${report.error.slice(0, 12000).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}\n`);
} finally {
  if (owner) { try { await owner.close(); } catch (error) { report.closeError = error.stack ?? String(error); report.status = 'failed'; process.exitCode = 1; } }
  if (browser) await browser.close(); report.browserClosed = !browser || !browser.isConnected(); report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: report.status, report: resolve(output, 'report.json'), cases: report.cases.map(({ name, status }) => ({ name, status })), ...(report.error ? { error: report.error } : {}) })}\n`);
}
