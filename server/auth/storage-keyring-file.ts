import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseStorageCredentialKeyring, StorageCredentialUnavailableError, type StorageCredentialKeyring } from '../../worker/storage/credential-envelope';

/** The version-1 parser admits at most 4096 UTF-8 bytes; this reader never
 * allocates or reads an unbounded secret file, including a growing file. */
export const MAX_PRIVATE_KEYRING_BYTES = 4096;
function unavailable(): never { throw new StorageCredentialUnavailableError(); }
function uid(): bigint {
  if (process.platform !== 'linux' || typeof process.geteuid !== 'function') return unavailable();
  return BigInt(process.geteuid());
}
function privateFile(stat: BigIntStats, owner: bigint): void {
  const mode = stat.mode & 0o7777n;
  if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== owner || (mode !== 0o400n && mode !== 0o600n)
    || stat.size < 1n || stat.size > BigInt(MAX_PRIVATE_KEYRING_BYTES)) unavailable();
}
async function privatePath(path: string, owner: bigint, filesystemRootOwner: bigint): Promise<BigIntStats> {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0') || !isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) unavailable();
  let directory = dirname(path);
  while (true) {
    const stat = await lstat(directory, { bigint: true });
    // All non-root ancestors remain service-user/root-owned. Exact '/' can
    // have a separately pinned deployment-owned UID for a remapped filesystem;
    // this never trusts arbitrary observed ancestor owners or public scratch.
    const parent = dirname(directory), atRoot = parent === directory;
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (atRoot ? stat.uid !== filesystemRootOwner : stat.uid !== owner && stat.uid !== 0n)
      || (stat.mode & 0o022n) !== 0n) unavailable();
    if (atRoot) break; directory = parent;
  }
  const stat = await lstat(path, { bigint: true }); privateFile(stat, owner); return stat;
}
function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
    && before.uid === after.uid && before.mode === after.mode && before.nlink === after.nlink;
}

/** Trusted composition owns a fixed canonical path on a server-owned local
 * filesystem. No provisioning, key generation, persistence reset or fallback.
 * Each call reopens the private file so a provisioned rotation can retain old
 * key IDs. Retention/retirement authorization stays with its owner, not this
 * loader. Host administrators or another process with this service UID can
 * replace a mount/file outside these assumptions; this is not hostile-host
 * protection. Buffers are erased; transient JS JSON strings remain GC-managed. */
export function createPrivateStorageKeyringLoader(path: string, options: {
  /** Trusted deployment pin for exact '/'; default UID0. No stat-derived trust
   * or extension to another ancestor. Capture this before any asynchronous work. */
  filesystemRootOwnerUid?: number;
} = {}): () => Promise<StorageCredentialKeyring> {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => key !== 'filesystemRootOwnerUid')) unavailable();
  const configuredRootOwner = options.filesystemRootOwnerUid === undefined ? 0 : options.filesystemRootOwnerUid;
  if (!Number.isSafeInteger(configuredRootOwner) || configuredRootOwner < 0 || configuredRootOwner > 0xffff_ffff) unavailable();
  const filesystemRootOwner = BigInt(configuredRootOwner);
  // Defer missing/unreadable secret availability to the operation using it;
  // unrelated database/application readiness need not reset or fail itself.
  return async () => {
    let handle: FileHandle | undefined;
    const bytes = Buffer.alloc(MAX_PRIVATE_KEYRING_BYTES + 1);
    try {
      const owner = uid(), beforePath = await privatePath(path, owner, filesystemRootOwner);
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat({ bigint: true }); privateFile(before, owner);
      if (!unchanged(beforePath, before)) unavailable();
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break; length += result.bytesRead;
      }
      if (length < 1 || length > MAX_PRIVATE_KEYRING_BYTES || BigInt(length) !== before.size) unavailable();
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
      const keyring = await parseStorageCredentialKeyring(raw);
      const after = await handle.stat({ bigint: true }); privateFile(after, owner);
      const afterPath = await privatePath(path, owner, filesystemRootOwner);
      if (!unchanged(before, after) || !unchanged(before, afterPath)) unavailable();
      return keyring;
    } catch { return unavailable(); }
    finally {
      bytes.fill(0);
      // A failed close is still an unavailable secret capability. Never return
      // imported keys after cleanup failed, or expose filesystem error details.
      try { await handle?.close(); } catch { unavailable(); }
    }
  };
}
