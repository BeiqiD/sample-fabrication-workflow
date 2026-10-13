import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { verifyNodeDistribution } from '../../scripts/lib/node-distribution-v28-manifest.mjs';
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource } from '../../scripts/lib/system-backup-node-io.ts';
import { validateV28SystemBackupArchiveCandidate } from '../../shared/contracts/system-backup-v5-archive-admission.ts';
import { PORTABLE_RUNTIME_RECOVERY_TABLES } from '../../shared/contracts/portable-runtime-v28-recovery-catalog.ts';
import { stableJson } from '../../shared/domain/content-addressing.ts';
import { checkedSystemRecoveryCapabilities, checkedSystemRecoveryReceipt, checkedSystemRecoveryJobStatus,
  checkedSystemRecoveryPreview, checkedSystemRecoveryMaintenanceStatus, checkedSystemRecoveryMaintenanceReceipt,
  type SystemRecoveryPublicReport } from '../../shared/contracts/system-recovery.ts';
import { loadNodeRuntimeConfiguration, assertNodeRuntimeConfiguration } from '../node-runtime-config.ts';
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from '../installation-catalog-v28-candidate.ts';
import { admitInstallationRecoverySource } from '../migrations.ts';
import { CANONICAL_FILE_PASSWORD, assertCanonicalFileOwnersReleased, canonicalFilePrivateOrigin,
  retainedCanonicalFileCase, withCanonicalFileDatabase } from '../collaboration/current-v28-canonical-comment-file.qualification-support.ts';
import { prepareCurrentV28OnlineRecoverySource, currentV28RecoveryImageRows, currentV28RecoveryTypedRows,
  CURRENT_V28_RECOVERY_PHYSICAL_TABLES } from './current-v28-online-recovery.qualification-support.ts';
import { loginCurrentRecoveryCli, recoveryCliJson, recoveryCliBytes, type CurrentRecoveryCliOwner,
  type CurrentRecoveryCliSession } from './current-v28-recovery-cli.qualification-support.ts';
import { prepareCurrentRecoveryTarget } from './current-v28-recovery-target.qualification-support.ts';
import { holdCurrentRecoveryTargetPayloadAck } from './current-v28-recovery-held-target-ack.qualification-support.ts';
import { disabledProtectedAccountTable } from './restore-v28-candidate.ts';

const RESERVE = 603_979_776n;
let distribution: string, output: string;
function ensure(value: unknown): asserts value { if (!value) throw new Error('Genuine current inert target qualification unavailable'); }
beforeAll(async () => {
  distribution = process.env.NODE_OFFLINE_V28_DISTRIBUTION ?? '';
  output = process.env.CURRENT_V28_ONLINE_RECOVERY_TARGET_RECEIPT ?? '';
  const parent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT ?? '';
  ensure(isAbsolute(distribution) && resolve(distribution) === distribution && await realpath(distribution) === distribution
    && isAbsolute(output) && resolve(output) === output && isAbsolute(parent) && resolve(parent) === parent);
  for (const directory of [parent, tmpdir()]) { const free = statfsSync(directory, { bigint: true }); ensure(free.bavail * free.bsize >= RESERVE); }
  const manifest = await verifyNodeDistribution(distribution, { enforceRuntimeVersion: true });
  expect(manifest.version).toBe(3); expect(manifest.offlineRecoveryCheckpoint.id).toBe('portable-runtime/v28');
  expect(manifest.offlineRecoveryCheckpoint.archiveFormat).toBe('v5');
}, 20_000);
async function fence(owner: CurrentRecoveryCliOwner, origin: string, session: CurrentRecoveryCliSession) {
  const reply = await recoveryCliJson(owner, origin, '/api/system-recovery/maintenance', 'GET', undefined, session);
  expect(reply.status).toBe(200); const initial = checkedSystemRecoveryMaintenanceStatus(reply.value);
  expect(initial.state).toBe('open');
  const entering = await recoveryCliJson(owner, origin, '/api/system-recovery/maintenance', 'POST', {
    requestId: randomUUID(), action: 'enter', expectedGeneration: initial.generation }, session);
  expect(entering.status).toBe(200); const entered = checkedSystemRecoveryMaintenanceReceipt(entering.value);
  const finalizing = await recoveryCliJson(owner, origin, '/api/system-recovery/maintenance', 'POST', {
    requestId: randomUUID(), action: 'finalize', expectedGeneration: entered.status.generation }, session);
  expect(finalizing.status).toBe(200); const final = checkedSystemRecoveryMaintenanceReceipt(finalizing.value);
  expect(final.status).toMatchObject({ state: 'fenced', activeWriters: 0 }); return final.status;
}
async function acknowledged(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) { ensure(Date.now() < deadline); await new Promise<void>(done => setTimeout(done, 10)); }
}

// This NEW120s case crosses the unchanged real kernel60s deadline once. Public
// metadata/control uses the actual distribution main; independent original
// Native hosts invoke the original one-shot dispatcher between first closes.
// It does not qualify elapsed120 cadence or same-app source business writers.
describe('current real one-File Node V28 fresh inert target through shared recovery stages', () => {
  it('retains unknown target writes across source release and restart, reconciles exact nonempty bytes and records an explicit inert handoff',
    () => retainedCanonicalFileCase(async () => {
      const source = await prepareCurrentV28OnlineRecoverySource(), target = await prepareCurrentRecoveryTarget(source);
      const origin = await withCanonicalFileDatabase(source.baseline.path, owner => canonicalFilePrivateOrigin(owner));
      const backupInput = { requestId: randomUUID(), kind: 'backup', mode: 'planned' } as const;
      const backupId = await target.withCli(distribution, origin, async owner => {
        const session = await loginCurrentRecoveryCli(owner, origin, 'operator', CANONICAL_FILE_PASSWORD);
        const capability = await recoveryCliJson(owner, origin, '/api/system-recovery/capabilities', 'GET', undefined, session);
        expect(capability.status).toBe(200); expect(checkedSystemRecoveryCapabilities(capability.value)).toMatchObject({ enabled: false,
          reason: 'executor_disabled', target: { configured: true, id: target.descriptor.targetId, mode: 'fresh' } });
        expect((await recoveryCliJson(owner, origin, '/api/system-recovery/executor', 'POST', { enabled: true }, session)).status).toBe(200);
        await fence(owner, origin, session);
        const accepted = await recoveryCliJson(owner, origin, '/api/system-recovery/jobs', 'POST', backupInput, session);
        expect(accepted.status).toBe(202); return checkedSystemRecoveryReceipt(accepted.value).job.id;
      });
      await target.withDispatcher(async app => {
        for (const outcome of ['snapshot', 'source_measured', 'measured', 'completed'])
          expect(await app.dispatchRecoveryJobsOnce()).toEqual({ jobId: backupId, outcome });
      });
      const downloaded = await target.withCli(distribution, origin, async owner => {
        const session = await loginCurrentRecoveryCli(owner, origin, 'operator', CANONICAL_FILE_PASSWORD);
        const reply = await recoveryCliJson(owner, origin, `/api/system-recovery/jobs/${backupId}`, 'GET', undefined, session);
        expect(reply.status).toBe(200); const state = checkedSystemRecoveryJobStatus(reply.value); ensure(state.output);
        expect(state).toMatchObject({ state: 'completed', phase: 'done', output: { available: true } });
        const result = await recoveryCliBytes(owner, origin, `/api/system-recovery/jobs/${backupId}/download`, 'GET', undefined, session);
        expect(result.status).toBe(200); expect(result.bytes.byteLength).toBe(state.output.byteSize);
        expect(createHash('sha256').update(result.bytes).digest('hex')).toBe(state.output.sha256);
        return { bytes: result.bytes, sha256: state.output.sha256 };
      });
      const archivePath = join(source.baseline.root, 'actual-inert-target-public-download-v5.zip');
      await writeFile(archivePath, downloaded.bytes, { flag: 'wx', mode: 0o600 });
      const admitted = await validateV28SystemBackupArchiveCandidate(await nodeRecoveryArchiveSource(archivePath), {
        ...NODE_RECOVERY_ARCHIVE_OPTIONS, expectedSha256: downloaded.sha256 });
      expect(admitted.manifest.completeness).toBe('complete'); expect(admitted.manifest.files).toHaveLength(1);
      expect(admitted.manifest.files[0]).toMatchObject({ byteSize: source.payloadBytes, sha256: source.payloadSha256,
        outcome: 'packaged', source: { provider: 'local', fileId: source.sourceFileId } });
      const uploadId = await target.withCli(distribution, origin, async owner => {
        const session = await loginCurrentRecoveryCli(owner, origin, 'operator', CANONICAL_FILE_PASSWORD);
        const accepted = await recoveryCliJson(owner, origin, '/api/system-recovery/uploads', 'POST', {
          requestId: randomUUID(), byteSize: downloaded.bytes.byteLength, sha256: downloaded.sha256 }, session);
        expect(accepted.status).toBe(202); const id = checkedSystemRecoveryReceipt(accepted.value).job.id;
        const put = await recoveryCliBytes(owner, origin, `/api/system-recovery/jobs/${id}/upload`, 'PUT', downloaded.bytes, session);
        expect(put.status).toBe(200); expect(checkedSystemRecoveryJobStatus(JSON.parse(Buffer.from(put.bytes).toString('utf8'))))
          .toMatchObject({ state: 'queued', phase: 'validate' }); return id;
      });
      await target.withDispatcher(async app => { expect(await app.dispatchRecoveryJobsOnce()).toEqual({ jobId: uploadId, outcome: 'preview' }); });
      const recoveryInput = { requestId: randomUUID(), uploadJobId: uploadId, expectedTargetId: target.descriptor.targetId,
        mapping: [], mode: 'historical', acknowledgeLaterChanges: true, acknowledgePartial: false } as const;
      const recoveryId = await target.withCli(distribution, origin, async owner => {
        const session = await loginCurrentRecoveryCli(owner, origin, 'operator', CANONICAL_FILE_PASSWORD);
        const reply = await recoveryCliJson(owner, origin, `/api/system-recovery/jobs/${uploadId}/preview`, 'GET', undefined, session);
        expect(reply.status).toBe(200); expect(checkedSystemRecoveryPreview(reply.value)).toMatchObject({ canRecover: true, canCutover: false,
          target: { id: target.descriptor.targetId, available: true, reason: null }, archive: { schema: 'system-backup/5', complete: true, legacy: false } });
        expect((await recoveryCliJson(owner, origin, '/api/system-recovery/recoveries', 'POST', recoveryInput, session, { omitCsrf: true })).status).toBe(403);
        expect((await recoveryCliJson(owner, origin, '/api/system-recovery/recoveries', 'POST', { ...recoveryInput, acknowledgeLaterChanges: false }, session)).status).toBe(400);
        expect((await recoveryCliJson(owner, origin, '/api/system-recovery/recoveries', 'POST', { ...recoveryInput, expectedTargetId: randomUUID() }, session)).status).toBe(503);
        const accepted = await recoveryCliJson(owner, origin, '/api/system-recovery/recoveries', 'POST', recoveryInput, session);
        expect(accepted.status).toBe(202); const receipt = checkedSystemRecoveryReceipt(accepted.value);
        expect(receipt.job).toMatchObject({ kind: 'recovery', state: 'queued', phase: 'claim' });
        expect((await recoveryCliJson(owner, origin, '/api/system-recovery/recoveries', 'POST', recoveryInput, session)).value)
          .toEqual({ ...receipt, reused: true });
        expect((await recoveryCliJson(owner, origin, '/api/system-recovery/recoveries', 'POST', { ...recoveryInput, requestId: randomUUID() }, session)).status).toBe(409);
        return receipt.job.id;
      });
      await target.withDispatcher(async (app, client, native) => {
        let phase = 'claim';
        for (let count = 0; phase !== 'files'; count++) {
          ensure(count < 64); const result = await app.dispatchRecoveryJobsOnce(); expect(result.jobId).toBe(recoveryId); expect(result.outcome).not.toBe('paused');
          phase = String(native.prepare('SELECT phase FROM system_recovery_jobs WHERE id=?').get(recoveryId)?.phase);
        }
        const hold = await holdCurrentRecoveryTargetPayloadAck(target.destination), original = app.dispatchRecoveryJobsOnce();
        void original.catch(() => undefined); let failed = false, failure: unknown;
        try {
          await Promise.race([hold.reached, original.then(() => { throw new Error('Original target payload ACK was not held'); })]);
          expect(await original).toEqual({ jobId: recoveryId, outcome: 'paused' });
          expect(native.prepare('SELECT state,reason FROM system_recovery_jobs WHERE id=?').get(recoveryId))
            .toEqual({ state: 'paused', reason: 'execution_budget_exhausted' });
          expect(native.prepare("SELECT json_extract(cursor_json,'$.pending') pending FROM system_recovery_target_claim WHERE job_id=?").get(recoveryId)?.pending).toBe(1);
          expect(native.prepare('SELECT state FROM system_recovery_target_files WHERE job_id=?').all(recoveryId)).toEqual([{ state: 'write_started' }]);
          const session = await client.login('operator');
          expect((await client.request(`/api/system-recovery/jobs/${uploadId}/control`, 'POST', { action: 'cleanup' }, session)).status).toBe(409);
          const state = checkedSystemRecoveryMaintenanceStatus((await client.request('/api/system-recovery/maintenance', 'GET', undefined, session)).value);
          const released = await client.request('/api/system-recovery/maintenance', 'POST', { requestId: randomUUID(), action: 'release', expectedGeneration: state.generation }, session);
          expect(released.status).toBe(200); expect(checkedSystemRecoveryMaintenanceReceipt(released.value).status.state).toBe('open');
          expect((await client.request(`/api/system-recovery/jobs/${uploadId}/control`, 'POST', { action: 'cleanup' }, session)).status).toBe(409);
          expect(hold.selectedCalls()).toBe(1);
        } catch (error) { failed = true; failure = error; }
        try { await hold.releaseAndRestore(); } catch (cleanup) { throw failed ? new AggregateError([failure, cleanup]) : cleanup; }
        if (failed) throw failure;
        await acknowledged(() => native.prepare('SELECT state FROM system_recovery_target_files WHERE job_id=?').get(recoveryId)?.state === 'unknown');
        expect(native.prepare('SELECT state FROM system_recovery_jobs WHERE id=?').get(recoveryId)?.state).toBe('paused');
      });
      assertCanonicalFileOwnersReleased();
      await target.withCli(distribution, origin, async owner => {
        const session = await loginCurrentRecoveryCli(owner, origin, 'operator', CANONICAL_FILE_PASSWORD);
        expect((await recoveryCliJson(owner, origin, `/api/system-recovery/jobs/${uploadId}/control`, 'POST', { action: 'cleanup' }, session)).status).toBe(409);
        const state = await recoveryCliJson(owner, origin, `/api/system-recovery/jobs/${recoveryId}`, 'GET', undefined, session);
        expect(checkedSystemRecoveryJobStatus(state.value)).toMatchObject({ state: 'paused', reason: 'execution_budget_exhausted' });
        expect((await recoveryCliJson(owner, origin, `/api/system-recovery/jobs/${recoveryId}/control`, 'POST', { action: 'resume' }, session)).status).toBe(200);
      });
      await target.withDispatcher(async (app, _client, native) => {
        for (let count = 0; ; count++) {
          ensure(count < 64); const result = await app.dispatchRecoveryJobsOnce(); expect(result.jobId).toBe(recoveryId); expect(result.outcome).not.toBe('paused');
          if (result.outcome === 'target_ready') break;
        }
        expect(native.prepare('SELECT state FROM system_recovery_target_files WHERE job_id=?').all(recoveryId)).toEqual([{ state: 'published' }]);
        expect(native.prepare("SELECT json_extract(cursor_json,'$.pending') pending,status FROM system_recovery_target_claim WHERE job_id=?").get(recoveryId))
          .toEqual({ pending: 0, status: 'ready' });
      });
      const handoff = await target.withCli(distribution, origin, async owner => {
        const session = await loginCurrentRecoveryCli(owner, origin, 'operator', CANONICAL_FILE_PASSWORD);
        await fence(owner, origin, session);
        const stateReply = await recoveryCliJson(owner, origin, `/api/system-recovery/jobs/${recoveryId}`, 'GET', undefined, session);
        expect(stateReply.status).toBe(200); const state = checkedSystemRecoveryJobStatus(stateReply.value);
        expect(state).toMatchObject({ state: 'completed', phase: 'ready', progress: { completedFiles: 1, totalFiles: 1,
          bytesDone: source.payloadBytes, bytesTotal: source.payloadBytes }, result: { targetId: target.descriptor.targetId, ready: true, cutover: false } });
        ensure(state.result?.checkpoint);
        const reportReply = await recoveryCliJson(owner, origin, `/api/system-recovery/jobs/${recoveryId}/report`, 'GET', undefined, session);
        expect(reportReply.status).toBe(200); const report = reportReply.value as SystemRecoveryPublicReport;
        expect(report).toMatchObject({ schema: 'system-recovery-public-report/1', jobId: recoveryId, targetId: target.descriptor.targetId,
          mode: 'historical', historicalLaterChangesLost: true, targetCheckpoint: state.result.checkpoint,
          execution: { shadow: false, authority: false, fileJobs: false, recoveryJobs: false, cleanup: false, oldJobReplay: false },
          handoff: { automaticBindingChange: false, operatorRequired: true, sourceRetainedReadOnly: true } });
        const input = { requestId: randomUUID(), expectedTargetId: target.descriptor.targetId, expectedCheckpoint: state.result.checkpoint };
        expect((await recoveryCliJson(owner, origin, `/api/system-recovery/jobs/${recoveryId}/cutover`, 'POST', input, session, { omitCsrf: true })).status).toBe(403);
        const accepted = await recoveryCliJson(owner, origin, `/api/system-recovery/jobs/${recoveryId}/cutover`, 'POST', input, session);
        expect(accepted.status).toBe(200); const receipt = checkedSystemRecoveryReceipt(accepted.value);
        expect(receipt.job.result).toMatchObject({ ready: true, cutover: true, checkpoint: state.result.checkpoint });
        expect((await recoveryCliJson(owner, origin, `/api/system-recovery/jobs/${recoveryId}/cutover`, 'POST', input, session)).value)
          .toEqual({ ...receipt, reused: true });
        expect((await recoveryCliJson(owner, origin, `/api/system-recovery/jobs/${recoveryId}/control`, 'POST', { action: 'cleanup' }, session)).status).toBe(409);
        expect((await recoveryCliJson(owner, origin, '/api/system-recovery/executor', 'POST', { enabled: false }, session)).status).toBe(200);
        return { report, receipt };
      });
      const destinationInstallationId = await withCanonicalFileDatabase(join(target.destination, 'database.sqlite'), async (_owner, lease, native) => lease.withWriter(async () => {
        const admittedTarget = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE).receipt;
        expect(admittedTarget.installationId).not.toBe(source.baseline.installationId);
        expect(admittedTarget.checkpointId).toBe('portable-runtime/v28');
        const specs = PORTABLE_RUNTIME_RECOVERY_TABLES.filter(table => !table.local), names = specs.map(table => table.name);
        const actual = currentV28RecoveryTypedRows(native, names);
        for (const spec of specs) {
          const original = admitted.records.image.tables[spec.name]!;
          expect(actual[spec.name]).toEqual(currentV28RecoveryImageRows(spec.name === 'local_accounts' ? disabledProtectedAccountTable(original) : original));
        }
        for (const name of ['file_shadow_runtime_guard', 'file_authority_runtime_guard', 'file_job_runtime_guard', 'system_recovery_runtime'])
          expect(native.prepare(`SELECT enabled FROM ${name} WHERE singleton=1`).get()?.enabled).toBe(0);
        expect(native.prepare('SELECT state FROM system_recovery_maintenance WHERE singleton=1').get()?.state).toBe('fenced');
        for (const name of ['local_sessions', 'local_admin_grants', 'system_storage_native_bindings', 'local_storage_profile_bindings',
          'file_job_cleanup_grants', 'system_recovery_jobs', 'system_recovery_target_claim', 'system_recovery_target_files',
          'collaboration_members', 'collaboration_identities', 'collaboration_resources', 'collaboration_grants'])
          expect(native.prepare(`SELECT count(*) n FROM ${name}`).get()?.n).toBe(0);
        expect(native.prepare('SELECT count(*) n FROM local_accounts WHERE enabled<>0').get()?.n).toBe(0);
        expect(native.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(native.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
        return admittedTarget.installationId;
      }));
      for (const file of admitted.manifest.files) {
        ensure(file.path && file.byteSize !== null && file.sha256 !== null);
        const path = join(target.destination, file.path), stat = await lstat(path);
        expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600).toBe(true);
        const bytes = await readFile(path); expect(bytes.byteLength).toBe(file.byteSize); expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
        expect(new Uint8Array(bytes)).toEqual(source.bytes);
      }
      const restoredConfiguration = join(source.baseline.root, 'inert-target-restored-admission.json');
      await writeFile(restoredConfiguration, JSON.stringify({ format: 'node-loopback-restored-v28-v1', databaseFile: 'database.sqlite',
        dataDirectory: target.destination, expectedInstallationId: destinationInstallationId, publicOrigin: origin,
        clientDirectory: source.baseline.clientDirectory, enableLocalFile: false, enableLocalJobs: false }), { flag: 'wx', mode: 0o600 });
      const restored = assertNodeRuntimeConfiguration(loadNodeRuntimeConfiguration(restoredConfiguration, {
        filesystemRootOwnerUid: source.baseline.rootOwnerUid, runtimeProfile: 'v28-metadata' }));
      expect(restored.enableLocalFile).toBe(false); expect(restored.enableLocalJobs).toBe(false); expect(restored.enableLocalRecovery).toBe(false);
      expect(restored.localVolumes).toEqual([]); expect(restored.recoveryTarget).toBeUndefined();
      await withCanonicalFileDatabase(source.baseline.path, async (_owner, lease, native) => lease.withWriter(async () => {
        expect(currentV28RecoveryTypedRows(native)).toEqual(source.expectedTypedSource);
        expect(currentV28RecoveryTypedRows(native, CURRENT_V28_RECOVERY_PHYSICAL_TABLES)).toEqual(source.expectedTypedPhysicalBindings);
        expect(native.prepare('SELECT enabled FROM local_accounts WHERE principal_id=?').get(source.baseline.principalId)?.enabled).toBe(1);
        expect(native.prepare('SELECT enabled FROM system_recovery_runtime WHERE singleton=1').get()?.enabled).toBe(0);
        expect(native.prepare('SELECT state FROM system_recovery_maintenance WHERE singleton=1').get()?.state).toBe('fenced');
        for (const name of ['file_shadow_runtime_guard', 'file_authority_runtime_guard', 'file_job_runtime_guard'])
          expect(native.prepare(`SELECT enabled FROM ${name} WHERE singleton=1`).get()?.enabled).toBe(0);
      }));
      assertCanonicalFileOwnersReleased();
      await writeFile(output, stableJson({ schema: 'current-node-v28-online-recovery-target-genuine-qualification/1',
        runtime: process.versions.node, distribution, sourceInstallationId: source.baseline.installationId,
        targetId: target.descriptor.targetId, destinationInstallationId, backupId, uploadId, recoveryId,
        originalTargetDirectoryAckHeldAcrossRealSixtySecondDeadline: true, sourceReleaseAndCliRestartRetainUnknownUploadHold: true,
        publicUploadValidatePreviewAccept: true, independentOriginalSharedKernelStageDispatch: true, exactTypedRowsAndRowids: true,
        realPayloadBytes: source.payloadBytes, realPayloadSha256: source.payloadSha256, publicHandoffReceipt: handoff.receipt,
        destinationInertAndDefaultOff: true, sourceCanonicalAndPhysicalBindingsUnchanged: true,
        automaticActivation: false, sourceSameAppBusinessWritersQualified: false, elapsed120SecondCadenceQualified: false }), { flag: 'wx', mode: 0o600 });
    }), 120_000);

  it('keeps a cancelled target original and dependent upload held after real ACK, source release and CLI restart',
    () => retainedCanonicalFileCase(async () => {
      const source = await prepareCurrentV28OnlineRecoverySource(), target = await prepareCurrentRecoveryTarget(source);
      const origin = await withCanonicalFileDatabase(source.baseline.path, owner => canonicalFilePrivateOrigin(owner));
      const backupId = await target.withCli(distribution, origin, async owner => {
        const session = await loginCurrentRecoveryCli(owner, origin, 'operator', CANONICAL_FILE_PASSWORD);
        expect((await recoveryCliJson(owner, origin, '/api/system-recovery/executor', 'POST', { enabled: true }, session)).status).toBe(200);
        await fence(owner, origin, session);
        const accepted = await recoveryCliJson(owner, origin, '/api/system-recovery/jobs', 'POST', {
          requestId: randomUUID(), kind: 'backup', mode: 'planned' }, session);
        expect(accepted.status).toBe(202); return checkedSystemRecoveryReceipt(accepted.value).job.id;
      });
      await target.withDispatcher(async app => {
        for (const outcome of ['snapshot', 'source_measured', 'measured', 'completed'])
          expect(await app.dispatchRecoveryJobsOnce()).toEqual({ jobId: backupId, outcome });
      });
      const downloaded = await target.withCli(distribution, origin, async owner => {
        const session = await loginCurrentRecoveryCli(owner, origin, 'operator', CANONICAL_FILE_PASSWORD);
        const status = checkedSystemRecoveryJobStatus((await recoveryCliJson(owner, origin, `/api/system-recovery/jobs/${backupId}`, 'GET', undefined, session)).value);
        ensure(status.output?.available);
        const result = await recoveryCliBytes(owner, origin, `/api/system-recovery/jobs/${backupId}/download`, 'GET', undefined, session);
        expect(result.status).toBe(200); expect(result.bytes.byteLength).toBe(status.output.byteSize);
        expect(createHash('sha256').update(result.bytes).digest('hex')).toBe(status.output.sha256);
        return { bytes: result.bytes, sha256: status.output.sha256 };
      });
      const uploadId = await target.withCli(distribution, origin, async owner => {
        const session = await loginCurrentRecoveryCli(owner, origin, 'operator', CANONICAL_FILE_PASSWORD);
        const accepted = await recoveryCliJson(owner, origin, '/api/system-recovery/uploads', 'POST', {
          requestId: randomUUID(), byteSize: downloaded.bytes.byteLength, sha256: downloaded.sha256 }, session);
        expect(accepted.status).toBe(202); const id = checkedSystemRecoveryReceipt(accepted.value).job.id;
        const put = await recoveryCliBytes(owner, origin, `/api/system-recovery/jobs/${id}/upload`, 'PUT', downloaded.bytes, session);
        expect(put.status).toBe(200); return id;
      });
      await target.withDispatcher(async app => { expect(await app.dispatchRecoveryJobsOnce()).toEqual({ jobId: uploadId, outcome: 'preview' }); });
      const recoveryId = await target.withCli(distribution, origin, async owner => {
        const session = await loginCurrentRecoveryCli(owner, origin, 'operator', CANONICAL_FILE_PASSWORD);
        const accepted = await recoveryCliJson(owner, origin, '/api/system-recovery/recoveries', 'POST', {
          requestId: randomUUID(), uploadJobId: uploadId, expectedTargetId: target.descriptor.targetId,
          mapping: [], mode: 'historical', acknowledgeLaterChanges: true, acknowledgePartial: false }, session);
        expect(accepted.status).toBe(202); return checkedSystemRecoveryReceipt(accepted.value).job.id;
      });
      await target.withDispatcher(async (app, client, native) => {
        let phase = 'claim';
        for (let count = 0; phase !== 'files'; count++) {
          ensure(count < 64); const result = await app.dispatchRecoveryJobsOnce(); expect(result.jobId).toBe(recoveryId); expect(result.outcome).not.toBe('paused');
          phase = String(native.prepare('SELECT phase FROM system_recovery_jobs WHERE id=?').get(recoveryId)?.phase);
        }
        const hold = await holdCurrentRecoveryTargetPayloadAck(target.destination), original = app.dispatchRecoveryJobsOnce();
        void original.catch(() => undefined); let failed = false, failure: unknown;
        try {
          await Promise.race([hold.reached, original.then(() => { throw new Error('Original cancelled target ACK was not held'); })]);
          const session = await client.login('operator');
          expect((await client.request(`/api/system-recovery/jobs/${recoveryId}/control`, 'POST', { action: 'cancel' }, session)).status).toBe(200);
          expect(native.prepare('SELECT state FROM system_recovery_jobs WHERE id=?').get(recoveryId)?.state).toBe('cancelled');
          const state = checkedSystemRecoveryMaintenanceStatus((await client.request('/api/system-recovery/maintenance', 'GET', undefined, session)).value);
          const released = await client.request('/api/system-recovery/maintenance', 'POST', {
            requestId: randomUUID(), action: 'release', expectedGeneration: state.generation }, session);
          expect(released.status).toBe(200); expect(checkedSystemRecoveryMaintenanceReceipt(released.value).status.state).toBe('open');
          expect((await client.request(`/api/system-recovery/jobs/${uploadId}/control`, 'POST', { action: 'cleanup' }, session)).status).toBe(409);
          expect(hold.selectedCalls()).toBe(1);
        } catch (error) { failed = true; failure = error; }
        try { await hold.releaseAndRestore(); } catch (cleanup) { throw failed ? new AggregateError([failure, cleanup]) : cleanup; }
        // Join the original dispatch before collecting a cancellation failure.
        const result = await original;
        if (failed) throw failure;
        expect(result).toEqual({ jobId: recoveryId, outcome: 'paused' });
        expect(native.prepare('SELECT state FROM system_recovery_target_files WHERE job_id=?').all(recoveryId)).toEqual([{ state: 'unknown' }]);
        expect(native.prepare("SELECT json_extract(cursor_json,'$.pending') pending FROM system_recovery_target_claim WHERE job_id=?").get(recoveryId)?.pending).toBe(1);
        expect(native.prepare('SELECT state FROM system_recovery_jobs WHERE id=?').get(recoveryId)?.state).toBe('cancelled');
      });
      assertCanonicalFileOwnersReleased();
      await target.withCli(distribution, origin, async owner => {
        const session = await loginCurrentRecoveryCli(owner, origin, 'operator', CANONICAL_FILE_PASSWORD);
        const state = checkedSystemRecoveryJobStatus((await recoveryCliJson(owner, origin, `/api/system-recovery/jobs/${recoveryId}`, 'GET', undefined, session)).value);
        expect(state).toMatchObject({ state: 'cancelled', phase: 'files', result: null });
        expect((await recoveryCliJson(owner, origin, `/api/system-recovery/jobs/${uploadId}/control`, 'POST', { action: 'cleanup' }, session)).status).toBe(409);
        expect((await recoveryCliJson(owner, origin, `/api/system-recovery/jobs/${recoveryId}/control`, 'POST', { action: 'cleanup' }, session)).status).toBe(409);
        expect((await recoveryCliJson(owner, origin, '/api/system-recovery/executor', 'POST', { enabled: false }, session)).status).toBe(200);
      });
      await withCanonicalFileDatabase(source.baseline.path, async (_owner, lease, native) => lease.withWriter(async () => {
        expect(native.prepare('SELECT state FROM system_recovery_jobs WHERE id=?').get(recoveryId)?.state).toBe('cancelled');
        expect(native.prepare('SELECT state FROM system_recovery_target_files WHERE job_id=?').all(recoveryId)).toEqual([{ state: 'unknown' }]);
        expect(native.prepare("SELECT json_extract(cursor_json,'$.pending') pending FROM system_recovery_target_claim WHERE job_id=?").get(recoveryId)?.pending).toBe(1);
        expect(native.prepare('SELECT state FROM system_recovery_maintenance WHERE singleton=1').get()?.state).toBe('open');
        expect(currentV28RecoveryTypedRows(native)).toEqual(source.expectedTypedSource);
        expect(currentV28RecoveryTypedRows(native, CURRENT_V28_RECOVERY_PHYSICAL_TABLES)).toEqual(source.expectedTypedPhysicalBindings);
        for (const name of ['file_shadow_runtime_guard', 'file_authority_runtime_guard', 'file_job_runtime_guard', 'system_recovery_runtime'])
          expect(native.prepare(`SELECT enabled FROM ${name} WHERE singleton=1`).get()?.enabled).toBe(0);
      }));
      const payload = await readFile(join(target.destination, 'files/b_0000'));
      expect(new Uint8Array(payload)).toEqual(source.bytes); expect(createHash('sha256').update(payload).digest('hex')).toBe(source.payloadSha256);
      assertCanonicalFileOwnersReleased();
      await writeFile(output + '.cancelled-unknown.json', stableJson({ schema: 'current-node-v28-cancelled-target-unknown-qualification/1',
        distribution, sourceInstallationId: source.baseline.installationId, targetId: target.descriptor.targetId, backupId, uploadId, recoveryId,
        realOriginalDirectoryAckBeforeCancellation: true, originalDispatchAndCloseAcknowledged: true,
        cancelledUnknownLedgerSurvivesSourceReleaseAndCliRestart: true, uploadCleanupRefused: true, targetCleanupRefused: true,
        sourceCanonicalAndPhysicalBindingsUnchanged: true, destinationNotReadyOrActivated: true }), { flag: 'wx', mode: 0o600 });
    }));
});
