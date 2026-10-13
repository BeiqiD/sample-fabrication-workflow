import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNodeRuntimeConfiguration, assertNodeRuntimeConfigurationForProfile, loadNodeRuntimeConfiguration,
  NodeRuntimeConfigurationError, type LoadedNodeRuntimeConfiguration, type NodeRuntimeConfigurationProfile,
} from './node-runtime-config';

// Pure configuration/private-file unit fixtures. These JSON reports are not
// genuine restore evidence and no test opens SQLite, issues permissions or
// claims compiled-main startup. Root runs these only in its canonical QA cwd;
// a world-writable /tmp ancestor is deliberately not used or exempted.
const directories: string[] = [];
// Reuse the existing canonical fixture environment when Root supplies it;
// otherwise use its controlled canonical cwd. Neither path exempts /tmp.
const fixtureParent = process.env.CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT ?? process.cwd();
if (!isAbsolute(fixtureParent) || resolve(fixtureParent) !== fixtureParent) throw new Error('Invalid configuration fixture parent');
const installationId = 'b5406370-2c5b-4bac-9b08-9e68d17b6cb0';
const otherInstallationId = '06118bd7-e394-408f-8a5f-55e167b0489a';
const filesystemRootOwnerUid = Number(lstatSync('/', { bigint: true }).uid);
const timeout = 20_000;
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); }, timeout);

function reportValues(): Record<string, unknown> {
  return {
    kind: 'offline-system-backup-recovery', databasePath: 'database.sqlite',
    sourceArchiveSha256: 'a'.repeat(64), destinationInstallationId: installationId,
    destinationCheckpoint: 'portable-runtime/v28', nativeBindingsRestored: false,
    executionEnabled: false, deploymentChanged: false, maintenanceState: 'fenced',
    verification: { exactTypedRows: true, exactRowids: true, foreignKeys: true, integrity: 'ok', reviewedSchema: true },
  };
}
function fixture(restored: boolean, values: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(fixtureParent, '.node-restored-config-')); directories.push(directory);
  chmodSync(directory, 0o700);
  const dataDirectory = join(directory, 'data'), clientDirectory = join(directory, 'client');
  mkdirSync(dataDirectory, { mode: 0o700 }); mkdirSync(clientDirectory, { mode: 0o700 });
  const configPath = join(directory, 'runtime.json'), reportPath = join(dataDirectory, 'recovery-report.json');
  const configuration = {
    format: restored ? 'node-loopback-restored-v28-v1' : 'node-loopback-development-v1',
    dataDirectory, clientDirectory, expectedInstallationId: installationId,
    publicOrigin: 'http://127.0.0.1:16471', enableLocalFile: false, enableLocalJobs: false,
    ...(restored ? { databaseFile: 'database.sqlite' } : {}), ...values,
  };
  writeFileSync(configPath, JSON.stringify(configuration), { flag: 'wx', mode: 0o600 });
  if (restored) writeFileSync(reportPath, JSON.stringify(reportValues()), { flag: 'wx', mode: 0o600 });
  return { directory, dataDirectory, configPath, reportPath, configuration };
}
function loadRestored(path: string) {
  return loadNodeRuntimeConfiguration(path, { filesystemRootOwnerUid, runtimeProfile: 'v28-metadata' });
}
function replace(path: string, values: unknown) {
  const replacement = path + '.replacement';
  writeFileSync(replacement, JSON.stringify(values), { flag: 'wx', mode: 0o600 });
  renameSync(replacement, path);
}

describe('explicit restored V28 configuration metadata and original private pins', () => {
  it('keeps the original v1 filename and rejects a restored filename field in v1', () => {
    const f = fixture(false), token = loadNodeRuntimeConfiguration(f.configPath, { filesystemRootOwnerUid });
    const value = assertNodeRuntimeConfigurationForProfile(token, undefined);
    expect(value.databasePath).toBe(join(f.dataDirectory, 'application.sqlite'));
    expect(assertNodeRuntimeConfigurationForProfile(token, 'v28-metadata')).toBe(value);
    expect(existsSync(value.databasePath)).toBe(false);
    const extra = fixture(false, { databaseFile: 'database.sqlite' });
    expect(() => loadNodeRuntimeConfiguration(extra.configPath, { filesystemRootOwnerUid })).toThrow(NodeRuntimeConfigurationError);
  }, timeout);

  it('requires an explicit V28 selector and only selects the fixed restored filename', () => {
    const f = fixture(true);
    expect(() => loadNodeRuntimeConfiguration(f.configPath, { filesystemRootOwnerUid })).toThrow(NodeRuntimeConfigurationError);
    const token = loadRestored(f.configPath), value = assertNodeRuntimeConfiguration(token);
    expect(value.databasePath).toBe(join(f.dataDirectory, 'database.sqlite'));
    expect(value.enableLocalFile).toBe(false); expect(value.enableLocalJobs).toBe(false);
    expect(assertNodeRuntimeConfigurationForProfile(token, 'v28-metadata')).toBe(value);
    expect(() => assertNodeRuntimeConfigurationForProfile(token, undefined)).toThrow(NodeRuntimeConfigurationError);
    expect(existsSync(join(f.dataDirectory, 'application.sqlite'))).toBe(false);
    expect(existsSync(value.databasePath)).toBe(false);
  }, timeout);

  it('keeps restored format fields and loader options closed without path fallback', () => {
    for (const databaseFile of [undefined, 'application.sqlite', '../database.sqlite', '/database.sqlite']) {
      const f = fixture(true, { databaseFile });
      expect(() => loadRestored(f.configPath)).toThrow(NodeRuntimeConfigurationError);
    }
    const extra = fixture(true, { databasePath: '/arbitrary.sqlite' });
    expect(() => loadRestored(extra.configPath)).toThrow(NodeRuntimeConfigurationError);
    const wrongFormat = fixture(true, { format: 'node-loopback-development-v2' });
    expect(() => loadRestored(wrongFormat.configPath)).toThrow(NodeRuntimeConfigurationError);
    const f = fixture(true);
    expect(() => loadNodeRuntimeConfiguration(f.configPath, {
      filesystemRootOwnerUid, runtimeProfile: 'v26' as NodeRuntimeConfigurationProfile,
    })).toThrow(NodeRuntimeConfigurationError);
    expect(() => loadNodeRuntimeConfiguration(f.configPath, {
      filesystemRootOwnerUid, runtimeProfile: 'v28-metadata', databasePath: '/arbitrary.sqlite',
    } as Parameters<typeof loadNodeRuntimeConfiguration>[1])).toThrow(NodeRuntimeConfigurationError);
  }, timeout);

  it('binds the fixed original report to the selected installation and V28 checkpoint', () => {
    for (const changed of [
      { destinationInstallationId: otherInstallationId },
      { destinationCheckpoint: 'portable-runtime/v26' },
      { databasePath: 'application.sqlite' },
      { executionEnabled: true },
      { nativeBindingsRestored: true },
      { verification: { exactTypedRows: true, exactRowids: false, foreignKeys: true, integrity: 'ok', reviewedSchema: true } },
    ]) {
      const f = fixture(true); replace(f.reportPath, { ...reportValues(), ...changed });
      expect(() => loadRestored(f.configPath)).toThrow(NodeRuntimeConfigurationError);
    }
    const absent = fixture(true); unlinkSync(absent.reportPath);
    expect(() => loadRestored(absent.configPath)).toThrow(NodeRuntimeConfigurationError);
    const oversized = fixture(true); replace(oversized.reportPath, { ...reportValues(), padding: 'a'.repeat(64 * 1024) });
    expect(() => loadRestored(oversized.configPath)).toThrow(NodeRuntimeConfigurationError);
  }, timeout);

  it('rejects configuration and report identity changes through both assertions', () => {
    const first = fixture(true), firstToken = loadRestored(first.configPath);
    replace(first.reportPath, reportValues());
    expect(() => assertNodeRuntimeConfiguration(firstToken)).toThrow(NodeRuntimeConfigurationError);
    expect(() => assertNodeRuntimeConfigurationForProfile(firstToken, 'v28-metadata')).toThrow(NodeRuntimeConfigurationError);
    const second = fixture(true), secondToken = loadRestored(second.configPath);
    replace(second.configPath, second.configuration);
    expect(() => assertNodeRuntimeConfiguration(secondToken)).toThrow(NodeRuntimeConfigurationError);
    expect(() => assertNodeRuntimeConfigurationForProfile(secondToken, 'v28-metadata')).toThrow(NodeRuntimeConfigurationError);
  }, timeout);

  it('retains private mode, canonical report path and explicit root UID fences', () => {
    const publicReport = fixture(true); chmodSync(publicReport.reportPath, 0o644);
    expect(() => loadRestored(publicReport.configPath)).toThrow(NodeRuntimeConfigurationError);
    const alias = fixture(true), target = join(alias.dataDirectory, 'other-report.json');
    writeFileSync(target, JSON.stringify(reportValues()), { flag: 'wx', mode: 0o600 });
    unlinkSync(alias.reportPath); symlinkSync(target, alias.reportPath);
    expect(() => loadRestored(alias.configPath)).toThrow(NodeRuntimeConfigurationError);
    const writableDirectory = fixture(true); chmodSync(writableDirectory.dataDirectory, 0o770);
    expect(() => loadRestored(writableDirectory.configPath)).toThrow(NodeRuntimeConfigurationError);
    const wrongOwner = fixture(true);
    expect(() => loadNodeRuntimeConfiguration(wrongOwner.configPath, {
      filesystemRootOwnerUid: filesystemRootOwnerUid === 0 ? 1 : 0, runtimeProfile: 'v28-metadata',
    })).toThrow(NodeRuntimeConfigurationError);
  }, timeout);

  it('never accepts a copied configuration token as a factory-issued owner', () => {
    const f = fixture(true), token = loadRestored(f.configPath);
    const copy: LoadedNodeRuntimeConfiguration = Object.freeze({ ...token });
    expect(() => assertNodeRuntimeConfiguration(copy)).toThrow(NodeRuntimeConfigurationError);
    expect(() => assertNodeRuntimeConfigurationForProfile(copy, 'v28-metadata')).toThrow(NodeRuntimeConfigurationError);
  }, timeout);
});
