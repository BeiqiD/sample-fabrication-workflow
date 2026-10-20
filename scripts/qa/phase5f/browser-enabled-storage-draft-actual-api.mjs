// Two finite genuine enabled-Access metadata draft browser cases.
// Existing product/JWT/administrator/D1/encryption/CAS paths are unmodified.
// Accepted isolated draft history is retained; no provider/test/activation work.
// The unchanged mature seed must finish and its Worker must stop first.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { lstat, mkdir, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [sourceValue, fixtureValue, permit, diagnosticValue, freshSourceValue, ...extra] = process.argv.slice(2);
const readOnlyLayout = permit === '--exclusive-go-read-only-retained-storage-layout';
assert(sourceValue && fixtureValue && !extra.length && (readOnlyLayout ? diagnosticValue && freshSourceValue
  : permit === '--exclusive-go-two-enabled-storage-drafts' && !diagnosticValue && !freshSourceValue),
  'Use the original two-draft permit, or the read-only retained-state permit with a new private diagnostic directory and fresh built source.');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const base = new URL('http://127.0.0.1:4219/');
const alias = resolve(tmpdir()), temporary = await realpath(alias);
const within = (root, value) => { const part = relative(root, value); return part && !part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part); };
async function privateRoot(value) {
  assert(!value.split(/[\\/]/).includes('..'));
  let path = resolve(value);
  if (within(alias, path)) path = resolve(temporary, relative(alias, path));
  assert(within(temporary, path));
  let current = temporary;
  for (const part of relative(temporary, path).split(sep)) {
    current = resolve(current, part); const info = await lstat(current);
    assert(info.isDirectory() && !info.isSymbolicLink());
  }
  const info = await lstat(path); assert.equal(info.mode & 0o777, 0o700);
  if (process.getuid) assert.equal(info.uid, process.getuid());
  assert.equal(await realpath(path), path); return path;
}
const source = await privateRoot(sourceValue), fixtureRoot = await privateRoot(fixtureValue);
assert(source !== fixtureRoot && !within(source, fixtureRoot) && !within(fixtureRoot, source));
const diagnosticRoot = readOnlyLayout ? await privateRoot(diagnosticValue) : fixtureRoot;
if (readOnlyLayout) for (const root of [source, fixtureRoot])
  assert(diagnosticRoot !== root && !within(root, diagnosticRoot) && !within(diagnosticRoot, root));
async function file(root, name) {
  assert(name && !isAbsolute(name) && !name.split(/[\\/]/).includes('..'));
  const path = resolve(root, name); assert(within(root, path));
  let current = root;
  for (const part of relative(root, path).split(sep)) { current = resolve(current, part); assert(!(await lstat(current)).isSymbolicLink()); }
  assert((await lstat(path)).isFile()); return path;
}
async function json(root, name) { return JSON.parse(await readFile(await file(root, name), 'utf8')); }
async function missing(path) {
  try { await lstat(path); assert.fail('Preserve prior qualification; use a new fixture.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function writeOnce(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
async function refused(port) {
  await new Promise((done, fail) => {
    const socket = createConnection({ host: '127.0.0.1', port }); socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); fail(new Error('Owned loopback port remains open.')); });
    socket.once('timeout', () => { socket.destroy(); fail(new Error('Loopback closure is unknown.')); });
    socket.once('error', error => { socket.destroy(); if (error.code === 'ECONNREFUSED') done(); else fail(error); });
  });
}
const isolation = await json(source, 'isolation-receipt.json');
const fixture = await json(fixtureRoot, 'process-fixture.json');
assert.equal(isolation.copiedState, false); assert.equal(isolation.sourceCopyRoot, source);
assert.equal(fixture.sourceCopyRoot, source); assert.equal(fixture.fixtureDirectory, fixtureRoot);
assert.equal(fixture.sourceHead, isolation.sourceHead); assert.equal(fixture.loopbackPort, 4219);
const isolationHash = sha(await readFile(await file(source, 'isolation-receipt.json')));
assert.equal(fixture.isolationReceiptSha256, isolationHash);
assert.equal(sha(await readFile(await file(fixtureRoot, 'process-fixture.sql'))), fixture.sqlSha256);
for (const inventory of [isolation.trackedFiles, isolation.copiedArtifactFiles]) {
  assert(inventory && Object.keys(inventory).length);
  for (const [name, digest] of Object.entries(inventory)) assert.equal(sha(await readFile(await file(source, name))), digest, `Copied input changed: ${name}`);
}
assert(process.stdin.isTTY, 'Use the original interactive TTY control channel; refuse before any owned server/browser startup.');
const helperSha256 = sha(await readFile(new URL(import.meta.url)));
if (!readOnlyLayout) assert.equal(helperSha256, isolation.trackedFiles['scripts/qa/phase5f/browser-enabled-storage-draft-actual-api.mjs']);
assert((await lstat(resolve(source, 'node_modules'))).isSymbolicLink());
assert.equal(await realpath(resolve(source, 'node_modules')), isolation.nodeModulesRoot);
const config = await json(source, '.wrangler/deploy.jsonc');
assert.equal(config.vars.AUTH_MODE, 'disabled'); assert.equal(config.account_id, undefined);
assert.equal(config.d1_databases.length, 1); assert.equal(config.d1_databases[0].binding, 'DB');
assert.equal(config.d1_databases[0].database_id, '00000000-0000-4000-8000-000000000000');
for (const key of ['remote', 'preview_database_id']) assert.equal(config.d1_databases[0][key], undefined);
assert.equal(config.r2_buckets.length, 1); assert.equal(config.r2_buckets[0].binding, 'ASSETS');
for (const key of ['remote', 'jurisdiction', 'preview_bucket_name']) assert.equal(config.r2_buckets[0][key], undefined);
const namespace = JSON.parse(config.vars.R2_BOOTSTRAP_NAMESPACE), installation = await json(source, '.wrangler/local-installation.json');
assert.deepEqual(namespace, { kind: 'local-r2', installationId: installation.installationId, bucketName: config.r2_buckets[0].bucket_name });
// The ordinary setup is historical to these two cases, and retains its own
// disabled authentication scope. It is never relabeled authenticated setup.
const priorServer = await json(fixtureRoot, 'isolated-server-receipt.json');
const priorStop = await json(fixtureRoot, 'isolated-server-stop-receipt.json');
const seed = await json(fixtureRoot, 'actual-api-fixture-receipt.json');
const physical = await json(fixtureRoot, 'physical-sqlite-before-api.json');
for (const receipt of [priorServer, priorStop, seed]) {
  assert.equal(receipt.sourceHead, isolation.sourceHead); assert.equal(receipt.sourceCopyRoot, source);
  assert.equal(receipt.fixtureDirectory, fixtureRoot); assert.equal(receipt.isolationReceiptSha256, isolationHash);
}
assert.equal(priorServer.authMode, 'disabled'); assert.equal(priorStop.status, 'stopped');
assert.equal(priorStop.disposalAwaited, true); assert.equal(priorStop.portClosed, true);
assert.equal(priorStop.sessionId, priorServer.sessionId); assert.equal(seed.serverSessionId, priorServer.sessionId);
assert.equal(seed.status, 'prepared'); assert.equal(seed.trace.length, 84);
assert(seed.trace.every(item => item.outcome === 'response_accepted'));
assert.equal(physical.status, 'passed'); assert.equal(physical.sourceHead, isolation.sourceHead);
assert.equal(physical.isolationReceiptSha256, isolationHash);
assert(Object.values(physical.results).length && Object.values(physical.results).every(item => item.quickCheck.length === 1
  && item.quickCheck[0][0] === 'ok' && item.foreignKeyCheck.length === 0));
assert.equal(priorStop.startupReceiptSha256, sha(await readFile(await file(fixtureRoot, 'isolated-server-receipt.json'))));
try { process.kill(priorServer.sessionPid, 0); assert.fail('Await the original seed Worker process exit.'); }
catch (error) { if (error.code !== 'ESRCH') throw error; }
await refused(4219);
// The contextual Refresh repair changes product code. Require an actual fresh
// ordinary build of this exact tracked source; historical95 outputs cannot qualify.
const freshBuild = await json(fixtureRoot, 'enabled-storage-draft-build-input-witness.json');
assert.equal(freshBuild.status, 'passed'); assert.deepEqual(freshBuild.command, ['npm', 'run', 'build']);
assert.equal(freshBuild.actualExitCode, 0); assert.equal(freshBuild.directChildReaped, true);
assert.equal(freshBuild.sourceHead, isolation.sourceHead);
assert.equal(freshBuild.sourceTree, isolation.sourceTree);
assert.equal(freshBuild.sourceRoot, isolation.sourceRoot);
assert.equal(freshBuild.trackedInputInventorySha256, sha(JSON.stringify(isolation.trackedFiles)));
assert.equal(freshBuild.workerSha256, isolation.activeBuild.scriptSha256);
assert.equal(freshBuild.activeBuildConfigSha256, isolation.activeBuild.configSha256);
assert.equal(freshBuild.copiedArtifactInventorySha256, sha(JSON.stringify(isolation.copiedArtifactFiles)));
assert(/^[a-f0-9]{64}$/.test(freshBuild.originalCommandReceiptSha256));
let retainedReport;
if (readOnlyLayout) {
  assert.equal(isolation.sourceHead, '01ad7ab9270f7db7b7c10fea5c31707a8923d66c');
  retainedReport = await json(fixtureRoot, 'enabled-storage-draft-browser-report.json');
  assert.equal(retainedReport.sourceHead, isolation.sourceHead);
  assert.equal(retainedReport.ownedClosure.status, 'closed');
  assert.equal(retainedReport.ownedClosure.workerDisposeAwaited, true);
  assert.equal(retainedReport.ownedClosure.workerPortRefused, true);
  assert.equal(retainedReport.acceptedDraftMetadata.length, 3);
  const copiedState = await json(diagnosticRoot, 'retained-state-copy-receipt.json');
  assert.equal(copiedState.sourceCopyRoot, source); assert.equal(copiedState.diagnosticRoot, diagnosticRoot);
  assert.equal(copiedState.originalReportSha256, sha(await readFile(await file(fixtureRoot, 'enabled-storage-draft-browser-report.json'))));
  for (const [name, digest] of Object.entries(copiedState.copiedFiles))
    assert.equal(sha(await readFile(await file(diagnosticRoot, `retained-state/${name}`))), digest);
  try { process.kill(retainedReport.sessionPid, 0); assert.fail('Await the original draft Worker process exit.'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
// The retained state keeps its genuine historical installation and receipts.
// The repaired page must be served from a separately witnessed fresh build.
const applicationSource = readOnlyLayout ? await privateRoot(freshSourceValue) : source;
let applicationIsolation = isolation, applicationBuild = freshBuild;
if (readOnlyLayout) {
  for (const root of [source, fixtureRoot, diagnosticRoot])
    assert(applicationSource !== root && !within(root, applicationSource) && !within(applicationSource, root));
  applicationIsolation = await json(applicationSource, 'isolation-receipt.json');
  assert.equal(applicationIsolation.copiedState, false);
  assert.equal(applicationIsolation.sourceCopyRoot, applicationSource);
  assert.equal(Object.keys(applicationIsolation.trackedFiles).length, 1792);
  for (const inventory of [applicationIsolation.trackedFiles, applicationIsolation.copiedArtifactFiles])
    for (const [name, digest] of Object.entries(inventory))
      assert.equal(sha(await readFile(await file(applicationSource, name))), digest, `Fresh built input changed: ${name}`);
  for (const [name, digest] of Object.entries(isolation.trackedFiles))
    if (!['scripts/qa/phase5f/browser-enabled-storage-draft-actual-api.mjs', 'src/pages/storage-settings.css'].includes(name))
      assert.equal(applicationIsolation.trackedFiles[name], digest, `Historical state consumer input changed: ${name}`);
  assert.equal(applicationIsolation.trackedFiles['src/pages/storage-settings.css'], 'c56f7a2fe5db78602e2455dfe6ddcae364fb0634c4347f8b943ccc7a422c3bb7');
  assert.equal(applicationIsolation.trackedFiles['scripts/qa/phase5f/browser-enabled-storage-draft-actual-api.mjs'], helperSha256);
  assert.equal(await realpath(resolve(applicationSource, 'node_modules')), isolation.nodeModulesRoot);
  applicationBuild = await json(applicationSource, 'fresh-storage-layout-build-input-witness.json');
  assert.equal(applicationBuild.status, 'passed'); assert.deepEqual(applicationBuild.command, ['npm', 'run', 'build']);
  assert.equal(applicationBuild.actualExitCode, 0); assert.equal(applicationBuild.directChildReaped, true);
  assert.equal(applicationBuild.sourceHead, applicationIsolation.sourceHead);
  assert.equal(applicationBuild.sourceTree, applicationIsolation.sourceTree);
  assert.equal(applicationBuild.sourceRoot, applicationIsolation.sourceRoot);
  assert.equal(applicationBuild.trackedInputInventorySha256, sha(JSON.stringify(applicationIsolation.trackedFiles)));
  assert.equal(applicationBuild.workerSha256, applicationIsolation.activeBuild.scriptSha256);
  assert.equal(applicationBuild.activeBuildConfigSha256, applicationIsolation.activeBuild.configSha256);
  assert.equal(applicationBuild.copiedArtifactInventorySha256, sha(JSON.stringify(applicationIsolation.copiedArtifactFiles)));
  assert(/^[a-f0-9]{64}$/.test(applicationBuild.originalCommandReceiptSha256));
}
const { productionWorkerArtifact } = await import(pathToFileURL(await file(applicationSource, 'scripts/production-worker-artifact.mjs')));
const artifact = await productionWorkerArtifact(applicationSource);
assert.equal(artifact.scriptPath, await file(applicationSource, applicationIsolation.activeBuild.scriptPath));
assert.equal(sha(await readFile(artifact.scriptPath)), applicationIsolation.activeBuild.scriptSha256);
const require = createRequire(resolve(source, 'package.json'));
const { Miniflare, Log, LogLevel } = require('miniflare');
const { generateKeyPair, exportJWK, SignJWT } = await import(pathToFileURL(require.resolve('jose')));
const moduleValue = process.env.PLAYWRIGHT_MODULE_PATH;
assert(moduleValue && process.env.CHROMIUM_PATH, 'Use explicitly installed Playwright and Chromium; no downloads.');
const { chromium } = require(resolve(moduleValue));
const expectedCases = readOnlyLayout ? ['retained-candidates-read-only-layout-390-dark']
  : ['draft-create-lost-reply-1280-light', 'draft-revision-conflict-390-dark'];
const output = resolve(diagnosticRoot, 'enabled-storage-draft-browser-artifacts');
const reportPath = resolve(diagnosticRoot, 'enabled-storage-draft-browser-report.json');
const stopPath = resolve(diagnosticRoot, 'enabled-storage-draft-runtime-stop.json');
const progressPath = resolve(diagnosticRoot, 'enabled-storage-draft-browser-progress.ndjson');
for (const path of [output, reportPath, stopPath, progressPath]) await missing(path);
await mkdir(output, { mode: 0o700 }); await writeFile(progressPath, '', { flag: 'wx', mode: 0o600 });
const report = { version: 1, scope: 'Two actual local enabled-Access encrypted metadata draft cases. Genuine accepted draft history is retained. No provider/test/activation/recovery/device or whole-roadmap acceptance.',
  sourceRoot: isolation.sourceRoot, sourceCopyRoot: source, sourceHead: isolation.sourceHead, sourceTree: isolation.sourceTree,
  fixtureDirectory: fixtureRoot, isolationReceiptSha256: isolationHash, helperSha256,
  seedReceiptSha256: sha(await readFile(await file(fixtureRoot, 'actual-api-fixture-receipt.json'))),
  freshBuildReceiptSha256: sha(await readFile(await file(fixtureRoot, 'enabled-storage-draft-build-input-witness.json'))),
  sessionId: randomUUID(), sessionPid: process.pid, expectedCases, cases: [], authorityControls: [], auxiliaryRequests: [], acceptedDraftMetadata: [], jwksRequests: [],
  startedAt: new Date().toISOString(), status: 'running' };
if (readOnlyLayout) report.readOnlyLayoutScope = {
  originalProducerHead: isolation.sourceHead, consumerHelperSha256: helperSha256,
  applicationSourceCopyRoot: applicationSource, applicationSourceHead: applicationIsolation.sourceHead,
  applicationSourceTree: applicationIsolation.sourceTree,
  applicationBuildWitnessSha256: sha(await readFile(await file(applicationSource, 'fresh-storage-layout-build-input-witness.json'))),
  originalProducerHelperSha256: isolation.trackedFiles['scripts/qa/phase5f/browser-enabled-storage-draft-actual-api.mjs'],
  retainedAcceptedRevisions: 3, freshMetadataWrites: 0, originalCredentialKeyReused: false,
  limitation: 'One genuine retained-metadata read layout. A fresh private keyring keeps the Edit controls rendered, but original ciphertext credentials are unavailable. No lost-write/revision case rerun.' };
if (readOnlyLayout) {
  report.scope = 'One actual local enabled-Access read-only 390dark retained-candidate layout characterization. No metadata writes/provider/test/activation/recovery or whole-roadmap acceptance.';
  report.diagnosticDirectory = diagnosticRoot;
}
let jwksServer, runtime, browser, database, originalDatabaseSnapshot, originalLeaseRows;
const metadataWriteAttempts = [];
let originalBrowserClose, originalWorkerDispose, originalJwksClose;
const activeContexts = new Set(), originalContextCloses = new WeakMap();
function notInterrupted() { assert(!report.interrupted, 'Qualification was interrupted; later cases remain unrun.'); }
function closeContext(context) {
  let original = originalContextCloses.get(context);
  if (!original) { original = context.close(); originalContextCloses.set(context, original); }
  return original;
}
function closeBrowser() { return originalBrowserClose ??= browser.close(); }
function disposeWorker() { return originalWorkerDispose ??= runtime.dispose(); }
function closeJwks() { return originalJwksClose ??= new Promise((done, fail) => jwksServer.close(error => error ? fail(error) : done())); }
// Miniflare's installed SIGTERM hook calls process.exit(143), so signals are
// external interruption evidence, never an awaited normal finally mechanism.
// Only an explicit stop on this helper's original inherited TTY starts this
// ordered cancellation. Keep D1 alive until accepted draft history is read.
let originalControlStop;
function stopFromOriginalControl() {
  return originalControlStop ??= (async () => {
    report.interrupted ??= 'original-stdin-stop'; report.status = 'failed';
    report.originalStdinStopReceived = report.controlInputError === undefined;
    try { await Promise.all([...activeContexts].map(closeContext)); }
    finally { if (browser) await closeBrowser(); }
  })();
}
function originalControlInput(value) {
  if (value !== 'stop\n') {
    report.controlInputError = 'Only the original explicit stop command is permitted.';
  }
  void stopFromOriginalControl().catch(error => {
    report.controlStopError = privateError(error);
  });
}
process.stdin.setEncoding('utf8');
process.stdin.once('data', originalControlInput);
process.stdin.resume();
let issuer, issuerPort, adminToken, readerToken, signingKey;
const admin = 'administrator@enabled-draft.invalid', reader = 'reader@enabled-draft.invalid';
const audience = `enabled-draft-${randomUUID()}`;
const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const canonical = value => JSON.stringify(value, (_key, item) => item instanceof ArrayBuffer
  ? { bytes: Buffer.from(item).toString('hex') } : ArrayBuffer.isView(item) ? { bytes: Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString('hex') } : item);
// Private inputs stay only in this process. Redact them from diagnostic
// errors without weakening any assertion or persisting their values/hashes.
const privateValues = new Set();
const privateDraftInputs = new WeakMap();
function privateError(error) {
  let text = String(error.stack || error.message || error);
  for (const value of privateValues) if (value) text = text.split(value).join('[private fixture input]');
  return text;
}
function metadata(value, input, revision) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['createdAt','createdBy','credentials','label','namespace','profileId','revision']);
  assert.equal(typeof value.profileId, 'string'); assert.match(value.profileId, /^external:[0-9a-f-]{36}$/);
  assert.equal(value.revision, revision); assert.equal(value.label, input.label);
  assert.deepEqual(value.namespace, input.namespace); assert.equal(value.createdBy, admin);
  assert.equal(typeof value.createdAt, 'string'); assert(Number.isFinite(Date.parse(value.createdAt)));
  assert.deepEqual(Object.keys(value.credentials).sort(), ['ref','status']);
  assert.equal(value.credentials.status, 'configured'); assert.match(value.credentials.ref, /^credential:[0-9a-f-]{36}$/);
  if (input.profileId) assert.equal(value.profileId, input.profileId);
  report.acceptedDraftMetadata.push(value); return value;
}
const changedTables = ['system_storage_profiles','system_storage_configuration_revisions','system_storage_credential_descriptors',
  'system_storage_credential_payloads','system_storage_configuration_audit'];
async function verifyAcceptedHistory(snapshotAfter) {
  if (readOnlyLayout) {
    assert.deepEqual(snapshotAfter, originalDatabaseSnapshot, 'Read-only layout changed retained application schema/rows.');
    assert.equal(metadataWriteAttempts.length, 0);
    assert(report.cases.every(item => item.browserRequests.every(request => !mutationMethods.has(request.method))));
    report.retainedApplicationSchemaAndAllRowsUnchanged = true; return;
  }
  assert.equal(snapshotAfter.schemaSha256, originalDatabaseSnapshot.schemaSha256);
  assert.deepEqual(Object.keys(snapshotAfter.tables), Object.keys(originalDatabaseSnapshot.tables));
  for (const [name, row] of Object.entries(originalDatabaseSnapshot.tables)) {
    if (!changedTables.includes(name) && name !== 'system_recovery_write_leases')
      assert.deepEqual(snapshotAfter.tables[name], row, `Unrelated fixture rows changed: ${name}`);
  }
  // Valid metadata PUTs acquire one actual source-write permit, including a
  // stale-revision SELECT which returns409. Reads and shape/auth failures do not.
  // Preserve every original lease row byte-for-byte and qualify only exact new
  // rows against these observed original PUT windows; expiry is not release.
  const leases = (await database.prepare('SELECT * FROM system_recovery_write_leases').all()).results;
  const retained = leases.filter(row => originalLeaseRows.some(before => before.id === row.id));
  assert.deepEqual(retained.map(canonical).sort(), originalLeaseRows.map(canonical).sort(), 'Retain exact original write-permit history.');
  assert.deepEqual({ count: retained.length, sha256: sha(retained.map(canonical).sort().join('\n')) },
    originalDatabaseSnapshot.tables.system_recovery_write_leases);
  const added = leases.filter(row => !originalLeaseRows.some(before => before.id === row.id));
  assert.equal(new Set(leases.map(row => row.id)).size, leases.length);
  assert.equal(added.length, metadataWriteAttempts.length, 'Exactly one admitted permit per observed valid metadata PUT.');
  const maintenance = await database.prepare('SELECT state,generation FROM system_recovery_maintenance WHERE singleton=1').first();
  assert.equal(maintenance.state, 'open');
  const remaining = [...added], permits = [];
  for (const [ordinal, attempt] of metadataWriteAttempts.entries()) {
    assert([200,409].includes(attempt.status) && attempt.completedAt, 'An unfinished original PUT has no qualified permit window.');
    const matches = remaining.filter(row => row.owner === admin && row.kind === 'http' && row.generation === maintenance.generation
      && typeof row.released_at === 'string' && Date.parse(attempt.startedAt) <= Date.parse(row.created_at)
      && Date.parse(row.created_at) <= Date.parse(row.released_at) && Date.parse(row.released_at) <= Date.parse(attempt.completedAt));
    assert.equal(matches.length, 1, 'Require one unique current-actor, kind, generation and released permit in this original PUT window.');
    const row = matches[0];
    assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), 300000);
    remaining.splice(remaining.indexOf(row), 1);
    permits.push({ originalPutOrdinal: ordinal + 1, channel: attempt.channel, status: attempt.status,
      startedAt: attempt.startedAt, completedAt: attempt.completedAt, permitIdSha256: sha(row.id), rowSha256: sha(canonical(row)),
      authenticatedActorMatches: true, kind: row.kind, currentGenerationMatches: true, generation: row.generation,
      createdAt: row.created_at, expiresAt: row.expires_at, releasedAt: row.released_at });
  }
  assert.equal(remaining.length, 0);
  report.sourceWritePermitHistory = { originalCount: retained.length, originalRowsSha256: originalDatabaseSnapshot.tables.system_recovery_write_leases.sha256,
    originalRowsExact: true, newCount: added.length, permits,
    correlationScope: 'Exact original valid PUT windows/actor/http/current generation with released permits; the lease schema has no request or profile lineage column.' };
  const accepted = report.acceptedDraftMetadata;
  const ids = [...new Set(accepted.map(item => item.profileId))].sort();
  const refs = accepted.map(item => item.credentials.ref).sort();
  assert.equal(new Set(refs).size, refs.length);
  assert.equal(snapshotAfter.tables.system_storage_profiles.count, ids.length);
  for (const name of changedTables.slice(1)) assert.equal(snapshotAfter.tables[name].count, accepted.length, `Accepted history count: ${name}`);
  const profiles = (await database.prepare('SELECT id,latest_revision FROM system_storage_profiles ORDER BY id').all()).results;
  assert.deepEqual(profiles, ids.map(id => ({ id, latest_revision: Math.max(...accepted.filter(item => item.profileId === id).map(item => item.revision)) })));
  const revisions = (await database.prepare('SELECT profile_id,revision,label,credential_ref,created_by FROM system_storage_configuration_revisions ORDER BY profile_id,revision').all()).results;
  assert.deepEqual(revisions, accepted.map(item => ({ profile_id:item.profileId, revision:item.revision, label:item.label,
    credential_ref:item.credentials.ref, created_by:admin })).sort((a,b) => a.profile_id.localeCompare(b.profile_id) || a.revision-b.revision));
  const descriptors = (await database.prepare('SELECT credential_ref,profile_id,configuration_revision FROM system_storage_credential_descriptors ORDER BY credential_ref').all()).results;
  assert.deepEqual(descriptors, accepted.map(item => ({ credential_ref:item.credentials.ref, profile_id:item.profileId,
    configuration_revision:item.revision })).sort((a,b) => a.credential_ref.localeCompare(b.credential_ref)));
  const payloads = (await database.prepare('SELECT credential_ref,envelope_revision,envelope_version,key_id FROM system_storage_credential_payloads ORDER BY credential_ref').all()).results;
  assert.deepEqual(payloads, refs.map(ref => ({ credential_ref:ref,envelope_revision:1,envelope_version:1,key_id:privateKeyId })));
  const audit = (await database.prepare('SELECT profile_id,configuration_revision,actor,operation,outcome FROM system_storage_configuration_audit ORDER BY profile_id,configuration_revision').all()).results;
  assert.deepEqual(audit, revisions.map(item => ({ profile_id:item.profile_id,configuration_revision:item.revision,
    actor:admin,operation:item.revision===1?'candidate_create':'candidate_revise',outcome:'saved' })));
  assert.deepEqual((await database.prepare('PRAGMA foreign_key_check').all()).results, []);
}
let privateKeyId;
async function snapshot() {
  const schema = (await database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results;
  assert(schema.length > 0 && schema.length < 3000);
  const tables = schema.filter(item => item.type === 'table' && !item.name.startsWith('_cf_'));
  const rows = {};
  for (const table of tables) {
    assert(/^[a-zA-Z0-9_]+$/.test(table.name));
    const values = (await database.prepare(`SELECT * FROM "${table.name}"`).all()).results;
    assert(values.length < 10000); rows[table.name] = { count: values.length, sha256: sha(values.map(canonical).sort().join('\n')) };
  }
  return { schemaSha256: sha(canonical(schema)), tables: rows };
}
async function actualRequest(path, token, expected, method = 'GET', body) {
  notInterrupted();
  const attempt = method === 'PUT' ? { channel: 'auxiliary', startedAt: new Date().toISOString() } : undefined;
  if (attempt) metadataWriteAttempts.push(attempt);
  const response = await fetch(new URL(path, base), { method, headers: { ...(token ? { 'cf-access-jwt-assertion': token } : {}), origin: base.origin,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error', signal: AbortSignal.timeout(20000) });
  const bytes = Buffer.from(await response.arrayBuffer()); assert(bytes.length < 131072);
  if (attempt) { attempt.status = response.status; attempt.completedAt = new Date().toISOString(); }
  assert.equal(response.status, expected, `${method} ${path}`);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  const value = JSON.parse(bytes);
  report.auxiliaryRequests.push({ path, method, status:response.status, responseSha256:sha(bytes) });
  return { status: response.status, responseSha256: sha(bytes), value };
}
async function sign(email, options = {}) {
  notInterrupted();
  return new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'enabled-draft-fixture-key' })
    .setIssuer(issuer).setAudience(options.audience || audience).setSubject(`fixture:${email}`)
    .setIssuedAt().setExpirationTime(options.expires ?? '5m').sign(signingKey);
}
async function visible(locator) { await locator.waitFor({ state: 'visible', timeout: 20000 }); }
async function absent(locator) { await locator.waitFor({ state: 'hidden', timeout: 20000 }); }
async function geometry(page, record, surface, theme) {
  const value = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const safeClasses = new Set(['page', 'storage-settings-page', 'page-heading', 'button', 'primary', 'card', 'storage-settings-section',
      'storage-profile-list', 'storage-profile-heading', 'storage-candidate-checks', 'storage-candidate-readiness', 'storage-credential-encryption',
      'storage-candidate-form', 'storage-candidate-fields', 'storage-candidate-credentials', 'storage-candidate-actions', 'storage-candidate-checkbox',
      'storage-readiness-details', 'storage-check-stages', 'storage-settings-observation', 'muted', 'error-banner', 'lead']);
    const safeIds = new Set(['storage-candidates-title', 'storage-editor-title', 'storage-expected-owner-help']);
    const safeRoles = new Set(['alert', 'status', 'button', 'heading', 'region', 'group', 'list', 'listitem']);
    const number = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
    const elements = [...document.querySelectorAll('body *')];
    const offenders = [];
    for (const element of elements.slice(0, 3000)) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || (rect.left >= -2 && rect.right <= width + 2)) continue;
      const role = element.getAttribute('role');
      offenders.push({ tag: element.tagName.toLowerCase(), classes: [...element.classList].filter(token => safeClasses.has(token)).slice(0, 8),
        id: safeIds.has(element.id) ? element.id : null, role: safeRoles.has(role) ? role : null,
        rect: { left: number(rect.left), right: number(rect.right), top: number(rect.top), bottom: number(rect.bottom), width: number(rect.width), height: number(rect.height) },
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth });
    }
    return { width, viewport: { width: innerWidth, height: innerHeight }, root: document.documentElement.scrollWidth,
      body: document.body.scrollWidth, theme: document.documentElement.dataset.theme, inspectedElements: Math.min(elements.length, 3000),
      totalElements: elements.length, offendingElements: offenders.slice(0, 24), remainingOffenderCount: Math.max(0, offenders.length - 24) };
  });
  // Persist bounded numeric geometry before the original assertion. Never record
  // text, form values, URLs, arbitrary attributes, DOM markup or a failed screenshot.
  record.assertions.push({ surface, geometry: value });
  assert.match(record.id, /^[a-z0-9-]+$/); assert.match(surface, /^[a-z0-9-]+$/);
  await writeFile(resolve(output, `${record.id}.${surface}.geometry.json`), canonical({ surface, geometry: value }) + '\n', { flag: 'wx', mode: 0o600 });
  assert.equal(value.theme, theme); assert(value.root <= value.width + 2 && value.body <= value.width + 2);
}
async function caseRun(id, width, theme, token, action) {
  notInterrupted();
  const record = { id, width, theme, browserRequests: [], status: 'running', assertions: [], api: [], pageErrors: [], externalRequests: [], startedAt: new Date().toISOString() };
  report.cases.push(record); await writeFile(progressPath, canonical({ id, status: 'running' }) + '\n', { flag: 'a' });
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, isMobile: width === 390,
    hasTouch: width === 390, serviceWorkers: 'block' });
  activeContexts.add(context);
  const observations = [];
  const originalResponseObservations = new WeakMap(), originalPutAttempts = new WeakMap();
  let originalUnavailableBodyException, lostOriginalRequest, lostAcceptance, originalInterceptionWork;
  let finishLostReply, failLostReply;
  const originalLostReply = new Promise((done, fail) => { finishLostReply=done; failLostReply=fail; });
  originalLostReply.catch(() => {});
  const originalRequestTerminals = new WeakMap(), originalTerminalWaiters = new WeakMap();
  try {
    notInterrupted();
    // Header injection is confined to the exact local API origin. JWTs never
    // enter fixture receipts, browser storage, screenshots or external assets.
    await context.route('**/*', async route => {
      const request = route.request(), target = new URL(request.url());
      if (['http:', 'https:'].includes(target.protocol) && target.origin !== base.origin) {
        record.externalRequests.push({ origin: target.origin }); await route.abort('blockedbyclient'); return;
      }
      if (target.origin === base.origin && target.pathname.startsWith('/api/')) {
        if (readOnlyLayout && mutationMethods.has(request.method())) {
          record.unexpectedReadOnlyMutation = { method: request.method(), path: target.pathname };
          await route.abort('blockedbyclient'); return;
        }
        const headers = { ...request.headers(), 'cf-access-jwt-assertion': token };
        if (request.method() === 'PUT') {
          assert.equal(target.pathname, '/api/storage/configuration/candidates');
          const attempt = { channel: 'browser', startedAt: new Date().toISOString() };
          metadataWriteAttempts.push(attempt); originalPutAttempts.set(request, attempt);
        }
        if (id===expectedCases[0] && request.method()==='PUT' && target.pathname==='/api/storage/configuration/candidates') {
          if (originalInterceptionWork) {
            const error=new Error('Never send a second accepted create request.');
            record.originalInterceptionError=privateError(error); failLostReply(error);
            await route.abort('failed'); return;
          }
          originalInterceptionWork=(async()=>{ try {
            assert.equal(lostOriginalRequest, undefined, 'Never send a second accepted create request.');
            lostOriginalRequest=request;
            const response=await route.fetch({ headers,timeout:20000,maxRedirects:0,maxRetries:0 });
            const bytes=await response.body(); assert(bytes.length<131072); assert.equal(response.status(),200);
            assert.match(response.headers()['cache-control']||'', /no-store/);
            const attempt = originalPutAttempts.get(request);
            attempt.status = response.status(); attempt.completedAt = new Date().toISOString();
            lostAcceptance=metadata(JSON.parse(bytes), privateDraftInputs.get(record), 1);
            record.originalCommit={ method:'PUT',path:target.pathname,status:200,responseSha256:sha(bytes),
              profileId:lostAcceptance.profileId,revision:lostAcceptance.revision,controlledReplyLoss:true };
            privateDraftInputs.delete(record);
            record.controlledReplyLossStarted=true;
            await route.abort('failed'); finishLostReply(lostAcceptance);
          } catch(error) {
            record.originalInterceptionError=privateError(error);
            failLostReply(new Error(privateError(error)));
            try { await route.abort('failed'); }
            catch(closeError) { record.interceptionCloseError=privateError(closeError); }
          } })();
          await originalInterceptionWork;
        } else await route.continue({ headers });
      } else await route.continue();
    });
    await context.addInitScript(value => localStorage.setItem('sample-workflow-theme', value), theme);
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => record.pageErrors.push(privateError(error)));
    page.on('request', request => { const url=new URL(request.url());
      if(url.origin===base.origin && url.pathname.startsWith('/api/')) record.browserRequests.push({path:url.pathname,method:request.method()}); });
    // Arm native terminal observers before navigation. A status-only fetch
    // may finish normally before Refresh, or its unread body may be aborted.
    function observeTerminal(request, type) {
      const event = { type, failure: request.failure(), controlledRefreshStarted: record.controlledRefreshStarted === true,
        controlledReplyLossStarted: record.controlledReplyLossStarted === true };
      const previous = originalRequestTerminals.get(request);
      if (previous) { previous.duplicateTerminalEvent = event; return; }
      originalRequestTerminals.set(request, event);
      originalTerminalWaiters.get(request)?.(event);
    }
    page.on('requestfinished', request => observeTerminal(request, 'requestfinished'));
    page.on('requestfailed', request => observeTerminal(request, 'requestfailed'));
    page.on('response', response => {
      const url = new URL(response.url()); if (url.origin !== base.origin || !url.pathname.startsWith('/api/')) return;
      const attempt = originalPutAttempts.get(response.request());
      if (attempt) { attempt.status = response.status(); attempt.completedAt = new Date().toISOString(); }
      const item = { path: url.pathname, method: response.request().method(), status: response.status(), body: 'pending' };
      record.api.push(item);
      const original = response.body();
      const observation = original.then(bytes => { assert(bytes.length < 131072); item.body = 'completed'; item.responseSha256 = sha(bytes); })
        .catch(error => { item.body = 'failed'; item.error = privateError({message:error.message}); });
      const terminal = new Promise(done => {
        const existing = originalRequestTerminals.get(response.request());
        if (existing) done(existing); else originalTerminalWaiters.set(response.request(), done);
      });
      originalResponseObservations.set(response, { item, observation, terminal }); observations.push(observation);
    });
    await action(page, record, async response => {
      const captured = originalResponseObservations.get(response); assert(captured, 'Require the original response observation.');
      assert.equal(id, 'draft-revision-conflict-390-dark');
      assert.equal(captured.item.path, '/api/storage/configuration/candidates');
      assert.equal(captured.item.method, 'PUT'); assert.equal(captured.item.status, 409);
      let timer, terminal;
      try {
        [terminal] = await Promise.race([
          Promise.all([captured.terminal, captured.observation]),
          new Promise((_done, fail) => { timer = setTimeout(() => fail(new Error('Original response terminal/body observation exceeded the existing 20s request budget.')), 20000); }),
        ]);
      } finally { clearTimeout(timer); }
      assert.equal(terminal, originalRequestTerminals.get(response.request()), 'Use the exact original native Request terminal event.');
      assert.equal(terminal.duplicateTerminalEvent, undefined);
      if (terminal.type === 'requestfinished') assert.equal(terminal.failure, null);
      else {
        assert.equal(terminal.type, 'requestfailed');
        assert.equal(terminal.controlledRefreshStarted, true, 'Cancellation must follow the explicit Refresh.');
        assert.deepEqual(terminal.failure, { errorText: 'net::ERR_ABORTED' });
      }
      captured.item.nativeRequestTerminal = terminal;
      if (captured.item.body !== 'completed') {
        assert.equal(captured.item.body, 'failed');
        assert.equal(captured.item.error, 'response.body: Protocol error (Network.getResponseBody): No data found for resource with given identifier');
        assert.equal(captured.item.responseSha256, undefined, 'Unavailable payload has no observed bytes/hash.');
        captured.item.body = terminal.type === 'requestfinished' ? 'unused-error-body-unavailable' : 'cancelled-after-explicit-refresh';
        originalUnavailableBodyException = captured.item;
      }
      record.assertions.push({ original409RequestTerminal: terminal, originalBodyOutcome: captured.item.body,
        originalResponseCaptureTerminalError: captured.item.error, observedResponseSha256: captured.item.responseSha256 });
    }, () => originalLostReply);
    if(lostOriginalRequest) {
      let terminal=originalRequestTerminals.get(lostOriginalRequest);
      if(!terminal) {
        let timer;
        try { terminal=await Promise.race([
          new Promise(done=>originalTerminalWaiters.set(lostOriginalRequest,done)),
          new Promise((_done,fail)=>{timer=setTimeout(()=>fail(new Error('Original lost-reply Request terminal exceeded the existing 20s request budget.')),20000);}),
        ]); } finally { clearTimeout(timer); }
      }
      assert.equal(terminal.type,'requestfailed'); assert.deepEqual(terminal.failure,{errorText:'net::ERR_FAILED'});
      assert.equal(terminal.controlledReplyLossStarted,true);
      assert.equal(terminal.duplicateTerminalEvent,undefined);
      record.originalLostReplyTerminal={type:terminal.type,failure:terminal.failure,accepted200BeforeControlledLoss:true};
    }
    await Promise.all(observations);
    assert(record.api.every(item => item.body === 'completed' || (item === originalUnavailableBodyException && ['unused-error-body-unavailable', 'cancelled-after-explicit-refresh'].includes(item.body))), 'Every original API response body must settle before context shutdown.');
    await closeContext(context); record.contextClosed = true;
    await Promise.all(observations);
    assert(record.api.every(item => item.body === 'completed' || (item === originalUnavailableBodyException && ['unused-error-body-unavailable', 'cancelled-after-explicit-refresh'].includes(item.body))), 'Every original API response body must settle.');
    assert.equal(record.pageErrors.length, 0); assert.equal(record.externalRequests.length, 0);
    assert.equal(record.originalInterceptionError,undefined);
    const writes=record.browserRequests.filter(item=>mutationMethods.has(item.method));
    assert.deepEqual(writes,readOnlyLayout ? [] : [{path:'/api/storage/configuration/candidates',method:'PUT'}]);
    assert(record.api.every(item=>!mutationMethods.has(item.method)||(id===expectedCases[1] && item.path==='/api/storage/configuration/candidates' && item.method==='PUT' && item.status===409)));
    if (readOnlyLayout) {
      assert.deepEqual(writes, []); assert.equal(metadataWriteAttempts.length, 0);
      assert.equal(record.unexpectedReadOnlyMutation, undefined); assert.equal(record.originalCommit, undefined);
    } else {
    if(id===expectedCases[0]) assert.equal(record.originalCommit.status,200);
    else assert.equal(record.api.filter(item=>item.method==='PUT' && item.status===409).length,1);
    }
    record.status = 'passed';
  } catch (error) { record.status = 'failed'; record.error = privateError(error); throw error; }
  finally {
    if (!record.contextClosed) { try { await closeContext(context); record.contextClosed = true; } catch (error) { record.contextCloseError = privateError(error); } }
    if(originalInterceptionWork) {
      try { await originalInterceptionWork; record.originalInterceptionAwaited=true; }
      catch(error) { record.originalInterceptionError=privateError(error); }
    }
    activeContexts.delete(context); privateDraftInputs.delete(record);
    await Promise.all(observations); record.completedAt = new Date().toISOString();
    await writeFile(progressPath, canonical({ id, status: record.status, contextClosed: record.contextClosed === true }) + '\n', { flag: 'a' });
  }
}
function credentials() {
  const value={username:`private-user-${randomUUID()}`,password:`private-password-${randomUUID()}`};
  privateValues.add(value.username); privateValues.add(value.password); return value;
}
function input(label) { return { expectedRevision:null,label,
  namespace:{kind:'webdav',endpoint:`https://draft-${randomUUID()}.invalid/files`,root:'archive'},
  credentials:{mode:'replace',value:credentials()} }; }
async function noPrivateInputs(page) {
  const values=await page.evaluate(()=>({text:document.body.textContent,
    storage:[...Object.values(localStorage),...Object.values(sessionStorage)]}));
  for(const value of privateValues) assert(!values.text.includes(value)&&values.storage.every(item=>!item.includes(value)), 'Private fixture inputs must not be rendered or persisted.');
  for(const label of ['Username','Password','Access key ID','Secret access key','Session token (optional)']) {
    const field=page.getByLabel(label,{exact:true}); if(await field.count()) assert.equal((await field.inputValue()).length,0,'Credential field must be cleared.');
  }
}
async function refreshed(page, record) {
  const read=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/storage/configuration');
  const control=page.getByRole('button',{name:'Refresh',exact:true}); await visible(control); await control.focus();
  assert(await control.evaluate(node=>document.activeElement===node)); record.controlledRefreshStarted=true;
  await page.keyboard.press('Enter'); const response=await read; assert.equal(response.status(),200);
  await visible(page.getByRole('heading',{name:'New candidate',exact:true})); await absent(page.getByRole('alert'));
  await noPrivateInputs(page); return response;
}
async function candidateReady(page, value) {
  const row=page.getByRole('listitem').filter({has:page.getByRole('heading',{name:value.label,exact:true})});
  await visible(row.getByRole('button',{name:`Check test status for ${value.label}`,exact:true}));
  await visible(row.getByText('This candidate has no recorded tests.',{exact:true}));
}
async function presentation(locator, record, name) {
  await visible(locator);
  const value=await locator.evaluate(node=>{const css=getComputedStyle(node);return {
    active:document.activeElement===node,focusVisible:node.matches(':focus-visible'),
    color:css.color,backgroundColor:css.backgroundColor,outlineColor:css.outlineColor,
    outlineWidth:css.outlineWidth,outlineStyle:css.outlineStyle,boxShadow:css.boxShadow};});
  (record.presentations??=[]).push({name,...value});
  if(name==='focused-refresh') assert.equal(value.active,true);
}

try {
  const keys = await generateKeyPair('RS256'); signingKey = keys.privateKey;
  notInterrupted();
  const publicKey = { ...await exportJWK(keys.publicKey), kid: 'enabled-draft-fixture-key', alg: 'RS256', use: 'sig' };
  const publicBytes = Buffer.from(JSON.stringify({ keys: [publicKey] }));
  jwksServer = createServer((request, response) => {
    const observation = { method: request.method, path: request.url, at: new Date().toISOString() }; report.jwksRequests.push(observation);
    if (request.method !== 'GET' || request.url !== '/cdn-cgi/access/certs') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': publicBytes.length }); response.end(publicBytes);
  });
  await new Promise((done, fail) => { jwksServer.once('error', fail); jwksServer.listen(0, '127.0.0.1', done); });
  issuerPort = jwksServer.address().port; issuer = `http://127.0.0.1:${issuerPort}`;
  report.jwksOwner = { host: '127.0.0.1', port: issuerPort, publicJwksSha256: sha(publicBytes), issuerScope: 'Fresh private local issuer, no remote Access acceptance' };
  adminToken = await sign(admin); readerToken = await sign(reader);
  privateValues.add(adminToken); privateValues.add(readerToken);
  const vars = { ...config.vars, AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience,
    ALLOWED_EMAILS: `${admin},${reader}`, SYSTEM_ADMIN_EMAILS: admin };
  // The ephemeral ordinary keyring enables only candidate metadata writes.
  // No provider capability/test/registration/activation is manufactured.
  privateKeyId=`draft-${randomUUID()}`; const keyMaterial=randomBytes(32);
  const encodedKey=keyMaterial.toString('base64'); keyMaterial.fill(0);
  vars.STORAGE_CREDENTIAL_KEYRING=JSON.stringify({version:1,currentKeyId:privateKeyId,keys:{[privateKeyId]:encodedKey}});
  privateValues.add(encodedKey); privateValues.add(vars.STORAGE_CREDENTIAL_KEYRING);
  runtime = new Miniflare({ ...artifact, rootPath: applicationSource, modulesRoot: applicationSource, modules: true, host: '127.0.0.1', port: 4219,
    bindings: vars, d1Databases: { DB: config.d1_databases[0].database_id }, d1Persist: resolve(readOnlyLayout ? diagnosticRoot : source, readOnlyLayout ? 'retained-state/v3/d1' : '.wrangler/state/v3/d1'),
    r2Buckets: { ASSETS: config.r2_buckets[0].bucket_name }, r2Persist: resolve(readOnlyLayout ? diagnosticRoot : source, readOnlyLayout ? 'retained-state/v3/r2' : '.wrangler/state/v3/r2'), log: new Log(LogLevel.ERROR),
    outboundService: async request => {
      assert.equal(request.url, `${issuer}/cdn-cgi/access/certs`, 'Only the owned original JOSE JWKS request may leave the Worker.');
      assert.equal(request.method, 'GET');
      const response = await fetch(request.url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
    } });
  assert.equal(new URL((await runtime.ready).href).origin, base.origin);
  notInterrupted();
  database = await runtime.getD1Database('DB');
  const names = (await readdir(resolve(source, 'migrations'))).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  assert.equal(names.length, 24); assert.equal(names.at(-1).slice(0, 4), '0024');
  assert.deepEqual((await database.prepare('SELECT name FROM d1_migrations ORDER BY name').all()).results.map(item => item.name), names);
  for (const [id, version] of [[fixture.ids.v1, 1], [fixture.ids.v2, 2]]) {
    const row = await database.prepare('SELECT id,version,initial_state_hash FROM template_versions WHERE id=?').bind(id).first();
    assert.deepEqual(row, { id, version, initial_state_hash: fixture.initialStateHash });
  }
  originalDatabaseSnapshot = await snapshot(); report.databaseBefore = originalDatabaseSnapshot;
  originalLeaseRows = (await database.prepare('SELECT * FROM system_recovery_write_leases').all()).results;
  assert.deepEqual({ count: originalLeaseRows.length, sha256: sha(originalLeaseRows.map(canonical).sort().join('\n')) },
    originalDatabaseSnapshot.tables.system_recovery_write_leases);
  if (readOnlyLayout) assert.deepEqual(originalDatabaseSnapshot, retainedReport.databaseAfter);
  else for(const name of changedTables) assert.equal(originalDatabaseSnapshot.tables[name].count,0);
  const adminCapability=await actualRequest('/api/storage/configuration/capability',adminToken,200);
  assert.deepEqual(adminCapability.value,{canManage:true,credentialEditingAvailable:true});
  const readerCapability=await actualRequest('/api/storage/configuration/capability',readerToken,200);
  assert.deepEqual(readerCapability.value,{canManage:false,credentialEditingAvailable:false});
  report.authorityControls.push({id:'genuine-signed-admin-with-private-keyring',status:200,responseSha256:adminCapability.responseSha256},
    {id:'genuine-signed-reader',status:200,responseSha256:readerCapability.responseSha256});
  assert(report.jwksRequests.some(item=>item.method==='GET' && item.path==='/cdn-cgi/access/certs'));
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox']});
  notInterrupted();
  if (readOnlyLayout) {
    await caseRun(expectedCases[0],390,'dark',adminToken,async(page,record)=>{
      await page.goto(new URL('/settings/storage/configuration',base).href);
      const latest = retainedReport.acceptedDraftMetadata.filter(item => !retainedReport.acceptedDraftMetadata.some(other =>
        other.profileId === item.profileId && other.revision > item.revision));
      assert.equal(latest.length, 2);
      for (const candidate of latest) {
        await candidateReady(page,candidate);
        await visible(page.getByRole('button',{name:`Edit ${candidate.label}`,exact:true}));
      }
      record.assertions.push({ genuineRetainedCandidates: 2, originalCredentialKeyUnavailable: true,
        freshKeyringOnlyKeepsNativeEditControls: true, metadataWrites: 0 });
      await geometry(page,record,'retained-candidates-read-only-layout','dark');
    });
    assert.equal(report.acceptedDraftMetadata.length,0);
  } else {
  await caseRun(expectedCases[0],1280,'light',adminToken,async(page,record,_unused409,originalLostReply)=>{
    const draft=input(`Research archive 原始实验记录 retained draft ${randomUUID()}`);
    privateDraftInputs.set(record,draft);
    await page.goto(new URL('/settings/storage/configuration',base).href);
    await visible(page.getByRole('heading',{name:'New candidate',exact:true}));
    await page.getByLabel('Provider').selectOption('webdav');
    for(const [name,value] of [['Name',draft.label],['HTTPS endpoint',draft.namespace.endpoint],['Root folder',draft.namespace.root],
      ['Username',draft.credentials.value.username],['Password',draft.credentials.value.password]]) await page.getByLabel(name,{exact:true}).fill(value);
    const save=page.getByRole('button',{name:'Save draft',exact:true}); await save.focus(); await page.keyboard.press('Enter');
    let accepted, lostReplyTimer;
    try {
      accepted=await Promise.race([
        originalLostReply(),
        new Promise((_done,fail)=>{lostReplyTimer=setTimeout(()=>fail(new Error('Original accepted-write reply interception exceeded the existing 20s request budget.')),20000);}),
      ]);
    } finally { clearTimeout(lostReplyTimer); }
    await visible(page.getByText('The save result is unavailable. Refresh saved candidates before trying again.',{exact:true}));
    assert(await save.isDisabled()); await noPrivateInputs(page);
    await presentation(page.getByRole('alert'),record,'lost-reply-alert');
    await presentation(save,record,'disabled-save');
    await refreshed(page,record);
    await visible(page.getByRole('heading',{name:accepted.label,exact:true}));
    await candidateReady(page,accepted);
    await presentation(page.getByRole('button',{name:'Refresh',exact:true}),record,'focused-refresh');
    assert.equal(report.acceptedDraftMetadata.length,1); assert.equal(accepted.revision,1);
    await geometry(page,record,'draft-create-lost-reply-reconciled','light');
    await page.screenshot({path:resolve(output,`${record.id}.png`),fullPage:true,timeout:20000});
    record.assertions.push({actualAccepted200ReplyLost:true,exactProfileId:accepted.profileId,revision:1,explicitFocusedRefresh:true,
      secretsCleared:true,noAutomaticReplay:true,acceptedBrowserWrites:1,providerOrActivationRequests:0});
  });
  const secondInput=input(`Long research destination 实验数据目录 revision identity ${randomUUID()}`);
  const first=metadata((await actualRequest('/api/storage/configuration/candidates',adminToken,200,'PUT',secondInput)).value,secondInput,1);
  await caseRun(expectedCases[1],390,'dark',adminToken,async(page,record,original409)=>{
    await page.goto(new URL('/settings/storage/configuration',base).href);
    await candidateReady(page,report.acceptedDraftMetadata[0]); await candidateReady(page,first);
    const edit=page.getByRole('button',{name:`Edit ${first.label}`,exact:true}); await visible(edit); await edit.focus(); await page.keyboard.press('Enter');
    await visible(page.getByRole('heading',{name:'New candidate revision',exact:true}));
    assert(await page.getByLabel('HTTPS endpoint',{exact:true}).isDisabled());
    assert(!(await page.getByLabel('Replace credentials',{exact:true}).isChecked()));
    await absent(page.getByLabel('Password',{exact:true}));
    await page.getByLabel('Name',{exact:true}).fill(`Stale editor 原始 revision ${randomUUID()}`);
    const contender={...secondInput,profileId:first.profileId,expectedRevision:1,
      label:`Current revision 当前资料 ${randomUUID()}`,credentials:{mode:'retain'}};
    const current=metadata((await actualRequest('/api/storage/configuration/candidates',adminToken,200,'PUT',contender)).value,contender,2);
    const conflict=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/storage/configuration/candidates' && response.request().method()==='PUT');
    const save=page.getByRole('button',{name:'Save draft',exact:true}); await save.focus(); await page.keyboard.press('Enter');
    const original=await conflict; assert.equal(original.status(),409);
    await visible(page.getByText('This candidate changed. Refresh before saving a new revision.',{exact:true})); assert(await save.isDisabled());
    await presentation(page.getByRole('alert'),record,'revision-conflict-alert');
    await presentation(save,record,'disabled-save');
    await refreshed(page,record); await original409(original);
    await visible(page.getByRole('heading',{name:current.label,exact:true})); await absent(page.getByRole('heading',{name:first.label,exact:true}));
    await candidateReady(page,report.acceptedDraftMetadata[0]); await candidateReady(page,current);
    await presentation(page.getByRole('button',{name:'Refresh',exact:true}),record,'focused-refresh');
    await geometry(page,record,'draft-revision-conflict-reconciled','dark');
    await page.screenshot({path:resolve(output,`${record.id}.png`),fullPage:true,timeout:20000});
    record.assertions.push({sameProfileId:first.profileId,expectedRevisionCaptured:1,genuineContenderRevision:2,originalStalePut:409,
      explicitFocusedRefresh:true,noAutomaticReplay:true,acceptedBrowserWrites:0,providerOrActivationRequests:0});
  });
  }
  assert.deepEqual(report.cases.map(item=>item.id),expectedCases); assert(report.cases.every(item=>item.status==='passed' && item.contextClosed));
  assert.equal(report.acceptedDraftMetadata.length,readOnlyLayout ? 0 : 3); assert.equal(report.auxiliaryRequests.filter(item=>item.method==='PUT').length,readOnlyLayout ? 0 : 2);
  report.databaseAfter=await snapshot(); await verifyAcceptedHistory(report.databaseAfter);
  notInterrupted(); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = privateError(error); }
finally {
  // Original owners are retained and awaited. A failed disposal is preserved;
  // this helper never signals an unowned process or invents graceful closure.
  process.stdin.removeListener('data', originalControlInput); process.stdin.pause();
  const cleanup = { sessionId: report.sessionId, startedAt: new Date().toISOString(), status: 'closing' };
  if (originalControlStop) {
    try { await originalControlStop; cleanup.originalControlStopAwaited = true; }
    catch (error) { cleanup.originalControlStopError = privateError(error); }
  }
  if (browser) { try { await closeBrowser(); cleanup.browserCloseAwaited = true; } catch (error) { cleanup.browserCloseError = privateError(error); } }
  if (database && originalDatabaseSnapshot) { try { report.databaseAfter=await snapshot(); await verifyAcceptedHistory(report.databaseAfter); cleanup.originalCatalogUnrelatedRowsAndAcceptedHistoryVerified=true; } catch(error) { cleanup.acceptedHistoryVerificationError=privateError(error); } }
  if (runtime) { try { await disposeWorker(); cleanup.workerDisposeAwaited = true; await refused(4219); cleanup.workerPortRefused = true; } catch (error) { cleanup.workerCloseError = privateError(error); } }
  if (jwksServer) { try { await closeJwks(); cleanup.jwksCloseAwaited = true;
    if (issuerPort) { await refused(issuerPort); cleanup.jwksPortRefused = true; } } catch (error) { cleanup.jwksCloseError = privateError(error); } }
  cleanup.status = Object.keys(cleanup).some(key => key.endsWith('Error')) ? 'failed' : 'closed';
  cleanup.completedAt = new Date().toISOString(); report.ownedClosure = cleanup;
  if (cleanup.status !== 'closed') report.status = 'failed';
  report.unrunCases = expectedCases.filter(id => !report.cases.some(item => item.id === id)); report.completedAt = new Date().toISOString();
  await writeOnce(stopPath, cleanup); await writeOnce(reportPath, report);
}
console.log(JSON.stringify({ status: report.status, reportPath, actualCases: report.cases.length, passed: report.cases.filter(item => item.status === 'passed').length,
  failed: report.cases.filter(item => item.status === 'failed').length, unrun: report.unrunCases.length, closure: report.ownedClosure.status }));
if (report.status !== 'passed') process.exitCode = 1;
