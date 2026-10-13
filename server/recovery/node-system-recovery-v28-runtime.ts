import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createPasswordHasher } from "../auth/passwords.ts";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate.ts";
import { admitInstallationRecoverySource, assertInstallationAdmission } from "../migrations.ts";
import { assertNodeRuntimeConfigurationForProfile, type LoadedNodeRuntimeConfiguration } from "../node-runtime-config.ts";
import { acquireLinuxWriterLease, assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease.ts";
import { createSqliteCapability, type SqliteCapability } from "../sqlite.ts";
import { createNodeSystemRecoveryV28Application, type NodeSystemRecoveryV28Application } from "./node-system-recovery-v28-application.ts";

export interface RunningNodeSystemRecoveryV28Runtime {
  readonly server: Server;
  readonly capabilities: NodeSystemRecoveryV28Application["surfaceCapabilities"];
  dispatchRecoveryJobsOnce(): ReturnType<NodeSystemRecoveryV28Application["dispatchRecoveryJobsOnce"]>;
  close(): Promise<void>;
}
interface Owner {
  lease?: LinuxWriterLease;
  native?: DatabaseSync;
  database?: SqliteCapability;
  acquisitionAttempted: boolean;
  acquisition?: Promise<LinuxWriterLease>;
  acquisitionFailed: boolean;
  acquisitionFailure?: unknown;
  nativeAttempted: boolean;
  constructorFailed: boolean;
  constructorFailure?: unknown;
  applicationAttempted: boolean;
  originalApplication?: Promise<NodeSystemRecoveryV28Application>;
  application?: NodeSystemRecoveryV28Application;
  closing?: Promise<void>;
  failed: boolean;
  failure?: unknown;
}
const owners = new Set<Owner>();
const identityPolicy = Object.freeze({ absoluteLifetimeMs: 12 * 3600_000, idleLifetimeMs: 1800_000,
  loginWindowMs: 60_000, loginAttempts: 5, throttleBuckets: 1000 });
const unavailable = () => new Error("Explicit Node V28 SystemRecovery runtime is unavailable");

/** Explicit Recovery-only selector. An existing exact V28 installation and
 * private artifact configuration are required; startup never installs,
 * migrates, creates identity/grants, enables executors or resumes old jobs.
 * Group enforcement is not required. The application owns its sole original
 * Native/core/lease tuple once construction is attempted; no business writer
 * or online target-restore integration is supplied by this entry point. */
export async function startNodeSystemRecoveryV28Runtime(configuration: LoadedNodeRuntimeConfiguration,
  options: { signal?: AbortSignal } = {}): Promise<Readonly<RunningNodeSystemRecoveryV28Runtime>> {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(key => key !== "signal")
    || options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw unavailable();
  const signal = options.signal;
  const current = () => {
    const value = assertNodeRuntimeConfigurationForProfile(configuration, "v28-recovery");
    if (signal?.aborted || !value.enableLocalRecovery || !value.recoveryArtifacts
      || value.enableLocalFile || value.enableLocalJobs) throw unavailable();
    return value;
  };
  const value = current();
  if (owners.size >= 2) throw unavailable();
  // Reserve before original acquisition; failed cleanup retains this slot.
  const owner: Owner = { acquisitionAttempted: false, acquisitionFailed: false,
    nativeAttempted: false, constructorFailed: false, applicationAttempted: false, failed: false };
  owners.add(owner);
  const remember = (error: unknown) => {
    if (!owner.failed) { owner.failed = true; owner.failure = error; }
  };
  function closeBeforeApplication(): Promise<void> {
    if (owner.closing) return owner.closing;
    owner.closing = Promise.resolve().then(async () => {
      try {
        if (!owner.lease) {
          if (owner.acquisitionAttempted) {
            if (owner.acquisitionFailed) throw owner.acquisitionFailure;
            throw unavailable();
          }
          owners.delete(owner); return;
        }
        if (owner.nativeAttempted && !owner.native) {
          if (owner.constructorFailed) throw owner.constructorFailure;
          throw unavailable();
        }
        await owner.lease.stopAdmissionAndDrain();
        if (owner.database) owner.database.close();
        else if (owner.native) owner.native.close(); // Sole known original handle before a core exists.
        if (owner.native?.isOpen) throw unavailable();
        await owner.lease.release();
        owners.delete(owner);
      } catch (error) { remember(error); throw error; }
    });
    void owner.closing.catch(() => undefined); return owner.closing;
  }
  function closeApplication(application: NodeSystemRecoveryV28Application): Promise<void> {
    if (owner.closing) return owner.closing;
    owner.closing = Promise.resolve().then(() => application.close()).then(() => {
      owners.delete(owner);
    }, error => { remember(error); throw error; });
    void owner.closing.catch(() => undefined); return owner.closing;
  }
  try {
    owner.acquisitionAttempted = true;
    try {
      const original = acquireLinuxWriterLease({ databasePath: value.databasePath,
        filesystemRootOwnerUid: value.filesystemRootOwnerUid });
      owner.acquisition = original;
      owner.lease = await original;
    } catch (error) { owner.acquisitionFailed = true; owner.acquisitionFailure = error; throw error; }
    current();
    owner.nativeAttempted = true;
    try { owner.native = new DatabaseSync(value.databasePath, { allowExtension: false, enableForeignKeyConstraints: true }); }
    catch (error) { owner.constructorFailed = true; owner.constructorFailure = error; throw error; }
    owner.database = createSqliteCapability(owner.native);
    owner.lease.bind(owner.database, owner.native);
    const lease = owner.lease, native = owner.native, database = owner.database;
    const admission = await lease.withWriter(() => {
      current(); assertLinuxWriterLeaseBinding(lease, database, native);
      const main = native.prepare("PRAGMA database_list").all().filter(row => row.name === "main");
      if (main.length !== 1 || main[0]?.file !== value.databasePath) throw unavailable();
      const admitted = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE);
      const facts = assertInstallationAdmission(native, admitted);
      const checkpoint = V28_NODE_INSTALLATION_CATALOG_CANDIDATE.migrations.at(-1)?.checkpoint;
      if (!checkpoint || checkpoint.id !== "portable-runtime/v28"
        || facts.installationId !== value.expectedInstallationId || facts.checkpointId !== checkpoint.id
        || facts.catalogId !== V28_NODE_INSTALLATION_CATALOG_CANDIDATE.id || facts.schemaSha256 !== checkpoint.schemaSha256
        || facts.appliedMigrations !== V28_NODE_INSTALLATION_CATALOG_CANDIDATE.migrations.length) throw unavailable();
      current(); return admitted;
    });
    current();
    const hasher = createPasswordHasher();
    // From this invocation onward only the original application factory owns
    // construction cleanup, including an unknown or rejected first outcome.
    owner.applicationAttempted = true;
    const original = createNodeSystemRecoveryV28Application({ configuration, database, nativeDatabase: native,
      writerLease: lease, admission, hasher, identityPolicy, publicOrigin: value.publicOrigin });
    owner.originalApplication = original;
    owner.application = await original;
    const application = owner.application;
    current();
    await new Promise<void>((resolve, reject) => {
      const fail = () => { application.server.removeListener("listening", ready); reject(unavailable()); };
      const ready = () => {
        application.server.removeListener("error", fail);
        try {
          current(); assertLinuxWriterLeaseBinding(lease, database, native);
          const address = application.server.address();
          if (!address || typeof address === "string" || address.address !== value.host || address.port !== value.port) throw unavailable();
          resolve();
        } catch (error) { reject(error); }
      };
      application.server.once("error", fail); application.server.once("listening", ready);
      try { application.server.listen({ host: value.host, port: value.port, exclusive: true }); }
      catch (error) { application.server.removeListener("error", fail); application.server.removeListener("listening", ready); reject(error); }
    });
    return Object.freeze({ server: application.server, capabilities: application.surfaceCapabilities,
      dispatchRecoveryJobsOnce() {
        if (owner.closing || owner.failed) throw unavailable();
        current(); assertLinuxWriterLeaseBinding(lease, database, native);
        return application.dispatchRecoveryJobsOnce();
      },
      close: () => closeApplication(application),
    });
  } catch (error) {
    if (owner.application) {
      try { await closeApplication(owner.application); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Recovery startup and original application close failed"); }
    } else if (owner.applicationAttempted) {
      // The original factory owns first cleanup. A closed-looking native is
      // not proof of successful cleanup; no raw core/native/release fallback.
      remember(error);
    } else {
      try { await closeBeforeApplication(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Recovery startup and original native cleanup failed"); }
    }
    throw error;
  }
}
