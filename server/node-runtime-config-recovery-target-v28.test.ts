import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadNodeRuntimeConfiguration, assertNodeRuntimeConfigurationForProfile, NodeRuntimeConfigurationError } from './node-runtime-config.ts';

// Closed host/private configuration fixtures only; no Native, archive or
// authority rows are constructed and no configuration acts as restore proof.
const parent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT ?? process.cwd();
if (!isAbsolute(parent) || resolve(parent) !== parent) throw new Error('Invalid target configuration fixture parent');
const roots: string[] = [], installationId = 'b5406370-2c5b-4bac-9b08-9e68d17b6cb0', targetId = '10d5c13d-211b-44cb-9443-a6d6252a5b2e';
const rootBindingId = '06118bd7-e394-408f-8a5f-55e167b0489a', filesystemRootOwnerUid = Number(lstatSync('/', { bigint: true }).uid);
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { force: true, recursive: true }); }, 20_000);
function fixture() {
  const root = mkdtempSync(join(parent, '.node-target-config-')); roots.push(root); chmodSync(root, 0o700);
  const data = join(root, 'data'), client = join(root, 'client'), artifacts = join(root, 'artifacts'), targetParent = join(root, 'targets');
  for (const path of [data, client, artifacts, targetParent]) mkdirSync(path, { mode: 0o700 });
  const path = join(root, 'runtime.json'), target = { parent: targetParent, rootBindingId, targetId };
  const values = { format: 'node-loopback-development-v1', dataDirectory: data, clientDirectory: client,
    expectedInstallationId: installationId, publicOrigin: 'http://127.0.0.1:16471', enableLocalFile: false,
    enableLocalJobs: false, enableLocalRecovery: true, recoveryArtifacts: { root: artifacts, rootBindingId } };
  return { root, data, client, artifacts, targetParent, target, path, values,
    write(extra: Record<string, unknown> = {}) { writeFileSync(path, JSON.stringify({ ...values, ...extra }), { flag: 'wx', mode: 0o600 }); } };
}
function load(path: string) { return loadNodeRuntimeConfiguration(path, { filesystemRootOwnerUid, runtimeProfile: 'v28-recovery' }); }
describe('explicit sealed fresh target configuration before Native admission', () => {
  it('keeps an omitted target absent and accepts only the exact independent host descriptor without creating a target', () => {
    const absent = fixture(); absent.write(); expect(assertNodeRuntimeConfigurationForProfile(load(absent.path), 'v28-recovery').recoveryTarget).toBeUndefined();
    const selected = fixture(); selected.write({ recoveryTarget: selected.target });
    const value = assertNodeRuntimeConfigurationForProfile(load(selected.path), 'v28-recovery');
    expect(value.recoveryTarget).toEqual(selected.target); expect(Object.isFrozen(value.recoveryTarget)).toBe(true);
    expect(value.enableLocalFile).toBe(false); expect(value.enableLocalJobs).toBe(false);
    expect(existsSync(join(selected.targetParent, targetId))).toBe(false); expect(existsSync(join(selected.targetParent, 'namespace.json'))).toBe(false);
  }, 20_000);
  it('rejects a target without explicit Recovery opt-in, under another selector, or with an open descriptor', () => {
    for (const enableLocalRecovery of [undefined, false]) {
      const f = fixture(); f.write({ recoveryTarget: f.target, enableLocalRecovery });
      expect(() => load(f.path)).toThrow(NodeRuntimeConfigurationError);
    }
    const f = fixture(); f.write({ recoveryTarget: f.target });
    for (const runtimeProfile of [undefined, 'v28-metadata', 'v28-fabublox'] as const)
      expect(() => loadNodeRuntimeConfiguration(f.path, { filesystemRootOwnerUid, ...(runtimeProfile ? { runtimeProfile } : {}) })).toThrow(NodeRuntimeConfigurationError);
    for (const changed of [null, [], {}, { parent: 'relative', rootBindingId, targetId },
      { parent: f.targetParent, rootBindingId, targetId: installationId }, { ...f.target, installationId }, { ...f.target, rootBindingId: 'caller-root' }]) {
      const other = fixture(); other.write({ recoveryTarget: changed }); expect(() => load(other.path)).toThrow(NodeRuntimeConfigurationError);
    }
  }, 20_000);
  it('refuses aliases, public parents and overlap with source, client, artifacts or configuration', () => {
    for (const choice of ['root', 'data', 'client', 'artifacts'] as const) {
      const f = fixture(); f.write({ recoveryTarget: { ...f.target, parent: f[choice] } }); expect(() => load(f.path)).toThrow(NodeRuntimeConfigurationError);
    }
    const publicParent = fixture(); chmodSync(publicParent.targetParent, 0o740); publicParent.write({ recoveryTarget: publicParent.target });
    expect(() => load(publicParent.path)).toThrow(NodeRuntimeConfigurationError);
    const alias = fixture(), link = join(alias.root, 'target-alias'); symlinkSync(alias.targetParent, link);
    alias.write({ recoveryTarget: { ...alias.target, parent: link } }); expect(() => load(alias.path)).toThrow(NodeRuntimeConfigurationError);
  }, 20_000);
  it('keeps the original private target parent and configuration inode pins live', () => {
    const f = fixture(); f.write({ recoveryTarget: f.target }); const token = load(f.path);
    renameSync(f.targetParent, f.targetParent + '.original'); mkdirSync(f.targetParent, { mode: 0o700 });
    expect(() => assertNodeRuntimeConfigurationForProfile(token, 'v28-recovery')).toThrow(NodeRuntimeConfigurationError);
    const other = fixture(); other.write({ recoveryTarget: other.target }); const original = load(other.path), replacement = other.path + '.replacement';
    writeFileSync(replacement, JSON.stringify({ ...other.values, recoveryTarget: other.target }), { flag: 'wx', mode: 0o600 }); renameSync(replacement, other.path);
    expect(() => assertNodeRuntimeConfigurationForProfile(original, 'v28-recovery')).toThrow(NodeRuntimeConfigurationError);
  }, 20_000);
});
