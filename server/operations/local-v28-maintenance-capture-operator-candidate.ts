import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createInstalledLocalIdentity } from "../auth/identity.ts";
import { createLocalAuthentication } from "../auth/local-auth-http.ts";
import { createLoopbackLocalAuthTransport } from "../auth/local-auth-transport.ts";
import { createPasswordHasher } from "../auth/passwords.ts";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate.ts";
import { admitInstallationRecoverySource, assertInstallationAdmission } from "../migrations.ts";
import { createSqliteCapability, type SqliteCapability } from "../sqlite.ts";
import { acquireLinuxWriterLease, assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "./writer-lease.ts";
import { createLocalVolumeProfileOpeningV28, assertLocalVolumeProfileOpeningV28 } from "../storage/local-volume-profile-opening.ts";
import type { LocalVolumeProfileOpening } from "../storage/local-volume-profile-opening.ts";
import type { CapturedLocalVolumeDescriptor, TrustedLocalVolumeDescriptor } from "../storage/local-volume-descriptor.ts";
import { openStorageProfile, StorageProfileCleanupError, type OpenedStorageProfile } from "../../worker/files/storage-profile-opening.ts";
import { captureQuiescedNodeSystemBackupV28Candidate } from "../recovery/snapshot-v28-candidate.ts";
import { finishSystemBackupManifestV5, validateSystemBackupDocumentsV5, type SystemBackupManifestV5 } from "../../shared/contracts/system-backup-v5.ts";
import { planSystemBackupSourcesV28, type SystemBackupFileV28, type SystemBackupSourceV28 } from "../../shared/contracts/system-backup-v28-content.ts";
import { SYSTEM_BACKUP_MAX_ARCHIVE_BYTES, SYSTEM_BACKUP_MAX_PAYLOAD_BYTES, type SystemBackupOutcome } from "../../shared/contracts/system-backup.ts";
import { createSystemBackupArchiveStream, measureSystemBackupArchive, systemBackupArchiveMetadata } from "../../shared/domain/system-backup-archive.ts";
import type { ArchiveEntry, OpenArchiveEntry } from "../../shared/domain/research-archive.ts";
import { stableJson } from "../../shared/domain/content-addressing.ts";

export class LocalV28MaintenanceCaptureError extends Error {
  constructor(options?: ErrorOptions) { super("Stopped Local V28 maintenance capture is unavailable.", options); this.name = "LocalV28MaintenanceCaptureError"; }
}
export interface LocalV28MaintenanceCaptureCommand { readonly kind: "fixed-stopped-local-v28-capture/1" }
interface Selected { configuration: string; archive: string; installationId: string; rootUid: number }
interface Identity { dev: bigint; ino: bigint; uid: bigint; gid: bigint; mode: bigint }
interface FileIdentity extends Identity { size: bigint; nlink: bigint; mtimeNs: bigint; ctimeNs: bigint }
interface FdOwner { fd: number; closeAttempted: boolean; closeFailure?: unknown; closeFailed: boolean }
interface ReadOwner {
  body: ReadableStream<Uint8Array>; reader?: ReadableStreamDefaultReader<Uint8Array>;
  close?: Promise<void>; pending: Set<Promise<unknown>>; ended: boolean;
}
interface Owner {
  acquisition?: Promise<LinuxWriterLease>; lease?: LinuxWriterLease;
  nativeAttempted: boolean; native?: DatabaseSync; nativeConstructorFailure?: unknown; core?: SqliteCapability;
  nativeCloseAttempted: boolean; nativeCloseFailed: boolean; nativeCloseFailure?: unknown;
  openingAttempted: boolean; opening?: LocalVolumeProfileOpening; openingFailure?: unknown;
  files: FdOwner[]; reads: Set<ReadOwner>; failedReads: Set<unknown>;
  originalWork?: Promise<CaptureResult>; close?: Promise<void>; leaseDrain?: Promise<void>; leaseRelease?: Promise<void>;
  originalFailure?: unknown; normalCloseAcknowledged?: true;
}
export interface CaptureResult {
  readonly kind: "stopped-local-v28-v5-capture/1"; readonly nodeInstallationId: string; readonly sourceInstallationId: string;
  readonly sourceCheckpoint: "portable-runtime/v28"; readonly archiveFormat: "v5";
  readonly archiveSha256: string; readonly archiveBytes: number; readonly completeness: "complete" | "partial";
  readonly packagedFiles: number; readonly unavailableFiles: number;
  readonly sourceAuthorityImported: false; readonly sourceMutation: false;
}
const issued = new WeakMap<LocalV28MaintenanceCaptureCommand, Readonly<Selected>>();
const owners = new Set<Owner>();
/** Redacted original-owner metrology only; no paths, cells, error strings,
 * handle, grant or authority token can be recovered from this projection. */
export function localV28MaintenanceCaptureProcessStateCandidate() {
  return Object.freeze({ retainedOriginalOwners: owners.size,
    retainedPhysicalOwners: [...owners].filter(owner => owner.lease && !owner.normalCloseAcknowledged).length,
    normalClosedRetainedErrorOwners: [...owners].filter(owner => owner.normalCloseAcknowledged).length });
}
const POLICY = Object.freeze({ absoluteLifetimeMs: 12 * 3600_000, idleLifetimeMs: 1800_000,
  loginWindowMs: 60_000, loginAttempts: 5, throttleBuckets: 1000 });
function ensure(value: unknown): asserts value { if (!value) throw new LocalV28MaintenanceCaptureError(); }
function exact(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value)
    && Reflect.ownKeys(value).length === names.length && names.every(name => Object.hasOwn(value, name)));
}
function absolute(value: unknown): asserts value is string {
  ensure(typeof value === "string" && value.length > 0 && value.length <= 4000 && !value.includes("\0")
    && isAbsolute(value) && resolve(value) === value);
}
function identity(stat: BigIntStats): Identity { return { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode }; }
function fileIdentity(stat: BigIntStats): FileIdentity {
  return { ...identity(stat), size: stat.size, nlink: stat.nlink, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}
function same(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode;
}
function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return same(left, right) && left.size === right.size && left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function privateFile(stat: BigIntStats, uid: bigint, maximum: number): void {
  ensure(stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && stat.nlink === 1n
    && (stat.mode & 0o7777n) === 0o600n && stat.size >= 0n && stat.size <= BigInt(maximum));
}
function directories(path: string, uid: bigint, rootUid: bigint) {
  const pins: { path: string; current: Identity; private: boolean }[] = [];
  for (let current = dirname(path), first = true;; first = false) {
    const stat = lstatSync(current, { bigint: true }), parent = dirname(current), root = parent === current;
    ensure(realpathSync(current) === current && stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o022n)
      && (root ? stat.uid === rootUid : stat.uid === uid || stat.uid === 0n)
      && (!first || stat.uid === uid && (stat.mode & 0o7777n) === 0o700n));
    pins.push({ path: current, current: identity(stat), private: first }); if (root) return pins; current = parent;
  }
}
function ownFd(owner: Owner, fd: number): FdOwner {
  const captured = { fd, closeAttempted: false, closeFailed: false }; owner.files.push(captured); return captured;
}
function closeFd(file: FdOwner): void {
  if (file.closeAttempted) { if (file.closeFailed) throw file.closeFailure; return; }
  file.closeAttempted = true;
  try { closeSync(file.fd); } catch (error) { file.closeFailed = true; file.closeFailure = error; throw error; }
}
function closeRead(owner: Owner, read: ReadOwner): Promise<void> {
  return read.close ??= Promise.resolve().then(async () => {
    await Promise.allSettled([...read.pending]);
    try {
      if (read.reader) { await read.reader.cancel(); read.reader.releaseLock(); }
      else await read.body.cancel();
      owner.reads.delete(read);
    } catch (error) { owner.failedReads.add(error); throw error; }
  });
}
function closeOwner(owner: Owner): Promise<void> {
  return owner.close ??= Promise.resolve().then(async () => {
    // The complete original acquisition/setup/work settles before child snapshot.
    await owner.originalWork?.then(() => undefined, () => undefined);
    if (owner.acquisition) owner.lease = await owner.acquisition;
    const outcomes = await Promise.allSettled([...owner.reads].map(read => closeRead(owner, read)));
    for (const outcome of outcomes) if (outcome.status === "rejected") owner.failedReads.add(outcome.reason);
    if (owner.failedReads.size) throw new AggregateError([...owner.failedReads], "Original Local capture body closure failed");
    if (owner.openingAttempted && !owner.opening) {
      // This is the original failed constructor cleanup, never a new retry.
      if (owner.openingFailure instanceof StorageProfileCleanupError) await owner.openingFailure.ownership.dispose();
      throw owner.openingFailure;
    }
    await owner.opening?.close();
    for (const file of [...owner.files].reverse()) closeFd(file);
    if (owner.lease) { owner.leaseDrain ??= owner.lease.stopAdmissionAndDrain(); await owner.leaseDrain; }
    if (owner.nativeAttempted && !owner.native) throw owner.nativeConstructorFailure;
    if (!owner.nativeCloseAttempted) {
      owner.nativeCloseAttempted = true;
      try { if (owner.core) owner.core.close(); else owner.native?.close(); }
      catch (error) { owner.nativeCloseFailed = true; owner.nativeCloseFailure = error; throw error; }
    } else if (owner.nativeCloseFailed) throw owner.nativeCloseFailure;
    if (owner.lease) { owner.leaseRelease ??= owner.lease.release(); await owner.leaseRelease; }
    owner.normalCloseAcknowledged = true;
  });
}
/** This is an explicit stopped-physical operator command, not an HTTP permission,
 * File/root grant, provider callback or proof of an already-running app's drain. */
export function parseLocalV28MaintenanceCaptureCommandCandidate(argv: readonly string[]): LocalV28MaintenanceCaptureCommand {
  ensure(Array.isArray(argv) && [7, 9].includes(argv.length) && argv[0] === "capture"
    && argv.every(value => typeof value === "string" && value.length > 0 && value.length <= 4000 && !value.includes("\0")));
  const fields = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]!; ensure(["--configuration", "--archive", "--installation", "--filesystem-root-owner-uid"].includes(name) && !fields.has(name));
    fields.set(name, argv[index + 1]!);
  }
  const configuration = fields.get("--configuration"), archive = fields.get("--archive"), installationId = fields.get("--installation");
  absolute(configuration); absolute(archive); ensure(configuration !== archive && typeof installationId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(installationId));
  const rawUid = fields.get("--filesystem-root-owner-uid"), rootUid = rawUid === undefined ? 0 : Number(rawUid);
  ensure((rawUid === undefined || /^(?:0|[1-9][0-9]{0,9})$/.test(rawUid)) && Number.isSafeInteger(rootUid) && rootUid >= 0 && rootUid <= 0xffff_ffff);
  const token = Object.freeze({ kind: "fixed-stopped-local-v28-capture/1" as const });
  issued.set(token, Object.freeze({ configuration, archive, installationId, rootUid })); return token;
}
/** Holds the genuine kernel writer lease over snapshot AND every captured byte
 * pass. Normal runtime/background/GC writers must use the same private lock.
 * Same-UID malicious writers and a deployment outside that contract are excluded.
 * No account/profile registration, flag/role/grant or persistent hold is inserted. */
export function executeLocalV28MaintenanceCaptureCandidate(token: LocalV28MaintenanceCaptureCommand): Promise<CaptureResult> {
  const selected = issued.get(token); ensure(selected && process.platform === "linux" && typeof process.geteuid === "function" && owners.size < 2);
  const owner: Owner = { nativeAttempted: false, nativeCloseAttempted: false, nativeCloseFailed: false,
    openingAttempted: false, files: [], reads: new Set(), failedReads: new Set() }; owners.add(owner);
  owner.originalWork = Promise.resolve().then(async () => {
    const uid = BigInt(process.geteuid!()), rootUid = BigInt(selected.rootUid);
    const pins = [...directories(selected.configuration, uid, rootUid), ...directories(selected.archive, uid, rootUid)];
    const before = lstatSync(selected.configuration, { bigint: true }); privateFile(before, uid, 64 * 1024);
    ensure(before.size > 0n && realpathSync(selected.configuration) === selected.configuration);
    const configFd = ownFd(owner, openSync(selected.configuration, constants.O_RDONLY | constants.O_NOFOLLOW));
    ensure(sameFile(fileIdentity(before), fileIdentity(fstatSync(configFd.fd, { bigint: true }))));
    const raw = readFileSync(configFd.fd); ensure(raw.length === Number(before.size));
    const config: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    exact(config, ["schema", "databasePath", "descriptors"]);
    ensure(config.schema === "stopped-local-v28-capture/1" && Array.isArray(config.descriptors) && config.descriptors.length <= 32);
    absolute(config.databasePath);
    ensure(config.databasePath !== selected.archive && config.databasePath !== selected.configuration);
    const configuredDescriptors = config.descriptors.map(value => {
      exact(value, ["id", "root", "rootBindingId", "namespace"]); absolute(value.root);
      ensure(typeof value.id === "string" && selected.archive !== value.root && !selected.archive.startsWith(value.root + "/"));
      // Only the original V28 opening validates and privately issues physical
      // descriptors. These closed local JSON inputs grant no byte authority.
      return value as unknown as TrustedLocalVolumeDescriptor;
    });
    let descriptors: Readonly<CapturedLocalVolumeDescriptor>[] = [];
    function currentPaths() {
      for (const pin of pins) ensure(realpathSync(pin.path) === pin.path && same(pin.current, identity(lstatSync(pin.path, { bigint: true }))));
      ensure(sameFile(fileIdentity(before), fileIdentity(fstatSync(configFd.fd, { bigint: true })))
        && sameFile(fileIdentity(before), fileIdentity(lstatSync(selected.configuration, { bigint: true }))));
      for (const descriptor of descriptors) descriptor.assertCurrent();
    }
    currentPaths();
    // Existing empty600 one-link writer-lock is required; acquisition creates none.
    owner.acquisition = acquireLinuxWriterLease({ databasePath: config.databasePath, filesystemRootOwnerUid: selected.rootUid });
    owner.lease = await owner.acquisition; const lease = owner.lease;
    return await lease.withWriter(async () => {
      currentPaths(); lease.assertHeld(); owner.nativeAttempted = true;
      try { owner.native = new DatabaseSync(config.databasePath as string, { allowExtension: false, enableForeignKeyConstraints: true }); }
      catch (error) { owner.nativeConstructorFailure = error; throw error; }
      const native = owner.native, core = owner.core = createSqliteCapability(native); lease.bind(core, native);
      const admission = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE);
      ensure(admission.receipt.installationId === selected.installationId && admission.receipt.checkpointId === "portable-runtime/v28");
      // Genuine private factories; no bootstrap/login/session or KDF receipt is imported.
      const identity = await createInstalledLocalIdentity({ database: core, nativeDatabase: native, admission, hasher: createPasswordHasher(), policy: POLICY });
      const authentication = createLocalAuthentication({ identity, transport: createLoopbackLocalAuthTransport({ publicOrigin: "http://127.0.0.1:43117" }), now: Date.now });
      owner.openingAttempted = true;
      try { owner.opening = createLocalVolumeProfileOpeningV28({ database: core, nativeDatabase: native, admission,
        authentication, writerLease: lease, filesystemRootOwnerUid: selected.rootUid, descriptors: configuredDescriptors,
        authorizeAdministrator: () => false }); }
      catch (error) { owner.openingFailure = error; throw error; }
      const opening = owner.opening, context = assertLocalVolumeProfileOpeningV28(opening);
      descriptors = configuredDescriptors.map(value => context.descriptor(value.id));
      const assertCurrent = () => { currentPaths(); assertLinuxWriterLeaseBinding(lease, core, native); assertInstallationAdmission(native, admission); context.assertCurrent(); };
      assertCurrent();
      const records = await captureQuiescedNodeSystemBackupV28Candidate(core, native, { backupId: randomUUID() }); assertCurrent();
      ensure(records.sourceMigrationLedger.installationId === selected.installationId && records.origin.capturePolicy === "quiesced-writers-and-bytes/1");
      const sources = planSystemBackupSourcesV28(records.content), opened = new Map<string, OpenedStorageProfile<"local">>();
      const keys = new Map<string, Set<string>>();
      for (const item of sources) if (item.source.provider === "local" && item.source.storeKind === "file" && item.source.storageProfileId)
        keys.set(item.source.storageProfileId, new Set([...(keys.get(item.source.storageProfileId) ?? []), item.source.objectKey]));
      async function provider(item: SystemBackupSourceV28) {
        const source = item.source;
        ensure(source.provider === "local" && source.storeKind === "file" && source.storageProfileId && source.storageProfileRevision === 1);
        let adapter = opened.get(source.storageProfileId);
        if (!adapter) {
          adapter = await openStorageProfile(opening.capabilities, { profileId: source.storageProfileId, configurationRevision: 1 }, "read", {
            beforeRequest: async operation => { assertCurrent(); return ["GET", "HEAD"].includes(operation.method) && keys.get(source.storageProfileId!)?.has(operation.key) === true; },
          }); opened.set(source.storageProfileId, adapter);
        }
        assertCurrent();
        const authority = context.captureProfileAuthority({ profileId: source.storageProfileId, configurationRevision: 1 }, "read");
        const descriptor = descriptors.find(value => value.profileId === source.storageProfileId);
        ensure(descriptor && "namespace" in source && stableJson(source.namespace) === stableJson(descriptor.namespace)
          && adapter.storage.namespaceIdentity === authority.profile.namespaceIdentity);
        return adapter;
      }
      async function readBody(item: SystemBackupSourceV28): Promise<ReadableStream<Uint8Array> | null> {
        const adapter = await provider(item), result = await adapter.reader.read(item.source.objectKey); assertCurrent();
        if (result.outcome !== "available") return null;
        const read: ReadOwner = { body: result.body as ReadableStream<Uint8Array>, pending: new Set(), ended: false }; owner.reads.add(read);
        try { read.reader = read.body.getReader(); } catch (error) {
          try { await closeRead(owner, read); } catch (cleanup) { throw new AggregateError([error, cleanup], "Original capture reader construction and closure failed"); } throw error;
        }
        return new ReadableStream<Uint8Array>({ async pull(controller) {
          let original: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
          try {
            assertCurrent(); original = read.reader!.read(); read.pending.add(original);
            const next = await original; assertCurrent();
            // Only the actual input.read promise is registered: it has settled
            // before EOF disposal. No close waits for its own outer pull scope.
            if (next.done) { read.ended = true; await closeRead(owner, read); controller.close(); }
            else { ensure(next.value instanceof Uint8Array); controller.enqueue(next.value); }
          } catch (error) { controller.error(error); }
          finally { if (original) read.pending.delete(original); }
        }, cancel() { return closeRead(owner, read); } }, { highWaterMark: 0 });
      }
      async function measured(item: SystemBackupSourceV28): Promise<SystemBackupFileV28> {
        const unavailable = (outcome: SystemBackupOutcome): SystemBackupFileV28 => ({ ...item, path: null, byteSize: null, sha256: null, outcome });
        if (item.source.initialOutcome !== null) return unavailable(item.source.initialOutcome === "missing" ? "missing"
          : item.source.initialOutcome === "provider_unavailable" ? "provider_unavailable" : "metadata_unavailable");
        if (item.source.provider !== "local" || item.source.storeKind !== "file") return unavailable("provider_unavailable");
        const body = await readBody(item); if (!body) return unavailable("download_failed");
        const reader = body.getReader(), hash = createHash("sha256"); let bytes = 0, workFailed = false, originalFailure: unknown;
        try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength;
          ensure(bytes <= SYSTEM_BACKUP_MAX_PAYLOAD_BYTES); hash.update(next.value); } }
        catch (error) { workFailed = true; originalFailure = error; }
        try { await reader.cancel(); reader.releaseLock(); } catch (cleanup) {
          if (workFailed) throw new AggregateError([originalFailure, cleanup], "Original capture byte work and closure failed"); throw cleanup;
        }
        if (workFailed) throw originalFailure;
        const sha256 = hash.digest("hex");
        if (item.source.expectedByteSize !== null && item.source.expectedByteSize !== bytes) return unavailable("size_mismatch");
        if (item.source.expectedSha256 !== null && item.source.expectedSha256.toLowerCase() !== sha256) return unavailable("hash_mismatch");
        return { ...item, path: `files/${item.id}`, outcome: "packaged", byteSize: bytes, sha256 };
      }
      const files: SystemBackupFileV28[] = [];
      for (const source of sources) { assertCurrent(); files.push(await measured(source)); }
      const manifest: SystemBackupManifestV5 = await finishSystemBackupManifestV5(records, files);
      await validateSystemBackupDocumentsV5(manifest, records); assertCurrent();
      const metadata = await systemBackupArchiveMetadata(manifest, records, manifest);
      const byPath = new Map(files.filter(file => file.outcome === "packaged").map(file => [file.path!, file]));
      const openPayload: OpenArchiveEntry = async (entry: ArchiveEntry) => {
        const file = byPath.get(entry.path); ensure(file && file.byteSize === entry.byteSize && file.sha256 === entry.sha256);
        const body = await readBody(file); ensure(body); return body;
      };
      const measuredArchive = await measureSystemBackupArchive(metadata, openPayload); assertCurrent();
      ensure(measuredArchive.byteSize <= SYSTEM_BACKUP_MAX_ARCHIVE_BYTES);
      const outputDirectory = ownFd(owner, openSync(dirname(selected.archive), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
      ensure(same(identity(fstatSync(outputDirectory.fd, { bigint: true })), identity(lstatSync(dirname(selected.archive), { bigint: true }))));
      const stage = join(dirname(selected.archive), `.local-v28-capture-${records.backupId}.partial`);
      const output = ownFd(owner, openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
      privateFile(fstatSync(output.fd, { bigint: true }), uid, SYSTEM_BACKUP_MAX_ARCHIVE_BYTES);
      const stageIdentity = identity(fstatSync(output.fd, { bigint: true }));
      const assertStage = () => {
        const fd = fstatSync(output.fd, { bigint: true }), path = lstatSync(stage, { bigint: true });
        privateFile(fd, uid, SYSTEM_BACKUP_MAX_ARCHIVE_BYTES); privateFile(path, uid, SYSTEM_BACKUP_MAX_ARCHIVE_BYTES);
        ensure(realpathSync(stage) === stage && same(stageIdentity, identity(fd)) && sameFile(fileIdentity(fd), fileIdentity(path)));
      };
      assertStage();
      const body = createSystemBackupArchiveStream(metadata, openPayload), reader = body.getReader(), hash = createHash("sha256");
      let byteSize = 0, workFailed = false, originalFailure: unknown;
      try {
        while (true) { const next = await reader.read(); assertCurrent(); if (next.done) break;
          ensure(next.value instanceof Uint8Array); byteSize += next.value.byteLength; ensure(byteSize <= measuredArchive.byteSize);
          assertStage(); hash.update(next.value); let offset = 0;
          while (offset < next.value.length) { const written = writeSync(output.fd, next.value, offset, next.value.length - offset); ensure(written > 0); offset += written; }
        }
        ensure(byteSize === measuredArchive.byteSize && hash.digest("hex") === measuredArchive.sha256); fsyncSync(output.fd);
      } catch (error) { workFailed = true; originalFailure = error; }
      try { await reader.cancel(); reader.releaseLock(); } catch (cleanup) {
        if (workFailed) throw new AggregateError([originalFailure, cleanup], "Original archive work and response closure failed"); throw cleanup;
      }
      if (workFailed) throw originalFailure;
      assertStage(); const completedFile = fileIdentity(fstatSync(output.fd, { bigint: true }));
      closeFd(output); assertCurrent(); ensure(sameFile(completedFile, fileIdentity(lstatSync(stage, { bigint: true }))));
      // link is atomic no-replace. Unknown link/unlink/fsync outcomes are retained
      // as failures with original stage/final paths; no overwrite/retry/removal.
      linkSync(stage, selected.archive); unlinkSync(stage); fsyncSync(outputDirectory.fd);
      const final = lstatSync(selected.archive, { bigint: true }); privateFile(final, uid, SYSTEM_BACKUP_MAX_ARCHIVE_BYTES);
      ensure(same(completedFile, identity(final)) && final.size === BigInt(byteSize) && final.mtimeNs === completedFile.mtimeNs
        && realpathSync(selected.archive) === selected.archive); assertCurrent();
      return Object.freeze({ kind: "stopped-local-v28-v5-capture/1" as const, nodeInstallationId: selected.installationId, sourceInstallationId: manifest.sourceInstallationId,
        sourceCheckpoint: "portable-runtime/v28" as const, archiveFormat: "v5" as const, archiveSha256: measuredArchive.sha256,
        archiveBytes: byteSize, completeness: manifest.completeness, packagedFiles: manifest.counts.packagedFiles,
        unavailableFiles: manifest.counts.unavailableFiles, sourceAuthorityImported: false as const, sourceMutation: false as const });
    });
  });
  return Promise.resolve().then(async () => {
    let result: CaptureResult | undefined, failed = false, failure: unknown;
    try { result = await owner.originalWork; } catch (error) { failed = true; failure = error; owner.originalFailure = error; }
    try { await closeOwner(owner); } catch (cleanup) {
      if (failed) throw new AggregateError([failure, cleanup], "Original maintenance capture and first closure failed"); throw cleanup;
    }
    if (failed) throw failure;
    ensure(result); owners.delete(owner); return result;
  });
}

