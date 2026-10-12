import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createInstalledLocalIdentity } from "../auth/identity";
import { createPasswordHasher } from "../auth/passwords";
import { V26_NODE_INSTALLATION_CATALOG } from "../installation-catalog-v26";
import { admitInstallationRecoverySource, installReviewedSqliteCatalog } from "../migrations";
import { acquireLinuxWriterLease, WriterLeaseError } from "../operations/writer-lease";
import { createSqliteCapability, type SqliteCapability } from "../sqlite";
import { createLocalVolumeProfileOpening, type LocalVolumeProfileOpening } from "./local-volume-profile-opening";
import { createLocalVolumeProfileLifecycle } from "./local-volume-profile-lifecycle";
import { canonicalLocalVolumeNamespace } from "../../shared/contracts/local-volume-profile";
import { verifyStoredBytes } from "../../worker/files/byte-verification";
import { nodeSha256 } from "./node-sha256";
import { openStorageProfile, StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";

const [root, mode] = process.argv.slice(2);
assert(root && ["profile-constructor-close", "profile-data-close", "profile-body-cancel", "profile-current-and-cancel", "profile-normal-close"].includes(mode));
const databasePath = join(root, "installed-v26.sqlite"), byteRoot = join(root, "bytes");
const rootUid = lstatSync("/").uid;
const namespace = Object.freeze({ kind: "local-volume" as const, volumeId: randomUUID(), rootId: randomUUID(), namespaceRevision: 1 as const });
const profileId = `storage-profile:local:${createHash("sha256").update(canonicalLocalVolumeNamespace(namespace)).digest("hex")}`;
const descriptor = { id: randomUUID(), root: byteRoot, rootBindingId: randomUUID(), namespace };
const password = "Fixed private Local profile fault control password";
const policy = { absoluteLifetimeMs: 120_000, idleLifetimeMs: 60_000, loginWindowMs: 1000, loginAttempts: 5, throttleBuckets: 100 };
const nativeFailure = new Error("Fixed original Local profile child close failure");
const realOpen = fs.open.bind(fs);
const nativeFdFaults: { handle: FileHandle; closes: number }[] = [], backendParents: { path: string; handle: FileHandle; closes: number }[] = [];
let armed = false, captureProvider = false, nativeCloseCalls = 0, leaseReleaseCalls = 0;
type Lease = Awaited<ReturnType<typeof acquireLinuxWriterLease>>;
interface Owner {
  acquire?: Promise<Lease>;
  lease?: Lease;
  native?: DatabaseSync;
  nativeAttempted?: true;
  nativeConstructorError?: unknown;
  core?: SqliteCapability;
  identityConstruction?: ReturnType<typeof createInstalledLocalIdentity>;
  trustedOpening?: LocalVolumeProfileOpening;
  opening?: LocalVolumeProfileOpening;
  openingAttempted?: true;
  setup?: Promise<void>;
  close?: Promise<void>;
}
const owner: Owner = {};
// Explicit strong original owner exists before any path, lease or native await.
const retainedOriginalOwners = new Set<Owner>([owner]);
function contains(error: unknown, exact: unknown, seen = new Set<unknown>()): boolean {
  if (error === exact) return true;
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  if (error instanceof AggregateError && error.errors.some(value => contains(value, exact, seen))) return true;
  return "cause" in error && contains(error.cause, exact, seen);
}
async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  assert.fail("The original negative owner unexpectedly acknowledged");
}
function closeOriginal(): Promise<void> {
  return owner.close ??= (async () => {
    if (owner.setup) await owner.setup.then(() => undefined, () => undefined);
    if (owner.acquire) owner.lease = await owner.acquire;
    if (owner.identityConstruction) await owner.identityConstruction;
    await owner.trustedOpening?.close();
    if (owner.openingAttempted && !owner.opening) throw new Error("Original profile construction did not return ownership");
    await owner.opening?.close();
    await owner.lease?.stopAdmissionAndDrain();
    if (owner.nativeAttempted && !owner.native) throw owner.nativeConstructorError;
    // No raw-native fallback after a core error and no release before first ACK.
    owner.core?.close();
    if (owner.native?.isOpen) throw new Error("Original native close did not acknowledge");
    if (owner.lease) { leaseReleaseCalls++; await owner.lease.release(); }
    retainedOriginalOwners.delete(owner);
  })();
}
fs.open = (async (...args: Parameters<typeof fs.open>) => {
  const handle = await realOpen(...args), path = String(args[0]), close = handle.close.bind(handle);
  if (!captureProvider) return handle;
  const parent = [byteRoot, join(byteRoot, "objects"), join(byteRoot, "staging")].includes(path)
    && !backendParents.some(value => value.path === path) ? { path, handle, closes: 0 } : undefined;
  if (parent) backendParents.push(parent);
  const fault = armed && ((mode === "profile-constructor-close" && path === join(byteRoot, "namespace.json"))
    || (mode === "profile-data-close" && /\/staging\/attempt-[^/]+\/data$/.test(path))
    || (["profile-body-cancel", "profile-current-and-cancel"].includes(mode) && /\/objects\/[a-f0-9]{64}\/data$/.test(path)));
  const record = fault ? { handle, closes: 0 } : undefined;
  if (record) nativeFdFaults.push(record);
  handle.close = async () => {
    if (parent) parent.closes++;
    if (record) { record.closes++; await close(); throw nativeFailure; }
    await close();
  };
  return handle;
}) as typeof fs.open;
syncBuiltinESMExports();
let actor = "", runtimeLifecycle: ReturnType<typeof createLocalVolumeProfileLifecycle> | undefined;
owner.setup = (async () => {
  await fs.mkdir(byteRoot, { mode: 0o700 });
  for (const path of ["objects", "staging"]) await fs.mkdir(join(byteRoot, path), { mode: 0o700 });
  await fs.writeFile(join(byteRoot, "namespace.json"), JSON.stringify({ format: "local-byte-namespace-v1", namespace: {
    volumeId: namespace.volumeId, rootId: namespace.rootId, profileId, namespaceRevision: 1 } }), { flag: "wx", mode: 0o600 });
  await fs.writeFile(databasePath, "", { flag: "wx", mode: 0o600 });
  await fs.writeFile(`${databasePath}.writer-lock`, "", { flag: "wx", mode: 0o600 });
  owner.acquire = acquireLinuxWriterLease({ databasePath, filesystemRootOwnerUid: rootUid });
  void owner.acquire.catch(() => undefined);
  const lease = owner.lease = await owner.acquire;
  owner.nativeAttempted = true;
  let native: DatabaseSync;
  try { native = owner.native = new DatabaseSync(databasePath, { allowExtension: false }); }
  catch (error) { owner.nativeConstructorError = error; throw error; }
  const rawClose = native.close.bind(native); let attempted = false, failed = false, originalError: unknown;
  native.close = () => {
    if (attempted) { if (failed) throw originalError; return; }
    attempted = true; nativeCloseCalls++;
    try { rawClose(); } catch (error) { failed = true; originalError = error; throw error; }
  };
  const database = owner.core = createSqliteCapability(native); lease.bind(database, native);
  await lease.withWriter(() => installReviewedSqliteCatalog(native, V26_NODE_INSTALLATION_CATALOG));
  const admission = await lease.withWriter(() => admitInstallationRecoverySource(native, V26_NODE_INSTALLATION_CATALOG));
  owner.identityConstruction = lease.withWriter(() => createInstalledLocalIdentity({ nativeDatabase: native, database, admission,
    hasher: createPasswordHasher(), policy }));
  const identity = await owner.identityConstruction;
  actor = (await lease.withWriter(() => identity.offline(lease).bootstrap({ username: "local.fault.operator", password, now: Date.now() }))).actor;
  const session = await lease.withWriter(() => identity.login({ username: "local.fault.operator", password,
    sourceKey: "actual-private-profile-fault-control", now: Date.now() }));
  const options = { database, nativeDatabase: native, admission, writerLease: lease, descriptors: [descriptor], filesystemRootOwnerUid: rootUid,
    async authorizeAdministrator(selected: string) {
      const principal = await identity.authenticate(session.token, Date.now());
      return principal?.actor === selected && principal.capabilities.systemAdministrator;
    } };
  const trusted = owner.trustedOpening = createLocalVolumeProfileOpening(options), lifecycle = createLocalVolumeProfileLifecycle(trusted);
  // Real trusted registration, byte probe and audit activation, with no direct
  // profile/control/grant SQL inserts or flag-only provider admission.
  await trusted.register({ operationId: randomUUID(), volumeDescriptorId: descriptor.id }, actor);
  await lifecycle.probeAndBind({ operationId: randomUUID(), checkId: randomUUID(), volumeDescriptorId: descriptor.id,
    access: "read_write", expectedBindingRevision: null }, actor);
  await lifecycle.activate({ operationId: randomUUID(), volumeDescriptorId: descriptor.id, expectedBindingRevision: 1 }, actor);
  await trusted.close();
  captureProvider = true;
  owner.openingAttempted = true;
  owner.opening = createLocalVolumeProfileOpening(options);
  runtimeLifecycle = createLocalVolumeProfileLifecycle(owner.opening);
})();
void owner.setup.catch(() => undefined);
await owner.setup;
const bytes = new TextEncoder().encode("actual installed Local profile negative bytes"), input = { key: "fixed-owned-profile-byte",
  body: Uint8Array.from(bytes).buffer, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
  contentType: "application/octet-stream", filename: "fixed.bin" };
let operationError: unknown;
if (mode === "profile-constructor-close") {
  armed = true;
  operationError = await rejected(openStorageProfile(owner.opening!.capabilities, { profileId, configurationRevision: 1 }, "write"));
  assert(operationError instanceof StorageProfileCleanupError); assert(contains(operationError.cleanupCause, nativeFailure));
} else {
  if (mode === "profile-data-close") armed = true;
  const opened = await openStorageProfile(owner.opening!.capabilities, { profileId, configurationRevision: 1 }, "write");
  if (mode === "profile-data-close") {
    operationError = await rejected(opened.writer!.write(input)); assert(contains(operationError, nativeFailure));
  }
  else {
    await opened.writer!.write(input);
    const objects = await fs.readdir(join(byteRoot, "objects")); assert.equal(objects.length, 1);
    assert.deepEqual(await fs.readFile(join(byteRoot, "objects", objects[0], "data")), Buffer.from(bytes));
    if (mode === "profile-normal-close") {
      assert.deepEqual(await verifyStoredBytes(opened.reader, input.key, input, nodeSha256), { byteSize: input.byteSize, sha256: input.sha256 });
    } else {
    armed = true;
    const read = await opened.reader.read(input.key); assert.equal(read.outcome, "available");
    if (read.outcome !== "available") assert.fail("Original provider body is required");
    if (mode === "profile-body-cancel") operationError = await rejected(read.body.cancel());
    else {
      await runtimeLifecycle!.retire({ operationId: randomUUID(), volumeDescriptorId: descriptor.id, expectedBindingRevision: 1 }, actor);
      const reader = read.body.getReader();
      try { operationError = await rejected(reader.read()); } finally { reader.releaseLock(); }
      assert(operationError instanceof AggregateError); assert(operationError.errors[0] instanceof Error);
      assert(!contains(operationError.errors[0], nativeFailure)); assert.equal(operationError.errors[1], nativeFailure);
    }
    assert(contains(operationError, nativeFailure));
    }
    assert.deepEqual(await fs.readFile(join(byteRoot, "objects", objects[0], "data")), Buffer.from(bytes));
  }
}
assert.equal(owner.native!.prepare("SELECT count(*) AS n FROM files").get()!.n, 0);
assert.equal(owner.native!.prepare("SELECT count(*) AS n FROM file_locations").get()!.n, 0);
const first = closeOriginal(), again = closeOriginal(); assert.equal(first, again);
if (mode === "profile-normal-close") {
  await first; await again;
  assert.equal(nativeCloseCalls, 1); assert.equal(leaseReleaseCalls, 1); assert.equal(owner.native!.isOpen, false);
  assert.equal(retainedOriginalOwners.has(owner), false); assert.equal(nativeFdFaults.length, 0);
  assert.equal(backendParents.length, 3);
  for (const parent of backendParents) { assert.equal(parent.closes, 1); assert.equal(parent.handle.fd, -1); }
  const fresh = await acquireLinuxWriterLease({ databasePath, filesystemRootOwnerUid: rootUid }); fresh.assertHeld(); await fresh.release();
  process.stdout.write(JSON.stringify({ version: 1, mode, assertionsComplete: true, nativeCloseCalls, leaseReleaseCalls,
    originalByteCloseCalls: 0, parentByteCloseCalls: [1, 1, 1], actualNativeStillOpen: false,
    genuineKernelWriterCompetition: "fresh-acquired-and-released", originalPhysicalOwnerRetained: false,
    normalProfileNativeLeaseAck: true, terminalKernelSettlementOnly: false, appComposerAckClaimed: false }) + "\n");
} else {
const failure = await rejected(first); assert(contains(failure, nativeFailure)); assert.equal(await rejected(again), failure);
assert.equal(nativeCloseCalls, 0); assert.equal(leaseReleaseCalls, 0); assert.equal(owner.native!.isOpen, true);
owner.lease!.assertHeld();
const competition = await rejected(acquireLinuxWriterLease({ databasePath, filesystemRootOwnerUid: rootUid }));
assert(competition instanceof WriterLeaseError); assert.equal(competition.code, "busy");
assert.equal(retainedOriginalOwners.has(owner), true); assert.equal(nativeFdFaults.length, 1); assert.equal(nativeFdFaults[0].closes, 1);
assert.equal(backendParents.length, 3);
for (const parent of backendParents) { assert.equal(parent.closes, 0); assert(parent.handle.fd >= 0); }
// The public writer retains its ordinary sanitized transport error; the exact
// original native cleanup reason is independently retained by the close graph.
assert(operationError instanceof Error);
process.stdout.write(JSON.stringify({ version: 1, mode, assertionsComplete: true, nativeCloseCalls, leaseReleaseCalls,
  originalByteCloseCalls: nativeFdFaults[0].closes, parentByteCloseCalls: backendParents.map(value => value.closes),
  actualNativeStillOpen: owner.native!.isOpen, genuineKernelWriterCompetition: "busy", originalPhysicalOwnerRetained: true,
  normalProfileNativeLeaseAck: false, terminalKernelSettlementOnly: true, appComposerAckClaimed: false }) + "\n");
}
