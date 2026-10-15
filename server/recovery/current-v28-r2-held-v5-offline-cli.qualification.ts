import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, readFile, realpath, writeFile, type FileHandle } from 'node:fs/promises';
import { constants, statfsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNodeDistribution } from '../../scripts/lib/node-distribution-v28-manifest.mjs';
import { NODE_RECOVERY_ARCHIVE_OPTIONS, nodeRecoveryArchiveSource } from '../../scripts/lib/system-backup-node-io.ts';
import { validateV28SystemBackupArchiveCandidate } from '../../shared/contracts/system-backup-v5-archive-admission.ts';
import { stableJson } from '../../shared/domain/content-addressing.ts';
import { PORTABLE_RUNTIME_RECOVERY_TABLES, PORTABLE_RUNTIME_SCHEMA_STATEMENTS, PORTABLE_RUNTIME_SEED_TABLE_ROWS }
  from '../../worker/recovery/portable-runtime-v28-trusted-schema.ts';
import { NODE_PLATFORM_OBJECTS } from '../../shared/contracts/node-installation-schema.ts';
import { loadNodeRuntimeConfiguration, assertNodeRuntimeConfiguration } from '../node-runtime-config.ts';
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from '../installation-catalog-v28-candidate.ts';
import { admitInstallationRecoverySource } from '../migrations.ts';
import { assertCanonicalFileOwnersReleased, retainedCanonicalFileCase }
  from '../collaboration/current-v28-canonical-comment-file.qualification-support.ts';
import { currentV28RecoveryImageRows, currentV28RecoveryTypedRows } from './current-v28-online-recovery.qualification-support.ts';
import { runCurrentCli } from '../operations/current-v28-backup-cli.qualification-support.ts';
import { disabledProtectedAccountTable } from './restore-v28-candidate.ts';
// These immutable inputs retain their ACTUAL original producer qualification.
// They are never relabelled as a current consumer binary/archive generation.
const PRODUCER_HEAD = '62ac1d54dcfd2bff6381f2bbfbe4276df1bf3ddc';
const PRODUCER_TREE = '856ee17cd6434efb07403833c0266b1dacc218c4';
const ARCHIVE_SHA256 = '82fc04947297df401ac3a80b6ad171659850871ce7b9d5c114a79b505af8aa24';
const PINS = {
  producer: { sha256: 'c1a977d75e4019b32872f0d9b1078d5bfe54add084044f6a96718164678a6f38', bytes: 5722 },
  node: { sha256: '9084bb4e0bb08c3f126af7881e6ba6fcc7d70aee9de2a48722ec2692244422cb', bytes: 650 },
  d1: { sha256: '0155fd6ab7ee6fc9b32a4cc8a90ff910964ba549157b04ecf0f9e717d39017e1', bytes: 4134 },
  capture: { sha256: '75a75b8fda0bbad93711229cdeaa2220c0dbe6d34217e12bf23f191451326c2e', bytes: 6190 },
} as const;
const RESERVE = 603_979_776n, SOURCE_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
let distribution: string, output: string, consumerHead: string, manifestSha256: string, fixtureParent: string;
function ensure(value: unknown, reason = 'original_r2_v5_offline_restore_unavailable'): asserts value {
  if (!value) throw new Error(reason);
}
function object(value: unknown): Record<string, unknown> {
  ensure(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
async function pinned(path: string, sha256: string, size: number) {
  ensure(isAbsolute(path) && resolve(path) === path && await realpath(path) === path);
  const before = await lstat(path, { bigint: true });
  ensure(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size === BigInt(size)
    && (before.mode & 0o7777n) === 0o600n && typeof process.geteuid === 'function' && before.uid === BigInt(process.geteuid()));
  const raw = await readFile(path), after = await lstat(path, { bigint: true });
  expect([after.dev,after.ino,after.uid,after.mode,after.nlink,after.size,after.mtimeNs,after.ctimeNs])
    .toEqual([before.dev,before.ino,before.uid,before.mode,before.nlink,before.size,before.mtimeNs,before.ctimeNs]);
  expect(raw.byteLength).toBe(size); expect(digest(raw)).toBe(sha256); return { path, sha256, size, raw };
}
async function originalInput() {
  const archive = process.env.CURRENT_R2_V5_ONLINE_ARCHIVE ?? '', producerPath = process.env.CURRENT_R2_V5_ONLINE_PRODUCER_RECEIPT ?? '';
  const archiveInput = await pinned(archive, ARCHIVE_SHA256, 1863610), parent = dirname(archive);
  const producerInput = await pinned(producerPath, PINS.producer.sha256, PINS.producer.bytes);
  const nodeInput = await pinned(join(parent, 'original-node-restore-receipt.json'), PINS.node.sha256, PINS.node.bytes);
  const d1Input = await pinned(join(parent, 'closed-native-file-consistency.json'), PINS.d1.sha256, PINS.d1.bytes);
  const captureInput = await pinned(join(parent, 'original-native-response.json'), PINS.capture.sha256, PINS.capture.bytes);
  const producer = object(JSON.parse(producerInput.raw.toString('utf8'))), results = object(producer.actualResults);
  expect(producer).toMatchObject({ kind: 'current-v28-post-restore-original-owned-stage/1', stage: 'worker-v5-held',
    head: PRODUCER_HEAD, tree: PRODUCER_TREE, status: 'PASS', exitCode: 0, originalChildWaited: true, ownedClosureProven: true, noFixtureRemoval: true });
  expect(producer.outerExpired).not.toBe(true); expect(producer.firstFailure).toBeUndefined();
  ensure(Array.isArray(producer.finalGroupSnapshot)); expect(producer.finalGroupSnapshot.every(row => object(row).activeOrOwnershipUnproven === false)).toBe(true);
  expect(results).toMatchObject({ actualTotal: 1, actualPassed: 1, actualFailed: 0, actualPending: 0,
    reporterSuccess: true, exactOriginalSelection: true, pass: true });
  expect(results.titles).toEqual(['captures the original held native R2 V28 V5 archive and restores exact recovery evidence into a fresh coherent Node distribution']);
  const node = object(JSON.parse(nodeInput.raw.toString('utf8'))), d1 = object(JSON.parse(d1Input.raw.toString('utf8')));
  expect(object(producer.actualHeldNodeRestore)).toMatchObject({ originalProofSha256: PINS.node.sha256, originalProofBytes: PINS.node.bytes,
    archiveFormat: 'v5', actualBytes: 68, exactTypedRows: true, restoredOriginalLocalEvidence: true, canonicalFileIdsPreserved: true, automaticActivation: false });
  ensure(Array.isArray(producer.actualClosedNativeProofs)); expect(producer.actualClosedNativeProofs).toHaveLength(1);
  expect(object(producer.actualClosedNativeProofs[0])).toMatchObject({ originalProofSha256: PINS.d1.sha256, originalProofBytes: PINS.d1.bytes });
  expect(d1).toMatchObject({ schema: 'closed-original-native-d1-readonly-consistency/1', originalNativeDisposed: true,
    wholeQuickCheck: true, foreignKeys: true, durableMainAndWalUnchanged: true, physicalPathsAndInodesUnchanged: true });
  expect(node).toMatchObject({ kind: 'offline-v28-inert-restore/1', archiveFormat: 'v5', sourceArchiveSha256: ARCHIVE_SHA256,
    destinationCheckpoint: 'portable-runtime/v28', sourceLedger: 'cloudflare-observed-migrations/1', executionEnabled: false,
    exactTypedRows: true, restoredOriginalLocalEvidence: true, canonicalFileIdsPreserved: true, actualBytes: 68 });
  const captureReply = object(JSON.parse(captureInput.raw.toString('utf8'))), capture = object(captureReply.capture);
  expect(capture).toMatchObject({ format: 'v5', sha256: ARCHIVE_SHA256, byteSize: 1863610, sourceCheckpoint: 'portable-runtime/v28',
    sourceLedger: 'observed-reviewed-construction', migrationExecutionClaimed: false, ledger: 'cloudflare-observed-migrations/1', ledgerEntries: 26,
    files: 1, bytes: 68, relocations: 1, activeHolds: 2, heldReadCount: 3, executionEnabled: false, recoveryReady: false,
    origin: { format: 'native', schemaVersion: 28, capturePolicy: 'atomic-primary-with-byte-holds/1' } });
  expect(capture.sourceInstallationId).toBe(captureReply.targetInstallationId);
  ensure(Array.isArray(d1.installations)); expect(d1.installations).toContain(capture.sourceInstallationId);
  const admitted = await validateV28SystemBackupArchiveCandidate(await nodeRecoveryArchiveSource(archive), {
    ...NODE_RECOVERY_ARCHIVE_OPTIONS, expectedSha256: ARCHIVE_SHA256 });
  expect(admitted.format).toBe('v5'); expect(admitted.manifest.completeness).toBe('complete'); expect(admitted.manifest.files).toHaveLength(1);
  expect(admitted.records.origin.capturePolicy).toBe('atomic-primary-with-byte-holds/1');
  expect(admitted.records.content.backupHoldOwner).toBe(admitted.records.backupId); expect(admitted.records.backupId).toBe(capture.backupId);
  expect(admitted.records.sourceMigrationLedger.kind).toBe('cloudflare-observed-migrations/1');
  const member = admitted.manifest.files[0]!;
  expect(member).toMatchObject({ outcome: 'packaged', byteSize: 68, sha256: node.sha256, source: { provider: 'r2', byteAuthority: 'file_location' } });
  expect(admitted.records.content.tables.recovery_file_evidence).toHaveLength(1);
  const originalLocal = object(JSON.parse(String(admitted.records.content.tables.recovery_file_evidence[0]!.source_locator_json)));
  expect(originalLocal).toMatchObject({ provider: 'local', storeKind: 'file' });
  for (const name of ['local_storage_profile_registrations', 'local_storage_profile_activations'])
    expect(admitted.records.image.tables[name]!.rows.length).toBeGreaterThan(0);
  const values = [archiveInput,producerInput,nodeInput,d1Input,captureInput];
  return { archive, archiveInput, values, admitted, member, producer, capture, node };
}

interface OfflineReadonlyInspection {
  originalOpen?: Promise<FileHandle>; handle?: FileHandle; native?: DatabaseSync;
  nativeAttempted: boolean; constructorFailed: boolean; nativeCloseAcknowledged?: boolean; fdCloseAcknowledged?: boolean;
  failure?: unknown; closing?: Promise<void>;
}
const readonlyInspections = new Set<OfflineReadonlyInspection>();
afterEach(() => {
  if (readonlyInspections.size) throw new AggregateError([...readonlyInspections].map(owner => owner.closing ?? owner.failure ?? owner.originalOpen),
    'Original retained target read-only inspection ownership remains unproven');
});
async function absent(path: string) {
  try { await lstat(path); return false; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return true; throw error; }
}
interface ReaderSidecarSnapshot {
  readonly present: boolean; readonly byteSize?: number; readonly sha256?: string; readonly physicalIdentity?: string;
}
interface OfflineClosedNativeProof {
  readonly mainSha256: string; readonly mainPhysicalIdentity: string;
  readonly sidecarsBeforeOpen: { readonly wal: ReaderSidecarSnapshot; readonly shm: ReaderSidecarSnapshot };
  readonly readerSidecarsBeforeClose: { readonly wal: ReaderSidecarSnapshot; readonly shm: ReaderSidecarSnapshot };
  readonly readerSidecarsAfterClose: { readonly wal: ReaderSidecarSnapshot; readonly shm: ReaderSidecarSnapshot };
  readonly originalNativeClosed: true; readonly originalFdClosed: true; readonly noReaderWalFrames: true;
  readonly shmMeaning: 'ephemeral-reader-coordination'; readonly exactInertSchemaAndTypedImage: true;
  readonly physicalQuickCheck: true; readonly wholeNativeIntegrityAndForeignKeys: true;
}
/* Read the genuine original closed offline target directly. This issues no
 * writer lease/sentinel, target claim or activation. Refuse old detached
 * sidecars; record readonly reader coordination without changing durable data. */
async function inspectClosedOfflineDatabase(path: string, originalPath: string, expectedSha256: string,
  work: (native: DatabaseSync) => void): Promise<OfflineClosedNativeProof> {
  assertCanonicalFileOwnersReleased();
  ensure(isAbsolute(path) && resolve(path) === path && await realpath(path) === path && /^[a-f0-9]{64}$/.test(expectedSha256));
  const before = await lstat(path, { bigint: true });
  ensure(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.uid === BigInt(process.geteuid!())
    && (before.mode & 0o7777n) === 0o600n && before.size > 0n && before.size <= 16n * 1024n * 1024n);
  const identity = (stat: typeof before) => [stat.dev,stat.ino,stat.uid,stat.gid,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
  // The original restore CLI closed its own Native/archive before this read.
  // A surviving WAL would require its exact original owner proof.
  for (const named of [path, originalPath]) for (const suffix of ['-wal','-shm']) ensure(await absent(named + suffix), 'retained_target_wal_requires_original_owner_proof');
  const owner: OfflineReadonlyInspection = { nativeAttempted: false, constructorFailed: false }; readonlyInspections.add(owner);
  let failed = false, failure: unknown;
  let readerSidecarsBeforeClose: OfflineClosedNativeProof['readerSidecarsBeforeClose'] | undefined;
  let readerSidecarsAfterClose: OfflineClosedNativeProof['readerSidecarsAfterClose'] | undefined;
  async function sidecars(): Promise<OfflineClosedNativeProof['readerSidecarsBeforeClose']> {
    const snapshots: ReaderSidecarSnapshot[] = [];
    for (const suffix of ['-wal', '-shm']) {
      const named = path + suffix;
      if (await absent(named)) { snapshots.push({ present: false }); continue; }
      const observed = await lstat(named, { bigint: true });
      ensure(observed.isFile() && !observed.isSymbolicLink() && observed.nlink === 1n
        && observed.uid === before.uid && observed.gid === before.gid && (observed.mode & 0o7777n) === 0o600n
        && observed.size >= 0n && observed.size <= 1024n * 1024n && await realpath(named) === named, 'retained_reader_sidecar_physical_identity');
      const bytes = await readFile(named);
      ensure(identity(await lstat(named, { bigint: true })) === identity(observed) && bytes.byteLength === Number(observed.size),
        'retained_reader_sidecar_changed_during_observation');
      // No old WAL existed. A new readonly-reader WAL may be empty or contain
      // only the SQLite header, never any durable frames. SHM is coordination,
      // and its observed bytes/inode are recorded without an unchanged claim.
      if (suffix === '-wal') ensure(bytes.byteLength === 0 || bytes.byteLength === 32
        && [0x377f0682, 0x377f0683].includes(bytes.readUInt32BE(0)), 'retained_readonly_reader_created_wal_frames');
      snapshots.push({ present: true, byteSize: bytes.byteLength, sha256: digest(bytes), physicalIdentity: identity(observed) });
    }
    const wal = snapshots[0], shm = snapshots[1]; ensure(wal && shm); return { wal, shm };
  }
  function close(): Promise<void> {
    if (owner.closing) return owner.closing;
    owner.closing = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      if (owner.nativeAttempted && !owner.native) errors.push(owner.constructorFailed ? owner.failure : new Error('Original readonly Native constructor has no close owner'));
      // Observe the original reader's own new sidecars, then attempt both first
      // closes even if an independent observation fails. Never retry either.
      try { readerSidecarsBeforeClose ??= await sidecars(); } catch (error) { errors.push(error); }
      try {
        if (owner.native) { owner.native.close(); ensure(!owner.native.isOpen, 'original_retained_readonly_native_close'); owner.nativeCloseAcknowledged = true; }
      } catch (error) { errors.push(error); }
      try {
        if (!owner.handle) throw owner.failure ?? new Error('Original retained FD has no close owner');
        await owner.handle.close(); owner.fdCloseAcknowledged = true;
      } catch (error) { errors.push(error); }
      try {
        ensure(await realpath(path) === path && identity(await lstat(path, { bigint: true })) === identity(before), 'retained_target_physical_identity_changed');
        expect(digest(await readFile(path))).toBe(expectedSha256);
        if (originalPath !== path) for (const suffix of ['-wal','-shm']) ensure(await absent(originalPath + suffix), 'original_replaced_basename_sidecar_changed');
        readerSidecarsAfterClose = await sidecars();
      } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Original retained reader observations and first Native/FD close failed');
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
    // The complete original offline target has all trusted objects. Work
    // independently checks full schema/image and global integrity/FK below.
    expect(native.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
    readerSidecarsBeforeClose = await sidecars();
  } catch (error) { failed = true; failure = error; owner.failure ??= error; }
  try { const first = close(); expect(close()).toBe(first); await first; }
  catch (cleanup) { throw failed ? new AggregateError([failure, cleanup], 'Original retained target inspection and first close failed') : cleanup; }
  if (failed) throw failure;
  ensure(readerSidecarsBeforeClose && readerSidecarsAfterClose && owner.native && !owner.native.isOpen
    && owner.nativeCloseAcknowledged && owner.fdCloseAcknowledged);
  return { mainSha256: expectedSha256, mainPhysicalIdentity: identity(before),
    sidecarsBeforeOpen: { wal: { present: false }, shm: { present: false } }, readerSidecarsBeforeClose, readerSidecarsAfterClose,
    originalNativeClosed: true, originalFdClosed: true, noReaderWalFrames: true, shmMeaning: 'ephemeral-reader-coordination',
    exactInertSchemaAndTypedImage: true, physicalQuickCheck: true, wholeNativeIntegrityAndForeignKeys: true };
}

beforeAll(async () => {
  distribution = process.env.NODE_OFFLINE_V28_DISTRIBUTION ?? ''; output = process.env.CURRENT_R2_V5_OFFLINE_NODE_RECEIPT ?? '';
  consumerHead = process.env.CURRENT_R2_V5_ONLINE_CONSUMER_HEAD ?? '';
  fixtureParent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT ?? '';
  ensure(isAbsolute(distribution) && resolve(distribution) === distribution && await realpath(distribution) === distribution
    && isAbsolute(output) && resolve(output) === output && /^[a-f0-9]{40}$/.test(consumerHead)
    && isAbsolute(fixtureParent) && resolve(fixtureParent) === fixtureParent && await realpath(fixtureParent) === fixtureParent);
  const parent = await lstat(fixtureParent, { bigint: true });
  ensure(parent.isDirectory() && !parent.isSymbolicLink() && typeof process.geteuid === 'function'
    && parent.uid === BigInt(process.geteuid()) && (parent.mode & 0o7777n) === 0o700n);
  for (const path of [fixtureParent, tmpdir()]) { const free = statfsSync(path, { bigint: true }); ensure(free.bavail * free.bsize >= RESERVE); }
  const manifest = await verifyNodeDistribution(distribution, { enforceRuntimeVersion: true }); manifestSha256 = manifest.manifestSha256;
  expect(manifest.version).toBe(3); expect(manifest.offlineRecoveryCheckpoint.id).toBe('portable-runtime/v28');
  const inputs = object(JSON.parse(await readFile(join(distribution, 'source-inputs.json'), 'utf8'))).inputs; ensure(Array.isArray(inputs));
  // The public verifier result exposes the checkpoint summary. Its real closed
  // source-input inventory and the exact embedded verifier retain the fixed
  // original restorer pin without assuming an undeclared summary property.
  const restorerInputs = inputs.map(object).filter(value => value.path === 'server/recovery/restore-v28-candidate.ts');
  expect(restorerInputs).toHaveLength(1);
  expect(restorerInputs[0]).toMatchObject({ bytes: 17871,
    sha256: '8ac2eba1170fa1a1e8d7400e560925e5fd8118af50dc8fdd01a82db18da89b80' });
  const embeddedVerifier = await readFile(join(distribution, 'tools/lib/node-distribution-v28-manifest.mjs'));
  expect(embeddedVerifier.byteLength).toBe(13184);
  expect(digest(embeddedVerifier)).toBe('5ab60c4f50128702dcd98904064669101a85bf850f57c2221bbf61da55e8fd8c');
  expect(embeddedVerifier).toEqual(await readFile(join(SOURCE_ROOT, 'scripts/lib/node-distribution-v28-manifest.mjs')));
  for (const relative of ['server/operations/restore-v28-cli.ts', 'server/operations/restore-v28-operator.ts',
    'server/recovery/restore-v28-candidate.ts', 'server/recovery/local-volume-byte-destination-v28.ts',
    'server/recovery/empty-target-v28-candidate.ts', 'shared/contracts/system-backup-v5.ts',
    'shared/contracts/system-backup-v5-archive-admission.ts', 'scripts/lib/restore-system-backup-v28-candidate.ts']) {
    const raw = await readFile(join(SOURCE_ROOT, relative)), selected = inputs.map(object).find(value => value.path === relative); ensure(selected);
    expect(selected.bytes).toBe(raw.byteLength); expect(selected.sha256).toBe(digest(raw));
  }
}, 20_000);

describe('retained original held native R2 V5 through current compiled offline Node restorer', () => {
  it('restores the original held V28 R2 image and exact native recovery history into a fresh inactive Node installation through the current fixed CLI with no activation or producer retag',
    () => retainedCanonicalFileCase(async () => {
      const input = await originalInput(), privateRoot = await mkdtemp(join(fixtureParent, '.original-held-r2-offline-'));
      const destination = join(privateRoot, 'fresh-inert-node');
      const rootOwner = await lstat('/', { bigint: true }); ensure(rootOwner.isDirectory() && rootOwner.uid >= 0n && rootOwner.uid <= 0xffff_ffffn);
      // Exact current compiled executable, one genuine original child and its
      // positive close+stdio ACK. No alternate restore callback or Native SQL
      // constructor is used by this qualification before the real CLI returns.
      const original = runCurrentCli(distribution, 'restore-v28-cli.cjs', ['restore', '--archive', input.archive,
        '--destination', destination, '--sha256', ARCHIVE_SHA256, '--filesystem-root-owner-uid', String(rootOwner.uid)]);
      void original.catch(() => undefined); const reply = await original;
      expect(reply.code).toBe(0); expect(reply.signal).toBeNull(); expect(reply.stderr).toBe('');
      const currentReceipt = object(JSON.parse(reply.stdout));
      expect(currentReceipt).toMatchObject({ kind: 'offline-v28-inert-restore/1', archiveFormat: 'v5', sourceArchiveSha256: ARCHIVE_SHA256,
        destinationCheckpoint: 'portable-runtime/v28', payloads: 1, executionEnabled: false });
      ensure(typeof currentReceipt.destinationInstallationId === 'string');
      const destinationInstallationId = currentReceipt.destinationInstallationId;
      expect(destinationInstallationId).not.toBe(input.capture.sourceInstallationId);
      expect(destinationInstallationId).not.toBe(input.node.destinationInstallationId);
      assertCanonicalFileOwnersReleased();
      const databasePath = join(destination, 'database.sqlite'), beforeDatabase = digest(await readFile(databasePath));
      const closedNativeProof = await inspectClosedOfflineDatabase(databasePath, databasePath, beforeDatabase, native => {
        const admitted = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE).receipt;
        expect(admitted.installationId).toBe(destinationInstallationId); expect(admitted.checkpointId).toBe('portable-runtime/v28');
        const expectedSchema = [...NODE_PLATFORM_OBJECTS, ...PORTABLE_RUNTIME_SCHEMA_STATEMENTS]
          .sort((left, right) => left.type < right.type ? -1 : left.type > right.type ? 1 : left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        expect(native.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name").all()).toEqual(expectedSchema);
        const specs = PORTABLE_RUNTIME_RECOVERY_TABLES.filter(spec => !spec.local || !spec.name.startsWith('system_recovery_'));
        const actual = currentV28RecoveryTypedRows(native, specs.map(spec => spec.name));
        for (const spec of specs) {
          const source = spec.local ? PORTABLE_RUNTIME_SEED_TABLE_ROWS[spec.name] : input.admitted.records.image.tables[spec.name]; ensure(source);
          expect(actual[spec.name], spec.name).toEqual(currentV28RecoveryImageRows(spec.name === 'local_accounts' ? disabledProtectedAccountTable(source) : source));
        }
        for (const name of ['file_shadow_runtime_guard', 'file_authority_runtime_guard', 'file_job_runtime_guard', 'system_recovery_runtime'])
          expect(native.prepare(`SELECT enabled FROM ${name} WHERE singleton=1`).get()?.enabled).toBe(0);
        for (const name of ['local_identity_installation', 'local_admin_grants', 'local_sessions', 'local_login_throttle',
          'local_storage_profile_checks', 'local_storage_profile_admissions', 'local_storage_profile_bindings', 'system_storage_native_bindings',
          'file_job_cleanup_grants', 'system_research_package_cleanup_grants', 'system_recovery_jobs', 'system_recovery_target_claim', 'system_recovery_target_files',
          'system_recovery_write_leases', 'collaboration_members', 'collaboration_identities', 'collaboration_resources', 'collaboration_grants'])
          expect(native.prepare(`SELECT count(*) n FROM ${name}`).get()?.n, name).toBe(0);
        expect(native.prepare('SELECT count(*) n FROM local_accounts WHERE enabled<>0').get()?.n).toBe(0);
        expect(native.prepare('SELECT state FROM system_recovery_maintenance WHERE singleton=1').get()?.state).toBe('fenced');
        expect(native.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(native.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
      });
      assertCanonicalFileOwnersReleased();
      const payloads: { id: string; byteSize: number; sha256: string }[] = [];
      for (const member of input.admitted.manifest.files) {
        ensure(member.path && member.byteSize !== null && member.sha256 !== null);
        const entry = input.admitted.entries.find(value => value.path === member.path); ensure(entry);
        const payload = await readFile(join(destination, member.path));
        expect(payload.byteLength).toBe(member.byteSize); expect(digest(payload)).toBe(member.sha256);
        expect(new Uint8Array(payload)).toEqual(new Uint8Array(input.archiveInput.raw.subarray(entry.dataOffset, entry.dataOffset + entry.byteSize)));
        payloads.push({ id: member.id, byteSize: payload.byteLength, sha256: digest(payload) });
      }
      const records = JSON.parse(await readFile(join(destination, 'metadata/records.json'), 'utf8'));
      const manifest = JSON.parse(await readFile(join(destination, 'metadata/manifest.json'), 'utf8'));
      expect(records).toEqual(input.admitted.records); expect(manifest).toEqual(input.admitted.manifest);
      expect(digest(await readFile(join(destination, 'original-archive.zip')))).toBe(ARCHIVE_SHA256);
      const inventory = object(JSON.parse(await readFile(join(destination, 'source-byte-inventory.json'), 'utf8')));
      expect(inventory).toMatchObject({ schema: 'offline-system-recovery-bytes/1', backupId: input.admitted.records.backupId, sourceArchiveSha256: ARCHIVE_SHA256 });
      expect(inventory.files).toEqual(input.admitted.manifest.files.map(file => ({ ...file, localPath: file.path })));
      const mappings = object(JSON.parse(await readFile(join(destination, 'inert-local-volume-mappings.json'), 'utf8')));
      expect(mappings).toMatchObject({ mappings: [], executionEnabled: false, installationBindingsRestored: false });
      const report = object(JSON.parse(await readFile(join(destination, 'recovery-report.json'), 'utf8')));
      expect(report).toMatchObject({ sourceArchiveSha256: ARCHIVE_SHA256, destinationInstallationId, destinationCheckpoint: 'portable-runtime/v28',
        payloads: 1, payloadBytes: 68, verifiedInertLocalVolumePayloads: 0, nativeBindingsRestored: false, executionEnabled: false,
        maintenanceState: 'fenced', deploymentChanged: false, providerIO: false,
        verification: { exactTypedRows: true, exactRowids: true, foreignKeys: true, integrity: 'ok', reviewedSchema: true } });
      const construction = object(report.installationConstruction);
      expect(construction).toMatchObject({ kind: 'reviewed-empty-recovery-checkpoint-construction/v28', constructionProvenance: 'reviewed-final-schema',
        rawMigrationExecution: false, nativeLedgerMeaning: 'implemented-reviewed-checkpoint-lineage', destinationInstallationId, checkpointId: 'portable-runtime/v28' });
      expect(JSON.parse(await readFile(join(destination, 'metadata/destination-checkpoint-construction.json'), 'utf8'))).toEqual(construction);
      const configPath = join(privateRoot, 'selected-inert-v28-metadata.json');
      await writeFile(configPath, JSON.stringify({ format: 'node-loopback-restored-v28-v1', databaseFile: 'database.sqlite', dataDirectory: destination,
        expectedInstallationId: destinationInstallationId, publicOrigin: 'http://127.0.0.1:14691', clientDirectory: join(distribution, 'client'),
        enableLocalFile: false, enableLocalJobs: false }), { flag: 'wx', mode: 0o600 });
      const configured = assertNodeRuntimeConfiguration(loadNodeRuntimeConfiguration(configPath,
        { filesystemRootOwnerUid: Number(rootOwner.uid), runtimeProfile: 'v28-metadata' }));
      expect(configured.enableLocalFile).toBe(false); expect(configured.enableLocalJobs).toBe(false); expect(configured.enableLocalRecovery).toBe(false);
      expect(configured.localVolumes).toEqual([]); expect(configured.recoveryArtifacts).toBeUndefined(); expect(configured.recoveryTarget).toBeUndefined();
      // Retained producer evidence and archive remain read-only and separately
      // labelled; the new compiled CLI consumer never impersonates that head.
      for (const value of input.values) await pinned(value.path, value.sha256, value.size);
      expect(digest(await readFile(join(distribution, 'manifest.json')))).toBe(manifestSha256);
      await writeFile(output, stableJson({ schema: 'genuine-current-node-v28-held-r2-offline-cli/1', consumerHead,
        currentDistributionManifestSha256: manifestSha256, producerHead: PRODUCER_HEAD, producerTree: PRODUCER_TREE,
        sourceArchiveSha256: ARCHIVE_SHA256, originalProducerProofs: PINS, originalNodeReceiptRetained: true, originalClosedD1ProofRetained: true,
        currentCliReceipt: currentReceipt, destinationInstallationId, payloads, capturePolicy: input.admitted.records.origin.capturePolicy,
        backupHoldOwner: input.admitted.records.content.backupHoldOwner, sourceLedger: input.admitted.records.sourceMigrationLedger.kind,
        currentOriginalCliCloseAndNativeObserverCloseAcknowledged: true, closedNativeProof, exactTypedRowsAndRowids: true, originalLocalRecoveryEvidenceAndProtectedHistoryExact: true,
        localBindingsAndAuthorityEmpty: true, allExecutionOffAndMaintenanceFenced: true, selectedMetadataConfigurationDefaultOff: true,
        rawMigrationExecutionClaimed: false, activationOrCutover: false, sourceArchiveAndProducerFilesUnchanged: true,
        fullApplicationRecoveryQualified: false }), { flag: 'wx', mode: 0o600 });
    }), 120_000);
});
