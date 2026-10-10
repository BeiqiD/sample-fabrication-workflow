// Start only a reviewed fresh local artifact copy. Send "stop" on stdin to
// await disposal; immutable startup and stop receipts preserve distinct facts.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const tempAlias = resolve(tmpdir()), tempRoot = await realpath(tempAlias);
function within(root, path) { const part = relative(root, path); return part && !part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part); }
async function privateDirectory(value) {
  let path = resolve(value);
  if (within(tempAlias, path)) path = resolve(tempRoot, relative(tempAlias, path));
  assert(within(tempRoot, path), 'Only a private directory below the OS temporary root is permitted.');
  let cursor = tempRoot;
  for (const part of relative(tempRoot, path).split(sep)) { cursor = resolve(cursor, part); const info = await lstat(cursor); assert(info.isDirectory() && !info.isSymbolicLink(), 'Temporary directory components must be real directories.'); }
  const info = await lstat(path);
  if (process.getuid) { assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o077, 0, 'Fixture roots must be private.'); }
  return path;
}
async function ownedFile(root, name) {
  assert(typeof name === 'string' && within(root, resolve(root, name)) && !isAbsolute(name), 'File must remain inside its isolated root.');
  const path = resolve(root, name); let cursor = root;
  for (const part of relative(root, path).split(sep)) { cursor = resolve(cursor, part); assert(!(await lstat(cursor)).isSymbolicLink(), 'Fixture files cannot use symlinks.'); }
  assert((await lstat(path)).isFile()); return path;
}
async function json(root, name) { return JSON.parse(await readFile(await ownedFile(root, name), 'utf8')); }
async function absent(path) { try { await lstat(path); assert.fail(`Refusing prior receipt/session: ${path}`); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
async function writeOnce(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
async function portClosed() {
  return new Promise((done, fail) => { const socket = createConnection({ host: '127.0.0.1', port: 4219 }); socket.setTimeout(2000); socket.once('connect', () => { socket.destroy(); fail(new Error('The isolated port is already listening.')); }); socket.once('timeout', () => { socket.destroy(); fail(new Error('Cannot determine isolated port availability.')); }); socket.once('error', error => { socket.destroy(); if (error.code === 'ECONNREFUSED') done(); else fail(error); }); });
}
const [rootValue, fixtureValue] = process.argv.slice(2);
assert(rootValue && fixtureValue && process.argv.length === 4, 'Usage: node start-built-server.mjs ISOLATED_COPY FIXTURE_DIRECTORY');
const root = await privateDirectory(rootValue), fixtureDirectory = await privateDirectory(fixtureValue);
assert(root !== fixtureDirectory && !within(root, fixtureDirectory) && !within(fixtureDirectory, root), 'Keep copied state and receipt roots separate.');
const isolationPath = await ownedFile(root, 'isolation-receipt.json'), isolation = await json(root, 'isolation-receipt.json');
const fixturePath = await ownedFile(fixtureDirectory, 'process-fixture.json'), fixture = await json(fixtureDirectory, 'process-fixture.json');
const isolationHash = sha(await readFile(isolationPath)), fixtureHash = sha(await readFile(fixturePath));
assert.equal(isolation.copiedState, false); assert.equal(isolation.sourceCopyRoot, root);
assert.equal(fixture.sourceCopyRoot, root); assert.equal(fixture.fixtureDirectory, fixtureDirectory);
assert.equal(fixture.sourceHead, isolation.sourceHead); assert.equal(fixture.isolationReceiptSha256, isolationHash);
assert.equal(fixture.loopbackPort, 4219); assert.equal(sha(await readFile(await ownedFile(fixtureDirectory, 'process-fixture.sql'))), fixture.sqlSha256);
for (const map of [isolation.trackedFiles, isolation.copiedArtifactFiles]) {
  assert(map && Object.keys(map).length);
  for (const [name, expected] of Object.entries(map)) assert.equal(sha(await readFile(await ownedFile(root, name))), expected, `Copied byte mismatch: ${name}`);
}
assert.equal(sha(await readFile(new URL(import.meta.url))), isolation.trackedFiles['scripts/qa/phase5f/start-built-server.mjs'], 'Execute the helper captured in the committed copy.');
const dependencies = await lstat(resolve(root, 'node_modules'));
assert(dependencies.isSymbolicLink()); assert.equal(await realpath(resolve(root, 'node_modules')), isolation.nodeModulesRoot);
const configPath = await ownedFile(root, '.wrangler/deploy.jsonc'), config = await json(root, '.wrangler/deploy.jsonc');
assert.equal(config.vars.AUTH_MODE, 'disabled'); assert.equal(config.account_id, undefined);
assert.deepEqual(config.d1_databases.map(item => item.binding), ['DB']);
assert.equal(config.d1_databases[0].database_id, '00000000-0000-4000-8000-000000000000');
assert.equal(config.d1_databases[0].remote, undefined); assert.equal(config.d1_databases[0].preview_database_id, undefined);
assert.deepEqual(config.r2_buckets.map(item => item.binding), ['ASSETS']);
for (const key of ['remote', 'jurisdiction', 'preview_bucket_name']) assert.equal(config.r2_buckets[0][key], undefined);
const namespace = JSON.parse(config.vars.R2_BOOTSTRAP_NAMESPACE), installation = await json(root, '.wrangler/local-installation.json');
assert.deepEqual(namespace, { kind: 'local-r2', installationId: installation.installationId, bucketName: config.r2_buckets[0].bucket_name });
assert.match(installation.installationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const active = isolation.activeBuild; assert(active);
const redirect = await json(root, active.redirectPath), activeConfigPath = await ownedFile(root, active.configPath);
assert.equal(resolve(dirname(resolve(root, active.redirectPath)), redirect.configPath), activeConfigPath);
const builtConfig = JSON.parse(await readFile(activeConfigPath, 'utf8'));
assert.equal(sha(await readFile(activeConfigPath)), active.configSha256);
assert.deepEqual(builtConfig.vars, config.vars);
const databaseIdentity = items => items.map(({ migrations_dir, ...identity }) => identity);
assert.deepEqual(databaseIdentity(builtConfig.d1_databases), databaseIdentity(config.d1_databases));
assert.equal(resolve(dirname(configPath), config.d1_databases[0].migrations_dir), resolve(root, 'migrations'));
assert.equal(resolve(dirname(activeConfigPath), builtConfig.d1_databases[0].migrations_dir), resolve(root, 'migrations'));
assert.deepEqual(builtConfig.r2_buckets, config.r2_buckets);
assert.equal(builtConfig.account_id, undefined);
const { productionWorkerArtifact } = await import(pathToFileURL(await ownedFile(root, 'scripts/production-worker-artifact.mjs')));
const artifact = await productionWorkerArtifact(root);
assert.equal(artifact.scriptPath, await ownedFile(root, active.scriptPath)); assert.equal(artifact.assets.directory, resolve(root, active.assetsDirectory));
assert.equal(sha(await readFile(artifact.scriptPath)), active.scriptSha256);
const migrationNames = (await readdir(resolve(root, 'migrations'))).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
const migrations = [];
for (const name of migrationNames) migrations.push({ name, sha256: sha(await readFile(await ownedFile(root, `migrations/${name}`))) });
assert(migrations.length); assert.deepEqual(migrations, isolation.migrationFiles);
const physicalPath = await ownedFile(fixtureDirectory, 'physical-sqlite-before-api.json'), physical = await json(fixtureDirectory, 'physical-sqlite-before-api.json');
for (const [key, value] of Object.entries({ sourceRoot: isolation.sourceRoot, sourceCopyRoot: root, sourceHead: isolation.sourceHead, fixtureDirectory, isolationReceiptSha256: isolationHash, fixtureManifestSha256: fixtureHash })) assert.equal(physical[key], value);
assert.equal(physical.status, 'passed');
assert(Object.values(physical.results).length && Object.values(physical.results).every(check => check.quickCheck.length === 1 && check.quickCheck[0][0] === 'ok' && check.foreignKeyCheck.length === 0));
const receiptPath = resolve(fixtureDirectory, 'isolated-server-receipt.json'), stopPath = resolve(fixtureDirectory, 'isolated-server-stop-receipt.json'), sessionPath = resolve(fixtureDirectory, 'isolated-server-session.json');
for (const path of [receiptPath, stopPath, sessionPath, resolve(fixtureDirectory, 'actual-api-fixture-receipt.json'), resolve(fixtureDirectory, 'actual-api-fixture-session.json')]) await absent(path);
await portClosed();
const identity = { sourceRoot: isolation.sourceRoot, sourceCopyRoot: root, fixtureDirectory, sourceHead: isolation.sourceHead, sessionId: randomUUID(), sessionPid: process.pid, isolationReceiptSha256: isolationHash, fixtureManifestSha256: fixtureHash };
await writeOnce(sessionPath, { version: 1, ...identity, reservedAt: new Date().toISOString() });
const receipt = { version: 2, ...identity, copiedState: false, host: '127.0.0.1', port: 4219, authMode: 'disabled',
  d1DatabaseId: config.d1_databases[0].database_id, r2BucketName: config.r2_buckets[0].bucket_name,
  persistRoot: resolve(root, '.wrangler/state'), namespace, helperSha256: sha(await readFile(new URL(import.meta.url))),
  workerSha256: sha(await readFile(artifact.scriptPath)), configSha256: sha(await readFile(configPath)), activeBuildConfigSha256: active.configSha256,
  physicalSqliteDiagnosticReceiptSha256: sha(await readFile(physicalPath)), startedAt: new Date().toISOString(),
  d1QuickCheck: 'not_run', scope: 'Fresh local production artifact and synthetic D1/R2 only; no provider or authenticated administrator qualification.' };
let runtime;
try {
  const { Miniflare, Log, LogLevel } = createRequire(resolve(root, 'package.json'))('miniflare');
  runtime = new Miniflare({ ...artifact, modules: true, host: '127.0.0.1', port: 4219, bindings: config.vars,
    d1Databases: { DB: config.d1_databases[0].database_id }, d1Persist: resolve(root, '.wrangler/state/v3/d1'),
    r2Buckets: { ASSETS: config.r2_buckets[0].bucket_name }, r2Persist: resolve(root, '.wrangler/state/v3/r2'), log: new Log(LogLevel.ERROR) });
  const ready = await runtime.ready; assert.equal(new URL(ready.href).origin, 'http://127.0.0.1:4219');
  const db = await runtime.getD1Database('DB');
  const applied = await db.prepare('SELECT name FROM d1_migrations ORDER BY name').all();
  assert.deepEqual(applied.results.map(row => row.name), migrationNames);
  for (const id of [fixture.ids.v1, fixture.ids.v2]) { const row = await db.prepare('SELECT initial_state_hash FROM template_versions WHERE id = ?').bind(id).first(); assert.equal(row?.initial_state_hash, fixture.initialStateHash); }
  const readiness = [];
  for (const path of ['/api/health', '/api/ready']) { const response = await fetch(new URL(path, ready), { redirect: 'error' }); const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(response.status, 200); assert.equal(JSON.parse(bytes).ok, true); readiness.push({ path, status: response.status, responseSha256: sha(bytes) }); }
  Object.assign(receipt, { status: 'ready', baseUrl: ready.href, migrationNames, readiness });
  await writeOnce(receiptPath, receipt);
  console.log(JSON.stringify({ status: 'ready', baseUrl: ready.href, receiptPath, sourceHead: receipt.sourceHead, sessionId: identity.sessionId, control: 'Send stop on stdin and await exit.' }));
} catch (error) {
  if (runtime) await runtime.dispose();
  Object.assign(receipt, { status: 'failed', error: error.message, completedAt: new Date().toISOString() });
  await writeOnce(receiptPath, receipt); throw error;
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let stopping = false;
async function stop(reason) {
  if (stopping) return; stopping = true; input.close();
  const startedAt = new Date().toISOString();
  try {
    await runtime.dispose(); await portClosed();
    await writeOnce(stopPath, { version: 1, ...identity, status: 'stopped', control: reason, disposalAwaited: true, portClosed: true,
      startedAt, stoppedAt: new Date().toISOString(), startupReceiptSha256: sha(await readFile(receiptPath)), helperSha256: receipt.helperSha256 });
    console.log(JSON.stringify({ status: 'stopped', stopReceiptPath: stopPath, sessionId: identity.sessionId }));
    process.exit(0);
  } catch (error) {
    await writeOnce(stopPath, { version: 1, ...identity, status: 'failed', control: reason, disposalAwaited: false, error: error.message, startedAt, completedAt: new Date().toISOString() });
    console.error(error); process.exit(1);
  }
}
input.on('line', line => { if (line.trim() === 'stop') void stop('stdin:stop'); else console.error('Unknown control command; expected stop.'); });
input.on('close', () => { if (!stopping) void stop('stdin:eof'); });
// Signals preserve the same awaited disposal contract; abrupt SIGKILL cannot.
process.on('SIGINT', () => void stop('signal:SIGINT'));
process.on('SIGTERM', () => void stop('signal:SIGTERM'));
