import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNodeRuntimeConfiguration, assertNodeRuntimeConfigurationForProfile, loadNodeRuntimeConfiguration,
  NodeRuntimeConfigurationError, type LoadedNodeRuntimeConfiguration, type NodeRuntimeConfigurationProfile,
} from './node-runtime-config';

// Configuration/private-file unit fixtures only. Synthetic report JSON is not
// restore evidence, and no case opens SQLite or starts a runtime/CLI/provider.
// Reuse the canonical QA parent; do not exempt a writable /tmp ancestor.
const fixtureParent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT ?? process.cwd();
if (!isAbsolute(fixtureParent) || resolve(fixtureParent) !== fixtureParent) throw new Error('Invalid Recovery configuration fixture parent');
const directories: string[] = [];
const installationId = 'b5406370-2c5b-4bac-9b08-9e68d17b6cb0';
const rootBindingId = '06118bd7-e394-408f-8a5f-55e167b0489a';
const filesystemRootOwnerUid = Number(lstatSync('/', { bigint: true }).uid);
const timeout = 20_000;
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); }, timeout);

function fixture(restored = false) {
  const directory = mkdtempSync(join(fixtureParent, '.node-recovery-config-')); directories.push(directory); chmodSync(directory, 0o700);
  const dataDirectory = join(directory, 'data'), clientDirectory = join(directory, 'client'), artifactRoot = join(directory, 'artifacts');
  for (const path of [dataDirectory, clientDirectory, artifactRoot]) mkdirSync(path, { mode: 0o700 });
  const configPath = join(directory, 'runtime.json'), reportPath = join(dataDirectory, 'recovery-report.json');
  const configuration: Record<string, unknown> = {
    format: restored ? 'node-loopback-restored-v28-v1' : 'node-loopback-development-v1',
    dataDirectory, clientDirectory, expectedInstallationId: installationId, publicOrigin: 'http://127.0.0.1:16471',
    enableLocalFile: false, enableLocalJobs: false, ...(restored ? { databaseFile: 'database.sqlite' } : {}),
  };
  const report = { kind: 'offline-system-backup-recovery', databasePath: 'database.sqlite', sourceArchiveSha256: 'a'.repeat(64),
    destinationInstallationId: installationId, destinationCheckpoint: 'portable-runtime/v28', nativeBindingsRestored: false,
    executionEnabled: false, deploymentChanged: false, maintenanceState: 'fenced',
    verification: { exactTypedRows: true, exactRowids: true, foreignKeys: true, integrity: 'ok', reviewedSchema: true } };
  if (restored) writeFileSync(reportPath, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
  function write(values: Record<string, unknown> = {}) {
    writeFileSync(configPath, JSON.stringify({ ...configuration, ...values }), { flag: 'wx', mode: 0o600 });
  }
  return { directory, dataDirectory, clientDirectory, artifactRoot, configPath, reportPath, configuration, report, write,
    recoveryArtifacts: { root: artifactRoot, rootBindingId } };
}
function load(path: string, runtimeProfile: NodeRuntimeConfigurationProfile = 'v28-recovery') {
  return loadNodeRuntimeConfiguration(path, { filesystemRootOwnerUid, runtimeProfile });
}
function replace(path: string, value: unknown): void {
  const replacement = path + '.replacement'; writeFileSync(replacement, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  renameSync(replacement, path);
}

describe('closed explicit Recovery-only configuration and unchanged default admission', () => {
  it('keeps Recovery disabled and unbound when omitted without creating a database or artifact layout', () => {
    const f = fixture(); f.write();
    const token = loadNodeRuntimeConfiguration(f.configPath, { filesystemRootOwnerUid }), value = assertNodeRuntimeConfiguration(token);
    expect(value.enableLocalRecovery).toBe(false); expect(value.recoveryArtifacts).toBeUndefined();
    for (const profile of [undefined, 'v28-metadata', 'v28-fabublox'] as const)
      expect(assertNodeRuntimeConfigurationForProfile(token, profile)).toBe(value);
    expect(() => assertNodeRuntimeConfigurationForProfile(token, 'v28-recovery')).toThrow(NodeRuntimeConfigurationError);
    expect(existsSync(value.databasePath)).toBe(false);
    for (const child of ['objects', 'staging', 'namespace.json']) expect(existsSync(join(f.artifactRoot, child))).toBe(false);
  }, timeout);

  it('does not turn a private artifact descriptor or an explicit false flag into Recovery opt-in', () => {
    for (const flag of [undefined, false]) {
      const f = fixture(); f.write({ recoveryArtifacts: f.recoveryArtifacts, ...(flag === undefined ? {} : { enableLocalRecovery: flag }) });
      const token = load(f.configPath), value = assertNodeRuntimeConfiguration(token);
      expect(value.enableLocalRecovery).toBe(false); expect(value.recoveryArtifacts).toEqual(f.recoveryArtifacts);
      expect(assertNodeRuntimeConfigurationForProfile(token, undefined)).toBe(value);
      expect(() => assertNodeRuntimeConfigurationForProfile(token, 'v28-recovery')).toThrow(NodeRuntimeConfigurationError);
      expect(existsSync(value.databasePath)).toBe(false);
    }
  }, timeout);

  it('requires the Recovery selector for true opt-in and refuses reuse under every existing surface', () => {
    const f = fixture(); f.write({ enableLocalRecovery: true, recoveryArtifacts: f.recoveryArtifacts });
    for (const runtimeProfile of [undefined, 'v28-metadata', 'v28-fabublox'] as const)
      expect(() => loadNodeRuntimeConfiguration(f.configPath, { filesystemRootOwnerUid, ...(runtimeProfile === undefined ? {} : { runtimeProfile }) }))
        .toThrow(NodeRuntimeConfigurationError);
    const token = load(f.configPath), value = assertNodeRuntimeConfigurationForProfile(token, 'v28-recovery');
    expect(value.enableLocalRecovery).toBe(true); expect(value.enableLocalFile).toBe(false); expect(value.enableLocalJobs).toBe(false);
    expect(value.databasePath).toBe(join(f.dataDirectory, 'application.sqlite'));
    expect(Object.isFrozen(value.recoveryArtifacts)).toBe(true);
    for (const profile of [undefined, 'v28-metadata', 'v28-fabublox'] as const)
      expect(() => assertNodeRuntimeConfigurationForProfile(token, profile)).toThrow(NodeRuntimeConfigurationError);
    expect(existsSync(value.databasePath)).toBe(false);
  }, timeout);

  it('rejects open descriptor fields, malformed opt-ins and File/Job selections before runtime admission', () => {
    for (const changed of [
      { recoveryArtifacts: undefined }, { recoveryArtifacts: null }, { recoveryArtifacts: [] },
      { recoveryArtifacts: {} }, { recoveryArtifacts: { rootBindingId } },
      { recoveryArtifacts: { root: 'relative-artifacts', rootBindingId } },
      { enableLocalRecovery: 'true' }, { enableLocalRecovery: 1 }, { recoveryExecutorEnabled: true },
      { enableLocalJobs: true },
    ]) {
      const f = fixture(); f.write({ enableLocalRecovery: true, recoveryArtifacts: f.recoveryArtifacts, ...changed });
      expect(() => load(f.configPath)).toThrow(NodeRuntimeConfigurationError);
    }
    const extra = fixture(); extra.write({ enableLocalRecovery: true,
      recoveryArtifacts: { ...extra.recoveryArtifacts, installationId, namespaceRevision: 1 } });
    expect(() => load(extra.configPath)).toThrow(NodeRuntimeConfigurationError);
    const binding = fixture(); binding.write({ enableLocalRecovery: true,
      recoveryArtifacts: { ...binding.recoveryArtifacts, rootBindingId: 'caller-supplied-root' } });
    expect(() => load(binding.configPath)).toThrow(NodeRuntimeConfigurationError);
    for (const enableLocalJobs of [false, true]) {
      const file = fixture(), volumeRoot = join(file.directory, 'business-volume'); mkdirSync(volumeRoot, { mode: 0o700 });
      file.write({ enableLocalRecovery: true, recoveryArtifacts: file.recoveryArtifacts, enableLocalFile: true, enableLocalJobs,
        localVolumes: [{ id: '8ca3010f-4ddb-4718-9d43-d7b6d74d65f4', root: volumeRoot, rootBindingId,
          namespace: { kind: 'local-volume', volumeId: installationId, rootId: rootBindingId, namespaceRevision: 1 } }] });
      const token = load(file.configPath);
      expect(assertNodeRuntimeConfiguration(token).enableLocalFile).toBe(true);
      expect(() => assertNodeRuntimeConfigurationForProfile(token, 'v28-recovery')).toThrow(NodeRuntimeConfigurationError);
    }
  }, timeout);

  it('refuses artifact roots that overlap configuration, data, client, keyring or declared local volumes', () => {
    for (const destination of ['configuration', 'data', 'client', 'keyring', 'local-volume'] as const) {
      const f = fixture();
      const root = destination === 'configuration' ? f.directory : destination === 'data' ? f.dataDirectory
        : destination === 'client' ? f.clientDirectory : f.artifactRoot;
      const values: Record<string, unknown> = { enableLocalRecovery: true, recoveryArtifacts: { root, rootBindingId } };
      if (destination === 'keyring') values.storageKeyringPath = join(f.artifactRoot, 'external-root-keys.json');
      if (destination === 'local-volume') values.localVolumes = [{ id: '8ca3010f-4ddb-4718-9d43-d7b6d74d65f4', root: f.artifactRoot, rootBindingId,
        namespace: { kind: 'local-volume', volumeId: installationId, rootId: rootBindingId, namespaceRevision: 1 } }];
      f.write(values); expect(() => load(f.configPath)).toThrow(NodeRuntimeConfigurationError);
    }
  }, timeout);

  it('keeps canonical private artifact roots and their original inode/configuration pins live', () => {
    const publicRoot = fixture(); chmodSync(publicRoot.artifactRoot, 0o740);
    publicRoot.write({ enableLocalRecovery: true, recoveryArtifacts: publicRoot.recoveryArtifacts });
    expect(() => load(publicRoot.configPath)).toThrow(NodeRuntimeConfigurationError);
    const aliased = fixture(), link = join(aliased.directory, 'artifact-alias'); symlinkSync(aliased.artifactRoot, link);
    aliased.write({ enableLocalRecovery: true, recoveryArtifacts: { root: link, rootBindingId } });
    expect(() => load(aliased.configPath)).toThrow(NodeRuntimeConfigurationError);
    const replaced = fixture(); replaced.write({ enableLocalRecovery: true, recoveryArtifacts: replaced.recoveryArtifacts });
    const token = load(replaced.configPath); renameSync(replaced.artifactRoot, replaced.artifactRoot + '.original');
    mkdirSync(replaced.artifactRoot, { mode: 0o700 });
    expect(() => assertNodeRuntimeConfiguration(token)).toThrow(NodeRuntimeConfigurationError);
    expect(() => assertNodeRuntimeConfigurationForProfile(token, 'v28-recovery')).toThrow(NodeRuntimeConfigurationError);
    const changed = fixture(), values = { ...changed.configuration, enableLocalRecovery: true, recoveryArtifacts: changed.recoveryArtifacts };
    changed.write(values); const original = load(changed.configPath); replace(changed.configPath, values);
    expect(() => assertNodeRuntimeConfigurationForProfile(original, 'v28-recovery')).toThrow(NodeRuntimeConfigurationError);
  }, timeout);

  it('selects the fixed restored filename only with explicit Recovery and the unchanged inert report pin', () => {
    const f = fixture(true); f.write({ enableLocalRecovery: true, recoveryArtifacts: f.recoveryArtifacts });
    const token = load(f.configPath), value = assertNodeRuntimeConfigurationForProfile(token, 'v28-recovery');
    expect(value.databasePath).toBe(join(f.dataDirectory, 'database.sqlite'));
    expect(value.enableLocalFile).toBe(false); expect(value.enableLocalJobs).toBe(false);
    expect(existsSync(value.databasePath)).toBe(false); expect(existsSync(join(f.dataDirectory, 'application.sqlite'))).toBe(false);
    replace(f.reportPath, { ...f.report, executionEnabled: true });
    expect(() => assertNodeRuntimeConfigurationForProfile(token, 'v28-recovery')).toThrow(NodeRuntimeConfigurationError);
    expect(() => load(f.configPath)).toThrow(NodeRuntimeConfigurationError);
  }, timeout);

  it('cannot turn a copied token into a factory-issued Recovery configuration owner', () => {
    const f = fixture(); f.write({ enableLocalRecovery: true, recoveryArtifacts: f.recoveryArtifacts });
    const token = load(f.configPath), copy: LoadedNodeRuntimeConfiguration = Object.freeze({ ...token });
    expect(() => assertNodeRuntimeConfiguration(copy)).toThrow(NodeRuntimeConfigurationError);
    expect(() => assertNodeRuntimeConfigurationForProfile(copy, 'v28-recovery')).toThrow(NodeRuntimeConfigurationError);
  }, timeout);
});
