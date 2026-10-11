import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { LocalFileRuntimeEvidenceV28 } from "../../shared/contracts/export-local-file-runtime-v28";
import { checkedLocalVolumeSourceV28, planFileBlobExportV28, verifyLocalVolumePayloadV28,
  type LocalVolumeBlobEntryV28 } from "../../shared/contracts/export-local-file-bytes-v28";
import { stableJson } from "../../shared/domain/content-addressing";

export interface PackagedLocalVolumePayloadV28 {
  id: string; source: LocalVolumeBlobEntryV28; path: string; byteSize: number; sha256: string;
}
export interface InertLocalVolumeMappingV28 extends PackagedLocalVolumePayloadV28 {
  state: "verified-offline-source";
}
/** Retains the exact original handle/close Promise. A rejected close is never
 * retried or interpreted as successful destination custody release. */
export class LocalVolumeDestinationCleanupError extends Error {
  constructor(readonly owner: FileHandle, readonly originalClose: Promise<void>, readonly reason: unknown) {
    super("V28 local recovery payload custody could not close"); this.name = "LocalVolumeDestinationCleanupError";
  }
}
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`V28 inert local recovery rejected: ${reason}`);
}
const sameInode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const privateOwner = (stat: BigIntStats) => typeof process.geteuid === "function"
  && stat.uid === BigInt(process.geteuid()) && (stat.mode & 0o077n) === 0n;
const sameFile = (a: BigIntStats, b: BigIntStats) => sameInode(a, b) && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function freezeData<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeData(item);
    Object.freeze(value);
  }
  return value;
}

/** Verifies only admitted extracted regular files. Namespace metadata is
 * retained as an inert source address; no original volume is opened and no
 * target directory, SQL row, profile binding/default or capability is created.
 * The V5 restorer owns and validates the whole image/manifest before calling. */
export async function verifyInertLocalVolumeDestinationV28(options: {
  directory: string; evidence: LocalFileRuntimeEvidenceV28; payloads: readonly PackagedLocalVolumePayloadV28[];
}): Promise<readonly InertLocalVolumeMappingV28[]> {
  const { directory, evidence } = options;
  ensure(isAbsolute(directory) && resolve(directory) === directory, "canonical private extraction directory");
  const expected = planFileBlobExportV28(evidence).blobs.filter((source): source is LocalVolumeBlobEntryV28 =>
    source.storeKind === "file" && source.provider === "local" && "namespace" in source);
  ensure(options.payloads.length === expected.length, "complete local payload inventory");
  // Capture serialized metadata once before any await/file I/O. V5 admission
  // already supplies bounded data-only rows; private semantic evidence must
  // independently match every complete source/occurrence/consumer below.
  const payloads = options.payloads.map(item => JSON.parse(stableJson(item)) as PackagedLocalVolumePayloadV28);
  const ids = new Set<string>(), locators = new Set<string>();
  for (const item of payloads) {
    ensure(stableJson(Object.keys(item).sort()) === stableJson(["id", "source", "path", "byteSize", "sha256"].sort())
      && /^b_[0-9]{4}$/.test(item.id) && item.path === `files/${item.id}` && !ids.has(item.id), "payload fields/path");
    const source = checkedLocalVolumeSourceV28(evidence, item.source);
    ensure(source.initialOutcome === null && item.byteSize === source.expectedByteSize && item.sha256 === source.expectedSha256
      && !locators.has(source.locatorId), "verified local payload tuple");
    ids.add(item.id); locators.add(source.locatorId);
  }
  ensure(expected.every(source => locators.has(source.locatorId)), "every local source retained");
  ensure(await realpath(directory) === directory, "canonical private extraction directory");
  const cleanups = new Set<() => Promise<void>>();
  const retain = (handle: FileHandle) => {
    let original: Promise<void> | undefined, closed: Promise<void> | undefined;
    const dispose = () => closed ??= (async () => {
      original = Promise.resolve().then(() => handle.close());
      try { await original; cleanups.delete(dispose); }
      catch (reason) { throw new LocalVolumeDestinationCleanupError(handle, original, reason); }
    })();
    cleanups.add(dispose); return dispose;
  };
  const openDirectory = async (path: string) => {
    const before = await lstat(path, { bigint: true });
    ensure(before.isDirectory() && privateOwner(before) && await realpath(path) === path, "private extracted directory");
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    retain(handle);
    const observed = await handle.stat({ bigint: true });
    ensure(observed.isDirectory() && privateOwner(observed) && sameInode(before, observed), "directory inode changed");
    return { path, handle, observed };
  };
  const assertDirectory = async (owner: Awaited<ReturnType<typeof openDirectory>>) => {
    const path = await lstat(owner.path, { bigint: true });
    const handle = await owner.handle.stat({ bigint: true });
    ensure(path.isDirectory() && handle.isDirectory() && privateOwner(path) && privateOwner(handle)
      && sameInode(owner.observed, path) && sameInode(path, handle), "directory custody changed");
  };
  let failure: unknown, failed = false;
  const mappings: InertLocalVolumeMappingV28[] = [];
  try {
    const root = await openDirectory(directory);
    const files = payloads.length ? await openDirectory(join(directory, "files")) : undefined;
    for (const item of payloads) {
      await assertDirectory(root); await assertDirectory(files!);
      const path = join(directory, item.path), before = await lstat(path, { bigint: true });
      ensure(before.isFile() && before.nlink === 1n && privateOwner(before) && before.size === BigInt(item.byteSize), "private regular payload");
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW), dispose = retain(handle);
      const opened = await handle.stat({ bigint: true });
      ensure(opened.isFile() && opened.nlink === 1n && privateOwner(opened) && sameFile(before, opened), "payload inode changed");
      await verifyLocalVolumePayloadV28(evidence, item.source, {
        byteSize: item.byteSize,
        async read(offset, length) {
          const bytes = new Uint8Array(length); let cursor = 0;
          while (cursor < length) {
            const original = handle.read(bytes, cursor, length - cursor, offset + cursor);
            const result = await original;
            ensure(result.bytesRead > 0, "truncated local payload"); cursor += result.bytesRead;
          }
          return bytes;
        },
      });
      const extra = new Uint8Array(1), eof = await handle.read(extra, 0, 1, item.byteSize);
      ensure(eof.bytesRead === 0, "local payload grew");
      const after = await handle.stat({ bigint: true });
      const pathname = await lstat(path, { bigint: true });
      ensure(after.isFile() && pathname.isFile() && after.nlink === 1n && pathname.nlink === 1n
        && privateOwner(after) && privateOwner(pathname) && sameFile(opened, after) && sameFile(after, pathname), "payload changed during verification");
      await assertDirectory(root); await assertDirectory(files!); await dispose();
      mappings.push(freezeData({ ...item, source: checkedLocalVolumeSourceV28(evidence, item.source), state: "verified-offline-source" as const }));
    }
  } catch (error) { failed = true; failure = error; }
  const errors: unknown[] = [];
  for (const dispose of [...cleanups].reverse()) try { await dispose(); } catch (error) { errors.push(error); }
  if (failed || errors.length) {
    if (!errors.length) throw failure;
    throw new AggregateError([...(failed ? [failure] : []), ...errors], "V28 local payload verification/cleanup failed");
  }
  return Object.freeze(mappings.map(item => Object.freeze(item)));
}
