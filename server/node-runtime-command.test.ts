import { describe, expect, it } from 'vitest';
import { NodeRuntimeError } from './node-runtime';
import { parseNodeRuntimeCommand } from './node-runtime-command';

describe('closed explicit runtime CLI profiles', () => {
  it('retains the existing absent-selector command and numeric owner pin', () => {
    expect(parseNodeRuntimeCommand(['--config', '/private/runtime.json'])).toEqual({ path: '/private/runtime.json' });
    expect(parseNodeRuntimeCommand(['--filesystem-root-owner-uid', '0', '--config', '/private/runtime.json']))
      .toEqual({ path: '/private/runtime.json', filesystemRootOwnerUid: 0 });
    expect(parseNodeRuntimeCommand(['--config', '/private/runtime.json', '--filesystem-root-owner-uid', '4294967295']))
      .toEqual({ path: '/private/runtime.json', filesystemRootOwnerUid: 4294967295 });
  });
  it('accepts only the three named V28 surfaces in the existing unordered pair syntax', () => {
    expect(parseNodeRuntimeCommand(['--runtime-profile', 'v28-metadata', '--config', '/private/runtime.json']))
      .toEqual({ path: '/private/runtime.json', profile: 'v28-metadata' });
    expect(parseNodeRuntimeCommand(['--filesystem-root-owner-uid', '65534', '--runtime-profile', 'v28-fabublox', '--config', '/private/runtime.json']))
      .toEqual({ path: '/private/runtime.json', filesystemRootOwnerUid: 65534, profile: 'v28-fabublox' });
    expect(parseNodeRuntimeCommand(['--config', '/private/runtime.json', '--runtime-profile', 'v28-recovery']))
      .toEqual({ path: '/private/runtime.json', profile: 'v28-recovery' });
  });
  it('rejects unknown or repeated flags, implicit generation names and incomplete commands', () => {
    const invalid = [[], ['--config'], ['--config', ''], ['--config', '/private/runtime.json', '--runtime-profile'],
      ['--config', '/private/runtime.json', '--config', '/other/runtime.json'],
      ['--config', '/private/runtime.json', '--runtime-profile', 'v28-metadata', '--runtime-profile', 'v28-fabublox'],
      ['--config', '/private/runtime.json', '--generation', '28'],
      ...['v28', 'V28', 'v26', 'auto', 'v28-jobs', 'v28-canonical-comments', ''].map(profile => ['--config', '/private/runtime.json', '--runtime-profile', profile]),
      ...['-1', '+1', '01', '1e3', '4294967296', ''].map(uid => ['--config', '/private/runtime.json', '--filesystem-root-owner-uid', uid])];
    for (const argv of invalid) expect(() => parseNodeRuntimeCommand(argv)).toThrow(NodeRuntimeError);
  });
});
