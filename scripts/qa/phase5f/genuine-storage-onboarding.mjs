// Actual current built Worker + native local D1/R2 + signed Access + Chromium.
// No external service or production setting is changed by this QA owner.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startGenuineStorageOnboardingRuntime, onboardingBase, newSyntheticSeed, newLegacyFixtureRoot } from './genuine-storage-onboarding-runtime.mjs';
import { qualifyGenuineStorageOnboardingBrowser } from './genuine-storage-onboarding-browser.mjs';

const source = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const args = process.argv.slice(2);
assert([3, 5].includes(args.length) && args[0] === '--output' && isAbsolute(args[1]) && ['--probe', '--browser'].includes(args[2])
  && (args.length === 3 || args[2] === '--browser' && args[3] === '--scenario' && ['seed-first-s3-1280-light', 'seed-first-s3-390-dark', 'legacy-keyring-1280-light'].includes(args[4])),
  'Usage: node scripts/qa/phase5f/genuine-storage-onboarding.mjs --output /tmp/NEW_OUTPUT --probe|--browser [--scenario EXACT_CASE_NAME]');
const output = resolve(args[1]); await mkdir(output, { mode: 0o700 });
const report = { version: 1, scope: 'Genuine current25 built Worker/native D1/R2 storage onboarding. Owned local Access issuer and synthetic AWS S3 transport, no real AWS/provider/deployed/production acceptance.',
  source, output, startedAt: new Date().toISOString(), status: 'running', cases: [], sensitiveArtifactsExcluded: ['runtime secrets', 'provider credentials', 'request bodies', 'database files', 'persistent runtime state'] };
let owner, browser;
try {
  if (args[2] === '--probe') {
    report.stage = 'probe-startup';
    owner = await startGenuineStorageOnboardingRuntime(source, output, report);
    await owner.setup();
    assert.equal((await owner.request(`${onboardingBase}/encryption-readiness`)).state, 'setup_required');
    const seed = newSyntheticSeed();
    await owner.reloadCredentialRoots({ INSTALLATION_SECRET_SEED: seed });
    assert.equal((await owner.request(`${onboardingBase}/encryption-readiness`)).state, 'seed_ready');
    await owner.request(`${onboardingBase}/candidates`, 'PUT', owner.candidateInput(0, 'API storage onboarding probe'));
    report.encryption = await owner.assertProtectedCredentials();
    await owner.reloadCredentialRoots({ INSTALLATION_SECRET_SEED: newSyntheticSeed() });
    assert.equal((await owner.request(`${onboardingBase}/encryption-readiness`)).state, 'restore_required');
    report.r2WithoutCorrectExternalRoot = await owner.assertR2Upload();
    await owner.reloadCredentialRoots({ INSTALLATION_SECRET_SEED: seed });
    assert.equal((await owner.request(`${onboardingBase}/encryption-readiness`)).state, 'seed_ready');
    report.recovered = await owner.assertProtectedCredentials();
    report.probe = { setupRequiredBeforeFirstRoot: true, seedReadyAfterActualReload: true, wrongCanonicalRootRequiresRecovery: true,
      retainedCiphertextReadableAfterOriginalRootRestored: true, readerReadinessForbidden: true };
  } else {
    assert(process.env.PLAYWRIGHT_MODULE_PATH && process.env.CHROMIUM_PATH, 'Provide existing Playwright and Chromium paths; no downloads.');
    const require = createRequire(import.meta.url), { chromium } = require(resolve(process.env.PLAYWRIGHT_MODULE_PATH));
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    report.chromiumVersion = browser.version();
    const scenarios = [
      { name: 'seed-first-s3-1280-light', width: 1280, theme: 'light' },
      { name: 'seed-first-s3-390-dark', width: 390, theme: 'dark' },
      { name: 'legacy-keyring-1280-light', width: 1280, theme: 'light', legacy: true },
    ];
    const selected = args[4] ? scenarios.filter(value => value.name === args[4]) : scenarios;
    report.selection = args[4] ?? 'all-three-cases';
    for (const scenario of selected) {
      const caseOutput = resolve(output, scenario.name); await mkdir(caseOutput, { mode: 0o700 });
      const value = { ...scenario, output: caseOutput, startedAt: new Date().toISOString(), status: 'running' }; report.cases.push(value);
      const legacyRoot = scenario.legacy ? newLegacyFixtureRoot() : undefined;
      owner = await startGenuineStorageOnboardingRuntime(source, caseOutput, value,
        legacyRoot ? { STORAGE_CREDENTIAL_KEYRING: legacyRoot } : {}, { activeFileFixture: true });
      await owner.setup(); owner.browserOrigin = await owner.startBrowserAccessProxy();
      const context = await browser.newContext({ viewport: { width: scenario.width, height: 900 }, colorScheme: scenario.theme });
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: owner.browserOrigin });
      await context.addInitScript(theme => localStorage.setItem('sample-workflow-theme', theme), scenario.theme);
      try { await qualifyGenuineStorageOnboardingBrowser(owner, context, value, { legacyRoot }); }
      finally { await context.close(); await owner.close(); owner = undefined; value.finishedAt = new Date().toISOString(); }
    }
  }
  report.status = 'passed'; report.stage = 'complete';
} catch (error) {
  report.status = 'failed'; process.exitCode = 1;
  if (report.cases.at(-1)?.status === 'running') report.cases.at(-1).status = 'failed';
  // Never serialize an assertion's actual/expected value or exception message:
  // this process deliberately handles ephemeral generated root/provider values.
  report.error = { name: /^[A-Za-z][A-Za-z0-9_]*$/.test(error?.name ?? '') ? error.name : 'Error',
    stage: report.cases.at(-1)?.stage ?? report.stage ?? 'startup',
    localFrames: String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line) && line.includes('/genuine-storage-onboarding')).slice(0, 6) };
} finally {
  if (owner) await owner.close();
  if (browser) await browser.close();
  report.browserClosed = !browser || !browser.isConnected();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: report.status, report: resolve(output, 'report.json'), ...(report.error ? { error: report.error } : {}) })}\n`);
}
