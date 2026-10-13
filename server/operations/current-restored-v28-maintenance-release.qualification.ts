import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseRestoredV28MaintenanceReleaseCommand, executeRestoredV28MaintenanceRelease,
  restoredV28MaintenanceReleaseProcessState } from './restored-v28-maintenance-release-operator.ts';
import { executeOfflineV28Restore, parseOfflineV28RestoreCommand } from './restore-v28-operator';
import { executeIdentityOperator, parseIdentityOperatorCommand } from './identity-operator';
import { canonicalFileObject, retainedCanonicalFileCase, withCanonicalFileDatabase } from '../collaboration/current-v28-canonical-comment-file.qualification-support';

// Root supplies the NEW actual V5 destination ONLY after current preparation1
// and destination operators2 PASS/normal closure. No historical target, copied
// database, manually seeded fence/admin or synthetic maintenance row is used.
let path: string, principal: string, installation: string, generation: number, rootUid: string;
function ensure(value: unknown): asserts value { if (!value) throw new Error('Fresh qualified restored target inputs required'); }
beforeAll(() => retainedCanonicalFileCase(async () => {
  path = process.env.CURRENT_V28_POST_RESTORE_DATABASE ?? ''; principal = process.env.CURRENT_V28_POST_RESTORE_PRINCIPAL ?? '';
  rootUid = process.env.NODE_PROTOTYPE_FILESYSTEM_ROOT_OWNER_UID ?? '';
  const reportBytes = await readFile(join(dirname(path), 'recovery-report.json'));
  ensure(createHash('sha256').update(reportBytes).digest('hex') === process.env.CURRENT_V28_POST_RESTORE_REPORT_SHA256);
  const report = canonicalFileObject(JSON.parse(reportBytes.toString('utf8')));
  ensure(typeof report.destinationInstallationId === 'string' && report.destinationCheckpoint === 'portable-runtime/v28');
  installation = report.destinationInstallationId;
  await withCanonicalFileDatabase(path, async (_owner, lease, native) => lease.withWriter(async () => {
    const maintenance = native.prepare('SELECT state,generation FROM system_recovery_maintenance WHERE singleton=1').get();
    ensure(maintenance?.state === 'fenced' && typeof maintenance.generation === 'number' && Number.isSafeInteger(maintenance.generation)
      && maintenance.generation >= 0 && maintenance.generation < Number.MAX_SAFE_INTEGER - 1); generation = maintenance.generation;
    expect(native.prepare('SELECT enforcement FROM collaboration_control WHERE singleton=1').get()?.enforcement).toBe('enabled');
    expect(native.prepare('SELECT principal_id FROM local_admin_grants').all()).toEqual([{ principal_id: principal }]);
  }));
}), 20_000);
function command(target = path, id = installation, actor = principal, requestId = randomUUID(), expected = generation) {
  return parseRestoredV28MaintenanceReleaseCommand(['release-restored-maintenance', '--runtime-profile', 'v28', '--database', target,
    '--principal', actor, '--installation', id, '--request-id', requestId, '--expected-generation', String(expected), '--filesystem-root-owner-uid', rootUid]);
}
async function boundary(target = path) {
  return withCanonicalFileDatabase(target, async (_owner, lease, native) => lease.withWriter(async () => ({
    maintenance: native.prepare('SELECT state,generation FROM system_recovery_maintenance WHERE singleton=1').get(),
    requests: native.prepare('SELECT count(*) n FROM system_recovery_maintenance_requests').get()?.n,
    guards: ['file_shadow_runtime_guard', 'file_authority_runtime_guard', 'file_job_runtime_guard', 'system_recovery_runtime'].map(name => native.prepare(`SELECT enabled FROM ${name}`).get()?.enabled),
    groups: native.prepare('SELECT schema_version,enforcement,revision FROM collaboration_control WHERE singleton=1').get(),
    members: native.prepare('SELECT count(*) n FROM collaboration_members').get()?.n,
    grants: native.prepare('SELECT count(*) n FROM collaboration_grants').get()?.n,
    sessions: native.prepare('SELECT count(*) n FROM local_sessions').get()?.n,
    bindings: native.prepare('SELECT count(*) n FROM local_storage_profile_bindings').get()?.n,
  })));
}
function contains(value: unknown, original: unknown, seen = new Set<unknown>()): boolean {
  if (value === original) return true;
  if (!value || typeof value !== 'object' || seen.has(value)) return false; seen.add(value);
  return value instanceof AggregateError && value.errors.some(error => contains(error, original, seen))
    || 'cause' in value && contains(value.cause, original, seen);
}
describe.sequential('genuine restored V28 stopped maintenance release', () => {
  it('refuses a real competing writer, wrong installation/principal and stale generation without changing the fenced target', () => retainedCanonicalFileCase(async () => {
    const before = await boundary();
    await withCanonicalFileDatabase(path, async (_owner, lease) => lease.withWriter(async () => {
      await expect(executeRestoredV28MaintenanceRelease(command())).rejects.toThrow('unavailable');
    }));
    await expect(executeRestoredV28MaintenanceRelease(command(path, randomUUID()))).rejects.toThrow('unavailable');
    await expect(executeRestoredV28MaintenanceRelease(command(path, installation, `local_${randomUUID()}`))).rejects.toThrow('unavailable');
    await expect(executeRestoredV28MaintenanceRelease(command(path, installation, principal, randomUUID(), generation + 1))).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(await boundary()).toEqual(before); expect(restoredV28MaintenanceReleaseProcessState().retainedOriginalOwners).toBe(0);
  }), 20_000);
  it('commits one original release receipt, reconciles the same ID after open and rejects changed input without activating any other owner', () => retainedCanonicalFileCase(async () => {
    const before = await boundary(), requestId = randomUUID();
    const result = await executeRestoredV28MaintenanceRelease(command(path, installation, principal, requestId));
    expect(result).toEqual({ requestId, action: 'release', expectedGeneration: generation,
      status: { state: 'open', generation: generation + 1, token: null, checkpoint: null, backupJobId: null, activeWriters: 0 } });
    expect(await executeRestoredV28MaintenanceRelease(command(path, installation, principal, requestId))).toEqual(result);
    await expect(executeRestoredV28MaintenanceRelease(command(path, installation, principal, requestId, generation + 1))).rejects.toMatchObject({ code: 'request_conflict' });
    await expect(executeRestoredV28MaintenanceRelease(command())).rejects.toMatchObject({ code: 'revision_conflict' });
    const after = await boundary();
    expect(after.maintenance).toEqual({ state: 'open', generation: generation + 1 }); expect(after.requests).toBe(Number(before.requests) + 1);
    expect({ ...after, maintenance: before.maintenance, requests: before.requests }).toEqual(before);
    expect(after.guards).toEqual([0, 0, 0, 0]); expect(restoredV28MaintenanceReleaseProcessState().retainedOriginalOwners).toBe(0);
  }), 20_000);
  it('retains a genuine commit ACK failure and reconciles its original durable receipt on a second fresh restored target without replaying the write', () => retainedCanonicalFileCase(async () => {
    const destination = join(dirname(dirname(path)), `.maintenance-lost-ACK-${randomUUID()}`);
    const sourceReport = canonicalFileObject(JSON.parse(await readFile(join(dirname(path), 'recovery-report.json'), 'utf8')));
    const sourceArchiveSha256 = sourceReport.sourceArchiveSha256;
    ensure(typeof sourceArchiveSha256 === 'string' && /^[0-9a-f]{64}$/.test(sourceArchiveSha256));
    const restored = await executeOfflineV28Restore(parseOfflineV28RestoreCommand(['restore', '--archive', join(dirname(path), 'original-archive.zip'),
      '--destination', destination, '--sha256', sourceArchiveSha256, '--filesystem-root-owner-uid', rootUid]));
    const target = restored.databasePath; await writeFile(`${target}.writer-lock`, '', { flag: 'wx', mode: 0o600 });
    await executeIdentityOperator(parseIdentityOperatorCommand(['restore-administrator', '--runtime-profile', 'v28', '--database', target,
      '--principal', principal, '--filesystem-root-owner-uid', rootUid]), 'Synthetic separate restored maintenance fault fixture password');
    const id = restored.report.destinationInstallationId, requestId = randomUUID();
    const fresh = await boundary(target), freshGeneration = fresh.maintenance?.generation;
    ensure(typeof freshGeneration === 'number' && Number.isSafeInteger(freshGeneration) && freshGeneration >= 0 && freshGeneration < Number.MAX_SAFE_INTEGER);
    const originalExec = DatabaseSync.prototype.exec, originalFailure = new Error('Fixed original maintenance commit ACK failure'); let fired = false;
    DatabaseSync.prototype.exec = function(sql: string) {
      if (!fired && sql === 'COMMIT' && this.prepare('SELECT 1 FROM system_recovery_maintenance_requests WHERE request_id=?').get(requestId)) {
        originalExec.call(this, sql); fired = true; throw originalFailure;
      }
      return originalExec.call(this, sql);
    };
    let failure: unknown;
    try { await executeRestoredV28MaintenanceRelease(command(target, id, principal, requestId, freshGeneration)); }
    catch (error) { failure = error; }
    finally { DatabaseSync.prototype.exec = originalExec; }
    expect(fired).toBe(true); expect(contains(failure, originalFailure)).toBe(true);
    const replay = await executeRestoredV28MaintenanceRelease(command(target, id, principal, requestId, freshGeneration));
    expect(replay.status.state).toBe('open'); expect(replay.status.generation).toBe(freshGeneration + 1);
    const observed = await boundary(target); expect(observed.requests).toBe(1); expect(observed.guards).toEqual([0, 0, 0, 0]);
    expect(observed.members).toBe(0); expect(observed.grants).toBe(0); expect(observed.sessions).toBe(0); expect(observed.bindings).toBe(0);
    expect(restoredV28MaintenanceReleaseProcessState().retainedOriginalOwners).toBe(0);
  }), 20_000);
});
