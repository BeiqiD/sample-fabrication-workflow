import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { verifyNodeDistribution } from '../../scripts/lib/node-distribution-v28-manifest.mjs';
import { NodeRuntimeConfigurationError } from '../node-runtime-config.ts';
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource } from '../../scripts/lib/system-backup-node-io.ts';
import { validateV28SystemBackupArchiveCandidate } from '../../shared/contracts/system-backup-v5-archive-admission.ts';
import { stableJson } from '../../shared/domain/content-addressing.ts';
import { NODE_PLATFORM_OBJECTS } from '../../shared/contracts/node-installation-schema.ts';
import { PORTABLE_RUNTIME_SCHEMA_STATEMENTS, PORTABLE_RUNTIME_RECOVERY_TABLES, PORTABLE_RUNTIME_SEED_TABLE_ROWS }
  from '../../worker/recovery/portable-runtime-v28-trusted-schema.ts';
import { disabledProtectedAccountTable } from './restore-v28-candidate.ts';
import { checkedSystemRecoveryReceipt, checkedSystemRecoveryJobStatus, checkedSystemRecoveryMaintenanceStatus,
  checkedSystemRecoveryMaintenanceReceipt } from '../../shared/contracts/system-recovery.ts';
import { CANONICAL_FILE_PASSWORD, assertCanonicalFileOwnersReleased, canonicalFilePrivateOrigin,
  retainedCanonicalFileCase, withCanonicalFileDatabase } from '../collaboration/current-v28-canonical-comment-file.qualification-support.ts';
import { prepareCurrentV28OnlineRecoverySource, currentV28RecoveryImageRows, currentV28RecoveryTypedRows,
  CURRENT_V28_RECOVERY_PHYSICAL_TABLES } from './current-v28-online-recovery.qualification-support.ts';
import { loginCurrentRecoveryCli, recoveryCliJson, recoveryCliBytes,
  type CurrentRecoveryCliOwner, type CurrentRecoveryCliSession } from './current-v28-recovery-cli.qualification-support.ts';
import { prepareCurrentRecoveryTarget } from './current-v28-recovery-target.qualification-support.ts';
const RESERVE = 603_979_776n;
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
let distribution: string, output: string, manifestSha256: string;
function ensure(value: unknown, reason = 'genuine_artifact_binding_fault_unavailable'): asserts value { if (!value) throw new Error(reason); }
function object(value: unknown): Record<string, unknown> {
  ensure(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
beforeAll(async () => {
  distribution = process.env.NODE_OFFLINE_V28_DISTRIBUTION ?? '';
  output = process.env.CURRENT_V28_ARTIFACT_BINDING_FAULT_RECEIPT ?? '';
  const parent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT ?? '';
  ensure(isAbsolute(distribution) && resolve(distribution) === distribution && await realpath(distribution) === distribution
    && isAbsolute(output) && resolve(output) === output && isAbsolute(parent) && resolve(parent) === parent);
  for (const directory of [parent, tmpdir()]) { const free = statfsSync(directory, { bigint: true }); ensure(free.bavail * free.bsize >= RESERVE); }
  const manifest = await verifyNodeDistribution(distribution, { enforceRuntimeVersion: true }); manifestSha256 = manifest.manifestSha256;
  expect(manifest.version).toBe(3); expect(manifest.offlineRecoveryCheckpoint.id).toBe('portable-runtime/v28');
  const inputs = object(JSON.parse(await readFile(join(distribution, 'source-inputs.json'), 'utf8'))).inputs; ensure(Array.isArray(inputs));
  for (const relative of ['server/main.ts', 'server/recovery/node-system-recovery-v28-application.ts',
    'server/recovery/node-v28-target-stages.ts', 'server/recovery/node-v28-recovery-target.ts',
    'server/recovery/node-private-artifacts.ts', 'server/storage/local-byte-storage.ts', 'worker/recovery/kernel.ts']) {
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

async function prepared() {
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
  const archive = join(source.baseline.root, 'original-artifact-binding-source-v5.zip');
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
      mode: 'historical', acknowledgeLaterChanges: true, acknowledgePartial: false }, session);
    expect(reply.status).toBe(202); return checkedSystemRecoveryReceipt(reply.value).job.id;
  });
  return { source, target, origin, backupId, uploadId, recoveryId, archive, archiveSha256: downloaded.sha256, admitted };
}


interface PrivateFileProof {
  readonly relative: string; readonly dev: string; readonly ino: string; readonly uid: string; readonly gid: string;
  readonly mode: string; readonly nlink: string; readonly byteSize: number; readonly sha256: string;
}
/** Hash only the original private filesystem objects. No SQL/provider grant,
 * copy, delete or alternative archive resolution is performed by this census. */
async function privateInventory(root: string): Promise<readonly PrivateFileProof[]> {
  ensure(isAbsolute(root) && resolve(root) === root && await realpath(root) === root);
  const result: PrivateFileProof[] = []; let total = 0, entries = 0;
  async function visit(relative: string): Promise<void> {
    ensure(++entries <= 32); const path = relative ? join(root, relative) : root;
    const before = await lstat(path, { bigint: true });
    ensure(!before.isSymbolicLink() && before.uid === BigInt(process.geteuid!()) && await realpath(path) === path);
    if (before.isDirectory()) {
      ensure((before.mode & 0o7777n) === 0o700n);
      for (const name of (await readdir(path)).sort()) {
        ensure(/^[A-Za-z0-9._-]{1,128}$/.test(name)); await visit(relative ? relative + '/' + name : name);
      }
      return;
    }
    ensure(before.isFile() && before.nlink === 1n && (before.mode & 0o7777n) === 0o600n && before.size <= 4n * 1024n * 1024n);
    const bytes = await readFile(path); total += bytes.byteLength; ensure(total <= 8 * 1024 * 1024);
    const after = await lstat(path, { bigint: true });
    expect([after.dev,after.ino,after.uid,after.gid,after.mode,after.nlink,after.size,after.mtimeNs,after.ctimeNs])
      .toEqual([before.dev,before.ino,before.uid,before.gid,before.mode,before.nlink,before.size,before.mtimeNs,before.ctimeNs]);
    expect(bytes.byteLength).toBe(Number(before.size));
    result.push({ relative, dev: String(before.dev), ino: String(before.ino), uid: String(before.uid), gid: String(before.gid),
      mode: String(before.mode), nlink: String(before.nlink), byteSize: bytes.byteLength, sha256: digest(bytes) });
  }
  await visit(''); return Object.freeze(result);
}
async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return true; throw error; }
}
function retention(native: DatabaseSync, backupId: string, uploadId: string, recoveryId: string) {
  const order = (rows: Record<string, unknown>[]) => rows.sort((left, right) => stableJson(left) < stableJson(right) ? -1 : stableJson(left) > stableJson(right) ? 1 : 0);
  const location = order(native.prepare('SELECT * FROM file_location_holds').all());
  const file = order(native.prepare('SELECT * FROM file_holds').all());
  const legacy = order(native.prepare('SELECT * FROM system_recovery_legacy_holds').all());
  const dependency = native.prepare('SELECT id,kind,actor,source_upload_job_id,source_checkpoint FROM system_recovery_jobs WHERE id=?').get(recoveryId); ensure(dependency);
  expect(dependency.kind).toBe('recovery'); expect(dependency.source_upload_job_id).toBe(uploadId);
  const upload = native.prepare('SELECT id,actor,kind,state,phase,artifact_key,archive_sha256,archive_byte_size FROM system_recovery_jobs WHERE id=?').get(uploadId); ensure(upload);
  expect(upload).toMatchObject({ kind: 'upload', state: 'preview', phase: 'done' }); expect(upload.actor).toBe(dependency.actor);
  ensure(typeof upload.artifact_key === 'string' && typeof upload.archive_sha256 === 'string' && typeof upload.archive_byte_size === 'number' && upload.archive_byte_size > 0);
  const attempts = order(native.prepare('SELECT * FROM system_recovery_attempts WHERE job_id=?').all(uploadId));
  expect(attempts.some(row => row.object_key === upload.artifact_key && row.state === 'verified' && row.expected_sha256 === upload.archive_sha256)).toBe(true);
  const window = native.prepare('SELECT state,generation,token,checkpoint_sha256,backup_job_id FROM system_recovery_maintenance WHERE singleton=1').get(); ensure(window);
  expect(window.state).toBe('fenced'); expect(window.backup_job_id).toBe(backupId); ensure(typeof window.checkpoint_sha256 === 'string');
  // Current Node capture is quiesced, backupHoldOwner=null. Preserve all real
  // File/legacy hold rows, even an empty set; the nonempty durable archive hold
  // is this actual accepted recovery dependency plus pending target intent.
  return { location, file, legacy, dependency, upload, attempts, window };
}

async function run(): Promise<void> {
  const data = await prepared(), { source, target, recoveryId, uploadId } = data;
  const originalRoot = source.recoveryArtifacts.root, retainedRoot = originalRoot + '.retained-original-binding';
  const originalFiles = await privateInventory(originalRoot); expect(originalFiles.length).toBeGreaterThanOrEqual(5);
  const marker = await readFile(join(originalRoot, 'namespace.json'));
  const backupFiles = originalFiles.filter(value => value.relative.endsWith('/data') && value.sha256 === data.archiveSha256);
  // Both original backup output and actual public upload contain the SAME
  // strict V5 bytes; no historical binary/archive is retagged or SQL seeded.
  expect(backupFiles).toHaveLength(2);
  let oldRootIdentity: { dev: string; ino: string } | undefined, replacementRootIdentity: { dev: string; ino: string } | undefined;
  let pendingCursor: Record<string, unknown> | undefined, retainedFile: Record<string, unknown> | undefined;
  let expectedRetention: ReturnType<typeof retention> | undefined;
  let originalQueuedJob: Record<string, unknown> | undefined, originalTargetClaim: Record<string, unknown> | undefined;
  let clearedCursor: Record<string, unknown> | undefined;
  await target.withDispatcher(async (app, client, native) => {
    let phase = 'claim';
    for (let count = 0; phase !== 'files'; count++) {
      ensure(count < 64); const result = await app.dispatchRecoveryJobsOnce(); expect(result.jobId).toBe(recoveryId); expect(result.outcome).not.toBe('paused');
      const value = native.prepare('SELECT phase FROM system_recovery_jobs WHERE id=?').get(recoveryId)?.phase; ensure(typeof value === 'string'); phase = value;
    }
    const session = await client.login('operator');
    expect((await client.request('/api/auth/session', 'GET', undefined, session)).status).toBe(200);
    const originalClaim = native.prepare('SELECT * FROM system_recovery_target_claim WHERE job_id=?').get(recoveryId); ensure(originalClaim);
    ensure(typeof originalClaim.cursor_json === 'string'); const originalCursor = object(JSON.parse(originalClaim.cursor_json));
    expect(originalCursor).toMatchObject({ stage: 'files', pending: false, cleared: true, file: 0 });
    clearedCursor = originalCursor; originalTargetClaim = originalClaim;
    originalQueuedJob = native.prepare('SELECT * FROM system_recovery_jobs WHERE id=?').get(recoveryId); ensure(originalQueuedJob);
    expect(originalQueuedJob).toMatchObject({ state: 'queued', phase: 'files', owner_token: null, runtime_incarnation: null, result_json: null });
    expectedRetention = retention(native, data.backupId, uploadId, recoveryId);
    expect(native.prepare('SELECT count(*) n FROM system_recovery_target_files WHERE job_id=?').get(recoveryId)?.n).toBe(0);
    ensure(await absent(retainedRoot)); const oldRoot = await lstat(originalRoot, { bigint: true });
    ensure(oldRoot.isDirectory() && !oldRoot.isSymbolicLink() && (oldRoot.mode & 0o7777n) === 0o700n);
    oldRootIdentity = { dev: String(oldRoot.dev), ino: String(oldRoot.ino) };
    // Genuine unavailable binding while the ORIGINAL private provider owns
    // its opened root/objects/staging FDs. Preserve that original tree in place
    // under a new name; the replacement contains no object, payload or fallback.
    await rename(originalRoot, retainedRoot); await mkdir(originalRoot, { mode: 0o700 });
    for (const name of ['objects', 'staging']) await mkdir(join(originalRoot, name), { mode: 0o700 });
    await writeFile(join(originalRoot, 'namespace.json'), marker, { flag: 'wx', mode: 0o600 });
    const replacement = await lstat(originalRoot, { bigint: true }), retained = await lstat(retainedRoot, { bigint: true });
    replacementRootIdentity = { dev: String(replacement.dev), ino: String(replacement.ino) };
    expect(replacementRootIdentity).not.toEqual(oldRootIdentity); expect({ dev: String(retained.dev), ino: String(retained.ino) }).toEqual(oldRootIdentity);
    expect(await privateInventory(retainedRoot)).toEqual(originalFiles);
    expect(await readdir(join(originalRoot, 'objects'))).toEqual([]); expect(await readdir(join(originalRoot, 'staging'))).toEqual([]);
    // This original config token captured the OLD physical root inode. The
    // whole-config guard refuses before claim, lease or files-stage admission;
    // it must preserve the exact queued job/cleared claim and issue NO intent.
    await expect(app.dispatchRecoveryJobsOnce()).rejects.toBeInstanceOf(NodeRuntimeConfigurationError);
    expect(native.prepare('SELECT * FROM system_recovery_jobs WHERE id=?').get(recoveryId)).toEqual(originalQueuedJob);
    expect(native.prepare('SELECT * FROM system_recovery_target_claim WHERE job_id=?').get(recoveryId)).toEqual(originalTargetClaim);
    expect(native.prepare('SELECT * FROM system_recovery_target_files WHERE job_id=?').all(recoveryId)).toEqual([]);
    expect(native.prepare('SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL').get()?.n).toBe(0);
    await expect(app.dispatchRecoveryJobsOnce()).rejects.toBeInstanceOf(NodeRuntimeConfigurationError);
    expect(native.prepare('SELECT * FROM system_recovery_jobs WHERE id=?').get(recoveryId)).toEqual(originalQueuedJob);
    expect(native.prepare('SELECT * FROM system_recovery_target_claim WHERE job_id=?').get(recoveryId)).toEqual(originalTargetClaim);
    expect(native.prepare('SELECT * FROM system_recovery_target_files WHERE job_id=?').all(recoveryId)).toEqual([]);
    expect(retention(native, data.backupId, uploadId, recoveryId)).toEqual(expectedRetention);
    expect(await absent(join(target.destination, 'files/b_0000'))).toBe(true);
    expect(await readdir(join(originalRoot, 'objects'))).toEqual([]); expect(await readdir(join(originalRoot, 'staging'))).toEqual([]);
  });
  assertCanonicalFileOwnersReleased();
  ensure(expectedRetention && originalQueuedJob && originalTargetClaim && clearedCursor && oldRootIdentity && replacementRootIdentity);
  expect(await privateInventory(retainedRoot)).toEqual(originalFiles);
  // Fresh genuine main/HTTP/auth/physical owner sees only the explicit empty
  // replacement. It may report old metadata; actual original download refuses
  // unavailable bytes instead of choosing retainedRoot or the canonical File.
  await target.withCli(distribution, data.origin, async owner => {
    const session = await loginCurrentRecoveryCli(owner, data.origin, 'operator', CANONICAL_FILE_PASSWORD);
    const status = checkedSystemRecoveryJobStatus((await recoveryCliJson(owner, data.origin,
      `/api/system-recovery/jobs/${recoveryId}`, 'GET', undefined, session)).value);
    expect(status).toMatchObject({ kind: 'recovery', state: 'queued', phase: 'files', result: null });
    expect((await recoveryCliBytes(owner, data.origin, `/api/system-recovery/jobs/${data.backupId}/download`, 'GET', undefined, session)).status).toBe(404);
    expect((await recoveryCliJson(owner, data.origin, `/api/system-recovery/jobs/${recoveryId}/report`, 'GET', undefined, session)).status).toBe(404);
    for (const id of [uploadId, recoveryId]) expect((await recoveryCliJson(owner, data.origin,
      `/api/system-recovery/jobs/${id}/control`, 'POST', { action: 'cleanup' }, session)).status).toBe(409);
  });
  assertCanonicalFileOwnersReleased();
  // Explicit fresh operator opening captures the replacement's NEW inode.
  // The genuine newly issued dispatcher can now claim the existing job, but
  // its required private archive is absent. Only THIS new attempt may become
  // paused/unknown/pending; it never follows retainedRoot or canonical bytes.
  await target.withDispatcher(async (app, client, native) => {
    expect(native.prepare('SELECT * FROM system_recovery_jobs WHERE id=?').get(recoveryId)).toEqual(originalQueuedJob);
    expect(native.prepare('SELECT * FROM system_recovery_target_claim WHERE job_id=?').get(recoveryId)).toEqual(originalTargetClaim);
    expect(native.prepare('SELECT * FROM system_recovery_target_files WHERE job_id=?').all(recoveryId)).toEqual([]);
    expect(await app.dispatchRecoveryJobsOnce()).toEqual({ jobId: recoveryId, outcome: 'paused' });
    expect(native.prepare('SELECT state,phase,result_json FROM system_recovery_jobs WHERE id=?').get(recoveryId))
      .toEqual({ state: 'paused', phase: 'files', result_json: null });
    retainedFile = native.prepare('SELECT * FROM system_recovery_target_files WHERE job_id=?').get(recoveryId); ensure(retainedFile);
    expect(retainedFile.state).toBe('unknown'); expect(retainedFile.byte_size).toBe(source.payloadBytes); expect(retainedFile.sha256).toBe(source.payloadSha256);
    const afterClaim = native.prepare('SELECT * FROM system_recovery_target_claim WHERE job_id=?').get(recoveryId); ensure(afterClaim);
    ensure(typeof afterClaim.cursor_json === 'string'); pendingCursor = object(JSON.parse(afterClaim.cursor_json));
    expect(pendingCursor).toEqual({ ...clearedCursor, pending: true }); expect(afterClaim.status).toBe('files');
    expect(retainedFile.owner_token).toBe(afterClaim.owner_token); expect(retainedFile.generation).toBe(afterClaim.generation);
    ensure(typeof originalTargetClaim?.generation === 'number' && Number.isSafeInteger(originalTargetClaim.generation));
    expect(afterClaim.generation).toBe(originalTargetClaim.generation + 1);
    expect(native.prepare("SELECT count(*) n FROM system_recovery_target_files WHERE job_id=? AND state IN('verified','published')").get(recoveryId)?.n).toBe(0);
    expect(await app.dispatchRecoveryJobsOnce()).toEqual({ jobId: null, outcome: 'idle' });
    expect(native.prepare('SELECT * FROM system_recovery_target_files WHERE job_id=?').get(recoveryId)).toEqual(retainedFile);
    expect(retention(native, data.backupId, uploadId, recoveryId)).toEqual(expectedRetention);
    const session = await client.login('operator');
    expect((await client.request('/api/auth/session', 'GET', undefined, session)).status).toBe(200);
    for (const id of [uploadId, recoveryId])
      expect((await client.request(`/api/system-recovery/jobs/${id}/control`, 'POST', { action: 'cleanup' }, session)).status).toBe(409);
    expect((await client.request('/api/system-recovery/executor', 'POST', { enabled: false }, session)).status).toBe(200);
    expect(await absent(join(target.destination, 'files/b_0000'))).toBe(true);
    expect(await readdir(join(originalRoot, 'objects'))).toEqual([]); expect(await readdir(join(originalRoot, 'staging'))).toEqual([]);
  });
  assertCanonicalFileOwnersReleased();
  ensure(retainedFile && pendingCursor);
  await withCanonicalFileDatabase(source.baseline.path, async (_owner, lease, native) => lease.withWriter(async () => {
    expect(native.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(native.prepare('SELECT * FROM system_recovery_target_files WHERE job_id=?').get(recoveryId)).toEqual(retainedFile);
    const claim = native.prepare('SELECT cursor_json FROM system_recovery_target_claim WHERE job_id=?').get(recoveryId); ensure(typeof claim?.cursor_json === 'string');
    expect(object(JSON.parse(claim.cursor_json))).toEqual(pendingCursor);
    expect(native.prepare('SELECT state,phase,result_json FROM system_recovery_jobs WHERE id=?').get(recoveryId))
      .toEqual({ state: 'paused', phase: 'files', result_json: null });
    expect(native.prepare('SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL').get()?.n).toBe(0);
    expect(retention(native, data.backupId, uploadId, recoveryId)).toEqual(expectedRetention);
    expect(currentV28RecoveryTypedRows(native)).toEqual(source.expectedTypedSource);
    expect(currentV28RecoveryTypedRows(native, CURRENT_V28_RECOVERY_PHYSICAL_TABLES)).toEqual(source.expectedTypedPhysicalBindings);
  }));
  assertCanonicalFileOwnersReleased();
  await withCanonicalFileDatabase(join(target.destination, 'database.sqlite'), async (_owner, lease, native) => lease.withWriter(() => {
    // Deliberate files-stage partial target: full exact code-owned table SQL,
    // every original typed row/rowid and local constructor seed. Explicit FK
    // indexes/views/triggers are not yet reinstalled; no ready-health claim.
    const expectedSchema = [...NODE_PLATFORM_OBJECTS, ...PORTABLE_RUNTIME_SCHEMA_STATEMENTS.filter(value => value.type === 'table')]
      .sort((left, right) => left.type < right.type ? -1 : left.type > right.type ? 1 : left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    expect(native.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name").all()).toEqual(expectedSchema);
    expect(native.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
    const actual = currentV28RecoveryTypedRows(native, PORTABLE_RUNTIME_RECOVERY_TABLES.map(spec => spec.name));
    for (const spec of PORTABLE_RUNTIME_RECOVERY_TABLES) {
      const original = spec.local ? PORTABLE_RUNTIME_SEED_TABLE_ROWS[spec.name] : data.admitted.records.image.tables[spec.name]; ensure(original);
      expect(actual[spec.name]).toEqual(currentV28RecoveryImageRows(spec.name === 'local_accounts' ? disabledProtectedAccountTable(original) : original));
    }
    for (const name of ['file_shadow_runtime_guard', 'file_authority_runtime_guard', 'file_job_runtime_guard', 'system_recovery_runtime'])
      expect(native.prepare(`SELECT enabled FROM ${name} WHERE singleton=1`).get()?.enabled).toBe(0);
    for (const name of ['local_storage_profile_bindings', 'system_storage_native_bindings'])
      expect(native.prepare(`SELECT count(*) n FROM ${name}`).get()?.n).toBe(0);
    const history = data.admitted.records.image.tables.local_storage_profile_activations; ensure(history);
    expect(history.rows.every(row => row.rowid === null)).toBe(true);
    expect(actual.local_storage_profile_activations).toEqual(currentV28RecoveryImageRows(history));
  }));
  assertCanonicalFileOwnersReleased();
  expect(await privateInventory(retainedRoot)).toEqual(originalFiles);
  expect(await readdir(join(originalRoot, 'objects'))).toEqual([]); expect(await readdir(join(originalRoot, 'staging'))).toEqual([]);
  expect(await absent(join(target.destination, 'files/b_0000'))).toBe(true);
  expect(digest(await readFile(data.archive))).toBe(data.archiveSha256);
  expect(digest(await readFile(join(distribution, 'manifest.json')))).toBe(manifestSha256);
  await writeFile(output, stableJson({ schema: 'genuine-current-node-v28-artifact-binding-unavailable/1',
    distributionManifestSha256: manifestSha256, sourceInstallationId: source.baseline.installationId, targetId: target.descriptor.targetId,
    backupId: data.backupId, uploadId, recoveryId, archiveSha256: data.archiveSha256, archiveFiles: backupFiles,
    actualPayloadBytes: source.payloadBytes, actualPayloadSha256: source.payloadSha256, oldRootIdentity, replacementRootIdentity,
    genuineOpenedRootInodeReplacement: true, originalPrivateTreeInodesAndHashesRetained: true, replacementObjectsAndStagingEmpty: true,
    originalCapturedConfigurationRefusedBeforeClaim: true, originalQueuedJobAndClearedClaimExact: true, originalTargetIntentsAbsent: true,
    actualFreshMainUnavailableDownload404: true, actualFreshMainUnavailableReport404: true, noAlternateProviderOrFileFallback: true,
    freshIssuedDispatcherRequiredArtifactRefused: true, freshPausedFilesIntentUnknownAndCursorPending: true,
    noTargetPayloadIssued: true, noTargetVerifiedPublicationReadyOrHandoff: true,
    existingFileAndLegacyHoldRowsExact: true, actualAcceptedArchiveDependencyHeld: true, originalVerifiedUploadAttemptAndArtifactKeyRetained: true,
    backupCapturePolicy: data.admitted.records.origin.capturePolicy, backupHoldOwner: data.admitted.records.content.backupHoldOwner,
    recoveryAndUploadCleanup409AfterFreshOpeningAndPausedAttempt: true,
    originalKernelProviderHttpNativeAndFirstOwnerClosesAcknowledged: true, sourceCanonicalAndPhysicalBindingsUnchanged: true,
    exactTargetPartialSchemaAndTypedRows: true, protectedActivationHistoryExact: true, destinationBindingsEmptyAndRuntimeOff: true,
    fakeClock: false, rawBusinessIdentityOrGrantSeed: false, permissionCallbackDenial: false, fullApplicationRecoveryQualified: false }),
    { flag: 'wx', mode: 0o600 });
}

describe('current genuine F5 required private artifact binding unavailable', () => {
  it('refuses the original captured artifact root before claim and pauses a fresh-issued target attempt when required archive bytes remain unavailable, with retained holds and no fallback',
    () => retainedCanonicalFileCase(run), 120_000);
});
