// Two genuine local R2 providers and signed public File/migration operations.
// Only installation-owned historical profile metadata uses the existing SQL fixture.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { productionWorkerArtifact } from '../../production-worker-artifact.mjs';
import { prepareHistoricalR2Profiles } from './prepare-file-migration-historical-r2-profiles.mjs';
import { sha256, payload } from './genuine-worker-recovery-runtime.mjs';

const execute = promisify(execFile);
export const migrationBase = '/api/files/migrations';
export async function startMigrationIntentRuntime(source, output, report) {
  const require = createRequire(resolve(source, 'package.json'));
  const { Miniflare, Log, LogLevel } = require('miniflare');
  const { generateKeyPair, exportJWK, SignJWT } = await import(require.resolve('jose'));
  const artifact = await productionWorkerArtifact(source), databaseId = randomUUID(), installationId = randomUUID();
  const sourceProfileId = 'storage-profile:r2:bootstrap', targetProfileId = 'storage-profile:r2:qa-migration-target';
  const sourceBucketName = `migration-source-${randomUUID()}`, targetBucketName = `migration-target-${randomUUID()}`;
  const namespaces = Object.fromEntries([['source', sourceBucketName], ['target', targetBucketName]].map(([key, bucketName]) =>
    [key, JSON.stringify({ kind: 'local-r2', installationId, bucketName })]));
  const config = resolve(output, 'wrangler.json'), persist = resolve(output, 'state');
  await writeFile(config, JSON.stringify({ name: 'migration-intent-local-only', compatibility_date: artifact.compatibilityDate,
    d1_databases: [{ binding: 'DB', database_name: 'migration-intent', database_id: databaseId, migrations_dir: resolve(source, 'migrations') }] }), { flag: 'wx', mode: 0o600 });
  const migration = await execute(process.execPath, [resolve(source, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist, '--config', config],
    { cwd: source, timeout: 120000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  await writeFile(resolve(output, 'migrations.log'), migration.stdout + migration.stderr, { flag: 'wx', mode: 0o600 });
  report.build = { workerPath: artifact.scriptPath, workerSha256: sha256(await readFile(artifact.scriptPath)), clientDirectory: artifact.assets.directory };
  report.installationFixture = { helper: 'prepare-file-migration-historical-r2-profiles.mjs',
    scope: 'Exactly two historical R2 installation profile metadata rows plus original registration triggers; schema unchanged. All authority/profile enablement, File creation, migration acceptance and execution use actual public Worker APIs. No business File/job/result SQL fixture writes.',
    namespaces };
  const actor = 'migration-admin-a@browser-qualification.invalid', competitor = 'migration-admin-b@browser-qualification.invalid';
  const audience = `migration-intent-${randomUUID()}`, keys = await generateKeyPair('RS256');
  const publicKey = { ...await exportJWK(keys.publicKey), kid: 'migration-intent-local-key', alg: 'RS256', use: 'sig' };
  let jwks, runtime, edge, origin, browserOrigin, loseNextAck = false;
  report.api = []; report.schedule = []; report.edge = { requests: [], errors: [], lostAcknowledgements: [] };
  async function close() {
    if (edge?.listening) await new Promise((done, fail) => edge.close(error => error ? fail(error) : done()));
    if (runtime) { const owned = runtime; runtime = undefined; await owned.dispose(); }
    if (jwks?.listening) await new Promise((done, fail) => jwks.close(error => error ? fail(error) : done()));
    report.runtimeClosed = true;
  }
  try {
    jwks = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/cdn-cgi/access/certs') { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ keys: [publicKey] }));
    });
    await new Promise((done, fail) => { jwks.once('error', fail); jwks.listen(0, '127.0.0.1', done); });
    const issuer = `http://127.0.0.1:${jwks.address().port}`;
    const token = email => new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: publicKey.kid }).setIssuer(issuer)
      .setAudience(audience).setSubject(`fixture:${email}`).setIssuedAt().setExpirationTime('15m').sign(keys.privateKey);
    const tokens = { admin: await token(actor), competitor: await token(competitor) };
    runtime = new Miniflare({ ...artifact, rootPath: source, modulesRoot: source, modules: true, host: '127.0.0.1', port: 0,
      d1Databases: { DB: databaseId }, d1Persist: resolve(persist, 'v3/d1'),
      r2Buckets: { ASSETS: sourceBucketName, MIGRATION_TARGET: targetBucketName }, r2Persist: resolve(persist, 'v3/r2'), log: new Log(LogLevel.ERROR),
      bindings: { AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience, ALLOWED_EMAILS: `${actor},${competitor}`,
        SYSTEM_ADMIN_EMAILS: `${actor},${competitor}`, FILE_EVIDENCE_OPERATOR_EMAILS: `${actor},${competitor}`, R2_BOOTSTRAP_NAMESPACE: namespaces.source,
        R2_PROFILE_BINDINGS: JSON.stringify({ [sourceProfileId]: { namespaceIdentity: namespaces.source, bindingName: 'ASSETS' },
          [targetProfileId]: { namespaceIdentity: namespaces.target, bindingName: 'MIGRATION_TARGET' } }) },
      outboundService: async request => {
        assert.equal(request.url, `${issuer}/cdn-cgi/access/certs`, 'Only the owned local signed issuer may be contacted.'); assert.equal(request.method, 'GET');
        const response = await fetch(request.url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
      } });
    origin = (await runtime.ready).origin;
    const database = await runtime.getD1Database('DB'), sourceBucket = await runtime.getR2Bucket('ASSETS'), targetBucket = await runtime.getR2Bucket('MIGRATION_TARGET'), worker = await runtime.getWorker();
    const rows = async (sql, bindings = []) => (await database.prepare(sql).bind(...bindings).all()).results;
    const migrations = (await rows('SELECT name FROM d1_migrations ORDER BY id')).map(row => row.name);
    assert.equal(migrations.length, 24); assert(migrations.at(-1).startsWith('0024_')); report.migrations = migrations;
    async function request(path, method = 'GET', body, expected = 200, headers = {}, identity = 'admin') {
      assert(tokens[identity]); const binary = body instanceof Uint8Array;
      const response = await fetch(`${origin}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'cf-access-jwt-assertion': tokens[identity], ...(body === undefined || binary ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }) });
      const bytes = Buffer.from(await response.arrayBuffer()), json = /^application\/json/.test(response.headers.get('content-type') ?? '');
      const value = json ? JSON.parse(bytes.toString('utf8')) : bytes;
      report.api.push({ method, path, identity, status: response.status, ...(body === undefined || binary ? {} : { input: body }) });
      assert.equal(response.status, expected, `${method} ${path}: ${json ? JSON.stringify(value) : 'non-JSON body'}`); return value;
    }
    async function scheduleUntil(jobId, identity = 'admin') {
      const deadline = Date.now() + 90000;
      for (let step = 0; step < 100; step++) {
        assert(Date.now() < deadline, 'Actual manually issued migration events exceeded this QA90-second deadline.');
        const current = await request(`${migrationBase}/${jobId}`, 'GET', undefined, 200, {}, identity);
        if (current.state === 'completed') return current;
        assert(['queued', 'running'].includes(current.state), `Migration stopped unexpectedly: ${JSON.stringify(current)}`);
        const result = await worker.scheduled({ scheduledTime: new Date(), cron: '*/2 * * * *' });
        report.schedule.push({ jobId, step, state: current.state, outcome: result.outcome }); assert.equal(result.outcome, 'ok');
      }
      throw new Error('Migration exceeded100 actual manual scheduled events; no elapsed scheduler cadence is claimed.');
    }
    return { source, output, actor, competitor, rows, request, scheduleUntil, close,
      armLostAck() { assert(!loseNextAck); loseNextAck = true; },
      async startBrowserAccessProxy() {
        assert(!edge);
        edge = createServer((incoming, outgoing) => { void (async () => {
          const url = new URL(incoming.url, browserOrigin); assert.equal(url.origin, browserOrigin);
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && !['host', 'connection', 'transfer-encoding', 'cf-access-jwt-assertion', 'accept-encoding'].includes(name)) headers.set(name, Array.isArray(value) ? value.join(',') : value);
          headers.set('accept-encoding', 'identity'); headers.set('cf-access-jwt-assertion', tokens.admin);
          const body = ['GET', 'HEAD'].includes(incoming.method) ? undefined : Buffer.concat(await Array.fromAsync(incoming));
          const input = headers.get('content-type') === 'application/json' && body?.length ? JSON.parse(body.toString('utf8')) : undefined;
          const upstream = await runtime.dispatchFetch(url, { method: incoming.method, headers, redirect: 'manual', signal: AbortSignal.timeout(20000), ...(body === undefined ? {} : { body }) });
          report.edge.requests.push({ method: incoming.method, path: url.pathname, status: upstream.status, ...(input ? { input } : {}) });
          if (loseNextAck && incoming.method === 'POST' && url.pathname === migrationBase) {
            loseNextAck = false; assert.equal(upstream.status, 202);
            const bytes = Buffer.from(await upstream.arrayBuffer()), ack = JSON.parse(bytes.toString('utf8'));
            const native = await rows('SELECT id,request_id,actor FROM file_migration_jobs WHERE request_id=?', [input.requestId]);
            assert.equal(native.length, 1); assert.equal(native[0].id, ack.id); assert.equal(native[0].actor, actor);
            report.edge.lostAcknowledgements.push({ requestId: input.requestId, jobId: ack.id, status: upstream.status, actualAckSha256: sha256(bytes),
              fault: 'Actual Worker committed202 ACK body deliberately truncated after response headers; no API response substitution or acceptance retry.' });
            outgoing.writeHead(upstream.status, { 'content-type': 'application/json', 'content-length': bytes.length + 1000, connection: 'close' });
            outgoing.write(bytes.subarray(0, Math.min(8, bytes.length))); outgoing.end(); return;
          }
          outgoing.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => !['connection', 'transfer-encoding'].includes(name))));
          if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), outgoing); else outgoing.end();
        })().catch(error => { report.edge.errors.push({ name: error.name, message: error.message }); if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); }); });
        await new Promise((done, fail) => { edge.once('error', fail); edge.listen(0, '127.0.0.1', done); });
        browserOrigin = `http://127.0.0.1:${edge.address().port}`; return browserOrigin;
      },
      async setup() {
        const preparation = await prepareHistoricalR2Profiles(database, namespaces, new Date().toISOString());
        assert.equal(preparation.originalCatalogExact, true); report.installationFixture.originalCatalogExact = true;
        assert.equal((await request('/api/storage/configuration/capability')).canManage, true);
        assert.equal((await request('/api/storage/configuration/capability', 'GET', undefined, 200, {}, 'competitor')).canManage, true);
        const status = await request('/api/files/shadow/status');
        let shadow = await request('/api/files/shadow/enable', 'POST', { requestId: randomUUID(), expectedEpoch: status.epoch, expectedIncarnation: status.incarnation });
        for (const profileId of [sourceProfileId, targetProfileId]) shadow = await request('/api/files/shadow/profiles/enable', 'POST',
          { profile: { profileId, configurationRevision: 1 }, runtimeIncarnation: shadow.incarnation, expectedEpoch: shadow.epoch });
        await request('/api/files/shadow/disable', 'POST', { runtimeIncarnation: shadow.incarnation, expectedEpoch: shadow.epoch });
        const authority = await request('/api/files/authority/status');
        await request('/api/files/authority/activate', 'POST', { requestId: randomUUID(), expectedEpoch: authority.epoch, expectedShadowIncarnation: shadow.incarnation });
        const uploadRequestId = randomUUID(), upload = await request('/api/project-assets', 'POST', payload, 201,
          { 'content-type': 'image/png', 'x-project-filename-uri': encodeURIComponent('genuine-migration-intent.png'), 'x-upload-request-id': uploadRequestId });
        assert.deepEqual(await request(`/api/assets/${upload.key}`), payload);
        const files = await rows(`SELECT f.file_id,f.active_location_id,l.storage_profile_id,l.object_key,f.verified_byte_size,f.verified_sha256
          FROM r2_upload_requests r JOIN file_acceptance_candidates c ON c.acceptance_kind='r2_upload' AND c.acceptance_id=r.id AND c.state='ready'
          JOIN file_usable_publications f ON f.file_id=c.result_file_id JOIN file_locations l ON l.id=f.active_location_id WHERE r.actor_email=? AND r.client_request_id=?`, [actor, uploadRequestId]);
        assert.equal(files.length, 1); assert.equal(files[0].storage_profile_id, sourceProfileId); assert.equal(files[0].verified_sha256, sha256(payload));
        assert.deepEqual(Buffer.from(await (await sourceBucket.get(files[0].object_key)).arrayBuffer()), payload);
        assert.equal((await targetBucket.list()).objects.length, 0);
        report.sourceFile = { ...files[0], assetId: upload.id, sourceProfileId, targetProfileId, byteSize: payload.length, sha256: sha256(payload),
          setup: 'Genuine signed HTTP authority/profile activation and project PNG upload, original publication plus exact native source R2 readback.' };
        return report.sourceFile;
      },
      async verifyFile(profileId) {
        const file = report.sourceFile;
        const publications = await rows(`SELECT p.file_id,p.active_location_id,l.storage_profile_id,l.object_key,l.verified_byte_size,l.verified_sha256
          FROM file_usable_publications p JOIN file_location_publications l ON l.location_id=p.active_location_id AND l.file_id=p.file_id WHERE p.file_id=?`, [file.file_id]);
        assert.equal(publications.length, 1); const active = publications[0]; assert.equal(active.storage_profile_id, profileId);
        const bucket = profileId === sourceProfileId ? sourceBucket : targetBucket;
        assert.deepEqual(Buffer.from(await (await bucket.get(active.object_key)).arrayBuffer()), payload);
        assert.equal(active.verified_sha256, file.sha256); assert.equal(active.verified_byte_size, payload.length);
        assert.deepEqual(Buffer.from(await (await sourceBucket.get(file.object_key)).arrayBuffer()), payload);
        assert.deepEqual(await rows('PRAGMA foreign_key_check'), []);
        const jobs = await rows('SELECT id,request_id,actor,input_json,state,accepted_at FROM file_migration_jobs ORDER BY accepted_at,id');
        const value = { active, sourceOriginalRetained: true, activeBytesSha256: sha256(payload), foreignKeysValid: true, jobs };
        (report.nativeReadbacks ??= []).push(value); return value;
      } };
  } catch (error) { await close(); throw error; }
}
