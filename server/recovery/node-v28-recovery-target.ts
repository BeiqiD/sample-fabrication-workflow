import { constants, lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { ReadableStreamReadResult } from "node:stream/web";
import { stableJson } from "../../shared/domain/content-addressing.ts";
import type { NodeConfiguredRecoveryTarget } from "../node-runtime-config.ts";
import { acquireLinuxWriterLease, assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease.ts";
import { createSqliteCapability, type SqliteCapability } from "../sqlite.ts";
import { assertOriginalNodeV28TargetSourceFrame, type OriginalNodeV28TargetSourceFrame } from "./node-system-recovery-v28-application.ts";

export interface NodeV28TargetIdentity {
  readonly kind: "node-v28-fresh-inert-target/1";
  readonly sourceInstallationId: string; readonly targetId: string; readonly rootBindingId: string; readonly sha256: string;
}
export interface NodeV28TargetIntent {
  readonly jobId: string; readonly archiveSha256: string; readonly imageSha256: string;
}
export interface NodeV28TargetDatabaseIdentity { readonly dev: string; readonly ino: string; readonly uid: string; readonly gid: string; readonly mode: string }
export interface NodeV28TargetNative {
  readonly native: DatabaseSync;
  readonly core: SqliteCapability;
  readonly lease: LinuxWriterLease;
}
interface HandleOwner { handle: FileHandle; originalClose?: Promise<void>; close(): Promise<void> }
interface DirectoryOwner { path: string; handle: HandleOwner; stat: BigIntStats }
interface NativeOwner {
  opening?: Promise<LinuxWriterLease>; lease?: LinuxWriterLease; nativeAttempted: boolean; native?: DatabaseSync; core?: SqliteCapability;
  closing?: Promise<void>; failed: boolean; failure?: unknown;
  bindingAccepted: boolean; workActive: boolean;
}
const retained = new Set<object>();
const originalTargetIdentityChecks = new WeakMap<object, Readonly<{
  source: () => void; assertIdentity(frame: OriginalNodeV28TargetSourceFrame, expected: NodeV28TargetDatabaseIdentity): void;
}>>();
/** The original target factory alone registers its private metadata checker.
 * The opaque source frame is consumed by the actual issuing engine. */
export function assertOriginalNodeV28TargetDatabaseIdentity(target: object,
  frame: OriginalNodeV28TargetSourceFrame, expected: NodeV28TargetDatabaseIdentity): void {
  const original = originalTargetIdentityChecks.get(target);
  if (!original) throw new Error("target_unavailable");
  original.assertIdentity(frame, expected);
}
const fail = (reason = "target_unavailable"): never => { throw new Error(reason); };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
function privateDirectory(value: BigIntStats): boolean {
  return value.isDirectory() && !value.isSymbolicLink() && typeof process.geteuid === "function"
    && value.uid === BigInt(process.geteuid()) && (value.mode & 0o7777n) === 0o700n;
}
function privateFile(value: BigIntStats): boolean {
  return value.isFile() && !value.isSymbolicLink() && value.nlink === 1n && typeof process.geteuid === "function"
    && value.uid === BigInt(process.geteuid()) && (value.mode & 0o7777n) === 0o600n;
}
function code(error: unknown): unknown { return error && typeof error === "object" ? (error as { code?: unknown }).code : undefined; }

/** Original filesystem/native owner for one configured fresh isolated target.
 * Every path is code-selected below the sealed private parent. The archive never
 * supplies a root, target identity, SQL, binding, grant or execution capability.
 * A failed target is retained; this owner has no deletion/sweep operation. */
export async function openNodeV28RecoveryTarget(options: {
  binding: Readonly<NodeConfiguredRecoveryTarget>; sourceInstallationId: string; filesystemRootOwnerUid: number;
  assertSource(): void; quarantine(error: unknown): void;
}) {
  const captured = Object.freeze({ ...options, binding: Object.freeze({ ...options.binding }) });
  const { binding, sourceInstallationId } = captured, root = join(binding.parent, binding.targetId);
  const identity: NodeV28TargetIdentity = Object.freeze({ kind: "node-v28-fresh-inert-target/1", sourceInstallationId,
    targetId: binding.targetId, rootBindingId: binding.rootBindingId,
    sha256: sha(stableJson({ sourceInstallationId, parent: binding.parent, targetId: binding.targetId, rootBindingId: binding.rootBindingId })) });
  const handles = new Set<HandleOwner>(), directories = new Map<string, DirectoryOwner>(), pending = new Set<Promise<unknown>>();
  const nativeOwners = new Set<NativeOwner>(), mutations = new Set<string>();
  const owner = { identity, handles, directories, pending, nativeOwners, closed: false, failed: false,
    failure: undefined as unknown, closing: undefined as Promise<void> | undefined };
  retained.add(owner);
  function remember(error: unknown): void {
    if (!owner.failed) { owner.failed = true; owner.failure = error; }
    captured.quarantine(error);
  }
  function physical(): void {
    if (owner.closed || owner.failed) fail(); captured.assertSource(); assertDirectories();
  }
  function assertDirectories(): void {
    for (const directory of directories.values()) {
      const value = lstatSync(directory.path, { bigint: true });
      if (!privateDirectory(value) || !same(directory.stat, value) || realpathSync(directory.path) !== directory.path) fail("target_alias");
    }
  }
  function assertDatabaseIdentity(expected: NodeV28TargetDatabaseIdentity): void {
    physical(); assertDatabaseMetadata(expected);
  }
  function assertDatabaseMetadata(expected: NodeV28TargetDatabaseIdentity): void {
    const file = lstatSync(join(root, "database.sqlite"), { bigint: true });
    if (!expected || Object.keys(expected).length !== 5 || !privateFile(file)
      || stableJson(expected) !== stableJson({ dev: String(file.dev), ino: String(file.ino), uid: String(file.uid), gid: String(file.gid), mode: String(file.mode) })) fail("target_alias");
    for (const selected of nativeOwners) if (selected.native && selected.core && selected.lease) {
      // The exact pair was accepted by the original full binding check before
      // its private withWriter work. Direct reviewed Native transactions do not
      // belong to core.batch; calling core.primary inside BEGIN would correctly
      // reject that foreign batch. Require this exact issued work owner, keep
      // physical inode/lease proof, and repeat full binding after transaction.
      if (!selected.bindingAccepted || !selected.native.isOpen || selected.native.isTransaction && !selected.workActive) fail("target_unavailable");
      selected.lease.assertHeld();
    }
  }
  function own(handle: FileHandle): HandleOwner {
    const selected: HandleOwner = { handle, close() {
      return selected.originalClose ??= Promise.resolve().then(() => handle.close()).then(() => { handles.delete(selected); },
        error => { remember(error); throw error; });
    } };
    handles.add(selected); return selected;
  }
  function track<T>(work: () => Promise<T>): Promise<T> {
    try { physical(); } catch (error) { return Promise.reject(error); }
    const original = Promise.resolve().then(work); pending.add(original);
    void original.then(() => pending.delete(original), () => pending.delete(original)); return original;
  }
  async function directory(path: string): Promise<DirectoryOwner> {
    const current = directories.get(path); if (current) { physical(); return current; }
    physical(); const before = await lstat(path, { bigint: true });
    if (!privateDirectory(before) || realpathSync(path) !== path) fail("target_alias");
    const selected = own(await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    const stat = await selected.handle.stat({ bigint: true });
    if (!privateDirectory(stat) || !same(before, stat)) fail("target_alias");
    const value = { path, handle: selected, stat }; directories.set(path, value); physical(); return value;
  }
  async function readFile(path: string, maximum: number, guard?: () => void): Promise<Uint8Array> {
    physical(); const before = await lstat(path, { bigint: true });
    if (!privateFile(before) || before.size > BigInt(maximum)) fail("target_alias");
    const selected = own(await open(path, constants.O_RDONLY | constants.O_NOFOLLOW));
    let failed = false, failure: unknown, value!: Uint8Array;
    try {
      const stat = await selected.handle.stat({ bigint: true }); if (!privateFile(stat) || !same(stat, before) || stat.size !== before.size) fail("target_alias");
      value = new Uint8Array(Number(stat.size)); let offset = 0;
      while (offset < value.byteLength) { guard?.(); const result = await selected.handle.read(value, offset, value.byteLength - offset, offset); if (!result.bytesRead) fail("target_unavailable"); offset += result.bytesRead; }
      const extra = new Uint8Array(1); if ((await selected.handle.read(extra, 0, 1, value.byteLength)).bytesRead) fail("target_alias");
      if (guard) { guard(); await selected.handle.sync(); }
      const after = await selected.handle.stat({ bigint: true }), pathAfter = await lstat(path, { bigint: true });
      if (!privateFile(pathAfter) || !same(stat, after) || !same(after, pathAfter) || stat.size !== after.size
        || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs) fail("target_alias");
      physical();
    } catch (error) { failed = true; failure = error; }
    try { await selected.close(); } catch (cleanup) { throw failed ? new AggregateError([failure, cleanup]) : cleanup; }
    if (failed) throw failure;
    if (guard) { guard(); const parent = await directory(dirname(path)); guard(); await parent.handle.handle.sync(); }
    return value;
  }
  const expectedMarker = (intent: NodeV28TargetIntent) => ({ format: "node-v28-inert-recovery-target/1", identity,
    jobId: intent.jobId, archiveSha256: intent.archiveSha256, imageSha256: intent.imageSha256 });
  async function assertIntent(intent: NodeV28TargetIntent): Promise<void> {
    await directory(root);
    const bytes = await readFile(join(root, "target-owner.json"), 4096);
    if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== stableJson(expectedMarker(intent))) fail("target_alias");
    for (const name of ["files", "metadata", "report"]) await directory(join(root, name));
  }
  async function writeBytes(path: string, bytes: Uint8Array, guard: () => void): Promise<void> {
    guard(); physical(); const selected = own(await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
    let failed = false, failure: unknown;
    try {
      let offset = 0;
      while (offset < bytes.byteLength) { guard(); physical(); const result = await selected.handle.write(bytes, offset, Math.min(65536, bytes.byteLength - offset), offset); if (!result.bytesWritten) fail(); offset += result.bytesWritten; }
      guard(); await selected.handle.sync();
    } catch (error) { failed = true; failure = error; }
    try { await selected.close(); } catch (cleanup) { throw failed ? new AggregateError([failure, cleanup]) : cleanup; }
    if (failed) throw failure;
    guard(); const parent = await directory(dirname(path)); guard(); await parent.handle.handle.sync();
  }
  function closeNative(selected: NativeOwner): Promise<void> {
    return selected.closing ??= (async () => {
      try {
        if (selected.opening) selected.lease = await selected.opening;
        if (selected.lease) await selected.lease.stopAdmissionAndDrain();
        if (selected.nativeAttempted && !selected.native) fail("target_unavailable");
        if (selected.core) selected.core.close(); else if (selected.native) selected.native.close();
        if (selected.native?.isOpen) fail(); if (selected.lease) await selected.lease.release(); nativeOwners.delete(selected);
      } catch (error) { selected.failed = true; selected.failure = error; remember(error); throw error; }
    })();
  }
  function close(): Promise<void> {
    if (owner.closing) return owner.closing; owner.closed = true;
    owner.closing = (async () => {
      // Each still-issued operation owns all readers, filesystem calls and
      // nested physical workers beyond a shared kernel deadline race.
      await Promise.allSettled([...pending]);
      const children = await Promise.allSettled([...nativeOwners].map(closeNative));
      const fds = await Promise.allSettled([...handles].reverse().map(value => value.close()));
      const failures = [...children, ...fds].flatMap(value => value.status === "rejected" ? [value.reason as unknown] : []);
      if (mutations.size) failures.push(new Error("Original target payload mutation remains unproven"));
      if (owner.failed || failures.length) throw new AggregateError([...(owner.failed ? [owner.failure] : []), ...failures], "Original inert target ownership did not close");
      retained.delete(owner);
    })().catch(error => { remember(error); throw error; });
    void owner.closing.catch(() => undefined); return owner.closing;
  }
  try {
    await directory(binding.parent);
    const marker = await readFile(join(binding.parent, "namespace.json"), 4096);
    if (new TextDecoder("utf-8", { fatal: true }).decode(marker) !== stableJson({ format: "node-v28-recovery-target-parent/1", sourceInstallationId, rootBindingId: binding.rootBindingId })) fail("target_alias");
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Target parent opening and original cleanup failed"); } throw error;
  }
  const target = Object.freeze({ identity, destination: root,
    assertDatabaseIdentity,
    checkpoint() { physical(); return Object.freeze({ targetNamespace: identity }); },
    async fresh(): Promise<boolean> {
      physical(); try { await lstat(root); return false; } catch (error) { if (code(error) === "ENOENT") return true; throw error; }
    },
    create(intent: NodeV28TargetIntent, guard: () => void): Promise<void> { return track(async () => {
      guard(); let fresh = false;
      try { await mkdir(root, { mode: 0o700 }); fresh = true; } catch (error) { if (code(error) !== "EEXIST") throw error; }
      await directory(root); guard();
      if (fresh) await writeBytes(join(root, "target-owner.json"), new TextEncoder().encode(stableJson(expectedMarker(intent))), guard);
      else {
        // Resume only after positive proof of the exact original owner marker.
        // An absent/partial marker leaves the retained path unresolved.
        const marker = await readFile(join(root, "target-owner.json"), 4096, guard);
        if (new TextDecoder("utf-8", { fatal: true }).decode(marker) !== stableJson(expectedMarker(intent))) fail("target_alias");
      }
      for (const name of ["files", "metadata", "report"]) {
        guard(); try { await mkdir(join(root, name), { mode: 0o700 }); } catch (error) { if (code(error) !== "EEXIST") throw error; }
        await directory(join(root, name));
      }
      for (const name of ["database.sqlite", "database.sqlite.writer-lock"]) {
        guard(); try { await writeBytes(join(root, name), new Uint8Array(), guard); }
        catch (error) { if (code(error) !== "EEXIST") throw error;
          // The claim stage never opens Native. Its retry admits only the exact
          // empty original files, never a caller-provided or initialized DB.
          if ((await readFile(join(root, name), 1, guard)).byteLength !== 0) fail("write_outcome_unknown"); }
      }
      guard(); await directories.get(root)!.handle.handle.sync(); guard(); await directories.get(binding.parent)!.handle.handle.sync();
    }); },
    assertIntent(intent: NodeV28TargetIntent): Promise<void> { return track(() => assertIntent(intent)); },
    databaseIdentity(intent: NodeV28TargetIntent): Promise<{ dev: string; ino: string; uid: string; gid: string; mode: string }> {
      return track(async () => { await assertIntent(intent); const value = await lstat(join(root, "database.sqlite"), { bigint: true });
        if (!privateFile(value)) fail("target_alias");
        return { dev: String(value.dev), ino: String(value.ino), uid: String(value.uid), gid: String(value.gid), mode: String(value.mode) }; });
    },
    withNative<T>(intent: NodeV28TargetIntent, guard: () => void, work: (value: NodeV28TargetNative) => T | Promise<T>, expectedIdentity: { dev: string; ino: string; uid: string; gid: string; mode: string }): Promise<T> {
      return track(async () => {
        await assertIntent(intent); guard();
        assertDatabaseIdentity(expectedIdentity);
        const selected: NativeOwner = { nativeAttempted: false, failed: false, bindingAccepted: false, workActive: false }; nativeOwners.add(selected);
        let failed = false, failure: unknown, value!: T;
        try {
          selected.opening = acquireLinuxWriterLease({ databasePath: join(root, "database.sqlite"), filesystemRootOwnerUid: captured.filesystemRootOwnerUid });
          void selected.opening.catch(() => undefined); selected.lease = await selected.opening;
          // The original physical acquire awaited an external worker. Recheck
          // the durable cursor inode synchronously before Native can write.
          guard(); assertDatabaseIdentity(expectedIdentity); selected.nativeAttempted = true;
          selected.native = new DatabaseSync(join(root, "database.sqlite"), { allowExtension: false, enableForeignKeyConstraints: true });
          guard(); assertDatabaseIdentity(expectedIdentity);
          selected.core = createSqliteCapability(selected.native); selected.lease.bind(selected.core, selected.native);
          const opened = Object.freeze({ native: selected.native, core: selected.core, lease: selected.lease });
          assertLinuxWriterLeaseBinding(opened.lease, opened.core, opened.native); selected.bindingAccepted = true;
          value = await selected.lease.withWriter(async () => {
            guard(); assertDatabaseIdentity(expectedIdentity); assertLinuxWriterLeaseBinding(opened.lease, opened.core, opened.native);
            if (opened.native.isTransaction) fail("target_unavailable");
            selected.workActive = true;
            try {
              const result = await work(opened);
              guard(); assertDatabaseIdentity(expectedIdentity);
              if (opened.native.isTransaction) fail("target_owned_transaction_unsettled");
              assertLinuxWriterLeaseBinding(opened.lease, opened.core, opened.native); return result;
            } finally { selected.workActive = false; }
          });
        } catch (error) { failed = true; failure = error; }
        try { await closeNative(selected); } catch (cleanup) { throw failed ? new AggregateError([failure, cleanup]) : cleanup; }
        if (failed) throw failure; return value;
      });
    },
    writeDocument(intent: NodeV28TargetIntent, path: "metadata/records.json" | "metadata/manifest.json" | "metadata/destination-checkpoint-construction.json" | "recovery-report.json" | "inert-local-volume-mappings.json" | "source-byte-inventory.json", value: unknown, guard: () => void): Promise<void> {
      return track(async () => { await assertIntent(intent); guard(); const bytes = new TextEncoder().encode(stableJson(value));
        if (bytes.byteLength > 4194304) fail("archive_budget");
        try { await writeBytes(join(root, path), bytes, guard); }
        catch (error) { if (code(error) !== "EEXIST") throw error;
          const prior = await readFile(join(root, path), 4194304, guard); if (sha(Buffer.from(prior).toString("utf8")) !== sha(stableJson(value))) fail("target_alias"); }
      });
    },
    writePayload(intent: NodeV28TargetIntent, id: string, body: ReadableStream<Uint8Array>, expected: { byteSize: number; sha256: string }, guard: () => void): Promise<void> {
      return track(async () => {
        if (!/^b_[0-9]{4}$/.test(id)) fail("archive_invalid"); await assertIntent(intent); guard();
        if (mutations.has(id)) fail("write_outcome_unknown"); mutations.add(id);
        const reader = body.getReader(), reads = new Set<Promise<ReadableStreamReadResult<Uint8Array>>>();
        let readerClosed: Promise<void> | undefined, file: HandleOwner | undefined, failed = false, failure: unknown;
        const closeReader = () => readerClosed ??= (async () => { await reader.cancel(); await Promise.allSettled([...reads]); reader.releaseLock(); })();
        try {
          file = own(await open(join(root, "files", id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
          const hash = createHash("sha256"); let bytes = 0;
          for (;;) {
            guard(); physical(); const original = reader.read(); reads.add(original); const next = await original; reads.delete(original);
            if (next.done) break; if (bytes + next.value.byteLength > expected.byteSize) fail("archive_invalid");
            let offset = 0;
            while (offset < next.value.byteLength) { guard(); physical(); const result = await file.handle.write(next.value, offset, Math.min(65536, next.value.byteLength - offset), bytes + offset);
              if (!result.bytesWritten) fail(); offset += result.bytesWritten; }
            hash.update(next.value); bytes += next.value.byteLength;
          }
          if (bytes !== expected.byteSize || hash.digest("hex") !== expected.sha256) fail("archive_invalid"); guard(); await file.handle.sync();
        } catch (error) { failed = true; failure = error; }
        const closes = await Promise.allSettled([closeReader(), ...(file ? [file.close()] : [])]);
        const errors = closes.flatMap(value => value.status === "rejected" ? [value.reason as unknown] : []);
        if (errors.length) { const error = new AggregateError([...(failed ? [failure] : []), ...errors], "Original target payload body/FD cleanup failed"); remember(error); throw error; }
        if (failed) { mutations.delete(id); throw failure; }
        guard(); await directories.get(join(root, "files"))!.handle.handle.sync(); mutations.delete(id);
      });
    },
    verifyPayload(intent: NodeV28TargetIntent, id: string, expected: { byteSize: number; sha256: string }, guard: () => void): Promise<boolean> {
      return track(async () => { if (!/^b_[0-9]{4}$/.test(id)) fail("archive_invalid"); if (mutations.has(id)) fail("write_outcome_unknown"); await assertIntent(intent); guard();
        const path = join(root, "files", id); let selected: HandleOwner | undefined;
        try {
          const before = await lstat(path, { bigint: true }); if (!privateFile(before) || before.size !== BigInt(expected.byteSize)) return false;
          selected = own(await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)); const stat = await selected.handle.stat({ bigint: true });
          if (!privateFile(stat) || !same(before, stat) || stat.size !== before.size) fail("target_alias");
          const hash = createHash("sha256"), buffer = new Uint8Array(65536); let bytes = 0;
          for (;;) { guard(); physical(); const result = await selected.handle.read(buffer, 0, Math.min(buffer.byteLength, expected.byteSize - bytes + 1), bytes);
            if (!result.bytesRead) break; bytes += result.bytesRead; if (bytes > expected.byteSize) return false; hash.update(buffer.subarray(0, result.bytesRead)); }
          const after = await selected.handle.stat({ bigint: true }), pathAfter = await lstat(path, { bigint: true });
          if (!privateFile(pathAfter) || !same(stat, after) || !same(after, pathAfter) || stat.size !== after.size
            || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs) fail("target_alias");
          guard(); const verified = bytes === expected.byteSize && hash.digest("hex") === expected.sha256;
          if (verified) { await selected.handle.sync(); guard(); await directories.get(join(root, "files"))!.handle.handle.sync(); }
          return verified;
        } catch (error) { if (code(error) === "ENOENT") return false; throw error; }
        finally { if (selected) await selected.close(); }
      });
    },
    close,
  });
  originalTargetIdentityChecks.set(target, Object.freeze({ source: captured.assertSource,
    assertIdentity(frame: OriginalNodeV28TargetSourceFrame, expected: NodeV28TargetDatabaseIdentity) {
      if (owner.closed || owner.failed) fail();
      assertOriginalNodeV28TargetSourceFrame(frame, target, captured.assertSource);
      assertDirectories(); assertDatabaseMetadata(expected);
    } }));
  return target;
}
export type NodeV28RecoveryTarget = Awaited<ReturnType<typeof openNodeV28RecoveryTarget>>;
