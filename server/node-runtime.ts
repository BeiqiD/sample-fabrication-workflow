import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createPasswordHasher } from './auth/passwords';
import { createPrivateStorageKeyringLoader } from './auth/storage-keyring-file';
import { OPERATIONAL_NODE_INSTALLATION_CATALOG } from './operational-installation-catalog';
import { admitInstallationRecoverySource, assertInstallationAdmission } from './migrations';
import { createNodeDevelopmentPrototype } from './node-application';
import { assertNodeRuntimeConfiguration, assertNodeRuntimeConfigurationForProfile, type LoadedNodeRuntimeConfiguration } from './node-runtime-config';
import { acquireLinuxWriterLease, assertLinuxWriterLeaseBinding, type LinuxWriterLease } from './operations/writer-lease';
import { createSqliteCapability, type SqliteCapability } from './sqlite';

export class NodeRuntimeError extends Error {
  constructor() { super('Local development runtime is unavailable.'); this.name = 'NodeRuntimeError'; }
}
export interface RunningNodeDevelopmentRuntime {
  readonly server: Server;
  readonly unsupportedRouteOwners: readonly string[];
  close(): Promise<void>;
}
interface Owner { lease?: LinuxWriterLease; native?: DatabaseSync; database?: SqliteCapability; quarantined: boolean;
  cleanup?: Promise<void>; failure?: unknown;
  composition?: ReturnType<typeof createNodeDevelopmentPrototype>; prototype?: Awaited<ReturnType<typeof createNodeDevelopmentPrototype>> }
const owners = new Set<Owner>();
const IDENTITY_POLICY = Object.freeze({ absoluteLifetimeMs: 12 * 3600_000, idleLifetimeMs: 1800_000,
  loginWindowMs: 60_000, loginAttempts: 5, throttleBuckets: 1000 });
function unavailable(): never { throw new NodeRuntimeError(); }
function aborted(signal: AbortSignal | undefined): void { if (signal?.aborted) unavailable(); }
function cleanup(owner: Owner): Promise<void> {
  // Pre-composer startup only. The exact original close outcome is retained;
  // rejected prototype construction never delegates another cleanup here.
  return owner.cleanup ??= (async () => {
    if (!owner.lease) { owners.delete(owner); return; }
    try {
      await owner.lease.stopAdmissionAndDrain();
      if (owner.database) owner.database.close();
      else if (owner.native?.isOpen) owner.native.close();
      if (owner.native?.isOpen) throw new NodeRuntimeError();
      await owner.lease.release();
      owners.delete(owner);
    } catch (error) {
      owner.quarantined = true; owner.failure = error;
      throw error; // No raw native fallback and no physical release after failed ACK.
    }
  })();
}

/** Genuine operational composition for the currently restricted development
 * graph. There is no startup install/bootstrap, fabricated Env, provider role
 * or executor. Only an existing paired operational V26 installation with local
 * destination-owned administrator bootstrap authority can start. */
export async function startNodeDevelopmentRuntime(configuration: LoadedNodeRuntimeConfiguration,
  options: { signal?: AbortSignal } = {}): Promise<RunningNodeDevelopmentRuntime> {
  const signal = options?.signal;
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'signal')
    || signal !== undefined && !(signal instanceof AbortSignal)) unavailable();
  const value = assertNodeRuntimeConfigurationForProfile(configuration, undefined); aborted(signal);
  if (owners.size >= 2) unavailable();
  // Synchronous active+quarantine reservation bounds failed native cleanup.
  const owner: Owner = { quarantined: false }; owners.add(owner);
  let prototype: Awaited<ReturnType<typeof createNodeDevelopmentPrototype>> | undefined;
  let composition: ReturnType<typeof createNodeDevelopmentPrototype> | undefined;
  try {
    owner.lease = await acquireLinuxWriterLease({ databasePath: value.databasePath, filesystemRootOwnerUid: value.filesystemRootOwnerUid });
    assertNodeRuntimeConfiguration(configuration); aborted(signal);
    owner.native = new DatabaseSync(value.databasePath, { allowExtension: false, enableForeignKeyConstraints: true });
    owner.database = createSqliteCapability(owner.native); owner.lease.bind(owner.database, owner.native);
    const lease = owner.lease, native = owner.native, database = owner.database;
    const admission = await lease.withWriter(() => {
      assertLinuxWriterLeaseBinding(lease, database, native);
      // Admission reads the existing exact checkpoint. Missing/older/newer
      // schemas do not trigger automatic installation, migration or reset.
      const admitted = admitInstallationRecoverySource(native, OPERATIONAL_NODE_INSTALLATION_CATALOG);
      const receipt = assertInstallationAdmission(native, admitted);
      if (receipt.installationId !== value.expectedInstallationId
        || receipt.appliedMigrations !== OPERATIONAL_NODE_INSTALLATION_CATALOG.migrations.length) unavailable();
      const initialized = native.prepare(`SELECT a.principal_id FROM local_identity_installation i
        JOIN local_accounts a ON a.principal_id=i.bootstrap_principal_id
        JOIN local_admin_grants g ON g.principal_id=a.principal_id
        WHERE i.singleton=1 AND a.enabled=1`).all();
      if (initialized.length !== 1) unavailable();
      return admitted;
    });
    assertNodeRuntimeConfiguration(configuration); aborted(signal);
    const keyring = value.storageKeyringPath === undefined ? undefined
      : createPrivateStorageKeyringLoader(value.storageKeyringPath, { filesystemRootOwnerUid: value.filesystemRootOwnerUid });
    composition = owner.composition = createNodeDevelopmentPrototype({ writerLease: lease, nativeDatabase: native, database, admission,
      hasher: createPasswordHasher(), identityPolicy: IDENTITY_POLICY, now: Date.now,
      publicOrigin: value.publicOrigin, clientDirectory: value.clientDirectory, keyring,
      ...(value.enableLocalFile ? { localFileConfiguration: configuration } : {}) });
    prototype = owner.prototype = await composition;
    assertNodeRuntimeConfiguration(configuration); aborted(signal);
    await new Promise<void>((resolve, reject) => {
      const server = prototype!.server;
      const fail = () => { server.removeListener('listening', ready); reject(new NodeRuntimeError()); };
      const ready = () => {
        server.removeListener('error', fail);
        try {
          aborted(signal); assertNodeRuntimeConfiguration(configuration);
          assertLinuxWriterLeaseBinding(lease, database, native);
          const actual = server.address();
          if (!actual || typeof actual === 'string' || actual.address !== value.host || actual.port !== value.port) unavailable();
          resolve();
        } catch { reject(new NodeRuntimeError()); }
      };
      server.once('error', fail); server.once('listening', ready);
      try { server.listen({ host: value.host, port: value.port, exclusive: true }); }
      catch { server.removeListener('error', fail); server.removeListener('listening', ready); reject(new NodeRuntimeError()); }
    });
    const accepted = prototype;
    let closing: Promise<void> | undefined;
    return Object.freeze({ server: accepted.server, unsupportedRouteOwners: accepted.unsupportedRouteOwners,
      close(): Promise<void> {
        if (closing) return closing;
        closing = accepted.close().then(() => { owners.delete(owner); }, error => {
          // Retain the same composer and first rejected promise permanently.
          owner.quarantined = true; owner.failure = error; throw new NodeRuntimeError();
        });
        return closing;
      },
    });
  } catch (error) {
    if (prototype) {
      try { await prototype.close(); owners.delete(owner); }
      catch (closeError) { owner.quarantined = true; owner.failure = closeError; unavailable(); }
    } else if (composition) {
      // The composer owns attempted construction cleanup. Its rejected original
      // promise cannot be discharged by native.isOpen or a second close attempt.
      owner.quarantined = true; owner.failure = error; unavailable();
    } else {
      try { await cleanup(owner); }
      catch (closeError) { owner.quarantined = true; owner.failure = closeError; unavailable(); }
    }
    return unavailable();
  }
}
