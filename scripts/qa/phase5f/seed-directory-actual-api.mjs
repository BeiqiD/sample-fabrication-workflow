// Actual API fixtures for the receipt-owned, fresh local production artifact.
// Accepted writes are retained; never reuse an attempted seed session.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const [baseValue, fixtureValue, ...extra] = process.argv.slice(2);
assert(baseValue && fixtureValue && extra.length === 0, 'Usage: node seed-directory-actual-api.mjs LOOPBACK_URL PRIVATE_FIXTURE_DIRECTORY');
const requestedBase = new URL(baseValue);
assert(requestedBase.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(requestedBase.hostname)
  && !requestedBase.username && !requestedBase.password && requestedBase.pathname === '/' && !requestedBase.search && !requestedBase.hash
  && requestedBase.port === '4219', 'Only http://127.0.0.1:4219/ (or its localhost alias) is permitted.');
// The service binds IPv4 explicitly. Canonicalizing localhost also keeps the
// recorded request origin identical to the server and browser receipts.
const base = new URL('http://127.0.0.1:4219/');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, path) => { const value = relative(root, path); return value !== '' && !value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value); };
const temporaryAlias = resolve(tmpdir()), temporaryRoot = await realpath(temporaryAlias);
function temporaryPath(value) {
  assert(typeof value === 'string' && !value.split(/[\\/]/).includes('..'), 'Temporary paths must not contain parent traversal.');
  let path = resolve(value);
  if (path === temporaryAlias || within(temporaryAlias, path)) path = resolve(temporaryRoot, relative(temporaryAlias, path));
  assert(within(temporaryRoot, path), 'Use a directory below the canonical operating-system temporary directory.');
  return path;
}
async function noSymlinks(path) {
  let current = path;
  while (within(temporaryRoot, current)) {
    try { assert(!(await lstat(current)).isSymbolicLink(), 'Temporary descendants must not be symlinks.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    current = dirname(current);
  }
}
async function privateDirectory(path) {
  await noSymlinks(path); const info = await lstat(path);
  assert(info.isDirectory() && (info.mode & 0o777) === 0o700, 'Use an existing private mode-0700 directory.');
  if (process.getuid) assert.equal(info.uid, process.getuid(), 'The private directory must be owned by this user.');
  assert.equal(await realpath(path), path, 'Private directories must be canonical.');
}
async function fileAt(root, value) {
  assert(typeof value === 'string' && value && !isAbsolute(value) && !value.split(/[\\/]/).includes('..'),
    'Receipt file paths must be bounded relative paths.');
  const path = resolve(root, value);
  assert(within(root, path) && !value.split(/[\\/]/).includes('node_modules'), 'Receipt files must remain inside their private root.');
  await noSymlinks(path); assert((await lstat(path)).isFile(), 'Receipt entries must identify regular files.');
  return path;
}
async function absentFile(root, name) {
  try { await lstat(resolve(root, name)); assert.fail(`Preserve existing ${name}; use a fresh fixture instead.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const fixtureDirectory = temporaryPath(fixtureValue);
await privateDirectory(fixtureDirectory);
const fixturePath = await fileAt(fixtureDirectory, 'process-fixture.json');
const fixtureBytes = await readFile(fixturePath), fixture = JSON.parse(fixtureBytes);
assert.equal(fixture.version, 2); assert.equal(fixture.copiedState, false); assert.equal(fixture.loopbackPort, 4219);
assert.equal(fixture.fixtureDirectory, fixtureDirectory);
const sourceCopyRoot = temporaryPath(fixture.sourceCopyRoot);
await privateDirectory(sourceCopyRoot);
assert(!within(sourceCopyRoot, fixtureDirectory) && !within(fixtureDirectory, sourceCopyRoot) && sourceCopyRoot !== fixtureDirectory,
  'Fixture and copied source roots must be separate.');
const isolationPath = await fileAt(sourceCopyRoot, 'isolation-receipt.json');
const isolationBytes = await readFile(isolationPath), isolation = JSON.parse(isolationBytes);
assert.equal(isolation.version, 2); assert.equal(isolation.copiedState, false);
assert.equal(isolation.sourceCopyRoot, sourceCopyRoot); assert.equal(fixture.sourceCopyRoot, sourceCopyRoot);
assert(typeof isolation.sourceRoot === 'string' && isAbsolute(isolation.sourceRoot) && isolation.sourceRoot !== sourceCopyRoot);
assert.equal(fixture.sourceRoot, isolation.sourceRoot); assert.equal(fixture.sourceHead, isolation.sourceHead);
assert(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(isolation.sourceHead), 'A committed source HEAD is required.');
assert.equal(fixture.isolationReceiptSha256, sha(isolationBytes));
assert(typeof isolation.nodeModulesRoot === 'string' && isAbsolute(isolation.nodeModulesRoot));
assert((await lstat(resolve(sourceCopyRoot, 'node_modules'))).isSymbolicLink(), 'Expected the intentional receipt-owned dependency link.');
async function inspectTree(directory, allowDependencyLink = false) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name), info = await lstat(path);
    if (info.isSymbolicLink()) {
      assert(allowDependencyLink && path === resolve(sourceCopyRoot, 'node_modules'), 'Only the copied node_modules link is permitted.');
      assert.equal(await realpath(path), isolation.nodeModulesRoot, 'Dependency link must match its isolation receipt.');
    } else if (info.isDirectory()) await inspectTree(path, allowDependencyLink);
    else assert(info.isFile(), 'Temporary descendants must be regular files or directories.');
  }
}
async function hashInventory(inventory) {
  assert(inventory && typeof inventory === 'object' && !Array.isArray(inventory) && Object.keys(inventory).length,
    'A nonempty copied-file hash inventory is required.');
  for (const [name, expected] of Object.entries(inventory)) {
    assert(/^[a-f0-9]{64}$/.test(expected), 'Expected a SHA256 file identity.');
    assert.equal(sha(await readFile(await fileAt(sourceCopyRoot, name))), expected, `Copied file changed: ${name}`);
  }
}
await inspectTree(sourceCopyRoot, true); await inspectTree(fixtureDirectory);
await hashInventory(isolation.trackedFiles); await hashInventory(isolation.copiedArtifactFiles);
const helperSha256 = sha(await readFile(new URL(import.meta.url)));
assert.equal(helperSha256, isolation.trackedFiles['scripts/qa/phase5f/seed-directory-actual-api.mjs'], 'Run the exact seeder captured in the committed source copy.');
assert.equal(fixture.helperSha256, isolation.trackedFiles['scripts/qa/phase5f/generate-process-fixture.mjs']);
assert.equal(sha(await readFile(await fileAt(fixtureDirectory, 'process-fixture.sql'))), fixture.sqlSha256);
assert.equal(sha(await readFile(await fileAt(fixtureDirectory, 'fixture-hashing.mjs'))), fixture.hashingModuleSha256);
assert(fixture.initialSubstrateStep && typeof fixture.initialSubstrateStep === 'object' && !Array.isArray(fixture.initialSubstrateStep));
assert(/^[a-f0-9]{64}$/.test(fixture.initialStateHash));
assert(typeof fixture.prefix === 'string' && /^phase5f-[a-f0-9-]+$/.test(fixture.prefix));
assert.deepEqual(fixture.ids, { family: `${fixture.prefix}-family`, v1: `${fixture.prefix}-v1`, v2: `${fixture.prefix}-v2` });

const configPath = await fileAt(sourceCopyRoot, '.wrangler/deploy.jsonc');
const configBytes = await readFile(configPath), config = JSON.parse(configBytes);
const activeBuild = isolation.activeBuild;
assert(activeBuild && typeof activeBuild === 'object');
const builtConfigPath = await fileAt(sourceCopyRoot, activeBuild.configPath);
const builtConfigBytes = await readFile(builtConfigPath), builtConfig = JSON.parse(builtConfigBytes);
const workerPath = await fileAt(sourceCopyRoot, activeBuild.scriptPath);
assert(within(resolve(sourceCopyRoot, 'dist'), builtConfigPath) && within(resolve(sourceCopyRoot, 'dist'), workerPath));
assert.equal(sha(builtConfigBytes), activeBuild.configSha256); assert.equal(sha(await readFile(workerPath)), activeBuild.scriptSha256);
assert.equal(builtConfig.no_bundle, true);
assert.equal(builtConfig.assets?.not_found_handling, 'single-page-application');
assert.deepEqual(builtConfig.assets?.run_worker_first, ['/api/*']);
assert.equal(resolve(dirname(builtConfigPath), builtConfig.main), workerPath);
const assetsDirectory = resolve(dirname(builtConfigPath), builtConfig.assets.directory);
assert(within(resolve(sourceCopyRoot, 'dist'), assetsDirectory)); await noSymlinks(assetsDirectory);
assert((await lstat(assetsDirectory)).isDirectory());
assert.equal(relative(sourceCopyRoot, assetsDirectory).split(sep).join('/'), activeBuild.assetsDirectory);
const redirect = JSON.parse(await readFile(await fileAt(sourceCopyRoot, activeBuild.redirectPath)));
assert.equal(redirect.auxiliaryWorkers?.length ?? 0, 0);
assert.equal(resolve(dirname(resolve(sourceCopyRoot, activeBuild.redirectPath)), redirect.configPath), builtConfigPath);
const localDatabaseId = '00000000-0000-4000-8000-000000000000';
for (const value of [config, builtConfig]) {
  assert.equal(value.vars?.AUTH_MODE, 'disabled'); assert.equal(value.account_id, undefined, 'Remote accounts are not permitted.');
  assert(Array.isArray(value.d1_databases) && value.d1_databases.length === 1);
  const database = value.d1_databases[0]; assert.equal(database.binding, 'DB'); assert.equal(database.database_id, localDatabaseId);
  assert.equal(database.remote, undefined); assert.equal(database.preview_database_id, undefined);
  assert(Array.isArray(value.r2_buckets) && value.r2_buckets.length === 1);
  assert.equal(value.r2_buckets[0].binding, 'ASSETS');
  for (const key of ['remote', 'jurisdiction', 'preview_bucket_name']) assert.equal(value.r2_buckets[0][key], undefined);
  const namespace = JSON.parse(value.vars.R2_BOOTSTRAP_NAMESPACE);
  assert.equal(namespace.kind, 'local-r2'); assert.equal(namespace.bucketName, value.r2_buckets[0].bucket_name);
}
assert.equal(config.name, builtConfig.name); assert.deepEqual(config.vars, builtConfig.vars);
const databaseIdentity = values => values.map(({ migrations_dir, ...identity }) => identity);
assert.deepEqual(databaseIdentity(config.d1_databases), databaseIdentity(builtConfig.d1_databases));
assert.equal(resolve(dirname(configPath), config.d1_databases[0].migrations_dir), resolve(sourceCopyRoot, 'migrations'));
assert.equal(resolve(dirname(builtConfigPath), builtConfig.d1_databases[0].migrations_dir), resolve(sourceCopyRoot, 'migrations'));
assert.deepEqual(config.r2_buckets, builtConfig.r2_buckets);
const namespace = JSON.parse(config.vars.R2_BOOTSTRAP_NAMESPACE);
const installation = JSON.parse(await readFile(await fileAt(sourceCopyRoot, '.wrangler/local-installation.json')));
assert.equal(namespace.installationId, installation.installationId);
assert.deepEqual(namespace, { kind: 'local-r2', installationId: installation.installationId, bucketName: config.r2_buckets[0].bucket_name });
assert(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(installation.installationId));

const serverPath = await fileAt(fixtureDirectory, 'isolated-server-receipt.json');
const serverBytes = await readFile(serverPath), server = JSON.parse(serverBytes);
const serverSessionPath = await fileAt(fixtureDirectory, 'isolated-server-session.json');
const serverSessionBytes = await readFile(serverSessionPath), serverSession = JSON.parse(serverSessionBytes);
assert.equal(server.version, 2); assert.equal(serverSession.version, 1);
assert.equal(server.status, 'ready'); assert.equal(server.copiedState, false);
assert.equal(server.baseUrl, base.href); assert.equal(server.host, '127.0.0.1'); assert.equal(server.port, 4219);
assert.equal(server.authMode, 'disabled'); assert.equal(server.d1DatabaseId, localDatabaseId);
assert.equal(server.r2BucketName, config.r2_buckets[0].bucket_name); assert.deepEqual(server.namespace, namespace);
assert.equal(server.persistRoot, resolve(sourceCopyRoot, '.wrangler/state')); await noSymlinks(server.persistRoot);
assert.equal(server.workerSha256, activeBuild.scriptSha256); assert.equal(server.configSha256, sha(configBytes));
assert.equal(server.activeBuildConfigSha256, activeBuild.configSha256);
assert.equal(server.helperSha256, isolation.trackedFiles['scripts/qa/phase5f/start-built-server.mjs']);
assert(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(server.sessionId));
assert(Number.isSafeInteger(server.sessionPid) && server.sessionPid > 0 && server.sessionPid !== process.pid);
const ownedIdentity = { sourceRoot: isolation.sourceRoot, sourceCopyRoot, sourceHead: isolation.sourceHead, fixtureDirectory,
  isolationReceiptSha256: sha(isolationBytes), fixtureManifestSha256: sha(fixtureBytes) };
for (const [key, expected] of Object.entries(ownedIdentity)) { assert.equal(server[key], expected); assert.equal(serverSession[key], expected); }
assert.equal(serverSession.sessionId, server.sessionId); assert.equal(serverSession.sessionPid, server.sessionPid);
async function liveServer() {
  await absentFile(fixtureDirectory, 'isolated-server-stop-receipt.json');
  assert.equal(sha(await readFile(await fileAt(fixtureDirectory, 'isolated-server-receipt.json'))), sha(serverBytes), 'Ready server receipt changed.');
  assert.equal(sha(await readFile(await fileAt(fixtureDirectory, 'isolated-server-session.json'))), sha(serverSessionBytes), 'Server session changed.');
  process.kill(server.sessionPid, 0);
}
await liveServer();
for (const name of ['directory-api-fixture-session.json', 'directory-api-fixture-receipt.json', 'directory-api-browser-session.json', 'directory-api-browser-report.json']) await absentFile(fixtureDirectory, name);
// Reserve before the first API, including sentinel reads. A failure leaves this
// immutable marker and all already accepted synthetic writes for inspection.
const sessionId = randomUUID(), startedAt = new Date().toISOString();
await writeFile(resolve(fixtureDirectory, 'directory-api-fixture-session.json'), JSON.stringify({ version: 2, ...ownedIdentity,
  sessionId, sessionPid: process.pid, serverSessionId: server.sessionId, serverReceiptSha256: sha(serverBytes),
  helperSha256, baseUrl: base.origin, status: 'reserved', startedAt }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const trace = [];
async function request(path, method = 'GET', body, headers = {}) {
  await liveServer();
  const observation = { path, method, status: null, dispatchedAt: new Date().toISOString(),
    request: body instanceof Uint8Array ? { byteSize: body.byteLength, sha256: sha(body) } : body ?? null,
    outcome: 'dispatched' };
  trace.push(observation);
  try {
    const response = await fetch(new URL(`/api${path}`, base), { method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', origin: base.origin, ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'object' && !(body instanceof Uint8Array) ? JSON.stringify(body) : body }) });
    observation.status = response.status;
    const bytes = Buffer.from(await response.arrayBuffer());
    Object.assign(observation, { responseSha256: sha(bytes), outcome: response.ok ? 'response_accepted' : 'response_rejected' });
    assert(response.ok, `Actual fixture API ${method} ${path} failed (${response.status}): ${bytes.toString().slice(0, 300)}`);
    return JSON.parse(bytes.toString());
  } catch (error) {
    observation.error = error.message;
    // Losing a response never proves a write was rejected. Keep its original
    // synthetic input and refuse a new session rather than silently retrying.
    if (observation.outcome === 'dispatched') observation.outcome = method === 'GET' ? 'read_unconfirmed' : 'write_unconfirmed';
    throw error;
  }
}
const originalSeedPath = await fileAt(fixtureDirectory, 'actual-api-fixture-receipt.json');
const originalSeedBytes = await readFile(originalSeedPath), originalSeed = JSON.parse(originalSeedBytes);
for (const [key, expected] of Object.entries(ownedIdentity)) assert.equal(originalSeed[key], expected);
assert.equal(originalSeed.status, 'prepared'); assert.equal(originalSeed.serverSessionId, server.sessionId);
assert.equal(originalSeed.serverReceiptSha256, sha(serverBytes));
const directoryPrefix = `${fixture.prefix}-directory`, directoryLocation = 'Synthetic directory rack · Shelf 51';
const receipt = { version: 1, ...ownedIdentity, baseUrl: base.origin, prefix: fixture.prefix,
  directoryPrefix, directoryLocation, sessionId, serverReceiptSha256: sha(serverBytes), serverSessionId: server.sessionId,
  helperSha256, originalSeedReceiptSha256: sha(originalSeedBytes), startedAt, samples: [], trace,
  scope: 'Fifty-one additional synthetic Sample owners for actual directory pagination; no providers, production, or real-device qualification.' };
try {
  for (const [id, version] of [[fixture.ids.v1, 1], [fixture.ids.v2, 2]]) {
    const { template } = await request(`/templates/${id}`);
    assert.equal(template.id, id); assert.equal(template.version, version);
    assert.equal(template.name, fixture.familyName); assert.equal(template.initialStateHash, fixture.initialStateHash);
    assert.deepEqual(template.initialSubstrateStep, fixture.initialSubstrateStep);
  }
  const existing = await request(`/samples?q=${encodeURIComponent(directoryPrefix)}&page=1&pageSize=50`);
  assert.equal(existing.pagination.total, 0, 'Use fresh directory owners; never replay a partial accepted seeder.');
  for (let ordinal = 1; ordinal <= 51; ordinal++) {
    const code = `${directoryPrefix}-${String(ordinal).padStart(2, '0')}`;
    const title = `Directory ${ordinal} · ${fixture.prefix} · synthetic long research question 中文`;
    const created = await request('/samples', 'POST', { code, title,
      description: 'Synthetic isolated pagination fixture. No process or file writes.', status: 'stored', location: directoryLocation });
    assert(typeof created.id === 'string'); receipt.samples.push({ sampleId: created.id, code, title });
  }
  const scope = new URLSearchParams({ q: directoryPrefix, location: directoryLocation, status: 'stored', sort: 'code-asc', pageSize: '50' });
  const first = await request(`/samples?${scope}&page=1`), second = await request(`/samples?${scope}&page=2`);
  assert.equal(first.pagination.total, 51); assert.equal(first.pagination.totalPages, 2);
  assert.equal(first.samples.length, 50); assert.equal(second.samples.length, 1);
  assert.deepEqual([...first.samples, ...second.samples].map(sample => sample.id), receipt.samples.map(sample => sample.sampleId));
  assert.equal(sha(await readFile(isolationPath)), sha(isolationBytes)); assert.equal(sha(await readFile(fixturePath)), sha(fixtureBytes));
  receipt.status = 'prepared'; receipt.completedAt = new Date().toISOString();
} catch (error) {
  receipt.status = 'failed'; receipt.error = error.message; receipt.completedAt = new Date().toISOString(); process.exitCode = 1;
} finally {
  await privateDirectory(fixtureDirectory);
  await writeFile(resolve(fixtureDirectory, 'directory-api-fixture-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: receipt.status, fixture: resolve(fixtureDirectory, 'directory-api-fixture-receipt.json'),
    actualApiRequests: trace.length, browserCasesRun: 0, error: receipt.error ?? null }));
}
