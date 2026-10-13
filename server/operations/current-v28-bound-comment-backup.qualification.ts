import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { verifyNodeDistribution } from '../../scripts/lib/node-distribution-v28-manifest.mjs';
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource } from '../../scripts/lib/system-backup-node-io.ts';
import { validateV28SystemBackupArchiveCandidate } from '../../shared/contracts/system-backup-v5-archive-admission.ts';
import { stableJson } from '../../shared/domain/content-addressing.ts';
import { assertCanonicalFileOwnersReleased, canonicalFileObject, composeCanonicalCommentFileV28,
  consumeCanonicalFileClient, currentCanonicalFileTarget, prepareCanonicalCommentFileBaseline,
  retainedCanonicalFileCase, withCanonicalFileDatabase } from '../collaboration/current-v28-canonical-comment-file.qualification-support.ts';
import { currentV28RecoveryImageRows, currentV28RecoveryTypedRows } from '../recovery/current-v28-online-recovery.qualification-support.ts';
import { runCurrentCli } from './current-v28-backup-cli.qualification-support.ts';
import { observeBoundProducerOriginalAcks } from './current-v28-bound-producer-original-ack.qualification-support.ts';

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
  it('captures one real bound LOCAL attachment without creating a legacy shadow head or changing its typed canonical consumer',
    () => retainedCanonicalFileCase(async () => {
      const baseline = await prepareCanonicalCommentFileBaseline(), submissionId = randomUUID(), itemId = randomUUID();
      const acknowledgements = await observeBoundProducerOriginalAcks(baseline.root);
      try {
      acknowledgements.phase('compose original canonical application');
      const produced = await withCanonicalFileDatabase(baseline.path, async (owner, lease, native, core) => {
        const app = await composeCanonicalCommentFileV28(owner, lease, native, core, baseline);
        acknowledgements.phase('original Alice login'); const session = await app.login('alice');
        const input = { protocol: 'comment-submission/1', id: submissionId, body: 'Genuine bound recovery source',
          context: { kind: 'run_steps', scope: 'common', targets: baseline.targets.map(target => currentCanonicalFileTarget(native, target)) },
          items: [{ id: itemId, kind: 'attachment', filename: 'bound-original.bin', mimeType: 'application/octet-stream',
            byteSize: bytes.byteLength, sha256: digest, title: 'Bound original native bytes' }] };
        acknowledgements.phase('original canonical Comment create');
        expect((await app.request('/api/comment-submissions', 'POST', input, session)).status).toBe(201);
        acknowledgements.phase('original attachment PUT response delivery');
        const upload = await app.raw(`/api/comment-submissions/${submissionId}/items/${itemId}/content`, 'PUT', session, bytes,
          { 'content-type': 'application/octet-stream', 'x-upload-size': String(bytes.byteLength), 'x-content-sha256': digest });
        acknowledgements.phase('original attachment PUT response body');
        const uploaded = await consumeCanonicalFileClient(upload.client, 'text'); ensure(typeof uploaded === 'string');
        expect(upload.response.status).toBe(200); expect(JSON.parse(uploaded)).toMatchObject({ ok: true, request: { items: [{ id: itemId, status: 'ready' }] } });
        acknowledgements.phase('original canonical Comment finalize');
        const finalized = await app.request(`/api/comment-submissions/${submissionId}/finalize`, 'POST', undefined, session);
        expect(finalized.status).toBe(200); expect(finalized.value).toMatchObject({ ok: true, status: 'ready' });
        acknowledgements.phase('original canonical publication assertions');
        const row = native.prepare("SELECT file_id FROM comment_submission_items WHERE id=? AND submission_id=? AND status='ready'").get(itemId, submissionId);
        ensure(typeof row?.file_id === 'string'); const fileId = row.file_id;
        expect(native.prepare('SELECT count(*) n FROM files').get()?.n).toBe(1);
        expect(native.prepare('SELECT count(*) n FROM file_locations').get()?.n).toBe(1);
        expect(native.prepare('SELECT count(*) n FROM file_shadow_heads WHERE present=1').get()?.n).toBe(0);
        expect(native.prepare('SELECT count(*) n FROM file_consumer_projection WHERE file_id=?').get(fileId)?.n).toBeGreaterThan(0);
        acknowledgements.phase('original attachment GET response delivery');
        const download = await app.raw(`/api/attachments/${itemId}/download`, 'GET', session);
        acknowledgements.phase('original attachment GET response body');
        const body = await consumeCanonicalFileClient(download.client, 'arrayBuffer'); ensure(body instanceof ArrayBuffer);
        expect(download.response.status).toBe(200); expect(new Uint8Array(body)).toEqual(bytes);
        acknowledgements.phase('original typed consumer/history snapshots');
        const names = ['files', 'file_locations', 'file_publications', 'file_location_publications', 'comment_submissions', 'comment_submission_items',
          'comment_item_acceptances', 'comment_submission_acceptances', 'run_step_comments', 'events', 'file_shadow_heads',
          'file_shadow_occurrences', 'file_shadow_closures', 'file_shadow_dependency_versions', 'file_shadow_decisions'];
        return { fileId, names, rows: currentV28RecoveryTypedRows(native, names) };
      });
      acknowledgements.phase('original source owner close acknowledged');
      assertCanonicalFileOwnersReleased();
      const configuration = join(baseline.root, 'bound-current-capture.json'), archive = join(baseline.root, 'genuine-bound-original-v5.zip');
      await writeFile(configuration, JSON.stringify({ schema: 'stopped-local-v28-capture/1', databasePath: baseline.path,
        descriptors: baseline.descriptors }), { flag: 'wx', mode: 0o600 });
      acknowledgements.phase('original compiled stopped capture');
      const capture = await runCurrentCli(distribution, 'installation-cli.cjs', ['capture-local-backup', '--runtime-profile', 'v28',
        '--configuration', configuration, '--archive', archive, '--installation', baseline.installationId,
        '--filesystem-root-owner-uid', String(baseline.rootOwnerUid)]);
      expect(capture.code).toBe(0); expect(capture.signal).toBeNull(); expect(capture.stderr).toBe('');
      const captured = canonicalFileObject(JSON.parse(capture.stdout));
      expect(captured).toMatchObject({ kind: 'stopped-local-v28-v5-capture/1', nodeInstallationId: baseline.installationId,
        sourceCheckpoint: 'portable-runtime/v28', archiveFormat: 'v5', completeness: 'complete', packagedFiles: 1,
        unavailableFiles: 0, sourceAuthorityImported: false, sourceMutation: false });
      ensure(typeof captured.archiveSha256 === 'string' && /^[a-f0-9]{64}$/.test(captured.archiveSha256));
      acknowledgements.phase('original strict V5 archive admission');
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
      acknowledgements.phase('original source preservation reopen');
      await withCanonicalFileDatabase(baseline.path, async (_owner, lease, native) => lease.withWriter(async () => {
        expect(currentV28RecoveryTypedRows(native, produced.names)).toEqual(produced.rows);
        expect(native.prepare('SELECT count(*) n FROM file_shadow_heads WHERE present=1').get()?.n).toBe(0);
      }));
      assertCanonicalFileOwnersReleased();
      expect(createHash('sha256').update(await readFile(archive)).digest('hex')).toBe(captured.archiveSha256);
      await writeFile(output, stableJson({ schema: 'current-genuine-bound-node-comment-v5-producer/1', runtime: process.versions.node,
        distribution, sourceInstallationId: baseline.installationId, archive, archiveSha256: captured.archiveSha256,
        fileId: produced.fileId, submissionId, itemId, payloadBytes: bytes.byteLength, payloadSha256: digest,
        genuineOriginalCommentProducer: true, currentVerifiedCompiledStoppedCapture: true, noBusinessSqlSeed: true,
        nativeConsumerBindings: file.bindings, oldTypedRowsAndRowidsUnchanged: true, noManufacturedLegacyHeads: true,
        sourceUnchanged: true, originalCloseAcknowledged: true }), { flag: 'wx', mode: 0o600 });
      } finally {
        acknowledgements.report('original case work returned or rejected; observation does not settle custody');
        acknowledgements.restore();
        acknowledgements.report('instrumentation restored; pending original ACKs remain reported');
      }
    }), 60_000);
});
