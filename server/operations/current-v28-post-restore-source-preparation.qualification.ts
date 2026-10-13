import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { verifyNodeDistribution } from '../../scripts/lib/node-distribution-v28-manifest.mjs';
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource } from '../../scripts/lib/system-backup-node-io';
import { validateV28SystemBackupArchiveCandidate } from '../../shared/contracts/system-backup-v5-archive-admission';
import { prepareGenuineFabubloxBaseline } from '../collaboration/current-final-fabublox-genuine-process.qualification-support';
import { canonicalFileObject, retainedCanonicalFileCase } from '../collaboration/current-v28-canonical-comment-file.qualification-support';
import { runCurrentCli } from './current-v28-backup-cli.qualification-support';

// New source preparation only. Root must first build/admit the CURRENT fixed
// four-entry distribution; no historical V5 archive/target or producer result
// is reused. Its executable is the actual restore CLI, not a mocked restorer.
function ensure(value: unknown): asserts value { if (!value) throw new Error('Current producer and bundled restoration preparation unavailable'); }

describe('current genuine zero-File V5 source for separate destination operators', () => {
  it('captures all actual typed data before any business POST and restores through the current fixed CLI into a fresh inert destination',
    () => retainedCanonicalFileCase(async () => {
      const distribution = process.env.NODE_OFFLINE_V28_DISTRIBUTION ?? '';
      const output = process.env.CURRENT_V28_POST_RESTORE_PREPARATION_RECEIPT ?? '';
      ensure(isAbsolute(distribution) && resolve(distribution) === distribution && await realpath(distribution) === distribution
        && isAbsolute(output) && resolve(output) === output);
      const manifest = await verifyNodeDistribution(distribution, { enforceRuntimeVersion: true });
      expect(manifest.version).toBe(3); expect(manifest.offlineRecoveryCheckpoint.id).toBe('portable-runtime/v28');
      expect(manifest.offlineRecoveryCheckpoint.archiveFormat).toBe('v5'); expect(manifest.offlineRecoveryCheckpoint.executionEnabled).toBe(false);
      // Every bootstrap/KDF/profile-probe/activation/Group operation and its
      // original Native/lease close completes here. No host is composed and no
      // HTTP, background job or byte-GC writer is started on this source.
      const baseline = await prepareGenuineFabubloxBaseline();
      const configuration = join(baseline.root, 'stopped-capture.json'), archive = join(baseline.root, 'complete-zero-File-v5.zip');
      await writeFile(configuration, JSON.stringify({ schema: 'stopped-local-v28-capture/1', databasePath: baseline.path,
        descriptors: baseline.descriptors }), { flag: 'wx', mode: 0o600 });
      // Invoke the actual current fixed installation executable. Its public
      // selector delegates to the same privately issued stopped capture owner.
      // Original close/output ACK precedes reading the resulting real archive.
      const capture = await runCurrentCli(distribution, 'installation-cli.cjs', ['capture-local-backup', '--runtime-profile', 'v28',
        '--configuration', configuration, '--archive', archive, '--installation', baseline.installationId,
        '--filesystem-root-owner-uid', String(baseline.rootOwnerUid)]);
      expect(capture.code).toBe(0); expect(capture.signal).toBeNull(); expect(capture.stderr).toBe('');
      const captured = canonicalFileObject(JSON.parse(capture.stdout));
      expect(captured.kind).toBe('stopped-local-v28-v5-capture/1'); expect(captured.sourceCheckpoint).toBe('portable-runtime/v28');
      expect(captured.nodeInstallationId).toBe(baseline.installationId); expect(captured.archiveFormat).toBe('v5');
      expect(captured.sourceAuthorityImported).toBe(false); expect(captured.sourceMutation).toBe(false);
      ensure(typeof captured.archiveSha256 === 'string' && /^[0-9a-f]{64}$/.test(captured.archiveSha256));
      expect(captured.completeness).toBe('complete'); expect(captured.packagedFiles).toBe(0); expect(captured.unavailableFiles).toBe(0);
      const admitted = await validateV28SystemBackupArchiveCandidate(await nodeRecoveryArchiveSource(archive),
        { ...NODE_RECOVERY_ARCHIVE_OPTIONS, expectedSha256: captured.archiveSha256 });
      expect(admitted.format).toBe('v5'); expect(admitted.manifest.completeness).toBe('complete');
      expect(admitted.manifest.counts.sources).toBe(0); expect(admitted.manifest.files).toEqual([]);
      expect(admitted.records.sourceMigrationLedger.kind).toBe('node-reviewed-migrations/1');
      expect(admitted.records.origin.capturePolicy).toBe('quiesced-writers-and-bytes/1');
      expect(admitted.records.image.tables.file_locations.rows).toEqual([]);
      const accounts = admitted.records.image.tables.local_accounts;
      const idIndex = accounts.columns.indexOf('principal_id');
      expect(idIndex).toBeGreaterThanOrEqual(0);
      expect(accounts.rows.some(row => { const cell = row.cells[idIndex]; return cell?.type === 'text' && cell.value === baseline.principalId; })).toBe(true);
      const destination = join(baseline.root, 'new-inert-destination');
      const restored = await runCurrentCli(distribution, 'restore-v28-cli.cjs', ['restore', '--archive', archive,
        '--destination', destination, '--sha256', captured.archiveSha256, '--filesystem-root-owner-uid', String(baseline.rootOwnerUid)]);
      expect(restored.code).toBe(0); expect(restored.signal).toBeNull(); expect(restored.stderr).toBe('');
      const receipt = canonicalFileObject(JSON.parse(restored.stdout));
      expect(receipt.kind).toBe('offline-v28-inert-restore/1'); expect(receipt.sourceArchiveSha256).toBe(captured.archiveSha256);
      expect(receipt.destinationCheckpoint).toBe('portable-runtime/v28'); expect(receipt.executionEnabled).toBe(false);
      const reportPath = join(destination, 'recovery-report.json'), reportBytes = await readFile(reportPath);
      const report = canonicalFileObject(JSON.parse(reportBytes.toString('utf8')));
      expect(report.maintenanceState).toBe('fenced'); expect(report.nativeBindingsRestored).toBe(false); expect(report.executionEnabled).toBe(false);
      expect(report.verification).toEqual({ exactTypedRows: true, exactRowids: true, foreignKeys: true, integrity: 'ok', reviewedSchema: true });
      const database = join(destination, 'database.sqlite'), stat = await lstat(database);
      expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600).toBe(true);
      // Root reads this private result to bind the NEXT original two cases.
      // The two-case beforeAll alone exclusively provisions the writer lock.
      await writeFile(output, JSON.stringify({ kind: 'current-v28-genuine-zero-File-source-and-CLI-restore/1',
        sourceInstallationId: baseline.installationId, archive, archiveSha256: captured.archiveSha256,
        sourceCheckpoint: 'portable-runtime/v28', archiveFormat: 'v5', completeness: 'complete', sourceFileCount: 0,
        destinationInstallationId: receipt.destinationInstallationId,
        environment: { CURRENT_V28_POST_RESTORE_DATABASE: database, CURRENT_V28_POST_RESTORE_PRINCIPAL: baseline.principalId,
          CURRENT_V28_POST_RESTORE_REPORT_SHA256: createHash('sha256').update(reportBytes).digest('hex') } }) + '\n',
      { flag: 'wx', mode: 0o600 });
    }), 20_000);
});
