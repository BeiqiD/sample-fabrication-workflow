// QA-only companion. It is bundled separately and never a distribution entry.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalLocalVolumeNamespace } from "../../../shared/contracts/local-volume-profile";
import { createInstalledLocalIdentity } from "../../../server/auth/identity";
import { createPasswordHasher } from "../../../server/auth/passwords";
import { OPERATIONAL_NODE_INSTALLATION_CATALOG } from "../../../server/operational-installation-catalog";
import { admitInstallationRecoverySource, assertInstallationAdmission } from "../../../server/migrations";
import { loadNodeRuntimeConfiguration, assertNodeRuntimeConfiguration } from "../../../server/node-runtime-config";
import { acquireLinuxWriterLease, type LinuxWriterLease } from "../../../server/operations/writer-lease";
import { createSqliteCapability, type SqliteCapability } from "../../../server/sqlite";
import { createLocalVolumeProfileOpening, type LocalVolumeProfileOpening } from "../../../server/storage/local-volume-profile-opening";
import { createLocalVolumeProfileLifecycle } from "../../../server/storage/local-volume-profile-lifecycle";
import { createOfflineLocalFileInitialization } from "../../../server/storage/local-file-initialization";

const policy = Object.freeze({ absoluteLifetimeMs: 12 * 3600_000, idleLifetimeMs: 1800_000,
  loginWindowMs: 60_000, loginAttempts: 5, throttleBuckets: 1000 });
interface Owner {
  setup?: Promise<void>; acquisition?: Promise<LinuxWriterLease>; lease?: LinuxWriterLease;
  nativeAttempted?: true; nativeError?: unknown; native?: DatabaseSync; database?: SqliteCapability;
  nativeClose?: () => void; nativeAcknowledged?: () => boolean;
  openingAttempted?: true; openingError?: unknown; opening?: LocalVolumeProfileOpening;
  close?: Promise<void>; setupError?: unknown; closeError?: unknown;
}
// Failed original graphs remain owned for the remainder of this child. Kernel
// child exit is a separate boundary, never a manufactured graceful release.
const retained = new Set<Owner>();
function closeOwner(owner: Owner): Promise<void> {
  if (owner.close) return owner.close;
  owner.close = (async () => {
    if (owner.setup) await owner.setup.then(() => undefined, () => undefined);
    if (owner.acquisition) owner.lease = await owner.acquisition;
    if (owner.openingAttempted && !owner.opening) throw owner.openingError;
    await owner.opening?.close();
    await owner.lease?.stopAdmissionAndDrain();
    if (owner.nativeAttempted && !owner.native) throw owner.nativeError;
    if (owner.database) owner.database.close(); else owner.nativeClose?.();
    if (owner.native && (!owner.nativeAcknowledged?.() || owner.native.isOpen))
      throw new Error("Original setup native first close is unproven");
    await owner.lease?.release();
    retained.delete(owner);
  })().catch(error => { owner.closeError = error; throw error; });
  owner.close.then(() => undefined, () => undefined); return owner.close;
}
function bindFirstNativeClose(owner: Owner, native: DatabaseSync): void {
  const original = native.close.bind(native); let attempted = false, failed = false, reason: unknown;
  const close = () => {
    if (attempted) { if (failed) throw reason; return; }
    attempted = true;
    try { original(); } catch (error) { failed = true; reason = error; throw error; }
  };
  native.close = close; owner.nativeClose = close;
  owner.nativeAcknowledged = () => attempted && !failed && !native.isOpen;
}
async function privateInput(): Promise<{ configuration: string; username: string; password: string }> {
  let count = 0; const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    count += chunk.length; assert.ok(count <= 16384); chunks.push(Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const input = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(input).sort(), ["configuration", "password", "username"]);
  assert.equal(input.configuration, "/run/sample/runtime.json");
  assert.equal(typeof input.username, "string"); assert.equal(typeof input.password, "string");
  assert.ok((input.password as string).length >= 16 && (input.password as string).length <= 256);
  return input as { configuration: string; username: string; password: string };
}
async function main(): Promise<void> {
  const input = await privateInput();
  const token = loadNodeRuntimeConfiguration(input.configuration, { filesystemRootOwnerUid: 0 });
  const configuration = assertNodeRuntimeConfiguration(token);
  assert.equal(configuration.enableLocalFile, true); assert.equal(configuration.localVolumes.length, 2);
  assert.equal(process.getuid?.(), 1000);
  const owner: Owner = {}; retained.add(owner); // Before acquisition or any filesystem await.
  owner.setup = (async () => {
    owner.acquisition = acquireLinuxWriterLease({ databasePath: configuration.databasePath, filesystemRootOwnerUid: 0 });
    owner.acquisition.then(() => undefined, () => undefined);
    const lease = owner.lease = await owner.acquisition;
    owner.nativeAttempted = true;
    try {
      owner.native = new DatabaseSync(configuration.databasePath, { allowExtension: false, enableForeignKeyConstraints: true });
      bindFirstNativeClose(owner, owner.native);
    } catch (error) { owner.nativeError = error; throw error; }
    const native = owner.native, database = owner.database = createSqliteCapability(native);
    lease.bind(database, native);
    await lease.withWriter(async () => {
      assertNodeRuntimeConfiguration(token);
      const admission = admitInstallationRecoverySource(native, OPERATIONAL_NODE_INSTALLATION_CATALOG);
      assert.equal(assertInstallationAdmission(native, admission).installationId, configuration.expectedInstallationId);
      const identity = await createInstalledLocalIdentity({ database, nativeDatabase: native, admission,
        hasher: createPasswordHasher(), policy });
      const session = await identity.login({ username: input.username, password: input.password,
        sourceKey: "original-current-container-file-setup", now: Date.now() });
      const principal = await identity.authenticate(session.token, Date.now());
      assert.ok(principal && principal.capabilities.systemAdministrator === true);
      const actor = principal.actor; // Only the actual authenticated owner supplies this actor.
      owner.openingAttempted = true;
      try {
        owner.opening = createLocalVolumeProfileOpening({ database, nativeDatabase: native, admission,
          writerLease: lease, filesystemRootOwnerUid: 0, descriptors: configuration.localVolumes,
          async authorizeAdministrator(selected) {
            const current = await identity.authenticate(session.token, Date.now());
            return current?.actor === selected && current.capabilities.systemAdministrator === true;
          } });
      } catch (error) { owner.openingError = error; throw error; }
      const opening = owner.opening, lifecycle = createLocalVolumeProfileLifecycle(opening);
      const profiles: string[] = [];
      for (const volume of configuration.localVolumes) {
        const profile = "storage-profile:local:" + createHash("sha256")
          .update(canonicalLocalVolumeNamespace(volume.namespace)).digest("hex");
        profiles.push(profile);
        await opening.register({ operationId: randomUUID(), volumeDescriptorId: volume.id }, actor);
        await lifecycle.probeAndBind({ operationId: randomUUID(), checkId: randomUUID(), volumeDescriptorId: volume.id,
          access: "read_write", expectedBindingRevision: null }, actor);
        await lifecycle.activate({ operationId: randomUUID(), volumeDescriptorId: volume.id, expectedBindingRevision: 1 }, actor);
      }
      const row = native.prepare("SELECT epoch FROM file_shadow_control WHERE singleton=1").get();
      assert.ok(row && typeof row.epoch === "number" && Number.isSafeInteger(row.epoch) && row.epoch >= 0);
      await createOfflineLocalFileInitialization(opening).initialize({ requestId: randomUUID(), expectedEpoch: row.epoch,
        internalProfileId: profiles[0]!, originalsProfileId: profiles[1]! }, actor);
      assert.equal(native.prepare("SELECT mode FROM file_authority_control WHERE singleton=1").get()?.mode, "active");
      assert.equal(native.prepare("SELECT enabled FROM file_job_runtime_guard WHERE singleton=1").get()?.enabled, 0);
      assert.deepEqual(native.prepare("PRAGMA foreign_key_check").all(), []);
      assertNodeRuntimeConfiguration(token);
    });
  })();
  owner.setup.then(() => undefined, () => undefined);
  let workFailed = false, workError: unknown;
  try { await owner.setup; } catch (error) { workFailed = true; workError = owner.setupError = error; }
  try { await closeOwner(owner); }
  catch (closeError) {
    if (workFailed) throw new AggregateError([workError, closeError], "Original setup and first close failed");
    throw closeError;
  } finally { input.password = ""; }
  if (workFailed) throw workError;
  assert.equal(retained.size, 0);
  process.stdout.write(JSON.stringify({ status: "PASS", profileCount: 2, executorEnabled: false,
    originalSetupSettled: true, openingFirstCloseAcknowledged: true, nativeFirstCloseAcknowledged: true,
    physicalFirstReleaseAcknowledged: true }) + "\n");
}
main().catch(() => {
  // Keep the exact failed graph internally; do not serialize its private reasons.
  process.stdout.write(JSON.stringify({ status: "FAIL", gracefulSetupCloseUnproven: retained.size !== 0 }) + "\n");
  process.exitCode = 1;
});
