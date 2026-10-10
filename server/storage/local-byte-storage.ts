import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, realpath, readdir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ByteDeleter } from "../../worker/files/byte-deleter";
import type { ByteMetadata, ByteReader } from "../../worker/files/byte-reader";
import { ByteVerificationError, bufferByteStream, validateByteExpectation, verifyingStream } from "../../worker/files/byte-verification";
import type { ByteWriteInput, ByteWriter } from "../../worker/files/byte-writer";
import { nodeSha256 } from "./node-sha256";

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
export class LocalByteStorageError extends Error {
  constructor(readonly reason: "unavailable" | "conflict") {
    super(reason === "conflict" ? "The immutable local object already exists" : "Local byte storage is unavailable");
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
async function directory(path: string): Promise<{ handle: FileHandle; stat: BigIntStats }> {
  const before = await lstat(path, { bigint: true });
  if (!before.isDirectory() || !owner(before) || (before.mode & 0o077n) !== 0n || await realpath(path) !== path) fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory() || !sameInode(before, stat)) fail();
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
}
async function regular(path: string, flags = constants.O_RDONLY): Promise<FileHandle> {
  const handle = await open(path, flags | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || !owner(stat) || stat.nlink !== 1n || (stat.mode & 0o077n) !== 0n) fail();
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function smallJson(path: string) {
  const handle = await regular(path);
  try {
    const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_METADATA_BYTES || (await handle.stat({ bigint: true })).size !== BigInt(bytesRead)) fail();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))) as unknown;
  } finally { await handle.close(); }
}
async function createRegular(path: string) {
  return open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
}
async function writeAll(handle: FileHandle, value: Uint8Array) {
  for (let offset = 0; offset < value.byteLength;) {
    const result = await handle.write(value, offset, value.byteLength - offset);
    if (result.bytesWritten <= 0) fail();
    offset += result.bytesWritten;
  }
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
export async function openLocalByteStorage(binding: LocalByteBinding): Promise<LocalByteStorage> {
  validateNamespace(binding.namespace);
  if (!isAbsolute(binding.root) || resolve(binding.root) !== binding.root || !Number.isInteger(constants.O_NOFOLLOW)
    || typeof process.geteuid !== "function") fail();
  const root = binding.root;
  const namespace = Object.freeze(namespaceValue(binding.namespace));
  const markerPath = join(root, MARKER), objectsPath = join(root, "objects"), stagingPath = join(root, "staging");
  const opened: Awaited<ReturnType<typeof directory>>[] = [];
  try {
    for (const path of [root, objectsPath, stagingPath]) opened.push(await directory(path));
    const marker = await smallJson(markerPath);
    if (!exactKeys(marker, ["format", "namespace"]) || marker.format !== "local-byte-namespace-v1" || !sameNamespace(marker.namespace, namespace)) fail();
  } catch { await Promise.allSettled(opened.map(value => value.handle.close())); fail(); }
  let closed = false;
  async function checkNamespace() {
    if (closed) fail();
    for (const [index, path] of [root, objectsPath, stagingPath].entries()) {
      const current = await directory(path);
      try { if (!sameInode(current.stat, opened[index].stat)) fail(); }
      finally { await current.handle.close(); }
    }
    const marker = await smallJson(markerPath);
    if (!exactKeys(marker, ["format", "namespace"]) || marker.format !== "local-byte-namespace-v1" || !sameNamespace(marker.namespace, namespace)) fail();
  }
  async function object(key: string) {
    const path = join(objectsPath, identity(namespace, key));
    await checkNamespace();
    let selected: Awaited<ReturnType<typeof directory>>;
    try { selected = await directory(path); }
    catch (error) { if (code(error) === "ENOENT") return null; throw error; }
    try {
      if ((await readdir(path)).sort().join("\0") !== [DATA, METADATA].sort().join("\0")) fail();
      const value = metadata(await smallJson(join(path, METADATA)), namespace, key);
      const data = await regular(join(path, DATA));
      return { path, value, data, directory: selected.handle };
    } catch (error) { await selected.handle.close(); throw error; }
  }
  const reader: ByteReader = {
    async stat(key) {
      let selected: Awaited<ReturnType<typeof object>>;
      try {
        selected = await object(key);
        if (!selected) return { outcome: "missing" };
        try {
          const size = (await selected.data.stat({ bigint: true })).size;
          return { outcome: "available", byteSize: size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(size) : null, ...headers(selected.value) };
        } finally { await Promise.all([selected.data.close(), selected.directory.close()]); }
      } catch { return { outcome: "unavailable" }; }
    },
    async read(key) {
      try {
        const selected = await object(key);
        if (!selected) return { outcome: "missing" };
        let released = false;
        const release = async () => { if (!released) { released = true; await Promise.all([selected.data.close(), selected.directory.close()]); } };
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const buffer = new Uint8Array(CHUNK_BYTES);
              const { bytesRead } = await selected.data.read(buffer, 0, buffer.byteLength, null);
              if (!bytesRead) { await release(); controller.close(); }
              else controller.enqueue(buffer.subarray(0, bytesRead));
            } catch { await release(); controller.error(new LocalByteStorageError("unavailable")); }
          },
          async cancel() { await release(); },
        }, { highWaterMark: 0 });
        return { outcome: "available", body, ...headers(selected.value) };
      } catch { return { outcome: "unavailable" }; }
    },
  };
  const writer: ByteWriter = {
    accepts: "both",
    async write(input: ByteWriteInput) {
      const request = Object.freeze({ key: input.key, body: input.body, byteSize: input.byteSize, sha256: input.sha256,
        contentType: input.contentType, filename: input.filename });
      let source: ReturnType<typeof verifyingStream> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let data: FileHandle | undefined;
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
        data = await createRegular(join(stage, DATA));
        source = verifyingStream(request.body instanceof ArrayBuffer ? bufferByteStream(request.body) : request.body, request, nodeSha256, "source");
        reader = source.body.getReader();
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          await writeAll(data, next.value);
        }
        source.result();
        await data.sync(); await data.close(); data = undefined;
        const record = await createRegular(join(stage, METADATA));
        try { await writeAll(record, descriptionBytes); await record.sync(); }
        finally { await record.close(); }
        const stagedDirectory = await directory(stage);
        try { await stagedDirectory.handle.sync(); }
        finally { await stagedDirectory.handle.close(); }
        await checkNamespace();
        await rename(stage, destination);
        // Nonempty immutable object directories prevent a competing writer's
        // rename from replacing an accepted object. Errors after this point
        // are unknown ACKs: preserve the object for exact-key reconciliation.
        await opened[1].handle.sync(); await opened[2].handle.sync();
        await checkNamespace();
      } catch (error) {
        if (error instanceof ByteVerificationError || error instanceof LocalByteStorageError) throw error;
        throw new LocalByteStorageError("unavailable");
      } finally {
        if (data) await data.close().catch(() => undefined);
        if (source) await source.dispose();
        else if (!(request.body instanceof ArrayBuffer)) await request.body.cancel().catch(() => undefined);
        reader?.releaseLock();
      }
    },
  };
  const deleter: ByteDeleter = {
    async delete(key) {
      try {
        const selected = await object(key);
        if (!selected) return { outcome: "acknowledged" };
        try {
          await checkNamespace();
          const tomb = await mkdtemp(join(stagingPath, "delete-"));
          // Remove the empty generated placeholder before one exact rename.
          await rmdir(tomb); await rename(selected.path, tomb);
          await opened[1].handle.sync(); await opened[2].handle.sync();
          await unlink(join(tomb, DATA)); await unlink(join(tomb, METADATA)); await rmdir(tomb);
          await opened[2].handle.sync();
          return { outcome: "acknowledged" };
        } finally { await Promise.all([selected.data.close(), selected.directory.close()]); }
      } catch { return { outcome: "unavailable" }; }
    },
  };
  return { reader, writer, deleter, async close() {
    if (closed) return;
    closed = true; await Promise.all(opened.map(value => value.handle.close()));
  } };
}
