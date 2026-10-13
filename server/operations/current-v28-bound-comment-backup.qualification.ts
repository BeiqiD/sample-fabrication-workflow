import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { verifyNodeDistribution } from '../../scripts/lib/node-distribution-v28-manifest.mjs';
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource } from '../../scripts/lib/system-backup-node-io.ts';
import { validateV28SystemBackupArchiveCandidate } from '../../shared/contracts/system-backup-v5-archive-admission.ts';
import { FILE_SHADOW_HEAD_INTEGRITY_SQL } from '../../shared/contracts/export-file-shadow.ts';
import { PORTABLE_RUNTIME_RECOVERY_TABLES } from '../../shared/contracts/portable-runtime-v28-recovery-catalog.ts';
import { stableJson } from '../../shared/domain/content-addressing.ts';
import { assertCanonicalFileOwnersReleased, canonicalFileObject, composeCanonicalCommentFileV28,
  consumeCanonicalFileClient, currentCanonicalFileTarget, prepareCanonicalCommentFileBaseline,
  retainedCanonicalFileCase, withCanonicalFileDatabase } from '../collaboration/current-v28-canonical-comment-file.qualification-support.ts';
import { currentV28RecoveryImageRows, currentV28RecoveryTypedRows } from '../recovery/current-v28-online-recovery.qualification-support.ts';
import { runCurrentCli } from './current-v28-backup-cli.qualification-support.ts';
import { observeOriginalSchemaScalar, type SchemaScalarMetric } from './current-v28-bound-schema-scalar-metric.qualification-support.ts';

// Qualification-only fixed phase facts. Invoke the original operation once,
// attach observation only, and return its exact original promise unchanged.
// No request/response data, IDs, paths, credentials, SQL or error text is logged.
type ProducerPhase = 'baseline' | 'producer-and-original-close' | 'compose' | 'login' | 'create'
  | 'upload-response' | 'upload-body' | 'finalize' | 'download-response' | 'download-body' | 'stopped-capture';
let phaseSequence = 0;
let schemaObservation: ReturnType<typeof observeOriginalSchemaScalar> | undefined;
function schemaDifference(before: Readonly<SchemaScalarMetric> | undefined) {
  if (!before || !schemaObservation) return null;
  const after = schemaObservation.snapshot();
  return { matchingPrepares: after.matchingPrepares - before.matchingPrepares,
    trackedStatements: after.trackedStatements - before.trackedStatements,
    getCalls: after.getCalls - before.getCalls, getMs: after.getMs - before.getMs,
    lifetimeMaximumGetMs: after.maximumGetMs, getFailures: after.getFailures - before.getFailures,
    unavailablePatches: after.unavailablePatches, restorationFailures: after.restorationFailures };
}
function originalProducerPhase<T>(phase: ProducerPhase, operation: () => Promise<T>): Promise<T> {
  const sequence = ++phaseSequence, startedAt = Date.now(), schemaBefore = schemaObservation?.snapshot();
  const report = (outcome: 'begin' | 'acknowledged' | 'failed') => {
    try { console.error('Original bound producer phase: ' + JSON.stringify({ phase, sequence, outcome,
      startedAtUTC: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt, schemaScalar: schemaDifference(schemaBefore) })); }
    catch { /* An observation failure does not replace the original outcome. */ }
  };
  report('begin');
  let original: Promise<T>;
  try { original = operation(); } catch (error) { report('failed'); throw error; }
  void original.then(() => report('acknowledged'), () => report('failed')).catch(() => undefined);
  return original;
}

// The frozen 0008 source-key view includes every non-link Comment item,
// including canonical-only attachments with no legacy locator. Verify the one
// public-created tuple and its complete chain; no observed head is an exemption.
// The fixed unpaired one-item/two-target public plan issues 3 create, 5 upload
// and 6 finalize snapshots: generations 3, 8 and 14. Finalize must change the
// two original Step and Sample timestamps, so those four events are required.
const immutableShadowTables = ['file_shadow_occurrences', 'file_shadow_closures',
  'file_shadow_dependency_versions', 'file_shadow_decisions'] as const;
function naturalCommentHead(native: DatabaseSync, itemId: string, submissionId: string, expectedGeneration: 3 | 8 | 14) {
  const heads = native.prepare('SELECT * FROM file_shadow_heads').all(); expect(heads).toHaveLength(1);
  const head = heads[0]!;
  expect(head).toMatchObject({ consumer_kind: 'comment_submission_item', consumer_id: itemId,
    consumer_sub_id: '', file_slot: 'primary', present: 1, generation: expectedGeneration });
  const source = native.prepare('SELECT * FROM file_shadow_sources_comment_submission_item_primary WHERE consumer_id=?').get(itemId);
  ensure(source && typeof head.source_json === 'string' && typeof head.occurrence_id === 'string'
    && typeof head.generation === 'number' && Number.isSafeInteger(head.generation) && head.generation >= 1);
  expect(source).toMatchObject({ consumer_kind: 'comment_submission_item', consumer_id: itemId,
    consumer_sub_id: '', file_slot: 'primary', legacy_store_kind: null, legacy_provider: null,
    legacy_object_key: null, expected_purpose: 'research_source' });
  expect(head.source_rowid).toBe(source.source_rowid); expect(head.source_json).toBe(source.source_json);
  const image = canonicalFileObject(JSON.parse(head.source_json));
  expect(image).toMatchObject({ id: itemId, submission_id: submissionId, kind: 'attachment',
    storage_object_id: null, resolved_r2_key: null, resolved_managed_provider: null,
    resolved_managed_key: null, expected_purpose: 'research_source', status: expectedGeneration === 3 ? 'pending' : 'ready' });
  const item = native.prepare('SELECT rowid source_rowid,asset_id,file_id FROM comment_submission_items WHERE id=? AND submission_id=?').get(itemId, submissionId);
  ensure(item); expect(source.source_rowid).toBe(item.source_rowid); expect(image.asset_id).toBe(item.asset_id);
  if (expectedGeneration === 3) { expect(item.asset_id).toBeNull(); expect(item.file_id).toBeNull(); }
  else {
    ensure(typeof item.asset_id === 'string' && typeof item.file_id === 'string');
    expect(native.prepare('SELECT file_id,r2_key,status FROM assets WHERE id=?').get(item.asset_id))
      .toEqual({ file_id: item.file_id, r2_key: null, status: 'ready' });
  }
  const dependencies = canonicalFileObject(image._dependencies);
  expect(dependencies.profileRevision).toBe(native.prepare("SELECT count(*) n FROM file_shadow_dependency_versions WHERE dependency_kind IN('storage_profiles','storage_profile_runtime')").get()?.n);
  const occurrences = native.prepare('SELECT * FROM file_shadow_occurrences ORDER BY generation').all();
  const closures = native.prepare('SELECT * FROM file_shadow_closures').all();
  expect(occurrences).toHaveLength(head.generation); expect(closures).toHaveLength(head.generation - 1);
  for (let index = 0; index < occurrences.length; index++) {
    const occurrence = occurrences[index]!;
    expect(occurrence).toMatchObject({ consumer_kind: 'comment_submission_item', consumer_id: itemId,
      consumer_sub_id: '', file_slot: 'primary', generation: index + 1, present: 1,
      source_rowid: source.source_rowid, legacy_store_kind: null, legacy_provider: null,
      legacy_object_key: null, expected_purpose: 'research_source' });
    if (index + 1 < occurrences.length) {
      const next = occurrences[index + 1]!;
      expect(closures.filter(row => row.occurrence_id === occurrence.id)).toEqual([{ occurrence_id: occurrence.id,
        successor_occurrence_id: next.id, closed_epoch: next.observed_epoch, closed_at: next.observed_at }]);
    } else {
      expect(occurrence.id).toBe(head.occurrence_id); expect(occurrence.source_json).toBe(head.source_json);
      expect(occurrence.observed_epoch).toBe(head.observed_epoch);
      expect(closures.filter(row => row.occurrence_id === occurrence.id)).toEqual([]);
    }
  }
  expect(native.prepare(FILE_SHADOW_HEAD_INTEGRITY_SQL).get()?.invalid_count).toBe(0);
  return { generation: head.generation, occurrenceId: head.occurrence_id,
    immutableRows: currentV28RecoveryTypedRows(native, immutableShadowTables) };
}
function preserveOriginalShadowRows(before: ReturnType<typeof naturalCommentHead>, after: ReturnType<typeof naturalCommentHead>) {
  expect(after.generation).toBeGreaterThan(before.generation);
  for (const name of immutableShadowTables) expect(after.immutableRows[name]).toEqual(expect.arrayContaining([...before.immutableRows[name]!]));
}

const RESERVE = 603_979_776n;
const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRXsAAAAASUVORK5CYII=', 'base64'));
const digest = createHash('sha256').update(bytes).digest('hex');
let distribution: string, output: string;
function ensure(value: unknown): asserts value { if (!value) throw new Error('Current genuine bound V5 producer unavailable'); }
beforeAll(async () => {
  distribution = process.env.NODE_OFFLINE_V28_DISTRIBUTION ?? '';
  output = process.env.CURRENT_V28_BOUND_COMMENT_BACKUP_RECEIPT ?? '';
  const parent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT ?? '';
  ensure(isAbsolute(distribution) && resolve(distribution) === distribution && await realpath(distribution) === distribution
    && isAbsolute(output) && resolve(output) === output && isAbsolute(parent) && resolve(parent) === parent);
  for (const path of [parent, tmpdir()]) { const free = statfsSync(path, { bigint: true }); ensure(free.bavail * free.bsize >= RESERVE); }
  const manifest = await verifyNodeDistribution(distribution, { enforceRuntimeVersion: true });
  expect(manifest.version).toBe(3); expect(manifest.offlineRecoveryCheckpoint.archiveFormat).toBe('v5');
}, 20_000);

// One NEW actual canonical Comment attachment producer and current verified
// compiled stopped capture. Existing ordinary unbound and shadow tests remain
// separate. No SQL business/account/authority/acceptance rows are test-seeded.
describe('current genuine bound canonical Comment File through compiled strict V5 capture', () => {
  it('captures one real bound LOCAL Comment attachment with its naturally issued present head and exact immutable typed history',
    () => retainedCanonicalFileCase(async () => {
      const baseline = await originalProducerPhase('baseline', () => prepareCanonicalCommentFileBaseline()), submissionId = randomUUID(), itemId = randomUUID();
      const produce = () => originalProducerPhase('producer-and-original-close', () => withCanonicalFileDatabase(baseline.path, async (owner, lease, native, core) => {
        schemaObservation = observeOriginalSchemaScalar(native);
        const app = await originalProducerPhase('compose', () => composeCanonicalCommentFileV28(owner, lease, native, core, baseline)),
          session = await originalProducerPhase('login', () => app.login('alice'));
        const input = { protocol: 'comment-submission/1', id: submissionId, body: 'Genuine bound recovery source',
          context: { kind: 'run_steps', scope: 'common', targets: baseline.targets.map(target => currentCanonicalFileTarget(native, target)) },
          items: [{ id: itemId, kind: 'attachment', filename: 'bound-original.bin', mimeType: 'application/octet-stream',
            byteSize: bytes.byteLength, sha256: digest, title: 'Bound original native bytes' }] };
        expect(input.context.targets).toHaveLength(2);
        expect(new Set(baseline.targets.map(target => target.stepId)).size).toBe(2);
        expect(new Set(baseline.targets.map(target => target.sampleId)).size).toBe(2);
        const targetSnapshots = baseline.targets.map(target => ({
          stepId: target.stepId, sampleId: target.sampleId,
          stepUpdatedAt: native.prepare('SELECT updated_at FROM run_steps WHERE id=?').get(target.stepId)?.updated_at,
          sampleUpdatedAt: native.prepare('SELECT updated_at FROM samples WHERE id=?').get(target.sampleId)?.updated_at,
        }));
        expect(native.prepare('SELECT count(*) n FROM file_shadow_heads').get()?.n).toBe(0);
        expect((await originalProducerPhase('create', () => app.request('/api/comment-submissions', 'POST', input, session))).status).toBe(201);
        const createdHead = naturalCommentHead(native, itemId, submissionId, 3);
        const upload = await originalProducerPhase('upload-response', () => app.raw(`/api/comment-submissions/${submissionId}/items/${itemId}/content`, 'PUT', session, bytes,
          { 'content-type': 'application/octet-stream', 'x-upload-size': String(bytes.byteLength), 'x-content-sha256': digest }));
        const uploaded = await originalProducerPhase('upload-body', () => consumeCanonicalFileClient(upload.client, 'text')); ensure(typeof uploaded === 'string');
        expect(upload.response.status).toBe(200); expect(JSON.parse(uploaded)).toMatchObject({ ok: true, request: { items: [{ id: itemId, status: 'ready' }] } });
        const uploadedHead = naturalCommentHead(native, itemId, submissionId, 8);
        preserveOriginalShadowRows(createdHead, uploadedHead);
        const finalized = await originalProducerPhase('finalize', () => app.request(`/api/comment-submissions/${submissionId}/finalize`, 'POST', undefined, session));
        expect(finalized.status).toBe(200); expect(finalized.value).toMatchObject({ ok: true, status: 'ready' });
        const row = native.prepare("SELECT file_id FROM comment_submission_items WHERE id=? AND submission_id=? AND status='ready'").get(itemId, submissionId);
        ensure(typeof row?.file_id === 'string'); const fileId = row.file_id;
        expect(native.prepare('SELECT count(*) n FROM files').get()?.n).toBe(1);
        expect(native.prepare('SELECT count(*) n FROM file_locations').get()?.n).toBe(1);
        for (const target of targetSnapshots) {
          expect(native.prepare('SELECT updated_at FROM run_steps WHERE id=?').get(target.stepId)?.updated_at).not.toBe(target.stepUpdatedAt);
          expect(native.prepare('SELECT updated_at FROM samples WHERE id=?').get(target.sampleId)?.updated_at).not.toBe(target.sampleUpdatedAt);
        }
        const finalHead = naturalCommentHead(native, itemId, submissionId, 14);
        preserveOriginalShadowRows(uploadedHead, finalHead);
        expect(native.prepare('SELECT count(*) n FROM file_consumer_projection WHERE file_id=?').get(fileId)?.n).toBeGreaterThan(0);
        const download = await originalProducerPhase('download-response', () => app.raw(`/api/attachments/${itemId}/download`, 'GET', session));
        const body = await originalProducerPhase('download-body', () => consumeCanonicalFileClient(download.client, 'arrayBuffer')); ensure(body instanceof ArrayBuffer);
        expect(download.response.status).toBe(200); expect(new Uint8Array(body)).toEqual(bytes);
        const names = PORTABLE_RUNTIME_RECOVERY_TABLES.filter(table => !table.local).map(table => table.name);
        return { fileId, names, headGeneration: finalHead.generation, headOccurrenceId: finalHead.occurrenceId,
          rows: currentV28RecoveryTypedRows(native, names) };
      }));
      let produced!: Awaited<ReturnType<typeof produce>>;
      let originalFailed = false, originalFailure: unknown, restorationFailed = false, restorationFailure: unknown;
      try { produced = await produce(); } catch (error) { originalFailed = true; originalFailure = error; }
      try { schemaObservation?.restore(); } catch (error) { restorationFailed = true; restorationFailure = error; }
      try { console.error('Original bound producer schema scalar final: ' + JSON.stringify(schemaObservation?.snapshot() ?? null)); }
      catch { /* Observation does not replace the original outcome. */ }
      if (!restorationFailed) schemaObservation = undefined;
      if (restorationFailed) throw originalFailed
        ? new AggregateError([originalFailure, restorationFailure], 'Original producer and schema observer restoration failed') : restorationFailure;
      if (originalFailed) throw originalFailure;
      assertCanonicalFileOwnersReleased();
      const configuration = join(baseline.root, 'bound-current-capture.json'), archive = join(baseline.root, 'genuine-bound-original-v5.zip');
      await writeFile(configuration, JSON.stringify({ schema: 'stopped-local-v28-capture/1', databasePath: baseline.path,
        descriptors: baseline.descriptors }), { flag: 'wx', mode: 0o600 });
      const capture = await originalProducerPhase('stopped-capture', () => runCurrentCli(distribution, 'installation-cli.cjs', ['capture-local-backup', '--runtime-profile', 'v28',
        '--configuration', configuration, '--archive', archive, '--installation', baseline.installationId,
        '--filesystem-root-owner-uid', String(baseline.rootOwnerUid)]));
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
      expect(file).toMatchObject({ byteSize: bytes.byteLength, sha256: digest, fileIds: [produced.fileId], purposes: ['research_source'],
        source: { provider: 'local', fileId: produced.fileId, purpose: 'research_source' } });
      expect(file.bindings.length).toBeGreaterThan(0); expect(file.bindings).toEqual(expect.arrayContaining([{ consumerKind: 'comment_submission_item',
        consumerId: itemId, consumerSubId: '', fileSlot: 'primary', fileId: produced.fileId, purpose: 'research_source' }]));
      ensure(file.source.provider === 'local' && 'consumerBindings' in file.source);
      expect(stableJson(file.bindings)).toBe(stableJson(file.source.consumerBindings));
      for (const name of produced.names) expect(currentV28RecoveryImageRows(admitted.records.image.tables[name]!)).toEqual(produced.rows[name]);
      await withCanonicalFileDatabase(baseline.path, async (_owner, lease, native) => lease.withWriter(async () => {
        expect(currentV28RecoveryTypedRows(native, produced.names)).toEqual(produced.rows);
        const retainedHead = naturalCommentHead(native, itemId, submissionId, 14);
        expect(retainedHead.generation).toBe(produced.headGeneration);
        expect(retainedHead.occurrenceId).toBe(produced.headOccurrenceId);
      }));
      assertCanonicalFileOwnersReleased();
      expect(createHash('sha256').update(await readFile(archive)).digest('hex')).toBe(captured.archiveSha256);
      await writeFile(output, stableJson({ schema: 'current-genuine-bound-node-comment-v5-producer/1', runtime: process.versions.node,
        distribution, sourceInstallationId: baseline.installationId, archive, archiveSha256: captured.archiveSha256,
        fileId: produced.fileId, submissionId, itemId, payloadBytes: bytes.byteLength, payloadSha256: digest,
        genuineOriginalCommentProducer: true, currentVerifiedCompiledStoppedCapture: true, noBusinessSqlSeed: true,
        nativeConsumerBindings: file.bindings, presentHeads: 1, headGeneration: produced.headGeneration,
        headOccurrenceId: produced.headOccurrenceId, naturallyIssuedCommentHead: true, immutableSourceShadowChainExact: true,
        oldTypedRowsAndRowidsUnchanged: true, noManufacturedLegacyHeads: true,
        sourceUnchanged: true, originalCloseAcknowledged: true }), { flag: 'wx', mode: 0o600 });
    }), 60_000);
});
