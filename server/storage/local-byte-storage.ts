import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, realpath, readdir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ByteDeleter } from "../../worker/files/byte-deleter";
import type { ByteMetadata, ByteReader } from "../../worker/files/byte-reader";
import { ByteVerificationError, bufferByteStream, disposeByteVerificationFailure, validateByteExpectation, verifyingStream } from "../../worker/files/byte-verification.ts";
import type { ByteWriteInput, ByteWriter } from "../../worker/files/byte-writer";
import { nodeSha256 } from "./node-sha256.ts";
import { StorageProfileCleanupError, type FileByteOperation } from "../../worker/files/storage-profile-opening.ts";

export interface LocalByteNamespace {
  readonly volumeId: string;
  readonly rootId: string;
  readonly profileId: string;
  readonly namespaceRevision: number;
}
export interface LocalByteBinding {
  /** Operator-provisioned absolute private root; never created or normalized. */
  readonly root: string;
  readonly namespace: LocalByteNamespace;
}
export interface LocalByteStorage {
  readonly reader: ByteReader;
  readonly writer: ByteWriter;
  readonly deleter: ByteDeleter;
  close(): Promise<void>;
}
/** Optional owned runtime fencing. The final synchronous assertion runs after
 * asynchronous authorization and immediately before destructive publication.
 * Already-started filesystem operations cannot be revoked retroactively. */
export interface LocalByteStorageMutationFence {
  beforeMutation(operation: FileByteOperation): Promise<boolean>;
  assertCurrent(operation: FileByteOperation): void;
}
export class LocalByteStorageError extends Error {
  constructor(readonly reason: "unavailable" | "conflict", options?: ErrorOptions) {
    super(reason === "conflict" ? "The immutable local object already exists" : "Local byte storage is unavailable", options);
    this.name = "LocalByteStorageError";
  }
}
type ObjectMetadata = {
  format: "local-byte-object-v1";
  namespace: LocalByteNamespace;
  key: string;
  byteSize: number;
  sha256: string;
  contentType: string;
  filename: string;
};
const MARKER = "namespace.json";
const METADATA = "metadata.json";
const DATA = "data";
const MAX_METADATA_BYTES = 16 * 1024;
const CHUNK_BYTES = 64 * 1024;
const fail = (): never => { throw new LocalByteStorageError("unavailable"); };
const code = (error: unknown) => typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
const sameInode = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino;
const owner = (stat: BigIntStats) => typeof process.geteuid === "function" && stat.uid === BigInt(process.geteuid());

type Closer = () => Promise<void>;
const nativeClosers = new WeakMap<FileHandle, { close: Closer; registries: Set<Set<Closer>> }>();
const failedLocalOwners = new Set<object>();
function combineFailures(failures: unknown[], message: string): unknown {
  const distinct = [...new Set(failures)];
  return distinct.length === 1 ? distinct[0] : new AggregateError(distinct, message);
}
function ownHandle(handle: FileHandle, retained?: Set<Closer>): Closer {
  let record = nativeClosers.get(handle);
  if (!record) {
    const original = handle.close.bind(handle), registries = new Set<Set<Closer>>();
    let closing: Promise<void> | undefined;
    const owner = { handle, original, registries, close: (): Promise<void> => closing ??= Promise.resolve().then(original).then(() => {
      for (const registry of registries) registry.delete(owner.close);
      registries.clear();
    }, error => { failedLocalOwners.add(owner); throw error; }) };
    record = { close: owner.close, registries }; nativeClosers.set(handle, record);
  }
  if (retained) { record.registries.add(retained); retained.add(record.close); }
  return record.close;
}
async function preserveClose<T>(close: Closer, work: () => Promise<T>): Promise<T> {
  let result: T | undefined, rejected = false, original: unknown;
  try { result = await work(); } catch (error) { rejected = true; original = error; }
  try { await close(); } catch (cleanup) {
    throw rejected ? combineFailures([original, cleanup], "Local byte work and first close failed") : cleanup;
  }
  if (rejected) throw original;
  return result!;
}
function canonicalText(value: unknown, maximum: number, nonempty = true): value is string {
  return typeof value === "string" && (!nonempty || value.trim().length > 0) && !value.includes("\0")
    && value.normalize("NFC") === value && new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) === value
    && Buffer.byteLength(value, "utf8") <= maximum;
}
function validateNamespace(value: LocalByteNamespace) {
  if (!canonicalText(value.volumeId, 1024) || !canonicalText(value.rootId, 1024) || !canonicalText(value.profileId, 1024)
    || !Number.isSafeInteger(value.namespaceRevision) || value.namespaceRevision < 1) fail();
}
function namespaceValue(value: LocalByteNamespace): LocalByteNamespace {
  return { volumeId: value.volumeId, rootId: value.rootId, profileId: value.profileId, namespaceRevision: value.namespaceRevision };
}
function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}
function sameNamespace(value: unknown, expected: LocalByteNamespace) {
  return exactKeys(value, ["volumeId", "rootId", "profileId", "namespaceRevision"])
    && value.volumeId === expected.volumeId && value.rootId === expected.rootId && value.profileId === expected.profileId
    && value.namespaceRevision === expected.namespaceRevision;
}
function identity(namespace: LocalByteNamespace, key: string) {
  if (!canonicalText(key, 4096)) fail();
  return createHash("sha256").update(JSON.stringify(["local-byte-object-v1", namespaceValue(namespace), key])).digest("hex");
}
async function directory(path: string, retained?: Set<Closer>): Promise<{ handle: FileHandle; stat: BigIntStats }> {
  const before = await lstat(path, { bigint: true });
  if (!before.isDirectory() || !owner(before) || (before.mode & 0o077n) !== 0n || await realpath(path) !== path) fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const close = ownHandle(handle, retained);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory() || !sameInode(before, stat)) fail();
    return { handle, stat };
  } catch (error) { return preserveClose(close, async () => { throw error; }); }
}
async function regular(path: string, flags = constants.O_RDONLY, retained?: Set<Closer>): Promise<FileHandle> {
  const handle = await open(path, flags | constants.O_NOFOLLOW);
  const close = ownHandle(handle, retained);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || !owner(stat) || stat.nlink !== 1n || (stat.mode & 0o077n) !== 0n) fail();
    return handle;
  } catch (error) { return preserveClose(close, async () => { throw error; }); }
}
async function smallJson(path: string, retained?: Set<Closer>) {
  const handle = await regular(path, constants.O_RDONLY, retained);
  return preserveClose(ownHandle(handle), async () => {
    const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_METADATA_BYTES || (await handle.stat({ bigint: true })).size !== BigInt(bytesRead)) fail();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))) as unknown;
  });
}
async function createRegular(path: string, retained?: Set<Closer>) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  ownHandle(handle, retained); return handle;
}
async function writeAll(handle: FileHandle, value: Uint8Array) {
  for (let offset = 0; offset < value.byteLength;) {
    const result = await handle.write(value, offset, value.byteLength - offset);
    if (result.bytesWritten <= 0) fail();
    offset += result.bytesWritten;
  }
}
async function closeHandles(handles: readonly FileHandle[]) {
  // One early close rejection must not report settlement while another native
  // close remains pending. Failed owners stay referenced for quarantine.
  const results = await Promise.allSettled(handles.map(handle => ownHandle(handle)()));
  const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw combineFailures(failures, "Local byte handles did not all close");
}
function metadata(value: unknown, namespace: LocalByteNamespace, key: string): ObjectMetadata {
  if (!exactKeys(value, ["format", "namespace", "key", "byteSize", "sha256", "contentType", "filename"])
    || value.format !== "local-byte-object-v1" || !sameNamespace(value.namespace, namespace) || value.key !== key
    || typeof value.byteSize !== "number" || typeof value.sha256 !== "string"
    || typeof value.contentType !== "string" || !/^[\x20-\x7e]{1,512}$/.test(value.contentType)
    || !canonicalText(value.filename, 1024, false)) fail();
  const record = value as ObjectMetadata;
  validateByteExpectation(record, "destination");
  return record;
}
const headers = (value: ObjectMetadata): ByteMetadata => ({ contentType: value.contentType, etag: null,
  httpMetadata: { "content-type": value.contentType } });

/** Disabled/uncomposed capability foundation, not a registered local profile.
 * Operator provisioning must already supply private root/objects/staging dirs
 * and namespace.json = { format:"local-byte-namespace-v1", namespace }.
 * The caller still owns authorization, durable attempts, verification, File
 * publication and deletion claims. Missing or changed bindings never fall back.
 * Private local directories are required; hostile host-admin mutation and
 * network/multi-writer filesystem semantics are not qualified by these checks.
 */
export async function openLocalByteStorage(binding: LocalByteBinding, fence?: LocalByteStorageMutationFence): Promise<LocalByteStorage> {
  const beforeMutation = fence?.beforeMutation.bind(fence), assertCurrent = fence?.assertCurrent.bind(fence);
  function synchronousCurrent(operation: FileByteOperation) {
    // A void callback type alone permits async functions. Reject a deferred
    // assertion so a bad composition cannot publish before validation settles.
    const result: unknown = assertCurrent?.(Object.freeze({ method: operation.method, key: operation.key }));
    if (result !== undefined) {
      if (result instanceof Promise) void result.catch(() => undefined);
      fail();
    }
  }
  async function mutation(operation: FileByteOperation) {
    const captured = Object.freeze({ method: operation.method, key: operation.key });
    if (beforeMutation && await beforeMutation(captured) !== true) fail();
    synchronousCurrent(captured);
  }
  validateNamespace(binding.namespace);
  if (!isAbsolute(binding.root) || resolve(binding.root) !== binding.root || !Number.isInteger(constants.O_NOFOLLOW)
    || typeof process.geteuid !== "function") fail();
  const root = binding.root;
  const namespace = Object.freeze(namespaceValue(binding.namespace));
  const markerPath = join(root, MARKER), objectsPath = join(root, "objects"), stagingPath = join(root, "staging");
  const opened: Awaited<ReturnType<typeof directory>>[] = [];
  let closed = false, closing: Promise<void> | undefined;
  const selectedClosers = new Set<Closer>();
  const pendingOperations = new Set<Promise<unknown>>();
  const operationErrors = new Set<unknown>();
  const owner = { binding: { root, namespace }, opened, selectedClosers, pendingOperations, operationErrors, close };
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      // Register whole original operations before their first await. Only after
      // they settle can the child snapshot be complete; parent FDs close only
      // after every original cached child cleanup acknowledges successfully.
      await Promise.allSettled([...pendingOperations]);
      const children = await Promise.allSettled([...selectedClosers].map(release => release()));
      const failures = children.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw combineFailures(failures, "Local byte child cleanup is incomplete");
      await closeHandles(opened.map(value => value.handle));
      operationErrors.clear();
    })().catch(error => { failedLocalOwners.add(owner); throw error; });
    return closing;
  }
  function operation<T>(work: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new LocalByteStorageError("unavailable"));
    const original = Promise.resolve().then(work); pendingOperations.add(original);
    void original.then(() => { pendingOperations.delete(original); }, error => {
      operationErrors.add(error); pendingOperations.delete(original);
    });
    return original;
  }
  try {
    for (const path of [root, objectsPath, stagingPath]) {
      const parent = await directory(path, selectedClosers); opened.push(parent);
      selectedClosers.delete(ownHandle(parent.handle));
    }
    const marker = await smallJson(markerPath, selectedClosers);
    if (!exactKeys(marker, ["format", "namespace"]) || marker.format !== "local-byte-namespace-v1" || !sameNamespace(marker.namespace, namespace)) fail();
  } catch (validationCause) {
    try { await close(); }
    catch (cleanupCause) { throw new StorageProfileCleanupError(validationCause, cleanupCause, { owner, dispose: close }); }
    throw new LocalByteStorageError("unavailable", { cause: validationCause });
  }
  async function checkNamespace() {
    if (closed) fail();
    for (const [index, path] of [root, objectsPath, stagingPath].entries()) {
      const current = await directory(path, selectedClosers);
      await preserveClose(ownHandle(current.handle), async () => { if (!sameInode(current.stat, opened[index].stat)) fail(); });
    }
    const marker = await smallJson(markerPath, selectedClosers);
    if (!exactKeys(marker, ["format", "namespace"]) || marker.format !== "local-byte-namespace-v1" || !sameNamespace(marker.namespace, namespace)) fail();
  }
  async function object(key: string) {
    const path = join(objectsPath, identity(namespace, key));
    await checkNamespace();
    let selected: Awaited<ReturnType<typeof directory>>;
    try { selected = await directory(path, selectedClosers); }
    catch (error) { if (code(error) === "ENOENT") return null; throw error; }
    try {
      if ((await readdir(path)).sort().join("\0") !== [DATA, METADATA].sort().join("\0")) fail();
      const value = metadata(await smallJson(join(path, METADATA), selectedClosers), namespace, key);
      const data = await regular(join(path, DATA), constants.O_RDONLY, selectedClosers);
      const pendingReads = new Set<Promise<unknown>>();
      let releasing: Promise<void> | undefined;
      const release = () => releasing ??= (async () => {
        // Failed close cannot bypass already-started native read settlement.
        // Track the actual read promises, not a pull/cancel that awaits release.
        const results = await Promise.allSettled([closeHandles([data, selected.handle]), ...pendingReads]);
        const closeResult = results[0]!;
        if (closeResult.status === "rejected") throw closeResult.reason;
        selectedClosers.delete(release);
      })();
      selectedClosers.add(release);
      return { path, value, data, directory: selected.handle, release, pendingReads };
    } catch (error) { return preserveClose(ownHandle(selected.handle), async () => { throw error; }); }
  }
  const reader: ByteReader = {
    stat(key) { if (closed) return Promise.resolve({ outcome: "unavailable" } as const); return operation(async () => {
      try {
        const selected = await object(key);
        if (!selected) return { outcome: "missing" } as const;
        return await preserveClose(selected.release, async () => {
          const size = (await selected.data.stat({ bigint: true })).size;
          return { outcome: "available" as const, byteSize: size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(size) : null, ...headers(selected.value) };
        });
      } catch (error) { operationErrors.add(error); return { outcome: "unavailable" } as const; }
    }); },
    read(key) { if (closed) return Promise.resolve({ outcome: "unavailable" } as const); return operation(async () => {
      try {
        const selected = await object(key);
        if (!selected) return { outcome: "missing" } as const;
        // Concurrent EOF/cancellation must await the same actual handle-close
        // promise, including any already-started native read.
        const release = selected.release;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const buffer = new Uint8Array(CHUNK_BYTES);
              if (closed) fail();
              const nativeRead = selected.data.read(buffer, 0, buffer.byteLength, null);
              selected.pendingReads.add(nativeRead);
              let bytesRead: number;
              try { bytesRead = (await nativeRead).bytesRead; }
              finally { selected.pendingReads.delete(nativeRead); }
              if (!bytesRead) { await release(); controller.close(); }
              else controller.enqueue(buffer.subarray(0, bytesRead));
            } catch (error) {
              try { await release(); } catch (cleanup) {
                const original = combineFailures([error, cleanup], "Local byte read and first close failed");
                operationErrors.add(original); controller.error(original); return;
              }
              operationErrors.add(error); controller.error(new LocalByteStorageError("unavailable", { cause: error }));
            }
          },
          async cancel() { await release(); },
        }, { highWaterMark: 0 });
        return { outcome: "available" as const, body, ...headers(selected.value) };
      } catch (error) { operationErrors.add(error); return { outcome: "unavailable" } as const; }
    }); },
  };
  const writer: ByteWriter = {
    accepts: "both",
    write(input: ByteWriteInput) {
      const request = Object.freeze({ key: input.key, body: input.body, byteSize: input.byteSize, sha256: input.sha256,
        contentType: input.contentType, filename: input.filename });
      let source: ReturnType<typeof verifyingStream> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let data: FileHandle | undefined;
      let rejected = false, workError: unknown, cleanupPromise: Promise<void> | undefined;
      const writerOwner = { request, handles: [] as FileHandle[], close: (): Promise<void> => cleanup() };
      const cleanup: Closer = () => cleanupPromise ??= Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        for (const handle of writerOwner.handles) {
          try { await ownHandle(handle)(); } catch (error) { failures.push(error); }
        }
        try {
          if (source) await source.dispose();
          else if (!(request.body instanceof ArrayBuffer)) await (disposeByteVerificationFailure(workError) ?? request.body.cancel());
        } catch (error) { failures.push(error); }
        try { reader?.releaseLock(); } catch (error) { failures.push(error); }
        if (failures.length) {
          failedLocalOwners.add(writerOwner);
          throw combineFailures(failures, "Local byte writer cleanup is incomplete");
        }
        selectedClosers.delete(cleanup);
      });
      if (closed) return Promise.reject(new LocalByteStorageError("unavailable"));
      selectedClosers.add(cleanup);
      return operation(async () => {
      try {
        validateByteExpectation(request, "source");
        if (!canonicalText(request.key, 4096) || !/^[\x20-\x7e]{1,512}$/.test(request.contentType)
          || !canonicalText(request.filename, 1024, false)) throw new ByteVerificationError("source", "invalid_expectation");
        const description: ObjectMetadata = { format: "local-byte-object-v1", namespace, key: request.key,
          byteSize: request.byteSize, sha256: request.sha256, contentType: request.contentType, filename: request.filename };
        const descriptionBytes = new TextEncoder().encode(JSON.stringify(description));
        if (descriptionBytes.byteLength > MAX_METADATA_BYTES) throw new ByteVerificationError("source", "invalid_expectation");
        await checkNamespace();
        const destination = join(objectsPath, identity(namespace, request.key));
        try { await lstat(destination); throw new LocalByteStorageError("conflict"); }
        catch (error) { if (code(error) !== "ENOENT") throw error; }
        const stage = await mkdtemp(join(stagingPath, "attempt-"));
        // Every failed stage is retained, never blindly deleted/retried. Caller
        // durable attempts/cleanup will be a separately admitted composition.
        data = await createRegular(join(stage, DATA), selectedClosers); writerOwner.handles.push(data);
        source = verifyingStream(request.body instanceof ArrayBuffer ? bufferByteStream(request.body) : request.body, request, nodeSha256, "source");
        reader = source.body.getReader();
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          await writeAll(data, next.value);
        }
        source.result();
        await data.sync(); await ownHandle(data)();
        const record = await createRegular(join(stage, METADATA), selectedClosers); writerOwner.handles.push(record);
        await preserveClose(ownHandle(record), async () => { await writeAll(record, descriptionBytes); await record.sync(); });
        const stagedDirectory = await directory(stage, selectedClosers); writerOwner.handles.push(stagedDirectory.handle);
        await preserveClose(ownHandle(stagedDirectory.handle), async () => { await stagedDirectory.handle.sync(); });
        await checkNamespace();
        await mutation({ method: "PUT", key: request.key });
        // Check synchronous owned state once more after the awaited fence.
        synchronousCurrent({ method: "PUT", key: request.key });
        await rename(stage, destination);
        // Nonempty immutable object directories prevent a competing writer's
        // rename from replacing an accepted object. Errors after this point
        // are unknown ACKs: preserve the object for exact-key reconciliation.
        await opened[1].handle.sync(); await opened[2].handle.sync();
        await checkNamespace();
      } catch (error) { rejected = true; workError = error; }
      try { await cleanup(); }
      catch (cleanupError) {
        throw rejected ? combineFailures([workError, cleanupError], "Local byte write and cleanup failed") : cleanupError;
      }
      if (rejected) {
        if (workError instanceof ByteVerificationError || workError instanceof LocalByteStorageError) throw workError;
        throw new LocalByteStorageError("unavailable", { cause: workError });
      }
      });
    },
  };
  const deleter: ByteDeleter = {
    delete(key) { if (closed) return Promise.resolve({ outcome: "unavailable" } as const); return operation(async () => {
      try {
        const selected = await object(key);
        if (!selected) return { outcome: "acknowledged" } as const;
        return await preserveClose(selected.release, async () => {
          await checkNamespace();
          const tomb = await mkdtemp(join(stagingPath, "delete-"));
          // Remove the empty generated placeholder before one exact rename.
          await rmdir(tomb);
          await mutation({ method: "DELETE", key });
          synchronousCurrent({ method: "DELETE", key });
          await rename(selected.path, tomb);
          await opened[1].handle.sync(); await opened[2].handle.sync();
          await unlink(join(tomb, DATA)); await unlink(join(tomb, METADATA)); await rmdir(tomb);
          await opened[2].handle.sync();
          return { outcome: "acknowledged" } as const;
        });
      } catch (error) { operationErrors.add(error); return { outcome: "unavailable" } as const; }
    }); },
  };
  return { reader, writer, deleter, close };
}
