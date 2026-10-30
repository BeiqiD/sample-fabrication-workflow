import { beforeAll, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadNodeRuntimeConfiguration } from '../node-runtime-config';
import { NodeRuntimeError } from '../node-runtime';
import { startSelectedNodeDevelopmentRuntime } from '../node-runtime-profile';
import { prepareGenuineFabubloxBaseline, type GenuineFabubloxBaseline } from './current-final-fabublox-genuine-process.qualification-support';
import { canonicalFilePrivateOrigin, retainedCanonicalFileCase, withCanonicalFileDatabase } from './current-v28-canonical-comment-file.qualification-support';

let baseline: GenuineFabubloxBaseline;
beforeAll(async () => { await retainedCanonicalFileCase(async () => {
  baseline = await prepareGenuineFabubloxBaseline();
}); });

async function configuration(enableLocalFile: boolean, enableLocalJobs = false) {
  let origin = '';
  // Reuse the original probe owner and its cached close ACK, fully release its
  // real Native/lease before the selected startup acquires its own parents.
  await withCanonicalFileDatabase(baseline.path, async owner => { origin = await canonicalFilePrivateOrigin(owner); });
  const path = join(baseline.root, `profile-runtime-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify({ format: 'node-loopback-development-v1', dataDirectory: baseline.dataDirectory,
    expectedInstallationId: baseline.installationId, publicOrigin: origin, clientDirectory: baseline.clientDirectory,
    localVolumes: baseline.descriptors, enableLocalFile, enableLocalJobs }), { flag: 'wx', mode: 0o600 });
  return loadNodeRuntimeConfiguration(path, { filesystemRootOwnerUid: baseline.rootOwnerUid });
}

describe('explicit V28 operational startup against genuine stopped installation', () => {
  it('keeps an absent selector V26-gated and releases the rejected V28 startup parents', () => retainedCanonicalFileCase(async () => {
    await expect(startSelectedNodeDevelopmentRuntime(await configuration(false), undefined)).rejects.toThrow(NodeRuntimeError);
    // Genuine reacquisition verifies the rejected original startup did release;
    // no closed-looking handle or fabricated receipt substitutes for this ACK.
    await withCanonicalFileDatabase(baseline.path, async (_owner, _lease, native) => { expect(native.isOpen).toBe(true); });
  }));
  it('starts only the explicit metadata surface and reports its actual unavailable owners', () => retainedCanonicalFileCase(async () => {
    const runtime = await startSelectedNodeDevelopmentRuntime(await configuration(false), 'v28-metadata');
    try {
      expect(runtime.server.listening).toBe(true);
      expect(runtime.capabilities?.kind).toBe('explicit-v28-development-capabilities/1');
      expect(runtime.capabilities?.routes.some(route => route.path === '/api/imports/fabublox')).toBe(false);
      expect(runtime.capabilities?.unavailable).toEqual(expect.arrayContaining([
        'file-bytes-and-file-grants', 'jobs-and-package-import-export', 'system-backup-and-assisted-recovery', 'provider-egress', 'frontend-static-serving']));
    } finally { const first = runtime.close(); expect(runtime.close()).toBe(first); await first; }
  }));
  it('starts the explicit existing Fabu surface without granting general File, Jobs, SPA or recovery', () => retainedCanonicalFileCase(async () => {
    const token = await configuration(true);
    const runtime = await startSelectedNodeDevelopmentRuntime(token, 'v28-fabublox');
    try {
      expect(runtime.server.listening).toBe(true);
      expect(runtime.capabilities?.routes).toEqual(expect.arrayContaining([{ method: 'POST', path: '/api/imports/fabublox' }, { method: 'GET', path: '/api/templates/:id' }]));
      expect(runtime.capabilities?.authorities).toContain('request-and-purpose-bound-fabublox-acceptance');
      expect(runtime.capabilities?.unavailable).toEqual(expect.arrayContaining([
        'file-bytes-and-file-grants', 'jobs-and-package-import-export', 'system-backup-and-assisted-recovery', 'provider-egress', 'frontend-static-serving']));
    } finally { const first = runtime.close(); expect(runtime.close()).toBe(first); await first; }
  }));
  it('rejects mismatched File selections and all V28 Job opt-ins without automatic provisioning', () => retainedCanonicalFileCase(async () => {
    await expect(startSelectedNodeDevelopmentRuntime(await configuration(false), 'v28-fabublox')).rejects.toThrow();
    await expect(startSelectedNodeDevelopmentRuntime(await configuration(true), 'v28-metadata')).rejects.toThrow();
    await expect(startSelectedNodeDevelopmentRuntime(await configuration(true, true), 'v28-fabublox')).rejects.toThrow();
    const stopped = new AbortController(); stopped.abort();
    await expect(startSelectedNodeDevelopmentRuntime(await configuration(false), 'v28-metadata', { signal: stopped.signal })).rejects.toThrow();
  }));
});
