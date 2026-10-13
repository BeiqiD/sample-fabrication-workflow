import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, writeFile } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { verifyNodeDistribution } from '../../scripts/lib/node-distribution-v28-manifest.mjs';
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource } from '../../scripts/lib/system-backup-node-io.ts';
import { validateV28SystemBackupArchiveCandidate } from '../../shared/contracts/system-backup-v5-archive-admission.ts';
import { checkedSystemRecoveryCapabilities, checkedSystemRecoveryReceipt, checkedSystemRecoveryJobStatus,
  checkedSystemRecoveryPreview, checkedSystemRecoveryMaintenanceStatus, checkedSystemRecoveryMaintenanceReceipt } from '../../shared/contracts/system-recovery.ts';
import { assertNodeRuntimeConfiguration, loadNodeRuntimeConfiguration } from '../node-runtime-config.ts';
import { createPasswordHasher } from '../auth/passwords.ts';
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from '../installation-catalog-v28-candidate.ts';
import { admitInstallationRecoverySource } from '../migrations.ts';
import { CANONICAL_FILE_PASSWORD, CANONICAL_FILE_IDENTITY_POLICY, assertCanonicalFileOwnersReleased,
  canonicalFileClient, canonicalFilePrivateOrigin, listenCanonicalFileApplication,
  retainedCanonicalFileCase, withCanonicalFileDatabase } from '../collaboration/current-v28-canonical-comment-file.qualification-support.ts';
import { createNodeSystemRecoveryV28Application, type NodeSystemRecoveryV28Application } from './node-system-recovery-v28-application.ts';
import { prepareCurrentV28OnlineRecoverySource, assertCurrentV28OnlineRecoverySourceFenced,
  currentV28RecoveryImageRows, currentV28RecoveryTypedRows, CURRENT_V28_RECOVERY_FILE_TABLES,
  CURRENT_V28_RECOVERY_TEMPLATE_TABLES, CURRENT_V28_RECOVERY_PHYSICAL_TABLES,
  type CurrentV28OnlineRecoverySource } from './current-v28-online-recovery.qualification-support.ts';
import { launchCurrentRecoveryCli, closeCurrentRecoveryCli, loginCurrentRecoveryCli, recoveryCliJson,
  recoveryCliBytes, runCurrentRecoveryCliRefusal, type CurrentRecoveryCliOwner } from './current-v28-recovery-cli.qualification-support.ts';
import { holdCurrentRecoveryPublicationAck } from './current-v28-recovery-held-publication-ack.qualification-support.ts';

const RESERVE = 603_979_776n;
let distribution: string, output: string;
function ensure(value: unknown): asserts value { if (!value) throw new Error('Current genuine Recovery-only qualification is unavailable'); }
beforeAll(async () => {
  distribution = process.env.NODE_OFFLINE_V28_DISTRIBUTION ?? '';
  output = process.env.CURRENT_V28_ONLINE_RECOVERY_RECEIPT ?? '';
  const parent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT ?? '';
  ensure(isAbsolute(distribution) && resolve(distribution) === distribution && await realpath(distribution) === distribution
    && isAbsolute(output) && resolve(output) === output && isAbsolute(parent) && resolve(parent) === parent);
  for (const directory of [parent, tmpdir()]) {
    const free = statfsSync(directory, { bigint: true }); ensure(free.bavail * free.bsize >= RESERVE);
  }
  const manifest = await verifyNodeDistribution(distribution, { enforceRuntimeVersion: true });
  expect(manifest.version).toBe(3); expect(manifest.offlineRecoveryCheckpoint.id).toBe('portable-runtime/v28');
  expect(manifest.offlineRecoveryCheckpoint.archiveFormat).toBe('v5');
}, 20_000);
async function origin(source: CurrentV28OnlineRecoverySource): Promise<string> {
  return withCanonicalFileDatabase(source.baseline.path, owner => canonicalFilePrivateOrigin(owner));
}
async function withCli<T>(source: CurrentV28OnlineRecoverySource, publicOrigin: string,
  work: (owner: CurrentRecoveryCliOwner) => Promise<T>): Promise<T> {
  const path = await source.writeRecoveryConfiguration(publicOrigin), owner = launchCurrentRecoveryCli(distribution, path, source.baseline.rootOwnerUid);
  let failed = false, failure: unknown, result!: T;
  try { await owner.ready; result = await work(owner); } catch (error) { failed = true; failure = error; }
  try { await closeCurrentRecoveryCli(owner); } catch (cleanup) {
    throw failed ? new AggregateError([failure, cleanup], 'Original Recovery CLI action and first close failed') : cleanup;
  }
  if (failed) throw failure;
  return result;
}
async function withTrustedDispatcher<T>(source: CurrentV28OnlineRecoverySource,
  work: (app: NodeSystemRecoveryV28Application, client: ReturnType<typeof canonicalFileClient>,
    native: import('node:sqlite').DatabaseSync) => Promise<T>): Promise<T> {
  return withCanonicalFileDatabase(source.baseline.path, async (owner, lease, native, core) => {
    assertCurrentV28OnlineRecoverySourceFenced(native);
    const publicOrigin = await canonicalFilePrivateOrigin(owner), configuration = await source.loadRecoveryConfiguration(publicOrigin);
    owner.applicationAttempted = true;
    const original = Promise.resolve().then(() => createNodeSystemRecoveryV28Application({ configuration, database: core,
      nativeDatabase: native, writerLease: lease, admission: admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE),
      hasher: createPasswordHasher(), identityPolicy: CANONICAL_FILE_IDENTITY_POLICY, publicOrigin }));
    owner.originalApplication = original;
    const app = await original; owner.application = app;
    await listenCanonicalFileApplication(owner, publicOrigin);
    return work(app, canonicalFileClient(owner, publicOrigin), native);
  });
}
async function untilOriginalAcknowledged(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) { ensure(Date.now() < deadline); await new Promise<void>(done => setTimeout(done, 10)); }
}

// This NEW case has its own 120s budget because it waits for the unchanged real
// 60s kernel deadline. Existing 20s cases/configurations stay unchanged. Fixed
// main owns public HTTP; a separately closed fresh original native host invokes
// the trusted one-shot dispatcher. This case does not qualify 120s cadence,
// same-app business writer drain, fresh-target restore or automatic activation.
describe('current real one-File Node V28 Recovery-only CLI and shared kernel', () => {
  it('creates an authenticated source fence, retains an unknown original publication, completes strict nonempty V5 and validates its public reupload without a target',
    () => retainedCanonicalFileCase(async () => {
      const source = await prepareCurrentV28OnlineRecoverySource(), publicOrigin = await origin(source);
      const absentPath = await source.writeRecoveryConfiguration(publicOrigin, false);
      const absent = assertNodeRuntimeConfiguration(loadNodeRuntimeConfiguration(absentPath, {
        filesystemRootOwnerUid: source.baseline.rootOwnerUid, runtimeProfile: 'v28-recovery' }));
      expect(absent.enableLocalRecovery).toBe(false); expect(absent.recoveryArtifacts).toBeUndefined();
      const refused = await runCurrentRecoveryCliRefusal(distribution, absentPath, source.baseline.rootOwnerUid);
      expect(refused.code).toBe(1); expect(refused.signal).toBeNull(); expect(refused.stdout).toBe('');
      expect(refused.stderr).toBe('Local development runtime unavailable.\n');
      await withCanonicalFileDatabase(source.baseline.path, async (_owner, lease, native) => lease.withWriter(async () => {
        expect(native.prepare('SELECT enabled FROM file_authority_runtime_guard WHERE singleton=1').get()?.enabled).toBe(1);
        expect(native.prepare('SELECT state FROM system_recovery_maintenance WHERE singleton=1').get()?.state).toBe('open');
        expect(native.prepare('SELECT enabled FROM system_recovery_runtime WHERE singleton=1').get()?.enabled).toBe(0);
      }));
      const backupInput = { requestId: randomUUID(), kind: 'backup', mode: 'planned' } as const;
      const backupId = await withCli(source, publicOrigin, async owner => {
        const session = await loginCurrentRecoveryCli(owner, publicOrigin, 'operator', CANONICAL_FILE_PASSWORD);
        expect(session.actor).toBe(source.baseline.operatorActor); expect(session.systemAdministrator).toBe(true);
        const health = await recoveryCliJson(owner, publicOrigin, '/api/health', 'GET');
        expect(health.status).toBe(200); expect(health.value).toMatchObject({ ok: true, capabilities: {
          kind: 'node-v28-recovery-only/1', maintenance: 'explicit-source-control', sourceBusinessWriters: false, targetRecovery: false } });
        const first = await recoveryCliJson(owner, publicOrigin, '/api/system-recovery/capabilities', 'GET', undefined, session);
        expect(first.status).toBe(200); expect(checkedSystemRecoveryCapabilities(first.value)).toMatchObject({ enabled: false,
          reason: 'executor_disabled', target: { configured: false, id: null, mode: 'fresh' } });
        expect((await recoveryCliJson(owner, publicOrigin, '/api/system-recovery/executor', 'POST', { enabled: true }, session, { omitCsrf: true })).status).toBe(403);
        const enabled = await recoveryCliJson(owner, publicOrigin, '/api/system-recovery/executor', 'POST', { enabled: true }, session);
        expect(enabled.status).toBe(200); expect(checkedSystemRecoveryCapabilities(enabled.value).enabled).toBe(true);
        expect((await recoveryCliJson(owner, publicOrigin, '/api/system-recovery/jobs', 'POST', backupInput, session)).status).toBe(409);
        const initial = await recoveryCliJson(owner, publicOrigin, '/api/system-recovery/maintenance', 'GET', undefined, session);
        expect(initial.status).toBe(200); const initialState = checkedSystemRecoveryMaintenanceStatus(initial.value);
        expect(initialState).toMatchObject({ state: 'open', token: null, activeWriters: 0 });
        const enter = { requestId: randomUUID(), action: 'enter', expectedGeneration: initialState.generation } as const;
        expect((await recoveryCliJson(owner, publicOrigin, '/api/system-recovery/maintenance', 'POST', enter, session, { omitCsrf: true })).status).toBe(403);
        const entering = await recoveryCliJson(owner, publicOrigin, '/api/system-recovery/maintenance', 'POST', enter, session);
        expect(entering.status).toBe(200); const entered = checkedSystemRecoveryMaintenanceReceipt(entering.value);
        expect(entered.status).toMatchObject({ state: 'draining', generation: initialState.generation + 1, token: enter.requestId, activeWriters: 0 });
        const finalize = { requestId: randomUUID(), action: 'finalize', expectedGeneration: entered.status.generation } as const;
        const finalizing = await recoveryCliJson(owner, publicOrigin, '/api/system-recovery/maintenance', 'POST', finalize, session);
        expect(finalizing.status).toBe(200); const fenced = checkedSystemRecoveryMaintenanceReceipt(finalizing.value);
        expect(fenced.status).toMatchObject({ state: 'fenced', generation: entered.status.generation, token: enter.requestId, activeWriters: 0 });
        expect((await recoveryCliJson(owner, publicOrigin, '/api/system-recovery/maintenance', 'POST', enter, session)).value).toEqual(entered);
        expect((await recoveryCliJson(owner, publicOrigin, `/api/system-recovery/maintenance/requests/${enter.requestId}`, 'GET', undefined, session)).value).toEqual(entered);
        expect((await recoveryCliJson(owner, publicOrigin, '/api/system-recovery/maintenance', 'POST', { ...enter, action: 'release' }, session)).status).toBe(409);
        const accepted = await recoveryCliJson(owner, publicOrigin, '/api/system-recovery/jobs', 'POST', backupInput, session);
        expect(accepted.status).toBe(202); const receipt = checkedSystemRecoveryReceipt(accepted.value);
        expect(receipt.job).toMatchObject({ kind: 'backup', state: 'queued', phase: 'snapshot', requestId: backupInput.requestId });
        expect((await recoveryCliJson(owner, publicOrigin, `/api/system-recovery/requests/${backupInput.requestId}`, 'GET', undefined, session)).value)
          .toEqual({ ...receipt, reused: true });
        return receipt.job.id;
      }); // Original compiled child close ACK precedes the fresh one-shot owner.
      await withTrustedDispatcher(source, async (app, client, native) => {
        for (const outcome of ['snapshot', 'source_measured', 'measured'])
          expect(await app.dispatchRecoveryJobsOnce()).toEqual({ jobId: backupId, outcome });
        expect(native.prepare('SELECT phase,state FROM system_recovery_jobs WHERE id=?').get(backupId)).toEqual({ phase: 'write', state: 'queued' });
        const hold = await holdCurrentRecoveryPublicationAck(source.recoveryArtifacts.root);
        const dispatch = app.dispatchRecoveryJobsOnce(); void dispatch.catch(() => undefined);
        let failed = false, failure: unknown;
        try {
          await Promise.race([hold.reached, dispatch.then(() => { throw new Error('Original filesystem publication ACK was not held'); })]);
          expect(await dispatch).toEqual({ jobId: backupId, outcome: 'paused' });
          expect(native.prepare('SELECT state,reason FROM system_recovery_jobs WHERE id=?').get(backupId))
            .toEqual({ state: 'paused', reason: 'execution_budget_exhausted' });
          expect(native.prepare('SELECT state FROM system_recovery_attempts WHERE job_id=?').all(backupId)).toEqual([{ state: 'unknown' }]);
          const session = await client.login('operator');
          expect((await client.request(`/api/system-recovery/jobs/${backupId}/control`, 'POST', { action: 'cleanup' }, session)).status).toBe(409);
          expect(native.prepare('SELECT state FROM system_recovery_attempts WHERE job_id=?').all(backupId)).toEqual([{ state: 'unknown' }]);
          expect(hold.selectedCalls()).toBe(1);
        } catch (error) { failed = true; failure = error; }
        try { await hold.releaseAndRestore(); } catch (cleanup) {
          throw failed ? new AggregateError([failure, cleanup], 'Original held publication and first ACK cleanup failed') : cleanup;
        }
        if (failed) throw failure;
        // A late positive provider ACK may settle its own original attempt. It
        // cannot finish the stale job; fresh resume verifies the exact same key.
        await untilOriginalAcknowledged(() => native.prepare('SELECT state FROM system_recovery_attempts WHERE job_id=?').get(backupId)?.state === 'settled');
        expect(native.prepare('SELECT state FROM system_recovery_jobs WHERE id=?').get(backupId)?.state).toBe('paused');
        const session = await client.login('operator');
        expect((await client.request(`/api/system-recovery/jobs/${backupId}/control`, 'POST', { action: 'resume' }, session)).status).toBe(200);
        expect(await app.dispatchRecoveryJobsOnce()).toEqual({ jobId: backupId, outcome: 'completed' });
        expect(native.prepare('SELECT state FROM system_recovery_attempts WHERE job_id=?').all(backupId)).toEqual([{ state: 'verified' }]);
      });
      assertCanonicalFileOwnersReleased();
      const downloaded = await withCli(source, publicOrigin, async owner => {
        const session = await loginCurrentRecoveryCli(owner, publicOrigin, 'operator', CANONICAL_FILE_PASSWORD);
        const state = await recoveryCliJson(owner, publicOrigin, `/api/system-recovery/jobs/${backupId}`, 'GET', undefined, session);
        expect(state.status).toBe(200); const status = checkedSystemRecoveryJobStatus(state.value);
        expect(status).toMatchObject({ state: 'completed', phase: 'done', output: { available: true }, progress: {
          totalFiles: 1, completedFiles: 1, bytesTotal: source.payloadBytes, bytesDone: source.payloadBytes } });
        ensure(status.output);
        const download = await recoveryCliBytes(owner, publicOrigin, `/api/system-recovery/jobs/${backupId}/download`, 'GET', undefined, session);
        expect(download.status).toBe(200); expect(download.headers.get('content-type')).toBe('application/zip');
        expect(download.bytes.byteLength).toBe(status.output.byteSize);
        expect(createHash('sha256').update(download.bytes).digest('hex')).toBe(status.output.sha256);
        return { bytes: download.bytes, sha256: status.output.sha256 };
      });
      const archivePath = join(source.baseline.root, 'actual-online-recovery-download-v5.zip');
      await writeFile(archivePath, downloaded.bytes, { flag: 'wx', mode: 0o600 });
      const stat = await lstat(archivePath); expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600).toBe(true);
      const admitted = await validateV28SystemBackupArchiveCandidate(await nodeRecoveryArchiveSource(archivePath), {
        ...NODE_RECOVERY_ARCHIVE_OPTIONS, expectedSha256: downloaded.sha256 });
      expect(admitted.manifest.completeness).toBe('complete'); expect(admitted.manifest.counts).toMatchObject({ sources: 1,
        packagedFiles: 1, unavailableFiles: 0, bytes: source.payloadBytes });
      expect(admitted.records.origin.capturePolicy).toBe('quiesced-writers-and-bytes/1');
      expect(admitted.manifest.files).toHaveLength(1); expect(admitted.manifest.files[0]).toMatchObject({ outcome: 'packaged',
        byteSize: source.payloadBytes, sha256: source.payloadSha256, fileIds: [source.sourceFileId],
        source: { provider: 'local', fileId: source.sourceFileId, storageProfileId: source.baseline.internalProfileId } });
      for (const table of [...CURRENT_V28_RECOVERY_FILE_TABLES, ...CURRENT_V28_RECOVERY_TEMPLATE_TABLES])
        expect(currentV28RecoveryImageRows(admitted.records.image.tables[table]!)).toEqual(source.expectedTypedSource[table]);
      const uploadInput = { requestId: randomUUID(), byteSize: downloaded.bytes.byteLength, sha256: downloaded.sha256 };
      const uploadId = await withCli(source, publicOrigin, async owner => {
        const session = await loginCurrentRecoveryCli(owner, publicOrigin, 'operator', CANONICAL_FILE_PASSWORD);
        const accepted = await recoveryCliJson(owner, publicOrigin, '/api/system-recovery/uploads', 'POST', uploadInput, session);
        expect(accepted.status).toBe(202); const receipt = checkedSystemRecoveryReceipt(accepted.value);
        expect(receipt.job).toMatchObject({ kind: 'upload', state: 'awaiting_upload', phase: 'write' });
        const uploaded = await recoveryCliBytes(owner, publicOrigin, `/api/system-recovery/jobs/${receipt.job.id}/upload`, 'PUT', downloaded.bytes, session);
        expect(uploaded.status).toBe(200);
        expect(checkedSystemRecoveryJobStatus(JSON.parse(Buffer.from(uploaded.bytes).toString('utf8')))).toMatchObject({ state: 'queued', phase: 'validate' });
        return receipt.job.id;
      });
      await withTrustedDispatcher(source, async app => {
        expect(await app.dispatchRecoveryJobsOnce()).toEqual({ jobId: uploadId, outcome: 'preview' });
      });
      const preview = await withCli(source, publicOrigin, async owner => {
        const session = await loginCurrentRecoveryCli(owner, publicOrigin, 'operator', CANONICAL_FILE_PASSWORD);
        const response = await recoveryCliJson(owner, publicOrigin, `/api/system-recovery/jobs/${uploadId}/preview`, 'GET', undefined, session);
        expect(response.status).toBe(200); const result = checkedSystemRecoveryPreview(response.value);
        expect(result).toMatchObject({ archive: { schema: 'system-backup/5', complete: true, legacy: false, sha256: downloaded.sha256 },
          counts: { files: 1, availableFiles: 1, unavailableFiles: 0, bytes: source.payloadBytes },
          target: { id: null, available: false, reason: 'target_unavailable' }, canRecover: false, canCutover: false,
          oldJobs: { automaticReplay: false }, protectedSettings: { included: true, credentialRecovery: 'quarantined' } });
        expect(result.reasons).toContain('target_unavailable');
        const current = checkedSystemRecoveryMaintenanceStatus((await recoveryCliJson(owner, publicOrigin, '/api/system-recovery/maintenance', 'GET', undefined, session)).value);
        expect(current).toMatchObject({ state: 'fenced', backupJobId: backupId }); ensure(current.checkpoint);
        const release = { requestId: randomUUID(), action: 'release', expectedGeneration: current.generation } as const;
        const released = await recoveryCliJson(owner, publicOrigin, '/api/system-recovery/maintenance', 'POST', release, session);
        expect(released.status).toBe(200); expect(checkedSystemRecoveryMaintenanceReceipt(released.value).status)
          .toMatchObject({ state: 'open', generation: current.generation + 1, token: null, checkpoint: null, backupJobId: null });
        for (const id of [backupId, uploadId])
          expect((await recoveryCliJson(owner, publicOrigin, `/api/system-recovery/jobs/${id}/control`, 'POST', { action: 'cleanup' }, session)).status).toBe(200);
        expect((await recoveryCliBytes(owner, publicOrigin, `/api/system-recovery/jobs/${backupId}/download`, 'GET', undefined, session)).status).toBe(404);
        const disabled = await recoveryCliJson(owner, publicOrigin, '/api/system-recovery/executor', 'POST', { enabled: false }, session);
        expect(disabled.status).toBe(200); expect(checkedSystemRecoveryCapabilities(disabled.value).enabled).toBe(false);
        return result;
      });
      await withCanonicalFileDatabase(source.baseline.path, async (_owner, lease, native) => lease.withWriter(async () => {
        expect(currentV28RecoveryTypedRows(native)).toEqual(source.expectedTypedSource);
        expect(currentV28RecoveryTypedRows(native, CURRENT_V28_RECOVERY_PHYSICAL_TABLES)).toEqual(source.expectedTypedPhysicalBindings);
        for (const table of ['file_authority_runtime_guard', 'file_shadow_runtime_guard', 'file_job_runtime_guard', 'system_recovery_runtime'])
          expect(native.prepare(`SELECT enabled FROM ${table} WHERE singleton=1`).get()?.enabled).toBe(0);
        expect(native.prepare('SELECT state FROM system_recovery_maintenance WHERE singleton=1').get()?.state).toBe('open');
        expect(native.prepare('SELECT state FROM system_recovery_attempts WHERE job_id IN(?,?) ORDER BY job_id').all(backupId, uploadId))
          .toEqual([{ state: 'cleaned' }, { state: 'cleaned' }]);
      }));
      assertCanonicalFileOwnersReleased();
      await writeFile(output, JSON.stringify({ kind: 'current-node-v28-recovery-only-cli-kernel/1',
        sourceInstallationId: source.baseline.installationId, sourceFileId: source.sourceFileId, sourceAssetId: source.sourceAssetId,
        sourceFileCount: 1, payloadBytes: source.payloadBytes, payloadSha256: source.payloadSha256, archiveSha256: downloaded.sha256,
        backupJobId: backupId, uploadJobId: uploadId, packagedCliHttp: true, sharedTrustedOneShotDispatch: true,
        originalKernelDeadlineMs: 60000, originalPublicationUnknownCleanupRefused: true,
        targetAvailable: preview.target.available, canRecover: preview.canRecover, canCutover: preview.canCutover,
        recoveryCadenceQualified: false, sourceBusinessWritersMounted: false, fullSameAppRecoveryQualified: false,
        automaticActivation: false, sourceExecutorsEnabled: false }) + '\n', { flag: 'wx', mode: 0o600 });
    }), 120_000);
});
