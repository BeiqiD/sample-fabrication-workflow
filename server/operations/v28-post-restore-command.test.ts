import { describe, expect, it } from 'vitest';
import { parseIdentityOperatorCommand, IdentityOperatorError } from './identity-operator';
import { parseV28GroupInstallationCommand, V28GroupInstallationCommandError } from './v28-group-installation-command.ts';

const principal = 'local_12345678-1234-4234-8234-123456789abc';
const identity = ['restore-administrator', '--database', '/private/database.sqlite', '--principal', principal];
const enroll = ['enroll-local-member', '--runtime-profile', 'v28', '--database', '/private/database.sqlite',
  '--principal', principal, '--display-name', 'Destination operator', '--workspace-role', 'membershipAdministrator',
  '--can-create-samples', 'false', '--expected-control-revision', '1'];
const enable = ['set-enforcement', '--runtime-profile', 'v28', '--database', '/private/database.sqlite',
  '--enforcement', 'enabled', '--expected-control-revision', '1'];

describe('explicit restored V28 operational command selection', () => {
  it('keeps absent-profile identity commands V26 and accepts only explicit V28 restore/reset', () => {
    expect(parseIdentityOperatorCommand(identity)).not.toHaveProperty('runtimeProfile');
    expect(parseIdentityOperatorCommand([...identity, '--runtime-profile', 'v28'])).toEqual({
      kind: 'restore-administrator', databasePath: '/private/database.sqlite', principalId: principal, runtimeProfile: 'v28' });
    expect(parseIdentityOperatorCommand(['reset-password', ...identity.slice(1), '--runtime-profile', 'v28']).runtimeProfile).toBe('v28');
    for (const input of [['bootstrap', '--database', '/private/database.sqlite', '--username', 'operator', '--runtime-profile', 'v28'],
      [...identity, '--runtime-profile', 'v26'], [...identity, '--runtime-profile', 'v28', '--runtime-profile', 'v28']])
      expect(() => parseIdentityOperatorCommand(input)).toThrow(IdentityOperatorError);
  });
  it('requires explicit Group profile, role, creation flag and control CAS without caller authority inputs', () => {
    const selected = parseV28GroupInstallationCommand(enroll);
    expect(selected).toMatchObject({ kind: 'enroll-local-member', principalId: principal, workspaceRole: 'membershipAdministrator',
      canCreateSamples: false, expectedControlRevision: 1 });
    expect(Object.isFrozen(selected)).toBe(true); expect(selected).not.toHaveProperty('runtimeProfile');
    expect(parseV28GroupInstallationCommand(enable)).toMatchObject({ kind: 'set-enforcement', enforcement: 'enabled', expectedControlRevision: 1 });
    for (const input of [enroll.filter((_, index) => index !== 1 && index !== 2), enroll.slice(0, -2),
      [...enable, '--actor', principal], [...enable, '--runtime-profile', 'v28'], [...enable.slice(0, -1), '0'],
      [...enable.slice(0, -1), '9007199254740991'], [...enroll.slice(0, -3), '1', ...enroll.slice(-2)]])
      expect(() => parseV28GroupInstallationCommand(input)).toThrow(V28GroupInstallationCommandError);
  });
  it('rejects secret, upgrade, recovery and resource-grant options before any owner can be acquired', () => {
    for (const input of [['upgrade-metadata', ...enable.slice(1)], ['release-restored-maintenance', ...enable.slice(1)],
      [...enable, '--password', 'secret'], [...enable, '--catalog', 'v28'], [...enable, '--root', 'sample'],
      [...enable, '--filesystem-root-owner-uid', '00'], [...enroll, '--filesystem-root-owner-uid', '4294967296']])
      expect(() => parseV28GroupInstallationCommand(input)).toThrow(V28GroupInstallationCommandError);
  });
});
