import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createPasswordHasher } from '../auth/passwords';
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from '../installation-catalog-v28-candidate.ts';
import { admitInstallationRecoverySource, assertInstallationAdmission } from '../migrations';
import { executeIdentityOperator, parseIdentityOperatorCommand } from './identity-operator';
import { executeCollaborationV28OperatorCandidate } from './collaboration-v28-operator-candidate.ts';
import { parseV28GroupInstallationCommand } from './v28-group-installation-command.ts';
import { CANONICAL_FILE_PASSWORD, canonicalFileObject, retainedCanonicalFileCase,
  withCanonicalFileDatabase } from '../collaboration/current-v28-canonical-comment-file.qualification-support';

// The controller must provide a NEW destination from the actual qualified V5
// restorer, plus the unchanged report digest. No copied live/failed database,
// synthetic account SQL, manually fenced database or source authority fixture
// is accepted as the preparation for these two ordered cases.
let path: string, principalId: string, installationId: string, rootUid: string;
let reportPath: string, reportSha256: string;
const principalPattern = /^local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function ensure(value: unknown): asserts value { if (!value) throw new Error('Fresh genuine V5 restored target inputs are required'); }
beforeAll(() => retainedCanonicalFileCase(async () => {
  path = process.env.CURRENT_V28_POST_RESTORE_DATABASE ?? '';
  principalId = process.env.CURRENT_V28_POST_RESTORE_PRINCIPAL ?? '';
  reportSha256 = process.env.CURRENT_V28_POST_RESTORE_REPORT_SHA256 ?? '';
  rootUid = process.env.NODE_PROTOTYPE_FILESYSTEM_ROOT_OWNER_UID ?? '';
  const parent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT ?? '';
  ensure(isAbsolute(path) && resolve(path) === path && path.startsWith(`${parent}/`) && join(dirname(path), 'database.sqlite') === path
    && principalPattern.test(principalId) && /^[0-9a-f]{64}$/.test(reportSha256));
  ensure(await realpath(path) === path);
  const stat = await lstat(path);
  ensure(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.geteuid?.() && (stat.mode & 0o7777) === 0o600);
  reportPath = join(dirname(path), 'recovery-report.json');
  const bytes = await readFile(reportPath);
  ensure(createHash('sha256').update(bytes).digest('hex') === reportSha256);
  const report = canonicalFileObject(JSON.parse(bytes.toString('utf8')));
  ensure(report.destinationCheckpoint === 'portable-runtime/v28' && report.executionEnabled === false
    && report.nativeBindingsRestored === false && report.maintenanceState === 'fenced'
    && typeof report.destinationInstallationId === 'string');
  installationId = report.destinationInstallationId;
  // Deployment-owned exclusive preprovisioning; the restorer creates no lock.
  // Existing locks are refused rather than removed/replaced or inferred idle.
  await writeFile(`${path}.writer-lock`, '', { flag: 'wx', mode: 0o600 });
}), 20_000);
function admitted(native: DatabaseSync) {
  expect(assertInstallationAdmission(native, admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE)).installationId)
    .toBe(installationId);
}
function stillInert(native: DatabaseSync) {
  expect(native.prepare("SELECT state FROM system_recovery_maintenance WHERE singleton=1").get()?.state).toBe('fenced');
  for (const name of ['file_shadow_runtime_guard', 'file_authority_runtime_guard', 'file_job_runtime_guard', 'system_recovery_runtime'])
    expect(native.prepare(`SELECT enabled FROM ${name}`).get()?.enabled).toBe(0);
  for (const name of ['local_sessions', 'collaboration_resources', 'collaboration_grants', 'local_storage_profile_bindings', 'system_storage_native_bindings'])
    expect(native.prepare(`SELECT count(*) n FROM ${name}`).get()?.n).toBe(0);
}
const identityArgs = (kind: 'restore-administrator' | 'reset-password', selected = true) => [kind, '--database', path,
  '--principal', principalId, '--filesystem-root-owner-uid', rootUid, ...(selected ? ['--runtime-profile', 'v28'] : [])];
const groupArgs = (kind: 'enroll-local-member' | 'set-enforcement') => [kind, '--runtime-profile', 'v28', '--database', path,
  '--filesystem-root-owner-uid', rootUid, '--expected-control-revision', '1'];

describe('genuine restored V28 separate identity and Group operational entries', () => {
  it('requires explicit V28 and stopped ownership to restore one disabled principal while maintenance and runtime authority remain inert',
    () => retainedCanonicalFileCase(async () => {
      await withCanonicalFileDatabase(path, async (_owner, lease, native) => lease.withWriter(async () => {
        admitted(native); stillInert(native);
        expect(native.prepare('SELECT enabled FROM local_accounts WHERE principal_id=?').get(principalId)?.enabled).toBe(0);
        for (const name of ['local_identity_installation', 'local_admin_grants', 'collaboration_members', 'collaboration_identities'])
          expect(native.prepare(`SELECT count(*) n FROM ${name}`).get()?.n).toBe(0);
        await expect(executeIdentityOperator(parseIdentityOperatorCommand(identityArgs('restore-administrator')), CANONICAL_FILE_PASSWORD))
          .rejects.toThrow('unavailable'); // The actual original writer lock is held.
      }));
      await expect(executeIdentityOperator(parseIdentityOperatorCommand(identityArgs('restore-administrator', false)), CANONICAL_FILE_PASSWORD))
        .rejects.toThrow('unavailable'); // Default V26 cannot admit the restored V28.
      await executeIdentityOperator(parseIdentityOperatorCommand(identityArgs('restore-administrator')), CANONICAL_FILE_PASSWORD);
      await executeIdentityOperator(parseIdentityOperatorCommand(identityArgs('reset-password')), CANONICAL_FILE_PASSWORD);
      await withCanonicalFileDatabase(path, async (_owner, lease, native) => lease.withWriter(async () => {
        admitted(native); stillInert(native);
        expect(native.prepare('SELECT count(*) n FROM local_accounts WHERE enabled=1').get()?.n).toBe(1);
        const selected = native.prepare('SELECT enabled,password_verifier FROM local_accounts WHERE principal_id=?').get(principalId);
        expect(selected?.enabled).toBe(1);
        expect(await createPasswordHasher().verify(CANONICAL_FILE_PASSWORD, selected?.password_verifier)).toBe(true);
        expect(native.prepare('SELECT count(*) n FROM local_admin_grants WHERE principal_id=?').get(principalId)?.n).toBe(1);
        expect(native.prepare('SELECT count(*) n FROM local_admin_grants').get()?.n).toBe(1);
        expect(native.prepare('SELECT bootstrap_principal_id FROM local_identity_installation WHERE singleton=1').get()?.bootstrap_principal_id).toBe(principalId);
        expect(native.prepare('SELECT enforcement,revision FROM collaboration_control WHERE singleton=1').get()).toEqual({ enforcement: 'disabled', revision: 1 });
      }));
      expect(createHash('sha256').update(await readFile(reportPath)).digest('hex')).toBe(reportSha256);
    }), 20_000);
  it('enrolls only the selected actual principal and enables Group through explicit revision CAS without releasing maintenance or granting domains',
    () => retainedCanonicalFileCase(async () => {
      const enable = parseV28GroupInstallationCommand([...groupArgs('set-enforcement'), '--enforcement', 'enabled']);
      await expect(executeCollaborationV28OperatorCandidate(enable)).rejects.toThrow('unavailable'); // No member administrator yet.
      const member = await executeCollaborationV28OperatorCandidate(parseV28GroupInstallationCommand([...groupArgs('enroll-local-member'),
        '--principal', principalId, '--display-name', 'Restored destination operator', '--workspace-role', 'membershipAdministrator', '--can-create-samples', 'false']));
      expect(member.principalId).toBe(principalId); expect(member.memberId).toEqual(expect.any(String));
      const receipt = await executeCollaborationV28OperatorCandidate(enable);
      expect(receipt.installationId).toBe(installationId); expect(receipt.controlRevision).toBe(2); expect(receipt.enforcement).toBe('enabled');
      await expect(executeCollaborationV28OperatorCandidate(enable)).rejects.toThrow('unavailable'); // The original revision is stale; no replay is invented.
      await withCanonicalFileDatabase(path, async (_owner, lease, native) => lease.withWriter(async () => {
        admitted(native); stillInert(native);
        expect(native.prepare('SELECT enforcement,revision FROM collaboration_control WHERE singleton=1').get()).toEqual({ enforcement: 'enabled', revision: 2 });
        expect(native.prepare('SELECT workspace_role,can_create_samples,can_create_projects,can_create_templates FROM collaboration_members WHERE member_id=?').get(member.memberId!))
          .toEqual({ workspace_role: 'membershipAdministrator', can_create_samples: 0, can_create_projects: 0, can_create_templates: 0 });
        expect(native.prepare('SELECT provider,issuer,subject,enabled FROM collaboration_identities WHERE member_id=?').get(member.memberId!))
          .toEqual({ provider: 'local', issuer: `node-installation:${installationId}`, subject: principalId, enabled: 1 });
      }));
    }), 20_000);
});
