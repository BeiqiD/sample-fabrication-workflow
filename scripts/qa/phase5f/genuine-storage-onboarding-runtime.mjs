// Isolated genuine application owner. Only the provider transport is synthetic;
// authentication, SQL, encryption, public APIs and browser code are unchanged.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { productionWorkerArtifact } from '../../production-worker-artifact.mjs';

const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRXsAAAAASUVORK5CYII=', 'base64');
function uniquePng() {
  const text = Buffer.from(`qualification\0${randomUUID()}`), type = Buffer.from('tEXt'), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(text.length);
  let crc = 0xffffffff;
  for (const value of Buffer.concat([type, text])) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  assert.equal(png.subarray(-8, -4).toString(), 'IEND', 'PNG fixture terminator changed');
  return Buffer.concat([png.subarray(0, -12), length, type, text, checksum, png.subarray(-12)]);
}
export const onboardingBase = '/api/storage/configuration';
export const newSyntheticSeed = () => `sfi-seed-v1.${randomBytes(32).toString('base64url')}`;
export function newLegacyFixtureRoot() {
  return JSON.stringify({ version: 1, currentKeyId: 'browser-legacy-v1', keys: { 'browser-legacy-v1': randomBytes(32).toString('base64') } });
}

/** Every returned secret remains in the caller's process memory. Never place
 * this owner, candidateInput(), response bodies or roots into a report. */
export async function startGenuineStorageOnboardingRuntime(source, output, report, initialRoots = {}, { activeFileFixture = false } = {}) {
  const require = createRequire(resolve(source, 'package.json'));
  const { Miniflare, Log, LogLevel } = require('miniflare');
  const { generateKeyPair, exportJWK, SignJWT } = await import(require.resolve('jose'));
  const artifact = await productionWorkerArtifact(source);
  const databaseId = randomUUID(), bucketName = `onboarding-${randomUUID()}`;
  const namespace = JSON.stringify({ kind: 'local-r2', installationId: randomUUID(), bucketName });
  const persist = resolve(output, 'state'), config = resolve(output, 'wrangler.json');
  await writeFile(config, JSON.stringify({ name: 'genuine-storage-onboarding-local-only', compatibility_date: artifact.compatibilityDate,
    d1_databases: [{ binding: 'DB', database_name: 'genuine-storage-onboarding', database_id: databaseId,
      migrations_dir: resolve(source, 'migrations') }] }), { flag: 'wx', mode: 0o600 });
  const migration = await execute(process.execPath,
    [resolve(source, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist, '--config', config],
    { cwd: source, timeout: 120000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  await writeFile(resolve(output, 'migrations.log'), migration.stdout + migration.stderr, { flag: 'wx', mode: 0o600 });
  report.build = { workerSha256: digest(await readFile(artifact.scriptPath)), workerPath: artifact.scriptPath };
  report.providerScope = 'Owned in-memory AWS S3 transport with independently checked SigV4. No real AWS, Cloudflare account, production, provider outage or deployed acceptance is claimed.';
  report.api = []; report.bindingReloads = []; report.provider = { requests: [], objectsRemaining: 0 };
  report.edge = { requests: [], lostAcknowledgements: 0, errors: 0 };
  const actor = 'storage-admin@browser-qualification.invalid', reader = 'storage-reader@browser-qualification.invalid';
  const audience = `storage-onboarding-${randomUUID()}`, keys = await generateKeyPair('RS256');
  const publicKey = { ...await exportJWK(keys.publicKey), kid: 'local-storage-onboarding', alg: 'RS256', use: 'sig' };
  const providerAccess = `qa-${randomBytes(10).toString('hex')}`, providerSecret = randomBytes(32).toString('base64url');
  const providerOwner = '111122223333', providerBuckets = [0, 1, 2].map(() => `onboarding-${randomUUID()}`);
  const objects = new Map();
  let runtime, database, bucket, origin, jwks, edge, browserOrigin;
  let browserIdentity = 'admin', loseNextCandidateAck = false, generation = 0;
  const roots = {};

  async function close() {
    if (edge?.listening) await new Promise((done, fail) => { edge.close(error => error ? fail(error) : done()); edge.closeAllConnections(); });
    if (runtime) { const owned = runtime; runtime = undefined; await owned.dispose(); }
    if (jwks?.listening) await new Promise((done, fail) => { jwks.close(error => error ? fail(error) : done()); jwks.closeAllConnections(); });
    report.provider.objectsRemaining = objects.size;
    report.runtimeClosed = true;
  }
  async function syntheticProvider(request) {
    const url = new URL(request.url), bucketPart = decodeURIComponent(url.pathname.split('/')[1] ?? '');
    assert.equal(url.origin, 'https://s3.us-east-1.amazonaws.com', 'Unexpected provider origin');
    assert(providerBuckets.includes(bucketPart), 'Unexpected provider bucket');
    assert(['PUT', 'GET', 'HEAD', 'DELETE'].includes(request.method), 'Unexpected provider method');
    assert.equal(url.search, '', 'Unexpected provider query');
    const authorization = request.headers.get('authorization') ?? '';
    const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8}\/us-east-1\/s3\/aws4_request), SignedHeaders=([a-z0-9;-]+), Signature=([a-f0-9]{64})$/.exec(authorization);
    assert(match && match[1] === providerAccess, 'Unexpected signed credential');
    assert.equal(request.headers.get('x-amz-expected-bucket-owner'), providerOwner, 'Missing expected owner fence');
    const signed = match[3].split(';');
    assert.deepEqual(signed, [...signed].sort(), 'Noncanonical signed headers');
    assert(signed.includes('host') && signed.includes('x-amz-date') && signed.includes('x-amz-content-sha256') && signed.includes('x-amz-expected-bucket-owner'), 'Missing signing fence');
    const body = Buffer.from(await request.arrayBuffer());
    assert(body.length <= 65536, 'Provider fixture body budget exceeded');
    const payloadHash = request.headers.get('x-amz-content-sha256');
    assert.equal(payloadHash, digest(body), 'Signed payload mismatch');
    const canonical = [request.method, url.pathname, '', signed.map(name => `${name}:${(name === 'host' ? url.host : request.headers.get(name) ?? '').trim().replace(/\s+/g, ' ')}\n`).join(''), signed.join(';'), payloadHash].join('\n');
    const date = match[2].slice(0, 8), signingKey = hmac(hmac(hmac(hmac(`AWS4${providerSecret}`, date), 'us-east-1'), 's3'), 'aws4_request');
    const expected = hmac(signingKey, `AWS4-HMAC-SHA256\n${request.headers.get('x-amz-date')}\n${match[2]}\n${digest(canonical)}`);
    assert(timingSafeEqual(expected, Buffer.from(match[4], 'hex')), 'Invalid SigV4 signature');
    report.provider.requests.push({ method: request.method, signedPayloadVerified: true, expectedOwnerVerified: true });
    const key = url.pathname;
    if (request.method === 'PUT') { objects.set(key, { bytes: body, contentType: request.headers.get('content-type') ?? 'application/octet-stream' }); return new Response(null, { status: 200 }); }
    if (request.method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
    const stored = objects.get(key);
    if (!stored) return new Response(null, { status: 404 });
    return new Response(request.method === 'HEAD' ? null : stored.bytes.slice(), { status: 200,
      headers: { 'content-length': String(stored.bytes.length), 'content-type': stored.contentType, etag: `"${digest(stored.bytes)}"` } });
  }
  try {
    jwks = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/cdn-cgi/access/certs') { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ keys: [publicKey] }));
    });
    await new Promise((done, fail) => { jwks.once('error', fail); jwks.listen(0, '127.0.0.1', done); });
    const issuer = `http://127.0.0.1:${jwks.address().port}`;
    const token = email => new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: publicKey.kid }).setIssuer(issuer)
      .setAudience(audience).setSubject(`fixture:${email}`).setIssuedAt().setExpirationTime('30m').sign(keys.privateKey);
    const tokens = { admin: await token(actor), reader: await token(reader) };
    const ordinaryBindings = { AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience, ALLOWED_EMAILS: `${actor},${reader}`,
      SYSTEM_ADMIN_EMAILS: actor, FILE_EVIDENCE_OPERATOR_EMAILS: actor, R2_BOOTSTRAP_NAMESPACE: namespace };
    async function reloadCredentialRoots(next = {}) {
      assert(Object.keys(next).every(name => ['STORAGE_CREDENTIAL_KEYRING', 'INSTALLATION_SECRET_SEED'].includes(name)), 'Unknown root configuration field');
      assert(Object.values(next).every(value => typeof value === 'string'), 'Unexpected root configuration value');
      if (runtime) { const previous = runtime; runtime = undefined; await previous.dispose(); }
      for (const name of Object.keys(roots)) delete roots[name];
      Object.assign(roots, next);
      runtime = new Miniflare({ ...artifact, rootPath: source, modulesRoot: source, modules: true, host: '127.0.0.1', port: 0,
        d1Databases: { DB: databaseId }, d1Persist: resolve(persist, 'v3/d1'),
        r2Buckets: { ASSETS: bucketName }, r2Persist: resolve(persist, 'v3/r2'), log: new Log(LogLevel.ERROR),
        bindings: { ...ordinaryBindings, ...roots }, outboundService: async request => {
          if (request.url === `${issuer}/cdn-cgi/access/certs`) {
            assert.equal(request.method, 'GET'); const response = await fetch(request.url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
            return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
          }
          return syntheticProvider(request);
        } });
      origin = (await runtime.ready).origin;
      database = await runtime.getD1Database('DB'); bucket = await runtime.getR2Bucket('ASSETS');
      generation += 1;
      report.bindingReloads.push({ generation, seedConfigured: Object.hasOwn(roots, 'INSTALLATION_SECRET_SEED'), legacyConfigured: Object.hasOwn(roots, 'STORAGE_CREDENTIAL_KEYRING'), samePersistedDatabase: true });
    }
    await reloadCredentialRoots(initialRoots);
    const rows = async (sql, bindings = []) => (await database.prepare(sql).bind(...bindings).all()).results;
    const migrations = (await rows('SELECT name FROM d1_migrations ORDER BY id')).map(row => row.name);
    assert.equal(migrations.length, 25); assert.equal(migrations.at(-1), '0025_scheduler_fair_turn.sql');
    report.migrations = { names: migrations, nativeD1: true, remoteApplied: false };
    assert.deepEqual(await rows('SELECT enabled,next_queue FROM file_job_runtime_guard WHERE singleton=1'), [{ enabled: 0, next_queue: 'package' }]);
    async function request(path, method = 'GET', body, expected = 200, identity = 'admin', extraHeaders = {}) {
      assert(tokens[identity], 'Unknown request actor');
      const binary = body instanceof Uint8Array;
      const response = await fetch(`${origin}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'cf-access-jwt-assertion': tokens[identity], ...(body === undefined || binary ? {} : { 'content-type': 'application/json' }), ...extraHeaders },
        ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }) });
      const bytes = Buffer.from(await response.arrayBuffer()), json = /^application\/json/.test(response.headers.get('content-type') ?? '');
      const value = json ? JSON.parse(bytes.toString('utf8')) : bytes;
      report.api.push({ method, path: new URL(path, origin).pathname, identity, status: response.status });
      assert.equal(response.status, expected, 'Unexpected application HTTP status');
      return value;
    }
    let baseline;
    return { source, output, actor, request, rows, reloadCredentialRoots, close,
      assertProviderCleanup() { assert.equal(objects.size, 0, 'Temporary provider object cleanup incomplete'); return true; },
      candidateInput(index, label) {
        assert(Number.isInteger(index) && index >= 0 && index < providerBuckets.length, 'Unknown candidate fixture');
        return { expectedRevision: null, label,
          namespace: { kind: 's3', endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', bucket: providerBuckets[index], root: 'onboarding', forcePathStyle: true, expectedBucketOwner: providerOwner },
          credentials: { mode: 'replace', value: { accessKeyId: providerAccess, secretAccessKey: providerSecret } } };
      },
      async assertProtectedCredentials() {
        const payloads = await rows('SELECT ciphertext,key_id FROM system_storage_credential_payloads');
        assert(payloads.length > 0, 'Expected encrypted candidate payload');
        assert(payloads.every(row => !String(row.ciphertext).includes(providerAccess) && !String(row.ciphertext).includes(providerSecret)), 'Provider material leaked into ciphertext representation');
        const status = await request(onboardingBase);
        assert(status.candidates.items.every(candidate => candidate.credentials.status === 'configured'), 'Retained candidate credentials unavailable');
        const json = JSON.stringify(status);
        assert(!json.includes(providerAccess) && !json.includes(providerSecret), 'Provider material leaked into public metadata');
        assert(Object.values(roots).every(value => !json.includes(value)), 'Root leaked into public metadata');
        return { encryptedPayloads: payloads.length, metadataContainsNoSecrets: true };
      },
      async originalState() {
        return { sample: await rows('SELECT * FROM samples WHERE id=?', [baseline.sampleId]),
          asset: await rows('SELECT * FROM assets WHERE id=?', [baseline.assetId]),
          policy: await rows('SELECT * FROM storage_role_defaults ORDER BY role'),
          policyHistory: await rows('SELECT * FROM storage_role_policy_revisions ORDER BY policy_revision,role'),
          nativeBindings: await rows('SELECT * FROM system_storage_native_bindings ORDER BY storage_profile_id') };
      },
      async assertR2Unchanged() {
        const stored = await bucket.get(baseline.assetKey); assert(stored, 'Original R2 object missing');
        assert(Buffer.from(await stored.arrayBuffer()).equals(png), 'Original R2 bytes changed');
        assert.equal((await request(`/api/samples/${baseline.sampleId}`)).id, baseline.sampleId);
        assert.deepEqual(await rows('PRAGMA foreign_key_check'), []);
        return { originalR2Readable: true, sourceSampleReadable: true, foreignKeysValid: true };
      },
      async assertR2Upload() {
        const bytes = uniquePng();
        const asset = await request('/api/assets', 'POST', bytes, 201, 'admin', { 'content-type': 'image/png', 'x-upload-request-id': randomUUID(), 'x-filename-uri': 'onboarding-no-root.png' });
        const physical = await rows('SELECT r2_key,object_key,storage_profile_id FROM assets WHERE id=?', [asset.id]);
        assert.equal(physical.length, 1, 'Uploaded R2 alias absent');
        const key = physical[0].r2_key ?? physical[0].object_key;
        assert.equal(typeof key, 'string', 'Uploaded R2 object key absent');
        const stored = await bucket.get(key); assert(stored, 'R2 upload missing');
        assert(Buffer.from(await stored.arrayBuffer()).equals(bytes), 'R2 upload bytes changed');
        return { genuineR2UploadWithoutExternalCredentials: true, bytes: bytes.length, sha256: digest(bytes) };
      },
      async enableFileAuthority() {
        if (report.fixtureAuthority) {
          const authority = await request('/api/files/authority/status');
          assert.equal(authority.mode, 'active', 'Fixture authority changed');
          assert.equal(authority.enabled, 1, 'Fixture File access became disabled');
          return report.fixtureAuthority.bootstrapR2ProfileId;
        }
        const settings = await request('/api/settings/storage?version=3');
        const profile = settings.profiles.items.find(value => value.adapterType === 'r2'); assert(profile, 'Bootstrap R2 profile missing');
        const status = await request('/api/files/shadow/status');
        let shadow = await request('/api/files/shadow/enable', 'POST', { requestId: randomUUID(), expectedEpoch: status.epoch, expectedIncarnation: status.incarnation });
        shadow = await request('/api/files/shadow/profiles/enable', 'POST', { profile: { profileId: profile.id, configurationRevision: 1 }, runtimeIncarnation: shadow.incarnation, expectedEpoch: shadow.epoch });
        await request('/api/files/shadow/disable', 'POST', { runtimeIncarnation: shadow.incarnation, expectedEpoch: shadow.epoch });
        const authority = await request('/api/files/authority/status');
        await request('/api/files/authority/activate', 'POST', { requestId: randomUUID(), expectedEpoch: authority.epoch, expectedShadowIncarnation: shadow.incarnation });
        assert.equal((await request('/api/settings/storage?version=3')).authority.mode, 'active');
        report.fixtureAuthority = { activatedThroughSignedPublicApi: true, bootstrapR2ProfileId: profile.id, schedulerStillDisabled: true };
        return profile.id;
      },
      setBrowserIdentity(identity) { assert(tokens[identity], 'Unknown browser actor'); browserIdentity = identity; },
      armLostCandidateAcknowledgement() { assert(!loseNextCandidateAck); loseNextCandidateAck = true; },
      async startBrowserAccessProxy() {
        assert(!edge, 'Browser edge already started');
        edge = createServer((incoming, outgoing) => { void (async () => {
          const url = new URL(incoming.url, browserOrigin); assert.equal(url.origin, browserOrigin, 'Unexpected forwarding origin');
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && !['host', 'connection', 'transfer-encoding', 'cf-access-jwt-assertion', 'accept-encoding'].includes(name)) headers.set(name, Array.isArray(value) ? value.join(',') : value);
          headers.set('accept-encoding', 'identity'); headers.set('cf-access-jwt-assertion', tokens[browserIdentity]);
          const body = ['GET', 'HEAD'].includes(incoming.method) ? undefined : Readable.toWeb(incoming);
          const upstream = await runtime.dispatchFetch(url, { method: incoming.method, headers, redirect: 'manual', signal: AbortSignal.timeout(25000), ...(body === undefined ? {} : { body, duplex: 'half' }) });
          report.edge.requests.push({ method: incoming.method, path: url.pathname, status: upstream.status, actor: browserIdentity });
          if (loseNextCandidateAck && incoming.method === 'PUT' && url.pathname === `${onboardingBase}/candidates`) {
            loseNextCandidateAck = false; assert.equal(upstream.status, 200, 'Candidate did not commit before ACK loss');
            const bytes = Buffer.from(await upstream.arrayBuffer());
            report.edge.lostAcknowledgements += 1;
            outgoing.writeHead(upstream.status, { 'content-type': 'application/json', 'content-length': bytes.length + 1000, connection: 'close' });
            outgoing.write(bytes.subarray(0, Math.min(8, bytes.length))); outgoing.end(); return;
          }
          outgoing.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => !['connection', 'transfer-encoding'].includes(name))));
          if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), outgoing); else outgoing.end();
        })().catch(() => { report.edge.errors += 1; if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); }); });
        await new Promise((done, fail) => { edge.once('error', fail); edge.listen(0, '127.0.0.1', done); });
        browserOrigin = `http://127.0.0.1:${edge.address().port}`;
        return browserOrigin;
      },
      async setup() {
        assert.equal((await request(`${onboardingBase}/capability`)).canManage, true);
        assert.deepEqual(await request(`${onboardingBase}/capability`, 'GET', undefined, 200, 'reader'), { canManage: false, credentialEditingAvailable: false });
        await request(`${onboardingBase}/encryption-readiness`, 'GET', undefined, 403, 'reader');
        if (activeFileFixture) {
          // Installation-owned bootstrap metadata, with every original schema
          // constraint/trigger intact. Equivalent fields/conditional INSERT to
          // ensureR2BootstrapProfile; no File, asset, receipt or guard SQL writes.
          const catalogSql = "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name";
          const catalogBefore = digest(JSON.stringify(await rows(catalogSql)));
          assert.equal((await rows('SELECT id FROM storage_profiles')).length, 0, 'Unexpected preinstalled storage profile');
          await database.prepare(`INSERT INTO storage_profiles
            (id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at)
            SELECT ?, 'r2', ?, 'bootstrap', NULL, 1, 'historical', ?
            WHERE NOT EXISTS(SELECT 1 FROM storage_profiles WHERE adapter_type='r2')`)
            .bind('storage-profile:r2:bootstrap', namespace, new Date().toISOString()).run();
          const metadata = await rows('SELECT id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state FROM storage_profiles');
          assert.deepEqual(metadata, [{ id: 'storage-profile:r2:bootstrap', adapter_type: 'r2', namespace_identity: namespace,
            configuration_source: 'bootstrap', credential_reference: null, configuration_revision: 1, state: 'historical' }]);
          assert.equal(digest(JSON.stringify(await rows(catalogSql))), catalogBefore, 'Installation fixture changed schema or guards');
          report.installationFixture = { bootstrapR2MetadataRows: 1, fieldsMatchProductionBootstrapHelper: true,
            schemaAndOriginalGuardsUnchanged: true, noDirectBusinessOrRuntimeGuardSqlWrites: true,
            scope: 'Explicit installed File-active browser prerequisite. One deployment-owned R2 profile metadata row, followed by signed public empty shadow/profile admission and File authority activation before any business asset. This is not automatic production bootstrap or zero-operation native S3 activation.' };
          await this.enableFileAuthority();
        }
        const sample = await request('/api/samples', 'POST', { code: `ONBOARD-${randomUUID()}`, title: 'Genuine onboarding source', status: 'stored', location: 'QA' }, 201);
        const asset = await request('/api/assets', 'POST', png, 201, 'admin', { 'content-type': 'image/png', 'x-upload-request-id': randomUUID(), 'x-filename-uri': 'onboarding-source.png' });
        const stored = await bucket.get(asset.key); assert(stored, 'Initial R2 bytes absent');
        assert(Buffer.from(await stored.arrayBuffer()).equals(png), 'Initial R2 bytes changed');
        baseline = { sampleId: sample.id, assetId: asset.id, assetKey: asset.key };
        report.sourceFixture = { ordinarySignedSampleAndR2Upload: true, initialR2Bytes: png.length, initialR2Sha256: digest(png), noBusinessSqlFixtureWrites: true };
        return { ...report.sourceFixture };
      } };
  } catch (error) { await close(); throw error; }
}
