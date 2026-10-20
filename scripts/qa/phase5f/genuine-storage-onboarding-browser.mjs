import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { onboardingBase, newSyntheticSeed, newLegacyFixtureRoot } from './genuine-storage-onboarding-runtime.mjs';

const control = (page, name) => page.getByRole('button', { name, exact: true });
const seedOutput = page => page.getByLabel('Installation seed', { exact: true });
async function press(locator) { await locator.waitFor(); await locator.click(); }
async function wizardStage(page, expected) {
  const current = page.getByRole('navigation', { name: 'Add AWS S3 stages', exact: true }).locator('li[aria-current="step"]');
  await current.filter({ hasText: expected }).waitFor();
  assert.equal((await current.textContent()).trim(), expected, 'Wizard stage did not match verified progress');
}
async function responseAfter(page, path, method, operation, status = 200) {
  const waiting = page.waitForResponse(value => new URL(value.url()).pathname === path && value.request().method() === method);
  void waiting.catch(() => {});
  await operation(); const response = await waiting;
  assert.equal(response.status(), status, 'Unexpected browser HTTP status');
  return response;
}
async function secretFreeStorage(page, secrets) {
  const values = await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)]);
  assert(values.every(value => secrets.every(secret => !value.includes(secret))), 'Secret persisted in browser storage');
}
async function safeScreenshot(page, owner, name, secrets) {
  assert.equal(await seedOutput(page).count(), 0, 'Seed must be cleared before screenshot');
  const clean = await page.evaluate(forbidden => {
    const values = [document.body.textContent ?? '', ...[...document.querySelectorAll('input, textarea, output')]
      .map(element => 'value' in element ? String(element.value) : element.textContent ?? '')];
    return values.every(value => forbidden.every(secret => !value.includes(secret)));
  }, secrets);
  assert(clean, 'Secret must be absent from all DOM text and control values before screenshot');
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
  if (geometry.page > geometry.viewport + 1) {
    const layout = await page.evaluate(() => {
      const bounds = element => { const box = element.getBoundingClientRect(); return { left: box.left + scrollX, right: box.right + scrollX, width: box.width }; };
      const describe = element => { const style = getComputedStyle(element); return { tag: element.tagName, classes: String(element.className ?? '').slice(0, 160), textLength: (element.textContent ?? '').length, ...bounds(element),
        display: style.display, overflowWrap: style.overflowWrap, wordBreak: style.wordBreak, whiteSpace: style.whiteSpace, overflowX: style.overflowX, minWidth: style.minWidth, maxWidth: style.maxWidth }; };
      return { viewport: innerWidth, page: document.documentElement.scrollWidth, offenders: [...document.querySelectorAll('body *')]
        .filter(element => bounds(element).right > innerWidth + 1 || bounds(element).left < -1)
        .sort((a, b) => bounds(a).width - bounds(b).width).slice(0, 8)
        .map(element => ({ ...describe(element), parents: [element.parentElement, element.parentElement?.parentElement].filter(Boolean).map(describe) })) };
    });
    await writeFile(resolve(owner.output, `${name}.layout.json`), `${JSON.stringify(layout, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await page.screenshot({ path: resolve(owner.output, `${name}.overflow.png`), fullPage: true });
    assert.fail('Onboarding page overflows horizontally');
  }
  await page.screenshot({ path: resolve(owner.output, `${name}.png`), fullPage: true });
  return { file: `${name}.png`, geometry, seedAndProviderSecretsAbsent: true };
}
async function fillCandidate(page, input) {
  await page.getByRole('heading', { name: 'New candidate', exact: true }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill(input.label);
  await page.getByLabel('HTTPS endpoint', { exact: true }).fill(input.namespace.endpoint);
  await page.getByLabel('Bucket', { exact: true }).fill(input.namespace.bucket);
  await page.getByLabel('Region', { exact: true }).fill(input.namespace.region);
  await page.getByLabel('Root folder', { exact: true }).fill(input.namespace.root);
  await page.getByLabel('Use path style requests', { exact: true }).setChecked(true);
  await page.getByLabel('AWS bucket owner account ID', { exact: true }).fill(input.namespace.expectedBucketOwner);
  await page.getByLabel('Access key ID', { exact: true }).fill(input.credentials.value.accessKeyId);
  await page.getByLabel('Secret access key', { exact: true }).fill(input.credentials.value.secretAccessKey);
}
async function openConfiguration(page, owner) {
  await page.goto(`${owner.browserOrigin}/settings/storage/configuration`);
  await page.getByRole('heading', { name: 'Storage configuration', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Add storage', exact: true }).waitFor();
}
async function recoveryScreen(page, owner, state, roots) {
  await owner.reloadCredentialRoots(roots);
  await openConfiguration(page, owner);
  await responseAfter(page, `${onboardingBase}/encryption-readiness`, 'GET', () => press(control(page, 'Add AWS S3 storage')));
  await page.getByRole('heading', { name: state === 'configuration_conflict' ? 'Resolve the existing secret configuration' : 'Restore existing seed/key', exact: true }).waitFor();
  assert.equal(await control(page, 'Generate seed').count(), 0, 'Existing root must not offer reinitialization');
  assert.equal(await page.getByLabel('Access key ID', { exact: true }).count(), 0, 'Provider entry must wait for original root recovery');
  assert.equal((await owner.request(`${onboardingBase}/encryption-readiness`)).state, state);
  return { state, noNewSeed: true, noProviderEntry: true, r2: await owner.assertR2Upload() };
}

/** Exact public UI and genuine Worker only. Secrets are kept in this closure,
 * never returned in observer evidence or supplied to a screenshot. */
export async function qualifyGenuineStorageOnboardingBrowser(owner, context, report, { legacyRoot } = {}) {
  const page = await context.newPage(); page.setDefaultTimeout(25000);
  let seed = null, activeSecrets = [];
  const first = owner.candidateInput(0, 'Browser first AWS S3'), second = owner.candidateInput(1, 'Browser second AWS S3');
  activeSecrets = [first.credentials.value.accessKeyId, first.credentials.value.secretAccessKey,
    ...(legacyRoot ? [legacyRoot, ...Object.values(JSON.parse(legacyRoot).keys)] : [])];
  report.browserApi = []; report.pageErrorCount = 0; report.seedCrossedNetwork = false;
  page.on('pageerror', () => { report.pageErrorCount += 1; });
  page.on('request', request => {
    if (seed && (request.url().includes(seed) || request.postData()?.includes(seed))) report.seedCrossedNetwork = true;
  });
  page.on('response', response => {
    const request = response.request(), path = new URL(response.url()).pathname;
    if (path.startsWith('/api/')) report.browserApi.push({ method: request.method(), path, status: response.status() });
  });
  await page.route('**/*', async route => {
    assert.equal(new URL(route.request().url()).origin, owner.browserOrigin, 'Browser contacted an unowned origin');
    await route.continue();
  });
  try {
    report.stage = 'fresh-r2-and-read-only-settings';
    await page.goto(`${owner.browserOrigin}/settings/storage`);
    await page.getByRole('heading', { name: 'Storage', exact: true, level: 1 }).waitFor();
    assert.equal(await control(page, 'Generate seed').count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Set up secure credentials — required once', exact: true }).count(), 0);
    const initialReadinessRequests = report.browserApi.filter(item => item.path === `${onboardingBase}/encryption-readiness`).length;
    await openConfiguration(page, owner);
    assert.equal(await control(page, 'Generate seed').count(), 0);
    assert.equal(report.browserApi.filter(item => item.path === `${onboardingBase}/encryption-readiness`).length, initialReadinessRequests, 'Ordinary settings unexpectedly requested bootstrap');
    report.initialR2 = { readOnlySettingsNeedNoBootstrap: true, r2: await owner.assertR2Upload() };

    report.stage = legacyRoot ? 'legacy-root-bypasses-bootstrap' : 'explicit-first-s3-bootstrap';
    if (legacyRoot) {
      await press(control(page, 'Add AWS S3 storage'));
      await page.getByLabel('Access key ID', { exact: true }).waitFor();
      await wizardStage(page, 'Save connection');
      assert.equal(await control(page, 'Generate seed').count(), 0);
      assert.equal((await owner.request(`${onboardingBase}/encryption-readiness`)).state, 'legacy_ready');
      report.legacyRoot = { noSeedPrompt: true, unchangedLegacyConfiguration: true };
    } else {
      assert.equal(await page.getByLabel('Access key ID', { exact: true }).count(), 0);
      await responseAfter(page, `${onboardingBase}/encryption-readiness`, 'GET', () => press(control(page, 'Add AWS S3 storage')));
      await page.getByRole('heading', { name: 'Set up secure credentials — required once', exact: true }).waitFor();
      await wizardStage(page, 'Secure credentials');
      await page.getByText('Settings → Variables and Secrets → Secret', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Access key ID', { exact: true }).count(), 0, 'Provider fields appeared before encryption root');
      assert.equal((await owner.request(`${onboardingBase}/encryption-readiness`)).state, 'setup_required');
      report.preSeedScreenshot = await safeScreenshot(page, owner, 'first-s3-before-generate', activeSecrets);
      await press(control(page, 'Generate seed'));
      seed = await seedOutput(page).textContent();
      assert(typeof seed === 'string' && /^sfi-seed-v1\.[A-Za-z0-9_-]{43}$/.test(seed), 'Generated seed is not canonical');
      const raw = Buffer.from(seed.slice('sfi-seed-v1.'.length), 'base64url');
      assert.equal(raw.length, 32, 'Generated seed entropy width is not 256 bits'); raw.fill(0);
      activeSecrets.push(seed, seed.slice('sfi-seed-v1.'.length));
      await press(control(page, 'Copy seed'));
      await page.getByText('Seed copied. Save a protected recovery backup before continuing.', { exact: true }).waitFor();
      const copiedMatches = await page.evaluate(expected => navigator.clipboard.readText().then(value => value === expected), seed);
      assert(copiedMatches, 'Clipboard did not contain the exact browser seed');
      await secretFreeStorage(page, activeSecrets);
      await owner.reloadCredentialRoots({ INSTALLATION_SECRET_SEED: seed });
      await responseAfter(page, `${onboardingBase}/encryption-readiness`, 'GET', () => press(control(page, 'Recheck setup')));
      await page.getByLabel('Access key ID', { exact: true }).waitFor();
      await wizardStage(page, 'Save connection');
      assert.equal(await seedOutput(page).count(), 0, 'Seed retained after readiness confirmation');
      assert.equal((await owner.request(`${onboardingBase}/encryption-readiness`)).state, 'seed_ready');
      await page.evaluate(() => navigator.clipboard.writeText(''));
      report.firstSeedSetup = { browserGeneratedCanonical256BitSeed: true, genuineClipboardCopy: true, providerEntryAfterRoot: true,
        singleLocalRuntimeSecretReload: true, noSeedBrowserPersistence: true, seedClearedAfterRecheck: true };
    }

    report.stage = 'first-candidate-encryption';
    const before = await owner.originalState();
    await fillCandidate(page, first);
    await responseAfter(page, `${onboardingBase}/candidates`, 'PUT', () => press(control(page, 'Save draft')));
    await page.getByRole('heading', { name: first.label, exact: true }).waitFor();
    await page.getByText('Candidate saved as a draft. Current upload destinations are unchanged.', { exact: true }).waitFor();
    await wizardStage(page, 'Test connection');
    assert.equal(await page.getByLabel('Access key ID', { exact: true }).count(), 0, 'Saved connection retained a fresh provider credential form');
    report.encryption = await owner.assertProtectedCredentials();
    const afterSave = await owner.originalState();
    assert.deepEqual(afterSave.policy, before.policy, 'Saving candidate changed upload defaults');
    assert.deepEqual(afterSave.policyHistory, before.policyHistory, 'Saving candidate changed policy history');
    assert.deepEqual(afterSave.nativeBindings, before.nativeBindings, 'Saving candidate activated storage');
    await secretFreeStorage(page, activeSecrets);
    report.savedScreenshot = await safeScreenshot(page, owner, 'candidate-saved-before-provider-test', activeSecrets);

    report.stage = 'existing-provider-test-registration-activation';
    await owner.enableFileAuthority();
    await responseAfter(page, `${onboardingBase}/checks`, 'POST', () => press(control(page, `Test ${first.label}`)));
    await page.getByText('Passed', { exact: true }).first().waitFor();
    await wizardStage(page, 'Review evidence and register');
    await press(control(page, `Check evidence for ${first.label}`));
    await page.getByText('Recorded success matches the current configuration and stored credential version.', { exact: true }).waitFor();
    await wizardStage(page, 'Review evidence and register');
    await responseAfter(page, `${onboardingBase}/registrations`, 'POST', () => press(control(page, 'Register profile')));
    await wizardStage(page, 'Confirm profile activation');
    await control(page, 'Activate profile').waitFor();
    await responseAfter(page, `${onboardingBase}/activations`, 'POST', () => press(control(page, 'Activate profile')));
    await page.getByText('Profile activation confirmed. Select this profile in current storage settings to use it for new uploads.', { exact: true }).waitFor();
    await wizardStage(page, 'Choose upload destinations');
    const activated = await owner.originalState();
    assert.equal(activated.nativeBindings.length, 1, 'Actual native activation binding absent');
    // Authority setup may establish the R2 legacy policy. S3 activation itself
    // must not append a user-selected destination policy revision.
    assert(activated.policy.every(row => row.storage_profile_id !== activated.nativeBindings[0].storage_profile_id), 'Activation implicitly selected S3 for uploads');
    assert(report.provider.requests.some(item => item.method === 'PUT') && report.provider.requests.some(item => item.method === 'GET')
      && report.provider.requests.some(item => item.method === 'HEAD') && report.provider.requests.some(item => item.method === 'DELETE'), 'Missing real application provider transport stages');
    report.lifecycle = { actualCheckAndCleanup: true, independentlyVerifiedSigV4: true, nativeRegistration: true,
      nativeActivation: true, activationDoesNotSelectUploadDefaults: true, providerTransportSynthetic: true,
      temporaryObjectsConfirmedAbsent: owner.assertProviderCleanup(), wizardTracksExactVerifiedStages: true };
    report.activatedScreenshot = await safeScreenshot(page, owner, 'tested-registered-activated', activeSecrets);

    report.stage = 'independent-per-role-upload-default-authorization';
    const nativeS3 = activated.nativeBindings[0].storage_profile_id;
    const r2 = report.fixtureAuthority.bootstrapR2ProfileId;
    await page.goto(`${owner.browserOrigin}/settings/storage`);
    await page.getByRole('heading', { name: 'Upload destinations', exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Embedded media, previews and generated files', exact: true }).selectOption(r2);
    await page.getByRole('combobox', { name: 'Original research files and Project attachments', exact: true }).selectOption(nativeS3);
    await responseAfter(page, '/api/settings/storage/defaults', 'PUT', () => press(control(page, 'Save upload destinations')));
    const selected = await owner.request('/api/settings/storage?version=3');
    assert.equal(selected.roleDefaults.internal.profileId, r2, 'Internal uploads changed without independent choice');
    assert.equal(selected.roleDefaults.originals.profileId, nativeS3, 'Explicit S3 destination was not selected');
    await page.getByRole('combobox', { name: 'Original research files and Project attachments', exact: true }).waitFor();
    report.defaultsScreenshot = await safeScreenshot(page, owner, 'explicit-upload-destinations', activeSecrets);
    await page.getByRole('combobox', { name: 'Original research files and Project attachments', exact: true }).selectOption(r2);
    await responseAfter(page, '/api/settings/storage/defaults', 'PUT', () => press(control(page, 'Save upload destinations')));
    const restored = await owner.request('/api/settings/storage?version=3');
    assert.equal(restored.roleDefaults.internal.profileId, r2);
    assert.equal(restored.roleDefaults.originals.profileId, r2);
    report.defaults = { separateUserSaveRequired: true, independentlySelectedRoles: true, r2DefaultsRestoredExplicitly: true,
      originalR2BytesUnchanged: (await owner.assertR2Unchanged()).originalR2Readable };

    report.stage = 'second-s3-no-extra-root-setup-and-lost-ack';
    const reloadsBeforeSecond = report.bindingReloads.length;
    await openConfiguration(page, owner);
    await press(control(page, 'Add AWS S3 storage'));
    await wizardStage(page, 'Save connection');
    assert.equal(await control(page, 'Generate seed').count(), 0, 'Second S3 unexpectedly requested bootstrap');
    await fillCandidate(page, second);
    owner.armLostCandidateAcknowledgement();
    await responseAfter(page, `${onboardingBase}/candidates`, 'PUT', () => press(control(page, 'Save draft')));
    await page.getByText('The save result is unavailable. Refresh saved candidates before trying again.', { exact: true }).waitFor();
    assert.equal((await owner.request(onboardingBase)).candidates.items.length, 2, 'Lost ACK changed accepted candidate count');
    assert.equal(report.bindingReloads.length, reloadsBeforeSecond, 'Second S3 required another runtime secret change');
    const candidateWrites = report.browserApi.filter(item => item.path === `${onboardingBase}/candidates` && item.method === 'PUT').length;
    await press(control(page, 'Refresh'));
    await page.getByRole('heading', { name: second.label, exact: true }).waitFor();
    assert.equal(report.browserApi.filter(item => item.path === `${onboardingBase}/candidates` && item.method === 'PUT').length, candidateWrites, 'Refresh replayed candidate save');
    await press(control(page, `Continue setup for ${second.label}`));
    await wizardStage(page, 'Test connection');
    await page.locator('.storage-wizard-selection').getByText(second.label, { exact: true }).waitFor();
    report.secondS3 = { noFurtherRuntimeSecretReload: true, acceptedExactlyOnceAfterLostAcknowledgement: true,
      refreshDoesNotReplayMutation: true, explicitSameCandidateContinuationAfterLostAcknowledgement: true };
    await secretFreeStorage(page, activeSecrets);

    if (!legacyRoot) {
      report.stage = 'existing-root-recovery-and-conflict';
      const roots = { INSTALLATION_SECRET_SEED: seed };
      report.recovery = [];
      report.recovery.push(await recoveryScreen(page, owner, 'restore_required', {}));
      report.recovery.push(await recoveryScreen(page, owner, 'restore_required', { INSTALLATION_SECRET_SEED: newSyntheticSeed() }));
      report.recovery.push(await recoveryScreen(page, owner, 'configuration_conflict', { ...roots, STORAGE_CREDENTIAL_KEYRING: newLegacyFixtureRoot() }));
      await owner.reloadCredentialRoots(roots);
      await responseAfter(page, `${onboardingBase}/encryption-readiness`, 'GET', () => press(control(page, 'Recheck setup')));
      await page.getByLabel('Access key ID', { exact: true }).waitFor();
      report.recovered = await owner.assertProtectedCredentials();
      report.recovered.originalCiphertextReadableAfterRestart = true;
    } else {
      await owner.reloadCredentialRoots({ STORAGE_CREDENTIAL_KEYRING: legacyRoot });
      report.legacyRoot.retainedCiphertextReadableAfterRestart = (await owner.assertProtectedCredentials()).metadataContainsNoSecrets;
    }
    report.stage = 'reader-and-final-r2-boundaries';
    report.r2Final = await owner.assertR2Unchanged();
    await owner.request(`${onboardingBase}/encryption-readiness`, 'GET', undefined, 403, 'reader');
    owner.setBrowserIdentity('reader');
    await page.goto(`${owner.browserOrigin}/settings/storage/configuration`);
    await page.getByRole('heading', { name: 'Read only', exact: true }).waitFor();
    assert.equal(await control(page, 'Add AWS S3 storage').count(), 0);
    assert.equal(await control(page, 'Generate seed').count(), 0);
    assert.equal(await seedOutput(page).count(), 0);
    report.reader = { actualAccessVerified: true, privilegedReadinessForbidden: true, cannotGenerateOrAddStorage: true };
    owner.setBrowserIdentity('admin');
    assert.equal(report.seedCrossedNetwork, false, 'Browser seed crossed application request boundary');
    assert.equal(report.pageErrorCount, 0, 'Application emitted an uncaught browser error');
    await secretFreeStorage(page, activeSecrets);
    report.status = 'passed'; report.stage = 'complete';
  } finally {
    seed = null; activeSecrets = []; await page.close();
  }
}
