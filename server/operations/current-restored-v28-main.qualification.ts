import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { verifyNodeDistribution } from '../../scripts/lib/node-distribution-v28-manifest.mjs';
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from '../installation-catalog-v28-candidate.ts';
import { admitInstallationRecoverySource, assertInstallationAdmission } from '../migrations';
import { executeV28OrdinaryAccountOperatorCandidate, v28OrdinaryAccountOperatorProcessState } from './ordinary-account-v28-candidate';
import { canonicalFileObject, canonicalFilePrivateOrigin, consumeCanonicalFileClient, fetchCanonicalFileClient,
  retainedCanonicalFileCase, withCanonicalFileDatabase,
  type CanonicalFileClientOwner, type CanonicalFileFixtureOwner } from '../collaboration/current-v28-canonical-comment-file.qualification-support';

// Root runs preparation1 -> operators2 -> maintenance3 -> this case against the
// SAME new target. Case2 of maintenance3 opens its first destination; case3's
// separate ACK-fault target is never selected here. No historical target, SQL
// seed, V26 alias or manufactured startup/config authority substitutes for it.
const PASSWORD = 'Synthetic independent V28 destination reset password';
const ORDINARY_PASSWORD = 'Synthetic independent restored V28 ordinary readiness password';
const PRE_NATIVE_RESERVE = 603_979_776n;
let path: string, principalId: string, installationId: string, reportSha256: string;
let distribution: string, rootUid: number;
function ensure(value: unknown): asserts value { if (!value) throw new Error('Current genuine restored V28 compiled-main qualification unavailable'); }
async function noDefaultDatabase(): Promise<void> {
  try { await lstat(join(dirname(path), 'application.sqlite')); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Restored main created or selected a default application.sqlite');
}
function stopped(native: DatabaseSync) {
  const receipt = assertInstallationAdmission(native, admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE));
  expect(receipt.installationId).toBe(installationId); expect(receipt.checkpointId).toBe('portable-runtime/v28');
  expect(native.prepare('SELECT state FROM system_recovery_maintenance WHERE singleton=1').get()?.state).toBe('open');
  expect(native.prepare('SELECT enforcement,revision FROM collaboration_control WHERE singleton=1').get())
    .toEqual({ enforcement: 'enabled', revision: 2 });
  for (const name of ['file_shadow_runtime_guard', 'file_authority_runtime_guard', 'file_job_runtime_guard', 'system_recovery_runtime'])
    expect(native.prepare(`SELECT enabled FROM ${name}`).get()?.enabled).toBe(0);
  for (const name of ['collaboration_resources', 'collaboration_grants', 'local_storage_profile_bindings', 'system_storage_native_bindings'])
    expect(native.prepare(`SELECT count(*) n FROM ${name}`).get()?.n).toBe(0);
  expect(native.prepare('SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL').get()?.n).toBe(0);
}
beforeAll(() => retainedCanonicalFileCase(async () => {
  path = process.env.CURRENT_V28_POST_RESTORE_DATABASE ?? '';
  principalId = process.env.CURRENT_V28_POST_RESTORE_PRINCIPAL ?? '';
  reportSha256 = process.env.CURRENT_V28_POST_RESTORE_REPORT_SHA256 ?? '';
  distribution = process.env.NODE_OFFLINE_V28_DISTRIBUTION ?? '';
  const parent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT ?? '';
  const rawUid = process.env.NODE_PROTOTYPE_FILESYSTEM_ROOT_OWNER_UID ?? '';
  ensure(isAbsolute(path) && resolve(path) === path && path.startsWith(`${parent}/`) && path === join(dirname(path), 'database.sqlite')
    && /^local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(principalId)
    && /^[0-9a-f]{64}$/.test(reportSha256) && /^(?:0|[1-9][0-9]*)$/.test(rawUid)
    && Number.isSafeInteger(Number(rawUid)) && Number(rawUid) <= 0xffff_ffff
    && isAbsolute(distribution) && resolve(distribution) === distribution);
  rootUid = Number(rawUid);
  ensure(await realpath(path) === path && await realpath(distribution) === distribution);
  const stat = await lstat(path);
  ensure(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.geteuid?.() && (stat.mode & 0o7777) === 0o600);
  for (const directory of [parent, tmpdir()]) {
    const free = statfsSync(directory, { bigint: true }); ensure(free.bavail * free.bsize >= PRE_NATIVE_RESERVE);
  }
  const reportBytes = await readFile(join(dirname(path), 'recovery-report.json'));
  ensure(createHash('sha256').update(reportBytes).digest('hex') === reportSha256);
  const report = canonicalFileObject(JSON.parse(reportBytes.toString('utf8')));
  ensure(report.destinationCheckpoint === 'portable-runtime/v28' && typeof report.destinationInstallationId === 'string'
    && report.executionEnabled === false && report.nativeBindingsRestored === false && report.maintenanceState === 'fenced');
  installationId = report.destinationInstallationId;
  const manifest = await verifyNodeDistribution(distribution, { enforceRuntimeVersion: true });
  expect(manifest.version).toBe(3); expect(manifest.offlineRecoveryCheckpoint.id).toBe('portable-runtime/v28');
  await noDefaultDatabase();
  await withCanonicalFileDatabase(path, async (_owner, lease, native) => lease.withWriter(async () => { stopped(native); }));
}), 20_000);

interface ClosedChild { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
interface MainOwner {
  child?: ChildProcess; constructionFailure?: unknown; originalClose?: Promise<ClosedChild>;
  ready?: Promise<void>; closing?: Promise<ClosedChild>; ended: boolean; stopSent: boolean;
  clients: CanonicalFileFixtureOwner;
}
const mainOwners = new Set<MainOwner>();
afterEach(() => {
  if (mainOwners.size) throw new AggregateError([...mainOwners].map(owner => owner.closing ?? owner.originalClose ?? owner.constructionFailure),
    'Original compiled-main ownership remains unproven');
});
function launch(configuration: string): MainOwner {
  const owner: MainOwner = { ended: false, stopSent: false, clients: { clients: new Set(), quarantined: false } };
  mainOwners.add(owner);
  try {
    owner.child = spawn(process.execPath, [join(distribution, 'server/main.mjs'), '--config', configuration,
      '--runtime-profile', 'v28-metadata', '--filesystem-root-owner-uid', String(rootUid)], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { owner.constructionFailure = error; throw error; }
  const child = owner.child;
  let ready!: () => void, rejectReady!: (error: unknown) => void;
  owner.ready = new Promise<void>((resolveReady, reject) => { ready = resolveReady; rejectReady = reject; });
  void owner.ready.catch(() => undefined);
  owner.originalClose = new Promise<ClosedChild>((done, fail) => {
    let stdout = '', stderr = '', outputBytes = 0, outputFailure: Error | undefined, spawnError: unknown;
    child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
    const capture = (value: string, standardOutput: boolean) => {
      outputBytes += Buffer.byteLength(value);
      if (outputBytes > 16 * 1024) { outputFailure ??= new Error('Compiled-main diagnostic budget exceeded'); rejectReady(outputFailure); return; }
      if (standardOutput) {
        stdout += value;
        if (stdout.includes('Restricted v28-metadata development runtime started.\n')) ready();
      } else stderr += value;
    };
    child.stdout!.on('data', (value: string) => { capture(value, true); });
    child.stderr!.on('data', (value: string) => { capture(value, false); });
    child.once('error', error => { spawnError = error; rejectReady(error); });
    // Only the original close event settles the child/output ownership. No
    // signal, exit-looking flag or startup line substitutes for this ACK.
    child.once('close', (code, signal) => {
      owner.ended = true;
      rejectReady(new Error('Compiled-main closed before startup admission'));
      if (spawnError || outputFailure) fail(spawnError ?? outputFailure);
      else done({ code, signal, stdout, stderr });
    });
  });
  void owner.originalClose.catch(() => undefined); return owner;
}
function closeClient(owner: MainOwner, client: CanonicalFileClientOwner): Promise<void> {
  if (client.firstCleanup) return client.firstCleanup;
  client.firstCleanup = (async () => {
    const response = await client.originalFetch;
    if (client.consumption) await client.consumption;
    else if (response.body) {
      try { client.cancellation = response.body.cancel(); }
      catch (error) { client.cancellation = Promise.reject(error); }
      await client.cancellation;
    }
    owner.clients.clients.delete(client);
  })();
  void client.firstCleanup.catch(() => undefined); return client.firstCleanup;
}
function closeMain(owner: MainOwner): Promise<ClosedChild> {
  if (owner.closing) return owner.closing;
  owner.closing = (async () => {
    // Reuse the existing client's original delivery/consumption/cached-first-
    // cleanup contract. Unproven body ACK remains a parent shutdown barrier.
    const clients = await Promise.allSettled([...owner.clients.clients].map(client => closeClient(owner, client)));
    const failures = clients.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
    if (failures.length) throw new AggregateError(failures, 'Original compiled-main client body cleanup failed');
    ensure(owner.child && owner.originalClose);
    let stopFailed = false, stopFailure: unknown;
    if (!owner.ended) {
      try { owner.stopSent = true; ensure(owner.child.kill('SIGTERM')); }
      catch (error) { stopFailed = true; stopFailure = error; }
    }
    const result = await owner.originalClose;
    if (stopFailed) throw stopFailure;
    ensure(owner.stopSent);
    expect(result.code).toBe(0); expect(result.signal).toBeNull(); expect(result.stderr).toBe('');
    mainOwners.delete(owner); return result;
  })();
  void owner.closing.catch(() => undefined); return owner.closing;
}
async function request(owner: MainOwner, origin: string, pathname: string, method = 'GET', input?: unknown,
  session?: Readonly<{ cookie: string; csrf: string }>) {
  const delivery = await fetchCanonicalFileClient(owner.clients, `${origin}${pathname}`, { method,
    headers: { ...(session ? { cookie: session.cookie } : {}), ...(method === 'GET' ? {} : {
      origin, 'content-type': 'application/json', ...(session ? { 'x-sfw-csrf': session.csrf } : {}),
    }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(5000), redirect: 'manual' });
  const text = await consumeCanonicalFileClient(delivery.client, 'text'); ensure(typeof text === 'string');
  return { status: delivery.response.status, headers: delivery.response.headers, value: text ? JSON.parse(text) as unknown : null };
}

describe('current compiled main on the same genuinely restored and separately released V28 destination', () => {
  it('serves scoped health and readiness for genuine local sessions without granting ordinary accounts domains, then closes before restored writer reacquisition',
    () => retainedCanonicalFileCase(async () => {
      const target = dirname(path), clientDirectory = join(dirname(target), `restored-main-client-${randomUUID()}`);
      await mkdir(clientDirectory, { mode: 0o700 });
      // Genuine stopped identity service, not account/session/member/grant SQL.
      // This newly provisioned enabled account is deliberately not enrolled.
      const ordinaryUsername = `ready-${randomUUID()}`;
      const ordinary = await executeV28OrdinaryAccountOperatorCandidate({ kind: 'provision-account', databasePath: path,
        filesystemRootOwnerUid: rootUid, username: ordinaryUsername }, ORDINARY_PASSWORD);
      expect(ordinary.systemAdministrator).toBe(false);
      expect(v28OrdinaryAccountOperatorProcessState()).toEqual({ activeOperations: 0, quarantinedOperations: 0 });
      const selected = await withCanonicalFileDatabase(path, async (owner, lease, native) => lease.withWriter(async () => {
        stopped(native);
        expect(native.prepare('SELECT count(*) n FROM local_admin_grants WHERE principal_id=?').get(ordinary.principalId)?.n).toBe(0);
        expect(native.prepare('SELECT count(*) n FROM collaboration_identities WHERE subject=?').get(ordinary.principalId)?.n).toBe(0);
        const account = native.prepare('SELECT username,enabled FROM local_accounts WHERE principal_id=?').get(principalId);
        ensure(account?.enabled === 1 && typeof account.username === 'string');
        const username = account.username;
        const origin = await canonicalFilePrivateOrigin(owner);
        return { origin, username };
      })); // Original probe/Native/physical close ACK before compiled startup.
      const configuration = join(dirname(target), `restored-main-config-${randomUUID()}.json`);
      await writeFile(configuration, JSON.stringify({ format: 'node-loopback-restored-v28-v1', databaseFile: 'database.sqlite',
        dataDirectory: target, expectedInstallationId: installationId, publicOrigin: selected.origin, clientDirectory,
        enableLocalFile: false, enableLocalJobs: false }), { flag: 'wx', mode: 0o600 });
      await noDefaultDatabase();
      const owner = launch(configuration);
      let failed = false, failure: unknown, closed!: ClosedChild;
      try {
        await owner.ready;
        expect((await request(owner, selected.origin, '/api/auth/session')).status).toBe(401);
        const health = await request(owner, selected.origin, '/api/health');
        expect(health.status).toBe(200); expect(canonicalFileObject(health.value).ok).toBe(true);
        expect(canonicalFileObject(canonicalFileObject(health.value).capabilities).unavailable).toEqual(expect.arrayContaining([
          'file-bytes-and-file-grants', 'jobs-and-package-import-export', 'provider-egress', 'frontend-static-serving']));
        expect((await request(owner, selected.origin, '/api/ready')).status).toBe(401);
        const login = await request(owner, selected.origin, '/api/auth/login', 'POST', { username: selected.username, password: PASSWORD });
        expect(login.status).toBe(200); expect(login.headers.get('cache-control')).toBe('private, no-store');
        const body = canonicalFileObject(login.value), principal = canonicalFileObject(body.principal);
        expect(principal.id).toBe(principalId); expect(principal.actor).toBe(`local-account:${principalId}`);
        expect(principal.capabilities).toEqual({ systemAdministrator: true, fileEvidenceOperator: false });
        const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]; ensure(typeof cookie === 'string' && cookie.startsWith('sfw_dev_session=') && typeof body.csrf === 'string');
        const session = { cookie, csrf: body.csrf };
        const current = await request(owner, selected.origin, '/api/auth/session', 'GET', undefined, session);
        expect(current.status).toBe(200); expect(canonicalFileObject(canonicalFileObject(current.value).principal).id).toBe(principalId);
        const ready = await request(owner, selected.origin, '/api/ready', 'GET', undefined, session);
        expect(ready.status).toBe(200);
        expect(canonicalFileObject(ready.value)).toMatchObject({ ok: true, scope: 'supported-v28-service', fullReady: false });
        expect(canonicalFileObject(canonicalFileObject(ready.value).capabilities).unavailable).toEqual(
          canonicalFileObject(canonicalFileObject(health.value).capabilities).unavailable);
        expect((await request(owner, selected.origin, '/api/auth/logout', 'POST', undefined, session)).status).toBe(204);
        expect((await request(owner, selected.origin, '/api/auth/session', 'GET', undefined, session)).status).toBe(401);
        expect((await request(owner, selected.origin, '/api/ready', 'GET', undefined, session)).status).toBe(401);
        const ordinaryLogin = await request(owner, selected.origin, '/api/auth/login', 'POST', {
          username: ordinaryUsername, password: ORDINARY_PASSWORD });
        expect(ordinaryLogin.status).toBe(200);
        const ordinaryBody = canonicalFileObject(ordinaryLogin.value);
        expect(canonicalFileObject(ordinaryBody.principal)).toMatchObject({ id: ordinary.principalId,
          capabilities: { systemAdministrator: false, fileEvidenceOperator: false } });
        const ordinaryCookie = ordinaryLogin.headers.get('set-cookie')?.split(';', 1)[0];
        ensure(typeof ordinaryCookie === 'string' && ordinaryCookie.startsWith('sfw_dev_session=') && typeof ordinaryBody.csrf === 'string');
        const ordinarySession = { cookie: ordinaryCookie, csrf: ordinaryBody.csrf };
        const ordinaryReady = await request(owner, selected.origin, '/api/ready', 'GET', undefined, ordinarySession);
        expect(ordinaryReady.status).toBe(200);
        expect(canonicalFileObject(ordinaryReady.value)).toMatchObject({ ok: true, scope: 'supported-v28-service', fullReady: false });
        expect(ordinaryReady.value).toEqual(ready.value);
        // Ready is not a Group membership or named business-resource grant.
        expect((await request(owner, selected.origin, '/api/projects', 'GET', undefined, ordinarySession)).status).toBe(403);
        expect((await request(owner, selected.origin, '/api/auth/logout', 'POST', undefined, ordinarySession)).status).toBe(204);
        await noDefaultDatabase();
      } catch (error) { failed = true; failure = error; }
      try { const first = closeMain(owner); expect(closeMain(owner)).toBe(first); closed = await first; }
      catch (error) { if (failed) throw new AggregateError([failure, error], 'Original compiled-main work and cleanup failed'); throw error; }
      if (failed) throw failure;
      const lines = closed.stdout.trimEnd().split('\n'); expect(lines).toHaveLength(2);
      expect(lines[0]).toBe('Restricted v28-metadata development runtime started.');
      const capabilities = canonicalFileObject(JSON.parse(lines[1]!));
      expect(capabilities.kind).toBe('explicit-v28-development-capabilities/1');
      expect(capabilities.unavailable).toEqual(expect.arrayContaining(['file-bytes-and-file-grants', 'jobs-and-package-import-export',
        'system-backup-and-assisted-recovery', 'provider-egress', 'frontend-static-serving']));
      // New original acquisition of the exact restored filename proves the
      // compiled main released its real writer parents after normal close.
      await withCanonicalFileDatabase(path, async (_owner, lease, native) => lease.withWriter(async () => { stopped(native); }));
      await noDefaultDatabase();
      expect(createHash('sha256').update(await readFile(join(target, 'recovery-report.json'))).digest('hex')).toBe(reportSha256);
    }), 20_000);
});
