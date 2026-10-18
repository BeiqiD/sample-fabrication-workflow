// Actual API fixtures for the receipt-owned, fresh local production artifact.
// Accepted writes are retained; never reuse an attempted seed session.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const [baseValue, fixtureValue, ...extra] = process.argv.slice(2);
assert(baseValue && fixtureValue && extra.length === 0, 'Usage: node seed-template-pagination-actual-api.mjs LOOPBACK_URL PRIVATE_FIXTURE_DIRECTORY');
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
assert.equal(helperSha256, isolation.trackedFiles['scripts/qa/phase5f/seed-template-pagination-actual-api.mjs'], 'Run the exact seeder captured in the committed source copy.');
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
for (const name of ['template-pagination-fixture-session.json', 'template-pagination-fixture-receipt.json', 'template-pagination-browser-session.json', 'template-pagination-browser-report.json']) await absentFile(fixtureDirectory, name);
// Reserve before the first API, including sentinel reads. A failure leaves this
// immutable marker and all already accepted synthetic writes for inspection.
const sessionId = randomUUID(), startedAt = new Date().toISOString();
await writeFile(resolve(fixtureDirectory, 'template-pagination-fixture-session.json'), JSON.stringify({ version: 2, ...ownedIdentity,
  sessionId, sessionPid: process.pid, serverSessionId: server.sessionId, serverReceiptSha256: sha(serverBytes),
  helperSha256, baseUrl: base.origin, status: 'reserved', startedAt }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const trace = [];
async function request(path, method = 'GET', body, headers = {}) {
  await liveServer();
  const observation = { path, method, status: null, dispatchedAt: new Date().toISOString(),
    request: body instanceof FormData ? await formIdentity(body) : body instanceof Uint8Array ? { byteSize: body.byteLength, sha256: sha(body) } : body ?? null,
    headers: { origin: base.origin, ...headers },
    outcome: 'dispatched' };
  trace.push(observation);
  if (method !== 'GET') await appendFile(inputJournalPath, JSON.stringify(observation) + '\n', { mode: 0o600 });
  try {
    const response = await fetch(new URL(`/api${path}`, base), { method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), origin: base.origin, ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'object' && !(body instanceof Uint8Array) && !(body instanceof FormData) ? JSON.stringify(body) : body }) });
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
assert.equal(originalSeed.helperSha256, isolation.trackedFiles['scripts/qa/phase5f/seed-actual-api.mjs']);
const inputJournalPath = resolve(fixtureDirectory, 'template-pagination-original-inputs.ndjson');
await absentFile(fixtureDirectory, 'template-pagination-original-inputs.ndjson');
await writeFile(inputJournalPath, '', { flag: 'wx', mode: 0o600 });
const ownerDirectory = resolve(fixtureDirectory, 'template-pagination-originals');
await absentFile(fixtureDirectory, 'template-pagination-originals');
await mkdir(ownerDirectory, { mode: 0o700 });
async function formIdentity(form) {
  const entries = [];
  for (const [field, value] of form.entries()) {
    assert(value instanceof File, 'The genuine workbook flow sends only named File/Blob fields.');
    const bytes = Buffer.from(await value.arrayBuffer());
    entries.push({ field, name: value.name, mimeType: value.type, byteSize: bytes.length, sha256: sha(bytes),
      ...(field === 'manifest' ? { parsedManifest: JSON.parse(bytes.toString()) } : {}) });
  }
  return { fields: entries };
}
const prefix = `${fixture.prefix}-template-pages`;
const receipt = { version: 1, ...ownedIdentity, baseUrl: base.origin, prefix: fixture.prefix, directoryPrefix: prefix,
  sessionId, serverReceiptSha256: sha(serverBytes), serverSessionId: server.sessionId,
  helperSha256, originalSeedReceiptSha256: sha(originalSeedBytes), startedAt,
  process: [], metrology: [], trace, inputsJournal: 'template-pagination-original-inputs.ndjson',
  scope: 'Genuine FabuBlox workbook imports create 21 distinct process families; ordinary metrology creates 26 distinct families. Actual local API only; no authority SQL, providers or device claims.' };
const require = createRequire(resolve(sourceCopyRoot, 'package.json'));
const JSZip = require('jszip'), { DOMParser } = require('@xmldom/xmldom');
const { build } = require('esbuild');
function escapeXml(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
async function workbookFor(name) {
  const zip = new JSZip(), ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rBook" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Process" sheetId="1" r:id="rSheet1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rSheet1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  const rows = [['Step #', 'Step Name', 'Tool Name', 'Parameters', 'Comments'],
    ['0', 'Substrate Stack', '', 'SOI / 2 µm BOX', 'Synthetic isolated substrate'],
    ['1', 'Coat', 'Spinner', '4000 rpm', `Synthetic isolated workbook ${name}`]];
  zip.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="${ns}"><sheetData>${rows.map((cells, r) => `<row r="${r + 1}">${cells.map((value, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return new File([bytes], `${name}.xlsx`, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
try {
  for (const [id, version] of [[fixture.ids.v1, 1], [fixture.ids.v2, 2]]) {
    const { template } = await request(`/templates/${id}`);
    assert.equal(template.id, id); assert.equal(template.version, version);
    assert.equal(template.name, fixture.familyName); assert.equal(template.initialStateHash, fixture.initialStateHash);
    assert.deepEqual(template.initialSubstrateStep, fixture.initialSubstrateStep);
  }
  for (const path of ['/template-families', '/metrology-templates']) {
    const empty = await request(`${path}?q=${encodeURIComponent(prefix)}`);
    assert.equal(empty.pagination.total, 0, 'Never replay a partial accepted template seeder.');
  }
  // Reuse the actual pure parser, as mature fabublox.test.ts does with the same
  // DOMParser. This is a fixture parser bundle, not a new app/product build.
  const parserPath = resolve(ownerDirectory, 'genuine-workbook-parser.mjs');
  await build({ entryPoints: [resolve(sourceCopyRoot, 'src/lib/fabublox.ts')], outfile: parserPath,
    bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    banner: { js: "import { createRequire as __sfwBundleCreateRequire } from 'node:module'; const require = __sfwBundleCreateRequire(import.meta.url);" } });
  await chmod(parserPath, 0o600); Object.defineProperty(globalThis, 'DOMParser', { value: DOMParser, configurable: true });
  const { parseFabuBloxWorkbook } = await import(pathToFileURL(parserPath));
  receipt.parser = { sourceSha256: isolation.trackedFiles['src/lib/fabublox.ts'],
    sectionsSourceSha256: isolation.trackedFiles['src/lib/template-sections.ts'], moduleSha256: sha(await readFile(parserPath)),
    scope: 'Actual source parser bundled using pinned existing esbuild/JSZip, mature xmldom input shim; not a browser parser or whole-build rerun.' };
  for (let ordinal = 1; ordinal <= 21; ordinal++) {
    const tag = String(ordinal).padStart(2, '0'), name = `${prefix}-P${tag} · long fabrication title 中文`;
    const workbook = await workbookFor(`${prefix}-P${tag}`), preview = await parseFabuBloxWorkbook(workbook);
    assert.equal(preview.schemaVersion, 2); assert.equal(preview.steps.length, 1);
    assert.equal(preview.initialSubstrateStep.name, 'Substrate Stack'); assert.equal(preview.steps[0].name, 'Coat');
    assert.equal(preview.source.fileSha256, sha(Buffer.from(await workbook.arrayBuffer())));
    const manifest = { ...preview, title: name, images: preview.images.map(({ data: _data, ...image }) => image), recipeFamilyId: null };
    assert.equal(manifest.images.length, 0);
    const requestId = randomUUID(), form = new FormData();
    form.append('workbook', workbook, workbook.name);
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    form.append('manifest', new Blob([manifestBytes], { type: 'application/json' }), 'manifest.json');
    await writeFile(resolve(ownerDirectory, `P${tag}.xlsx`), Buffer.from(await workbook.arrayBuffer()), { flag: 'wx', mode: 0o600 });
    await writeFile(resolve(ownerDirectory, `P${tag}-manifest.json`), manifestBytes, { flag: 'wx', mode: 0o600 });
    const created = await request('/imports/fabublox', 'POST', form, { 'X-Import-Request-Id': requestId });
    assert.equal(trace.at(-1).status, 201); assert.equal(created.version, 1);
    assert(typeof created.id === 'string' && typeof created.templateVersionId === 'string');
    receipt.process.push({ ordinal, name, requestId, importId: created.id, templateId: created.templateVersionId,
      workbookFile: `template-pagination-originals/P${tag}.xlsx`, workbookSha256: preview.source.fileSha256,
      manifestFile: `template-pagination-originals/P${tag}-manifest.json`, manifestSha256: sha(manifestBytes) });
    const accepted = await request(`/imports/fabublox/requests/${requestId}`);
    assert.equal(accepted.requestId, requestId); assert.equal(accepted.status, 'ready'); assert.equal(accepted.importId, created.id);
    assert.deepEqual(accepted.result, created);
  }
  for (let ordinal = 1; ordinal <= 26; ordinal++) {
    const name = `${prefix}-M${String(ordinal).padStart(2, '0')} · long measurement title 中文`;
    const input = { name, toolName: 'Synthetic instrument 中文', parametersText: 'Synthetic isolated default parameters', commentsText: 'Synthetic reusable metrology record' };
    const created = await request('/metrology-templates', 'POST', input);
    assert.equal(trace.at(-1).status, 201); assert.equal(created.version, 1); assert(typeof created.id === 'string');
    receipt.metrology.push({ ordinal, name, input, templateId: created.id });
    const { template } = await request(`/templates/${created.id}`);
    assert.equal(template.id, created.id); assert.equal(template.name, name); assert.equal(template.templateKind, 'metrology');
    assert.equal(template.version, 1); assert.equal(template.steps.length, 1); assert.equal(template.steps[0].toolName, input.toolName);
    assert.equal(template.steps[0].parametersText, input.parametersText); assert.equal(template.steps[0].commentsText, input.commentsText);
    assert(typeof template.recipeFamilyId === 'string'); receipt.metrology.at(-1).recipeFamilyId = template.recipeFamilyId;
  }
  const scope = `q=${encodeURIComponent(prefix)}`;
  const firstProcess = await request(`/template-families?${scope}`), lastProcess = await request(`/template-families?${scope}&page=2`);
  assert.deepEqual(firstProcess.pagination, { page: 1, pageSize: 20, total: 21, totalPages: 2 });
  assert.deepEqual(lastProcess.pagination, { page: 2, pageSize: 20, total: 21, totalPages: 2 });
  assert.equal(firstProcess.families.length, 20); assert.equal(lastProcess.families.length, 1);
  const allFamilies = [...firstProcess.families, ...lastProcess.families];
  assert.equal(new Set(allFamilies.map(item => item.recipeFamilyId)).size, 21);
  assert.deepEqual(allFamilies.map(item => item.latest.id), receipt.process.map(item => item.templateId));
  for (let i = 0; i < 21; i++) { assert.equal(allFamilies[i].name, receipt.process[i].name); assert.equal(allFamilies[i].versionCount, 1); assert.equal(allFamilies[i].latestVersion, 1); receipt.process[i].recipeFamilyId = allFamilies[i].recipeFamilyId; }
  const firstMetrology = await request(`/metrology-templates?${scope}`), lastMetrology = await request(`/metrology-templates?${scope}&page=2`);
  assert.deepEqual(firstMetrology.pagination, { page: 1, pageSize: 25, total: 26, totalPages: 2 });
  assert.deepEqual(lastMetrology.pagination, { page: 2, pageSize: 25, total: 26, totalPages: 2 });
  assert.equal(firstMetrology.templates.length, 25); assert.equal(lastMetrology.templates.length, 1);
  assert.deepEqual([...firstMetrology.templates, ...lastMetrology.templates].map(item => item.id), receipt.metrology.map(item => item.templateId));
  assert.equal(new Set(receipt.metrology.map(item => item.recipeFamilyId)).size, 26);
  assert.equal(new Set([...receipt.process, ...receipt.metrology].map(item => item.recipeFamilyId)).size, 47);
  assert.equal(trace.length, 102, '2 sentinel+2 empty+21 import+21 receipt+26 create+26 detail+4 ordered page reads');
  assert.equal(sha(await readFile(isolationPath)), sha(isolationBytes)); assert.equal(sha(await readFile(fixturePath)), sha(fixtureBytes));
  receipt.pagination = { process: { first: firstProcess.pagination, last: lastProcess.pagination }, metrology: { first: firstMetrology.pagination, last: lastMetrology.pagination } };
  receipt.status = 'prepared'; receipt.completedAt = new Date().toISOString();
} catch (error) {
  receipt.status = 'failed'; receipt.error = error.stack || error.message; receipt.completedAt = new Date().toISOString(); process.exitCode = 1;
} finally {
  await privateDirectory(fixtureDirectory);
  receipt.inputsJournalSha256 = sha(await readFile(inputJournalPath));
  await writeFile(resolve(fixtureDirectory, 'template-pagination-fixture-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: receipt.status, fixture: resolve(fixtureDirectory, 'template-pagination-fixture-receipt.json'),
    actualApiRequests: trace.length, browserCasesRun: 0, error: receipt.error ?? null }));
}
