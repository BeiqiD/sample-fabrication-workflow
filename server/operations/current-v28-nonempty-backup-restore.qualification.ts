import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { validateFileUploadResult } from '../../shared/contracts/r2-upload';
import { stableJson } from '../../shared/domain/content-addressing';
import { recoveryTableSnapshotSql, type SystemRecoveryTable } from '../../shared/contracts/system-recovery-image';
import { PORTABLE_RUNTIME_RECOVERY_TABLES } from '../../shared/contracts/portable-runtime-v28-recovery-catalog';
import { PORTABLE_RUNTIME_SEED_TABLE_ROWS } from '../../worker/recovery/portable-runtime-v28-trusted-schema';
import { validateV28SystemBackupArchiveCandidate } from '../../shared/contracts/system-backup-v5-archive-admission';
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource, nodeRecoveryFileSha256 } from '../../scripts/lib/system-backup-node-io';
import { verifyNodeDistribution } from '../../scripts/lib/node-distribution-v28-manifest.mjs';
import { createNodeDevelopmentPrototype } from '../node-application';
import { createPasswordHasher } from '../auth/passwords';
import { loadNodeRuntimeConfiguration } from '../node-runtime-config';
import { V26_NODE_INSTALLATION_CATALOG } from '../installation-catalog-v26';
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from '../installation-catalog-v28-candidate';
import { admitInstallationRecoverySource, assertInstallationAdmission } from '../migrations';
import { prepareGenuineLocalFileV26Baseline, type GenuineLocalFileV26Baseline } from '../collaboration/current-final-fabublox-genuine-process.qualification-support';
import { CANONICAL_FILE_IDENTITY_POLICY, canonicalFileClient, canonicalFileObject, canonicalFilePrivateOrigin,
  consumeCanonicalFileClient, listenCanonicalFileApplication, retainedCanonicalFileCase, withCanonicalFileDatabase } from '../collaboration/current-v28-canonical-comment-file.qualification-support';
import { executeCollaborationV28OperatorCandidate } from './collaboration-v28-operator-candidate';
import { runCurrentCli } from './current-v28-backup-cli.qualification-support';

// This is one NEW ordinary-upload source and one NEW inert restoration. The
// zero-File case remains separately selected. No imported Fabu/Comment location,
// domain seed, restored profile grant or historical target substitutes for it.
const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRXsAAAAASUVORK5CYII=', 'base64'));
const digest = createHash('sha256').update(bytes).digest('hex');
const TABLES = ['assets', 'files', 'file_locations', 'file_location_publications', 'file_publications', 'file_acceptance_candidates', 'r2_upload_requests'] as const;
const TEMPLATE_TABLES = ['recipe_families', 'template_versions', 'template_steps', 'step_definitions'] as const;
const RESERVE = 603_979_776n;
let baseline: GenuineLocalFileV26Baseline, distribution: string, output: string;
function ensure(value: unknown): asserts value { if (!value) throw new Error('Current genuine nonempty V28 backup qualification unavailable'); }
interface TypedRow { rowid: string | null; cells: string }
function ordered(rows: TypedRow[]): TypedRow[] {
  return rows.sort((a, b) => stableJson(a) < stableJson(b) ? -1 : stableJson(a) > stableJson(b) ? 1 : 0);
}
function imageRows(table: SystemRecoveryTable): TypedRow[] {
  return ordered(table.rows.map(row => ({ rowid: row.rowid, cells: stableJson(row.cells) })));
}
function readMetadata(native: DatabaseSync, names: readonly string[] = TABLES): Record<string, TypedRow[]> {
  return Object.fromEntries(names.map(name => {
    const spec = PORTABLE_RUNTIME_RECOVERY_TABLES.find(value => value.name === name);
    ensure(spec);
    const rows = native.prepare(recoveryTableSnapshotSql(spec)).all().map(row => {
      ensure((row.rowid === null || typeof row.rowid === 'string') && typeof row.cells === 'string');
      const cells: unknown = JSON.parse(row.cells);
      return { rowid: row.rowid, cells: stableJson(cells) };
    });
    return [name, ordered(rows)];
  }));
}
beforeAll(() => retainedCanonicalFileCase(async () => {
  distribution = process.env.NODE_OFFLINE_V28_DISTRIBUTION ?? '';
  output = process.env.CURRENT_V28_NONEMPTY_BACKUP_RECEIPT ?? '';
  const parent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT ?? '';
  ensure(isAbsolute(distribution) && resolve(distribution) === distribution && await realpath(distribution) === distribution
    && isAbsolute(output) && resolve(output) === output && isAbsolute(parent) && resolve(parent) === parent);
  for (const directory of [parent, tmpdir()]) {
    const free = statfsSync(directory, { bigint: true }); ensure(free.bavail * free.bsize >= RESERVE);
  }
  const manifest = await verifyNodeDistribution(distribution, { enforceRuntimeVersion: true });
  expect(manifest.version).toBe(3); expect(manifest.offlineRecoveryCheckpoint.id).toBe('portable-runtime/v28');
  expect(manifest.offlineRecoveryCheckpoint.archiveFormat).toBe('v5');
  baseline = await prepareGenuineLocalFileV26Baseline();
}), 20_000);

describe('current genuine one-File V28 V5 backup into an inert destination', () => {
  it('preserves one real ordinary HTTP upload through stopped upgrade, compiled complete capture and compiled inert restore without destination File authority',
    () => retainedCanonicalFileCase(async () => {
      const uploadRequestId = randomUUID();
      const accepted = await withCanonicalFileDatabase(baseline.path, async (owner, lease, native, core) => {
        const admission = admitInstallationRecoverySource(native, V26_NODE_INSTALLATION_CATALOG);
        expect(assertInstallationAdmission(native, admission).installationId).toBe(baseline.installationId);
        const origin = await canonicalFilePrivateOrigin(owner), configPath = join(baseline.root, 'nonempty-source-runtime.json');
        await writeFile(configPath, JSON.stringify({ format: 'node-loopback-development-v1', dataDirectory: baseline.dataDirectory,
          expectedInstallationId: baseline.installationId, publicOrigin: origin, clientDirectory: baseline.clientDirectory,
          localVolumes: baseline.descriptors, enableLocalFile: true, enableLocalJobs: false }), { flag: 'wx', mode: 0o600 });
        const configuration = loadNodeRuntimeConfiguration(configPath, { filesystemRootOwnerUid: baseline.rootOwnerUid });
        owner.applicationAttempted = true;
        owner.originalApplication = Promise.resolve().then(() => createNodeDevelopmentPrototype({ database: core, nativeDatabase: native,
          writerLease: lease, admission, hasher: createPasswordHasher(), identityPolicy: CANONICAL_FILE_IDENTITY_POLICY, now: Date.now,
          publicOrigin: origin, clientDirectory: baseline.clientDirectory, localFileConfiguration: configuration,
          httpLimits: { timeoutMs: 5000, maxBodyBytes: 2_500_000 } }));
        owner.application = await owner.originalApplication;
        await listenCanonicalFileApplication(owner, origin);
        const client = canonicalFileClient(owner, origin), session = await client.login('operator');
        const headers = { 'content-type': 'image/png', 'x-filename': 'genuine-nonempty-original.png', 'x-upload-request-id': uploadRequestId };
        const first = await client.raw('/api/assets', 'POST', session, bytes, headers);
        expect(first.response.status).toBe(201);
        const result = validateFileUploadResult(await consumeCanonicalFileClient(first.client, 'json'));
        ensure(result.key === null); expect(result.storageKind).toBe('native'); expect(result.deduplicated).toBe(false);
        const replay = await client.raw('/api/assets', 'POST', session, bytes, headers);
        expect(replay.response.status).toBe(200);
        expect(validateFileUploadResult(await consumeCanonicalFileClient(replay.client, 'json'))).toEqual(result);
        const originalRead = await client.raw(result.url, 'GET', session);
        expect(originalRead.response.status).toBe(200);
        const delivered = await consumeCanonicalFileClient(originalRead.client, 'arrayBuffer'); ensure(delivered instanceof ArrayBuffer);
        expect(new Uint8Array(delivered)).toEqual(bytes); expect(createHash('sha256').update(new Uint8Array(delivered)).digest('hex')).toBe(digest);
        return result;
      }); // Original client EOF, whole-app first close, Native and Linux lease ACK precede upgrade.
      const beforeUpgrade = await withCanonicalFileDatabase(baseline.path, async (_owner, lease, native) => lease.withWriter(async () => {
        expect(native.prepare('SELECT count(*) n FROM file_locations').get()?.n).toBe(1);
        expect(native.prepare('SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL').get()?.n).toBe(0);
        expect(native.prepare('SELECT actor_email,ingress,purpose,request_scope,status FROM r2_upload_requests WHERE client_request_id=?').get(uploadRequestId))
          .toEqual({ actor_email: baseline.operatorActor, ingress: 'ordinary_image', purpose: 'embedded_content', request_scope: 'system', status: 'ready' });
        // Reviewed installation includes retired builtin templates. Capture all
        // actual typed cells/rowids, including family IDs and version content,
        // and require the original seed rather than inventing an empty domain.
        const templates = readMetadata(native, TEMPLATE_TABLES);
        for (const table of TEMPLATE_TABLES) expect(templates[table]).toEqual(imageRows(PORTABLE_RUNTIME_SEED_TABLE_ROWS[table]!));
        for (const table of ['samples', 'runs']) expect(native.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(0);
        return { files: readMetadata(native), templates };
      }));
      const upgrade = await executeCollaborationV28OperatorCandidate({ kind: 'upgrade-metadata', databasePath: baseline.path,
        filesystemRootOwnerUid: baseline.rootOwnerUid });
      expect(upgrade.installationId).toBe(baseline.installationId); expect(upgrade.checkpointId).toBe('portable-runtime/v28');
      const afterUpgradeResources = await withCanonicalFileDatabase(baseline.path, async (_owner, lease, native) => lease.withWriter(async () => {
        expect(assertInstallationAdmission(native, admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE)).installationId)
          .toBe(baseline.installationId);
        expect(readMetadata(native)).toEqual(beforeUpgrade.files);
        expect(readMetadata(native, TEMPLATE_TABLES)).toEqual(beforeUpgrade.templates);
        for (const table of ['samples', 'runs', 'collaboration_members', 'collaboration_identities', 'collaboration_grants'])
          expect(native.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(0);
        // Family content is portable; Group roots are installation-local. This
        // case invokes no enrollment or root-allocation operation, so require
        // the reviewed empty local seed instead of inventing builtin grants.
        const resources = readMetadata(native, ['collaboration_resources']);
        expect(resources.collaboration_resources).toEqual(imageRows(PORTABLE_RUNTIME_SEED_TABLE_ROWS.collaboration_resources!));
        return resources;
      }));
      const configuration = join(baseline.root, 'nonempty-capture.json'), archive = join(baseline.root, 'complete-one-File-v5.zip');
      await writeFile(configuration, JSON.stringify({ schema: 'stopped-local-v28-capture/1', databasePath: baseline.path,
        descriptors: baseline.descriptors }), { flag: 'wx', mode: 0o600 });
      const capture = await runCurrentCli(distribution, 'installation-cli.cjs', ['capture-local-backup', '--runtime-profile', 'v28',
        '--configuration', configuration, '--archive', archive, '--installation', baseline.installationId,
        '--filesystem-root-owner-uid', String(baseline.rootOwnerUid)]);
      expect(capture.code).toBe(0); expect(capture.signal).toBeNull(); expect(capture.stderr).toBe('');
      const captured = canonicalFileObject(JSON.parse(capture.stdout));
      expect(captured.kind).toBe('stopped-local-v28-v5-capture/1'); expect(captured.nodeInstallationId).toBe(baseline.installationId);
      expect(captured.sourceCheckpoint).toBe('portable-runtime/v28'); expect(captured.archiveFormat).toBe('v5');
      expect(captured.completeness).toBe('complete'); expect(captured.packagedFiles).toBe(1); expect(captured.unavailableFiles).toBe(0);
      expect(captured.sourceAuthorityImported).toBe(false); expect(captured.sourceMutation).toBe(false);
      ensure(typeof captured.archiveSha256 === 'string' && /^[0-9a-f]{64}$/.test(captured.archiveSha256));
      const admitted = await validateV28SystemBackupArchiveCandidate(await nodeRecoveryArchiveSource(archive),
        { ...NODE_RECOVERY_ARCHIVE_OPTIONS, expectedSha256: captured.archiveSha256 });
      expect(admitted.manifest.completeness).toBe('complete');
      expect(admitted.manifest.counts).toMatchObject({ sources: 1, packagedFiles: 1, unavailableFiles: 0, bytes: bytes.byteLength });
      expect(admitted.records.origin.capturePolicy).toBe('quiesced-writers-and-bytes/1');
      expect(admitted.records.sourceMigrationLedger).toMatchObject({ kind: 'node-reviewed-migrations/1', installationId: baseline.installationId });
      expect(admitted.manifest.files).toHaveLength(1);
      const file = admitted.manifest.files[0]!;
      expect(file).toMatchObject({ id: 'b_0000', path: 'files/b_0000', outcome: 'packaged', byteSize: bytes.byteLength,
        sha256: digest, fileIds: [accepted.fileId], purposes: ['embedded_content'], bindings: [] });
      expect(file.source).toMatchObject({ storeKind: 'file', provider: 'local', storageProfileId: baseline.internalProfileId,
        storageProfileRevision: 1, fileId: accepted.fileId, expectedByteSize: bytes.byteLength, expectedSha256: digest,
        initialOutcome: null, accessScope: 'system', purpose: 'embedded_content' });
      for (const table of TABLES) expect(imageRows(admitted.records.image.tables[table]!)).toEqual(beforeUpgrade.files[table]);
      for (const table of TEMPLATE_TABLES) expect(imageRows(admitted.records.image.tables[table]!)).toEqual(beforeUpgrade.templates[table]);
      // The V5 local-omitted policy excludes source Group authority entirely.
      expect(Object.hasOwn(admitted.records.image.tables, 'collaboration_resources')).toBe(false);
      expect(admitted.records.content.tables.file_locations).toHaveLength(1);
      expect(admitted.records.content.tables.file_acceptance_candidates).toHaveLength(1);
      expect(admitted.records.content.tables.file_acceptance_candidates[0]).toMatchObject({ acceptance_kind: 'r2_upload', item_id: '' });
      const destination = join(baseline.root, 'new-inert-one-File-destination');
      const restored = await runCurrentCli(distribution, 'restore-v28-cli.cjs', ['restore', '--archive', archive,
        '--destination', destination, '--sha256', captured.archiveSha256, '--filesystem-root-owner-uid', String(baseline.rootOwnerUid)]);
      expect(restored.code).toBe(0); expect(restored.signal).toBeNull(); expect(restored.stderr).toBe('');
      const receipt = canonicalFileObject(JSON.parse(restored.stdout));
      expect(receipt.kind).toBe('offline-v28-inert-restore/1'); expect(receipt.sourceArchiveSha256).toBe(captured.archiveSha256);
      expect(receipt.destinationCheckpoint).toBe('portable-runtime/v28'); expect(receipt.executionEnabled).toBe(false);
      ensure(typeof receipt.destinationInstallationId === 'string'); expect(receipt.destinationInstallationId).not.toBe(baseline.installationId);
      const reportBytes = await readFile(join(destination, 'recovery-report.json')), report = canonicalFileObject(JSON.parse(reportBytes.toString('utf8')));
      expect(report).toMatchObject({ destinationInstallationId: receipt.destinationInstallationId, destinationCheckpoint: 'portable-runtime/v28',
        payloads: 1, payloadBytes: bytes.byteLength, verifiedInertLocalVolumePayloads: 1,
        executionEnabled: false, nativeBindingsRestored: false, maintenanceState: 'fenced', providerIO: false });
      expect(report.verification).toEqual({ exactTypedRows: true, exactRowids: true, foreignKeys: true, integrity: 'ok', reviewedSchema: true });
      const payloadPath = join(destination, file.path!), payload = await readFile(payloadPath), payloadStat = await lstat(payloadPath);
      expect(payloadStat.isFile() && !payloadStat.isSymbolicLink() && payloadStat.nlink === 1 && (payloadStat.mode & 0o7777) === 0o600).toBe(true);
      expect(new Uint8Array(payload)).toEqual(bytes); expect(createHash('sha256').update(payload).digest('hex')).toBe(digest);
      expect((await nodeRecoveryFileSha256(join(destination, 'original-archive.zip'))).sha256).toBe(captured.archiveSha256);
      const mappingDocument = canonicalFileObject(JSON.parse((await readFile(join(destination, 'inert-local-volume-mappings.json'))).toString('utf8')));
      expect(mappingDocument.schema).toBe('offline-local-volume-source-mappings/v28');
      expect(mappingDocument.installationBindingsRestored).toBe(false); expect(mappingDocument.executionEnabled).toBe(false);
      expect(mappingDocument.mappings).toEqual([{ id: file.id, source: file.source, path: file.path, byteSize: file.byteSize,
        sha256: file.sha256, state: 'verified-offline-source' }]);
      const database = join(destination, 'database.sqlite');
      // Fixture lock provisioning only: no account/File/grant/runtime business SQL is written.
      await writeFile(`${database}.writer-lock`, '', { flag: 'wx', mode: 0o600 });
      await withCanonicalFileDatabase(database, async (_owner, lease, native) => lease.withWriter(async () => {
        const target = assertInstallationAdmission(native, admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE));
        expect(target.installationId).toBe(receipt.destinationInstallationId); expect(target.installationId).not.toBe(baseline.installationId);
        expect(readMetadata(native)).toEqual(beforeUpgrade.files);
        expect(readMetadata(native, TEMPLATE_TABLES)).toEqual(beforeUpgrade.templates);
        expect(readMetadata(native, ['collaboration_resources'])).toEqual(afterUpgradeResources);
        expect(native.prepare('SELECT mode FROM file_authority_control WHERE singleton=1').get()?.mode).toBe('active');
        expect(native.prepare('SELECT state FROM system_recovery_maintenance WHERE singleton=1').get()?.state).toBe('fenced');
        expect(native.prepare('SELECT enforcement FROM collaboration_control WHERE singleton=1').get()?.enforcement).toBe('disabled');
        expect(native.prepare('SELECT principal_id,enabled FROM local_accounts WHERE principal_id=?').get(baseline.principalId))
          .toEqual({ principal_id: baseline.principalId, enabled: 0 });
        for (const name of ['file_shadow_runtime_guard', 'file_authority_runtime_guard', 'file_job_runtime_guard', 'system_recovery_runtime'])
          expect(native.prepare(`SELECT enabled FROM ${name}`).get()?.enabled).toBe(0);
        for (const name of ['system_storage_native_bindings', 'local_storage_profile_checks', 'local_storage_profile_admissions', 'local_storage_profile_bindings',
          'local_identity_installation', 'local_admin_grants', 'local_sessions', 'samples', 'runs', 'collaboration_members', 'collaboration_identities', 'collaboration_grants', 'system_recovery_write_leases'])
          expect(native.prepare(`SELECT count(*) n FROM ${name}`).get()?.n).toBe(0);
      })); // Read-only inspection owner closes; no destination File/profile opening or enabling occurs.
      await writeFile(output, JSON.stringify({ kind: 'current-genuine-one-File-v28-v5-inert-restore/1', sourceInstallationId: baseline.installationId,
        destinationInstallationId: receipt.destinationInstallationId, sourceFileId: accepted.fileId, sourceAssetId: accepted.id,
        sourceFileCount: 1, payloadBytes: bytes.byteLength, payloadSha256: digest, archiveSha256: captured.archiveSha256,
        recoveryReportSha256: createHash('sha256').update(reportBytes).digest('hex'), executionEnabled: false, nativeBindingsRestored: false,
        maintenanceState: 'fenced', destinationProfileBound: false, originalReadPathsRetained: true }) + '\n', { flag: 'wx', mode: 0o600 });
    }), 20_000);
});
