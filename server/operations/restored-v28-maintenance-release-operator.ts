import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInstalledLocalIdentity, assertInstalledLocalIdentityOwner } from '../auth/identity.ts';
import { createPasswordHasher } from '../auth/passwords.ts';
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from '../installation-catalog-v28-candidate.ts';
import { admitInstallationRecoverySource, assertInstallationAdmission } from '../migrations.ts';
import { createSqliteCapability, createSqliteBatchAdmission, runSqliteAdmittedBatch, checkedSafeInteger,
  type SqliteCapability, type SqliteRow, type SqliteBatchAdmissionCheck } from '../sqlite.ts';
import { acquireLinuxWriterLease, assertLinuxWriterLeaseBinding, type LinuxWriterLease } from './writer-lease.ts';
import { checkedSystemRecoveryMaintenanceInput, checkedSystemRecoveryMaintenanceReceipt,
  type SystemRecoveryMaintenanceReceipt } from '../../shared/contracts/system-recovery.ts';
import { validateV28SystemBackupArchiveCandidate } from '../../shared/contracts/system-backup-v5-archive-admission.ts';
import { SYSTEM_BACKUP_MAX_ARCHIVE_BYTES } from '../../shared/contracts/system-backup.ts';
import { PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256 } from '../../shared/contracts/portable-runtime-v28-recovery-catalog.ts';
import { NODE_RECOVERY_ARCHIVE_OPTIONS } from '../../scripts/lib/system-backup-node-io.ts';

export class RestoredV28MaintenanceReleaseError extends Error {
  constructor(readonly code: 'unavailable' | 'request_conflict' | 'revision_conflict' = 'unavailable', options?: ErrorOptions) {
    super('Stopped restored V28 maintenance release is unavailable; reconcile the same request ID.', options);
    this.name = 'RestoredV28MaintenanceReleaseError';
  }
}
export interface RestoredV28MaintenanceReleaseCommand { readonly kind: 'fixed-stopped-restored-v28-maintenance-release/1' }
interface Selection { databasePath: string; principalId: string; installationId: string; requestId: string; expectedGeneration: number; rootUid: number }
interface Pin { path: string; fd: number; original: BigIntStats; closeAttempted: boolean; closeFailed: boolean; closeFailure?: unknown }
interface Owner {
  acquisition?: Promise<LinuxWriterLease>; lease?: LinuxWriterLease; nativeAttempted: boolean; native?: DatabaseSync;
  nativeConstructionFailure?: unknown; core?: SqliteCapability; pins: Pin[];
  nativeCloseAttempted: boolean; nativeCloseFailed: boolean; nativeCloseFailure?: unknown;
  originalWork?: Promise<SystemRecoveryMaintenanceReceipt>; close?: Promise<void>; drain?: Promise<void>; release?: Promise<void>;
  failure?: unknown;
}
const issued = new WeakMap<RestoredV28MaintenanceReleaseCommand, Readonly<Selection>>(), owners = new Set<Owner>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POLICY = Object.freeze({ absoluteLifetimeMs: 12 * 3600_000, idleLifetimeMs: 1800_000,
  loginWindowMs: 60_000, loginAttempts: 5, throttleBuckets: 1000 });
export const RESTORED_V28_MAINTENANCE_RELEASE_USAGE = 'Usage: local-installation release-restored-maintenance --runtime-profile v28 --database <private-restored-database.sqlite> --principal local_UUID --installation UUID --request-id UUID --expected-generation N [--filesystem-root-owner-uid UID]\nRequires the actual stopped restored V28 target, current destination bootstrap administrator, disabled execution guards and no unreleased recovery writer. Reconciles only the same stored request receipt. It grants no Group, File, Jobs or domain capability.\n';
function ensure(value: unknown): asserts value { if (!value) throw new RestoredV28MaintenanceReleaseError(); }
export function parseRestoredV28MaintenanceReleaseCommand(argv: readonly string[]): RestoredV28MaintenanceReleaseCommand {
  ensure(Array.isArray(argv) && [13, 15].includes(argv.length) && argv[0] === 'release-restored-maintenance'
    && argv.every(value => typeof value === 'string' && value.length > 0 && value.length <= 4000 && !value.includes('\0')));
  const fields = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]!;
    ensure(['--runtime-profile', '--database', '--principal', '--installation', '--request-id', '--expected-generation', '--filesystem-root-owner-uid'].includes(name)
      && !fields.has(name)); fields.set(name, argv[index + 1]!);
  }
  const databasePath = fields.get('--database'), principalId = fields.get('--principal');
  const installationId = fields.get('--installation'), requestId = fields.get('--request-id'), generation = fields.get('--expected-generation');
  ensure(fields.get('--runtime-profile') === 'v28' && typeof databasePath === 'string' && isAbsolute(databasePath)
    && resolve(databasePath) === databasePath && basename(databasePath) === 'database.sqlite'
    && typeof principalId === 'string' && principalId.startsWith('local_') && UUID.test(principalId.slice(6))
    && typeof installationId === 'string' && UUID.test(installationId) && typeof requestId === 'string' && UUID.test(requestId)
    && typeof generation === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(generation)
    && Number.isSafeInteger(Number(generation)) && Number(generation) < Number.MAX_SAFE_INTEGER);
  const rawUid = fields.get('--filesystem-root-owner-uid'), rootUid = rawUid === undefined ? 0 : Number(rawUid);
  ensure((rawUid === undefined || /^(?:0|[1-9][0-9]{0,9})$/.test(rawUid)) && Number.isSafeInteger(rootUid) && rootUid >= 0 && rootUid <= 0xffff_ffff);
  const input = checkedSystemRecoveryMaintenanceInput({ requestId, action: 'release', expectedGeneration: Number(generation) });
  const token = Object.freeze({ kind: 'fixed-stopped-restored-v28-maintenance-release/1' as const });
  issued.set(token, Object.freeze({ databasePath, principalId, installationId, requestId: input.requestId, expectedGeneration: input.expectedGeneration, rootUid }));
  return token;
}
export function restoredV28MaintenanceReleaseProcessState() { return Object.freeze({ retainedOriginalOwners: owners.size }); }
function same(a: BigIntStats, b: BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode
    && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function assertPin(pin: Pin) {
  ensure(!pin.closeAttempted && realpathSync(pin.path) === pin.path);
  const path = lstatSync(pin.path, { bigint: true }), fd = fstatSync(pin.fd, { bigint: true });
  ensure(path.isFile() && !path.isSymbolicLink() && path.nlink === 1n && path.uid === BigInt(process.geteuid!())
    && (path.mode & 0o7777n) === 0o600n && same(pin.original, path) && same(path, fd));
}
function openPin(owner: Owner, path: string, max: number): Pin {
  const original = lstatSync(path, { bigint: true });
  ensure(original.isFile() && !original.isSymbolicLink() && original.nlink === 1n && original.uid === BigInt(process.geteuid!())
    && (original.mode & 0o7777n) === 0o600n && original.size > 0n && original.size <= BigInt(max) && realpathSync(path) === path);
  const pin = { path, original, fd: openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), closeAttempted: false, closeFailed: false };
  owner.pins.push(pin); assertPin(pin); return pin;
}
function read(owner: Owner, pin: Pin, offset: number, length: number): Uint8Array {
  ensure(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && length <= 65536
    && BigInt(offset) + BigInt(length) <= pin.original.size);
  for (const item of owner.pins) assertPin(item);
  const bytes = new Uint8Array(length); let cursor = 0;
  while (cursor < length) { const count = readSync(pin.fd, bytes, cursor, length - cursor, offset + cursor); ensure(count > 0); cursor += count; }
  for (const item of owner.pins) assertPin(item); return bytes;
}
function closePin(pin: Pin) {
  if (pin.closeAttempted) { if (pin.closeFailed) throw pin.closeFailure; return; }
  pin.closeAttempted = true;
  try { closeSync(pin.fd); } catch (error) { pin.closeFailed = true; pin.closeFailure = error; throw error; }
}
function closeOwner(owner: Owner) {
  return owner.close ??= Promise.resolve().then(async () => {
    await owner.originalWork?.then(() => undefined, () => undefined);
    const failures: unknown[] = [];
    for (const pin of [...owner.pins].reverse()) {
      try { assertPin(pin); } catch (error) { failures.push(error); }
      try { closePin(pin); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Original restored receipt/archive FD closure failed');
    if (owner.lease) { owner.drain ??= owner.lease.stopAdmissionAndDrain(); await owner.drain; }
    if (owner.nativeAttempted && !owner.native) throw owner.nativeConstructionFailure;
    if (!owner.nativeCloseAttempted) {
      owner.nativeCloseAttempted = true;
      try { if (owner.core) owner.core.close(); else owner.native?.close(); }
      catch (error) { owner.nativeCloseFailed = true; owner.nativeCloseFailure = error; throw error; }
    } else if (owner.nativeCloseFailed) throw owner.nativeCloseFailure;
    ensure(!owner.native?.isOpen);
    if (owner.lease) { owner.release ??= owner.lease.release(); await owner.release; }
    owners.delete(owner);
  });
}
function integer(value: unknown): number {
  ensure(typeof value === 'number' || typeof value === 'bigint'); return checkedSafeInteger(value, 'Current restored authority integer');
}
function receipt(row: SqliteRow | undefined, selected: Readonly<Selection>, actor: string): SystemRecoveryMaintenanceReceipt | null {
  if (!row) return null;
  if (row.actor !== actor || row.action !== 'release' || integer(row.expected_generation) !== selected.expectedGeneration)
    throw new RestoredV28MaintenanceReleaseError('request_conflict');
  ensure(typeof row.result_json === 'string' && Buffer.byteLength(row.result_json) <= 65536);
  const result = checkedSystemRecoveryMaintenanceReceipt({ requestId: selected.requestId, action: 'release',
    expectedGeneration: selected.expectedGeneration, status: JSON.parse(row.result_json) });
  ensure(result.status.state === 'open' && result.status.generation === selected.expectedGeneration + 1 && result.status.token === null
    && result.status.checkpoint === null && result.status.backupJobId === null && result.status.activeWriters === 0);
  return Object.freeze({ ...result, status: Object.freeze(result.status) });
}

/** Stopped destination deployment authority, not a Worker Access actor/Env or
 * browser grant. The current real bootstrap administrator is checked in the
 * same Native BEGIN; restoration data never imports its source authority. */
export function executeRestoredV28MaintenanceRelease(token: RestoredV28MaintenanceReleaseCommand): Promise<SystemRecoveryMaintenanceReceipt> {
  const originalSelection = issued.get(token); ensure(originalSelection && process.platform === 'linux' && typeof process.geteuid === 'function' && owners.size < 2);
  const selected: Readonly<Selection> = originalSelection;
  const owner: Owner = { nativeAttempted: false, pins: [], nativeCloseAttempted: false, nativeCloseFailed: false }; owners.add(owner);
  owner.originalWork = Promise.resolve().then(async () => {
    owner.acquisition = acquireLinuxWriterLease({ databasePath: selected.databasePath, filesystemRootOwnerUid: selected.rootUid });
    owner.lease = await owner.acquisition; const lease = owner.lease;
    return await lease.withWriter(async () => {
      lease.assertHeld();
      const directory = dirname(selected.databasePath), reportPin = openPin(owner, join(directory, 'recovery-report.json'), 65536);
      const report: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read(owner, reportPin, 0, Number(reportPin.original.size))));
      ensure(report && typeof report === 'object' && !Array.isArray(report));
      const detail = report as Record<string, unknown>;
      ensure(detail.kind === 'offline-system-backup-recovery' && detail.databasePath === 'database.sqlite'
        && detail.originalArchivePath === 'original-archive.zip' && detail.destinationCheckpoint === 'portable-runtime/v28'
        && detail.destinationInstallationId === selected.installationId && detail.sourceImageSchemaSha256 === PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256
        && detail.executionEnabled === false && detail.nativeBindingsRestored === false && detail.maintenanceState === 'fenced'
        && typeof detail.sourceArchiveSha256 === 'string' && /^[0-9a-f]{64}$/.test(detail.sourceArchiveSha256));
      const archivePin = openPin(owner, join(directory, 'original-archive.zip'), SYSTEM_BACKUP_MAX_ARCHIVE_BYTES);
      const archive = await validateV28SystemBackupArchiveCandidate({ byteSize: Number(archivePin.original.size),
        async read(offset, length, signal) { signal?.throwIfAborted(); return read(owner, archivePin, offset, length); } },
      { ...NODE_RECOVERY_ARCHIVE_OPTIONS, expectedSha256: detail.sourceArchiveSha256 });
      ensure(archive.manifest.completeness === 'complete' && detail.backupId === archive.records.backupId
        && detail.payloads === archive.manifest.counts.packagedFiles && detail.payloadBytes === archive.manifest.counts.bytes);
      ensure(detail.verification && typeof detail.verification === 'object' && !Array.isArray(detail.verification));
      const verification = detail.verification as Record<string, unknown>;
      ensure(Object.keys(verification).length === 5 && verification.exactTypedRows === true && verification.exactRowids === true
        && verification.foreignKeys === true && verification.integrity === 'ok' && verification.reviewedSchema === true);
      const accounts = archive.records.image.tables.local_accounts, idIndex = accounts.columns.indexOf('principal_id');
      ensure(idIndex >= 0 && accounts.rows.some(row => { const cell = row.cells[idIndex]; return cell?.type === 'text' && cell.value === selected.principalId; }));
      if (archive.records.sourceMigrationLedger.kind === 'node-reviewed-migrations/1') ensure(archive.records.sourceMigrationLedger.installationId !== selected.installationId);
      lease.assertHeld(); owner.nativeAttempted = true;
      try { owner.native = new DatabaseSync(selected.databasePath, { allowExtension: false, enableForeignKeyConstraints: true }); }
      catch (error) { owner.nativeConstructionFailure = error; throw error; }
      const native = owner.native, core = owner.core = createSqliteCapability(native); lease.bind(core, native);
      const admission = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE);
      const installed = assertInstallationAdmission(native, admission); ensure(installed.installationId === selected.installationId);
      const installedIdentity = await createInstalledLocalIdentity({ database: core, nativeDatabase: native, admission, hasher: createPasswordHasher(), policy: POLICY });
      assertInstalledLocalIdentityOwner(installedIdentity, core, native, admission);
      const authority = native.prepare(`SELECT a.credential_revision,g.granted_at,s.initialized_at FROM local_accounts a
        JOIN local_admin_grants g ON g.principal_id=a.principal_id JOIN local_identity_installation s ON s.bootstrap_principal_id=a.principal_id
        WHERE a.principal_id=? AND a.enabled=1 AND s.singleton=1 AND s.catalog_id='local-identity-v1'`).get(selected.principalId);
      ensure(authority);
      const revision = integer(authority.credential_revision), grantedAt = integer(authority.granted_at), initializedAt = integer(authority.initialized_at);
      const actor = `local-account:${selected.principalId}`;
      const prepare = (sql: string, ...values: unknown[]) => core.prepare(sql).bind(...values);
      const checks: SqliteBatchAdmissionCheck[] = [
        { statement: prepare(`SELECT 1 admitted FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=?
          AND schema_checkpoint=? AND schema_sha256=? AND created_at=?`, installed.installationId, installed.catalogId, installed.checkpointId, installed.schemaSha256, installed.createdAt),
          rejection: new RestoredV28MaintenanceReleaseError() },
        { statement: prepare(`SELECT 1 admitted FROM local_accounts a JOIN local_admin_grants g ON g.principal_id=a.principal_id
          JOIN local_identity_installation s ON s.bootstrap_principal_id=a.principal_id WHERE a.principal_id=? AND a.enabled=1
          AND a.credential_revision=? AND g.granted_at=? AND s.singleton=1 AND s.catalog_id='local-identity-v1' AND s.initialized_at=?`,
          selected.principalId, revision, grantedAt, initializedAt), rejection: new RestoredV28MaintenanceReleaseError() },
      ];
      const current = () => { for (const pin of owner.pins) assertPin(pin); assertLinuxWriterLeaseBinding(lease, core, native);
        assertInstalledLocalIdentityOwner(installedIdentity, core, native, admission); };
      const selectReceipt = () => prepare('SELECT actor,action,expected_generation,result_json FROM system_recovery_maintenance_requests WHERE request_id=?', selected.requestId);
      const readOriginal = async () => { current(); const values = await runSqliteAdmittedBatch(core, [selectReceipt()], createSqliteBatchAdmission(core, checks));
        current(); ensure(values.length === 1 && values[0]!.results.length <= 1); return receipt(values[0]!.results[0], selected, actor); };
      // Replay checks real current authority but does not require the obsolete
      // fenced generation after a prior commit. No new mutation/activation occurs.
      const prior = await readOriginal(); if (prior) return prior;
      const mutationChecks: SqliteBatchAdmissionCheck[] = [...checks,
        { statement: prepare("SELECT 1 admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='fenced' AND generation=?", selected.expectedGeneration),
          rejection: new RestoredV28MaintenanceReleaseError('revision_conflict') },
        { statement: prepare(`SELECT 1 admitted WHERE EXISTS(SELECT 1 FROM file_shadow_runtime_guard WHERE singleton=1 AND enabled=0)
          AND EXISTS(SELECT 1 FROM file_authority_runtime_guard WHERE singleton=1 AND enabled=0)
          AND EXISTS(SELECT 1 FROM file_job_runtime_guard WHERE singleton=1 AND enabled=0)
          AND EXISTS(SELECT 1 FROM system_recovery_runtime WHERE singleton=1 AND enabled=0)`), rejection: new RestoredV28MaintenanceReleaseError() },
        { statement: prepare('SELECT 1 admitted WHERE NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)'), rejection: new RestoredV28MaintenanceReleaseError() },
      ];
      const now = new Date().toISOString(); current();
      try {
        await runSqliteAdmittedBatch(core, [
          prepare(`UPDATE system_recovery_maintenance SET state='open',generation=generation+1,token=NULL,requested_by=NULL,
          backup_job_id=NULL,checkpoint_sha256=NULL,started_at=NULL,fenced_at=NULL,updated_at=? WHERE singleton=1 AND generation=? AND state='fenced'`, now, selected.expectedGeneration),
          prepare(`INSERT INTO system_recovery_maintenance_requests(request_id,actor,action,expected_generation,result_json,created_at)
        SELECT ?,?,?,?,json_object('state',state,'generation',generation,'token',token,'checkpoint',checkpoint_sha256,'backupJobId',backup_job_id,
          'activeWriters',(SELECT count(*) FROM system_recovery_write_leases WHERE released_at IS NULL)),?
        FROM system_recovery_maintenance WHERE singleton=1`, selected.requestId, actor, 'release', selected.expectedGeneration, now),
        ], createSqliteBatchAdmission(core, mutationChecks));
      } catch (error) {
        // One exact same-request readback, no business replay or arbitrary cause
        // classification. A quarantined/unknown core remains unavailable.
        let original: SystemRecoveryMaintenanceReceipt | null;
        try { original = await readOriginal(); }
        catch (readbackError) { throw new RestoredV28MaintenanceReleaseError('unavailable', { cause: new AggregateError([error, readbackError], 'Original release and receipt readback failed') }); }
        if (original) return original;
        if (mutationChecks.some(check => check.rejection === error)) throw error;
        throw new RestoredV28MaintenanceReleaseError('unavailable', { cause: error });
      }
      const result = await readOriginal(); ensure(result); return result;
    });
  });
  return Promise.resolve().then(async () => {
    let failed = false, failure: unknown, result: SystemRecoveryMaintenanceReceipt | undefined;
    try { result = await owner.originalWork; } catch (error) { failed = true; failure = error; owner.failure = error; }
    try { await closeOwner(owner); } catch (cleanup) {
      const error = new AggregateError(failed ? [failure, cleanup] : [cleanup], 'Original release and first owner closure failed'); owner.failure = error; throw error;
    }
    if (failed) throw failure; ensure(result); return result;
  });
}
