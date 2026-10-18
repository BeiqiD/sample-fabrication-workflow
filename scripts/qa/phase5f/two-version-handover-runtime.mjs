// Actual two-artifact Worker owner. Only the local edge and transport-ACK fault
// belong to QA; application assets, APIs and persistent rows remain genuine.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { productionWorkerArtifact } from '../../production-worker-artifact.mjs';

const execute = promisify(execFile);
export const versionACommit = 'abdc2d98541c01e887bbea540c50bb07a7e1cab5';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const payload = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
async function git(source, args) { return (await execute('git', ['-C', source, ...args], { maxBuffer: 1024 * 1024 })).stdout.trim(); }
async function dependencyInputs(source) {
  const manifest = await readFile(resolve(source, 'package.json')), lockBytes = await readFile(resolve(source, 'package-lock.json'));
  const lock = JSON.parse(lockBytes), installed = JSON.parse(await readFile(resolve(source, 'node_modules/.package-lock.json'), 'utf8'));
  assert.equal(await realpath(resolve(source, 'node_modules')), resolve(source, 'node_modules'), 'Each version must own its installed dependencies.');
  assert.equal(lock.lockfileVersion, 3); assert.equal(installed.lockfileVersion, 3);
  const names = Object.keys(installed.packages); assert(names.length > 0);
  for (const name of names) {
    const entry = installed.packages[name], expected = lock.packages[name];
    assert(expected, `Installed package absent from this version lock: ${name}`);
    for (const field of ['version', 'resolved', 'integrity']) assert.equal(entry[field], expected[field], `${name}: installed ${field} must match its own lock`);
  }
  return { manifestSha256: sha256(manifest), lockSha256: sha256(lockBytes), installedLockSha256: sha256(JSON.stringify(installed)),
    installedPackagesChecked: names.length, independentInstallation: true, installedEntriesMatchOwnLock: true };
}
export async function inspectVersion(source, old = false) {
  const artifact = await productionWorkerArtifact(source), client = artifact.assets.directory;
  const names = await readdir(resolve(client, 'assets'));
  const recovery = names.filter(name => /^SystemRecoveryPage-.*\.js$/.test(name));
  assert.equal(recovery.length, 1, 'Require one actual Recovery lazy module.');
  const html = await readFile(resolve(client, 'index.html'));
  const entry = html.toString().match(/<script[^>]+src="([^"]+)"/);
  assert(entry, 'Actual built HTML must identify its entry module.');
  const info = { source, workerSha256: sha256(await readFile(artifact.scriptPath)), htmlSha256: sha256(html),
    entry: entry[1], entrySha256: sha256(await readFile(resolve(client, `.${entry[1]}`))),
    recovery: `/assets/${recovery[0]}`, recoverySha256: sha256(await readFile(resolve(client, 'assets', recovery[0]))),
    recoveryCss: names.filter(name => /^SystemRecoveryPage-.*\.css$/.test(name)).map(name => `/assets/${name}`),
    dependencies: await dependencyInputs(source) };
  let ownCheckout = false;
  try { ownCheckout = resolve(await git(source, ['rev-parse', '--show-toplevel'])) === resolve(source); } catch { /* Ordinary archive requires its original receipt. */ }
  if (ownCheckout) {
    info.commit = await git(source, ['rev-parse', 'HEAD']); info.tree = await git(source, ['rev-parse', 'HEAD^{tree}']);
    info.trackedChanges = await git(source, ['status', '--porcelain', '--untracked-files=no']);
    if (old) { assert.equal(info.commit, versionACommit); assert.equal(info.trackedChanges, ''); }
  } else {
    assert(old && process.env.HANDOVER_VERSION_A_SOURCE_MANIFEST, 'An ordinary Version A archive needs its original source/build manifest.');
    const receipt = JSON.parse(await readFile(process.env.HANDOVER_VERSION_A_SOURCE_MANIFEST, 'utf8'));
    assert.equal(resolve(receipt.source), resolve(source)); assert.equal(receipt.sourceCommit, versionACommit); assert.equal(receipt.build, 'PASSED');
    assert.equal(receipt.artifacts[relative(source, artifact.scriptPath)], info.workerSha256);
    assert.equal(receipt.artifacts[relative(source, resolve(client, 'index.html'))], info.htmlSha256);
    assert.equal(receipt.artifacts[relative(source, resolve(client, `.${info.recovery}`))], info.recoverySha256);
    info.commit = receipt.sourceCommit; info.tree = receipt.sourceTree; info.provenance = 'Original ordinary archive/source-build receipt, checked against actual artifacts.';
  }
  return { artifact, info, names };
}
export async function compatibleVersions(a, b) {
  const hashes = {};
  const migrations = (await readdir(resolve(a.info.source, 'migrations'))).filter(name => name.endsWith('.sql')).sort();
  assert.deepEqual((await readdir(resolve(b.info.source, 'migrations'))).filter(name => name.endsWith('.sql')).sort(), migrations);
  for (const path of ['vite.config.ts', 'wrangler.jsonc', ...migrations.map(name => `migrations/${name}`)]) {
    const before = sha256(await readFile(resolve(a.info.source, path))), after = sha256(await readFile(resolve(b.info.source, path)));
    assert.equal(before, after, `This schema-compatible rehearsal requires unchanged ${path}`); hashes[path] = before;
  }
  assert.notEqual(a.info.recovery, b.info.recovery); assert.notEqual(a.info.recoverySha256, b.info.recoverySha256);
  assert(!b.names.includes(a.info.recovery.split('/').at(-1)), 'B must truly lack A\'s Recovery module.');
  assert.notEqual(a.info.htmlSha256, b.info.htmlSha256);
  return { exactSharedInputHashes: hashes, independentDependencyInputs: { A: a.info.dependencies, B: b.info.dependencies },
    originalRecoveryModuleAbsentFromB: true, realDistinctRecoveryModules: true };
}
async function listen(server) {
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function closedPort(port) {
  await new Promise((done, fail) => { const socket = createConnection({ host: '127.0.0.1', port }); socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); fail(new Error(`Owned port ${port} remains open.`)); });
    socket.once('timeout', () => { socket.destroy(); fail(new Error(`Owned port ${port} closure is unknown.`)); });
    socket.once('error', error => { socket.destroy(); error.code === 'ECONNREFUSED' ? done() : fail(error); }); });
}
export async function startTwoVersionRuntime(a, b, output, report) {
  assert(!process.execArgv.some(value => value.startsWith('--input-type')), 'Run a normal .mjs file: --input-type is inherited by Miniflare\'s CommonJS synchronous-fetch eval worker.');
  const require = createRequire(resolve(b.info.source, 'package.json'));
  const { generateKeyPair, exportJWK, SignJWT } = await import(require.resolve('jose'));
  const databaseId = randomUUID(), recoveryId = randomUUID(), bucketName = `handover-${randomUUID()}`;
  const namespace = JSON.stringify({ kind: 'local-r2', installationId: randomUUID(), bucketName });
  const persist = resolve(output, 'state'), config = resolve(output, 'wrangler.json');
  const actor = 'handover-admin@browser-qualification.invalid', reader = 'handover-reader@browser-qualification.invalid';
  let jwks, edge, current, version, origin, gate = Promise.resolve(), releaseGate, loseAck = false, closing = false;
  const closedVersions = [];
  report.edge = { requests: [], errors: [], cancelledReads: [], lostAcknowledgements: [] }; report.api = []; report.lifecycle = [];
  async function phase(label) {
    report.lastPhase = { label, at: new Date().toISOString() };
    await writeFile(resolve(output, 'progress.json'), JSON.stringify({ lastPhase: report.lastPhase, lifecycle: report.lifecycle, completedApi: report.api.map(({ method, path, status }) => ({ method, path, status })) }, null, 2) + '\n');
    if (process.env.HANDOVER_PHASE_LOG === '1') process.stdout.write(`handover-phase ${label}\n`);
  }
  async function closeRuntime(owner) {
    await phase(`${owner.label}:drain-before-close`); await Promise.all([...owner.pending]);
    await phase(`${owner.label}:dispose-start`); await owner.runtime.dispose(); await phase(`${owner.label}:disposed`); await closedPort(owner.port);
    closedVersions.push(owner.label); report.lifecycle.push({ version: owner.label, event: 'Original runtime disposed and owned port refused', at: new Date().toISOString() });
  }
  async function close() {
    if (closing) return; closing = true;
    releaseGate?.();
    if (edge?.listening) { const port = edge.address().port; await new Promise((done, fail) => edge.close(error => error ? fail(error) : done())); await closedPort(port); }
    if (current) { const owned = current; current = undefined; await closeRuntime(owned); }
    if (jwks?.listening) { const port = jwks.address().port; await new Promise((done, fail) => jwks.close(error => error ? fail(error) : done())); await closedPort(port); }
    report.closure = { originalRuntimeVersionsClosed: closedVersions, ownedEdgeAndJwksPortsRefused: true, ownedRuntimePortsRefused: true };
  }
  try {
    await writeFile(config, JSON.stringify({ name: 'two-version-handover-local-only', compatibility_date: a.artifact.compatibilityDate,
      d1_databases: [{ binding: 'DB', database_name: 'two-version-handover-source', database_id: databaseId, migrations_dir: resolve(a.info.source, 'migrations') }] }), { flag: 'wx', mode: 0o600 });
    const migration = await execute(process.execPath, [resolve(a.info.source, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist, '--config', config],
      { cwd: a.info.source, timeout: 120000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
    await writeFile(resolve(output, 'migrations.log'), migration.stdout + migration.stderr, { flag: 'wx', mode: 0o600 });
    report.migrations = { appliedOnceUnderA: true, command: 'wrangler d1 migrations apply DB --local', log: 'migrations.log' };
    const keys = await generateKeyPair('RS256'), audience = `handover-${randomUUID()}`;
    const publicKey = { ...await exportJWK(keys.publicKey), kid: 'handover-local-key', alg: 'RS256', use: 'sig' };
    const jwksBytes = Buffer.from(JSON.stringify({ keys: [publicKey] }));
    report.authorization = { kind: 'Actual local signed Access JWT/JWKS, same issuer/audience/actor across versions', jwksRequests: [] };
    jwks = createServer((request, response) => { report.authorization.jwksRequests.push({ method: request.method, path: request.url });
      if (request.method !== 'GET' || request.url !== '/cdn-cgi/access/certs') { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(jwksBytes); });
    const issuer = await listen(jwks);
    const token = email => new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: publicKey.kid }).setIssuer(issuer)
      .setAudience(audience).setSubject(`fixture:${email}`).setIssuedAt().setExpirationTime('15m').sign(keys.privateKey);
    const tokens = { admin: await token(actor), reader: await token(reader) };
    async function open(selected, label) {
      const { Miniflare, Log, LogLevel } = createRequire(resolve(selected.info.source, 'package.json'))('miniflare');
      const runtime = new Miniflare({ ...selected.artifact, rootPath: selected.info.source, modulesRoot: selected.info.source, modules: true, host: '127.0.0.1', port: 0,
        d1Databases: { DB: databaseId, RECOVERY_DB: recoveryId }, d1Persist: resolve(persist, 'v3/d1'),
        r2Buckets: { ASSETS: bucketName }, r2Persist: resolve(persist, 'v3/r2'), log: new Log(LogLevel.ERROR),
        bindings: { AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience, ALLOWED_EMAILS: `${actor},${reader}`,
          SYSTEM_ADMIN_EMAILS: actor, FILE_EVIDENCE_OPERATOR_EMAILS: actor, R2_BOOTSTRAP_NAMESPACE: namespace, RECOVERY_TARGET_ID: 'handover-unchanged-inert-target' },
        outboundService: async request => { assert.equal(request.url, `${issuer}/cdn-cgi/access/certs`); assert.equal(request.method, 'GET');
          const response = await fetch(request.url, { signal: AbortSignal.timeout(5000), redirect: 'error' }); return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers }); } });
      try {
        await phase(`${label}:ready-start`); const ready = await runtime.ready; await phase(`${label}:ready`);
        const database = await runtime.getD1Database('DB'); await phase(`${label}:d1-ready`);
        const bucket = await runtime.getR2Bucket('ASSETS'); await phase(`${label}:r2-ready`);
        const owner = { runtime, label, port: Number(ready.port), pending: new Set(), database, bucket };
        report.lifecycle.push({ version: label, event: 'Actual artifact ready', workerSha256: selected.info.workerSha256, at: new Date().toISOString() });
        return owner;
      } catch (error) { await runtime.dispose(); throw error; }
    }
    current = await open(a, 'A'); version = 'A';
    const rows = async (sql, bindings = []) => (await current.database.prepare(sql).bind(...bindings).all()).results;
    async function request(path, method = 'GET', body, expected = 200, headers = {}, identity = 'admin') {
      const binary = body instanceof Uint8Array;
      await phase(`${version}:${method}:${path}:start`);
      const response = await current.runtime.dispatchFetch(`${origin ?? 'http://127.0.0.1'}${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { 'cf-access-jwt-assertion': tokens[identity], ...(body === undefined || binary ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }) });
      const bytes = Buffer.from(await response.arrayBuffer()), json = /^application\/json/.test(response.headers.get('content-type') ?? '');
      const value = json ? JSON.parse(bytes.toString()) : bytes;
      await phase(`${version}:${method}:${path}:body-read`);
      report.api.push({ version, method, path, status: response.status, ...(body && !binary ? { input: body } : {}) });
      assert.equal(response.status, expected, `${method} ${path}: ${json ? JSON.stringify(value) : 'non-JSON response'}`); return value;
    }
    async function snapshot() {
      const observations = {};
      for (const name of ['samples', 'events', 'assets', 'research_package_jobs', 'research_package_requests', 'research_package_records', 'research_package_files', 'research_package_attempts',
        'file_job_runtime_guard', 'file_authority_control', 'file_authority_runtime_guard', 'file_shadow_runtime_guard']) {
        observations[name] = (await rows(`SELECT ${['samples', 'events', 'assets'].includes(name) ? 'CAST(rowid AS TEXT) physical_rowid,' : ''}* FROM ${name}`)).map(row => JSON.stringify(row)).sort();
      }
      return { schema: await rows("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"),
        ledger: await rows('SELECT * FROM d1_migrations ORDER BY id'), observations };
    }
    edge = createServer((incoming, outgoing) => {
      void (async () => {
        await gate; assert(!closing && current); const owner = current;
        const work = (async () => {
          const url = new URL(incoming.url, origin); assert.equal(url.origin, origin);
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && !['host', 'connection', 'transfer-encoding', 'cf-access-jwt-assertion', 'accept-encoding'].includes(name)) headers.set(name, Array.isArray(value) ? value.join(',') : value);
          headers.set('cf-access-jwt-assertion', tokens.admin); headers.set('accept-encoding', 'identity');
          const body = ['GET', 'HEAD'].includes(incoming.method) ? undefined : Buffer.concat(await Array.fromAsync(incoming));
          const input = body?.length && /^application\/json/.test(headers.get('content-type') ?? '') ? JSON.parse(body.toString()) : undefined;
          const upstream = await owner.runtime.dispatchFetch(url, { method: incoming.method, headers, redirect: 'manual', signal: AbortSignal.timeout(20000), ...(body === undefined ? {} : { body }) });
          const observed = { version: owner.label, method: incoming.method, path: url.pathname, query: url.search, status: upstream.status,
            contentType: upstream.headers.get('content-type'), cacheControl: upstream.headers.get('cache-control'), etag: upstream.headers.get('etag'), ...(input ? { input } : {}) };
          report.edge.requests.push(observed);
          if (outgoing.destroyed || outgoing.writableEnded) {
            assert(['GET', 'HEAD'].includes(incoming.method), 'A browser mutation disconnected before its real response could be forwarded.');
            if (upstream.body) await upstream.body.cancel(); observed.browserCancelledReadBeforeForward = true;
            report.edge.cancelledReads.push({ method: incoming.method, path: url.pathname, status: upstream.status,
              disposition: 'Browser left before forwarding began; original upstream read body explicitly cancelled, no substitute response.' }); return;
          }
          if (loseAck && incoming.method === 'POST' && url.pathname === '/api/packages/jobs') {
            loseAck = false; assert.equal(upstream.status, 202);
            const bytes = Buffer.from(await upstream.arrayBuffer()), ack = JSON.parse(bytes.toString());
            const native = await rows('SELECT id,request_id,actor,input_json,state FROM research_package_jobs WHERE request_id=?', [input.requestId]);
            assert.equal(native.length, 1); assert.equal(native[0].id, ack.job.id); assert.equal(native[0].actor, actor); assert.deepEqual(JSON.parse(native[0].input_json), input);
            report.edge.lostAcknowledgements.push({ version: owner.label, requestId: input.requestId, jobId: ack.job.id, input, actualAckSha256: sha256(bytes), realCommittedStatus: 202,
              fault: 'Original actual committed ACK deliberately truncated at owned edge; no response or job substitution.' });
            outgoing.writeHead(upstream.status, { 'content-type': 'application/json', 'content-length': bytes.length + 1000, connection: 'close' });
            outgoing.write(bytes.subarray(0, 8)); outgoing.end(); return;
          }
          outgoing.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => !['connection', 'transfer-encoding'].includes(name))));
          if (/^text\/html/.test(observed.contentType ?? '') || url.pathname === a.info.recovery || a.info.recoveryCss.includes(url.pathname)) {
            const bytes = Buffer.from(await upstream.arrayBuffer()); observed.bodySha256 = sha256(bytes); observed.byteSize = bytes.length;
            outgoing.end(bytes);
          } else if (upstream.body) {
            const sourceBody = Readable.fromWeb(upstream.body); let upstreamFailedFirst = false, clientClosedFirst = false;
            sourceBody.once('error', () => { if (!clientClosedFirst) upstreamFailedFirst = true; });
            sourceBody.once('close', () => { if (!sourceBody.readableEnded && !clientClosedFirst) upstreamFailedFirst = true; });
            const closed = () => { if (!outgoing.writableFinished && !upstreamFailedFirst) clientClosedFirst = true; };
            outgoing.once('close', closed);
            try { await pipeline(sourceBody, outgoing); }
            catch (error) {
              if (!['GET', 'HEAD'].includes(incoming.method) || !clientClosedFirst || error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
              observed.browserCancelledRead = true;
              report.edge.cancelledReads.push({ method: incoming.method, path: url.pathname, status: upstream.status, code: error.code,
                disposition: 'Browser response closed unfinished before any upstream failure; original read pipeline cancelled, no substitute response.' });
            } finally { outgoing.off('close', closed); }
          } else outgoing.end();
        })();
        owner.pending.add(work); try { await work; } finally { owner.pending.delete(work); }
      })().catch(error => { report.edge.errors.push({ name: error.name, code: error.code ?? null, path: new URL(incoming.url, origin).pathname, message: error.message }); if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    });
    origin = await listen(edge);
    report.installation = { databaseId, sameR2NamespaceAcrossVersions: true, sameDatabaseAndPersistenceAcrossVersions: true, realSequentialOwners: true };
    return { origin, rows, request, close,
      armLostExportAck() { assert(!loseAck); loseAck = true; },
      async setup() {
        await request('/api/system-recovery/backup-preview', 'GET', undefined, 403, {}, 'reader');
        // Installation metadata fixture only, following the existing historical
        // R2 profile fixture. Actual authority and all business/job writes use HTTP.
        const catalog = await rows("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name");
        const now = new Date().toISOString(), profile = { id: 'storage-profile:r2:bootstrap' };
        await current.database.batch([
          current.database.prepare("SELECT CASE WHEN (SELECT count(*) FROM storage_profiles)=0 AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='legacy') THEN 1 ELSE json('Fresh handover profile boundary changed') END"),
          current.database.prepare("INSERT INTO storage_profiles(id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at) VALUES(?,'r2',?,'bootstrap',NULL,1,'historical',?)").bind(profile.id, namespace, now),
        ]);
        assert.deepEqual(await rows("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name"), catalog);
        report.installation.profilePreparation = 'One historical installation-owned R2 profile metadata row through its original registration triggers; no schema, authority, business or job SQL fixture writes.';
        const status = await request('/api/files/shadow/status');
        let shadow = await request('/api/files/shadow/enable', 'POST', { requestId: randomUUID(), expectedEpoch: status.epoch, expectedIncarnation: status.incarnation });
        shadow = await request('/api/files/shadow/profiles/enable', 'POST', { profile: { profileId: profile.id, configurationRevision: 1 }, runtimeIncarnation: shadow.incarnation, expectedEpoch: shadow.epoch });
        await request('/api/files/shadow/disable', 'POST', { runtimeIncarnation: shadow.incarnation, expectedEpoch: shadow.epoch });
        const authority = await request('/api/files/authority/status');
        await request('/api/files/authority/activate', 'POST', { requestId: randomUUID(), expectedEpoch: authority.epoch, expectedShadowIncarnation: shadow.incarnation });
        const sample = await request('/api/samples', 'POST', { code: `HANDOVER-${randomUUID()}`, title: 'Actual two-version handover source', status: 'stored', location: 'QA' }, 201);
        const asset = await request('/api/assets', 'POST', payload, 201, { 'content-type': 'image/png', 'x-upload-request-id': randomUUID(), 'x-filename-uri': encodeURIComponent('handover-original.png') });
        const detail = await request(`/api/samples/${sample.id}`);
        await request(`/api/samples/${sample.id}/records`, 'POST', { status: 'stored', location: 'QA', pinned: false, expectedUpdatedAt: detail.updatedAt, body: 'Preserved original two-version source', assetKey: asset.key }, 201);
        assert.equal((await rows('SELECT enabled FROM file_job_runtime_guard'))[0].enabled, 0);
        assert.equal((await rows('SELECT mode FROM file_authority_control'))[0].mode, 'active');
        assert.deepEqual(Buffer.from(await (await current.bucket.get(asset.key)).arrayBuffer()), payload);
        report.sourceFixture = { sampleId: sample.id, assetId: asset.id, objectKey: asset.key, sha256: sha256(payload), byteSize: payload.length,
          profileId: profile.id, setup: 'Actual signed Sample/PNG/history HTTP; public shadow/profile admission and source authority activation. No business/job SQL writes.' };
        return report.sourceFixture;
      },
      async switchToB() {
        assert.equal(version, 'A'); assert.equal(loseAck, false);
        gate = new Promise(done => { releaseGate = done; });
        const old = current; await Promise.all([...old.pending]); const before = await snapshot(); await closeRuntime(old); current = undefined;
        current = await open(b, 'B'); version = 'B'; const after = await snapshot(); assert.deepEqual(after, before);
        report.handover = { sameObservedSchemaAndLedger: true, selectedCanonicalSourceJobAndGuardRowsUnchanged: true,
          beforeSha256: sha256(Buffer.from(JSON.stringify(before))), afterSha256: sha256(Buffer.from(JSON.stringify(after))),
          oldRuntimeClosedBeforeBOpened: true, sameOrigin: origin, switchedAt: new Date().toISOString() };
        releaseGate(); releaseGate = undefined;
      },
      async verifyPreserved(queued) {
        const seed = report.sourceFixture;
        assert.deepEqual(Buffer.from(await (await current.bucket.get(seed.objectKey)).arrayBuffer()), payload);
        assert.deepEqual(await request(`/api/assets/${seed.objectKey}`), payload);
        assert.equal((await rows('SELECT enabled FROM file_job_runtime_guard'))[0].enabled, 0);
        assert.equal((await rows('SELECT count(*) n FROM research_package_attempts'))[0].n, 0);
        const jobs = await rows('SELECT id,request_id,actor,kind,input_json,state,phase,generation,owner_token FROM research_package_jobs');
        assert.equal(jobs.length, queued ? 1 : 0);
        if (queued) { assert.equal(jobs[0].id, queued.jobId); assert.equal(jobs[0].request_id, queued.requestId); assert.equal(jobs[0].state, 'queued');
          assert.equal(jobs[0].generation, 0); assert.equal(jobs[0].owner_token, null); assert.deepEqual(JSON.parse(jobs[0].input_json), queued.input); }
        assert.deepEqual(await rows('PRAGMA foreign_key_check'), []);
        return { originalPngBytesSha256: sha256(payload), originalQueuedJob: queued ? jobs[0] : null, independentExecutorPaused: true, executionAttempts: 0, foreignKeysValid: true };
      } };
  } catch (error) { await close(); throw error; }
}
