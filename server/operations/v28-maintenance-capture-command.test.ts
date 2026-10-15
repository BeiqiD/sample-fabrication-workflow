import { describe, expect, it } from 'vitest';
import { parseV28MaintenanceCaptureCommand } from './v28-maintenance-capture-command.ts';
import { executeLocalV28MaintenanceCaptureCandidate, LocalV28MaintenanceCaptureError } from './local-v28-maintenance-capture-operator-candidate.ts';

const args = ['capture-local-backup', '--runtime-profile', 'v28', '--configuration', '/private/source/capture.json',
  '--archive', '/private/archive/new.zip', '--installation', '11111111-1111-4111-8111-111111111111'];
describe('explicit public V28 stopped backup selection', () => {
  it('issues only the original branded stopped capture token for an explicit V28 selector', () => {
    const selected = parseV28MaintenanceCaptureCommand([...args, '--filesystem-root-owner-uid', '65534']);
    expect(selected).toEqual({ kind: 'fixed-stopped-local-v28-capture/1' }); expect(Object.isFrozen(selected)).toBe(true);
    expect(parseV28MaintenanceCaptureCommand([args[0]!, ...args.slice(3), '--runtime-profile', 'v28']))
      .toEqual({ kind: 'fixed-stopped-local-v28-capture/1' });
  });
  it('refuses implicit or duplicate profiles and authority or executable overrides before opening a source', () => {
    for (const input of [[args[0]!, ...args.slice(3)], [args[0]!, '--runtime-profile', 'v26', ...args.slice(3)],
      [...args, '--runtime-profile', 'v28'], [...args, '--actor', 'administrator'], [...args, '--catalog', 'portable-runtime/v28'],
      [...args, '--entry', 'server/main.ts'], ['capture', ...args.slice(1)]])
      expect(() => parseV28MaintenanceCaptureCommand(input)).toThrow(LocalV28MaintenanceCaptureError);
  });
  it('preserves original canonical configuration/archive/installation/root validation and rejects fabricated tokens before I/O', () => {
    for (const input of [[...args.slice(0, 4), 'relative.json', ...args.slice(5)],
      [...args.slice(0, 6), '/private/../new.zip', ...args.slice(7)], [...args.slice(0, -1), 'not-an-installation'],
      [...args, '--filesystem-root-owner-uid', '00'], [...args, '--filesystem-root-owner-uid', '4294967296']])
      expect(() => parseV28MaintenanceCaptureCommand(input)).toThrow(LocalV28MaintenanceCaptureError);
    const original = parseV28MaintenanceCaptureCommand(args);
    expect(() => executeLocalV28MaintenanceCaptureCandidate({ ...original })).toThrow(LocalV28MaintenanceCaptureError);
    expect(() => executeLocalV28MaintenanceCaptureCandidate(Object.freeze({ kind: 'fixed-stopped-local-v28-capture/1' })))
      .toThrow(LocalV28MaintenanceCaptureError);
  });
});
