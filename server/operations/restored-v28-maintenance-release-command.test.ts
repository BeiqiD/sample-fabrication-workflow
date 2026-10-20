import { describe, expect, it } from 'vitest';
import { executeRestoredV28MaintenanceRelease, parseRestoredV28MaintenanceReleaseCommand,
  RestoredV28MaintenanceReleaseError } from './restored-v28-maintenance-release-operator.ts';
const id = '12345678-1234-4234-8234-123456789abc';
const args = ['release-restored-maintenance', '--runtime-profile', 'v28', '--database', '/private/new/database.sqlite',
  '--principal', `local_${id}`, '--installation', id, '--request-id', id, '--expected-generation', '0'];
describe('explicit stopped restored V28 maintenance release selection', () => {
  it('issues only one frozen exact release selection with an optional real root UID', () => {
    const token = parseRestoredV28MaintenanceReleaseCommand([...args, '--filesystem-root-owner-uid', '65534']);
    expect(token).toEqual({ kind: 'fixed-stopped-restored-v28-maintenance-release/1' }); expect(Object.isFrozen(token)).toBe(true);
  });
  it('refuses implicit profiles, arbitrary databases, request actors and unsafe generations before I/O', () => {
    for (const input of [args.filter((_, index) => index !== 1 && index !== 2), [...args, '--actor', 'operator'],
      [...args.slice(0, -1), '9007199254740991'], [...args.slice(0, -1), '00'], [...args, '--request-id', id],
      args.map(value => value === 'v28' ? 'v26' : value), args.map(value => value === '/private/new/database.sqlite' ? '/private/new/application.sqlite' : value),
      args.map(value => value === '/private/new/database.sqlite' ? '/private/new/../database.sqlite' : value),
      [...args, '--filesystem-root-owner-uid', '4294967296']])
      expect(() => parseRestoredV28MaintenanceReleaseCommand(input)).toThrow(RestoredV28MaintenanceReleaseError);
  });
  it('refuses copied and fabricated command bags before opening a target or granting authority', () => {
    const token = parseRestoredV28MaintenanceReleaseCommand(args);
    expect(() => executeRestoredV28MaintenanceRelease({ ...token })).toThrow(RestoredV28MaintenanceReleaseError);
    expect(() => executeRestoredV28MaintenanceRelease(Object.freeze({ kind: 'fixed-stopped-restored-v28-maintenance-release/1' }))).toThrow(RestoredV28MaintenanceReleaseError);
  });
});
