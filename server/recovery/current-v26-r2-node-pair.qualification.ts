import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { stableJson } from '../../shared/domain/content-addressing';
import { validateFileUploadResult } from '../../shared/contracts/r2-upload';
import { checkedSystemRecoveryCapabilities, checkedSystemRecoveryJobStatus } from '../../shared/contracts/system-recovery';
import { validateVersionedSystemBackupArchive } from '../../shared/contracts/system-backup-versioned-admission';
import { recoveryTableSnapshotSql } from '../../shared/contracts/system-recovery-image';
import { PORTABLE_RUNTIME_RECOVERY_TABLES, PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256 } from '../../shared/contracts/portable-runtime-v26-recovery-catalog';
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource, nodeRecoveryFileSha256 } from '../../scripts/lib/system-backup-node-io';
import { restoreSystemBackupToIsolatedDirectory } from '../../scripts/lib/restore-system-backup';
import { disabledProtectedAccountTable } from './restore-v26';
import { V26_NODE_INSTALLATION_CATALOG } from '../installation-catalog-v26';
import { admitInstallationRecoverySource, assertInstallationAdmission } from '../migrations';
import { retainedCanonicalFileCase, withCanonicalFileDatabase } from '../collaboration/current-v28-canonical-comment-file.qualification-support';
import { assertPairReserve, pairJson, prepareGenuineCurrentV26R2Pair, type GenuineR2Pair } from './current-v26-r2-node-pair.qualification-support';

const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRXsAAAAASUVORK5CYII=', 'base64'));
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = sha(bytes);
let pair: GenuineR2Pair, parent: string, output: string;
function ensure(value: unknown): asserts value { if (!value) throw new Error('Current genuine R2/Node pair unavailable'); }
beforeAll(() => retainedCanonicalFileCase(async () => {
  parent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT ?? '';
  output = process.env.CURRENT_V26_R2_NODE_PAIR_RECEIPT ?? '';
  ensure(isAbsolute(parent) && resolve(parent) === parent && await realpath(parent) === parent
    && isAbsolute(output) && resolve(output) === output);
  assertPairReserve(parent);
  pair = await prepareGenuineCurrentV26R2Pair(parent);
}), 20_000);

describe('current genuine V26 D1/R2 to Node inert pair', () => {
  it('backs up one real ordinary R2 HTTP upload through the original scheduled recovery job and restores exact V3 content into a fresh inert Node target',
    () => retainedCanonicalFileCase(async () => {
      let failed = false, failure: unknown;
      try {
        assertPairReserve(parent);
        const initialObjects = await pair.listObjects(); expect(initialObjects.truncated).toBe(false); expect(initialObjects.objects).toEqual([]);
        const unauthenticated = await pair.request('/api/system-recovery/capabilities', 'GET', undefined, {}, 'none');
        expect(unauthenticated.response.status).toBe(403);
        const denied = await pair.request('/api/system-recovery/executor', 'POST', JSON.stringify({ enabled: true }), { 'content-type': 'application/json' }, 'reader');
        expect(denied.response.status).toBe(403);
        expect(await pair.legacyMode()).toEqual({ mode: 'legacy' });
        const uploadRequestId = randomUUID(), headers = { 'content-type': 'image/png', 'x-filename': 'genuine-r2-pair.png', 'x-upload-request-id': uploadRequestId };
        const uploaded = await pair.request('/api/assets', 'POST', bytes, headers); expect(uploaded.response.status).toBe(201);
        const asset = validateFileUploadResult(pairJson(uploaded.value)); const sourceKey = asset.key; ensure(typeof sourceKey === 'string');
        expect(Object.keys(asset).sort()).toEqual(['deduplicated', 'id', 'key']); expect(asset.deduplicated).toBe(false);
        const replay = await pair.request('/api/assets', 'POST', bytes, headers); expect(replay.response.status).toBe(200);
        expect(validateFileUploadResult(pairJson(replay.value))).toEqual(asset);
        const read = await pair.request(`/api/assets/${sourceKey}`); expect(read.response.status).toBe(200); ensure(read.value instanceof ArrayBuffer);
        expect(new Uint8Array(read.value)).toEqual(bytes); expect(sha(new Uint8Array(read.value))).toBe(digest);
        const nativeObject = await pair.readObject(sourceKey); expect(nativeObject.byteSize).toBe(bytes.byteLength);
        expect(new Uint8Array(nativeObject.bytes)).toEqual(bytes); expect(sha(new Uint8Array(nativeObject.bytes))).toBe(digest);
        const objects = await pair.listObjects(); expect(objects.truncated).toBe(false); expect(objects.objects.map(object => object.key)).toEqual([sourceKey]);
        expect(await pair.uploadReceipt(uploadRequestId))
          .toEqual({ actor_email: pair.actor, ingress: 'ordinary_image', purpose: 'embedded_content', request_scope: 'system', status: 'ready' });
        const configured = await pair.request('/api/system-recovery/executor', 'POST', JSON.stringify({ enabled: true }), { 'content-type': 'application/json' });
        expect(configured.response.status).toBe(200);
        expect(checkedSystemRecoveryCapabilities(pairJson(configured.value))).toMatchObject({ supported: true, canManage: true, enabled: true });
        const requestId = randomUUID(), input = { requestId, kind: 'backup', mode: 'historical' };
        const accepted = await pair.request('/api/system-recovery/jobs', 'POST', JSON.stringify(input), { 'content-type': 'application/json' });
        expect(accepted.response.status).toBe(202); const acceptedReceipt = pairJson(accepted.value); expect(acceptedReceipt.requestId).toBe(requestId);
        const firstJob = checkedSystemRecoveryJobStatus(acceptedReceipt.job); let job = firstJob;
        for (let stages = 0; stages < 16 && job.state !== 'completed'; stages++) {
          await pair.schedule();
          const status = await pair.request(`/api/system-recovery/jobs/${job.id}`); expect(status.response.status).toBe(200);
          job = checkedSystemRecoveryJobStatus(pairJson(status.value)); expect(['queued', 'completed']).toContain(job.state);
        }
        expect(job.id).toBe(firstJob.id); expect(job.state).toBe('completed'); expect(job.output?.available).toBe(true);
        ensure(job.output); expect(job.progress.completedFiles).toBe(1); expect(job.progress.totalFiles).toBe(1);
        const archiveResponse = await pair.request(`/api/system-recovery/jobs/${job.id}/download`);
        expect(archiveResponse.response.status).toBe(200); expect(archiveResponse.response.headers.get('content-type')).toBe('application/zip');
        ensure(archiveResponse.value instanceof ArrayBuffer); const archiveBytes = new Uint8Array(archiveResponse.value);
        expect(archiveBytes.byteLength).toBe(job.output.byteSize); expect(sha(archiveBytes)).toBe(job.output.sha256);
        const afterObjects = await pair.listObjects(); expect(afterObjects.truncated).toBe(false); expect(afterObjects.objects).toHaveLength(2);
        const artifact = afterObjects.objects.find(object => object.key.startsWith(`fp5-system/${job.id}/`)); ensure(artifact);
        const storedArchive = await pair.readObject(artifact.key); expect(storedArchive.byteSize).toBe(archiveBytes.byteLength);
        expect(new Uint8Array(storedArchive.bytes)).toEqual(archiveBytes); expect(sha(new Uint8Array(storedArchive.bytes))).toBe(job.output.sha256);
        // Source provider proof is native R2 GET/list/body and the original job's
        // R2 write/readback. It is never inferred from a fetch-attempt counter.
        const archive = join(pair.root, 'actual-r2-source-v3.zip');
        await writeFile(archive, archiveBytes, { flag: 'wx', mode: 0o600 });
        const admitted = await validateVersionedSystemBackupArchive(await nodeRecoveryArchiveSource(archive),
          { ...NODE_RECOVERY_ARCHIVE_OPTIONS, expectedSha256: job.output.sha256 });
        ensure(admitted.format === 'v3');
        expect(admitted.records.origin).toMatchObject({ format: 'native', schemaVersion: 26, capturePolicy: 'atomic-primary-with-byte-holds/1' });
        expect(admitted.records.image).toMatchObject({ version: 3, checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID, schemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256 });
        ensure(admitted.records.sourceMigrationLedger.kind === 'cloudflare-observed-migrations/1');
        expect(admitted.records.sourceMigrationLedger.status).toBe(pair.wranglerLedgerPresent ? 'observed' : 'unavailable');
        if (!pair.wranglerLedgerPresent) expect(admitted.records.sourceMigrationLedger.entries).toEqual([]);
        expect(Object.hasOwn(admitted.records.sourceMigrationLedger, 'installationId')).toBe(false);
        expect(admitted.manifest.completeness).toBe('complete');
        expect(admitted.manifest.counts).toMatchObject({ sources: 1, packagedFiles: 1, unavailableFiles: 0, bytes: bytes.byteLength });
        expect(admitted.manifest.files).toHaveLength(1); const file = admitted.manifest.files[0]!;
        expect(file).toMatchObject({ outcome: 'packaged', byteSize: bytes.byteLength, sha256: digest });
        expect(file.source).toMatchObject({ storeKind: 'r2', provider: 'r2', objectKey: sourceKey });
        const actualSourceRows = await pair.typedSourceRows();
        for (const spec of PORTABLE_RUNTIME_RECOVERY_TABLES.filter(spec => !spec.local)) {
          expect(actualSourceRows[spec.name]!.map(row => { ensure((row.rowid === null || typeof row.rowid === 'string') && typeof row.cells === 'string');
            return stableJson({ rowid: row.rowid, cells: JSON.parse(row.cells) }); }).sort())
            .toEqual(admitted.records.image.tables[spec.name]!.rows.map(stableJson).sort());
        }
        const firstClose = pair.close(); expect(pair.close()).toBe(firstClose); await firstClose;
        const destination = join(pair.root, 'new-node-inert-destination');
        const restored = await restoreSystemBackupToIsolatedDirectory({ archivePath: archive, destination, expectedSha256: admitted.sha256 });
        expect(restored.report).toMatchObject({ payloads: 1, payloadBytes: bytes.byteLength, providerIO: false, nativeBindingsRestored: false,
          executionEnabled: false, maintenanceState: 'fenced', sourceImageSchemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256 });
        const payloadPath = join(destination, file.path!), payload = await readFile(payloadPath), payloadStat = await lstat(payloadPath);
        expect(payloadStat.isFile() && !payloadStat.isSymbolicLink() && payloadStat.nlink === 1 && (payloadStat.mode & 0o7777) === 0o600).toBe(true);
        expect(new Uint8Array(payload)).toEqual(bytes); expect(sha(payload)).toBe(digest);
        expect((await nodeRecoveryFileSha256(join(destination, 'original-archive.zip'))).sha256).toBe(admitted.sha256);
        await writeFile(`${restored.databasePath}.writer-lock`, '', { flag: 'wx', mode: 0o600 }); // Fixture lock only; no business/auth/authority seed.
        let destinationInstallationId = '';
        await withCanonicalFileDatabase(restored.databasePath, async (_owner, lease, native) => lease.withWriter(async () => {
          const target = assertInstallationAdmission(native, admitInstallationRecoverySource(native, V26_NODE_INSTALLATION_CATALOG));
          expect(target.checkpointId).toBe(PORTABLE_RUNTIME_CHECKPOINT_ID); expect(target.installationId).not.toBe(pair.sourceNamespaceInstallationId);
          destinationInstallationId = target.installationId;
          for (const spec of PORTABLE_RUNTIME_RECOVERY_TABLES.filter(spec => !spec.local)) {
            const expected = spec.name === 'local_accounts' ? disabledProtectedAccountTable(admitted.records.image.tables[spec.name]!) : admitted.records.image.tables[spec.name]!;
            const rows = native.prepare(recoveryTableSnapshotSql(spec)).all();
            expect(rows.map(row => { ensure((row.rowid === null || typeof row.rowid === 'string') && typeof row.cells === 'string');
              return stableJson({ rowid: row.rowid, cells: JSON.parse(row.cells) }); }).sort()).toEqual(expected.rows.map(stableJson).sort());
          }
          expect(native.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
          expect(native.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0])).toEqual(['ok']);
          expect(native.prepare('SELECT state FROM system_recovery_maintenance WHERE singleton=1').get()?.state).toBe('fenced');
          for (const name of ['file_shadow_runtime_guard', 'file_authority_runtime_guard', 'file_job_runtime_guard', 'system_recovery_runtime'])
            expect(native.prepare(`SELECT enabled FROM ${name}`).get()?.enabled).toBe(0);
          for (const name of ['local_identity_installation', 'local_admin_grants', 'local_sessions', 'local_storage_profile_checks', 'local_storage_profile_admissions',
            'local_storage_profile_bindings', 'system_storage_native_bindings', 'file_job_cleanup_grants', 'system_research_package_cleanup_grants', 'system_recovery_write_leases'])
            expect(native.prepare(`SELECT count(*) n FROM ${name}`).get()?.n).toBe(0);
        }));
        await writeFile(output, JSON.stringify({ kind: 'current-genuine-v26-d1-r2-node-inert-pair/1', sourceCheckpoint: PORTABLE_RUNTIME_CHECKPOINT_ID,
          archiveFormat: 'v3', sourceProvider: 'r2', actualR2SourceBytesVerified: true, originalScheduledJobCompleted: true,
          actualR2ArchiveBytesVerified: true, archiveSha256: admitted.sha256, payloadSha256: digest, payloadBytes: bytes.byteLength,
          destinationInstallationId, executionEnabled: false, nativeBindingsRestored: false, maintenanceState: 'fenced',
          reverseNodeLocalToD1Qualified: false, originalReadPathsRetained: true }) + '\n', { flag: 'wx', mode: 0o600 });
      } catch (error) { failed = true; failure = error; }
      try { await pair.close(); } catch (cleanup) { throw new AggregateError(failed ? [failure, cleanup] : [cleanup], 'Original pair work and first close failed'); }
      if (failed) throw failure;
    }), 20_000);
});
