import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { verifyNodeDistribution } from '../../scripts/lib/node-distribution-v28-manifest.mjs';
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource } from '../../scripts/lib/system-backup-node-io.ts';
import { validateV28SystemBackupArchiveCandidate } from '../../shared/contracts/system-backup-v5-archive-admission.ts';
import { validateFileUploadResult } from '../../shared/contracts/r2-upload.ts';
import { PORTABLE_RUNTIME_RECOVERY_TABLES as V26_TABLES } from '../../shared/contracts/portable-runtime-v26-recovery-catalog.ts';
import { FILE_SHADOW_HEAD_INTEGRITY_SQL } from '../../shared/contracts/export-file-shadow.ts';
import { stableJson } from '../../shared/domain/content-addressing.ts';
import { createNodeDevelopmentPrototype } from '../node-application.ts';
import { createPasswordHasher } from '../auth/passwords.ts';
import { loadNodeRuntimeConfiguration } from '../node-runtime-config.ts';
import { V26_NODE_INSTALLATION_CATALOG } from '../installation-catalog-v26.ts';
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from '../installation-catalog-v28-candidate.ts';
import { admitInstallationRecoverySource, assertInstallationAdmission } from '../migrations.ts';
import { executeCollaborationV28OperatorCandidate } from './collaboration-v28-operator-candidate.ts';
import { preparePresentHeadPublicV26Baseline } from './current-v28-present-head-bound-backup.qualification-support.ts';
import { CANONICAL_FILE_IDENTITY_POLICY, assertCanonicalFileOwnersReleased, canonicalFileClient,
  canonicalFileObject, canonicalFilePrivateOrigin, consumeCanonicalFileClient, listenCanonicalFileApplication,
  retainedCanonicalFileCase, withCanonicalFileDatabase } from '../collaboration/current-v28-canonical-comment-file.qualification-support.ts';
import { currentV28RecoveryImageRows, currentV28RecoveryTypedRows,
  CURRENT_V28_RECOVERY_PHYSICAL_TABLES } from '../recovery/current-v28-online-recovery.qualification-support.ts';
import { runCurrentCli } from './current-v28-backup-cli.qualification-support.ts';

const RESERVE = 603_979_776n;
const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRXsAAAAASUVORK5CYII=', 'base64'));
const digest = createHash('sha256').update(bytes).digest('hex');
const title = 'captures one genuine public Run Step LOCAL binding with its naturally issued present head through stopped V28 upgrade and complete V5 capture';
let distribution: string, output: string;
function ensure(value: unknown): asserts value { if (!value) throw new Error('Current genuine present-head V5 producer unavailable'); }
beforeAll(async () => {
  distribution = process.env.NODE_OFFLINE_V28_DISTRIBUTION ?? '';
  output = process.env.CURRENT_V28_PRESENT_HEAD_BOUND_BACKUP_RECEIPT ?? '';
  const parent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT ?? '';
  ensure(isAbsolute(distribution) && resolve(distribution) === distribution && await realpath(distribution) === distribution
    && isAbsolute(output) && resolve(output) === output && isAbsolute(parent) && resolve(parent) === parent);
  for (const path of [parent, tmpdir()]) { const free = statfsSync(path, { bigint: true }); ensure(free.bavail * free.bsize >= RESERVE); }
  const manifest = await verifyNodeDistribution(distribution, { enforceRuntimeVersion: true });
  expect(manifest.version).toBe(3); expect(manifest.offlineRecoveryCheckpoint.archiveFormat).toBe('v5');
}, 20_000);

// The current V28 business surface does not mount this V26 File metadata route.
// Use the original genuine V26 owner, close it completely, and then execute the
// original stopped upgrade. Neither its Request nor its authority enters V28.
// No business/File/consumer/shadow/rights rows are written by qualification SQL.
describe('current genuine present-head bound Run Step File producer', () => {
  it(title, () => retainedCanonicalFileCase(async () => {
    const baseline = await preparePresentHeadPublicV26Baseline(), uploadRequestId = randomUUID();
    const names = V26_TABLES.filter(table => !table.local).map(table => table.name);
    const produced = await withCanonicalFileDatabase(baseline.path, async (owner, lease, native, core) => {
      const admission = admitInstallationRecoverySource(native, V26_NODE_INSTALLATION_CATALOG);
      expect(assertInstallationAdmission(native, admission).installationId).toBe(baseline.installationId);
      const origin = await canonicalFilePrivateOrigin(owner), configurationPath = join(baseline.root, 'present-head-v26-public-source.json');
      await writeFile(configurationPath, JSON.stringify({ format: 'node-loopback-development-v1',
        dataDirectory: baseline.dataDirectory, expectedInstallationId: baseline.installationId, publicOrigin: origin,
        clientDirectory: baseline.clientDirectory, localVolumes: baseline.descriptors,
        enableLocalFile: true, enableLocalJobs: false }), { flag: 'wx', mode: 0o600 });
      const configuration = loadNodeRuntimeConfiguration(configurationPath, { filesystemRootOwnerUid: baseline.rootOwnerUid });
      owner.applicationAttempted = true;
      owner.originalApplication = Promise.resolve().then(() => createNodeDevelopmentPrototype({
        database: core, nativeDatabase: native, writerLease: lease, admission, hasher: createPasswordHasher(),
        identityPolicy: CANONICAL_FILE_IDENTITY_POLICY, now: Date.now, publicOrigin: origin,
        clientDirectory: baseline.clientDirectory, localFileConfiguration: configuration,
        httpLimits: { timeoutMs: 5000, maxBodyBytes: 2_500_000 },
      }));
      owner.application = await owner.originalApplication;
      await listenCanonicalFileApplication(owner, origin);
      const client = canonicalFileClient(owner, origin), session = await client.login('operator');
      const upload = await client.raw('/api/assets', 'POST', session, bytes, { 'content-type': 'image/png',
        'x-filename': 'genuine-present-head-local.png', 'x-upload-request-id': uploadRequestId });
      expect(upload.response.status).toBe(201);
      const accepted = validateFileUploadResult(await consumeCanonicalFileClient(upload.client, 'json'));
      ensure(accepted.key === null);
      expect(accepted.storageKind).toBe('native'); expect(accepted.key).toBeNull(); expect(accepted.deduplicated).toBe(false);
      ensure(typeof accepted.fileId === 'string' && typeof accepted.id === 'string');
      const { sampleId, runId } = baseline.target;
      // Read actual public-created CAS values; this SELECT issues no authority
      // and performs no fixture mutation. The original route checks them again.
      const step = native.prepare(`SELECT rs.id,rs.status,rs.updated_at,COALESCE(rs.title,sd.name) title,
        COALESCE(rs.tool_name,sd.tool_name,'') tool_name,COALESCE(rs.parameters_text,sd.parameters_text,'') parameters_text,
        COALESCE(rs.comments_text,sd.comments_text,'') comments_text,COALESCE(rs.deviation_note,'') deviation_note,
        COALESCE(rs.notes,'') notes FROM run_steps rs LEFT JOIN step_definitions sd ON sd.hash=rs.definition_hash
        WHERE rs.run_id=? AND rs.deleted_at IS NULL ORDER BY rs.position`).get(runId);
      ensure(step && typeof step.id === 'string' && typeof step.updated_at === 'string' && typeof step.title === 'string');
      const attached = await client.request(`/api/samples/${sampleId}/runs/${runId}/steps/${step.id}`, 'PATCH', {
        status: step.status, title: step.title, toolName: step.tool_name, parametersText: step.parameters_text,
        commentsText: step.comments_text, deviationNote: step.deviation_note, notes: step.notes,
        expectedUpdatedAt: step.updated_at, assetId: accepted.id,
      }, session);
      expect(attached.status).toBe(200); expect(attached.value).toMatchObject({ ok: true });
      const consumer = native.prepare(`SELECT id,run_step_id,asset_id,file_id,role FROM run_step_assets
        WHERE run_step_id=? AND asset_id=? AND deleted_at IS NULL AND superseded_by_occurrence_id IS NULL`).get(step.id, accepted.id);
      ensure(consumer && typeof consumer.id === 'string');
      expect(consumer).toMatchObject({ run_step_id: step.id, asset_id: accepted.id, file_id: accepted.fileId, role: 'execution' });
      const heads = native.prepare('SELECT * FROM file_shadow_heads WHERE present=1').all(); expect(heads).toHaveLength(1);
      const head = heads[0]!;
      expect(head).toMatchObject({ consumer_kind: 'run_step_asset', consumer_id: consumer.id, consumer_sub_id: '', file_slot: 'primary', present: 1 });
      ensure(typeof head.occurrence_id === 'string' && typeof head.source_json === 'string'
        && typeof head.generation === 'number' && Number.isSafeInteger(head.generation) && head.generation >= 1);
      const occurrence = native.prepare('SELECT * FROM file_shadow_occurrences WHERE id=?').get(head.occurrence_id);
      expect(occurrence).toMatchObject({ consumer_kind: 'run_step_asset', consumer_id: consumer.id, generation: head.generation,
        present: 1, source_rowid: head.source_rowid, source_json: head.source_json, legacy_store_kind: null,
        legacy_provider: null, legacy_object_key: null, expected_purpose: 'embedded_content' });
      expect(native.prepare(FILE_SHADOW_HEAD_INTEGRITY_SQL).get()?.invalid_count).toBe(0);
      // Frozen0007's relational Run Step slot records unknown purpose;
      // frozen0008's execution shadow independently records embedded content.
      // The real PATCH also creates its exact native image event binding.
      const events = native.prepare('SELECT id,sample_id,kind,asset_key,asset_file_id,metadata_json FROM events WHERE asset_file_id=?')
        .all(accepted.fileId); expect(events).toHaveLength(1); const event = events[0]!;
      ensure(typeof event.id === 'string' && typeof event.metadata_json === 'string');
      expect(event).toMatchObject({ sample_id: sampleId, kind: 'image', asset_key: null, asset_file_id: accepted.fileId });
      expect(JSON.parse(event.metadata_json)).toEqual({ runId, stepId: step.id, runStepAssetId: consumer.id, assetId: accepted.id });
      const nativeConsumerBindings = native.prepare(`SELECT consumer_kind AS consumerKind,consumer_id AS consumerId,
        consumer_sub_id AS consumerSubId,file_slot AS fileSlot,file_id AS fileId,expected_purpose AS purpose
        FROM file_consumer_projection WHERE file_id=?`).all(accepted.fileId)
        .sort((a,b) => stableJson(a) < stableJson(b) ? -1 : stableJson(a) > stableJson(b) ? 1 : 0);
      const exactBindings = [
        { consumerKind: 'run_step_asset', consumerId: consumer.id, consumerSubId: '', fileSlot: 'primary', fileId: accepted.fileId, purpose: null },
        { consumerKind: 'event', consumerId: event.id, consumerSubId: '', fileSlot: 'primary', fileId: accepted.fileId, purpose: 'embedded_content' },
      ].sort((a,b) => stableJson(a) < stableJson(b) ? -1 : stableJson(a) > stableJson(b) ? 1 : 0);
      expect(stableJson(nativeConsumerBindings)).toBe(stableJson(exactBindings));
      expect(native.prepare('SELECT count(*) n FROM files').get()?.n).toBe(1);
      expect(native.prepare('SELECT count(*) n FROM file_locations').get()?.n).toBe(1);
      const download = await client.raw(accepted.url, 'GET', session);
      expect(download.response.status).toBe(200);
      const body = await consumeCanonicalFileClient(download.client, 'arrayBuffer'); ensure(body instanceof ArrayBuffer);
      expect(new Uint8Array(body)).toEqual(bytes);
      const source = canonicalFileObject(JSON.parse(head.source_json)), dependency = canonicalFileObject(source._dependencies);
      const revision = native.prepare("SELECT count(*) n FROM file_shadow_dependency_versions WHERE dependency_kind IN('storage_profiles','storage_profile_runtime')").get()?.n;
      ensure(typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0);
      expect(dependency.profileRevision).toBe(revision);
      return { fileId: accepted.fileId, assetId: accepted.id, sampleId, runId, stepId: step.id, consumerId: consumer.id, eventId: event.id, nativeConsumerBindings,
        headGeneration: head.generation, sourceProfileRevision: revision, headOccurrenceId: head.occurrence_id,
        rows: currentV28RecoveryTypedRows(native, names), physical: currentV28RecoveryTypedRows(native, CURRENT_V28_RECOVERY_PHYSICAL_TABLES) };
    });
    assertCanonicalFileOwnersReleased();
    const upgraded = await executeCollaborationV28OperatorCandidate({ kind: 'upgrade-metadata', databasePath: baseline.path,
      filesystemRootOwnerUid: baseline.rootOwnerUid });
    expect(upgraded.installationId).toBe(baseline.installationId); expect(upgraded.checkpointId).toBe('portable-runtime/v28');
    await withCanonicalFileDatabase(baseline.path, async (_owner, lease, native) => lease.withWriter(async () => {
      expect(assertInstallationAdmission(native, admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE))
        .installationId).toBe(baseline.installationId);
      expect(currentV28RecoveryTypedRows(native, names)).toEqual(produced.rows);
      expect(currentV28RecoveryTypedRows(native, CURRENT_V28_RECOVERY_PHYSICAL_TABLES)).toEqual(produced.physical);
      expect(native.prepare(FILE_SHADOW_HEAD_INTEGRITY_SQL).get()?.invalid_count).toBe(0);
      expect(native.prepare('SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL').get()?.n).toBe(0);
    }));
    assertCanonicalFileOwnersReleased();
    const configuration = join(baseline.root, 'present-head-current-capture.json'), archive = join(baseline.root, 'genuine-present-head-original-v5.zip');
    await writeFile(configuration, JSON.stringify({ schema: 'stopped-local-v28-capture/1', databasePath: baseline.path,
      descriptors: baseline.descriptors }), { flag: 'wx', mode: 0o600 });
    const capture = await runCurrentCli(distribution, 'installation-cli.cjs', ['capture-local-backup', '--runtime-profile', 'v28',
      '--configuration', configuration, '--archive', archive, '--installation', baseline.installationId,
      '--filesystem-root-owner-uid', String(baseline.rootOwnerUid)]);
    expect(capture.code).toBe(0); expect(capture.signal).toBeNull(); expect(capture.stderr).toBe('');
    const captured = canonicalFileObject(JSON.parse(capture.stdout));
    expect(captured).toMatchObject({ kind: 'stopped-local-v28-v5-capture/1', nodeInstallationId: baseline.installationId,
      sourceCheckpoint: 'portable-runtime/v28', archiveFormat: 'v5', completeness: 'complete', packagedFiles: 1,
      unavailableFiles: 0, sourceAuthorityImported: false, sourceMutation: false });
    ensure(typeof captured.archiveSha256 === 'string' && /^[a-f0-9]{64}$/.test(captured.archiveSha256));
    const admitted = await validateV28SystemBackupArchiveCandidate(await nodeRecoveryArchiveSource(archive), {
      ...NODE_RECOVERY_ARCHIVE_OPTIONS, expectedSha256: captured.archiveSha256 });
    expect(admitted.records.sourceMigrationLedger).toMatchObject({ kind: 'node-reviewed-migrations/1', installationId: baseline.installationId });
    expect(admitted.records.origin.capturePolicy).toBe('quiesced-writers-and-bytes/1');
    expect(admitted.manifest.completeness).toBe('complete'); expect(admitted.manifest.files).toHaveLength(1);
    const file = admitted.manifest.files[0]!;
    expect(file).toMatchObject({ byteSize: bytes.byteLength, sha256: digest, fileIds: [produced.fileId], purposes: ['embedded_content'],
      source: { provider: 'local', fileId: produced.fileId, purpose: 'embedded_content' } });
    expect(stableJson(file.bindings)).toBe(stableJson(produced.nativeConsumerBindings));
    ensure(file.source.provider === 'local' && 'consumerBindings' in file.source);
    expect(stableJson(file.bindings)).toBe(stableJson(file.source.consumerBindings));
    for (const name of names) expect(currentV28RecoveryImageRows(admitted.records.image.tables[name]!)).toEqual(produced.rows[name]);
    await withCanonicalFileDatabase(baseline.path, async (_owner, lease, native) => lease.withWriter(async () => {
      expect(currentV28RecoveryTypedRows(native, names)).toEqual(produced.rows);
      expect(currentV28RecoveryTypedRows(native, CURRENT_V28_RECOVERY_PHYSICAL_TABLES)).toEqual(produced.physical);
      expect(native.prepare(FILE_SHADOW_HEAD_INTEGRITY_SQL).get()?.invalid_count).toBe(0);
    }));
    assertCanonicalFileOwnersReleased();
    expect(createHash('sha256').update(await readFile(archive)).digest('hex')).toBe(captured.archiveSha256);
    await writeFile(output, stableJson({ schema: 'current-genuine-present-head-bound-node-run-step-v5-producer/1', runtime: process.versions.node,
      distribution, sourceInstallationId: baseline.installationId, archive, archiveSha256: captured.archiveSha256,
      fileId: produced.fileId, assetId: produced.assetId, sampleId: produced.sampleId, runId: produced.runId, stepId: produced.stepId,
      consumerId: produced.consumerId, eventId: produced.eventId, payloadBytes: bytes.byteLength, payloadSha256: digest, presentHeads: 1,
      headGeneration: produced.headGeneration, headOccurrenceId: produced.headOccurrenceId, sourceProfileRevision: produced.sourceProfileRevision,
      genuineOriginalV26PublicProducer: true, stoppedV28UpgradeAfterOriginalClose: true, currentVerifiedCompiledStoppedCapture: true,
      noBusinessSqlSeed: true, naturallyIssuedHead: true, nativeConsumerBindings: file.bindings,
      oldTypedRowsAndRowidsUnchanged: true, sourceUnchanged: true, originalCloseAcknowledged: true }), { flag: 'wx', mode: 0o600 });
  }), 120_000);
});
