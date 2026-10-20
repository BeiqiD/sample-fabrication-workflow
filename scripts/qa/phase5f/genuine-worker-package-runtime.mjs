// Genuine current Worker, native D1/R2, signed local Access and all-public setup.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { productionWorkerArtifact } from '../../production-worker-artifact.mjs';
import { sha256 } from './genuine-worker-recovery-runtime.mjs';
import { RESEARCH_PACKAGE_CATALOG } from '../../../shared/contracts/research-package-catalog.ts';

const execute = promisify(execFile);
// One-pixel grayscale/alpha PNG; IHDR/IDAT/IEND CRCs and inflated row verified.
const payload = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
export const packageBase = '/api/packages';
export async function startGenuinePackageRuntime(source, output, report) {
  const require = createRequire(resolve(source, 'package.json')), { Miniflare, Log, LogLevel } = require('miniflare');
  const { generateKeyPair, exportJWK, SignJWT } = await import(require.resolve('jose'));
  const artifact = await productionWorkerArtifact(source), databaseId = randomUUID();
  const bucketName = `package-browser-${randomUUID()}`, namespace = JSON.stringify({ kind: 'local-r2', installationId: randomUUID(), bucketName });
  const config = resolve(output, 'wrangler.json'), persist = resolve(output, 'state');
  await writeFile(config, JSON.stringify({ name: 'package-browser-local-only', compatibility_date: artifact.compatibilityDate,
    d1_databases: [{ binding: 'DB', database_name: 'package-browser', database_id: databaseId, migrations_dir: resolve(source, 'migrations') }] }), { flag: 'wx', mode: 0o600 });
  const migration = await execute(process.execPath, [resolve(source, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist, '--config', config],
    { cwd: source, timeout: 120000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  await writeFile(resolve(output, 'migrations.log'), migration.stdout + migration.stderr, { flag: 'wx', mode: 0o600 });
  const clientAssets = resolve(artifact.assets.directory, 'assets');
  const packageChunks = (await readdir(clientAssets)).filter(name => /^ResearchPackagesPage-.+\.js$/.test(name)); assert.equal(packageChunks.length, 1);
  report.build = { workerPath: artifact.scriptPath, workerSha256: sha256(await readFile(artifact.scriptPath)), clientDirectory: artifact.assets.directory,
    clientIndexSha256: sha256(await readFile(resolve(artifact.assets.directory, 'index.html'))),
    packagePageChunk: { filename: packageChunks[0], sha256: sha256(await readFile(resolve(clientAssets, packageChunks[0]))) } };
  const actor = 'package-admin@browser-qualification.invalid', audience = `package-browser-${randomUUID()}`, keys = await generateKeyPair('RS256');
  const publicKey = { ...await exportJWK(keys.publicKey), kid: 'package-browser-local-key', alg: 'RS256', use: 'sig' };
  let jwks, runtime, edge, origin, browserOrigin, loseNextImportAck = false, sourceSnapshot;
  report.api = []; report.schedule = []; report.edge = { requests: [], errors: [], cancelledReads: [], lostAcknowledgements: [] };
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
    const adminToken = await new SignJWT({ email: actor }).setProtectedHeader({ alg: 'RS256', kid: publicKey.kid }).setIssuer(issuer)
      .setAudience(audience).setSubject(`fixture:${actor}`).setIssuedAt().setExpirationTime('15m').sign(keys.privateKey);
    runtime = new Miniflare({ ...artifact, rootPath: source, modulesRoot: source, modules: true, host: '127.0.0.1', port: 0,
      d1Databases: { DB: databaseId }, d1Persist: resolve(persist, 'v3/d1'), r2Buckets: { ASSETS: bucketName }, r2Persist: resolve(persist, 'v3/r2'), log: new Log(LogLevel.ERROR),
      bindings: { AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience, ALLOWED_EMAILS: actor,
        SYSTEM_ADMIN_EMAILS: actor, FILE_EVIDENCE_OPERATOR_EMAILS: actor, R2_BOOTSTRAP_NAMESPACE: namespace },
      outboundService: async request => {
        assert.equal(request.url, `${issuer}/cdn-cgi/access/certs`, 'Only owned local JWKS network requests are permitted.'); assert.equal(request.method, 'GET');
        const response = await fetch(request.url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
      } });
    origin = (await runtime.ready).origin;
    const database = await runtime.getD1Database('DB'), bucket = await runtime.getR2Bucket('ASSETS'), worker = await runtime.getWorker();
    const rows = async (sql, bindings = []) => (await database.prepare(sql).bind(...bindings).all()).results;
    report.migrations = (await rows('SELECT name FROM d1_migrations ORDER BY id')).map(row => row.name);
    assert.equal(report.migrations.length, 25); assert.equal(report.migrations.at(-1), '0025_scheduler_fair_turn.sql');
    const scheduler = await rows('SELECT enabled,next_queue FROM file_job_runtime_guard WHERE singleton=1');
    assert.deepEqual(scheduler, [{ enabled: 0, next_queue: 'package' }]); report.initialSchedulerGuard = scheduler[0];
    async function request(path, method = 'GET', body, expected = 200, headers = {}) {
      const binary = body instanceof Uint8Array;
      const response = await fetch(`${origin}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'cf-access-jwt-assertion': adminToken, ...(body === undefined || binary ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }) });
      const bytes = Buffer.from(await response.arrayBuffer()), json = /^application\/json/.test(response.headers.get('content-type') ?? '');
      const value = json ? JSON.parse(bytes.toString('utf8')) : bytes;
      report.api.push({ method, path, status: response.status, ...(body === undefined || binary ? {} : { input: body }) });
      assert.equal(response.status, expected, `${method} ${path}: ${json ? JSON.stringify(value) : 'non-JSON body'}`); return value;
    }
    async function snapshotSource() {
      const f = report.sourceFixture, values = {};
      const queries = [
        ['samples', 'id IN (?,?)', [f.sampleId, report.bootstrap.sampleId]], ['events', 'sample_id IN (?,?)', [f.sampleId, report.bootstrap.sampleId]],
        ['projects', 'id=?', [f.projectId]], ['project_contents', 'project_id=?', [f.projectId]], ['project_items', 'project_id=?', [f.projectId]],
        ['project_content_attachments', 'project_content_id IN(SELECT id FROM project_contents WHERE project_id=?)', [f.projectId]],
        ['project_map_placements', 'project_item_id IN(SELECT id FROM project_items WHERE project_id=?)', [f.projectId]],
        ['reference_targets', 'id IN(SELECT reference_target_id FROM project_items WHERE project_id=?)', [f.projectId]],
        ['assets', 'id IN (?,?)', [f.assetId, report.bootstrap.assetId]], ['comment_submissions', 'id=?', [report.bootstrap.submissionId]],
        ['comment_submission_items', 'id=?', [report.bootstrap.itemId]],
      ];
      for (const [table, condition, bindings] of queries) {
        const schema = await rows("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?", [table]); assert.equal(schema.length, 1);
        const observedRowid = !/WITHOUT\s+ROWID/i.test(schema[0].sql);
        values[table] = await rows(`SELECT ${observedRowid ? 'CAST(rowid AS TEXT) observed_rowid,' : ''}* FROM ${table} WHERE ${condition} ORDER BY 1`, bindings);
      }
      return values;
    }
    async function scheduleUntil(jobId, terminal = 'completed') {
      const deadline = Date.now() + 180000;
      for (let step = 0; step < 200; step++) {
        assert(Date.now() < deadline, 'Actual manual Package events exceeded the existing QA three-minute budget.');
        const current = await request(`${packageBase}/jobs/${jobId}`); if (current.state === terminal) return current;
        assert(['queued', 'running'].includes(current.state), `Package stopped unexpectedly: ${JSON.stringify(current)}`);
        const result = await worker.scheduled({ scheduledTime: new Date(), cron: '*/2 * * * *' });
        report.schedule.push({ jobId, step, before: { state: current.state, phase: current.phase }, outcome: result.outcome }); assert.equal(result.outcome, 'ok');
      }
      throw new Error('Package exceeded200 actual manual scheduled events; no elapsed scheduler cadence qualification.');
    }
    return { source, output, actor, rows, request, scheduleUntil, close,
      armLostImportAck() { assert(!loseNextImportAck); loseNextImportAck = true; },
      async startBrowserAccessProxy() {
        assert(!edge);
        edge = createServer((incoming, outgoing) => { void (async () => {
          const url = new URL(incoming.url, browserOrigin); assert.equal(url.origin, browserOrigin);
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && !['host', 'connection', 'transfer-encoding', 'cf-access-jwt-assertion', 'accept-encoding'].includes(name)) headers.set(name, Array.isArray(value) ? value.join(',') : value);
          headers.set('accept-encoding', 'identity'); headers.set('cf-access-jwt-assertion', adminToken);
          const body = ['GET', 'HEAD'].includes(incoming.method) ? undefined : Buffer.concat(await Array.fromAsync(incoming));
          const input = headers.get('content-type') === 'application/json' && body?.length ? JSON.parse(body.toString('utf8')) : undefined;
          const upstream = await runtime.dispatchFetch(url, { method: incoming.method, headers, redirect: 'manual', signal: AbortSignal.timeout(20000), ...(body === undefined ? {} : { body }) });
          report.edge.requests.push({ method: incoming.method, path: url.pathname, status: upstream.status, ...(input ? { input } : {}),
            ...(body && !input ? { byteSize: body.length, sha256: sha256(body) } : {}) });
          if (outgoing.destroyed || outgoing.writableEnded) {
            assert(['GET', 'HEAD'].includes(incoming.method), 'A browser mutation disconnected before its real response could be forwarded.');
            if (upstream.body) await upstream.body.cancel();
            report.edge.cancelledReads.push({ method: incoming.method, path: url.pathname, status: upstream.status,
              disposition: 'Browser left before forwarding began; original upstream read body explicitly cancelled, no substitute response.' }); return;
          }
          if (loseNextImportAck && incoming.method === 'POST' && url.pathname === `${packageBase}/imports`) {
            loseNextImportAck = false; assert.equal(upstream.status, 202);
            const bytes = Buffer.from(await upstream.arrayBuffer()), ack = JSON.parse(bytes.toString('utf8'));
            const native = await rows('SELECT request_id,input_json,job_id FROM research_package_requests WHERE actor=? AND request_id=?', [actor, input.requestId]);
            assert.equal(native.length, 1); assert.equal(native[0].job_id, ack.job.id); assert.deepEqual(JSON.parse(native[0].input_json), input);
            report.edge.lostAcknowledgements.push({ requestId: input.requestId, jobId: ack.job.id, actualStatus: upstream.status, actualAckSha256: sha256(bytes),
              fault: 'Actual committed Worker202 ACK body truncated after original status headers; native job/receipt already present. No API/business/result substitution.' });
            outgoing.writeHead(upstream.status, { 'content-type': 'application/json', 'content-length': bytes.length + 1000, connection: 'close' });
            outgoing.write(bytes.subarray(0, 8)); outgoing.end(); return;
          }
          outgoing.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => !['connection', 'transfer-encoding'].includes(name))));
          if (upstream.body) {
            const sourceBody = Readable.fromWeb(upstream.body); let upstreamFailedFirst = false, clientClosedFirst = false;
            sourceBody.once('error', () => { if (!clientClosedFirst) upstreamFailedFirst = true; });
            sourceBody.once('close', () => { if (!sourceBody.readableEnded && !clientClosedFirst) upstreamFailedFirst = true; });
            const closed = () => { if (!outgoing.writableFinished && !upstreamFailedFirst) clientClosedFirst = true; };
            outgoing.once('close', closed);
            try { await pipeline(sourceBody, outgoing); }
            catch (error) {
              if (!['GET', 'HEAD'].includes(incoming.method) || !clientClosedFirst || error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
              report.edge.cancelledReads.push({ method: incoming.method, path: url.pathname, status: upstream.status, code: error.code,
                disposition: 'Browser response closed unfinished before any upstream failure; original read pipeline cancelled, no substitute response.' });
            } finally { outgoing.off('close', closed); }
          } else outgoing.end();
        })().catch(error => { report.edge.errors.push({ name: error.name, code: error.code ?? null, path: new URL(incoming.url, browserOrigin).pathname, message: error.message }); if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); }); });
        await new Promise((done, fail) => { edge.once('error', fail); edge.listen(0, '127.0.0.1', done); });
        browserOrigin = `http://127.0.0.1:${edge.address().port}`; return browserOrigin;
      },
      async setup() {
        assert.deepEqual(await rows('SELECT id FROM storage_profiles'), []);
        const sample = await request('/api/samples', 'POST', { code: `BOOTSTRAP-${randomUUID()}`, title: 'Unexported public authority bootstrap', status: 'stored', location: 'QA' }, 201);
        const detail = await request(`/api/samples/${sample.id}`), submissionId = randomUUID(), itemId = randomUUID();
        await request('/api/comment-submissions', 'POST', { protocol: 'comment-submission/1', id: submissionId, body: 'Separate retained public bootstrap graph',
          context: { kind: 'sample', sampleId: sample.id, expectedUpdatedAt: detail.updatedAt }, items: [{ id: itemId, kind: 'comment_image', filename: 'bootstrap.png', mimeType: 'image/png',
            byteSize: payload.length, originalFilename: 'bootstrap.png', originalMimeType: 'image/png', originalByteSize: payload.length, sha256: sha256(payload) }] }, 201);
        await request(`/api/comment-submissions/${submissionId}/items/${itemId}/content`, 'PUT', payload, 200,
          { 'content-type': 'image/png', 'x-upload-size': String(payload.length), 'x-content-sha256': sha256(payload) });
        await request(`/api/comment-submissions/${submissionId}/finalize`, 'POST');
        const accepted = await rows('SELECT accepted_result_json FROM comment_item_acceptances WHERE item_id=? AND submission_id=?', [itemId, submissionId]);
        assert.equal(accepted.length, 1); const bootstrap = JSON.parse(accepted[0].accepted_result_json);
        assert.deepEqual(Buffer.from(await (await bucket.get(bootstrap.objectKey)).arrayBuffer()), payload);
        const profiles = await rows('SELECT id FROM storage_profiles'); assert.equal(profiles.length, 1); const profileId = profiles[0].id;
        let shadow = await request('/api/files/shadow/status');
        shadow = await request('/api/files/shadow/enable', 'POST', { requestId: randomUUID(), expectedEpoch: shadow.epoch, expectedIncarnation: shadow.incarnation });
        shadow = await request('/api/files/shadow/profiles/enable', 'POST', { profile: { profileId, configurationRevision: 1 }, runtimeIncarnation: shadow.incarnation, expectedEpoch: shadow.epoch });
        const key = { consumerKind: 'comment_submission_item', consumerId: itemId, consumerSubId: '', fileSlot: 'primary' };
        const baseline = await request('/api/files/shadow/baseline', 'POST', { key }); assert.equal(baseline.status, 'ready_to_verify');
        const converted = await request('/api/files/shadow/convert', 'POST', { operationId: randomUUID(), key, expectedBaselineSha256: baseline.baselineSha256,
          destinationProfile: { profileId, configurationRevision: 1 }, runtimeIncarnation: shadow.incarnation }); assert.equal(converted.status, 'resolved');
        shadow = await request('/api/files/shadow/status');
        await request('/api/files/shadow/checkpoint', 'POST', { requestId: randomUUID(), expectedEpoch: shadow.epoch, runtimeIncarnation: shadow.incarnation });
        await request('/api/files/shadow/disable', 'POST', { runtimeIncarnation: shadow.incarnation, expectedEpoch: shadow.epoch });
        const status = await request('/api/files/authority/status');
        const authority = await request('/api/files/authority/activate', 'POST', { requestId: randomUUID(), expectedEpoch: status.epoch, expectedShadowIncarnation: shadow.incarnation }); assert.equal(authority.mode, 'active');
        const policy = await request('/api/settings/storage/defaults', 'PUT', { operationId: randomUUID(), expectedPolicyRevision: null, internalProfileId: profileId, originalsProfileId: profileId });
        assert(Number.isSafeInteger(policy.policyRevision));
        await request('/api/files/migrations/executor', 'POST', { enabled: true });
        report.bootstrap = { sampleId: sample.id, submissionId, itemId, assetId: bootstrap.blobRecordId, originalObjectKey: bootstrap.objectKey, profileId,
          scope: 'Separate unexported Sample/comment-image graph created through actual public HTTP. Public shadow baseline/conversion/checkpoint, authority activation, destination defaults and executor enablement; no SQL fixture writes.' };
        const research = await request('/api/samples', 'POST', { code: `PACKAGE-${randomUUID()}`, title: 'Package browser research Sample', status: 'stored', location: 'QA' }, 201);
        const researchDetail = await request(`/api/samples/${research.id}`); assert.equal(researchDetail.title, 'Package browser research Sample');
        const projectId = randomUUID(), created = await request('/api/projects', 'POST', { id: projectId, operationId: randomUUID(), title: 'Package browser mixed Project' }, 201);
        let revision = created.project.revision;
        const item = async (kind, body, index) => { const value = await request(`/api/projects/${projectId}/items/${kind}`, 'POST',
          { itemId: randomUUID(), placementId: randomUUID(), operationId: randomUUID(), expectedProjectRevision: revision,
            geometry: { x: index * 360, y: 20, width: 320, height: 220, zIndex: index }, ...body }, 201); revision = value.project.revision; return value; };
        const markdown = `# Genuine Package research\n\n中文记录 and $E=mc^2$. Literal source Sample id: ${research.id}.`;
        const text = await item('markdown', { contentId: randomUUID(), markdownSource: markdown }, 0);
        const reference = await item('reference', { target: { type: 'sample', id: research.id } }, 1);
        const asset = await request('/api/project-assets', 'POST', payload, 201, { 'content-type': 'image/png', 'x-project-filename-uri': encodeURIComponent('package-browser.png'), 'x-upload-request-id': randomUUID() });
        const attachment = await item('attachment', { contentId: randomUUID(), locator: { assetId: asset.id }, presentation: { originalName: 'package-browser.png', mimeType: 'image/png', byteSize: payload.length },
          caption: 'Exact original research PNG', sourceUrl: null }, 2);
        assert.deepEqual(await request(`/api/projects/${projectId}/contents/${attachment.content.id}/file`), payload);
        const published = await rows(`SELECT pca.file_id,l.object_key,l.storage_profile_id FROM project_content_attachments pca JOIN file_usable_publications f ON f.file_id=pca.file_id
          JOIN file_location_publications l ON l.location_id=f.active_location_id WHERE pca.project_content_id=? AND pca.asset_id=?`, [attachment.content.id, asset.id]);
        assert.equal(published.length, 1); assert.equal(published[0].storage_profile_id, profileId);
        report.sourceFixture = { sampleId: research.id, sampleTitle: researchDetail.title, projectId, projectTitle: created.project.title, markdownContentId: text.content.id,
          attachmentContentId: attachment.content.id, referenceItemId: reference.item.id, markdown, assetId: asset.id, fileId: published[0].file_id,
          objectKey: published[0].object_key, profileId, rolePolicyRevision: policy.policyRevision, byteSize: payload.length, sha256: sha256(payload),
          roots: [{ kind: 'sample', id: research.id }, { kind: 'project', id: projectId }] };
        sourceSnapshot = await snapshotSource(); report.sourceSnapshotSha256 = sha256(JSON.stringify(sourceSnapshot)); return report.sourceFixture;
      },
      async verifyCopy(jobId, archive) {
        const f = report.sourceFixture, jobs = await rows('SELECT * FROM research_package_jobs WHERE id=?', [jobId]); assert.equal(jobs.length, 1); const job = jobs[0];
        assert.equal(job.kind, 'import'); assert.equal(job.state, 'completed'); assert.equal(job.actor, actor);
        const plan = JSON.parse(job.domain_plan_json), identities = await rows('SELECT entity_kind,source_id,destination_id FROM research_package_identity_maps WHERE job_id=? ORDER BY entity_kind,source_id', [jobId]);
        assert.equal(plan.schema, 'research-domain-import/1'); assert.equal(identities.length, plan.identities.length);
        for (const identity of plan.identities) assert(identities.some(row => row.entity_kind === identity.kind && row.source_id === identity.sourceId && row.destination_id === identity.destinationId));
        for (const row of plan.rows) {
          const definition = RESEARCH_PACKAGE_CATALOG[row.kind]; assert(definition && definition.table === row.table);
          const actual = await rows(`SELECT * FROM ${definition.table} WHERE ${definition.id.map(name => `${name}=?`).join(' AND ')}`, definition.id.map(name => row.data[name]));
          assert.equal(actual.length, 1); for (const [name, value] of Object.entries(row.data)) assert.deepEqual(actual[0][name], value, `${row.kind}.${name}`);
          if (definition.id.length === 1 && definition.id[0] === 'id') assert.notEqual(row.id, row.sourceId);
        }
        const mapped = (kind, id) => { const row = identities.find(row => row.entity_kind === kind && row.source_id === id); assert(row); return row.destination_id; };
        const sampleId = mapped('sample', f.sampleId), projectId = mapped('project', f.projectId), attachmentId = mapped('projectContent', f.attachmentContentId);
        assert.notEqual(sampleId, f.sampleId); assert.notEqual(projectId, f.projectId);
        assert.equal((await request(`/api/samples/${sampleId}`)).title, f.sampleTitle);
        const project = await request(`/api/projects/${projectId}`); assert.equal(project.project.id, projectId); assert.equal(project.items.length, 3);
        assert.equal((await rows('SELECT markdown_source FROM project_contents WHERE id=?', [mapped('projectContent', f.markdownContentId)]))[0].markdown_source, f.markdown);
        const refs = await rows(`SELECT r.target_type,r.target_id FROM project_items i JOIN reference_targets r ON r.id=i.reference_target_id WHERE i.project_id=?`, [projectId]);
        assert.deepEqual(refs, [{ target_type: 'sample', target_id: sampleId }]);
        const files = await rows(`SELECT pca.asset_id,pca.file_id,pca.original_name,pca.mime_type,pca.byte_size,l.object_key,l.storage_profile_id,f.verified_sha256,f.verified_byte_size
          FROM project_content_attachments pca JOIN file_usable_publications f ON f.file_id=pca.file_id JOIN file_location_publications l ON l.location_id=f.active_location_id WHERE pca.project_content_id=?`, [attachmentId]);
        assert.equal(files.length, 1); const copied = files[0]; assert.notEqual(copied.file_id, f.fileId); assert.notEqual(copied.asset_id, f.assetId); assert.notEqual(copied.object_key, f.objectKey);
        assert.equal(copied.storage_profile_id, f.profileId); assert.equal(copied.verified_sha256, f.sha256); assert.equal(copied.verified_byte_size, payload.length);
        assert.equal(copied.original_name, 'package-browser.png'); assert.equal(copied.mime_type, 'image/png'); assert.equal(copied.byte_size, payload.length);
        assert.deepEqual(await request(`/api/projects/${projectId}/contents/${attachmentId}/file`), payload);
        assert.deepEqual(Buffer.from(await (await bucket.get(copied.object_key)).arrayBuffer()), payload);
        assert.deepEqual(Buffer.from(await (await bucket.get(f.objectKey)).arrayBuffer()), payload);
        assert.deepEqual(Buffer.from(await (await bucket.get(report.bootstrap.originalObjectKey)).arrayBuffer()), payload);
        assert.deepEqual(await snapshotSource(), sourceSnapshot); assert.deepEqual(await rows('PRAGMA foreign_key_check'), []);
        const records = (await rows('SELECT record_json FROM research_package_records WHERE job_id=? ORDER BY ordinal', [jobId])).map(row => JSON.parse(row.record_json));
        assert.deepEqual(records, archive.records.records); assert.equal(job.package_id, archive.manifest.packageId); assert.equal(job.source_installation_id, archive.manifest.sourceInstallationId);
        const targets = JSON.parse(job.target_policy_json); assert(Object.values(targets).every(target => target.profileId === f.profileId && target.policyRevision === f.rolePolicyRevision));
        const result = JSON.parse(job.result_json); assert.deepEqual(result.roots, plan.roots); assert.equal(result.reused, false);
        report.independentReadback = { jobId, importedRoots: result.roots, freshSampleId: sampleId, freshProjectId: projectId, copiedAttachmentContentId: attachmentId,
          frozenRowsCompared: plan.rows.length, identitiesCompared: identities.length, remappedProjectSampleReference: refs[0], copiedAttachment: copied,
          literalMarkdownPreserved: true, sourceSelectedRowsAndObservedRowidsUnchanged: true, separateBootstrapGraphRetained: true,
          exactSourceAndCopiedBytesSha256: f.sha256, publicAttachmentBytesExact: true, provenance: { packageId: job.package_id, sourceInstallationId: job.source_installation_id },
          acceptedTargets: targets, foreignKeysValid: true };
        return report.independentReadback;
      },
      async graphFingerprint() {
        const tables = [...new Set(Object.values(RESEARCH_PACKAGE_CATALOG).map(row => row.table))];
        const value = {}; for (const table of tables) value[table] = await rows(`SELECT * FROM ${table}`);
        return { sha256: sha256(JSON.stringify(value)), counts: Object.fromEntries(Object.entries(value).map(([table, items]) => [table, items.length])) };
      } };
  } catch (error) { await close(); throw error; }
}
