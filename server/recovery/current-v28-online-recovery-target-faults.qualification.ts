import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, writeFile, type FileHandle } from 'node:fs/promises';
import { constants, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifyNodeDistribution } from '../../scripts/lib/node-distribution-v28-manifest.mjs';
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource } from '../../scripts/lib/system-backup-node-io.ts';
import { validateV28SystemBackupArchiveCandidate } from '../../shared/contracts/system-backup-v5-archive-admission.ts';
import { stableJson } from '../../shared/domain/content-addressing.ts';
import { checkedSystemRecoveryReceipt, checkedSystemRecoveryJobStatus, checkedSystemRecoveryMaintenanceStatus,
  checkedSystemRecoveryMaintenanceReceipt, type SystemRecoveryMaintenanceStatus } from '../../shared/contracts/system-recovery.ts';
import { loadNodeRuntimeConfiguration } from '../node-runtime-config.ts';
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from '../installation-catalog-v28-candidate.ts';
import { admitInstallationRecoverySource, assertInstallationAdmission } from '../migrations.ts';
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from '../operations/writer-lease.ts';
import { assertSqliteConnectionOwner, type SqliteCapability } from '../sqlite.ts';
import { createPasswordHasher } from '../auth/passwords.ts';
import { hashSessionToken } from '../auth/tokens.ts';
import { CANONICAL_FILE_PASSWORD, CANONICAL_FILE_IDENTITY_POLICY, assertCanonicalFileOwnersReleased, canonicalFileClient,
  canonicalFilePrivateOrigin, listenCanonicalFileApplication, retainedCanonicalFileCase, withCanonicalFileDatabase,
  type CanonicalFileSession } from '../collaboration/current-v28-canonical-comment-file.qualification-support.ts';
import { prepareCurrentV28OnlineRecoverySource, currentV28RecoveryImageRows, currentV28RecoveryTypedRows, CURRENT_V28_RECOVERY_PHYSICAL_TABLES,
  type CurrentV28OnlineRecoverySource } from './current-v28-online-recovery.qualification-support.ts';
import { loginCurrentRecoveryCli, recoveryCliJson, recoveryCliBytes,
  type CurrentRecoveryCliOwner, type CurrentRecoveryCliSession } from './current-v28-recovery-cli.qualification-support.ts';
import { prepareCurrentRecoveryTarget } from './current-v28-recovery-target.qualification-support.ts';
import { holdCurrentRecoveryTargetPayloadAck } from './current-v28-recovery-held-target-ack.qualification-support.ts';
import { createNodeSystemRecoveryV28Application, type NodeSystemRecoveryV28Application } from './node-system-recovery-v28-application.ts';

type Fault = 'F4' | 'F5' | 'F6';
type Client = ReturnType<typeof canonicalFileClient>;
type PreparedTarget = Awaited<ReturnType<typeof prepareCurrentRecoveryTarget>>;
const RESERVE = 603_979_776n;
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
let distribution: string, output: string, manifestSha256: string;
function ensure(value: unknown, reason = 'genuine_target_fault_unavailable'): asserts value {
  if (!value) throw new Error(reason);
}
function object(value: unknown): Record<string, unknown> {
  ensure(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
beforeAll(async () => {
  distribution = process.env.NODE_OFFLINE_V28_DISTRIBUTION ?? '';
  output = process.env.CURRENT_V28_TARGET_FAULT_RECEIPT ?? '';
  const parent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT ?? '';
  ensure(isAbsolute(distribution) && resolve(distribution) === distribution && await realpath(distribution) === distribution
    && isAbsolute(output) && resolve(output) === output && isAbsolute(parent) && resolve(parent) === parent);
  for (const directory of [parent, tmpdir()]) { const free = statfsSync(directory, { bigint: true }); ensure(free.bavail * free.bsize >= RESERVE); }
  const manifest = await verifyNodeDistribution(distribution, { enforceRuntimeVersion: true }); manifestSha256 = manifest.manifestSha256;
  expect(manifest.version).toBe(3); expect(manifest.offlineRecoveryCheckpoint.id).toBe('portable-runtime/v28');
  const inputs = object(JSON.parse(await readFile(join(distribution, 'source-inputs.json'), 'utf8'))).inputs; ensure(Array.isArray(inputs));
  for (const relative of ['server/main.ts', 'server/recovery/node-system-recovery-v28-application.ts',
    'server/recovery/node-v28-target-stages.ts', 'server/recovery/node-v28-recovery-target.ts',
    'worker/recovery/kernel.ts']) {
    const raw = await readFile(new URL('../../' + relative, import.meta.url));
    const selected = inputs.map(object).find(value => value.path === relative); ensure(selected);
    expect(selected.bytes).toBe(raw.byteLength); expect(selected.sha256).toBe(digest(raw));
  }
}, 20_000);

async function fence(owner: CurrentRecoveryCliOwner, origin: string, session: CurrentRecoveryCliSession) {
  const current = checkedSystemRecoveryMaintenanceStatus((await recoveryCliJson(owner, origin,
    '/api/system-recovery/maintenance', 'GET', undefined, session)).value);
  expect(current.state).toBe('open');
  const entering = await recoveryCliJson(owner, origin, '/api/system-recovery/maintenance', 'POST', {
    requestId: randomUUID(), action: 'enter', expectedGeneration: current.generation }, session);
  expect(entering.status).toBe(200); const entered = checkedSystemRecoveryMaintenanceReceipt(entering.value);
  const finalizing = await recoveryCliJson(owner, origin, '/api/system-recovery/maintenance', 'POST', {
    requestId: randomUUID(), action: 'finalize', expectedGeneration: entered.status.generation }, session);
  expect(finalizing.status).toBe(200); expect(checkedSystemRecoveryMaintenanceReceipt(finalizing.value).status.state).toBe('fenced');
}

/** Same original fixture/core/Native/lease/application as the qualified helper;
 * exposes that original writer only for one real account-row fault transaction.
 * It neither opens a second Native owner nor manufactures authentication. */
async function withOriginalDispatcher<T>(source: CurrentV28OnlineRecoverySource, target: PreparedTarget,
  work: (app: NodeSystemRecoveryV28Application, client: Client, native: DatabaseSync,
    lease: LinuxWriterLease, core: SqliteCapability) => Promise<T>): Promise<T> {
  return withCanonicalFileDatabase(source.baseline.path, async (owner, lease, native, core) => {
    const origin = await canonicalFilePrivateOrigin(owner), path = await target.configuration(origin);
    const configuration = loadNodeRuntimeConfiguration(path, { filesystemRootOwnerUid: source.baseline.rootOwnerUid, runtimeProfile: 'v28-recovery' });
    owner.applicationAttempted = true;
    const original = Promise.resolve().then(() => createNodeSystemRecoveryV28Application({ configuration, database: core, nativeDatabase: native,
      writerLease: lease, admission: admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE),
      hasher: createPasswordHasher(), identityPolicy: CANONICAL_FILE_IDENTITY_POLICY, publicOrigin: origin }));
    owner.originalApplication = original; const app = await original; owner.application = app;
    await listenCanonicalFileApplication(owner, origin);
    return work(app, canonicalFileClient(owner, origin), native, lease, core);
  });
}

async function prepared(fault: Fault) {
  const source = await prepareCurrentV28OnlineRecoverySource(), target = await prepareCurrentRecoveryTarget(source);
  const origin = await withCanonicalFileDatabase(source.baseline.path, owner => canonicalFilePrivateOrigin(owner));
  assertCanonicalFileOwnersReleased();
  const backupId = await target.withCli(distribution, origin, async owner => {
    const session = await loginCurrentRecoveryCli(owner, origin, 'operator', CANONICAL_FILE_PASSWORD);
    expect((await recoveryCliJson(owner, origin, '/api/system-recovery/executor', 'POST', { enabled: true }, session)).status).toBe(200);
    await fence(owner, origin, session);
    const accepted = await recoveryCliJson(owner, origin, '/api/system-recovery/jobs', 'POST', { requestId: randomUUID(), kind: 'backup', mode: 'planned' }, session);
    expect(accepted.status).toBe(202); return checkedSystemRecoveryReceipt(accepted.value).job.id;
  });
  await target.withDispatcher(async app => {
    for (const outcome of ['snapshot', 'source_measured', 'measured', 'completed'])
      expect(await app.dispatchRecoveryJobsOnce()).toEqual({ jobId: backupId, outcome });
  });
  const downloaded = await target.withCli(distribution, origin, async owner => {
    const session = await loginCurrentRecoveryCli(owner, origin, 'operator', CANONICAL_FILE_PASSWORD);
    const state = checkedSystemRecoveryJobStatus((await recoveryCliJson(owner, origin, `/api/system-recovery/jobs/${backupId}`, 'GET', undefined, session)).value);
    ensure(state.output?.available); const reply = await recoveryCliBytes(owner, origin, `/api/system-recovery/jobs/${backupId}/download`, 'GET', undefined, session);
    expect(reply.status).toBe(200); expect(reply.bytes.byteLength).toBe(state.output.byteSize); expect(digest(reply.bytes)).toBe(state.output.sha256);
    return { bytes: reply.bytes, sha256: state.output.sha256 };
  });
  const archive = join(source.baseline.root, 'original-fault-source-v5.zip');
  await writeFile(archive, downloaded.bytes, { flag: 'wx', mode: 0o600 });
  const admitted = await validateV28SystemBackupArchiveCandidate(await nodeRecoveryArchiveSource(archive), {
    ...NODE_RECOVERY_ARCHIVE_OPTIONS, expectedSha256: downloaded.sha256 });
  expect(admitted.manifest.completeness).toBe('complete'); expect(admitted.manifest.files).toHaveLength(1);
  expect(admitted.manifest.files[0]).toMatchObject({ outcome: 'packaged', byteSize: source.payloadBytes, sha256: source.payloadSha256 });
  const uploadId = await target.withCli(distribution, origin, async owner => {
    const session = await loginCurrentRecoveryCli(owner, origin, 'operator', CANONICAL_FILE_PASSWORD);
    const accepted = await recoveryCliJson(owner, origin, '/api/system-recovery/uploads', 'POST', {
      requestId: randomUUID(), byteSize: downloaded.bytes.byteLength, sha256: downloaded.sha256 }, session);
    expect(accepted.status).toBe(202); const id = checkedSystemRecoveryReceipt(accepted.value).job.id;
    const reply = await recoveryCliBytes(owner, origin, `/api/system-recovery/jobs/${id}/upload`, 'PUT', downloaded.bytes, session);
    expect(reply.status).toBe(200); expect(checkedSystemRecoveryJobStatus(JSON.parse(Buffer.from(reply.bytes).toString('utf8'))))
      .toMatchObject({ kind: 'upload', state: 'queued', phase: 'validate' }); return id;
  });
  await target.withDispatcher(async app => { expect(await app.dispatchRecoveryJobsOnce()).toEqual({ jobId: uploadId, outcome: 'preview' }); });
  const recoveryId = await target.withCli(distribution, origin, async owner => {
    const session = await loginCurrentRecoveryCli(owner, origin, 'operator', CANONICAL_FILE_PASSWORD);
    const reply = await recoveryCliJson(owner, origin, '/api/system-recovery/recoveries', 'POST', {
      requestId: randomUUID(), uploadJobId: uploadId, expectedTargetId: target.descriptor.targetId, mapping: [],
      mode: fault === 'F6' ? 'planned' : 'historical', acknowledgeLaterChanges: fault !== 'F6', acknowledgePartial: false }, session);
    expect(reply.status).toBe(202); return checkedSystemRecoveryReceipt(reply.value).job.id;
  });
  return { source, target, origin, backupId, uploadId, recoveryId, archive, archiveSha256: downloaded.sha256, admitted };
}

async function cleanupRefused(client: Client, session: CanonicalFileSession, uploadId: string, recoveryId: string) {
  for (const id of [uploadId, recoveryId])
    expect((await client.request(`/api/system-recovery/jobs/${id}/control`, 'POST', { action: 'cleanup' }, session)).status).toBe(409);
}

/** Fault, not provisioning: mutate ONLY enabled on this already installed,
 * genuinely logged-in administrator. The original core BEGIN rechecks every
 * selected installation/account/credential/session fact before the one update.
 * No verifier, credential revision, grant, history or session row is seeded. */
async function revokeExistingAccount(source: CurrentV28OnlineRecoverySource, session: CanonicalFileSession,
  native: DatabaseSync, lease: LinuxWriterLease, core: SqliteCapability) {
  const account = native.prepare('SELECT * FROM local_accounts WHERE principal_id=?').get(source.baseline.principalId); ensure(account);
  expect(account.username).toBe('operator'); expect(account.enabled).toBe(1);
  ensure(account.username === 'operator' && typeof account.password_verifier === 'string'
    && typeof account.credential_revision === 'number' && Number.isSafeInteger(account.credential_revision));
  const token = session.cookie.slice(session.cookie.indexOf('=') + 1), tokenHash = hashSessionToken(token);
  const grants = native.prepare('SELECT * FROM local_admin_grants ORDER BY principal_id').all();
  const history = native.prepare('SELECT * FROM local_auth_events ORDER BY sequence').all();
  await lease.withWriter(async () => {
    assertLinuxWriterLeaseBinding(lease, core, native); assertSqliteConnectionOwner(core, native);
    const installation = assertInstallationAdmission(native, admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE));
    expect(installation.installationId).toBe(source.baseline.installationId);
    const at = Date.now();
    const results = await core.batch([
      core.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM node_installation n JOIN local_identity_installation i ON i.singleton=n.singleton
        JOIN local_accounts a ON a.principal_id=i.bootstrap_principal_id JOIN local_admin_grants g ON g.principal_id=a.principal_id
        JOIN local_sessions s ON s.principal_id=a.principal_id
        WHERE n.singleton=1 AND n.installation_id=? AND n.catalog_id=? AND n.schema_checkpoint=? AND n.schema_sha256=? AND n.created_at=?
          AND i.catalog_id='local-identity-v1' AND a.principal_id=? AND a.username='operator' AND a.enabled=1
          AND a.credential_revision=? AND a.password_verifier=? AND s.token_hash=? AND s.revoked_at IS NULL
          AND s.credential_revision=a.credential_revision AND ?>=s.last_seen_at AND ?<s.absolute_expires_at
          AND ?<s.last_seen_at+?) THEN 1 ELSE json('Original genuine account revocation fault selection changed') END`)
        .bind(source.baseline.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256, installation.createdAt,
          source.baseline.principalId, account.credential_revision, account.password_verifier,
          tokenHash, at, at, at, CANONICAL_FILE_IDENTITY_POLICY.idleLifetimeMs),
      core.prepare('UPDATE local_accounts SET enabled=0 WHERE principal_id=? AND username=? AND enabled=1 AND credential_revision=? AND password_verifier=?')
        .bind(source.baseline.principalId, account.username, account.credential_revision, account.password_verifier),
    ]);
    expect(results[1]?.meta.directChanges).toBe(1); expect(native.isTransaction).toBe(false);
    assertLinuxWriterLeaseBinding(lease, core, native);
  });
  expect(native.prepare('SELECT * FROM local_accounts WHERE principal_id=?').get(source.baseline.principalId)).toEqual({ ...account, enabled: 0 });
  expect(native.prepare('SELECT * FROM local_admin_grants ORDER BY principal_id').all()).toEqual(grants);
  expect(native.prepare('SELECT * FROM local_auth_events ORDER BY sequence').all()).toEqual(history);
  return { account, grants, history };
}

async function replaceWindow(client: Client, session: CanonicalFileSession, frozen: SystemRecoveryMaintenanceStatus) {
  const released = await client.request('/api/system-recovery/maintenance', 'POST', {
    requestId: randomUUID(), action: 'release', expectedGeneration: frozen.generation }, session);
  expect(released.status).toBe(200); const open = checkedSystemRecoveryMaintenanceReceipt(released.value).status; expect(open.state).toBe('open');
  const entered = await client.request('/api/system-recovery/maintenance', 'POST', {
    requestId: randomUUID(), action: 'enter', expectedGeneration: open.generation }, session);
  expect(entered.status).toBe(200); const draining = checkedSystemRecoveryMaintenanceReceipt(entered.value).status;
  const finalized = await client.request('/api/system-recovery/maintenance', 'POST', {
    requestId: randomUUID(), action: 'finalize', expectedGeneration: draining.generation }, session);
  expect(finalized.status).toBe(200); const replacement = checkedSystemRecoveryMaintenanceReceipt(finalized.value).status;
  expect(replacement.state).toBe('fenced'); expect(replacement.generation).toBeGreaterThan(frozen.generation);
  expect(replacement.token).not.toBe(frozen.token); expect(replacement.checkpoint).toBeNull(); expect(replacement.backupJobId).toBeNull();
  return replacement;
}

interface RetainedReadonlyInspection {
  originalOpen?: Promise<FileHandle>; handle?: FileHandle; native?: DatabaseSync;
  nativeAttempted: boolean; constructorFailed: boolean; failure?: unknown; closing?: Promise<void>;
}
const readonlyInspections = new Set<RetainedReadonlyInspection>();
afterEach(() => {
  if (readonlyInspections.size) throw new AggregateError([...readonlyInspections].map(owner => owner.closing ?? owner.failure ?? owner.originalOpen),
    'Original retained target read-only inspection ownership remains unproven');
});
async function absent(path: string) {
  try { await lstat(path); return false; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return true; throw error; }
}
/** Forensic read of the genuine renamed closed target, after every production
 * original Native/provider/source close. A read-only handle grants no target
 * claim or writer authority; no renamed/fabricated writer sentinel is used.
 * Refuse a detached WAL rather than ignore it with an immutable URI. */
async function inspectClosedRetainedInode(path: string, originalPath: string, expectedSha256: string,
  work: (native: DatabaseSync) => void): Promise<void> {
  assertCanonicalFileOwnersReleased();
  ensure(isAbsolute(path) && resolve(path) === path && await realpath(path) === path && /^[a-f0-9]{64}$/.test(expectedSha256));
  const before = await lstat(path, { bigint: true });
  ensure(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.uid === BigInt(process.geteuid!())
    && (before.mode & 0o7777n) === 0o600n && before.size > 0n && before.size <= 16n * 1024n * 1024n);
  const identity = (stat: typeof before) => [stat.dev,stat.ino,stat.uid,stat.gid,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
  // Files-stage target Native owners already closed before the original inode
  // was renamed. A WAL under either name would make a bare-main read incomplete.
  for (const named of [path, originalPath]) for (const suffix of ['-wal','-shm']) ensure(await absent(named + suffix), 'retained_target_wal_requires_original_owner_proof');
  const owner: RetainedReadonlyInspection = { nativeAttempted: false, constructorFailed: false }; readonlyInspections.add(owner);
  let failed = false, failure: unknown;
  function close(): Promise<void> {
    if (owner.closing) return owner.closing;
    owner.closing = Promise.resolve().then(async () => {
      if (owner.nativeAttempted && !owner.native) throw owner.constructorFailed ? owner.failure : new Error('Original readonly Native constructor has no close owner');
      if (owner.native) { owner.native.close(); ensure(!owner.native.isOpen, 'original_retained_readonly_native_close'); }
      if (!owner.handle) throw owner.failure ?? new Error('Original retained FD has no close owner');
      await owner.handle.close();
      ensure(await realpath(path) === path && identity(await lstat(path, { bigint: true })) === identity(before), 'retained_target_physical_identity_changed');
      expect(digest(await readFile(path))).toBe(expectedSha256);
      for (const named of [path, originalPath]) for (const suffix of ['-wal','-shm']) ensure(await absent(named + suffix), 'retained_target_sidecar_close_unproven');
      readonlyInspections.delete(owner);
    });
    void owner.closing.catch(() => undefined); return owner.closing;
  }
  try {
    owner.originalOpen = open(path, constants.O_RDONLY | constants.O_NOFOLLOW); void owner.originalOpen.catch(() => undefined);
    owner.handle = await owner.originalOpen;
    ensure(identity(await owner.handle.stat({ bigint: true })) === identity(before), 'retained_target_original_fd_identity');
    expect(digest(await owner.handle.readFile())).toBe(expectedSha256);
    ensure(identity(await lstat(path, { bigint: true })) === identity(before) && await realpath(path) === path);
    owner.nativeAttempted = true;
    try { owner.native = new DatabaseSync(path, { readOnly: true, allowExtension: false, enableForeignKeyConstraints: true }); }
    catch (error) { owner.constructorFailed = true; owner.failure = error; throw error; }
    const native = owner.native; native.exec('PRAGMA query_only=ON');
    expect(native.prepare('PRAGMA query_only').get()?.query_only).toBe(1);
    const main = native.prepare('PRAGMA database_list').all().filter(row => row.name === 'main');
    expect(main).toHaveLength(1); expect(main[0]?.file).toBe(path);
    ensure(identity(await owner.handle.stat({ bigint: true })) === identity(before) && identity(await lstat(path, { bigint: true })) === identity(before));
    work(native);
    expect(native.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(native.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
  } catch (error) { failed = true; failure = error; owner.failure ??= error; }
  try { const first = close(); expect(close()).toBe(first); await first; }
  catch (cleanup) { throw failed ? new AggregateError([failure, cleanup], 'Original retained target inspection and first close failed') : cleanup; }
  if (failed) throw failure;
}

async function run(fault: Fault) {
  const data = await prepared(fault), { source, target, recoveryId, uploadId } = data;
  let retainedDatabase = join(target.destination, 'database.sqlite'), retainedDatabaseSha256: string | undefined;
  let expectedState: 'write_started' | 'unknown' = 'unknown';
  let beforeFile: Record<string, unknown> | undefined, afterFile: Record<string, unknown> | undefined;
  let replacedWindow: SystemRecoveryMaintenanceStatus | undefined, frozenWindow: SystemRecoveryMaintenanceStatus | undefined;
  let accountFault: Awaited<ReturnType<typeof revokeExistingAccount>> | undefined;
  await withOriginalDispatcher(source, target, async (app, client, native, lease, core) => {
    let phase = 'claim';
    for (let count = 0; phase !== 'files'; count++) {
      ensure(count < 64); const result = await app.dispatchRecoveryJobsOnce(); expect(result.jobId).toBe(recoveryId); expect(result.outcome).not.toBe('paused');
      const value = native.prepare('SELECT phase FROM system_recovery_jobs WHERE id=?').get(recoveryId)?.phase; ensure(typeof value === 'string'); phase = value;
    }
    const session = await client.login('operator');
    const delivered = await client.request('/api/auth/session', 'GET', undefined, session); expect(delivered.status).toBe(200);
    expect(object(object(delivered.value).principal)).toMatchObject({ id: source.baseline.principalId, actor: source.baseline.operatorActor,
      capabilities: { systemAdministrator: true } });
    const hold = await holdCurrentRecoveryTargetPayloadAck(target.destination), original = app.dispatchRecoveryJobsOnce();
    void original.catch(() => undefined); let failed = false, failure: unknown;
    try {
      await Promise.race([hold.reached, original.then(() => { throw new Error('Original target payload ACK was not held'); })]);
      expect(hold.selectedCalls()).toBe(1);
      beforeFile = native.prepare('SELECT * FROM system_recovery_target_files WHERE job_id=?').get(recoveryId); ensure(beforeFile);
      expect(beforeFile.state).toBe('write_started');
      const beforeClaim = native.prepare('SELECT * FROM system_recovery_target_claim WHERE job_id=?').get(recoveryId); ensure(beforeClaim);
      expect(native.prepare("SELECT json_extract(cursor_json,'$.pending') pending FROM system_recovery_target_claim WHERE job_id=?").get(recoveryId)?.pending).toBe(1);
      await cleanupRefused(client, session, uploadId, recoveryId);
      frozenWindow = checkedSystemRecoveryMaintenanceStatus((await client.request('/api/system-recovery/maintenance', 'GET', undefined, session)).value);
      expect(frozenWindow.state).toBe('fenced'); expect(frozenWindow.backupJobId).toBe(data.backupId); ensure(frozenWindow.checkpoint);
      if (fault === 'F4') {
        accountFault = await revokeExistingAccount(source, session, native, lease, core); expectedState = 'write_started';
        expect((await client.request('/api/auth/session', 'GET', undefined, session)).status).toBe(401);
        expect((await client.request(`/api/system-recovery/jobs/${uploadId}/control`, 'POST', { action: 'cleanup' }, session)).status).toBe(401);
      } else if (fault === 'F5') {
        const originalPath = retainedDatabase, before = await lstat(originalPath);
        ensure(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
        retainedDatabaseSha256 = digest(await readFile(originalPath)); retainedDatabase = originalPath + '.retained-original-inode';
        await rename(originalPath, retainedDatabase); await writeFile(originalPath, new Uint8Array(), { flag: 'wx', mode: 0o600 });
        const changed = await lstat(originalPath), retained = await lstat(retainedDatabase);
        expect(retained.dev).toBe(before.dev); expect(retained.ino).toBe(before.ino);
        expect([changed.dev, changed.ino]).not.toEqual([before.dev, before.ino]); expect(changed.size).toBe(0);
        expect(digest(await readFile(retainedDatabase))).toBe(retainedDatabaseSha256);
      } else {
        const planned = object(JSON.parse(String(native.prepare('SELECT checkpoint_json FROM system_recovery_jobs WHERE id=?').get(recoveryId)?.checkpoint_json))).plannedSourceWindow;
        expect(planned).toEqual({ generation: frozenWindow.generation, token: frozenWindow.token, backupJobId: frozenWindow.backupJobId, checkpoint: frozenWindow.checkpoint });
        replacedWindow = await replaceWindow(client, session, frozenWindow);
      }
      // The first real fsync has already committed. Only its positive ACK is
      // withheld; releasing it cannot make stale authority/window/inode current.
      const firstFinish = hold.releaseAndRestore(); expect(hold.releaseAndRestore()).toBe(firstFinish); await firstFinish;
      expect(await original).toEqual({ jobId: recoveryId, outcome: 'paused' });
      afterFile = native.prepare('SELECT * FROM system_recovery_target_files WHERE job_id=?').get(recoveryId); ensure(afterFile);
      expect(afterFile).toEqual({ ...beforeFile, state: expectedState });
      expect(native.prepare('SELECT * FROM system_recovery_target_claim WHERE job_id=?').get(recoveryId)).toEqual(beforeClaim);
      expect(native.prepare('SELECT state,phase,result_json FROM system_recovery_jobs WHERE id=?').get(recoveryId))
        .toEqual({ state: 'paused', phase: 'files', result_json: null });
      expect(native.prepare("SELECT count(*) n FROM system_recovery_target_files WHERE job_id=? AND state IN('verified','published')").get(recoveryId)?.n).toBe(0);
      expect(await app.dispatchRecoveryJobsOnce()).toEqual({ jobId: null, outcome: 'idle' });
      expect(native.prepare('SELECT * FROM system_recovery_target_files WHERE job_id=?').get(recoveryId)).toEqual(afterFile);
      expect(hold.selectedCalls()).toBe(1);
      if (fault !== 'F4') await cleanupRefused(client, session, uploadId, recoveryId);
    } catch (error) { failed = true; failure = error; }
    try { await hold.releaseAndRestore(); } catch (cleanup) { throw failed ? new AggregateError([failure, cleanup], 'Original fault and first ACK hook close failed') : cleanup; }
    // Join the one original dispatch even after an assertion/fault failed.
    try { await original; } catch (cleanup) { throw failed ? new AggregateError([failure, cleanup], 'Original fault and dispatch failed') : cleanup; }
    if (failed) throw failure;
  });
  assertCanonicalFileOwnersReleased();
  if (fault !== 'F4') await target.withCli(distribution, data.origin, async owner => {
    const session = await loginCurrentRecoveryCli(owner, data.origin, 'operator', CANONICAL_FILE_PASSWORD);
    const state = checkedSystemRecoveryJobStatus((await recoveryCliJson(owner, data.origin, `/api/system-recovery/jobs/${recoveryId}`, 'GET', undefined, session)).value);
    expect(state).toMatchObject({ kind: 'recovery', state: 'paused', phase: 'files', result: null });
    for (const id of [uploadId, recoveryId]) expect((await recoveryCliJson(owner, data.origin,
      `/api/system-recovery/jobs/${id}/control`, 'POST', { action: 'cleanup' }, session)).status).toBe(409);
    expect((await recoveryCliJson(owner, data.origin, '/api/system-recovery/executor', 'POST', { enabled: false }, session)).status).toBe(200);
  });
  await withCanonicalFileDatabase(source.baseline.path, async (_owner, lease, native) => lease.withWriter(async () => {
    expect(native.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(native.prepare('SELECT * FROM system_recovery_target_files WHERE job_id=?').get(recoveryId)).toEqual(afterFile);
    expect(native.prepare("SELECT json_extract(cursor_json,'$.pending') pending FROM system_recovery_target_claim WHERE job_id=?").get(recoveryId)?.pending).toBe(1);
    expect(native.prepare('SELECT result_json FROM system_recovery_jobs WHERE id=?').get(recoveryId)?.result_json).toBeNull();
    expect(native.prepare('SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL').get()?.n).toBe(0);
    expect(currentV28RecoveryTypedRows(native)).toEqual(source.expectedTypedSource);
    expect(currentV28RecoveryTypedRows(native, CURRENT_V28_RECOVERY_PHYSICAL_TABLES)).toEqual(source.expectedTypedPhysicalBindings);
    if (fault === 'F4') {
      ensure(accountFault); expect(native.prepare('SELECT * FROM local_accounts WHERE principal_id=?').get(source.baseline.principalId))
        .toEqual({ ...accountFault.account, enabled: 0 });
      expect(native.prepare('SELECT * FROM local_admin_grants ORDER BY principal_id').all()).toEqual(accountFault.grants);
      expect(native.prepare('SELECT * FROM local_auth_events ORDER BY sequence').all()).toEqual(accountFault.history);
    }
    if (fault === 'F6') { ensure(replacedWindow); expect(native.prepare('SELECT state,generation,token,checkpoint_sha256,backup_job_id FROM system_recovery_maintenance WHERE singleton=1').get())
      .toEqual({ state: 'fenced', generation: replacedWindow.generation, token: replacedWindow.token, checkpoint_sha256: null, backup_job_id: null }); }
  }));
  if (fault === 'F5') { ensure(retainedDatabaseSha256); expect(digest(await readFile(retainedDatabase))).toBe(retainedDatabaseSha256);
    expect((await lstat(join(target.destination, 'database.sqlite'))).size).toBe(0); }
  const inspectInertRows = (native: DatabaseSync) => {
    for (const name of ['file_shadow_runtime_guard', 'file_authority_runtime_guard', 'file_job_runtime_guard', 'system_recovery_runtime'])
      expect(native.prepare(`SELECT enabled FROM ${name} WHERE singleton=1`).get()?.enabled).toBe(0);
    for (const name of ['local_storage_profile_bindings', 'system_storage_native_bindings'])
      expect(native.prepare(`SELECT count(*) n FROM ${name}`).get()?.n).toBe(0);
    // Frozen catalog: activation rows are protected source history, whereas
    // installation bindings and runtime authority remain absent/off. Compare
    // every typed cell of the original WITHOUT ROWID image; do not clear or
    // synthesize history to make an inert destination appear empty.
    const activationHistory = data.admitted.records.image.tables.local_storage_profile_activations; ensure(activationHistory);
    expect(activationHistory.rows.every(row => row.rowid === null)).toBe(true);
    expect(currentV28RecoveryTypedRows(native, ['local_storage_profile_activations']).local_storage_profile_activations)
      .toEqual(currentV28RecoveryImageRows(activationHistory));
  };
  if (fault === 'F5') {
    ensure(retainedDatabaseSha256);
    await inspectClosedRetainedInode(retainedDatabase, join(target.destination, 'database.sqlite'), retainedDatabaseSha256, inspectInertRows);
  } else await withCanonicalFileDatabase(retainedDatabase, async (_owner, lease, native) => lease.withWriter(() => inspectInertRows(native)));
  assertCanonicalFileOwnersReleased();
  if (fault === 'F5') { ensure(retainedDatabaseSha256); expect(digest(await readFile(retainedDatabase))).toBe(retainedDatabaseSha256); }
  const payload = await readFile(join(target.destination, 'files/b_0000'));
  expect(new Uint8Array(payload)).toEqual(source.bytes); expect(digest(payload)).toBe(source.payloadSha256);
  expect(digest(await readFile(data.archive))).toBe(data.archiveSha256);
  expect(digest(await readFile(join(distribution, 'manifest.json')))).toBe(manifestSha256);
  await writeFile(output + '.' + fault + '.json', stableJson({ schema: 'current-node-v28-original-target-late-ack-fault/1', fault,
    distributionManifestSha256: manifestSha256, sourceInstallationId: source.baseline.installationId, targetId: target.descriptor.targetId,
    uploadId, recoveryId, archiveSha256: data.archiveSha256, actualPayloadBytes: source.payloadBytes, actualPayloadSha256: source.payloadSha256,
    expectedRetainedState: expectedState, frozenWindow, replacedWindow: replacedWindow ?? null,
    realOriginalPositiveDirectoryAck: true, originalDispatchAndFirstOwnerClosesAcknowledged: true, originalPendingIntentRetained: true,
    noVerifiedOrPublishedTargetFile: true, noCursorAdvance: true, noAutomaticReplay: true, noReadyOrHandoff: true,
    sourceCanonicalAndPhysicalBindingsUnchanged: true, noDestinationBindingsOrActivation: true,
    accountEnabledOnlyFault: fault === 'F4', revokedSessionDenied: fault === 'F4', cleanup409BeforeFault: true,
    cleanup409AfterCloseAndRestart: fault !== 'F4', retainedOriginalDatabaseInodeAndBytes: fault === 'F5',
    plannedWindowReplacedThroughOriginalHttp: fault === 'F6', rawBusinessOrIdentitySeed: false,
    fakePermission: false, fakeClock: false, fullApplicationRecoveryQualified: false }), { flag: 'wx', mode: 0o600 });
}

describe('current genuine target refuses late ACK under actual revoked authority, inode and planned window', () => {
  it('F4 retains the original unresolved target intent after real current administrator account revocation without rewriting history or permission callbacks',
    () => retainedCanonicalFileCase(() => run('F4')), 90_000);
  it('F5 retains unknown target bytes after the original database inode is replaced and refuses cleanup or automatic replay across original close and restart',
    () => retainedCanonicalFileCase(() => run('F5')), 90_000);
  it('F6 refuses late planned target publication after genuine release and a replacement generation token and checkpoint window while retaining original unknown bytes',
    () => retainedCanonicalFileCase(() => run('F6')), 90_000);
});
