import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createPasswordHasher } from "../auth/passwords";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate";
import { admitInstallationRecoverySource, assertInstallationAdmission } from "../migrations";
import { assertNodeRuntimeConfiguration, type LoadedNodeRuntimeConfiguration } from "../node-runtime-config";
import { acquireLinuxWriterLease, assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteCapability, type SqliteCapability } from "../sqlite";
import { createGroupV28ApplicationCandidate, type GroupV28ApplicationCandidate } from "./group-v28-application-candidate";

interface Owner {
  lease?: LinuxWriterLease; native?: DatabaseSync; database?: SqliteCapability;
  acquisitionAttempted: boolean; acquisition?: Promise<LinuxWriterLease>;
  acquisitionFailed: boolean; acquisitionFailure?: unknown;
  nativeAttempted: boolean; constructorFailed: boolean; constructorFailure?: unknown;
  applicationAttempted: boolean; application?: GroupV28ApplicationCandidate;
  originalApplication?: Promise<GroupV28ApplicationCandidate>;
  closing?: Promise<void>; failed: boolean; failure?: unknown;
}
const owners = new Set<Owner>();
const unavailable = () => new Error("Explicit Group V28 runtime candidate is unavailable");
const policy = Object.freeze({ absoluteLifetimeMs: 12 * 3600_000, idleLifetimeMs: 1800_000,
  loginWindowMs: 60_000, loginAttempts: 5, throttleBuckets: 1000 });

/** Additive programmatic entry only: no main/config/default import selects it.
 * Uses the original factory-issued private development configuration but an
 * explicitly different current V28 catalog. Jobs opt-ins are refused; canonical
 * acceptance requires both this explicit selector and the genuine File config.
 * Existing metadata must already have been upgraded and Group enabled by the
 * genuine stopped operator. It never installs, enrolls or grants at startup. */
export async function startGroupV28RuntimeCandidate(configuration: LoadedNodeRuntimeConfiguration,
  options: { signal?: AbortSignal; sampleMetadataReads?: true; canonicalComments?: true; canonicalSampleAttachments?:true; fabubloxConfiguration?:LoadedNodeRuntimeConfiguration } = {}): Promise<Readonly<{ server: Server; routes: GroupV28ApplicationCandidate["routes"];
    capabilities: GroupV28ApplicationCandidate["capabilities"]; close(): Promise<void> }>> {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(k => k !== "signal" && k !== "sampleMetadataReads" && k !== "canonicalComments" && k !== "canonicalSampleAttachments" && k!=="fabubloxConfiguration")
    || options.sampleMetadataReads !== undefined && options.sampleMetadataReads !== true
    || options.canonicalSampleAttachments!==undefined && options.canonicalSampleAttachments!==true
    || options.canonicalSampleAttachments===true && (options.canonicalComments!==true || options.sampleMetadataReads!==true)
    || options.canonicalComments !== undefined && options.canonicalComments !== true || options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw unavailable();
  if(options.fabubloxConfiguration!==undefined && (options.fabubloxConfiguration!==configuration
    || assertNodeRuntimeConfiguration(options.fabubloxConfiguration)!==assertNodeRuntimeConfiguration(configuration)))throw unavailable();
  const fabubloxConfiguration=options.fabubloxConfiguration;
  const signal = options.signal;
  const sampleMetadataReads = options.sampleMetadataReads;
  const canonicalComments = options.canonicalComments;
  const canonicalSampleAttachments=options.canonicalSampleAttachments;
  const current = () => {
    const value = assertNodeRuntimeConfiguration(configuration);
    if (signal?.aborted || value.enableLocalJobs || (canonicalComments === true || fabubloxConfiguration!==undefined ? !value.enableLocalFile : value.enableLocalFile)) throw unavailable();
    return value;
  };
  const value = current();
  if (owners.size >= 2) throw unavailable();
  const owner: Owner = { acquisitionAttempted: false, acquisitionFailed: false,
    nativeAttempted: false, constructorFailed: false, applicationAttempted: false, failed: false };
  owners.add(owner);
  const remember = (error: unknown) => { if (!owner.failed) { owner.failed = true; owner.failure = error; } };
  function closeBeforeApplication(): Promise<void> {
    if (owner.closing) return owner.closing;
    owner.closing = (async () => {
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
          throw unavailable(); // Unknown returned-handle ownership is retained.
        }
        await owner.lease.stopAdmissionAndDrain();
        if (owner.database) owner.database.close();
        else if (owner.native) owner.native.close(); // Sole known original handle, not a fallback after failed core.close.
        if (owner.native?.isOpen) throw unavailable();
        await owner.lease.release();
        owners.delete(owner);
      } catch (error) { remember(error); throw error; }
    })();
    void owner.closing.catch(() => undefined);
    return owner.closing;
  }
  try {
    owner.acquisitionAttempted = true;
    try {
      const originalAcquisition = acquireLinuxWriterLease({ databasePath: value.databasePath, filesystemRootOwnerUid: value.filesystemRootOwnerUid });
      owner.acquisition = originalAcquisition;
      owner.lease = await originalAcquisition;
    } catch (error) { owner.acquisitionFailed = true; owner.acquisitionFailure = error; throw error; }
    current();
    owner.nativeAttempted = true;
    try { owner.native = new DatabaseSync(value.databasePath, { allowExtension: false, enableForeignKeyConstraints: true }); }
    catch (error) { owner.constructorFailed = true; owner.constructorFailure = error; throw error; }
    owner.database = createSqliteCapability(owner.native); owner.lease.bind(owner.database, owner.native);
    const lease = owner.lease, native = owner.native, database = owner.database;
    const admission = await lease.withWriter(() => {
      assertLinuxWriterLeaseBinding(lease, database, native);
      const admitted = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE);
      const facts = assertInstallationAdmission(native, admitted);
      if (facts.installationId !== value.expectedInstallationId || facts.checkpointId !== "portable-runtime/v28"
        || facts.appliedMigrations !== V28_NODE_INSTALLATION_CATALOG_CANDIDATE.migrations.length) throw unavailable();
      const control = native.prepare("SELECT schema_version,enforcement,revision FROM collaboration_control WHERE singleton=1").get();
      if (control?.schema_version !== 2 || control.enforcement !== "enabled" || typeof control.revision !== "number"
        || !Number.isSafeInteger(control.revision) || control.revision < 1) throw unavailable();
      return admitted;
    });
    current();
    owner.applicationAttempted = true;
    const original = createGroupV28ApplicationCandidate({ sampleMetadataReads, canonicalSampleAttachments, database, nativeDatabase: native, writerLease: lease,
      admission, hasher: createPasswordHasher(), identityPolicy: policy, publicOrigin: value.publicOrigin,
      ...(canonicalComments === true ? {canonicalCommentConfiguration:configuration} : {}),
      ...(fabubloxConfiguration!==undefined?{fabubloxConfiguration}:{}) });
    owner.originalApplication = original;
    owner.application = await original;
    const app = owner.application;
    current();
    await new Promise<void>((resolve, reject) => {
      const fail = () => { app.server.removeListener("listening", ready); reject(unavailable()); };
      const ready = () => {
        app.server.removeListener("error", fail);
        try {
          current(); assertLinuxWriterLeaseBinding(lease, database, native);
          const address = app.server.address();
          if (!address || typeof address === "string" || address.address !== value.host || address.port !== value.port) throw unavailable();
          resolve();
        } catch (error) { reject(error); }
      };
      app.server.once("error", fail); app.server.once("listening", ready);
      try { app.server.listen({ host: value.host, port: value.port, exclusive: true }); }
      catch (error) { app.server.removeListener("error", fail); app.server.removeListener("listening", ready); reject(error); }
    });
    return Object.freeze({ server: app.server, routes: app.routes, capabilities: app.capabilities, close(): Promise<void> {
      if (owner.closing) return owner.closing;
      owner.closing = app.close().then(() => { owners.delete(owner); }, error => { remember(error); throw error; });
      void owner.closing.catch(() => undefined);
      return owner.closing;
    } });
  } catch (error) {
    if (owner.application) {
      try { await owner.application.close(); owners.delete(owner); }
      catch (cleanup) { remember(cleanup); throw new AggregateError([error, cleanup], "Group startup and original application close failed"); }
    } else if (owner.applicationAttempted) {
      // A rejected original factory already owns its first cleanup. Never raw
      // close or release again because the native appears closed.
      remember(error);
    } else {
      try { await closeBeforeApplication(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Group startup and original native cleanup failed"); }
    }
    throw error;
  }
}
