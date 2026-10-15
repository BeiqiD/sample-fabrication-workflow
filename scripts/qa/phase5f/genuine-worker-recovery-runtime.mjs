// Genuine isolated Worker/D1/R2 owner used by the browser successor gate.
// Setup writes business state and profile controls through signed public HTTP.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { productionWorkerArtifact } from '../../production-worker-artifact.mjs';

const execute = promisify(execFile);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const payload = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRXsAAAAASUVORK5CYII=', 'base64');
export async function startGenuineRecoveryRuntime(source, output, report) {
  const require = createRequire(resolve(source, 'package.json'));
  const { Miniflare, Log, LogLevel } = require('miniflare');
  const { generateKeyPair, exportJWK, SignJWT } = await import(require.resolve('jose'));
  const artifact = await productionWorkerArtifact(source), databaseId = randomUUID(), targetId = randomUUID();
  const namespace = JSON.stringify({ kind: 'local-r2', installationId: randomUUID(), bucketName: `browser-recovery-${randomUUID()}` });
  const config = resolve(output, 'wrangler.json'), persist = resolve(output, 'state');
  await writeFile(config, JSON.stringify({ name: 'genuine-recovery-browser-local-only', compatibility_date: artifact.compatibilityDate,
    d1_databases: [{ binding: 'DB', database_name: 'genuine-recovery-browser-source', database_id: databaseId, migrations_dir: resolve(source, 'migrations') }] }), { flag: 'wx', mode: 0o600 });
  const migration = await execute(process.execPath, [resolve(source, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist, '--config', config],
    { cwd: source, timeout: 120000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  await writeFile(resolve(output, 'migrations.log'), migration.stdout + migration.stderr, { flag: 'wx', mode: 0o600 });
  report.build = { workerPath: artifact.scriptPath, workerSha256: sha256(await readFile(artifact.scriptPath)), clientDirectory: artifact.assets.directory };
  report.migrations = { command: 'wrangler d1 migrations apply DB --local', log: 'migrations.log', databaseId };
  const actor = 'recovery-admin@browser-qualification.invalid', reader = 'recovery-reader@browser-qualification.invalid', audience = `browser-recovery-${randomUUID()}`;
  const keys = await generateKeyPair('RS256'), publicKey = { ...await exportJWK(keys.publicKey), kid: 'local-recovery-browser-key', alg: 'RS256', use: 'sig' };
  const jwksBytes = Buffer.from(JSON.stringify({ keys: [publicKey] }));
  let jwks, runtime, origin, accessProxy;
  const requests = [], issued = [], jwksRequests = [];
  async function close() {
    if (accessProxy?.listening) await new Promise((done, fail) => accessProxy.close(error => error ? fail(error) : done()));
    if (runtime) { const owned = runtime; runtime = undefined; await owned.dispose(); }
    if (jwks?.listening) await new Promise((done, fail) => jwks.close(error => error ? fail(error) : done()));
    report.runtimeClosed = true;
  }
  try {
    jwks = createServer((request, response) => {
      jwksRequests.push({ method: request.method, path: request.url });
      if (request.method !== 'GET' || request.url !== '/cdn-cgi/access/certs') { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(jwksBytes);
    });
    await new Promise((done, fail) => { jwks.once('error', fail); jwks.listen(0, '127.0.0.1', done); });
    const issuer = `http://127.0.0.1:${jwks.address().port}`;
    async function token(email) { return new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: publicKey.kid }).setIssuer(issuer)
      .setAudience(audience).setSubject(`fixture:${email}`).setIssuedAt().setExpirationTime('15m').sign(keys.privateKey); }
    const adminToken = await token(actor), readerToken = await token(reader);
    runtime = new Miniflare({ ...artifact, rootPath: source, modulesRoot: source, modules: true, host: '127.0.0.1', port: 0,
      d1Databases: { DB: databaseId, RECOVERY_DB: targetId }, d1Persist: resolve(persist, 'v3/d1'),
      r2Buckets: { ASSETS: JSON.parse(namespace).bucketName }, r2Persist: resolve(persist, 'v3/r2'), log: new Log(LogLevel.ERROR),
      bindings: { AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience, ALLOWED_EMAILS: `${actor},${reader}`,
        SYSTEM_ADMIN_EMAILS: actor, FILE_EVIDENCE_OPERATOR_EMAILS: actor, R2_BOOTSTRAP_NAMESPACE: namespace, RECOVERY_TARGET_ID: 'genuine-browser-isolated-target' },
      outboundService: async request => {
        assert.equal(request.url, `${issuer}/cdn-cgi/access/certs`, 'No provider or production network request is permitted.');
        assert.equal(request.method, 'GET'); const response = await fetch(request.url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
      } });
    origin = (await runtime.ready).origin;
    const database = await runtime.getD1Database('DB'), target = await runtime.getD1Database('RECOVERY_DB'), bucket = await runtime.getR2Bucket('ASSETS'), worker = await runtime.getWorker();
    const rows = async (sql, bindings = [], selected = database) => (await selected.prepare(sql).bind(...bindings).all()).results;
    const migrationNames = (await rows('SELECT name FROM d1_migrations ORDER BY id')).map(row => row.name);
    assert.equal(migrationNames.length, 24); assert(migrationNames.at(-1).startsWith('0024_'));
    assert.deepEqual(await rows("SELECT name FROM sqlite_schema WHERE type='table' AND name='collaboration_control'"), []);
    report.migrations.names = migrationNames; report.archiveSelection = { defaultCurrentMigrations: 24, expectedRecords: 'system-backup-records/3', expectedManifest: 'system-backup/3', collaborationV5Enabled: false };
    report.authorization = { localSignedIssuer: issuer, explicitAdministratorAllowlist: true, explicitFileOperatorAllowlist: true, jwksRequests };
    report.api = requests; report.schedule = issued;
    async function request(path, method = 'GET', body, expected = 200, headers = {}, identity = 'admin') {
      const binary = body instanceof Uint8Array;
      const response = await fetch(`${origin}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'cf-access-jwt-assertion': identity === 'admin' ? adminToken : readerToken,
          ...(body === undefined || binary ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }) });
      const bytes = Buffer.from(await response.arrayBuffer()), json = /^application\/json/.test(response.headers.get('content-type') ?? '');
      const value = json ? JSON.parse(bytes.toString('utf8')) : bytes;
      requests.push({ method, path, status: response.status, ...(body === undefined || binary ? {} : { input: body }),
        ...(binary ? { byteSize: body.byteLength, sha256: sha256(body) } : {}) });
      assert.equal(response.status, expected, `${method} ${path}: ${json ? JSON.stringify(value) : 'non-JSON response'}`); return value;
    }
    async function scheduleUntil(jobId, terminal) {
      const deadline = Date.now() + 180000;
      for (let step = 0; step < 200; step++) {
        assert(Date.now() < deadline, 'Actual manually issued recovery steps exceeded this QA three-minute deadline.');
        const current = await request(`/api/system-recovery/jobs/${jobId}`);
        if (current.state === terminal) return current;
        assert(['queued', 'running'].includes(current.state), `Job stopped: ${JSON.stringify(current)}`);
        const result = await worker.scheduled({ scheduledTime: new Date(), cron: '*/2 * * * *' });
        issued.push({ jobId, step, before: { state: current.state, phase: current.phase }, outcome: result.outcome });
        assert.equal(result.outcome, 'ok');
      }
      throw new Error('Recovery exceeded 200 actual manually issued scheduled events; no cadence qualification is claimed.');
    }
    let originalSample, originalEvents, originalAuthorityMode;
    return { source, output, origin, actor, adminToken, request, scheduleUntil, rows, database, target, bucket, close,
      async startBrowserAccessProxy() {
        assert(!accessProxy);
        let browserProxyOrigin;
        report.browserAccessProxy = { scope: 'Owned loopback edge forwards the unchanged public URL and body through Miniflare dispatchFetch and injects a genuine locally signed JWT, including Chromium download handoffs. Original Worker verifies JWT/JWKS and browser same-origin admission. API bodies, archives, execution and target results remain genuine.', requests: [], errors: [] };
        accessProxy = createServer((incoming, outgoing) => {
          void (async () => {
            const url = new URL(incoming.url, browserProxyOrigin); assert.equal(url.origin, browserProxyOrigin);
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (value !== undefined && !['host', 'connection', 'transfer-encoding', 'cf-access-jwt-assertion', 'accept-encoding'].includes(name)) headers.set(name, Array.isArray(value) ? value.join(',') : value);
            }
            headers.set('accept-encoding', 'identity'); headers.set('cf-access-jwt-assertion', adminToken);
            const upstream = await runtime.dispatchFetch(url, { method: incoming.method, headers, redirect: 'manual', signal: AbortSignal.timeout(20000),
              ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Readable.toWeb(incoming), duplex: 'half' }) });
            report.browserAccessProxy.requests.push({ method: incoming.method, path: url.pathname, status: upstream.status });
            outgoing.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => !['connection', 'transfer-encoding'].includes(name))));
            if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), outgoing); else outgoing.end();
          })().catch(error => {
            report.browserAccessProxy.errors.push({ name: error.name, code: error.code ?? null, message: error.message });
            if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end();
          });
        });
        await new Promise((done, fail) => { accessProxy.once('error', fail); accessProxy.listen(0, '127.0.0.1', done); });
        browserProxyOrigin = `http://127.0.0.1:${accessProxy.address().port}`;
        return browserProxyOrigin;
      },
      async verifyRecovery(recoveryJobId, publicReport) {
        const seed = report.sourceFixture;
        assert.deepEqual(await rows('SELECT CAST(rowid AS TEXT) physical_rowid,* FROM samples WHERE id=?', [seed.sampleId]), originalSample);
        assert.deepEqual(await rows('SELECT CAST(rowid AS TEXT) physical_rowid,* FROM events WHERE sample_id=? ORDER BY rowid', [seed.sampleId]), originalEvents);
        assert.deepEqual(await rows('SELECT CAST(rowid AS TEXT) physical_rowid,* FROM samples WHERE id=?', [seed.sampleId], target), originalSample);
        const targetEvents = await rows('SELECT CAST(rowid AS TEXT) physical_rowid,* FROM events WHERE sample_id=? ORDER BY rowid', [seed.sampleId], target);
        const originalAssetEvents = originalEvents.filter(row => row.asset_key === seed.objectKey);
        assert.equal(originalAssetEvents.length, 1); assert.equal(originalAssetEvents[0].asset_file_id, null);
        assert.deepEqual(targetEvents.map(row => row.asset_key === seed.objectKey ? { ...row, asset_file_id: null } : row), originalEvents);
        const repairedEvents = targetEvents.filter(row => row.asset_key === seed.objectKey && typeof row.asset_file_id === 'string');
        assert.equal(repairedEvents.length, originalAssetEvents.length);
        assert.deepEqual(publicReport.changes.filter(change => change.table === 'events' && change.column === 'asset_file_id'),
          [{ table: 'events', column: 'asset_file_id', reason: 'file_binding', count: repairedEvents.length }]);
        const relocated = await rows(`SELECT a.file_id,l.object_key,l.storage_profile_id,l.verified_byte_size byte_size,l.verified_sha256 sha256
          FROM assets a JOIN file_publications p ON p.file_id=a.file_id JOIN file_location_publications l ON l.location_id=p.active_location_id WHERE a.id=?`, [seed.assetId], target);
        assert.equal(relocated.length, 1); assert.notEqual(relocated[0].object_key, seed.objectKey); assert.equal(relocated[0].storage_profile_id, seed.profileId);
        assert.equal(repairedEvents[0].asset_file_id, relocated[0].file_id);
        const targetObject = await bucket.get(relocated[0].object_key), sourceObject = await bucket.get(seed.objectKey);
        assert(targetObject && sourceObject); assert.deepEqual(Buffer.from(await targetObject.arrayBuffer()), payload); assert.deepEqual(Buffer.from(await sourceObject.arrayBuffer()), payload);
        assert.equal(relocated[0].sha256, seed.sha256); assert.equal(relocated[0].byte_size, payload.length);
        const guards = {};
        for (const name of ['file_authority_runtime_guard', 'file_shadow_runtime_guard', 'file_job_runtime_guard', 'system_recovery_runtime']) {
          const values = await rows(`SELECT enabled FROM ${name}`, [], target); assert.equal(values.length, 1); assert.equal(values[0].enabled, 0); guards[name] = 0;
        }
        assert.deepEqual(await rows('SELECT * FROM system_storage_native_bindings', [], target), []);
        assert.deepEqual(await rows('PRAGMA foreign_key_check'), []); assert.deepEqual(await rows('PRAGMA foreign_key_check', [], target), []);
        assert.equal((await rows('SELECT mode FROM file_authority_control'))[0].mode, originalAuthorityMode);
        assert.equal((await request(`/api/samples/${seed.sampleId}`)).id, seed.sampleId);
        const targetClaim = await rows('SELECT target_id,job_id,status FROM system_recovery_target_claim', [], target);
        assert.equal(targetClaim[0].job_id, recoveryJobId); assert.equal(targetClaim[0].status, 'ready');
        report.independentReadback = { sourceSampleAndEventsUnchanged: true, observedRowidsPreserved: true, targetSampleAndEventMetadataPreserved: true,
          restoredEventFileBindingPresent: true, originalSourceBytesSha256: seed.sha256, relocatedTargetBytesSha256: seed.sha256,
          relocatedObjectKey: relocated[0].object_key, relocatedFileId: relocated[0].file_id, targetExecutionGuards: guards,
          targetNativeBindingsAbsent: true, sourceAuthorityModeUnchanged: originalAuthorityMode,
          sourceRemainsOriginalRunningDatabase: true, sourceAndTargetForeignKeysValid: true, targetClaim };
        return report.independentReadback;
      },
      async setup() {
        const ordinary = await request('/api/system-recovery/capabilities', 'GET', undefined, 200, {}, 'reader'); assert.equal(ordinary.canManage, false);
        await request('/api/system-recovery/backup-preview', 'GET', undefined, 403, {}, 'reader');
        assert.equal((await request('/api/system-recovery/capabilities')).target.configured, true);
        const sample = await request('/api/samples', 'POST', { code: `BROWSER-${randomUUID()}`, title: 'Genuine browser recovery source', status: 'stored', location: 'QA' }, 201);
        const asset = await request('/api/assets', 'POST', payload, 201, { 'content-type': 'image/png', 'x-upload-request-id': randomUUID(), 'x-filename-uri': encodeURIComponent('genuine-recovery.png') });
        assert.equal(typeof asset.key, 'string');
        const detail = await request(`/api/samples/${sample.id}`);
        await request(`/api/samples/${sample.id}/records`, 'POST', { status: 'stored', location: 'QA', pinned: false, expectedUpdatedAt: detail.updatedAt,
          body: 'Original HTTP-created recovery image', assetKey: asset.key }, 201);
        const stored = await bucket.get(asset.key); assert(stored); assert.deepEqual(Buffer.from(await stored.arrayBuffer()), payload);
        const settings = await request('/api/settings/storage?version=3'), profile = settings.profiles.items.find(value => value.adapterType === 'r2'); assert(profile);
        const status = await request('/api/files/shadow/status');
        const enabled = await request('/api/files/shadow/enable', 'POST', { requestId: randomUUID(), expectedEpoch: status.epoch, expectedIncarnation: status.incarnation });
        const admitted = await request('/api/files/shadow/profiles/enable', 'POST', { profile: { profileId: profile.id, configurationRevision: 1 }, runtimeIncarnation: enabled.incarnation, expectedEpoch: enabled.epoch });
        await request('/api/files/shadow/disable', 'POST', { runtimeIncarnation: admitted.incarnation, expectedEpoch: admitted.epoch });
        assert.equal((await rows('SELECT state FROM storage_profile_runtime WHERE storage_profile_id=?', [profile.id]))[0].state, 'read_write');
        assert.equal((await rows('SELECT enabled FROM file_shadow_runtime_guard'))[0].enabled, 0);
        assert.deepEqual(await rows('SELECT name FROM sqlite_schema WHERE type=\'table\' AND name NOT LIKE \'_cf_%\'', [], target), []);
        report.sourceFixture = { sampleId: sample.id, assetId: asset.id, objectKey: asset.key, profileId: profile.id, byteSize: payload.length, sha256: sha256(payload),
          setup: 'Ordinary signed Sample/PNG upload/record HTTP, then public shadow/profile admission and shadow disable. No business or authority SQL fixture rows.' };
        originalSample = await rows('SELECT CAST(rowid AS TEXT) physical_rowid,* FROM samples WHERE id=?', [sample.id]);
        originalEvents = await rows('SELECT CAST(rowid AS TEXT) physical_rowid,* FROM events WHERE sample_id=? ORDER BY rowid', [sample.id]);
        originalAuthorityMode = (await rows('SELECT mode FROM file_authority_control'))[0].mode;
        report.sourceFixture.authorityMode = originalAuthorityMode;
        return report.sourceFixture;
      } };
  } catch (error) { await close(); throw error; }
}
